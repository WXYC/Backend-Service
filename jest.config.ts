/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type { Config } from 'jest';

const config: Config = {
  // The glob patterns Jest uses to detect test files
  testMatch: ['**/tests/specs/?(*.)+(spec).js'],
  setupFilesAfterEnv: ['./tests/test.setup.js'],
  reporters: [
    'default',
    [
      'jest-html-reporters',
      {
        publicPath: './tests/report', // report directory
        filename: 'report.html', // report file name
        pageTitle: 'SuperTest and Jest API Test Report', // report title
        overwrite: true, // enable report file overwrite
        expand: true, // enable report file expansion
      },
    ],
  ],
};

export default config;
