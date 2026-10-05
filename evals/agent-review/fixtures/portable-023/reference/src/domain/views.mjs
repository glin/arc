import { isQueryMatch, parseSessionQuery } from "./session-query.mjs";
import { normalizeSavedViewSort } from "./rail-sort.mjs";
import { cleanName } from "./text.mjs";
const VIEW_NAME_LIMIT = 40;
const VIEW_QUERY_LIMIT = 200;
const VIEW_NOTES = {
  taken: "A view already has that name. Choose another name.",
  unnamed: "A view needs a name. Type one to save it.",
  limit: `A name is cut to ${VIEW_NAME_LIMIT} characters. Two names that agree that far are one view.`
};
function viewName(raw) {
  return cleanName(raw, VIEW_NAME_LIMIT);
}
function viewKey(name) {
  return name.toLocaleLowerCase();
}
function viewQuery(raw) {
  return typeof raw === "string" ? raw.trim().slice(0, VIEW_QUERY_LIMIT) : "";
}
function nextViewId(views) {
  const taken = new Set(views.map((view) => view.id));
  for (let n = 1; ; n++) {
    const id = `v${n}`;
    if (!taken.has(id)) {
      return id;
    }
  }
}
function viewFiles(query) {
  return parseSessionQuery(viewQuery(query)).terms.length > 0;
}
function viewCanSave(query) {
  return viewFiles(query);
}
function normalizeSavedViews(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = [];
  const ids = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry;
    const id = typeof row.id === "string" ? row.id.trim().slice(0, 64) : "";
    const name = viewName(row.name);
    const query = viewQuery(row.query);
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
      match: isQueryMatch(row.match) ? row.match : "all",
      archived: row.archived === true,
      ...sort === "inherit" ? {} : { sort }
    });
  }
  return out;
}
function findView(views, id) {
  if (!id) {
    return null;
  }
  return views.find((view) => view.id === id) ?? null;
}
function viewNameTaken(views, name, exceptId) {
  const wanted = viewKey(viewName(name));
  if (!wanted) {
    return false;
  }
  return views.some((view) => view.id !== exceptId && viewKey(view.name) === wanted);
}
function viewTypedNotes(views, raw, exceptId) {
  const notes = [];
  if (!viewName(raw)) {
    notes.push("unnamed");
  } else if (viewNameTaken(views, raw, exceptId)) {
    notes.push("taken");
  }
  if (cleanName(raw, VIEW_NAME_LIMIT + 1).length > VIEW_NAME_LIMIT) {
    notes.push("limit");
  }
  return notes;
}
function viewQueryNotes(query) {
  return [];
}
export {
  VIEW_NAME_LIMIT,
  VIEW_NOTES,
  VIEW_QUERY_LIMIT,
  findView,
  nextViewId,
  normalizeSavedViews,
  viewCanSave,
  viewFiles,
  viewKey,
  viewName,
  viewNameTaken,
  viewQuery,
  viewQueryNotes,
  viewTypedNotes
};
