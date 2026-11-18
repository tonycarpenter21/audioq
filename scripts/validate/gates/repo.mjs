/**
 * Repository hygiene gates.
 */
import { statSync } from 'node:fs';
import { validationConfig } from '../config.mjs';
import { abs, exists, fail, pass, read, runCommand } from '../lib.mjs';

const TEXT_FILE = /\.(ts|mjs|js|json|md|yml|yaml)$/;

export const repoGates = [
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
