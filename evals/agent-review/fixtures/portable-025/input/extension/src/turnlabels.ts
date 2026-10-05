// extension/src/turnlabels.ts
//
// The labels a reader files a session under: what one is called, which session carries which, and what a card draws when it carries more than it can show.
//
// A leaf. It imports nothing from the turn* family, so any module in the family reads it
// without a cycle. turnrail.ts and turnview.ts read it today. A cycle is caught by nothing
// here: it arrives as an undefined export the first time the panel loads.
//
// The record of session to labels is the whole of the state. There is no separate list
// of the labels a workspace has, so the labels are whatever the record names and one cannot
// outlive the last session carrying it. Nothing has to clean one up, and no control can
// offer a label that files nothing.

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

// How many labels one session carries.
//
// Labels sort a workspace, and a session filed under `LABELS_PER_SESSION` of them is
// filed under none. Past that the reader is writing about the session rather than filing
// it, and a note is the thing for that. The ceiling holds on the way in as well as on the way
// out, so a state file edited by hand cannot put a row of chips of any length on one card.
export const LABELS_PER_SESSION = 20;

// How many sessions carry labels before the oldest entries drop out. One entry per
// session, so it takes the same session-shaped ceiling the rest of the panel's
// stored state takes.
//
// Named for the sessions it counts, not the labels. `LABELS_PER_SESSION` above bounds one
// session's list, this bounds how many sessions are filed at all, and a name that
// read as "how many labels a session gets" would fit either. `setSessionLabels` uses
// both within a few lines, where a swap typechecks and reads as deliberate.
export const LABELLED_SESSION_LIMIT = 500;

// How many labels a rail card draws before the rest fold into a count.
//
// The card is only as wide as the reader has dragged the rail, and a row of chips that wraps
// pushes every card under it down the list, so the row draws a fixed few and folds the rest.
// A fixed few rather than as many as fit: a count read off the width would redraw the line on
// every drag, and the card would say a different thing about the session at each one.
//
// At the rail's default width they are drawn whole. Dragged to the floor the rail clips them,
// which the chip's own hover answers, and the card's accessible name says every label at any
// width. The fold limits the drawing and never what the session carries.
export const RAIL_LABELS_SHOWN = 2;

// The record with every session that never got a real id taken out.
//
// A draft the reader labelled and then abandoned leaves an entry nothing can reach: no card
// draws it, no control takes it off, and it holds a place under the record's ceiling for
// ever. Its labels also stand in the workspace's catalogue with a count beside them, so the
// filter box would offer a label that files nothing a reader can open.
//
// `normalizeSessionLabels` does not call this, and must not. Normalization runs on
// every write, and a draft the reader is looking at right now is a live session whose
// labels have to survive one. This runs once, where the stored state is first read, when
// every draft id in it is known to be from a window that has gone.
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

// One label's name as it will be stored and drawn: the reader's own words, run together and
// cut to a chip.
//
// The cleaning itself is `cleanName` in `domain/text.ts`, which the view editor's name box
// reaches too. It carries why each step runs and why they run in that order. Only the ceiling
// is this module's: a label is drawn on a card as wide as the reader dragged the rail.
export function labelName(raw: unknown): string {
  return cleanName(raw, LABEL_NAME_LIMIT);
}

// One session's names, cleaned, filed under the workspace's spellings, and cut to the
// ceiling.
//
// `spellings` is carried in and back out rather than built fresh per session, because
// the rule is workspace wide: the first spelling seen wins and every later case-variant is
// rewritten to it. A rule that stopped at one session would let one card read `perf`
// and the next `Perf`, and the reader has no control that puts those back together.
//
// A list past the ceiling keeps its first names. The reader applied them in that order and
// the card draws from the front, so what goes is what nothing on screen was showing.
function adoptNames(names: readonly unknown[], spellings: Map<string, string>): string[] {
  const kept: string[] = [];
  const here = new Set<string>();
  for (const raw of names) {
    const name = labelName(raw);
    if (!name) {
      continue;
    }
    const key = labelKey(name);
    // The first spelling seen owns the label from here on, so a name that arrives later in
    // another case is stored as the one already on screen elsewhere.
    const owned = spellings.get(key);
    if (owned === undefined) {
      spellings.set(key, name);
    }
    if (here.has(key)) {
      continue;
    }
    here.add(key);
    kept.push(owned ?? name);
    // The ceiling stops the walk rather than cutting the result, so a name past it teaches no
    // spelling. A spelling nothing carries would rewrite a later session's label to a
    // name the reader cannot see anywhere.
    if (kept.length === LABELS_PER_SESSION) {
      break;
    }
  }
  return kept;
}

