// Browser-safe grammar and matching rules for session queries.

import { labelKey } from './labels.ts';

export type SessionField = 'session' | 'agent' | 'title' | 'labels' | 'cost' | 'cache-expiry' | 'status';

export interface DecimalValue {
  digits: string;
  exponent: number;
}

// Strict numeric comparisons shared by cost and cache-expiry query terms.
export interface NumericComparison {
  operator: '>' | '<';
  threshold: DecimalValue;
}

export interface SessionAxis {
  prefix: string;
  field: SessionField;
}

export interface FilterTerm {
  field: SessionField;
  needle: string;
  plain?: boolean;
  identities?: { any: Set<string>; claude: Set<string>; codex: Set<string> };
  invalid?: boolean;
  shorthand?: boolean;
  unresolved?: boolean;
  // A leading `-` excludes the sessions the plain term matches.
  negated?: boolean;
  // Present only when a cost or cache-expiry value follows the strict comparison grammar. An
  // absent comparison on either field keeps the value available for the visible correction.
  comparison?: NumericComparison;
}

export type SearchWhere = 'both' | 'prompt' | 'summary';

// `warm` and `active` are not turn states. `warm` asks about the session's prompt cache, which
// the caller answers with `cacheWarm` because the cache runs out on a clock this module does
// not hold. `active` asks whether the session sits inside its own recency window, which the
// caller answers with `active` for the same reason. `needsyou` asks for an active session that
// waits on the reader or is unread, so it reads the same `active` fact beside the turn state.
// `archived` and `agentrun` are not turn states either. Each asks about a fact the reader or the agent put on the session, which the
// caller carries on the session it hands in.
export type SessionStatus =
  | 'input'
  | 'unread'
  | 'read'
  | 'running'
  | 'warm'
  | 'active'
  | 'needsyou'
  | 'archived'
  | 'agentrun';

export interface SessionQuery {
  terms: FilterTerm[];
  find: string[];
  where: SearchWhere;
  unknownWhere: string[];
  // The whole word the reader wrote around an unknown `is:` value, mark and all, so a note
  // about it quotes what they typed rather than the part the parser read.
  unknownIs: string[];
}

export interface QueryToken {
  prefix: string;
  value: string;
  start: number;
  end: number;
}

interface QueryWord {
  text: string;
  start: number;
  end: number;
  quoted: boolean;
  // Whether the word opens on a quote. The negation mark is read off the first character the
  // reader wrote, so a word opening inside quotes carries its mark as text.
  quotedHead: boolean;
}

export const LABEL_PREFIX = 'label';
export const FIND_PREFIX = 'find';
export const WHERE_PREFIX = 'in';
export const WHERE_VALUES: SearchWhere[] = ['both', 'prompt', 'summary'];
export const WHERE_SYNONYMS: Record<string, SearchWhere> = {
  response: 'summary',
  answer: 'summary',
  reply: 'summary',
  ask: 'prompt',
  me: 'prompt',
};
export const IS_PREFIX = 'is';
export const IS_VALUES: SessionStatus[] = [
  'input',
  'unread',
  'read',
  'running',
  'warm',
  'active',
  'needsyou',
  'archived',
  'agentrun',
];
export const IS_SYNONYMS: Record<string, SessionStatus> = { waiting: 'input', blocked: 'input' };
export const SESSION_AXES: SessionAxis[] = [
  { prefix: 'id', field: 'session' },
  { prefix: 'session', field: 'session' },
  { prefix: 'agent', field: 'agent' },
  { prefix: 'title', field: 'title' },
  { prefix: LABEL_PREFIX, field: 'labels' },
  { prefix: 'cost', field: 'cost' },
  { prefix: 'cache-expiry', field: 'cache-expiry' },
  { prefix: IS_PREFIX, field: 'status' },
];

// The fields whose value follows the strict `>`/`<` comparison grammar `cost:` established.
export const NUMERIC_FIELDS: readonly SessionField[] = ['cost', 'cache-expiry'];

// The mark a reader writes in front of a term to ask for the sessions it drops.
export const NEGATE_MARK = '-';

const QUERY_SPACE = /\s/;
// The strict comparison grammar every numeric axis shares: one `>` or `<`, then a non-negative
// whole or decimal number, and nothing else.
const NUMERIC_COMPARISON_VALUE = /^(>|<)(\d+(?:\.\d+)?)$/;
const DECIMAL_VALUE = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

