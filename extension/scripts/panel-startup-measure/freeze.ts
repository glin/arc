// Freeze a workspace's transcript catalog into a measurement fixture for measure.ts.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codexSessionsRoot, readCodexSessionMeta } from '../../src/codex.ts';
import { DISPATCH_ID } from '../../src/dispatchreceipts.ts';
import { turnKey } from '../../src/domain/read.ts';
import { arcHome } from '../../src/store.ts';
import { isInside, projectSlug, projectsRoot, readSessionCwd, readTurns } from '../../src/transcript.ts';

const CHUNK = 8 * 1024 * 1024;
// A selected session written this recently can still be mid-turn in the source catalog.
const SETTLED_MS = 10 * 60_000;

export interface FreezeOptions {
  workspace: string;
  projects: string;
  codex: string;
  output: string;
  // The Arc home whose dispatch receipt store the fixture keeps.
  store?: string;
  now?: number;
}

export interface FrozenSource {
  file: string;
  sha256: string;
  bytes: number;
  frozenBytes: number;
}

export interface FreezeRecord {
  workspace: string;
  frozenAt: string;
  sources: FrozenSource[];
  // Rollouts outside the workspace keep only their opening record. Discovery reads no more of them.
  reduced: Array<{ file: string; bytes: number; openingSha256: string }>;
  // Compressed rollout archives that discovery never opens. Each keeps its name as an empty file, so listings match.
  placeholders: { files: number; bytes: number };
  bytes: number;
  frozenBytes: number;
  dispatch?: Omit<DispatchFreeze, 'sources'>;
}

// Refuse a source tree that holds a health log or a Git directory. Neither may enter a fixture.
export function refuseUnsafeSource(root: string): void {
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name.toLowerCase() === '.git') throw new Error(`The source holds a Git directory: ${file}`);
      if (/^health-.*\.(json|jsonl|json\.next)$/i.test(entry.name))
        throw new Error(`The source holds a health log: ${file}`);
      if (entry.isSymbolicLink()) throw new Error(`The source holds a link: ${file}`);
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rewrite each spelling of a source path to the same spelling of its frozen path. A longer name such as `arc-tools`
// beside `arc` keeps its text.
export function pathRewriter(pairs: Array<[string, string]>): (text: string) => string {
  const spellings = (file: string): string[] => {
    const forward = file.replace(/\\/g, '/');
    const drive = /^([A-Za-z]):\//.exec(forward);
    return [
      file,
      file.replace(/\\/g, '\\\\'),
      forward,
      ...(drive ? [`/${drive[1].toLowerCase()}/${forward.slice(3)}`] : []),
    ];
  };
  const map = new Map<string, string>();
  for (const [from, to] of pairs) {
    const sources = spellings(path.resolve(from).replace(/[\\/]+$/, ''));
    const targets = spellings(path.resolve(to).replace(/[\\/]+$/, ''));
    sources.forEach((source, index) => {
      if (!map.has(source.toLowerCase())) map.set(source.toLowerCase(), targets[index]);
    });
  }
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return (text) => text;
  const pattern = new RegExp(`(?:${keys.map(escapeRegExp).join('|')})(?![A-Za-z0-9_.-])`, 'gi');
  return (text) => text.replace(pattern, (match) => map.get(match.toLowerCase()) ?? match);
}

// Copy one file through the rewriter in newline-bounded chunks, and keep its source times.
function copyRewritten(source: string, target: string, rewrite: (text: string) => string): FrozenSource {
  const hash = createHash('sha256');
  const input = fs.openSync(source, 'r');
  const output = fs.openSync(target, 'wx');
  const buffer = Buffer.alloc(CHUNK);
  let carry = Buffer.alloc(0);
  let bytes = 0;
  let frozenBytes = 0;
  const write = (chunk: Buffer) => {
    const text = Buffer.from(rewrite(chunk.toString('utf8')), 'utf8');
    fs.writeSync(output, text);
    frozenBytes += text.length;
  };
  try {
    for (;;) {
      const read = fs.readSync(input, buffer, 0, CHUNK, null);
      if (read === 0) break;
      bytes += read;
      hash.update(buffer.subarray(0, read));
      const pending = Buffer.concat([carry, buffer.subarray(0, read)]);
      const end = pending.lastIndexOf(0x0a);
      if (end < 0) {
        carry = pending;
        continue;
      }
      write(pending.subarray(0, end + 1));
      carry = Buffer.from(pending.subarray(end + 1));
    }
    if (carry.length) write(carry);
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
  const stat = fs.statSync(source);
  fs.utimesSync(target, stat.atime, stat.mtime);
  return { file: '', sha256: hash.digest('hex'), bytes, frozenBytes };
}

// Keep only the opening record of a rollout, which is all that discovery reads of another workspace's rollout.
function copyOpening(
  source: string,
  target: string,
  rewrite: (text: string) => string,
): { bytes: number; openingSha256: string } {
  const input = fs.openSync(source, 'r');
  const buffer = Buffer.alloc(CHUNK);
  let head = Buffer.alloc(0);
  try {
    for (;;) {
      const read = fs.readSync(input, buffer, 0, CHUNK, null);
      if (read === 0) break;
      head = Buffer.concat([head, buffer.subarray(0, read)]);
      const end = head.indexOf(0x0a);
      if (end >= 0) {
        head = head.subarray(0, end + 1);
        break;
      }
    }
  } finally {
    fs.closeSync(input);
  }
  fs.writeFileSync(target, rewrite(head.toString('utf8')), { flag: 'wx' });
  const stat = fs.statSync(source);
  fs.utimesSync(target, stat.atime, stat.mtime);
  return { bytes: stat.size, openingSha256: createHash('sha256').update(head).digest('hex') };
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out.push(file);
    }
  };
  walk(root);
  return out.sort();
}

