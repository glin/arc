// extension/src/payload.ts
//
// What the extension posts to the panel, built where a test can weigh it.
//
// The render and rail messages were assembled inline in `panelhost.ts`, which imports
// `vscode` and therefore has no test. A field could grow by a megabyte and nothing in the
// repository would notice. `panelfixture.ts` builds a payload of its own for the browser
// tests, so it cannot see host-side growth either: it never calls what the host calls.
//
// Everything here is a projection over values the host already holds. No file is read and
// no clock is asked. The host still decides what goes in; this module decides the shape and
// is the one place a byte ceiling can be asserted against the real thing.

import type { SavedView } from './domain/views.ts';
import type { SavedRailFilter } from './domain/rail-filters.ts';
import {
  SessionStatChip,
  type CacheExpiryCountFact,
  type SessionContextDetail,
  type SessionCostTotal,
} from './turncard';
import { LabelCount, labelCounts } from './turnlabels';
import { RailCacheMark, RailCard, UnsentInput, railSessions, sessionStatsOf } from './turnrail';
import { NewCount } from './turnread';
import type { RailStatus } from './view/rail.ts';
import { timelineLayout } from './view/timeline-layout.ts';

// One session as the rail order left it. This is the row shape `railSessions` reads,
// named here so a caller cannot drift from it silently.
export interface PayloadSessionRow {
  id: string;
  persisted: boolean;
  label: string;
  // The rail card's own drawn name, cut to 200 characters. The rail has no maximum width,
  // and 200 characters fills a rail of about 1,300px at the panel's own type size, far wider
  // than a normal rail. Present only where it differs from `label`. `railSessions` reads it
  // for the one card it builds per row; every other reader of this row (the popover heading,
  // the composer target, the loading message) keeps reading `label`, the shorter form they
  // all share.
  railName?: string;
  agent: string;
  when: string;
  at: number;
  relative: string;
  agentRun?: boolean;
}

export interface RailPayloadInput {
  sessions: readonly PayloadSessionRow[];
  counts: ReadonlyMap<string, NewCount>;
  newest: ReadonlyMap<string, number>;
  statuses: ReadonlyMap<string, RailStatus>;
  runningSince: ReadonlyMap<string, number>;
  // The live open-child counts by session, which word a `subagents` card.
  openChildren: ReadonlyMap<string, number>;
  // The live background command counts by session, which word a `background` card.
  backgroundCommands: ReadonlyMap<string, number>;
  hidden: ReadonlySet<string>;
  showing: string | null;
  pinnedTop: ReadonlySet<string>;
  unsent: ReadonlyMap<string, UnsentInput>;
  // The three stat sources the heading and the rail card share. Kept apart rather than
  // merged by the caller, because which one wins per metric is a tested rule in
  // `sessionStatsOf` and a caller merging them first would be a second copy of it.
  parsedStats: Readonly<Record<string, readonly SessionStatChip[]>>;
  metadataStats: Readonly<Record<string, readonly SessionStatChip[]>>;
  lifetimeStats: Readonly<Record<string, readonly SessionStatChip[]>>;
  lifetimeContextDetails?: Readonly<Record<string, SessionContextDetail>>;
  // The recorded total is independent from its visible chip. Exact zero omits the chip but
  // still answers a cost comparison, while a missing total answers neither comparison.
  lifetimeCosts: Readonly<Record<string, SessionCostTotal>>;
  // The exact cache-expiry return count `cache-expiry:` matches on, independent from the
  // session heading's chip, paired with whether that count is a floor. Null or absent where the
  // source cannot answer, which answers neither comparison the way a missing cost does. Optional
  // so a caller that predates this axis need not supply it; `railSessions` treats an absent
  // record as empty.
  lifetimeCacheExpiry?: Readonly<Record<string, CacheExpiryCountFact | null>>;
  labels: Readonly<Record<string, readonly string[]>>;
  caches: Readonly<Record<string, RailCacheMark | null>>;
  // The views the reader saved under a name. Carried here rather than added by each
  // sender, because it joins the print that decides whether a rail post is worth making: a
  // view saved in one host moves no card, and a post that skipped on unmoved cards would
  // leave a second host listing the views the reader had before.
  views: readonly SavedView[];
  railFilters: readonly SavedRailFilter[];
  // The clock the wording reads. A running session's start names its day once that day is
  // over, so the same rows word a different rail after midnight.
  now: number;
}

