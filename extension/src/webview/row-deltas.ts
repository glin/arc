// Session rows travel to a panel as changes against the rows that panel already holds.
// The host keeps one RowDeltaSender for each panel, and the panel keeps one RowDeltaReceiver.
// A render or session list message carries its changed rows, an order edit when the order moved, and removed figure ids.
// The receiver rebuilds the complete lists, so message handlers read the same rows a complete message carries.
// Selection messages replace rows in the panel's drawn state only. The next render replaces all three drawn lists.
// The next session list message replaces the drawn `rail` and `stats`.

export interface RowOrderEdit {
  // Ids kept from the start and the end of the held order. `ids` replaces the ids between them.
  head: number;
  tail: number;
  ids: string[];
}

export interface RowDeltaHeader {
  // This message's place in the sequence the host posts to one panel.
  revision: number;
  // The revision this message extends. Null marks a snapshot, whose `rail` and `stats` are complete.
  base: number | null;
  // Present when the message carries `sessions`: the revision of the last message that carried them. Null marks complete `sessions`.
  sessionsBase?: number | null;
  sessionOrder?: RowOrderEdit;
  railOrder?: RowOrderEdit;
  // Sessions whose `stats` entry no longer exists.
  statsRemoved?: string[];
}

interface Row {
  id: string;
}

// Why the sender forgot the rows a panel holds. The next message after a reset is a snapshot.
export type RowResetReason = 'ready' | 'unready' | 'gap' | 'unaccepted' | 'failed' | 'unkeyedRows' | 'repeatedIds';

// What one encoded message carried. `reason` names why a snapshot went out, or null for a delta.
export interface RowEncoding {
  whole: boolean;
  reason: string | null;
  // Rows the message describes, and rows it had to carry.
  rowsHeld: number;
  rowsSent: number;
}

export interface RowLists {
  sessions?: readonly Row[];
  rail: readonly Row[];
  stats: Readonly<Record<string, unknown>>;
}

