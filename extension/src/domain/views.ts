// A saved view files matching sessions under its own section. It carries a query and an archived-session choice.
// The extension normalizes saved views. The browser draws and edits them.

import { parseSessionQuery } from './session-query.ts';
import { labelKey } from './labels.ts';
import { normalizeSavedViewSort, type SavedViewSort } from './rail-sort.ts';
import { cleanName } from './text.ts';

// The longest a view's name is stored at. The same ceiling a label takes, because the two are drawn in
// the same widths: a name on the rail's own row, and a name in a list inside a popover.
export const VIEW_NAME_LIMIT = 40;

// The longest query a view stands for. Far past any filter a reader types by hand. It
// exists because the record comes back from storage that outlives the code that wrote it, and
// a query of any length would be drawn on the row that names the view.
export const VIEW_QUERY_LIMIT = 200;

// What the editor tells the reader about the name they are typing. The one place either
// sentence is written, so the panel holds no copy of a rule about names.
export const VIEW_NOTES = {
  taken: 'A view already has that name. Choose another name.',
  unnamed: 'A view needs a name. Type one to save it.',
  limit: `A name is cut to ${VIEW_NAME_LIMIT} characters. Two names that agree that far are one view.`,
} as const;

export type ViewNote = keyof typeof VIEW_NOTES;

export interface SavedView {
  id: string;
  name: string;
  query: string;

  // New views exclude archived sessions unless the reader enables them.
  archived: boolean;
  sort?: SavedViewSort;
}

// A view's name as it will be stored and drawn: the reader's own words, run together and cut.
// The same cleaning a label name goes through, because a reader types both into a box in the
// same panel and expects one answer to a pasted line break or a run of spaces.
export function viewName(raw: unknown): string {
  return cleanName(raw, VIEW_NAME_LIMIT);
}

// Two names that fold to one key are one view. The reader's own locale decides case, the way
// it decides it for a label, so a name typed in another case reaches the view already saved.
export function viewKey(name: string): string {
  return name.toLocaleLowerCase();
}

// The query a view stands for, made safe to store. Whitespace at either end says nothing and a
// query past the ceiling is cut, because a stored value of any length would be drawn on a row
// as wide as the rail.
//
// The cut runs before anything reads the grammar, which is why `viewFiles` asks
// this first: a long query whose only term sits past the cut reaches storage with no term.
export function viewQuery(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, VIEW_QUERY_LIMIT) : '';
}

// Suggest the sole positive label in the query the view will store.
export function viewNameForQuery(query: string, labels: readonly { name: string }[]): string {
  const positive = parseSessionQuery(viewQuery(query)).terms.filter((term) => term.field === 'labels' && !term.negated);
  if (positive.length !== 1) {
    return '';
  }
  const name = positive[0].needle;
  return viewName(labels.find((label) => labelKey(label.name) === labelKey(name))?.name ?? name);
}

// Returns the first unused sequential view id.
export function nextViewId(views: readonly SavedView[]): string {
  const taken = new Set(views.map((view) => view.id));
  for (let n = 1; ; n++) {
    const id = `v${n}`;
    if (!taken.has(id)) {
      return id;
    }
  }
}

// Whether a query narrows anything. A query of spaces alone, or one holding only `find:` and
// `in:` words, leaves the grammar no term, and a query with no term matches every session.
// A view over one is a section holding the whole rail under a name, so neither the panel nor
// the record makes one.
export function viewFiles(query: string): boolean {
  return parseSessionQuery(viewQuery(query)).terms.length > 0;
}

// Whether a query can file a view. Any term does, a live one such as `cost:` or `cache-expiry:`
// among them, because a view's section matches again on every draw the way a status view does.
export function viewCanSave(query: string): boolean {
  return viewFiles(query);
}

// Normalize each stored entry. Drop entries with missing identity, missing names, or duplicate identity or names.
export function normalizeSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SavedView[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim().slice(0, 64) : '';
    const name = viewName(row.name);
    const query = viewQuery(row.query);
    // A view whose query narrows nothing goes, because the panel refuses to make one and a
    // record that held one would draw a section over the whole rail under a name.
    if (!id || !name || !viewCanSave(query) || ids.has(id) || names.has(viewKey(name))) {
      continue;
    }
    ids.add(id);
    names.add(viewKey(name));
    const sort = normalizeSavedViewSort(row.sort);
    out.push({
      id,
      name,
      query,

      archived: row.archived === true,
      ...(sort === 'inherit' ? {} : { sort }),
    });
  }
  return out;
}

// An empty id selects All sessions and has no saved view.
export function findView(views: readonly SavedView[], id: string): SavedView | null {
  if (!id) {
    return null;
  }
  return views.find((view) => view.id === id) ?? null;
}

// Whether another view already carries a name. The view being edited is excluded by its own
// id, or renaming a view to the case it already has would refuse itself.
export function viewNameTaken(views: readonly SavedView[], name: string, exceptId: string): boolean {
  const wanted = viewKey(viewName(name));
  if (!wanted) {
    return false;
  }
  return views.some((view) => view.id !== exceptId && viewKey(view.name) === wanted);
}

// What the editor tells the reader about the name in the box, while they are typing it.
export function viewTypedNotes(views: readonly SavedView[], raw: string, exceptId: string): ViewNote[] {
  const notes: ViewNote[] = [];
  if (!viewName(raw)) {
    notes.push('unnamed');
  } else if (viewNameTaken(views, raw, exceptId)) {
    notes.push('taken');
  }
  // Said while the name is being typed rather than after it is stored, because the cut is what
  // makes two names one view and the reader cannot see it happen. It rides beside the note
  // above, since a name past the ceiling can also be one another view already carries.
  //
  // Measured on the cleaned name and not on the raw one. The cleaning runs a row of spaces
  // together and drops what draws nothing, so a raw string past the ceiling often stores whole,
  // and a warning about a cut that never happens is a warning the reader learns to ignore.
  if (cleanName(raw, VIEW_NAME_LIMIT + 1).length > VIEW_NAME_LIMIT) {
    notes.push('limit');
  }
  return notes;
}

export function viewQueryNotes(query: string): ViewNote[] {
  void query;
  return [];
}