export interface RailPayload {
  rail: RailCard[];
  stats: Record<string, SessionStatChip[]>;
  labels: LabelCount[];
  views: readonly SavedView[];
  railFilters: readonly SavedRailFilter[];
}

// What a rail post compares before it words the rail. Small inputs are printed. The stat
// records and the session rows are compared by identity, because printing them would cost
// what the wording costs. Their read-only types keep the host from editing one in place. The
// clock is printed as the local day it falls on, which is all of it the wording reads.
export interface RailInputKey {
  readonly held: readonly unknown[];
  readonly print: string;
}

// Every input, named, so an input added to the rail cannot be left out of the comparison.
const RAIL_INPUT_HOLDS: { readonly [Field in keyof Required<RailPayloadInput>]: 'print' | 'same' | 'each' | 'day' } = {
  sessions: 'each',
  counts: 'print',
  newest: 'print',
  statuses: 'print',
  runningSince: 'print',
  openChildren: 'print',
  backgroundCommands: 'print',
  hidden: 'print',
  showing: 'print',
  pinnedTop: 'print',
  unsent: 'print',
  parsedStats: 'print',
  metadataStats: 'same',
  lifetimeStats: 'same',
  lifetimeContextDetails: 'same',
  lifetimeCosts: 'same',
  lifetimeCacheExpiry: 'same',
  labels: 'print',
  caches: 'print',
  views: 'print',
  railFilters: 'print',
  now: 'day',
};

// The local calendar day and the zone offset, which decide how a time of day is worded.
export function railWordingDay(now: number): string {
  const date = new Date(now);
  return `${date.toDateString()} ${date.getTimezoneOffset()}`;
}

function printable(value: unknown): unknown {
  if (value instanceof Map || value instanceof Set) {
    return [...value];
  }
  return value ?? null;
}

export function railInputKey(input: RailPayloadInput): RailInputKey {
  const held: unknown[] = [];
  const printed: unknown[] = [];
  for (const field of Object.keys(RAIL_INPUT_HOLDS) as (keyof RailPayloadInput)[]) {
    const value = input[field];
    const hold = RAIL_INPUT_HOLDS[field];
    if (hold === 'same') {
      held.push(value);
    } else if (hold === 'day') {
      printed.push(railWordingDay(value as number));
    } else if (hold === 'each') {
      const items = value as readonly unknown[];
      held.push(items.length);
      for (const item of items) {
        held.push(item);
      }
    } else {
      printed.push(printable(value));
    }
  }
  return { held, print: JSON.stringify(printed) };
}

export function sameRailInputs(before: RailInputKey | null, now: RailInputKey): boolean {
  return (
    before !== null &&
    before.print === now.print &&
    before.held.length === now.held.length &&
    before.held.every((value, at) => value === now.held[at])
  );
}