// The project directories whose names can hold the workspace's sessions, the way discovery matches them.
export function workspaceProjectDirectories(projects: string, workspace: string): string[] {
  const slug = projectSlug(workspace).toLowerCase();
  return fs
    .readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower === slug || lower.startsWith(slug.endsWith('-') ? slug : `${slug}-`);
    })
    .sort();
}

// Select the newest settled Claude session in the workspace whose newest turn has a prompt and a summary.
export function selectSession(
  projects: string,
  workspace: string,
  now: number,
): { session: string; key: string; prompt: string; summary: string } | null {
  const candidates = workspaceProjectDirectories(projects, workspace)
    .flatMap((directory) =>
      fs
        .readdirSync(path.join(projects, directory))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(projects, directory, name)),
    )
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .filter((entry) => now - entry.mtimeMs >= SETTLED_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of candidates) {
    const cwd = readSessionCwd(file);
    if (!cwd || !isInside(cwd, [workspace])) continue;
    const session = path.basename(file, '.jsonl');
    const newest = readTurns(file, session).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (newest?.prompt.trim() && newest.summary.trim())
      return { session, key: turnKey(newest), prompt: newest.prompt, summary: newest.summary };
  }
  return null;
}

// Process output, supervision tokens, and write locks stay out of a fixture. Discovery reads none of them.
const DISPATCH_SKIPPED = /\.(log|lock|released)$/i;
const DISPATCH_PROCESS_FILES = new Set(['monitor.json', 'output-monitor.json', 'observation.json']);
const CREDENTIAL_KEY = /token|secret|password|credential|cookie|bearer|api[_-]?key|authorization/i;

export function holdsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsCredential);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, inner]) => CREDENTIAL_KEY.test(key) || holdsCredential(inner));
}

export interface DispatchFreeze {
  files: number;
  bytes: number;
  excluded: number;
  prefixes: number;
  cwds: string[];
  sources: FrozenSource[];
}

// Copy the dispatch receipt store through the path rewrite. A producer opening keeps its prefix length and digest
// in the rewritten transcript, and every receipt working directory inside the workspace exists in the fixture.
export function freezeDispatch(
  source: string,
  target: string,
  rewrite: (text: string) => string,
  workspace: string,
  frozenWorkspace: string,
): DispatchFreeze {
  refuseUnsafeSource(source);
  const result: DispatchFreeze = { files: 0, bytes: 0, excluded: 0, prefixes: 0, cwds: [], sources: [] };
  const cwds = new Set<string>();
  for (const file of filesUnder(source)) {
    const name = path.basename(file);
    const out = path.join(target, path.relative(source, file));
    if (DISPATCH_SKIPPED.test(name) || DISPATCH_PROCESS_FILES.has(name)) {
      result.excluded++;
      continue;
    }
    let content: Buffer | string = fs.readFileSync(file);
    if (/\.(json|md|txt)$/i.test(name)) {
      let text = content.toString('utf8');
      if (name.endsWith('.json')) {
        let value: Record<string, unknown> | null = null;
        try {
          value = JSON.parse(text) as Record<string, unknown>;
        } catch {
          value = null;
        }
        if (holdsCredential(value)) {
          result.excluded++;
          continue;
        }
        if (
          value &&
          typeof value.file === 'string' &&
          typeof value.bytes === 'number' &&
          typeof value.sha256 === 'string'
        ) {
          const opening = openingPrefix(value.file, value.bytes);
          if (opening !== null) {
            const rewritten = rewrite(opening);
            value.bytes = Buffer.byteLength(rewritten);
            value.sha256 = createHash('sha256').update(rewritten, 'utf8').digest('hex');
            text = JSON.stringify(value);
            result.prefixes++;
          }
        }
        const cwd = (value?.standalone as { cwd?: unknown } | undefined)?.cwd;
        if (typeof cwd === 'string' && isInside(cwd, [workspace]))
          cwds.add(path.join(frozenWorkspace, path.relative(workspace, cwd)));
      }
      content = rewrite(text);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, content, { flag: 'wx' });
    const stat = fs.statSync(file);
    fs.utimesSync(out, stat.atime, stat.mtime);
    result.files++;
    result.bytes += stat.size;
    result.sources.push({
      file: path.relative(path.dirname(path.dirname(target)), out),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      bytes: stat.size,
      frozenBytes: Buffer.byteLength(content),
    });
  }
  for (const cwd of cwds) fs.mkdirSync(cwd, { recursive: true });
  result.cwds = [...cwds].map((cwd) => path.relative(frozenWorkspace, cwd)).sort();
  return result;
}

