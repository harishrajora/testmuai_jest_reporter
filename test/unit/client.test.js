'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TestManagerClient, TestManagerError, REGIONS } = require('../../src/client');
const { createMockServer } = require('../mock-server');

let mock;
before(async () => {
  mock = createMockServer({ caseCount: 3 });
  await mock.start();
});
after(() => mock.stop());

const client = () => new TestManagerClient({ username: 'user', accessKey: 'key', apiUrl: mock.url, retries: 2 });

test('region selects the base URL', () => {
  assert.equal(new TestManagerClient({ username: 'u', accessKey: 'k' }).baseUrl, REGIONS.us);
  assert.equal(new TestManagerClient({ username: 'u', accessKey: 'k', region: 'EU' }).baseUrl, REGIONS.eu);
  assert.throws(() => new TestManagerClient({ username: 'u', accessKey: 'k', region: 'mars' }), /Unknown region/);
  assert.throws(() => new TestManagerClient({ username: 'u' }), /required/);
});

test('sends Basic auth built from username:accessKey', async () => {
  await client().listTestCases('PROJ1');
  const last = mock.state.requests.at(-1);
  assert.equal(last.auth, 'Basic ' + Buffer.from('user:key').toString('base64'));
});

test('full flow against the mock', async () => {
  const c = client();
  const cases = await c.listTestCases('PROJ1');
  assert.equal(cases.length, 3);
  const runId = await c.createTestRun({ projectId: 'PROJ1', title: 't' });
  await c.setRunTestCases(runId, { projectId: 'PROJ1', title: 't', testCaseIds: cases.map((x) => x.test_case_id), environmentId: '42' });
  const putBody = mock.state.requests.at(-1).body;
  assert.equal(putBody.test_run_instances[0].environment_id, 42);
  const { instances } = await c.getRunInstances(runId, { perPage: 2 });
  assert.equal(instances.length, 3, 'paged through instances');
  await c.bulkUpdateStatus(runId, instances.map((i) => i.id), 'Passed', { chunkSize: 2 });
  await c.updateInstance(instances[0].id, { status: 'Failed', remarks: '<p>x</p>' });
  await c.setRunStatus(runId, 'Failed');
  const run = mock.state.runs.get(runId);
  assert.deepEqual(run.instances.map((i) => i.status), ['Failed', 'Passed', 'Passed']);
  assert.equal(run.status, 'Failed');
});

test('environment_id is omitted when not set', async () => {
  const c = client();
  const runId = await c.createTestRun({ projectId: 'PROJ1', title: 't2' });
  await c.setRunTestCases(runId, { projectId: 'PROJ1', title: 't2', testCaseIds: [mock.state.testCases[0].test_case_id] });
  assert.ok(!('environment_id' in mock.state.requests.at(-1).body.test_run_instances[0]));
});

test('setRunTestCases replaces the list but keeps existing instances', async () => {
  const c = client();
  const [a, b] = mock.state.testCases;
  const runId = await c.createTestRun({ projectId: 'PROJ1', title: 'r' });
  await c.setRunTestCases(runId, { projectId: 'PROJ1', title: 'r', testCaseIds: [a.test_case_id] });
  const first = (await c.getRunInstances(runId)).instances[0];
  await c.bulkUpdateStatus(runId, [first.id], 'Passed');
  await c.setRunTestCases(runId, { projectId: 'PROJ1', title: 'r', testCaseIds: [b.test_case_id] });
  assert.deepEqual((await c.getRunInstances(runId)).instances.map((i) => i.test_case_id), [b.test_case_id], 'replaced');
  await c.setRunTestCases(runId, { projectId: 'PROJ1', title: 'r', testCaseIds: [b.test_case_id, a.test_case_id] });
  const after = (await c.getRunInstances(runId)).instances;
  assert.equal(after.length, 2);
});

test('blank objective is replaced by a default', async () => {
  const c = client();
  const runId = await c.createTestRun({ projectId: 'PROJ1', title: 'o', objective: '   ' });
  await c.setRunTestCases(runId, { projectId: 'PROJ1', title: 'o', objective: ' ', testCaseIds: [] });
  assert.match(mock.state.requests.at(-1).body.objective, /\S/);
});

test('field-keyed error messages are readable', () => {
  const { errorText } = require('../../src/client');
  assert.equal(errorText({ message: { objective: 'objective cannot be just spaces' } }), 'objective: objective cannot be just spaces');
  assert.equal(errorText({ message: 'Invalid project ID' }), 'Invalid project ID');
  assert.equal(errorText({}, 'Bad Request'), 'Bad Request');
  assert.equal(errorText({ message: [{ key: 'SyntaxError', detail: 'bad tags' }] }), 'bad tags');
});

test('4xx errors throw TestManagerError without retrying', async () => {
  const n = mock.state.requests.length;
  await assert.rejects(client().createTestRun({ projectId: 'NOPE', title: 'x' }), (e) => e instanceof TestManagerError && e.status === 422);
  assert.equal(mock.state.requests.length, n + 1);
});

test('a 200 response with type "error" is treated as a failure', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ type: 'error', message: 'Invalid Entity ID' }), { status: 200 });
  const c = new TestManagerClient({ username: 'u', accessKey: 'k', apiUrl: 'http://x.test', fetchImpl, retries: 0 });
  await assert.rejects(c.setRunStatus('r', 'Passed'), /Invalid Entity ID/);
});

test('5xx is retried, then succeeds', async () => {
  mock.state.failFirst['POST /api/v1/test-run'] = 2;
  const id = await client().createTestRun({ projectId: 'PROJ1', title: 'retry' });
  assert.ok(id);
});