// The five values the `rail` message carries, and the same five the `render` message
// embeds. One function, so a field added to one arrives in the other, and one print, so
// the two senders cannot disagree about whether anything moved.
export function railPayload(input: RailPayloadInput): RailPayload {
  const stats = sessionStatsOf(
    input.parsedStats,
    input.metadataStats,
    input.lifetimeStats,
    input.lifetimeContextDetails,
  );
  const rail = railSessions(
    [...input.sessions],
    input.counts,
    input.newest,
    input.statuses,
    input.hidden,
    input.showing,
    input.pinnedTop,
    input.unsent,
    stats,
    input.labels,
    input.caches,
    input.lifetimeCosts,
    input.runningSince,
    input.now,
    input.openChildren,
    input.backgroundCommands,
    input.lifetimeCacheExpiry,
  );
  // Only the selected session opens stat popovers. Other sessions retain their native tooltip text.
  const headingStats = Object.fromEntries(
    Object.entries(stats).map(([id, chips]) => [
      id,
      id === input.showing ? chips : chips.map(({ detailList: _detailList, ...chip }) => chip),
    ]),
  );
  return {
    rail,
    stats: headingStats,
    labels: labelCounts(input.labels),
    views: input.views,
    railFilters: input.railFilters,
  };
}

export interface RenderPayloadInput {
  rail: RailPayload;
  // Which sessions are hidden, as the extension holds them.
  //
  // Sent rather than left to each webview's own copy, because the cut it drives is made in
  // the host, before the parse, and its result reaches every host. A webview keeping only
  // what its own reader told it would draw the other host's hidden session as simply
  // absent: no footer saying how many are away, no way to bring one back, and, when it was
  // the last one, the message about empty transcripts rather than the one saying a filter
  // is why. Worse, its next hide would post a set that never knew about the first and
  // quietly bring that session back.
  hidden: ReadonlySet<string>;
  // The pinned-to-top set travels the same way and for the same reason: the cut it
  // stretches is made in the host, and every host has to agree about it.
  pinnedTop: ReadonlySet<string>;
  // The reader's notes, held in the host and sent down rather than kept by each webview. A
  // webview that kept its own would overwrite the other's on its next save.
  comments: readonly object[];
  sessions: readonly object[];
  showing: string | null;
  sessionAdoptions: readonly { provisional: string; durable: string }[];
  maxSessions: number;
  // The sentinel at the end of the list: whether an older page can be asked for, and what
  // the control that asks says. Decided in a tested module rather than in the panel,
  // because the panel is the file with no tests and the boundaries of this are exactly
  // where it would go wrong.
  olderHistory: unknown;
  projectSpend: unknown;
  // An empty panel is otherwise indistinguishable from a broken one, so the panel is sent
  // the explanation itself, already worded.
  diagnosis: unknown;
  // The reader's Timeline layout settings, read on every render so a change reaches the panel
  // on the next one.
  timelineLayout: unknown;
}

// Everything that is the same wherever the panel is drawn. Built once, whether one host
// is open or both: parsing is the expensive half and it must not be paid per host. The two
// values that differ per host, the theme font and the themed cards, are added by the
// caller, because both reach a webview as addresses that webview alone may load.
export function renderPayload(input: RenderPayloadInput): Record<string, unknown> {
  return {
    type: 'render',
    hidden: [...input.hidden],
    pinnedTop: [...input.pinnedTop],
    comments: input.comments,
    sessions: input.sessions,
    // The rail's cards: which sessions, what is new in each, and what every button is
    // announced by. Sent rather than worked out in the panel, and re-sent alone when the
    // read set moves.
    rail: input.rail.rail,
    // Every label the workspace has, with how many sessions carry each. The filter box
    // offers them while the reader types a `label:` term. Sent with the first draw as well
    // as with every later rail, or the box would offer nothing until something else moved
    // the rail.
    labels: input.rail.labels,
    // The views the reader saved under a name. The extension owns the list, so it is sent
    // with the first draw as well as with every later rail, or a panel opened in a second
    // window would draw no views until the reader made one.
    views: input.rail.views,
    // Saved rail filters use a separate list because they narrow every section without
    // creating or claiming one. The extension owns this list and sends it on the same cadence.
    railFilters: input.rail.railFilters,
    showing: input.showing,
    sessionAdoptions: input.sessionAdoptions,
    maxSessions: input.maxSessions,
    olderHistory: input.olderHistory,
    // The panel's foot: what each agent says the reader's account has left, and what the
    // composer is aimed at. Replaced per host, because the age on a figure is worked out
    // when it is drawn, and because a render can change which session the composer
    // names.
    usage: null,
    projectSpend: input.projectSpend,
    diagnosis: input.diagnosis,
    timelineLayout: timelineLayout(input.timelineLayout),
  };
}

