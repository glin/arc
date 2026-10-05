import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const suite = path.join(root, 'evals/agent-review');
const require = createRequire(import.meta.url);
const { transformSync } = require('../extension/node_modules/esbuild');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const source = (revision, file) => execFileSync('git', ['show', `${revision}:${file}`], { cwd: root });
const full = (revision) => execFileSync('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8' }).trim();
const written = new Map();

function adaptControl(code, id, file) {
  if (id !== 'portable-023' || file !== 'extension/src/domain/rail-filters.ts') return code;
  const original = `  const drop = new Set(
    railQueryLenses(written).filter((other) => other !== lens).flatMap((other) => railLensKeys(other)).filter((key) => !keep.has(key))
  );`;
  const adapted = `  const opposites = [...keep].map((key) => key.startsWith("-") ? key.slice(1) : \`-\${key}\`);
  const incompatible = lens === "unread" ? ["status:read"] : lens === "input" ? ["status:running"] : [];
  const drop = new Set([
    ...opposites,
    ...incompatible,
    ...railQueryLenses(written).filter((other) => other !== lens).flatMap((other) => railLensKeys(other)).filter((key) => !keep.has(key))
  ]);`;
  if (!code.includes(original)) throw new Error(`Control adaptation no longer matches ${file}`);
  return code.replace(original, adapted);
}

