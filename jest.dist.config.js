/**
 * Runs the test suites against the BUILT package (dist/cjs) instead of src, so the shipped code is
 * tested too, including build-time transforms (renamed internals, target).
 *
 * Every test file runs here unless its header says `@dist-skip <reason>`: white-box tests that
 * read internal properties, which the build renames on purpose. Opting out (rather than listing
 * the files to run) means a new test file is never forgotten.
 * @type {import('jest').Config}
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const base = require('./jest.config.js');

const testFiles = (directory) =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return testFiles(path);
    return entry.endsWith('.test.ts') ? [path] : [];
  });

/** Test files whose header opts out, with a reason. */
const skipped = testFiles(join(__dirname, '__tests__')).filter((path) =>
  /@dist-skip\s+\S/.test(readFileSync(path, 'utf8').slice(0, 2000))
);

const escapeRegExp = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  ...base,
  collectCoverage: false,
  coverageThreshold: undefined,
  moduleNameMapper: {
    '^(?:\\.\\./)+src/(.*?)(?:\\.js)?$': '<rootDir>/dist/cjs/$1.js',
    ...base.moduleNameMapper
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', ...skipped.map(escapeRegExp)]
};
