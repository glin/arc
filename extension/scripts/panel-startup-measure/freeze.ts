// Freeze a workspace's transcript catalog into a measurement fixture for measure.ts.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
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
  // A compressed rollout records its fixture digest, and whether the fixture holds its source bytes or a rewritten
  // archive. One that does not decode, or that does not end at a zstd frame boundary, keeps
  // its source bytes.
  frozenSha256?: string;
  archive?: 'copied' | 'rewritten' | 'undecodable' | 'truncated';
}

export interface FreezeRecord {
  workspace: string;
  frozenAt: string;
  sources: FrozenSource[];
  // Rollouts outside the workspace keep only their opening record. Discovery reads no more of them.
  reduced: Array<{ file: string; bytes: number; openingSha256: string }>;
  // Compressed rollouts. `sources` holds each one. None is reduced.
  compressed: {
    files: number;
    bytes: number;
    frozenBytes: number;
    rewritten: number;
    undecodable: number;
    truncated: number;
  };
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

// fs.writeSync can accept fewer bytes than it was given, so write until the whole buffer is out.
function writeAll(descriptor: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('The fixture file accepted no bytes.');
    offset += written;
  }
}

function keepTimes(source: string, target: string): void {
  const stat = fs.statSync(source);
  fs.utimesSync(target, stat.atime, stat.mtime);
}

// Rewrite text in newline-bounded pieces, so that no path is split between two pieces.
function lineRewriter(rewrite: (text: string) => string) {
  let pending: Buffer[] = [];
  const state = { changed: false };
  const convert = (bytes: Buffer): Buffer => {
    const text = bytes.toString('utf8');
    const moved = rewrite(text);
    if (moved !== text) state.changed = true;
    return Buffer.from(moved, 'utf8');
  };
  return {
    state,
    push(chunk: Buffer): Buffer | null {
      const end = chunk.lastIndexOf(0x0a);
      if (end < 0) {
        pending.push(Buffer.from(chunk));
        return null;
      }
      const lines = Buffer.concat([...pending, chunk.subarray(0, end + 1)]);
      pending = [Buffer.from(chunk.subarray(end + 1))];
      return convert(lines);
    },
    flush(): Buffer | null {
      const rest = Buffer.concat(pending);
      pending = [];
      return rest.length ? convert(rest) : null;
    },
  };
}

