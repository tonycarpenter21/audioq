/**
 * Documentation gates: changelog, README coverage, README examples compile, links, license.
 */
import { readPublicApi, runtimeApiNames } from '../api.mjs';
import { abs, exists, fail, packageJson, pass, read, ts } from '../lib.mjs';

const ENTRY = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?: - (\S+))?/;

const compareSemver = (a, b) => {
  const [pa, pb] = [a, b].map((v) => v.split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

/** Extracts ```ts / ```typescript blocks with their starting line, honouring skip markers. */
const codeBlocks = (markdown) => {
  const lines = markdown.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```(ts|typescript)\s*$/);
    if (!open) continue;
    const skip =
      /<!--\s*validate:skip\s*-->/.test(lines[i - 1] ?? '') ||
      /<!--\s*validate:skip\s*-->/.test(lines[i - 2] ?? '');
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].startsWith('```')) end++;
    if (!skip) blocks.push({ code: lines.slice(start, end), line: start + 1 });
    i = end;
  }
  return blocks;
};

/** Typechecks code blocks against src/index.ts, imported as 'audioq'. */
const typecheckExamples = (documentPath) => {
  const api = readPublicApi();
  const names = Object.keys(api);
  const files = new Map();
  codeBlocks(read(documentPath)).forEach((block, index) => {
    const imports = block.code.filter(
      (line) => /^import\s/.test(line) && !/from 'audioq'/.test(line)
    );
    const body = block.code.filter((line) => !/^import\s/.test(line));
    const header = [
      `import { ${names.join(', ')} } from 'audioq';`,
      ...imports,
      'declare const button: HTMLButtonElement;',
      'export async function example(): Promise<void> {'
    ];
    const fileName = abs(`.validation-examples/example-${index}.ts`);
    files.set(fileName, {
      block,
      headerLines: header.length,
      text: [...header, ...body, '}'].join('\n')
    });
  });
  if (files.size === 0) return { count: 0, problems: [] };
  const options = {
    baseUrl: abs('.'),
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noUnusedLocals: false,
    paths: { audioq: ['src/index.ts'] },
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
    types: []
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    files.has(fileName)
      ? ts.createSourceFile(fileName, files.get(fileName).text, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => files.has(fileName) || fileExists(fileName);
  const program = ts.createProgram([...files.keys()], options, host);
  const problems = [];
  for (const [fileName, { block, headerLines }] of files) {
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(fileName));
    for (const diagnostic of diagnostics) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const docLine = block.line + line - headerLines;
      problems.push(
        `${documentPath}:${docLine} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
      );
    }
  }
  return { count: files.size, problems };
};

export const docGates = [
  {
    category: 'docs',
    description:
      'CHANGELOG.md starts with the package.json version; versions strictly descend; dates are ' +
      'valid, not in the future, and never increase going down the file.',
    id: 'changelog',
    run: async () => {
      if (!exists('CHANGELOG.md')) return fail('CHANGELOG.md is missing');
      const entries = read('CHANGELOG.md')
        .split('\n')
        .map((line, index) => ({ index, match: line.match(ENTRY) }))
        .filter(({ match }) => match)
        .map(({ index, match }) => ({ date: match[2], line: index + 1, version: match[1] }));
      const problems = [];
      const { version } = packageJson();
      if (entries[0]?.version !== version) {
        problems.push(
          `First entry is ${entries[0]?.version ?? 'missing'}, package.json is ${version}`
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      entries.forEach((entry, i) => {
        if (
          !entry.date ||
          !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
          Number.isNaN(Date.parse(entry.date))
        ) {
          problems.push(`CHANGELOG.md:${entry.line} ${entry.version} has no valid YYYY-MM-DD date`);
        } else if (entry.date > today) {
          problems.push(`CHANGELOG.md:${entry.line} ${entry.version} is dated in the future`);
        }
        const next = entries[i + 1];
        if (!next) return;
        if (compareSemver(entry.version, next.version) <= 0) {
          problems.push(
            `CHANGELOG.md:${next.line} ${next.version} should be older than ${entry.version}`
          );
        }
        if (entry.date && next.date && next.date > entry.date) {
          problems.push(
            `CHANGELOG.md:${next.line} ${next.version} (${next.date}) is dated after ${entry.version} (${entry.date})`
          );
        }
      });
      return problems.length === 0
        ? pass(`${entries.length} changelog entries in order`)
        : fail('Changelog problems', problems);
    },
    title: 'Changelog'
  },
  {
    category: 'docs',
    description: 'Every runtime export of the package is mentioned in README.md.',
    id: 'readme-api-coverage',
    run: async () => {
      const readme = read('README.md');
      const missing = runtimeApiNames().filter((name) => !new RegExp(`\\b${name}\\b`).test(readme));
      return missing.length === 0
        ? pass('README mentions every runtime export')
        : fail(
            `${missing.length} export(s) undocumented in README`,
            missing.map((name) => `README.md never mentions ${name}`)
          );
    },
    title: 'README covers the API'
  },
  {
    category: 'docs',
    description:
      'Every ```ts example in README.md compiles against the real API ' +
      '(opt out per block with <!-- validate:skip -->).',
    id: 'readme-examples-compile',
    run: async () => {
      const { count, problems } = typecheckExamples('README.md');
      return problems.length === 0
        ? pass(`${count} README examples compile`)
        : fail(`${problems.length} README example error(s)`, problems);
    },
    title: 'README examples compile'
  },
  {
    category: 'docs',
    description: 'Relative links in Markdown files point to files that exist.',
    id: 'docs-links',
    run: async () => {
      const problems = [];
      for (const doc of ['README.md', 'MIGRATION.md', 'CHANGELOG.md'].filter(exists)) {
        for (const [, target] of read(doc).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
          if (/^[a-z]+:/i.test(target)) continue;
          if (!exists(target.replace(/^\.\//, '')))
            problems.push(`${doc} links to missing ${target}`);
        }
      }
      return problems.length === 0
        ? pass('All relative links resolve')
        : fail('Broken links', problems);
    },
    title: 'Docs links'
  },
  {
    category: 'docs',
    description: 'LICENSE exists and matches the MIT license declared in package.json.',
    id: 'license',
    run: async () => {
      if (!exists('LICENSE')) return fail('LICENSE is missing');
      const text = read('LICENSE');
      const problems = [];
      if (!/MIT License/.test(text)) problems.push('LICENSE is not the MIT license text');
      if (!/Copyright \(c\) \d{4}/i.test(text)) problems.push('LICENSE has no copyright line');
      if (packageJson().license !== 'MIT') problems.push('package.json license is not MIT');
      return problems.length === 0
        ? pass('MIT license present')
        : fail('License problems', problems);
    },
    title: 'License'
  }
];
