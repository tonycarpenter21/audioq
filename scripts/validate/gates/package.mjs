/**
 * Gates about what gets published: metadata, lockfile, exports, SSR safety, size, tarball, API.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { API_SNAPSHOT_PATH, readPublicApi } from '../api.mjs';
import { validationConfig } from '../config.mjs';
import {
  abs,
  exists,
  fail,
  lastLines,
  listFiles,
  packageJson,
  pass,
  readJson,
  runCommand
} from '../lib.mjs';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Runs a snippet in a fresh Node process with no DOM and returns its JSON output. */
const runInNode = async (code) => {
  const result = await runCommand(process.execPath, ['--input-type=module', '-e', code]);
  if (result.code !== 0) return { error: result.output };
  try {
    return { value: JSON.parse(lastLines(result.output, 1)[0] ?? '') };
  } catch {
    return { error: result.output };
  }
};

const importBoth = `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(pathToFileURL(abs('package.json')).href)});
const before = new Set(Object.getOwnPropertyNames(globalThis));
const cjs = require(${JSON.stringify(abs('dist/cjs/index.js'))});
const esm = await import(${JSON.stringify(pathToFileURL(abs('dist/esm/index.js')).href)});
const added = Object.getOwnPropertyNames(globalThis).filter((key) => !before.has(key));
`;

