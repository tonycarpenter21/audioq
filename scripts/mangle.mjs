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
        declared.add(name.text);
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

/** Every name that appears in the public type declarations (dist/types/index.d.ts and imports). */
const publicNames = () => {
  const names = new Set();
  const typesDir = join(root, 'dist', 'types');
  const publicFiles = ['index.d.ts', 'types.d.ts', 'audio-queue.d.ts', 'default-queue.d.ts'];
  for (const file of publicFiles) {
    const text = readFileSync(join(typesDir, file), 'utf8');
    for (const [name] of text.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(name);
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
