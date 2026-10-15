import { performance } from 'node:perf_hooks';
import { RAIL_FILTER_QUERY_LIMIT } from '../../extension/src/domain/rail-filters.ts';
import { listingQueryError } from '../../extension/src/domain/session-query.ts';
import { SESSION_PAGE_ERRORS, type SessionPage } from '../../extension/src/sessionreads.ts';
import { requestWindow, SESSION_CURSOR } from '../../extension/src/sessionrequests.ts';

const OUTPUT_BYTES = 8 * 1024 * 1024;
const REPLY_BYTES = 64 * 1024;
const ROW_BYTES = 256;
type ObjectValue = Record<string, unknown>;
type RowRef = { page: number; row: number };
type TurnReply = ObjectValue & {
  version: 1;
  id: string;
  provider: 'claude' | 'codex';
  state: 'current' | 'stale' | 'unparsed';
  turns: unknown[];
  partial: boolean;
  readByteLimit: number;
  notes: string[];
};
type Observation = { generation: number; reply?: unknown; error?: string };
type Outcome = { row: number; status: 'completed' | 'skipped' | 'failed'; reason?: string; observations: number[] };
interface Dependencies {
  request: (
    method: 'sessions' | 'session',
    params: Parameters<typeof requestWindow>[1],
    window: string,
  ) => Promise<unknown>;
  now: () => number;
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((one) => typeof one === 'string');
}

function pageReply(value: unknown, limit: number): value is SessionPage {
  if (!object(value)) return false;
  return (
    value.version === 1 &&
    (value.requester === null || typeof value.requester === 'string') &&
    Array.isArray(value.sessions) &&
    value.sessions.length <= limit &&
    value.sessions.every(
      (row) =>
        object(row) &&
        typeof row.source === 'string' &&
        row.source.length > 0 &&
        row.source.length <= 256 &&
        (row.id === null || typeof row.id === 'string') &&
        ['claude', 'codex'].includes(row.provider as string) &&
        typeof row.ambiguous === 'boolean' &&
        strings(row.truncated),
    ) &&
    typeof value.complete === 'boolean' &&
    strings(value.notes) &&
    (value.next === null || (typeof value.next === 'string' && SESSION_CURSOR.test(value.next))) &&
    ['complete', 'incomplete', 'unavailable'].includes(value.coverage as string) &&
    ['current', 'stale'].includes(value.freshness as string) &&
    value.complete === (value.next === null && value.coverage === 'complete' && value.freshness === 'current') &&
    (value.coverage !== 'unavailable' || (value.sessions.length === 0 && value.next === null))
  );
}

function turnReply(value: unknown, turns: number): value is TurnReply {
  return (
    object(value) &&
    value.version === 1 &&
    (value.requester === null || typeof value.requester === 'string') &&
    typeof value.id === 'string' &&
    ['claude', 'codex'].includes(value.provider as string) &&
    ['current', 'stale', 'unparsed'].includes(value.state as string) &&
    Array.isArray(value.turns) &&
    value.turns.length <= turns &&
    value.turns.every(object) &&
    (value.state === 'current' || value.turns.length === 0) &&
    typeof value.partial === 'boolean' &&
    Number.isSafeInteger(value.readByteLimit) &&
    (value.readByteLimit as number) > 0 &&
    strings(value.notes)
  );
}

function failure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function retryable(message: string): boolean {
  return (
    message === SESSION_PAGE_ERRORS.catalog ||
    message === 'The selected Arc window did not answer in time.' ||
    message === 'The selected Arc window is unavailable.' ||
    message === 'Session reads are unavailable in this window.'
  );
}