// A selection keeps the workspace-owned state from the last render. It replaces only the
// values whose answer can move when the reader chooses another session.
export interface SelectionPayloadInput {
  rail: RailPayload;
  sessions: readonly object[];
  showing: string | null;
  previousShowing: string | null;
  olderHistory: unknown;
  diagnosis: unknown;
}

export function selectionPayload(input: SelectionPayloadInput): Record<string, unknown> {
  const changed = new Set([input.showing, input.previousShowing].filter((id): id is string => typeof id === 'string'));
  return {
    type: 'selection',
    replaces: [...changed],
    sessions: input.sessions.filter((row) => changed.has((row as { id?: string }).id ?? '')),
    rail: input.rail.rail.filter((row) => changed.has(row.id)),
    stats: Object.fromEntries(Object.entries(input.rail.stats).filter(([id]) => changed.has(id))),
    showing: input.showing,
    olderHistory: input.olderHistory,
    diagnosis: input.diagnosis,
  };
}

// How many bytes each top-level field of a message costs, and which fields cost the most.
//
// Read by the payload guard and by the host's budget warning. Measured per field rather
// than as one total, because a total says a message grew and names nothing to look at.
export interface FieldBytes {
  field: string;
  bytes: number;
}

export function messageFieldBytes(message: unknown, excludedFields: ReadonlySet<string> = new Set()): FieldBytes[] {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return [];
  }
  const out: FieldBytes[] = [];
  for (const [field, value] of Object.entries(message as Record<string, unknown>)) {
    if (excludedFields.has(field)) {
      continue;
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      text = undefined;
    }
    out.push({ field, bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8') });
  }
  return out.sort((left, right) => right.bytes - left.bytes || left.field.localeCompare(right.field));
}

// Every string of `minimumLength` characters or more that the message holds more than once,
// with how many times it appears and what repeating it costs.
//
// A long string sent twice is the shape this payload grew into: one tooltip is encoded both
// as joined text and as a list of the same lines, and a session label rides both its rail
// card and its session row. Neither is visible in a total, and both are obvious here.
export interface DuplicateString {
  text: string;
  count: number;
  // What the repeats cost: the string's bytes times one less than the number of copies.
  wastedBytes: number;
}

export const DUPLICATE_CENSUS_MINIMUM = 48;

export function duplicateStrings(message: unknown, minimumLength = DUPLICATE_CENSUS_MINIMUM): DuplicateString[] {
  const counts = new Map<string, number>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length >= minimumLength) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // A repeated key is not a repeated value. Object keys are counted nowhere, because
        // a field name is the schema and cannot be cut without changing the contract.
        void key;
        walk(item);
      }
    }
  };
  walk(message);
  const out: DuplicateString[] = [];
  for (const [text, count] of counts) {
    if (count < 2) {
      continue;
    }
    out.push({
      text,
      count,
      wastedBytes: Buffer.byteLength(JSON.stringify(text), 'utf8') * (count - 1),
    });
  }
  return out.sort((left, right) => right.wastedBytes - left.wastedBytes);
}

export function totalWastedBytes(duplicates: readonly DuplicateString[]): number {
  return duplicates.reduce((sum, entry) => sum + entry.wastedBytes, 0);
}

// The bytes the largest rail card costs. The rail is the field that grows with the corpus
// rather than with what is on screen, so the largest row decides whether a single rich
// session can cross the budget while smaller rows hide it.
export function railRowBytes(rail: readonly unknown[]): number {
  let maximum = 0;
  for (const row of rail) {
    maximum = Math.max(maximum, Buffer.byteLength(JSON.stringify(row) ?? '', 'utf8'));
  }
  return maximum;
}