function openingPrefix(file: string, bytes: number): string | null {
  try {
    const descriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(descriptor, buffer, 0, bytes, 0);
      return read === bytes ? buffer.toString('utf8') : null;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

// Bind a copied dispatch store to the identities of its own files. A copy gets new device and inode numbers, and the
// receipt reader refuses a receipt whose recorded identity differs, after fewer checks than an accepted receipt costs.
// `rewrite` moves transcript paths when the run reads its transcripts from another root.
export function rebindDispatch(
  root: string,
  rewrite?: (text: string) => string,
): { anchors: number; witnesses: number; openings: number } {
  const counts = { anchors: 0, witnesses: 0, openings: 0 };
  if (!fs.existsSync(root)) return counts;
  const identity = (file: string) => {
    const stat = fs.statSync(file, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  };
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file, 'utf8'), 'utf8').digest('hex');
  const update = (file: string, change: (value: Record<string, unknown>) => boolean) => {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!change(value)) return false;
    // Rewriting in place keeps the file's own identity, which other witnesses record.
    fs.writeFileSync(file, JSON.stringify(value));
    return true;
  };
  if (rewrite)
    for (const file of filesUnder(root).filter((name) => /\.(json|md|txt)$/i.test(name))) {
      const text = fs.readFileSync(file, 'utf8');
      const moved = rewrite(text);
      if (moved !== text) fs.writeFileSync(file, moved);
    }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const launches = entries
    .filter((entry) => entry.isDirectory() && DISPATCH_ID.test(entry.name))
    .map((entry) => entry.name);
  for (const id of launches) {
    for (const name of ['startup.json', 'source-candidate.json'])
      if (
        update(path.join(root, id, name), (value) => {
          if (typeof value.file !== 'string' || typeof value.ancestor !== 'string') return false;
          if (!fs.existsSync(value.file) || !fs.existsSync(value.ancestor)) return false;
          const file = identity(value.file);
          const ancestor = identity(value.ancestor);
          value.identity = `${file.dev}:${file.ino}`;
          value.directory = `${ancestor.dev}:${ancestor.ino}`;
          return true;
        })
      )
        counts.openings++;
    const baseline = path.join(root, `${id}.source-baseline.json`);
    if (fs.existsSync(baseline))
      update(path.join(root, id, 'source-baseline-witness.json'), (value) => {
        value.identity = identity(baseline);
        return true;
      });
  }
  for (const entry of entries) {
    const match = /^([a-f0-9-]{36})\.([a-z-]+)\.json$/.exec(entry.name);
    if (!entry.isFile() || !match || !DISPATCH_ID.test(match[1]) || match[2].endsWith('accepting')) continue;
    const target = path.join(root, match[1], `${match[2]}.json`);
    if (!fs.existsSync(target)) continue;
    if (
      update(path.join(root, entry.name), (value) => {
        if (!value.identity || typeof value.sha256 !== 'string') return false;
        value.identity = identity(target);
        value.sha256 = digest(target);
        return true;
      })
    )
      counts.witnesses++;
  }
  for (const id of launches) {
    const receipt = path.join(root, id, 'receipt.json');
    if (!fs.existsSync(receipt)) continue;
    if (
      update(path.join(root, `${id}.json`), (value) => {
        if (!value.directory || !value.receipt) return false;
        value.directory = identity(path.join(root, id));
        value.receipt = identity(receipt);
        value.sha256 = digest(receipt);
        return true;
      })
    )
      counts.anchors++;
  }
  return counts;
}

