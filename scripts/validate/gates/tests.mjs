/**
 * Gates about the tests themselves: pairing with source files, coverage of every exported symbol,
 * and test quality (assertions present, nothing focused or skipped, no global timer hacks).
 */
import { validationConfig } from '../config.mjs';
import {
  exists,
  fail,
  getSourceFile,
  lineOf,
  pass,
  publicMembers,
  read,
  referencedNames,
  runtimeExports,
  sourceFiles,
  testFiles,
  ts
} from '../lib.mjs';

/** src/foo/bar.ts -> __tests__/foo/bar.test.ts */
const testPathFor = (sourcePath) =>
  sourcePath.replace(/^src\//, '__tests__/').replace(/\.ts$/, '.test.ts');

/** Test files that cover a source file: bar.test.ts plus variants like bar.ssr.test.ts. */
const testsFor = (sourcePath) => {
  const base = testPathFor(sourcePath).replace(/\.test\.ts$/, '');
  return testFiles().filter((path) => path === `${base}.test.ts` || path.startsWith(`${base}.`));
};

const isShared = (path) =>
  validationConfig.testPairing.sharedTestDirectories.some((dir) => path.startsWith(dir));

/** Names a test file may mention to cover a symbol (the symbol and its file's re-export names). */
const isReExportOnly = (sourcePath) => runtimeExports(sourcePath).length === 0;

const FOCUS_OR_SKIP =
  /\b(?:(?:describe|test|it)\.(?:only|skip|todo)|fdescribe|fit|xdescribe|xit|xtest)\s*\(/;

export const testGates = [
  {
    category: 'tests',
    description:
      'Every src file has a matching __tests__ file, and every test file maps to a src file ' +
      '(except shared helpers and integration suites).',
    id: 'test-file-pairing',
    run: async () => {
      const problems = [];
      for (const source of sourceFiles()) {
        if (!exists(testPathFor(source))) {
          problems.push(`${source} has no test file (expected ${testPathFor(source)})`);
        }
      }
      for (const test of testFiles()) {
        if (isShared(test)) continue;
        const base = test
          .replace(/^__tests__\//, 'src/')
          .replace(/(\.[a-z0-9-]+)?\.test\.ts$/, '.ts');
        if (!exists(base)) problems.push(`${test} does not match any source file`);
      }
      return problems.length === 0
        ? pass(`${sourceFiles().length} source files each have a test file`)
        : fail(`${problems.length} pairing problem(s)`, problems);
    },
    title: 'Every file has a test file'
  },
  {
    category: 'tests',
    dependsOn: ['test-file-pairing'],
    description:
      'Crawls every exported function, class, constant and enum, and every public class method, ' +
      'and checks that the matching test file references it.',
    id: 'exported-symbols-tested',
    run: async () => {
      const problems = [];
      let checked = 0;
      for (const source of sourceFiles()) {
        if (isReExportOnly(source)) continue;
        const tests = testsFor(source);
        const referenced = new Set(tests.flatMap((test) => [...referencedNames(test)]));
        for (const symbol of runtimeExports(source)) {
          checked++;
          if (!referenced.has(symbol.name)) {
            problems.push(
              `${source}: export "${symbol.name}" is never referenced in ${tests.join(', ') || 'any test'}`
            );
          }
          if (symbol.kind !== 'class') continue;
          for (const member of publicMembers(symbol.node)) {
            checked++;
            if (!referenced.has(member.name.text)) {
              problems.push(
                `${source}: ${symbol.name}.${member.name.text}() is never referenced in tests`
              );
            }
          }
        }
      }
      return problems.length === 0
        ? pass(`All ${checked} exported symbols and public methods are referenced by tests`)
        : fail(`${problems.length} untested symbol(s)`, problems);
    },
    title: 'Every exported function and method is tested'
  },
  {
    category: 'tests',
    description:
      'Every test has at least one expect(), and nothing is focused (.only/fit) or skipped ' +
      '(.skip/xit/.todo).',
    id: 'test-quality',
    run: async () => {
      const problems = [];
      let tests = 0;
      for (const path of testFiles()) {
        const file = getSourceFile(path);
        read(path)
          .split('\n')
          .forEach((line, index) => {
            if (FOCUS_OR_SKIP.test(line))
              problems.push(`${path}:${index + 1} focused or skipped test`);
          });
        const visit = (node) => {
          if (ts.isCallExpression(node) && isTestCall(node.expression)) {
            const body = node.arguments.find(
              (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
            );
            if (body) {
              tests++;
              if (!containsExpect(body))
                problems.push(`${path}:${lineOf(file, node)} test has no expect()`);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
      return problems.length === 0
        ? pass(`${tests} tests checked: all assert something, none focused or skipped`)
        : fail(`${problems.length} test quality problem(s)`, problems);
    },
    title: 'Test quality'
  },
  {
    category: 'tests',
    description:
      'Tests must not replace global timers or other globals with synchronous fakes ' +
      '(that hid every timing bug in v2). Use jest.useFakeTimers() instead.',
    id: 'no-global-timer-hacks',
    run: async () => {
      const pattern =
        /\b(global|globalThis|window)\.(setTimeout|setInterval|requestAnimationFrame|Promise)\s*=/;
      const problems = [];
      for (const path of [...testFiles(), 'jest.config.js']) {
        read(path)
          .split('\n')
          .forEach((line, index) => {
            if (pattern.test(line)) problems.push(`${path}:${index + 1} ${line.trim()}`);
          });
      }
      const jestConfig = read('jest.config.js');
      if (/setupFiles(AfterEnv)?/.test(jestConfig)) {
        problems.push(
          'jest.config.js: global setup files are not allowed; import helpers explicitly'
        );
      }
      return problems.length === 0
        ? pass('No global timer or Promise replacements in tests')
        : fail('Tests replace globals', problems);
    },
    title: 'No global timer hacks in tests'
  }
];

/** test(...), it(...), test.each(...)(...) */
function isTestCall(expression) {
  if (ts.isIdentifier(expression)) return ['test', 'it'].includes(expression.text);
  if (ts.isCallExpression(expression)) return isEachCall(expression.expression);
  return false;
}

function isEachCall(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'each' &&
    ts.isIdentifier(expression.expression) &&
    ['test', 'it'].includes(expression.expression.text)
  );
}

function containsExpect(node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && child.text === 'expect') {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}
