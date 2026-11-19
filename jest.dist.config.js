/**
 * Runs the public-API test suites against the BUILT package (dist/cjs) instead of src, so the
 * shipped code is tested too, including any build-time transforms (renamed internals, target).
 * @type {import('jest').Config}
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  collectCoverage: false,
  coverageThreshold: undefined,
  moduleNameMapper: {
    '^(?:\\.\\./)+src/(.*?)(?:\\.js)?$': '<rootDir>/dist/cjs/$1.js',
    ...base.moduleNameMapper
  },
  testMatch: [
    '**/__tests__/audio-queue*.test.ts',
    '**/__tests__/default-queue.test.ts',
    '**/__tests__/index.test.ts',
    '**/__tests__/media-session.test.ts',
    '**/__tests__/preload.test.ts',
    '**/__tests__/sprite.test.ts',
    '**/__tests__/store.test.ts',
    '**/__tests__/webvtt.test.ts',
    '**/__tests__/integration/*.test.ts'
  ]
};
