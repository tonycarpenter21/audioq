/**
 * Build step: shortens the names of internal properties and methods in dist/ so apps ship less
 * code. Minifiers cannot do this themselves because renaming a property is only safe when every
 * use of it is known; here it is, because the names are computed from the source:
 *
 *   rename = property names declared in src/
 *          − every name in the public API (types, options, payloads, methods, parameters)
 *          − every property name in the DOM and JavaScript built-in type definitions
 *          − every string literal in src/ (in case a name is used as a key)
 *
 * The test suites run against the built output (jest.dist.config.js) to prove nothing broke.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const sourceFiles = () =>
  readdirSync(join(root, 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(root, 'src', name));

/** A type written with a string index: `Record<string, T>` or `{ [key: string]: T }`. */
const STRING_INDEX = /\bRecord<\s*string\b|\[\s*\w+\s*:\s*string\s*\]/;

/** Whether a property assignment is a key of an object literal typed with a string index. */
const isLookupTableKey = (node) => {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return false;
  const literal = node.parent;
  if (!ts.isObjectLiteralExpression(literal)) return false;
  let holder = literal.parent;
  while (
    holder &&
    (ts.isAsExpression(holder) ||
      ts.isSatisfiesExpression(holder) ||
      ts.isParenthesizedExpression(holder))
  ) {
    if (holder.type && STRING_INDEX.test(holder.type.getText())) return true;
    holder = holder.parent;
  }
  return Boolean(
    holder &&
    ts.isVariableDeclaration(holder) &&
    holder.type &&
    STRING_INDEX.test(holder.type.getText())
  );
};

/** Property-like names declared in src, plus every string literal (reserved). */
const scanSource = () => {
  const declared = new Set();
  const strings = new Set();
  for (const path of sourceFiles()) {
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node) => {
      const name = node.name;
      const isMember =
        ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node);
      // Inline type literals (`globalThis as { webkitAudioContext?: ... }`) describe objects we
      // do not own, so their member names must keep their real spelling.
      const describesHostObject = node.parent !== undefined && ts.isTypeLiteralNode(node.parent);
      if (isMember && !describesHostObject && name && ts.isIdentifier(name)) {
        // Keys of a lookup table (an object typed with a string index) are looked up with
        // runtime strings, so renaming them would break the lookup: keep them.
        if (isLookupTableKey(node)) strings.add(name.text);
        else declared.add(name.text);
      }
      if (ts.isStringLiteralLike(node)) strings.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { declared, strings };
};

/** Every member name in the TypeScript DOM / ES library definitions. */
const builtInNames = () => {
  const libDir = join(root, 'node_modules', 'typescript', 'lib');
  const names = new Set();
  for (const file of readdirSync(libDir).filter((name) => /^lib\..*\.d\.ts$/.test(name))) {
    const text = readFileSync(join(libDir, file), 'utf8');
    for (const [, name] of text.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/gm)) {
      names.add(name);
    }
  }
  return names;
};

/** True for class members marked private or protected: implementation details, not API. */
const isHiddenMember = (node) =>
  ts.isClassElement(node) &&
  (ts.getCombinedModifierFlags(node) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
    0;

/** The declaration files index.d.ts re-exports from, followed transitively. */
const publicFiles = (typesDir) => {
  const files = new Set(['index.d.ts']);
  for (const file of files) {
    const text = readFileSync(join(typesDir, file), 'utf8');
    for (const [, target] of text.matchAll(
      /^export\b[^;]*?\bfrom\s+['"]\.\/([\w.-]+?)(?:\.js)?['"]/gm
    )) {
      files.add(`${target}.d.ts`);
    }
  }
  return [...files];
};

/**
 * Every name in the public type declarations: each file index.d.ts re-exports from, minus
 * private and protected class members.
 */
const publicNames = () => {
  const names = new Set();
  const typesDir = join(root, 'dist', 'types');
  for (const file of publicFiles(typesDir)) {
    const path = join(typesDir, file);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node) => {
      if (isHiddenMember(node)) return;
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
};

/** Internal names that are safe to rename. */
export const internalNames = () => {
  const { declared, strings } = scanSource();
  const reserved = new Set([...builtInNames(), ...publicNames(), ...strings]);
  return [...declared].filter((name) => IDENTIFIER.test(name) && !reserved.has(name)).sort();
};

/**
 * Removes protected members from QueueEngine's declaration file: they are implementation details
 * (and renamed at build time), so they must not appear as API to subclasses.
 */
const stripProtectedMembers = (path) => {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();
  const transform = (context) => (sourceFile) => {
    const visit = (node) => {
      if (ts.isClassDeclaration(node)) {
        const members = node.members.filter(
          (member) =>
            !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Protected) &&
            !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private)
        );
        return context.factory.updateClassDeclaration(
          node,
          node.modifiers,
          node.name,
          node.typeParameters,
          node.heritageClauses,
          members
        );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sourceFile, visit);
  };
  const [result] = ts.transform(file, [transform]).transformed;
  writeFileSync(path, printer.printFile(result));
};

/** Renames internal properties in dist/esm and dist/cjs, and trims internal declarations. */
export const mangleDist = async () => {
  const names = internalNames();
  if (names.length === 0) return { names };
  const mangleProps = new RegExp(`^(${names.join('|')})$`);
  let mangleCache = {};
  for (const [folder, format] of [
    ['esm', 'esm'],
    ['cjs', 'cjs']
  ]) {
    const dir = join(root, 'dist', folder);
    const entryPoints = readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(dir, name));
    const result = await build({
      allowOverwrite: true,
      bundle: false,
      entryPoints,
      format,
      logLevel: 'silent',
      mangleCache,
      mangleProps,
      outdir: dir,
      target: 'es2020'
    });
    mangleCache = result.mangleCache ?? mangleCache;
  }
  stripProtectedMembers(join(root, 'dist', 'types', 'engine.d.ts'));
  return { names };
};
