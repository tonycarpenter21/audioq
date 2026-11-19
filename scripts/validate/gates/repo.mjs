/**
 * Repository hygiene gates.
 */
import { statSync } from 'node:fs';
import { validationConfig } from '../config.mjs';
import { abs, exists, fail, pass, read, runCommand } from '../lib.mjs';

const TEXT_FILE = /\.(ts|mjs|js|json|md|yml|yaml)$/;

const WORKFLOW = '.github/workflows/validate.yml';

export const repoGates = [
  {
    category: 'repo',
    description:
      `${WORKFLOW} runs npm ci and npm run validate:all on pushes and pull requests, on the ` +
      'oldest supported development Node version and the newest, and uploads the report.',
    id: 'ci-workflow',
    run: async () => {
      if (!exists(WORKFLOW)) return fail(`${WORKFLOW} is missing`);
      const text = read(WORKFLOW);
      const problems = [];
      const need = (pattern, message) => pattern.test(text) || problems.push(message);
      need(/^\s*push:/m, 'workflow must run on push');
      need(/^\s*pull_request:/m, 'workflow must run on pull_request');
      need(/npm ci\b/, 'workflow must install with npm ci (uses the lockfile)');
      need(/npm run validate:all\b/, 'workflow must run npm run validate:all');
      need(/upload-artifact/, 'workflow must upload .validation-reports as an artifact');
      need(/if:\s*always\(\)/, 'report upload must run even when validation fails');
      const minimum = /\^(\d+\.\d+)\.\d+/.exec(
        JSON.parse(read('package.json')).devEngines?.runtime?.version ?? ''
      )?.[1];
      if (minimum && !text.includes(`'${minimum}'`)) {
        problems.push(
          `matrix must include the minimum dev Node version '${minimum}' from devEngines`
        );
      }
      return problems.length === 0
        ? pass('CI runs every gate on push and pull request')
        : fail('CI workflow problems', problems);
    },
    title: 'CI runs validate:all'
  },
  {
    category: 'repo',
    description:
      'Build output, coverage, reports and node_modules are git-ignored and not committed; no huge ' +
      'files; no merge conflict markers.',
    id: 'git-hygiene',
    run: async () => {
      const problems = [];
      const gitignore = exists('.gitignore') ? read('.gitignore') : '';
      for (const path of validationConfig.ignoredPaths) {
        const ignored = gitignore
          .split('\n')
          .some((line) => line.trim().replace(/^\/|\/\*?$/g, '') === path);
        if (!ignored) problems.push(`.gitignore does not ignore ${path}/`);
      }
      const listed = await runCommand('git', ['ls-files']);
      if (listed.code !== 0) return fail('git ls-files failed', [listed.output]);
      const tracked = listed.output.split('\n').filter(Boolean);
      for (const file of tracked) {
        if (
          validationConfig.ignoredPaths.some((path) => file === path || file.startsWith(`${path}/`))
        ) {
          problems.push(`${file} is committed but should be ignored`);
          continue;
        }
        if (!exists(file)) continue;
        const size = statSync(abs(file)).size;
        if (size > validationConfig.maxTrackedFileBytes) problems.push(`${file} is ${size} bytes`);
        if (TEXT_FILE.test(file) && /^(<{7}|>{7}|={7})( |$)/m.test(read(file))) {
          problems.push(`${file} contains a merge conflict marker`);
        }
      }
      return problems.length === 0
        ? pass(`${tracked.length} tracked files clean`)
        : fail('Repository hygiene problems', problems);
    },
    title: 'Git hygiene'
  }
];
