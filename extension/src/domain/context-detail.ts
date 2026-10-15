export const CONTEXT_ROWS = 32;
export const CONTEXT_STRING = 256;
export const CONTEXT_REPLY_BYTES = 32_768;

export interface ContextIdentity {
  session: string;
  provider: 'claude' | 'codex';
  model: string;
  source: string;
  generation: number;
  request: number;
}

export interface ContextCategory {
  key: string;
  name: string;
  tokens: number;
  relationship: 'used';
}

const MESSAGE_FIELDS = [
  ['toolCallTokens', 'Tool calls'],
  ['toolResultTokens', 'Tool results'],
  ['attachmentTokens', 'Attachments'],
  ['assistantMessageTokens', 'Assistant messages'],
  ['userMessageTokens', 'User messages'],
  ['redirectedContextTokens', 'Redirected context'],
  ['unattributedTokens', 'Unattributed'],
] as const;

export interface ContextMessage {
  key: (typeof MESSAGE_FIELDS)[number][0];
  name: string;
  tokens: number;
}

export type ContextUnavailableReason = 'pending-tools' | 'awaiting-measurement';

export function contextUnavailableReason(value: unknown): value is ContextUnavailableReason {
  return value === 'pending-tools' || value === 'awaiting-measurement';
}

export interface ContextDetail extends ContextIdentity {
  status: 'loading' | 'available' | 'mismatch' | 'unavailable' | 'stale';
  capturedAt: number;
  measurement: 'provider-estimate' | 'local-estimate';
  basis?: 'request' | 'retained-estimate';
  reason?: ContextUnavailableReason;
  used: number | null;
  capacity: number | null;
  remaining: number | null;
  reserve: number | null;
  categories: ContextCategory[];
  messageBreakdown?: ContextMessage[];
}

export function contextString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CONTEXT_STRING * 2 && Array.from(value).length <= CONTEXT_STRING;
}

export function contextNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function contextIdentity(value: unknown): value is ContextIdentity {
  if (!value || typeof value !== 'object') return false;
  const row = value as ContextIdentity;
  return (
    contextString(row.session) &&
    !!row.session &&
    contextString(row.model) &&
    contextString(row.source) &&
    (row.provider === 'claude' || row.provider === 'codex') &&
    contextNumber(row.generation) &&
    contextNumber(row.request)
  );
}

export function unavailableContext(
  identity: ContextIdentity,
  status: ContextDetail['status'] = 'unavailable',
): ContextDetail {
  return {
    ...identity,
    status,
    capturedAt: Date.now(),
    measurement: 'provider-estimate',
    used: null,
    capacity: null,
    remaining: null,
    reserve: null,
    categories: [],
  };
}

