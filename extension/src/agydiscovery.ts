import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agyHasEncodedArgs, agyPrompt, parseAgyStep, type AgyStep } from './agyhistory';
import { ARC_IDENTITY } from './identity';
import { CONTENT_ANCHOR_BYTES, readStableRange } from './history';
import { revisionOf, supportedFileIdentity, type FileRevision, type SessionFile } from './transcript';

export const AGY_DISCOVERY_ROWS = 32;
export const AGY_DISCOVERY_BYTES = 128 * 1024;
const AGY_DISCOVERY_PASS_BYTES = 16 * 1024 * 1024;
const AGY_RECORD_BYTES = 1024 * 1024;
const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TRANSCRIPT = /^transcript(?:_full)?\.jsonl$/;

export function agyBrainRoot(): string {
  return (
    process.env[ARC_IDENTITY.environmentPrefix + 'AGY_BRAIN_ROOT'] ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
  );
}

export function agySessionId(file: string): string | null {
  const parts = file.replace(/\\/g, '/').split('/');
  const id = parts.at(-4);
  return TRANSCRIPT.test(parts.at(-1) ?? '') &&
    parts.at(-2) === 'logs' &&
    parts.at(-3) === '.system_generated' &&
    id &&
    NATIVE_ID.test(id)
    ? id
    : null;
}

export interface AgyLaunchIdentity {
  brain: string;
  sessionId: string;
  cwd: string;
}

export interface AgySessionFile extends SessionFile {
  agent: 'agy';
  agyOwnerRoot: string;
  agyFirstPrompt: string;
}

function location(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  if (platform === 'win32') {
    if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) return null;
    return path.win32.normalize(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
  return path.posix.isAbsolute(value) ? path.posix.normalize(value).replace(/\/$/, '') || '/' : null;
}

function ownerOf(value: unknown, roots: readonly string[], platform: NodeJS.Platform): string | null {
  const target = location(value, platform);
  if (target === null) return null;
  const matches = roots
    .flatMap((root) => {
      const base = location(root, platform);
      if (base === null || (target !== base && !target.startsWith(base === '/' ? base : base + '/'))) return [];
      return [{ root, base }];
    })
    .sort((a, b) => b.base.length - a.base.length);
  return matches[0]?.root ?? null;
}

interface Candidate {
  id: string;
  file: string;
  revision: FileRevision;
  offset: number;
  fragment: Buffer;
  opening: Buffer;
  anchor: Buffer;
  discarding: boolean;
  prompt: string;
  toolRoots: Set<string | null>;
  independentRoots: Set<string | null>;
  writeTarget: { target: string; root: string } | null;
  conflicting: boolean;
}

const FILE_TOOLS = new Set([
  'read_file',
  'view_file',
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
]);
const WRITE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

function observe(candidate: Candidate, row: AgyStep, roots: readonly string[], platform: NodeJS.Platform): void {
  if (row.type === 'USER_INPUT') candidate.prompt ||= agyPrompt(row.content).slice(0, 512);
  if (
    row.type === 'GENERIC' &&
    row.status === 'DONE' &&
    !row.error &&
    candidate.writeTarget &&
    /(?:^|\n)(?:Created file\.|Made 1 replacement |\[diff_block_start\])/.test(row.content)
  ) {
    const { target, root } = candidate.writeTarget;
    const completed = /^Made 1 replacement in (.+) starting at line \d+ \(\+\d+\/-\d+ lines\)\./m.exec(
      row.content,
    )?.[1];
    if (completed && location(completed, platform) !== target) {
      candidate.conflicting = true;
    } else {
      candidate.independentRoots.add(root);
    }
  }
  if (row.type === 'SYSTEM_MESSAGE') return;
  candidate.writeTarget = null;
  if (row.type !== 'PLANNER_RESPONSE') return;
  for (const { name, args } of row.calls) {
    if (name === 'run_command' && location(args.Cwd, platform) !== null)
      candidate.independentRoots.add(ownerOf(args.Cwd, roots, platform));
    const target = args.Path ?? args.TargetFile;
    const verifiedTarget = location(target, platform);
    if (!FILE_TOOLS.has(name) || verifiedTarget === null) continue;
    const owner = ownerOf(target, roots, platform);
    candidate.toolRoots.add(owner);
    if (owner && row.calls.length === 1 && WRITE_TOOLS.has(name))
      candidate.writeTarget = { target: verifiedTarget, root: owner };
  }
}

function transcriptIn(brain: string, id: string): Pick<Candidate, 'file' | 'revision'> | null {
  let directory = brain;
  for (const name of [id, '.system_generated', 'logs']) {
    directory = path.join(directory, name);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return null;
  }
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (stat?.isFile()) return { file, revision: revisionOf(stat) };
  }
  return null;
}

export function findAgyTranscript(brain: string, id: string): string | null {
  if (!NATIVE_ID.test(id)) return null;
  try {
    if (!fs.lstatSync(brain).isDirectory()) return null;
    return transcriptIn(brain, id)?.file ?? null;
  } catch {
    return null;
  }
}

