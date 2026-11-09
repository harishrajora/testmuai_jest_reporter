'use strict';

const { STATUS, extractCaseRefs, toStatus, mergeStatus, failureMessage, displayTitle } = require('./mapping');
const { PREFIX, resolveOptions, disabledReason, syncResults } = require('./sync');

/**
 * Jest reporter that records Passed / Failed / Skipped results in
 * TestMu AI Test Manager, for tests run anywhere.
 */
class TestMuJestReporter {
  /**
   * @param {object} globalConfig   Jest global config
   * @param {object} reporterOptions options from the jest config `reporters` entry
   */
  constructor(globalConfig = {}, reporterOptions = {}) {
    this.opts = resolveOptions(reporterOptions || {});
    this.log = this.opts.logger;
    this.watching = Boolean(globalConfig.watch || globalConfig.watchAll);
    this.disabledReason = disabledReason(this.opts);
    if (!this.disabledReason && this.watching && !this.opts.reportInWatchMode) {
      this.disabledReason = 'watch mode (set reportInWatchMode to report every re-run)';
    }
    this.warned = false;
  }

  onRunStart() {
    if (this.disabledReason && this.opts.enabled && !this.warned) {
      this.warned = true;
      this.log.warn(`${PREFIX} Test Manager reporting is off: ${this.disabledReason}.`);
    }
  }

  /** Builds { ref -> { status, entries[] } }, unlinked tests and files that failed to run. */
  collect(aggregatedResults) {
    const byRef = new Map();
    const unlinked = [];
    const brokenFiles = [];
    for (const file of aggregatedResults.testResults || []) {
      if (file.testExecError) brokenFiles.push(file.testFilePath);
      for (const a of file.testResults || []) {
        const status = toStatus(a.status);
        if (status === STATUS.SKIPPED && !this.opts.reportSkipped) continue;
        const entry = {
          title: displayTitle(a),
          status,
          error: status === STATUS.FAILED ? failureMessage(a) : undefined,
        };
        const refs = extractCaseRefs(a);
        if (!refs.length) {
          unlinked.push(entry);
          continue;
        }
        for (const ref of refs) {
          const cur = byRef.get(ref) || { status: undefined, entries: [] };
          cur.status = mergeStatus(cur.status, status);
          cur.entries.push(entry);
          byRef.set(ref, cur);
        }
      }
    }
    return { byRef, unlinked, brokenFiles };
  }

  async onRunComplete(testContexts, aggregatedResults) {
    if (this.disabledReason || !aggregatedResults) return;
    try {
      const { byRef, unlinked, brokenFiles } = this.collect(aggregatedResults);
      if (brokenFiles.length) {
        this.log.warn(
          `${PREFIX} ${brokenFiles.length} test file(s) failed to run, so their tests were not reported:\n` +
            brokenFiles.map((f) => `  ${f}`).join('\n')
        );
      }
      await syncResults(this.opts, { byRef, unlinked });
    } catch (err) {
      // Never change the outcome of the test run because reporting failed.
      this.log.warn(`${PREFIX} Could not send results to Test Manager: ${err.message}`);
    }
  }

  /** Jest fails the run if this returns an error; reporting problems never should. */
  getLastError() {
    return undefined;
  }
}

module.exports = { TestMuJestReporter };