// The stored labels, made safe to use and cut to the ceilings.
//
// Rebuilt entry by entry rather than trusted, for the reason `normalizePanelState` gives:
// this comes back from storage that outlives the code that wrote it, and a panel that throws
// while reading its own state draws nothing at all and says nothing about why. A key that
// names no session goes, a value that is not a list goes, and a name that cleans to
// nothing goes. A session left with no labels takes no entry, so the record answers the
// same way for a session that was never filed and one whose last label was taken off.
//
// Storage hands every key back as a string, so the empty one and `__proto__` are the two
// shapes that can arrive wrong. The empty key would file a session no card can ever
// draw. `__proto__` is not a session id either, and a plain assignment under it replaces
// the record's prototype instead of adding an entry, which loses the entry and hands every
// later reader an object shaped like whatever arrived.
//
// The record takes the session-shaped ceiling and the newest entries are what is kept,
// the way the drafts and the watermarks beside it are.
//
// The cut runs before any spelling is read, which is why this walks the record twice. A
// first pass asks only whether an entry cleans to a name at all, and a second reads the
// spellings off the entries that survived. Cutting afterwards would let the entry the cut
// throws away own the spelling of a label every card that is kept still draws, which is the
// same hole the ceiling on one session avoids by stopping its walk.
export function normalizeSessionLabels(raw: unknown): Record<string, string[]> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const held: [string, unknown[]][] = [];
  for (const [session, value] of Object.entries(src)) {
    if (!session || session === '__proto__' || !Array.isArray(value)) {
      continue;
    }
    // A throwaway map, because this pass only asks whether the entry survives at all. How
    // many names it keeps does not depend on which spellings it is handed.
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

// One session's labels, as a list the caller owns.
//
// A copy, because the record it comes out of is the panel's stored state. A caller that
// sorted or spliced what it was handed would edit that state without saving it, and the
// screen and the storage would disagree until the next reload.
//
// The lookup names an own entry only. A session id is a string an agent chose, so a bare
// index could answer with something off the object's prototype and hand back a value that is
// not a list at all.
export function labelsOf(labels: Readonly<Record<string, readonly string[]>>, session: string): string[] {
  const held = Object.prototype.hasOwnProperty.call(labels, session) ? labels[session] : null;
  // A list, or nothing. The own-property check answers the first half of the hazard above,
  // and this answers the second: a string under the key spreads into one entry per letter,
  // and the card draws a chip for each of them.
  return Array.isArray(held) ? [...held] : [];
}

// One session's labels, replaced. Every other session comes back as it was.
//
// A new record rather than an edit in place, so the caller can hold the old one beside it and
// decide whether to save. The names go through the rules a stored record goes through,
// spelling included: a reader typing `Perf` onto a second session gets the `perf` the
// first one already carries, and no control has to ask them which of the two they meant.
//
// The spellings are read off the other sessions and never off this one. Retyping the
// only holder's label in another case is how a reader changes its spelling, and reading this
// session's own names back would rewrite the new spelling to the old one and read as the
// panel refusing the edit.
//
// An empty result deletes the entry rather than storing an empty list. The record is the whole
// answer to which labels exist, so an empty list would count a session as filed under
// nothing and fill the ceiling with sessions carrying no label at all.
//
// An empty session names no session, so the record comes back unchanged. Writing under
// that key would file a session no card can draw and no control can reach. `__proto__`
// is refused for the reason the normalizer refuses it.
//
// The session just filed goes to the newest end of the record, and the record is held to
// its ceiling here rather than only on the way back from storage. Without both, a workspace at
// the ceiling grows past it for the whole life of the window, and the reader's newest filing
// keeps the position it had when it was oldest. The cut on the next reload would then throw
// away the entry they had just written.
//
// The cut runs before the spellings are read, for the reason `normalizeSessionLabels`
// gives: an entry the cut drops must not own the spelling of a label the surviving cards
// draw. The entry being written takes one of the ceiling's places when it cleans to a name,
// so the rest are cut to one fewer, and a reader taking every label off a session costs
// no other session its entry.
export function setSessionLabels(
  labels: Readonly<Record<string, readonly string[]>>,
  session: string,
  names: readonly string[],
): Record<string, string[]> {
  const writing = !!session && session !== '__proto__' && adoptNames(names, new Map()).length > 0;
  const held: [string, readonly string[]][] = [];
  for (const [id, list] of Object.entries(labels)) {
    // The key is refused on the way through as well as on the way in. A record whose own
    // `__proto__` names a list arrives only from state nobody normalized, and copying it
    // with a plain assignment replaces the returned record's prototype rather than adding
    // an entry: the entry is lost and every later reader holds an object shaped like
    // whatever arrived.
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

// The labels of a session that had no id yet, moved onto the id it was given.
//
// A prompt sent from the panel starts a session before the agent has written a record of
// it, so the panel files it under a provisional id and learns the real one from the first
// record that lands. Anything the reader did in between is keyed on the provisional id.
// Labels move with the drafts, or a session filed while it was starting comes back
// unfiled the moment it answers.
//
// An actual id that already carries labels is merged rather than refused, which is where this
// parts from `adoptSessionIdentity`: two queues of presses cannot be run as one, while
// two lists of the reader's own filing lose nothing by joining. A repeat is dropped rather
// than kept twice, since one card drawing one label twice is what a merge gets wrong.
//
// The draft's own labels lead the merged list. They are the newest thing the reader said about
// the session, and the row draws the front of the list, so they are what the card shows.
// It is also what makes this safe at the ceiling: the walk stops once a session is full,
// so an actual id already carrying its full complement would swallow the merge and drop the
// label the reader had put on the draft seconds earlier.
//
// The same id twice, or an empty one on either side, returns the record unchanged. Adopting
// an id onto itself would delete the entry it had just written.
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
  // Deleted before it is written, so the merged entry lands at the newest end of the record
  // rather than keeping the position the actual id already had. Assigning over a key leaves
  // it where it was, and the session the reader filed seconds ago would then be first
  // in line for the next cut. `setSessionLabels` moves an entry for the same reason.
  delete out[actual];
  if (merged.length) {
    out[actual] = merged;
  }
  return out;
}

// What a rail card draws for its labels: the first few names, and a count standing for the
// rest.
//
// The card is as narrow as the reader has dragged the rail, so the row cannot grow with the
// session. What it leaves out is still said in full in the card's accessible name, which
// is built from the whole list rather than from this, because the fold is a limit on the
// drawing and not a claim about what the session carries.
//
// `more` is null rather than an empty string when nothing folds, so the panel has one thing
// to test before it draws a chip and an empty chip with a border around it never reaches the
// row. `rest` names what the count stands for, so the chip drawn from it can carry the whole
// of what it hides on its hover. Split here rather than by the caller, or the count and the
// names behind it would come from two slices that could disagree.
//
export function railLabelChips(names: readonly string[]): { chips: string[]; more: string | null; rest: string[] } {
  const chips = names.slice(0, RAIL_LABELS_SHOWN);
  const rest = names.slice(chips.length);
  return { chips, more: rest.length ? `+${rest.length}` : null, rest };
}

// Every field a rail card takes from its session's labels, and the clause that closes the
// card's accessible name. `labelled` is the word that opens the clause.
//
// The rail builds its cards from this, and the web sample rebuilds a card's label fields from
// it after the reader edits them, so the two draw one card the same way.
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

// One label the workspace has, as every surface that offers a list of them is handed it.
//
// The editor's checkboxes and the filter box's suggestions draw the same three fields, and
// both are announced by the name and the count together. One shape, so the module and the
// browser copy of the suggestion rule take identical rows and a guard can hold one answer
// against the other field for field.
export interface LabelCount {
  name: string;
  count: number;
  countName: string;
}

// Every label the workspace has, with how many sessions carry it.
//
// Counted off the record rather than kept beside it, because the record is the whole answer
// to which labels exist. A label the last session dropped leaves the list with it, and
// no control offers a label that files nothing.
//
// Counted by the folded key and reported in the spelling the record carries, so two cases of
// one name are one row with one count. A record nobody normalized names a label twice on one
// session, and a count that took both would say two sessions carry it.
//
// The keys and values `normalizeSessionLabels` refuses are refused here for the reasons
// it gives, since this reads the same record from anywhere the panel holds one.
//
// Ordered by count and then by name, so the labels the workspace leans on lead the editor's
// list and two labels nothing separates keep one order between one drawing and the next.
//
// Each row carries the spoken form of its own count, worded once by `sessionsCarrying`.
// The panel draws this catalogue in two places and reads out both, so a plural rule written
// in the browser would be a second answer to when a count is plural.
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
      // The first spelling seen owns the row, which is the answer `adoptNames` gives a
      // record on the way in. A normalized record carries one spelling already, and an
      // unnormalized one is read the same way here as it would be written there.
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

// The rows the editor draws for one session: every label the workspace has, with the
// ones this session already carries at the front.
//
// The session's own labels lead, in the order the reader applied them. That order is
// the one thing in the list the reader wrote, and it is the order the card draws them in, so
// the editor and the card agree about which label is first. The rest follow the catalog.
//
// The order is settled once, when the rows are built. A list that sorted itself as the boxes
// were ticked would move a row out from under the reader's hand between one press and the
// next, so a tick is a write and the order it produces belongs to the next answer.
//
// A row is drawn only for a label the catalog holds. A name filed under a key that names no
// session reaches none, because the count beside it would stand for nothing.
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

// What the label editor draws for one session: the heading it wears, and a row per label
// the workspace has. `opener` is the word that opens the heading, and `browserSession` is
// the id the panel knows the session by.
//
// The heading names the session by its row's short `label`, the sixty-character form
// every row carries, not by the fuller `railName` the rail card draws for a name past
// that length. A session the rows no longer name falls back to its id rather than
// opening on a heading with a gap in it.
//
// The extension answers the editor with this, and the web sample answers it with the same
// function, so the two draw one editor the same way.
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