export function normalizeContext(payload: unknown, identity: ContextIdentity, capturedAt = Date.now()): ContextDetail {
  if (identity.provider === 'codex') return normalizeCodexContext(payload, identity, capturedAt);
  const unavailable = unavailableContext(identity);
  if (!contextIdentity(identity) || identity.provider !== 'claude' || !payload || typeof payload !== 'object')
    return unavailable;
  const raw = payload as Record<string, unknown>;
  if (
    !contextNumber(raw.totalTokens) ||
    !contextNumber(raw.rawMaxTokens) ||
    raw.rawMaxTokens === 0 ||
    !contextString(raw.model) ||
    !Array.isArray(raw.categories) ||
    raw.categories.length > CONTEXT_ROWS
  )
    return unavailable;
  const categories: ContextCategory[] = [];
  const seen = new Set<string>();
  let remaining: number | null = null;
  let reserve: number | null = null;
  for (const value of raw.categories) {
    if (!value || typeof value !== 'object') return unavailable;
    const row = value as Record<string, unknown>;
    if (
      !contextString(row.name) ||
      !row.name.trim() ||
      !contextNumber(row.tokens) ||
      typeof row.kind !== 'string' ||
      !['used', 'free', 'buffer', 'deferred'].includes(row.kind)
    )
      return unavailable;
    const key = row.name;
    if (seen.has(key)) return unavailable;
    seen.add(key);
    if (row.kind === 'used') categories.push({ key, name: row.name, tokens: row.tokens, relationship: 'used' });
    if (row.kind === 'free') remaining = (remaining ?? 0) + row.tokens;
    if (row.kind === 'buffer') reserve = (reserve ?? 0) + row.tokens;
  }
  const sum = categories.reduce((total, row) => total + row.tokens, 0);
  if (
    !contextNumber(sum) ||
    (remaining !== null && !contextNumber(remaining)) ||
    (reserve !== null && !contextNumber(reserve))
  )
    return unavailable;
  categories.sort((a, b) => b.tokens - a.tokens);
  const messages = categories.find((row) => row.key === 'Messages');
  const breakdown = raw.messageBreakdown;
  let messageBreakdown: ContextMessage[] | undefined;
  if (messages && breakdown && typeof breakdown === 'object') {
    const fields = breakdown as Record<string, unknown>;
    const rows = MESSAGE_FIELDS.map(([key, name]) => ({ key, name, tokens: fields[key] }));
    const sum = rows.reduce((total, row) => total + (contextNumber(row.tokens) ? row.tokens : NaN), 0);
    if (contextNumber(sum) && sum === messages.tokens) messageBreakdown = rows as ContextMessage[];
  }
  return {
    ...identity,
    model: raw.model,
    capturedAt,
    measurement: 'provider-estimate',
    status: sum === raw.totalTokens ? 'available' : 'mismatch',
    used: raw.totalTokens,
    capacity: raw.rawMaxTokens,
    remaining,
    reserve,
    categories,
    ...(messageBreakdown ? { messageBreakdown } : {}),
  };
}

function normalizeCodexContext(payload: unknown, identity: ContextIdentity, capturedAt: number): ContextDetail {
  const unavailable = unavailableContext(identity);
  if (!contextIdentity(identity) || !payload || typeof payload !== 'object') return unavailable;
  const raw = payload as Record<string, unknown>;
  if (raw.kind === 'codex-context-unavailable') {
    if (
      raw.session !== identity.session ||
      !contextString(raw.model) ||
      !raw.model ||
      (identity.model && raw.model !== identity.model) ||
      !contextUnavailableReason(raw.reason)
    )
      return unavailable;
    return { ...unavailable, capturedAt, reason: raw.reason };
  }
  if (
    raw.kind !== 'codex-retained-context' ||
    !['request', 'retained-estimate'].includes(String(raw.basis)) ||
    raw.session !== identity.session ||
    !contextString(raw.model) ||
    !raw.model ||
    (identity.model && raw.model !== identity.model) ||
    !contextNumber(raw.used) ||
    !contextNumber(raw.capacity) ||
    !raw.capacity ||
    !Array.isArray(raw.categories) ||
    !raw.categories.length ||
    raw.categories.length > CONTEXT_ROWS
  )
    return unavailable;
  const detail: ContextDetail = {
    ...identity,
    model: raw.model,
    capturedAt,
    measurement: 'local-estimate',
    basis: raw.basis as 'request' | 'retained-estimate',
    status:
      raw.categories.reduce((total, row) => total + (row?.tokens ?? NaN), 0) === raw.used ? 'available' : 'mismatch',
    used: raw.used,
    capacity: raw.capacity,
    remaining: Math.max(0, raw.capacity - raw.used),
    reserve: null,
    categories: raw.categories.map((row) => ({
      key: row?.key,
      name: row?.name,
      tokens: row?.tokens,
      relationship: row?.relationship,
    })),
  };
  if (!validContextDetail(detail)) return unavailable;
  detail.categories.sort((a, b) => b.tokens - a.tokens);
  return detail;
}

