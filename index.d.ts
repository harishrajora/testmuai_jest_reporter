export interface TestMuJestReporterOptions {
  /** TestMu AI username. Default: LT_USERNAME */
  username?: string;
  /** TestMu AI access key. Default: LT_ACCESS_KEY */
  accessKey?: string;
  /** Test Manager project ID. Default: TESTMU_PROJECT_ID */
  projectId?: string;
  /** Existing run to report into (e.g. shared by CI shards). Default: TESTMU_RUN_ID */
  runId?: string;
  /** Title for a new run. Default: TESTMU_RUN_TITLE or "Jest run <date> UTC" */
  runTitle?: string;
  /** Objective / description for a new run. Default: TESTMU_RUN_OBJECTIVE */
  objective?: string;
  /** Tags for a new run. Default: TESTMU_RUN_TAGS (comma separated) or ["jest"] */
  tags?: string[];
  /** Configuration ID to attach to each result. Optional. Default: TESTMU_ENVIRONMENT_ID */
  environmentId?: string | number;
  /** "us" (default) or "eu". Default: TESTMU_REGION */
  region?: 'us' | 'eu';
  /** Override the API base URL. Default: TESTMU_TM_API_URL */
  apiUrl?: string;
  /** Report skipped / todo tests as Skipped. Default: true (TESTMU_REPORT_SKIPPED) */
  reportSkipped?: boolean;
  /** Set the overall run status at the end. Default: true (TESTMU_SET_RUN_STATUS) */
  setRunStatus?: boolean;
  /** Report on every re-run in --watch mode. Default: false (TESTMU_REPORT_IN_WATCH_MODE) */
  reportInWatchMode?: boolean;
  /** Print what would be sent without calling the API. Default: false (TESTMU_DRY_RUN) */
  dryRun?: boolean;
  /** Turn the reporter on or off. Default: true (TESTMU_REPORTER_ENABLED) */
  enabled?: boolean;
  /** Parallel requests used for failed-test updates. Default: 5 */
  concurrency?: number;
}

declare class TestMuJestReporter {
  constructor(globalConfig?: unknown, reporterOptions?: TestMuJestReporterOptions);
  onRunStart(): void;
  onRunComplete(testContexts: unknown, aggregatedResults: unknown): Promise<void>;
  getLastError(): Error | undefined;
}

export = TestMuJestReporter;
