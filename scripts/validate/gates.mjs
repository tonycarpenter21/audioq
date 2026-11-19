/**
 * The ordered list of validation gates. Fast static checks run first, then tools, then the
 * build and the gates that inspect its output.
 */
import { docGates } from './gates/docs.mjs';
import { packageGates } from './gates/package.mjs';
import { repoGates } from './gates/repo.mjs';
import { sourceGates } from './gates/source.mjs';
import { testGates } from './gates/tests.mjs';
import { toolingGates } from './gates/tooling.mjs';

const byId = new Map(
  [...toolingGates, ...testGates, ...sourceGates, ...packageGates, ...docGates, ...repoGates].map(
    (gate) => [gate.id, gate]
  )
);

const ORDER = [
  // repository and metadata
  'git-hygiene',
  'ci-workflow',
  'package-metadata',
  'lockfile-sync',
  'dependency-audit',
  'license',
  'changelog',
  'docs-links',
  'tsconfig-strictness',
  'generated-code',
  // source structure
  'file-naming',
  'zero-dependencies',
  'forbidden-patterns',
  'no-circular-imports',
  'size-limits',
  'jsdoc-public-api',
  'api-snapshot',
  // tests
  'test-file-pairing',
  'exported-symbols-tested',
  'test-quality',
  'no-global-timer-hacks',
  // docs that need the compiler
  'readme-api-coverage',
  'readme-examples-compile',
  // standard tools
  'format',
  'lint',
  'typecheck-src',
  'typecheck-tests',
  'unit-tests',
  'coverage-per-file',
  // build output
  'build',
  'package-exports',
  'ssr-import',
  'bundle-size',
  'package-contents'
];

const missing = [...byId.keys()].filter((id) => !ORDER.includes(id));
if (missing.length) throw new Error(`Gates missing from ORDER: ${missing.join(', ')}`);

/** All gates in run order. */
export const gates = ORDER.map((id) => {
  const gate = byId.get(id);
  if (!gate) throw new Error(`Unknown gate in ORDER: ${id}`);
  return gate;
});