function emit(id, side, revision, entry) {
  const queue = [entry];
  const visited = new Set();
  const records = [];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const original = source(revision, file);
    const relative = file.slice('extension/src/'.length).replace(/\.ts$/, '.mjs');
    const output = path.join(suite, 'fixtures', id, side, 'src', relative);
    let code = transformSync(original.toString('utf8'), {
      loader: 'ts',
      format: 'esm',
      target: 'node22',
      sourcefile: file,
    }).code;
    code = code.replace(/(from\s*['"]|import\s*\(\s*['"])(\.[^'"]+)(['"])/g, (_whole, before, spec, after) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      const resolved = path.posix.extname(target) ? target : `${target}.ts`;
      queue.push(resolved);
      return `${before}${spec.replace(/\.ts$/, '')}.mjs${after}`;
    });
    const match = [...code.matchAll(/(?:from\s*['"]|import\s*\(\s*['"])([^.'"][^'"]*)['"]/g)];
    for (const [, dependency] of match) {
      if (dependency.startsWith('node:')) continue;
      if (builtinModules.includes(dependency)) {
        code = code
          .replaceAll(`'${dependency}'`, `'node:${dependency}'`)
          .replaceAll(`"${dependency}"`, `"node:${dependency}"`);
        continue;
      }
      if (dependency !== 'marked') throw new Error(`Unexpected external dependency ${dependency} in ${file}`);
      const vendorImport = path.posix.relative(path.posix.dirname(relative), 'vendor/marked.mjs');
      code = code
        .replaceAll(`'marked'`, `'${vendorImport.startsWith('.') ? vendorImport : `./${vendorImport}`}'`)
        .replaceAll(`"marked"`, `"${vendorImport.startsWith('.') ? vendorImport : `./${vendorImport}`}"`);
      const module = require.resolve('marked', { paths: [path.join(root, 'extension')] });
      const packageRoot = path.dirname(path.dirname(module));
      const vendor = path.join(suite, 'fixtures', id, side, 'src/vendor');
      fs.mkdirSync(vendor, { recursive: true });
      fs.copyFileSync(path.join(packageRoot, 'lib/marked.esm.js'), path.join(vendor, 'marked.mjs'));
      fs.copyFileSync(path.join(packageRoot, 'LICENSE.md'), path.join(vendor, 'LICENSE.md'));
    }
    code = adaptControl(code, id, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, code);
    records.push({
      source_commit: full(revision),
      source_path: file,
      original_sha256: sha(original),
      output_path: path.relative(path.join(suite, 'fixtures', id, side), output).replaceAll('\\', '/'),
      output_sha256: sha(code),
      transformation:
        id === 'portable-023' && file === 'extension/src/domain/rail-filters.ts'
          ? 'esbuild TypeScript transform removes types and comments; relative imports gain .mjs suffixes; control adaptation removes opposite-polarity lens words and incompatible read/running statuses'
          : 'esbuild TypeScript transform removes types and comments; relative imports gain .mjs suffixes',
    });
  }
  written.set(`${id}:${side}`, records);
}

emit('portable-021', 'input', '3444b2a2', 'extension/src/domain/rail-filters.ts');
emit('portable-021', 'reference', 'd84f6d8b', 'extension/src/domain/rail-filters.ts');
emit('portable-023', 'input', 'd84f6d8b', 'extension/src/domain/rail-filters.ts');
emit('portable-023', 'reference', 'd84f6d8b', 'extension/src/domain/rail-filters.ts');
emit('portable-022', 'input', '48385f69', 'extension/src/sessioncost.ts');
emit('portable-022', 'reference', 'f09246af', 'extension/src/sessioncost.ts');
for (const id of ['portable-021', 'portable-022', 'portable-023']) {
  const folder = path.join(suite, 'fixtures', id);
  if (id === 'portable-022')
    for (const name of ['inspect.mjs', 'samples/ordinary.jsonl', 'samples/two-turns.jsonl']) {
      const target = path.join(folder, 'reference', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(folder, 'input', name), target);
    }
  const provenance = { input: written.get(`${id}:input`), reference: written.get(`${id}:reference`) };
  if (id === 'portable-022') {
    const module = require.resolve('marked', { paths: [path.join(root, 'extension')] });
    const packageRoot = path.dirname(path.dirname(module));
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    provenance.external_dependency = {
      name: 'marked',
      version: packageJson.version,
      license: packageJson.license,
      files: ['lib/marked.esm.js', 'LICENSE.md'].map((name) => ({
        source_path: `extension/node_modules/marked/${name}`,
        original_sha256: sha(fs.readFileSync(path.join(packageRoot, name))),
        output_path: name === 'LICENSE.md' ? 'src/vendor/LICENSE.md' : 'src/vendor/marked.mjs',
        output_sha256: sha(
          fs.readFileSync(
            path.join(folder, 'input', 'src/vendor', name === 'LICENSE.md' ? 'LICENSE.md' : 'marked.mjs'),
          ),
        ),
        transformation: 'verbatim copy',
      })),
    };
  }
  fs.writeFileSync(path.join(folder, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  const revisions = {
    'portable-021': ['781015c0', '3444b2a2', 'extension/src/domain/rail-filters.ts'],
    'portable-022': ['92111099', '48385f69', 'extension/src/sessioncost.ts'],
    'portable-023': ['3444b2a2', 'd84f6d8b', 'extension/src/domain/rail-filters.ts'],
  };
  const [base, candidate, file] = revisions[id];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-historical-diff-'));
  let patch;
  try {
    const before = path.join(temporary, 'before.mjs');
    const after = path.join(temporary, 'after.mjs');
    const render = (revision) =>
      adaptControl(
        transformSync(source(revision, file).toString('utf8'), {
          loader: 'ts',
          format: 'esm',
          target: 'node22',
          sourcefile: file,
        }).code.replace(
          /(from\s*['"]|import\s*\(\s*['"])(\.[^'"]+)(['"])/g,
          (_whole, prefix, name, suffix) => `${prefix}${name.replace(/\.ts$/, '')}.mjs${suffix}`,
        ),
        revision === candidate ? id : '',
        file,
      );
    fs.writeFileSync(before, render(base));
    fs.writeFileSync(after, render(candidate));
    try {
      patch = execFileSync('git', ['diff', '--no-index', '--unified=3', '--', before, after], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (error) {
      if (error.status !== 1) throw error;
      patch = error.stdout;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const diffPath = `src/${file.slice('extension/src/'.length).replace(/\.ts$/, '.mjs')}`;
  patch = patch
    .replace(/^diff --git .*$/m, `diff --git a/${diffPath} b/${diffPath}`)
    .replace(/^--- .*$/m, `--- a/${diffPath}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${diffPath}`);
  fs.writeFileSync(path.join(folder, 'candidate.diff'), patch);
  const files = (directory, prefix = '') =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const name = path.posix.join(prefix, entry.name);
      return entry.isDirectory() ? files(path.join(directory, entry.name), name) : [name];
    });
  const item = {
    schema: 'arc-portable-review-case-v1',
    id,
    revision: 1,
    family: id === 'portable-022' ? 'billing-reconciliation' : 'rail-lens',
    split: 'holdout',
    kind: id === 'portable-023' ? 'clean' : 'bug',
    source_mode: 'fixed',
    title: {
      'portable-021': 'Rail lens over typed status',
      'portable-022': 'Session billing identity and snapshot order',
      'portable-023': 'Corrected rail lens domain',
    }[id],
    provenance: {
      classification: 'adapted',
      reference: `${file} @ ${full(candidate)}`,
      limitations:
        id === 'portable-023'
          ? 'Whole domain runtime modules are transpiled without TypeScript types. The rail-filters control is adapted to remove opposite-polarity terms and incompatible read/running statuses of the requested lens. The review boundary omits UI wiring and captured historical instructions.'
          : 'Whole domain runtime modules are transpiled without TypeScript types. The review boundary omits UI wiring and captured historical instructions.',
    },
    inputs: files(path.join(folder, 'input'))
      .sort()
      .map((name) => ({ path: name, sha256: sha(fs.readFileSync(path.join(folder, 'input', name))) })),
    prompt_sha256: sha(fs.readFileSync(path.join(folder, 'prompt.txt'))),
    diff_sha256: sha(fs.readFileSync(path.join(folder, 'candidate.diff'))),
    keys:
      id === 'portable-021'
        ? [
            {
              id: 'typed-status-double-lens',
              severity: 'medium',
              summary: 'Setting a lens over a typed status term leaves two full lenses.',
              paths: ['src/domain/rail-filters.mjs'],
              scenario: 'A typed is:unread word combines with the shared exclusions written by another lens.',
              origin: 'historical-sol-xhigh',
            },
          ]
        : id === 'portable-022'
          ? [
              {
                id: 'pending-snapshot-position',
                severity: 'medium',
                summary: 'The last of 65 pending snapshots loses its own pairing position.',
                paths: ['src/sessioncost.mjs'],
                scenario: 'A billing record arrives before the 65th token snapshot while request metadata is pending.',
                origin: 'historical-sol-xhigh',
              },
              {
                id: 'late-copied-snapshot',
                severity: 'medium',
                summary: 'Late copied-turn classification leaves snapshot usage in the report.',
                paths: ['src/sessioncost.mjs'],
                scenario:
                  'A copied prior turn is classified after 65 later turn starts, followed by an original-turn replay.',
                origin: 'historical-sol-medium',
              },
            ]
          : [],
    audit:
      id === 'portable-023'
        ? 'Changed rail domain behavior covers typed and complete status lenses, quoted and negated terms, opposite-polarity words, read/unread and running/input conflicts, combined terms, partial lenses, and ambiguous stored lenses. Browser state and UI wiring are outside this domain boundary.'
        : id === 'portable-021'
          ? 'Candidate and corrected module closures execute the typed status and complete lens paths with ordinary query behavior.'
          : 'Candidate and correction run the 65-snapshot sequence, late copied-turn classification, original replay, and an ordinary bill through readSessionRequests and sessionCostReport.',
  };
  const definition = JSON.stringify(item, null, 2).replace(/"paths": \[\n\s+"([^"]+)"\n\s+\]/g, '"paths": ["$1"]');
  fs.writeFileSync(path.join(suite, 'portable/cases', `${id}.json`), definition + '\n');
}
