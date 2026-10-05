// Normalizes session labels and prepares their display fields.
// This module imports no other `turn*` module.
// The session-to-label map is the complete label catalog.
// A label disappears when its last session removes it.

import { cleanName } from './domain/text.ts';
import { DRAFT_SESSION_PREFIX, LABEL_NAME_LIMIT, labelKey, sessionsCarrying } from './domain/labels.ts';
export {
  DRAFT_SESSION_PREFIX,
  LABEL_NAME_LIMIT,
  LABEL_NOTES,
  labelKey,
  labelTypedNotes,
  sessionsCarrying,
} from './domain/labels.ts';
export type { LabelNote } from './domain/labels.ts';

// Maximum labels retained per session, including normalized stored values.
export const LABELS_PER_SESSION = 20;

// Maximum sessions retained in the label map. Oldest entries are removed first.
// `LABELS_PER_SESSION` separately bounds each session's labels.
export const LABELLED_SESSION_LIMIT = 500;

// Maximum labels drawn on a session list card before remaining labels become a count.
// The fixed limit preserves the displayed list during resizing.
// Clipped labels remain available through tooltips and the card's full accessible name.
// This display limit never changes stored labels.
export const RAIL_LABELS_SHOWN = 2;

// Removes provisional draft entries when saved state first loads.
// Abandoned drafts otherwise retain unreachable labels and consume map capacity.
// Do not call this during normalization. Active drafts must retain labels on ordinary writes.
export function sweepDraftLabels(labels: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [session, list] of Object.entries(labels)) {
    if (session === '__proto__' || session.startsWith(DRAFT_SESSION_PREFIX)) {
      continue;
    }
    if (!Array.isArray(list)) {
      continue;
    }
    out[session] = [...list];
  }
  return out;
}

// Cleans a stored label name with the shared `cleanName` rules and label length limit.
export function labelName(raw: unknown): string {
  return cleanName(raw, LABEL_NAME_LIMIT);
}

// Cleans one session's label names, removes duplicates, and applies the per-session limit.
// The shared `spellings` map keeps the first case variant seen across retained sessions.
// Labels retain input order, and the limit retains the names drawn first.
function adoptNames(names: readonly unknown[], spellings: Map<string, string>): string[] {
  const kept: string[] = [];
  const here = new Set<string>();
  for (const raw of names) {
    const name = labelName(raw);
    if (!name) {
      continue;
    }
    const key = labelKey(name);
    // Use the first spelling already stored for this case-insensitive label key.
    const owned = spellings.get(key);
    if (owned === undefined) {
      spellings.set(key, name);
    }
    if (here.has(key)) {
      continue;
    }
    here.add(key);
    kept.push(owned ?? name);
    // Stop at the limit before registering more spellings.
    // Discarded names must not change a later session's visible spelling.
    if (kept.length === LABELS_PER_SESSION) {
      break;
    }
  }
  return kept;
}

// Normalizes stored label state with session and per-session limits.
// Empty session keys, `__proto__`, non-list values, and empty cleaned names are excluded.
// Assigning `__proto__` would change the result's prototype instead of storing a session.
// Sessions with no labels have no entry. The newest valid entries survive the limit.
// The first pass finds valid entries before the second establishes their spellings.
// Discarded sessions must not determine a spelling used by retained sessions.
export function normalizeSessionLabels(raw: unknown): Record<string, string[]> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const held: [string, unknown[]][] = [];
  for (const [session, value] of Object.entries(src)) {
    if (!session || session === '__proto__' || !Array.isArray(value)) {
      continue;
    }
    // Use a temporary spelling map to test whether this session has a valid label.
    if (adoptNames(value, new Map()).length) {
      held.push([session, value]);
    }
  }
  const spellings = new Map<string, string>();
  const out: Record<string, string[]> = {};
  for (const [session, value] of held.slice(Math.max(0, held.length - LABELLED_SESSION_LIMIT))) {
    out[session] = adoptNames(value, spellings);
  }
  return out;
}

// Returns a copy of a session's own label list.
// Copying prevents unsaved changes through caller sorting or splicing.
// Own-property lookup excludes prototype values that a session id can name.
export function labelsOf(labels: Readonly<Record<string, readonly string[]>>, session: string): string[] {
  const held = Object.prototype.hasOwnProperty.call(labels, session) ? labels[session] : null;
  // Reject non-list values instead of spreading a string into one label per character.
  return Array.isArray(held) ? [...held] : [];
}

// Returns updated labels without mutating the input map.
// Other sessions retain their names until the session limit removes oldest entries.
// An empty or `__proto__` session key is not written. Empty labels remove the entry.
// Retained other sessions establish the spelling for case variants.
// Retyping a sole holder's label can therefore change its spelling.
// A written session moves to the newest map position before applying the limit.
// Reserve one entry for a nonempty update, then collect spellings from surviving sessions.
// Removing all labels reserves no entry and removes no other session.
export function setSessionLabels(
  labels: Readonly<Record<string, readonly string[]>>,
  session: string,
  names: readonly string[],
): Record<string, string[]> {
  const writing = !!session && session !== '__proto__' && adoptNames(names, new Map()).length > 0;
  const held: [string, readonly string[]][] = [];
  for (const [id, list] of Object.entries(labels)) {
    // Exclude `__proto__` while copying because assignment would change the result's prototype.
    if (id !== session && id !== '__proto__') {
      held.push([id, list]);
    }
  }
  const room = LABELLED_SESSION_LIMIT - (writing ? 1 : 0);
  const spellings = new Map<string, string>();
  const out: Record<string, string[]> = {};
  for (const [id, list] of held.slice(Math.max(0, held.length - Math.max(0, room)))) {
    out[id] = [...list];
    for (const name of list) {
      const key = labelKey(name);
      if (!spellings.has(key)) {
        spellings.set(key, name);
      }
    }
  }
  if (writing) {
    out[session] = adoptNames(names, spellings);
  }
  return out;
}

