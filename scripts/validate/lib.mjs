/**
 * Shared helpers for validation gates: paths, file listing, commands and TypeScript parsing.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Repository root. */
export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path from a repo-relative path. */
export const abs = (...parts) => join(root, ...parts);

/** Repo-relative path with forward slashes. */
export const rel = (path) => relative(root, path).split(sep).join('/');

/** Reads a repo-relative text file. */
export const read = (path) => readFileSync(abs(path), 'utf8');

/** Reads and parses a repo-relative JSON file. */
export const readJson = (path) => JSON.parse(read(path));

/** Whether a repo-relative path exists. */
export const exists = (path) => existsSync(abs(path));

/** Lists files under a repo-relative directory (recursively) matching a filter. */
export const listFiles = (directory, filter = () => true) => {
  const start = abs(directory);
  if (!existsSync(start)) return [];
  const results = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (filter(rel(full))) results.push(rel(full));
    }
  };
  walk(start);
  return results.sort();
};

/** Source files of the library. */
export const sourceFiles = () => listFiles('src', (path) => path.endsWith('.ts'));

/** Test files. */
export const testFiles = () => listFiles('__tests__', (path) => path.endsWith('.test.ts'));

/** All TypeScript files used by tests, including helpers. */
export const testSupportFiles = () => listFiles('__tests__', (path) => path.endsWith('.ts'));

/** Path to a locally installed binary's JS entry, run with the current Node. */
const binEntries = {
  eslint: 'node_modules/eslint/bin/eslint.js',
  jest: 'node_modules/jest/bin/jest.js',
  prettier: 'node_modules/prettier/bin/prettier.cjs',
  tsc: 'node_modules/typescript/bin/tsc'
};

/**
 * Runs a command and captures its output. Never throws.
 * @returns {Promise<{ code: number, output: string }>}
 */
export const runCommand = (command, args, options = {}) =>
  new Promise((resolve) => {
    const entry = binEntries[command];
    const [file, fileArgs] = entry ? [process.execPath, [abs(entry), ...args]] : [command, args];
    const child = spawn(file, fileArgs, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
      shell: false
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });

/** Gate result helpers. */
export const pass = (summary, details = {}) => ({ status: 'pass', summary, ...details });
export const fail = (summary, problems = [], details = {}) => ({
  status: 'fail',
  summary,
  problems,
  ...details
});

/** Turns a command result into a gate result. */
export const fromCommand = (result, okSummary, failSummary) =>
  result.code === 0
    ? pass(okSummary, { output: result.output })
    : fail(failSummary, lastLines(result.output, 40), { output: result.output });

/** Last N non-empty lines of a text. */
export const lastLines = (text, count) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count);

const sourceCache = new Map();

/** Parsed SourceFile (with parent pointers) for a repo-relative path, cached per run. */
export const getSourceFile = (path) => {
  if (!sourceCache.has(path)) {
    sourceCache.set(path, ts.createSourceFile(abs(path), read(path), ts.ScriptTarget.Latest, true));
  }
  return sourceCache.get(path);
};

/** Whether a node has a given modifier. */
export const hasModifier = (node, kind) =>
  (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);

/** 1-based line number of a node. */
export const lineOf = (file, node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;

/**
 * Runtime (non-type) exports declared in a source file, with their declaration nodes.
 * Re-exports (`export ... from`) are not included.
 */
export const runtimeExports = (path) => {
  const file = getSourceFile(path);
  const exportsFound = [];
  file.forEachChild((node) => {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return;
    if (ts.isFunctionDeclaration(node) && node.name) {
      exportsFound.push({ kind: 'function', name: node.name.text, node });
    } else if (ts.isClassDeclaration(node) && node.name) {
      exportsFound.push({ kind: 'class', name: node.name.text, node });
    } else if (ts.isEnumDeclaration(node)) {
      exportsFound.push({ kind: 'enum', name: node.name.text, node });
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const init = declaration.initializer;
        const isFunction = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        exportsFound.push({
          kind: isFunction ? 'function' : 'const',
          name: declaration.name.text,
          node: declaration,
          statement: node
        });
      }
    }
  });
  return exportsFound;
};

/** Public (non-private, non-protected) methods and accessors of a class declaration. */
export const publicMembers = (classNode) =>
  classNode.members.filter(
    (member) =>
      (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
      member.name &&
      ts.isIdentifier(member.name) &&
      !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
      !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
  );

/** Every identifier and property name referenced in a file. */
export const referencedNames = (path) => {
  const names = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) names.add(node.text);
    if (ts.isStringLiteral(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(getSourceFile(path));
  return names;
};

/** Static import specifiers of a file (`importTypeOnly` tells whether the import is type-only). */
export const importsOf = (path) => {
  const file = getSourceFile(path);
  const imports = [];
  file.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? (node.importClause?.isTypeOnly ?? false)
        : node.isTypeOnly;
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly });
    }
  });
  return imports;
};

/** The current package.json. */
export const packageJson = () => readJson('package.json');

export { ts };