function decimalValue(raw: string): DecimalValue | null {
  const match = DECIMAL_VALUE.exec(raw);
  if (!match) {
    return null;
  }
  const fraction = match[2] ?? '';
  const writtenExponent = match[3] ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(writtenExponent)) {
    return null;
  }
  let digits = `${match[1]}${fraction}`.replace(/^0+/, '');
  if (!digits) {
    return { digits: '0', exponent: 0 };
  }
  let exponent = writtenExponent - fraction.length;
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return { digits, exponent };
}

function compareDecimals(left: DecimalValue, right: DecimalValue): -1 | 0 | 1 {
  if (left.digits === '0' || right.digits === '0') {
    return left.digits === right.digits ? 0 : left.digits === '0' ? -1 : 1;
  }
  const leftPlace = left.digits.length + left.exponent;
  const rightPlace = right.digits.length + right.exponent;
  if (leftPlace !== rightPlace) {
    return leftPlace < rightPlace ? -1 : 1;
  }
  const width = Math.max(left.digits.length, right.digits.length);
  const leftDigits = left.digits.padEnd(width, '0');
  const rightDigits = right.digits.padEnd(width, '0');
  return leftDigits === rightDigits ? 0 : leftDigits < rightDigits ? -1 : 1;
}

function queryWords(query: string): QueryWord[] {
  const words: QueryWord[] = [];
  let text = '';
  let start = -1;
  let quoted = false;
  let hadQuote = false;
  let quotedHead = false;
  const close = (at: number): void => {
    if (start !== -1) {
      words.push({ text, start, end: at, quoted: hadQuote, quotedHead });
    }
    text = '';
    start = -1;
    hadQuote = false;
    quotedHead = false;
  };
  for (let at = 0; at < query.length; at++) {
    const ch = query[at];
    if (!quoted && QUERY_SPACE.test(ch)) {
      close(at);
      continue;
    }
    if (start === -1) {
      start = at;
      quotedHead = ch === '"';
    }
    if (ch === '"') {
      hadQuote = true;
      if (quoted && query[at + 1] === '"') {
        text += '"';
        at++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    text += ch;
  }
  close(query.length);
  return words;
}

// Whether a rail status is one `is:running` matches. A session whose subagents still run has
// work in progress, and a session whose agent waits on a background command resumes by
// itself, so both count as running.
export function railStatusRuns(status: string | null | undefined): boolean {
  return status === 'running' || status === 'subagents' || status === 'background';
}

export function quoteQueryValue(value: string): string {
  if (!/[\s"]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function wordPrefix(text: string): string {
  const split = text.indexOf(':');
  return split > 0 ? text.slice(0, split).toLowerCase() : '';
}

// `find:` and `in:` set where a content search looks rather than adding a term, and there is
// nothing to negate about a direction, so a leading `-` on one stays part of the word.
function setsSearch(text: string): boolean {
  const prefix = wordPrefix(text);
  return prefix === FIND_PREFIX || prefix === WHERE_PREFIX;
}

function sessionSelector(word: QueryWord): FilterTerm | null {
  if (word.quotedHead) return null;
  const negated = !word.quotedHead && word.text.startsWith('-');
  const raw = negated ? word.text.slice(1) : word.text;
  const prefix = wordPrefix(raw);
  if (prefix !== 'session' && prefix !== 'id') return null;
  const value = raw.slice(raw.indexOf(':') + 1);
  const qualified = /^(claude|codex):(.+)$/i.exec(value);
  const provider = qualified ? (qualified[1].toLowerCase() as 'claude' | 'codex') : 'any';
  const id = qualified ? qualified[2] : value;
  const identities = { any: new Set<string>(), claude: new Set<string>(), codex: new Set<string>() };
  const invalid = !id || /[\s:/\\]/.test(id);
  if (!invalid) identities[provider].add(id);
  return {
    field: 'session',
    needle: value,
    identities,
    ...(prefix === 'id' ? { shorthand: true } : {}),
    ...(negated ? { negated: true } : {}),
    ...(invalid ? { invalid: true } : {}),
  };
}

function identityKey(term: FilterTerm): string {
  return JSON.stringify(
    ['any', 'claude', 'codex'].map((provider) =>
      [...(term.identities?.[provider as 'any' | 'claude' | 'codex'] ?? [])].sort(),
    ),
  );
}

export function sessionQueryError(query: string): string | null {
  return parseSessionQuery(query).terms.some((term) => term.invalid)
    ? 'Use session IDs or prefixes of at least eight characters. Join positive selectors with OR.'
    : null;
}

export function parseSessionQuery(query: string): SessionQuery {
  const out: SessionQuery = { terms: [], find: [], where: 'both', unknownWhere: [], unknownIs: [] };
  let searching = false;
  const words = queryWords(query);
  const selectors = words.map(sessionSelector);
  const consumed = new Set<number>();
  for (let at = 0; at < words.length; at++) {
    if (words[at].text !== 'OR' || words[at].quoted) continue;
    let left = at - 1;
    let right = at + 1;
    while (left >= 0 && words[left].text === 'OR' && !words[left].quoted) left--;
    while (right < words.length && words[right].text === 'OR' && !words[right].quoted) right++;
    if (!selectors[left] && !selectors[right]) continue;
    if (
      left !== at - 1 ||
      right !== at + 1 ||
      !selectors[left] ||
      !selectors[right] ||
      selectors[left]!.negated ||
      selectors[right]!.negated ||
      selectors[left]!.invalid ||
      selectors[right]!.invalid
    ) {
      out.terms.push({ field: 'session', needle: '', invalid: true });
      consumed.add(at);
      continue;
    }
    const first = selectors[left]!;
    const next = selectors[right]!;
    if (next.shorthand) first.shorthand = true;
    for (const provider of ['any', 'claude', 'codex'] as const) {
      for (const id of next.identities![provider]) first.identities![provider].add(id);
    }
    selectors[right] = first;
    consumed.add(left);
    consumed.add(at);
  }
  for (let index = 0; index < words.length; index++) {
    if (consumed.has(index)) continue;
    if (selectors[index]) {
      out.terms.push(selectors[index]!);
      continue;
    }
    const { text: written, quoted, quotedHead } = words[index];
    // A lone `-` names no term to exclude, so it adds nothing rather than asking for a title
    // holding a dash.
    if (!written || (!quotedHead && written === NEGATE_MARK)) {
      continue;
    }
    // Ignore unquoted words with two negation marks. Quote such text to search for it literally.
    if (!quotedHead && written.startsWith(NEGATE_MARK + NEGATE_MARK)) {
      continue;
    }
    // A quote before a leading `-` keeps the mark as text. `"-fix"` asks for a title holding
    // the hyphen, and `find: "-name"` searches for it. A mark outside the quotes still negates, so
    // `-label:"release 0.4"` drops that label.
    const negated = !quotedHead && written[0] === NEGATE_MARK && !setsSearch(written.slice(1));
    const raw = negated ? written.slice(1) : written;
    const mark = negated ? { negated: true as const } : {};
    const word = raw.toLowerCase();
    const split = raw.indexOf(':');
    const prefix = split > 0 ? raw.slice(0, split).toLowerCase() : '';
    const typed = split > 0 ? raw.slice(split + 1) : '';
    const value = typed.toLowerCase();
    if (prefix === FIND_PREFIX) {
      searching = true;
      if (value) {
        out.find.push(value);
      }
      continue;
    }
    if (prefix === WHERE_PREFIX) {
      // An own-property lookup keeps object prototype names from becoming query synonyms.
      const where =
        WHERE_VALUES.find((candidate) => candidate === value) ||
        (Object.prototype.hasOwnProperty.call(WHERE_SYNONYMS, value) ? WHERE_SYNONYMS[value] : undefined);
      if (where) {
        out.where = where;
      } else if (value) {
        out.unknownWhere.push(value);
      }
      continue;
    }
    if (prefix === IS_PREFIX) {
      const status =
        IS_VALUES.find((candidate) => candidate === value) ||
        (Object.prototype.hasOwnProperty.call(IS_SYNONYMS, value) ? IS_SYNONYMS[value] : undefined);
      if (status) {
        out.terms.push({ field: 'status', needle: status, ...mark });
      } else if (value) {
        out.unknownIs.push(written);
      }
      continue;
    }
    const axis = SESSION_AXES.find(
      (candidate) => candidate.prefix === prefix && !(quotedHead && candidate.field === 'session'),
    );
    if (axis) {
      if (NUMERIC_FIELDS.includes(axis.field)) {
        const match = quoted ? null : NUMERIC_COMPARISON_VALUE.exec(typed);
        const threshold = match ? decimalValue(match[2]) : null;
        out.terms.push({
          field: axis.field,
          needle: typed,
          ...mark,
          ...(match && threshold
            ? { comparison: { operator: match[1] as NumericComparison['operator'], threshold } }
            : {}),
        });
        continue;
      }
      // Label identity owns its locale fold, so label values stay exactly as typed here.
      if (typed) {
        out.terms.push({ field: axis.field, needle: axis.field === 'labels' ? typed : value, ...mark });
      }
      continue;
    }
    if (searching) {
      out.find.push(word);
    } else {
      out.terms.push({ field: 'title', needle: word, plain: true, ...mark });
    }
  }
  const implicit = out.terms.filter(
    (term) => term.field === 'session' && term.shorthand && !term.negated && !term.invalid,
  );
  if (implicit.length > 1) {
    const first = implicit[0];
    for (const next of implicit.slice(1)) {
      for (const provider of ['any', 'claude', 'codex'] as const)
        for (const id of next.identities![provider]) first.identities![provider].add(id);
    }
    out.terms = out.terms.filter((term) => !implicit.includes(term) || term === first);
  }
  return out;
}

export interface SessionQueryIdentity {
  sessionId: string;
  agent: string;
}

export interface SessionQueryContext {
  identities: readonly SessionQueryIdentity[];
  coverage: 'complete' | 'incomplete' | 'unavailable';
  scope: string;
  revision: string;
}

// Equal identities in the same order. The host reuses an identity list whose contents did not change.
export function sameSessionQueryIdentities(
  before: readonly SessionQueryIdentity[],
  after: readonly SessionQueryIdentity[],
): boolean {
  return (
    before === after ||
    (before.length === after.length &&
      after.every(
        (identity, index) => identity.sessionId === before[index].sessionId && identity.agent === before[index].agent,
      ))
  );
}

export function sameSessionQueryContext(before: SessionQueryContext, after: SessionQueryContext): boolean {
  return (
    before === after ||
    (before.scope === after.scope &&
      before.coverage === after.coverage &&
      before.revision === after.revision &&
      sameSessionQueryIdentities(before.identities, after.identities))
  );
}

const FULL_SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const prefixValue = (id: string): boolean => id.length >= 8 && !FULL_SESSION_ID.test(id);

// A caller without catalog identities cannot distinguish a long exact ID from a prefix.
export function sessionQueryNeedsShorthand(query: string): boolean {
  return parseSessionQuery(query).terms.some(
    (term) =>
      term.field === 'session' &&
      (term.shorthand || Object.values(term.identities ?? {}).some((ids) => [...ids].some(prefixValue))),
  );
}

const identityIndexes = new WeakMap<readonly SessionQueryIdentity[], Map<string, Set<string>>>();
const compiledQueries = new WeakMap<SessionQueryContext, Map<string, SessionQuery & { notes: string[] }>>();

// Resolve once against the complete scoped catalog before callers narrow their row pools.
export function resolveSessionQuery(query: string, context?: SessionQueryContext): SessionQuery & { notes: string[] } {
  const cached = context && compiledQueries.get(context)?.get(query);
  if (cached) return cached;
  const parsed = { ...parseSessionQuery(query), notes: [] as string[] };
  let index = context && identityIndexes.get(context.identities);
  if (context && !index) {
    index = new Map([
      ['claude', new Set<string>()],
      ['codex', new Set<string>()],
    ]);
    for (const identity of context.identities) index.get(identity.agent.toLowerCase())?.add(identity.sessionId);
    identityIndexes.set(context.identities, index);
  }
  for (const term of parsed.terms) {
    if (!term.identities || term.invalid) continue;
    const resolved = { any: new Set<string>(), claude: new Set<string>(), codex: new Set<string>() };
    for (const provider of ['any', 'claude', 'codex'] as const) {
      for (const id of term.identities[provider]) {
        const providers = provider === 'any' ? (['claude', 'codex'] as const) : [provider];
        const exact = providers.some((kind) => index?.get(kind)?.has(id));
        if (exact || !prefixValue(id) || (!context && !term.shorthand)) {
          resolved[provider].add(id);
          continue;
        }
        if (context?.coverage !== 'complete') {
          term.unresolved = true;
          parsed.notes.push(`${id}: session discovery is incomplete. Retry after it finishes.`);
          continue;
        }
        let count = 0;
        for (const kind of providers)
          for (const candidate of index?.get(kind) ?? []) {
            if (candidate.startsWith(id)) {
              resolved[kind].add(candidate);
              count++;
            }
          }
        if (count > 1) parsed.notes.push(`${id} matches ${count} sessions.`);
      }
    }
    term.identities = resolved;
  }
  if (context) {
    let cache = compiledQueries.get(context);
    if (!cache) {
      cache = new Map();
      compiledQueries.set(context, cache);
    }
    if (cache.size >= 64) cache.clear();
    cache.set(query, parsed);
  }
  return parsed;
}

export function sessionQueryResolutionError(query: string, context?: SessionQueryContext): string | null {
  const resolved = resolveSessionQuery(query, context);
  return resolved.terms.some((term) => term.unresolved)
    ? 'Session discovery is incomplete. Retry after it finishes.'
    : null;
}

export function queryToken(query: string, caret: number): QueryToken {
  const at = Math.max(0, Math.min(caret, query.length));
  for (const word of queryWords(query)) {
    if (at < word.start || at > word.end) {
      continue;
    }
    const split = word.text.indexOf(':');
    return {
      prefix: split > 0 ? word.text.slice(0, split).toLowerCase() : '',
      value: split > 0 ? word.text.slice(split + 1) : word.text,
      start: word.start,
      end: word.end,
    };
  }
  return { prefix: '', value: '', start: at, end: at };
}

// Every query word with the same decoded value and source bounds `queryToken` returns for one
// caret. A control that removes a visible term needs those bounds so it can preserve the other
// words exactly as the reader typed them without implementing the query grammar again.
export function queryTokens(query: string): QueryToken[] {
  return queryWords(query).map((word) => {
    const split = word.text.indexOf(':');
    return {
      prefix: split > 0 ? word.text.slice(0, split).toLowerCase() : '',
      value: split > 0 ? word.text.slice(split + 1) : word.text,
      start: word.start,
      end: word.end,
    };
  });
}

export function replaceToken(
  query: string,
  start: number,
  end: number,
  text: string,
): { query: string; caret: number } {
  const from = Math.max(0, Math.min(start, query.length));
  const to = Math.max(from, Math.min(end, query.length));
  return { query: query.slice(0, from) + text + query.slice(to), caret: from + text.length };
}

export function canStartSearch(query: string): boolean {
  const parsed = parseSessionQuery(query);
  return parsed.find.length === 0 && parsed.terms.some((term) => term.plain === true);
}

export function withWhere(query: string, where: SearchWhere): string {
  const kept = query
    .trim()
    .split(/\s+/)
    .filter((word) => word && word.toLowerCase().indexOf(WHERE_PREFIX + ':') !== 0);
  if (where !== 'both') {
    kept.push(WHERE_PREFIX + ':' + where);
  }
  return kept.join(' ');
}

export function isSearch(query: string): boolean {
  return parseSessionQuery(query).find.length > 0;
}

// Whether the plain term holds, before the reader's `-` is read.
function plainTermHolds(
  term: FilterTerm,
  agent: string,
  title: string,
  labels: readonly string[] | undefined,
  costDollars?: number | null,
  costAtLeast = false,
  status?: string | null,
  unread = false,
  cacheWarm = false,
  runByAgent: boolean | null = false,
  archived = false,
  active = false,
  // The exact count of cache-expiry returns from lifetime indexed facts. Null where the
  // source cannot answer, which holds for neither comparison the way an unpriced cost does.
  cacheExpiryCount: number | null = null,
  // True when unclassified adjacent pairs prevent an exact count.
  cacheExpiryAtLeast = false,
): boolean {
  if (term.field === 'cost' || term.field === 'cache-expiry') {
    const value = term.field === 'cost' ? costDollars : cacheExpiryCount;
    const atLeast = term.field === 'cost' ? costAtLeast : cacheExpiryAtLeast;
    if (!term.comparison || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return false;
    }
    const recorded = decimalValue(String(value));
    if (!recorded) {
      return false;
    }
    const compared = compareDecimals(recorded, term.comparison.threshold);
    if (term.comparison.operator === '>') {
      return compared > 0;
    }
    return !atLeast && compared < 0;
  }
  // Labels are selected names and match exactly after locale folding. Titles and agent
  // names are prose and retain substring matching.
  if (term.field === 'labels') {
    const wanted = labelKey(term.needle);
    return (labels ?? []).some((name) => labelKey(name) === wanted);
  }
  if (term.field === 'status') {
    if (term.needle === 'input') {
      return status === 'waiting';
    }
    if (term.needle === 'unread') {
      return unread;
    }
    if (term.needle === 'read') {
      return !unread;
    }
    // Warm cache matching is independent of archived state and agent-run ownership.
    if (term.needle === 'warm') {
      return cacheWarm;
    }
    // The reader's own filing, read whether or not the caller draws the Archived bucket.
    if (term.needle === 'archived') {
      return archived;
    }
    // The plain fact that an agent started this session. A card's own bucket flag gives way
    // to archiving, so the caller hands in the fact rather than the bucket.
    if (term.needle === 'agentrun') {
      return runByAgent === true;
    }
    // The reader's own recency window, answered by the caller against its own clock the same
    // way `warm` is above.
    if (term.needle === 'active') {
      return active;
    }
    // An active session that waits on the reader or that the reader has not read.
    if (term.needle === 'needsyou') {
      return active && (status === 'waiting' || unread);
    }
    return railStatusRuns(status);
  }
  return (term.field === 'agent' ? agent : title).toLowerCase().includes(term.needle);
}

// Whether one term holds for one session. A negated term answers the opposite of the plain
// one, and the reading is decided here rather than at each caller, so every path through the
// grammar reads a `-` the same way. A negated cost term therefore holds wherever the
// comparison does not, which includes a session with no recorded cost and a lower-bound
// total that has not yet crossed a `<` threshold. A negated cache-expiry term holds the same
// way for a session whose facts are unavailable and for a floor that has not crossed a `<`
// threshold.
export function sessionTermHolds(
  term: FilterTerm,
  agent: string,
  title: string,
  labels: readonly string[] | undefined,
  costDollars?: number | null,
  costAtLeast = false,
  status?: string | null,
  unread = false,
  cacheWarm = false,
  runByAgent: boolean | null = false,
  archived = false,
  active = false,
  cacheExpiryCount: number | null = null,
  cacheExpiryAtLeast = false,
  sessionId = '',
  readKnown = true,
): boolean {
  if (term.invalid || term.unresolved || (term.field === 'status' && term.needle === 'agentrun' && runByAgent === null))
    return false;
  if (!readKnown && term.field === 'status' && (term.needle === 'read' || term.needle === 'unread')) return false;
  if (!readKnown && term.field === 'status' && term.needle === 'needsyou' && active && status !== 'waiting')
    return false;
  if (term.field === 'session') {
    const identities = term.identities;
    const provider = agent.toLowerCase();
    const held =
      !!identities &&
      (identities.any.has(sessionId) ||
        ((provider === 'claude' || provider === 'codex') && identities[provider].has(sessionId)));
    return term.negated ? !held : held;
  }
  const held = plainTermHolds(
    term,
    agent,
    title,
    labels,
    costDollars,
    costAtLeast,
    status,
    unread,
    cacheWarm,
    runByAgent,
    archived,
    active,
    cacheExpiryCount,
    cacheExpiryAtLeast,
  );
  return term.negated === true ? !held : held;
}

// Whether two queries ask the same thing. A control that writes a query reads its own lens
// back off the box, and the reader can type the same words in another order, so the answer
// is over the parsed terms rather than the text.
export function sameQueryTerms(left: string, right: string): boolean {
  const key = (query: string): string => {
    const parsed = parseSessionQuery(query);
    const terms = parsed.terms
      .map(
        (term) =>
          `${term.negated === true ? NEGATE_MARK : ''}${term.field}:${term.field === 'session' ? identityKey(term) + Boolean(term.invalid) + Boolean(term.shorthand) : term.needle}`,
      )
      .sort();
    return JSON.stringify([terms, [...parsed.find].sort(), parsed.where]);
  };
  return key(left) === key(right);
}

// The agent-run fact that the panel files and counts by, and that `is:agentrun` reads in the panel.
// A pin or a label brings a non-archived agent run into the reader's own sessions, whatever its
// classification, for as long as one of them stays. Archived sessions keep the classification.
// Export and the CLI report the classification alone.
export function panelAgentRun(
  classified: boolean | null,
  archived: boolean,
  pinned: boolean,
  labelled: boolean,
): boolean | null {
  return classified !== false && !archived && (pinned || labelled) ? false : classified;
}

export function matchSessions<
  T extends {
    id?: string;
    sessionId?: string;
    label: string;
    // The card's own drawn name, where it differs from `label`. A free-text term matches
    // this rather than `label` where it is present, because the rail card can draw more of
    // the session's name than `label` carries, and a word visible on the card must never
    // fail to find the card that shows it.
    name?: string;
    agent: string;
    labels?: readonly string[];
    costDollars?: number | null;
    costAtLeast?: boolean;
    status?: string | null;
    unread?: boolean | null;
    // The caller supplies prompt-cache status using its own clock. Omission makes is:warm match nothing.
    cacheWarm?: boolean;
    // Whether an agent runs this session, which `is:agentrun` answers. A card's own bucket flag
    // turns this off when the session is archived, so the caller must hand in the plain fact.
    runByAgent?: boolean | null;
    // Whether the reader archived this session, which `is:archived` answers, whether or not
    // the caller's own Show-archived switch draws the session.
    archived?: boolean;
    // Whether this session sits inside its own recency window, answered by the caller against
    // its own clock. A caller that never asks about recency leaves it out, and `is:active`
    // then matches nothing, which is the answer for a list with no recency facts.
    active?: boolean;
    // The exact count of cache-expiry returns from lifetime indexed facts, read the same way
    // `costDollars` is: null where the source cannot answer, which matches neither comparison.
    cacheExpiryCount?: number | null;
    // Whether that count is a floor rather than the whole answer, read the same way
    // `costAtLeast` is.
    cacheExpiryAtLeast?: boolean;
  },
>(sessions: T[], query: string, context?: SessionQueryContext): T[] {
  const { terms } = resolveSessionQuery(query, context);
  // Invalid numeric comparisons match no session.
  if (terms.some((term) => (NUMERIC_FIELDS.includes(term.field) && !term.comparison) || term.invalid)) {
    return [];
  }
  if (!terms.length) {
    return sessions;
  }
  return sessions.filter((session) => {
    const holds = (term: FilterTerm): boolean =>
      sessionTermHolds(
        term,
        session.agent,
        session.name ?? session.label,
        session.labels,
        session.costDollars,
        session.costAtLeast === true,
        session.status,
        session.unread === true,
        session.cacheWarm === true,
        session.runByAgent === null ? null : session.runByAgent === true,
        session.archived === true,
        session.active === true,
        session.cacheExpiryCount ?? null,
        session.cacheExpiryAtLeast === true,
        session.sessionId ?? session.id ?? '',
        session.unread !== null,
      );
    return terms.every(holds);
  });
}

// Listing queries read only catalog identity and reader metadata.
export function listingQueryError(query: string): string | null {
  const error = sessionQueryError(query);
  if (error) return error;
  const parsed = parseSessionQuery(query);
  if (
    parsed.find.length ||
    parsed.unknownWhere.length ||
    parsed.unknownIs.length ||
    queryTokens(query).some((token) => ['find', 'in'].includes(token.prefix)) ||
    parsed.terms.some(
      (term) =>
        !['session', 'agent', 'title', 'labels', 'status'].includes(term.field) ||
        (term.field === 'status' && !['archived', 'agentrun'].includes(term.needle)),
    )
  )
    return 'This query needs the panel filter. Use arc filter QUERY.';
  return null;
}

export function listingTermHolds(
  term: FilterTerm,
  session: {
    sessionId: string;
    agent: string;
    title: string;
    labels: readonly string[];
    archived: boolean;
    agentRun: boolean | null;
  },
): boolean {
  if (term.field === 'status' && term.needle === 'agentrun' && session.agentRun === null) return false;
  return sessionTermHolds(
    term,
    session.agent,
    session.title,
    session.labels,
    null,
    false,
    null,
    false,
    false,
    session.agentRun === true,
    session.archived,
    false,
    null,
    false,
    session.sessionId,
  );
}
