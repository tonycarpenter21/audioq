#!/usr/bin/env node
/**
 * Runs every validation gate and writes a report of the run.
 *
 *   npm run validate:all                      run everything
 *   npm run validate:all -- --only=lint,build run some gates (dependencies are not auto-added)
 *   npm run validate:all -- --skip=bundle-size
 *   npm run validate:all -- --list            describe the gates
 *
 * Reports go to .validation-reports/<timestamp>/ (git-ignored):
 *   report.md    failing gates first, with every problem, then a table of all gates
 *   report.json  machine-readable results
 *   logs/*.log   full output of each gate
 * Only the newest runs are kept (see scripts/validate/config.mjs). Exit code 1 if any gate fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validationConfig } from './validate/config.mjs';
import { gates } from './validate/gates.mjs';
import { abs } from './validate/lib.mjs';

const usage = () => {
  console.error('Usage: npm run validate:all -- [--list] [--only=a,b | --only a,b] [--skip=a,b]');
  process.exit(2);
};

/** Parses --list, --only and --skip (with `=` or a following value). Unknown flags are errors. */
const parseArgs = (argv) => {
  const parsed = { list: false, only: undefined, skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      parsed.list = true;
      continue;
    }
    const match = /^--(only|skip)(?:=(.*))?$/.exec(arg);
    if (!match) {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) {
      console.error(`--${match[1]} needs a comma-separated list of gate ids`);
      usage();
    }
    const ids = value.split(',').filter(Boolean);
    if (match[1] === 'only') parsed.only = [...(parsed.only ?? []), ...ids];
    else parsed.skip.push(...ids);
  }
  return parsed;
};

const { list, only, skip } = parseArgs(process.argv.slice(2));

if (list) {
  for (const gate of gates) {
    const deps = gate.dependsOn ? ` (after: ${gate.dependsOn.join(', ')})` : '';
    console.log(
      `${gate.id.padEnd(26)} [${gate.category}] ${gate.title}${deps}\n${' '.repeat(27)}${gate.description}\n`
    );
  }
  process.exit(0);
}

const unknown = [...(only ?? []), ...skip].filter((id) => !gates.some((gate) => gate.id === id));
if (unknown.length) {
  console.error(`Unknown gate id(s): ${unknown.join(', ')}. Use --list to see them.`);
  process.exit(2);
}

/** --only also runs every gate the selected ones depend on, so nothing reads stale output. */
const selectedIds = new Set();
const include = (id) => {
  if (selectedIds.has(id)) return;
  selectedIds.add(id);
  gates.find((gate) => gate.id === id)?.dependsOn?.forEach(include);
};
(only ?? gates.map((gate) => gate.id)).forEach(include);
const autoIncluded = only ? [...selectedIds].filter((id) => !only.includes(id)) : [];

/** Default limit for one gate; a gate may set its own `timeoutMs`. */
const GATE_TIMEOUT_MS = 10 * 60 * 1000;

const runWithTimeout = (gate) => {
  const limit = gate.timeoutMs ?? GATE_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          problems: [`No result after ${Math.round(limit / 1000)}s`],
          status: 'fail',
          summary: 'Gate timed out'
        }),
      limit
    );
  });
  return Promise.race([gate.run(), timeout]).finally(() => clearTimeout(timer));
};

