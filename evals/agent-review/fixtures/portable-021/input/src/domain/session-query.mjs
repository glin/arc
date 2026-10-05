import { labelKey } from "./labels.mjs";
const LABEL_PREFIX = "label";
const FIND_PREFIX = "find";
const WHERE_PREFIX = "in";
const WHERE_VALUES = ["both", "prompt", "summary"];
const WHERE_SYNONYMS = {
  response: "summary",
  answer: "summary",
  reply: "summary",
  ask: "prompt",
  me: "prompt"
};
const IS_PREFIX = "is";
const IS_VALUES = [
  "input",
  "unread",
  "read",
  "running",
  "warm",
  "active",
  "needsyou",
  "archived",
  "agentrun"
];
const IS_SYNONYMS = { waiting: "input", blocked: "input" };
const SESSION_AXES = [
  { prefix: "agent", field: "agent" },
  { prefix: "title", field: "title" },
  { prefix: LABEL_PREFIX, field: "labels" },
  { prefix: "cost", field: "cost" },
  { prefix: "cache-expiry", field: "cache-expiry" },
  { prefix: IS_PREFIX, field: "status" }
];
const NUMERIC_FIELDS = ["cost", "cache-expiry"];
const NEGATE_MARK = "-";
const QUERY_SPACE = /\s/;
const NUMERIC_COMPARISON_VALUE = /^(>|<)(\d+(?:\.\d+)?)$/;
const DECIMAL_VALUE = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;
function decimalValue(raw) {
  const match = DECIMAL_VALUE.exec(raw);
  if (!match) {
    return null;
  }
  const fraction = match[2] ?? "";
  const writtenExponent = match[3] ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(writtenExponent)) {
    return null;
  }
  let digits = `${match[1]}${fraction}`.replace(/^0+/, "");
  if (!digits) {
    return { digits: "0", exponent: 0 };
  }
  let exponent = writtenExponent - fraction.length;
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return { digits, exponent };
}
function compareDecimals(left, right) {
  if (left.digits === "0" || right.digits === "0") {
    return left.digits === right.digits ? 0 : left.digits === "0" ? -1 : 1;
  }
  const leftPlace = left.digits.length + left.exponent;
  const rightPlace = right.digits.length + right.exponent;
  if (leftPlace !== rightPlace) {
    return leftPlace < rightPlace ? -1 : 1;
  }
  const width = Math.max(left.digits.length, right.digits.length);
  const leftDigits = left.digits.padEnd(width, "0");
  const rightDigits = right.digits.padEnd(width, "0");
  return leftDigits === rightDigits ? 0 : leftDigits < rightDigits ? -1 : 1;
}
function queryWords(query) {
  const words = [];
  let text = "";
  let start = -1;
  let quoted = false;
  let hadQuote = false;
  let quotedHead = false;
  const close = (at) => {
    if (start !== -1) {
      words.push({ text, start, end: at, quoted: hadQuote, quotedHead });
    }
    text = "";
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
function railStatusRuns(status) {
  return status === "running" || status === "subagents" || status === "background";
}
function quoteQueryValue(value) {
  if (!/[\s"]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}
function wordPrefix(text) {
  const split = text.indexOf(":");
  return split > 0 ? text.slice(0, split).toLowerCase() : "";
}
function setsSearch(text) {
  const prefix = wordPrefix(text);
  return prefix === FIND_PREFIX || prefix === WHERE_PREFIX;
}
function parseSessionQuery(query) {
  const out = { terms: [], find: [], where: "both", unknownWhere: [], unknownIs: [] };
  let searching = false;
  for (const { text: written, quoted, quotedHead } of queryWords(query)) {
    if (!written || !quotedHead && written === NEGATE_MARK) {
      continue;
    }
    if (!quotedHead && written.startsWith(NEGATE_MARK + NEGATE_MARK)) {
      continue;
    }
    const negated = !quotedHead && written[0] === NEGATE_MARK && !setsSearch(written.slice(1));
    const raw = negated ? written.slice(1) : written;
    const mark = negated ? { negated: true } : {};
    const word = raw.toLowerCase();
    const split = raw.indexOf(":");
    const prefix = split > 0 ? raw.slice(0, split).toLowerCase() : "";
    const typed = split > 0 ? raw.slice(split + 1) : "";
    const value = typed.toLowerCase();
    if (prefix === FIND_PREFIX) {
      searching = true;
      if (value) {
        out.find.push(value);
      }
      continue;
    }
    if (prefix === WHERE_PREFIX) {
      const where = WHERE_VALUES.find((candidate) => candidate === value) || (Object.prototype.hasOwnProperty.call(WHERE_SYNONYMS, value) ? WHERE_SYNONYMS[value] : void 0);
      if (where) {
        out.where = where;
      } else if (value) {
        out.unknownWhere.push(value);
      }
      continue;
    }
    if (prefix === IS_PREFIX) {
      const status = IS_VALUES.find((candidate) => candidate === value) || (Object.prototype.hasOwnProperty.call(IS_SYNONYMS, value) ? IS_SYNONYMS[value] : void 0);
      if (status) {
        out.terms.push({ field: "status", needle: status, ...mark });
      } else if (value) {
        out.unknownIs.push(written);
      }
      continue;
    }
    const axis = SESSION_AXES.find((candidate) => candidate.prefix === prefix);
    if (axis) {
      if (NUMERIC_FIELDS.includes(axis.field)) {
        const match = quoted ? null : NUMERIC_COMPARISON_VALUE.exec(typed);
        const threshold = match ? decimalValue(match[2]) : null;
        out.terms.push({
          field: axis.field,
          needle: typed,
          ...mark,
          ...match && threshold ? { comparison: { operator: match[1], threshold } } : {}
        });
        continue;
      }
      if (typed) {
        out.terms.push({ field: axis.field, needle: axis.field === "labels" ? typed : value, ...mark });
      }
      continue;
    }
    if (searching) {
      out.find.push(word);
    } else {
      out.terms.push({ field: "title", needle: word, plain: true, ...mark });
    }
  }
  return out;
}
function queryToken(query, caret) {
  const at = Math.max(0, Math.min(caret, query.length));
  for (const word of queryWords(query)) {
    if (at < word.start || at > word.end) {
      continue;
    }
    const split = word.text.indexOf(":");
    return {
      prefix: split > 0 ? word.text.slice(0, split).toLowerCase() : "",
      value: split > 0 ? word.text.slice(split + 1) : word.text,
      start: word.start,
      end: word.end
    };
  }
  return { prefix: "", value: "", start: at, end: at };
}
function queryTokens(query) {
  return queryWords(query).map((word) => {
    const split = word.text.indexOf(":");
    return {
      prefix: split > 0 ? word.text.slice(0, split).toLowerCase() : "",
      value: split > 0 ? word.text.slice(split + 1) : word.text,
      start: word.start,
      end: word.end
    };
  });
}
function replaceToken(query, start, end, text) {
  const from = Math.max(0, Math.min(start, query.length));
  const to = Math.max(from, Math.min(end, query.length));
  return { query: query.slice(0, from) + text + query.slice(to), caret: from + text.length };
}
function canStartSearch(query) {
  const parsed = parseSessionQuery(query);
  return parsed.find.length === 0 && parsed.terms.some((term) => term.plain === true);
}
function withWhere(query, where) {
  const kept = query.trim().split(/\s+/).filter((word) => word && word.toLowerCase().indexOf(WHERE_PREFIX + ":") !== 0);
  if (where !== "both") {
    kept.push(WHERE_PREFIX + ":" + where);
  }
  return kept.join(" ");
}
function isSearch(query) {
  return parseSessionQuery(query).find.length > 0;
}
function plainTermHolds(term, agent, title, labels, costDollars, costAtLeast = false, status, unread = false, cacheWarm = false, runByAgent = false, archived = false, active = false, cacheExpiryCount = null, cacheExpiryAtLeast = false) {
  if (term.field === "cost" || term.field === "cache-expiry") {
    const value = term.field === "cost" ? costDollars : cacheExpiryCount;
    const atLeast = term.field === "cost" ? costAtLeast : cacheExpiryAtLeast;
    if (!term.comparison || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return false;
    }
    const recorded = decimalValue(String(value));
    if (!recorded) {
      return false;
    }
    const compared = compareDecimals(recorded, term.comparison.threshold);
    if (term.comparison.operator === ">") {
      return compared > 0;
    }
    return !atLeast && compared < 0;
  }
  if (term.field === "labels") {
    const wanted = labelKey(term.needle);
    return (labels ?? []).some((name) => labelKey(name) === wanted);
  }
  if (term.field === "status") {
    if (term.needle === "input") {
      return status === "waiting";
    }
    if (term.needle === "unread") {
      return unread;
    }
    if (term.needle === "read") {
      return !unread;
    }
    if (term.needle === "warm") {
      return cacheWarm;
    }
    if (term.needle === "archived") {
      return archived;
    }
    if (term.needle === "agentrun") {
      return runByAgent;
    }
    if (term.needle === "active") {
      return active;
    }
    if (term.needle === "needsyou") {
      return active && (status === "waiting" || unread);
    }
    return railStatusRuns(status);
  }
  return (term.field === "agent" ? agent : title).toLowerCase().includes(term.needle);
}
function sessionTermHolds(term, agent, title, labels, costDollars, costAtLeast = false, status, unread = false, cacheWarm = false, runByAgent = false, archived = false, active = false, cacheExpiryCount = null, cacheExpiryAtLeast = false) {
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
    cacheExpiryAtLeast
  );
  return term.negated === true ? !held : held;
}
function sameQueryTerms(left, right) {
  const key = (query) => {
    const parsed = parseSessionQuery(query);
    const terms = parsed.terms.map((term) => `${term.negated === true ? NEGATE_MARK : ""}${term.field}:${term.needle}`).sort();
    return JSON.stringify([terms, [...parsed.find].sort(), parsed.where]);
  };
  return key(left) === key(right);
}
function isQueryMatch(raw) {
  return raw === "all" || raw === "any";
}
const NARROWING_STATUSES = /* @__PURE__ */ new Set(["active", "needsyou"]);
function termNarrows(term) {
  return term.negated === true || term.field === "status" && NARROWING_STATUSES.has(term.needle);
}
function matchSessions(sessions, query, match = "all") {
  const { terms } = parseSessionQuery(query);
  if (terms.some((term) => NUMERIC_FIELDS.includes(term.field) && !term.comparison)) {
    return [];
  }
  if (!terms.length) {
    return sessions;
  }
  const wanted = terms.filter((term) => !termNarrows(term));
  const unwanted = terms.filter(termNarrows);
  return sessions.filter((session) => {
    const holds = (term) => sessionTermHolds(
      term,
      session.agent,
      session.name ?? session.label,
      session.labels,
      session.costDollars,
      session.costAtLeast === true,
      session.status,
      session.unread === true,
      session.cacheWarm === true,
      session.runByAgent === true,
      session.archived === true,
      session.active === true,
      session.cacheExpiryCount ?? null,
      session.cacheExpiryAtLeast === true
    );
    if (!unwanted.every(holds)) {
      return false;
    }
    if (!wanted.length) {
      return true;
    }
    return match === "any" ? wanted.some(holds) : wanted.every(holds);
  });
}
export {
  FIND_PREFIX,
  IS_PREFIX,
  IS_SYNONYMS,
  IS_VALUES,
  LABEL_PREFIX,
  NEGATE_MARK,
  NUMERIC_FIELDS,
  SESSION_AXES,
  WHERE_PREFIX,
  WHERE_SYNONYMS,
  WHERE_VALUES,
  canStartSearch,
  isQueryMatch,
  isSearch,
  matchSessions,
  parseSessionQuery,
  queryToken,
  queryTokens,
  quoteQueryValue,
  railStatusRuns,
  replaceToken,
  sameQueryTerms,
  sessionTermHolds,
  termNarrows,
  withWhere
};
