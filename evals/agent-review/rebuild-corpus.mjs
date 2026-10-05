import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assert, encoded, qualify, readJson, sha } from './portable/core.mjs';
import { buildBugs, buildControls } from './builders/production-corpus.mjs';

const suite = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const repo = path.resolve(option('--repository', path.resolve(suite, '../..')));
const output = option('--out');
assert(
  output &&
    args.every(
      (arg, index) =>
        ['--repository', '--out', '--check'].includes(arg) || ['--repository', '--out'].includes(args[index - 1]),
    ),
  'Use --repository <source-clone> --out <fresh-directory> [--check]',
);
const destination = path.resolve(output);
assert(!fs.existsSync(destination), 'Build output must be a fresh directory');
const req = createRequire(path.join(repo, 'extension/package.json'));
const versions = { esbuild: '0.21.5', typescript: '5.9.3', marked: '4.3.0', diff: '5.2.2' };
for (const [name, version] of Object.entries(versions))
  assert(req(`${name}/package.json`).version === version, `Build dependency version: ${name} ${version}`);
const git = (...values) => execFileSync('git', ['-C', repo, ...values], { maxBuffer: 64 * 1024 * 1024 });
const snapshot = 'ac1e28c6684c9d399bc8f8fddcf420f2dd86182a';
const read = (revision, name) => git('show', `${revision}:${name}`);
const put = (name, bytes) => {
  const file = path.join(destination, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const cohort = readJson(path.join(suite, 'cohorts/review-diversity-v1.json'));
const scratch = path.join(destination, '.build');
fs.mkdirSync(scratch, { recursive: true });
try {
  fs.writeFileSync(path.join(scratch, 'vscode.ts'), read(snapshot, 'extension/test/vscode.ts'));
  const runtimeEntries = await buildBugs({ repo, suite: destination, scratch });
  await buildControls({ repo, suite: destination });
  const checked = [];
  const check = (name, expected) => {
    const bytes = fs.readFileSync(path.join(destination, name));
    if (args.includes('--check')) assert(sha(bytes) === expected, `Reproduction changed: ${name}`);
    checked.push({ path: name, sha256: sha(bytes) });
  };
  for (const entry of cohort.entries) {
    const name = `fixtures/${entry.case_id}`;
    const fixture = path.join(suite, name);
    const provenance = readJson(path.join(fixture, 'provenance.json'));
    for (const source of provenance.source_files) {
      for (const [side, revision, expected] of [
        ['input', provenance.source.candidate, source.candidate_sha256],
        ['reference', provenance.source.correction, source.reference_sha256],
      ]) {
        put(`${name}/${side}/${source.path}`, read(revision, source.path));
        check(`${name}/${side}/${source.path}`, expected);
      }
    }
    for (const generated of provenance.generated_files)
      for (const [side, expected] of [
        ['input', generated.candidate_sha256],
        ['reference', generated.reference_sha256],
      ])
        check(`${name}/${side}/${generated.path}`, expected);
    check(`${name}/qualify.mjs`, entry.qualifier_sha256);
    const diff =
      entry.case_id === 'portable-025'
        ? await causalBase(provenance, name, runtimeEntries[entry.case_id])
        : git(
            'diff',
            '--no-ext-diff',
            '--no-color',
            provenance.source.base,
            provenance.source.candidate,
            '--',
            ...provenance.source_files.map((source) => source.path),
          );
    put(`${name}/candidate.diff`, diff);
    const item = readJson(path.join(suite, `portable/cases/${entry.case_id}.json`));
    check(`${name}/candidate.diff`, item.diff_sha256);
    const result = qualify(
      path.join(destination, name, 'qualify.mjs'),
      path.join(destination, name, 'input'),
      path.join(destination, name, 'reference'),
      entry.kind,
    );
    assert(encoded(result) === encoded(entry.qualification.result), `Rebuilt qualification: ${entry.case_id}`);
  }
  const bundle = 'fixtures/review-diversity-instructions';
  const manifest = readJson(path.join(suite, bundle, 'manifest.json'));
  for (const doc of [...manifest.documents, ...manifest.omitted_documents])
    assert(sha(read(snapshot, doc.path)) === doc.original_sha256, `Original instruction snapshot: ${doc.path}`);
  const original = read(snapshot, 'CLAUDE.md').toString();
  const start = original.indexOf('## Writing');
  const end = original.indexOf('\n## ', start + 1);
  const boundary =
    'Review only the supplied candidate change and source. Report material defects with their trigger, consequence, and evidence. Current glossary terms apply to explanations. Later repository features do not require changes to historical snapshots. Runtime artifacts bundle the supplied source for Node. They do not add product behavior. Qualification scripts and corrected references remain outside assigned inputs.\n\n';
  put(`${bundle}/CLAUDE.md`, boundary + original.slice(start, end < 0 ? undefined : end));
  put(`${bundle}/docs/glossary.md`, read(snapshot, 'docs/glossary.md'));
  for (const doc of manifest.documents) check(`${bundle}/${doc.path}`, doc.exported_sha256);
  put(
    'reproduction.json',
    encoded({ schema: 'arc-corpus-reproduction-v1', instruction_source: snapshot, versions, checked }),
  );
  console.log(encoded({ complete: true, versions, reproduced_files: checked.length, output: destination }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function causalBase(provenance, name, entries) {
  const parser = 'extension/src/projectspend.ts';
  const candidate = read(provenance.source.candidate, parser).toString();
  const corrected = read(provenance.source.correction, parser).toString();
  const lineStart = corrected.indexOf('        if (completedOffset > 0) {');
  const lineEnd = corrected.indexOf('        for (const event of reducer.pushLine', lineStart);
  const tailStart = corrected.indexOf('    if (complete && completedOffset > 0 && held.length > 0');
  const tailEnd = corrected.indexOf('    return {', tailStart);
  assert(
    lineStart >= 0 && tailStart >= 0 && lineEnd > lineStart && tailEnd > tailStart,
    'Padding transformation source',
  );
  const base = candidate
    .replace(
      '        for (const event of reducer.pushLine',
      corrected.slice(lineStart, lineEnd) + '        for (const event of reducer.pushLine',
    )
    .replace(
      '    const complete = position >= size;\n',
      '    const complete = position >= size;\n' + corrected.slice(tailStart, tailEnd),
    );
  put(`${name}/base/${parser}`, base);
  const names = git('ls-tree', '-r', '--name-only', provenance.source.candidate).toString().split('\n');
  const resolve = (from, spec) => {
    const raw = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    return [raw, raw + '.ts', raw + '.js', raw + '/index.ts'].find((file) => names.includes(file));
  };
  const contents =
    entries.map((file, index) => `import * as m${index} from './${file}';`).join('\n') +
    `\nexport const modules={${entries.map((file, index) => JSON.stringify(file) + ':m' + index).join(',')}};`;
  const plugin = {
    name: 'historical',
    setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(scratch, 'vscode.ts') }));
      build.onResolve({ filter: /^\./ }, (args) => {
        if (args.namespace === 'history' || args.importer.endsWith('entry.ts')) {
          const found = resolve(args.namespace === 'history' ? args.importer : 'entry.ts', args.path);
          if (found) return { path: found, namespace: 'history' };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: 'history' }, (args) => ({
        contents: args.path === parser ? base : read(provenance.source.candidate, args.path).toString(),
        loader: args.path.endsWith('.ts') ? 'ts' : 'js',
        resolveDir: path.join(repo, 'extension'),
      }));
    },
  };
  const built = await req('esbuild').build({
    stdin: { contents, sourcefile: 'entry.ts', resolveDir: repo },
    plugins: [plugin],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    legalComments: 'none',
    minifyWhitespace: true,
    define: { PANEL_CSS: '""', PANEL_JS: '""', PANEL_DEV_SERVER_URL: 'null' },
    logLevel: 'silent',
  });
  put(`${name}/base/runtime.cjs`, built.outputFiles[0].contents);
  const result = qualify(
    path.join(destination, name, 'qualify.mjs'),
    path.join(destination, name, 'base'),
    path.join(destination, name, 'reference'),
    'clean',
  );
  put(
    `${name}/causality.json`,
    encoded({
      construction: 'candidate-snapshot-with-two-production-padding-branches',
      base: result.candidate,
      candidate: provenance.source.candidate,
      base_source_sha256: sha(base),
      candidate_source_sha256: sha(candidate),
      diff_origin: 'reconstructed-causal-introduction',
    }),
  );
  if (args.includes('--check')) {
    const reconstruction = provenance.reconstructed_base;
    assert(reconstruction && reconstruction.source_sha256 === sha(base), 'Reconstructed base source changed');
    assert(reconstruction.runtime_sha256 === sha(built.outputFiles[0].contents), 'Reconstructed base runtime changed');
  }
  const patch = req('diff').createTwoFilesPatch(`a/${parser}`, `b/${parser}`, base, candidate, '', '', { context: 3 });
  return `diff --git a/${parser} b/${parser}\n` + patch.slice(patch.indexOf('--- a/'));
}