const git = (...gitArgs) => {
  try {
    return execFileSync('git', gitArgs, { cwd: abs('.'), encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const ICON = { blocked: '⊘', fail: '✖', pass: '✔', skipped: '○', warn: '⚠' };
const startedAt = new Date();
const results = [];

console.log(`audioq validation: ${selectedIds.size - skip.length} of ${gates.length} gates`);
if (autoIncluded.length) console.log(`(also running dependencies: ${autoIncluded.join(', ')})`);
console.log('');
for (const gate of gates) {
  const selected = selectedIds.has(gate.id) && !skip.includes(gate.id);
  // A dependency that failed, was blocked, or was skipped means this gate would read stale output.
  const blockedBy = (gate.dependsOn ?? []).filter((id) =>
    results.some(
      (result) => result.id === id && result.status !== 'pass' && result.status !== 'warn'
    )
  );
  let result;
  const begin = Date.now();
  if (!selected) {
    result = { status: 'skipped', summary: 'Not selected' };
  } else if (blockedBy.length) {
    const reasons = blockedBy.map((id) =>
      results.find((r) => r.id === id)?.status === 'skipped'
        ? `${id} was skipped`
        : `${id} did not pass`
    );
    result = { status: 'blocked', summary: `Blocked: ${reasons.join(', ')}` };
  } else {
    try {
      result = await runWithTimeout(gate);
    } catch (error) {
      result = {
        problems: [String(error?.stack ?? error)],
        status: 'fail',
        summary: 'Gate crashed'
      };
    }
  }
  const entry = {
    category: gate.category,
    description: gate.description,
    durationMs: Date.now() - begin,
    id: gate.id,
    output: result.output ?? '',
    problems: result.problems ?? [],
    status: result.status,
    summary: result.summary,
    title: gate.title
  };
  results.push(entry);
  if (entry.status === 'skipped') continue;
  const seconds = (entry.durationMs / 1000).toFixed(1).padStart(5);
  console.log(`${ICON[entry.status]} ${gate.id.padEnd(26)} ${seconds}s  ${entry.summary}`);
  if (entry.status === 'fail') {
    // Print the problems too, so CI logs are useful without downloading the report.
    const shown = entry.problems.slice(0, 15);
    for (const problem of shown) console.log(`      ${problem.split('\n').join('\n      ')}`);
    if (entry.problems.length > shown.length) {
      console.log(`      ... ${entry.problems.length - shown.length} more in the report`);
    }
  }
}

const count = (status) => results.filter((result) => result.status === status).length;
const failed = results.filter((result) => result.status === 'fail' || result.status === 'blocked');
const totalSeconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);

// ------------------------------------------------------------------ report
const runId = startedAt.toISOString().replace(/[:.]/g, '-');
const reportsRoot = abs(validationConfig.reports.directory);
const runDir = join(reportsRoot, runId);
mkdirSync(join(runDir, 'logs'), { recursive: true });

for (const result of results) {
  const log = [
    `${result.title} (${result.id}): ${result.status.toUpperCase()}`,
    result.summary,
    '',
    ...result.problems,
    result.output ? `\n--- output ---\n${result.output}` : ''
  ].join('\n');
  writeFileSync(join(runDir, 'logs', `${result.id}.log`), log);
}

const meta = {
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  commit: git('rev-parse', '--short', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  durationSeconds: Number(totalSeconds),
  finishedAt: new Date().toISOString(),
  node: process.version,
  startedAt: startedAt.toISOString()
};
const totals = {
  warned: count('warn'),
  blocked: count('blocked'),
  failed: count('fail'),
  passed: count('pass'),
  skipped: count('skipped'),
  total: results.length
};

writeFileSync(
  join(runDir, 'report.json'),
  `${JSON.stringify({ meta, results: results.map(({ output, ...rest }) => ({ ...rest, log: `logs/${rest.id}.log`, outputBytes: output.length })), totals }, null, 2)}\n`
);

const md = [];
md.push(`# Validation report: ${failed.length === 0 ? 'PASSED' : 'FAILED'}`);
md.push('');
md.push(`- Run: ${meta.startedAt} (${totalSeconds}s, Node ${meta.node})`);
md.push(`- Commit: ${meta.commit} on ${meta.branch}${meta.dirty ? ' (uncommitted changes)' : ''}`);
md.push(
  `- Gates: ${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked, ${totals.warned} warned, ${totals.skipped} skipped`
);
md.push('');
const warned = results.filter((result) => result.status === 'warn');
if (warned.length) {
  md.push('## Warnings');
  md.push('');
  for (const result of warned) md.push(`- ${ICON.warn} \`${result.id}\`: ${result.summary}`);
  md.push('');
}
if (failed.length) {
  md.push('## Failing gates');
  md.push('');
  for (const result of failed) {
    md.push(`### ${ICON[result.status]} ${result.title} (\`${result.id}\`)`);
    md.push('');
    md.push(`${result.summary}. ${result.description}`);
    md.push('');
    if (result.problems.length) {
      md.push('```');
      md.push(...result.problems.slice(0, 200));
      if (result.problems.length > 200)
        md.push(`... ${result.problems.length - 200} more (see log)`);
      md.push('```');
      md.push('');
    }
    md.push(`Full log: [logs/${result.id}.log](logs/${result.id}.log)`);
    md.push('');
  }
}
md.push('## All gates');
md.push('');
md.push('| | Gate | Category | Time | Result |');
md.push('|---|---|---|---|---|');
for (const result of results) {
  const summary = result.summary.replace(/\|/g, '\\|');
  md.push(
    `| ${ICON[result.status]} | \`${result.id}\` ${result.title} | ${result.category} | ${(result.durationMs / 1000).toFixed(1)}s | ${summary} |`
  );
}
md.push('');
writeFileSync(join(runDir, 'report.md'), `${md.join('\n')}\n`);
writeFileSync(join(reportsRoot, 'LATEST'), `${runId}\n`);

// keep only the newest N runs
const runs = readdirSync(reportsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
for (const old of runs.slice(0, Math.max(0, runs.length - validationConfig.reports.keep))) {
  rmSync(join(reportsRoot, old), { force: true, recursive: true });
}

console.log(
  `\n${failed.length === 0 ? 'PASSED' : 'FAILED'}: ${totals.passed} passed, ${totals.failed} failed, ` +
    `${totals.blocked} blocked, ${totals.warned} warned, ${totals.skipped} skipped in ${totalSeconds}s`
);
console.log(`Report: ${validationConfig.reports.directory}/${runId}/report.md`);
process.exit(failed.length === 0 ? 0 : 1);
