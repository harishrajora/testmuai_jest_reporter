'use strict';

const { TestMuJestReporter } = require('./reporter');
const { TestManagerClient, TestManagerError } = require('./client');

// Jest loads a reporter from the module's export.
module.exports = TestMuJestReporter;
module.exports.default = TestMuJestReporter;
module.exports.TestMuJestReporter = TestMuJestReporter;
module.exports.TestManagerClient = TestManagerClient;
module.exports.TestManagerError = TestManagerError;
