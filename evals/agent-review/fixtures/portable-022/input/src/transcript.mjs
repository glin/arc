import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import {
  addModelUsage,
  addUsage,
  agentSpendIsOpen,
  modelSpends,
  openSpendBand,
  scanLines,
  spendFileVersion
} from "./agentspend.mjs";
import {
  childToolCalls,
  childTurnSpan,
  cloneChildArtifacts,
  lastLineWhole,
  reduceChildArtifacts,
  UNNAMED_TOOL
} from "./childartifacts.mjs";
import { HEX_SHA, sameCommitSha } from "./domain/commit-sha.mjs";
import {
  applyHiddenParserState,
  cloneParserState,
  hiddenParserState,
  RETAINED_COMPACTIONS,
  RETAINED_REQUESTS,
  retainedRequestEvents
} from "./parserstate.mjs";
import { withoutRichContent } from "./richtext.mjs";
import { compactionEstimate } from "./pricing.mjs";
import { activityDetail, describeToolInput } from "./activitydetail.mjs";
import { shortenTo } from "./domain/text.mjs";
import { ARC_IDENTITY } from "./identity.mjs";
import { arcHome } from "./store.mjs";
import { claudeConfigHome, codexHome } from "./agentpaths.mjs";
import { describeToolInput as describeToolInput2 } from "./activitydetail.mjs";
import { shortenTo as shortenTo2 } from "./domain/text.mjs";
function samePricedPart(part, event) {
  return part.model === event.model && part.provider === event.provider && part.contextWindow === event.contextWindow && part.contextBand === event.contextBand && part.inferenceClass === event.inferenceClass && part.serviceTier === event.serviceTier && part.unclassifiedCacheWrite === event.unclassifiedCacheWrite && part.incomplete === event.incomplete && part.requestCountExact === event.requestCountExact && part.linkedInvocationId === event.linkedInvocationId && part.compactionEstimate === event.compactionEstimate;
}
function addPricedUsagePart(parts, add) {
  const same = parts.find((part) => samePricedPart(part, add));
  if (same) {
    addUsage(same.usage, add.usage);
    return;
  }
  const usage = { ...add.usage };
  if (add.usage.byContextBand) {
    usage.byContextBand = Object.fromEntries(
      Object.entries(add.usage.byContextBand).map(([band, held]) => [band, { ...held }])
    );
  }
  parts.push({ ...add, usage });
}
function addTurnUsagePart(turn, event) {
  const parts = turn.usageParts ??= [];
  const same = parts.find((part) => samePricedPart(part, event));
  if (same) {
    addUsage(same.usage, event.usage, event.contextBand);
    return;
  }
  const usage = { ...event.usage };
  if (event.contextBand) {
    usage.byContextBand = { [event.contextBand]: { ...event.usage } };
  }
  parts.push({
    model: event.model,
    provider: event.provider,
    contextWindow: event.contextWindow,
    contextBand: event.contextBand,
    inferenceClass: event.inferenceClass,
    serviceTier: event.serviceTier,
    ...event.unclassifiedCacheWrite === void 0 ? {} : { unclassifiedCacheWrite: event.unclassifiedCacheWrite },
    ...event.incomplete === void 0 ? {} : { incomplete: event.incomplete },
    ...event.requestCountExact === void 0 ? {} : { requestCountExact: event.requestCountExact },
    ...event.linkedInvocationId === void 0 ? {} : { linkedInvocationId: event.linkedInvocationId },
    ...event.compactionEstimate ? { compactionEstimate: true } : {},
    usage
  });
}
const CACHE_LIFETIMES = ["5m", "30m", "1h"];
function isCacheLifetime(value) {
  return typeof value === "string" && CACHE_LIFETIMES.includes(value);
}
function responseAnswerIndex(turn) {
  for (let index = turn.answers.length - 1; index >= 0; index--) {
    if (turn.answers[index].notResponse) {
      continue;
    }
    return turn.answers[index].text === turn.summary ? index : -1;
  }
  return -1;
}
const TURN_ASK_LIMIT = 12;
const TURN_SKILL_USE_LIMIT = 60;
const SKILL_STEP_KIND = "skill";
const TURN_STEP_LIMIT = 60;
const CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN = TURN_STEP_LIMIT * 4;
const STEP_DETAIL_LIMIT = 120;
const STEP_CUT = "...";
const NARRATION_DETAIL_LIMIT = 600;
function stepDetail(input) {
  return shortenTo(describeToolInput(input).replace(/\s+/g, " ").trim(), STEP_DETAIL_LIMIT, STEP_CUT);
}
function presentedStepDetail(name, input) {
  const presented = activityDetail(name, input);
  const oneLine = presented.exact.replace(/\s+/g, " ").trim();
  const detail = shortenTo(oneLine, STEP_DETAIL_LIMIT, STEP_CUT);
  const retainExact = !!presented.exact && (presented.format === "command" || presented.exact !== detail);
  return {
    detail,
    ...retainExact ? { fullDetail: presented.exact } : {},
    policy: presented.policy,
    format: presented.format
  };
}
function addTurnSkillUse(turn, use) {
  const held = turn.skillUses.findIndex((earlier) => earlier.sourceId === use.sourceId && earlier.name === use.name);
  if (held >= 0) {
    turn.skillUses[held] = use;
    return;
  }
  turn.skillUses.push(use);
  turn.skillUseCount++;
  if (turn.skillUses.length > TURN_SKILL_USE_LIMIT) {
    turn.skillUses.shift();
  }
}
function setTurnStepStatus(turn, step, status) {
  step.status = status;
  if (status === "failed" && !turn.failedOrdinals.includes(step.ordinal)) {
    turn.failedOrdinals.push(step.ordinal);
  }
}
function isClaudeSubagentReference(reference) {
  return reference.kind !== "dispatch";
}
function sameSessionRevision(cached, current) {
  return cached.mtimeMs === current.mtimeMs && cached.size === current.size;
}
function revalidatedCatalog(sessions, showing, statOf) {
  if (!showing) {
    return null;
  }
  const at = sessions.findIndex((session) => session.sessionId === showing);
  if (at < 0) {
    return null;
  }
  const held = sessions[at];
  const now = statOf(held.file);
  if (!now) {
    return null;
  }
  const out = [...sessions];
  if (!sameSessionRevision(held, now)) {
    out[at] = { ...held, mtimeMs: now.mtimeMs, size: now.size };
  }
  return out;
}
function revalidatedCatalogPaths(sessions, files, statOf) {
  if (files.length === 0) {
    return null;
  }
  const byFile = new Map(sessions.map((session, index) => [normalizeFsPath(session.file), index]));
  const out = [...sessions];
  for (const file of files) {
    const at = byFile.get(normalizeFsPath(file));
    if (at === void 0) {
      return null;
    }
    const now = statOf(out[at].file);
    if (!now) {
      return null;
    }
    if (!sameSessionRevision(out[at], now)) {
      out[at] = { ...out[at], mtimeMs: now.mtimeMs, size: now.size };
    }
  }
  return out;
}
function trustedListedRevisions(sessions, walked, showing) {
  const trusted = walked ? sessions : sessions.filter((session) => session.sessionId === showing);
  return new Map(trusted.map((session) => [session.file, { mtimeMs: session.mtimeMs, size: session.size }]));
}
function sessionStatFactsOf(read) {
  if (!read.turns.length) {
    return null;
  }
  return {
    turns: read.turns.map((turn) => ({
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      finished: turn.finished,
      error: turn.error !== null,
      model: turn.model,
      provider: turn.provider ?? null,
      usage: {
        ...turn.usage,
        ...turn.usage.byContextBand ? {
          byContextBand: Object.fromEntries(
            Object.entries(turn.usage.byContextBand).map(([band, counts]) => [band, { ...counts }])
          )
        } : {}
      },
      ...turn.usageParts ? {
        usageParts: turn.usageParts.map((part) => ({
          ...part,
          usage: {
            ...part.usage,
            ...part.usage.byContextBand ? {
              byContextBand: Object.fromEntries(
                Object.entries(part.usage.byContextBand).map(([band, counts]) => [band, { ...counts }])
              )
            } : {}
          }
        }))
      } : {},
      contextTokens: turn.contextTokens,
      contextWindow: turn.contextWindow,
      contextRequest: turn.contextRequest ? { ...turn.contextRequest } : null,
      childSpendPartial: turn.agents.length > 0
    })),
    compactions: read.compactions.map((compaction) => ({
      at: compaction.at,
      contextAfter: compaction.contextAfter,
      trigger: compaction.trigger,
      model: compaction.model
    }))
  };
}
function sessionOutcomeOf(read) {
  let newest = null;
  const openChildren = [];
  const closedChildren = [];
  const closedChildIndex = /* @__PURE__ */ new Map();
  for (const turn of read.turns) {
    if (!newest || turn.startedAt > newest.startedAt) {
      newest = turn;
    }
  }
  for (const turn of [...read.turns].sort((a, b) => a.startedAt - b.startedAt)) {
    for (const agent of turn.agents) {
      if (!agent.id) {
        continue;
      }
      if (agentIsRunning(agent)) {
        if (!openChildren.includes(agent.id)) {
          openChildren.push(agent.id);
        }
      } else {
        closeChild(closedChildren, closedChildIndex, agent.id, agent.closedAt ?? turn.endedAt);
      }
    }
    if (turn.processEndedAt !== void 0) {
      openChildren.length = 0;
      closedChildren.length = 0;
      closedChildIndex.clear();
    }
  }
  return newest ? {
    finished: newest.finished,
    error: newest.error !== null,
    interrupted: newest.interrupted,
    endedAt: newest.endedAt,
    startedAt: newest.startedAt,
    ...newest.processEndedAt !== void 0 ? { processEndedAt: newest.processEndedAt } : {},
    ...openChildren.length > 0 ? { openChildren } : {},
    ...closedChildren.length > 0 ? { closedChildren: [...closedChildren] } : {}
  } : null;
}
function projectsRoot() {
  return process.env[`${ARC_IDENTITY.environmentPrefix}PROJECTS_ROOT`] || path.join(claudeConfigHome(), "projects");
}
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
function projectDirectoryMatches(name, slug) {
  return name === slug || name.startsWith(slug.endsWith("-") ? slug : `${slug}-`);
}
function readSessionCwd(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
      if (line.indexOf('"cwd"') < 0) {
        continue;
      }
      try {
        const o = JSON.parse(line);
        if (o.cwd) {
          return o.cwd;
        }
      } catch {
      }
    }
  } catch {
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
  return null;
}
function holdsHumanPrompt(text) {
  for (const line of text.split("\n")) {
    if (humanPromptIn(line, true)) {
      return true;
    }
  }
  return false;
}
function humanPromptIn(line, refusePeer) {
  if (line.indexOf('"type":"user"') < 0) {
    return null;
  }
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isTypedPrompt(o)) {
    return null;
  }
  if (refusePeer) {
    const origin = o.origin;
    if (origin && origin.kind === "peer") {
      return null;
    }
  }
  return o;
}
const TURN_START_BYTES = 1024 * 1024;
const TURN_START_MAX_BYTES = 16 * 1024 * 1024;
function readTurnStartsFromTail(file, startsIn, bytes = TURN_START_BYTES) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const initialBytes = Math.max(1, Math.floor(bytes));
    const scale = TURN_START_MAX_BYTES / TURN_START_BYTES;
    const maxBytes = initialBytes * scale;
    let targetBytes = Math.min(size, initialBytes);
    let start = size;
    let body = Buffer.alloc(0);
    while (true) {
      const nextStart = Math.max(0, size - targetBytes);
      const length = start - nextStart;
      const chunk = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const next = fs.readSync(fd, chunk, read, length - read, nextStart + read);
        if (next <= 0) {
          throw new Error("Turn-start glance stopped before its requested range.");
        }
        read += next;
      }
      body = Buffer.concat([chunk, body]);
      start = nextStart;
      const lines = body.toString("utf8").split("\n");
      const starts = startsIn(lines);
      if (starts.length) {
        return { starts, whole: start === 0 };
      }
      if (start === 0) {
        return { starts: [], whole: true };
      }
      if (targetBytes >= maxBytes) {
        return { starts: [], whole: false };
      }
      targetBytes = Math.min(size, maxBytes, targetBytes * 2);
    }
  } catch {
    return { starts: [], whole: false };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function readSessionTurnStarts(file, bytes = TURN_START_BYTES, childTranscript = false) {
  return readTurnStartsFromTail(file, (lines) => sessionTurnStartsIn(lines, childTranscript), bytes);
}
function sessionTurnStartsIn(lines, childTranscript = false) {
  const starts = [];
  for (const line of lines) {
    if (line.indexOf('"type":"user"') < 0) {
      continue;
    }
    let o = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        const record = parsed;
        if (record.type === "user" && isTypedPrompt(record, childTranscript)) {
          o = record;
        }
      }
    } catch {
    }
    if (!o) {
      continue;
    }
    const at = Date.parse(String(o.timestamp));
    if (Number.isNaN(at)) {
      continue;
    }
    starts.push(at);
  }
  return starts;
}
function scanForHumanPrompt(file, size, prev) {
  if (prev?.found) {
    return prev;
  }
  let found = false;
  const from = prev && prev.bytes <= size ? prev.bytes : 0;
  const { bytes } = readCompleteLines(file, from, size, (text) => found = holdsHumanPrompt(text));
  return { bytes, found };
}
function readCompleteLines(file, from, size, visit) {
  let bytes = from;
  if (size <= bytes) {
    return { bytes, rest: Buffer.alloc(0) };
  }
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    let carry = null;
    let pos = bytes;
    const chunk = Buffer.allocUnsafe(256 * 1024);
    while (pos < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (read <= 0) {
        break;
      }
      pos += read;
      const buf = carry ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const lastNewline = buf.lastIndexOf(10);
      if (lastNewline < 0) {
        carry = Buffer.from(buf);
        continue;
      }
      carry = lastNewline + 1 < buf.length ? Buffer.from(buf.subarray(lastNewline + 1)) : null;
      bytes = pos - (carry ? carry.length : 0);
      if (visit(buf.subarray(0, lastNewline).toString("utf8"))) {
        return { bytes, rest: null };
      }
    }
    if (pos >= size) {
      return { bytes, rest: carry ?? Buffer.alloc(0) };
    }
  } catch {
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
  return { bytes, rest: null };
}
function readSessionRecordedTitlePair(file, bytes = 256 * 1024) {
  const read = tailOf(file, bytes);
  return recordedTitlePairIn(read.lines, read.offset);
}
function customTitleOf(o) {
  return typeof o.customTitle === "string" ? normalizeSessionTitle(o.customTitle) : null;
}
const CUSTOM_TITLE_SIDECAR_BYTES = 4 * 1024;
function readCustomTitleSidecar(sessionFile, bytes = CUSTOM_TITLE_SIDECAR_BYTES) {
  const sessionId = path.basename(sessionFile, ".jsonl");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId) || bytes <= 0) {
    return null;
  }
  let fd = -1;
  try {
    fd = fs.openSync(path.join(path.dirname(sessionFile), sessionId, "custom-title.json"), "r");
    const size = fs.fstatSync(fd).size;
    if (size < 1 || size > bytes) {
      return null;
    }
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, content, offset, size - offset, offset);
      if (read <= 0) {
        return null;
      }
      offset += read;
    }
    const parsed = JSON.parse(content.toString("utf8"));
    return typeof parsed?.customTitle === "string" ? parsed.customTitle : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function recordedTitlePairIn(lines, offset) {
  const at = (index) => {
    if (offset === void 0) {
      return {};
    }
    let position = offset;
    for (let i = 0; i < index; i++) {
      position += Buffer.byteLength(lines[i]) + 1;
    }
    return { at: position };
  };
  let generated = null;
  let customSeen = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const custom = !customSeen && lines[i].indexOf('"custom-title"') >= 0;
    if (!custom && (generated || lines[i].indexOf('"ai-title"') < 0)) {
      continue;
    }
    try {
      const o = JSON.parse(lines[i]);
      if (custom && o.type === "custom-title") {
        const short = customTitleOf(o);
        if (short) {
          return { short, full: normalizeFullSessionTitle(o.customTitle), source: "custom", ...at(i) };
        }
        customSeen = true;
        continue;
      }
      if (!generated && o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle) {
        const short = normalizeSessionTitle(o.aiTitle);
        generated = short ? { short, full: normalizeFullSessionTitle(o.aiTitle), source: "generated", ...at(i) } : { short: null, full: null, source: null };
      }
    } catch {
    }
  }
  return generated?.short ? generated : { short: null, full: null, source: null };
}
const SESSION_HEAD_BYTES = 128 * 1024;
const HEAD_KEY_BYTES = 4096;
function headKeyOf(firstLine2) {
  return createHash("sha1").update(firstLine2).digest("hex").slice(0, 16);
}
function firstPromptIn(lines, childTranscript) {
  for (const line of lines) {
    if (line.indexOf('"type":"user"') < 0) {
      continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isTypedPrompt(o, childTranscript)) {
      continue;
    }
    const source = cleanPrompt(textOf(o.message.content));
    const short = normalizeSessionTitle(source);
    if (short) {
      return { short, full: normalizeFullSessionTitle(source) };
    }
  }
  return { short: null, full: null };
}
function headLines(file, bytes) {
  return headOf(file, bytes).lines;
}
function headOf(file, bytes) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, read).toString("utf8");
    const lines = text.split("\n");
    if (read === bytes) {
      lines.pop();
    }
    return { lines, ...lines.length > 1 || read === bytes && lines.length > 0 ? { key: headKeyOf(lines[0]) } : {} };
  } catch {
    return { lines: [] };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function sessionTitleOf(file, read, childTranscript) {
  const recorded = recordedTitlePairIn(read.lines, read.offset);
  const head = read.whole ? { lines: read.lines, ...read.lines.length > 1 ? { key: headKeyOf(read.lines[0]) } : {} } : headOf(file, recorded.short ? HEAD_KEY_BYTES : SESSION_HEAD_BYTES);
  if (recorded.short) {
    return { title: recorded, headKey: head.key };
  }
  const prompt = firstPromptIn(head.lines, childTranscript);
  return {
    title: prompt.short ? { ...prompt, source: "prompt", at: 0 } : { short: null, full: null, source: null },
    headKey: head.key
  };
}
function readSessionActivity(file, bytes = 256 * 1024) {
  return activityIn(tailLines(file, bytes));
}
function closedChildId(child) {
  return typeof child === "string" ? child : child.id;
}
function indexClosedChildren(children) {
  const index = /* @__PURE__ */ new Map();
  for (let at = 0; at < children.length; at++) {
    const id = closedChildId(children[at]);
    if (!index.has(id)) {
      index.set(id, at);
    }
  }
  return index;
}
function closeChild(children, index, id, closedAt) {
  const next = { id, closedAt };
  const heldAt = index.get(id);
  if (heldAt === void 0) {
    index.set(id, children.length);
    children.push(next);
    return true;
  }
  const held = children[heldAt];
  if (typeof held !== "string" && held.closedAt === closedAt) {
    return false;
  }
  children[heldAt] = next;
  return true;
}
function claudeBackgroundLaunchOf(record) {
  if (record.type !== "user") {
    return null;
  }
  const result = record.toolUseResult;
  if (!result || typeof result !== "object") {
    return null;
  }
  if (result.status !== "async_launched" && result.status !== "launched") {
    return null;
  }
  return typeof result.agentId === "string" && result.agentId ? result.agentId : null;
}
function claudeClosedChildOf(notice) {
  const status = /<status>([^<]+)<\/status>/.exec(notice);
  if (!status || status[1] === "running") {
    return null;
  }
  return /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1] ?? null;
}
function addClosedChildNotice(closed, index, notice, closedAt) {
  const id = notice === null ? null : claudeClosedChildOf(notice);
  return id !== null && closeChild(closed, index, id, closedAt);
}
function nextOpenChildren(open, record, notice) {
  const closed = notice === null ? null : claudeClosedChildOf(notice);
  if (closed !== null) {
    return open.includes(closed) ? open.filter((id) => id !== closed) : open;
  }
  const launched = claudeBackgroundLaunchOf(record);
  return launched !== null && !open.includes(launched) ? [...open, launched] : open;
}
function nextBackgroundCommands(open, record, notice, tasks) {
  if (notice !== null) {
    const ended = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1];
    return ended !== void 0 ? withoutCommand(open, ended) : open;
  }
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return open;
  }
  const blocks = content;
  let next = open;
  if (record.type === "user") {
    const taskId = record.toolUseResult?.backgroundTaskId;
    for (const block of blocks) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      if (block.is_error === true) {
        next = withoutCommand(next, block.tool_use_id);
      } else if (typeof taskId === "string" && taskId) {
        tasks.set(taskId, block.tool_use_id);
      }
    }
    return next;
  }
  if (record.type !== "assistant") {
    return open;
  }
  for (const block of blocks) {
    if (block.type !== "tool_use") {
      continue;
    }
    const input = block.input;
    if (block.name === "TaskStop" || block.name === "KillShell") {
      const taskId = input?.task_id ?? input?.shell_id;
      const launch = typeof taskId === "string" ? tasks.get(taskId) : void 0;
      if (launch !== void 0) {
        next = withoutCommand(next, launch);
      }
      continue;
    }
    if (block.name !== "Bash" || typeof block.id !== "string" || !block.id) {
      continue;
    }
    if (input?.run_in_background !== true) {
      continue;
    }
    const id = block.id;
    if (next.some((command) => command.id === id)) {
      continue;
    }
    next = [...next, { id, startedAt: stamp(record.timestamp) }];
  }
  return next;
}
function withoutCommand(open, id) {
  return open.some((command) => command.id === id) ? open.filter((command) => command.id !== id) : open;
}
function readSessionMeta(file, bytes = 256 * 1024, sessionId = "", childTranscript = false) {
  const read = tailOf(file, bytes);
  const { title, headKey } = sessionTitleOf(file, read, childTranscript);
  const tail = outcomeIn(read.lines, childTranscript);
  return {
    title: title.short,
    fullTitle: title.full,
    titleSource: title.source,
    ...title.source && title.at !== void 0 ? { titleAt: title.at } : {},
    ...headKey ? { headKey } : {},
    activityMs: activityIn(read.lines),
    agentRun: childTranscript ? true : agentRunIn(read.lines, read.whole),
    outcome: tail.outcome,
    ...!tail.outcome && tail.backgroundCommands.length > 0 ? { backgroundCommands: tail.backgroundCommands } : {},
    ...sessionId ? {
      stats: sessionStatFactsOf(
        readSessionLines(read.lines, sessionId, { maxTurns: 40, childTranscript }, read.readBytes)
      )
    } : {}
  };
}
function agentRunIn(lines, whole) {
  if (!whole) {
    return null;
  }
  const tally = {
    prompts: 0,
    finished: false,
    unattended: false,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false
  };
  const last = lines.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === last) {
        break;
      }
      return null;
    }
    if (personSignIn(parsed, tally)) {
      return false;
    }
  }
  return agentRunOfTally(tally);
}
const UNATTENDED_SYSTEM_SUBTYPES = /* @__PURE__ */ new Set([
  "stop_hook_summary",
  "compact_boundary",
  "turn_duration",
  "api_error",
  "informational",
  "away_summary"
]);
function personSignIn(parsed, tally) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const o = parsed;
  if (o.isSidechain) {
    return false;
  }
  if (o.message?.model === "<synthetic>") {
    return false;
  }
  if (typeof o.entrypoint === "string") {
    tally.entrypoint = o.entrypoint.startsWith("sdk-") && tally.entrypoint !== "other" ? "sdk" : "other";
  }
  if (o.sessionKind === "bg") {
    tally.bg = true;
  }
  if (tally.entrypoint === "other" && !tally.bg) {
    return true;
  }
  const type = o.type;
  if (type === "bridge-session") {
    tally.bridgeSession = true;
    return false;
  }
  if (type === "system") {
    if (!UNATTENDED_SYSTEM_SUBTYPES.has(String(o.subtype))) {
      return true;
    }
    tally.unattended = true;
    return false;
  }
  if (o.toolDenialKind) {
    if (o.toolDenialKind === "user-rejected") {
      return true;
    }
    tally.deniedTool = true;
    return false;
  }
  if (type === "assistant") {
    if (askedTheReader(o)) {
      return true;
    }
    if (askedToChangeAFile(o)) {
      tally.changedFile = true;
    }
    if (finishedATurn(o)) {
      tally.finished = true;
    }
    return false;
  }
  if (type === "attachment") {
    const attachment = o.attachment;
    if (!isReaderQueued(attachment) || !cleanPrompt(textOf(attachment?.prompt))) {
      return false;
    }
    return queuedPromptIsPerson(attachment?.origin, tally);
  }
  if (type !== "user") {
    return false;
  }
  const said = textOf(o.message?.content);
  if (said.includes("<ide_")) {
    return true;
  }
  if (said.includes("<command-name>")) {
    if (o.origin?.kind === "human") {
      if (!tally.bg) {
        return true;
      }
      tallyTypedPrompt(tally);
      return false;
    }
    tally.command = true;
    tally.prompts += 1;
    return false;
  }
  if (!isTypedPrompt(o)) {
    return false;
  }
  const origin = o.origin;
  if (!tally.bg && origin?.kind === "human") {
    return true;
  }
  if (tally.bg && origin?.kind !== "human" && o.promptSource === "sdk") {
    return false;
  }
  tallyTypedPrompt(tally);
  return false;
}
function queuedPromptIsPerson(origin, tally) {
  if (origin?.kind === "human") {
    return true;
  }
  tally.prompts += 1;
  return tally.prompts > 1;
}
function tallyTypedPrompt(tally) {
  tally.prompts += 1;
}
function promptsOk(tally) {
  if (tally.bg) {
    return tally.prompts === 1;
  }
  if (tally.entrypoint === "sdk") {
    return tally.prompts >= 1;
  }
  return tally.prompts === 1;
}
function agentRunOfTally(tally) {
  const lenient = tally.entrypoint === "sdk" || tally.bg;
  const sdkOnly = tally.entrypoint === "sdk" && !tally.bg;
  return promptsOk(tally) && (tally.finished || sdkOnly) && (!tally.unattended || lenient) && (!tally.changedFile || lenient) && (!tally.deniedTool || lenient) && (!tally.command || tally.entrypoint === "sdk") && (!tally.bridgeSession || tally.bg);
}
function agentRunOfScan(scan, size) {
  return !scan.person && (scan.bytes === size || scan.end === size) && (scan.entrypoint === "sdk" || scan.bg) && agentRunOfTally(scan);
}
function scanForAgentRun(file, size, prev) {
  if (prev?.person) {
    return prev;
  }
  const resumed = prev && prev.bytes <= size ? prev : void 0;
  const scan = resumed ? { ...resumed } : {
    bytes: 0,
    prompts: 0,
    finished: false,
    unattended: false,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false,
    person: false
  };
  const read = readCompleteLines(file, scan.bytes, size, (text) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        scan.person = true;
        return true;
      }
      if (personSignIn(parsed, scan)) {
        scan.person = true;
        return true;
      }
    }
    return false;
  });
  scan.bytes = read.bytes;
  const rest = read.rest?.toString("utf8");
  if (rest !== void 0 && (!rest.trim() || !lastLineWhole(rest))) {
    scan.end = size;
  } else {
    delete scan.end;
  }
  return scan;
}
function scanForPerson(file, size, prev, start = 0) {
  if (prev?.person) {
    return prev;
  }
  const from = Math.min(start, size);
  const scan = prev && prev.bytes <= size ? { ...prev } : {
    bytes: from,
    person: false,
    prompts: 0,
    bg: false,
    start: from,
    userBefore: from > 0 && holdsUserRecord(file, from)
  };
  scan.bytes = readCompleteLines(file, scan.bytes, size, (text) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (personSpokeIn(parsed, scan)) {
        scan.person = true;
        return true;
      }
    }
    return false;
  }).bytes;
  return scan;
}
function holdsUserRecord(file, size) {
  const mark = Buffer.from('"type":"user"');
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const chunk = Buffer.allocUnsafe(4 * 1024);
    let pos = 0;
    while (pos < size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (read <= 0) {
        break;
      }
      if (chunk.subarray(0, read).includes(mark)) {
        return true;
      }
      if (pos + read >= size) {
        break;
      }
      pos += Math.max(1, read - mark.length + 1);
    }
  } catch {
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
  return false;
}
function mayHoldPersonSign(line, scan) {
  if (!scan.bg && line.includes('"sessionKind":"bg"')) {
    scan.bg = true;
  }
  return line.includes('"toolDenialKind"') || line.includes('"queued_command"') || line.includes('"type":"user"') && !line.includes('"type":"tool_result"');
}
function personSpokeIn(parsed, scan) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const o = parsed;
  if (o.isSidechain) {
    return false;
  }
  if (o.sessionKind === "bg") {
    scan.bg = true;
  }
  if (o.toolDenialKind === "user-rejected") {
    return true;
  }
  if (o.type === "attachment") {
    const attachment = o.attachment;
    return isReaderQueued(attachment) && cleanPrompt(textOf(attachment?.prompt)).length > 0;
  }
  if (o.type !== "user") {
    return false;
  }
  const said = textOf(o.message?.content);
  const human = o.origin?.kind === "human";
  if (said.includes("<command-name>")) {
    scan.prompts += 1;
    if (!human) {
      return false;
    }
    return !(scan.prompts === 1 && scan.bg && !scan.userBefore);
  }
  if (!isTypedPrompt(o) || !human && o.promptSource === "sdk") {
    return false;
  }
  scan.prompts += 1;
  if (scan.start > 0) {
    return false;
  }
  const launch = scan.prompts === 1;
  return !launch && said.includes("<ide_") || human && (!scan.bg || !launch);
}
function calledATool(record, wanted) {
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((b) => {
    const block = b;
    return !!block && block.type === "tool_use" && wanted(block.name ?? "");
  });
}
function askedToChangeAFile(record) {
  return calledATool(record, (name) => TOOL_KIND[name] === "edits");
}
const ASKS_THE_READER = /* @__PURE__ */ new Set(["AskUserQuestion"]);
function askedTheReader(record) {
  return calledATool(record, (name) => ASKS_THE_READER.has(name));
}
function finishedATurn(record) {
  const stop = record.message?.stop_reason;
  return typeof stop === "string" && stop.length > 0 && stop !== "tool_use";
}
function failedATurn(record) {
  return record.isApiErrorMessage === true;
}
function interruptedATurn(record) {
  return INTERRUPTED.test(cleanPrompt(textOf(record.message?.content)));
}
function answeredATurn(record) {
  const content = record.message?.content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return Array.isArray(content) && content.some((block) => {
    const text = block;
    return text?.type === "text" && typeof text.text === "string" && text.text.trim().length > 0;
  });
}
const RESULT_ID = /"tool_use_id"\s*:\s*"([^"]+)"/;
function skipsOrdinaryToolResult(line, isUser, wrote) {
  if (!isUser || line.indexOf('"tool_result"') < 0) {
    return false;
  }
  if (line.indexOf('"structuredPatch"') >= 0 || line.indexOf('"bashEditDiff"') >= 0 || line.indexOf('"totalToolUseCount"') >= 0 || line.indexOf('"agentId"') >= 0 || line.indexOf('"is_error":true') >= 0 || line.indexOf('"gitOperation"') >= 0) {
    return false;
  }
  if (wrote === void 0 || wrote.size === 0) {
    return true;
  }
  const id = RESULT_ID.exec(line);
  return id === null || !wrote.has(id[1]);
}
function claudeProcessEndedAt(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const value = record;
  if (value.type !== "cost-state") {
    return null;
  }
  const start = value.startTime;
  const duration = value.totalDuration;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    return null;
  }
  const endedAt = start + duration;
  return Number.isFinite(endedAt) && Number.isSafeInteger(endedAt) ? endedAt : null;
}
function outcomeIn(lines, childTranscript = false) {
  let outcome = null;
  let open = [];
  let commands = [];
  const tasks = /* @__PURE__ */ new Map();
  const closed = [];
  const closedIndex = /* @__PURE__ */ new Map();
  for (const line of lines) {
    if (line.length < 20) {
      continue;
    }
    const taskIdOnly = skipsOrdinaryToolResult(line, line.indexOf('"type":"user"') >= 0);
    if (taskIdOnly && line.indexOf('"backgroundTaskId"') < 0) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") {
      continue;
    }
    const o = record;
    if (o.isSidechain && !childTranscript) {
      continue;
    }
    if (taskIdOnly) {
      commands = nextBackgroundCommands(commands, o, null, tasks);
      continue;
    }
    const type = o.type;
    if (type === "user" && isTypedPrompt(o, childTranscript)) {
      const startedAt = stamp(o.timestamp);
      outcome = { finished: false, error: false, interrupted: false, endedAt: startedAt, startedAt };
      continue;
    }
    const notice = taskNotificationText(o);
    const processEndedAt = claudeProcessEndedAt(o);
    open = processEndedAt !== null ? [] : nextOpenChildren(open, o, notice);
    commands = processEndedAt !== null ? [] : nextBackgroundCommands(commands, o, notice, tasks);
    if (processEndedAt !== null) {
      closed.length = 0;
      closedIndex.clear();
    } else {
      addClosedChildNotice(closed, closedIndex, notice, claudeRecordAt(o));
    }
    if (!outcome && childTranscript && type === "assistant" && o.message?.stop_reason) {
      const at = stamp(o.timestamp);
      outcome = {
        finished: finishedATurn(o),
        error: failedATurn(o),
        interrupted: false,
        endedAt: at,
        startedAt: at
      };
    }
    if (!outcome) {
      continue;
    }
    if (processEndedAt !== null) {
      outcome.processEndedAt = Math.max(outcome.processEndedAt ?? 0, processEndedAt);
      continue;
    }
    if (notice !== null) {
      outcome.endedAt = Math.max(outcome.endedAt, claudeRecordAt(o));
      continue;
    }
    if (type === "user") {
      const at = stamp(o.timestamp);
      if (interruptedATurn(o)) {
        outcome.interrupted = true;
        outcome.endedAt = Math.max(outcome.endedAt, at);
        continue;
      }
      if (o.toolUseResult && typeof o.toolUseResult === "object") {
        outcome.endedAt = Math.max(outcome.endedAt, at);
      }
      continue;
    }
    if (type !== "assistant") {
      continue;
    }
    outcome.endedAt = Math.max(outcome.endedAt, stamp(o.timestamp));
    if (failedATurn(o)) {
      outcome.error = true;
      continue;
    }
    if (o.message?.model === "<synthetic>") {
      continue;
    }
    if (answeredATurn(o)) {
      outcome.error = false;
    }
    if (o.message?.stop_reason) {
      outcome.finished = finishedATurn(o);
    }
  }
  if (outcome && open.length > 0) {
    outcome.openChildren = [...open];
  }
  if (outcome && closed.length > 0) {
    outcome.closedChildren = [...closed];
  }
  if (outcome && commands.length > 0) {
    outcome.backgroundCommands = [...commands];
  }
  return { outcome, backgroundCommands: [...commands] };
}
function activityIn(lines) {
  let newest = null;
  for (const line of lines) {
    if (line.indexOf('"timestamp"') < 0) {
      continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp === void 0 || o.timestamp === null) {
      continue;
    }
    const t = Date.parse(String(o.timestamp));
    if (Number.isNaN(t)) {
      continue;
    }
    if (newest === null || t > newest) {
      newest = t;
    }
  }
  return newest;
}
function isInside(target, folders) {
  const t = normalizeFsPath(target);
  return folders.some((f) => {
    const base = normalizeFsPath(f).replace(/\/$/, "");
    return t === base || t.startsWith(base + "/");
  });
}
function transcriptDirsFor(root, folders) {
  if (folders.length === 0) {
    return [];
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const slugs = folders.map((f) => projectSlug(f).toLowerCase());
  const out = [];
  for (const d of dirs) {
    const name = d.toLowerCase();
    const exact = slugs.includes(name);
    if (!slugs.some((slug) => projectDirectoryMatches(name, slug))) {
      continue;
    }
    const full = path.join(root, d);
    const sample = listSessionFiles(full)[0];
    const cwd = sample ? readSessionCwd(sample.file) : null;
    if (cwd ? isInside(cwd, folders) : exact) {
      out.push(full);
    }
  }
  return out;
}
function relativePath(target, folders) {
  const t = normalizeFsPath(target);
  const sorted = [...folders].sort((a, b) => normalizeFsPath(b).length - normalizeFsPath(a).length);
  for (const folder of sorted) {
    const base = normalizeFsPath(folder).replace(/\/$/, "");
    if (t === base) {
      return folder.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || folder;
    }
    if (!t.startsWith(base + "/")) {
      continue;
    }
    const rest = target.replace(/\\/g, "/").slice(base.length + 1);
    if (folders.length < 2) {
      return rest;
    }
    const name = folder.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || folder;
    return `${name}/${rest}`;
  }
  return target;
}
function linkTarget(href) {
  if (!href || /^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    return null;
  }
  const anchor = /#L(\d+)(?:-L?(\d+))?$/.exec(href) || /:(\d+)(?::\d+)?$/.exec(href);
  return (anchor ? href.slice(0, anchor.index) : href) || null;
}
function linkTargetIsHtml(target) {
  return /\.html?$/i.test(target);
}
function linkTargetIsMarkdown(target) {
  return /\.(?:md|markdown)$/i.test(target);
}
function resolveLink(target, folders, exists) {
  if (!target) {
    return null;
  }
  if (path.isAbsolute(target)) {
    return target;
  }
  const joined = folders.map((f) => path.join(f, target));
  return joined.find(exists) ?? joined[0] ?? null;
}
function sessionFilesFor(root, folders, cwdOf = readSessionCwd, missingCwdFolders = folders) {
  if (folders.length === 0) {
    return [];
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const slugs = folders.map((f) => projectSlug(f).toLowerCase());
  const missingCwdSlugs = missingCwdFolders.map((f) => projectSlug(f).toLowerCase());
  const out = [];
  for (const d of dirs) {
    const name = d.toLowerCase();
    if (!slugs.some((slug) => projectDirectoryMatches(name, slug))) {
      continue;
    }
    for (const f of listSessionFiles(path.join(root, d))) {
      const cwd = cwdOf(f.file, f);
      if (cwd ? isInside(cwd, folders) : missingCwdSlugs.includes(name)) {
        out.push(cwd ? { ...f, cwd } : f);
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function listSessionFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) {
        continue;
      }
      out.push({
        agent: "claude",
        file,
        sessionId: name.slice(0, -".jsonl".length),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ...stat.ino > 0 ? { ino: stat.ino } : {}
      });
    } catch {
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function readClaudeChildSessionReferences(parent) {
  return scanClaudeChildSessionReferences(parent).references;
}
const ASYNC_AGENT_RESULT = /^\s*Async agent launched/;
const ASYNC_AGENT_ID = /\nagentId: ([A-Za-z0-9-]+)/;
const FOREGROUND_AGENT_TAIL = /(?:^|\n)agentId: ([A-Za-z0-9-]+)[^\n]*\n?<usage>([\s\S]*?)<\/usage>\s*$/;
function claudeAgentResultText(content) {
  const text = textOf(content);
  if (ASYNC_AGENT_RESULT.test(text)) {
    return {
      background: true,
      agentId: ASYNC_AGENT_ID.exec(text)?.[1] ?? null,
      tokens: null,
      toolUses: null,
      durationMs: null
    };
  }
  const tail = FOREGROUND_AGENT_TAIL.exec(text);
  const usage = tail?.[2] ?? "";
  const figure = (name) => {
    const value = new RegExp(`(?:^|\\n)${name}: (\\d+)`).exec(usage)?.[1];
    return value === void 0 ? null : Number(value);
  };
  return {
    background: false,
    agentId: tail?.[1] ?? null,
    tokens: figure("subagent_tokens"),
    toolUses: figure("tool_uses"),
    durationMs: figure("duration_ms")
  };
}
function scanClaudeChildSessionReferences(parent) {
  const launches = /* @__PURE__ */ new Set();
  const children = /* @__PURE__ */ new Map();
  const shellLaunches = /* @__PURE__ */ new Map();
  const dispatches = /* @__PURE__ */ new Map();
  let linked = 0;
  const complete = scanLines(parent.file, (line) => {
    if (line.indexOf("Agent") < 0 && line.indexOf("agentId") < 0 && line.indexOf("task-id") < 0 && line.indexOf("Bash") < 0 && line.indexOf("tool_result") < 0) {
      return;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record.type === "assistant") {
      const content = record.message?.content;
      if (!Array.isArray(content)) {
        return;
      }
      for (const block of content) {
        if (block.type === "tool_use" && block.name === "Agent" && typeof block.id === "string" && block.id) {
          launches.add(block.id);
        }
        if (block.type === "tool_use" && block.name === "Bash" && typeof block.id === "string" && block.id && typeof block.input?.command === "string") {
          const kind = claudeLaunchKind(block.input.command);
          if (kind) {
            shellLaunches.set(block.id, kind);
          }
        }
      }
      return;
    }
    const result = record.toolUseResult;
    const resultToolUseId = toolUseIdOf(record.message);
    const pairs = [];
    if (result && typeof result.agentId === "string") {
      pairs.push([resultToolUseId, result.agentId]);
    } else if (record.type === "user") {
      const blocks = record.message?.content;
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block.type !== "tool_result" || block.is_error || typeof block.tool_use_id !== "string" || !launches.has(block.tool_use_id)) {
          continue;
        }
        const agentId = claudeAgentResultText(block.content).agentId;
        if (agentId) {
          pairs.push([block.tool_use_id, agentId]);
        }
      }
    }
    const notice = taskNotificationText(record);
    if (notice !== null) {
      pairs.push([
        /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1] ?? "",
        /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1] ?? ""
      ]);
    }
    for (const [toolUseId, sessionId] of pairs) {
      if (!launches.has(toolUseId) || !/^[A-Za-z0-9-]+$/.test(sessionId)) {
        continue;
      }
      const held = children.get(sessionId);
      if (held) {
        held.add(toolUseId);
      } else if (linked < MAX_CLAUDE_CHILD_REFERENCES_PER_FILE) {
        linked++;
        children.set(sessionId, /* @__PURE__ */ new Set([toolUseId]));
      }
    }
    const shellLaunch = shellLaunches.get(resultToolUseId);
    if (!shellLaunch || dispatches.has(resultToolUseId)) {
      return;
    }
    const launchKind = shellLaunch.kind;
    const stdout = record.toolUseResult?.stdout;
    const output = launchKind === "receipt" ? typeof stdout === "string" && stdout.length > 0 ? stdout : null : shellResultText(record);
    const launched = output === null ? [] : launchKind === "receipt" ? claudeDispatchReceipts(output, shellLaunch.count) : [claudeDispatchFromOutput(output)].filter((dispatch) => dispatch !== null);
    const kept = launched.slice(0, MAX_CLAUDE_CHILD_REFERENCES_PER_FILE - linked);
    if (kept.length) {
      linked += kept.length;
      dispatches.set(
        resultToolUseId,
        kept.map((dispatch) => ({
          kind: "dispatch",
          parentSessionId: parent.sessionId,
          sessionId: dispatch.sessionId,
          file: null,
          toolUseIds: [resultToolUseId],
          name: dispatch.name,
          owned: dispatch.owned
        }))
      );
    }
  });
  const references = [...children].map(([sessionId, toolUseIds]) => ({
    kind: "subagent",
    parentSessionId: parent.sessionId,
    sessionId,
    file: parent.childTranscript ? path.join(path.dirname(parent.file), `agent-${sessionId}.jsonl`) : path.join(path.dirname(parent.file), parent.sessionId, "subagents", `agent-${sessionId}.jsonl`),
    toolUseIds: [...toolUseIds]
  }));
  references.push(...[...dispatches.values()].flat());
  return { complete, references };
}
function launchesClaudeSession(command) {
  return claudeLaunchKind(command) !== null;
}
function claudeLaunchKind(command) {
  let launch = null;
  let count = 0;
  let mixed = false;
  for (const segment of commandSegments(command)) {
    for (const offset of commandStartOffsets(segment.masked)) {
      const kind = claudeCommandKind(commandWords(segment.text, offset, segment.masked));
      if (kind === "resume") {
        return null;
      }
      if (!kind) {
        continue;
      }
      mixed ||= launch !== null && launch !== kind;
      launch = kind;
      count++;
    }
  }
  return mixed || !launch ? null : { kind: launch, count };
}
function commandStartOffsets(masked) {
  const offsets = [0];
  for (const match of masked.matchAll(/[({|&]/g)) {
    offsets.push((match.index ?? 0) + 1);
  }
  return offsets;
}
function commandWords(command, offset, masked) {
  const words = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = offset; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      started = true;
      if (quote === '"' && c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
        word += command[++i];
      } else if (c === quote && masked[i] !== FILL) {
        quote = "";
      } else {
        word += c;
      }
      continue;
    }
    if (masked[i] === FILL) {
      break;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length && ESCAPABLE.test(command[i + 1])) {
      word += command[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (/[(){}|&]/.test(c)) {
      break;
    }
    word += c;
    started = true;
  }
  if (started) {
    words.push(word);
  }
  return words;
}
function executableName(word) {
  return word.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
}
function claudeCommandKind(words) {
  let at = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) {
    at++;
  }
  while (/^(?:nohup|command|exec)$/i.test(words[at] ?? "")) {
    at++;
  }
  const executable = executableName(words[at] ?? "");
  if (/^claude(?:\.exe|\.cmd)?$/.test(executable)) {
    return resumesClaudeSession(words.slice(at + 1)) ? "resume" : "native";
  }
  if (!/^(?:cat|echo|findstr|grep|printf|rg|sed|type)$/.test(executable) && words.slice(at + 1).includes("--arc-dispatch")) {
    return "receipt";
  }
  return null;
}
function resumesClaudeSession(args) {
  let resumes = false;
  for (const word of args) {
    if (word === "--") {
      break;
    }
    if (word === "--fork-session") {
      return false;
    }
    if (/^--(?:resume|continue)(?:=|$)/.test(word)) {
      resumes = true;
      continue;
    }
    const cluster = /^-([A-Za-z]\S*)$/.exec(word)?.[1];
    if (!cluster) {
      continue;
    }
    for (const letter of cluster) {
      if (letter === "r" || letter === "c") {
        resumes = true;
        break;
      }
      if (!/[A-Za-z]/.test(letter) || letter === "d" || letter === "n" || letter === "w") {
        break;
      }
    }
  }
  return resumes;
}
const MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT = 16;
const MAX_CLAUDE_CHILD_REFERENCES_PER_FILE = 4096;
function claudeDispatchReceipts(output, launches) {
  const prefix = `${ARC_IDENTITY.environmentPrefix}DISPATCH_SESSION=`;
  const receipts = [];
  const named = /* @__PURE__ */ new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    if (line.length > 4096 || receipts.length >= Math.min(launches, MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT)) {
      return [];
    }
    let value;
    try {
      value = JSON.parse(line.slice(prefix.length));
    } catch {
      return [];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const fields = value;
    if (Object.keys(fields).some((key) => !["agent", "session_id", "name", "owned"].includes(key)) || fields.agent !== "claude" || typeof fields.session_id !== "string" || !/^(?:[0-9a-f]{8}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(fields.session_id) || fields.name !== void 0 && typeof fields.name !== "string" || fields.owned !== void 0 && fields.owned !== true) {
      return [];
    }
    const session = fields.session_id.slice(0, 8).toLowerCase();
    if (named.has(session)) {
      return [];
    }
    named.add(session);
    receipts.push({
      sessionId: fields.session_id,
      name: typeof fields.name === "string" ? fields.name.trim() || null : null,
      owned: fields.owned === true
    });
  }
  return receipts;
}
function shellResultText(record) {
  const result = record.toolUseResult;
  if (typeof result?.stdout === "string") {
    return result.stdout;
  }
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const block = content.find((candidate) => {
    const value = candidate;
    return value?.type === "tool_result";
  });
  return typeof block?.content === "string" ? block.content : null;
}
function claudeDispatchFromOutput(output) {
  const background = /backgrounded\s+(?:Â?·)\s+([0-9a-f]{8})\s+(?:Â?·)\s+([^\r\n]+)/i.exec(output);
  if (background) {
    return { sessionId: background[1], name: background[2].trim() || null, owned: false };
  }
  for (const line of output.split(/\r?\n/)) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== "object") {
      continue;
    }
    const result = value;
    if (result.type === "result" && typeof result.session_id === "string" && /^[0-9a-f-]+$/i.test(result.session_id)) {
      return { sessionId: result.session_id, name: null, owned: false };
    }
  }
  return null;
}
function resolveClaudeDispatchReferences(references, catalog) {
  const byPrefix = /* @__PURE__ */ new Map();
  for (const session of catalog) {
    if (session.agent !== "claude" || session.childTranscript === true) {
      continue;
    }
    const sessionId = session.sessionId;
    const entry = { sessionId, file: session.file };
    for (let length = 1; length <= sessionId.length; length++) {
      const prefix = sessionId.slice(0, length).toLowerCase();
      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, entry);
      } else {
        byPrefix.set(prefix, null);
      }
    }
  }
  const resolved = [];
  for (const reference of references) {
    if (reference.kind !== "dispatch") {
      resolved.push(reference);
      continue;
    }
    const match = byPrefix.get(reference.sessionId.toLowerCase());
    if (!match) {
      continue;
    }
    resolved.push({ ...reference, sessionId: match.sessionId, file: match.file });
  }
  return resolved;
}
function claudeChildSessionFiles(references, repositoryRoots, cache = new ClaudeChildSessionCache()) {
  const byId = /* @__PURE__ */ new Map();
  for (const reference of references) {
    if (reference.kind === "dispatch") {
      continue;
    }
    const candidate = cache.read(reference, repositoryRoots);
    if (!candidate) {
      continue;
    }
    const previous = byId.get(reference.sessionId);
    if (previous === void 0) {
      byId.set(reference.sessionId, candidate);
    } else if (previous === null || normalizeFsPath(previous.file) !== normalizeFsPath(candidate.file)) {
      byId.set(reference.sessionId, null);
    } else {
      previous.toolUseIds = [.../* @__PURE__ */ new Set([...previous.toolUseIds, ...candidate.toolUseIds])];
    }
  }
  return [...byId.values()].filter((child) => child !== null);
}
class ClaudeChildSessionCache {
  constructor(cwdOf = readSessionCwd) {
    this.cwdOf = cwdOf;
  }
  entries = /* @__PURE__ */ new Map();
  read(reference, repositoryRoots) {
    const key = normalizeFsPath(reference.file);
    let stat;
    try {
      stat = fs.statSync(reference.file);
      if (!stat.isFile() || stat.size === 0) {
        this.entries.delete(key);
        return null;
      }
    } catch {
      this.entries.delete(key);
      return null;
    }
    const held = this.entries.get(key);
    const cwd = held && held.size === stat.size && held.mtimeMs === stat.mtimeMs && held.dev === stat.dev && held.ino === stat.ino ? held.cwd : this.cwdOf(reference.file);
    this.entries.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino, cwd });
    if (!cwd || !isInside(cwd, [...repositoryRoots])) {
      return null;
    }
    return {
      agent: "claude",
      file: reference.file,
      sessionId: reference.sessionId,
      parentSessionId: reference.parentSessionId,
      toolUseIds: [...reference.toolUseIds],
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      cwd,
      agentRun: true,
      childTranscript: true
    };
  }
}
function claudeChildReferenceFor(references, parentSessionId, agent) {
  if (!agent.id || !agent.toolUseId) {
    return null;
  }
  const matches = references.filter(
    (reference) => reference.kind !== "dispatch" && reference.parentSessionId === parentSessionId && reference.sessionId === agent.id && reference.toolUseIds.includes(agent.toolUseId)
  );
  return matches.length === 1 ? matches[0] : null;
}
function discoverClaudeChildSessions(parents, repositoryRoots, referencesOf = readClaudeChildSessionReferences, cache = new ClaudeChildSessionCache()) {
  const queue = [...parents];
  const queued = new Set(queue.map((session) => normalizeFsPath(session.file)));
  const visited = /* @__PURE__ */ new Set();
  const references = [];
  const byId = /* @__PURE__ */ new Map();
  while (queue.length) {
    const parent = queue.shift();
    const key = normalizeFsPath(parent.file);
    queued.delete(key);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    for (const reference of referencesOf(parent)) {
      references.push(reference);
      if (reference.kind === "dispatch") {
        continue;
      }
      const child = cache.read(reference, repositoryRoots);
      if (!child) {
        continue;
      }
      const previous = byId.get(child.sessionId);
      if (previous === void 0) {
        byId.set(child.sessionId, child);
      } else if (previous === null || normalizeFsPath(previous.file) !== normalizeFsPath(child.file)) {
        byId.set(child.sessionId, null);
        continue;
      } else {
        previous.toolUseIds = [.../* @__PURE__ */ new Set([...previous.toolUseIds, ...child.toolUseIds])];
      }
      const childKey = normalizeFsPath(child.file);
      if (!visited.has(childKey) && !queued.has(childKey)) {
        queue.push(child);
        queued.add(childKey);
      }
    }
  }
  const byParent = /* @__PURE__ */ new Map();
  for (const child of byId.values()) {
    if (!child) {
      continue;
    }
    const held = byParent.get(child.parentSessionId) ?? [];
    held.push(child);
    byParent.set(child.parentSessionId, held);
  }
  const reachable = [...new Set(parents.map((parent) => parent.sessionId))];
  const seenIds = new Set(reachable);
  const children = [];
  for (let index = 0; index < reachable.length; index++) {
    for (const child of byParent.get(reachable[index]) ?? []) {
      if (seenIds.has(child.sessionId)) {
        continue;
      }
      seenIds.add(child.sessionId);
      reachable.push(child.sessionId);
      children.push(child);
    }
  }
  return { references, children };
}
function discoverClaudeChildSessionFiles(parents, repositoryRoots, referencesOf = readClaudeChildSessionReferences) {
  return discoverClaudeChildSessions(parents, repositoryRoots, referencesOf).children;
}
function ephemeralRoots() {
  const env = process.env[`${ARC_IDENTITY.environmentPrefix}IGNORE_ROOTS`];
  if (env !== void 0) {
    return env.split(path.delimiter).filter(Boolean);
  }
  return [os.tmpdir(), claudeConfigHome(), codexHome(), path.resolve(arcHome())];
}
function isEphemeralPath(target) {
  const t = normalizeFsPath(target);
  return ephemeralRoots().some((root) => {
    const r = normalizeFsPath(root).replace(/\/$/, "");
    return t === r || t.startsWith(r + "/");
  });
}
function normalizeFsPath(target) {
  const unified = target.replace(/\\/g, "/");
  const drive = /^([a-zA-Z]):\//.exec(unified);
  const cased = drive ? drive[1].toLowerCase() + unified.slice(1) : unified;
  return drive || process.platform === "win32" ? cased.toLowerCase() : cased;
}
function nativePath(target) {
  if (!/^[A-Za-z]:[\\/]/.test(target)) {
    return target;
  }
  return target[0].toUpperCase() + target.slice(1).replace(/\//g, "\\");
}
function tailLines(file, bytes) {
  return tailOf(file, bytes).lines;
}
function revisionOf(stat) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
}
function sameFileRevision(stat, revision) {
  return stat.size === revision.size && stat.mtimeMs === revision.mtimeMs && stat.dev === revision.dev && stat.ino === revision.ino;
}
function tailOf(file, bytes, keepCursor = false) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    const body = buf.subarray(0, read);
    const lines = body.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    const firstNewline = body.indexOf(10);
    const fragment = firstNewline < 0 ? body : body.subarray(0, firstNewline);
    return {
      lines,
      whole: start === 0,
      readBytes: body.length,
      offset: start === 0 ? 0 : start + (firstNewline < 0 ? body.length : firstNewline + 1),
      ...keepCursor && start > 0 ? {
        cursor: {
          revision: revisionOf(stat),
          end: start,
          fragment: Buffer.from(fragment)
        }
      } : {}
    };
  } catch {
    return { lines: [], whole: false, readBytes: 0 };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function readBackwardRange(file, start, length, revision) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    if (!sameFileRevision(fs.fstatSync(fd), revision)) {
      return null;
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const next = fs.readSync(fd, buffer, read, length - read, start + read);
      if (next <= 0) {
        return null;
      }
      read += next;
    }
    if (!sameFileRevision(fs.fstatSync(fd), revision)) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function readPreviousLines(file, cursor, bytes, readRange = readBackwardRange) {
  const length = Math.min(Math.max(1, bytes), cursor.end);
  const start = cursor.end - length;
  const chunk = readRange(file, start, length, cursor.revision);
  if (!chunk || chunk.length !== length) {
    return null;
  }
  const joined = Buffer.concat([chunk, cursor.fragment, Buffer.from("\n")]);
  const firstNewline = joined.indexOf(10);
  const inspectFrom = start === 0 ? 0 : firstNewline + 1;
  const lines = [];
  let lineStart = inspectFrom;
  while (lineStart < joined.length) {
    const newline = joined.indexOf(10, lineStart);
    if (newline < 0) {
      break;
    }
    lines.push({ offset: start + lineStart, text: joined.subarray(lineStart, newline).toString("utf8") });
    lineStart = newline + 1;
  }
  lines.reverse();
  return {
    lines,
    cursor: {
      revision: cursor.revision,
      end: start,
      fragment: start > 0 ? Buffer.from(joined.subarray(0, firstNewline)) : Buffer.alloc(0)
    }
  };
}
async function discoverBackwardBoundary(file, initial, boundary, options = {}) {
  const chunkBytes = Math.max(1, options.chunkBytes ?? TURN_START_BYTES);
  const pause = options.pause ?? (() => new Promise((resolve) => setImmediate(resolve)));
  let cursor = initial;
  while (cursor.end > 0) {
    if (options.signal?.aborted) {
      return { kind: "cancelled" };
    }
    const batch = readPreviousLines(file, cursor, chunkBytes, options.readRange);
    if (!batch) {
      return { kind: "stale" };
    }
    for (const line of batch.lines) {
      if (boundary(line)) {
        const start = line.offset > 0 ? line.offset - 1 : 0;
        return { kind: "found", readBytes: initial.revision.size - start };
      }
    }
    cursor = batch.cursor;
    if (cursor.end === 0) {
      return { kind: "beginning" };
    }
    await pause();
  }
  return { kind: "beginning" };
}
const WRAPPED = /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|local-command-stdout|local-command-caveat|command-message|command-contents|task-notification)>[\s\S]*?<\/\1>/g;
const HARNESS_COMMANDS = /* @__PURE__ */ new Set(["/clear", "/compact", "/config", "/context", "/effort", "/model", "/plugin"]);
const COMMAND_NAMED = /<command-name>\s*(\/[^\s<]*)/;
const COMMAND_SCAFFOLD = /<(command-name|command-args)>[\s\S]*?<\/\1>/g;
const COMMAND_INVOCATION = /<command-name>\s*([^<]*?)\s*<\/command-name>\s*<command-args>([\s\S]*?)<\/command-args>/g;
function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
}
function cleanPrompt(raw) {
  const named = COMMAND_NAMED.exec(raw);
  const body = named && HARNESS_COMMANDS.has(named[1]) ? raw.replace(COMMAND_SCAFFOLD, " ") : raw;
  return body.replace(WRAPPED, " ").replace(COMMAND_INVOCATION, (_all, name, args) => `${name} ${args}`).replace(/<\/?[a-z][a-z0-9-]{0,38}>/gi, " ").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function isReaderQueued(attachment) {
  if (!attachment || attachment.type !== "queued_command") {
    return false;
  }
  if (attachment.commandMode !== "prompt") {
    return false;
  }
  const origin = attachment.origin;
  if (origin === void 0 || origin === null) {
    return true;
  }
  if (typeof origin !== "object" || Array.isArray(origin)) {
    return false;
  }
  const kind = origin.kind;
  return typeof kind === "string" && kind !== "peer";
}
function taskNotificationText(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  if (record.type === "user") {
    const origin = record.origin;
    if (!origin || origin.kind !== "task-notification") {
      return null;
    }
    return noticeTags(record.message?.content);
  }
  if (record.type === "attachment") {
    const attachment = record.attachment;
    if (!attachment || attachment.type !== "queued_command") {
      return null;
    }
    if (attachment.commandMode !== "task-notification") {
      return null;
    }
    return noticeTags(attachment.prompt);
  }
  return null;
}
function noticeTags(content) {
  if (typeof content === "string") {
    return content;
  }
  const text = textOf(content);
  if (text) {
    return text;
  }
  if (content === null || content === void 0) {
    return "";
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content) ?? "";
    } catch {
      return "";
    }
  }
  return String(content);
}
function claudeRecordAt(record) {
  const attachment = record.attachment;
  if (record.type === "attachment" && attachment && attachment.timestamp) {
    return stamp(attachment.timestamp);
  }
  return stamp(record.timestamp);
}
const TRIPLE_STAR = /(?<![\w*])\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*(?![\w*])/g;
const STRONG_STAR = /(?<![\w*])\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*(?![\w*])/g;
const EM_STAR = /(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g;
const TRIPLE_LOW = /(?<![\w_])___(?!\s)([^_\n]+?)(?<!\s)___(?![\w_])/g;
const STRONG_LOW = /(?<![\w_])__(?!\s)([^_\n]+?)(?<!\s)__(?![\w_])/g;
const EM_LOW = /(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g;
const IMAGE = /!\[([^\]\n]*)\]\\?\(([^()\n]*)\\?\)/g;
const LINK = /\[([^\]\n]*)\]\\?\(([^()\n]*)\\?\)/g;
function stripEmphasisMarkersOnce(text) {
  return text.replace(TRIPLE_STAR, "$1").replace(TRIPLE_LOW, "$1").replace(STRONG_STAR, "$1").replace(EM_STAR, "$1").replace(STRONG_LOW, "$1").replace(EM_LOW, "$1");
}
function stripEmphasisMarkers(text) {
  let current = text;
  for (; ; ) {
    const next = stripEmphasisMarkersOnce(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
}
function plainTitlePiece(text) {
  return stripEmphasisMarkers(text.replace(IMAGE, "$1").replace(LINK, "$1"));
}
function withCodeSpansPreserved(line, transform) {
  return line.split(/(`[^`\n]+`)/g).map((piece, i) => i % 2 ? piece.slice(1, -1) : transform(piece)).join("");
}
function plainTitle(line) {
  return withCodeSpansPreserved(line, plainTitlePiece);
}
function normalizeSessionTitle(text) {
  const full = normalizeFullSessionTitle(text);
  return full ? shortenTo(full, 60, "...") : null;
}
function normalizeFullSessionTitle(text) {
  if (!text) {
    return null;
  }
  const flat = plainTitle(withoutRichContent(text)).replace(/\s+/g, " ").trim();
  return flat || null;
}
const SECTION_ONLY = /^(tl;?dr|summary|result|results|outcome|status|overview)[:.]?$/i;
const BULLET = /^[\s>]*[-*+]\s+/;
const ORDERED = /^\s*\d+\.\s+/;
const CONTINUATION = /^\s+\S/;
const FENCE = /^\s*(```|~~~)/;
function stripStructuralMarkdown(line) {
  return line.replace(BULLET, "").replace(/^#{1,6}\s*/, "").replace(/^\s*\d+\.\s+/, "");
}
function stripInlineMarkdown(line) {
  const withLinkText = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return withCodeSpansPreserved(withLinkText, (piece) => stripEmphasisMarkers(piece).replace(/`/g, "")).trim();
}
function stripMarkdown(line) {
  return stripInlineMarkdown(stripStructuralMarkdown(line));
}
function headlineLine(summary) {
  for (const raw of summary.split("\n")) {
    if (FENCE.test(raw)) {
      continue;
    }
    const structural = stripStructuralMarkdown(raw);
    const plain = stripInlineMarkdown(structural);
    if (!plain || SECTION_ONLY.test(plain)) {
      continue;
    }
    return structural;
  }
  return null;
}
function headlineOf(summary) {
  const line = headlineLine(summary);
  return line === null ? "" : stripInlineMarkdown(line);
}
function headlineMarkdownOf(summary) {
  const line = headlineLine(summary);
  return line === null ? "" : line.trim();
}
function openingLines(summary) {
  const lines = [];
  for (const raw of summary.split("\n")) {
    if (FENCE.test(raw)) {
      continue;
    }
    const stripped = stripMarkdown(raw);
    if (!stripped || SECTION_ONLY.test(stripped)) {
      if (lines.length) {
        break;
      }
      continue;
    }
    if (BULLET.test(raw) || ORDERED.test(raw)) {
      lines.push(stripped);
      continue;
    }
    if (lines.length && CONTINUATION.test(raw)) {
      continue;
    }
    break;
  }
  return lines;
}
const CLOSING_ROW_NAME = {
  actions: /^[^\p{L}]*your actions\b/iu,
  questions: /^[^\p{L}]*open questions\b/iu
};
const ROW_TEXT = /^[^:\n]{0,30}?(?::|\s[–—-])\s+(.+)$/u;
const ROW_QUALIFIER = 20;
const WAITING_LABEL = /^\*\*waiting on you:?\*\*:?$/i;
function closingRows(summary) {
  const found = { actions: null, questions: null };
  const lines = summary.split("\n");
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    if (WAITING_LABEL.test(lines[i].trim())) {
      const section = waitingSection(lines, i);
      if (section) {
        found.actions = section.text;
        found.questions = null;
        i = section.end;
      }
      continue;
    }
    const line = stripMarkdown(lines[i]);
    for (const name of Object.keys(CLOSING_ROW_NAME)) {
      const text = rowTextAt(name, line, lines, i);
      if (text) {
        found[name] = text;
      }
    }
  }
  return found;
}
function rowTextAt(name, line, lines, i) {
  const hit = CLOSING_ROW_NAME[name].exec(line);
  if (!hit) {
    return null;
  }
  const rest = line.slice(hit[0].length);
  const inline = ROW_TEXT.exec(rest);
  if (inline) {
    return joinWrapped(inline[1], lines, i);
  }
  return rest.trim().length <= ROW_QUALIFIER ? listUnder(lines, i) : null;
}
function startsARow(line) {
  const text = stripMarkdown(line);
  return Object.values(CLOSING_ROW_NAME).some((name) => {
    const hit = name.exec(text);
    if (!hit) {
      return false;
    }
    const rest = text.slice(hit[0].length);
    return ROW_TEXT.test(rest) || rest.trim().length <= ROW_QUALIFIER;
  });
}
function listUnder(lines, from) {
  const parts = [];
  for (let i = from + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) {
      if (parts.length) {
        break;
      } else {
        continue;
      }
    }
    if (!BULLET.test(raw) && !ORDERED.test(raw) && !CONTINUATION.test(raw)) {
      break;
    }
    if (startsARow(raw)) {
      break;
    }
    const text = stripMarkdown(raw);
    if (text) {
      parts.push(text);
    }
  }
  return parts.length ? parts.join(" ") : null;
}
function waitingSection(lines, from) {
  const parts = [];
  let end = from;
  for (let i = from + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) {
      continue;
    }
    if (startsARow(raw)) {
      break;
    }
    if (BULLET.test(raw) || ORDERED.test(raw)) {
      const text = stripMarkdown(raw);
      if (text) {
        parts.push(text);
        end = i;
      }
      continue;
    }
    if (CONTINUATION.test(raw) && parts.length) {
      const text = stripMarkdown(raw);
      if (text) {
        parts[parts.length - 1] += ` ${text}`;
        end = i;
      }
      continue;
    }
    break;
  }
  return parts.length ? { text: parts.join("\n"), end } : null;
}
function joinWrapped(first, lines, from) {
  const parts = [first.trim()];
  for (let i = from + 1; i < lines.length; i += 1) {
    if (!CONTINUATION.test(lines[i])) {
      break;
    }
    const more = stripMarkdown(lines[i]);
    if (more) {
      parts.push(more);
    }
  }
  return parts.join(" ");
}
const COMPACT_PREAMBLE = /^[\s\S]{0,400}?covers the earlier portion of the conversation\.\s*(?:Summary:)?\s*/;
function stripCompactPreamble(text) {
  return text.replace(COMPACT_PREAMBLE, "").trim();
}
const INTERRUPTED = /^\[Request interrupted by user/;
function isTypedPrompt(o, childTranscript = false) {
  if (o.isSidechain && !childTranscript || o.isMeta || o.isCompactSummary) {
    return false;
  }
  const origin = o.origin;
  if (origin && origin.kind === "task-notification") {
    return false;
  }
  const content = o.message?.content;
  if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
    return false;
  }
  const text = cleanPrompt(textOf(content));
  return text.length > 0 && !INTERRUPTED.test(text);
}
const TOOL_KIND = {
  Edit: "edits",
  Write: "edits",
  MultiEdit: "edits",
  NotebookEdit: "edits",
  Read: "reads",
  NotebookRead: "reads",
  Grep: "searches",
  Glob: "searches",
  Bash: "commands",
  PowerShell: "commands",
  Agent: "agents",
  Task: "agents",
  Workflow: "agents",
  SendMessage: "coordination",
  SubagentHandback: "coordination",
  ListAgents: "coordination",
  TaskOutput: "coordination",
  TaskStop: "coordination",
  WebFetch: "web",
  WebSearch: "web"
};
function emptyToolCounts() {
  return { edits: 0, reads: 0, searches: 0, commands: 0, agents: 0, coordination: 0, web: 0, other: 0 };
}
function tallyToolName(tally, name) {
  if (Object.prototype.hasOwnProperty.call(tally, name)) {
    tally[name]++;
    return;
  }
  Object.defineProperty(tally, name, {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
const FILL = "";
function maskQuoted(command) {
  const out = command.split("");
  const open = [];
  let quotes = 0;
  let pending = [];
  let eol = -1;
  let ink = -1;
  const mask = (from, to) => {
    for (let p = from; p < to; p++) {
      out[p] = FILL;
    }
  };
  const pass = (at, to) => {
    if (quotes > 0) {
      mask(at, to);
    }
    return to;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const top = open[open.length - 1];
    if (top === "'" || top === '"') {
      if (c === top) {
        open.pop();
        quotes--;
        i = pass(i, i + 1);
      } else if (top === '"' && c === "\\") {
        mask(i, Math.min(i + 2, command.length));
        i += 2;
      } else if (top === '"' && command.startsWith("$(", i)) {
        const arithmetic2 = command[i + 2] === "(";
        open.push(arithmetic2 ? "$((" : "$(");
        i = pass(i, i + (arithmetic2 ? 3 : 2));
      } else {
        out[i] = FILL;
        i++;
      }
      continue;
    }
    if (c === "\\") {
      i = pass(i, Math.min(i + 2, command.length));
      continue;
    }
    if (c === '"' || c === "'") {
      i = pass(i, i + 1);
      open.push(c);
      quotes++;
      continue;
    }
    if (command.startsWith("$(", i)) {
      const arithmetic2 = command[i + 2] === "(";
      open.push(arithmetic2 ? "$((" : "$(");
      i = pass(i, i + (arithmetic2 ? 3 : 2));
      continue;
    }
    const arithmetic = top === "$((" || top === "arith(";
    if (c === "(" && open.length > 0) {
      open.push(arithmetic ? "arith(" : "(");
      i = pass(i, i + 1);
      continue;
    }
    if (c === ")" && open.length > 0) {
      const closes = top === "$((" && command[i + 1] === ")" ? 2 : 1;
      open.pop();
      i = pass(i, i + closes);
      continue;
    }
    if (arithmetic) {
      i = pass(i, i + 1);
      continue;
    }
    if (c === "@" && open.length === 0 && (command[i + 1] === "'" || command[i + 1] === '"')) {
      if (eol < i) {
        const nl = command.indexOf("\n", i);
        eol = nl < 0 ? command.length : nl;
        ink = eol - 1;
        while (ink > i && /\s/.test(command[ink])) {
          ink--;
        }
      }
      if (eol < command.length && ink === i + 1) {
        const term = command[i + 1] + "@";
        let end = command.length;
        let k = eol;
        while (k >= 0) {
          if (command.startsWith(term, k + 1)) {
            end = k + 3;
            break;
          }
          k = command.indexOf("\n", k + 1);
        }
        mask(i, end);
        i = end;
        continue;
      }
    }
    if (c === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        i = pass(i, i + 3);
        continue;
      }
      const heredoc = heredocOpener(command, i);
      if (heredoc.delim !== null) {
        pending.push({ delim: heredoc.delim, tabs: heredoc.tabs });
      }
      i = pass(i, heredoc.after);
      continue;
    }
    if (c === "\n" && pending.length) {
      let k = i;
      for (const { delim, tabs } of pending) {
        while (k < command.length) {
          const stop = command.indexOf("\n", k + 1);
          const end = stop < 0 ? command.length : stop;
          const line = command.slice(k + 1, end);
          k = end;
          if ((tabs ? line.replace(/^\t+/, "") : line) === delim) {
            break;
          }
        }
      }
      pending = [];
      mask(i, k);
      i = k;
      continue;
    }
    i = pass(i, i + 1);
  }
  return out.join("");
}
function heredocOpener(command, at) {
  let j = at + 2;
  const tabs = command[j] === "-";
  if (tabs) {
    j++;
  }
  while (command[j] === " " || command[j] === "	") {
    j++;
  }
  const start = j;
  let delim = "";
  while (j < command.length && !/[\s;&|()<>]/.test(command[j])) {
    const c = command[j];
    if (c === '"' || c === "'") {
      const close = command.indexOf(c, j + 1);
      const stop = close < 0 ? command.length : close;
      delim += command.slice(j + 1, stop);
      j = Math.min(stop + 1, command.length);
    } else if (c === "\\" && j + 1 < command.length) {
      delim += command[j + 1];
      j += 2;
    } else {
      delim += c;
      j++;
    }
  }
  return { delim: j > start ? delim : null, tabs, after: j };
}
function commandSegments(command) {
  const m = maskQuoted(command);
  const parts = [];
  let start = 0;
  for (let i = 0; i < m.length; i++) {
    const two = m.slice(i, i + 2);
    let width = 0;
    if (two === "&&" || two === "||") {
      width = 2;
    } else if (m[i] === ";" || m[i] === "\n") {
      width = 1;
    }
    if (!width) {
      continue;
    }
    parts.push({ text: command.slice(start, i), masked: m.slice(start, i) });
    i += width - 1;
    start = i + 1;
  }
  parts.push({ text: command.slice(start), masked: m.slice(start) });
  return parts;
}
function driveForm(p) {
  let m = /^\/mnt\/([a-zA-Z])(\/|$)/.exec(p) || /^\/cygdrive\/([a-zA-Z])(\/|$)/.exec(p);
  if (m) {
    return m[1].toUpperCase() + ":" + (p.slice(m[0].length - (m[2] ? 1 : 0)) || "/");
  }
  m = /^\/([a-zA-Z])(\/|$)/.exec(p);
  if (m) {
    return m[1].toUpperCase() + ":" + (p.slice(2) || "/");
  }
  return p;
}
function normalizeDir(p) {
  const drive = /^([a-zA-Z]:)(\/.*)?$/.exec(p);
  const unc = p.startsWith("//");
  const root = drive ? drive[1] : p.startsWith("/") ? "" : null;
  const rest = drive ? drive[2] || "/" : p;
  const parts = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (!unc || parts.length > 2) {
        parts.pop();
      }
      continue;
    }
    parts.push(seg);
  }
  if (root === null) {
    return parts.join("/");
  }
  if (unc) {
    return `//${parts.join("/")}`;
  }
  return (root + "/" + parts.join("/")).replace(/\/$/, "") || root + "/";
}
const ESCAPABLE = /[\s'"]/;
function firstArg(rest) {
  const s = rest.trim();
  if (!s) {
    return null;
  }
  let out = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) {
        quote = "";
      } else {
        out += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      break;
    }
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      out += s[++i];
      continue;
    }
    out += c;
  }
  return out;
}
function resolveDir(arg, cur, homeDir) {
  let t = arg.replace(/\\/g, "/").replace(/^\$\{?HOME\}?(?=\/|$)/, () => homeDir).replace(/^~(?=\/|$)/, () => homeDir);
  t = driveForm(t);
  if (/\$|%/.test(t)) {
    return null;
  }
  if (/^[a-zA-Z]:\//.test(t) || t.startsWith("/")) {
    return normalizeDir(t);
  }
  return cur ? normalizeDir(cur + "/" + t) : null;
}
const CHANGE_DIR = /^(cd|chdir|set-location|pushd|push-location)(\s|$)/i;
const UNTRACKED_DIR = /^(popd|pop-location)(\s|$)/i;
const DIR_PARAM = /^-(?:Path|LiteralPath)(?=[\s:=]|$)/i;
const UNREADABLE = Symbol("unreadable switch");
function moveTarget(rest) {
  let s = rest.trim();
  while (s.startsWith("-") && s !== "-" && !/^-\s/.test(s)) {
    const m = DIR_PARAM.exec(s);
    if (!m) {
      return UNREADABLE;
    }
    s = s.slice(m[0].length).replace(/^[:=]/, "").trim();
  }
  return firstArg(s);
}
const COMMIT_CALL = /(^|[\s(])git((?:\s+-C\s+\S+)*)\s+commit(?=\s|$)/g;
const MERGE_CALL = /(^|[\s(])git((?:\s+-C\s+\S+)*)\s+merge(?=\s|$)/g;
function commitDirs(command, cwd, home = os.homedir()) {
  return gitCallDirs(command, cwd, home, COMMIT_CALL);
}
function mergeDirs(command, cwd, home = os.homedir()) {
  return gitCallDirs(command, cwd, home, MERGE_CALL);
}
function gitCallDirs(command, cwd, home, call) {
  const homeDir = normalizeDir(driveForm((home || "").replace(/\\/g, "/")));
  let cur = cwd ? normalizeDir(driveForm(cwd.replace(/\\/g, "/"))) : null;
  const out = [];
  for (const seg of commandSegments(command)) {
    const trimmed = seg.text.trim();
    const move = CHANGE_DIR.exec(trimmed);
    if (move) {
      const arg = moveTarget(trimmed.slice(move[1].length));
      if (arg === UNREADABLE) {
        cur = null;
      } else if (arg === null) {
        cur = move[1].toLowerCase() === "cd" ? homeDir || null : null;
      } else if (arg === "-") {
        cur = null;
      } else {
        cur = resolveDir(arg, cur, homeDir);
      }
    } else if (UNTRACKED_DIR.test(trimmed)) {
      cur = null;
    }
    call.lastIndex = 0;
    let m;
    while (m = call.exec(seg.masked)) {
      if (!m[2]) {
        out.push(cur);
        continue;
      }
      const from = m.index + m[1].length + "git".length;
      const opts = seg.text.slice(from, from + m[2].length);
      const optsMasked = m[2];
      let dir = cur;
      const arg = /-C\s+(\S+)/g;
      let a;
      while (dir !== null && (a = arg.exec(optsMasked))) {
        const at = a.index + a[0].length - a[1].length;
        dir = resolveDir(firstArg(opts.slice(at, at + a[1].length)) ?? "", dir, homeDir);
      }
      out.push(dir);
    }
  }
  return out;
}
const GIT_CALL = /(?:^|[({|&])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git(?:\s|$)/;
function ranGit(command) {
  return commandSegments(command).some((seg) => GIT_CALL.test(seg.masked));
}
const CONDITIONAL = /(^|[\s({;])(if|elif|elseif|else|fi|then|switch|foreach|while|until|for|do|done|try|catch|finally|function)([\s({;]|$)/i;
const BLOCK = /(^|[^$])\{/;
const LEAVES_EARLY = /(^|[\s({;])(exit|return|break|continue)([\s;]|$)/i;
const DRY_RUN = /(^|[\s"'])--dry-run([\s"'=]|$)/;
const OWN_DATE = /GIT_COMMITTER_DATE\s*=/i;
const BACKGROUND = /(^|[^&>])&([^&]|$)/;
const NEGATED = /(^|[\s({;])!\s/;
function commitStatusIsReadable(command) {
  return gitStatusIsReadable(command, COMMIT_CALL);
}
function mergeStatusIsReadable(command) {
  return gitStatusIsReadable(command, MERGE_CALL);
}
function gitStatusIsReadable(command, call) {
  const masked = maskQuoted(command);
  if (CONDITIONAL.test(masked) || masked.includes("||")) {
    return false;
  }
  if (DRY_RUN.test(masked) || OWN_DATE.test(masked) || NEGATED.test(masked)) {
    return false;
  }
  if (DRY_RUN.test(command) || OWN_DATE.test(command)) {
    return false;
  }
  if (BLOCK.test(masked) || LEAVES_EARLY.test(masked)) {
    return false;
  }
  if (!everyCallIsACommand(command, call)) {
    return false;
  }
  call.lastIndex = 0;
  const m = call.exec(masked);
  if (m === null) {
    return false;
  }
  const after = masked.slice(m.index + m[0].length);
  if (after.includes(";") || after.includes("\n") || BACKGROUND.test(after)) {
    return false;
  }
  return true;
}
const ONE_LINE_LOG = /^([0-9a-f]{7,40})\s+(.+)$/;
const BASH_ECHO_OPTION = /^(?:-[neE]+|(['"])-[neE]+\1)(?:\s|$)/;
function literalEchoOutput(command) {
  const match = /^\s*echo\s+([\s\S]*?)\s*$/.exec(command);
  if (!match) {
    return null;
  }
  const arg = match[1].trim();
  if (BASH_ECHO_OPTION.test(arg)) {
    return null;
  }
  const single = /^'([^']*)'$/.exec(arg);
  if (single) {
    return single[1];
  }
  const double = /^"([^"]*)"$/.exec(arg);
  if (double) {
    return /[$`\\]/.test(double[1]) ? null : double[1];
  }
  if (!arg || /[$%`'"\\;&|<>()[\]{}*?]/.test(arg)) {
    return null;
  }
  return arg.replace(/\s+/g, " ");
}
function witnessedCommitSha(command, stdout) {
  const masked = maskQuoted(command);
  if (CONDITIONAL.test(masked) || DRY_RUN.test(masked) || OWN_DATE.test(masked) || NEGATED.test(masked)) {
    return null;
  }
  if (DRY_RUN.test(command) || OWN_DATE.test(command) || BLOCK.test(masked) || LEAVES_EARLY.test(masked)) {
    return null;
  }
  if (!everyCallIsACommand(command, COMMIT_CALL) || commitDirs(command, null).length !== 1) {
    return null;
  }
  const orElse = [...masked.matchAll(/\|\|/g)];
  if (orElse.length !== 1) {
    return null;
  }
  const orAt = orElse[0].index;
  const fallbackEnd = command.indexOf("\n", orAt + 2);
  const fallback = literalEchoOutput(command.slice(orAt + 2, fallbackEnd < 0 ? command.length : fallbackEnd));
  if (fallbackEnd >= 0 && masked.slice(fallbackEnd).replaceAll(FILL, "").trim() !== "") {
    return null;
  }
  if (fallback === null || fallback.trim() === "" || ONE_LINE_LOG.test(fallback.trim())) {
    return null;
  }
  const success = masked.slice(0, orAt);
  const logAt = success.lastIndexOf("&&");
  if (logAt < 0 || !/^\s*git\s+log\s+--oneline\s+-1\s*$/.test(success.slice(logAt + 2))) {
    return null;
  }
  const beforeLog = success.slice(0, logAt);
  if (/(?:^|[({|&])\s*git\s+log\s+--oneline\s+-1(?:\s|$)/.test(beforeLog)) {
    return null;
  }
  COMMIT_CALL.lastIndex = 0;
  const commit = COMMIT_CALL.exec(beforeLog);
  if (!commit) {
    return null;
  }
  const afterCommit = beforeLog.slice(commit.index + commit[0].length);
  if (afterCommit.includes("&&") || afterCommit.includes("|") || afterCommit.includes(";") || afterCommit.includes("\n") || BACKGROUND.test(afterCommit)) {
    return null;
  }
  const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  return ONE_LINE_LOG.exec(last)?.[1] ?? null;
}
function everyCallIsACommand(command, call) {
  for (const seg of commandSegments(command)) {
    call.lastIndex = 0;
    let m;
    while (m = call.exec(seg.masked)) {
      const before = seg.masked.slice(0, m.index + m[1].length).replace(/\s+$/, "");
      if (before !== "" && !/[({|&]$/.test(before)) {
        return false;
      }
      if (/\$\($/.test(before)) {
        return false;
      }
    }
  }
  return true;
}
function commitPlaceOf(call, folders, home = os.homedir()) {
  if (!call || folders.length === 0) {
    return null;
  }
  const agreed = commitDirOf(call, folders, home);
  if (agreed !== null) {
    return isInside(agreed, folders) ? null : { kind: "named", dir: agreed };
  }
  const dirs = commitDirs(call.command, call.cwd, home);
  if (!dirs.length || dirs.some((d) => d === null)) {
    return null;
  }
  const known = dirs;
  return known.every((d) => !isInside(d, folders)) ? { kind: "unnamed" } : null;
}
function commitDirOf(call, folders = [], home = os.homedir()) {
  if (!call) {
    return null;
  }
  return theOneDir(commitDirs(call.command, call.cwd, home));
}
function mergeDirOf(call, folders = [], home = os.homedir()) {
  if (!call) {
    return null;
  }
  return theOneDir(mergeDirs(call.command, call.cwd, home));
}
function theOneDir(dirs) {
  if (!dirs.length || dirs.some((d) => d === null)) {
    return null;
  }
  const first = dirs[0];
  return dirs.every((d) => normalizeFsPath(d) === normalizeFsPath(first)) ? first : null;
}
const COMMIT_LINE = /^\[(?:(detached HEAD|\S+)\s+)?(?:\(root-commit\)\s+)?([0-9a-f]{7,40})\]\s*(.*)$/;
const STAT_LINE = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const STAT_LOOKAHEAD = 3;
function parseStatLine(line) {
  const m = STAT_LINE.exec(line);
  if (!m) {
    return null;
  }
  return {
    files: Number(m[1]),
    added: m[2] !== void 0 ? Number(m[2]) : 0,
    removed: m[3] !== void 0 ? Number(m[3]) : 0
  };
}
function recordCommits(turn, stdout, at, call = null, folders = [], defaultDir = null, window = null) {
  if (call === null || call !== "unreadable" && !ranGit(call.command)) {
    return;
  }
  const ran = call === "unreadable" ? null : call;
  const lines = stdout.split("\n");
  let place;
  let printed = false;
  const dir = call === "unreadable" ? defaultDir : commitDirOf(ran, folders);
  for (let i = 0; i < lines.length; i++) {
    const m = COMMIT_LINE.exec(lines[i].trim());
    if (!m) {
      continue;
    }
    printed = true;
    if (place === void 0) {
      place = commitPlaceOf(ran, folders);
    }
    const sha = m[2].slice(0, 8);
    if (turn.commits.some((c) => sameCommitSha(c.sha, sha))) {
      continue;
    }
    let stat = null;
    for (let j = i + 1; j < lines.length && j <= i + STAT_LOOKAHEAD; j++) {
      const next = lines[j].trim();
      if (COMMIT_LINE.test(next)) {
        break;
      }
      stat = parseStatLine(next);
      if (stat) {
        break;
      }
    }
    turn.commits.push({
      sha,
      subject: m[3].trim(),
      head: m[1] === "detached HEAD" ? { kind: "detached" } : m[1] ? { kind: "branch", name: m[1] } : null,
      files: stat ? stat.files : null,
      added: stat ? stat.added : null,
      removed: stat ? stat.removed : null,
      at,
      place,
      dir
    });
  }
  recordCommitIntent(turn, ran, dir, printed, window, at, stdout);
  recordLandingIntent(turn, ran, mergeDirOf(ran, folders), window, at);
}
function recordCommitIntent(turn, ran, dir, printed, window, at, stdout) {
  if (printed || window === null || window.failed || ran === null || dir === null) {
    return;
  }
  const readable = commitStatusIsReadable(ran.command);
  const witnessedSha = readable ? null : witnessedCommitSha(ran.command, stdout);
  if (!readable && witnessedSha === null) {
    return;
  }
  const expected = commitDirs(ran.command, ran.cwd).length;
  if (expected === 0) {
    return;
  }
  (turn.commitIntents ??= []).push({
    dir,
    from: Math.min(window.from, at),
    to: at,
    expected,
    ...witnessedSha === null ? {} : { witnessedSha }
  });
}
function recordLandingIntent(turn, ran, dir, window, at) {
  if (window === null || window.failed || ran === null || dir === null) {
    return;
  }
  if (!mergeStatusIsReadable(ran.command)) {
    return;
  }
  const expected = mergeDirs(ran.command, ran.cwd).length;
  if (expected === 0) {
    return;
  }
  (turn.landingIntents ??= []).push({
    ...ran.id ? { id: ran.id } : {},
    dir,
    from: Math.min(window.from, at),
    to: at,
    expected
  });
}
function firstLine(text) {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) || "no detail given";
  return shortenTo(line, 160, "...");
}
function stamp(value) {
  const t = Date.parse(String(value || ""));
  return Number.isNaN(t) ? 0 : t;
}
function toolUseIdOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (block.type === "tool_result" && block.tool_use_id) {
      return block.tool_use_id;
    }
  }
  return "";
}
const SOURCE_START = Symbol("sourceStart");
const SOURCE_END = Symbol("sourceEnd");
const MEMBERSHIP_START = Symbol("membershipStart");
function setSourceRange(value, start, end) {
  Object.defineProperty(value, SOURCE_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(value, SOURCE_END, {
    value: end,
    enumerable: false,
    configurable: true,
    writable: true
  });
}
function extendSourceRange(value, start, end) {
  const currentStart = value[SOURCE_START];
  const currentEnd = value[SOURCE_END];
  if (currentStart === void 0 || start < currentStart) {
    Object.defineProperty(value, SOURCE_START, {
      value: start,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
  if (currentEnd === void 0 || end > currentEnd) {
    Object.defineProperty(value, SOURCE_END, {
      value: end,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
}
function setMembershipStart(value, start) {
  Object.defineProperty(value, MEMBERSHIP_START, {
    value: start,
    enumerable: false,
    configurable: true,
    writable: true
  });
}
const CLAUDE_HIDDEN_POLICY = {
  start: SOURCE_START,
  end: SOURCE_END,
  membershipStart: MEMBERSHIP_START,
  redefinesDetail: false
};
function copyUnsizedCompaction(value) {
  return value ? { ...value, previous: value.previous ? { ...value.previous } : null } : null;
}
function compactSummaryChars(record) {
  const content = record.message?.content;
  return (typeof content === "string" ? content : textOf(content)).length;
}
function positiveCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
function withinCompactWindow(left, right) {
  return Math.abs(left - right) <= COMPACT_META_WINDOW_MS;
}
function emptyClaudeUsageReducerState() {
  return {
    seenRequestKeys: [],
    closedTurns: 0,
    openTurn: false,
    openTurnAnswered: false,
    compactionCount: 0,
    recentCompactions: [],
    pendingCompactionTrigger: null,
    toolListNames: [],
    toolListVersion: 0,
    visibleTurns: 0,
    firstTurnAt: null,
    currentTurnStartedAt: null,
    currentTurnEndedAt: null,
    currentTurnOutcome: null
  };
}
function retainNewestCompaction(state, compaction) {
  state.recentCompactions.push(compaction);
  while (state.recentCompactions.length > RETAINED_COMPACTIONS) {
    state.recentCompactions.shift();
  }
}
function reduceClaudeTurnRecord(state, record, childTranscript = false) {
  if (record.isSidechain && !childTranscript) {
    return;
  }
  if (record.type === "system" && record.subtype === "compact_boundary") {
    const metadata = record.compactMetadata;
    state.pendingCompactionTrigger = typeof metadata?.trigger === "string" && metadata.trigger ? metadata.trigger : null;
    const at2 = stamp(record.timestamp);
    const after = positiveCount(metadata?.postTokens);
    state.pendingCompactionSize = after ? { before: positiveCount(metadata?.preTokens), after, at: at2, durationMs: positiveCount(metadata?.durationMs) } : null;
    if (state.unsizedCompaction && (!after || !withinCompactWindow(state.unsizedCompaction.at, at2))) {
      state.unsizedCompaction = null;
    }
    return;
  }
  if (noteClaudeModelProfile(state, record)) {
    return;
  }
  const attachment = record.attachment;
  if (record.type === "attachment" && attachment?.type === "deferred_tools_delta") {
    const names = new Set(state.toolListNames ?? []);
    for (const value of Array.isArray(attachment.removedNames) ? attachment.removedNames : []) {
      if (typeof value === "string") {
        names.delete(value);
      }
    }
    for (const value of Array.isArray(attachment.addedNames) ? attachment.addedNames : []) {
      if (typeof value === "string" && value) {
        names.add(value);
      }
    }
    const next = [...names].sort();
    const current = state.toolListNames ?? [];
    if (next.length !== current.length || next.some((value, index) => value !== current[index])) {
      state.toolListNames = next;
      state.toolListVersion = (state.toolListVersion ?? 0) + 1;
    }
    return;
  }
  if (record.type === "user" && record.isCompactSummary) {
    state.compactionCount++;
    const at2 = stamp(record.timestamp);
    retainNewestCompaction(state, {
      ordinal: state.compactionCount,
      at: Number.isFinite(at2) && at2 > 0 ? at2 : null,
      trigger: state.pendingCompactionTrigger ?? null,
      // A Claude compaction summary is a user record and carries no request usage. The usage
      // reducer emits an estimated request for it instead.
      requestUsage: null,
      requestModel: null,
      requestProvider: null,
      requestServiceTier: null,
      requestContextWindow: null
    });
    state.pendingCompactionTrigger = null;
    const size = state.pendingCompactionSize ?? null;
    if (size && !withinCompactWindow(size.at, at2)) {
      state.pendingCompactionSize = null;
    }
    state.unsizedCompaction = {
      ordinal: state.compactionCount,
      at: at2,
      previous: state.lastRequest ? { ...state.lastRequest } : null,
      summaryChars: compactSummaryChars(record)
    };
    return;
  }
  if (record.type === "user" && isTypedPrompt(record, childTranscript)) {
    if (state.openTurn && state.openTurnAnswered) {
      state.closedTurns++;
    }
    state.visibleTurns++;
    state.openTurn = true;
    state.openTurnAnswered = false;
    const at2 = stamp(record.timestamp);
    state.currentTurnStartedAt = at2;
    state.currentTurnEndedAt = at2;
    const openChildren = state.currentTurnOutcome?.openChildren;
    const closedChildren = state.currentTurnOutcome?.closedChildren;
    state.currentTurnOutcome = {
      finished: false,
      error: false,
      interrupted: false,
      endedAt: at2,
      startedAt: at2,
      ...openChildren && openChildren.length > 0 ? { openChildren } : {},
      ...closedChildren && closedChildren.length > 0 ? { closedChildren } : {}
    };
    if (state.firstTurnAt === null) {
      state.firstTurnAt = at2;
    }
    return;
  }
  if (!state.openTurn) {
    return;
  }
  const notice = taskNotificationText(record);
  if (state.currentTurnOutcome) {
    const held = state.currentTurnOutcome.openChildren ?? [];
    const open = nextOpenChildren(held, record, notice);
    if (open !== held) {
      if (open.length > 0) {
        state.currentTurnOutcome.openChildren = [...open];
      } else {
        delete state.currentTurnOutcome.openChildren;
      }
    }
    const heldClosed = state.currentTurnOutcome.closedChildren ?? [];
    if (notice !== null) {
      state.closedChildIndex ??= indexClosedChildren(heldClosed);
      if (addClosedChildNotice(heldClosed, state.closedChildIndex, notice, claudeRecordAt(record))) {
        state.currentTurnOutcome.closedChildren = heldClosed;
      }
    }
  }
  const processEndedAt = claudeProcessEndedAt(record);
  if (processEndedAt !== null && state.currentTurnOutcome) {
    state.openTurnAnswered = true;
    delete state.currentTurnOutcome.openChildren;
    delete state.currentTurnOutcome.closedChildren;
    state.closedChildIndex = void 0;
    state.currentTurnOutcome.processEndedAt = Math.max(state.currentTurnOutcome.processEndedAt ?? 0, processEndedAt);
    return;
  }
  if (notice !== null) {
    if (state.currentTurnOutcome) {
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, claudeRecordAt(record));
    }
    return;
  }
  if (record.type === "user") {
    const at2 = stamp(record.timestamp);
    if (interruptedATurn(record)) {
      state.openTurnAnswered = true;
      state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at2);
      if (state.currentTurnOutcome) {
        state.currentTurnOutcome.interrupted = true;
        state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at2);
      }
      return;
    }
    if (record.toolUseResult && typeof record.toolUseResult === "object" && state.currentTurnOutcome) {
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at2);
    }
    return;
  }
  if (record.type !== "assistant") {
    return;
  }
  const message = record.message;
  if (failedATurn(record)) {
    const at2 = stamp(record.timestamp);
    state.openTurnAnswered = true;
    state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at2);
    if (state.currentTurnOutcome) {
      state.currentTurnOutcome.error = true;
      state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at2);
    }
    return;
  }
  if (message?.model === "<synthetic>") {
    return;
  }
  const at = stamp(record.timestamp);
  state.currentTurnEndedAt = Math.max(state.currentTurnEndedAt ?? 0, at);
  if (state.currentTurnOutcome) {
    state.currentTurnOutcome.endedAt = Math.max(state.currentTurnOutcome.endedAt, at);
  }
  const content = message?.content;
  const visible = typeof content === "string" ? content.trim().length > 0 : Array.isArray(content) && content.some((block) => {
    const item = block;
    return item.type === "tool_use" || item.type === "text" && String(item.text ?? "").trim().length > 0;
  });
  if (failedATurn(record) || visible || (message?.usage?.output_tokens ?? 0) > 0) {
    state.openTurnAnswered = true;
  }
  if (answeredATurn(record) && state.currentTurnOutcome) {
    state.currentTurnOutcome.error = false;
  }
  if (message?.stop_reason && state.currentTurnOutcome) {
    state.currentTurnOutcome.finished = finishedATurn(record);
  }
}
function claudeUsage(usage) {
  const created = usage.cache_creation;
  const total1h = created?.ephemeral_1h_input_tokens ?? 0;
  const total5m = created?.ephemeral_5m_input_tokens ?? 0;
  return {
    requests: 1,
    input: usage.input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    // Older transcripts have the total but not the split; charge those at the 1-hour rate,
    // which is what this harness asks for.
    cacheWrite1h: total1h || (total5m ? 0 : usage.cache_creation_input_tokens || 0),
    cacheWrite5m: total5m,
    cacheWrite30m: 0,
    output: usage.output_tokens || 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0
  };
}
function claudeCacheLifetime(usage) {
  const created = usage.cache_creation;
  const hour = created?.ephemeral_1h_input_tokens;
  const short = created?.ephemeral_5m_input_tokens;
  if (hour && short) {
    return null;
  }
  if (hour) {
    return "1h";
  }
  if (short) {
    return "5m";
  }
  return null;
}
function numericUsageField(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function claudeServiceTier(usage) {
  const speed = typeof usage.speed === "string" && usage.speed ? usage.speed : null;
  if (speed && speed !== "standard") {
    return speed;
  }
  return typeof usage.service_tier === "string" && usage.service_tier ? usage.service_tier : null;
}
function claudeInferenceClass(value) {
  if (typeof value !== "string") {
    return null;
  }
  const geo = value.toLowerCase();
  if (geo === "global") {
    return "global";
  }
  if (geo === "us" || geo === "us-only" || geo === "in-region") {
    return "in-region";
  }
  if (geo === "not_available" || geo === "not-available") {
    return null;
  }
  return geo ? "geo" : null;
}
const BEDROCK_MESSAGE_PREFIX = "msg_bdrk_";
function claudeRequestInferenceClass(messageId, profile, geo) {
  if (messageId?.startsWith(BEDROCK_MESSAGE_PREFIX)) {
    return profile?.startsWith("global.") ? null : "bedrock-regional";
  }
  return claudeInferenceClass(geo);
}
const MODEL_ATTACHMENT_MARK = '"modelId"';
function noteClaudeModelProfile(state, record) {
  const attachment = record.attachment;
  if (record.type !== "attachment" || attachment?.type !== "model") {
    return false;
  }
  const id = attachment.identity?.modelId;
  if (typeof id === "string" && id) {
    state.modelProfile = id;
  }
  return true;
}
function seenRequestIndex(state) {
  if (state.seenRequests instanceof Set) {
    return state.seenRequests;
  }
  const index = new Set(state.seenRequestKeys);
  state.seenRequests = index;
  return index;
}
function reduceClaudeUsageRecord(state, record, opts = {}) {
  if (record.type !== "assistant") {
    return null;
  }
  if (record.isSidechain && opts.countSidechain !== true) {
    return null;
  }
  const message = record.message;
  const usage = message?.usage;
  if (!usage || message?.model === "<synthetic>") {
    return null;
  }
  const messageId = typeof message.id === "string" && message.id ? message.id : null;
  const uuid = typeof record.uuid === "string" && record.uuid ? record.uuid : null;
  const timestamp = Date.parse(String(record.timestamp ?? ""));
  const requestKey = `claude:${messageId ?? uuid ?? `${Number.isNaN(timestamp) ? "" : timestamp}:${String(message.model ?? "")}`}`;
  if (opts.emitRepeats !== true) {
    const seen = seenRequestIndex(state);
    if (seen.has(requestKey)) {
      return null;
    }
    seen.add(requestKey);
    state.seenRequestKeys.push(requestKey);
  }
  const counted = claudeUsage(usage);
  const inferenceClass = claudeRequestInferenceClass(messageId, state.modelProfile, usage.inference_geo);
  const serviceTier = claudeServiceTier(usage);
  const model = typeof message.model === "string" && message.model ? message.model : null;
  state.firstRequestCacheRead ??= counted.cacheRead;
  state.lastRequest = {
    tokens: counted.input + counted.cacheRead + counted.cacheWrite1h + counted.cacheWrite5m,
    cacheRead: counted.cacheRead,
    cacheWrite: counted.cacheWrite1h + counted.cacheWrite5m + (counted.cacheWrite30m ?? 0),
    at: Number.isNaN(timestamp) ? null : timestamp,
    lifetime: claudeCacheLifetime(usage) ?? state.lastRequest?.lifetime ?? null,
    inferenceClass,
    serviceTier,
    model
  };
  return {
    timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    agent: "claude",
    // Claude records no provider identity on this response. A model family is not proof of
    // the service that billed it.
    provider: null,
    model,
    contextWindow: null,
    contextBand: null,
    billingClass: "unknown",
    inferenceClass,
    serviceTier,
    effort: typeof record.effort === "string" && record.effort ? record.effort : null,
    toolListVersion: state.toolListVersion ?? 0,
    reportedCost: numericUsageField(usage.cost_usd) ?? numericUsageField(usage.cost),
    // A sidechain response runs under the child agent's own prompt, and this reader counts
    // no visible turn for it. It reports none rather than the parent turn that was open.
    visibleTurnId: record.isSidechain || state.visibleTurns === 0 ? null : `claude-turn:${state.visibleTurns}`,
    cacheLifetime: claudeCacheLifetime(usage),
    compactionsBefore: state.compactionCount,
    usage: counted,
    requestKey
  };
}
function claudeCompactionEstimateEvent(state) {
  const size = state.pendingCompactionSize ?? null;
  const compaction = state.unsizedCompaction ?? null;
  if (!size || !compaction) {
    return null;
  }
  state.pendingCompactionSize = null;
  state.unsizedCompaction = null;
  const previous = compaction.previous;
  if (!previous?.model) {
    return null;
  }
  const at = compaction.at;
  const usage = compactionEstimate({
    model: previous.model,
    at,
    durationMs: size.durationMs,
    contextBefore: size.before || previous.tokens,
    contextAfter: size.after,
    previousRequest: previous,
    firstRequestCacheRead: state.firstRequestCacheRead ?? null,
    summaryChars: compaction.summaryChars ?? null
  })?.usage;
  if (!usage) {
    return null;
  }
  return {
    timestamp: at > 0 ? at : previous.at ?? 0,
    agent: "claude",
    provider: null,
    model: previous.model,
    contextWindow: null,
    contextBand: null,
    billingClass: "unknown",
    inferenceClass: previous.inferenceClass ?? null,
    serviceTier: previous.serviceTier ?? null,
    reportedCost: null,
    visibleTurnId: null,
    compactionsBefore: compaction.ordinal,
    compactionEstimate: true,
    usage,
    requestKey: `claude-compaction:${compaction.ordinal}`
  };
}
function reduceClaudeUsageLine(state, line, opts = {}) {
  const isUser = /"type"\s*:\s*"user"/.test(line);
  const isAssistant = /"type"\s*:\s*"assistant"/.test(line);
  const isProcessEnd = /"type"\s*:\s*"cost-state"/.test(line);
  const isCompactionBoundary = /"subtype"\s*:\s*"compact_boundary"/.test(line);
  const isToolDelta = /"type"\s*:\s*"deferred_tools_delta"/.test(line);
  const isModelAttachment = line.indexOf(MODEL_ATTACHMENT_MARK) >= 0;
  if (!isUser && !isAssistant && !isProcessEnd && !isCompactionBoundary && !isToolDelta && !isModelAttachment && line.indexOf("task-notification") < 0) {
    return null;
  }
  if (skipsOrdinaryToolResult(line, isUser)) {
    return null;
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  reduceClaudeTurnRecord(state, record, opts.countSidechain === true);
  return record.type === "assistant" ? reduceClaudeUsageRecord(state, record, opts) : null;
}
function copyTurnOutcome(outcome) {
  return outcome ? {
    ...outcome,
    ...outcome.openChildren ? { openChildren: [...outcome.openChildren] } : {},
    ...outcome.closedChildren ? { closedChildren: [...outcome.closedChildren] } : {}
  } : null;
}
function negativeUsage(usage) {
  return {
    requests: -(usage.requests ?? 0),
    input: -usage.input,
    cacheWrite1h: -usage.cacheWrite1h,
    cacheWrite5m: -usage.cacheWrite5m,
    cacheWrite30m: -(usage.cacheWrite30m ?? 0),
    cacheRead: -usage.cacheRead,
    output: -usage.output,
    thinking: -usage.thinking
  };
}
function removalFor(event) {
  return {
    ...event,
    reportedCost: event.reportedCost === null ? null : -event.reportedCost,
    usage: negativeUsage(event.usage)
  };
}
function replaceClaudeUsageEvent(state, event, retain = RETAINED_REQUESTS) {
  if (!event.requestKey) {
    return [event];
  }
  const key = event.requestKey;
  const previous = state.requestEvents?.[key];
  const seen = seenRequestIndex(state);
  const counted = seen.has(key);
  if (counted && !previous) {
    return [];
  }
  state.requestEvents ??= {};
  state.requestEvents[key] = { ...event, usage: { ...event.usage } };
  if (!counted) {
    seen.add(key);
    state.seenRequestKeys.push(key);
  }
  while (state.seenRequestKeys.length > retain) {
    const removed = state.seenRequestKeys.shift();
    if (removed) {
      seen.delete(removed);
      delete state.requestEvents[removed];
    }
  }
  return previous ? [removalFor(previous), event] : [event];
}
function createClaudeUsageLineReducer(restored, opts = {}) {
  const restoredKeys = [...restored?.seenRequestKeys ?? []];
  const state = restored ? {
    seenRequestKeys: restoredKeys,
    closedTurns: restored.closedTurns ?? 0,
    openTurn: restored.openTurn,
    openTurnAnswered: restored.openTurnAnswered,
    compactionCount: restored.compactionCount ?? 0,
    recentCompactions: (restored.recentCompactions ?? []).map((item) => ({ ...item })),
    pendingCompactionTrigger: restored.pendingCompactionTrigger ?? null,
    pendingCompactionSize: restored.pendingCompactionSize ? { ...restored.pendingCompactionSize } : null,
    unsizedCompaction: copyUnsizedCompaction(restored.unsizedCompaction),
    lastRequest: restored.lastRequest ? { ...restored.lastRequest } : null,
    firstRequestCacheRead: restored.firstRequestCacheRead ?? null,
    ...restored.modelProfile ? { modelProfile: restored.modelProfile } : {},
    visibleTurns: restored.visibleTurns ?? 0,
    firstTurnAt: restored.firstTurnAt ?? null,
    currentTurnStartedAt: restored.currentTurnStartedAt ?? null,
    currentTurnEndedAt: restored.currentTurnEndedAt ?? null,
    currentTurnOutcome: copyTurnOutcome(restored.currentTurnOutcome),
    // Only a child read removes what a revision replaces, so only a child read carries the
    // events forward. A parent read drops a repeat outright and reads no event. Carrying
    // the events forward would save a map that nothing can pair with the queue.
    ...opts.childTranscript && restored.requestEvents ? {
      requestEvents: {
        ...retainedRequestEvents(restoredKeys, restored.requestEvents)
      }
    } : {}
  } : emptyClaudeUsageReducerState();
  return {
    parserKind: "claude",
    pushLine: (line) => {
      const event = reduceClaudeUsageLine(
        state,
        line,
        opts.childTranscript ? { countSidechain: true, emitRepeats: true } : {}
      );
      const estimate = claudeCompactionEstimateEvent(state);
      if (estimate) {
        return [estimate];
      }
      if (!event || !opts.childTranscript || !event.requestKey) {
        return event ? [event] : [];
      }
      return replaceClaudeUsageEvent(state, event);
    },
    snapshot: () => ({
      seenRequestKeys: [...state.seenRequestKeys],
      closedTurns: state.closedTurns,
      openTurn: state.openTurn,
      openTurnAnswered: state.openTurnAnswered,
      compactionCount: state.compactionCount,
      recentCompactions: state.recentCompactions.map((item) => ({ ...item })),
      pendingCompactionTrigger: state.pendingCompactionTrigger ?? null,
      pendingCompactionSize: state.pendingCompactionSize ? { ...state.pendingCompactionSize } : null,
      unsizedCompaction: copyUnsizedCompaction(state.unsizedCompaction),
      lastRequest: state.lastRequest ? { ...state.lastRequest } : null,
      firstRequestCacheRead: state.firstRequestCacheRead ?? null,
      ...state.modelProfile ? { modelProfile: state.modelProfile } : {},
      visibleTurns: state.visibleTurns,
      firstTurnAt: state.firstTurnAt,
      currentTurnStartedAt: state.currentTurnStartedAt,
      currentTurnEndedAt: state.currentTurnEndedAt,
      currentTurnOutcome: copyTurnOutcome(state.currentTurnOutcome),
      ...state.requestEvents ? { requestEvents: { ...state.requestEvents } } : {}
    }),
    turnCount: () => state.closedTurns + (state.openTurn ? 1 : 0),
    compactionCount: () => state.compactionCount,
    recentCompactions: () => state.recentCompactions.map((item) => ({ ...item })),
    firstTurnAt: () => state.firstTurnAt,
    lastTurnAt: () => state.openTurn ? state.openTurnAnswered ? state.currentTurnEndedAt : state.currentTurnStartedAt : null,
    newestTurnStartedAt: () => state.openTurn ? state.currentTurnStartedAt : null,
    newestTurnOutcome: () => copyTurnOutcome(state.currentTurnOutcome)
  };
}
function readClaudeAgentSpend(file, folders = [], childTranscript = true, metas = readClaudeSubagentMetas) {
  return readClaudeSpendTree(file, folders, childTranscript, metas, /* @__PURE__ */ new Set([normalizeFsPath(file)])).spend;
}
const subagentMetaFiles = /* @__PURE__ */ new Map();
const SUBAGENT_META_LIMIT = 5e3;
function readClaudeSubagentMetas(directory) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const metas = [];
  for (const name of names) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!match) {
      continue;
    }
    const metaFile = path.join(directory, name);
    let meta = subagentMetaFiles.get(metaFile);
    if (!meta) {
      let record;
      try {
        record = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") {
        continue;
      }
      const { toolUseId, parentAgentId } = record;
      meta = {
        id: match[1],
        file: path.join(directory, `agent-${match[1]}.jsonl`),
        toolUseId: typeof toolUseId === "string" && toolUseId ? toolUseId : null,
        parentAgentId: typeof parentAgentId === "string" && parentAgentId ? parentAgentId : null
      };
      if (subagentMetaFiles.size >= SUBAGENT_META_LIMIT) {
        subagentMetaFiles.clear();
      }
      subagentMetaFiles.set(metaFile, meta);
    }
    metas.push(meta);
  }
  return metas;
}
function claudeSubagentMetaReader() {
  const held = /* @__PURE__ */ new Map();
  return (directory) => {
    let metas = held.get(directory);
    if (!metas) {
      metas = readClaudeSubagentMetas(directory);
      held.set(directory, metas);
    }
    return metas;
  };
}
function claudeDirectSubagents(file, childTranscript, metas) {
  const base = path.basename(file, path.extname(file));
  const directory = childTranscript ? path.dirname(file) : path.join(path.dirname(file), base, "subagents");
  const launcher = childTranscript ? base.replace(/^agent-/, "") : null;
  return metas(directory).filter((meta) => meta.parentAgentId === launcher);
}
function claudeAgentSpendVersion(file, childTranscript = true, metas = readClaudeSubagentMetas) {
  const versions = [spendFileVersion(file)];
  const visited = /* @__PURE__ */ new Set([normalizeFsPath(file)]);
  const visit = (launcher, child) => {
    for (const meta of claudeDirectSubagents(launcher, child, metas)) {
      const key = normalizeFsPath(meta.file);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      versions.push(`${meta.id}:${spendFileVersion(meta.file)}`);
      visit(meta.file, true);
    }
  };
  visit(file, childTranscript);
  return versions.join("\n");
}
function childSpendVersion(agent, file, metas = readClaudeSubagentMetas) {
  return agent === "claude" ? claudeAgentSpendVersion(file, true, metas) : spendFileVersion(file);
}
function agentSpendDependencyKey(turns, agentFile, versionOf, structuralKey, codexChildFiles, now) {
  const recorded = turns.flatMap(
    (turn) => turn.agents.map((agent) => {
      const ref = {
        id: agent.id,
        name: agent.description,
        path: agent.agentType,
        status: agent.status,
        toolUseId: agent.toolUseId
      };
      const file = agentFile(ref);
      if (agentSpendIsOpen(ref.status)) {
        const band = file ? openSpendBand(versionOf(file), now) : "none";
        if (band !== null) {
          return `${ref.id || ref.path || ref.name}:open:${band}`;
        }
      }
      return file ? `${file}:${versionOf(file)}` : `${ref.id || ref.path || ref.name}:missing`;
    })
  );
  return [...recorded, ...structuralKey ? [structuralKey] : []].join("\n") + codexChildFiles.map((file) => `
${file}:${versionOf(file)}`).sort().join("");
}
const claudeOwnSpends = /* @__PURE__ */ new Map();
const CLAUDE_OWN_SPEND_LIMIT = 500;
function readClaudeOwnSpend(file, folders, childTranscript, withRecord) {
  const key = [normalizeFsPath(file), childTranscript, withRecord, ...folders].join("\n");
  const revision = spendFileVersion(file);
  const held = claudeOwnSpends.get(key);
  if (held?.revision === revision) {
    claudeOwnSpends.delete(key);
    claudeOwnSpends.set(key, held);
    return held;
  }
  const usageState = emptyClaudeUsageReducerState();
  const launches = /* @__PURE__ */ new Set();
  const failedToolUses = /* @__PURE__ */ new Set();
  let partial = false;
  let effort = null;
  let lastLine = "";
  const estimates = [];
  const compactionState = emptyClaudeUsageReducerState();
  const compactionOptions = childTranscript ? { countSidechain: true, emitRepeats: true } : {};
  const person = withRecord && !childTranscript ? { bytes: 0, person: false, prompts: 0, bg: false, start: 0, userBefore: false } : null;
  const child = createClaudeSessionReducer(path.basename(file, path.extname(file)), {
    childTranscript,
    folders,
    maxTurns: Number.MAX_SAFE_INTEGER
  });
  const found = scanLines(file, (line) => {
    child.pushLine(line);
    if (line.trim()) {
      lastLine = line;
    }
    if (person && !person.person && mayHoldPersonSign(line, person)) {
      try {
        person.person = personSpokeIn(JSON.parse(line), person);
      } catch {
      }
    }
    if (line.indexOf('"type":"assistant"') < 0) {
      if (line.indexOf(MODEL_ATTACHMENT_MARK) >= 0) {
        let record3 = null;
        try {
          record3 = JSON.parse(line);
        } catch {
        }
        if (record3 && (!record3.isSidechain || childTranscript) && noteClaudeModelProfile(usageState, record3)) {
          compactionState.modelProfile = usageState.modelProfile;
          return;
        }
      }
      const failure = /"is_error"\s*:\s*true/.test(line);
      const compaction = /"subtype"\s*:\s*"compact_boundary"|"isCompactSummary"\s*:\s*true/.test(line);
      if (!failure && !compaction) {
        return;
      }
      let record2;
      try {
        record2 = JSON.parse(line);
      } catch {
        return;
      }
      if (failure) {
        const content = record2.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const item = block;
          if (item.type === "tool_result" && item.is_error === true && typeof item.tool_use_id === "string") {
            failedToolUses.add(item.tool_use_id);
          }
        }
      }
      if (!compaction) {
        return;
      }
      reduceClaudeTurnRecord(compactionState, record2, childTranscript);
      const estimate = claudeCompactionEstimateEvent(compactionState);
      if (estimate) {
        estimates.push(estimate);
      }
      return;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const message = o.message;
    reduceClaudeUsageRecord(compactionState, o, compactionOptions);
    if (failedATurn(o) || message?.model === "<synthetic>") {
      return;
    }
    effort = typeof o.effort === "string" && o.effort ? o.effort : effort;
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const item = block;
      if (item.type !== "tool_use" || item.name !== "Agent") {
        continue;
      }
      if (typeof item.id === "string" && item.id) {
        launches.add(item.id);
      } else {
        partial = true;
      }
    }
    const event = reduceClaudeUsageRecord(usageState, o, { countSidechain: true, emitRepeats: true });
    if (event) {
      replaceClaudeUsageEvent(usageState, event, Number.POSITIVE_INFINITY);
    }
  });
  const byRequest = Object.values(usageState.requestEvents ?? {});
  const byModel = /* @__PURE__ */ new Map();
  for (const request of byRequest) {
    addModelUsage(byModel, request.model, request.usage);
  }
  const exact = { usageParts: [] };
  for (const request of [...byRequest, ...estimates]) {
    addTurnUsagePart(exact, request);
  }
  const childTurns = child.finish().turns;
  let record = null;
  if (withRecord) {
    const span = childTurnSpan(childTurns);
    const startedAt = span.startedAt ?? null;
    const firstEndedAt = childTurns[0]?.endedAt;
    const endedAt = firstEndedAt ? Math.max(span.endedAt ?? firstEndedAt, firstEndedAt) : span.endedAt ?? null;
    const toolUses = childTurns.reduce((total, turn) => total + turn.stepCount, 0);
    const commits = [];
    for (const commit of childTurns.flatMap((turn) => turn.commits)) {
      if (!commits.some((kept) => sameCommitSha(kept.sha, commit.sha))) {
        commits.push(commit);
      }
    }
    const commitIntents = childTurns.flatMap((turn) => turn.commitIntents ?? []);
    const artifacts = reduceChildArtifacts(
      { turns: childTurns },
      {
        revision,
        complete: lastLineWhole(lastLine),
        pathKey: normalizeFsPath,
        sameCommit: sameCommitSha
      }
    );
    record = {
      artifacts,
      ...childTranscript ? {} : { startedAt, endedAt, toolUses },
      ...commits.length ? { commits } : {},
      ...commitIntents.length ? { commitIntents } : {},
      ...person?.person ? { person: true } : {}
    };
  }
  const own = {
    revision,
    found,
    byModel: [...byModel],
    usageParts: exact.usageParts,
    launches: [...launches].filter((id) => !failedToolUses.has(id)),
    partial,
    effort,
    finished: childTurns.at(-1)?.finished === true,
    record
  };
  claudeOwnSpends.delete(key);
  claudeOwnSpends.set(key, own);
  while (claudeOwnSpends.size > CLAUDE_OWN_SPEND_LIMIT) {
    const oldest = claudeOwnSpends.keys().next().value;
    if (oldest === void 0) {
      break;
    }
    claudeOwnSpends.delete(oldest);
  }
  return own;
}
function readClaudeSpendTree(file, folders, childTranscript, metas, visited, withRecord = true) {
  const own = readClaudeOwnSpend(file, folders, childTranscript, withRecord);
  if (!own.found) {
    return { spend: { models: [], found: false, partial: false, effort: null }, finished: own.finished };
  }
  let partial = own.partial;
  const byModel = new Map(structuredClone(own.byModel));
  const usageParts = structuredClone(own.usageParts);
  if (own.launches.length) {
    const children = claudeDirectSubagents(file, childTranscript, metas);
    if (own.launches.some((id) => !children.some((meta) => meta.toolUseId === id))) {
      partial = true;
    }
    for (const meta of children) {
      const key = normalizeFsPath(meta.file);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const nested = readClaudeSpendTree(meta.file, folders, true, metas, visited, false);
      if (!nested.spend.found || nested.spend.partial || !nested.finished) {
        partial = true;
      }
      for (const spend of nested.spend.models) {
        addModelUsage(byModel, spend.model, spend.usage);
        for (const part of spend.usageParts ?? []) {
          addPricedUsagePart(usageParts, part);
        }
      }
    }
  }
  const models = modelSpends(byModel).map((spend) => ({
    ...spend,
    usageParts: usageParts.filter((part) => part.model === spend.model)
  }));
  const record = own.record ? structuredClone(own.record) : {};
  return { spend: { models, found: true, partial, effort: own.effort, ...record }, finished: own.finished };
}
function readTurns(file, sessionId, opts = {}) {
  return readSession(file, sessionId, { ...opts, turnsOnly: true }).turns;
}
const firstRequestReads = /* @__PURE__ */ new Map();
const FIRST_REQUEST_READS_KEPT = 512;
function claudeFirstRequestCacheRead(file, childTranscript = false) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${childTranscript ? "child" : "main"}:${file}`;
  const held = firstRequestReads.get(key);
  if (held && held.dev === stat.dev && held.ino === stat.ino && stat.size >= held.size && (held.cacheRead !== null || stat.size === held.size)) {
    return held.cacheRead;
  }
  const cacheRead = scanClaudeFirstRequestCacheRead(file, childTranscript);
  firstRequestReads.delete(key);
  if (firstRequestReads.size >= FIRST_REQUEST_READS_KEPT) {
    firstRequestReads.delete(firstRequestReads.keys().next().value);
  }
  firstRequestReads.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, cacheRead });
  return cacheRead;
}
function scanClaudeFirstRequestCacheRead(file, childTranscript) {
  const state = emptyClaudeUsageReducerState();
  const opts = childTranscript ? { countSidechain: true, emitRepeats: true } : {};
  scanLines(file, (line) => {
    if (!/"type"\s*:\s*"assistant"/.test(line)) {
      return false;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return false;
    }
    reduceClaudeUsageRecord(state, record, opts);
    return state.firstRequestCacheRead != null;
  });
  return state.firstRequestCacheRead ?? null;
}
function withClaudeFirstRequest(file, compactions, childTranscript = false) {
  const asking = compactions.filter(
    (compaction) => compaction.previousRequest && compaction.firstRequestCacheRead === void 0
  );
  if (!asking.length) {
    return;
  }
  const read = claudeFirstRequestCacheRead(file, childTranscript);
  if (read === null) {
    return;
  }
  for (const compaction of asking) {
    compaction.firstRequestCacheRead = read;
  }
}
function readSession(file, sessionId, opts = {}) {
  const tailBytes = opts.tailBytes ?? 4 * 1024 * 1024;
  const tail = tailOf(file, tailBytes, opts.prepareNewestTurnDiscovery === true);
  const read = readSessionLines(tail.lines, sessionId, opts, tail.readBytes, tail.offset);
  if (!opts.turnsOnly) {
    withClaudeFirstRequest(file, read.compactions, opts.childTranscript === true);
  }
  if (opts.prepareNewestTurnDiscovery && !tail.whole && tail.cursor && sessionTurnStartsIn(tail.lines).length === 0) {
    read.newestTurnCursor = tail.cursor;
  }
  return read;
}
function discoverClaudeNewestTurn(file, cursor, options = {}) {
  return discoverBackwardBoundary(file, cursor, (line) => humanPromptIn(line.text, false) !== null, options);
}
function emptyClaudeSessionParserState(opts) {
  const suppliedTitle = normalizeSessionTitle(opts.sessionTitle);
  const suppliedFullTitle = normalizeFullSessionTitle(opts.sessionTitle);
  return {
    version: 6,
    turns: [],
    turnRanges: [],
    turnMembershipStarts: [],
    compactions: [],
    compactionRanges: [],
    compactionMetadataRanges: [],
    compactionValueSources: [],
    turnLimitReached: false,
    turnLimitStart: null,
    lastContext: 0,
    lastLifetime: null,
    lastContextSource: null,
    lastModel: null,
    lastModelSource: null,
    currentModelSource: null,
    compactMeta: [],
    launched: /* @__PURE__ */ new Map(),
    toolNames: /* @__PURE__ */ new Map(),
    stepById: /* @__PURE__ */ new Map(),
    skillUseById: /* @__PURE__ */ new Map(),
    pendingTypedSkill: null,
    handbacks: /* @__PURE__ */ new Map(),
    handedBack: false,
    repeatNotice: false,
    repeatReplyId: null,
    workedSinceReply: false,
    toolOwnerById: /* @__PURE__ */ new Map(),
    narrationOrdinals: /* @__PURE__ */ new Map(),
    awaited: [],
    calls: /* @__PURE__ */ new Map(),
    editCalls: /* @__PURE__ */ new Map(),
    lastResultAt: 0,
    lastResultCallAt: 0,
    wrote: /* @__PURE__ */ new Set(),
    usageState: emptyClaudeUsageReducerState(),
    cur: null,
    queued: [],
    pending: { held: null },
    suppliedTitle,
    suppliedFullTitle,
    title: suppliedTitle,
    fullTitle: suppliedFullTitle,
    titleSource: null,
    titleAt: null,
    titleRecord: null
  };
}
function emitClaudeTurn(state, turn, maxTurns) {
  const emitted = { ...turn, files: [...turn.files.values()] };
  state.turns.push(emitted);
  for (const [id, owner] of state.toolOwnerById) {
    if (owner === turn) {
      state.toolOwnerById.set(id, emitted);
    }
  }
  for (const held of state.skillUseById.values()) {
    if (held.owner === turn) {
      held.owner = emitted;
    }
  }
  const range = { start: turn[SOURCE_START] ?? 0, end: turn[SOURCE_END] ?? 0 };
  state.turnRanges.push(range);
  state.turnMembershipStarts.push(turn[MEMBERSHIP_START] ?? range.start);
  if (state.turns.length > maxTurns) {
    state.turns.shift();
    state.turnRanges.shift();
    const removedMembership = state.turnMembershipStarts.shift();
    state.turnLimitReached = true;
    state.turnLimitStart = removedMembership ?? state.turnLimitStart;
  }
}
function retainedClaudeTurns(state) {
  return [...state.turns, ...state.cur ? [state.cur] : [], ...state.pending.held ? [state.pending.held] : []];
}
function discardClaudeToolAssociation(state, id) {
  state.stepById.delete(id);
  state.toolOwnerById.delete(id);
  state.toolNames.delete(id);
  state.calls.delete(id);
  state.editCalls.delete(id);
}
function boundClaudeToolAssociations(state) {
  if (state.awaited.length > CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN) {
    state.awaited.splice(0, state.awaited.length - CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN);
  }
  const ownerCounts = /* @__PURE__ */ new Map();
  for (const owner of state.toolOwnerById.values()) {
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
  }
  for (const [id, owner] of state.toolOwnerById) {
    const count = ownerCounts.get(owner) ?? 0;
    if (count <= CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN) {
      continue;
    }
    discardClaudeToolAssociation(state, id);
    ownerCounts.set(owner, count - 1);
  }
  let ownerlessCalls = 0;
  for (const id of state.calls.keys()) {
    if (!state.toolOwnerById.has(id)) {
      ownerlessCalls++;
    }
  }
  let discardOwnerless = ownerlessCalls - CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN;
  if (discardOwnerless <= 0) {
    return;
  }
  for (const id of state.calls.keys()) {
    if (discardOwnerless <= 0) {
      break;
    }
    if (!state.toolOwnerById.has(id)) {
      state.calls.delete(id);
      discardOwnerless--;
    }
  }
}
function pruneClaudeTurnAssociations(state) {
  const retainedTurns = retainedClaudeTurns(state);
  const retainedOwners = new Set(retainedTurns);
  const retainedSteps = new Set(state.awaited);
  const retainedNarration = /* @__PURE__ */ new Set();
  for (const turn of retainedTurns) {
    for (const step of turn.steps) {
      retainedSteps.add(step);
    }
    for (const update of turn.updates) {
      const match = /^(.*):text:\d+$/.exec(update.sourceId);
      if (match) {
        retainedNarration.add(match[1]);
      }
    }
  }
  for (const [id, owner] of state.toolOwnerById) {
    if (!retainedOwners.has(owner)) {
      state.toolOwnerById.delete(id);
    }
  }
  for (const [id, step] of state.stepById) {
    if (!retainedSteps.has(step) && !state.toolOwnerById.has(id)) {
      state.stepById.delete(id);
    }
  }
  for (const id of state.toolNames.keys()) {
    if (!state.stepById.has(id) && !state.launched.has(id)) {
      state.toolNames.delete(id);
    }
  }
  for (const id of state.calls.keys()) {
    if (!state.stepById.has(id)) {
      state.calls.delete(id);
    }
  }
  for (const id of state.editCalls.keys()) {
    if (!state.stepById.has(id)) {
      state.editCalls.delete(id);
    }
  }
  for (const id of state.narrationOrdinals.keys()) {
    if (!retainedNarration.has(id)) {
      state.narrationOrdinals.delete(id);
    }
  }
  for (const [id, held] of state.skillUseById) {
    if (!retainedOwners.has(held.owner) || !held.owner.skillUses.includes(held.use)) {
      state.skillUseById.delete(id);
    }
  }
  boundClaudeToolAssociations(state);
}
function pruneClaudeAgentAssociations(state) {
  const retained = /* @__PURE__ */ new Set();
  for (const turn of retainedClaudeTurns(state)) {
    for (const agent of turn.agents) {
      retained.add(agent);
    }
  }
  for (const [id, agent] of state.launched) {
    if (!retained.has(agent)) {
      state.launched.delete(id);
    }
  }
}
function trimClaudeBefore(state, offset, maxTurns) {
  if (state.turnLimitStart !== null && state.turnLimitStart < offset) {
    state.turnLimitReached = false;
    state.turnLimitStart = null;
  }
  const completedCurrent = state.cur && (state.cur.finished || state.cur.interrupted || state.cur.error !== null) ? state.cur : null;
  const currentMembershipStart = state.cur ? state.cur[MEMBERSHIP_START] ?? state.cur[SOURCE_START] ?? 0 : 0;
  const straddlesCurrentDependency = state.cur !== null && (state.cur[SOURCE_START] ?? 0) < offset && currentMembershipStart >= offset;
  if (completedCurrent && (completedCurrent[MEMBERSHIP_START] ?? completedCurrent[SOURCE_START] ?? 0) < offset) {
    state.cur = null;
    state.currentModelSource = null;
    state.awaited = [];
  }
  if (state.lastContextSource && state.lastContextSource.start < offset) {
    state.lastContext = 0;
    state.lastContextSource = null;
    state.lastContextRequest = null;
    state.lastContextCache = null;
  }
  if (state.lastModelSource && state.lastModelSource.start < offset) {
    state.lastModel = null;
    state.lastModelSource = null;
  }
  const retained = state.turns.map((turn, index) => ({
    turn,
    range: state.turnRanges[index],
    membershipStart: state.turnMembershipStarts[index] ?? state.turnRanges[index].start
  })).filter(({ membershipStart }) => membershipStart >= offset);
  const straddlesTurnDependency = retained.some(
    ({ range, membershipStart }) => range.start < offset && membershipStart >= offset
  );
  state.turns = retained.map(({ turn }) => turn);
  state.turnRanges = retained.map(({ range }) => range);
  state.turnMembershipStarts = retained.map(({ membershipStart }) => membershipStart);
  const compactions = state.compactions.map((compaction, index) => ({
    compaction,
    range: state.compactionRanges[index],
    metadataRange: state.compactionMetadataRanges[index] ?? null,
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
    if (compaction.previousRequest && (!valueSources.previous || valueSources.previous.start < offset)) {
      delete compaction.previousRequest;
      valueSources.previous = null;
    }
  }
  state.compactions = compactions.map(({ compaction }) => compaction);
  state.compactionRanges = compactions.map(({ range }) => range);
  state.compactionMetadataRanges = compactions.map(({ metadataRange }) => metadataRange);
  state.compactionValueSources = compactions.map(({ valueSources }) => valueSources);
  state.compactMeta = state.compactMeta.filter((meta) => meta.start >= offset);
  boundClaudeCompactions(state, maxTurns);
  pruneClaudeAgentAssociations(state);
  pruneClaudeTurnAssociations(state);
  return straddlesCurrentDependency || straddlesTurnDependency || compactions.some(({ metadataRange }) => metadataRange !== null && metadataRange.start < offset);
}
const CLAUDE_SKILL_BASE_DIRECTORY = "Base directory for this skill:";
function claudeSkillBaseDirectory(text) {
  if (!text.startsWith(CLAUDE_SKILL_BASE_DIRECTORY)) {
    return "";
  }
  return firstLine(text.slice(CLAUDE_SKILL_BASE_DIRECTORY.length)).trim();
}
function claudeSkillFile(directory) {
  return `${directory.replace(/[\\/]+$/, "")}/SKILL.md`;
}
const TYPED_SKILL_ORIGIN = Symbol("typedSkillOrigin");
function recordClaudeSkillUse(state, turn, id, name, at) {
  if (turn.skillUses.some((existing) => existing.name === name && existing[TYPED_SKILL_ORIGIN])) {
    return;
  }
  const use = { sourceId: id, name, at, evidence: "recorded" };
  addTurnSkillUse(turn, use);
  state.skillUseById.delete(id);
  state.skillUseById.set(id, { use, owner: turn });
}
function recordTypedClaudeSkillUse(state, turn, id, name, at, path2) {
  const use = { sourceId: id, name, path: path2, at, evidence: "recorded" };
  Object.defineProperty(use, TYPED_SKILL_ORIGIN, { value: true, enumerable: false, configurable: true });
  addTurnSkillUse(turn, use);
  state.skillUseById.delete(id);
  state.skillUseById.set(id, { use, owner: turn });
}
function withdrawClaudeSkillUse(state, id) {
  const held = state.skillUseById.get(id);
  if (!held) {
    return;
  }
  state.skillUseById.delete(id);
  const index = held.owner.skillUses.indexOf(held.use);
  if (index < 0) {
    return;
  }
  held.owner.skillUses.splice(index, 1);
  held.owner.skillUseCount = Math.max(0, held.owner.skillUseCount - 1);
}
function applyClaudeTaskNotification(state, raw, at) {
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw);
  const task = /<task-id>([^<]+)<\/task-id>/.exec(raw);
  setClaudeRepeatNotice(state, task !== null && state.handbacks.get(task[1]) === true && !state.workedSinceReply);
  const status = /<status>([^<]+)<\/status>/.exec(raw);
  const agent = id ? state.launched.get(id[1]) : void 0;
  if (agent && status) {
    agent.status = status[1];
    if (status[1] !== "running") {
      agent.closedAt = at;
    }
  }
  if (agent) {
    agent.id = task ? task[1] : agent.id;
    const tokens = /<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(raw);
    const tools = /<tool_uses>(\d+)<\/tool_uses>/.exec(raw);
    const took = /<duration_ms>(\d+)<\/duration_ms>/.exec(raw);
    if (tokens) {
      agent.tokens = Number(tokens[1]);
    }
    if (tools) {
      agent.toolUses = Number(tools[1]);
      delete agent.toolUsesFromArtifacts;
    }
    if (took) {
      agent.durationMs = Number(took[1]);
    }
  }
  if (agent && id && status && status[1] !== "running") {
    finishClaudeTool(state, id[1], true);
  }
}
function applyClaudeAgentResultText(state, id, content) {
  const agent = state.launched.get(id);
  if (!agent) {
    return;
  }
  const result = claudeAgentResultText(content);
  if (result.agentId) {
    agent.id = result.agentId;
  }
  if (result.background) {
    return;
  }
  agent.status = "completed";
  if (result.tokens !== null) {
    agent.tokens = result.tokens;
  }
  if (result.durationMs !== null) {
    agent.durationMs = result.durationMs;
  }
  if (result.toolUses !== null) {
    agent.toolUses = result.toolUses;
    delete agent.toolUsesFromArtifacts;
  }
  finishClaudeTool(state, id, true);
}
function finishClaudeTool(state, id, terminalAgent) {
  if (terminalAgent) {
    state.launched.delete(id);
  }
  if (terminalAgent || !state.launched.has(id)) {
    state.toolNames.delete(id);
    state.stepById.delete(id);
    state.toolOwnerById.delete(id);
    state.calls.delete(id);
    state.editCalls.delete(id);
  }
}
function boundClaudeCompactions(state, maxTurns) {
  const limit = Math.max(0, Math.floor(maxTurns));
  if (state.compactions.length > limit) {
    const remove = state.compactions.length - limit;
    state.compactions.splice(0, remove);
    state.compactionRanges.splice(0, remove);
    state.compactionMetadataRanges.splice(0, remove);
    state.compactionValueSources.splice(0, remove);
  }
  if (state.compactMeta.length > limit) {
    state.compactMeta.splice(0, state.compactMeta.length - limit);
  }
}
function extendClaudeCompactionMetadataRange(state, index, start, end) {
  const range = state.compactionMetadataRanges[index];
  state.compactionMetadataRanges[index] = range ? { start: Math.min(range.start, start), end: Math.max(range.end, end) } : { start, end };
}
function expireClaudeCompactMetadata(state, at) {
  if (!at) {
    return;
  }
  state.compactMeta = state.compactMeta.filter((meta) => !meta.at || at - meta.at <= COMPACT_META_WINDOW_MS);
}
function closeClaudeTurn(state, maxTurns) {
  const turn = state.cur;
  if (!turn) {
    return;
  }
  const answered = turn.toolUses > 0 || turn.usage.output > 0 || turn.summary !== "" || turn.error !== null || turn.interrupted || turn.processEndedAt !== void 0;
  if (answered) {
    emitClaudeTurn(state, turn, maxTurns);
    state.pending.held = null;
  } else {
    state.pending.held = turn;
  }
  state.cur = null;
  state.currentModelSource = null;
  state.awaited = [];
  pruneClaudeAgentAssociations(state);
  pruneClaudeTurnAssociations(state);
}
function settleClaudeSteps(state) {
  for (const step of state.awaited) {
    if (step.status === "running") {
      step.status = "done";
    }
  }
  state.awaited = [];
}
function reduceClaudeSessionLine(state, input, sessionId, opts) {
  const line = typeof input === "string" ? input : input.text;
  const sourceStart = typeof input === "string" ? 0 : input.start ?? 0;
  const sourceEnd = typeof input === "string" ? sourceStart : input.end ?? sourceStart;
  const maxTurns = opts.maxTurns ?? 40;
  if (line.length < 20) {
    return;
  }
  if (line.indexOf(MODEL_ATTACHMENT_MARK) >= 0) {
    try {
      const o2 = JSON.parse(line);
      if ((!o2.isSidechain || opts.childTranscript) && noteClaudeModelProfile(state.usageState, o2)) {
        return;
      }
    } catch {
    }
  }
  if (line.indexOf('"compactMetadata"') >= 0) {
    try {
      const o2 = JSON.parse(line);
      if (o2.compactMetadata) {
        const at = stamp(o2.timestamp);
        expireClaudeCompactMetadata(state, at);
        let closestIndex = -1;
        let closestGap = COMPACT_META_WINDOW_MS;
        for (let index = 0; index < state.compactions.length; index += 1) {
          const compaction = state.compactions[index];
          const gap = Math.abs(compaction.at - at);
          if (gap <= closestGap) {
            closestIndex = index;
            closestGap = gap;
          }
        }
        if (closestIndex >= 0) {
          applyCompactMetadata(state.compactions[closestIndex], o2.compactMetadata);
          extendClaudeCompactionMetadataRange(state, closestIndex, sourceStart, sourceEnd);
          if (o2.compactMetadata.preTokens) {
            state.compactionValueSources[closestIndex].context = { start: sourceStart, end: sourceEnd };
          }
        } else {
          state.compactMeta.push({ at, data: o2.compactMetadata, start: sourceStart, end: sourceEnd });
        }
        boundClaudeCompactions(state, maxTurns);
      }
    } catch {
    }
    return;
  }
  if (line.indexOf('"ai-title"') >= 0 || line.indexOf('"custom-title"') >= 0) {
    try {
      const o2 = JSON.parse(line);
      const at = typeof input === "string" ? null : sourceStart;
      if (o2.type === "custom-title" && typeof o2.customTitle === "string") {
        const title = customTitleOf(o2);
        if (title) {
          setRecordedTitle(state, "custom", {
            title,
            fullTitle: normalizeFullSessionTitle(o2.customTitle),
            start: sourceStart,
            end: sourceEnd,
            at
          });
        } else if (state.titleSource === "custom") {
          if (state.generatedTitle) {
            setRecordedTitle(state, "generated", state.generatedTitle);
          } else {
            state.title = state.suppliedTitle;
            state.fullTitle = state.suppliedFullTitle;
            state.titleSource = null;
            state.titleAt = null;
            state.titleRecord = null;
          }
        }
      } else if (o2.type === "ai-title" && typeof o2.aiTitle === "string" && o2.aiTitle) {
        const title = normalizeSessionTitle(o2.aiTitle);
        const record = title ? {
          title,
          fullTitle: normalizeFullSessionTitle(o2.aiTitle),
          start: sourceStart,
          end: sourceEnd,
          at
        } : null;
        state.generatedTitle = record;
        if (state.titleSource === "custom") {
          return;
        }
        if (record) {
          setRecordedTitle(state, "generated", record);
        } else {
          state.title = state.suppliedTitle;
          state.fullTitle = state.suppliedFullTitle;
          state.titleSource = null;
          state.titleAt = null;
          state.titleRecord = { title: state.title, fullTitle: state.fullTitle, start: sourceStart, end: sourceEnd };
        }
      }
    } catch {
    }
    return;
  }
  if (line.indexOf('"queued_command"') >= 0) {
    let attachmentLine = false;
    try {
      const o2 = JSON.parse(line);
      attachmentLine = o2.type === "attachment";
      const attachment = o2.attachment;
      if (attachmentLine && !o2.isSidechain && isReaderQueued(attachment) && state.cur) {
        const text = cleanPrompt(textOf(attachment?.prompt));
        if (text) {
          setClaudeRepeatNotice(state, false);
          state.cur.laterPrompts.push({
            text,
            at: stamp(attachment?.timestamp ?? o2.timestamp),
            stepsBefore: state.cur.stepCount
          });
          if (state.cur.laterPrompts.length > TURN_ASK_LIMIT) {
            state.cur.laterPrompts.shift();
          }
          extendSourceRange(state.cur, sourceStart, sourceEnd);
        }
      }
      if (attachmentLine && !o2.isSidechain && attachment?.commandMode === "prompt" && state.cur) {
        applyClaudePeerMessage(state, attachment.origin);
      }
      const notice = attachmentLine && !o2.isSidechain ? taskNotificationText(o2) : null;
      if (notice !== null && state.cur) {
        const at = claudeRecordAt(o2);
        applyClaudeTaskNotification(state, notice, at);
        state.cur.endedAt = Math.max(state.cur.endedAt, at);
        extendSourceRange(state.cur, sourceStart, sourceEnd);
      }
    } catch {
    }
    if (attachmentLine) {
      return;
    }
  }
  if (line.indexOf('"type":"cost-state"') >= 0) {
    try {
      const o2 = JSON.parse(line);
      const processEndedAt = claudeProcessEndedAt(o2);
      if (processEndedAt !== null && state.cur && !o2.isSidechain) {
        state.cur.processEndedAt = Math.max(state.cur.processEndedAt ?? 0, processEndedAt);
        extendSourceRange(state.cur, sourceStart, sourceEnd);
      }
    } catch {
    }
    return;
  }
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  const isUser = !isAssistant && line.indexOf('"type":"user"') >= 0;
  if (!isAssistant && !isUser) {
    return;
  }
  if (skipsOrdinaryToolResult(line, isUser, state.wrote)) {
    return;
  }
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.isSidechain && !opts.childTranscript) {
    return;
  }
  if (state.pendingTypedSkill) {
    const pendingSkill = state.pendingTypedSkill;
    state.pendingTypedSkill = null;
    if (isUser && o.isMeta && state.cur) {
      const directory = claudeSkillBaseDirectory(textOf(o.message?.content));
      if (directory) {
        recordTypedClaudeSkillUse(
          state,
          state.cur,
          pendingSkill.sourceId,
          pendingSkill.name,
          pendingSkill.at,
          claudeSkillFile(directory)
        );
      }
    }
  }
  expireClaudeCompactMetadata(state, stamp(o.timestamp));
  if (isUser && o.isCompactSummary) {
    const content2 = o.message?.content;
    const compaction = {
      sessionId,
      at: stamp(o.timestamp),
      contextBefore: state.lastContext,
      contextAfter: 0,
      droppedTokens: 0,
      durationMs: 0,
      trigger: "",
      model: state.lastModel,
      ...state.lastContext > 0 && state.lastContextRequest ? {
        previousRequest: {
          tokens: state.lastContext,
          at: state.lastContextRequest.at,
          lifetime: state.lastContextRequest.lifetime,
          inferenceClass: state.lastContextRequest.inferenceClass,
          serviceTier: state.lastContextRequest.serviceTier,
          ...state.lastContextCache ? { cacheRead: state.lastContextCache.read, cacheWrite: state.lastContextCache.write } : {}
        }
      } : {},
      summaryChars: compactSummaryChars(o),
      summary: stripCompactPreamble(typeof content2 === "string" ? content2 : textOf(content2))
    };
    state.compactions.push(compaction);
    state.compactionRanges.push({ start: sourceStart, end: sourceEnd });
    state.compactionMetadataRanges.push(null);
    state.compactionValueSources.push({
      context: state.lastContextSource ? { ...state.lastContextSource } : null,
      model: state.lastModelSource ? { ...state.lastModelSource } : null,
      previous: compaction.previousRequest && state.lastContextSource ? { ...state.lastContextSource } : null
    });
    const compactionIndex = state.compactions.length - 1;
    state.compactMeta = state.compactMeta.filter((meta) => {
      if (!withinCompactWindow(compaction.at, meta.at)) {
        return true;
      }
      applyCompactMetadata(compaction, meta.data);
      extendClaudeCompactionMetadataRange(state, compactionIndex, meta.start, meta.end);
      if (meta.data.preTokens) {
        state.compactionValueSources[compactionIndex].context = { start: meta.start, end: meta.end };
      }
      return false;
    });
    boundClaudeCompactions(state, maxTurns);
    return;
  }
  if (isUser && isTypedPrompt(o, opts.childTranscript)) {
    closeClaudeTurn(state, maxTurns);
    const at = stamp(o.timestamp);
    const carried = state.pending.held;
    const carriedAsks = carried ? carried.laterPrompts : [];
    if (carried) {
      state.queued.push(...carried.promptParts ?? []);
      state.pending.held = null;
    }
    const rawText = textOf(o.message.content);
    const asked = [...state.queued, { text: cleanPrompt(rawText), at, stepsBefore: 0 }];
    setClaudeRepeatNotice(state, false);
    state.handedBack = false;
    state.queued = [];
    const next = {
      agent: "claude",
      sessionId,
      sessionTitle: opts.sessionTitle ?? null,
      promptId: String(o.promptId || ""),
      startedAt: at,
      endedAt: at,
      prompt: asked.map((one) => one.text).join("\n\n"),
      promptParts: asked,
      summary: "",
      answers: [],
      model: null,
      effort: null,
      files: /* @__PURE__ */ new Map(),
      agents: [],
      commits: [],
      usage: { requests: 0, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
      usageParts: [],
      contextTokens: 0,
      // Claude Code records no window per turn, so the price table answers for it.
      contextWindow: null,
      toolUses: 0,
      toolCounts: emptyToolCounts(),
      toolTally: {},
      laterPrompts: carriedAsks.slice(-TURN_ASK_LIMIT),
      steps: [],
      updates: [],
      stepCount: 0,
      stepKinds: [],
      failedOrdinals: [],
      skillUses: [],
      skillUseCount: 0,
      failures: [],
      interrupted: false,
      finished: false,
      error: null
    };
    setSourceRange(next, carried?.[SOURCE_START] ?? sourceStart, sourceEnd);
    setMembershipStart(next, sourceStart);
    state.cur = next;
    state.currentModelSource = null;
    const commandNamed = COMMAND_NAMED.exec(rawText);
    const commandName = commandNamed ? commandNamed[1] : null;
    state.pendingTypedSkill = commandName && !HARNESS_COMMANDS.has(commandName) ? {
      name: commandName.slice(1),
      sourceId: o.message?.id || (typeof o.uuid === "string" && o.uuid ? o.uuid : `at-${stamp(o.timestamp)}`),
      at
    } : null;
    return;
  }
  if (!state.cur) {
    return;
  }
  const cur = state.cur;
  extendSourceRange(cur, sourceStart, sourceEnd);
  if (isUser) {
    const notice = taskNotificationText(o);
    if (notice !== null) {
      const at = stamp(o.timestamp);
      applyClaudeTaskNotification(state, notice, at);
      cur.endedAt = Math.max(cur.endedAt, at);
      return;
    }
    if (o.isMeta) {
      applyClaudePeerMessage(state, o.origin);
    }
    if (interruptedATurn(o)) {
      cur.interrupted = true;
      cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
      return;
    }
    const loaded = typeof o.sourceToolUseID === "string" ? state.skillUseById.get(o.sourceToolUseID) : void 0;
    if (loaded) {
      const directory = claudeSkillBaseDirectory(textOf(o.message.content));
      if (directory) {
        loaded.use.path = claudeSkillFile(directory);
        return;
      }
    }
    const blocks = o.message.content;
    const completedToolIds = [];
    let failed = false;
    const result = o.toolUseResult;
    const structuredEvidence = !!result && typeof result === "object" && !Array.isArray(result) && (typeof result.stdout === "string" || Object.prototype.hasOwnProperty.call(result, "bashEditDiff") || Object.prototype.hasOwnProperty.call(result, "structuredPatch"));
    const fromCallAndText = opts.childTranscript === true && !structuredEvidence;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type !== "tool_result") {
          continue;
        }
        const toolId = b.tool_use_id || "";
        if (toolId) {
          completedToolIds.push(toolId);
        }
        const step = state.stepById.get(toolId);
        if (step) {
          setTurnStepStatus(state.toolOwnerById.get(toolId) ?? cur, step, b.is_error ? "failed" : "done");
        }
        if (!b.is_error) {
          if (fromCallAndText && toolId) {
            recordCallAndTextEvidence(state, cur, toolId, b.content, stamp(o.timestamp), opts.folders ?? []);
          }
          if (opts.childTranscript === true && toolId && result?.totalToolUseCount == null) {
            applyClaudeAgentResultText(state, toolId, b.content);
          }
          continue;
        }
        withdrawClaudeSkillUse(state, toolId);
        failed = true;
        cur.failures.push({
          tool: state.toolNames.get(toolId) || UNNAMED_TOOL,
          message: firstLine(textOf(b.content) || String(b.content ?? ""))
        });
      }
    }
    if (!result || typeof result !== "object") {
      for (const id of completedToolIds) {
        finishClaudeTool(state, id, false);
      }
      return;
    }
    const resultAt = stamp(o.timestamp);
    const previousResultAt = state.lastResultAt;
    const previousCallAt = state.lastResultCallAt;
    const call = state.calls.get(toolUseIdOf(o.message)) ?? null;
    state.lastResultAt = Math.max(state.lastResultAt, resultAt);
    state.lastResultCallAt = call === null ? resultAt : call.at;
    cur.endedAt = Math.max(cur.endedAt, resultAt);
    if (typeof result.stdout === "string") {
      const from = call === null ? 0 : previousCallAt < call.at ? Math.max(call.at, previousResultAt) : call.at;
      recordCommits(
        cur,
        result.stdout,
        resultAt,
        call,
        opts.folders ?? [],
        null,
        call === null ? null : { from, failed }
      );
    }
    if (Object.prototype.hasOwnProperty.call(result, "bashEditDiff")) {
      recordBashEdit(cur, result);
    }
    if (Object.prototype.hasOwnProperty.call(result, "structuredPatch")) {
      recordEdit(cur, result);
    } else if (result.totalToolUseCount != null) {
      const row = {
        id: result.agentId ? String(result.agentId) : null,
        description: String(result.description || result.agentType || "agent"),
        agentType: result.agentType ? String(result.agentType) : null,
        model: result.resolvedModel ? String(result.resolvedModel) : null,
        effort: null,
        spend: [],
        spendFound: false,
        spendPartial: false,
        durationMs: typeof result.totalDurationMs === "number" ? result.totalDurationMs : null,
        tokens: typeof result.totalTokens === "number" ? result.totalTokens : null,
        toolUses: typeof result.totalToolUseCount === "number" ? result.totalToolUseCount : null,
        status: String(result.status || "completed")
      };
      const existing = state.launched.get(toolUseIdOf(o.message));
      if (existing) {
        Object.assign(existing, row);
        delete existing.toolUsesFromArtifacts;
      } else {
        cur.agents.push(row);
      }
    } else {
      const existing = state.launched.get(toolUseIdOf(o.message));
      if (existing && typeof result.agentId === "string" && result.agentId) {
        existing.id = result.agentId;
      }
    }
    const terminalAgent = result.totalToolUseCount != null && String(result.status || "completed") !== "running";
    for (const id of completedToolIds) {
      finishClaudeTool(state, id, terminalAgent);
    }
    return;
  }
  cur.endedAt = Math.max(cur.endedAt, stamp(o.timestamp));
  const message = o.message || {};
  if (failedATurn(o)) {
    cur.error = textOf(message.content).trim() || "The request failed.";
    return;
  }
  if (message.model === "<synthetic>") {
    return;
  }
  if (answeredATurn(o)) {
    cur.error = null;
  }
  if (message.model) {
    cur.model = message.model;
    state.currentModelSource = { start: sourceStart, end: sourceEnd };
  }
  if (typeof o.effort === "string" && o.effort) {
    cur.effort = o.effort;
  }
  if (message.stop_reason) {
    cur.finished = finishedATurn(o);
  }
  const usageEvent = reduceClaudeUsageRecord(
    state.usageState,
    o,
    opts.childTranscript ? { countSidechain: true, emitRepeats: true } : {}
  );
  if (usageEvent) {
    const usage = usageEvent.usage;
    cur.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite1h + usage.cacheWrite5m;
    const wrote = message.usage ? claudeCacheLifetime(message.usage) : null;
    if (wrote) {
      state.lastLifetime = wrote;
    }
    cur.contextRequest = {
      at: stamp(o.timestamp),
      lifetime: wrote ?? state.lastLifetime,
      inferenceClass: usageEvent.inferenceClass,
      serviceTier: usageEvent.serviceTier,
      readBack: usage.cacheRead > 0,
      outputTokens: usage.output
    };
    const turnStart = cur[SOURCE_START] ?? sourceStart;
    state.lastContext = cur.contextTokens;
    state.lastContextRequest = cur.contextRequest;
    state.lastContextCache = {
      read: usage.cacheRead,
      write: usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0)
    };
    state.lastContextSource = { start: Math.min(turnStart, sourceStart), end: sourceEnd };
    state.lastModel = cur.model;
    state.lastModelSource = cur.model && state.currentModelSource ? {
      start: Math.min(turnStart, state.currentModelSource.start),
      end: Math.max(sourceEnd, state.currentModelSource.end)
    } : null;
    const events = opts.childTranscript ? replaceClaudeUsageEvent(state.usageState, usageEvent) : [usageEvent];
    for (const event of events) {
      addUsage(cur.usage, event.usage);
      addTurnUsagePart(cur, event);
    }
  }
  const replyId = typeof message.id === "string" && message.id ? message.id : null;
  if (state.repeatReplyId !== null && replyId !== state.repeatReplyId) {
    setClaudeRepeatNotice(state, false);
  }
  let closedReply = false;
  const content = message.content;
  if (Array.isArray(content)) {
    settleClaudeSteps(state);
    let answeredLine = false;
    const narrationBase = message.stop_reason === "tool_use" ? message.id || (typeof o.uuid === "string" && o.uuid ? o.uuid : `at-${stamp(o.timestamp)}`) : "";
    let textOrdinal = narrationBase ? state.narrationOrdinals.get(narrationBase) ?? 0 : 0;
    for (const block of content) {
      if (block.type === "tool_use") {
        const loadedSkill = block.name === "Skill" && typeof block.input?.skill === "string" ? block.input.skill.trim() : "";
        cur.toolUses++;
        if (block.name !== "Skill") {
          cur.toolCounts[TOOL_KIND[block.name || ""] ?? "other"]++;
        }
        if (block.name) {
          tallyToolName(cur.toolTally, block.name);
        }
        if (block.id && block.name) {
          state.toolNames.delete(block.id);
          state.toolNames.set(block.id, block.name);
        }
        if (block.id && block.name === "Bash" && typeof block.input?.command === "string" && launchesClaudeSession(block.input.command)) {
          (cur.dispatchToolUseIds ??= []).push(block.id);
        }
        if (block.name) {
          const input2 = block.input ?? {};
          const description = block.name === "Bash" && typeof input2.description === "string" && input2.description.trim() ? input2.description.trim() : "";
          const presented = presentedStepDetail(block.name, input2);
          const step = {
            ordinal: ++cur.stepCount,
            name: block.name,
            ...block.id ? { sourceId: block.id } : {},
            ...description ? { headline: description } : {},
            detail: presented.detail,
            at: stamp(o.timestamp),
            // Until a result comes back, which for the call the agent is on now never
            // happens while the panel is reading.
            status: "running"
          };
          if (presented.fullDetail !== void 0) {
            Object.defineProperty(step, "fullDetail", { value: presented.fullDetail });
          }
          if (block.id) {
            Object.defineProperty(step, "id", { value: block.id });
          }
          if (block.id) {
            state.stepById.delete(block.id);
            state.stepById.set(block.id, step);
            state.toolOwnerById.delete(block.id);
            state.toolOwnerById.set(block.id, cur);
          }
          state.awaited.push(step);
          cur.stepKinds.push(block.name === "Skill" ? SKILL_STEP_KIND : TOOL_KIND[block.name] ?? "other");
          cur.steps.push(step);
          if (cur.steps.length > TURN_STEP_LIMIT) {
            cur.steps.shift();
          }
          if (loadedSkill && block.id) {
            recordClaudeSkillUse(state, cur, block.id, loadedSkill, stamp(o.timestamp));
          }
        }
        if (block.id && typeof block.input?.command === "string") {
          const cwd = typeof o.cwd === "string" && o.cwd ? o.cwd : null;
          state.calls.delete(block.id);
          state.calls.set(block.id, { id: block.id, command: block.input.command, cwd, at: stamp(o.timestamp) });
          if (commitDirs(block.input.command, cwd).length > 0 || mergeDirs(block.input.command, cwd).length > 0) {
            state.wrote.add(block.id);
          } else if (opts.childTranscript === true && ranGit(block.input.command)) {
            state.wrote.add(block.id);
          }
        }
        if (block.id && block.name && opts.childTranscript === true) {
          const pending = pendingFileEdit(block.name, block.input ?? {});
          if (pending) {
            state.editCalls.delete(block.id);
            state.editCalls.set(block.id, pending);
            state.wrote.add(block.id);
          }
        }
        if (block.name === "Agent" && block.id) {
          const row = {
            id: null,
            description: String(block.input?.description || "agent"),
            agentType: block.input?.subagent_type ? String(block.input.subagent_type) : null,
            model: block.input?.model ? String(block.input.model) : null,
            effort: null,
            spend: [],
            spendFound: false,
            spendPartial: false,
            durationMs: null,
            tokens: null,
            toolUses: null,
            status: "running"
          };
          if (block.id) {
            Object.defineProperty(row, "toolUseId", { value: block.id });
          }
          state.launched.set(block.id, row);
          cur.agents.push(row);
        }
        if (block.name === "SubagentHandback" && typeof block.input?.message === "string" && block.input.message.trim()) {
          const report = block.input.message;
          cur.answers.push({ text: report, at: stamp(o.timestamp), stepsBefore: cur.stepCount });
          cur.summary = report;
          state.handedBack = true;
        }
      } else if (block.type === "text") {
        const text = String(block.text ?? "");
        if (!text.trim()) {
          continue;
        }
        const ordinal = textOrdinal++;
        if (message.stop_reason === "tool_use") {
          const sourceId = `${narrationBase}:text:${ordinal}`;
          if (!cur.updates.some((update) => update.sourceId === sourceId)) {
            cur.updates.push({
              sourceId,
              kind: "commentary",
              text,
              at: stamp(o.timestamp),
              status: "done",
              stepsBefore: cur.stepCount
            });
          }
          continue;
        }
        const closes = Boolean(message.stop_reason);
        const notResponse = closes ? claudeNotResponse(state, cur, text) : null;
        if (!notResponse) {
          cur.summary = text;
        }
        if (closes) {
          const answer = { text, at: stamp(o.timestamp), stepsBefore: cur.stepCount };
          if (notResponse) {
            answer.notResponse = notResponse;
          }
          const keepsLast = notResponse && !cur.answers[cur.answers.length - 1]?.notResponse;
          if (answeredLine && !keepsLast) {
            cur.answers[cur.answers.length - 1] = answer;
          } else {
            cur.answers.push(answer);
          }
          answeredLine = true;
          closedReply = true;
          if (notResponse) {
            cur.summary = claudeResponseText(cur);
          }
        }
      }
    }
    if (narrationBase) {
      state.narrationOrdinals.set(narrationBase, textOrdinal);
    }
  } else if (typeof content === "string" && content.trim()) {
    if (message.stop_reason === "tool_use") {
      const base = message.id || (typeof o.uuid === "string" && o.uuid ? o.uuid : `at-${stamp(o.timestamp)}`);
      const ordinal = state.narrationOrdinals.get(base) ?? 0;
      const sourceId = `${base}:text:${ordinal}`;
      if (!cur.updates.some((update) => update.sourceId === sourceId)) {
        cur.updates.push({
          sourceId,
          kind: "commentary",
          text: content,
          at: stamp(o.timestamp),
          status: "done",
          stepsBefore: cur.stepCount
        });
      }
      state.narrationOrdinals.set(base, ordinal + 1);
    } else {
      const notResponse = message.stop_reason ? claudeNotResponse(state, cur, content) : null;
      if (!notResponse) {
        cur.summary = content;
      }
      if (message.stop_reason && message.stop_reason !== "tool_use") {
        const answer = { text: content, at: stamp(o.timestamp), stepsBefore: cur.stepCount };
        if (notResponse) {
          answer.notResponse = notResponse;
        }
        cur.answers.push(answer);
        closedReply = true;
        if (notResponse) {
          cur.summary = claudeResponseText(cur);
        }
      }
    }
  }
  if (message.stop_reason === "tool_use" || Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_use")) {
    setClaudeRepeatNotice(state, false);
    state.workedSinceReply = true;
  }
  boundClaudeToolAssociations(state);
  if (closedReply) {
    for (const from of state.handbacks.keys()) {
      state.handbacks.set(from, true);
    }
    state.workedSinceReply = false;
    if (state.repeatNotice && replyId !== null) {
      state.repeatReplyId = replyId;
    } else {
      setClaudeRepeatNotice(state, false);
    }
  }
  if (message.stop_reason && message.stop_reason !== "tool_use") {
    settleClaudeSteps(state);
    pruneClaudeTurnAssociations(state);
  }
}
function setClaudeRepeatNotice(state, repeat) {
  state.repeatNotice = repeat;
  state.repeatReplyId = null;
}
function applyClaudePeerMessage(state, origin) {
  const peer = origin;
  if (peer && typeof peer === "object" && peer.kind === "coordinator") {
    state.handedBack = false;
    return;
  }
  if (!peer || typeof peer !== "object" || peer.kind !== "peer") {
    return;
  }
  if (peer.handback === true && typeof peer.from === "string" && peer.from) {
    state.handbacks.set(peer.from, false);
  }
  setClaudeRepeatNotice(state, false);
  state.handedBack = false;
}
function claudeNotResponse(state, cur, text) {
  if (state.handedBack) {
    return "after-handback";
  }
  if (state.repeatNotice && cur.answers.some((answer) => !answer.notResponse)) {
    return "repeat-notice";
  }
  if (text.trim() === "No response requested.") {
    return "no-response-requested";
  }
  return null;
}
function claudeResponseText(cur) {
  for (let index = cur.answers.length - 1; index >= 0; index--) {
    if (!cur.answers[index].notResponse) {
      return cur.answers[index].text;
    }
  }
  return "";
}
function setRecordedTitle(state, source, record) {
  state.title = record.title;
  state.fullTitle = record.fullTitle;
  state.titleSource = source;
  state.titleAt = record.at;
  state.titleRecord = {
    title: record.title,
    fullTitle: record.fullTitle,
    start: record.start,
    end: record.end,
    source
  };
}
function stampSessionTitle(turn, state) {
  turn.sessionTitle = state.title;
  turn.sessionFullTitle = state.fullTitle;
  if (state.titleSource) {
    turn.sessionTitleSource = state.titleSource;
  } else {
    delete turn.sessionTitleSource;
  }
  if (state.titleSource && typeof state.titleAt === "number") {
    turn.sessionTitleAt = state.titleAt;
  } else {
    delete turn.sessionTitleAt;
  }
}
function claudeSessionLineMayAffectRead(line) {
  if (line.length < 20) {
    return false;
  }
  if (line.indexOf('"compactMetadata"') >= 0 || line.indexOf('"ai-title"') >= 0 || line.indexOf('"custom-title"') >= 0 || line.indexOf('"queued_command"') >= 0 || line.indexOf(MODEL_ATTACHMENT_MARK) >= 0 || line.indexOf('"type":"cost-state"') >= 0) {
    return true;
  }
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  const isUser = !isAssistant && line.indexOf('"type":"user"') >= 0;
  return (isAssistant || isUser) && !skipsOrdinaryToolResult(line, isUser);
}
function finishClaudeSession(state, opts, readBytes) {
  const maxTurns = opts.maxTurns ?? 40;
  closeClaudeTurn(state, maxTurns);
  if (state.pending.held) {
    emitClaudeTurn(state, state.pending.held, maxTurns);
    state.pending.held = null;
  }
  for (const turn of state.turns) {
    stampSessionTitle(turn, state);
  }
  refreshClaudeAgentFacts(state.turns, opts.agentSpendOf, opts.agentSessionTargetOf);
  attachCompactMetadata(state.compactions, state.compactMeta);
  return {
    turns: state.turns,
    compactions: state.compactions,
    readBytes,
    turnLimitReached: state.turnLimitReached
  };
}
function materializeClaudeSession(source, opts, readBytes) {
  return finishClaudeSession(cloneParserState(source), opts, readBytes);
}
function claudeHiddenSlots(state) {
  return { turns: state.turns, open: state.cur, pending: state.pending.held };
}
function claudeSnapshot(state) {
  const copy = cloneParserState(state);
  copy.hidden = hiddenParserState(claudeHiddenSlots(copy), CLAUDE_HIDDEN_POLICY);
  return copy;
}
function createClaudeSessionReducer(sessionId, opts = {}, restored) {
  const state = restored ? cloneParserState(restored) : emptyClaudeSessionParserState(opts);
  if (state.version !== 6) {
    throw new Error("Incompatible Claude parser state");
  }
  applyHiddenParserState(claudeHiddenSlots(state), state.hidden, CLAUDE_HIDDEN_POLICY);
  delete state.hidden;
  state.compactionMetadataRanges ??= state.compactions.map(() => null);
  state.compactionValueSources ??= state.compactions.map(() => ({ context: null, model: null }));
  state.lastContextSource ??= null;
  state.lastModelSource ??= null;
  state.currentModelSource ??= null;
  state.pendingTypedSkill ??= null;
  state.handbacks ??= /* @__PURE__ */ new Map();
  state.handedBack ??= false;
  state.repeatNotice ??= false;
  state.repeatReplyId ??= null;
  state.workedSinceReply ??= false;
  return {
    pushLine: (line) => reduceClaudeSessionLine(state, line, sessionId, opts),
    trimBefore: (offset) => trimClaudeBefore(state, offset, opts.maxTurns ?? 40),
    snapshot: () => claudeSnapshot(state),
    read: (readBytes = 0) => materializeClaudeSession(state, opts, readBytes),
    finish: (readBytes = 0) => finishClaudeSession(state, opts, readBytes),
    completedTurns: () => {
      const completed = cloneParserState(state);
      if (completed.cur && (completed.cur.finished || completed.cur.interrupted || completed.cur.error !== null || completed.cur.processEndedAt !== void 0)) {
        closeClaudeTurn(completed, opts.maxTurns ?? 40);
      }
      for (const turn of completed.turns) {
        stampSessionTitle(turn, completed);
      }
      refreshClaudeAgentFacts(completed.turns, opts.agentSpendOf, opts.agentSessionTargetOf);
      return completed.turns.map((turn, index) => ({
        turn,
        start: completed.turnRanges[index]?.start ?? 0,
        end: completed.turnRanges[index]?.end ?? 0
      }));
    },
    completedCompactions: () => {
      const completed = cloneParserState(state);
      attachCompactMetadata(completed.compactions, completed.compactMeta);
      return completed.compactions.map((compaction, index) => ({
        compaction,
        start: completed.compactionRanges[index]?.start ?? 0,
        end: completed.compactionRanges[index]?.end ?? 0
      }));
    },
    openRange: () => {
      const open = state.cur;
      if (!open || open.finished || open.interrupted || open.error !== null || open.processEndedAt !== void 0) {
        return null;
      }
      return { start: open[SOURCE_START] ?? 0, end: open[SOURCE_END] ?? 0 };
    }
  };
}
function refreshClaudeAgentFacts(turns, lookup, targetOf) {
  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (!agent.id) {
        continue;
      }
      const ref = {
        id: agent.id,
        name: agent.description,
        path: null,
        status: agent.status,
        toolUseId: agent.toolUseId
      };
      const target = agent.toolUseId ? targetOf?.(ref) ?? null : null;
      if (target) {
        agent.childSessionId = target;
      } else {
        delete agent.childSessionId;
      }
      if (!lookup) {
        continue;
      }
      const spend = lookup(ref);
      agent.spend = spend.models;
      if (!agent.effort) {
        agent.effort = spend.effort;
      }
      agent.spendFound = spend.found;
      agent.spendPartial = spend.partial;
      if (spend.commits?.length) {
        agent.commits = spend.commits.map((commit) => ({ ...commit }));
      } else {
        delete agent.commits;
      }
      if (spend.commitIntents?.length) {
        agent.commitIntents = spend.commitIntents.map((intent) => ({ ...intent }));
      } else {
        delete agent.commitIntents;
      }
      if (spend.artifacts) {
        agent.artifacts = cloneChildArtifacts(spend.artifacts);
      } else {
        delete agent.artifacts;
      }
      if ((agent.toolUses === null || agent.toolUsesFromArtifacts) && !agentIsRunning(agent)) {
        agent.toolUses = childToolCalls(agent.artifacts);
        agent.toolUsesFromArtifacts = true;
      }
      if (spend.usageIncomplete) {
        agent.spendIncomplete = true;
      } else {
        delete agent.spendIncomplete;
      }
    }
  }
}
function readSessionLines(lines, sessionId, opts, readBytes, offset) {
  const reducer = createClaudeSessionReducer(sessionId, opts);
  let start = offset ?? 0;
  for (const line of lines) {
    if (offset === void 0) {
      reducer.pushLine(line);
      continue;
    }
    const end = start + Buffer.byteLength(line);
    reducer.pushLine({ text: line, start, end });
    start = end + 1;
  }
  return reducer.finish(readBytes);
}
const COMPACT_META_WINDOW_MS = 1e4;
function attachCompactMetadata(compactions, meta) {
  for (const m of meta) {
    let best = null;
    let bestGap = COMPACT_META_WINDOW_MS;
    for (const c of compactions) {
      const gap = Math.abs(c.at - m.at);
      if (gap <= bestGap) {
        best = c;
        bestGap = gap;
      }
    }
    if (!best) {
      continue;
    }
    applyCompactMetadata(best, m.data);
  }
}
function applyCompactMetadata(compaction, data) {
  compaction.trigger = data.trigger || compaction.trigger;
  compaction.contextBefore = data.preTokens || compaction.contextBefore;
  compaction.contextAfter = data.postTokens || compaction.contextAfter;
  compaction.durationMs = data.durationMs || compaction.durationMs;
  compaction.droppedTokens = data.cumulativeDroppedTokens || compaction.droppedTokens;
}
function countLines(text) {
  if (!text) {
    return 0;
  }
  return text.replace(/\r?\n$/, "").split("\n").length;
}
function patchMarkersAreValid(hunks) {
  let oldEnded = false;
  let newEnded = false;
  for (const hunk of hunks) {
    for (let index = 0; index < hunk.lines.length; index++) {
      const line = hunk.lines[index];
      if (line === "\\ No newline at end of file") {
        const prefix = hunk.lines[index - 1]?.[0];
        const marksOld = prefix === " " || prefix === "-";
        const marksNew = prefix === " " || prefix === "+";
        if (!marksOld && !marksNew || marksOld && oldEnded || marksNew && newEnded) {
          return false;
        }
        oldEnded ||= marksOld;
        newEnded ||= marksNew;
        continue;
      }
      if ((line.startsWith(" ") || line.startsWith("-")) && oldEnded) {
        return false;
      }
      if ((line.startsWith(" ") || line.startsWith("+")) && newEnded) {
        return false;
      }
    }
  }
  return true;
}
function patchHunks(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const hunks = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const hunk = candidate;
    const coordinates = [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines];
    if (!coordinates.every(
      (coordinate) => typeof coordinate === "number" && Number.isSafeInteger(coordinate) && coordinate >= 0
    )) {
      return null;
    }
    if (!Array.isArray(hunk.lines) || !hunk.lines.every(
      (line) => typeof line === "string" && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "\\ No newline at end of file")
    )) {
      return null;
    }
    const oldStart = hunk.oldStart;
    const oldLines = hunk.oldLines;
    const newStart = hunk.newStart;
    const newLines = hunk.newLines;
    if (oldLines === 0 && newLines === 0) {
      return null;
    }
    if (oldLines > 0 && oldStart === 0 || newLines > 0 && newStart === 0) {
      return null;
    }
    let seenOld = 0;
    let seenNew = 0;
    for (const line of hunk.lines) {
      if (line.startsWith(" ") || line.startsWith("-")) {
        seenOld++;
      }
      if (line.startsWith(" ") || line.startsWith("+")) {
        seenNew++;
      }
    }
    if (seenOld !== oldLines || seenNew !== newLines) {
      return null;
    }
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: [...hunk.lines]
    });
  }
  return patchMarkersAreValid(hunks) ? hunks : null;
}
function editLines(text) {
  return text ? text.replace(/\r?\n$/, "").split("\n") : [];
}
function editedLineCounts(oldText, newText) {
  const before = editLines(oldText);
  const after = editLines(newText);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head++;
  }
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    tail++;
  }
  return { added: after.length - head - tail, removed: before.length - head - tail };
}
function editInputPath(value) {
  if (typeof value !== "string" || !value || isEphemeralPath(value)) {
    return null;
  }
  return value;
}
function editInputText(value) {
  if (value === void 0 || value === null) {
    return "";
  }
  return typeof value === "string" ? value : null;
}
function uncountedFileEdit(path2, unknownReason) {
  return { path: path2, added: 0, removed: 0, countsUnknown: true, unknownReason };
}
function countedFileEdit(path2, added, removed) {
  return added === 0 && removed === 0 ? uncountedFileEdit(path2, "zero") : { path: path2, added, removed, countsUnknown: false };
}
function pendingFileEdit(name, input) {
  if (name === "Edit") {
    const target = editInputPath(input.file_path);
    if (target === null) {
      return null;
    }
    const before = editInputText(input.old_string);
    const after = editInputText(input.new_string);
    if (before === null || after === null) {
      return null;
    }
    if (input.replace_all === true) {
      return uncountedFileEdit(target, "replaceAll");
    }
    const counts = editedLineCounts(before, after);
    return countedFileEdit(target, counts.added, counts.removed);
  }
  if (name === "Write") {
    const target = editInputPath(input.file_path);
    if (target === null || editInputText(input.content) === null) {
      return null;
    }
    return uncountedFileEdit(target, "write");
  }
  if (name === "NotebookEdit") {
    const target = editInputPath(input.notebook_path);
    if (target === null) {
      return null;
    }
    const source = editInputText(input.new_source);
    if (source === null) {
      return null;
    }
    return String(input.edit_mode || "replace") === "insert" ? countedFileEdit(target, countLines(source), 0) : uncountedFileEdit(target, "notebook");
  }
  return null;
}
function recordEditFromCall(turn, edit) {
  const key = normalizeFsPath(edit.path);
  const entry = turn.files.get(key) || { path: edit.path, added: 0, removed: 0, isNew: false, edits: [] };
  if (edit.countsUnknown) {
    entry.countsUnknown = true;
    if (edit.unknownReason) {
      entry.unknownReason = edit.unknownReason;
    }
  }
  entry.added += edit.added;
  entry.removed += edit.removed;
  turn.files.set(key, entry);
}
function recordCallAndTextEvidence(state, turn, toolId, content, at, folders) {
  const edit = state.editCalls.get(toolId);
  if (edit) {
    state.editCalls.delete(toolId);
    recordEditFromCall(turn, edit);
    return;
  }
  const call = state.calls.get(toolId) ?? null;
  if (call === null) {
    return;
  }
  recordCommits(turn, textOf(content), at, call, folders, null, null);
}
function recordEdit(turn, result) {
  const filePath = String(result.filePath || "");
  if (!filePath || isEphemeralPath(filePath)) {
    return;
  }
  let added = 0;
  let removed = 0;
  const parsedHunks = patchHunks(result.structuredPatch);
  const hunks = parsedHunks ?? [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        added++;
      } else if (line.startsWith("-")) {
        removed++;
      }
    }
  }
  const created = result.type === "create";
  if (created) {
    added = countLines(String(result.content || ""));
  }
  const key = normalizeFsPath(filePath);
  const entry = turn.files.get(key) || { path: filePath, added: 0, removed: 0, isNew: false, edits: [] };
  delete entry.countsUnknown;
  delete entry.unknownReason;
  entry.added += added;
  entry.removed += removed;
  if (created) {
    entry.isNew = true;
  }
  const first = entry.edits.length === 0;
  entry.edits.push({
    hunks,
    originalFile: first && typeof result.originalFile === "string" ? result.originalFile : null,
    content: typeof result.content === "string" ? result.content : null,
    isCreate: created,
    ...parsedHunks === null ? { patchInvalid: true } : {}
  });
  turn.files.set(key, entry);
}
function recordBashEdit(turn, result) {
  const diff = result.bashEditDiff;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
    return;
  }
  const record = diff;
  const named = /* @__PURE__ */ new Set();
  const files = Array.isArray(record.files) ? record.files : [];
  for (const candidate of files) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const file = candidate;
    const filePath = String(file.filePath || "");
    if (!filePath || isEphemeralPath(filePath)) {
      continue;
    }
    named.add(normalizeFsPath(filePath));
    let added = 0;
    let removed = 0;
    const parsedHunks = patchHunks(file.hunks);
    const hunks = parsedHunks ?? [];
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          added++;
        } else if (line.startsWith("-")) {
          removed++;
        }
      }
    }
    const created = hunks.length === 1 && hunks[0].oldStart === 0 && hunks[0].oldLines === 0;
    const key = normalizeFsPath(filePath);
    const entry = turn.files.get(key) || { path: filePath, added: 0, removed: 0, isNew: false, edits: [] };
    delete entry.countsUnknown;
    delete entry.unknownReason;
    entry.added += added;
    entry.removed += removed;
    if (created) {
      entry.isNew = true;
    }
    entry.edits.push({
      hunks,
      originalFile: null,
      content: null,
      isCreate: created,
      ...parsedHunks === null ? { patchInvalid: true } : {}
    });
    turn.files.set(key, entry);
  }
  const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles : [];
  for (const candidate of changedFiles) {
    if (typeof candidate !== "string" || !candidate) {
      continue;
    }
    const key = normalizeFsPath(candidate);
    if (named.has(key) || isEphemeralPath(candidate)) {
      continue;
    }
    const existing = turn.files.get(key);
    if (existing && existing.edits.length > 0) {
      continue;
    }
    turn.files.set(
      key,
      existing ?? {
        path: candidate,
        added: 0,
        removed: 0,
        isNew: false,
        edits: [],
        countsUnknown: true,
        unknownReason: "shell"
      }
    );
  }
}
function agentIsRunning(agent) {
  return agent.status === "running" || agent.status === "async_launched";
}
const TRANSCRIPT_WAKE_MS = 200;
function watchDirs(files) {
  const dirs = /* @__PURE__ */ new Set();
  for (const one of files) {
    const dir = path.dirname(one.file);
    if (dir && dir !== ".") {
      dirs.add(dir);
    }
  }
  return [...dirs].sort();
}
export {
  CACHE_LIFETIMES,
  COMPACT_META_WINDOW_MS,
  CUSTOM_TITLE_SIDECAR_BYTES,
  ClaudeChildSessionCache,
  HEAD_KEY_BYTES,
  HEX_SHA,
  MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
  MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT,
  NARRATION_DETAIL_LIMIT,
  SESSION_HEAD_BYTES,
  SKILL_STEP_KIND,
  STEP_CUT,
  STEP_DETAIL_LIMIT,
  TOOL_KIND,
  TRANSCRIPT_WAKE_MS,
  TURN_ASK_LIMIT,
  TURN_SKILL_USE_LIMIT,
  TURN_START_BYTES,
  TURN_START_MAX_BYTES,
  TURN_STEP_LIMIT,
  activityIn,
  addTurnSkillUse,
  addTurnUsagePart,
  agentIsRunning,
  agentRunIn,
  agentRunOfScan,
  agentSpendDependencyKey,
  childSpendVersion,
  claudeAgentSpendVersion,
  claudeCacheLifetime,
  claudeChildReferenceFor,
  claudeChildSessionFiles,
  claudeFirstRequestCacheRead,
  claudeProcessEndedAt,
  claudeSessionLineMayAffectRead,
  claudeSubagentMetaReader,
  claudeUsage,
  cleanPrompt,
  closingRows,
  commitDirOf,
  commitDirs,
  commitPlaceOf,
  commitStatusIsReadable,
  compactSummaryChars,
  countLines,
  createClaudeSessionReducer,
  createClaudeUsageLineReducer,
  customTitleOf,
  describeToolInput2 as describeToolInput,
  discoverBackwardBoundary,
  discoverClaudeChildSessionFiles,
  discoverClaudeChildSessions,
  discoverClaudeNewestTurn,
  emptyClaudeUsageReducerState,
  failedATurn,
  finishedATurn,
  firstLine,
  headLines,
  headlineMarkdownOf,
  headlineOf,
  holdsHumanPrompt,
  interruptedATurn,
  isCacheLifetime,
  isClaudeSubagentReference,
  isEphemeralPath,
  isInside,
  isReaderQueued,
  linkTarget,
  linkTargetIsHtml,
  linkTargetIsMarkdown,
  listSessionFiles,
  mergeDirOf,
  mergeDirs,
  mergeStatusIsReadable,
  nativePath,
  normalizeFsPath,
  normalizeFullSessionTitle,
  normalizeSessionTitle,
  openingLines,
  parseStatLine,
  patchMarkersAreValid,
  plainTitle,
  presentedStepDetail,
  projectSlug,
  projectsRoot,
  ranGit,
  readClaudeAgentSpend,
  readClaudeChildSessionReferences,
  readClaudeSubagentMetas,
  readCustomTitleSidecar,
  readPreviousLines,
  readSession,
  readSessionActivity,
  readSessionCwd,
  readSessionMeta,
  readSessionRecordedTitlePair,
  readSessionTurnStarts,
  readTurnStartsFromTail,
  readTurns,
  recordCommits,
  reduceClaudeUsageLine,
  reduceClaudeUsageRecord,
  refreshClaudeAgentFacts,
  relativePath,
  resolveClaudeDispatchReferences,
  resolveLink,
  responseAnswerIndex,
  retainNewestCompaction,
  revalidatedCatalog,
  revalidatedCatalogPaths,
  sameCommitSha,
  sameSessionRevision,
  scanClaudeChildSessionReferences,
  scanForAgentRun,
  scanForHumanPrompt,
  scanForPerson,
  sessionFilesFor,
  sessionOutcomeOf,
  sessionStatFactsOf,
  setTurnStepStatus,
  shortenTo2 as shortenTo,
  stepDetail,
  stripCompactPreamble,
  tailLines,
  tailOf,
  tallyToolName,
  taskNotificationText,
  transcriptDirsFor,
  trustedListedRevisions,
  watchDirs,
  withClaudeFirstRequest
};