export function validContextDetail(value: unknown): value is ContextDetail {
  if (!contextIdentity(value)) return false;
  const row = value as ContextDetail;
  if (
    !['loading', 'available', 'mismatch', 'unavailable', 'stale'].includes(row.status) ||
    (row.reason !== undefined &&
      (row.status !== 'unavailable' || row.provider !== 'codex' || !contextUnavailableReason(row.reason))) ||
    !contextNumber(row.capturedAt) ||
    !['provider-estimate', 'local-estimate'].includes(row.measurement) ||
    (row.measurement === 'local-estimate' && (row.provider !== 'codex' || row.reserve !== null)) ||
    (row.measurement === 'local-estimate' && !['request', 'retained-estimate'].includes(String(row.basis))) ||
    ![row.used, row.capacity, row.remaining, row.reserve].every((number) => number === null || contextNumber(number)) ||
    !Array.isArray(row.categories) ||
    row.categories.length > CONTEXT_ROWS
  )
    return false;
  const keys = new Set<string>();
  for (const category of row.categories) {
    if (
      !category ||
      !contextString(category.key) ||
      !contextString(category.name) ||
      !category.name.trim() ||
      !contextNumber(category.tokens) ||
      category.relationship !== 'used' ||
      keys.has(category.key)
    )
      return false;
    keys.add(category.key);
  }
  const measured = row.status === 'available' || row.status === 'mismatch';
  if (row.messageBreakdown !== undefined) {
    if (
      row.provider !== 'claude' ||
      !measured ||
      !Array.isArray(row.messageBreakdown) ||
      row.messageBreakdown.length !== MESSAGE_FIELDS.length
    )
      return false;
    const seen = new Set<string>();
    for (const message of row.messageBreakdown) {
      if (
        !message ||
        !MESSAGE_FIELDS.some(([key, name]) => message.key === key && message.name === name) ||
        !contextNumber(message.tokens) ||
        seen.has(message.key)
      )
        return false;
      seen.add(message.key);
    }
    const sum = row.messageBreakdown.reduce((total, message) => total + message.tokens, 0);
    if (!contextNumber(sum) || sum !== row.categories.find((category) => category.key === 'Messages')?.tokens)
      return false;
  }
  const sum = row.categories.reduce((total, category) => total + category.tokens, 0);
  if (
    measured &&
    (row.used === null || !row.capacity || !contextNumber(sum) || (row.status === 'available') !== (sum === row.used))
  )
    return false;
  if (!measured && (row.categories.length || row.used !== null || row.capacity !== null)) return false;
  return new TextEncoder().encode(JSON.stringify({ type: 'contextDetail', detail: row })).length <= CONTEXT_REPLY_BYTES;
}

export function contextShare(tokens: number, used: number): string {
  if (!used) return 'Unavailable';
  const value = (tokens / used) * 100;
  if (value > 0 && value < 0.01) return '<0.01%';
  return `${value.toFixed(value < 0.1 || value > 99.9 ? 2 : 1)}%`;
}

export class ContextDemand {
  private generation = 0;
  private held: { key: string; promise: Promise<ContextDetail>; current: () => boolean } | null = null;
  invalidate(): void {
    this.generation++;
    this.held = null;
  }
  read(
    identity: ContextIdentity,
    key: string,
    read: () => Promise<unknown>,
    current: () => boolean,
  ): Promise<ContextDetail> {
    if (this.held?.key === key && this.held.current()) return this.held.promise;
    const generation = ++this.generation;
    const promise = Promise.resolve()
      .then(read)
      .then((raw) => normalizeContext(raw, identity))
      .catch(() => unavailableContext(identity))
      .then((detail) => {
        if (generation !== this.generation) return unavailableContext(identity, 'stale');
        if (!current()) {
          this.held = null;
          return unavailableContext(identity, 'stale');
        }
        if (detail.status === 'unavailable') this.held = null;
        return detail;
      });
    this.held = { key, promise, current };
    return promise;
  }
}
