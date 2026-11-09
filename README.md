# @testmuai/jest-reporter

A Jest reporter that records your test results in **TestMu AI Test Manager**, wherever the tests run: your laptop, any CI, any machine.

At the end of a run it:

1. creates a test run in your Test Manager project (or reuses one you pass in),
2. adds the test cases your tests are linked to,
3. marks each one **Passed**, **Failed** or **Skipped**, with the error message as remarks on failures,
4. sets the overall run status, and
5. prints the result, read back from Test Manager, in your terminal.

```
[testmu] Test Manager run "Jest run 2026-11-09 10:55 UTC" (id 01M6...)
  ✓ TC-287     Passed      login works
  ✗ TC-288     Failed      checkout total is right
  - TC-289     Skipped     newsletter signup
  6 in run · 3 passed · 2 failed · 1 skipped · 0 not started
```

Reporting never changes the outcome of your test run. If Test Manager can't be reached, you get a warning and Jest exits as it would have anyway.

## Install

```bash
npm install --save-dev @testmuai/jest-reporter
```

Requires Node.js 18+ and Jest 27+.

## Set up

Add the reporter next to the default one in `jest.config.js`:

```js
module.exports = {
  reporters: [
    'default',
    ['@testmuai/jest-reporter', { projectId: '01J3PWJPQPGHBNPHBXX4DSME1H' }],
  ],
};
```

Set your TestMu AI credentials:

```bash
export LT_USERNAME="your-username"
export LT_ACCESS_KEY="your-access-key"
```

## Link tests to test cases

Only tests linked to a Test Manager test case are reported. Put the case ID you see in Test Manager in the test name:

```js
test('login works @TC-123', () => { /* ... */ });

test('checkout total is right [TC-124]', () => { /* ... */ });

// An ID on a describe block applies to every test inside it
describe('profile @TC-125', () => {
  test('avatar upload', () => { /* ... */ });
  test('avatar crop', () => { /* ... */ });
});
```

The internal `test_case_id` (a 26-character ID) also works: `@tm:01J3Q2ZTG995PXPMQFQE2WYVDV`.

How results are combined:

- A test that passes on retry (`jest.retryTimes`) counts as **Passed**.
- Skipped, `todo` and disabled tests count as **Skipped**.
- If several tests link to the same case, any failure makes the case **Failed**, and every failing test is listed in the remarks.
- Tests with no case ID are counted in the summary and otherwise ignored.
- If a test file fails to load, the reporter lists it, since its tests never ran.
- In `--watch` mode nothing is reported unless you set `reportInWatchMode`, so each re-run doesn't create a new run.

## Options

Every option can be set in the config or with an environment variable.

| Option | Environment variable | Default | |
|---|---|---|---|
| `username` | `LT_USERNAME` | | Required |
| `accessKey` | `LT_ACCESS_KEY` | | Required |
| `projectId` | `TESTMU_PROJECT_ID` | | Required |
| `runId` | `TESTMU_RUN_ID` | | Report into an existing run instead of creating one |
| `runTitle` | `TESTMU_RUN_TITLE` | `Jest run <date> UTC` | |
| `objective` | `TESTMU_RUN_OBJECTIVE` | | Run description |
| `tags` | `TESTMU_RUN_TAGS` (comma separated) | `["jest"]` | Run tags |
| `environmentId` | `TESTMU_ENVIRONMENT_ID` | | Test Manager Configuration to attach to each result. Without it, Test Manager uses "No config selected". |
| `region` | `TESTMU_REGION` | `us` | `us` or `eu` |
| `apiUrl` | `TESTMU_TM_API_URL` | | Override the API base URL |
| `reportSkipped` | `TESTMU_REPORT_SKIPPED` | `true` | |
| `setRunStatus` | `TESTMU_SET_RUN_STATUS` | `true` | Set the overall run to Passed / Failed |
| `reportInWatchMode` | `TESTMU_REPORT_IN_WATCH_MODE` | `false` | |
| `dryRun` | `TESTMU_DRY_RUN` | `false` | Print what would be sent, call nothing |
| `enabled` | `TESTMU_REPORTER_ENABLED` | `true` | |

If a required value is missing, the reporter prints one warning and stays out of the way.

## Sharded runs

Each `--shard` creates its own run unless you give them one to share. Create the run once, then pass its ID to every shard:

```bash
TESTMU_RUN_ID=01JC... npx jest --shard=1/4
```

Every reporter run prints the `TESTMU_RUN_ID` it used. Reusing a run keeps its title, objective and tags, and keeps results other shards already recorded.

## Development

```bash
npm install
npm test            # unit tests + end-to-end tests against a local mock of the Test Manager API
```

The end-to-end tests run a real Jest suite with this reporter pointed at `test/mock-server.js`, which follows the behaviour of the live Test Manager API.

## API calls used

All from the public [Test Manager API](https://www.testmuai.com/support/api-doc/), with Basic auth (`username:accessKey`):

| Step | Call |
|---|---|
| Look up `TC-123` IDs | `GET /api/v1/projects/{project_id}/test-cases` |
| Create run | `POST /api/v1/test-run` |
| Add test cases | `PUT /api/v1/test-run/{test_run_id}` |
| Find instances | `GET /api/v1/test-run/instances/{test_run_id}` |
| Passed / Skipped | `PUT /api/v2/test-run/{test_run_id}/bulk-update` |
| Failed + remarks | `PUT /api/v1/test-run/instance/{test_instance_id}` |
| Run status | `PUT /api/v1/test-run/status/{test_run_id}` |

## License

MIT