export async function runCollect(
  args: string[],
  dependencies: Dependencies = { request: requestWindow, now: () => performance.now() },
): Promise<string> {
  const flags = new Map<string, string>();
  const bounds: Record<string, [number, number, number]> = {
    '--turns': [1, 20, 0],
    '--limit': [1, 128, 128],
    '--max-pages': [1, 64, 64],
    '--max-reads': [0, 32, 32],
    '--deadline-ms': [1, 60000, 60000],
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flags.has(flag) || !(Object.hasOwn(bounds, flag) || ['--window', '--query', '--json'].includes(flag)))
      throw new Error(`Unknown or repeated argument: ${flag}`);
    const value = flag === '--json' ? 'true' : args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    flags.set(flag, value);
  }
  const numbers: Record<string, number> = {};
  for (const [flag, [min, max, fallback]] of Object.entries(bounds)) {
    const value = flags.get(flag);
    const number = value === undefined ? fallback : /^[0-9]+$/.test(value) ? Number(value) : NaN;
    if (value !== undefined && (!Number.isSafeInteger(number) || number < min || number > max))
      throw new Error(`${flag} must be between ${min} and ${max}.`);
    numbers[flag] = number;
  }
  if (flags.has('--max-reads') && !flags.has('--turns')) throw new Error('--max-reads requires --turns.');
  const window = flags.get('--window') ?? process.env.ARC_WINDOW;
  if (!window) throw new Error('Select one Arc window with --window or ARC_WINDOW.');
  if (!/^[a-f0-9]{24}$/.test(window)) throw new Error('Invalid Arc window identifier.');
  const query = flags.get('--query');
  if (query !== undefined) {
    if (query.length > RAIL_FILTER_QUERY_LIMIT)
      throw new Error(`Filter queries accept at most ${RAIL_FILTER_QUERY_LIMIT} characters.`);
    const error = listingQueryError(query);
    if (error) throw new Error(error);
  }
  const turns = numbers['--turns'];
  const limit = numbers['--limit'];
  const maxPages = numbers['--max-pages'];
  const maxReads = numbers['--max-reads'];
  const deadlineMs = numbers['--deadline-ms'];
  const deadline = dependencies.now() + deadlineMs;
  const pages: Observation[] = [];
  const usablePages: number[] = [];
  const rows: RowRef[] = [];
  const reads: { row: number; reply?: unknown; error?: string }[] = [];
  const outcomes: Outcome[] = [];
  let charged = 16 * 1024;
  let generation = 0;
  let pageRequests = 0;
  let turnRequests = 0;
  let stop = 'page-limit';
  let ended = false;
  let cursor: string | undefined;
  let coverage: SessionPage['coverage'] | null = null;
  let freshness: SessionPage['freshness'] | null = null;
  const sources = new Set<string>();
  const cursors = new Set<string>();
  const admission = (reservation: number): string | null =>
    dependencies.now() >= deadline ? 'deadline' : charged + reservation > OUTPUT_BYTES ? 'output-limit' : null;
  const requestPage = async (): Promise<Observation> => {
    charged += REPLY_BYTES + 2048;
    try {
      const reply = await dependencies.request(
        'sessions',
        { limit, ...(query !== undefined && { query }), ...(cursor && { cursor }) },
        window,
      );
      if (Buffer.byteLength(JSON.stringify(reply)) > REPLY_BYTES)
        return { generation, error: 'The listing reply exceeds the response limit.' };
      return { generation, reply };
    } catch (error) {
      return { generation, error: failure(error) };
    }
  };
  let retry = false;
  while (pageRequests < maxPages) {
    const denied = admission(REPLY_BYTES + 2048 + limit * ROW_BYTES);
    if (denied) {
      stop = denied;
      break;
    }
    pageRequests++;
    const observation = await requestPage();
    const page = pages.push(observation) - 1;
    const message = observation.error;
    if (message) {
      if ((message === SESSION_PAGE_ERRORS.cursor || message === SESSION_PAGE_ERRORS.scope) && generation === 0) {
        generation++;
        usablePages.length = rows.length = 0;
        sources.clear();
        cursors.clear();
        cursor = undefined;
        coverage = freshness = null;
        retry = false;
        continue;
      }
      if (retryable(message) && !retry) {
        retry = true;
        continue;
      }
      stop = 'listing-failed';
      break;
    }
    if (!pageReply(observation.reply, limit)) {
      stop = 'malformed-listing';
      break;
    }
    const reply = observation.reply;
    if (reply.coverage === 'unavailable') {
      if (!retry) {
        retry = true;
        continue;
      }
      stop = 'catalog-unavailable';
      break;
    }
    retry = false;
    // A duplicate source cannot be reconciled with an earlier observation from this traversal.
    const pageSources = reply.sessions.map((row) => row.source);
    if (new Set(pageSources).size !== pageSources.length || pageSources.some((source) => sources.has(source))) {
      stop = 'duplicate-source';
      break;
    }
    usablePages.push(page);
    reply.sessions.forEach((row, index) => {
      sources.add(row.source);
      rows.push({ page, row: index });
      charged += ROW_BYTES;
    });
    coverage = reply.coverage;
    freshness = reply.freshness;
    if (reply.next === null) {
      ended = true;
      stop = 'end';
      break;
    }
    if (cursors.has(reply.next)) {
      stop = 'repeated-cursor';
      break;
    }
    cursors.add(reply.next);
    cursor = reply.next;
  }
  const selected = rows.map((ref) => (pages[ref.page].reply as SessionPage).sessions[ref.row]);
  const identities = new Map<string, number>();
  for (const row of selected) if (row.id !== null) identities.set(row.id, (identities.get(row.id) ?? 0) + 1);
  if (turns) {
    for (let row = 0; row < selected.length; row++)
      outcomes.push({ row, status: 'skipped', reason: 'read-limit', observations: [] });
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const index = next++;
        const row = selected[index];
        const outcome = outcomes[index];
        const reason =
          row.ambiguous || (row.id !== null && identities.get(row.id)! > 1)
            ? 'ambiguous-identity'
            : row.truncated.includes('id')
              ? 'truncated-identity'
              : row.id === null
                ? 'null-identity'
                : row.id.length === 0
                  ? 'empty-identity'
                  : row.id.length > 256
                    ? 'long-identity'
                    : null;
        if (reason) {
          outcome.reason = reason;
          continue;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const denied = turnRequests >= maxReads ? 'read-limit' : admission(REPLY_BYTES + 2048);
          if (denied) {
            outcome.reason = denied;
            break;
          }
          turnRequests++;
          charged += REPLY_BYTES + 2048;
          const observation: { row: number; reply?: unknown; error?: string } = { row: index };
          const at = reads.push(observation) - 1;
          outcome.observations.push(at);
          try {
            const reply = await dependencies.request('session', { sessionId: row.id!, turns }, window);
            if (Buffer.byteLength(JSON.stringify(reply)) > REPLY_BYTES)
              observation.error = 'The turn reply exceeds the response limit.';
            else observation.reply = reply;
          } catch (error) {
            observation.error = failure(error);
          }
          outcome.status = 'failed';
          if (observation.error) {
            outcome.reason = 'request-failed';
            if (retryable(observation.error) && attempt === 0) continue;
          } else if (!turnReply(observation.reply, turns)) outcome.reason = 'malformed-turns';
          else if (observation.reply.id !== row.id || observation.reply.provider !== row.provider)
            outcome.reason = 'identity-mismatch';
          else {
            outcome.status = 'completed';
            delete outcome.reason;
          }
          break;
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
  return JSON.stringify({
    version: 1,
    window,
    selection: { ...(query !== undefined && { query }), limit, turns: turns || null },
    limits: { maxPages, maxReads, concurrency: 2, outputBytes: OUTPUT_BYTES, deadlineMs },
    listing: { stop, ended, coverage, freshness, pageRequests, generation, usablePages },
    pages,
    rows,
    reads,
    outcomes,
    turnRequests,
  });
}
