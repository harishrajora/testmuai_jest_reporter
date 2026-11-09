'use strict';

/** Matches TC-123 style IDs (Test Manager "internal_id"). */
const INTERNAL_ID_RE = /^TC-\d+$/i;

/** Matches the 26-character ULIDs the API uses as test_case_id. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Case IDs written in a test or describe name:
 *   @TC-123   [TC-123]   @tm:<ULID>   [tm:<ULID>]
 */
const REF_IN_TITLE_RE = /(?:@|\[)(TC-\d+|(?:tm|testmu):[0-9A-Za-z]{26})\]?/gi;

const STATUS = {
  PASSED: 'Passed',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
};

/** Normalises a raw reference into its canonical form, or null if it is not an ID. */
function normalizeRef(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().replace(/^[@[]/, '').replace(/]$/, '').replace(/^(tm|testmu):/i, '');
  if (INTERNAL_ID_RE.test(v)) return v.toUpperCase();
  if (ULID_RE.test(v)) return v.toUpperCase();
  return null;
}

/**
 * Case IDs for a Jest assertion result. IDs in a describe name apply to every test inside it.
 * @param {{ ancestorTitles?: string[], title: string }} assertion
 */
function extractCaseRefs(assertion) {
  const refs = new Set();
  for (const text of [...(assertion.ancestorTitles || []), assertion.title]) {
    for (const m of String(text || '').matchAll(REF_IN_TITLE_RE)) {
      const ref = normalizeRef(m[1]);
      if (ref) refs.add(ref);
    }
  }
  return [...refs];
}

/** Jest assertion status -> Test Manager status. Retries (jest.retryTimes) are already folded in. */
function toStatus(jestStatus) {
  switch (jestStatus) {
    case 'passed':
      return STATUS.PASSED;
    case 'failed':
      return STATUS.FAILED;
    default:
      // skipped, pending, todo, disabled, focused
      return STATUS.SKIPPED;
  }
}

/** Worst status wins: Failed > Passed > Skipped. */
function mergeStatus(a, b) {
  const rank = { [STATUS.FAILED]: 3, [STATUS.PASSED]: 2, [STATUS.SKIPPED]: 1 };
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s;
}

/** Jest failure messages, ANSI codes removed. */
function failureMessage(assertion) {
  const msgs = (assertion.failureMessages || []).map(stripAnsi).filter(Boolean);
  return msgs.length ? msgs.join('\n\n').trim() : 'Test failed';
}

/** "describe › test" with case-ID tags removed. */
function displayTitle(assertion) {
  const full = [...(assertion.ancestorTitles || []), assertion.title].filter(Boolean).join(' › ');
  return full.replace(/\s*(?:@|\[)(?:TC-\d+|(?:tm|testmu):[0-9A-Za-z]{26})\]?/gi, '').replace(/\s{2,}/g, ' ').trim() || full;
}

/** HTML remarks for a failed instance (Test Manager renders remarks as rich text). */
function buildRemarks(entries, { maxLength = 8000 } = {}) {
  const failed = entries.filter((e) => e.status === STATUS.FAILED);
  const parts = failed.map((e) => {
    const where = e.project ? ` [${escapeHtml(e.project)}]` : '';
    return `<p><strong>${escapeHtml(e.title)}</strong>${where}</p><pre>${escapeHtml(
      truncate(e.error || 'Test failed', Math.floor(maxLength / Math.max(failed.length, 1)))
    )}</pre>`;
  });
  return `<p>Reported by @testmuai/jest-reporter</p>${parts.join('')}`;
}

module.exports = {
  STATUS,
  normalizeRef,
  extractCaseRefs,
  toStatus,
  mergeStatus,
  failureMessage,
  displayTitle,
  buildRemarks,
  stripAnsi,
  escapeHtml,
  INTERNAL_ID_RE,
  ULID_RE,
};
