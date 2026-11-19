/**
 * Thresholds and budgets used by the validation gates. Change them here, in one place.
 */
export const validationConfig = {
  /** Where reports are written (git-ignored) and how many runs to keep. */
  reports: { directory: '.validation-reports', keep: 5 },

  /** Per-file coverage minimums for every file in src/ (percent). */
  coveragePerFile: { branches: 85, functions: 90, lines: 95, statements: 95 },

  /** Longest function body allowed in src (files themselves have no length limit). */
  size: { maxFunctionLines: 60 },

  /**
   * Size budgets in bytes. `*GzipBytes` measure the unminified dist output; `minified*` measure
   * what an app ships after its bundler minifies (esbuild --minify, then gzip): the whole package,
   * and an app that only imports queueAudio.
   */
  bundle: {
    cjsGzipBytes: 18 * 1024,
    esmGzipBytes: 18 * 1024,
    minifiedFullGzipBytes: 11.5 * 1024,
    minifiedQueueAudioOnlyGzipBytes: 9.5 * 1024
  },

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
    maxUnpackedBytes: 350 * 1024,
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
    'isolatedModules',
    'exactOptionalPropertyTypes',
    'noPropertyAccessFromIndexSignature',
    'verbatimModuleSyntax'
  ],

  /** Compiler options that must stay off (so unreachable code and stray labels are errors). */
  forbiddenCompilerOptions: ['allowUnreachableCode', 'allowUnusedLabels'],

  /** Paths that must be git-ignored and never committed. */
  ignoredPaths: ['node_modules', 'dist', 'coverage', '.validation-reports'],

  /** Largest file allowed in git (bytes). */
  maxTrackedFileBytes: 500 * 1024
};
