// Build host-to-panel messages from values the host already holds.
// The host selects the inputs. This module defines message shapes without reading files or clocks.
// Payload measurements use these same message shapes.

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

// One session row in session list order, as read by railSessions.
export interface PayloadSessionRow {
  id: string;
  persisted: boolean;
  label: string;
  // The session list card's name, limited to 200 characters. Present only when it differs from label.
  // railSessions uses this name. Popover headings, prompt box targets, and loading messages use label.
  railName?: string;
  agent: string;
  when: string;
  at: number;
  relative: string;
  agentRun?: boolean | null;
}

export interface RailPayloadInput {
  sessions: readonly PayloadSessionRow[];
  counts: ReadonlyMap<string, NewCount>;
  newest: ReadonlyMap<string, number>;
  statuses: ReadonlyMap<string, RailStatus>;
  runningSince: ReadonlyMap<string, number>;
  // Live open-child counts by session for subagents cards.
  openChildren: ReadonlyMap<string, number>;
  // Live background-command counts by session for background cards.
  backgroundCommands: ReadonlyMap<string, number>;
  hidden: ReadonlySet<string>;
  showing: string | null;
  pinnedTop: ReadonlySet<string>;
  unsent: ReadonlyMap<string, UnsentInput>;
  // Separate stat sources shared by session headings and session list cards.
  // sessionStatsOf selects each metric's source. Callers must preserve that selection.
  parsedStats: Readonly<Record<string, readonly SessionStatChip[]>>;
  metadataStats: Readonly<Record<string, readonly SessionStatChip[]>>;
  lifetimeStats: Readonly<Record<string, readonly SessionStatChip[]>>;
  lifetimeContextDetails?: Readonly<Record<string, SessionContextDetail>>;
  // Recorded costs remain independent of visible chips.
  // Exact zero omits the chip but supports cost comparisons. A missing total supports neither comparison.
  lifetimeCosts: Readonly<Record<string, SessionCostTotal>>;
  // Exact cache-expiry return counts for cache-expiry: queries, paired with lower-bound status.
  // Null or absent values support neither comparison. railSessions treats an absent record as empty.
  lifetimeCacheExpiry?: Readonly<Record<string, CacheExpiryCountFact | null>>;
  labels: Readonly<Record<string, readonly string[]>>;
  caches: Readonly<Record<string, RailCacheMark | null>>;
  // Reader-saved views participate in the session list input comparison.
  // A view change must reach other hosts even when session cards remain unchanged.
  views: readonly SavedView[];
  railFilters: readonly SavedRailFilter[];
  // Clock for session list wording. Running-session dates change after local midnight.
  now: number;
}

export interface RailPayload {
  rail: RailCard[];
  stats: Record<string, SessionStatChip[]>;
  labels: LabelCount[];
  views: readonly SavedView[];
  railFilters: readonly SavedRailFilter[];
}

// Compare session list inputs before building the message.
// RAIL_INPUT_HOLDS selects serialized values, object identities, row identities, or the local day for each field.
// Change identities when identity-compared input contents change.
export interface RailInputKey {
  readonly held: readonly unknown[];
  readonly print: string;
}

// Comparison policy for every session list input field.
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

// Local calendar day and zone offset used by session list wording.
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

// Build session list fields shared by rail and render messages.
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
  // Hidden sessions shared across hosts.
  // The host applies this set before parsing. Every panel needs it for hidden-session counts and restore controls.
  // A hide action must preserve sessions hidden by another host.
  hidden: ReadonlySet<string>;
  // Pinned sessions shared across hosts for the host-side session selection.
  pinnedTop: ReadonlySet<string>;
  // Reader comments shared by the host. Local copies would overwrite another panel's comments on save.
  comments: readonly object[];
  sessions: readonly object[];
  showing: string | null;
  sessionAdoptions: readonly { provisional: string; durable: string }[];
  maxSessions: number;
  // Older-page availability and the text for its request control.
  olderHistory: unknown;
  projectSpend: unknown;
  // Explanation shown when the panel has no session content.
  diagnosis: unknown;
  // Reader Timeline layout settings supplied on each render.
  timelineLayout: unknown;
}

// Build render fields shared across panel hosts.
// The caller supplies per-host themed content and font addresses that each webview can load.
export function renderPayload(input: RenderPayloadInput): Record<string, unknown> {
  return {
    type: 'render',
    hidden: [...input.hidden],
    pinnedTop: [...input.pinnedTop],
    comments: input.comments,
    sessions: input.sessions,
    // Session list cards, including unread counts and accessible button names.
    // Separate session list messages update them when the read set changes.
    rail: input.rail.rail,
    // Workspace labels and their session counts for label: query completion.
    // Send them with the initial render and each session list update.
    labels: input.rail.labels,
    // Reader-saved views owned by the extension.
    // Send them with the initial render and each session list update.
    views: input.rail.views,
    // Saved filters narrow every session list section without creating or claiming one.
    // The extension sends them with the initial render and each session list update.
    railFilters: input.rail.railFilters,
    showing: input.showing,
    sessionAdoptions: input.sessionAdoptions,
    maxSessions: input.maxSessions,
    olderHistory: input.olderHistory,
    // Per-host account usage and prompt box target.
    // The caller replaces this value so ages and the selected session reflect the current draw.
    usage: null,
    projectSpend: input.projectSpend,
    diagnosis: input.diagnosis,
    timelineLayout: timelineLayout(input.timelineLayout),
  };
}

// Keep workspace state from the last render when selecting a session.
// Replace fields for both the old selection and the new selection.
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

// UTF-8 JSON bytes for each top-level message field, ordered by size.
// Per-field totals identify which part of a message exceeds its budget.
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

// Repeated string values at least minimumLength characters long, with counts and encoded byte costs.
// Examples include tooltip text repeated in lists and labels repeated in session rows and cards.
export interface DuplicateString {
  text: string;
  count: number;
  // Encoded string bytes multiplied by the number of extra copies.
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
        // Count string values only. Field names define the schema and cannot be removed as duplicate values.
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

// Measure the largest session list card in UTF-8 JSON bytes.
// One large card can exceed the budget even when other rows remain small.
export function railRowBytes(rail: readonly unknown[]): number {
  let maximum = 0;
  for (const row of rail) {
    maximum = Math.max(maximum, Buffer.byteLength(JSON.stringify(row) ?? '', 'utf8'));
  }
  return maximum;
}