// Copy one file through the rewriter, and keep its source times.
function copyRewritten(source: string, target: string, rewrite: (text: string) => string): FrozenSource {
  const hash = createHash('sha256');
  const lines = lineRewriter(rewrite);
  const buffer = Buffer.alloc(CHUNK);
  let bytes = 0;
  let frozenBytes = 0;
  const input = fs.openSync(source, 'r');
  try {
    const output = fs.openSync(target, 'wx');
    try {
      const write = (text: Buffer | null) => {
        if (!text) return;
        writeAll(output, text);
        frozenBytes += text.length;
      };
      for (;;) {
        const read = fs.readSync(input, buffer, 0, CHUNK, null);
        if (read === 0) break;
        bytes += read;
        hash.update(buffer.subarray(0, read));
        write(lines.push(buffer.subarray(0, read)));
      }
      write(lines.flush());
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
  keepTimes(source, target);
  return { file: '', sha256: hash.digest('hex'), bytes, frozenBytes };
}

// Copy one file byte for byte, and keep its source times.
function copyExact(source: string, target: string): FrozenSource {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK);
  let bytes = 0;
  const input = fs.openSync(source, 'r');
  try {
    const output = fs.openSync(target, 'wx');
    try {
      for (;;) {
        const read = fs.readSync(input, buffer, 0, CHUNK, null);
        if (read === 0) break;
        bytes += read;
        hash.update(buffer.subarray(0, read));
        writeAll(output, buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
  keepTimes(source, target);
  return { file: '', sha256: hash.digest('hex'), bytes, frozenBytes: bytes };
}

const zstd: {
  createZstdCompress?: (options: { params: Record<number, number> }) => Transform;
  createZstdDecompress?: () => Transform;
  constants: typeof zlib.constants & { ZSTD_c_compressionLevel?: number };
} = zlib;
// Codex writes its compressed rollouts at zstd level 3.
const CODEX_ZSTD_LEVEL = 3;

function zstdCodec() {
  const { createZstdCompress, createZstdDecompress } = zstd;
  const level = zstd.constants.ZSTD_c_compressionLevel;
  if (!createZstdCompress || !createZstdDecompress || level === undefined) return null;
  return { createZstdCompress, createZstdDecompress, level };
}

// Read the frame and block headers of a zstd stream without decoding it. The Node decoder ends without an error on a
// stream cut off inside a frame, so the freezer checks that the stream ends on a frame boundary.
function zstdFrames() {
  const ZSTD_MAGIC = 0xfd2fb528;
  const SKIPPABLE_MAGIC = 0x184d2a50;
  let state: 'magic' | 'skippable' | 'descriptor' | 'header' | 'block' | 'invalid' = 'magic';
  let need = 4;
  let held = Buffer.alloc(0);
  let skip = 0;
  let checksum = 0;
  let frames = 0;
  const take = (head: Buffer) => {
    if (state === 'magic') {
      const magic = head.readUInt32LE(0);
      if (magic === ZSTD_MAGIC) [state, need] = ['descriptor', 1];
      else if ((magic & 0xfffffff0) >>> 0 === SKIPPABLE_MAGIC) [state, need] = ['skippable', 4];
      else state = 'invalid';
    } else if (state === 'skippable') {
      [state, need, skip] = ['magic', 4, head.readUInt32LE(0)];
    } else if (state === 'descriptor') {
      const descriptor = head[0];
      const single = (descriptor >> 5) & 1;
      checksum = (descriptor >> 2) & 1 ? 4 : 0;
      const header = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + [single ? 1 : 0, 2, 4, 8][descriptor >> 6];
      [state, need] = header ? ['header', header] : ['block', 3];
    } else if (state === 'header') {
      [state, need] = ['block', 3];
    } else {
      const block = head[0] | (head[1] << 8) | (head[2] << 16);
      const type = (block >> 1) & 3;
      if (type === 3) {
        state = 'invalid';
        return;
      }
      skip = type === 1 ? 1 : block >>> 3;
      if (block & 1) {
        skip += checksum;
        [state, need] = ['magic', 4];
        frames++;
      }
    }
  };
  return {
    push(chunk: Buffer) {
      for (let at = 0; at < chunk.length;) {
        if (state === 'invalid') return;
        if (skip) {
          const step = Math.min(skip, chunk.length - at);
          skip -= step;
          at += step;
          continue;
        }
        const step = Math.min(need - held.length, chunk.length - at);
        held = Buffer.concat([held, chunk.subarray(at, at + step)]);
        at += step;
        if (held.length === need) {
          const head = held;
          held = Buffer.alloc(0);
          take(head);
        }
      }
    },
    complete: () => state === 'magic' && !held.length && !skip && frames > 0,
  };
}

// Decode a compressed rollout, rewrite its paths, and encode it again at the Codex level. A rollout that the rewrite
// leaves unchanged keeps its source bytes, and so does a rollout that does not decode or end at a zstd frame boundary.
async function copyCompressed(
  source: string,
  target: string,
  rewrite: (text: string) => string,
): Promise<FrozenSource> {
  const codec = zstdCodec();
  if (!codec) throw new Error(`This Node.js has no zstd, so the freezer cannot move the paths in ${source}.`);
  const { createZstdCompress, createZstdDecompress, level } = codec;
  const hash = createHash('sha256');
  const frozenHash = createHash('sha256');
  const lines = lineRewriter(rewrite);
  const frames = zstdFrames();
  let bytes = 0;
  let frozenBytes = 0;
  let undecodable = false;
  const output = fs.openSync(target, 'wx');
  try {
    await pipeline(
      fs.createReadStream(source, { highWaterMark: CHUNK }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          hash.update(chunk);
          frames.push(chunk);
          yield chunk;
        }
      },
      createZstdDecompress(),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          const text = lines.push(chunk);
          if (text) yield text;
        }
        const rest = lines.flush();
        if (rest) yield rest;
      },
      createZstdCompress({ params: { [level]: CODEX_ZSTD_LEVEL } }),
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) {
          writeAll(output, chunk);
          frozenHash.update(chunk);
          frozenBytes += chunk.length;
        }
      },
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !code.startsWith('ZSTD_')) throw error;
    undecodable = true;
  } finally {
    fs.closeSync(output);
  }
  const truncated = !undecodable && !frames.complete();
  if (undecodable || truncated || !lines.state.changed) {
    fs.rmSync(target);
    const copied = copyExact(source, target);
    const archive = undecodable ? 'undecodable' : truncated ? 'truncated' : 'copied';
    return { ...copied, frozenSha256: copied.sha256, archive };
  }
  keepTimes(source, target);
  return {
    file: '',
    sha256: hash.digest('hex'),
    bytes,
    frozenSha256: frozenHash.digest('hex'),
    frozenBytes,
    archive: 'rewritten',
  };
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
  keepTimes(source, target);
  return { bytes: fs.statSync(source).size, openingSha256: createHash('sha256').update(head).digest('hex') };
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

export async function freezeCatalog(options: FreezeOptions): Promise<FreezeRecord> {
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
  const codexFiles = filesUnder(options.codex);
  if (!zstdCodec() && codexFiles.some((file) => file.endsWith('.jsonl.zst')))
    throw new Error('This Node.js has no zstd, so the freezer cannot move the paths in the compressed rollouts.');
  for (const name of ['workspace', 'projects', 'codex', 'store'])
    fs.mkdirSync(path.join(output, name), { recursive: true });
  const record: FreezeRecord = {
    workspace,
    frozenAt: new Date(options.now ?? Date.now()).toISOString(),
    sources: [],
    reduced: [],
    compressed: { files: 0, bytes: 0, frozenBytes: 0, rewritten: 0, undecodable: 0, truncated: 0 },
    bytes: 0,
    frozenBytes: 0,
  };
  const keep = (frozen: FrozenSource, relative: string) => {
    record.sources.push({ ...frozen, file: relative });
    record.bytes += frozen.bytes;
    record.frozenBytes += frozen.frozenBytes;
  };
  for (const directory of directories) {
    for (const file of filesUnder(path.join(options.projects, directory))) {
      const inner = path.relative(path.join(options.projects, directory), file);
      const target = path.join(frozenProjects, renamed(directory), inner);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      keep(copyRewritten(file, target, rewrite), path.join('projects', directory, inner));
    }
  }
  for (const file of codexFiles) {
    const relative = path.relative(options.codex, file);
    const target = path.join(frozenCodex, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file.endsWith('.jsonl.zst')) {
      const frozen = await copyCompressed(file, target, rewrite);
      keep(frozen, path.join('codex', relative));
      record.compressed.files++;
      record.compressed.bytes += frozen.bytes;
      record.compressed.frozenBytes += frozen.frozenBytes;
      if (frozen.archive === 'rewritten') record.compressed.rewritten++;
      if (frozen.archive === 'undecodable') record.compressed.undecodable++;
      if (frozen.archive === 'truncated') record.compressed.truncated++;
      continue;
    }
    const cwd = file.endsWith('.jsonl') ? readCodexSessionMeta(file)?.cwd : null;
    if (!file.endsWith('.jsonl') || (cwd && isInside(cwd, [workspace]))) {
      keep(copyRewritten(file, target, rewrite), path.join('codex', relative));
      continue;
    }
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
          compressed: { ...record.compressed, rollouts: record.sources.filter((entry) => entry.archive) },
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const workspace = value('--workspace');
  if (!workspace) throw new Error('--workspace names the folder whose sessions the fixture freezes.');
  const date = value('--date') ?? new Date().toISOString().slice(0, 10);
  const output = value('--output') ?? path.join(arcHome(), 'measure', 'fixtures', date);
  const record = await freezeCatalog({
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
      compressedRollouts: record.compressed.files,
      compressedBytes: record.compressed.bytes,
      compressedFrozenBytes: record.compressed.frozenBytes,
      rewrittenRollouts: record.compressed.rewritten,
      undecodableRollouts: record.compressed.undecodable,
      truncatedRollouts: record.compressed.truncated,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename)
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
