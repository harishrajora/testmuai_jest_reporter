// Fixture project used by test/e2e/reporter.e2e.test.js.
module.exports = {
  rootDir: __dirname,
  testMatch: ['<rootDir>/*.spec.js'],
  reporters: ['default', [require.resolve('../../../src/index.js'), {}]],
};
