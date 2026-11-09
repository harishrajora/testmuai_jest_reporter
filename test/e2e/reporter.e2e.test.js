'use strict';

// Runs a real Jest suite with the reporter against the mock Test Manager API.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMockServer } = require('../mock-server');

const ROOT = path.resolve(__dirname, '../..');
const JEST = require.resolve('jest/bin/jest', { paths: [ROOT] });
const CONFIG = path.join(__dirname, 'fixture', 'jest.config.js');

// Async spawn: the mock server lives in this process and must keep answering.
function runJest(env, extraArgs = []) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^(LT_|TESTMU_)/.test(k)) delete clean[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, '--config', CONFIG, '--ci', ...extraArgs], {
      cwd: ROOT,
      env: { ...clean, FORCE_COLOR: '0', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

let mock;
const creds = { LT_USERNAME: 'user', LT_ACCESS_KEY: 'key', TESTMU_PROJECT_ID: 'PROJ1' };

before(async () => {
  mock = createMockServer({ caseCount: 150 }); // > 1 page of test cases
  await mock.start();
});
after(() => mock.stop());

let firstRunId;

test('records results for a full run', async () => {
  mock.state.requests.length = 0;
  const { code, out } = await runJest({ ...creds, TESTMU_TM_API_URL: mock.url, TESTMU_RUN_TITLE: 'e2e run' });
  assert.equal(code, 1, 'suite has failing tests, so Jest exits 1');

  assert.equal(mock.state.runs.size, 1, out);
  const run = [...mock.state.runs.values()][0];
  firstRunId = run.id;
  assert.equal(run.title, 'e2e run');

  const byInternal = Object.fromEntries(run.instances.map((i) => [i.internal_id, i]));
  assert.deepEqual(Object.keys(byInternal).sort(), ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5', 'TC-6']);
  assert.equal(byInternal['TC-1'].status, 'Passed');
  assert.equal(byInternal['TC-2'].status, 'Failed', '[TC-2] form is recognised');
  assert.equal(byInternal['TC-3'].status, 'Skipped');
  assert.equal(byInternal['TC-4'].status, 'Passed', 'flaky test that passed on retry counts as Passed');
  assert.equal(byInternal['TC-5'].status, 'Failed', 'ID on describe applies to its tests; one failure fails the case');
  assert.equal(byInternal['TC-6'].status, 'Passed', '@tm:<ULID> form is recognised');

  assert.match(byInternal['TC-2'].remarks, /Expected: 43/);
  assert.match(byInternal['TC-5'].remarks, /crop box was &lt;null&gt; &amp; resize failed/);
  assert.match(byInternal['TC-5'].remarks, /profile › avatar &lt;crop&gt; &amp; resize/);
  assert.doesNotMatch(byInternal['TC-2'].remarks, /\u001b\[/);

  assert.equal(run.status, 'Failed');
  assert.equal(mock.state.requests.filter((r) => r.path.endsWith('/test-cases')).length, 2, 'paged through test cases');

  assert.match(out, /\[testmu\] Test Manager run "e2e run"/);
  assert.match(out, /6 in run · 3 passed · 2 failed · 1 skipped · 0 not started/);
  assert.match(out, /✗ TC-5\s+Failed\s+profile › avatar <crop> & resize \(\+1 more\)/);
  assert.match(out, /Not found in project: TC-999/);
  assert.match(out, /✓ TC-6\s+Passed\s+settings page loads/, 'long ID shown as its TC number');
  assert.match(out, /1 test\(s\) have no Test Manager case ID/);
  assert.match(out, /1 test file\(s\) failed to run[\s\S]*broken\.spec\.js/);
  assert.match(out, new RegExp(`TESTMU_RUN_ID=${run.id}`));
});

test('reusing a run keeps cases another job added and their status', async () => {
  const run = mock.state.runs.get(firstRunId);
  const other = mock.state.testCases[40];
  run.instances = run.instances.filter((i) => i.internal_id !== 'TC-6');
  run.instances.push({ id: 99999, test_case_id: other.test_case_id, internal_id: other.internal_id, title: other.title, status: 'Passed' });
  mock.state.requests.length = 0;
  await runJest({ ...creds, TESTMU_TM_API_URL: mock.url, TESTMU_RUN_ID: firstRunId });
  assert.ok(!mock.state.requests.some((r) => r.method === 'POST'), 'no new run');
  const put = mock.state.requests.find((r) => r.method === 'PUT' && r.path === `/api/v1/test-run/${firstRunId}`);
  assert.ok(put, 'TC-6 had to be added');
  assert.ok(put.body.tags.every((t) => typeof t === 'string'), 'tags sent as names');
  assert.equal(run.instances.find((i) => i.id === 99999).status, 'Passed');
  assert.equal(run.instances.length, 7);
  assert.equal(run.title, 'e2e run');
});

test('missing credentials: warns and sends nothing', async () => {
  mock.state.requests.length = 0;
  const { code, out } = await runJest({ TESTMU_TM_API_URL: mock.url });
  assert.equal(code, 1);
  assert.match(out, /reporting is off: missing LT_USERNAME, LT_ACCESS_KEY, TESTMU_PROJECT_ID/);
  assert.equal(mock.state.requests.length, 0);
});

test('wrong credentials: warns, does not change the exit code', async () => {
  const { code, out } = await runJest({ ...creds, LT_ACCESS_KEY: 'wrong', TESTMU_TM_API_URL: mock.url });
  assert.equal(code, 1);
  assert.match(out, /Could not send results to Test Manager: .*401/);
});

test('a passing suite still exits 0 with the reporter on', async () => {
  const { code, out } = await runJest({ ...creds, TESTMU_TM_API_URL: mock.url }, ['-t', 'login works']);
  assert.equal(code, 1, 'broken.spec.js still fails the run'); // sanity: file-level failure is Jest's, not ours
  const ok = await runJest({ ...creds, LT_ACCESS_KEY: 'wrong', TESTMU_TM_API_URL: mock.url }, ['-t', 'login works', '--testPathIgnorePatterns', 'broken']);
  assert.equal(ok.code, 0, 'reporting failure never fails a green run:\n' + ok.out);
  assert.ok(out);
});

test('dry run prints the plan and sends nothing', async () => {
  mock.state.requests.length = 0;
  const { out } = await runJest({ TESTMU_DRY_RUN: '1', TESTMU_TM_API_URL: mock.url });
  assert.equal(mock.state.requests.length, 0);
  assert.match(out, /Dry run: nothing was sent/);
  assert.match(out, /TC-2\s+Failed/);
});

test('watch mode is off by default', () => {
  const { TestMuJestReporter } = require('../../src/reporter');
  const warnings = [];
  const r = new TestMuJestReporter({ watch: true }, { username: 'u', accessKey: 'k', projectId: 'p', logger: { warn: (m) => warnings.push(m), log() {} } });
  r.onRunStart();
  assert.match(warnings[0], /watch mode/);
});
