import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Shared style and correctness rules for TypeScript files
const commonRules = {
  'max-len': ['error', { code: 100, ignoreComments: true, ignoreStrings: true, ignoreUrls: true }],
  'comma-dangle': ['error', 'never'],
  eqeqeq: ['error', 'always'],
  'no-var': 'error',
  'prefer-const': 'error',
  'sort-keys': ['error', 'asc', { caseSensitive: true, minKeys: 2, natural: true }],
  '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/prefer-nullish-coalescing': [
    'error',
    { ignorePrimitives: { boolean: true, number: true, string: true } }
  ],
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
  '@typescript-eslint/ban-ts-comment': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  // Type-aware rules that catch real bugs
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
  '@typescript-eslint/return-await': ['error', 'in-try-catch'],
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
  '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
  '@typescript-eslint/no-unnecessary-condition': 'error',
  '@typescript-eslint/prefer-readonly': 'error',
  // A catch block must handle the error or explain (in a comment) why it is ignored
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-fallthrough': 'error',
  'no-unreachable': 'error'
};

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      ...commonRules,
      complexity: ['error', 15],
      'max-depth': ['error', 3],
      'max-params': ['error', 5],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    // The default console logger is the one deliberate console use in the library.
    files: ['src/config.ts'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['__tests__/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      ...commonRules,
      'sort-keys': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs', '*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        setTimeout: 'readonly',
        __dirname: 'readonly'
      },
      sourceType: 'module'
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
      'prefer-const': 'error'
    }
  },
  {
    // Jest config files are CommonJS.
    files: ['jest.config.js', 'jest.dist.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.validation-reports/']
  }
];