// A 64-bit hash of the value's JSON text and the text length. Two different rows share a print with negligible probability.
// The sender keeps prints rather than the text, so its memory stays small for every listed session.
export function rowPrint(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(36)}.${(first >>> 0).toString(36)}.${text.length}`;
}

// The shortest edit that keeps a common start and end of the held order. Returns undefined when the order did not move.
export function rowOrderEdit(before: readonly string[], after: readonly string[]): RowOrderEdit | undefined {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head++;
  if (head === before.length && head === after.length) return undefined;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { head, tail, ids: after.slice(head, after.length - tail) };
}

function keyedRows(rows: unknown): boolean {
  return Array.isArray(rows) && rows.every((row) => isRecord(row) && typeof row.id === 'string');
}

// Only keyed rows and a figure record can travel as a delta.
function encodable(message: RowLists): boolean {
  return (
    (message.sessions === undefined || keyedRows(message.sessions)) &&
    keyedRows(message.rail) &&
    isRecord(message.stats)
  );
}

function repeatsIds(rows: readonly Row[] | undefined): boolean {
  return rows !== undefined && new Set(rows.map((row) => row.id)).size !== rows.length;
}

interface SentList {
  order: string[];
  prints: Map<string, string>;
}

function sendList<T extends Row>(
  rows: readonly T[],
  held: SentList | null,
  whole: boolean,
): { changed: readonly T[]; order: RowOrderEdit | undefined; next: SentList } {
  const prints = new Map<string, string>();
  const changed: T[] = [];
  for (const row of rows) {
    const print = rowPrint(row);
    prints.set(row.id, print);
    if (!whole && held?.prints.get(row.id) !== print) changed.push(row);
  }
  const ids = rows.map((row) => row.id);
  const order = whole || !held ? undefined : rowOrderEdit(held.order, ids);
  return {
    changed: whole ? rows : changed,
    order,
    next: { order: ids, prints },
  };
}

// Every sender takes revisions from one counter, so a panel never sees one revision twice, even from a new sender.
let lastRevision = 0;

// Host side of one panel's row sequence. Reset it whenever the panel may hold other rows, so the next message is a snapshot.
export class RowDeltaSender {
  // The revision of the last message posted to the panel.
  private revision: number | null = null;
  private sessions: (SentList & { revision: number }) | null = null;
  private rail: SentList | null = null;
  private stats: Map<string, string> | null = null;
  // Prints of the inputs every row depends on, by name. A change sends a snapshot.
  private readonly globals = new Map<string, string>();
  private resetReason: RowResetReason | null = null;
  // What the last call to `encode` carried.
  lastEncoding: RowEncoding | null = null;

  reset(reason: RowResetReason): void {
    this.revision = null;
    this.sessions = null;
    this.rail = null;
    this.stats = null;
    this.globals.clear();
    this.resetReason = reason;
  }

  // A message whose lists are not keyed rows posts unchanged, and the next message is a snapshot.
  encode<M extends RowLists>(message: M, globals: Readonly<Record<string, unknown>>): M & { rows?: RowDeltaHeader } {
    if (!encodable(message)) {
      this.reset('unkeyedRows');
      this.lastEncoding = { whole: true, reason: 'unkeyedRows', rowsHeld: 0, rowsSent: 0 };
      return message;
    }
    let movedGlobal: string | null = null;
    for (const [name, value] of Object.entries(globals)) {
      const print = JSON.stringify(value) ?? '';
      if (this.globals.get(name) !== print) movedGlobal ??= name;
      this.globals.set(name, print);
    }
    const moved = movedGlobal !== null;
    const repeated = repeatsIds(message.sessions) || repeatsIds(message.rail);
    const fresh = this.revision === null || !this.rail || !this.stats;
    const whole = moved || repeated || fresh;
    const wholeReason = fresh
      ? this.resetReason
        ? `reset:${this.resetReason}`
        : 'first'
      : moved
        ? `globalMoved:${movedGlobal}`
        : repeated
          ? 'repeatedIds'
          : null;
    this.resetReason = null;
    const revision = ++lastRevision;
    const header: RowDeltaHeader = {
      revision,
      base: whole ? null : this.revision,
    };
    const out: Record<string, unknown> = {
      ...(message as object),
      rows: header,
    };
    let rowsHeld = message.rail.length;
    let rowsSent = 0;
    if (message.sessions) {
      // A session list message leaves `sessions` out, so `sessions` extend the last message that carried them.
      const held = whole ? null : this.sessions;
      const sessions = sendList(message.sessions, held, !held);
      out.sessions = sessions.changed;
      header.sessionsBase = held ? held.revision : null;
      if (sessions.order) header.sessionOrder = sessions.order;
      this.sessions = { ...sessions.next, revision };
      rowsHeld += message.sessions.length;
      rowsSent += sessions.changed.length;
    }
    const rail = sendList(message.rail, this.rail, whole);
    out.rail = rail.changed;
    rowsSent += rail.changed.length;
    if (rail.order) header.railOrder = rail.order;
    this.rail = rail.next;
    const prints = new Map<string, string>();
    const stats: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(message.stats)) {
      const print = rowPrint(value);
      prints.set(id, print);
      if (whole || this.stats?.get(id) !== print) stats[id] = value;
    }
    const removed = whole || !this.stats ? [] : [...this.stats.keys()].filter((id) => !prints.has(id));
    if (removed.length) header.statsRemoved = removed;
    out.stats = stats;
    this.stats = prints;
    this.revision = revision;
    this.lastEncoding = { whole, reason: wholeReason, rowsHeld, rowsSent };
    // Rows with a repeated id cannot be addressed by id, so the next message is a snapshot too.
    if (repeated) this.reset('repeatedIds');
    return out as unknown as M & { rows: RowDeltaHeader };
  }
}

interface HeldList {
  order: string[];
  rows: Map<string, Row>;
}

function holdList(rows: readonly Row[]): HeldList {
  return {
    order: rows.map((row) => row.id),
    rows: new Map(rows.map((row) => [row.id, row])),
  };
}

function mergeList(held: HeldList, changed: readonly Row[], edit: RowOrderEdit | undefined): Row[] | null {
  if (edit && edit.head + edit.tail > held.order.length) return null;
  const order = edit
    ? [...held.order.slice(0, edit.head), ...edit.ids, ...held.order.slice(held.order.length - edit.tail)]
    : held.order;
  const replacements = new Map(changed.map((row) => [row.id, row]));
  const rows: Row[] = [];
  for (const id of order) {
    const row = replacements.get(id) ?? held.rows.get(id);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

// Panel side of the row sequence. A delta that does not extend the held rows is lost, and the panel asks for a snapshot.
export class RowDeltaReceiver {
  private revision: number | null = null;
  private sessions: HeldList | null = null;
  // The revision of the last message that carried the held `sessions`.
  private sessionsRevision: number | null = null;
  private rail: HeldList | null = null;
  private stats: Record<string, unknown> = {};
  // True from a loss until the next snapshot, so one loss asks for one snapshot.
  private waiting = false;

  // `onGap` asks the host for a snapshot.
  constructor(private readonly onGap: () => void = () => {}) {}

  // Returns the message with complete lists, or null when the message cannot apply to the held rows.
  // A message without a header is complete and starts no sequence.
  expand<M extends RowLists & { rows?: RowDeltaHeader }>(message: M): M | null {
    const header = message.rows;
    const railWhole = !header || header.base === null;
    if (!railWhole && (header.base !== this.revision || !this.rail)) return this.lose();
    let sessions: readonly Row[] | undefined;
    let sessionsWhole = true;
    if (message.sessions) {
      sessionsWhole = !header || header.sessionsBase === null;
      if (sessionsWhole) {
        sessions = message.sessions;
      } else if (header?.sessionsBase !== this.sessionsRevision || !this.sessions) {
        return this.lose();
      } else {
        const merged = mergeList(this.sessions, message.sessions, header?.sessionOrder);
        if (!merged) return this.lose();
        sessions = merged;
      }
    }
    const rail = railWhole || !this.rail ? message.rail : mergeList(this.rail, message.rail, header.railOrder);
    if (!rail) return this.lose();
    const stats = railWhole ? { ...message.stats } : { ...this.stats, ...message.stats };
    for (const id of railWhole ? [] : (header.statsRemoved ?? [])) delete stats[id];
    const revision = header ? header.revision : null;
    if (sessions) {
      this.sessions = holdList(sessions);
      this.sessionsRevision = revision;
    }
    this.rail = holdList(rail);
    this.stats = stats;
    this.revision = revision;
    if (railWhole) this.waiting = false;
    if (railWhole && sessionsWhole) return message;
    return {
      ...message,
      ...(sessions ? { sessions } : {}),
      rail,
      stats: { ...stats },
    };
  }

  private lose(): null {
    this.revision = null;
    this.sessions = null;
    this.sessionsRevision = null;
    this.rail = null;
    this.stats = {};
    if (!this.waiting) {
      this.waiting = true;
      this.onGap();
    }
    return null;
  }
}

// Apply a selection message to the panel's drawn rows. Rows for `replaces` ids leave unless `changed` carries them.
export function replaceRows<T extends { id: string }>(
  held: readonly T[],
  changed: readonly T[],
  replaces: readonly string[],
): T[] {
  const replacements = new Map(changed.map((row) => [row.id, row]));
  const heldIds = new Set(held.map((row) => row.id));
  const replaced = new Set(replaces);
  return [
    ...changed.filter((row) => !heldIds.has(row.id)),
    ...held.flatMap((row) => {
      const replacement = replacements.get(row.id);
      return replacement ? [replacement] : replaced.has(row.id) ? [] : [row];
    }),
  ];
}

// Apply a selection message to the panel's drawn figures.
export function replaceStats<T>(
  held: Readonly<Record<string, T>>,
  changed: Readonly<Record<string, T>>,
  replaces: readonly string[],
): Record<string, T> {
  const next = { ...held };
  for (const id of replaces) {
    delete next[id];
  }
  return Object.assign(next, changed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIds(value: unknown): boolean {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

function orderEditOf(value: unknown): boolean {
  return value === undefined || (isRecord(value) && isCount(value.head) && isCount(value.tail) && isIds(value.ids));
}

// Accept an absent header or a well-formed one.
export function rowDeltaHeaderValid(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.revision) &&
    (value.base === null || Number.isSafeInteger(value.base)) &&
    (value.sessionsBase === undefined || value.sessionsBase === null || Number.isSafeInteger(value.sessionsBase)) &&
    orderEditOf(value.sessionOrder) &&
    orderEditOf(value.railOrder) &&
    (value.statsRemoved === undefined || isIds(value.statsRemoved))
  );
}
