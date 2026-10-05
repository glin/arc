import { labelKey } from "./labels.mjs";
import { normalizeRailSort } from "./rail-sort.mjs";
import {
  isQueryMatch,
  parseSessionQuery,
  queryTokens,
  quoteQueryValue,
  sameQueryTerms
} from "./session-query.mjs";
import { cleanName } from "./text.mjs";
import { VIEW_NAME_LIMIT, VIEW_QUERY_LIMIT } from "./views.mjs";
const RAIL_FILTER_NAME_LIMIT = VIEW_NAME_LIMIT;
const RAIL_FILTER_QUERY_LIMIT = VIEW_QUERY_LIMIT;
const ALL_RAIL_FILTER_ID = "all";
const OLD_NEEDS_YOU_FILTER_ID = "needs-you";
const OLD_NEEDS_YOU_LENS = "needs-you";
const OLD_NEEDS_YOU_WORDS = "is:needsyou -is:archived -is:agentrun";
const RESERVED_RAIL_FILTER_NAMES = [
  "All sessions",
  "Active",
  "Unread",
  "Needs input",
  "Needs you",
  "Custom"
];
const RESERVED_RAIL_FILTER_KEYS = new Set(RESERVED_RAIL_FILTER_NAMES.map((name) => railFilterKey(name)));
const RAIL_LENSES = ["active", "unread", "input"];
const RAIL_LENS_WORDS = {
  active: "is:active -is:archived -is:agentrun",
  unread: "is:unread -is:archived -is:agentrun",
  input: "is:input -is:archived -is:agentrun"
};
const RAIL_KEEPING_LENSES = ["unread", "input"];
const RAIL_FILTER_STORED_QUERY_LIMIT = RAIL_FILTER_QUERY_LIMIT + Math.max(OLD_NEEDS_YOU_WORDS.length, ...RAIL_LENSES.map((lens) => RAIL_LENS_WORDS[lens].length)) + 1;
function isRailLens(raw) {
  return RAIL_LENSES.includes(raw);
}
function isStoredRailLens(raw) {
  return isRailLens(raw) || raw === OLD_NEEDS_YOU_LENS;
}
function normalizeRailLens(raw) {
  return isRailLens(raw) ? raw : null;
}
function railFilterName(raw) {
  return cleanName(raw, RAIL_FILTER_NAME_LIMIT);
}
function railFilterKey(name) {
  return name.toLocaleLowerCase();
}
function boundedRailFilterQuery(raw) {
  return typeof raw === "string" ? raw.slice(0, RAIL_FILTER_STORED_QUERY_LIMIT) : "";
}
function railFilterQuery(raw) {
  return boundedRailFilterQuery(raw).trim();
}
function unreservedRailFilterName(name, taken) {
  for (let n = 1; ; n++) {
    const candidate = railFilterName(n === 1 ? `${name} (saved)` : `${name} (saved ${n})`);
    if (!taken.has(railFilterKey(candidate))) {
      return candidate;
    }
  }
}
function normalizeSavedRailFilters(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry;
    const id = typeof row.id === "string" ? row.id.trim().slice(0, 64) : "";
    const name = railFilterName(row.name);
    if (!id || id === ALL_RAIL_FILTER_ID || id === OLD_NEEDS_YOU_FILTER_ID || !name) {
      continue;
    }
    rows.push({ row, id, name });
  }
  const held = /* @__PURE__ */ new Set([...RESERVED_RAIL_FILTER_KEYS, ...rows.map(({ name }) => railFilterKey(name))]);
  const out = [];
  const ids = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Set();
  for (const { row, id, name: stored } of rows) {
    const name = RESERVED_RAIL_FILTER_KEYS.has(railFilterKey(stored)) ? unreservedRailFilterName(stored, held) : stored;
    const key = railFilterKey(name);
    if (ids.has(id) || names.has(key)) {
      continue;
    }
    held.add(key);
    ids.add(id);
    names.add(key);
    out.push({
      id,
      name,
      // A record saved while a lens was rail state carries it as a field. The lens's missing
      // words join the query, and every word the record held stays.
      query: foldRailLens(railFilterQuery(row.query), row.lens),
      match: isQueryMatch(row.match) ? row.match : "all",
      sort: normalizeRailSort(row.sort)
    });
  }
  return out;
}
function nextRailFilterId(filters) {
  const taken = new Set(filters.map((filter) => filter.id));
  for (let n = 1; ; n++) {
    const id = `f${n}`;
    if (!taken.has(id)) {
      return id;
    }
  }
}
function findRailFilter(filters, id) {
  return filters.find((filter) => filter.id === id) ?? null;
}
function normalizeRailFilterId(raw, filters) {
  return typeof raw === "string" && findRailFilter(filters, raw) ? raw : ALL_RAIL_FILTER_ID;
}
function railFilterNameTaken(filters, raw, exceptId = "") {
  const key = railFilterKey(railFilterName(raw));
  return !!key && (RESERVED_RAIL_FILTER_KEYS.has(key) || filters.some((filter) => filter.id !== exceptId && railFilterKey(filter.name) === key));
}
function sameRailFilterLens(left, right) {
  return left.query.trim() === right.query.trim() && left.match === right.match && left.sort === right.sort;
}
const OLD_WARM_QUERY = "is:warm -is:archived -is:agentrun";
function migrateStoredRailLens(stored) {
  const wasNeedsYou = stored.filterId === OLD_NEEDS_YOU_FILTER_ID || stored.lens === OLD_NEEDS_YOU_LENS;
  const filterId = stored.filterId === OLD_NEEDS_YOU_FILTER_ID ? ALL_RAIL_FILTER_ID : stored.filterId;
  if (wasNeedsYou) {
    return { filterId, query: stored.query, match: stored.match };
  }
  const lens = normalizeRailLens(stored.lens);
  const allSessions = filterId === ALL_RAIL_FILTER_ID || filterId === "" || filterId === void 0;
  if (allSessions && lens === null && stored.match === "all" && sameQueryTerms(stored.query, OLD_WARM_QUERY)) {
    return { filterId, query: RAIL_LENS_WORDS.active, match: "all" };
  }
  return { filterId, query: foldRailLens(stored.query, lens), match: stored.match };
}
function foldRailLens(query, stored) {
  const lens = normalizeRailLens(stored);
  return lens === null ? query : withRailLensWords(query, lens);
}
function termKey(word) {
  const { terms } = parseSessionQuery(word);
  if (terms.length !== 1) {
    return null;
  }
  const [term] = terms;
  return `${term.negated === true ? "-" : ""}${term.field}:${term.needle}`;
}
function queryWords(query) {
  return queryTokens(query).map((token) => {
    const text = query.slice(token.start, token.end);
    return { text, key: termKey(text) };
  });
}
function railQueryHoldsLens(query, lens) {
  const held = new Set(queryWords(query).map((word) => word.key));
  return queryWords(RAIL_LENS_WORDS[lens]).every((word) => held.has(word.key));
}
function railQueryLenses(query) {
  const held = new Set(queryWords(query).map((word) => word.key));
  return RAIL_LENSES.filter((lens) => railLensKeys(lens).every((key) => held.has(key)));
}
function railQueryHeldLens(query) {
  const lenses = railQueryLenses(query);
  return lenses.length === 1 ? lenses[0] : null;
}
function railQueryLens(query) {
  if (queryWords(query).some((word) => word.key === null)) {
    return null;
  }
  return RAIL_LENSES.find((lens) => sameQueryTerms(query, RAIL_LENS_WORDS[lens])) ?? null;
}
function railLensKeys(lens) {
  return queryWords(RAIL_LENS_WORDS[lens]).map((word) => word.key);
}
function withoutWords(query, drop) {
  return queryWords(query).filter((word) => word.key === null || !drop.has(word.key)).map((word) => word.text).join(" ");
}
function withoutRailLenses(query) {
  const held = railQueryHeldLens(query);
  return held === null ? query : withoutWords(query, new Set(railLensKeys(held)));
}
function withRailLensWords(query, lens) {
  const held = new Set(queryWords(query).map((word) => word.key));
  const words = queryWords(RAIL_LENS_WORDS[lens]).filter((word) => !held.has(word.key)).map((word) => word.text);
  return [...words, query.trim()].filter(Boolean).join(" ");
}
function withRailLens(query, lens) {
  if (lens === null) {
    return withoutWords(query, new Set(railQueryLenses(query).flatMap((held) => railLensKeys(held))));
  }
  const written = withRailLensWords(query, lens);
  const keep = new Set(railLensKeys(lens));
  const opposites = [...keep].map((key) => key.startsWith("-") ? key.slice(1) : `-${key}`);
  const incompatible = lens === "unread" ? ["status:read"] : lens === "input" ? ["status:running"] : [];
  const drop = new Set([
    ...opposites,
    ...incompatible,
    ...railQueryLenses(written).filter((other) => other !== lens).flatMap((other) => railLensKeys(other)).filter((key) => !keep.has(key))
  ]);
  return drop.size ? withoutWords(written, drop) : written;
}
function pressRailLens(query, lens) {
  return railQueryHeldLens(query) === lens ? withoutRailLenses(query) : withRailLens(query, lens);
}
function termNames(term, field, value) {
  return term.field === field && labelKey(term.needle) === labelKey(value);
}
function railFilterTermSelected(query, field, value) {
  return parseSessionQuery(query).terms.some((term) => term.negated !== true && termNames(term, field, value));
}
function railFilterTermNegated(query, field, value) {
  return parseSessionQuery(query).terms.some((term) => term.negated === true && termNames(term, field, value));
}
function toggleRailFilterTerm(query, field, value) {
  const remove = queryTokens(query).filter((token2) => {
    const parsed = parseSessionQuery(query.slice(token2.start, token2.end)).terms;
    return parsed.some((term) => term.negated !== true && termNames(term, field, value));
  });
  if (remove.length) {
    const starts = new Set(remove.map((token2) => token2.start));
    return queryTokens(query).filter((token2) => !starts.has(token2.start)).map((token2) => query.slice(token2.start, token2.end)).join(" ");
  }
  const token = `label:${quoteQueryValue(value)}`;
  return [query.trim(), token].filter(Boolean).join(" ");
}
export {
  ALL_RAIL_FILTER_ID,
  RAIL_FILTER_NAME_LIMIT,
  RAIL_FILTER_QUERY_LIMIT,
  RAIL_FILTER_STORED_QUERY_LIMIT,
  RAIL_KEEPING_LENSES,
  RAIL_LENSES,
  RAIL_LENS_WORDS,
  RESERVED_RAIL_FILTER_NAMES,
  boundedRailFilterQuery,
  findRailFilter,
  isRailLens,
  isStoredRailLens,
  migrateStoredRailLens,
  nextRailFilterId,
  normalizeRailFilterId,
  normalizeSavedRailFilters,
  pressRailLens,
  railFilterKey,
  railFilterName,
  railFilterNameTaken,
  railFilterQuery,
  railFilterTermNegated,
  railFilterTermSelected,
  railQueryHeldLens,
  railQueryHoldsLens,
  railQueryLens,
  railQueryLenses,
  sameRailFilterLens,
  toggleRailFilterTerm,
  withRailLens,
  withoutRailLenses
};
