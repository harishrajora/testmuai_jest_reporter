'use strict';

// In-memory stand-in for the Test Manager API, shaped after the public docs.
// Used only by the tests in this repo.

const http = require('node:http');

const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function fakeUlid(seed) {
  let s = '';
  let n = seed * 7919 + 104729;
  for (let i = 0; i < 26; i++) {
    s += ULID_CHARS[n % 32];
    n = Math.floor(n / 3) + i * 31 + seed;
  }
  return s;
}

function createMockServer({ username = 'user', accessKey = 'key', projectId = 'PROJ1', caseCount = 5, failFirst = {} } = {}) {
  const state = {
    requests: [],
    testCases: Array.from({ length: caseCount }, (_, i) => ({
      project_id: projectId,
      test_case_id: fakeUlid(i + 1),
      internal_id: `TC-${i + 1}`,
      title: `Case ${i + 1}`,
    })),
    runs: new Map(),
    nextRunSeq: 1,
    nextInstanceId: 1000,
    failFirst: { ...failFirst }, // e.g. { 'POST /api/v1/test-run': 2 } -> answer 503 twice first
  };
  const expectedAuth = 'Basic ' + Buffer.from(`${username}:${accessKey}`).toString('base64');

  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const err = (res, code, message) => send(res, code, { type: 'error', message });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      const key = `${req.method} ${url.pathname.replace(/\/[^/]*\d[^/]*$/, '/:id')}`;
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });

      if (req.headers.authorization !== expectedAuth) return err(res, 401, 'Unauthorized');

      for (const k of Object.keys(state.failFirst)) {
        if (`${req.method} ${url.pathname}`.startsWith(k) && state.failFirst[k] > 0) {
          state.failFirst[k]--;
          return err(res, 503, 'Service Unavailable');
        }
      }

      const page = Number(url.searchParams.get('page') || 1);
      const perPage = Number(url.searchParams.get('per_page') || 10);
      const paginate = (rows) => rows.slice((page - 1) * perPage, page * perPage);
      let m;

      if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/test-cases$/))) {
        if (m[1] !== projectId) return err(res, 422, 'Invalid project ID');
        // The documented response has no pagination block, so callers must stop on a short page.
        return send(res, 200, { data: paginate(state.testCases) });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/test-run') {
        if (!body || !body.title || body.project_id !== projectId) return err(res, 422, 'Invalid project ID');
        const id = fakeUlid(9000 + state.nextRunSeq++);
        state.runs.set(id, { id, title: body.title, objective: body.objective, project_id: body.project_id, tags: body.tags || [], status: 'Not Started', instances: [] });
        return send(res, 200, { message: 'Test Run created successfully', type: 'Success', id });
      }

      if (req.method === 'PUT' && (m = url.pathname.match(/^\/api\/v1\/test-run\/status\/([^/]+)$/))) {
        const run = state.runs.get(m[1]);
        if (!run) return err(res, 422, 'Invalid test run ID');
        if (!['Passed', 'Failed', 'Skipped', 'In Progress', 'Not Started'].includes(body.status)) return err(res, 422, 'Invalid status');
        run.status = body.status;
        return send(res, 200, { message: 'Test Run updated successfully', type: 'Success' });
      }

      if (req.method === 'PUT' && (m = url.pathname.match(/^\/api\/v1\/test-run\/instance\/([^/]+)$/))) {
        const inst = [...state.runs.values()].flatMap((r) => r.instances).find((i) => String(i.id) === m[1]);
        if (!inst) return err(res, 422, 'Invalid test instance ID');
        if (body.status && !['Passed', 'Failed', 'Skipped', 'Not Started'].includes(body.status)) return err(res, 422, 'Invalid status');
        if (body.status) inst.status = body.status;
        if (body.remarks !== undefined) inst.remarks = body.remarks;
        return send(res, 200, { message: 'Test Run Instance updated successfully', type: 'Success' });
      }

      if (req.method === 'PUT' && (m = url.pathname.match(/^\/api\/v2\/test-run\/([^/]+)\/bulk-update$/))) {
        const run = state.runs.get(m[1]);
        if (!run) return err(res, 422, 'Invalid test run ID');
        const ids = body && body.scope && body.scope.instance_ids;
        if (!Array.isArray(ids) || !body.patch) return err(res, 422, 'scope and patch are required');
        for (const id of ids) {
          const inst = run.instances.find((i) => i.id === id);
          if (!inst) return err(res, 422, `Invalid instance ID ${id}`);
        }
        for (const id of ids) Object.assign(run.instances.find((i) => i.id === id), body.patch);
        return send(res, 200, { message: 'Test Run Instances updated successfully', type: 'Success' });
      }

      if (req.method === 'PUT' && (m = url.pathname.match(/^\/api\/v1\/test-run\/([^/]+)$/))) {
        const run = state.runs.get(m[1]);
        if (!run) return err(res, 422, 'Invalid test run ID');
        // Matches the live API: tags must be plain strings.
        if (Array.isArray(body.tags) && body.tags.some((t) => typeof t !== 'string')) {
          return send(res, 400, { type: 'error', message: [{ key: 'SyntaxError', detail: 'Please, give correct input value for the "tags" field' }] });
        }
        // Matches the live API: a blank objective is rejected with a field-keyed message object.
        if (typeof body.objective !== 'string' || !body.objective.trim()) {
          return send(res, 422, { type: 'error', title: 'Request Not Processed', message: { objective: 'objective cannot be just spaces' } });
        }
        // Matches the live API: the list sent REPLACES the run's cases; cases already
        // in the run keep their instance id and status.
        const next = [];
        for (const ti of body.test_run_instances || []) {
          const tc = state.testCases.find((c) => c.test_case_id === ti.test_case_id);
          if (!tc) return err(res, 422, `Invalid test case ID ${ti.test_case_id}`);
          const keep = run.instances.find((i) => i.test_case_id === tc.test_case_id);
          next.push(
            keep || {
              id: state.nextInstanceId++,
              test_case_id: tc.test_case_id,
              title: tc.title,
              internal_id: tc.internal_id,
              status: 'Not Started',
              environment: { id: ti.environment_id || 5, name: ti.environment_id ? 'Custom' : 'No config selected' },
            }
          );
        }
        run.instances = next;
        run.objective = body.objective;
        if (Array.isArray(body.tags)) run.tags = body.tags;
        if (body.title) run.title = body.title;
        return send(res, 200, { message: 'Test Run updated successfully', type: 'Success' });
      }

      if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/v1\/test-run\/instances\/([^/]+)$/))) {
        const run = state.runs.get(m[1]);
        if (!run) return err(res, 404, 'Test run not found');
        const count = (s) => run.instances.filter((i) => i.status === s).length;
        return send(res, 200, {
          test_run_details: {
            id: run.id,
            title: run.title,
            objective: run.objective,
            // Matches the live API: tags come back as objects.
            tags: run.tags.map((name, i) => ({ tag_id: 100 + i, name })),
            project_id: run.project_id,
            status: run.status,
            run_result: {
              total_test: run.instances.length,
              passed: count('Passed'),
              failed: count('Failed'),
              skipped: count('Skipped'),
              not_started: count('Not Started'),
            },
          },
          test_run_instances: {
            data: paginate(run.instances),
            pagination: { current_page: page, last_page: Math.max(1, Math.ceil(run.instances.length / perPage)), per_page: perPage, total: run.instances.length },
          },
        });
      }

      return err(res, 404, `No mock route for ${key}`);
    });
  });

  return {
    state,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    stop() {
      return new Promise((r) => server.close(r));
    },
  };
}

module.exports = { createMockServer, fakeUlid };