export function freezeCatalog(options: FreezeOptions): FreezeRecord {
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error(`The fixture directory already exists: ${output}`);
  const workspace = path.resolve(options.workspace);
  const frozenWorkspace = path.join(output, 'workspace');
  const frozenProjects = path.join(output, 'projects');
  const frozenCodex = path.join(output, 'codex');
  const directories = workspaceProjectDirectories(options.projects, workspace);
  for (const directory of directories) refuseUnsafeSource(path.join(options.projects, directory));
  refuseUnsafeSource(options.codex);
  const dispatch = options.store ? path.join(options.store, 'dispatch') : null;
  if (dispatch && fs.existsSync(dispatch)) refuseUnsafeSource(dispatch);
  const oldSlug = projectSlug(workspace);
  const newSlug = projectSlug(frozenWorkspace);
  const renamed = (directory: string) => newSlug + directory.slice(oldSlug.length);
  // A path into a project directory takes the directory's new name. The rewriter prefers the longest match.
  const rewrite = pathRewriter([
    [workspace, frozenWorkspace],
    ...directories.map((directory): [string, string] => [
      path.join(options.projects, directory),
      path.join(frozenProjects, renamed(directory)),
    ]),
    [options.projects, frozenProjects],
    [options.codex, frozenCodex],
  ]);
  for (const name of ['workspace', 'projects', 'codex', 'store'])
    fs.mkdirSync(path.join(output, name), { recursive: true });
  const record: FreezeRecord = {
    workspace,
    frozenAt: new Date(options.now ?? Date.now()).toISOString(),
    sources: [],
    reduced: [],
    placeholders: { files: 0, bytes: 0 },
    bytes: 0,
    frozenBytes: 0,
  };
  const keep = (source: string, relative: string, target: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const frozen = copyRewritten(source, target, rewrite);
    record.sources.push({ ...frozen, file: relative });
    record.bytes += frozen.bytes;
    record.frozenBytes += frozen.frozenBytes;
  };
  for (const directory of directories) {
    for (const file of filesUnder(path.join(options.projects, directory))) {
      const inner = path.relative(path.join(options.projects, directory), file);
      keep(file, path.join('projects', directory, inner), path.join(frozenProjects, renamed(directory), inner));
    }
  }
  for (const file of filesUnder(options.codex)) {
    const relative = path.relative(options.codex, file);
    const target = path.join(frozenCodex, relative);
    if (file.endsWith('.zst')) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '', { flag: 'wx' });
      const stat = fs.statSync(file);
      fs.utimesSync(target, stat.atime, stat.mtime);
      record.placeholders.files++;
      record.placeholders.bytes += stat.size;
      continue;
    }
    const cwd = file.endsWith('.jsonl') ? readCodexSessionMeta(file)?.cwd : null;
    if (!file.endsWith('.jsonl') || (cwd && isInside(cwd, [workspace]))) {
      keep(file, path.join('codex', relative), target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    record.reduced.push({ file: path.join('codex', relative), ...copyOpening(file, target, rewrite) });
  }
  if (dispatch && fs.existsSync(dispatch)) {
    const { sources, ...summary } = freezeDispatch(
      dispatch,
      path.join(output, 'store', 'dispatch'),
      rewrite,
      workspace,
      frozenWorkspace,
    );
    record.dispatch = summary;
    record.sources.push(...sources);
  }
  const selected = selectSession(frozenProjects, frozenWorkspace, options.now ?? Date.now());
  if (!selected) throw new Error('No settled workspace session has a newest turn with a prompt and a summary.');
  fs.writeFileSync(path.join(output, 'state.json'), JSON.stringify({ showing: selected.session }));
  const sources = JSON.stringify(record);
  fs.writeFileSync(path.join(output, 'sources.json'), sources);
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        workspace: 'workspace',
        projects: 'projects',
        codex: 'codex',
        store: 'store',
        state: 'state.json',
        expectedSelection: { key: selected.key, prompt: selected.prompt, summary: selected.summary },
        frozen: {
          at: record.frozenAt,
          sourcesSha256: createHash('sha256').update(sources).digest('hex'),
          files: record.sources.length,
          bytes: record.bytes,
          frozenBytes: record.frozenBytes,
          reducedBytes: record.reduced.reduce((sum, entry) => sum + entry.bytes, 0),
          reduced: record.reduced,
          placeholders: record.placeholders,
          dispatch: record.dispatch
            ? {
                files: record.dispatch.files,
                bytes: record.dispatch.bytes,
                excluded: record.dispatch.excluded,
                prefixes: record.dispatch.prefixes,
              }
            : null,
        },
      },
      null,
      2,
    ),
  );
  return record;
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const workspace = value('--workspace');
  if (!workspace) throw new Error('--workspace names the folder whose sessions the fixture freezes.');
  const date = value('--date') ?? new Date().toISOString().slice(0, 10);
  const output = value('--output') ?? path.join(arcHome(), 'measure', 'fixtures', date);
  const record = freezeCatalog({
    workspace,
    projects: projectsRoot(),
    codex: codexSessionsRoot(),
    store: arcHome(),
    output,
  });
  process.stdout.write(
    `${JSON.stringify({
      output,
      files: record.sources.length,
      bytes: record.bytes,
      frozenBytes: record.frozenBytes,
      reducedRollouts: record.reduced.length,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();
