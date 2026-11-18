/**
 * Thresholds and budgets used by the validation gates. Change them here, in one place.
 */
export const validationConfig = {
  /** Where reports are written (git-ignored) and how many runs to keep. */
  reports: { directory: '.validation-reports', keep: 5 },

  /** Per-file coverage minimums for every file in src/ (percent). */
  coveragePerFile: { branches: 85, functions: 90, lines: 95, statements: 95 },

  /** Size limits. */
  size: {
    maxFunctionLines: 60,
    maxSourceFileLines: 1400,
    maxTestFileLines: 1500
  },

  /** Gzipped size budgets for the built output, in bytes. */
  bundle: { cjsGzipBytes: 12 * 1024, esmGzipBytes: 12 * 1024 },

  /** What the published tarball may contain. */
  packageContents: {
    allowed: [
      /^package\.json$/,
      /^README\.md$/,
      /^LICENSE$/,
      /^CHANGELOG\.md$/,
      /^MIGRATION\.md$/,
      /^dist\/(esm|cjs)\/[a-z0-9-]+\.js$/,
      /^dist\/(esm|cjs)\/package\.json$/,
      /^dist\/types\/[a-z0-9-]+\.d\.ts$/
    ],
    maxUnpackedBytes: 250 * 1024,
    required: [
      'dist/esm/index.js',
      'dist/cjs/index.js',
      'dist/types/index.d.ts',
      'README.md',
      'LICENSE'
    ]
  },

  /** Test files that intentionally have no matching source file. */
  testPairing: {
    sharedTestDirectories: ['__tests__/helpers/', '__tests__/integration/']
  },

  /** Compiler options that must stay on. */
  requiredCompilerOptions: [
    'strict',
    'noUncheckedIndexedAccess',
    'noImplicitReturns',
    'noImplicitOverride',
    'noFallthroughCasesInSwitch',
    'noUnusedLocals',
    'noUnusedParameters',
    'isolatedModules'
  ],

  /** Paths that must be git-ignored and never committed. */
  ignoredPaths: ['node_modules', 'dist', 'coverage', '.validation-reports'],

  /** Largest file allowed in git (bytes). */
  maxTrackedFileBytes: 500 * 1024
};
