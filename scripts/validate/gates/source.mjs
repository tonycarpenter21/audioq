/**
 * Gates over the library source: documentation, forbidden patterns, import structure, sizes
 * and naming.
 */
import { validationConfig } from '../config.mjs';
import {
  fail,
  getSourceFile,
  hasModifier,
  importsOf,
  lineOf,
  listFiles,
  packageJson,
  pass,
  publicMembers,
  read,
  runtimeExports,
  sourceFiles,
  ts
} from '../lib.mjs';

/**
 * Pattern, explanation, files where it is allowed, and whether comments are scanned too.
 * Most rules apply to code only; unfinished-work markers apply to comments as well.
 */
const FORBIDDEN = [
  [/\bconsole\.[a-z]+\s*\(/, 'console call (use the configurable logger)', ['src/config.ts']],
  [/@ts-(ignore|nocheck|expect-error)/, 'TypeScript suppression comment', [], true],
  [/eslint-disable/, 'eslint-disable comment', [], true],
  [/\bdebugger\b/, 'debugger statement'],
  [
    /\b(TODO|FIXME|XXX|HACK)\b/,
    'unfinished-work marker (track it in TODO.md or an issue)',
    [],
    true
  ],
  [/requestAnimationFrame/, 'requestAnimationFrame (paused in background tabs; use timers)'],
  [/\.innerHTML\b|document\.write\(/, 'HTML injection sink'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'dynamic code evaluation'],
  [/\b(localStorage|sessionStorage)\b/, 'web storage access'],
  [/new\s+Proxy\s*\(/, 'Proxy (v2 used one on every channel access)'],
  [/\bdelete\s+[a-zA-Z_.]+\[/, 'delete on an indexed collection (leaves holes)']
];

export const sourceGates = [
  {
    category: 'source',
    description:
      'Every runtime export and public method has JSDoc, every parameter has a matching @param, ' +
      'and functions that return a value document it with @returns.',
    id: 'jsdoc-public-api',
    run: async () => {
      const problems = [];
      let checked = 0;
      for (const path of sourceFiles()) {
        const file = getSourceFile(path);
        for (const symbol of runtimeExports(path)) {
          checked++;
          const docNode = symbol.statement ?? symbol.node;
          problems.push(...checkDoc(path, file, docNode, symbol.name, functionLike(symbol.node)));
          if (symbol.kind !== 'class') continue;
          for (const member of publicMembers(symbol.node)) {
            checked++;
            problems.push(
              ...checkDoc(path, file, member, `${symbol.name}.${member.name.text}`, member)
            );
          }
        }
      }
      return problems.length === 0
        ? pass(`${checked} public symbols fully documented`)
        : fail(`${problems.length} documentation problem(s)`, problems);
    },
    title: 'Public API is documented'
  },
  {
    category: 'source',
    description:
      'Library source avoids patterns that caused bugs or are unsafe in a browser library.',
    id: 'forbidden-patterns',
    run: async () => {
      const problems = [];
      for (const path of sourceFiles()) {
        read(path)
          .split('\n')
          .forEach((line, index) => {
            const isComment = /^\s*(\/\/|\/\*|\*)/.test(line);
            for (const [pattern, reason, allowedIn = [], scanComments = false] of FORBIDDEN) {
              if (isComment && !scanComments) continue;
              if (pattern.test(line) && !allowedIn.includes(path)) {
                problems.push(`${path}:${index + 1} ${reason}: ${line.trim()}`);
              }
            }
          });
      }
      // `any` is found on the syntax tree, so Record<string, any>, any[] and <any> are all caught.
      for (const path of sourceFiles()) {
        const file = getSourceFile(path);
        const visit = (node) => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            problems.push(`${path}:${lineOf(file, node)} explicit any`);
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
      return problems.length === 0
        ? pass(
            `${FORBIDDEN.length + 1} forbidden patterns checked across ${sourceFiles().length} files`
          )
        : fail(`${problems.length} forbidden pattern(s)`, problems);
    },
    title: 'No forbidden patterns'
  },
  {
    category: 'source',
    description:
      'Runtime imports between src files form no cycles (type-only imports are ignored).',
    id: 'no-circular-imports',
    run: async () => {
      const graph = new Map();
      for (const path of sourceFiles()) {
        const targets = importsOf(path)
          .filter((entry) => !entry.typeOnly && entry.specifier.startsWith('.'))
          .map((entry) => resolveImport(path, entry.specifier));
        graph.set(path, targets);
      }
      const cycles = findCycles(graph);
      return cycles.length === 0
        ? pass(`${graph.size} modules, no import cycles`)
        : fail(
            `${cycles.length} import cycle(s)`,
            cycles.map((cycle) => cycle.join(' -> '))
          );
    },
    title: 'No circular imports'
  },
  {
    category: 'source',
    description:
      'No runtime dependencies in package.json, and src imports nothing but its own files ' +
      '(no packages, no Node built-ins).',
    id: 'zero-dependencies',
    run: async () => {
      const pkg = packageJson();
      const problems = [];
      for (const field of [
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
        'bundleDependencies',
        'bundledDependencies'
      ]) {
        const value = pkg[field];
        if (value && Object.keys(value).length > 0) {
          problems.push(`package.json "${field}" must be empty: ${Object.keys(value).join(', ')}`);
        }
      }
      for (const path of sourceFiles()) {
        for (const { specifier } of importsOf(path)) {
          if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
            problems.push(`${path} imports "${specifier}"`);
          } else if (!specifier.endsWith('.js')) {
            problems.push(
              `${path} imports "${specifier}" without a .js extension (breaks Node ESM)`
            );
          }
        }
      }
      return problems.length === 0
        ? pass('Zero runtime dependencies; src imports only its own files')
        : fail('Dependency policy violated', problems);
    },
    title: 'Zero dependencies'
  },
  {
    category: 'source',
    description:
      'Function bodies in src stay short enough to review (limit in config.mjs). File length is ' +
      'not limited.',
    id: 'size-limits',
    run: async () => {
      const { maxFunctionLines } = validationConfig.size;
      const problems = [];
      for (const path of sourceFiles()) {
        const file = getSourceFile(path);
        const visit = (node) => {
          if (isFunctionWithBody(node)) {
            const start = file.getLineAndCharacterOfPosition(node.body.getStart(file)).line;
            const end = file.getLineAndCharacterOfPosition(node.body.getEnd()).line;
            if (end - start > maxFunctionLines) {
              problems.push(
                `${path}:${lineOf(file, node)} function body is ${end - start} lines > ${maxFunctionLines}`
              );
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
      return problems.length === 0
        ? pass(`Every function body is <= ${maxFunctionLines} lines`)
        : fail(`${problems.length} size limit(s) exceeded`, problems);
    },
    title: 'Function length'
  },
  {
    category: 'source',
    description: 'Files in src, __tests__ and scripts use kebab-case names.',
    id: 'file-naming',
    run: async () => {
      const kebab = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*\.(ts|mjs|js)$/;
      const files = [
        ...sourceFiles(),
        ...listFiles('__tests__', (p) => p.endsWith('.ts')),
        ...listFiles('scripts', (p) => p.endsWith('.mjs'))
      ];
      const problems = files
        .filter((path) => !kebab.test(path.split('/').pop()))
        .map((path) => `${path} is not kebab-case`);
      return problems.length === 0
        ? pass(`${files.length} files follow kebab-case naming`)
        : fail('File naming problems', problems);
    },
    title: 'File naming'
  }
];

function functionLike(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

function isFunctionWithBody(node) {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.body !== undefined &&
    ts.isBlock(node.body)
  );
}

function checkDoc(path, file, docNode, label, fn) {
  const docs = ts.getJSDocCommentsAndTags(docNode).filter(ts.isJSDoc);
  const where = `${path}:${lineOf(file, docNode)} ${label}`;
  if (docs.length === 0) return [`${where} has no JSDoc`];
  const doc = docs[docs.length - 1];
  const description = ts.getTextOfJSDocComment(doc.comment)?.trim() ?? '';
  const isConstructor = ts.isConstructorDeclaration(docNode);
  if (description.length === 0 && !isConstructor) {
    return [`${where} has an empty JSDoc description`];
  }
  if (!fn) return [];
  const tags = doc.tags ?? [];
  const params = tags.filter(ts.isJSDocParameterTag).map((tag) => tag.name.getText());
  const problems = [];
  for (const parameter of fn.parameters) {
    const name = parameter.name.getText().replace(/^\.\.\./, '');
    if (name.startsWith('_') || ts.isObjectBindingPattern(parameter.name)) continue;
    if (!params.includes(name) && !params.includes(`...${name}`)) {
      problems.push(`${where}: missing @param ${name}`);
    }
  }
  const returnType = fn.type?.getText();
  const returnsValue =
    returnType !== undefined && !['void', 'Promise<void>', 'never'].includes(returnType);
  const hasReturns = tags.some((tag) => ['returns', 'return'].includes(tag.tagName.text));
  if (returnsValue && !hasReturns && !hasModifier(fn, ts.SyntaxKind.SetKeyword)) {
    problems.push(`${where}: missing @returns`);
  }
  return problems;
}

function resolveImport(from, specifier) {
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.replace(/\.js$/, '.ts').split('/')) {
    if (segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 'visiting') {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}
