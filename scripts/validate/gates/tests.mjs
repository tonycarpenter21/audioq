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
  testSupportFiles,
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

/** Whether a source file only re-exports other modules (index.ts). */
const isReExportOnly = (sourcePath) => runtimeExports(sourcePath).length === 0;

/** Jest globals that run tests. */
const TEST_ROOTS = new Set(['describe', 'test', 'it']);
/** Modifiers that focus, skip, or weaken tests. */
const BANNED_MODIFIERS = new Set(['only', 'skip', 'todo', 'failing', 'concurrent']);
/** Aliases for focused or skipped tests. */
const BANNED_ALIASES = new Set(['fdescribe', 'fit', 'xdescribe', 'xit', 'xtest']);

/** Root identifier and member names of a call like `test.only.each(...)`. */
const chainOf = (expression) => {
  const members = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      members.unshift(current.name.text);
      current = current.expression;
    } else {
      current = current.expression;
    }
  }
  return { members, root: ts.isIdentifier(current) ? current.text : undefined };
};

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
      'Every test is an inline function with at least one expect(), and nothing is focused, ' +
      'skipped or weakened (.only, .skip, .todo, .failing, .concurrent, fit, xit, ... in any ' +
      'combination, e.g. test.only.each).',
    id: 'test-quality',
    run: async () => {
      const problems = [];
      let tests = 0;
      for (const path of testFiles()) {
        const file = getSourceFile(path);
        const visit = (node) => {
          if (ts.isCallExpression(node)) {
            const { members, root } = chainOf(node.expression);
            const banned = members.find((member) => BANNED_MODIFIERS.has(member));
            if (root && BANNED_ALIASES.has(root)) {
              problems.push(`${path}:${lineOf(file, node)} ${root}() focuses or skips tests`);
            } else if (root && TEST_ROOTS.has(root) && banned) {
              problems.push(
                `${path}:${lineOf(file, node)} ${root}.${members.join('.')} is not allowed`
              );
            }
            if (isTestCall(node.expression)) {
              tests++;
              const body = node.arguments[1];
              if (!body || !(ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
                problems.push(`${path}:${lineOf(file, node)} test body must be an inline function`);
              } else if (!containsExpect(body)) {
                problems.push(
                  `${path}:${lineOf(file, node)} test has no expect() that always runs`
                );
              }
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
      'Tests and helpers must not replace global timers or Promise with fakes of their own ' +
      '(that hid every timing bug in v2). Use jest.useFakeTimers() instead.',
    id: 'no-global-timer-hacks',
    run: async () => {
      const timers =
        '(setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|Promise|queueMicrotask)';
      const patterns = [
        new RegExp(`\\b(global|globalThis|window|self)\\.${timers}\\s*=`),
        new RegExp(
          `defineProperty\\(\\s*(global|globalThis|window|self)\\s*,\\s*['"]${timers}['"]`
        ),
        new RegExp(
          `spyOn\\(\\s*(global|globalThis|window|self)\\s*,\\s*['"]${timers}['"]\\s*\\)\\s*\\.\\s*mock(Implementation|ReturnValue)`
        )
      ];
      const problems = [];
      for (const path of [...testSupportFiles(), 'jest.config.js']) {
        read(path)
          .split('\n')
          .forEach((line, index) => {
            if (patterns.some((pattern) => pattern.test(line))) {
              problems.push(`${path}:${index + 1} ${line.trim()}`);
            }
          });
      }
      if (/setupFiles(AfterEnv)?/.test(read('jest.config.js'))) {
        problems.push(
          'jest.config.js: global setup files are not allowed; import helpers explicitly'
        );
      }
      return problems.length === 0
        ? pass('No global timer or Promise replacements in tests or helpers')
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

/**
 * Whether a test body calls expect() on a path that always runs. Expectations only inside an
 * `if`, a ternary, a `catch`, or the right side of `&&`/`||`/`??` may never execute.
 */
function containsExpect(node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && child.text === 'expect') {
      found = true;
      return;
    }
    if (ts.isIfStatement(child)) {
      visit(child.expression);
      return;
    }
    if (ts.isConditionalExpression(child)) {
      visit(child.condition);
      return;
    }
    if (ts.isCatchClause(child)) return;
    if (
      ts.isBinaryExpression(child) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken
      ].includes(child.operatorToken.kind)
    ) {
      visit(child.left);
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}
