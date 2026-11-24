#!/usr/bin/env node
/**
 * Builds dist/esm (ES modules), dist/cjs (CommonJS) and dist/types (declarations).
 * Each output folder gets a package.json declaring its module type so Node loads it correctly.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mangleDist } from './mangle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(dist, { force: true, recursive: true });
for (const project of ['tsconfig.esm.json', 'tsconfig.cjs.json', 'tsconfig.types.json']) {
  execFileSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit' });
}
for (const [folder, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs']
]) {
  mkdirSync(join(dist, folder), { recursive: true });
  writeFileSync(join(dist, folder, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}
const { names, prunedDeclarations } = await mangleDist();
console.log(
  `Built dist/esm, dist/cjs and dist/types (${names.length} internal names shortened, ` +
    `${prunedDeclarations.length} internal declaration files dropped)`
);
