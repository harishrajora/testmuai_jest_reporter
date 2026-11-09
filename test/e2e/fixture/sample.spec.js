// Fixture tests for the end-to-end check. Some fail on purpose.
const { fakeUlid } = require('../../mock-server');

jest.retryTimes(1);
let flakyAttempts = 0;

test('login works @TC-1', () => {
  expect(1 + 1).toBe(2);
});

test('checkout total is right [TC-2]', () => {
  expect(41 + 1).toBe(43);
});

test.skip('newsletter signup @TC-3', () => {});

test('search is flaky @TC-4', () => {
  flakyAttempts++;
  expect(flakyAttempts).toBeGreaterThan(1);
});

describe('profile @TC-5', () => {
  test('avatar upload', () => {
    expect(true).toBe(true);
  });

  test('avatar <crop> & resize', () => {
    throw new Error('crop box was <null> & resize failed');
  });
});

test(`settings page loads @tm:${fakeUlid(6)}`, () => {
  expect(true).toBe(true);
});

test('case that does not exist @TC-999', () => {
  expect(true).toBe(true);
});

test('not linked to any case', () => {
  expect(true).toBe(true);
});
