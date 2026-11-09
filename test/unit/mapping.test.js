'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../src/mapping');

const ULID = '01J3Q2ZTG995PXPMQFQE2WYVDV';

test('normalizeRef accepts TC ids and ULIDs, rejects other text', () => {
  assert.equal(m.normalizeRef('@TC-123'), 'TC-123');
  assert.equal(m.normalizeRef('[tc-7]'), 'TC-7');
  assert.equal(m.normalizeRef(`@tm:${ULID.toLowerCase()}`), ULID);
  assert.equal(m.normalizeRef('@smoke'), null);
  assert.equal(m.normalizeRef(undefined), null);
});

test('extractCaseRefs reads test and describe names', () => {
  assert.deepEqual(m.extractCaseRefs({ ancestorTitles: ['checkout @TC-5'], title: 'total [TC-2] and @TC-3' }), ['TC-5', 'TC-2', 'TC-3']);
  assert.deepEqual(m.extractCaseRefs({ title: `x @tm:${ULID}` }), [ULID]);
  assert.deepEqual(m.extractCaseRefs({ title: 'TC-1 without marker, email a@TC.com' }), []);
});

test('toStatus maps Jest statuses', () => {
  assert.equal(m.toStatus('passed'), 'Passed');
  assert.equal(m.toStatus('failed'), 'Failed');
  for (const s of ['skipped', 'pending', 'todo', 'disabled']) assert.equal(m.toStatus(s), 'Skipped');
});

test('mergeStatus: Failed > Passed > Skipped', () => {
  assert.equal(m.mergeStatus('Passed', 'Failed'), 'Failed');
  assert.equal(m.mergeStatus('Skipped', 'Passed'), 'Passed');
  assert.equal(m.mergeStatus(undefined, 'Skipped'), 'Skipped');
});

test('displayTitle drops case-ID markers', () => {
  assert.equal(m.displayTitle({ ancestorTitles: ['profile @TC-5'], title: 'avatar [TC-6] upload' }), 'profile › avatar upload');
});

test('failureMessage strips ANSI', () => {
  assert.equal(m.failureMessage({ failureMessages: ['\u001b[31mExpected\u001b[39m 1'] }), 'Expected 1');
  assert.equal(m.failureMessage({}), 'Test failed');
});

test('buildRemarks escapes HTML and truncates', () => {
  const html = m.buildRemarks([
    { title: 'a <b>', status: 'Failed', error: 'x'.repeat(20000) },
    { title: 'ok', status: 'Passed' },
  ]);
  assert.match(html, /a &lt;b&gt;/);
  assert.match(html, /truncated/);
  assert.match(html, /@testmuai\/jest-reporter/);
  assert.doesNotMatch(html, /<strong>ok/);
  assert.ok(html.length < 9000);
});
