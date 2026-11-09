'use strict';

// Framework-neutral part: takes collected results and records them in Test Manager.
// Same flow as @testmuai/playwright-adapter, which was verified against the live API.

const { TestManagerClient } = require('./client');
const { STATUS, buildRemarks, INTERNAL_ID_RE } = require('./mapping');

const PREFIX = '[testmu]';

function envFlag(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function resolveOptions(options = {}, env = process.env) {
  return {
    username: pick(options.username, env.LT_USERNAME),
    accessKey: pick(options.accessKey, env.LT_ACCESS_KEY),
    projectId: pick(options.projectId, env.TESTMU_PROJECT_ID),
    runId: pick(options.runId, env.TESTMU_RUN_ID),
    runTitle: pick(options.runTitle, env.TESTMU_RUN_TITLE),
    objective: pick(options.objective, env.TESTMU_RUN_OBJECTIVE),
    tags: options.tags || (env.TESTMU_RUN_TAGS ? env.TESTMU_RUN_TAGS.split(',').map((t) => t.trim()).filter(Boolean) : ['jest']),
    environmentId: pick(options.environmentId, env.TESTMU_ENVIRONMENT_ID),
    region: pick(options.region, env.TESTMU_REGION, 'us'),
    apiUrl: pick(options.apiUrl, env.TESTMU_TM_API_URL),
    reportSkipped: pick(options.reportSkipped, envFlag(env.TESTMU_REPORT_SKIPPED), true),
    setRunStatus: pick(options.setRunStatus, envFlag(env.TESTMU_SET_RUN_STATUS), true),
    reportInWatchMode: pick(options.reportInWatchMode, envFlag(env.TESTMU_REPORT_IN_WATCH_MODE), false),
    dryRun: pick(options.dryRun, envFlag(env.TESTMU_DRY_RUN), false),
    enabled: pick(options.enabled, envFlag(env.TESTMU_REPORTER_ENABLED), true),
    concurrency: Number(pick(options.concurrency, 5)),
    frameworkName: 'Jest',
    logger: options.logger || console,
    fetchImpl: options.fetchImpl,
  };
}

/** Why reporting cannot run with these options, or null. */
function disabledReason(opts) {
  if (!opts.enabled) return 'disabled by configuration';
  if (opts.dryRun) return null;
  const missing = [];
  if (!opts.username) missing.push('LT_USERNAME');
  if (!opts.accessKey) missing.push('LT_ACCESS_KEY');
  if (!opts.projectId) missing.push('TESTMU_PROJECT_ID');
  return missing.length ? `missing ${missing.join(', ')}` : null;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * byRef:    Map(ref -> { status, entries: [{ title, project, status, error }] })
 * unlinked: entries for tests with no case ID
 */
async function syncResults(opts, { byRef, unlinked }) {
  const log = opts.logger;
  if (byRef.size === 0) {
    log.log(`${PREFIX} No tests are linked to Test Manager test cases. Put a case ID in the test or describe name, e.g. 'login works @TC-123'.`);
    return;
  }
  if (opts.dryRun) {
    printDryRun(log, byRef, unlinked);
    return;
  }

  const client = new TestManagerClient({
    username: opts.username,
    accessKey: opts.accessKey,
    region: opts.region,
    apiUrl: opts.apiUrl,
    fetchImpl: opts.fetchImpl,
  });
  const { projectId } = opts;

  // 1. Resolve TC-123 style references to test_case_id values.
  const refToCaseId = new Map();
  const unresolved = [];
  const needLookup = [...byRef.keys()].filter((r) => INTERNAL_ID_RE.test(r));
  let internalMap = new Map();
  if (needLookup.length) {
    const cases = await client.listTestCases(projectId);
    internalMap = new Map(
      cases.filter((c) => c.internal_id).map((c) => [String(c.internal_id).toUpperCase(), String(c.test_case_id || c.id)])
    );
  }
  for (const ref of byRef.keys()) {
    if (INTERNAL_ID_RE.test(ref)) {
      const id = internalMap.get(ref);
      if (id) refToCaseId.set(ref, id);
      else unresolved.push(ref);
    } else {
      refToCaseId.set(ref, ref);
    }
  }
  if (refToCaseId.size === 0) {
    log.warn(`${PREFIX} None of the tagged test cases exist in project ${projectId}: ${unresolved.join(', ')}`);
    return;
  }

  // 2. Create the run, or reuse one passed in (e.g. shared across CI shards).
  const title = opts.runTitle || `${opts.frameworkName} run ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  let runId = opts.runId;
  let existing = [];
  let runMeta = { title, objective: opts.objective, tags: opts.tags };
  if (runId) {
    const current = await client.getRunInstances(runId);
    existing = current.instances;
    // Keep the existing run's own title / objective / tags: the update call overwrites them.
    const d = current.details || {};
    runMeta = {
      title: d.title || title,
      objective: d.objective || opts.objective,
      // Tags come back as [{ tag_id, name }] but must be sent as plain names.
      tags: Array.isArray(d.tags) ? d.tags.map((t) => (t && typeof t === 'object' ? t.name : t)).filter(Boolean) : opts.tags,
    };
  } else {
    runId = await client.createTestRun({ projectId, ...runMeta });
  }

  // 3. Add test cases that are not in the run yet. The update call replaces the run's
  //    case list, so send existing cases too (they keep their instance and status).
  const present = [...new Set(existing.map((i) => String(i.test_case_id)))];
  const toAdd = [...new Set(refToCaseId.values())].filter((id) => !present.includes(id));
  if (toAdd.length) {
    await client.setRunTestCases(runId, {
      projectId,
      ...runMeta,
      testCaseIds: [...present, ...toAdd],
      environmentId: opts.environmentId,
    });
  }

  // 4. Find the instance(s) for each test case.
  const { instances } = await client.getRunInstances(runId);
  const instancesByCase = new Map();
  for (const inst of instances) {
    const key = String(inst.test_case_id);
    if (!instancesByCase.has(key)) instancesByCase.set(key, []);
    instancesByCase.get(key).push(inst);
  }

  // 5. Passed / Skipped in bulk; Failed one by one so each gets its error as remarks.
  const bulk = { [STATUS.PASSED]: [], [STATUS.SKIPPED]: [] };
  const failed = [];
  const missingInstance = [];
  for (const [ref, result] of byRef) {
    const caseId = refToCaseId.get(ref);
    if (!caseId) continue;
    const insts = instancesByCase.get(caseId) || [];
    if (!insts.length) {
      missingInstance.push(ref);
      continue;
    }
    for (const inst of insts) {
      if (result.status === STATUS.FAILED) failed.push({ id: inst.id, remarks: buildRemarks(result.entries) });
      else bulk[result.status].push(inst.id);
    }
  }
  for (const status of [STATUS.PASSED, STATUS.SKIPPED]) {
    if (bulk[status].length) await client.bulkUpdateStatus(runId, bulk[status], status);
  }
  await mapLimit(failed, opts.concurrency, (f) =>
    client.updateInstance(f.id, { status: STATUS.FAILED, remarks: f.remarks })
  );

  // 6. Read the run back: overall status and the summary come from Test Manager itself.
  const after = await client.getRunInstances(runId);
  const counts = summarizeInstances(after.instances);
  if (opts.setRunStatus) {
    const runStatus = counts.failed > 0 ? STATUS.FAILED : counts.notStarted > 0 ? 'In Progress' : STATUS.PASSED;
    try {
      await client.setRunStatus(runId, runStatus);
    } catch (err) {
      log.warn(`${PREFIX} Could not set the overall run status: ${err.message}`);
    }
  }

  printSummary(log, { runId, title: after.details.title || title, byRef, refToCaseId, after, counts, unresolved, missingInstance, unlinked });
}

function printDryRun(log, byRef, unlinked) {
  const lines = [`${PREFIX} Dry run: nothing was sent to Test Manager.`];
  for (const [ref, r] of byRef) lines.push(`  ${symbol(r.status)} ${ref.padEnd(10)} ${r.status.padEnd(7)} ${r.entries.map((e) => e.title).join('; ')}`);
  if (unlinked.length) lines.push(`  ${unlinked.length} test(s) have no Test Manager case ID and were skipped.`);
  log.log(lines.join('\n'));
}

function printSummary(log, { runId, title, byRef, refToCaseId, after, counts, unresolved, missingInstance, unlinked }) {
  const statusByCase = new Map(after.instances.map((i) => [String(i.test_case_id), i.status]));
  // Show the short TC-123 number even when the test was linked by its long test_case_id.
  const shortIdByCase = new Map(after.instances.filter((i) => i.internal_id).map((i) => [String(i.test_case_id), i.internal_id]));
  const lines = ['', `${PREFIX} Test Manager run "${title}" (id ${runId})`];
  for (const [ref, r] of byRef) {
    const caseId = refToCaseId.get(ref);
    if (!caseId) continue;
    const recorded = statusByCase.get(caseId) || r.status;
    // Name the test that decided the status (e.g. the failing one), then how many more share the case.
    const lead = r.entries.find((e) => e.status === r.status) || r.entries[0];
    const more = r.entries.length > 1 ? ` (+${r.entries.length - 1} more)` : '';
    const label = shortIdByCase.get(caseId) || ref;
  lines.push(`  ${symbol(recorded)} ${label.padEnd(10)} ${String(recorded).padEnd(11)} ${lead.title}${more}`);
  }
  lines.push(
    `  ${counts.total} in run · ${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped · ${counts.notStarted} not started`
  );
  if (unresolved.length) lines.push(`  Not found in project: ${unresolved.join(', ')}`);
  if (missingInstance.length) lines.push(`  Could not add to the run: ${missingInstance.join(', ')}`);
  if (unlinked.length) lines.push(`  ${unlinked.length} test(s) have no Test Manager case ID and were not reported.`);
  lines.push(`  Reuse this run from other shards with TESTMU_RUN_ID=${runId}`);
  log.log(lines.join('\n'));
}

function summarizeInstances(instances) {
  const c = { total: instances.length, passed: 0, failed: 0, skipped: 0, notStarted: 0 };
  for (const i of instances) {
    const s = String(i.status || '').toLowerCase();
    if (s === 'passed') c.passed++;
    else if (s === 'failed') c.failed++;
    else if (s === 'skipped') c.skipped++;
    else c.notStarted++;
  }
  return c;
}

function symbol(status) {
  const s = String(status).toLowerCase();
  if (s === 'passed') return '✓';
  if (s === 'failed') return '✗';
  return '-';
}

module.exports = { PREFIX, resolveOptions, disabledReason, syncResults, summarizeInstances };
