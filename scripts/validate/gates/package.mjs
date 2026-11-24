/**
 * Gates about what gets published: metadata, lockfile, exports, SSR safety, size, tarball, API.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { API_SNAPSHOT_PATH, ENTRY_POINTS, readPublicApi, readPublishedApi } from '../api.mjs';
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

/** Package entry points other than ./package.json, e.g. ['.', './queue']. */
const entryPoints = (pkg) =>
  Object.entries(pkg.exports ?? {}).filter(([subpath]) => subpath !== './package.json');

/**
 * Node code that loads one built entry point (`index` or `queue`) as `cjs` and `esm`, and records
 * the globals the import added as `added`.
 */
const importBoth = (file = 'index') => `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(pathToFileURL(abs('package.json')).href)});
const before = new Set(Object.getOwnPropertyNames(globalThis));
const cjs = require(${JSON.stringify(abs(`dist/cjs/${file}.js`))});
const esm = await import(${JSON.stringify(pathToFileURL(abs(`dist/esm/${file}.js`)).href)});
const added = Object.getOwnPropertyNames(globalThis).filter((key) => !before.has(key));
`;

export const packageGates = [
  {
    category: 'package',
    description:
      'npm audit finds no known vulnerabilities in any dependency (dev tools included). ' +
      'Warns instead of failing when the registry cannot be reached.',
    id: 'dependency-audit',
    run: async () => {
      const result = await runCommand('npm', ['audit', '--json'], { timeoutMs: 60_000 });
      if (result.timedOut) {
        return { output: result.output, status: 'warn', summary: 'npm audit timed out (offline?)' };
      }
      let report;
      try {
        report = JSON.parse(result.output.slice(result.output.indexOf('{')));
      } catch {
        return {
          status: 'warn',
          summary: 'npm audit unavailable (offline?)',
          output: result.output
        };
      }
      if (report.error) {
        return {
          output: result.output,
          status: 'warn',
          summary: `npm audit unavailable: ${report.error.code ?? 'error'}`
        };
      }
      const counts = report.metadata?.vulnerabilities ?? {};
      const total = counts.total ?? 0;
      if (total === 0) return pass('0 known vulnerabilities', { output: result.output });
      const problems = Object.values(report.vulnerabilities ?? {}).map(
        (v) =>
          `${v.name} (${v.severity}${v.isDirect ? ', direct' : ''}): ${v.via.map((x) => (typeof x === 'string' ? x : x.title)).join('; ')}`
      );
      return fail(`${total} known vulnerabilities`, problems, { output: result.output });
    },
    title: 'Dependency audit'
  },
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
      need(pkg.exports?.['.'] !== undefined, 'exports["."] is missing');
      need(pkg.exports?.['./queue'] !== undefined, 'exports["./queue"] is missing');
      for (const [subpath, target] of entryPoints(pkg)) {
        need(Object.keys(target)[0] === 'types', `exports["${subpath}"].types must come first`);
        need(target.import && target.require, `exports["${subpath}"] needs import and require`);
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
      const targets = [
        pkg.main,
        pkg.module,
        pkg.types,
        ...entryPoints(pkg).flatMap(([, target]) => Object.values(target))
      ];
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
      let count = 0;
      for (const [specifier, source] of Object.entries(ENTRY_POINTS)) {
        const file = specifier === 'audioq' ? 'index' : specifier.replace('audioq/', '');
        const { error, value } = await runInNode(
          `${importBoth(file)} console.log(JSON.stringify({ cjs: Object.keys(cjs).sort(), esm: Object.keys(esm).filter((k) => k !== 'default').sort() }));`
        );
        if (error)
          return fail(`${specifier} failed to load`, [...problems, ...lastLines(error, 20)]);
        const missingInCjs = value.esm.filter((name) => !value.cjs.includes(name));
        const missingInEsm = value.cjs.filter((name) => !value.esm.includes(name));
        if (missingInCjs.length)
          problems.push(`${specifier}: missing from CJS: ${missingInCjs.join(', ')}`);
        if (missingInEsm.length)
          problems.push(`${specifier}: missing from ESM: ${missingInEsm.join(', ')}`);
        const declared = new Set(Object.keys(readPublicApi(source)));
        const undeclared = value.esm.filter((name) => !declared.has(name));
        if (undeclared.length)
          problems.push(`${specifier}: runtime exports without types: ${undeclared.join(', ')}`);
        count += value.esm.length;
      }
      return problems.length === 0
        ? pass(`${count} runtime exports identical in ESM and CJS, all typed`)
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
      const { error, value } = await runInNode(`${importBoth()}
        const onQueue = await import(${JSON.stringify(pathToFileURL(abs('dist/esm/queue.js')).href)});
        const queue = onQueue.createAudioQueue({ logger: null });
        let queueError = '';
        try { await onQueue.queueAudio(queue, '/a.mp3'); } catch (e) { queueError = e.message; }
        console.log(JSON.stringify({
          added,
          config: cjs.getQueueConfig().maxChannels,
          length: onQueue.getQueueLength(queue),
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
    description:
      'Gzipped size of each built format, and the minified + gzipped size an app ships (whole ' +
      'package, and queueAudio alone), stay within the budgets in config.mjs.',
    id: 'bundle-size',
    run: async () => {
      const budget = validationConfig.bundle;
      const measure = (folder) =>
        gzipSync(
          Buffer.concat(
            listFiles(`dist/${folder}`, (p) => p.endsWith('.js')).map((p) => readFileSync(abs(p)))
          ),
          { level: 9 }
        ).length;
      const minified = async (contents) => {
        const result = await build({
          bundle: true,
          format: 'esm',
          logLevel: 'silent',
          minify: true,
          stdin: { contents, resolveDir: abs('.') },
          write: false
        });
        return gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
      };
      const entry = JSON.stringify(abs('dist/esm/index.js'));
      const sizes = {
        cjs: measure('cjs'),
        esm: measure('esm'),
        minifiedFull: await minified(`export * from ${entry};`),
        minifiedQueueAudioOnly: await minified(
          `import { queueAudio } from ${entry}; queueAudio('/a.mp3');`
        ),
        minifiedQueueEntryOnly: await minified(
          `import { createAudioQueue, queueAudio } from ${JSON.stringify(abs('dist/esm/queue.js'))};
           queueAudio(createAudioQueue(), '/a.mp3');`
        )
      };
      const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
      const limits = {
        cjs: budget.cjsGzipBytes,
        esm: budget.esmGzipBytes,
        minifiedFull: budget.minifiedFullGzipBytes,
        minifiedQueueAudioOnly: budget.minifiedQueueAudioOnlyGzipBytes,
        minifiedQueueEntryOnly: budget.minifiedQueueAudioOnlyGzipBytes
      };
      const problems = Object.entries(sizes)
        .filter(([key, bytes]) => bytes > limits[key])
        .map(([key, bytes]) => `${key}: ${kb(bytes)} > budget ${kb(limits[key])}`);
      const summary =
        `min+gz ${kb(sizes.minifiedFull)} (queueAudio only ${kb(sizes.minifiedQueueAudioOnly)}, ` +
        `audioq/queue queueAudio only ${kb(sizes.minifiedQueueEntryOnly)}), ` +
        `dist gz ESM ${kb(sizes.esm)} / CJS ${kb(sizes.cjs)}`;
      return problems.length === 0
        ? pass(summary, { output: JSON.stringify(sizes, null, 2) })
        : fail('Bundle over budget', problems, { output: JSON.stringify(sizes, null, 2) });
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
      let unpackedSize;
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
      const actual = readPublishedApi();
      const problems = [];
      if (/"(\/|[A-Za-z]:\\)/.test(JSON.stringify(actual))) {
        problems.push('The API description contains absolute file paths (machine-specific)');
      }
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