export const packageGates = [
  {
    category: 'package',
    description: 'package.json has the fields consumers and registries need, with sane values.',
    id: 'package-metadata',
    run: async () => {
      const pkg = packageJson();
      const problems = [];
      const need = (condition, message) => condition || problems.push(message);
      need(pkg.name === 'audioq', 'name must be "audioq"');
      need(SEMVER.test(pkg.version ?? ''), `version "${pkg.version}" is not semver`);
      need((pkg.description ?? '').length >= 20, 'description is missing or too short');
      need(pkg.license === 'MIT', 'license must be MIT');
      need(typeof pkg.repository?.url === 'string', 'repository.url is missing');
      need((pkg.keywords ?? []).length >= 3, 'need at least 3 keywords');
      need(pkg.sideEffects === false, 'sideEffects must be false (enables tree-shaking)');
      need(pkg.engines?.node !== undefined, 'engines.node is missing');
      need(Array.isArray(pkg.files) && pkg.files.includes('dist'), 'files must include dist');
      const root = pkg.exports?.['.'];
      need(root !== undefined, 'exports["."] is missing');
      if (root) {
        need(Object.keys(root)[0] === 'types', 'exports["."].types must be the first condition');
        need(root.import && root.require, 'exports["."] needs import and require conditions');
      }
      need(pkg.scripts?.['validate:all'] !== undefined, 'scripts["validate:all"] is missing');
      return problems.length === 0
        ? pass('package.json metadata is complete')
        : fail('package.json problems', problems);
    },
    title: 'Package metadata'
  },
  {
    category: 'package',
    description: 'package-lock.json matches package.json (name, version and dev dependencies).',
    id: 'lockfile-sync',
    run: async () => {
      if (!exists('package-lock.json'))
        return fail('package-lock.json is missing', ['Run: npm install']);
      const pkg = packageJson();
      const lock = readJson('package-lock.json');
      const rootEntry = lock.packages?.[''] ?? {};
      const problems = [];
      if (lock.name !== pkg.name) problems.push(`lockfile name ${lock.name} != ${pkg.name}`);
      if (lock.version !== pkg.version)
        problems.push(`lockfile version ${lock.version} != ${pkg.version}`);
      if (
        JSON.stringify(rootEntry.devDependencies ?? {}) !==
        JSON.stringify(pkg.devDependencies ?? {})
      ) {
        problems.push('lockfile devDependencies differ from package.json (run: npm install)');
      }
      if (rootEntry.dependencies && Object.keys(rootEntry.dependencies).length > 0) {
        problems.push('lockfile lists runtime dependencies');
      }
      return problems.length === 0
        ? pass('Lockfile matches package.json')
        : fail('Lockfile out of sync', problems);
    },
    title: 'Lockfile in sync'
  },
  {
    category: 'package',
    dependsOn: ['build'],
    description:
      'Every path in main/module/types/exports exists, both module formats load in plain Node, ' +
      'export the same names, and the type declarations cover them.',
    id: 'package-exports',
    run: async () => {
      const pkg = packageJson();
      const problems = [];
      const targets = [pkg.main, pkg.module, pkg.types, ...Object.values(pkg.exports?.['.'] ?? {})];
      for (const target of targets) {
        if (typeof target === 'string' && !exists(target))
          problems.push(`${target} does not exist`);
      }
      for (const [folder, type] of [
        ['esm', 'module'],
        ['cjs', 'commonjs']
      ]) {
        const marker = `dist/${folder}/package.json`;
        if (!exists(marker) || readJson(marker).type !== type) {
          problems.push(`${marker} must declare "type": "${type}"`);
        }
      }
      const { error, value } = await runInNode(
        `${importBoth} console.log(JSON.stringify({ cjs: Object.keys(cjs).sort(), esm: Object.keys(esm).filter((k) => k !== 'default').sort() }));`
      );
      if (error)
        return fail('Built package failed to load', [...problems, ...lastLines(error, 20)]);
      const missingInCjs = value.esm.filter((name) => !value.cjs.includes(name));
      const missingInEsm = value.cjs.filter((name) => !value.esm.includes(name));
      if (missingInCjs.length) problems.push(`Missing from CJS: ${missingInCjs.join(', ')}`);
      if (missingInEsm.length) problems.push(`Missing from ESM: ${missingInEsm.join(', ')}`);
      const declared = new Set(Object.keys(readPublicApi()));
      const undeclared = value.esm.filter((name) => !declared.has(name));
      if (undeclared.length)
        problems.push(`Runtime exports without type declarations: ${undeclared.join(', ')}`);
      return problems.length === 0
        ? pass(`${value.esm.length} runtime exports identical in ESM and CJS, all typed`)
        : fail('Package entry points are inconsistent', problems);
    },
    title: 'Package entry points'
  },
  {
    category: 'package',
    dependsOn: ['build'],
    description:
      'Importing the built package in Node (no DOM) succeeds, adds no globals, and the API is usable ' +
      'until audio is actually queued (SSR / Next.js safety).',
    id: 'ssr-import',
    run: async () => {
      const { error, value } = await runInNode(`${importBoth}
        const queue = esm.createAudioQueue({ logger: null });
        let queueError = '';
        try { await queue.queueAudio('/a.mp3'); } catch (e) { queueError = e.message; }
        console.log(JSON.stringify({
          added,
          config: cjs.getQueueConfig().maxChannels,
          length: queue.getQueueLength(),
          queueError
        }));`);
      if (error) return fail('Importing the package without a DOM failed', lastLines(error, 20));
      const problems = [];
      if (value.added.length) problems.push(`Import added globals: ${value.added.join(', ')}`);
      if (value.config !== 64) problems.push('getQueueConfig() did not work without a DOM');
      if (!/browser environment/.test(value.queueError)) {
        problems.push(`queueAudio without a DOM should explain itself, got: "${value.queueError}"`);
      }
      return problems.length === 0
        ? pass('Safe to import during server-side rendering')
        : fail('SSR import problems', problems);
    },
    title: 'SSR-safe import'
  },
  {
    category: 'package',
    dependsOn: ['build'],
    description: 'Gzipped size of each built format stays within the budget in config.mjs.',
    id: 'bundle-size',
    run: async () => {
      const { cjsGzipBytes, esmGzipBytes } = validationConfig.bundle;
      const measure = (folder) =>
        gzipSync(
          Buffer.concat(
            listFiles(`dist/${folder}`, (p) => p.endsWith('.js')).map((p) => readFileSync(abs(p)))
          )
        ).length;
      const esm = measure('esm');
      const cjs = measure('cjs');
      const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
      const problems = [];
      if (esm > esmGzipBytes) problems.push(`ESM ${kb(esm)} gzipped > budget ${kb(esmGzipBytes)}`);
      if (cjs > cjsGzipBytes) problems.push(`CJS ${kb(cjs)} gzipped > budget ${kb(cjsGzipBytes)}`);
      return problems.length === 0
        ? pass(`ESM ${kb(esm)} / CJS ${kb(cjs)} gzipped (budget ${kb(esmGzipBytes)})`)
        : fail('Bundle over budget', problems);
    },
    title: 'Bundle size budget'
  },
  {
    category: 'package',
    dependsOn: ['build'],
    description: 'npm pack would publish exactly the allowed files and stay under the size limit.',
    id: 'package-contents',
    run: async () => {
      const result = await runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
      let files;
      let unpackedSize = 0;
      try {
        const parsed = JSON.parse(result.output.slice(result.output.indexOf('[')));
        files = parsed[0].files.map((file) => file.path);
        unpackedSize = parsed[0].unpackedSize;
      } catch {
        return fail('Could not read npm pack output', lastLines(result.output, 20));
      }
      const { allowed, maxUnpackedBytes, required } = validationConfig.packageContents;
      const problems = [
        ...files
          .filter((file) => !allowed.some((pattern) => pattern.test(file)))
          .map((file) => `Unexpected file in package: ${file}`),
        ...required
          .filter((file) => !files.includes(file))
          .map((file) => `Missing from package: ${file}`)
      ];
      if (unpackedSize > maxUnpackedBytes) {
        problems.push(`Unpacked size ${unpackedSize} bytes > ${maxUnpackedBytes}`);
      }
      return problems.length === 0
        ? pass(`${files.length} files, ${(unpackedSize / 1024).toFixed(1)} KB unpacked`)
        : fail('Package contents problems', problems);
    },
    title: 'Published files'
  },
  {
    category: 'package',
    description:
      `The public API (names and signatures) matches ${API_SNAPSHOT_PATH}. Intentional changes: ` +
      'run npm run api:update and add a CHANGELOG entry.',
    id: 'api-snapshot',
    run: async () => {
      if (!exists(API_SNAPSHOT_PATH))
        return fail(`${API_SNAPSHOT_PATH} is missing`, ['Run: npm run api:update']);
      const expected = readJson(API_SNAPSHOT_PATH);
      const actual = readPublicApi();
      const problems = [];
      for (const name of Object.keys(expected)) {
        if (!(name in actual)) problems.push(`Removed export: ${name}`);
        else if (JSON.stringify(expected[name]) !== JSON.stringify(actual[name])) {
          problems.push(
            `Changed: ${name}\n      was: ${expected[name].signature}\n      now: ${actual[name].signature}`
          );
        }
      }
      for (const name of Object.keys(actual)) {
        if (!(name in expected)) problems.push(`New export: ${name}`);
      }
      if (problems.length)
        problems.push('If intentional: npm run api:update, and note it in CHANGELOG.md');
      return problems.length === 0
        ? pass(`${Object.keys(actual).length} exports match the snapshot`)
        : fail('Public API changed', problems);
    },
    title: 'Public API snapshot'
  }
];
