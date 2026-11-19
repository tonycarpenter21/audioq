/**
 * Gates that wrap the standard tools: formatter, linter, compiler, tests and build.
 */
import { readFileSync } from 'node:fs';
import { renderDefaultApi } from '../../generate-default-api.mjs';
import { validationConfig } from '../config.mjs';
import {
  abs,
  exists,
  fail,
  fromCommand,
  pass,
  read,
  readJson,
  runCommand,
  testFiles
} from '../lib.mjs';

export const toolingGates = [
  {
    category: 'tooling',
    description: 'src/default-queue.ts matches what scripts/generate-default-api.mjs produces.',
    id: 'generated-code',
    run: async () => {
      const expected = await renderDefaultApi();
      let current;
      try {
        current = readFileSync(abs('src/default-queue.ts'), 'utf8');
      } catch {
        return fail('src/default-queue.ts is missing', ['Run: npm run generate']);
      }
      return current === expected
        ? pass('default-queue.ts is in sync with AudioQueue')
        : fail('src/default-queue.ts is out of date', [
            'AudioQueue changed but the top-level functions were not regenerated.',
            'Run: npm run generate'
          ]);
    },
    title: 'Generated code is up to date'
  },
  {
    category: 'tooling',
    description: 'Every file follows the Prettier style (prettier --check).',
    id: 'format',
    run: async () =>
      fromCommand(
        await runCommand('prettier', ['--check', '.']),
        'All files formatted',
        'Files need formatting (run: npm run format)'
      ),
    title: 'Formatting'
  },
  {
    category: 'tooling',
    description: 'ESLint passes with zero warnings over src, tests and scripts.',
    id: 'lint',
    run: async () =>
      fromCommand(
        await runCommand('eslint', [
          '--max-warnings',
          '0',
          'src',
          '__tests__',
          'scripts',
          'eslint.config.mjs',
          'jest.config.js',
          'jest.dist.config.js'
        ]),
        'No lint errors or warnings',
        'Lint errors or warnings found'
      ),
    title: 'Lint'
  },
  {
    category: 'tooling',
    description: 'The library compiles under the strict tsconfig.json.',
    id: 'typecheck-src',
    run: async () =>
      fromCommand(
        await runCommand('tsc', ['-p', 'tsconfig.json', '--noEmit']),
        'src compiles cleanly',
        'Type errors in src'
      ),
    title: 'Typecheck: library'
  },
  {
    category: 'tooling',
    description: 'Tests and helpers compile under tsconfig.test.json.',
    id: 'typecheck-tests',
    run: async () =>
      fromCommand(
        await runCommand('tsc', ['-p', 'tsconfig.test.json', '--noEmit']),
        'Tests compile cleanly',
        'Type errors in tests'
      ),
    title: 'Typecheck: tests'
  },
  {
    category: 'tests',
    description: 'All Jest suites pass and global coverage thresholds in jest.config.js are met.',
    id: 'unit-tests',
    run: async () => {
      const result = await runCommand('jest', [
        '--ci',
        '--coverage',
        '--coverageReporters=json-summary',
        '--coverageReporters=text-summary'
      ]);
      const totals = result.output.match(/Tests:\s+(.*)/);
      return fromCommand(
        result,
        `Tests passed (${totals ? totals[1] : 'see log'})`,
        `Tests failed or coverage below threshold (${totals ? totals[1] : 'see log'})`
      );
    },
    title: 'Unit tests'
  },
  {
    category: 'tests',
    dependsOn: ['unit-tests'],
    description:
      'Every src file meets the per-file coverage minimums in scripts/validate/config.mjs.',
    id: 'coverage-per-file',
    run: async () => {
      if (!exists('coverage/coverage-summary.json')) {
        return fail('coverage/coverage-summary.json not found', ['Run the unit-tests gate first']);
      }
      const summary = readJson('coverage/coverage-summary.json');
      const minimums = validationConfig.coveragePerFile;
      const problems = [];
      for (const [file, metrics] of Object.entries(summary)) {
        if (file === 'total') continue;
        const short = file.slice(file.indexOf('src/'));
        for (const [metric, minimum] of Object.entries(minimums)) {
          const pct = metrics[metric]?.pct ?? 0;
          if (pct < minimum) problems.push(`${short}: ${metric} ${pct}% < ${minimum}%`);
        }
      }
      const files = Object.keys(summary).length - 1;
      return problems.length === 0
        ? pass(`All ${files} files meet per-file coverage minimums`)
        : fail(`${problems.length} coverage shortfall(s)`, problems);
    },
    title: 'Coverage per file'
  },
  {
    category: 'package',
    dependsOn: ['build'],
    description:
      'Every test suite passes against the BUILT package (dist/cjs), so the shipped code is ' +
      'tested too, including build-time transforms like renamed internals. Only suites tagged ' +
      '`@dist-skip <reason>` (white-box tests of renamed internals) are left out.',
    id: 'dist-tests',
    run: async () => {
      const result = await runCommand('jest', ['--ci', '-c', 'jest.dist.config.js']);
      const totals = result.output.match(/Tests:\s+(.*)/);
      const skipped = testFiles().filter((path) =>
        /@dist-skip\s+\S/.test(read(path).slice(0, 2000))
      );
      return fromCommand(
        result,
        `Built package passes (${totals ? totals[1] : 'see log'}; ${skipped.length} white-box suites skipped)`,
        `Built package fails tests (${totals ? totals[1] : 'see log'})`
      );
    },
    title: 'Tests against the built package'
  },
  {
    category: 'package',
    description: 'scripts/build.mjs produces dist/esm, dist/cjs and dist/types.',
    id: 'build',
    run: async () => {
      const result = await runCommand(process.execPath, [abs('scripts/build.mjs')]);
      if (result.code !== 0) return fromCommand(result, '', 'Build failed');
      const missing = ['dist/esm/index.js', 'dist/cjs/index.js', 'dist/types/index.d.ts'].filter(
        (path) => !exists(path)
      );
      return missing.length === 0
        ? pass('Build succeeded', { output: result.output })
        : fail(
            'Build output is incomplete',
            missing.map((path) => `Missing ${path}`)
          );
    },
    title: 'Build'
  },
  {
    category: 'tooling',
    description: 'tsconfig.json keeps the required strictness flags switched on.',
    id: 'tsconfig-strictness',
    run: async () => {
      const options = JSON.parse(read('tsconfig.json')).compilerOptions ?? {};
      const problems = [
        ...validationConfig.requiredCompilerOptions
          .filter((flag) => options[flag] !== true)
          .map((flag) => `tsconfig.json: "${flag}" must be true`),
        ...validationConfig.forbiddenCompilerOptions
          .filter((flag) => options[flag] !== false)
          .map((flag) => `tsconfig.json: "${flag}" must be false`)
      ];
      return problems.length === 0
        ? pass(`${validationConfig.requiredCompilerOptions.length} strictness flags enabled`)
        : fail('Strictness flags were turned off', problems);
    },
    title: 'Compiler strictness'
  }
];
