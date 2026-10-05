import * as fs from "node:fs";
import * as path from "node:path";
import {
  retainNewestCompaction,
  STEP_CUT,
  STEP_DETAIL_LIMIT,
  TURN_ASK_LIMIT,
  TURN_START_BYTES,
  TURN_STEP_LIMIT,
  stepDetail,
  presentedStepDetail,
  addTurnSkillUse,
  cleanPrompt,
  countLines,
  firstLine,
  isEphemeralPath,
  isInside,
  normalizeFsPath,
  sameCommitSha,
  normalizeSessionTitle,
  normalizeFullSessionTitle,
  readTurnStartsFromTail,
  recordCommits,
  shortenTo,
  tailOf,
  tallyToolName,
  activityIn,
  discoverBackwardBoundary,
  readPreviousLines,
  addTurnUsagePart,
  sessionStatFactsOf,
  setTurnStepStatus,
  headLines
} from "./transcript.mjs";
import {
  addUsage,
  emptyUsage,
  spendFileVersion,
  scanLines
} from "./agentspend.mjs";
import {
  childToolCalls,
  cloneChildArtifacts,
  lastLineWhole,
  reduceChildArtifacts,
  UNNAMED_TOOL
} from "./childartifacts.mjs";
import {
  BEDROCK_LIST_COST_BASIS,
  bedrockClaudeListMultiplier,
  cacheLifetimeFor,
  contextBandForRequest
} from "./pricing.mjs";
import {
  applyHiddenParserState,
  cloneParserState,
  hiddenParserState,
  RETAINED_COMPACTIONS
} from "./parserstate.mjs";
import { ARC_IDENTITY } from "./identity.mjs";
import { codexHome } from "./agentpaths.mjs";
import { parseQuestionReply } from "./codexreply.mjs";
function codexSessionsRoot() {
  return process.env[`${ARC_IDENTITY.environmentPrefix}CODEX_ROOT`] || path.join(codexHome(), "sessions");
}
const COLD_OPENING_READS = 8;
const REFUSED_OPENING_RETRY_MS = 3e4;
const REFUSED_OPENING_FIRST_RETRY_MS = 1e3;
class CodexMetaCache {
  constructor(readMeta = readCodexOpening, sizeOf = fileSize, now = () => performance.now()) {
    this.readMeta = readMeta;
    this.sizeOf = sizeOf;
    this.now = now;
  }
  entries = /* @__PURE__ */ new Map();
  changed = 0;
  get(file) {
    const hit = this.entries.get(file);
    if (hit?.meta) {
      return hit.meta;
    }
    let size = null;
    if (hit && hit.meta === void 0) {
      const elapsed = this.now() - hit.triedAt;
      if (elapsed >= 0 && elapsed < hit.wait) {
        return null;
      }
    } else if (hit) {
      size = this.sizeOf(file);
      if (size === null || hit.size !== null && hit.size === size) {
        return null;
      }
    }
    const meta = this.readMeta(file);
    if (meta === void 0) {
      const wait = hit && hit.meta === void 0 ? REFUSED_OPENING_RETRY_MS : REFUSED_OPENING_FIRST_RETRY_MS;
      this.entries.set(file, { meta: void 0, triedAt: this.now(), wait });
      return null;
    }
    this.entries.set(file, meta ? { meta } : { meta: null, size });
    if (meta) {
      this.changed += 1;
    }
    return meta;
  }
  // Reads the opening record of every file this cache holds no answer for, `limit` at a time, and
  // settles once every read has. Each read leaves the main thread free while the disk works, so
  // a machine of cold rollouts no longer stalls the editor. A file that `get` read meanwhile
  // keeps that answer. A read that finds no record leaves the retry marker a first `get` leaves,
  // with the size measured off the main thread. `get` then reads the file again only after it
  // grows. A file `get` found refused, before or during the pass, has no answer, so the pass reads
  // it and its answer replaces the refusal entry. A read that rejects leaves the entry as it was,
  // because a file another process holds for a moment says nothing about its head. The next `get`
  // reads a file with no entry as a file the pass never reached, and a file with a refusal entry
  // after that entry's wait. True when the pass added a row the stored records lacked.
  async prime(files, readAsync = readCodexSessionMetaAsync, limit = COLD_OPENING_READS, sizeAsync = fileSizeAsync) {
    const missing = files.filter((file) => this.entries.get(file)?.meta === void 0);
    const before = this.changed;
    let next = 0;
    const lane = async () => {
      const buf = Buffer.allocUnsafe(META_BYTES);
      while (next < missing.length) {
        const file = missing[next++];
        let meta;
        try {
          meta = await readAsync(file, buf);
        } catch {
          continue;
        }
        const size = meta ? null : await sizeAsync(file).catch(() => null);
        if (this.entries.get(file)?.meta !== void 0) {
          continue;
        }
        this.entries.set(file, meta ? { meta } : { meta: null, size });
        if (meta) {
          this.changed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, missing.length) }, lane));
    return this.changed !== before;
  }
  keys() {
    return this.entries.keys();
  }
  get revision() {
    return this.changed;
  }
  delete(file) {
    const hit = this.entries.get(file);
    const deleted = this.entries.delete(file);
    if (deleted && hit?.meta) {
      this.changed += 1;
    }
    return deleted;
  }
  // Persist only readable opening records. A failed opening read is a retry marker whose
  // answer can change without the file growing, so it must not survive a window restart.
  snapshot() {
    return [...this.entries].flatMap(([file, entry]) => entry.meta ? [[file, entry.meta]] : []);
  }
  // Restore positive entries from the machine's stored opening records. Validation belongs to
  // the cache reader, while this method keeps the retry-marker representation private to this
  // class.
  load(entries) {
    for (const [file, meta] of entries) {
      this.entries.set(file, { meta });
    }
  }
}
function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}
async function fileSizeAsync(file) {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return null;
  }
}
function isHiddenThread(meta) {
  return isGuardianSource(meta.threadSource, meta.subagentKind);
}
function isGuardianSource(threadSource, subagentKind) {
  return threadSource === "guardian_review" || threadSource === "subagent" && subagentKind === "guardian";
}
function isAgentRun(meta) {
  return meta.launchSource === "exec" || meta.threadSource === "subagent" || meta.parentThreadId !== null || meta.hasSubagentSource;
}
const META_BYTES = 128 * 1024;
const TITLE_BYTES = 512 * 1024;
const WALK_DEPTH = 4;
const FIRST_LINE_WINDOW = 16 * 1024;
let headBuffer = null;
function firstLineStep(buf, have, read, want) {
  const newline = buf.subarray(0, have + read).indexOf(10, have);
  if (newline >= 0) {
    return buf.toString("utf8", 0, newline);
  }
  if (read < want) {
    return buf.toString("utf8", 0, have + read);
  }
  return have + read >= META_BYTES ? null : void 0;
}
function firstLineOf(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const buf = headBuffer ??= Buffer.allocUnsafe(META_BYTES);
    let have = 0;
    let window = FIRST_LINE_WINDOW;
    for (; ; ) {
      const want = window - have;
      const read = fs.readSync(fd, buf, have, want, have);
      const line = firstLineStep(buf, have, read, want);
      if (line !== void 0) {
        return line;
      }
      have += read;
      window = Math.min(window * 2, META_BYTES);
    }
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
async function firstLineOfAsync(file, buf) {
  let handle = null;
  try {
    handle = await fs.promises.open(file, "r");
    let have = 0;
    let window = FIRST_LINE_WINDOW;
    for (; ; ) {
      const want = window - have;
      const { bytesRead: read } = await handle.read(buf, have, want, have);
      const line = firstLineStep(buf, have, read, want);
      if (line !== void 0) {
        return line;
      }
      have += read;
      window = Math.min(window * 2, META_BYTES);
    }
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
function readCodexOpeningRecord(file) {
  let line;
  try {
    line = firstLineOf(file);
  } catch {
    return void 0;
  }
  return openingRecordOf(line);
}
function openingRecordOf(line) {
  if (!line || line.indexOf("session_meta") < 0) {
    return null;
  }
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o.type !== "session_meta" || !o.payload) {
    return null;
  }
  const p = o.payload;
  const source = p.source;
  const subagent = isRecord(source) && isRecord(source.subagent) ? source.subagent : null;
  const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const openedAt = stamp(o.timestamp) || null;
  const threadSource = str(p.thread_source);
  const subagentKind = str(subagent?.other);
  return {
    sessionId: str(p.id) ?? str(p.session_id),
    cwd: str(p.cwd),
    modelProvider: str(p.model_provider),
    openedAt,
    startedAt: codexStartedAt(openedAt, p, threadSource, subagentKind),
    replayBoundaryAt: codexReplayBoundaryAt(openedAt, p, threadSource, subagentKind),
    launchSource: str(source),
    threadSource,
    parentThreadId: str(p.parent_thread_id) ?? str(spawn?.parent_thread_id),
    agentPath: codexAgentPath(p),
    subagentKind,
    hasSubagentSource: subagent !== null
  };
}
function codexAgentPath(payload) {
  const source = payload.source;
  const subagent = isRecord(source) && isRecord(source.subagent) ? source.subagent : null;
  const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  return str(payload.agent_path) ?? str(spawn?.agent_path);
}
function readCodexSessionMeta(file) {
  return readCodexOpeningRecord(file) ?? null;
}
function readCodexOpening(file) {
  return readCodexOpeningRecord(file);
}
async function readCodexSessionMetaAsync(file, buf) {
  return openingRecordOf(await firstLineOfAsync(file, buf));
}
function str(value) {
  return typeof value === "string" && value ? value : null;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function guardianPayloadAt(payload, threadSource = str(payload.thread_source), subagentKind = str(
  isRecord(payload.source) && isRecord(payload.source.subagent) ? payload.source.subagent.other : null
)) {
  return isGuardianSource(threadSource, subagentKind) ? stamp(payload.timestamp) || null : null;
}
function codexStartedAt(openedAt, payload, threadSource, subagentKind) {
  return guardianPayloadAt(payload, threadSource, subagentKind) ?? openedAt;
}
const CODEX_REPLAY_CLOCK_SLACK_MS = 5e3;
const CODEX_TURN_START_ROUNDING_MS = 1e3;
function codexReplayBoundaryAt(openedAt, payload, threadSource, subagentKind) {
  const payloadAt = guardianPayloadAt(payload, threadSource, subagentKind);
  return payloadAt === null ? openedAt : payloadAt + CODEX_REPLAY_CLOCK_SLACK_MS - CODEX_TURN_START_ROUNDING_MS;
}
const ROLLOUT_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
function rolloutFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < WALK_DEPTH) {
          walk(full, depth + 1);
        }
      } else if (entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}
function readRolloutStat(file) {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
  } catch {
    return null;
  }
}
const CODEX_STAT_ACTIVE_MS = 10 * 6e4;
const CODEX_STAT_REVALIDATE_MS = 6e4;
class CodexStatCache {
  constructor(statOf = readRolloutStat, now = Date.now) {
    this.statOf = statOf;
    this.now = now;
  }
  entries = /* @__PURE__ */ new Map();
  get(file) {
    const at = this.now();
    const held = this.entries.get(file);
    if (held && held.stat.mtimeMs < at - CODEX_STAT_ACTIVE_MS && at - held.readAt < CODEX_STAT_REVALIDATE_MS) {
      return held.stat;
    }
    const stat = this.statOf(file);
    if (stat) {
      this.entries.set(file, { stat, readAt: at });
    } else {
      this.entries.delete(file);
    }
    return stat;
  }
  // A watcher event with no file name stands for every file in its directory.
  markChanged(directory, filename) {
    if (typeof filename === "string") {
      this.entries.delete(path.join(directory, filename));
      return;
    }
    for (const file of [...this.entries.keys()]) {
      if (path.dirname(file) === directory) {
        this.entries.delete(file);
      }
    }
  }
  keys() {
    return this.entries.keys();
  }
  delete(file) {
    return this.entries.delete(file);
  }
  clear() {
    this.entries.clear();
  }
}
async function coldOpeningPass(cache, root) {
  const walked = rolloutFiles(root);
  return { walked, read: await cache.prime(walked) };
}
function codexSessionFiles(root, folders, metaOf = readCodexSessionMeta, statOf = readRolloutStat, walked = rolloutFiles(root)) {
  if (folders.length === 0) {
    return { sessions: [], sources: [], subagents: [], walked };
  }
  const out = [];
  const sources = [];
  const subagents = [];
  for (const file of walked) {
    const meta = metaOf(file);
    if (!meta || !meta.cwd || !isInside(meta.cwd, folders)) {
      continue;
    }
    sources.push({ file });
    const structuralChild = meta.threadSource === "subagent" || meta.parentThreadId !== null || meta.hasSubagentSource;
    if (structuralChild && meta.sessionId) {
      subagents.push({
        file,
        threadId: meta.sessionId,
        parentThreadId: meta.parentThreadId,
        agentPath: meta.agentPath,
        openedAt: meta.openedAt,
        startedAt: meta.startedAt,
        threadSource: meta.threadSource,
        backgroundReview: isHiddenThread(meta)
      });
    }
    if (isHiddenThread(meta)) {
      continue;
    }
    const stat = statOf(file);
    if (!stat || !stat.isFile || stat.size === 0) {
      continue;
    }
    const named = ROLLOUT_NAME.exec(path.basename(file));
    out.push({
      agent: "codex",
      file,
      sessionId: meta.sessionId || (named ? named[1] : path.basename(file, ".jsonl")),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      cwd: meta.cwd,
      // A manually launched `codex exec` has the same record as a headless dispatch and is
      // grouped the same way; there is no parent field with which to tell them apart.
      agentRun: isAgentRun(meta)
    });
  }
  return { sessions: out.sort((a, b) => b.mtimeMs - a.mtimeMs), sources, subagents, walked };
}
function staleMetas(cached, walked) {
  const seen = new Set(walked);
  return [...cached].filter((file) => !seen.has(file));
}
function readCodexSessionTitle(file, bytes = TITLE_BYTES) {
  return readCodexSessionTitlePair(file, bytes).short;
}
function readCodexSessionTitlePair(file, bytes = TITLE_BYTES) {
  const lines = headLines(file, bytes);
  const opening = lines.length ? parseRecord(lines[0]) : null;
  const agentPath = opening?.kind === "session_meta" ? codexAgentPath(opening.payload) : null;
  for (const line of lines) {
    if (!carriesUserMessage(line) && !carriesDelegation(line)) {
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      continue;
    }
    const source = codexPrompt(userMessage(record) ?? "") || codexDelegation(record, agentPath)?.text || "";
    const short = normalizeSessionTitle(source);
    if (short) {
      return { short, full: normalizeFullSessionTitle(source) };
    }
  }
  return { short: null, full: null };
}
function readCodexSessionActivity(file, bytes = 256 * 1024, statsFor) {
  const tail = tailOf(file, bytes);
  const meta = statsFor ? statsFor.meta : readCodexSessionMeta(file);
  return {
    activityMs: activityIn(tail.lines),
    outcome: codexOutcomeIn(tail.lines, meta?.agentPath ?? null),
    ...statsFor ? {
      stats: sessionStatFactsOf(
        readCodexSessionLines(tail.lines, statsFor.sessionId, { maxTurns: 40 }, tail.readBytes, statsFor.meta)
      )
    } : {}
  };
}
function codexSessionIndexPath() {
  return path.join(path.dirname(codexSessionsRoot()), "session_index.jsonl");
}
function parseThreadNamePairs(text) {
  const names = /* @__PURE__ */ new Map();
  const fullNames = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    if (line.indexOf("thread_name") < 0) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const id = str(row.id);
    const name = str(row.thread_name);
    if (!id || !name) {
      continue;
    }
    const title = normalizeSessionTitle(name);
    const fullTitle = normalizeFullSessionTitle(name);
    if (title && fullTitle) {
      names.set(id, title);
      fullNames.set(id, fullTitle);
    } else {
      names.delete(id);
      fullNames.delete(id);
    }
  }
  return { names, fullNames };
}
function parseThreadNames(text) {
  return parseThreadNamePairs(text).names;
}
function readThreadNames(file, held) {
  let stamp2 = "";
  try {
    const st = fs.statSync(file);
    stamp2 = `${st.size}:${st.mtimeMs}`;
  } catch {
  }
  if (held && held.stamp === stamp2) {
    return held;
  }
  if (!stamp2) {
    return { stamp: stamp2, names: /* @__PURE__ */ new Map(), fullNames: /* @__PURE__ */ new Map() };
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    return { stamp: stamp2, ...parseThreadNamePairs(text) };
  } catch {
    return { stamp: "", names: /* @__PURE__ */ new Map(), fullNames: /* @__PURE__ */ new Map() };
  }
}
function codexTitleFor(names, sessionId, fromRollout) {
  return names.get(sessionId) || fromRollout || null;
}
const IDE_REQUEST = "## My request for Codex:";
function codexPrompt(raw) {
  const at = raw.lastIndexOf(IDE_REQUEST);
  return cleanPrompt(at < 0 ? raw : raw.slice(at + IDE_REQUEST.length));
}
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function hunksFromUnifiedDiff(diff) {
  const hunks = [];
  let current = null;
  for (const raw of diff.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === void 0 ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === void 0 ? 1 : Number(header[4]),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current || raw === "") {
      continue;
    }
    current.lines.push(raw);
  }
  return hunks;
}
const TOOL_KIND = {
  apply_patch: "edits",
  web_search: "web",
  exec: "commands",
  shell_command: "commands",
  exec_command: "commands",
  run: "commands",
  spawn_agent: "agents",
  wait_agent: "coordination",
  send_message: "coordination",
  list_agents: "coordination",
  interrupt_agent: "coordination",
  followup_task: "coordination"
};
function emptyToolCounts() {
  return { edits: 0, reads: 0, searches: 0, commands: 0, agents: 0, coordination: 0, web: 0, other: 0 };
}
const SCRIPT_ERROR = "Script error:";
const EXIT_CODE = /^Exit code:/;
function scriptFailure(output) {
  const at = output.indexOf(SCRIPT_ERROR);
  if (at < 0) {
    return null;
  }
  const detail = output.slice(at + SCRIPT_ERROR.length).split("\n").map((l) => l.trim()).find(Boolean) || "";
  if (!detail || EXIT_CODE.test(detail)) {
    return null;
  }
  return shortenTo(detail, 160, "...");
}
function outputText(output) {
  if (typeof output === "string") {
    return output;
  }
  if (!Array.isArray(output)) {
    return "";
  }
  return output.map((b) => String(b?.text ?? "")).filter(Boolean).join("\n");
}
function spawnResult(output) {
  try {
    const result = JSON.parse(output);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    if (typeof result.task_name === "string") {
      return { id: null, description: null };
    }
    if (typeof result.agent_id === "string" && typeof result.nickname === "string") {
      return { id: result.agent_id, description: result.nickname };
    }
  } catch {
  }
  return null;
}
function currentSpawnFailure(output) {
  const message = firstLine(output);
  if (/^collab spawn failed:/i.test(message)) {
    return message;
  }
  try {
    const result = JSON.parse(output);
    if (typeof result.error === "string" && result.error.trim()) {
      return firstLine(result.error);
    }
    if (isRecord(result.error) && typeof result.error.message === "string" && result.error.message.trim()) {
      return errorMessage(output);
    }
  } catch {
  }
  return null;
}
function errorMessage(raw) {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const envelope = JSON.parse(text);
      const inner = str(envelope.error?.message) ?? str(envelope.message);
      if (inner) {
        return firstLine(inner);
      }
    } catch {
    }
  }
  return firstLine(text);
}
function stamp(value) {
  const t = Date.parse(String(value || ""));
  return Number.isNaN(t) ? 0 : t;
}
const FINAL_ANSWER = "FINAL_ANSWER";
const LAUNCHED = "launched";
const CODEX_USAGE_ASSOCIATION_LIMIT = 64;
function emptyCodexUsageReducerState(provider = null, openingTimestamp = null, openingSessionId = null, agentPath = null) {
  return {
    provider,
    openingTimestamp,
    openingSessionId,
    agentPath,
    foreignSessionMeta: false,
    currentTurnId: null,
    currentTurnCopied: false,
    recentTurnIds: [],
    seenTurnIds: {},
    seenTurnOffsets: {},
    legacyReplayLinks: [],
    replayResetRequired: false,
    copiedTurnIds: {},
    datedCopiedTurnIds: {},
    countedTurnIds: {},
    turnModels: {},
    turnEfforts: {},
    turnWindows: {},
    planType: null,
    planKnown: false,
    serviceTier: null,
    reasoningEffort: null,
    requestNumber: 0,
    lastUsageSnapshot: null,
    pendingRequests: {},
    pendingRequestKeys: [],
    pendingRequestSources: {},
    recentClaudeInvocationIds: [],
    seenClaudeInvocations: {},
    recentClaudeCommandIds: [],
    seenClaudeCommands: {},
    pendingClaudeResultIds: [],
    pendingClaudeResults: {},
    closedTurns: 0,
    currentTurnDidSomething: false,
    currentTurnCompleted: false,
    compactionCount: 0,
    recentCompactions: [],
    compactionTurnOrdinals: {},
    pendingCompactionBilling: null,
    firstTurnAt: null,
    lastTurnAt: null,
    currentTurnStartedAt: null,
    currentTurnEndedAt: null,
    currentTurnOutcome: null,
    lastTurnStartedAt: null,
    lastTurnOutcome: null
  };
}
function rememberRecentIdentity(ids, id) {
  const prior = ids.indexOf(id);
  if (prior >= 0) {
    ids.splice(prior, 1);
  }
  ids.push(id);
}
function synchronizeIdentityQueue(ids, current) {
  const present = new Set(current);
  for (let index = ids.length - 1; index >= 0; index--) {
    if (!present.has(ids[index])) {
      ids.splice(index, 1);
    }
  }
  const remembered = new Set(ids);
  for (const id of current) {
    if (!remembered.has(id)) {
      ids.push(id);
      remembered.add(id);
    }
  }
}
function forgetIdentity(ids, id) {
  const index = ids.indexOf(id);
  if (index >= 0) {
    ids.splice(index, 1);
  }
}
function discardPendingRequestKey(state, requestKey) {
  forgetIdentity(state.pendingRequestKeys, requestKey);
  delete state.pendingRequestSources[requestKey];
}
function releasePendingRequest(state, requestKey) {
  for (const [turnId, events] of Object.entries(state.pendingRequests)) {
    const index = events.findIndex((event2) => event2.requestKey === requestKey);
    if (index < 0) {
      continue;
    }
    const [event] = events.splice(index, 1);
    if (events.length === 0) {
      delete state.pendingRequests[turnId];
    }
    discardPendingRequestKey(state, requestKey);
    return event;
  }
  discardPendingRequestKey(state, requestKey);
  return null;
}
function synchronizeCodexSpendAssociations(state) {
  synchronizeIdentityQueue(state.recentTurnIds, Object.keys(state.seenTurnIds));
  if (state.currentTurnId && state.seenTurnIds[state.currentTurnId]) {
    rememberRecentIdentity(state.recentTurnIds, state.currentTurnId);
  }
  synchronizeIdentityQueue(
    state.pendingRequestKeys,
    Object.values(state.pendingRequests).flatMap((events) => events.map((event) => event.requestKey))
  );
  synchronizeIdentityQueue(state.recentClaudeInvocationIds, Object.keys(state.seenClaudeInvocations));
  synchronizeIdentityQueue(state.recentClaudeCommandIds, Object.keys(state.seenClaudeCommands));
  synchronizeIdentityQueue(state.pendingClaudeResultIds, Object.keys(state.pendingClaudeResults));
}
function compactCodexSpendAssociations(state) {
  const released = [];
  while (state.recentTurnIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const turnId = state.recentTurnIds.shift();
    if (!turnId) {
      continue;
    }
    for (const event of state.pendingRequests[turnId] ?? []) {
      released.push(event);
      discardPendingRequestKey(state, event.requestKey);
    }
    delete state.pendingRequests[turnId];
    delete state.seenTurnIds[turnId];
    delete state.seenTurnOffsets[turnId];
    delete state.copiedTurnIds[turnId];
    delete state.datedCopiedTurnIds[turnId];
    delete state.countedTurnIds[turnId];
    delete state.turnModels[turnId];
    delete state.turnEfforts[turnId];
    delete state.turnWindows[turnId];
    delete state.compactionTurnOrdinals[turnId];
    state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => link.id !== turnId);
  }
  const retainedTurnIds = new Set(state.recentTurnIds);
  for (const turnId of Object.keys(state.pendingRequests)) {
    if (retainedTurnIds.has(turnId)) {
      continue;
    }
    for (const event of state.pendingRequests[turnId]) {
      released.push(event);
      discardPendingRequestKey(state, event.requestKey);
    }
    delete state.pendingRequests[turnId];
  }
  for (const association of [
    state.seenTurnOffsets,
    state.copiedTurnIds,
    state.datedCopiedTurnIds,
    state.countedTurnIds,
    state.turnModels,
    state.turnEfforts,
    state.turnWindows
  ]) {
    for (const turnId of Object.keys(association)) {
      if (!retainedTurnIds.has(turnId)) {
        delete association[turnId];
      }
    }
  }
  for (const turnId of Object.keys(state.compactionTurnOrdinals)) {
    if (!retainedTurnIds.has(turnId)) {
      delete state.compactionTurnOrdinals[turnId];
    }
  }
  state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => retainedTurnIds.has(link.id));
  while (state.pendingRequestKeys.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const requestKey = state.pendingRequestKeys[0];
    const event = releasePendingRequest(state, requestKey);
    if (event) {
      released.push(event);
    }
  }
  while (state.recentClaudeInvocationIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const id = state.recentClaudeInvocationIds.shift();
    if (id) {
      delete state.seenClaudeInvocations[id];
    }
  }
  while (state.recentClaudeCommandIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const id = state.recentClaudeCommandIds.shift();
    if (id) {
      delete state.seenClaudeCommands[id];
    }
  }
  while (state.pendingClaudeResultIds.length > CODEX_USAGE_ASSOCIATION_LIMIT) {
    const id = state.pendingClaudeResultIds.shift();
    if (id) {
      delete state.pendingClaudeResults[id];
    }
  }
  return released;
}
function recordedTurnStart(payload) {
  const value = num(payload.started_at);
  if (value === null || value <= 0) {
    return null;
  }
  return value < 1e10 ? value * 1e3 : value;
}
function utcDate(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}
function recordedDatePredatesOpening(value, state) {
  if (state.openingTimestamp === null || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const previousDate = utcDate(state.openingTimestamp - 24 * 60 * 60 * 1e3);
  if (value < previousDate) {
    return true;
  }
  if (value !== previousDate) {
    return false;
  }
  const utcHour = new Date(state.openingTimestamp).getUTCHours();
  return utcHour >= 12 || state.foreignSessionMeta;
}
function pruneCodexReplayLedger(state, replayFloor) {
  state.legacyReplayLinks = state.legacyReplayLinks.filter((link) => {
    if (link.replayOffset < replayFloor) {
      return false;
    }
    if (link.evidenceOffset < replayFloor) {
      state.replayResetRequired = true;
      return false;
    }
    return true;
  });
  for (const id of Object.keys(state.seenTurnIds)) {
    const offset = state.seenTurnOffsets[id];
    if (offset === void 0 ? replayFloor > 0 : offset < replayFloor) {
      delete state.seenTurnIds[id];
      delete state.seenTurnOffsets[id];
    }
  }
}
function beginCodexTurn(state, payload, sourceStart) {
  const turnId = str(payload.turn_id);
  const repeated = turnId !== null && state.seenTurnIds[turnId];
  const evidenceOffset = turnId === null ? void 0 : state.seenTurnOffsets[turnId];
  const startedAt = recordedTurnStart(payload);
  const copiedByClock = startedAt !== null && state.openingTimestamp !== null && startedAt < state.openingTimestamp - CODEX_REPLAY_CLOCK_SLACK_MS;
  if (startedAt !== null && !copiedByClock) {
    state.foreignSessionMeta = false;
  }
  state.currentTurnId = turnId;
  state.currentTurnCopied = repeated || copiedByClock;
  if (turnId) {
    if (repeated && !copiedByClock && sourceStart !== void 0 && evidenceOffset !== void 0) {
      state.legacyReplayLinks.push({ id: turnId, evidenceOffset, replayOffset: sourceStart });
    }
    state.seenTurnIds[turnId] = true;
    if (sourceStart !== void 0) {
      state.seenTurnOffsets[turnId] = sourceStart;
    }
    if (state.currentTurnCopied) {
      state.copiedTurnIds[turnId] = true;
    }
  }
}
function discardPendingCodexRequests(state, turnId) {
  for (const event of state.pendingRequests[turnId] ?? []) {
    delete state.pendingRequestSources[event.requestKey];
  }
  delete state.pendingRequests[turnId];
}
function retractCodexUsageCompactions(state, ordinals) {
  const retracted = new Set(ordinals);
  if (!retracted.size) {
    return;
  }
  const earlierRetracted = (ordinal) => [...retracted].filter((item) => item < ordinal).length;
  state.compactionCount = Math.max(0, state.compactionCount - retracted.size);
  state.recentCompactions = state.recentCompactions.filter((item) => !retracted.has(item.ordinal)).map((item) => ({ ...item, ordinal: item.ordinal - earlierRetracted(item.ordinal) }));
  for (const [id, associated] of Object.entries(state.compactionTurnOrdinals)) {
    const kept = associated.filter((ordinal) => !retracted.has(ordinal)).map((ordinal) => ordinal - earlierRetracted(ordinal));
    if (kept.length) {
      state.compactionTurnOrdinals[id] = kept;
    } else {
      delete state.compactionTurnOrdinals[id];
    }
  }
  if (state.pendingCompactionBilling !== null) {
    state.pendingCompactionBilling = retracted.has(state.pendingCompactionBilling) ? null : state.pendingCompactionBilling - earlierRetracted(state.pendingCompactionBilling);
  }
}
function applyCodexTurnDate(state, payload) {
  const turnId = str(payload.turn_id);
  if (!turnId || state.copiedTurnIds[turnId]) {
    return;
  }
  if (!recordedDatePredatesOpening(payload.current_date, state)) {
    return;
  }
  state.copiedTurnIds[turnId] = true;
  state.datedCopiedTurnIds[turnId] = true;
  const compactionOrdinals = state.compactionTurnOrdinals[turnId] ?? [];
  if (compactionOrdinals.length) {
    retractCodexUsageCompactions(state, compactionOrdinals);
  }
  if (turnId === state.currentTurnId) {
    state.currentTurnCopied = true;
    state.currentTurnOutcome = null;
  }
  if (state.countedTurnIds[turnId]) {
    state.closedTurns = Math.max(0, state.closedTurns - 1);
    delete state.countedTurnIds[turnId];
    state.firstTurnAt = null;
    state.lastTurnAt = null;
    state.lastTurnStartedAt = null;
    state.lastTurnOutcome = null;
  }
  discardPendingCodexRequests(state, turnId);
}
function bedrockInferenceClass(model) {
  if (!model || !/openai\.gpt-5\.6-(?:sol|terra|luna)$/.test(model)) {
    return null;
  }
  if (model.startsWith("global.")) {
    return "global";
  }
  if (/^[a-z]{2}\./.test(model)) {
    return "geo";
  }
  return "in-region";
}
function requestInputTokens(usage) {
  return usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead;
}
function codexRequestUsage(value) {
  if (!isRecord(value)) {
    return null;
  }
  const input = num(value.input_tokens);
  const cached = num(value.cached_input_tokens);
  const written = num(value.cache_write_input_tokens);
  const output = num(value.output_tokens);
  const thinking = num(value.reasoning_output_tokens);
  if (input === null && cached === null && written === null && output === null && thinking === null) {
    return null;
  }
  const usage = emptyUsage();
  usage.requests = 1;
  usage.input = Math.max(0, (input ?? 0) - (cached ?? 0) - (written ?? 0));
  usage.cacheRead = cached ?? 0;
  usage.cacheWrite30m = written ?? 0;
  usage.output = output ?? 0;
  usage.thinking = thinking ?? 0;
  return usage;
}
const CODEX_USAGE_COUNTERS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];
function codexUsageCounters(value) {
  if (!isRecord(value)) {
    return null;
  }
  const counters = CODEX_USAGE_COUNTERS.map((key) => num(value[key]));
  return counters.every((counter) => counter !== null) ? counters : null;
}
function sameCounters(left, right) {
  return left.length === right.length && left.every((counter, index) => counter === right[index]);
}
function reduceCodexUsageEvents(state, record) {
  const { kind, payload } = record;
  if (kind === "session_meta") {
    const sessionId = str(payload.id) ?? str(payload.session_id);
    if (state.openingTimestamp === null) {
      const replayBoundaryAt = codexReplayBoundaryAt(record.timestamp || null, payload);
      if (replayBoundaryAt !== null) {
        state.openingTimestamp = replayBoundaryAt;
        state.openingSessionId = sessionId;
        state.foreignSessionMeta = false;
      }
    } else if (sessionId && state.openingSessionId) {
      state.foreignSessionMeta = sessionId !== state.openingSessionId;
    }
    if (!state.foreignSessionMeta) {
      state.agentPath = codexAgentPath(payload) ?? state.agentPath;
    }
    state.provider = str(payload.model_provider) ?? state.provider;
    return [];
  }
  if (kind === "rate_limits") {
    state.planKnown = true;
    state.planType = str(payload.plan_type);
    return [];
  }
  if (kind === "thread_settings_applied") {
    const settings = payload.thread_settings || {};
    const model2 = str(settings.model) ?? str(settings.model_id);
    const provider = str(settings.model_provider_id);
    const serviceTier = str(settings.service_tier);
    state.reasoningEffort = str(settings.reasoning_effort) ?? state.reasoningEffort;
    state.serviceTier = serviceTier ?? state.serviceTier;
    state.provider = provider ?? state.provider;
    const waiting = state.pendingCompactionBilling;
    const held = waiting === null ? void 0 : state.recentCompactions.find((item) => item.ordinal === waiting);
    if (held) {
      held.requestModel = model2 ?? held.requestModel;
      held.requestProvider = provider ?? held.requestProvider;
      held.requestServiceTier = serviceTier ?? held.requestServiceTier;
    }
    state.pendingCompactionBilling = null;
    return [];
  }
  if (kind === "task_started") {
    if (state.currentTurnId && !state.currentTurnCopied && state.currentTurnDidSomething) {
      state.closedTurns++;
      state.countedTurnIds[state.currentTurnId] = true;
      if (state.firstTurnAt === null) {
        state.firstTurnAt = state.currentTurnStartedAt;
      }
      state.lastTurnAt = state.currentTurnCompleted && state.currentTurnEndedAt !== null ? state.currentTurnEndedAt : state.currentTurnStartedAt;
      state.lastTurnStartedAt = state.currentTurnStartedAt;
      state.lastTurnOutcome = state.currentTurnOutcome ? { ...state.currentTurnOutcome } : null;
    }
    beginCodexTurn(state, payload, record.sourceStart);
    state.currentTurnDidSomething = false;
    state.currentTurnCompleted = false;
    if (!state.currentTurnCopied) {
      state.currentTurnStartedAt = record.timestamp;
      state.currentTurnEndedAt = null;
      state.currentTurnOutcome = {
        finished: false,
        error: false,
        interrupted: false,
        endedAt: record.timestamp,
        startedAt: record.timestamp
      };
    } else {
      state.currentTurnOutcome = null;
    }
    const window2 = num(payload.model_context_window);
    if (!state.currentTurnCopied && state.currentTurnId && window2 !== null) {
      state.turnWindows[state.currentTurnId] = window2;
    }
    return [];
  }
  if (kind === "compacted") {
    if (!state.currentTurnCopied) {
      state.compactionCount++;
      const turnId2 = state.currentTurnId;
      const requestUsage = codexRequestUsage(
        isRecord(payload.latest_token_usage_record) ? payload.latest_token_usage_record.usage : null
      );
      retainNewestCompaction(state, {
        ordinal: state.compactionCount,
        at: Number.isFinite(record.timestamp) && record.timestamp > 0 ? record.timestamp : null,
        trigger: codexCompactionTrigger(
          state.currentTurnId !== null,
          state.currentTurnCopied,
          state.currentTurnDidSomething
        ),
        requestUsage,
        requestModel: turnId2 ? state.turnModels[turnId2] ?? null : null,
        requestProvider: state.provider,
        requestServiceTier: state.serviceTier,
        requestContextWindow: turnId2 ? state.turnWindows[turnId2] ?? null : null
      });
      if (turnId2) {
        const ordinals = state.compactionTurnOrdinals[turnId2] ??= [];
        ordinals.push(state.compactionCount);
        while (ordinals.length > RETAINED_COMPACTIONS) {
          ordinals.shift();
        }
      }
      state.pendingCompactionBilling = requestUsage ? state.compactionCount : null;
    }
    return [];
  }
  if (kind === "turn_context") {
    applyCodexTurnDate(state, payload);
  }
  if (state.currentTurnId && !state.currentTurnCompleted) {
    const entry = { kind, at: record.timestamp, payload };
    if (kind === "task_complete" || kind === "turn_aborted") {
      state.currentTurnCompleted = true;
      state.pendingCompactionBilling = null;
      if (!state.currentTurnCopied) {
        state.currentTurnEndedAt = record.timestamp;
      }
    }
    if (!state.currentTurnCopied && codexTurnRecordDidSomething(entry, state.agentPath)) {
      state.currentTurnDidSomething = true;
    }
    if (!state.currentTurnCopied && state.currentTurnOutcome) {
      if (parsedUpdate(payload) || kind === "custom_tool_call" || kind === "function_call" || kind === "web_search_call" || kind === "patch_apply_end" || kind === "custom_tool_call_output" || kind === "function_call_output" || kind === "item_completed" || kind === "sub_agent_activity" || kind === "agent_message" || kind === "task_complete" || kind === "turn_aborted" || kind === "token_count") {
        state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, record.timestamp);
      }
      if (failedCodexTurn(entry)) {
        state.currentTurnOutcome.error = true;
      }
      if (finishedCodexTurn(entry)) {
        state.currentTurnOutcome.finished = true;
      }
      if (interruptedCodexTurn(entry)) {
        state.currentTurnOutcome.interrupted = true;
      }
    }
  }
  if (state.currentTurnCopied) {
    return [];
  }
  if (kind === "item_completed") {
    const result = claudeCommandResult(payload);
    if (!result || !state.currentTurnId) {
      return [];
    }
    const commandKey = result.commandId ?? `source:${record.sourceStart ?? "unknown"}`;
    if (!result.accepted) {
      if (state.seenClaudeCommands[commandKey] || state.pendingClaudeResults[commandKey]) {
        return [];
      }
      const incomplete = {
        timestamp: record.timestamp,
        agent: "claude",
        provider: null,
        model: null,
        contextWindow: null,
        contextBand: null,
        billingClass: "unknown",
        inferenceClass: null,
        serviceTier: null,
        reportedCost: null,
        reportedCostBasis: null,
        linkedSessionId: result.sessionId,
        linkedInvocationId: result.invocationId,
        incomplete: true,
        usage: { ...emptyUsage(), requests: 1 },
        requestKey: `claude-incomplete:${commandKey}`
      };
      state.pendingClaudeResults[commandKey] = incomplete;
      return [incomplete];
    }
    if (state.seenClaudeCommands[commandKey] || state.seenClaudeInvocations[result.invocationId]) {
      return [];
    }
    state.seenClaudeCommands[commandKey] = true;
    state.seenClaudeInvocations[result.invocationId] = true;
    const pending = state.pendingClaudeResults[commandKey];
    delete state.pendingClaudeResults[commandKey];
    const replacement = pending ? [
      {
        ...pending,
        usage: { ...pending.usage, requests: -1 }
      }
    ] : [];
    const accepted = result.models.map((part, index) => ({
      timestamp: record.timestamp,
      agent: "claude",
      provider: part.provider ?? null,
      model: part.model,
      contextWindow: part.contextWindow ?? null,
      contextBand: null,
      billingClass: "unknown",
      inferenceClass: null,
      serviceTier: null,
      reportedCost: part.recordedCost ?? null,
      reportedCostBasis: part.costBasis ?? null,
      linkedSessionId: result.sessionId,
      linkedInvocationId: result.invocationId,
      requestCountExact: false,
      unclassifiedCacheWrite: part.unclassifiedCacheWrite,
      usage: part.usage,
      requestKey: `${result.invocationId}:${index}`
    }));
    return [...replacement, ...accepted];
  }
  if (kind === "turn_context") {
    const turnId2 = str(payload.turn_id);
    const model2 = str(payload.model);
    if (!turnId2) {
      return [];
    }
    const effort = str(payload.effort) ?? state.reasoningEffort;
    state.turnModels[turnId2] = model2;
    state.turnEfforts[turnId2] = effort;
    if (!model2) {
      return [];
    }
    const pending = state.pendingRequests[turnId2] ?? [];
    delete state.pendingRequests[turnId2];
    for (const event2 of pending) {
      discardPendingRequestKey(state, event2.requestKey);
    }
    return pending.map((event2) => ({
      ...event2,
      model: model2,
      effort,
      inferenceClass: state.provider === "amazon-bedrock" ? bedrockInferenceClass(model2) : null,
      contextBand: contextBandForRequest(model2, state.provider, requestInputTokens(event2.usage))
    }));
  }
  if (kind !== "token_count" || !state.currentTurnId) {
    return [];
  }
  const rateLimits = payload.rate_limits || {};
  if (Object.keys(rateLimits).length) {
    state.planKnown = true;
    state.planType = str(rateLimits.plan_type);
  }
  const info = payload.info || {};
  const window = num(info.model_context_window);
  if (window !== null) {
    state.turnWindows[state.currentTurnId] = window;
  }
  const lastCounters = codexUsageCounters(info.last_token_usage);
  const totalCounters = codexUsageCounters(info.total_token_usage);
  const previous = state.lastUsageSnapshot;
  const repeatedSnapshot = lastCounters !== null && totalCounters !== null && previous?.turnId === state.currentTurnId && sameCounters(previous.last, lastCounters) && sameCounters(previous.total, totalCounters);
  if (lastCounters !== null && totalCounters !== null) {
    state.lastUsageSnapshot = { turnId: state.currentTurnId, last: lastCounters, total: totalCounters };
  } else {
    state.lastUsageSnapshot = null;
  }
  if (repeatedSnapshot) {
    return [];
  }
  const parsedUsage = codexRequestUsage(info.last_token_usage);
  const usage = parsedUsage ?? { ...emptyUsage(), requests: 1 };
  state.requestNumber++;
  const turnId = state.currentTurnId;
  const model = state.turnModels[turnId] ?? null;
  const providerMetered = state.provider !== null && state.provider !== "openai";
  const event = {
    timestamp: record.timestamp,
    agent: "codex",
    provider: state.provider,
    model,
    contextWindow: state.turnWindows[turnId] ?? null,
    contextBand: contextBandForRequest(model, state.provider, requestInputTokens(usage)),
    billingClass: providerMetered ? "metered" : state.planType ? "subscription" : state.planKnown ? "metered" : "unknown",
    inferenceClass: state.provider === "amazon-bedrock" ? bedrockInferenceClass(model) : null,
    serviceTier: state.serviceTier,
    effort: state.turnEfforts[turnId] ?? state.reasoningEffort,
    toolListVersion: null,
    reportedCost: null,
    // A Codex turn opens on `task_started`, which is the visible prompt boundary itself.
    // The rollout records no cache lifetime, so the model's documented row answers instead.
    visibleTurnId: `codex-turn:${turnId}`,
    cacheLifetime: null,
    compactionsBefore: state.compactionCount,
    ...parsedUsage ? {} : { incomplete: true },
    usage,
    requestKey: `codex:${turnId}:${record.timestamp ?? ""}:${state.requestNumber}`
  };
  if (!model) {
    (state.pendingRequests[turnId] ??= []).push(event);
    if (record.sourceStart !== void 0) {
      state.pendingRequestSources[event.requestKey] = {
        start: record.sourceStart,
        end: record.sourceEnd ?? record.sourceStart
      };
    }
    return [];
  }
  return [event];
}
function reduceCodexUsageRecord(state, record) {
  return reduceCodexUsageEvents(state, record)[0] ?? null;
}
function parseRecord(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = o.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const wrapper = o.type || "";
  const kind = wrapper === "event_msg" || wrapper === "response_item" ? String(payload.type || "") : wrapper;
  return { kind, at: stamp(o.timestamp), payload };
}
function reduceCodexUsageLine(state, line) {
  return reduceCodexUsageLineEvents(state, line)[0] ?? null;
}
function reduceCodexUsageLineEvents(state, line) {
  if (!carriesRecord(line) && !/"type"\s*:\s*"(?:session_meta|rate_limits|thread_settings_applied|turn_context|token_count)"/.test(line)) {
    return [];
  }
  const record = parseRecord(line);
  return record ? reduceCodexUsageEvents(state, {
    kind: record.kind,
    timestamp: record.at,
    payload: record.payload
  }) : [];
}
function currentCodexTurnCounts(state) {
  return Boolean(state.currentTurnId) && !state.currentTurnCopied && (state.currentTurnDidSomething || !state.currentTurnCompleted);
}
function createCodexUsageLineReducer(restored) {
  const state = restored ? {
    ...JSON.parse(JSON.stringify(restored)),
    // Ledgers written before delayed-context buffering have no pending map.
    pendingRequests: JSON.parse(JSON.stringify(restored.pendingRequests ?? {})),
    pendingRequestKeys: [...restored.pendingRequestKeys ?? []],
    pendingRequestSources: JSON.parse(
      JSON.stringify(restored.pendingRequestSources ?? {})
    ),
    recentClaudeInvocationIds: [...restored.recentClaudeInvocationIds ?? []],
    seenClaudeInvocations: JSON.parse(JSON.stringify(restored.seenClaudeInvocations ?? {})),
    recentClaudeCommandIds: [...restored.recentClaudeCommandIds ?? []],
    seenClaudeCommands: JSON.parse(JSON.stringify(restored.seenClaudeCommands ?? {})),
    pendingClaudeResultIds: [...restored.pendingClaudeResultIds ?? []],
    pendingClaudeResults: JSON.parse(JSON.stringify(restored.pendingClaudeResults ?? {})),
    openingTimestamp: restored.openingTimestamp ?? null,
    openingSessionId: restored.openingSessionId ?? null,
    agentPath: restored.agentPath ?? null,
    foreignSessionMeta: restored.foreignSessionMeta,
    currentTurnCopied: restored.currentTurnCopied,
    lastUsageSnapshot: restored.lastUsageSnapshot ?? null,
    recentTurnIds: [...restored.recentTurnIds ?? []],
    seenTurnIds: JSON.parse(JSON.stringify(restored.seenTurnIds ?? {})),
    seenTurnOffsets: JSON.parse(JSON.stringify(restored.seenTurnOffsets ?? {})),
    legacyReplayLinks: JSON.parse(
      JSON.stringify(restored.legacyReplayLinks ?? [])
    ),
    replayResetRequired: restored.replayResetRequired,
    copiedTurnIds: JSON.parse(JSON.stringify(restored.copiedTurnIds ?? {})),
    datedCopiedTurnIds: JSON.parse(JSON.stringify(restored.datedCopiedTurnIds ?? {})),
    countedTurnIds: JSON.parse(JSON.stringify(restored.countedTurnIds ?? {})),
    turnEfforts: JSON.parse(JSON.stringify(restored.turnEfforts ?? {})),
    closedTurns: restored.closedTurns ?? 0,
    currentTurnDidSomething: restored.currentTurnDidSomething,
    currentTurnCompleted: restored.currentTurnCompleted,
    compactionCount: restored.compactionCount ?? 0,
    recentCompactions: (restored.recentCompactions ?? []).map((item) => ({ ...item })),
    compactionTurnOrdinals: JSON.parse(JSON.stringify(restored.compactionTurnOrdinals ?? {})),
    pendingCompactionBilling: restored.pendingCompactionBilling ?? null,
    firstTurnAt: restored.firstTurnAt ?? null,
    lastTurnAt: restored.lastTurnAt ?? null,
    currentTurnStartedAt: restored.currentTurnStartedAt ?? null,
    currentTurnEndedAt: restored.currentTurnEndedAt ?? null,
    currentTurnOutcome: restored.currentTurnOutcome ?? null,
    lastTurnStartedAt: restored.lastTurnStartedAt ?? null,
    lastTurnOutcome: restored.lastTurnOutcome ?? null
  } : emptyCodexUsageReducerState();
  return {
    parserKind: "codex",
    pushLine: (line) => {
      const events = reduceCodexUsageLineEvents(state, line);
      synchronizeCodexSpendAssociations(state);
      return [...events, ...compactCodexSpendAssociations(state)];
    },
    snapshot: () => JSON.parse(JSON.stringify(state)),
    pendingRequestKeys: () => state.pendingRequestKeys,
    currentToolTurnId: () => state.currentTurnId && !state.currentTurnCopied && !state.currentTurnCompleted ? state.currentTurnId : null,
    turnCount: () => state.closedTurns + (currentCodexTurnCounts(state) ? 1 : 0),
    compactionCount: () => state.compactionCount,
    recentCompactions: () => state.recentCompactions.map((item) => ({ ...item })),
    firstTurnAt: () => state.firstTurnAt !== null ? state.firstTurnAt : currentCodexTurnCounts(state) ? state.currentTurnStartedAt : null,
    lastTurnAt: () => currentCodexTurnCounts(state) ? state.currentTurnCompleted && state.currentTurnEndedAt !== null ? state.currentTurnEndedAt : state.currentTurnStartedAt : state.lastTurnAt,
    newestTurnStartedAt: () => currentCodexTurnCounts(state) ? state.currentTurnStartedAt : state.lastTurnStartedAt,
    newestTurnOutcome: () => {
      const outcome = currentCodexTurnCounts(state) ? state.currentTurnOutcome : state.lastTurnOutcome;
      return outcome ? { ...outcome } : null;
    }
  };
}
const CODEX_SKILL_CATALOG = "<skills_instructions>";
const CODEX_SKILL_ROOT = /^-\s+`([^`]+)`\s*=\s*`([^`]+)`$/;
const CODEX_SKILL_ENTRY = /^-\s+(\S+?):\s+(.*?)\s+\(file:\s*([^)]+)\)$/;
function codexSkillPath(written, roots) {
  const cut = written.indexOf("/");
  const root = cut > 0 ? roots.get(written.slice(0, cut)) : void 0;
  if (root) {
    return `${root.replace(/[\\/]+$/, "")}/${written.slice(cut + 1)}`;
  }
  return /^[A-Za-z]:[\\/]/.test(written) || written.startsWith("/") ? written : "";
}
function codexSkillCatalog(text) {
  const roots = /* @__PURE__ */ new Map();
  const skills = /* @__PURE__ */ new Map();
  for (const written of text.split("\n")) {
    const line = written.trim();
    const root = CODEX_SKILL_ROOT.exec(line);
    if (root) {
      roots.set(root[1], root[2]);
      continue;
    }
    const entry = CODEX_SKILL_ENTRY.exec(line);
    if (!entry) {
      continue;
    }
    const path2 = codexSkillPath(entry[3], roots);
    if (!path2) {
      continue;
    }
    const published = entry[2].trim() || "no detail given";
    skills.set(entry[1], {
      name: entry[1],
      // One line, cut where a step's detail is cut. The published descriptions run to a
      // paragraph each, and the row under the heading draws one line of it.
      description: shortenTo(firstLine(published), STEP_DETAIL_LIMIT, STEP_CUT),
      fullDescription: published,
      path: path2,
      compare: normalizeFsPath(path2)
    });
  }
  return skills;
}
const CODEX_FILE_READERS = /* @__PURE__ */ new Set(["get-content", "gc", "cat", "type", "head", "tail", "sed", "bat", "more", "less"]);
const CODEX_COMMAND_SEPARATORS = /[\n;|&]/;
function commandReadsFile(command, compare) {
  const windows = /^[a-z]:\//.test(compare);
  for (const statement of command.split(CODEX_COMMAND_SEPARATORS)) {
    const written = statement.trim();
    const searched = normalizeFsPath(written);
    if (!(windows ? searched.toLowerCase() : searched).includes(compare)) {
      continue;
    }
    const opening = written.replace(/^\(+/, "");
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(opening);
    const first = (quoted?.[1] ?? quoted?.[2] ?? opening.split(/\s+/)[0]).toLowerCase();
    const program = (first.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd|bat|com)$/, "");
    if (CODEX_FILE_READERS.has(program)) {
      return true;
    }
  }
  return false;
}
function recordCodexSkillUses(state, turn, command, at) {
  if (command.status !== "done" || state.skillCatalog.size === 0) {
    return;
  }
  for (const skill of state.skillCatalog.values()) {
    const read = command.readPaths.includes(skill.compare) || commandReadsFile(command.fullDetail, skill.compare);
    if (!read) {
      continue;
    }
    addTurnSkillUse(turn, {
      // One command can read several of these files, and every load it made shares the
      // command's identity and clock, because the command is the only record of any of them.
      sourceId: command.sourceId ?? `${turn.promptId}:command:${at}`,
      name: skill.name,
      description: skill.description,
      fullDescription: skill.fullDescription,
      path: skill.path,
      at,
      evidence: "best-effort"
    });
  }
}
const INJECTED_USER_CONTEXT = [
  "<recommended_plugins>",
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<permissions instructions>",
  "<apps_instructions>",
  "<plugins_instructions>",
  CODEX_SKILL_CATALOG,
  "The following is the Codex agent history "
];
function isInjectedUserContext(text) {
  const trimmed = text.trimStart();
  return INJECTED_USER_CONTEXT.some((prefix) => trimmed.startsWith(prefix));
}
function userMessage(record) {
  if (record.kind === "user_message") {
    const text2 = str(record.payload.message);
    return text2 ? answeredQuestions(text2) ?? text2 : text2;
  }
  if (record.kind !== "message" || str(record.payload.role) !== "user") {
    return null;
  }
  const content = record.payload.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const metadata = record.payload.internal_chat_message_metadata_passthrough;
  const kinds = metadata?.content_item_kinds;
  if (Array.isArray(kinds) && !kinds.includes("user.text")) {
    return null;
  }
  if (Array.isArray(kinds) && kinds.length !== content.length) {
    return null;
  }
  const text = content.flatMap((block, index) => {
    const item = block;
    const written = !Array.isArray(kinds) || kinds[index] === "user.text";
    if (!written || item?.type !== "input_text" || typeof item.text !== "string") {
      return [];
    }
    return !Array.isArray(kinds) && isInjectedUserContext(item.text) ? [] : [item.text];
  }).join("\n");
  return text ? answeredQuestions(text) ?? text : null;
}
function answeredQuestions(text) {
  const replies = parseQuestionReply(text);
  return replies ? replies.map(answeredQuestion).join("\n\n") : null;
}
function answeredQuestion({ question, answer }) {
  return [question, answer].filter((line) => line.trim()).join("\n");
}
function codexDelegation(record, agentPath) {
  if (!agentPath || record.kind !== "agent_message") {
    return null;
  }
  const text = blocksText(record.payload.content).trim();
  const matched = text.match(
    /^Message Type:[ \t]*NEW_TASK\r?\nTask name:[ \t]*(\S+)[ \t]*\r?\nSender:[ \t]*(\S+)[ \t]*\r?\nPayload:[ \t]*(?:\r?\n)?([\s\S]*)$/
  );
  if (!matched || str(record.payload.recipient) !== agentPath || !matched[1] || !matched[2]) {
    return null;
  }
  const payload = matched[3].trim();
  const opaque = Array.isArray(record.payload.content) && record.payload.content.some((block) => isRecord(block) && str(block.type) === "encrypted_content");
  return payload ? { text: payload, complete: !opaque } : { text: matched[1], complete: false };
}
function finishedCodexTurn(record) {
  return record.kind === "task_complete";
}
function failedCodexTurn(record) {
  return record.kind === "task_complete" && typeof record.payload.error?.message === "string" && (record.payload.error.message ?? "").trim().length > 0;
}
function interruptedCodexTurn(record) {
  return record.kind === "turn_aborted" && str(record.payload.reason) === "interrupted";
}
function answerInTaskComplete(record) {
  return record.kind === "task_complete" ? str(record.payload.last_agent_message) ?? "" : "";
}
function stripWhitespace(text) {
  return text.replace(/\s+/g, "");
}
function finalChildMessage(record) {
  return record.kind === "agent_message" && !!str(record.payload.author) && outputText(record.payload.content).indexOf(FINAL_ANSWER) >= 0;
}
function subagentNotification(record) {
  if (record.kind !== "message" || str(record.payload.role) !== "user") {
    return null;
  }
  const content = record.payload.content;
  const metadata = record.payload.internal_chat_message_metadata_passthrough;
  const kinds = metadata?.content_item_kinds;
  if (!Array.isArray(content) || !Array.isArray(kinds) || content.length !== 1 || kinds.length !== 1 || kinds[0] !== "multi_agent.subagent_notification") {
    return null;
  }
  for (let index = 0; index < content.length; index++) {
    const item = content[index];
    if (item?.type !== "input_text" || typeof item.text !== "string") {
      continue;
    }
    const wrapper = /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/.exec(item.text.trim());
    if (!wrapper) {
      continue;
    }
    try {
      const note = JSON.parse(wrapper[1]);
      if (typeof note.agent_path !== "string") {
        continue;
      }
      if (note.status === "shutdown") {
        return { id: note.agent_path, status: "interrupted" };
      }
      if (typeof note.status !== "object" || note.status === null) {
        continue;
      }
      if (typeof note.status.completed === "string") {
        return { id: note.agent_path, status: "completed" };
      }
      if (typeof note.status.errored === "string") {
        return { id: note.agent_path, status: "failed" };
      }
    } catch {
    }
  }
  return null;
}
function codexOutcomeIn(lines, agentPath) {
  let current = null;
  let latestDrawable = null;
  const pendingExec = /* @__PURE__ */ new Set();
  const keepCurrent = () => {
    if (!current?.worthDrawing) {
      return;
    }
    const { worthDrawing: _worthDrawing, ...outcome } = current;
    latestDrawable = outcome;
  };
  for (const line of lines) {
    if (line.length < 20 || !carriesRecord(line)) {
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      continue;
    }
    if (record.kind === "task_started") {
      keepCurrent();
      pendingExec.clear();
      current = {
        finished: false,
        error: false,
        interrupted: false,
        endedAt: record.at,
        startedAt: record.at,
        worthDrawing: false
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (parsedUpdate(record.payload)) {
      current.worthDrawing = true;
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (record.kind === "user_message" || record.kind === "message") {
      if (codexPrompt(userMessage(record) ?? "")) {
        current.worthDrawing = true;
      }
      continue;
    }
    if (codexDelegation(record, agentPath)) {
      current.worthDrawing = true;
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (record.kind === "custom_tool_call" || record.kind === "function_call" || record.kind === "web_search_call") {
      current.worthDrawing = true;
      current.endedAt = Math.max(current.endedAt, record.at);
      if ((record.kind === "custom_tool_call" || record.kind === "function_call") && str(record.payload.name) === "exec" && str(record.payload.call_id)) {
        pendingExec.add(str(record.payload.call_id));
      }
      continue;
    }
    if (record.kind === "patch_apply_end") {
      if (record.payload.success !== false && hasVisibleCodexChanges(record.payload.changes)) {
        current.worthDrawing = true;
      }
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (record.kind === "custom_tool_call_output" || record.kind === "function_call_output") {
      current.endedAt = Math.max(current.endedAt, record.at);
      pendingExec.delete(str(record.payload.call_id) ?? "");
      continue;
    }
    if (record.kind === "item_completed") {
      if ((completedFileChange(record.payload) || completedCommand(record.payload)) && pendingExec.size === 1) {
        current.endedAt = Math.max(current.endedAt, record.at);
      }
      continue;
    }
    if (record.kind === "sub_agent_activity") {
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (finalChildMessage(record)) {
      current.endedAt = Math.max(current.endedAt, record.at);
      continue;
    }
    if (failedCodexTurn(record)) {
      current.error = true;
      current.worthDrawing = true;
    }
    if (answerInTaskComplete(record)) {
      current.worthDrawing = true;
    }
    if (finishedCodexTurn(record)) {
      current.finished = true;
    }
    if (interruptedCodexTurn(record)) {
      current.interrupted = true;
      current.worthDrawing = true;
    }
    if (record.kind === "task_complete" || record.kind === "turn_aborted" || record.kind === "token_count") {
      current.endedAt = Math.max(current.endedAt, record.at);
    }
    if (record.kind === "task_complete" || record.kind === "turn_aborted") {
      keepCurrent();
      current = null;
      pendingExec.clear();
    }
  }
  keepCurrent();
  return latestDrawable;
}
function carriesUserMessage(line) {
  return line.indexOf("user_message") >= 0 || line.indexOf('"type":"message"') >= 0 && line.indexOf('"role":"user"') >= 0 && line.indexOf('"input_text"') >= 0;
}
const CLAUDE_RESULT_MODEL_LIMIT = 32;
const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.-]*$/i;
function commandText(item) {
  const parsed = item.parsed_cmd;
  if (Array.isArray(parsed) && parsed.length === 1) {
    const command = str(parsed[0]?.cmd);
    if (command) {
      return command;
    }
  }
  return str(item.command) ?? "";
}
function claudePrintCommand(command) {
  const segments = [];
  let segment = "";
  let quote = null;
  let hereEnd = null;
  let hereLineOnlyWhitespace = false;
  let comment = false;
  const finish = () => {
    if (segment.trim()) {
      segments.push(segment.trim());
    }
    segment = "";
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (comment) {
      if (char === "\n" || char === "\r") {
        comment = false;
        finish();
      }
      continue;
    }
    if (hereEnd) {
      const after = command[index + 2];
      if (hereLineOnlyWhitespace && char === hereEnd[0] && next === "@" && (after === void 0 || after === "\n" || after === "\r")) {
        segment += hereEnd;
        index++;
        hereEnd = null;
      } else {
        segment += char;
        if (char === "\n" || char === "\r") {
          hereLineOnlyWhitespace = true;
        } else if (char !== " " && char !== "	") {
          hereLineOnlyWhitespace = false;
        }
      }
      continue;
    }
    if (quote) {
      segment += char;
      if (char === quote) {
        if (next === quote) {
          segment += next;
          index++;
        } else {
          quote = null;
        }
      } else if (quote === '"' && (char === "\\" || char === "`") && next) {
        segment += next;
        index++;
      }
      continue;
    }
    if (char === "@" && (next === "'" || next === '"')) {
      hereEnd = next === "'" ? "'@" : '"@';
      hereLineOnlyWhitespace = false;
      segment += char + next;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1]))) {
      comment = true;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "\n" || char === "\r") {
      finish();
      continue;
    }
    segment += char;
  }
  finish();
  return segments.some((part) => /^claude(?:\.exe|\.cmd)?\s+-p(?:\s|$)/i.test(part));
}
function nonnegative(value) {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
function tokenCount(value) {
  const parsed = nonnegative(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}
function claudeCommandResult(payload) {
  const item = isRecord(payload.item) ? payload.item : null;
  if (!item || str(item.type) !== "CommandExecution") {
    return null;
  }
  const command = commandText(item);
  if (!claudePrintCommand(command)) {
    return null;
  }
  const commandId = str(item.id);
  const failed = str(item.status) !== "completed" || nonnegative(item.exit_code) !== 0;
  const incomplete = (sessionId2 = null, durationMs2 = null) => ({
    accepted: false,
    commandId,
    invocationId: `claude-command:${commandId ?? "unknown"}`,
    sessionId: sessionId2,
    durationMs: durationMs2,
    models: [],
    status: "failed"
  });
  const stdout = typeof item.stdout === "string" ? item.stdout.trim() : "";
  let result;
  try {
    const parsed = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      return incomplete();
    }
    result = parsed;
  } catch {
    return incomplete();
  }
  const sessionId = str(result.session_id);
  const durationMs = nonnegative(result.duration_ms);
  const totalCost = nonnegative(result.total_cost_usd);
  const rawModels = isRecord(result.modelUsage) ? Object.entries(result.modelUsage) : [];
  if (failed || result.type !== "result" || result.is_error !== false || !commandId || !sessionId || totalCost === null || !isRecord(result.modelUsage) || rawModels.length > CLAUDE_RESULT_MODEL_LIMIT) {
    return incomplete(sessionId, durationMs);
  }
  const parsedModels = [];
  let recordedTotal = 0;
  for (const [key, value] of rawModels) {
    if (key.length > 200 || !isRecord(value)) {
      return incomplete(sessionId, durationMs);
    }
    const model = str(value.canonicalModel);
    const input = tokenCount(value.inputTokens);
    const output = tokenCount(value.outputTokens);
    const cacheRead = tokenCount(value.cacheReadInputTokens);
    const cacheCreation = tokenCount(value.cacheCreationInputTokens);
    const thinking = tokenCount(value.thinkingTokens);
    const recordedCost = nonnegative(value.costUSD);
    const contextWindow = tokenCount(value.contextWindow);
    const costBasis = str(value.costBasis);
    if (!model || !CLAUDE_MODEL.test(model) || input === null || output === null || cacheRead === null || cacheCreation === null || thinking === null || recordedCost === null || contextWindow === null || contextWindow <= 0 || costBasis !== "list") {
      return incomplete(sessionId, durationMs);
    }
    recordedTotal += recordedCost;
    const multiplier = bedrockClaudeListMultiplier(key, model);
    parsedModels.push({
      model,
      contextWindow,
      recordedCost: recordedCost * multiplier,
      costBasis: multiplier === 1 ? costBasis : BEDROCK_LIST_COST_BASIS,
      usage: {
        requests: 1,
        input,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        cacheWrite30m: 0,
        cacheRead,
        output,
        thinking
      },
      cacheCreation
    });
  }
  if (Math.abs(recordedTotal - totalCost) > Math.max(1e-9, totalCost * 1e-9)) {
    return incomplete(sessionId, durationMs);
  }
  const aggregate = isRecord(result.usage) ? result.usage : null;
  const creation = aggregate && isRecord(aggregate.cache_creation) ? aggregate.cache_creation : null;
  const aggregateCreation = aggregate ? tokenCount(aggregate.cache_creation_input_tokens) : null;
  const oneHour = creation ? tokenCount(creation.ephemeral_1h_input_tokens) : null;
  const fiveMinute = creation ? tokenCount(creation.ephemeral_5m_input_tokens) : null;
  const creating = parsedModels.filter((part) => part.cacheCreation > 0);
  const splitCanBeAssigned = creating.length === 1 && aggregateCreation !== null && oneHour !== null && fiveMinute !== null && aggregateCreation === oneHour + fiveMinute && aggregateCreation === creating[0].cacheCreation;
  const models = parsedModels.map(({ cacheCreation, ...part }) => {
    if (splitCanBeAssigned && cacheCreation > 0) {
      part.usage.cacheWrite1h = oneHour ?? 0;
      part.usage.cacheWrite5m = fiveMinute ?? 0;
      return part;
    }
    return cacheCreation > 0 ? { ...part, unclassifiedCacheWrite: cacheCreation } : part;
  });
  return {
    accepted: true,
    commandId,
    invocationId: `${commandId}:${sessionId}`,
    sessionId,
    durationMs,
    models,
    status: "done"
  };
}
function codexChangePaths(changes) {
  if (!isRecord(changes)) {
    return [];
  }
  const paths = [];
  for (const [written, raw] of Object.entries(changes)) {
    paths.push(written);
    const moved = isRecord(raw) ? str(raw.move_path) : null;
    if (moved) {
      paths.push(moved);
    }
  }
  return [...new Set(paths)];
}
function localCommandCwd(value) {
  const cwd = str(value);
  if (!cwd) {
    return null;
  }
  if (/^(?:[a-z]:[\\/]|\/|\\\\[^\\/]+[\\/][^\\/]+)/i.test(cwd)) {
    return cwd;
  }
  const file = /^file:(?:\/\/([^/?#]*))?(\/[^?#]*)$/i.exec(cwd);
  if (!file) {
    return null;
  }
  const encodedPath = file[2];
  if (!encodedPath) {
    return null;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!pathname.startsWith("/")) {
    return null;
  }
  const host = (file[1] ?? "").toLowerCase();
  if (host && host !== "localhost") {
    return `\\\\${host}${pathname.replaceAll("/", "\\")}`;
  }
  return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
}
function completedCommand(payload) {
  const item = payload.item;
  if (!item || str(item.type) !== "CommandExecution") {
    return null;
  }
  const command = commandText(item);
  const detail = stepDetail({ command });
  if (!detail) {
    return null;
  }
  const exit = num(item.exit_code);
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
  const status = str(item.status);
  return {
    command,
    detail,
    fullDetail: command,
    sourceId: str(item.id),
    status: status === "failed" || exit !== null && exit !== 0 ? "failed" : "done",
    cwd: localCommandCwd(item.cwd),
    stdout: typeof item.stdout === "string" ? item.stdout : typeof item.aggregated_output === "string" ? item.aggregated_output : "",
    startedAt: num(item.started_at_ms),
    completedAt: num(item.completed_at_ms),
    failed: status !== "completed" || exit !== 0,
    readPaths: parsed.flatMap((segment) => {
      const entry = segment;
      const read = str(entry?.type) === "read" ? str(entry?.path) : null;
      return read ? [normalizeFsPath(read)] : [];
    })
  };
}
function completedFileChange(payload) {
  const item = payload.item;
  if (!item || str(item.type) !== "FileChange") {
    return null;
  }
  const changes = isRecord(item.changes) ? item.changes : {};
  const paths = codexChangePaths(changes);
  const presented = presentedStepDetail("apply_patch", { paths });
  return {
    changes,
    detail: presented.detail,
    fullDetail: presented.fullDetail ?? presented.detail,
    paths,
    sourceId: str(item.id),
    status: str(item.status) === "failed" ? "failed" : "done"
  };
}
function blocksText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value.flatMap((block) => {
    if (typeof block === "string") {
      return [block];
    }
    const text = str(block?.text);
    return text ? [text] : [];
  }).join("\n");
}
function parsedMessageItem(payload) {
  const nested = isRecord(payload.item) ? payload.item : null;
  const item = nested ?? payload;
  const type = str(item.type) ?? "";
  if (type !== "AgentMessage" && type !== "message" && type !== "agent_message") {
    return null;
  }
  if (type === "message" && str(item.role) !== "assistant") {
    return null;
  }
  const text = (blocksText(item.content) || str(item.message) || "").trim();
  return text ? { sourceId: str(item.id), phase: str(item.phase), text } : null;
}
function parsedAsyncMessage(payload) {
  const item = isRecord(payload.item) ? payload.item : null;
  if (!item || str(item.type) !== "AgentMessage" || str(item.delivery) !== "async") {
    return null;
  }
  const questions = (Array.isArray(item.questions) ? item.questions : []).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const title = str(entry.title);
    if (!title) {
      return [];
    }
    const options = (Array.isArray(entry.options) ? entry.options : []).filter(
      (option) => typeof option === "string" && option !== ""
    );
    return [[title, ...options.map((option) => `- ${option}`)].join("\n")];
  });
  const text = questions.length ? questions.join("\n\n") : blocksText(item.content).trim();
  return text ? { sourceId: str(item.id), kind: "commentary", text } : null;
}
function parsedUpdate(payload) {
  const message = parsedMessageItem(payload);
  if (message) {
    return message.phase === "commentary" ? { sourceId: message.sourceId, kind: "commentary", text: message.text } : null;
  }
  const nested = isRecord(payload.item) ? payload.item : null;
  const item = nested ?? payload;
  const type = str(item.type) ?? "";
  if (type !== "Reasoning" && type !== "reasoning") {
    return null;
  }
  const text = (blocksText(item.summary_text) || blocksText(item.summary)).trim();
  return text ? { sourceId: str(item.id), kind: "reasoning", text } : null;
}
function parsedFinalAnswer(payload) {
  const item = isRecord(payload.item) ? payload.item : payload;
  if (str(item.delivery) === "async") {
    return null;
  }
  const message = parsedMessageItem(payload);
  return message && message.phase === "final_answer" ? { sourceId: message.sourceId, text: message.text } : null;
}
function readCodexAgentSpend(file) {
  const meta = readCodexSessionMeta(file);
  const provider = meta?.modelProvider ?? null;
  const usageState = emptyCodexUsageReducerState(
    provider,
    meta?.replayBoundaryAt ?? null,
    meta?.sessionId ?? null,
    meta?.agentPath ?? null
  );
  const requests = [];
  let partial = false;
  let effort = null;
  let incompleteRequests = 0;
  let lastLine = "";
  const revision = spendFileVersion(file);
  const child = createCodexSessionReducer(
    meta?.sessionId ?? path.basename(file, path.extname(file)),
    { maxTurns: Number.MAX_SAFE_INTEGER },
    meta
  );
  const found = scanLines(file, (line) => {
    child.pushLine(line);
    if (line.trim()) {
      lastLine = line;
    }
    if (line.indexOf("session_meta") < 0 && line.indexOf("task_started") < 0 && line.indexOf("turn_context") < 0 && line.indexOf("thread_settings_applied") < 0 && line.indexOf("rate_limits") < 0 && line.indexOf("token_count") < 0 && line.indexOf("spawn_agent") < 0 && line.indexOf("CommandExecution") < 0) {
      return;
    }
    const record = parseRecord(line);
    if (!record) {
      return;
    }
    if ((record.kind === "custom_tool_call" || record.kind === "function_call") && str(record.payload.name) === "spawn_agent") {
      partial = true;
      return;
    }
    const events = reduceCodexUsageEvents(usageState, {
      kind: record.kind,
      timestamp: record.at,
      payload: record.payload
    });
    if (record.kind === "turn_context" && !usageState.currentTurnCopied) {
      effort = str(record.payload.effort) ?? effort;
    }
    requests.push(...events);
  });
  const byIdentity = /* @__PURE__ */ new Map();
  for (const event of requests) {
    if (event.incomplete) {
      if (!event.linkedInvocationId) {
        incompleteRequests += event.usage.requests ?? 0;
      }
      continue;
    }
    const model = event.model;
    const contextWindow = event.contextWindow;
    const eventProvider = event.agent === "claude" ? event.provider : event.provider ?? provider;
    const key = JSON.stringify([
      model,
      eventProvider,
      contextWindow,
      event.reportedCostBasis ?? null,
      event.linkedInvocationId ?? null
    ]);
    const held = byIdentity.get(key) ?? {
      model,
      ...eventProvider ? { provider: eventProvider } : {},
      ...contextWindow ? { contextWindow } : {},
      ...event.reportedCost === null ? {} : { recordedCost: 0 },
      ...event.reportedCostBasis ? { costBasis: event.reportedCostBasis } : {},
      usageParts: [],
      usage: emptyUsage()
    };
    addUsage(held.usage, event.usage, event.contextBand);
    addTurnUsagePart(held, { ...event, provider: eventProvider });
    if (event.reportedCost !== null) {
      held.recordedCost = (held.recordedCost ?? 0) + event.reportedCost;
    }
    held.unclassifiedCacheWrite = (held.unclassifiedCacheWrite ?? 0) + (event.unclassifiedCacheWrite ?? 0);
    if (!held.unclassifiedCacheWrite) {
      delete held.unclassifiedCacheWrite;
    }
    byIdentity.set(key, held);
  }
  partial ||= Object.keys(usageState.pendingClaudeResults).length > 0;
  const usageIncomplete = incompleteRequests > 0;
  const artifacts = reduceChildArtifacts(
    { turns: child.finish(0).turns },
    {
      revision,
      complete: lastLineWhole(lastLine),
      pathKey: normalizeFsPath,
      sameCommit: sameCommitSha
    }
  );
  if (meta && isHiddenThread(meta) && meta.startedAt !== null) {
    artifacts.startedAt = meta.startedAt;
  }
  return found ? {
    models: [...byIdentity.values()],
    found: true,
    partial,
    effort,
    artifacts,
    ...usageIncomplete ? { usageIncomplete: true } : {}
  } : { models: [], found: false, partial: false, effort: null };
}
function codexSubagentFor(children, parentThreadId, ref) {
  if (ref.id) {
    return children.find((child) => child.threadId === ref.id) ?? null;
  }
  const pathName = ref.path || `/root/${ref.name}`;
  const found = children.filter(
    (child) => child.parentThreadId === parentThreadId && child.agentPath && (child.agentPath === pathName || child.agentPath.endsWith(`/${ref.name}`))
  );
  return found.length === 1 ? found[0] : null;
}
const CODEX_SOURCE_START = Symbol("codexSourceStart");
const CODEX_SOURCE_END = Symbol("codexSourceEnd");
const CODEX_MEMBERSHIP_START = Symbol("codexMembershipStart");
function setCodexSourceRange(value, start, end) {
  Object.defineProperty(value, CODEX_SOURCE_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(value, CODEX_SOURCE_END, {
    value: end,
    enumerable: false,
    configurable: true,
    writable: true
  });
}
function extendCodexSourceRange(value, start, end) {
  const currentStart = value[CODEX_SOURCE_START];
  const currentEnd = value[CODEX_SOURCE_END];
  if (currentStart === void 0 || start < currentStart) {
    Object.defineProperty(value, CODEX_SOURCE_START, {
      value: start,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
  if (currentEnd === void 0 || end > currentEnd) {
    Object.defineProperty(value, CODEX_SOURCE_END, {
      value: end,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
}
function setCodexMembershipStart(value, start) {
  Object.defineProperty(value, CODEX_MEMBERSHIP_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true
  });
}
const CODEX_HIDDEN_POLICY = {
  start: CODEX_SOURCE_START,
  end: CODEX_SOURCE_END,
  membershipStart: CODEX_MEMBERSHIP_START,
  redefinesDetail: true
};
const NEEDLES = [
  "session_meta",
  "task_started",
  "task_complete",
  "turn_aborted",
  "user_message",
  "token_count",
  "patch_apply_end",
  "turn_context",
  "custom_tool_call",
  "function_call",
  "sub_agent_activity",
  "compacted",
  "web_search_call",
  "CommandExecution",
  // The record naming the billing tier and the provider. The usage reader admits it and the
  // session reader did not, so a session on a tier this table cannot price still reached
  // a figure quoted at the standard rate.
  "thread_settings_applied",
  "AgentMessage",
  "Reasoning",
  "item_completed",
  FINAL_ANSWER,
  // The published skill list. Nothing else in a rollout names the files that are skills, so
  // a window that drops this record cannot tell a skill read from any other file read.
  CODEX_SKILL_CATALOG
];
function carriesDelegation(line) {
  return line.indexOf('"type":"agent_message"') >= 0 && line.indexOf("Message Type: NEW_TASK") >= 0;
}
function carriesRecord(line) {
  return carriesUserMessage(line) || carriesAssistantUpdate(line) || carriesDelegation(line) || NEEDLES.some((needle) => line.indexOf(needle) >= 0);
}
function codexSessionLineMayAffectRead(line) {
  return line.length >= 20 && carriesRecord(line);
}
function carriesAssistantUpdate(line) {
  const phased = (line.indexOf('"phase":"commentary"') >= 0 || line.indexOf('"phase":"final_answer"') >= 0) && (line.indexOf('"type":"message"') >= 0 || line.indexOf('"type":"agent_message"') >= 0);
  const reasoning = line.indexOf('"type":"reasoning"') >= 0 && (line.indexOf('"summary"') >= 0 || line.indexOf('"summary_text"') >= 0);
  return phased || reasoning;
}
function codexTurnRecordDidSomething(record, agentPath = null) {
  const asked = userMessage(record);
  if (asked !== null) {
    return Boolean(codexPrompt(asked));
  }
  if (codexDelegation(record, agentPath)) {
    return true;
  }
  if (parsedUpdate(record.payload)) {
    return true;
  }
  if (record.kind === "custom_tool_call" || record.kind === "function_call" || record.kind === "web_search_call") {
    return true;
  }
  if (record.kind === "patch_apply_end") {
    return record.payload.success !== false && hasVisibleCodexChanges(record.payload.changes);
  }
  if (record.kind === "item_completed") {
    const fileChange = completedFileChange(record.payload);
    return fileChange?.status === "done" && hasVisibleCodexChanges(fileChange.changes);
  }
  if (record.kind === "task_complete") {
    return Boolean(str(record.payload.last_agent_message)) || failedCodexTurn(record);
  }
  return interruptedCodexTurn(record);
}
function codexCompactionTrigger(turnStarted, turnCopied, turnDidSomething) {
  if (!turnStarted || turnCopied) {
    return "";
  }
  return turnDidSomething ? "auto" : "manual";
}
function visitCodexBoundary(state, line) {
  if (line.length < 20 || !carriesRecord(line)) {
    return false;
  }
  const record = parseRecord(line);
  if (!record) {
    return false;
  }
  if (record.kind === "task_started") {
    const found = state.didSomething || !state.completed;
    state.didSomething = false;
    state.completed = false;
    return found;
  }
  if (record.kind === "task_complete" || record.kind === "turn_aborted") {
    state.completed = true;
    state.didSomething = codexTurnRecordDidSomething(record, state.agentPath);
    return false;
  }
  if (codexTurnRecordDidSomething(record, state.agentPath)) {
    state.didSomething = true;
  }
  return false;
}
function codexBoundaryState(lines, agentPath) {
  const state = { didSomething: false, completed: false, agentPath };
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    visitCodexBoundary(state, lines[i]);
  }
  return state;
}
function turnStartsIn(lines, agentPath) {
  const starts = [];
  let open = null;
  for (const line of lines) {
    if (line.length < 20 || !carriesRecord(line)) {
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      continue;
    }
    if (record.kind === "task_started") {
      open = record.at || null;
      continue;
    }
    if (open === null) {
      continue;
    }
    if (record.kind === "task_complete" || record.kind === "turn_aborted") {
      if (codexTurnRecordDidSomething(record, agentPath)) {
        starts.push(open);
      }
      open = null;
      continue;
    }
    if (codexTurnRecordDidSomething(record, agentPath)) {
      starts.push(open);
      open = null;
    }
  }
  if (open !== null) {
    starts.push(open);
  }
  return starts;
}
function readCodexTurnStarts(file, bytes = TURN_START_BYTES) {
  const agentPath = readCodexSessionMeta(file)?.agentPath ?? null;
  return readTurnStartsFromTail(file, (lines) => turnStartsIn(lines, agentPath), bytes);
}
function readCodexSession(file, sessionId, opts = {}) {
  const tailBytes = opts.tailBytes ?? 4 * 1024 * 1024;
  const tail = tailOf(file, tailBytes, opts.prepareNewestTurnDiscovery === true);
  const meta = readCodexSessionMeta(file);
  const read = readCodexSessionLines(tail.lines, sessionId, opts, tail.readBytes, meta);
  if (opts.prepareNewestTurnDiscovery && !tail.whole && tail.cursor && turnStartsIn(tail.lines, meta?.agentPath ?? null).length === 0) {
    read.newestTurnCursor = tail.cursor;
    read.newestTurnState = codexBoundaryState(tail.lines, meta?.agentPath ?? null);
  }
  return read;
}
function discoverCodexNewestTurn(file, cursor, opaqueState, options = {}) {
  const restored = opaqueState;
  const state = {
    didSomething: restored?.didSomething === true,
    completed: restored?.completed === true,
    agentPath: restored?.agentPath ?? readCodexSessionMeta(file)?.agentPath ?? null
  };
  return discoverBackwardBoundary(file, cursor, (line) => visitCodexBoundary(state, line.text), options);
}
function emptyCodexSessionParserState(meta) {
  const provider = meta?.modelProvider ?? null;
  const openedAt = meta?.openedAt ?? null;
  const replayBoundaryAt = meta?.replayBoundaryAt ?? null;
  const openingSessionId = meta?.sessionId ?? null;
  return {
    version: 13,
    turns: [],
    turnRanges: [],
    turnMembershipStarts: [],
    compactions: [],
    compactionRanges: [],
    compactionTurnIds: [],
    compactionValueSources: [],
    pendingCompactionBilling: null,
    turnLimitReached: false,
    turnLimitStart: null,
    contexts: /* @__PURE__ */ new Map(),
    toolNames: /* @__PURE__ */ new Map(),
    skillCatalog: /* @__PURE__ */ new Map(),
    stepById: /* @__PURE__ */ new Map(),
    updateById: /* @__PURE__ */ new Map(),
    updateByText: /* @__PURE__ */ new Map(),
    answerById: /* @__PURE__ */ new Map(),
    pendingExec: /* @__PURE__ */ new Map(),
    launched: /* @__PURE__ */ new Map(),
    currentSpawns: /* @__PURE__ */ new Set(),
    byName: /* @__PURE__ */ new Map(),
    seenClaudeCommands: {},
    usageState: emptyCodexUsageReducerState(provider, replayBoundaryAt, openingSessionId, meta?.agentPath ?? null),
    lastContext: 0,
    lastLifetime: null,
    lastContextSource: null,
    lastModel: null,
    lastModelSource: null,
    lastProviderSource: null,
    lastServiceTierSource: null,
    updateSequence: 0,
    pendingClassification: [],
    open: null,
    defaultDir: meta?.cwd ?? null,
    provider,
    agentPath: meta?.agentPath ?? null,
    opening: { openedAt, sessionId: openingSessionId }
  };
}
function discardCodexTurn(state) {
  if (state.open) {
    state.contexts.delete(state.open.promptId);
  }
  state.open = null;
  state.pendingExec.clear();
  state.updateById.clear();
  state.updateByText.clear();
  state.answerById.clear();
}
function retainCodexUsageKeys(state, keep) {
  const usage = state.usageState;
  const prune = (record) => {
    for (const id of Object.keys(record)) {
      if (!keep.has(id)) {
        delete record[id];
      }
    }
  };
  prune(usage.copiedTurnIds);
  prune(usage.datedCopiedTurnIds);
  prune(usage.countedTurnIds);
  prune(usage.turnModels);
  prune(usage.turnEfforts);
  prune(usage.turnWindows);
  prune(usage.pendingRequests);
  const pendingRequestKeys = /* @__PURE__ */ new Set();
  for (const events of Object.values(usage.pendingRequests)) {
    for (const event of events) {
      pendingRequestKeys.add(event.requestKey);
    }
  }
  for (const key of Object.keys(usage.pendingRequestSources)) {
    if (!pendingRequestKeys.has(key)) {
      delete usage.pendingRequestSources[key];
    }
  }
}
function compactCodexAssociations(state, maxTurns) {
  const limit = Math.max(0, Math.floor(maxTurns));
  const liveSteps = /* @__PURE__ */ new Set();
  const liveAgents = /* @__PURE__ */ new Set();
  for (const turn of [...state.turns, ...state.open ? [state.open] : []]) {
    for (const step of turn.steps) {
      liveSteps.add(step);
    }
    for (const agent of turn.agents) {
      liveAgents.add(agent);
    }
  }
  for (const pending of state.pendingExec.values()) {
    liveSteps.add(pending.step);
  }
  for (const [id, step] of state.stepById) {
    if (!liveSteps.has(step)) {
      state.stepById.delete(id);
    }
  }
  for (const [id, agent] of state.launched) {
    if (!liveAgents.has(agent)) {
      state.launched.delete(id);
      state.currentSpawns.delete(id);
    }
  }
  for (const [name, agent] of state.byName) {
    if (!liveAgents.has(agent)) {
      state.byName.delete(name);
    }
  }
  for (const id of state.toolNames.keys()) {
    if (!state.stepById.has(id) && !state.launched.has(id)) {
      state.toolNames.delete(id);
    }
  }
  const openId = state.open?.promptId ?? null;
  const orphanContexts = [...state.contexts.keys()].filter((id) => id !== openId);
  for (const id of orphanContexts.slice(0, Math.max(0, orphanContexts.length - limit))) {
    state.contexts.delete(id);
  }
  const keep = new Set(state.turns.map((turn) => turn.promptId).filter(Boolean));
  for (const id of state.pendingClassification) {
    if (id) {
      keep.add(id);
    }
  }
  if (openId) {
    keep.add(openId);
  }
  if (state.usageState.currentTurnId) {
    keep.add(state.usageState.currentTurnId);
  }
  for (const id of state.contexts.keys()) {
    keep.add(id);
  }
  retainCodexUsageKeys(state, keep);
}
function removeLatestPendingClassification(state, id) {
  const index = state.pendingClassification.lastIndexOf(id);
  if (index < 0) {
    return false;
  }
  state.pendingClassification.splice(index, 1);
  return true;
}
function latestCodexTurnIndex(state, id) {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    if (state.turns[index].promptId === id) {
      return index;
    }
  }
  return -1;
}
function retractPendingCodexTurn(state, id) {
  if (!removeLatestPendingClassification(state, id)) {
    return false;
  }
  const index = latestCodexTurnIndex(state, id);
  if (index >= 0) {
    state.turns.splice(index, 1);
    state.turnRanges.splice(index, 1);
    state.turnMembershipStarts.splice(index, 1);
  }
  return true;
}
function retractCopiedCodexCompactions(state, id) {
  const removed = /* @__PURE__ */ new Set();
  const kept = state.compactions.map((compaction, index) => ({ compaction, index })).filter(({ index }) => {
    if (state.compactionTurnIds[index] !== id) {
      return true;
    }
    removed.add(index);
    return false;
  });
  if (!removed.size) {
    return;
  }
  const latestWasRemoved = removed.has(state.compactions.length - 1);
  state.compactions = kept.map(({ compaction }) => compaction);
  state.compactionRanges = kept.map(({ index }) => state.compactionRanges[index]);
  state.compactionTurnIds = kept.map(({ index }) => state.compactionTurnIds[index]);
  state.compactionValueSources = kept.map(({ index }) => state.compactionValueSources[index]);
  if (latestWasRemoved) {
    state.pendingCompactionBilling = null;
  }
}
function boundCodexTurns(state, maxTurns) {
  const limit = Math.max(0, Math.floor(maxTurns));
  if (state.pendingClassification.length > limit) {
    state.pendingClassification.splice(0, state.pendingClassification.length - limit);
  }
  const remainingById = /* @__PURE__ */ new Map();
  for (const id of state.pendingClassification) {
    remainingById.set(id, (remainingById.get(id) ?? 0) + 1);
  }
  const pendingIndexes = /* @__PURE__ */ new Set();
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const id = state.turns[index].promptId;
    const remaining = remainingById.get(id) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    pendingIndexes.add(index);
    remainingById.set(id, remaining - 1);
  }
  const knownIndexes = [];
  for (let index = 0; index < state.turns.length; index++) {
    if (!pendingIndexes.has(index)) {
      knownIndexes.push(index);
    }
  }
  const remove = new Set(knownIndexes.slice(0, Math.max(0, knownIndexes.length - limit)));
  if (remove.size) {
    for (const index of remove) {
      const start = state.turnMembershipStarts[index] ?? state.turnRanges[index]?.start;
      if (start !== void 0 && (state.turnLimitStart === null || start > state.turnLimitStart)) {
        state.turnLimitStart = start;
      }
    }
    state.turns = state.turns.filter((_turn, index) => !remove.has(index));
    state.turnRanges = state.turnRanges.filter((_range, index) => !remove.has(index));
    state.turnMembershipStarts = state.turnMembershipStarts.filter((_start, index) => !remove.has(index));
    state.turnLimitReached = true;
  }
  if (state.compactions.length > limit) {
    const count = state.compactions.length - limit;
    state.compactions.splice(0, count);
    state.compactionRanges.splice(0, count);
    state.compactionTurnIds.splice(0, count);
    state.compactionValueSources.splice(0, count);
  }
  compactCodexAssociations(state, maxTurns);
}
function trimCodexBefore(state, offset, maxTurns) {
  pruneCodexReplayLedger(state.usageState, offset);
  const resetRequired = state.usageState.replayResetRequired;
  if (state.turnLimitStart !== null && state.turnLimitStart < offset) {
    state.turnLimitReached = false;
    state.turnLimitStart = null;
  }
  if (state.lastContextSource && state.lastContextSource.start < offset) {
    state.lastContext = 0;
    state.lastContextSource = null;
  }
  if (state.lastModelSource && state.lastModelSource.start < offset) {
    state.lastModel = null;
    state.lastModelSource = null;
  }
  if (state.lastProviderSource && state.lastProviderSource.start < offset) {
    state.lastProviderSource = null;
  }
  if (state.lastServiceTierSource && state.lastServiceTierSource.start < offset) {
    state.lastServiceTierSource = null;
  }
  const pendingBilling = state.pendingCompactionBilling;
  if (pendingBilling) {
    if (pendingBilling.modelSource && pendingBilling.modelSource.start < offset) {
      pendingBilling.model = null;
      pendingBilling.modelSource = null;
    }
    if (pendingBilling.providerSource && pendingBilling.providerSource.start < offset) {
      pendingBilling.provider = null;
      pendingBilling.providerSource = null;
    }
    if (pendingBilling.serviceTierSource && pendingBilling.serviceTierSource.start < offset) {
      pendingBilling.serviceTier = null;
      pendingBilling.serviceTierSource = null;
    }
  }
  const remainingById = /* @__PURE__ */ new Map();
  for (const id of state.pendingClassification) {
    remainingById.set(id, (remainingById.get(id) ?? 0) + 1);
  }
  const pendingIndexes = /* @__PURE__ */ new Set();
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const id = state.turns[index].promptId;
    const remaining = remainingById.get(id) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    pendingIndexes.add(index);
    remainingById.set(id, remaining - 1);
  }
  const retained = state.turns.map((turn, index) => ({
    turn,
    range: state.turnRanges[index],
    membershipStart: state.turnMembershipStarts[index] ?? state.turnRanges[index].start,
    index
  })).filter(({ membershipStart }) => membershipStart >= offset);
  const straddlesTurnDependency = retained.some(
    ({ range, membershipStart }) => range.start < offset && membershipStart >= offset
  );
  state.turns = retained.map(({ turn }) => turn);
  state.turnRanges = retained.map(({ range }) => range);
  state.turnMembershipStarts = retained.map(({ membershipStart }) => membershipStart);
  state.pendingClassification = retained.filter(({ index }) => pendingIndexes.has(index)).map(({ turn }) => turn.promptId).filter(Boolean);
  const compactions = state.compactions.map((compaction, index) => ({
    compaction,
    range: state.compactionRanges[index],
    turnId: state.compactionTurnIds[index] ?? null,
    valueSources: state.compactionValueSources[index] ?? { context: null, model: null }
  })).filter(({ range }) => range.start >= offset);
  for (const { compaction, valueSources } of compactions) {
    if (valueSources.context && valueSources.context.start < offset) {
      compaction.contextBefore = 0;
      valueSources.context = null;
    }
    if (valueSources.model && valueSources.model.start < offset) {
      compaction.model = null;
      valueSources.model = null;
    }
  }
  state.compactions = compactions.map(({ compaction }) => compaction);
  state.compactionRanges = compactions.map(({ range }) => range);
  state.compactionTurnIds = compactions.map(({ turnId }) => turnId);
  state.compactionValueSources = compactions.map(({ valueSources }) => valueSources);
  for (const [id, context] of state.contexts) {
    if (context.start < offset) {
      state.contexts.delete(id);
    }
  }
  boundCodexTurns(state, maxTurns);
  return resetRequired || straddlesTurnDependency;
}
function settleCodexClassifications(state, maxTurns) {
  state.pendingClassification = [];
  boundCodexTurns(state, maxTurns);
}
function closeCodexTurn(state, maxTurns, at = 0) {
  const open = state.open;
  if (!open) {
    boundCodexTurns(state, maxTurns);
    return;
  }
  if (!worthDrawing(open)) {
    discardCodexTurn(state);
    boundCodexTurns(state, maxTurns);
    return;
  }
  const context = state.contexts.get(open.promptId);
  const classified = context !== void 0;
  if (context) {
    open.model = context.model;
    open.effort = context.effort;
    extendCodexSourceRange(open, context.start, context.end);
    state.contexts.delete(open.promptId);
  }
  open.endedAt = Math.max(open.endedAt, at);
  for (const row of open.agents) {
    if (row.status === "running") {
      row.status = LAUNCHED;
    }
  }
  const closingAgents = new Set(open.agents);
  for (const id of state.currentSpawns) {
    if (closingAgents.has(state.launched.get(id))) {
      state.currentSpawns.delete(id);
    }
  }
  const { files, fileChanges: _fileChanges, ...turn } = open;
  state.turns.push({ ...turn, files: [...files.values()] });
  const range = { start: open[CODEX_SOURCE_START] ?? 0, end: open[CODEX_SOURCE_END] ?? 0 };
  state.turnRanges.push(range);
  state.turnMembershipStarts.push(open[CODEX_MEMBERSHIP_START] ?? range.start);
  if (!classified) {
    state.pendingClassification.push(open.promptId);
  }
  state.open = null;
  state.pendingExec.clear();
  state.updateById.clear();
  state.updateByText.clear();
  state.answerById.clear();
  boundCodexTurns(state, maxTurns);
}
function codexRequestFollowsLatestCompaction(state, event, source) {
  const compactionIndex = state.compactions.length - 1;
  const compaction = state.compactions[compactionIndex] ?? null;
  if (!compaction) {
    return true;
  }
  const compactionRange = state.compactionRanges[compactionIndex] ?? null;
  if (source && compactionRange && compactionRange.end > compactionRange.start) {
    return source.start >= compactionRange.end;
  }
  return event.timestamp > compaction.at;
}
function latestPendingCodexContext(state) {
  let latest = null;
  for (const events of Object.values(state.usageState.pendingRequests)) {
    for (const event of events) {
      const source = state.usageState.pendingRequestSources[event.requestKey] ?? null;
      if (!codexRequestFollowsLatestCompaction(state, event, source)) {
        continue;
      }
      if (!latest || (source && latest.source ? source.start >= latest.source.start : event.timestamp >= latest.event.timestamp)) {
        latest = { event, source };
      }
    }
  }
  return latest;
}
function addCodexRequest(state, turn, event, source, modelSource, turnStart = source.start) {
  addUsage(turn.usage, event.usage, event.contextBand);
  addTurnUsagePart(turn, event);
  const contextTokens = event.usage.input + event.usage.cacheRead + (event.usage.cacheWrite30m ?? 0);
  const compactionIndex = state.compactions.length - 1;
  const compaction = state.compactions[compactionIndex] ?? null;
  const requestAfterCompaction = codexRequestFollowsLatestCompaction(state, event, source);
  if (requestAfterCompaction || compaction && state.open !== turn && turn.endedAt < compaction.at) {
    turn.contextTokens = contextTokens;
    const requestModel = event.model ?? state.contexts.get(turn.promptId)?.model ?? state.lastModel;
    const lifetime = cacheLifetimeFor(requestModel, state.provider);
    const wrote = event.usage.cacheWrite30m ? lifetime : null;
    if (wrote) {
      state.lastLifetime = wrote;
    }
    turn.contextRequest = {
      at: event.timestamp,
      lifetime: lifetime === null ? null : wrote ?? (state.lastLifetime === lifetime ? state.lastLifetime : lifetime),
      inferenceClass: event.inferenceClass,
      serviceTier: event.serviceTier,
      readBack: event.usage.cacheRead > 0,
      outputTokens: event.usage.output
    };
  }
  turn.contextWindow = event.contextWindow ?? turn.contextWindow;
  if (requestAfterCompaction) {
    state.lastContext = contextTokens;
    state.lastContextSource = { start: Math.min(turnStart, source.start), end: source.end };
  }
  const context = state.contexts.get(turn.promptId);
  if (event.model !== null) {
    state.lastModel = event.model;
    const modelDependency = modelSource ?? source;
    state.lastModelSource = {
      start: Math.min(turnStart, modelDependency.start),
      end: Math.max(source.end, modelDependency.end)
    };
  } else if (context?.model) {
    state.lastModel = context.model;
    state.lastModelSource = { start: context.start, end: context.end };
  }
}
function reduceCodexSessionLine(state, input, sessionId, opts) {
  const line = typeof input === "string" ? input : input.text;
  const sourceStart = typeof input === "string" ? 0 : input.start ?? 0;
  const sourceEnd = typeof input === "string" ? sourceStart : input.end ?? sourceStart;
  const hasSourceOffset = typeof input !== "string" && input.start !== void 0;
  if (line.length < 20 || !carriesRecord(line)) {
    return;
  }
  const record = parseRecord(line);
  if (!record) {
    return;
  }
  const { kind, at, payload } = record;
  const usageEvents = reduceCodexUsageEvents(state.usageState, {
    kind,
    timestamp: at,
    payload,
    sourceStart: hasSourceOffset ? sourceStart : void 0,
    sourceEnd: hasSourceOffset ? sourceEnd : void 0
  });
  const currentSource = { start: sourceStart, end: sourceEnd };
  const usageSources = new Map(
    usageEvents.map((event) => [
      event.requestKey,
      state.usageState.pendingRequestSources[event.requestKey] ?? currentSource
    ])
  );
  const releaseUsageSources = () => {
    for (const event of usageEvents) {
      delete state.usageState.pendingRequestSources[event.requestKey];
    }
  };
  if (kind === "message" && str(payload.role) === "developer") {
    const published = blocksText(payload.content);
    if (published.trimStart().startsWith(CODEX_SKILL_CATALOG)) {
      state.skillCatalog = codexSkillCatalog(published);
      return;
    }
  }
  if (kind === "task_started") {
    state.pendingCompactionBilling = null;
    closeCodexTurn(state, opts.maxTurns ?? 40);
    if (state.usageState.currentTurnCopied) {
      return;
    }
    const turn2 = newTurn(
      sessionId,
      str(payload.turn_id) ?? "",
      at,
      num(payload.model_context_window),
      state.provider
    );
    setCodexSourceRange(turn2, sourceStart, sourceEnd);
    setCodexMembershipStart(turn2, sourceStart);
    state.open = turn2;
    state.updateSequence = 0;
    return;
  }
  if (kind === "turn_context") {
    const id = str(payload.turn_id);
    let classifiedAfterHorizon = -1;
    if (id && state.usageState.datedCopiedTurnIds[id]) {
      retractCopiedCodexCompactions(state, id);
      if (state.open && id === state.open.promptId) {
        discardCodexTurn(state);
        delete state.usageState.datedCopiedTurnIds[id];
        boundCodexTurns(state, opts.maxTurns ?? 40);
        return;
      }
      if (retractPendingCodexTurn(state, id)) {
        delete state.usageState.datedCopiedTurnIds[id];
        boundCodexTurns(state, opts.maxTurns ?? 40);
        return;
      }
      classifiedAfterHorizon = latestCodexTurnIndex(state, id);
      if (classifiedAfterHorizon < 0) {
        state.contexts.set(id, {
          model: str(payload.model),
          effort: str(payload.effort),
          start: sourceStart,
          end: sourceEnd
        });
        boundCodexTurns(state, opts.maxTurns ?? 40);
        return;
      }
      delete state.usageState.datedCopiedTurnIds[id];
      delete state.usageState.copiedTurnIds[id];
      if (state.usageState.currentTurnId === id) {
        state.usageState.currentTurnCopied = false;
      }
      if (!state.usageState.countedTurnIds[id] && state.usageState.currentTurnId !== id) {
        state.usageState.countedTurnIds[id] = true;
        state.usageState.closedTurns++;
      }
    }
    if (id && state.usageState.currentTurnCopied && id === state.usageState.currentTurnId) {
      if (state.open && id === state.open.promptId) {
        discardCodexTurn(state);
      } else {
        retractPendingCodexTurn(state, id);
      }
      boundCodexTurns(state, opts.maxTurns ?? 40);
      return;
    }
    if (id) {
      const context = {
        model: str(payload.model),
        effort: str(payload.effort),
        start: sourceStart,
        end: sourceEnd
      };
      if (context.model) {
        state.lastModel = context.model;
        state.lastModelSource = { start: sourceStart, end: sourceEnd };
      }
      const pending = removeLatestPendingClassification(state, id);
      const closedIndex = pending ? latestCodexTurnIndex(state, id) : classifiedAfterHorizon;
      if (closedIndex >= 0) {
        const closed = state.turns[closedIndex];
        closed.model = context.model;
        closed.effort = context.effort;
        const range = state.turnRanges[closedIndex];
        if (range) {
          range.start = Math.min(range.start, sourceStart);
          range.end = Math.max(range.end, sourceEnd);
        }
        for (const event of usageEvents) {
          addCodexRequest(
            state,
            closed,
            event,
            usageSources.get(event.requestKey) ?? currentSource,
            context,
            range?.start
          );
        }
      } else {
        state.contexts.set(id, context);
      }
      boundCodexTurns(state, opts.maxTurns ?? 40);
    }
    if (state.open && id === state.open.promptId) {
      extendCodexSourceRange(state.open, sourceStart, sourceEnd);
      for (const event of usageEvents) {
        addCodexRequest(
          state,
          state.open,
          event,
          usageSources.get(event.requestKey) ?? currentSource,
          {
            start: sourceStart,
            end: sourceEnd
          },
          state.open[CODEX_SOURCE_START]
        );
      }
    }
    releaseUsageSources();
    return;
  }
  if (kind === "thread_settings_applied") {
    const settings = isRecord(payload.thread_settings) ? payload.thread_settings : {};
    const model = str(settings.model) ?? str(settings.model_id);
    const provider = str(settings.model_provider_id);
    const serviceTier = str(settings.service_tier);
    if (model) {
      state.lastModel = model;
      state.lastModelSource = { start: sourceStart, end: sourceEnd };
    }
    if (provider) {
      state.lastProviderSource = { start: sourceStart, end: sourceEnd };
    }
    if (serviceTier) {
      state.lastServiceTierSource = { start: sourceStart, end: sourceEnd };
    }
    const pendingBilling = state.pendingCompactionBilling;
    if (pendingBilling) {
      const index = state.compactions.length - 1;
      const compaction = state.compactions[index];
      if (compaction?.at === pendingBilling.at) {
        compaction.model = model ?? pendingBilling.model;
        compaction.provider = provider ?? pendingBilling.provider;
        compaction.serviceTier = serviceTier ?? pendingBilling.serviceTier;
        if (compaction.model) {
          state.compactionValueSources[index].model = { start: sourceStart, end: sourceEnd };
        }
        compaction.inferenceClass = compaction.provider === "amazon-bedrock" ? bedrockInferenceClass(compaction.model) : null;
      }
      state.pendingCompactionBilling = null;
    }
  }
  if (state.usageState.currentTurnCopied) {
    return;
  }
  if (kind === "compacted") {
    const exactUsage = codexRequestUsage(
      isRecord(payload.latest_token_usage_record) ? payload.latest_token_usage_record.usage : null
    );
    const pendingContext = latestPendingCodexContext(state);
    const contextBefore = exactUsage ? requestInputTokens(exactUsage) : pendingContext ? pendingContext.event.usage.input + pendingContext.event.usage.cacheRead + (pendingContext.event.usage.cacheWrite30m ?? 0) : state.lastContext;
    const provider = state.usageState.provider ?? state.provider;
    const model = state.lastModel;
    const turnId = state.usageState.currentTurnId;
    const contextWindow = turnId ? state.usageState.turnWindows[turnId] ?? null : null;
    state.compactions.push({
      sessionId,
      at,
      contextBefore,
      contextAfter: 0,
      droppedTokens: 0,
      durationMs: 0,
      trigger: codexCompactionTrigger(
        state.usageState.currentTurnId !== null,
        state.usageState.currentTurnCopied,
        state.usageState.currentTurnDidSomething
      ),
      model: exactUsage ? null : model,
      summary: "",
      ...exactUsage ? {
        usage: exactUsage,
        provider: null,
        contextWindow,
        inferenceClass: null,
        serviceTier: null
      } : {}
    });
    state.compactionRanges.push({ start: sourceStart, end: sourceEnd });
    state.compactionTurnIds.push(state.usageState.currentTurnId);
    state.compactionValueSources.push({
      context: exactUsage ? { start: sourceStart, end: sourceEnd } : pendingContext?.source ? { ...pendingContext.source } : state.lastContextSource ? { ...state.lastContextSource } : null,
      model: state.lastModelSource ? { ...state.lastModelSource } : null
    });
    state.pendingCompactionBilling = exactUsage ? {
      at,
      model,
      modelSource: state.lastModelSource ? { ...state.lastModelSource } : null,
      provider,
      providerSource: state.lastProviderSource ? { ...state.lastProviderSource } : null,
      serviceTier: state.usageState.serviceTier,
      serviceTierSource: state.lastServiceTierSource ? { ...state.lastServiceTierSource } : null
    } : null;
    state.lastContext = 0;
    state.lastContextSource = null;
    if (state.open) {
      state.open.contextTokens = 0;
      state.open.contextRequest = void 0;
    }
    boundCodexTurns(state, opts.maxTurns ?? 40);
    return;
  }
  if (kind === "task_complete" || kind === "turn_aborted") {
    state.pendingCompactionBilling = null;
  }
  if (!state.open) {
    releaseUsageSources();
    return;
  }
  const turn = state.open;
  extendCodexSourceRange(turn, sourceStart, sourceEnd);
  switch (kind) {
    case "task_complete": {
      const rawSummary = answerInTaskComplete(record);
      const lastAnswer = turn.answers[turn.answers.length - 1];
      turn.summary = lastAnswer && stripWhitespace(lastAnswer.text) === stripWhitespace(rawSummary) ? lastAnswer.text : rawSummary;
      const failed = str(payload.error?.message);
      turn.error = failedCodexTurn(record) && failed ? errorMessage(failed) : null;
      turn.finished = finishedCodexTurn(record);
      closeCodexTurn(state, opts.maxTurns ?? 40, at);
      break;
    }
    case "turn_aborted": {
      turn.interrupted = interruptedCodexTurn(record);
      turn.finished = false;
      const lastAnswer = turn.answers[turn.answers.length - 1];
      if (!turn.summary && lastAnswer) {
        turn.summary = lastAnswer.text;
      }
      closeCodexTurn(state, opts.maxTurns ?? 40, at);
      break;
    }
    case "user_message":
    case "message": {
      const notification = subagentNotification(record);
      if (notification) {
        const row = turn.agents.find((agent) => agent.id === notification.id);
        if (row) {
          finishSpawn(state, row, notification.status);
        }
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const raw = userMessage(record);
      if (raw !== null) {
        const asked = codexPrompt(raw);
        if (!asked) {
          break;
        }
        if (!turn.prompt) {
          turn.prompt = asked;
          break;
        }
        turn.laterPrompts.push({ text: asked, at, stepsBefore: turn.stepCount });
        if (turn.laterPrompts.length > TURN_ASK_LIMIT) {
          turn.laterPrompts.shift();
        }
        break;
      }
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      break;
    }
    case "token_count": {
      const context = state.contexts.get(turn.promptId);
      for (const event of usageEvents) {
        addCodexRequest(
          state,
          turn,
          event,
          usageSources.get(event.requestKey) ?? currentSource,
          context?.model ? { start: context.start, end: context.end } : null,
          turn[CODEX_SOURCE_START]
        );
      }
      releaseUsageSources();
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case "patch_apply_end": {
      turn.endedAt = Math.max(turn.endedAt, at);
      if (payload.success === false) {
        const message = firstLine(String(payload.stderr || payload.stdout || ""));
        turn.failures.push({ tool: "apply_patch", message });
        const paths2 = codexChangePaths(payload.changes);
        const presented2 = presentedStepDetail("apply_patch", { paths: paths2 });
        recordStep(turn, state.stepById, "apply_patch", presented2.detail, at, "", "failed", {
          ...presented2.fullDetail !== void 0 ? { fullDetail: presented2.fullDetail } : {}
        });
        break;
      }
      recordChanges(turn, payload.changes || {});
      const paths = codexChangePaths(payload.changes);
      const presented = presentedStepDetail("apply_patch", { paths });
      recordStep(turn, state.stepById, "apply_patch", presented.detail, at, "", "done", {
        ...presented.fullDetail !== void 0 ? { fullDetail: presented.fullDetail } : {}
      });
      break;
    }
    case "custom_tool_call":
    case "function_call": {
      const recordedName = str(payload.name) ?? "";
      const name = recordedName === "exec" ? nestedToolName(payload.input) ?? recordedName : recordedName;
      const id = str(payload.call_id);
      turn.toolUses++;
      turn.toolCounts[TOOL_KIND[name] ?? "other"]++;
      if (name) {
        tallyToolName(turn.toolTally, name);
      }
      if (id && name) {
        state.toolNames.set(id, name);
      }
      const command = recordedName === "exec" ? wrappedCommand(payload.input) : null;
      const detail = command ? { detail: stepDetail({ command }), fullDetail: command } : callDetail(name, payload.arguments ?? payload.input);
      const step = name ? recordStep(turn, state.stepById, name, detail.detail, at, id ?? "", "running", {
        ...id ? { sourceId: id } : {},
        ...detail.fullDetail !== void 0 ? { fullDetail: detail.fullDetail } : {}
      }) : null;
      if (recordedName === "exec" && id && step) {
        state.pendingExec.set(id, { step, expanded: false });
      }
      if (name === "spawn_agent" && id) {
        const row = recordSpawn(turn, payload);
        state.launched.set(id, row);
        if (str(payload.namespace) === "multi_agent_v1") {
          state.currentSpawns.add(id);
        }
        state.byName.set(row.description, row);
      }
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case "item_completed": {
      const activity = currentSubAgentActivity(payload);
      if (activity) {
        const row = state.launched.get(activity.callId);
        if (row) {
          const previousName = row.description;
          setSpawnIdentity(row, activity.id, activity.description, null);
          if (state.byName.get(previousName) === row) {
            state.byName.delete(previousName);
          }
          state.byName.set(row.description, row);
        }
      }
      const collab = collabSpawnCompletion(payload);
      if (collab) {
        const row = state.launched.get(collab.callId);
        if (row) {
          setSpawnIdentity(row, collab.id, collab.description, collab.model, collab.effort);
          state.currentSpawns.delete(collab.callId);
          const step = state.stepById.get(collab.callId);
          if (step) {
            step.status = "done";
          }
        }
      }
      const claudeResult = claudeCommandResult(payload);
      if (claudeResult) {
        const commandKey = claudeResult.commandId ?? `source:${sourceStart}`;
        const seen = state.seenClaudeCommands[commandKey];
        const row = {
          id: claudeResult.sessionId,
          invocationId: claudeResult.invocationId,
          description: "Claude CLI",
          agentType: "claude-cli",
          model: null,
          effort: null,
          spend: claudeResult.models,
          spendFound: claudeResult.accepted,
          spendPartial: !claudeResult.accepted,
          durationMs: claudeResult.durationMs,
          tokens: null,
          toolUses: null,
          status: claudeResult.status
        };
        if (!seen) {
          state.seenClaudeCommands[commandKey] = {
            accepted: claudeResult.accepted,
            invocationId: claudeResult.invocationId
          };
          turn.agents.push(row);
        } else if (!seen.accepted && claudeResult.accepted) {
          const existing = turn.agents.findIndex((agent) => agent.invocationId === seen.invocationId);
          if (existing >= 0) {
            turn.agents[existing] = row;
          }
          state.seenClaudeCommands[commandKey] = { accepted: true, invocationId: claudeResult.invocationId };
        }
      }
      const fileChange = completedFileChange(payload);
      if (fileChange) {
        if (fileChange.status === "done") {
          recordChanges(turn, fileChange.changes);
        }
        const candidates = [...state.pendingExec.entries()].filter(([, pending2]) => !pending2.expanded);
        const patchCandidates = candidates.filter(([, pending2]) => pending2.step.name === "apply_patch");
        const matching = patchCandidates.filter(
          ([, pending2]) => fileChange.paths.some((path2) => (pending2.step.fullDetail ?? pending2.step.detail).split("\n").includes(path2))
        );
        const picked = matching.length === 1 ? matching[0] : patchCandidates.length === 1 ? patchCandidates[0] : candidates.length === 1 ? candidates[0] : null;
        if (!picked) {
          break;
        }
        const [callId, pending] = picked;
        pending.step.name = "apply_patch";
        turn.stepKinds[pending.step.ordinal - 1] = TOOL_KIND.apply_patch;
        pending.step.detail = fileChange.detail;
        if (fileChange.sourceId) {
          pending.step.sourceId = fileChange.sourceId;
        }
        if (fileChange.fullDetail) {
          setFullDetail(pending.step, fileChange.fullDetail);
        }
        pending.step.at = at;
        setTurnStepStatus(turn, pending.step, fileChange.status);
        pending.expanded = true;
        state.pendingExec.delete(callId);
        state.toolNames.delete(callId);
        state.stepById.delete(callId);
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const command = completedCommand(payload);
      if (command) {
        recordCodexSkillUses(state, turn, command, at);
        const readable = command.cwd !== null;
        const window = readable && command.startedAt !== null && command.completedAt !== null && command.startedAt <= command.completedAt ? { from: command.startedAt, failed: command.failed } : null;
        recordCommits(
          turn,
          command.stdout,
          command.completedAt ?? at,
          readable ? { command: command.command, cwd: command.cwd, at: command.startedAt ?? at } : "unreadable",
          [],
          readable ? null : state.defaultDir,
          window
        );
      }
      if (command && state.pendingExec.size === 1) {
        const pending = state.pendingExec.values().next().value;
        if (!pending) {
          break;
        }
        if (!pending.expanded) {
          pending.step.detail = command.detail;
          if (command.sourceId) {
            pending.step.sourceId = command.sourceId;
          }
          setFullDetail(pending.step, command.fullDetail);
          pending.step.at = at;
          setTurnStepStatus(turn, pending.step, command.status);
          pending.expanded = true;
        } else {
          recordStep(turn, state.stepById, "exec", command.detail, at, "", command.status, {
            ...command.sourceId ? { sourceId: command.sourceId } : {},
            fullDetail: command.fullDetail
          });
        }
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const asked = parsedAsyncMessage(payload);
      if (asked) {
        recordUpdate(turn, state.updateById, state.updateByText, asked, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
        break;
      }
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      break;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      turn.endedAt = Math.max(turn.endedAt, at);
      const text = outputText(payload.output);
      const callId = str(payload.call_id) ?? "";
      const ran = state.stepById.get(callId);
      const expanded = state.pendingExec.get(callId)?.expanded === true;
      recordCommits(turn, text, at, "unreadable", [], state.defaultDir);
      const child = state.launched.get(callId);
      const result = spawnResult(text);
      if (child && result) {
        setSpawnIdentity(child, result.id, result.description, null);
        state.currentSpawns.delete(callId);
      }
      const explicitCurrentFailure = state.currentSpawns.has(callId) ? currentSpawnFailure(text) : null;
      const spawnFailure = child && !child.id && !child.agentType && !result && (!state.currentSpawns.has(callId) || explicitCurrentFailure) ? (explicitCurrentFailure ?? firstLine(text)) || "The subagent did not start." : null;
      const failed = spawnFailure || scriptFailure(text);
      if (ran && !expanded) {
        setTurnStepStatus(turn, ran, failed ? "failed" : "done");
      }
      if (failed) {
        turn.failures.push({ tool: state.toolNames.get(callId) || UNNAMED_TOOL, message: failed });
      }
      if (child && spawnFailure) {
        const index = turn.agents.indexOf(child);
        if (index >= 0) {
          turn.agents.splice(index, 1);
        }
        state.launched.delete(callId);
        state.currentSpawns.delete(callId);
        if (state.byName.get(child.description) === child) {
          state.byName.delete(child.description);
        }
      }
      if (state.pendingExec.get(callId)?.step.name !== "apply_patch" || failed) {
        state.pendingExec.delete(callId);
        state.toolNames.delete(callId);
        state.stepById.delete(callId);
      }
      break;
    }
    case "web_search_call": {
      turn.toolUses++;
      turn.toolCounts.web++;
      tallyToolName(turn.toolTally, "web_search");
      const action = isRecord(payload.action) ? payload.action : {};
      const query = str(action.query);
      const queries = Array.isArray(action.queries) ? action.queries.filter((one) => typeof one === "string") : [];
      const presented = presentedStepDetail("web_search", query ? { query } : { queries });
      recordStep(turn, state.stepById, "web_search", presented.detail, at, "", "done", {
        ...presented.fullDetail !== void 0 ? { fullDetail: presented.fullDetail } : {}
      });
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case "agent_message": {
      const delegation = codexDelegation(record, state.agentPath);
      if (delegation) {
        turn.delegation ??= delegation;
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      if (!finalChildMessage(record)) {
        break;
      }
      const author = str(payload.author);
      const row = state.byName.get(author.slice(author.lastIndexOf("/") + 1));
      if (row) {
        finishSpawn(state, row, "completed");
      }
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    case "AgentMessage":
    case "Reasoning":
    case "reasoning": {
      const update = parsedUpdate(payload);
      if (update) {
        recordUpdate(turn, state.updateById, state.updateByText, update, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      const answer = parsedFinalAnswer(payload);
      if (answer) {
        recordAnswer(turn, state.answerById, answer, at, ++state.updateSequence);
        turn.endedAt = Math.max(turn.endedAt, at);
      }
      break;
    }
    case "sub_agent_activity": {
      const row = state.launched.get(str(payload.event_id) ?? "");
      if (row) {
        row.status = str(payload.kind) === "interrupted" ? "interrupted" : "running";
        row.id = str(payload.agent_thread_id) ?? row.id;
        row.agentType = str(payload.agent_path) ?? row.agentType;
      }
      turn.endedAt = Math.max(turn.endedAt, at);
      break;
    }
    default:
      break;
  }
}
function finishCodexSession(state, opts, readBytes) {
  const maxTurns = opts.maxTurns ?? 40;
  settleCodexClassifications(state, maxTurns);
  closeCodexTurn(state, maxTurns);
  settleCodexClassifications(state, maxTurns);
  refreshCodexStructuralAgents(
    state.turns,
    state.turns[0]?.sessionId ?? state.opening.sessionId,
    opts.structuralChildren ?? [],
    opts.agentSpendOf
  );
  const title = normalizeSessionTitle(opts.sessionTitle);
  for (const turn of state.turns) {
    turn.sessionTitle = title;
  }
  return {
    turns: state.turns,
    compactions: state.compactions,
    readBytes,
    turnLimitReached: state.turnLimitReached
  };
}
function structuralAgentStatus(child, previousLines = readPreviousLines) {
  const chunkBytes = 256 * 1024;
  const cutRecordLimit = 1024 * 1024;
  const tail = tailOf(child.file, chunkBytes, true);
  let cutLine = null;
  let cursor = tail.cursor;
  let cutBytes = 0;
  while (cursor && cursor.end > 0 && cutBytes < cutRecordLimit) {
    const readBytes = Math.min(chunkBytes, cutRecordLimit - cutBytes);
    const priorEnd = cursor.end;
    const batch = previousLines(child.file, cursor, readBytes);
    if (!batch) {
      break;
    }
    cursor = batch.cursor;
    cutBytes += priorEnd - cursor.end;
    if (!batch.lines.length) {
      continue;
    }
    cutLine = batch.lines[0].text;
    break;
  }
  let turnId = null;
  let status = "running";
  let endedAt = null;
  let terminal = false;
  let startSeen = false;
  const reduce = (line) => {
    const record = parseRecord(line);
    if (!record) {
      return;
    }
    const recordTurnId = str(record.payload.turn_id);
    if (record.kind === "task_started") {
      turnId = recordTurnId;
      status = "running";
      endedAt = null;
      terminal = false;
      startSeen = true;
      return;
    }
    if (record.kind !== "task_complete" && record.kind !== "turn_aborted") {
      return;
    }
    const differentKnownTurn = recordTurnId !== null && turnId !== null && recordTurnId !== turnId;
    if (startSeen && differentKnownTurn) {
      return;
    }
    if (turnId === null) {
      turnId = recordTurnId;
    } else if (!startSeen && differentKnownTurn) {
      turnId = recordTurnId;
      terminal = false;
    }
    if (terminal) {
      return;
    }
    status = record.kind === "turn_aborted" ? "interrupted" : failedCodexTurn(record) ? "failed" : "completed";
    endedAt = record.at;
    terminal = true;
  };
  if (cutLine !== null) {
    reduce(cutLine);
  }
  for (const line of tail.lines) {
    reduce(line);
  }
  const durationMs = child.startedAt !== null && endedAt !== null && endedAt >= child.startedAt ? endedAt - child.startedAt : null;
  return { status, durationMs };
}
const CODEX_STRUCTURAL_AGENT = Symbol("codexStructuralAgent");
const CODEX_STRUCTURAL_END = Symbol("codexStructuralEnd");
const CODEX_STRUCTURAL_BASE = Symbol("codexStructuralBase");
function markStructuralAgent(agent) {
  if (agent[CODEX_STRUCTURAL_AGENT]) {
    return;
  }
  Object.defineProperty(agent, CODEX_STRUCTURAL_AGENT, { value: true });
}
function codexStructuralAgentIds(turns) {
  const ids = [];
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (agent.id && agent[CODEX_STRUCTURAL_AGENT]) {
        ids.push(agent.id);
      }
    }
  }
  return ids;
}
function rememberStructuralBase(agent) {
  if (agent[CODEX_STRUCTURAL_BASE]) {
    return;
  }
  Object.defineProperty(agent, CODEX_STRUCTURAL_BASE, {
    value: {
      status: agent.status,
      durationMs: agent.durationMs,
      spend: agent.spend,
      spendFound: agent.spendFound,
      spendPartial: agent.spendPartial,
      effort: agent.effort
    }
  });
}
function restoreStructuralBase(agent) {
  const base = agent[CODEX_STRUCTURAL_BASE];
  if (!base) {
    return;
  }
  agent.status = base.status;
  agent.durationMs = base.durationMs;
  agent.spend = base.spend;
  agent.spendFound = base.spendFound;
  agent.spendPartial = base.spendPartial;
  agent.effort = base.effort;
}
function attachCodexStructuralAgents(turns, parentThreadId, children) {
  if (!parentThreadId || !children?.length || !turns.length) {
    return;
  }
  const represented = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (agent.id) {
        represented.set(agent.id, agent);
      }
    }
  }
  const ordered = children.filter((child) => child.parentThreadId === parentThreadId && child.openedAt !== null).sort((left, right) => left.openedAt - right.openedAt);
  for (const child of ordered) {
    const existing = represented.get(child.threadId);
    if (existing) {
      if (!child.backgroundReview) {
        existing.childSessionId = child.threadId;
      } else {
        delete existing.childSessionId;
      }
      const lifecycle2 = structuralAgentStatus(child);
      if (existing[CODEX_STRUCTURAL_AGENT]) {
        existing.status = lifecycle2.status;
        existing.durationMs = lifecycle2.durationMs;
        continue;
      }
      rememberStructuralBase(existing);
      const open = existing.status === "running" || existing.status === "async_launched" || existing.status === LAUNCHED;
      if (open && lifecycle2.status !== "running") {
        existing.status = lifecycle2.status;
        existing.durationMs ??= lifecycle2.durationMs;
      }
      continue;
    }
    const openedAt = child.openedAt;
    const containing = turns.filter((turn, index) => {
      if (openedAt < turn.startedAt) {
        return false;
      }
      if (openedAt <= turn.endedAt) {
        return true;
      }
      const open = !turn.finished && !turn.error && !turn.interrupted;
      if (!open) {
        return false;
      }
      const next = turns[index + 1];
      const exclusiveEnd = next?.startedAt ?? turn[CODEX_STRUCTURAL_END];
      return exclusiveEnd !== void 0 ? openedAt < exclusiveEnd : index === turns.length - 1;
    });
    if (containing.length !== 1) {
      continue;
    }
    const lifecycle = structuralAgentStatus(child);
    const row = {
      id: child.threadId,
      description: child.backgroundReview ? "Background review" : "agent",
      agentType: child.agentPath,
      model: null,
      effort: null,
      spend: [],
      spendFound: false,
      spendPartial: false,
      durationMs: lifecycle.durationMs,
      tokens: null,
      toolUses: null,
      status: lifecycle.status,
      ...child.backgroundReview ? {} : { childSessionId: child.threadId }
    };
    markStructuralAgent(row);
    containing[0].agents.push(row);
    represented.set(child.threadId, row);
  }
}
function refreshCodexStructuralAgents(turns, parentThreadId, children, lookup, structuralIds) {
  const marked = structuralIds?.length ? new Set(structuralIds) : null;
  const direct = new Set(
    children.filter((child) => child.parentThreadId === parentThreadId).map((child) => child.threadId)
  );
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (marked && agent.id && marked.has(agent.id)) {
        markStructuralAgent(agent);
      }
      restoreStructuralBase(agent);
      delete agent.childSessionId;
    }
    turn.agents = turn.agents.filter(
      (agent) => !agent[CODEX_STRUCTURAL_AGENT] || agent.id !== null && direct.has(agent.id)
    );
  }
  attachCodexStructuralAgents(turns, parentThreadId, children);
  attachCodexAgentSpend(turns, lookup);
}
function materializeCodexSession(source, opts, readBytes) {
  return finishCodexSession(cloneParserState(source), opts, readBytes);
}
function codexHiddenSlots(state) {
  return { turns: state.turns, open: state.open, pending: null };
}
function codexSnapshot(state) {
  const copy = cloneParserState(state);
  copy.hidden = hiddenParserState(codexHiddenSlots(copy), CODEX_HIDDEN_POLICY);
  return copy;
}
function createCodexSessionReducer(sessionId, opts = {}, meta = null, restored) {
  const state = restored ? cloneParserState(restored) : emptyCodexSessionParserState(meta);
  if (state.version !== 13) {
    throw new Error("Incompatible Codex parser state");
  }
  applyHiddenParserState(codexHiddenSlots(state), state.hidden, CODEX_HIDDEN_POLICY);
  delete state.hidden;
  state.usageState.seenTurnOffsets ??= {};
  state.usageState.legacyReplayLinks ??= [];
  state.usageState.replayResetRequired ??= false;
  state.usageState.pendingRequestSources ??= {};
  state.usageState.seenClaudeInvocations ??= {};
  state.usageState.seenClaudeCommands ??= {};
  state.usageState.pendingClaudeResults ??= {};
  state.seenClaudeCommands ??= {};
  state.currentSpawns ??= /* @__PURE__ */ new Set();
  if (state.open) {
    state.open.fileChanges ??= /* @__PURE__ */ new Set();
  }
  state.compactionValueSources ??= state.compactions.map(() => ({ context: null, model: null }));
  state.compactionTurnIds ??= state.compactions.map(() => null);
  state.pendingCompactionBilling ??= null;
  state.lastContextSource ??= null;
  state.lastModelSource ??= null;
  state.lastProviderSource ??= null;
  state.lastServiceTierSource ??= null;
  return {
    pushLine: (line) => reduceCodexSessionLine(state, line, sessionId, opts),
    trimBefore: (offset) => trimCodexBefore(state, offset, opts.maxTurns ?? 40),
    snapshot: () => codexSnapshot(state),
    read: (readBytes = 0) => materializeCodexSession(state, opts, readBytes),
    finish: (readBytes = 0) => finishCodexSession(state, opts, readBytes),
    completedTurns: () => {
      const completed = cloneParserState(state);
      const last = completed.turns[completed.turns.length - 1];
      if (last && completed.open && completed.open.startedAt > last.startedAt) {
        Object.defineProperty(last, CODEX_STRUCTURAL_END, { value: completed.open.startedAt });
      }
      refreshCodexStructuralAgents(completed.turns, sessionId, opts.structuralChildren ?? [], opts.agentSpendOf);
      const title = normalizeSessionTitle(opts.sessionTitle);
      for (const turn of completed.turns) {
        turn.sessionTitle = title;
      }
      return completed.turns.map((turn, index) => ({
        turn,
        start: completed.turnRanges[index]?.start ?? 0,
        end: completed.turnRanges[index]?.end ?? 0
      }));
    },
    completedCompactions: () => {
      const completed = cloneParserState(state);
      return completed.compactions.map((compaction, index) => ({
        compaction,
        start: completed.compactionRanges[index]?.start ?? 0,
        end: completed.compactionRanges[index]?.end ?? 0
      }));
    },
    openRange: () => state.open ? {
      start: state.open[CODEX_SOURCE_START] ?? 0,
      end: state.open[CODEX_SOURCE_END] ?? 0
    } : null
  };
}
function attachCodexAgentSpend(turns, lookup) {
  if (!lookup) {
    return;
  }
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (agent.invocationId) {
        continue;
      }
      const spend = lookup({
        id: agent.id,
        name: agent.description,
        path: agent.agentType,
        status: agent.status
      });
      agent.spend = spend.models;
      if (!agent.effort) {
        agent.effort = spend.effort;
      }
      agent.spendFound = spend.found;
      agent.spendPartial = spend.partial;
      const counted = childToolCalls(agent.artifacts);
      if (spend.artifacts) {
        agent.artifacts = cloneChildArtifacts(spend.artifacts);
      } else {
        delete agent.artifacts;
      }
      if (agent.toolUses === null || agent.toolUses === counted) {
        agent.toolUses = childToolCalls(agent.artifacts);
      }
      if (spend.usageIncomplete) {
        agent.spendIncomplete = true;
      } else {
        delete agent.spendIncomplete;
      }
    }
  }
}
function readCodexSessionLines(lines, sessionId, opts, readBytes, meta) {
  const reducer = createCodexSessionReducer(sessionId, opts, meta);
  for (const line of lines) {
    reducer.pushLine(line);
  }
  return reducer.finish(readBytes);
}
function worthDrawing(turn) {
  return turn.prompt !== "" || turn.delegation !== void 0 || turn.summary !== "" || turn.toolUses > 0 || turn.files.size > 0 || turn.updates.length > 0 || turn.error !== null || turn.interrupted;
}
function newTurn(sessionId, turnId, at, contextWindow, provider) {
  return {
    agent: "codex",
    sessionId,
    sessionTitle: null,
    promptId: turnId,
    startedAt: at,
    endedAt: at,
    prompt: "",
    summary: "",
    // `task_complete` only ever names `last_agent_message`, the newest one. Every
    // `final_answer` message the turn closed before that, `recordAnswer` collects here.
    answers: [],
    model: null,
    provider,
    effort: null,
    files: /* @__PURE__ */ new Map(),
    fileChanges: /* @__PURE__ */ new Set(),
    agents: [],
    commits: [],
    usage: {
      requests: 0,
      input: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0
    },
    usageParts: [],
    contextTokens: 0,
    contextWindow,
    toolUses: 0,
    toolCounts: emptyToolCounts(),
    toolTally: {},
    laterPrompts: [],
    steps: [],
    stepCount: 0,
    stepKinds: [],
    failedOrdinals: [],
    skillUses: [],
    skillUseCount: 0,
    updates: [],
    failures: [],
    interrupted: false,
    finished: false,
    error: null
  };
}
function setFullDetail(step, fullDetail) {
  Object.defineProperty(step, "fullDetail", {
    value: fullDetail,
    enumerable: false,
    configurable: true,
    writable: true
  });
}
function recordStep(turn, byId, name, detail, at, id, status = "running", metadata = {}) {
  const step = {
    ordinal: ++turn.stepCount,
    name,
    detail,
    at,
    status,
    ...metadata.sourceId ? { sourceId: metadata.sourceId } : {}
  };
  if (id) {
    Object.defineProperty(step, "id", { value: id });
  }
  if (metadata.fullDetail !== void 0) {
    setFullDetail(step, metadata.fullDetail);
  }
  turn.stepKinds.push(TOOL_KIND[name] ?? "other");
  setTurnStepStatus(turn, step, status);
  turn.steps.push(step);
  if (turn.steps.length > TURN_STEP_LIMIT) {
    turn.steps.shift();
  }
  if (id) {
    byId.set(id, step);
  }
  return step;
}
function recordUpdate(turn, byId, byText, parsed, at, sequence) {
  const sourceId = parsed.sourceId ?? `${turn.promptId}:${parsed.kind}:${at}:${sequence}`;
  const textKey = `${parsed.kind}:${at}:${parsed.text}`;
  const held = byId.get(sourceId) ?? byText.get(textKey);
  if (held) {
    if (parsed.text.length > held.text.length) {
      held.text = parsed.text;
    }
    held.status = "done";
    if (sourceId.startsWith("msg_")) {
      held.sourceId = sourceId;
    }
    byId.set(sourceId, held);
    byText.set(textKey, held);
    return;
  }
  const update = {
    sourceId,
    kind: parsed.kind,
    text: parsed.text,
    at,
    status: "done",
    stepsBefore: turn.stepCount
  };
  turn.updates.push(update);
  byId.set(sourceId, update);
  byText.set(textKey, update);
}
const ANSWER_PAIRING_WINDOW_MS = 2e3;
function recentMatchingAnswer(turn, text, at) {
  const last = turn.answers[turn.answers.length - 1];
  if (!last || last.text !== text || Math.abs(at - last.at) > ANSWER_PAIRING_WINDOW_MS) {
    return null;
  }
  const crossedPrompt = turn.laterPrompts.some(
    (ask) => ask.at > Math.min(at, last.at) && ask.at < Math.max(at, last.at)
  );
  return crossedPrompt ? null : last;
}
function recordAnswer(turn, byId, parsed, at, sequence) {
  const sourceId = parsed.sourceId ?? `${turn.promptId}:answer:${at}:${sequence}`;
  const held = byId.get(sourceId) ?? recentMatchingAnswer(turn, parsed.text, at);
  if (held) {
    if (parsed.text.length > held.text.length) {
      held.text = parsed.text;
    }
    byId.set(sourceId, held);
    return;
  }
  const answer = { text: parsed.text, at, stepsBefore: turn.stepCount };
  turn.answers.push(answer);
  byId.set(sourceId, answer);
}
function callDetail(name, raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { detail: "" };
  }
  try {
    const args = JSON.parse(raw);
    if (!isRecord(args)) {
      return { detail: "" };
    }
    const presented = presentedStepDetail(name, args);
    return {
      detail: presented.detail,
      ...presented.fullDetail !== void 0 ? { fullDetail: presented.fullDetail } : {}
    };
  } catch {
    const args = wrappedToolInput(name, raw);
    const presented = presentedStepDetail(name, args);
    return {
      detail: presented.detail,
      ...presented.fullDetail !== void 0 ? { fullDetail: presented.fullDetail } : {}
    };
  }
}
function decodedString(source) {
  try {
    const value = JSON.parse(source);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
function wrapperString(raw, field) {
  return wrapperStrings(raw, field)[0] ?? "";
}
function wrapperStrings(raw, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = raw.matchAll(new RegExp(`(?:["']?${escaped}["']?\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")`, "g"));
  return [...matches].map((match) => decodedString(match[1])).filter(Boolean);
}
function wrapperCollection(raw, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:["']?${escaped}["']?\\s*:\\s*)\\[`).exec(raw);
  if (!match) {
    return "";
  }
  const start = match.index + match[0].lastIndexOf("[");
  let depth = 0;
  let quote = "";
  let escapedCharacter = false;
  for (let index = start; index < raw.length; index++) {
    const character = raw[index];
    if (quote) {
      if (escapedCharacter) {
        escapedCharacter = false;
        continue;
      }
      if (character === "\\") {
        escapedCharacter = true;
        continue;
      }
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      depth++;
    } else if (character === "]" && --depth === 0) {
      return raw.slice(start, index + 1);
    }
  }
  return "";
}
function patchText(raw) {
  const call = /\btools\.apply_patch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"\\])*")/.exec(raw);
  if (!call) {
    return "";
  }
  if (call[1].startsWith('"')) {
    return decodedString(call[1]);
  }
  const name = call[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`).exec(raw);
  return assignment ? decodedString(assignment[1]) : "";
}
function patchPaths(patch) {
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line);
    if (match?.[1]) {
      paths.push(match[1].trim());
    }
  }
  return [...new Set(paths)];
}
function wrappedToolInput(name, raw) {
  if (name === "apply_patch") {
    const paths = patchPaths(patchText(raw));
    return paths.length ? { paths } : {};
  }
  if (name === "web__run") {
    const collections = [
      ["search_query", "q"],
      ["image_query", "q"],
      ["find", "pattern"],
      ["open", "ref_id"],
      ["finance", "ticker"],
      ["weather", "location"],
      ["sports", "team"],
      ["sports", "league"],
      ["time", "utc_offset"]
    ];
    for (const [collection, field] of collections) {
      const values = wrapperStrings(wrapperCollection(raw, collection), field);
      if (values.length) {
        return { [collection]: values.map((value) => ({ [field]: value })) };
      }
    }
    return {};
  }
  const input = {};
  for (const field of [
    "skill",
    "command",
    "cmd",
    "file_path",
    "filePath",
    "path",
    "url",
    "query",
    "pattern",
    "task_name",
    "recipient",
    "target",
    "to",
    "description",
    "prompt",
    "summary",
    "task_id"
  ]) {
    const value = wrapperString(raw, field);
    if (value) {
      input[field] = value;
    }
  }
  return input;
}
function nestedToolName(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const names = /* @__PURE__ */ new Set();
  for (const match of raw.matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    names.add(match[1]);
  }
  if (names.size !== 1) {
    return null;
  }
  const [name] = names;
  return name === "exec_command" || name === "shell_command" ? null : name;
}
function wrappedCommand(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const match = /\btools\.(?:exec_command|shell_command)\s*\(\s*\{\s*(?:"(?:cmd|command)"|cmd|command)\s*:\s*("(?:\\.|[^"\\])*")/.exec(
    raw
  );
  if (!match) {
    return null;
  }
  try {
    const command = JSON.parse(match[1]);
    return typeof command === "string" && command.trim() ? command : null;
  } catch {
    return null;
  }
}
function recordSpawn(turn, call) {
  let args = {};
  try {
    args = JSON.parse(String(call.arguments || "{}"));
  } catch {
  }
  const row = {
    id: null,
    description: str(args.task_name) ?? "agent",
    agentType: null,
    model: str(args.model),
    effort: str(args.reasoning_effort),
    spend: [],
    spendFound: false,
    spendPartial: false,
    durationMs: null,
    tokens: null,
    toolUses: null,
    status: "running"
  };
  const id = str(call.call_id);
  if (id) {
    Object.defineProperty(row, "toolUseId", { value: id });
  }
  turn.agents.push(row);
  return row;
}
function collabSpawnCompletion(payload) {
  const item = payload.item;
  if (!isRecord(item) || str(item.type) !== "CollabAgentToolCall" || str(item.tool) !== "spawn_agent" || str(item.status) !== "completed") {
    return null;
  }
  const callId = str(item.id);
  const receivers = Array.isArray(item.receiver_agents) ? item.receiver_agents : [];
  const receiver = receivers.find(isRecord);
  const receiverId = receiver ? str(receiver.thread_id) : null;
  const id = receiverId ?? (Array.isArray(item.receiver_thread_ids) ? str(item.receiver_thread_ids[0]) : null);
  if (!callId || !id) {
    return null;
  }
  return {
    callId,
    id,
    description: receiver ? str(receiver.agent_nickname) : null,
    model: str(item.model),
    effort: str(item.reasoning_effort)
  };
}
function currentSubAgentActivity(payload) {
  const item = payload.item;
  if (!isRecord(item) || str(item.type) !== "SubAgentActivity") {
    return null;
  }
  const callId = str(item.id);
  const id = str(item.agent_thread_id);
  const agentPath = str(item.agent_path);
  const description = agentPath?.slice(agentPath.lastIndexOf("/") + 1) ?? null;
  if (!callId || !id || !description) {
    return null;
  }
  return { callId, id, description };
}
function setSpawnIdentity(row, id, description, model, effort = null) {
  if (id) {
    row.id = id;
  }
  if (description) {
    row.description = description;
  }
  if (model) {
    row.model = model;
  }
  if (effort) {
    row.effort = effort;
  }
}
function finishSpawn(state, row, status) {
  if (row.status === "completed" || row.status === "failed") {
    return;
  }
  row.status = status;
  for (const [id, launched] of state.launched) {
    if (launched !== row) {
      continue;
    }
    state.launched.delete(id);
    state.currentSpawns.delete(id);
    state.toolNames.delete(id);
    state.stepById.delete(id);
  }
  for (const [name, launched] of state.byName) {
    if (launched === row) {
      state.byName.delete(name);
    }
  }
}
function visibleCodexChangePath(written, raw) {
  const change = raw || {};
  const filePath = str(change.move_path) ?? written;
  return filePath && !isEphemeralPath(filePath) ? filePath : null;
}
function hasVisibleCodexChanges(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  return Object.entries(raw).some(
    ([written, change]) => visibleCodexChangePath(written, change) !== null
  );
}
function recordChanges(turn, changes) {
  for (const [written, raw] of Object.entries(changes)) {
    const change = raw || {};
    const filePath = visibleCodexChangePath(written, raw);
    if (!filePath) {
      continue;
    }
    const fingerprint = JSON.stringify([
      written,
      str(change.type),
      str(change.move_path),
      typeof change.content === "string" ? change.content : null,
      typeof change.unified_diff === "string" ? change.unified_diff : null
    ]);
    if (turn.fileChanges.has(fingerprint)) {
      continue;
    }
    const kind = str(change.type);
    const content = typeof change.content === "string" ? change.content : null;
    const hunks = typeof change.unified_diff === "string" ? hunksFromUnifiedDiff(change.unified_diff) : [];
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          added++;
        } else if (line.startsWith("-")) {
          removed++;
        }
      }
    }
    if (kind === "add") {
      added = countLines(content || "");
    }
    if (kind === "delete") {
      removed = countLines(content || "");
    }
    const key = normalizeFsPath(filePath);
    const entry = turn.files.get(key) || { path: filePath, added: 0, removed: 0, isNew: false, edits: [] };
    entry.added += added;
    entry.removed += removed;
    if (kind === "add") {
      entry.isNew = true;
    }
    entry.edits.push({
      hunks,
      // A delete records the text it took out, which is the whole before side of the file,
      // against an after side of nothing. An update records neither side, so its diff is
      // the regions it changed and no more.
      originalFile: kind === "delete" ? content : null,
      content: kind === "add" ? content : kind === "delete" ? "" : null,
      isCreate: kind === "add"
    });
    turn.files.set(key, entry);
    turn.fileChanges.add(fingerprint);
  }
}
function mayHaveUnrecordedEdits(turn) {
  return turn.agent === "codex" && turn.toolCounts.commands > 0 && turn.files.length === 0;
}
export {
  CODEX_STAT_ACTIVE_MS,
  CODEX_STAT_REVALIDATE_MS,
  CODEX_USAGE_ASSOCIATION_LIMIT,
  COLD_OPENING_READS,
  CodexMetaCache,
  CodexStatCache,
  REFUSED_OPENING_FIRST_RETRY_MS,
  REFUSED_OPENING_RETRY_MS,
  TOOL_KIND,
  claudeCommandResult,
  codexPrompt,
  codexRequestUsage,
  codexSessionFiles,
  codexSessionIndexPath,
  codexSessionLineMayAffectRead,
  codexSessionsRoot,
  codexStructuralAgentIds,
  codexSubagentFor,
  codexTitleFor,
  coldOpeningPass,
  createCodexSessionReducer,
  createCodexUsageLineReducer,
  discoverCodexNewestTurn,
  emptyCodexUsageReducerState,
  errorMessage,
  hunksFromUnifiedDiff,
  isAgentRun,
  isHiddenThread,
  mayHaveUnrecordedEdits,
  parseThreadNames,
  readCodexAgentSpend,
  readCodexOpening,
  readCodexSession,
  readCodexSessionActivity,
  readCodexSessionMeta,
  readCodexSessionMetaAsync,
  readCodexSessionTitle,
  readCodexSessionTitlePair,
  readCodexTurnStarts,
  readRolloutStat,
  readThreadNames,
  recordedDatePredatesOpening,
  reduceCodexUsageEvents,
  reduceCodexUsageLine,
  reduceCodexUsageLineEvents,
  reduceCodexUsageRecord,
  refreshCodexStructuralAgents,
  rolloutFiles,
  scriptFailure,
  staleMetas,
  structuralAgentStatus
};
