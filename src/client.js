'use strict';

const REGIONS = {
  us: 'https://test-manager-api.lambdatest.com',
  eu: 'https://eu-test-manager-api.lambdatest.com',
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class TestManagerError extends Error {
  constructor(message, { status, method, path, body } = {}) {
    super(message);
    this.name = 'TestManagerError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

// Error bodies carry "message" as a string or as a { field: reason } object.
function errorText(data, fallback) {
  const m = data && (data.message || data.error || data.title);
  if (!m) return fallback || 'request failed';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) {
    return m.map((x) => (x && typeof x === 'object' ? x.detail || x.message || JSON.stringify(x) : String(x))).join('; ');
  }
  if (typeof m === 'object') {
    return Object.entries(m)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('; ');
  }
  return String(m);
}

const DEFAULT_OBJECTIVE = 'Jest results reported by @testmuai/jest-reporter';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin client for the TestMu AI Test Manager public REST API.
 * https://www.testmuai.com/support/api-doc/ (Test Manager section)
 */
class TestManagerClient {
  constructor({ username, accessKey, region = 'us', apiUrl, timeoutMs = 30000, retries = 3, fetchImpl } = {}) {
    if (!username || !accessKey) {
      throw new Error('username and accessKey are required');
    }
    const base = apiUrl || REGIONS[String(region).toLowerCase()];
    if (!base) {
      throw new Error(`Unknown region "${region}". Use "us" or "eu", or set apiUrl.`);
    }
    this.baseUrl = base.replace(/\/+$/, '');
    this.auth = 'Basic ' + Buffer.from(`${username}:${accessKey}`).toString('base64');
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new Error('global fetch is not available; Node.js 18 or later is required');
    }
  }

  async request(method, path, body) {
    const url = this.baseUrl + path;
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: this.auth,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = new TestManagerError(`${method} ${path} failed: ${err.message}`, { method, path });
        continue;
      }

      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      // Some endpoints answer 200 with {"type":"error", ...}, so check the body too.
      const bodyType = data && typeof data.type === 'string' ? data.type.toLowerCase() : '';
      if (res.ok && bodyType !== 'error') return data;

      lastError = new TestManagerError(`${method} ${path} -> ${res.status}: ${errorText(data, res.statusText)}`, {
        status: res.status,
        method,
        path,
        body: data,
      });
      if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
    }
    throw lastError;
  }

  /** POST /api/v1/test-run -> run id */
  async createTestRun({ projectId, title, objective, tags = [] }) {
    const data = await this.request('POST', '/api/v1/test-run', {
      title,
      objective: nonBlank(objective) || DEFAULT_OBJECTIVE,
      test_run_instances: [],
      tags,
      project_id: projectId,
      is_auteur_generated: false,
    });
    const id = data.id || (data.data && data.data.id);
    if (!id) throw new TestManagerError('Create Test Run returned no id', { body: data });
    return String(id);
  }

  /**
   * PUT /api/v1/test-run/{id}. The API REPLACES the run's test case list with the one sent:
   * pass every case that should be in the run. Cases already in the run keep their
   * instance id and status. The API rejects a blank objective.
   */
  async setRunTestCases(runId, { projectId, title, objective, tags = [], testCaseIds, environmentId }) {
    const instances = testCaseIds.map((testCaseId, i) => {
      const inst = { test_case_id: testCaseId, serial_no: i + 1 };
      if (environmentId !== undefined && environmentId !== null && environmentId !== '') {
        inst.environment_id = Number(environmentId);
      }
      return inst;
    });
    return this.request('PUT', `/api/v1/test-run/${encodeURIComponent(runId)}`, {
      id: runId,
      title,
      objective: nonBlank(objective) || DEFAULT_OBJECTIVE,
      tags,
      is_auteur_generated: false,
      test_run_instances: instances,
      project_id: projectId,
    });
  }

  /** GET /api/v1/test-run/instances/{id}, all pages. */
  async getRunInstances(runId, { perPage = 100, maxPages = 200 } = {}) {
    const instances = [];
    let details;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request(
        'GET',
        `/api/v1/test-run/instances/${encodeURIComponent(runId)}?page=${page}&per_page=${perPage}`
      );
      details = data.test_run_details || details;
      const block = data.test_run_instances || {};
      const rows = Array.isArray(block) ? block : block.data || [];
      instances.push(...rows);
      const pg = block.pagination || data.pagination;
      if (rows.length === 0) break;
      if (pg && pg.last_page !== undefined ? page >= pg.last_page : rows.length < perPage) break;
    }
    return { details: details || {}, instances };
  }

  /** GET /api/v1/projects/{id}/test-cases, all pages. */
  async listTestCases(projectId, { perPage = 100, maxPages = 500 } = {}) {
    const cases = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request(
        'GET',
        `/api/v1/projects/${encodeURIComponent(projectId)}/test-cases?page=${page}&per_page=${perPage}`
      );
      const rows = Array.isArray(data) ? data : data.data || [];
      cases.push(...rows);
      const pg = data.pagination || data.meta;
      if (rows.length === 0) break;
      if (pg && pg.last_page !== undefined ? page >= pg.last_page : rows.length < perPage) break;
    }
    return cases;
  }

  /** PUT /api/v2/test-run/{id}/bulk-update: one status for many instances. */
  async bulkUpdateStatus(runId, instanceIds, status, { chunkSize = 500 } = {}) {
    for (let i = 0; i < instanceIds.length; i += chunkSize) {
      const chunk = instanceIds.slice(i, i + chunkSize).map(Number);
      await this.request('PUT', `/api/v2/test-run/${encodeURIComponent(runId)}/bulk-update`, {
        scope: { instance_ids: chunk },
        patch: { status },
      });
    }
  }

  /** PUT /api/v1/test-run/instance/{id}: status plus HTML remarks. */
  async updateInstance(instanceId, { status, remarks }) {
    const body = {};
    if (status) body.status = status;
    if (remarks) body.remarks = remarks;
    return this.request('PUT', `/api/v1/test-run/instance/${encodeURIComponent(instanceId)}`, body);
  }

  /** PUT /api/v1/test-run/status/{id}: overall run status. */
  async setRunStatus(runId, status) {
    return this.request('PUT', `/api/v1/test-run/status/${encodeURIComponent(runId)}`, { status });
  }
}

function nonBlank(v) {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

module.exports = { TestManagerClient, TestManagerError, REGIONS, DEFAULT_OBJECTIVE, errorText };
