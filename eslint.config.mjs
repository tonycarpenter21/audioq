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
  '@typescript-eslint/await-thenable': 'error'
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
    files: ['jest.config.js'],
    languageOptions: { sourceType: 'commonjs' }
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.validation-reports/']
  }
];