function admit(
  item: Candidate,
  brain: string,
  roots: readonly string[],
  launches: readonly AgyLaunchIdentity[],
  platform: NodeJS.Platform,
): AgySessionFile | null {
  if (!item.prompt || item.conflicting) return null;
  const matching = launches.filter(
    (entry) =>
      entry.sessionId.toLowerCase() === item.id.toLowerCase() &&
      location(entry.brain, platform) === location(brain, platform),
  );
  const directories = new Map(matching.map((entry) => [location(entry.cwd, platform), entry.cwd]));
  const cwd = directories.size === 1 ? [...directories.values()][0] : undefined;
  const verified = cwd ? ownerOf(cwd, roots, platform) : null;
  const toolRoot = [...item.independentRoots][0];
  const corroborated =
    toolRoot && item.independentRoots.size === 1 && [...item.toolRoots].every((root) => root === toolRoot);
  const ownerRoot = matching.length ? verified : corroborated ? toolRoot : null;
  return ownerRoot
    ? {
        agent: 'agy',
        file: item.file,
        sessionId: item.id,
        agyOwnerRoot: ownerRoot,
        agyFirstPrompt: item.prompt,
        ...item.revision,
        ...(cwd ? { cwd } : {}),
      }
    : null;
}

export function omitAgyCollisions<T extends SessionFile>(
  rows: readonly T[],
  existing: readonly SessionFile[],
  reserved: readonly string[] = [],
): T[] {
  const occupied = new Set([...existing.map(({ sessionId }) => sessionId), ...reserved].map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  for (const { sessionId } of rows) {
    const key = sessionId.toLowerCase();
    if (seen.has(key)) occupied.add(key);
    seen.add(key);
  }
  return rows.filter(({ sessionId }) => !occupied.has(sessionId.toLowerCase()));
}

export function agyCollisionWith(existing: readonly SessionFile[]): (row: SessionFile) => boolean {
  const occupied = new Set(existing.map(({ sessionId }) => sessionId.toLowerCase()));
  return (row) => row.agent === 'agy' && occupied.has(row.sessionId.toLowerCase());
}

interface DiscoveryEntry {
  scope: string;
  item: Candidate;
  row: AgySessionFile | null;
  settled: boolean;
}

export type AgyDiscoveryCache = Map<string, DiscoveryEntry>;

export interface AgyDiscoveryResult {
  rows: AgySessionFile[];
  complete: boolean;
  uncertain: ReadonlySet<string>;
}

function sameRevision(left: FileRevision, right: FileRevision): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function copyCandidate(item: Candidate): Candidate {
  return { ...item, toolRoots: new Set(item.toolRoots), independentRoots: new Set(item.independentRoots) };
}

// Each advance charges directory entries and transcript lines to the row budget.
export function* scanAgySessions(
  brain: string,
  roots: readonly string[],
  launches: readonly AgyLaunchIdentity[] = [],
  options: {
    rows?: number;
    bytes?: number;
    passBytes?: number;
    platform?: NodeJS.Platform;
    cache?: AgyDiscoveryCache;
  } = {},
): Generator<{ rows: number; bytes: number }, AgyDiscoveryResult, void> {
  const empty = { rows: [], complete: true, uncertain: new Set<string>() };
  if (!roots.length) return empty;
  const platform = options.platform ?? process.platform;
  const scope = JSON.stringify([platform, roots, launches]);
  const rowBudget = Math.max(1, options.rows ?? AGY_DISCOVERY_ROWS);
  const byteBudget = Math.max(1, options.bytes ?? AGY_DISCOVERY_BYTES);
  const anchorBytes = Math.min(CONTENT_ANCHOR_BYTES, byteBudget);
  const passBudget = Math.max(byteBudget, 2 * anchorBytes + 1, options.passBytes ?? AGY_DISCOVERY_PASS_BYTES);
  const cache = options.cache ?? new Map<string, DiscoveryEntry>();
  const settled = new Set<string>();
  const uncertain = new Set<string>();
  let walkedDirectory = false;
  let unread = false;
  let rows = 0;
  let bytes = 0;
  let spent = 0;

  function* verify(item: Candidate, revision: FileRevision): Generator<{ rows: number; bytes: number }, boolean> {
    for (const [start, saved] of [
      [0, item.opening],
      [item.offset - item.anchor.length, item.anchor],
    ] as const) {
      if (!saved.length) continue;
      if (bytes + saved.length > byteBudget) {
        yield { rows, bytes };
        rows = bytes = 0;
      }
      spent += saved.length;
      bytes += saved.length;
      const actual = readStableRange(item.file, start, saved.length, revision);
      if (!actual?.equals(saved)) return false;
    }
    return true;
  }

  try {
    if (!fs.lstatSync(brain, { throwIfNoEntry: false })?.isDirectory()) {
      cache.clear();
      return empty;
    }
    const directory = fs.opendirSync(brain, { bufferSize: 1 });
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++rows >= rowBudget) {
          yield { rows, bytes };
          rows = bytes = 0;
        }
        if (!entry.isDirectory() || !NATIVE_ID.test(entry.name)) continue;
        const id = entry.name;
        let source: ReturnType<typeof transcriptIn>;
        try {
          source = transcriptIn(brain, id);
        } catch {
          uncertain.add(id);
          continue;
        }
        if (!source) {
          cache.delete(id);
          settled.add(id);
          continue;
        }
        const previous = cache.get(id);
        const cached = previous?.scope === scope ? previous : undefined;
        const held = cached?.item;
        const unchanged = held?.file === source.file && sameRevision(source.revision, held.revision);
        if (unchanged && cached?.settled) {
          settled.add(id);
          continue;
        }
        let item: Candidate = {
          ...source,
          id,
          offset: 0,
          fragment: Buffer.alloc(0),
          opening: Buffer.alloc(0),
          anchor: Buffer.alloc(0),
          discarding: false,
          prompt: '',
          toolRoots: new Set(),
          independentRoots: new Set(),
          writeTarget: null,
          conflicting: false,
        };
        if (unchanged && held) {
          item = copyCandidate(held);
        } else if (
          held?.file === source.file &&
          supportedFileIdentity(held.revision) &&
          held.revision.dev === source.revision.dev &&
          held.revision.ino === source.revision.ino &&
          held.revision.size < source.revision.size
        ) {
          if (spent + held.opening.length + held.anchor.length >= passBudget) {
            unread = true;
            break;
          }
          if (yield* verify(held, source.revision)) item = { ...copyCandidate(held), ...source };
        }

        const encodedArgs = agyHasEncodedArgs(item.file);
        while (item.offset < item.revision.size && spent < passBudget) {
          if (bytes >= byteBudget) {
            yield { rows, bytes };
            rows = bytes = 0;
          }
          const length = Math.min(item.revision.size - item.offset, byteBudget - bytes, passBudget - spent);
          bytes += length;
          spent += length;
          const chunk = readStableRange(item.file, item.offset, length, item.revision);
          if (!chunk) break;
          if (!item.offset) item.opening = Buffer.from(chunk.subarray(0, anchorBytes));
          item.anchor = Buffer.from(
            chunk.length >= anchorBytes
              ? chunk.subarray(-anchorBytes)
              : Buffer.concat([item.anchor, chunk]).subarray(-anchorBytes),
          );
          item.offset += length;
          const content = item.fragment.length ? Buffer.concat([item.fragment, chunk]) : chunk;
          let start = 0;
          for (let end = content.indexOf(10); end >= 0; end = content.indexOf(10, start)) {
            const step =
              !item.discarding && end - start <= AGY_RECORD_BYTES
                ? parseAgyStep(content.toString('utf8', start, end), encodedArgs)
                : null;
            if (step) observe(item, step, roots, platform);
            else if (item.discarding || end > start) item.conflicting = true;
            item.discarding = false;
            start = end + 1;
            if (++rows >= rowBudget) {
              yield { rows, bytes };
              rows = bytes = 0;
            }
          }
          item.discarding ||= content.length - start > AGY_RECORD_BYTES;
          item.fragment = item.discarding ? Buffer.alloc(0) : Buffer.from(content.subarray(start));
          if (bytes >= byteBudget) {
            yield { rows, bytes };
            rows = bytes = 0;
          }
        }
        const pending = { scope, item, row: cached?.row ?? null, settled: false };
        cache.set(id, pending);
        if (item.offset < item.revision.size) {
          uncertain.add(id);
          if (spent >= passBudget) break;
          continue;
        }

        // A complete final JSON object counts even before a newline arrives. Its evidence enters the cursor at the newline.
        const final = item.fragment.length ? parseAgyStep(item.fragment.toString('utf8'), encodedArgs) : null;
        let current: ReturnType<typeof transcriptIn>;
        try {
          current = transcriptIn(brain, id);
        } catch {
          uncertain.add(id);
          continue;
        }
        if (
          !current ||
          current.file !== item.file ||
          !sameRevision(current.revision, item.revision) ||
          (item.fragment.length && !final && !item.conflicting)
        ) {
          uncertain.add(id);
          continue;
        }
        const complete = final ? copyCandidate(item) : item;
        if (final) {
          observe(complete, final, roots, platform);
          if (++rows >= rowBudget) {
            yield { rows, bytes };
            rows = bytes = 0;
          }
        }
        const row = complete.discarding ? null : admit(complete, brain, roots, launches, platform);
        cache.set(id, { scope, item, row, settled: true });
        settled.add(id);
      }
      // The last candidate can land exactly on the pass limit. Reuse its checked revision on the next walk.
      walkedDirectory = spent < passBudget;
    } finally {
      directory.closeSync();
    }
  } catch {
    unread = true;
  }
  const found: AgySessionFile[] = [];
  for (const [id, entry] of cache) {
    if (entry.scope !== scope || (walkedDirectory && !unread && !settled.has(id) && !uncertain.has(id))) {
      cache.delete(id);
      continue;
    }
    if (!settled.has(id)) uncertain.add(id);
    if (entry.row) found.push(entry.row);
  }
  return { rows: found, complete: walkedDirectory && !unread && uncertain.size === 0, uncertain };
}