// Moves provisional session labels to the actual session id.
// Combine both lists with provisional labels first, then remove duplicates and apply the per-session limit.
// Provisional labels remain visible when the actual session already has a full list.
// Empty ids, identical ids, and an actual `__proto__` id leave label ownership unchanged.
export function adoptLabelSession(
  labels: Readonly<Record<string, readonly string[]>>,
  provisional: string,
  actual: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(labels)) {
    if (id !== '__proto__') {
      out[id] = [...list];
    }
  }
  if (!provisional || !actual || provisional === actual) {
    return out;
  }
  if (actual === '__proto__') {
    return out;
  }
  const merged = adoptNames([...labelsOf(labels, provisional), ...labelsOf(labels, actual)], new Map());
  delete out[provisional];
  // Delete the existing actual entry before writing so the combined labels become newest.
  // Replacing its value alone would retain its old position and expose it to the next limit cut.
  delete out[actual];
  if (merged.length) {
    out[actual] = merged;
  }
  return out;
}

// Returns visible session list label names and the folded remainder.
// `more` is null when no names are folded. `rest` supplies the folded names for the tooltip.
// Accessible names use the full label list independently of this display limit.
export function railLabelChips(names: readonly string[]): { chips: string[]; more: string | null; rest: string[] } {
  const chips = names.slice(0, RAIL_LABELS_SHOWN);
  const rest = names.slice(chips.length);
  return { chips, more: rest.length ? `+${rest.length}` : null, rest };
}

// Prepares session list label fields and the full accessible-name clause.
// `labelled` opens the clause. The extension and web demo share this projection.
export function railLabelFields(
  names: readonly string[],
  labelled: string,
): {
  labels: string[];
  labelChips: string[];
  labelsMore: string | null;
  labelsMoreName: string | null;
  labelClause: string | null;
} {
  const { chips, more, rest } = railLabelChips(names);
  return {
    labels: [...names],
    labelChips: chips,
    labelsMore: more,
    labelsMoreName: rest.length ? rest.join(', ') : null,
    labelClause: names.length ? `${labelled} ${names.join(', ')}` : null,
  };
}

// One catalog label, its session count, and that count's accessible wording.
// The label editor and filter suggestions use this shared shape.
export interface LabelCount {
  name: string;
  count: number;
  countName: string;
}

// Counts sessions per case-insensitive label key from the label map.
// A session contributes once even if its list repeats a label. The first spelling seen supplies the row name.
// Invalid session keys, non-list values, and empty cleaned names are excluded.
// Rows sort by descending count, then name. `sessionsCarrying` supplies shared count wording.
export function labelCounts(labels: Readonly<Record<string, readonly string[]>>): LabelCount[] {
  const counted = new Map<string, { name: string; count: number }>();
  for (const [session, value] of Object.entries(labels)) {
    if (!session || session === '__proto__' || !Array.isArray(value)) {
      continue;
    }
    const here = new Set<string>();
    for (const raw of value) {
      const name = labelName(raw);
      if (!name) {
        continue;
      }
      const key = labelKey(name);
      if (here.has(key)) {
        continue;
      }
      here.add(key);
      const held = counted.get(key);
      // Retain the first spelling for this label key, as normalization does.
      if (held) {
        held.count += 1;
      } else {
        counted.set(key, { name, count: 1 });
      }
    }
  }
  return [...counted.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((entry) => ({ ...entry, countName: sessionsCarrying(entry.count) }));
}

// Prepares catalog rows with applied session labels first in their stored order.
// Other rows retain catalog order. Names outside the catalog are omitted.
// Each reply fixes its row order so checkbox changes do not move the active row.
export function labelEditorRows(
  labels: Readonly<Record<string, readonly string[]>>,
  session: string,
): (LabelCount & { applied: boolean })[] {
  const catalog = labelCounts(labels);
  const held = new Map(catalog.map((entry) => [labelKey(entry.name), entry]));
  const mine = new Set<string>();
  const rows: (LabelCount & { applied: boolean })[] = [];
  for (const raw of labelsOf(labels, session)) {
    const name = labelName(raw);
    if (!name) {
      continue;
    }
    const key = labelKey(name);
    const entry = held.get(key);
    if (!entry || mine.has(key)) {
      continue;
    }
    mine.add(key);
    rows.push({ ...entry, applied: true });
  }
  for (const entry of catalog) {
    if (mine.has(labelKey(entry.name))) {
      continue;
    }
    rows.push({ ...entry, applied: false });
  }
  return rows;
}

// Prepares the label editor heading and rows.
// `opener` prefixes the heading. `browserSession` identifies the session in the panel.
// The heading uses the session row's `label`, falling back to its id when the row is absent.
// The extension and web demo share this reply.
export function labelEditorReply(
  labels: Readonly<Record<string, readonly string[]>>,
  sessions: readonly Readonly<{ id: string; label: string }>[],
  session: string,
  opener: string,
  browserSession: string = session,
): {
  type: 'labelEditor';
  session: string;
  heading: string;
  rows: (LabelCount & { applied: boolean })[];
} {
  const title = sessions.find((row) => row.id === session)?.label ?? session;
  return {
    type: 'labelEditor',
    session: browserSession,
    heading: `${opener} ${title}`,
    rows: labelEditorRows(labels, session),
  };
}
