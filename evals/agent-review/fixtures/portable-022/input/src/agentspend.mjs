import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
function emptyUsage() {
  return {
    requests: 0,
    input: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0
  };
}
function addUsageCounts(into, add) {
  into.requests = (into.requests ?? 0) + (add.requests ?? 0);
  into.input += add.input;
  into.cacheWrite1h += add.cacheWrite1h;
  into.cacheWrite5m += add.cacheWrite5m;
  into.cacheWrite30m = (into.cacheWrite30m ?? 0) + (add.cacheWrite30m ?? 0);
  into.cacheRead += add.cacheRead;
  into.output += add.output;
  into.thinking += add.thinking;
}
function addUsage(into, add, contextBand = null) {
  addUsageCounts(into, add);
  if (contextBand) {
    const held = into.byContextBand?.[contextBand] ?? emptyUsage();
    addUsageCounts(held, add);
    (into.byContextBand ??= {})[contextBand] = held;
    return;
  }
  for (const band of ["short", "long"]) {
    const bandUsage = add.byContextBand?.[band];
    if (!bandUsage) {
      continue;
    }
    const held = into.byContextBand?.[band] ?? emptyUsage();
    addUsageCounts(held, bandUsage);
    (into.byContextBand ??= {})[band] = held;
  }
}
function usageTokens(usage) {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead + usage.output;
}
function spendTokens(spend) {
  return spend.reduce((total, part) => total + usageTokens(part.usage) + (part.unclassifiedCacheWrite ?? 0), 0);
}
function agentSpendIsOpen(status) {
  return status === "running" || status === "async_launched" || status === "launched";
}
function addModelUsage(byModel, model, usage, contextBand = null) {
  const held = byModel.get(model) ?? emptyUsage();
  addUsage(held, usage, contextBand);
  byModel.set(model, held);
}
function modelSpends(byModel, provider = null) {
  return [...byModel].filter(([, usage]) => usageTokens(usage) > 0).map(([model, usage]) => ({
    model,
    ...provider ? { provider } : {},
    usage
  }));
}
const OPEN_SPEND_BAND_MS = 5e3;
const OPEN_SPEND_BYTES_PER_MS = 1e3;
function openSpendBandMs(bytes) {
  let band = OPEN_SPEND_BAND_MS;
  while (band * OPEN_SPEND_BYTES_PER_MS < bytes) {
    band *= 2;
  }
  return band;
}
function openSpendBand(version, now) {
  let newest = -Infinity;
  let bytes = 0;
  for (const line of version.split("\n")) {
    const fields = line.split(":");
    const written = Number(fields[fields.length - 1]);
    const size = Number(fields[fields.length - 2]);
    if (fields.length < 2 || !Number.isFinite(written) || !Number.isFinite(size)) {
      continue;
    }
    newest = Math.max(newest, written);
    bytes += size;
  }
  if (!Number.isFinite(newest)) {
    return "none";
  }
  const bandMs = openSpendBandMs(bytes);
  return now - newest > bandMs ? null : `${bandMs}:${Math.floor(newest / bandMs)}`;
}
function readChildSpend(cache, file, status, version, load, parseKey, versioned, now) {
  const open = agentSpendIsOpen(status);
  const band = open ? openSpendBand(version, now) : null;
  const key = versioned ? `${parseKey}
${band === null ? version : "open"}` : parseKey;
  const spend = cache.read(file, load, key, band ?? void 0);
  if (!open) {
    return spend;
  }
  return {
    models: spend.models,
    found: spend.found,
    partial: spend.partial,
    effort: spend.effort,
    ...spend.usageIncomplete ? { usageIncomplete: true } : {}
  };
}
function spendFileVersion(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : "not-file";
  } catch {
    return "missing";
  }
}
function scanLines(file, visit) {
  let fd = -1;
  let readWholeFile = false;
  try {
    fd = fs.openSync(file, "r");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let held = [];
    let stopped = false;
    const emit = (tail) => {
      const line = held.length ? held.join("") + tail : tail;
      held = [];
      return visit(line.endsWith("\r") ? line.slice(0, -1) : line) === true;
    };
    while (!stopped) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) {
        break;
      }
      const decoded = decoder.write(chunk.subarray(0, read));
      let start = 0;
      for (let end = decoded.indexOf("\n"); end >= 0 && !stopped; end = decoded.indexOf("\n", start)) {
        stopped = emit(decoded.slice(start, end));
        start = end + 1;
      }
      if (start < decoded.length) {
        held.push(decoded.slice(start));
      }
    }
    if (stopped) {
      return false;
    }
    const final = decoder.end();
    if (final) {
      held.push(final);
    }
    if (held.length) {
      emit("");
    }
    readWholeFile = true;
  } catch {
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
  return readWholeFile;
}
class AgentSpendCache {
  constructor(limit = 200) {
    this.limit = limit;
  }
  entries = /* @__PURE__ */ new Map();
  // A running child passes its `openSpendBand` as `band`. Its entry then answers every read in
  // that band, however often the child writes, so the child is read at most once a band.
  read(file, load, parseKey = "", band) {
    let stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) {
        this.entries.delete(file);
        return { models: [], found: false, partial: false, effort: null };
      }
    } catch {
      this.entries.delete(file);
      return { models: [], found: false, partial: false, effort: null };
    }
    const revision = band === void 0 ? `${stat.size}:${stat.mtimeMs}` : `band:${band}`;
    const hit = this.entries.get(file);
    if (hit && hit.revision === revision && hit.parseKey === parseKey) {
      this.entries.delete(file);
      this.entries.set(file, hit);
      return hit.value;
    }
    const value = load(file);
    this.entries.delete(file);
    this.entries.set(file, { revision, parseKey, value });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) {
        break;
      }
      this.entries.delete(oldest);
    }
    return value;
  }
}
export {
  AgentSpendCache,
  OPEN_SPEND_BAND_MS,
  OPEN_SPEND_BYTES_PER_MS,
  addModelUsage,
  addUsage,
  agentSpendIsOpen,
  emptyUsage,
  modelSpends,
  openSpendBand,
  openSpendBandMs,
  readChildSpend,
  scanLines,
  spendFileVersion,
  spendTokens,
  usageTokens
};
