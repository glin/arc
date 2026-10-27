import { test, vi } from 'vitest';
import { agentRunAnswer } from './turnrail';
import { enumerateClaudeChildSources, enumerateSessionFiles, enumerateSessionFilesFor } from './transcript';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EXPORT_LIMITS, ExportLimitError } from './exportlimits.ts';
import {
  scanClaudeRelationshipQuantum,
  replacedCatalogFiles,
  scanClaudeChildSessionReferences,
  type ClaudeRelationshipCursor,
} from './transcript';

test('Claude export relationship framing admits large records and rejects oversized fragments', async () => {
  const file = writeTranscript([
    { type: 'ignored', payload: 'x'.repeat(5 * 1024 * 1024) },
    assistantTool('Agent', 1, 'capture-launch', {}),
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'capture-launch' }] },
      toolUseResult: { agentId: 'child-capture' },
    },
  ]);
  const parent = { file, sessionId: 'parent' };
  let scan = await scanClaudeRelationshipQuantum(parent, undefined, 256 * 1024, undefined, undefined, EXPORT_LIMITS);
  while (!scan.complete)
    scan = await scanClaudeRelationshipQuantum(parent, scan.cursor, 256 * 1024, undefined, undefined, EXPORT_LIMITS);
  assert.deepEqual(
    scan.references.map((reference) => reference.sessionId),
    ['child-capture'],
  );
  await assert.rejects(
    scanClaudeRelationshipQuantum(parent, undefined, Infinity, undefined, undefined, {
      ...EXPORT_LIMITS,
      recordBytes: 1024,
    }),
    (error) => error instanceof ExportLimitError && error.boundary === 'record',
  );
});

test('Claude export refuses relationship overflow instead of reporting a shortened graph', async () => {
  const file = writeTranscript(
    Array.from({ length: 3 }, (_item, index) => [
      assistantTool('Agent', index + 1, `capture-${index}`, {}),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `capture-${index}` }] },
        toolUseResult: { agentId: `child-${index}` },
      },
    ]).flat(),
  );
  await assert.rejects(
    scanClaudeRelationshipQuantum({ file, sessionId: 'parent' }, undefined, Infinity, undefined, undefined, {
      ...EXPORT_LIMITS,
      relationships: 2,
    }),
    (error) => error instanceof ExportLimitError && error.boundary === 'relationships',
  );
});

test.each([65536, 1024 * 1024])(
  'Claude interior rewrite plus growth resumes to the fresh relationships at %i bytes, and keeps a rewrite before the anchor until a same-size change',
  async (budget) => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const file = writeTranscript([
      { type: 'ignored', payload: 'x'.repeat(1024) },
      assistantTool('Agent', 1, 'interior-launch', {}),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'interior-launch' }] },
        toolUseResult: { agentId: 'child-a' },
      },
      ...Array.from({ length: 100 }, () => ({ type: 'ignored', payload: 'y'.repeat(1024) })),
    ]);
    const parent = { file, sessionId: 'parent' };
    const first = await scanClaudeRelationshipQuantum(parent, undefined, budget);
    assert.deepEqual(
      first.references.map((reference) => reference.sessionId),
      ['child-a'],
    );
    const old = fs.readFileSync(file, 'utf8');
    assert.ok(old.indexOf('child-a') > 256 && old.indexOf('child-a') < first.cursor.offset - 4096);
    const finish = async (cursor: ClaudeRelationshipCursor) => {
      let scan = await scanClaudeRelationshipQuantum(parent, cursor, budget);
      let reset = scan.reset;
      for (let pass = 0; !scan.complete && pass < 100; pass++) {
        scan = await scanClaudeRelationshipQuantum(parent, JSON.parse(JSON.stringify(scan.cursor)), budget);
        reset ||= scan.reset;
      }
      return { scan, reset };
    };
    fs.writeFileSync(file, old.replace('child-a', 'child-b') + '{"type":"ignored"}\n');
    fs.utimesSync(file, new Date(0), new Date(first.cursor.revision.mtimeMs + 2000));
    // A quantum too small for the anchor read leaves the anchor for the next quantum.
    const short = await scanClaudeRelationshipQuantum(parent, first.cursor, 16384 + 1024);
    assert.equal(short.reset, false);
    assert.equal(short.cursor.evidence?.validation, undefined, 'a short anchor read started a whole-prefix comparison');
    // The rewrite lies before the final block, so growth keeps the accepted relationships.
    const grown = await finish(JSON.parse(JSON.stringify(short.cursor)));
    assert.ok(grown.scan.complete);
    assert.equal(grown.reset, false);
    assert.deepEqual(
      grown.scan.references.map((reference) => reference.sessionId),
      ['child-a'],
    );
    // A same-size change compares the whole prefix, finds the rewrite, and rescans.
    fs.utimesSync(file, new Date(0), new Date(grown.scan.cursor.revision.mtimeMs + 2000));
    const comparing = await scanClaudeRelationshipQuantum(parent, grown.scan.cursor, 32768);
    assert.equal(comparing.reset, false);
    assert.ok(comparing.cursor.evidence?.validation, 'the same-size comparison finished in one quantum');
    // Growth during the comparison restarts it over the whole prefix, so the rewrite still resets.
    fs.appendFileSync(file, '{"type":"ignored"}\n');
    const resumed = await finish(JSON.parse(JSON.stringify(comparing.cursor)));
    assert.ok(resumed.scan.complete);
    assert.equal(resumed.reset, true);
    assert.deepEqual(
      resumed.scan.references.map((reference) => reference.sessionId),
      ['child-b'],
    );
    assert.deepEqual(resumed.scan.references, scanClaudeChildSessionReferences(parent).references);
  },
);

test('Claude scans, rewrite comparisons and terminal continuations read forward when every slice starts past its deadline', async () => {
  // Each reading of the clock lands a full slice after the previous one, so every deadline has passed.
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1_000));
  const file = writeTranscript([
    { type: 'ignored', payload: 'x'.repeat(1024) },
    assistantTool('Agent', 1, 'interior-launch', {}),
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'interior-launch' }] },
      toolUseResult: { agentId: 'child-a' },
    },
    ...Array.from({ length: 20 }, () => ({ type: 'ignored', payload: 'y'.repeat(1024) })),
  ]);
  const parent = { file, sessionId: 'parent' };
  const finish = async (cursor: Awaited<ReturnType<typeof scanClaudeRelationshipQuantum>>['cursor'] | undefined) => {
    let scan = await scanClaudeRelationshipQuantum(parent, cursor, 65536);
    for (let pass = 0; !scan.complete && pass < 100; pass++)
      scan = await scanClaudeRelationshipQuantum(parent, JSON.parse(JSON.stringify(scan.cursor)), 65536);
    return scan;
  };
  const first = await finish(undefined);
  assert.ok(first.complete, 'the first scan finished');
  assert.deepEqual(
    first.references.map((reference) => reference.sessionId),
    ['child-a'],
  );
  const old = fs.readFileSync(file, 'utf8');
  // The rewrite ends without a newline, so the rescan applies its last record as a terminal record.
  fs.writeFileSync(file, old.replace('child-a', 'child-b') + '{"type":"ignored"}');
  fs.utimesSync(file, new Date(0), new Date(first.cursor.revision.mtimeMs + 2000));
  const grown = await finish(first.cursor);
  assert.ok(grown.complete, 'the grown parent finished its anchor check and read');
  // A same-size change makes the scan compare the whole prefix and find the rewrite.
  fs.utimesSync(file, new Date(0), new Date(grown.cursor.revision.mtimeMs + 2000));
  const resumed = await finish(grown.cursor);
  assert.ok(resumed.complete, 'the rewritten parent finished its comparison and rescan');
  assert.equal(resumed.cursor.terminalApplied, true);
  assert.deepEqual(resumed.references, scanClaudeChildSessionReferences(parent).references);
  fs.appendFileSync(file, '\n' + JSON.stringify(assistantTool('Agent', 2, 'late-launch', {})) + '\n');
  const continued = await finish(resumed.cursor);
  assert.ok(continued.complete, 'the scan read the records after the terminal record');
  assert.deepEqual(continued.references, scanClaudeChildSessionReferences(parent).references);
});

test('Claude same-size validation retains parsing position and growth replaces the superseded comparison', async () => {
  const file = writeTranscript(Array.from({ length: 300 }, () => ({ type: 'ignored', payload: 'x'.repeat(1024) })));
  const parent = { file, sessionId: 'parent' };
  let scan = await scanClaudeRelationshipQuantum(parent, undefined, 65536);
  const offset = scan.cursor.offset;
  // A same-size change makes validation compare the whole prefix.
  const accepted = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(0), new Date(accepted + 2000));
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor, 32768);
  assert.equal(scan.reset, false);
  assert.equal(scan.complete, false);
  assert.equal(scan.cursor.offset, offset);
  assert.ok(scan.cursor.evidence?.validation?.digest.offset);
  const candidate = scan.cursor.evidence.validation.stamp;
  // Growth replaces the pending comparison with a new whole-prefix comparison.
  fs.appendFileSync(file, '{"type":"ignored"}\n');
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor, 32768);
  assert.equal(scan.cursor.offset, offset);
  assert.notDeepEqual(scan.cursor.evidence?.validation?.stamp, candidate);
  assert.ok(scan.cursor.evidence!.validation.digest.offset <= 16384);
  for (let pass = 0; !scan.complete && pass < 100; pass++) {
    const before = scan.cursor.offset;
    scan = await scanClaudeRelationshipQuantum(parent, scan.cursor, 65536);
    assert.equal(scan.reset, false);
    assert.ok(scan.cursor.offset >= before);
  }
  assert.equal(scan.complete, true);
  assert.equal(scan.cursor.offset, fs.statSync(file).size);
});

// Relationship scans retain child ownership across record boundaries, restarts, and detectable source changes.
test('Claude relationship quanta retain launches receipts and oversized records across restart', async () => {
  const records = [
    assistantTool('Agent', 1, 'far-launch', { description: 'nested' }),
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}',
      'receipt-launch',
    ).slice(0, 1),
    { type: 'ignored', payload: '\u00e9'.repeat(550000) },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'far-launch' }] },
      toolUseResult: { agentId: 'nested-child' },
    },
    {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content:
          '<task-notification><task-id>notice-child</task-id><tool-use-id>far-launch</tool-use-id><status>completed</status></task-notification>',
      },
    },
    ...claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch',
      'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"aaaaaaaa"}',
      'receipt-launch',
    ).slice(1),
  ];
  const file = writeTranscript(records);
  const parent = { file, sessionId: 'parent', childTranscript: true };
  let cursor: ClaudeRelationshipCursor | undefined;
  let result;
  for (let pass = 0; pass < 60; pass++) {
    const before = cursor?.offset ?? 0;
    result = await scanClaudeRelationshipQuantum(parent, cursor, 65536);
    assert.ok(result.readBytes <= 65536);
    assert.ok(result.cursor.offset > before, 'an acknowledged quantum made no progress');
    cursor = JSON.parse(JSON.stringify(result.cursor));
    if (result.complete) break;
  }
  assert.ok(result?.complete);
  assert.deepEqual(result.references, scanClaudeChildSessionReferences(parent).references);
  assert.deepEqual(
    result.references.map((reference) => reference.sessionId),
    ['nested-child', 'notice-child', 'aaaaaaaa'],
  );
});

test('Claude relationship appends retain partial records and apply terminal JSON once', async () => {
  const file = writeTranscript([assistantTool('Agent', 1, 'launch', {})]);
  const parent = { file, sessionId: 'parent' };
  const first = await scanClaudeRelationshipQuantum(parent, undefined);
  const terminal = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
    toolUseResult: { agentId: 'child' },
  });
  fs.appendFileSync(file, terminal.slice(0, -2));
  const fragment = await scanClaudeRelationshipQuantum(parent, first.cursor);
  assert.equal(fragment.complete, false);
  assert.deepEqual(fragment.references, []);
  fs.appendFileSync(file, terminal.slice(-2));
  const completed = await scanClaudeRelationshipQuantum(parent, fragment.cursor);
  assert.equal(completed.cursor.terminalApplied, true);
  assert.equal(completed.references.length, 1);
  fs.appendFileSync(file, '\n');
  const newline = await scanClaudeRelationshipQuantum(parent, completed.cursor);
  assert.equal(newline.complete, true);
  assert.equal(newline.references[0].toolUseIds.length, 1);
  assert.deepEqual(newline.references, scanClaudeChildSessionReferences(parent).references);
});

test('Claude relationship cursors rebuild equal-size edits truncation replacement and changed anchors', async () => {
  const file = writeTranscript([
    assistantTool('Agent', 1, 'launch', {}),
    { type: 'ignored', payload: 'x'.repeat(10000) },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
      toolUseResult: { agentId: 'child-a' },
    },
  ]);
  const parent = { file, sessionId: 'parent' };
  let scan = await scanClaudeRelationshipQuantum(parent, undefined);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('child-a', 'child-b'));
  const clock = new Date(scan.cursor.revision.mtimeMs + 1000);
  fs.utimesSync(file, clock, clock);
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.reset, true);
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.references[0].sessionId, 'child-b');
  fs.writeFileSync(file, original.replace('child-a', 'child-c') + '{"type":"ignored"}\n');
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.reset, true);
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.references[0].sessionId, 'child-c');
  fs.renameSync(file, file + '.previous');
  fs.writeFileSync(file, original);
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.reset, true);
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.references[0].sessionId, 'child-a');
  fs.writeFileSync(file, '{}\n');
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.equal(scan.reset, true);
  scan = await scanClaudeRelationshipQuantum(parent, scan.cursor);
  assert.deepEqual(scan.references, []);
});
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { tempDir } from './temproot.ts';
import {
  AgentSpendCache,
  OPEN_SPEND_BAND_MS,
  OPEN_SPEND_BYTES_PER_MS,
  readChildSpend,
  spendTokens,
} from './agentspend.ts';
import { estimateCost, quoteUsage } from './pricing.ts';
import { renderInlineMarkdown } from './richtext.ts';
import { SESSION_LINK_RESPONSE } from './turnfixtures.ts';
import type { BackwardRangeReader, TurnCommit, TurnUsage } from './transcript.ts';
import {
  projectsRoot,
  readTurns,
  readSession,
  agentSpendDependencyKey,
  childSpendVersion,
  claudeAgentSpendVersion,
  readClaudeAgentSpend,
  commitDirs,
  inspectCommitCommand,
  commitStatusIsReadable,
  commitPlaceOf,
  ranGit,
  recordCommits,
  responseAnswerIndex,
  folderMatcher,
  isInside,
  stripCompactPreamble,
  countLines,
  headlineMarkdownOf,
  headlineOf,
  cleanPrompt,
  projectSlug,
  transcriptDirsFor,
  sessionFilesFor,
  listSessionFiles,
  normalizeFsPath,
  relativePath,
  nativePath,
  isEphemeralPath,
  readSessionCwd,
  readSessionActivity,
  readSessionMeta,
  sessionOutcomeOf,
  sessionStatFactsOf,
  ClaudeBackgroundWork,
  shortenTo,
  plainTitle,
  normalizeSessionTitle,
  normalizeFullSessionTitle,
  openingLines,
  closingRows,
  linkTarget,
  linkTargetIsHtml,
  linkTargetIsMarkdown,
  linkTargetIsVideo,
  resolveLink,
  linkCandidates,
  holdsHumanPrompt,
  promptScanLists,
  scanForHumanPrompt,
  scanForAgentRun,
  scanForPerson,
  agentRunOfScan,
  agentRunIn,
  readSessionTurnStarts,
  TURN_START_BYTES,
  TURN_START_MAX_BYTES,
  watchDirs,
  TRANSCRIPT_WATCH_LIMIT,
  TRANSCRIPT_WAKE_MS,
  TURN_STEP_LIMIT,
  STEP_DETAIL_LIMIT,
  STEP_CUT,
  TURN_ASK_LIMIT,
  isReaderQueued,
  describeToolInput,
  stepDetail,
  sameSessionRevision,
  revalidatedCatalog,
  revalidatedCatalogPaths,
  trustedListedRevisions,
  claudeUsage,
  claudeCacheLifetime,
  claudeProcessEndedAt,
  claudeSessionLineMayAffectRead,
  claudeRetainedLine,
  emptyClaudeUsageReducerState,
  reduceClaudeUsageRecord,
  reduceClaudeUsageLine,
  createClaudeUsageLineReducer,
  createClaudeSessionReducer,
  discoverBackwardBoundary,
  discoverClaudeNewestTurn,
  tailOf,
  readClaudeChildSessionReferences,
  claudeLaunchKind,
  MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT,
  claudeChildSessionFiles,
  discoverClaudeChildSessionFiles,
  discoverClaudeChildSessions,
  resolveClaudeDispatchReferences,
  ClaudeChildSessionCache,
  isClaudeSubagentReference,
  readCustomTitleSidecar,
  CUSTOM_TITLE_SIDECAR_BYTES,
} from './transcript.ts';
import { RETAINED_REQUESTS } from './parserstate.ts';
import { closeReadWindow, openReadWindow } from './readmeter.ts';
import { SessionNames } from './sessionnames.ts';
import {
  loadDerivedCache,
  MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
  saveDerivedCache,
  type DerivedTitleEntry,
} from './derivedcache.ts';
import type { TurnOutcome } from './transcript.ts';
import {
  PER_PASS_ITERATIONS,
  ADVISOR_EXECUTOR,
  ADVISOR_ITERATIONS,
  ADVISOR_MODEL,
  advisorIteration,
  advisorProbeRecords,
  advisorResponseRecords,
  bgAwaySummaryTranscript,
  claudeCompactionTranscript,
  claudeSubagentResult,
  COMPACTION_SAMPLES,
  bgSessionTranscript,
  bgWorkerFollowUpTranscript,
  claudeDispatchTranscript,
  powershellDispatchCommand,
  powershellDispatchExecution,
  resumedSdkTranscript,
  sdkFileChangeTranscript,
  sdkSlashCommandTranscript,
  throughStructuredClone,
} from './turnfixtures.ts';
import { nextTurnBasisOf, sessionStats, statusOf, toCard, turnCacheExpiryReturn, TURN_QUIET_MS } from './turncard.ts';
import type { CacheExpiryReturn } from './projectspend.ts';
import { newCounts, newestTurnStarts } from './turnread.ts';
import {
  childWriteKey,
  claudeChildWriteIndex,
  liveOpenChildren,
  openChildCounts,
  outcomeWithWiderChildren,
  writeTimeOfVersion,
} from './turnrail.ts';
import { searchableSummary } from './turnsearch.ts';
import { BACKGROUND_COMMAND_CAP_MS, liveBackgroundCommands, sessionRunningSince, sessionStatusOf } from './turnrail.ts';
import { resumeCommand } from './domain/resume.ts';
import type { ClaudeHistoryCursor } from './claudehistory.ts';
import { readClaudeHistoryPage, readClaudeHistoryPageAsync, readClaudeSessionIncremental } from './claudehistory.ts';
import { readForwardSession, readSemanticHistoryPage, readSemanticHistoryPageAsync } from './history.ts';

// A high surrogate without a following low surrogate indicates a character split during truncation.

const HALF_A_CHARACTER = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const ms = (n: number) => Date.parse(at(n));

test('a growing session is a new revision even when its timestamp stays fixed', () => {
  const cached = { mtimeMs: 1_700_000_000_000, size: 128 };
  assert.equal(
    sameSessionRevision(cached, { mtimeMs: 1_700_000_000_000, size: 256 }),
    false,
    'title and activity must be reread after a constant-mtime rollout grows',
  );
  assert.equal(sameSessionRevision(cached, { mtimeMs: 1_700_000_000_000, size: 128 }), true);
});

function userPrompt(text: string, second = 0, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    promptId: `p${++seq}`,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  };
}
function assistantText(text: string, second: number, usage?: Record<string, number>, effort?: string, stop?: string) {
  return {
    type: 'assistant',
    timestamp: at(second),
    effort,
    message: {
      role: 'assistant',
      id: `m${++seq}`,
      model: 'claude-opus-5',
      stop_reason: stop,
      content: [{ type: 'text', text }],
      usage,
    },
  };
}
// A closing answer carries a stop_reason other than tool_use.

function assistantAnswer(text: string, second: number, stop = 'end_turn') {
  return assistantText(text, second, undefined, undefined, stop);
}
function assistantTool(name: string, second: number, id = 'tu1', input: Record<string, unknown> = {}, effort?: string) {
  return {
    type: 'assistant',
    timestamp: at(second),
    effort,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] },
  };
}
function editResult(filePath: string, second: number, added: number, removed: number) {
  const lines = [...Array(added).fill('+new'), ...Array(removed).fill('-old')];
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    toolUseResult: {
      filePath,
      structuredPatch: [{ oldStart: 1, oldLines: removed, newStart: 1, newLines: added, lines }],
    },
  };
}
// This child tool result acknowledges a call without output or patch data.

function toolResult(id: string, second: number) {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  };
}
function commitResult(stdout: string, second: number, id = 't1') {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult: { gitOperation: 'commit', stdout, stderr: '' },
  };
}
// Bash file changes include hunks for up to five files and all paths in changedFiles.

function bashEditResult(second: number, diff: Record<string, unknown>, id = 'b1') {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult: { stdout: '', stderr: '', bashEditDiff: diff },
  };
}

function costState(startTime: number, totalDuration: number, modelUsage?: Record<string, Record<string, number>>) {
  return { type: 'cost-state', startTime, totalDuration, ...(modelUsage ? { sessionId: 's', modelUsage } : {}) };
}

test('Claude process end timing accepts only a safe terminal record', () => {
  assert.equal(claudeProcessEndedAt(costState(1_000, 250)), 1_250);
  assert.equal(claudeProcessEndedAt({ ...costState(1_000, 250), type: 'system' }), null);
  assert.equal(claudeProcessEndedAt(costState(-1, 250)), null);
  assert.equal(claudeProcessEndedAt(costState(1_000, Number.POSITIVE_INFINITY)), null);
  assert.equal(claudeProcessEndedAt(costState(Number.MAX_SAFE_INTEGER, 1)), null);
});

// Queued attachments carry prompts or notifications into a running turn.

function queued(attachment: Record<string, unknown>, second: number) {
  return {
    type: 'attachment',
    timestamp: at(second),
    attachment: { type: 'queued_command', timestamp: at(second), ...attachment },
  };
}
function typedMidTurn(text: string, second: number) {
  return queued({ commandMode: 'prompt', origin: { kind: 'human' }, prompt: [{ type: 'text', text }] }, second);
}

function writeTranscript(lines: object[]): string {
  const dir = tempDir('tl-');
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

// A turn longer than the response-id cap still knows the response that opened it, so the
// cache-expiry return that opened it still matches, also after a parser restore.
test('a Claude turn keeps its opening response past the response-id cap', () => {
  const steps = Array.from({ length: 600 }, (_, index) =>
    assistantText(`step ${index}`, 1, { input_tokens: 10, output_tokens: 5 }, undefined, 'tool_use'),
  );
  const records = [userPrompt('long run', 0), ...steps];
  const opening = steps[0].message.id;
  const turn = readSession(writeTranscript(records), 'sess').turns[0];
  assert.ok(!turn.responseIds?.includes(opening), 'the cap drops the opening id from the bounded list');
  const opened = { requestKey: `claude:${opening}`, request: { agent: 'claude' } } as CacheExpiryReturn;
  assert.equal(turnCacheExpiryReturn(turn, [opened]), opened);
  const first = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 3)) first.pushLine(JSON.stringify(record));
  const resumed = createClaudeSessionReducer('sess', {}, first.snapshot());
  for (const record of records.slice(3)) resumed.pushLine(JSON.stringify(record));
  assert.equal(turnCacheExpiryReturn(resumed.read().turns[0], [opened]), opened);
});

// The turn that held a compaction between two of its responses names it under "Included above",
// and its total holds the same estimate.
test('a Claude turn that compacts between two responses names the compaction in its cost', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 150_000, output_tokens: 2_000 };
  const before = [userPrompt('refactor', 0), assistantText('reading', 1, usage, undefined, 'tool_use')];
  const compaction = [
    {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at(2),
      compactMetadata: { trigger: 'auto', preTokens: 152_010, postTokens: 9_000 },
    },
    { ...userPrompt('summary', 3), isCompactSummary: true, message: { role: 'user', content: 'summary' } },
  ];
  const after = [assistantText('done', 4, { ...usage, cache_read_input_tokens: 9_000 }, undefined, 'end_turn')];
  const read = readSession(writeTranscript([...before, ...compaction, ...after]), 'sess');
  assert.equal(read.turns.length, 1);
  assert.equal(read.compactions.length, 1);
  const cost = (turn: (typeof read.turns)[number]) =>
    toCard(turn, false, Date.parse(at(60))).chips.find((chip) => chip.metric === 'cost')!.detailList!;
  const list = cost(read.turns[0]);
  const row = list.entries.find((entry) => entry.label === '1 compaction');
  assert.match(String(row?.value), /^\$\d+\.\d\d$/);
  const plainRead = readSession(writeTranscript([...before, ...after]), 'sess');
  const plainTurn = plainRead.turns[0];
  const plain = cost(plainTurn);
  // The tokens figure, its request count, its cached-input share and the session's latest-turn
  // cached reads hold recorded usage only.
  const tokens = (turn: (typeof read.turns)[number]) =>
    toCard(turn, false, Date.parse(at(60))).chips.find((chip) => chip.metric === 'tokens');
  assert.deepEqual(tokens(read.turns[0]), tokens(plainTurn));
  const reread = (session: typeof read) =>
    sessionStats(session.turns, session.compactions)
      .find((chip) => chip.metric === 'context')
      ?.detail?.match(/Latest turn cached input reads: [^\n]*/)?.[0];
  assert.ok(reread(plainRead));
  assert.equal(reread(read), reread(plainRead));
  const dollars = (value: unknown) => Number(String(value).replace(/[$+]/g, ''));
  assert.ok(
    Math.abs(dollars(list.heading!.value) - dollars(plain.heading!.value) - dollars(row?.value)) <= 0.011,
    'the total holds the dollars the row names',
  );
  // A compaction after the turn's last response stays outside the turn.
  const trailing = readSession(writeTranscript([...before, ...compaction]), 'sess').turns[0];
  assert.ok(!cost(trailing).entries.some((entry) => entry.label === '1 compaction'));
});

test('Claude turns retain main response identities for exact observed-speed publication', () => {
  const first = assistantText('first', 1, { output_tokens: 84 }, undefined, 'tool_use');
  const second = assistantText('second', 2, { output_tokens: 168 }, undefined, 'end_turn');
  const child = { ...assistantText('child', 2, { output_tokens: 999 }), isSidechain: true };
  const read = readSession(writeTranscript([userPrompt('work'), first, first, child, second]), 'sess');
  assert.deepEqual(read.turns[0].responseIds, [first.message.id, second.message.id]);
});

// The CLI writes a request record before each request, and each content block of the response names it.
function requestRecord(id: string, second: number, type = 'api-request') {
  return {
    type,
    sessionId: 'sess',
    id,
    timestamp: at(second),
    version: '2.1.302',
    querySource: 'repl_main_thread',
    params: { model: 'claude-opus-5', messages: [{ role: 'assistant', content: '"type":"assistant"' }] },
  };
}
function requestBlock(
  id: string,
  requestRef: string,
  second: number,
  output: number,
  stop = 'end_turn',
  model = 'claude-opus-5',
) {
  return {
    type: 'assistant',
    requestRef,
    timestamp: at(second),
    message: {
      role: 'assistant',
      id,
      model,
      stop_reason: stop,
      content: [{ type: 'text', text: `block ${second}` }],
      usage: { input_tokens: 10, output_tokens: output },
    },
  };
}
const outputLines = (turn: Parameters<typeof toCard>[0]) =>
  toCard(turn, false, ms(120))
    .chips.find((chip) => chip.metric === 'tokens')
    ?.detailList?.entries.find((entry) => entry.label === 'Output')?.lines ?? [];
const REQUEST_TITLE =
  '100.0 tok/s. Output tokens per second. Actual output includes thinking. Request time includes the wait for the first response event. Untimed responses are excluded.';

test('a Claude turn from a terminal transcript shows output speed from its request record', () => {
  const read = readSession(
    writeTranscript([
      userPrompt('work'),
      requestRecord('req-1', 10),
      requestBlock('m-timed', 'req-1', 13, 400),
      requestBlock('m-timed', 'req-1', 14, 400),
    ]),
    'sess',
  );
  const turn = read.turns[0];
  assert.deepEqual(turn.outputRate, { output: 400, milliseconds: 4000 });
  assert.equal(turn.outputRateModel, 'claude-opus-5');
  assert.equal(turn.outputRateBasis, 'request');
  assert.deepEqual(outputLines(turn)[0], { text: '100.0 tok/s', title: REQUEST_TITLE });
});

test('Claude request timing sums only stopped responses of the turn model that join a request record', () => {
  const read = readSession(
    writeTranscript([
      userPrompt('work'),
      requestBlock('m-unjoined', 'req-missing', 5, 100, 'tool_use'),
      requestRecord('req-other', 6, 'api-request-blob'),
      requestRecord('req-other', 6, 'api-request-shape'),
      requestBlock('m-other', 'req-other', 8, 50, 'tool_use'),
      requestRecord('req-sonnet', 10),
      requestBlock('m-sonnet', 'req-sonnet', 12, 70, 'tool_use', 'claude-sonnet-5'),
      requestRecord('req-first-send', 20),
      requestRecord('req-second-send', 21),
      requestBlock('m-unstopped', 'req-second-send', 22, 30, ''),
      requestBlock('m-timed', 'req-second-send', 23, 400, 'tool_use'),
      requestBlock('m-timed', 'req-second-send', 25, 400, 'end_turn'),
    ]),
    'sess',
  );
  assert.deepEqual(read.turns[0].outputRate, { output: 400, milliseconds: 4000 });

  const untimed = readSession(
    writeTranscript([userPrompt('work'), requestBlock('m-unjoined', 'req-missing', 5, 100)]),
    'sess',
  ).turns[0];
  assert.equal(untimed.outputRate, undefined);
  assert.equal(untimed.outputRateBasis, undefined);
  assert.doesNotMatch(JSON.stringify(outputLines(untimed)), /tok\/s/);

  const interrupted = readSession(
    writeTranscript([
      userPrompt('work'),
      requestRecord('req-1', 10),
      requestBlock('m-timed', 'req-1', 13, 400, 'tool_use'),
      userPrompt('[Request interrupted by user]', 14),
    ]),
    'sess',
  ).turns[0];
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.outputRate, undefined);
});

test('the Claude prompt scan never parses a request record', () => {
  const line = JSON.stringify({ ...requestRecord('req-1', 10), prompt: { type: 'user', text: 'x'.repeat(4096) } });
  assert.equal(claudeSessionLineMayAffectRead(line), true, 'filtered reads drop request records');
  const parse = vi.spyOn(JSON, 'parse');
  try {
    holdsHumanPrompt(line);
    assert.ok(!parse.mock.calls.some(([text]) => text === line), 'the prompt scan parsed a request body');
  } finally {
    parse.mockRestore();
  }
});

test('a Claude assistant record whose tool input holds a request marker keeps its usage and activity', () => {
  const record = {
    type: 'assistant',
    requestRef: 'req-1',
    timestamp: at(13),
    message: {
      role: 'assistant',
      id: 'm-tool',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_request',
          name: 'Write',
          input: { type: 'api-request', id: 'req-shaped', timestamp: at(12), file_path: '/p/request.json' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 400 },
    },
  };
  const line = JSON.stringify(record);
  assert.ok(line.indexOf('"type":"api-request",') < 400, 'the marker sits in the head of the line');
  assert.equal(claudeRetainedLine(line), line);
  const turn = readSession(writeTranscript([userPrompt('work'), requestRecord('req-1', 10), record]), 'sess').turns[0];
  assert.equal(turn.usage.output, 400);
  assert.deepEqual(
    turn.steps.map((step) => step.name),
    ['Write'],
  );
  assert.deepEqual(turn.outputRate, { output: 400, milliseconds: 3000 });
});

test('Claude request timing leaves the parser state when its turn is emitted', () => {
  const records = [
    userPrompt('first', 0),
    requestRecord('req-first', 1),
    requestBlock('m-first', 'req-first', 3, 200),
    userPrompt('second', 10),
    requestRecord('req-second', 11),
    requestBlock('m-second', 'req-second', 13, 300),
    requestBlock('m-second', 'req-second', 14, 300),
  ];
  const first = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 5)) first.pushLine(JSON.stringify(record));
  const resumed = createClaudeSessionReducer('sess', {}, first.snapshot());
  for (const record of records.slice(5)) resumed.pushLine(JSON.stringify(record));
  const turns = resumed.read().turns;
  assert.deepEqual(
    turns.map((turn) => turn.outputRate),
    [
      { output: 200, milliseconds: 2000 },
      { output: 300, milliseconds: 3000 },
    ],
  );
  const state = resumed.snapshot();
  assert.deepEqual([...state.requestTimes.keys()], ['req-second']);
  assert.deepEqual([...state.responseTimings.keys()], ['m-second']);
});

test('a Claude turn that model work reopens after a local command keeps the speed of its earlier responses', () => {
  const read = readSession(
    writeTranscript([
      userPrompt('first question', 0),
      requestRecord('req-1', 1),
      requestBlock('m-1', 'req-1', 3, 200),
      ...localCommand('/mcp', '', 4, 'mcp-1', { stdout: 'Reconnected to shotcut.', user: true }),
      requestRecord('req-2', 5),
      requestBlock('m-2', 'req-2', 8, 300),
    ]),
    'sess',
  );
  assert.equal(read.turns.length, 1);
  assert.deepEqual(read.turns[0].outputRate, { output: 500, milliseconds: 5000 });
});

// Haiku 5.5 prices each request in its own prompt-length band, so a turn total must keep both bands.
test('a Haiku 5.5 turn prices each request in its own band', () => {
  const request = (second: number, usage: Record<string, number>, stop?: string) => {
    const record = assistantText(`step ${second}`, second, usage, undefined, stop);
    record.message.model = 'claude-haiku-5-5';
    return record;
  };
  const records = [
    userPrompt('Summarize the logs', 0),
    request(1, { input_tokens: 10_000, cache_read_input_tokens: 40_000, output_tokens: 1_000 }),
    request(2, { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 2_000 }, 'end_turn'),
  ];
  // 50,000 input at the short rates, then 100,001 input at five times them.
  const short = (10_000 * 0.1 + 40_000 * 0.01 + 1_000 * 0.5) / 1_000_000;
  const long = (1 * 0.5 + 100_000 * 0.05 + 2_000 * 2.5) / 1_000_000;
  const near = (cost: number | null, label: string) =>
    assert.ok(cost !== null && Math.abs(cost - (short + long)) < 1e-12, `${label} priced at ${cost}`);
  const file = writeTranscript(records);
  const [turn] = readSession(file, 'sess').turns;
  const partCost = (turn.usageParts ?? []).reduce(
    (total, part) =>
      total +
      (estimateCost(part.usage, part.model, part.provider, part.contextWindow, null, {
        inferenceClass: part.inferenceClass,
        serviceTier: part.serviceTier,
      }) ?? Number.NaN),
    0,
  );
  near(estimateCost(turn.usage, turn.model), 'the turn total');
  near(partCost, 'the request parts');
  const child = readClaudeAgentSpend(file, [], true).models;
  assert.deepEqual(
    child.map((spend) => spend.model),
    ['claude-haiku-5-5'],
  );
  near(estimateCost(child[0].usage, child[0].model), 'the child model total');
});

test('a Claude turn retains usage under each request pricing identity', () => {
  const first = assistantText('one', 1) as Record<string, unknown>;
  first.message = {
    ...(first.message as object),
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      service_tier: 'priority',
      inference_geo: 'global',
    },
  };
  const second = assistantText('two', 2, undefined, undefined, 'end_turn') as Record<string, unknown>;
  second.message = {
    ...(second.message as object),
    usage: {
      input_tokens: 20,
      output_tokens: 3,
      service_tier: 'standard',
      inference_geo: 'in-region',
    },
  };
  const [turn] = readSession(writeTranscript([userPrompt('go'), first, second]), 'sess').turns;
  assert.deepEqual(
    turn.usageParts?.map((part) => ({
      model: part.model,
      provider: part.provider,
      inferenceClass: part.inferenceClass,
      serviceTier: part.serviceTier,
      requests: part.usage.requests,
    })),
    [
      { model: 'claude-opus-5', provider: null, inferenceClass: 'global', serviceTier: 'priority', requests: 1 },
      { model: 'claude-opus-5', provider: null, inferenceClass: 'in-region', serviceTier: 'standard', requests: 1 },
    ],
  );
});

function ignoredClaudeLineOfBytes(bytes: number): string {
  const prefix = '{"type":"progress","payload":"';
  const suffix = '"}\n';
  assert.ok(bytes >= Buffer.byteLength(prefix + suffix));
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function recordingRangeReader(ranges: Array<[number, number]>): BackwardRangeReader {
  return (file, start, length, revision) => {
    ranges.push([start, start + length]);
    const stat = fs.statSync(file);
    if (stat.size !== revision.size || stat.mtimeMs !== revision.mtimeMs) {
      return null;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      return fs.readSync(fd, buffer, 0, length, start) === length ? buffer : null;
    } finally {
      fs.closeSync(fd);
    }
  };
}

test('the Claude session reducer resumes every open tool association', () => {
  const records = [
    userPrompt('run the command', 0),
    assistantTool('Bash', 1, 'call-resume', { command: 'echo first\necho second', description: 'Run both' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-resume', is_error: true, content: 'command failed' }],
      },
    },
    typedMidTurn('also explain it', 3),
    assistantAnswer('The command failed safely.', 4),
  ];
  const all = createClaudeSessionReducer('sess');
  for (const record of records) {
    all.pushLine(JSON.stringify(record));
  }
  const first = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 2)) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createClaudeSessionReducer('sess', {}, first.snapshot());
  for (const record of records.slice(2)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(resumed.read(), all.read());
  const step = resumed.read().turns[0].steps[0];
  assert.equal(Object.getOwnPropertyDescriptor(step, 'id')?.enumerable, false);
  assert.equal((step as { id?: string }).id, 'call-resume');
  assert.equal(Object.getOwnPropertyDescriptor(step, 'fullDetail')?.enumerable, false);
  assert.equal((step as { fullDetail?: string }).fullDetail, 'echo first\necho second');
});

test('the Claude session reducer reads a non-string assistant text block without stopping the transcript', () => {
  const reducer = createClaudeSessionReducer('sess');
  reducer.pushLine(JSON.stringify(userPrompt('read the malformed reply', 0)));
  reducer.pushLine(
    JSON.stringify({
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'malformed-text',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 42 }],
      },
    }),
  );

  const [turn] = reducer.read().turns;
  assert.equal(turn.summary, '42');
  assert.deepEqual(
    turn.answers.map((answer) => answer.text),
    ['42'],
  );
});

test('a late Claude tool rejection after the next prompt updates its retained step and name', () => {
  const before = [
    userPrompt('start the command', 0),
    assistantTool('Bash', 1, 'late-rejection', { command: 'exit 1', description: 'Run command' }),
    assistantAnswer('The command is still pending.', 2),
    userPrompt('continue while it finishes', 3),
  ];
  const after = [
    {
      type: 'user',
      timestamp: at(4),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'late-rejection',
            is_error: true,
            content: 'permission denied',
          },
        ],
      },
    },
    assistantAnswer('Handled the rejection.', 5),
  ];
  const file = writeTranscript(before);
  const initial = readClaudeSessionIncremental(file, 'sess');
  fs.appendFileSync(file, after.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const resumed = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.deepEqual(resumed.read, readSession(file, 'sess'));
  const read = resumed.read!;
  assert.equal(read.turns[0].steps[0].status, 'failed');
  assert.deepEqual(read.turns[1].failures, [{ tool: 'Bash', message: 'permission denied' }]);
});

test('a late Claude result keeps the name of a call beyond the visible step limit', () => {
  const calls = Array.from({ length: TURN_STEP_LIMIT + 1 }, (_value, index) => ({
    type: 'tool_use',
    id: `oversized-call-${index}`,
    name: 'Bash',
    input: { command: `echo ${index}` },
  }));
  const file = writeTranscript([
    userPrompt('run more calls than the card displays', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'oversized-call-message',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: calls,
      },
    },
    userPrompt('continue before the first result', 2),
  ]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.equal(initial.checkpoint?.parserState.stepById.size, TURN_STEP_LIMIT + 1);
  fs.appendFileSync(
    file,
    [
      {
        type: 'user',
        timestamp: at(3),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'oversized-call-0',
              is_error: true,
              content: 'first call failed',
            },
          ],
        },
      },
      assistantAnswer('Handled the first failure.', 4),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const resumed = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.deepEqual(resumed.read, readSession(file, 'sess'));
  assert.equal(resumed.read?.turns[0].steps[0].sourceId, 'oversized-call-1');
  assert.deepEqual(resumed.read?.turns[1].failures, [{ tool: 'Bash', message: 'first call failed' }]);
});

test('one oversized Claude turn keeps a fixed newest association window', () => {
  const associationLimit = TURN_STEP_LIMIT * 4;
  const callCount = associationLimit * 3;
  const reducer = createClaudeSessionReducer('sess');
  reducer.pushLine(JSON.stringify(userPrompt('run an oversized call set', 0)));
  reducer.pushLine(
    JSON.stringify({
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'association-window',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: Array.from({ length: callCount }, (_value, index) => ({
          type: 'tool_use',
          id: `window-call-${index}`,
          name: 'Bash',
          input: { command: `echo ${index}` },
        })),
      },
    }),
  );
  const state = reducer.snapshot();
  assert.deepEqual(
    {
      awaited: state.awaited.length,
      toolNames: state.toolNames.size,
      stepById: state.stepById.size,
      toolOwnerById: state.toolOwnerById.size,
      calls: state.calls.size,
    },
    {
      awaited: associationLimit,
      toolNames: associationLimit,
      stepById: associationLimit,
      toolOwnerById: associationLimit,
      calls: associationLimit,
    },
  );
  assert.equal(state.stepById.has(`window-call-${callCount - associationLimit - 1}`), false);
  assert.equal(state.stepById.has(`window-call-${callCount - associationLimit}`), true);
  assert.deepEqual(
    state.cur?.steps.map((step) => step.sourceId),
    Array.from({ length: TURN_STEP_LIMIT }, (_value, index) => `window-call-${callCount - TURN_STEP_LIMIT + index}`),
  );
});

test('a next prompt leaves an interrupted unresolved Claude tool step running', () => {
  const file = writeTranscript([
    userPrompt('start a long command', 0),
    assistantTool('Bash', 1, 'interrupted-command', { command: 'wait forever' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    },
    userPrompt('do something else', 3),
    assistantAnswer('The other work is done.', 4),
  ]);
  const read = readSession(file, 'sess');
  assert.equal(read.turns[0].interrupted, true);
  assert.equal(read.turns[0].steps[0].status, 'running');
});

test('a legacy string final answer settles an ordinary successful Claude tool call', () => {
  const records = [
    userPrompt('run the legacy command', 0),
    assistantTool('Bash', 1, 'legacy-string-call', { command: 'echo legacy' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'legacy-string-call', content: 'ok' }],
      },
    },
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        role: 'assistant',
        id: 'legacy-string-answer',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: 'legacy command finished',
      },
    },
  ];
  const turn = readSession(writeTranscript(records), 'sess').turns[0];
  assert.equal(turn.summary, 'legacy command finished');
  assert.deepEqual(
    turn.steps.map((step) => [step.name, step.status]),
    [['Bash', 'done']],
  );
});

test('replayed Claude narration message ids continue across retained turns', () => {
  const narration = (text: string, second: number, toolId: string) => ({
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: 'replayed-narration',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo ${toolId}` } },
      ],
    },
  });
  const before = [
    userPrompt('first narrated turn', 0),
    narration('first update', 1, 'narration-one'),
    assistantAnswer('first answer', 2),
    userPrompt('second narrated turn', 3),
    narration('second update', 4, 'narration-two'),
  ];
  const file = writeTranscript(before.slice(0, 4));
  const initial = readClaudeSessionIncremental(file, 'sess');
  fs.appendFileSync(
    file,
    before
      .slice(4)
      .concat(assistantAnswer('second answer', 5))
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const resumed = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.deepEqual(resumed.read, readSession(file, 'sess'));
  const read = resumed.read!;
  assert.deepEqual(
    read.turns.map((turn) => turn.updates.map((update) => update.sourceId)),
    [['replayed-narration:text:0'], ['replayed-narration:text:1']],
  );
});

test('replayed Claude narration after a wake continues within the same semantic turn', () => {
  const narration = (text: string, second: number) => ({
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: 'same-turn-narration',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text }],
    },
  });
  const file = writeTranscript([
    userPrompt('narrate around a wake', 0),
    narration('first update', 1),
    assistantAnswer('Waiting for a peer.', 2),
    {
      type: 'user',
      timestamp: at(3),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<status>running</status>' },
    },
    narration('second update', 4),
    assistantAnswer('Finished after the wake.', 5),
  ]);
  const [turn] = readSession(file, 'sess').turns;
  assert.deepEqual(
    turn.updates.map((update) => [update.sourceId, update.text]),
    [
      ['same-turn-narration:text:0', 'first update'],
      ['same-turn-narration:text:1', 'second update'],
    ],
  );
});

test('unresolved Claude tool associations plateau with retained turns and the open turn', () => {
  const reducer = createClaudeSessionReducer('sess', { maxTurns: 2 });
  for (let index = 0; index < 12; index += 1) {
    reducer.pushLine(JSON.stringify(userPrompt(`association ${index}`, index * 3)));
    reducer.pushLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: at(index * 3 + 1),
        message: {
          role: 'assistant',
          id: `association-message-${index}`,
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: `working ${index}` },
            {
              type: 'tool_use',
              id: `association-tool-${index}`,
              name: 'Bash',
              input: { command: `echo ${index}` },
            },
          ],
        },
      }),
    );
    reducer.pushLine(
      JSON.stringify({
        type: 'user',
        timestamp: at(index * 3 + 2),
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }),
    );
  }
  const state = reducer.snapshot();
  assert.equal(state.turns.length, 2);
  assert.deepEqual(
    {
      toolNames: state.toolNames.size,
      stepById: state.stepById.size,
      toolOwnerById: state.toolOwnerById.size,
      calls: state.calls.size,
      narrationOrdinals: state.narrationOrdinals.size,
    },
    { toolNames: 3, stepById: 3, toolOwnerById: 3, calls: 3, narrationOrdinals: 3 },
  );
});

test('Claude reducer reads stay independent while finish transfers owned state', () => {
  const reducer = createClaudeSessionReducer('sess');
  reducer.pushLine(JSON.stringify(userPrompt('ownership', 0)));
  reducer.pushLine(JSON.stringify(assistantAnswer('original answer', 1)));
  const copied = reducer.read();
  copied.turns[0].summary = 'changed copy';
  assert.equal(reducer.read().turns[0].summary, 'original answer');
  const owned = reducer.finish();
  owned.turns[0].summary = 'changed owned state';
  assert.equal(reducer.finish().turns[0].summary, 'changed owned state');
});

test('the Claude reducer resumes a held prompt into the following turn', () => {
  const records = [userPrompt('held', 0), userPrompt('real prompt', 1), assistantAnswer('done', 2)];
  const reducer = createClaudeSessionReducer('sess');
  reducer.pushLine(JSON.stringify(records[0]));
  const resumed = createClaudeSessionReducer('sess', {}, reducer.snapshot());
  for (const record of records.slice(1)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.equal(resumed.read().turns[0].prompt, 'held\n\nreal prompt');
  const file = writeTranscript(records);
  assert.deepEqual(resumed.read(fs.statSync(file).size), readSession(file, 'sess'));
});

test('the Claude reducer resumes an agent launch into its result', () => {
  const records = [
    userPrompt('delegate', 0),
    assistantTool('Agent', 1, 'agent-call', { description: 'worker', subagent_type: 'general-purpose' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'done' }] },
      toolUseResult: {
        agentId: 'agent-1',
        description: 'worker',
        totalTokens: 9,
        totalToolUseCount: 2,
        status: 'completed',
      },
    },
    assistantAnswer('complete', 3),
  ];
  const reducer = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 2)) {
    reducer.pushLine(JSON.stringify(record));
  }
  const resumed = createClaudeSessionReducer('sess', {}, reducer.snapshot());
  for (const record of records.slice(2)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(
    resumed.read().turns[0].agents.map((agent) => [agent.id, agent.tokens, agent.status]),
    [['agent-1', 9, 'completed']],
  );
});

test('a Claude background child survives a final response and the next prompt until notification', () => {
  const records = [
    userPrompt('launch in background', 0),
    assistantTool('Agent', 1, 'background-call', { description: 'worker', subagent_type: 'general-purpose' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'background-call', content: 'launched' }],
      },
      toolUseResult: {
        agentId: 'background-agent',
        description: 'worker',
        totalTokens: 0,
        totalToolUseCount: 0,
        status: 'running',
      },
    },
    assistantAnswer('It is running in the background.', 3),
    userPrompt('do something else', 4),
    {
      type: 'user',
      timestamp: at(5),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<tool-use-id>background-call</tool-use-id><task-id>background-agent</task-id>' +
          '<status>completed</status><subagent_tokens>37</subagent_tokens>' +
          '<tool_uses>4</tool_uses><duration_ms>900</duration_ms>',
      },
    },
    assistantAnswer('The other work is done.', 6),
  ];
  const reducer = createClaudeSessionReducer('sess', { maxTurns: 2 });
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }
  const read = reducer.read();
  assert.deepEqual(
    read.turns[0].agents.map((agent) => [agent.id, agent.status, agent.tokens, agent.toolUses, agent.durationMs]),
    [['background-agent', 'completed', 37, 4, 900]],
  );
  assert.equal(reducer.snapshot().launched.size, 0);
});

test('a Claude background child row counts up only while its turn runs', () => {
  const records = [
    userPrompt('launch in background', 0),
    assistantTool('Agent', 1, 'row-call', { description: 'worker', subagent_type: 'general-purpose' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'row-call', content: 'launched' }] },
      toolUseResult: { agentId: 'row-agent', description: 'worker', status: 'running' },
    },
    assistantAnswer('It is running in the background.', 3),
  ];
  // While the turn runs, the row counts up from the Agent call.
  const [running] = readSession(writeTranscript(records.slice(0, -1)), 'sess').turns;
  const live = toCard(running, true, ms(2) + 120_000);
  assert.equal(live.status, 'running');
  assert.deepEqual(
    live.agents.map((agent) => [agent.description, agent.state, agent.stateWord, agent.since]),
    [['worker', 'running', 'running', ms(1)]],
  );
  // Arc cannot tell whether the child outlived its session, so a finished or stopped turn draws no time.
  const [turn] = readSession(writeTranscript(records), 'sess').turns;
  const done = toCard(turn, true, ms(3) + 3 * 24 * 60 * 60_000);
  assert.equal(done.status, 'done');
  assert.deepEqual(
    done.agents.map((agent) => [agent.description, agent.state, agent.stateWord, agent.since]),
    [['worker', 'open', 'no ending recorded', null]],
  );
  const stopped = toCard(running, false, ms(2) + 3 * 24 * 60 * 60_000);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(
    stopped.agents.map((agent) => [agent.description, agent.state, agent.stateWord, agent.since]),
    [['worker', 'open', 'no ending recorded', null]],
  );
});

test('a Claude background child expires with its evicted owner and ignores a late notification', () => {
  const reducer = createClaudeSessionReducer('sess', { maxTurns: 2 });
  const owner = [
    userPrompt('launch then age out', 0),
    assistantTool('Agent', 1, 'evicted-background', { description: 'worker', subagent_type: 'general-purpose' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'evicted-background', content: 'launched' }],
      },
      toolUseResult: { agentId: 'evicted-agent', description: 'worker', status: 'running' },
    },
    assistantAnswer('It is running.', 3),
  ];
  const later = [
    userPrompt('middle one', 4),
    assistantAnswer('middle done', 5),
    userPrompt('middle two', 6),
    assistantAnswer('middle two done', 7),
    userPrompt('current work', 8),
  ];
  for (const record of [...owner, ...later]) {
    reducer.pushLine(JSON.stringify(record));
  }
  assert.equal(reducer.snapshot().launched.size, 0);
  reducer.pushLine(
    JSON.stringify({
      type: 'user',
      timestamp: at(9),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<tool-use-id>evicted-background</tool-use-id><task-id>evicted-agent</task-id>' +
          '<status>completed</status><subagent_tokens>99</subagent_tokens>',
      },
    }),
  );
  const read = reducer.read();
  assert.equal(reducer.snapshot().launched.size, 0);
  assert.equal(read.turns.flatMap((turn) => turn.agents).length, 0);
  assert.equal(read.turns.at(-1)?.prompt, 'current work');
});

test('unfinished Claude background children plateau at the retained owner horizon', () => {
  const reducer = createClaudeSessionReducer('sess', { maxTurns: 3 });
  for (let index = 0; index < 20; index += 1) {
    const callId = `plateau-agent-${index}`;
    const records = [
      userPrompt(`plateau prompt ${index}`, index * 4),
      assistantTool('Agent', index * 4 + 1, callId, { description: `worker ${index}` }),
      {
        type: 'user',
        timestamp: at(index * 4 + 2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'launched' }] },
        toolUseResult: { agentId: `plateau-child-${index}`, description: `worker ${index}`, status: 'running' },
      },
      assistantAnswer(`background ${index} is running`, index * 4 + 3),
    ];
    for (const record of records) {
      reducer.pushLine(JSON.stringify(record));
    }
    assert.ok(reducer.snapshot().launched.size <= 4);
  }
  const state = reducer.snapshot();
  assert.equal(state.turns.length, 3);
  assert.equal(state.launched.size, 4);
  assert.equal(new Set(state.launched.values()).size, 4);
});

test('a long Claude checkpoint bounds every retained turn association', () => {
  const records: object[] = [];
  for (let index = 0; index < 20; index += 1) {
    const second = index * 6;
    const bashId = `bounded-bash-${index}`;
    const agentId = `bounded-agent-${index}`;
    records.push(
      userPrompt(`bounded prompt ${index}`, second),
      {
        type: 'assistant',
        timestamp: at(second + 1),
        message: {
          role: 'assistant',
          id: `bounded-message-${index}`,
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: `working ${index}` },
            { type: 'tool_use', id: bashId, name: 'Bash', input: { command: `echo ${index}` } },
            { type: 'tool_use', id: agentId, name: 'Agent', input: { description: `worker-${index}` } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: at(second + 2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: bashId, content: 'ok' }] },
        toolUseResult: { stdout: 'ok' },
      },
      {
        type: 'user',
        timestamp: at(second + 3),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agentId, content: 'done' }] },
        toolUseResult: {
          agentId: `worker-id-${index}`,
          description: `worker-${index}`,
          totalTokens: 9,
          totalToolUseCount: 2,
          status: 'completed',
        },
      },
      assistantAnswer(`answer ${index}`, second + 4),
      {
        type: 'system',
        timestamp: at(second + 5),
        compactMetadata: {
          trigger: 'manual',
          preTokens: 20 + index,
          postTokens: 2,
          durationMs: 4,
        },
      },
      {
        ...userPrompt(`summary ${index}`, second + 5),
        isCompactSummary: true,
        message: { role: 'user', content: `summary ${index}` },
      },
    );
  }
  for (let index = 0; index < 20; index += 1) {
    records.push({
      type: 'system',
      timestamp: at(1000 + index * 20),
      compactMetadata: { trigger: 'manual', preTokens: 100 + index, postTokens: 1 },
    });
  }
  const reducer = createClaudeSessionReducer('sess', { maxTurns: 3 });
  for (const record of records) {
    reducer.pushLine(JSON.stringify(record));
  }
  const state = reducer.snapshot();
  assert.deepEqual(
    {
      turns: state.turns.length,
      turnRanges: state.turnRanges.length,
      turnMembershipStarts: state.turnMembershipStarts.length,
      launched: state.launched.size,
      toolNames: state.toolNames.size,
      stepById: state.stepById.size,
      toolOwnerById: state.toolOwnerById.size,
      narrationOrdinals: state.narrationOrdinals.size,
      awaited: state.awaited.length,
      calls: state.calls.size,
      compactions: state.compactions.length,
      compactionRanges: state.compactionRanges.length,
      compactionMetadataRanges: state.compactionMetadataRanges.length,
      compactionValueSources: state.compactionValueSources.length,
      compactMeta: state.compactMeta.length,
    },
    {
      turns: 3,
      turnRanges: 3,
      turnMembershipStarts: 3,
      launched: 0,
      toolNames: 4,
      stepById: 4,
      toolOwnerById: 4,
      narrationOrdinals: 4,
      awaited: 0,
      calls: 4,
      compactions: 3,
      compactionRanges: 3,
      compactionMetadataRanges: 3,
      compactionValueSources: 3,
      compactMeta: 1,
    },
  );
  const file = writeTranscript(records);
  assert.deepEqual(reducer.read(fs.statSync(file).size), readSession(file, 'sess', { maxTurns: 3 }));
});

test('the Claude reducer resumes usage and compaction metadata together', () => {
  const response = assistantText('first answer', 1, { input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 3 });
  const summary = {
    ...userPrompt('saved summary', 3),
    isCompactSummary: true,
    message: { role: 'user', content: 'saved summary' },
  };
  const records = [
    userPrompt('first', 0),
    response,
    { type: 'system', timestamp: at(2), compactMetadata: { trigger: 'manual', preTokens: 25, postTokens: 4 } },
    summary,
    userPrompt('second', 4),
    assistantAnswer('second answer', 5),
  ];
  const first = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 3)) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createClaudeSessionReducer('sess', {}, first.snapshot());
  for (const record of records.slice(3)) {
    resumed.pushLine(JSON.stringify(record));
  }
  const all = createClaudeSessionReducer('sess');
  for (const record of records) {
    all.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(resumed.read(), all.read());
  assert.deepEqual(
    resumed.read().compactions.map((item) => [item.trigger, item.contextBefore, item.contextAfter]),
    [['manual', 25, 4]],
  );
  assert.equal(resumed.read().turns[0].usage.requests, 1);
});

test('a Claude checkpoint applies an append and equals a one-shot read', () => {
  const firstRecords = [userPrompt('append', 0), assistantTool('Bash', 1, 'append-call', { command: 'echo hi' })];
  const file = writeTranscript(firstRecords);
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.equal(initial.kind, 'reset');
  assert.ok(initial.checkpoint);
  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        type: 'user',
        timestamp: at(2),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'append-call', is_error: true, content: 'bad' }],
        },
      }),
      JSON.stringify(assistantAnswer('recovered', 3)),
      '',
    ].join('\n'),
  );
  const applied = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(applied.kind, 'appended');
  assert.deepEqual(applied.read, readSession(file, 'sess'));
});

test('a Claude checkpoint clears a prior overflow after its source leaves the tail', () => {
  const turn = (index: number) => [
    userPrompt(`overflow ${index}`, index * 2),
    assistantAnswer(`answer ${index}`, index * 2 + 1),
  ];
  const file = writeTranscript([...turn(0), ...turn(1)]);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(4096));
  fs.appendFileSync(file, [...turn(2), ...turn(3)].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const options = { maxTurns: 2, tailBytes: fs.statSync(file).size };
  const initial = readClaudeSessionIncremental(file, 'sess', undefined, options);
  assert.equal(initial.checkpoint?.parserState.turnLimitReached, true);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(2000));
  const resumed = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  const fresh = readSession(file, 'sess', options);
  assert.equal(resumed.kind, 'appended');
  assert.deepEqual(resumed.read, fresh);
  assert.equal(resumed.read?.turnLimitReached, false);
});

test('a prompt submitted into an idle Claude session keeps the newest card across a cloned checkpoint', () => {
  const records: object[] = [];
  for (let index = 1; index <= 12; index += 1) {
    records.push(userPrompt(`prompt ${index}`, index * 2));
    records.push(assistantAnswer(`answer ${index} ${'x'.repeat(600)}`, index * 2 + 1));
  }
  const file = writeTranscript(records);
  // The byte window begins after byte zero, so resumed turns need their original source ranges.

  const options = { tailBytes: 4096 };
  const initial = readClaudeSessionIncremental(file, 'sess', undefined, options);
  assert.equal(initial.read?.turns[initial.read.turns.length - 1].finished, true);
  fs.appendFileSync(file, JSON.stringify(userPrompt('the new message', 100)) + '\n');
  const resumed = readClaudeSessionIncremental(file, 'sess', throughStructuredClone(initial.checkpoint!), options);
  const cold = readSession(file, 'sess', options);
  assert.ok(resumed.checkpoint!.coveredFrom > 0);
  assert.deepEqual(
    resumed.read?.turns.map((turn) => turn.prompt),
    cold.turns.map((turn) => turn.prompt),
  );
  assert.deepEqual(resumed.read, cold);
});

test('a sliding Claude checkpoint retains its final generated title', () => {
  const fullTitle = `Title retained across the window ${'with its complete source '.repeat(4)}`;
  const file = writeTranscript([
    { type: 'ai-title', timestamp: at(0), aiTitle: fullTitle },
    userPrompt('first titled prompt', 1),
    assistantAnswer('first answer', 2),
  ]);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'sess', undefined, options);
  assert.equal(initial.read?.turns[0].sessionTitle, normalizeSessionTitle(fullTitle));
  assert.equal(initial.read?.turns[0].sessionFullTitle, fullTitle.trim());
  const appended = [
    userPrompt(`newer ${'x'.repeat(500)}`, 3),
    assistantAnswer('newer answer', 4),
    userPrompt(`newest ${'y'.repeat(500)}`, 5),
    assistantAnswer('newest answer', 6),
  ];
  fs.appendFileSync(file, appended.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const resumed = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  assert.ok(resumed.checkpoint!.coveredFrom > initial.checkpoint!.parserState.titleRecord!.end);
  assert.equal(resumed.checkpoint?.parserState.title, normalizeSessionTitle(fullTitle));
  assert.equal(resumed.checkpoint?.parserState.fullTitle, fullTitle.trim());
  assert.ok(resumed.read?.turns.every((turn) => turn.sessionTitle === normalizeSessionTitle(fullTitle)));
  assert.ok(resumed.read?.turns.every((turn) => turn.sessionFullTitle === fullTitle.trim()));
});

test('a Claude checkpoint excludes a turn whose prompt starts at the exact tail floor', () => {
  const prefix = { type: 'progress', payload: 'p'.repeat(200) };
  const records = [prefix, userPrompt('exact Claude floor', 1), assistantAnswer('answer above floor', 2)];
  const promptStart = Buffer.byteLength(JSON.stringify(prefix) + '\n');
  const file = writeTranscript(records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'sess', undefined, options);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(promptStart));
  const resumed = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, promptStart);
  assert.deepEqual(resumed.read, readSession(file, 'sess', options));
  assert.deepEqual(resumed.read?.turns, []);
});

test('Claude tail membership follows the actual prompt while pages own an earlier carried prompt', () => {
  const prefix = { type: 'progress', payload: 'p'.repeat(240) };
  const carried = userPrompt('carried prompt outside the later tail', 1);
  const actual = userPrompt('actual prompt inside the later tail', 2);
  const answer = assistantAnswer('answer for the actual prompt', 3);
  const records = [prefix, carried, actual, answer];
  const encoded = records.map((record) => JSON.stringify(record));
  const starts: number[] = [];
  let cursor = 0;
  for (const line of encoded) {
    starts.push(cursor);
    cursor += Buffer.byteLength(`${line}\n`);
  }
  const carriedStart = starts[1];
  const actualStart = starts[2];
  const floors = [
    ...new Set([carriedStart - 1, carriedStart, carriedStart + 1, actualStart - 2, actualStart - 1, actualStart]),
  ];
  for (const floor of floors) {
    const file = writeTranscript(records);
    const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
    const initial = readClaudeSessionIncremental(file, `claude-membership-${floor}`, undefined, options);
    fs.appendFileSync(file, ignoredClaudeLineOfBytes(floor));
    const resumed = readClaudeSessionIncremental(
      file,
      `claude-membership-${floor}`,
      initial.checkpoint ?? undefined,
      options,
    );
    const fresh = readSession(file, `claude-membership-${floor}`, options);
    assert.equal(resumed.checkpoint?.coveredFrom, floor);
    assert.deepEqual(
      resumed.read?.turns.map((turn) => ({
        prompt: turn.prompt,
        laterPrompts: turn.laterPrompts,
        summary: turn.summary,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      })),
      fresh.turns.map((turn) => ({
        prompt: turn.prompt,
        laterPrompts: turn.laterPrompts,
        summary: turn.summary,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      })),
      `turn fields at tail floor ${floor}`,
    );
    assert.deepEqual(resumed.read, fresh, `tail floor ${floor}`);
    if (floor >= carriedStart && floor < actualStart) {
      assert.equal(fresh.turns[0]?.prompt, 'actual prompt inside the later tail');
    }
  }

  const pagedRecords = [userPrompt('older guard', 0), assistantAnswer('older answer', 1), carried, actual, answer];
  const pageFile = writeTranscript(pagedRecords);
  const carriedPageStart = Buffer.byteLength(
    `${JSON.stringify(pagedRecords[0])}\n${JSON.stringify(pagedRecords[1])}\n`,
  );
  const page = readClaudeHistoryPage(pageFile, 'sess', null, {
    chunkBytes: fs.statSync(pageFile).size,
    targetTurns: 1,
  });
  assert.equal(page.kind, 'page');
  assert.equal(page.page?.ownedRange.start, carriedPageStart);
  assert.equal(
    page.page?.turns[0].prompt,
    'carried prompt outside the later tail\n\nactual prompt inside the later tail',
  );
});

test('an active Claude turn rebuilds when its carried prompt leaves the tail', () => {
  const prefix = { type: 'progress', payload: 'p'.repeat(240) };
  const carried = userPrompt('carried active prompt', 1);
  const actual = userPrompt('actual active prompt', 2);
  const records = [prefix, carried, actual];
  const carriedStart = Buffer.byteLength(`${JSON.stringify(prefix)}\n`);
  const actualStart = carriedStart + Buffer.byteLength(`${JSON.stringify(carried)}\n`);
  const floor = carriedStart + 1;
  assert.ok(floor < actualStart);
  const file = writeTranscript(records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'active-carried', undefined, options);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(floor));
  const resumed = readClaudeSessionIncremental(file, 'active-carried', initial.checkpoint ?? undefined, options);
  const fresh = readSession(file, 'active-carried', options);
  assert.equal(resumed.checkpoint?.coveredFrom, floor);
  assert.equal(resumed.kind, 'reset');
  assert.deepEqual(resumed.read, fresh);
  assert.equal(fresh.turns[0]?.prompt, 'actual active prompt');
  assert.equal(fresh.turns[0]?.finished, false);
});

test('an oversized active Claude turn remains resumable after its membership leaves the tail', () => {
  const records = [
    userPrompt('oversized active prompt', 1),
    assistantTool('Bash', 2, 'oversized-active-call', { command: `echo ${'x'.repeat(4_096)}` }),
  ];
  const file = writeTranscript(records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'oversized-active', undefined, options);
  const floor = 128;
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(floor));
  const resumed = readClaudeSessionIncremental(file, 'oversized-active', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, floor);
  assert.equal(resumed.kind, 'appended');
  assert.equal(resumed.read?.turns[0]?.prompt, 'oversized active prompt');
  assert.equal(resumed.read?.turns[0]?.finished, false);
});

test('a Claude checkpoint excludes compaction source facts at the exact tail floor', () => {
  const prefix = { type: 'progress', payload: 'p'.repeat(200) };
  const metadata = {
    type: 'system',
    timestamp: at(1),
    compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 100, durationMs: 25 },
  };
  const summary = {
    ...userPrompt('exact-floor carried summary', 2),
    isCompactSummary: true,
    message: { role: 'user', content: 'exact-floor carried summary' },
  };
  const fixtures = [
    { name: 'metadata', records: [prefix, metadata, summary], floor: Buffer.byteLength(JSON.stringify(prefix) + '\n') },
    {
      name: 'compaction',
      records: [prefix, metadata, summary],
      floor: Buffer.byteLength(JSON.stringify(prefix) + '\n' + JSON.stringify(metadata) + '\n'),
    },
  ];
  for (const fixture of fixtures) {
    const file = writeTranscript(fixture.records);
    const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
    const initial = readClaudeSessionIncremental(file, `sess-${fixture.name}`, undefined, options);
    fs.appendFileSync(file, ignoredClaudeLineOfBytes(fixture.floor));
    const resumed = readClaudeSessionIncremental(
      file,
      `sess-${fixture.name}`,
      initial.checkpoint ?? undefined,
      options,
    );
    assert.equal(resumed.checkpoint?.coveredFrom, fixture.floor, fixture.name);
    assert.deepEqual(resumed.read, readSession(file, `sess-${fixture.name}`, options), fixture.name);
  }
});

function claudeImplicitCompactionFixture(includeCompaction = true) {
  const prefix = { type: 'progress', payload: 'p'.repeat(240) };
  const prompt = userPrompt('implicit Claude compaction source', 1);
  const response = assistantText(
    'answer before compaction',
    2,
    {
      input_tokens: 31,
      cache_read_input_tokens: 400,
      output_tokens: 7,
    },
    undefined,
    'end_turn',
  );
  const summary = {
    ...userPrompt('implicit Claude summary', 3),
    isCompactSummary: true,
    message: { role: 'user', content: 'implicit Claude summary' },
  };
  const records = [prefix, prompt, response, ...(includeCompaction ? [summary] : [])];
  const responseStart = Buffer.byteLength(`${JSON.stringify(prefix)}\n${JSON.stringify(prompt)}\n`);
  return { records, response, responseStart, summary };
}

test('a Claude checkpoint drops implicit compaction values sourced at the exact tail floor', () => {
  const fixture = claudeImplicitCompactionFixture();
  const file = writeTranscript(fixture.records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'implicit-claude-exact', undefined, options);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(fixture.responseStart));
  const resumed = readClaudeSessionIncremental(file, 'implicit-claude-exact', initial.checkpoint ?? undefined, options);
  assert.equal(resumed.checkpoint?.coveredFrom, fixture.responseStart);
  assert.deepEqual(resumed.read, readSession(file, 'implicit-claude-exact', options));
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[0, null]],
  );
});

test('a Claude checkpoint drops implicit compaction values sourced below the tail floor', () => {
  const fixture = claudeImplicitCompactionFixture();
  const floor = fixture.responseStart + 8;
  const file = writeTranscript(fixture.records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'implicit-claude-beyond', undefined, options);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(floor));
  const resumed = readClaudeSessionIncremental(
    file,
    'implicit-claude-beyond',
    initial.checkpoint ?? undefined,
    options,
  );
  assert.equal(resumed.checkpoint?.coveredFrom, floor);
  assert.deepEqual(resumed.read, readSession(file, 'implicit-claude-beyond', options));
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[0, null]],
  );
});

test('a newly appended Claude compaction ignores expired implicit values', () => {
  const fixture = claudeImplicitCompactionFixture(false);
  const floor = fixture.responseStart + 8;
  const file = writeTranscript(fixture.records);
  const options = { tailBytes: fs.statSync(file).size, maxTurns: 3 };
  const initial = readClaudeSessionIncremental(file, 'implicit-claude-appended', undefined, options);
  fs.appendFileSync(file, ignoredClaudeLineOfBytes(floor));
  const trimmed = readClaudeSessionIncremental(
    file,
    'implicit-claude-appended',
    initial.checkpoint ?? undefined,
    options,
  );
  assert.deepEqual([trimmed.checkpoint?.parserState.lastContext, trimmed.checkpoint?.parserState.lastModel], [0, null]);
  fs.appendFileSync(file, `${JSON.stringify(fixture.summary)}\n`);
  const resumed = readClaudeSessionIncremental(
    file,
    'implicit-claude-appended',
    trimmed.checkpoint ?? undefined,
    options,
  );
  assert.deepEqual(resumed.read, readSession(file, 'implicit-claude-appended', options));
  assert.deepEqual(
    resumed.read?.compactions.map((item) => [item.contextBefore, item.model]),
    [[0, null]],
  );
});

test('an unchanged Claude checkpoint reads no transcript bytes', () => {
  const file = writeTranscript([userPrompt('same', 0), assistantAnswer('same', 1)]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.ok(initial.checkpoint);
  assert.equal(initial.read?.readBytes, fs.statSync(file).size);
  const reused = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reused.kind, 'reused');
  assert.equal(reused.readBytes, 0);
  assert.equal(reused.read?.readBytes, fs.statSync(file).size);
  assert.deepEqual(reused.read, initial.read);
});

test('a Claude checkpoint reset is bounded to its configured tail', () => {
  const file = writeTranscript([
    { type: 'progress', payload: 'x'.repeat(32 * 1024) },
    userPrompt('bounded reset', 0),
    assistantAnswer('done', 1),
  ]);
  const tailBytes = 4096;
  const result = readClaudeSessionIncremental(file, 'sess', undefined, { tailBytes });
  assert.equal(result.kind, 'reset');
  assert.ok(result.readBytes <= tailBytes);
  assert.equal(result.read?.readBytes, result.readBytes);
  assert.equal(result.read?.turns[0].prompt, 'bounded reset');
});

test('a Claude checkpoint resets when parser options change', () => {
  const records: object[] = [];
  for (let index = 0; index < 3; index++) {
    records.push(userPrompt(`configured ${index}`, index * 2), assistantAnswer(`answer ${index}`, index * 2 + 1));
  }
  const file = writeTranscript(records);
  const first = readClaudeSessionIncremental(file, 'sess', undefined, { maxTurns: 1 });
  assert.equal(first.read?.turns.length, 1);
  const reset = readClaudeSessionIncremental(file, 'sess', first.checkpoint ?? undefined, { maxTurns: 3 });
  assert.equal(reset.kind, 'reset');
  assert.deepEqual(reset.read, readSession(file, 'sess', { maxTurns: 3 }));
});

test('exact checkpoint reuse performs no transcript range read', () => {
  const file = writeTranscript([userPrompt('reuse without content I/O', 0), assistantAnswer('done', 1)]);
  const factory = (restored?: Parameters<typeof createClaudeSessionReducer>[2]) =>
    createClaudeSessionReducer('sess', {}, restored);
  const initial = readForwardSession(file, 'claude', 'sess', factory);
  assert.ok(initial.checkpoint);
  const ranges: Array<[number, number]> = [];
  const reused = readForwardSession(
    file,
    'claude',
    'sess',
    factory,
    initial.checkpoint ?? undefined,
    recordingRangeReader(ranges),
  );
  assert.equal(reused.kind, 'reused');
  assert.ok(reused.read);
  assert.equal(reused.appendFrom, null);
  assert.deepEqual(ranges, []);
  fs.appendFileSync(file, JSON.stringify(userPrompt('appended after reuse', 2)) + '\n');
  const appended = readForwardSession(
    file,
    'claude',
    'sess',
    factory,
    initial.checkpoint ?? undefined,
    recordingRangeReader(ranges),
  );
  assert.equal(appended.kind, 'appended');
  assert.ok(appended.read);
  assert.deepEqual(appended.appendFrom, initial.checkpoint.revision);
  const anchor = initial.checkpoint.contentAnchor;
  assert.deepEqual(ranges[0], [anchor.start, anchor.start + anchor.bytes.length]);
  assert.ok(anchor.bytes.length <= 4096);
});

test('forward checkpoint materialization transfers a disposable reducer exactly once', () => {
  const file = writeTranscript([userPrompt('finish transfer', 0), assistantAnswer('done', 1)]);
  let constructions = 0;
  let reads = 0;
  let finishes = 0;
  const factory = (restored?: Parameters<typeof createClaudeSessionReducer>[2]) => {
    constructions++;
    const reducer = createClaudeSessionReducer('sess', {}, restored);
    return {
      ...reducer,
      read: (readBytes?: number) => {
        reads++;
        return reducer.read(readBytes);
      },
      finish: (readBytes?: number) => {
        finishes++;
        return reducer.finish(readBytes);
      },
    };
  };
  const initial = readForwardSession(file, 'claude', 'sess', factory);
  assert.ok(initial.checkpoint);
  assert.deepEqual({ constructions, reads, finishes }, { constructions: 1, reads: 0, finishes: 1 });

  constructions = reads = finishes = 0;
  fs.appendFileSync(file, `${JSON.stringify(userPrompt('appended turn', 2))}\n`);
  const appended = readForwardSession(file, 'claude', 'sess', factory, initial.checkpoint ?? undefined);
  assert.equal(appended.kind, 'appended');
  assert.deepEqual({ constructions, reads, finishes }, { constructions: 1, reads: 0, finishes: 1 });

  constructions = reads = finishes = 0;
  const reused = readForwardSession(file, 'claude', 'sess', factory, appended.checkpoint ?? undefined);
  assert.equal(reused.kind, 'reused');
  assert.deepEqual({ constructions, reads, finishes }, { constructions: 1, reads: 0, finishes: 1 });
});

test('a truncated Claude transcript resets its checkpoint', () => {
  const file = writeTranscript([userPrompt('old', 0), assistantAnswer('old answer', 1)]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  fs.writeFileSync(file, JSON.stringify(userPrompt('new', 2)) + '\n');
  const reset = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.ok(reset.read);
  assert.equal(reset.appendFrom, null);
  assert.equal(reset.read?.turns[0].prompt, 'new');
});

test('a same-size Claude mutation resets its checkpoint', () => {
  const file = writeTranscript([userPrompt('aaa', 0), assistantAnswer('done', 1)]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.ok(initial.checkpoint);
  const body = fs.readFileSync(file, 'utf8').replace('aaa', 'bbb');
  fs.writeFileSync(file, body);
  const reset = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.ok(reset.read);
  assert.equal(reset.appendFrom, null);
  assert.equal(reset.read?.turns[0].prompt, 'bbb');
});

test('a replaced Claude file resets even when its path is unchanged', () => {
  const file = writeTranscript([userPrompt('old identity', 0), assistantAnswer('done', 1)]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  fs.unlinkSync(file);
  fs.writeFileSync(
    file,
    [JSON.stringify(userPrompt('new identity', 2)), JSON.stringify(assistantAnswer('done', 3)), ''].join('\n'),
  );
  const reset = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.ok(reset.read);
  assert.equal(reset.appendFrom, null);
  assert.equal(reset.read?.turns[0].prompt, 'new identity');
});

test('a Claude anchor mismatch rejects append-only resume', () => {
  const file = writeTranscript([userPrompt('before', 0), assistantAnswer('done', 1)]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  const changed = fs.readFileSync(file, 'utf8').replace('before', 'mutate');
  fs.writeFileSync(file, changed + JSON.stringify(userPrompt('after', 2)) + '\n');
  const reset = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.ok(reset.read);
  assert.equal(reset.appendFrom, null);
  assert.deepEqual(reset.read, readSession(file, 'sess'));
});

test('an incompatible Claude parser checkpoint rebuilds from the file', () => {
  const file = writeTranscript([userPrompt('rebuild', 0), assistantAnswer('done', 1)]);
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.ok(initial.checkpoint);
  (initial.checkpoint.parserState as { version: number }).version = 99;
  const reset = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.deepEqual(reset.read, readSession(file, 'sess'));
});

test('a different Claude session id resets a compatible file checkpoint', () => {
  const file = writeTranscript([userPrompt('identity', 0), assistantAnswer('done', 1)]);
  const initial = readClaudeSessionIncremental(file, 'old-session');
  const reset = readClaudeSessionIncremental(file, 'new-session', initial.checkpoint ?? undefined);
  assert.equal(reset.kind, 'reset');
  assert.equal(reset.checkpoint?.sessionId, 'new-session');
  assert.equal(reset.read?.turns[0].sessionId, 'new-session');
});

test('a missing and an empty Claude transcript have distinct complete results', () => {
  const dir = tempDir('claude-history-');
  assert.equal(readClaudeSessionIncremental(path.join(dir, 'missing.jsonl'), 'sess').kind, 'missing');
  const empty = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const result = readClaudeSessionIncremental(empty, 'sess');
  assert.equal(result.kind, 'reset');
  assert.deepEqual(result.read?.turns, []);
  assert.equal(result.checkpoint?.appliedThrough, 0);
});

test('a final unterminated Claude record and malformed predecessor recover together', () => {
  const dir = tempDir('claude-history-');
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(
    file,
    ['{malformed', JSON.stringify(userPrompt('valid', 0)), JSON.stringify(assistantAnswer('unterminated', 1))].join(
      '\n',
    ),
  );
  const result = readClaudeSessionIncremental(file, 'sess');
  assert.equal(result.read?.turns[0].summary, 'unterminated');
  assert.ok((result.checkpoint?.lineFragment.length ?? 0) > 0);
  assert.deepEqual(result.read, readSession(file, 'sess'));
  assert.equal(result.checkpoint?.parserState.cur?.summary, '');
  result.read!.turns[0].summary = 'mutated outside the checkpoint';
  const reused = readClaudeSessionIncremental(file, 'sess', result.checkpoint ?? undefined);
  assert.equal(reused.read?.turns[0].summary, 'unterminated');
  assert.equal(reused.checkpoint?.parserState.cur?.summary, '');
});

test('a Claude checkpoint completes its saved line fragment after an append', () => {
  const dir = tempDir('claude-history-');
  const file = path.join(dir, 'sess.jsonl');
  const prompt = JSON.stringify(userPrompt('fragmented answer', 0));
  const answer = JSON.stringify(assistantAnswer('completed later', 1));
  const cut = answer.length - 9;
  fs.writeFileSync(file, `${prompt}\n${answer.slice(0, cut)}`);
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.ok((initial.checkpoint?.lineFragment.length ?? 0) > 0);
  fs.appendFileSync(file, `${answer.slice(cut)}\n`);
  const appended = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(appended.kind, 'appended');
  assert.equal(appended.checkpoint?.lineFragment.length, 0);
  assert.deepEqual(appended.read, readSession(file, 'sess'));
});

test('Claude semantic pages reconstruct UTF-8 records split across chunks', () => {
  const file = writeTranscript([userPrompt('emoji 🌍 survives', 0), assistantAnswer('done', 1)]);
  const result = readClaudeHistoryPage(file, 'sess', null, { chunkBytes: 7, targetTurns: 1 });
  assert.equal(result.kind, 'page');
  assert.equal(result.page?.turns[0].prompt, 'emoji 🌍 survives');
  assert.equal(result.page?.source, 'claude');
  assert.equal(result.page?.sessionId, 'sess');
  const stat = fs.statSync(file);
  assert.deepEqual(result.page?.revision, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
  });
});

function claudeCursorFixture(): { file: string; cursor: ClaudeHistoryCursor | null } {
  const file = writeTranscript([
    userPrompt('one', 0),
    assistantAnswer('one done', 1),
    userPrompt('two', 2),
    assistantAnswer('two done', 3),
    userPrompt('three', 4),
    assistantAnswer('three done', 5),
  ]);
  const first = readClaudeHistoryPage(file, 'sess', null, { chunkBytes: 64, targetTurns: 1 });
  assert.equal(first.kind, 'page');
  return { file, cursor: first.page?.nextOlderCursor ?? null };
}

test('an append makes an older Claude page cursor stale', () => {
  const { file, cursor } = claudeCursorFixture();
  assert.ok(cursor);
  fs.appendFileSync(file, JSON.stringify(userPrompt('four', 6)) + '\n');
  assert.equal(readClaudeHistoryPage(file, 'sess', cursor, { chunkBytes: 64, targetTurns: 1 }).kind, 'stale');
});

test('truncation makes an older Claude page cursor stale', () => {
  const { file, cursor } = claudeCursorFixture();
  assert.ok(cursor);
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
  assert.equal(readClaudeHistoryPage(file, 'sess', cursor, { chunkBytes: 64, targetTurns: 1 }).kind, 'stale');
});

test('replacement makes an older Claude page cursor stale', () => {
  const { file, cursor } = claudeCursorFixture();
  assert.ok(cursor);
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify(userPrompt('replacement', 7)) + '\n');
  assert.equal(readClaudeHistoryPage(file, 'sess', cursor, { chunkBytes: 64, targetTurns: 1 }).kind, 'stale');
});

test('empty and missing Claude history sources are explicit', () => {
  const dir = tempDir('claude-pages-');
  const empty = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const page = readClaudeHistoryPage(empty, 'sess');
  assert.equal(page.kind, 'page');
  assert.deepEqual(page.page?.ownedRange, { start: 0, end: 0 });
  assert.deepEqual(page.page?.turns, []);
  assert.equal(readClaudeHistoryPage(path.join(dir, 'missing.jsonl'), 'sess').kind, 'missing');
});

test('an asynchronous Claude page scan yields and can be cancelled between chunks', async () => {
  const file = writeTranscript([userPrompt(`large ${'x'.repeat(16 * 1024)}`, 0), assistantAnswer('done', 1)]);
  const controller = new AbortController();
  let pauses = 0;
  const result = await readClaudeHistoryPageAsync(file, 'sess', null, {
    chunkBytes: 64,
    signal: controller.signal,
    pause: async () => {
      pauses++;
      if (pauses === 2) {
        controller.abort();
      }
    },
  });
  assert.equal(result.kind, 'cancelled');
  assert.equal(pauses, 2);
});

test('a sparse semantic scan parses retained candidates once at the beginning', () => {
  const dir = tempDir('sparse-history-');
  const file = path.join(dir, 'sparse.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(80) })}\n`.repeat(4096));
  let parses = 0;
  const result = readSemanticHistoryPage(
    file,
    'sess',
    {
      source: 'claude',
      initialState: () => ({}),
      accepts: () => false,
      parse: (_records, state) => {
        parses++;
        return { turns: [], compactions: [], openRange: null, adapterState: state };
      },
    },
    null,
    { chunkBytes: 1024 },
  );
  assert.equal(result.kind, 'page');
  assert.equal(parses, 1);
});

test('a semantic page scan does not replay every retained record after every chunk', async () => {
  const dir = tempDir('semantic-history-work-');
  const file = path.join(dir, 'records.jsonl');
  const records = Array.from({ length: 128 }, (_value, index) =>
    JSON.stringify({ type: 'candidate', index, payload: 'x'.repeat(96) }),
  );
  fs.writeFileSync(file, `${records.join('\n')}\n`);
  let parsedRecords = 0;
  let parses = 0;
  const result = await readSemanticHistoryPageAsync(
    file,
    'sess',
    {
      source: 'claude',
      initialState: () => ({}),
      accepts: () => true,
      parse: (held, state) => {
        parses++;
        parsedRecords += held.length;
        return { turns: [], compactions: [], openRange: null, adapterState: state };
      },
    },
    null,
    { chunkBytes: 256, pause: async () => {} },
  );
  assert.equal(result.kind, 'page');
  assert.ok(parses > 1, 'the fixture did not cross a materialization boundary');
  assert.ok(
    parsedRecords <= records.length * 3,
    `the page reader replayed ${parsedRecords} retained records for ${records.length} source records`,
  );
});

test('semantic evidence receives one final BOF scan before page construction', async () => {
  const dir = tempDir('semantic-evidence-eof-');
  const file = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(file, '');
  const run = async (asyncRead: boolean): Promise<number> => {
    let scans = 0;
    const adapter = {
      source: 'claude' as const,
      initialState: () => ({}),
      accepts: () => false,
      parse: (_records: readonly unknown[], state: object) => ({
        turns: [],
        compactions: [],
        openRange: null,
        adapterState: state,
        olderEvidence: [{ key: 'turn', value: 'still-unresolved' }],
      }),
      scanOlderEvidence: (
        _records: readonly unknown[],
        claims: readonly { key: string; value: string }[],
        state: object,
      ) => {
        scans++;
        return { adapterState: state, remaining: [...claims] };
      },
    };
    const result = asyncRead
      ? await readSemanticHistoryPageAsync(file, 'sess', adapter, null)
      : readSemanticHistoryPage(file, 'sess', adapter, null);
    assert.equal(result.kind, 'page');
    return scans;
  };
  assert.deepEqual([await run(false), await run(true)], [1, 1]);
});

test('persistent semantic evidence scans the source at most twice before an empty page', () => {
  const dir = tempDir('semantic-evidence-bound-');
  const file = path.join(dir, 'records.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'candidate', payload: 'x'.repeat(80) })}\n`.repeat(512));
  const ranges: Array<[number, number]> = [];
  const result = readSemanticHistoryPage(
    file,
    'sess',
    {
      source: 'claude',
      initialState: () => ({}),
      accepts: () => true,
      parse: (_records, state) => ({
        turns: [],
        compactions: [],
        openRange: null,
        adapterState: state,
        olderEvidence: [{ key: 'turn', value: 'never-resolved' }],
      }),
      scanOlderEvidence: (_records, claims, state) => ({
        adapterState: state,
        remaining: [...claims],
      }),
    },
    null,
    { chunkBytes: 127, readRange: recordingRangeReader(ranges) },
  );
  assert.equal(result.kind, 'page');
  const sourceBytes = fs.statSync(file).size;
  const readBytes = ranges.reduce((total, [start, end]) => total + end - start, 0);
  assert.ok(
    readBytes <= sourceBytes * 2,
    `persistent evidence read ${readBytes} bytes from a ${sourceBytes}-byte source`,
  );
});

test('Claude pages discard ordinary tool results before retaining an older guard', () => {
  const ordinaryResults = Array.from({ length: 128 }, (_value, index) => ({
    type: 'user',
    timestamp: at(index + 1),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `ordinary-${index}`, content: 'x'.repeat(256) }],
    },
  }));
  const file = writeTranscript([
    userPrompt('older guard', 0),
    ...ordinaryResults,
    assistantAnswer('older answer', 130),
    userPrompt('newest target', 131),
    assistantAnswer('newest answer', 132),
  ]);
  const result = readClaudeHistoryPage(file, 'sess', null, {
    chunkBytes: fs.statSync(file).size,
    targetTurns: 1,
  });
  assert.equal(result.kind, 'page');
  const retained = result.page?.nextOlderCursor?.heldRecords ?? [];
  const ordinary = retained.filter((record) => record.text.includes('"tool_result"'));
  assert.deepEqual(
    { records: ordinary.length, bytes: ordinary.reduce((sum, record) => sum + record.end - record.start, 0) },
    {
      records: 0,
      bytes: 0,
    },
  );
});

test('Claude page cursors expire ownerless terminal child evidence at the turn horizon', () => {
  const records: object[] = [];
  for (let index = 0; index < 24; index += 1) {
    records.push(
      userPrompt(`ownerless ${index}`, index * 3),
      {
        type: 'user',
        timestamp: at(index * 3 + 1),
        origin: { kind: 'task-notification' },
        message: {
          role: 'user',
          content: `<tool-use-id>missing-${index}</tool-use-id><status>completed</status>`,
        },
      },
      assistantAnswer(`ownerless answer ${index}`, index * 3 + 2),
    );
  }
  const file = writeTranscript(records);
  const retainedCounts: number[] = [];
  let cursor: ClaudeHistoryCursor | null = null;
  do {
    const result = readClaudeHistoryPage(
      file,
      'sess',
      cursor,
      {
        chunkBytes: 256,
        targetTurns: 1,
      },
      { maxTurns: 3 },
    );
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    cursor = result.page.nextOlderCursor;
    if (cursor) {
      retainedCounts.push(cursor.adapterState.terminalChildren.length);
    }
  } while (cursor);
  assert.ok(retainedCounts.length > 3);
  assert.ok(Math.max(...retainedCounts) <= 3, `terminal child evidence grew to ${Math.max(...retainedCounts)}`);
});

test('a full Claude semantic page targets twenty complete turns', () => {
  const records: object[] = [];
  for (let index = 0; index < 25; index++) {
    records.push(userPrompt(`prompt ${index}`, index * 2), assistantAnswer(`answer ${index}`, index * 2 + 1));
  }
  const result = readClaudeHistoryPage(writeTranscript(records), 'sess', null, {
    chunkBytes: 1024 * 1024,
  });
  assert.equal(result.kind, 'page');
  assert.equal(result.page?.turns.length, 20);
  assert.ok(result.page?.nextOlderCursor);
});

test('three Claude history pages own disjoint ranges and stable turns', () => {
  const records: object[] = [];
  for (let index = 0; index < 4; index++) {
    const second = index * 4;
    records.push(userPrompt(`prompt ${index} ${'x'.repeat(180)}`, second));
    records.push(
      assistantTool('Bash', second + 1, `paged-claude-${index}`, {
        command: `echo claude-${index}`,
        description: `Run Claude ${index}`,
      }),
    );
    if (index === 1) {
      records.push({
        type: 'system',
        timestamp: at(second),
        compactMetadata: { trigger: 'auto', preTokens: 123, postTokens: 17 },
      });
    }
    records.push(assistantAnswer(`answer ${index}`, second + 2));
    if (index === 0) {
      records.push({
        ...userPrompt('carried summary', second + 3),
        isCompactSummary: true,
        message: { role: 'user', content: 'carried summary' },
      });
    }
  }
  records.push({ type: 'ai-title', timestamp: at(20), aiTitle: 'Final paged title' });
  const file = writeTranscript(records);
  const reads: Array<[number, number]> = [];
  const pages = [];
  let cursor = null;
  const readOptions = { sessionTitle: 'Supplied title' };
  do {
    const result = readClaudeHistoryPage(
      file,
      'sess',
      cursor,
      {
        chunkBytes: 96,
        targetTurns: 1,
        readRange: recordingRangeReader(reads),
      },
      readOptions,
    );
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor && pages.length < 10);
  assert.equal(pages.length, 4);
  for (let index = 1; index < reads.length; index++) {
    assert.equal(reads[index][1], reads[index - 1][0]);
  }
  for (let index = 1; index < pages.length; index++) {
    assert.equal(pages[index].ownedRange.end, pages[index - 1].ownedRange.start);
  }
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  const oneShot = readSession(file, 'sess', readOptions);
  assert.deepEqual(paged, oneShot.turns);
  assert.deepEqual(
    [...pages].reverse().flatMap((page) => page.compactions),
    oneShot.compactions,
  );
  assert.equal(new Set(paged.map((turn) => turn.promptId)).size, paged.length);
  for (let turnIndex = 0; turnIndex < paged.length; turnIndex++) {
    for (let stepIndex = 0; stepIndex < paged[turnIndex].steps.length; stepIndex++) {
      for (const key of ['id', 'fullDetail'] as const) {
        const actual = Object.getOwnPropertyDescriptor(paged[turnIndex].steps[stepIndex], key);
        const expected = Object.getOwnPropertyDescriptor(oneShot.turns[turnIndex].steps[stepIndex], key);
        assert.deepEqual(actual?.value, expected?.value);
        assert.equal(actual?.enumerable, false);
        assert.equal(expected?.enumerable, false);
      }
    }
  }
});

test('a generated Claude title older than the newest-page guard still titles that page', () => {
  const records: object[] = [
    userPrompt('oldest', 0),
    assistantAnswer('oldest answer', 1),
    { type: 'ai-title', timestamp: at(2), aiTitle: 'Title before the guard' },
    { type: 'progress', payload: 'x'.repeat(300 * 1024) },
  ];
  for (let index = 1; index < 5; index++) {
    records.push(userPrompt(`newer ${index}`, index * 2 + 1), assistantAnswer(`answer ${index}`, index * 2 + 2));
  }
  const file = writeTranscript(records);
  const page = readClaudeHistoryPage(
    file,
    'sess',
    null,
    { chunkBytes: 180, targetTurns: 1 },
    {
      sessionTitle: 'Supplied fallback',
    },
  );
  assert.equal(page.kind, 'page');
  assert.equal(page.page?.turns.length, 1);
  assert.equal(page.page?.turns[0].sessionTitle, 'Title before the guard');
});

test('Claude pages accept legacy turns with missing or duplicate prompt ids', () => {
  const records = [
    { ...userPrompt('first legacy', 0), promptId: undefined },
    assistantAnswer('first answer', 1),
    { ...userPrompt('second legacy', 2), promptId: 'same-vendor-id' },
    assistantAnswer('second answer', 3),
    { ...userPrompt('third legacy', 4), promptId: 'same-vendor-id' },
    assistantAnswer('third answer', 5),
  ];
  const file = writeTranscript(records);
  const result = readClaudeHistoryPage(file, 'sess', null, { chunkBytes: 1024 * 1024 });
  assert.equal(result.kind, 'page');
  assert.deepEqual(result.page?.turns, readSession(file, 'sess').turns);
  assert.deepEqual(
    result.page?.turns.map((turn) => turn.promptId),
    ['', 'same-vendor-id', 'same-vendor-id'],
  );
});

test('a Claude page keeps the next prompt as lookahead for an abrupt older turn', () => {
  const file = writeTranscript([
    userPrompt('older abrupt turn', 0),
    assistantTool('Bash', 1, 'abrupt-claude', { command: 'echo older', description: 'Run older' }),
    userPrompt('newer closed turn', 2),
    assistantAnswer('newer answer', 3),
  ]);
  const pages = [];
  let cursor = null;
  do {
    const result = readClaudeHistoryPage(file, 'sess', cursor, { chunkBytes: 80, targetTurns: 1 });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor);
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  const expected = readSession(file, 'sess').turns;
  assert.deepEqual(paged, expected);
  assert.equal((paged[0].steps[0] as { id?: string }).id, (expected[0].steps[0] as { id?: string }).id);
  assert.equal(Object.getOwnPropertyDescriptor(paged[0].steps[0], 'id')?.enumerable, false);
  assert.equal(
    (paged[0].steps[0] as { fullDetail?: string }).fullDetail,
    (expected[0].steps[0] as { fullDetail?: string }).fullDetail,
  );
  assert.equal(Object.getOwnPropertyDescriptor(paged[0].steps[0], 'fullDetail')?.enumerable, false);
});

test('Claude pages carry a later child completion back to its guard owner', () => {
  const file = writeTranscript([
    userPrompt('launch the older child', 0),
    assistantTool('Agent', 1, 'paged-background-child', {
      description: 'paged worker',
      subagent_type: 'general-purpose',
    }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'paged-background-child', content: 'launched' }],
      },
      toolUseResult: { agentId: 'paged-child', description: 'paged worker', status: 'running' },
    },
    assistantAnswer('The child is running.', 3),
    userPrompt('newer owner-independent turn', 4),
    {
      type: 'user',
      timestamp: at(5),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<tool-use-id>paged-background-child</tool-use-id><task-id>paged-child</task-id>' +
          '<status>completed</status><subagent_tokens>41</subagent_tokens>' +
          '<tool_uses>6</tool_uses><duration_ms>1200</duration_ms>',
      },
    },
    assistantAnswer('The newer work is complete.', 6),
  ]);
  const pages = [];
  let cursor = null;
  do {
    const result = readClaudeHistoryPage(file, 'sess', cursor, { chunkBytes: 80, targetTurns: 1 });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      break;
    }
    pages.push(result.page);
    cursor = result.page.nextOlderCursor;
  } while (cursor);
  const paged = [...pages].reverse().flatMap((page) => page.turns);
  const oneShot = readSession(file, 'sess').turns;
  assert.deepEqual(paged, oneShot);
  assert.deepEqual(
    paged[0].agents.map((agent) => [agent.status, agent.tokens, agent.toolUses, agent.durationMs]),
    [['completed', 41, 6, 1200]],
  );
});

test('Claude pages hold the open newest turn outside complete history', () => {
  const file = writeTranscript([userPrompt('closed', 0), assistantAnswer('done', 1), userPrompt('still running', 2)]);
  const result = readClaudeHistoryPage(file, 'sess', null, { chunkBytes: 64, targetTurns: 20 });
  assert.equal(result.kind, 'page');
  assert.deepEqual(
    result.page?.turns.map((turn) => turn.prompt),
    ['closed'],
  );
  assert.ok(result.openRange);
  assert.equal(result.page?.ownedRange.end, result.openRange?.start);
});

test('a compaction summary starts where its content does', () => {
  const raw =
    'This session is being continued from a previous session that ran out of context. ' +
    'The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The ask';
  assert.equal(stripCompactPreamble(raw), '1. The ask');
  assert.equal(stripCompactPreamble('no preamble here'), 'no preamble here');
});

test('a compaction is reported with the context size it replaced', () => {
  const file = writeTranscript([
    userPrompt('first ask', 0),
    assistantText('Done.', 1, { output_tokens: 100, input_tokens: 5, cache_read_input_tokens: 620_000 }),
    {
      ...userPrompt('the summary that carried over', 2),
      isCompactSummary: true,
      message: { role: 'user', content: 'the summary that carried over' },
    },
    {
      type: 'system',
      timestamp: at(2),
      compactMetadata: {
        trigger: 'manual',
        preTokens: 629_292,
        postTokens: 14_172,
        durationMs: 147_691,
        cumulativeDroppedTokens: 615_120,
      },
    },
    userPrompt('second ask', 3),
    assistantText('Done again.', 4, { output_tokens: 20 }),
  ]);
  const { turns, compactions } = readSession(file, 'sess');
  assert.equal(turns.length, 2, 'a compaction does not start or end a turn');
  assert.equal(compactions.length, 1);
  const [c] = compactions;
  assert.equal(c.summary, 'the summary that carried over');
  assert.equal(c.sessionId, 'sess');
  assert.equal(c.model, 'claude-opus-5', 'priced at the model that was running');
  // Recorded compaction figures override the running context count.
  assert.deepEqual(
    [c.trigger, c.contextBefore, c.contextAfter, c.durationMs, c.droppedTokens],
    ['manual', 629_292, 14_172, 147_691, 615_120],
  );
});

test('Claude compact metadata keeps native pre-and-post context facts', () => {
  const file = writeTranscript([
    userPrompt('first ask', 0),
    assistantText('Done.', 1, { output_tokens: 100, input_tokens: 5, cache_read_input_tokens: 620_000 }),
    { ...userPrompt('carried over', 2), isCompactSummary: true, message: { role: 'user', content: 'carried over' } },
    {
      type: 'system',
      timestamp: at(2),
      compactMetadata: {
        trigger: 'auto',
        preTokens: 620_010,
        postTokens: 33_031,
        durationMs: 147_691,
        cumulativeDroppedTokens: 586_979,
        tools: ['Bash'],
      },
    },
  ]);
  const [compaction] = readSession(file, 'sess').compactions;
  assert.deepEqual(
    [
      compaction.trigger,
      compaction.contextBefore,
      compaction.contextAfter,
      compaction.durationMs,
      compaction.droppedTokens,
    ],
    ['auto', 620_010, 33_031, 147_691, 586_979],
  );
  assert.equal(compaction.usage, undefined);
});

test('a compaction with no figures recorded falls back to the running context count', () => {
  const file = writeTranscript([
    userPrompt('first ask', 0),
    assistantText('Done.', 1, { output_tokens: 100, input_tokens: 5, cache_read_input_tokens: 620_000 }),
    { ...userPrompt('carried over', 2), isCompactSummary: true, message: { role: 'user', content: 'carried over' } },
    userPrompt('second ask', 3),
    assistantText('Done again.', 4, { output_tokens: 20 }),
  ]);
  const [c] = readSession(file, 'sess').compactions;
  assert.equal(c.contextBefore, 620_005);
  assert.deepEqual([c.trigger, c.contextAfter, c.durationMs], ['', 0, 0]);
});

test('compaction figures written far from any compaction are ignored', () => {
  const file = writeTranscript([
    userPrompt('first ask', 0),
    assistantText('Done.', 1, { output_tokens: 100, input_tokens: 42 }),
    { ...userPrompt('carried over', 2), isCompactSummary: true, message: { role: 'user', content: 'carried over' } },
    { type: 'system', timestamp: at(600), compactMetadata: { trigger: 'auto', preTokens: 999_999 } },
  ]);
  const [c] = readSession(file, 'sess').compactions;
  assert.equal(c.trigger, '');
  assert.equal(c.contextBefore, 42);
});

test('a compaction at the very start of the window is still reported', () => {
  const file = writeTranscript([
    { ...userPrompt('carried over', 0), isCompactSummary: true, message: { role: 'user', content: 'carried over' } },
    userPrompt('first ask', 1),
    assistantText('Done.', 2, { output_tokens: 10 }),
  ]);
  const { turns, compactions } = readSession(file, 'sess');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].contextBefore, 0, 'nothing before it in the window to measure');
  assert.equal(turns.length, 1);
});

test('a human prompt is a typed prompt whose origin, where recorded, is not the peer kind', () => {
  const human = JSON.stringify(userPrompt('fix the panel', 0, { origin: { kind: 'human' } }));
  const bare = JSON.stringify(userPrompt('an old prompt with no origin field', 0));
  const unknownKind = JSON.stringify(userPrompt('a kind added later', 0, { origin: { kind: 'someday' } }));
  const peerMeta = JSON.stringify({
    ...userPrompt('Another Claude session sent a message', 0),
    isMeta: true,
    origin: { kind: 'peer' },
  });
  const peerPlain = JSON.stringify({
    ...userPrompt('a peer prompt written without the meta flag', 0),
    origin: { kind: 'peer' },
  });
  const toolResult = JSON.stringify(editResult('c:/repo/a.ts', 1, 1, 0));
  const notify = JSON.stringify({
    type: 'user',
    timestamp: at(0),
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: 'done' },
  });
  assert.equal(holdsHumanPrompt(human), true);
  // Missing and unknown origin kinds count as human prompts, preserving sessions across format changes.

  assert.equal(holdsHumanPrompt(bare), true, 'a transcript from before the origin field reads as machine work');
  assert.equal(holdsHumanPrompt(unknownKind), true, 'an unknown origin kind hides a session');
  assert.equal(holdsHumanPrompt(peerMeta), false, 'the wake message itself reads as a human prompt');
  assert.equal(holdsHumanPrompt(peerPlain), false, 'a peer prompt without the meta flag reads as human');
  assert.equal(holdsHumanPrompt([toolResult, notify].join('\n')), false, 'machine traffic reads as a human prompt');
  assert.equal(holdsHumanPrompt([peerMeta, human].join('\n')), true, 'a human prompt after a wake goes unseen');
  assert.equal(holdsHumanPrompt(''), false);
});

test('a session opened with a slash command is one somebody had', () => {
  const skill =
    '<command-message>write-ppm-docs</command-message>\n<command-name>/write-ppm-docs</command-name>\n<command-args>review the plugin pages</command-args>';
  const setting =
    '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>';
  const compaction =
    '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>';
  const effort =
    '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>low</command-args>';
  const later = '<command-name>/added-next-year</command-name>\n<command-args>go</command-args>';
  assert.equal(
    holdsHumanPrompt(JSON.stringify(userPrompt(skill, 0, { origin: { kind: 'human' } }))),
    true,
    'a session whose only prompt is a slash command is off the rail entirely',
  );
  // Model, compaction, and effort commands alone do not establish a reader-started session.

  assert.equal(
    holdsHumanPrompt(JSON.stringify(userPrompt(setting, 0, { origin: { kind: 'human' } }))),
    false,
    'a model switch reads as a session',
  );
  assert.equal(
    holdsHumanPrompt(JSON.stringify(userPrompt(compaction, 0, { origin: { kind: 'human' } }))),
    false,
    'a compaction reads as a session',
  );
  assert.equal(
    holdsHumanPrompt(JSON.stringify(userPrompt(effort, 0, { origin: { kind: 'human' } }))),
    false,
    'an effort change reads as a session',
  );
  // Unknown commands count as work so new command names remain discoverable.

  assert.equal(
    holdsHumanPrompt(JSON.stringify(userPrompt(later, 0, { origin: { kind: 'human' } }))),
    true,
    'a command added to the harness later takes its sessions off the rail',
  );
});

test('the human-prompt scan reads each byte once, and a wake file joins when a human prompts it', () => {
  const file = writeTranscript([
    { ...userPrompt('Another Claude session sent a message', 0), isMeta: true, origin: { kind: 'peer' } },
    assistantAnswer('Noted; holding.', 1),
  ]);
  const size1 = fs.statSync(file).size;
  const first = scanForHumanPrompt(file, size1);
  assert.equal(first.found, false, 'a wake-only file reads as human work');
  assert.equal(first.bytes, size1, 'the scan did not consume the complete lines it read');
  // An unchanged file needs no additional read.
  assert.deepEqual(scanForHumanPrompt(file, size1, first), { bytes: size1, found: false, complete: true });
  // The next scan finds a human prompt appended after its saved offset.

  fs.appendFileSync(
    file,
    JSON.stringify(userPrompt('picking this up myself', 2, { origin: { kind: 'human' } })) + '\n',
  );
  const size2 = fs.statSync(file).size;
  const second = scanForHumanPrompt(file, size2, first);
  assert.equal(second.found, true, 'a human prompt in the new bytes goes unseen, so the session never joins the list');
  // A successful scan retains found across later appends.
  assert.deepEqual(scanForHumanPrompt(file, size2, second), second);
  // A scan reads only bytes after its saved offset.

  fs.appendFileSync(file, JSON.stringify(assistantAnswer('More machine work.', 3)) + '\n');
  const size3 = fs.statSync(file).size;
  assert.equal(
    scanForHumanPrompt(file, size3, { bytes: size2, found: false }).found,
    false,
    'the scan re-read bytes an earlier scan already answered for',
  );
  // A smaller file resets the cursor to byte zero.
  fs.writeFileSync(file, JSON.stringify(userPrompt('rewritten from scratch', 0)) + '\n');
  const size4 = fs.statSync(file).size;
  assert.equal(
    scanForHumanPrompt(file, size4, { bytes: size3, found: false }).found,
    true,
    'a rewritten file keeps the old cursor, which now points past the end',
  );
});

test('the scan survives a line longer than its chunk, and waits for an unterminated one', () => {
  // A peer record exceeds one chunk and contains a multibyte character before the human prompt.

  const file = writeTranscript([
    { ...userPrompt('\u00e9' + 'x'.repeat(300 * 1024), 0), isMeta: true, origin: { kind: 'peer' } },
    userPrompt('a human at last', 1, { origin: { kind: 'human' } }),
  ]);
  const size = fs.statSync(file).size;
  assert.equal(scanForHumanPrompt(file, size).found, true, 'a line longer than one chunk ends the scan early');
  // The cursor stays before an unfinished final line until its newline arrives.

  const partial = writeTranscript([{ ...userPrompt('a wake', 0), isMeta: true, origin: { kind: 'peer' } }]);
  const whole = fs.statSync(partial).size;
  fs.appendFileSync(partial, JSON.stringify(userPrompt('typed but not yet flushed', 1)));
  const grown = fs.statSync(partial).size;
  const waiting = scanForHumanPrompt(partial, grown);
  assert.equal(waiting.found, false, 'an incomplete line was parsed as though it were whole');
  assert.equal(waiting.bytes, whole, 'the cursor moved past bytes the scan has not answered for');
  fs.appendFileSync(partial, '\n');
  assert.equal(
    scanForHumanPrompt(partial, fs.statSync(partial).size, waiting).found,
    true,
    'the completed line was never picked up',
  );
});

test('a prompt keeps its line structure, and its wrappers are stripped', () => {
  const raw =
    '<ide_selection>irrelevant</ide_selection>fix the panel:' +
    '\n  - the cost chip' +
    '\n  - the prompt block' +
    '\n\n\n\nthanks';
  assert.equal(cleanPrompt(raw), 'fix the panel:\n- the cost chip\n- the prompt block\n\nthanks');
  assert.equal(cleanPrompt('   spaced    out   '), 'spaced out');
});

test('a session is named by its latest title, or by what the user first asked', () => {
  const named = writeTranscript([
    userPrompt('build the timeline', 0),
    { type: 'ai-title', aiTitle: 'Timeline view for agent turns' },
    { type: 'ai-title', aiTitle: 'Debug game server connection timeouts' },
  ]);
  assert.equal(
    readSessionMeta(named).title,
    'Debug game server connection timeouts',
    'the last title is the current one',
  );

  const unnamed = writeTranscript([
    { ...userPrompt('injected', 0), isMeta: true },
    userPrompt('why does the panel show nothing in this repo', 1),
  ]);
  assert.equal(readSessionMeta(unnamed).title, 'why does the panel show nothing in this repo');

  const silent = writeTranscript([assistantText('nobody asked anything', 0)]);
  assert.equal(readSessionMeta(silent).title, null);
});

test('session titles are normalized as plain text and discard rich content', () => {
  const rich = `\uE200visualize\uE202${JSON.stringify({ path: path.resolve('fixtures', 'rail.html') })}\uE201`;
  assert.equal(normalizeSessionTitle(`  **Keep**\n${rich}\nthis   title  `), 'Keep this title');
  assert.equal(normalizeSessionTitle(rich), null);

  // Full session titles retain their complete text. Session list labels apply their own length limit.

  const huge = 'x'.repeat(10_000);
  assert.equal(normalizeFullSessionTitle(huge), huge);

  const file = writeTranscript([
    userPrompt('fallback to what I asked', 0),
    { type: 'ai-title', aiTitle: 'Superseded title' },
    { type: 'ai-title', aiTitle: rich },
    assistantText('Done.', 1),
  ]);
  assert.equal(readSessionMeta(file).title, 'fallback to what I asked');
  assert.equal(
    readSession(file, 'sess', { sessionTitle: 'supplied prompt fallback' }).turns[0].sessionTitle,
    'supplied prompt fallback',
  );
});

test('a long Claude title keeps its full normalized source beside the compact title', () => {
  const source = `**Keep** ${'the complete title text '.repeat(6)}`;
  const file = writeTranscript([userPrompt('prompt fallback', 0), { type: 'ai-title', aiTitle: source }]);
  const meta = readSessionMeta(file);
  assert.equal(meta.title, normalizeSessionTitle(source));
  assert.equal(meta.fullTitle, `Keep ${'the complete title text '.repeat(6)}`.trim());
  assert.ok((meta.title?.length ?? 0) <= 60, 'the compact heading no longer has its display limit');
});

test('a parsed Claude title carries its matching full value beyond the metadata tail', () => {
  const source = `**Generated** ${'title words '.repeat(12)}`;
  const file = writeTranscript([
    userPrompt('fallback prompt', 0),
    { type: 'ai-title', aiTitle: source },
    assistantAnswer('x'.repeat(300 * 1024), 1),
  ]);
  const metadata = readSessionMeta(file, 256 * 1024);
  const parsed = readSession(file, 'sess', { tailBytes: 512 * 1024 });
  assert.deepEqual(
    [metadata.title, metadata.titleSource],
    ['fallback prompt', 'prompt'],
    'the metadata tail reaches the generated title',
  );
  assert.equal(parsed.turns[0].sessionTitle, normalizeSessionTitle(source));
  assert.equal(parsed.turns[0].sessionFullTitle, `Generated ${'title words '.repeat(12)}`.trim());
});

test('a turn runs from one typed prompt to the next, absorbing task notifications', () => {
  const file = writeTranscript([
    userPrompt('first ask', 0),
    assistantTool('Bash', 1),
    {
      type: 'user',
      timestamp: at(2),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' },
    },
    assistantText('First turn is done.', 3, { output_tokens: 100, input_tokens: 5, cache_read_input_tokens: 1000 }),
    // These metadata records do not start turns.
    { ...userPrompt('injected', 4), isMeta: true },
    { ...userPrompt('compacted', 5), isCompactSummary: true },
    { ...userPrompt('subagent chatter', 6), isSidechain: true },
    userPrompt('second ask', 7),
    assistantText('Second turn is done.', 8, { output_tokens: 20, input_tokens: 1, cache_read_input_tokens: 2000 }),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, 'first ask');
  assert.equal(turns[0].summary, 'First turn is done.');
  assert.equal(turns[0].usage.output, 100);
  assert.equal(turns[0].contextTokens, 1005);
  assert.equal(turns[0].toolUses, 1);
  assert.equal(turns[1].prompt, 'second ask');
  // The turn ends at its last assistant activity.
  assert.equal(turns[0].endedAt - turns[0].startedAt, 3000);
});

test('a turn woken mid-life keeps every answer it closed, in order and with its time', () => {
  const file = writeTranscript([
    userPrompt('take the batch', 0),
    // Text ending with tool_use remains narration.
    assistantText('Let me check the plan first.', 1, undefined, undefined, 'tool_use'),
    assistantTool('Bash', 2),
    assistantAnswer('First answer: holding edits until the peer replies.', 3),
    // A cross-session message is a meta user line, not a typed prompt.
    { ...userPrompt('Another Claude session sent a message', 4), isMeta: true },
    assistantAnswer('Second answer: coordination settled.', 5),
    {
      type: 'user',
      timestamp: at(6),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' },
    },
    assistantAnswer('Third answer: the batch landed.', 7),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 1, 'a wake started a new turn');
  const [t] = turns;
  assert.deepEqual(
    t.answers.map((a) => a.text),
    [
      'First answer: holding edits until the peer replies.',
      'Second answer: coordination settled.',
      'Third answer: the batch landed.',
    ],
  );
  assert.deepEqual(
    t.answers.map((a) => a.at),
    [ms(3), ms(5), ms(7)],
    'each answer carries the time it was written',
  );
  assert.equal(t.summary, 'Third answer: the batch landed.', 'the summary stays the last answer');
});

// A peer handback identifies its sender and marks the user record as metadata.

const HANDBACK_FROM = 'a054545111561daad';
const REPORT = [
  'Phase 3 of the turn-card density plan (steps 22 to 30) is on main.',
  '',
  '- ❓ **Open questions / follow-ups** - choose whether phase 4 starts now.',
].join('\n');
const NOTE =
  "The plan recorder's final numbers came in: 46k tokens in 1.1 minutes. Nothing else changed since my last report.";
function peerHandback(from: string, second: number) {
  return {
    ...userPrompt(
      `Another Claude session sent a message: <agent-message>[Subagent hand-back] ${from}</agent-message>`,
      second,
    ),
    isMeta: true,
    origin: { kind: 'peer', from, handback: true },
  };
}
function completionNoticeText(taskId: string): string {
  return `<task-notification><task-id>${taskId}</task-id><status>completed</status><result>This agent's report was delivered to you as a message.</result></task-notification>`;
}
function completionNotice(taskId: string, second: number) {
  return {
    type: 'user',
    timestamp: at(second),
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: completionNoticeText(taskId) },
  };
}
function reportedTurnLines(notice: object) {
  return [
    userPrompt('/land the phase 3 plan', 0),
    assistantTool('Agent', 1, 'tu-agent', { description: 'plan recorder', subagent_type: 'general-purpose' }),
    assistantAnswer('The opus implementer is working on Phase 3 in its own worktree.', 2),
    peerHandback(HANDBACK_FROM, 3),
    assistantAnswer(REPORT, 4),
    notice,
    assistantAnswer(NOTE, 6),
  ];
}

test('a note written after a subagent repeats its completion notice leaves the report as the card response', () => {
  const [t] = readTurns(writeTranscript(reportedTurnLines(completionNotice(HANDBACK_FROM, 5))), 'sess');
  const card = toCard(t, true, ms(60));
  assert.ok(
    card.summary.startsWith('Phase 3 of the turn-card density plan'),
    `the response is ${JSON.stringify(card.summary)}`,
  );
  const replies = card.saidMessages.filter((message) => message.kind === 'answer').map((message) => message.text);
  assert.deepEqual(
    replies,
    ['The opus implementer is working on Phase 3 in its own worktree.', NOTE],
    'the note left Activity or the report stayed in it',
  );
  assert.equal(closingRows(card.summary).questions, 'choose whether phase 4 starts now.');
  assert.equal(searchableSummary(t).split(REPORT).length, 2, 'the search text holds the report once');
});

// A `SubagentHandback` call and its tool result, which carries no `toolUseResult`. With
// `endsTurn`, the result carries the `toolEndsTurn` flag the harness writes on it.
function handBack(message: unknown, second: number, id = `tu-handback-${second}`, endsTurn = false) {
  return [
    assistantTool('SubagentHandback', second, id, { message }),
    {
      type: 'user',
      timestamp: at(second + 1),
      ...(endsTurn ? { toolEndsTurn: true } : {}),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: [{ type: 'text', text: '{"success":true,"message":"Report delivered to your caller."}' }],
          },
        ],
      },
    },
  ];
}
function childRead(records: object[]) {
  const sidechain = records.map((record) => ({ ...record, isSidechain: true }));
  return readTurns(writeTranscript(sidechain), 'child', { childTranscript: true });
}
function metaUser(text: string, second: number, origin?: Record<string, unknown>) {
  return { ...userPrompt(text, second), isMeta: true, ...(origin ? { origin } : {}) };
}

// Handback text supplies the response in ordinary and child reads. Its following receipt stays in Activity.

for (const childTranscript of [true, false]) {
  test(`a subagent's hand-back message is its turn response and the receipt after it stays in Activity (${childTranscript ? 'child' : 'ordinary'} read)`, () => {
    const receipt = 'Report delivered.';
    const records = [
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      assistantTool('Grep', 1, 'tu-grep', { pattern: 'readings' }),
      toolResult('tu-grep', 2),
      assistantTool('Read', 3, 'tu-read', { file_path: 'c:/repo/usage.ts' }),
      toolResult('tu-read', 4),
      ...handBack(REPORT, 5),
      assistantAnswer(receipt, 7),
    ].map((record) => (childTranscript ? { ...record, isSidechain: true } : record));
    const [t] = readTurns(writeTranscript(records), 'child', childTranscript ? { childTranscript } : {});
    assert.equal(t.summary, REPORT, 'the turn summary is not the report');
    assert.deepEqual(
      t.answers.map((answer) => [answer.text, answer.notResponse]),
      [
        [REPORT, undefined],
        [receipt, 'after-handback'],
      ],
    );
    assert.equal(responseAnswerIndex(t), 0, 'the response is not the report');
    const card = toCard(t, true, ms(60));
    assert.equal(card.summary, REPORT, 'the card response is not the report');
    assert.deepEqual(
      card.saidMessages.filter((message) => message.kind === 'answer').map((message) => message.text),
      [receipt],
      'the receipt left Activity or the report stayed in it',
    );
    assert.equal(searchableSummary(t).split(REPORT).length, 2, 'the search text holds the report once');
    assert.equal(t.toolCounts.coordination, 1, 'the hand-back call is not coordination');
    assert.equal(t.toolCounts.other, 0, 'the hand-back call counted as other');
    assert.deepEqual(t.stepKinds, ['searches', 'reads', 'coordination']);
  });
}

// New prompts and peer or coordinator messages reopen the response. Completion notices and empty-reply reminders leave it closed.

for (const [wake, record, answered] of [
  ['a new prompt', userPrompt('Now list the writers of that cache.', 8), true],
  ['a peer message', metaUser('Also list the writers of that cache.', 8, { kind: 'peer', from: 'lead' }), true],
  [
    'a coordinator message',
    metaUser('The coordinator sent a message while you were working: commit the tests.', 8, { kind: 'coordinator' }),
    true,
  ],
  ['a completion notice', completionNotice('b6vw3z1jn', 8), false],
  ['the harness nudge', metaUser('[Your previous response had no visible output. Please continue...]', 8), false],
] as const) {
  test(`${wake} after a hand-back ${answered ? 'makes the next reply the response' : 'leaves the next reply a receipt'}`, () => {
    const reply = 'I committed the tests as 776c5ca8.';
    const turns = childRead([
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      ...handBack(REPORT, 5),
      assistantAnswer('Report delivered.', 7),
      record,
      assistantAnswer(reply, 9),
    ]);
    const t = turns[turns.length - 1];
    assert.equal(
      t.answers.find((answer) => answer.text === reply)?.notResponse,
      answered ? undefined : 'after-handback',
    );
    assert.equal(t.summary, answered ? reply : REPORT);
  });
}

// A subagent transcript records `stop_reason: null` on every assistant record. The harness
// marks the hand-back's tool result with `toolEndsTurn` instead.
function withNullStopReasons(records: object[]): object[] {
  return records.map((record) => {
    const one = record as { type?: unknown; message?: Record<string, unknown> };
    return one.type === 'assistant' ? { ...one, message: { ...one.message, stop_reason: null } } : record;
  });
}
const MINUTE = 60_000;

test('a subagent that hands back with the turn-ending flag reads done in every reader', () => {
  const records = withNullStopReasons([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    assistantTool('Grep', 1, 'tu-grep'),
    toolResult('tu-grep', 2),
    ...handBack(REPORT, 5, undefined, true),
  ]);
  for (const minutes of [30, 61]) {
    const read = localAnswerStatuses(records, ms(6) + minutes * MINUTE, minutes === 30, { childTranscript: true });
    assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done'], `${minutes} minutes after`);
    assert.deepEqual(
      [read.turns[0]?.endedAt, read.railOutcome?.endedAt, read.indexOutcome?.endedAt],
      [ms(6), ms(6), ms(6)],
      'the turn did not end at the flagged result',
    );
  }
});

test('the turn-ending flag finishes a main transcript turn whose result names no agent', () => {
  const records = withNullStopReasons([
    userPrompt('Report the cache fields.', 0),
    ...handBack(REPORT, 1, undefined, true),
  ]);
  assert.ok(!JSON.stringify(records).includes('agentId'));
  const read = localAnswerStatuses(records, ms(2) + 30 * MINUTE, true);
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
});

for (const [resumption, wake] of [
  ['a coordinator message', [metaUser('Commit the tests.', 8, { kind: 'coordinator' })]],
  ['a peer message', [metaUser('Also list the writers.', 8, { kind: 'peer', from: 'lead' })]],
  ['tool work', [assistantTool('Bash', 9, 'tu-commit')]],
  [
    'a coordinator message and tool work',
    [metaUser('Commit the tests.', 8, { kind: 'coordinator' }), assistantTool('Bash', 9, 'tu-commit')],
  ],
] as const) {
  test(`${resumption} after a flagged hand-back resumes the subagent turn in every reader`, () => {
    const records = withNullStopReasons([
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      ...handBack(REPORT, 5, undefined, true),
      ...wake,
    ]);
    const read = localAnswerStatuses(records, ms(9) + 30 * MINUTE, true, { childTranscript: true });
    assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
  });
}

for (const origin of [{ kind: 'coordinator' }, { kind: 'peer', from: 'lead' }]) {
  test(`a ${origin.kind} message two hours after a flagged hand-back resumes the subagent turn from the message`, () => {
    const woke = 6 + 2 * 60 * 60;
    const records = withNullStopReasons([
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      ...handBack(REPORT, 5, undefined, true),
      metaUser('Commit the tests.', woke, origin),
    ]);
    const read = localAnswerStatuses(records, ms(woke) + 30 * MINUTE, true, { childTranscript: true });
    assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
    assert.deepEqual(
      [read.turns[0]?.endedAt, read.railOutcome?.endedAt, read.indexOutcome?.endedAt],
      [ms(woke), ms(woke), ms(woke)],
      'the resumed turn did not move its activity time to the message',
    );
  });
}

test('an answer that ends the turn after a flagged hand-back keeps the turn done in every reader', () => {
  const records = [
    userPrompt('Report the cache fields.', 0),
    ...handBack(REPORT, 1, undefined, true),
    assistantAnswer('The report went to the lead.', 3),
  ];
  const read = localAnswerStatuses(records, ms(3) + 30 * MINUTE, true);
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
});

test('a long subagent transcript whose prompt is outside the tail window reads done after a flagged hand-back', () => {
  const work = Array.from({ length: 12 }, (_, i) =>
    assistantTool('Read', 1 + i, `tu-read-${i}`, { note: 'x'.repeat(2000) }),
  );
  const records = withNullStopReasons([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    ...work,
    ...handBack(REPORT, 20, undefined, true),
  ]);
  const read = localAnswerStatuses(records, ms(21) + 30 * MINUTE, false, { childTranscript: true, tailBytes: 4096 });
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
});

test('a subagent turn without the turn-ending flag reads running, then stopped', () => {
  const records = withNullStopReasons([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    ...handBack(REPORT, 5),
  ]);
  const soon = localAnswerStatuses(records, ms(6) + 30 * MINUTE, false, { childTranscript: true });
  assert.deepEqual([soon.full, soon.rail, soon.index], ['running', 'running', 'running']);
  const late = localAnswerStatuses(records, ms(6) + 61 * MINUTE, false, { childTranscript: true });
  assert.deepEqual([late.full, late.rail, late.index], ['stopped', 'stopped', 'stopped']);
});

test('a second hand-back in one turn makes the later report the response', () => {
  const later = 'The writers are the poller and the status hook.';
  const [t] = childRead([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    ...handBack(REPORT, 5),
    assistantAnswer('Report delivered.', 7),
    ...handBack(later, 8),
    assistantAnswer('Second report delivered.', 10),
  ]);
  assert.equal(t.summary, later);
  assert.deepEqual(
    t.answers.map((answer) => [answer.text, answer.notResponse]),
    [
      [REPORT, undefined],
      ['Report delivered.', 'after-handback'],
      [later, undefined],
      ['Second report delivered.', 'after-handback'],
    ],
  );
  assert.equal(responseAnswerIndex(t), 2);
  const search = searchableSummary(t);
  assert.equal(search.split(REPORT).length, 2, 'the search text holds the first report once');
  assert.equal(search.split(later).length, 2, 'the search text holds the later report once');
});

// A closing reply and its following handback share one report when either text contains the other after whitespace normalization.

const PREAMBLE = 'Here is the report.';
for (const [shape, reply, report, kept] of [
  ['the same text', REPORT, `${REPORT}\n`, `${REPORT}\n`],
  ['a report that holds the reply', REPORT, `${PREAMBLE}\n\n${REPORT}`, `${PREAMBLE}\n\n${REPORT}`],
  ['a reply that holds the report', `${PREAMBLE}\n\n${REPORT}`, REPORT, `${PREAMBLE}\n\n${REPORT}`],
  ['whitespace around the reply', ` \n${REPORT}\t`, REPORT, REPORT],
  [
    'whitespace around a report the reply holds',
    `${PREAMBLE}\n\n${REPORT}`,
    `\n${REPORT}\t `,
    `${PREAMBLE}\n\n${REPORT}`,
  ],
] as const) {
  test(`a closing reply sent again as a hand-back with ${shape} draws the report once`, () => {
    const receipt = 'Report delivered.';
    const [t] = childRead([
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      assistantAnswer(reply, 3),
      metaUser('[handback-send-enforce] Your report has not been delivered. Call SubagentHandback now.', 4),
      ...handBack(report, 5),
      assistantAnswer(receipt, 7),
    ]);
    assert.equal(t.summary, kept, 'the turn summary is not the longer text');
    const card = toCard(t, true, ms(60));
    assert.equal(card.summary, kept, 'the card response is not the longer text');
    assert.deepEqual(
      card.saidMessages.filter((message) => message.kind === 'answer').map((message) => message.text),
      [receipt],
      'the card draws the report a second time',
    );
    assert.equal(searchableSummary(t).split(REPORT).length, 2, 'the search text holds the report more than once');
  });
}

test('a closing reply that differs from the hand-back report after it keeps both', () => {
  const reply = 'Part 1 is written. I am waiting on the research for part 2.';
  const [t] = childRead([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    assistantAnswer(reply, 3),
    metaUser('[handback-send-enforce] Your report has not been delivered. Call SubagentHandback now.', 4),
    ...handBack(REPORT, 5),
  ]);
  assert.equal(t.summary, REPORT);
  const card = toCard(t, true, ms(60));
  assert.equal(card.summary, REPORT);
  assert.deepEqual(
    card.saidMessages.filter((message) => message.kind === 'answer').map((message) => message.text),
    [reply],
  );
  assert.equal(searchableSummary(t), `${reply}\n\n${REPORT}`);
});

// Only the closing reply of the wake the call answers can repeat the report. An earlier
// hand-back, or a reply written before a coordinator message, is a report of its own.
const DETAIL = 'The cache lives in usage.ts.';
for (const [first, second] of [
  [`${DETAIL} It holds three fields.`, DETAIL],
  [DETAIL, `${DETAIL} It holds three fields.`],
] as const) {
  test(`a hand-back right after a hand-back that ${first.length > second.length ? 'holds' : 'is part of'} its report keeps both`, () => {
    const [t] = childRead([
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      ...handBack(first, 3),
      ...handBack(second, 5),
    ]);
    assert.equal(t.summary, second, 'the later report is not the response');
    assert.deepEqual(
      t.answers.map((answer) => answer.text),
      [first, second],
    );
    assert.equal(responseAnswerIndex(t), 1);
  });
}

test('a hand-back after a coordinator message keeps the reply written before that message', () => {
  const report = `${DETAIL} It holds three fields.`;
  const [t] = childRead([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    assistantAnswer(DETAIL, 3),
    metaUser('The coordinator sent a message while you were working: list its fields too.', 4, { kind: 'coordinator' }),
    ...handBack(report, 5),
  ]);
  assert.equal(t.summary, report);
  assert.deepEqual(
    t.answers.map((answer) => answer.text),
    [DETAIL, report],
  );
});

test('a "No response requested." reply between a closing reply and the same hand-back draws the report once', () => {
  const [t] = childRead([
    userPrompt('Find where the usage cache lives and report its fields.', 0),
    assistantAnswer(REPORT, 3),
    metaUser('[handback-send-enforce] Your report has not been delivered. Call SubagentHandback now.', 4),
    assistantAnswer('No response requested.', 5),
    metaUser('[handback-send-enforce] Your report has not been delivered. Call SubagentHandback now.', 6),
    ...handBack(REPORT, 7),
  ]);
  assert.deepEqual(
    t.answers.map((answer) => [answer.text, answer.notResponse]),
    [
      ['No response requested.', 'no-response-requested'],
      [REPORT, undefined],
    ],
  );
  const card = toCard(t, true, ms(60));
  assert.equal(card.summary, REPORT);
  assert.equal(searchableSummary(t).split(REPORT).length, 2, 'the search text holds the report more than once');
});

for (const message of ['', '   ', 42, undefined]) {
  test(`a hand-back whose message is ${JSON.stringify(message) ?? 'missing'} leaves the reply after it the response`, () => {
    const receipt = 'Report delivered.';
    const [t] = childRead([
      userPrompt('Find where the usage cache lives and report its fields.', 0),
      ...handBack(message, 5),
      assistantAnswer(receipt, 7),
    ]);
    assert.equal(t.summary, receipt);
    assert.deepEqual(
      t.answers.map((answer) => [answer.text, answer.notResponse]),
      [[receipt, undefined]],
    );
    assert.equal(t.toolCounts.coordination, 1);
  });
}

// Thinking and text records share a closing message id and stop_reason.

function thoughtThenSaid(text: string, second: number) {
  const said = assistantAnswer(text, second) as { message: { id: string } };
  const thought = {
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: said.message.id,
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'The recorder finished.', signature: 's' }],
    },
  };
  return [thought, said];
}

test('a completion notice queued as an attachment repeats a handback the same way', () => {
  const notice = queued({ commandMode: 'task-notification', prompt: completionNoticeText(HANDBACK_FROM) }, 5);
  const [t] = readTurns(writeTranscript(reportedTurnLines(notice)), 'sess');
  assert.equal(t.summary, REPORT);
  assert.deepEqual(
    t.answers.map((answer) => answer.text),
    ['The opus implementer is working on Phase 3 in its own worktree.', REPORT, NOTE],
  );
  assert.deepEqual(
    t.answers.map((answer) => answer.notResponse),
    [undefined, undefined, 'repeat-notice'],
  );
});

for (const [shape, notice] of [
  ['wake', completionNotice],
  [
    'queued',
    (taskId: string, second: number) =>
      queued({ commandMode: 'task-notification', prompt: completionNoticeText(taskId) }, second),
  ],
] as const) {
  test(`a note written after thinking on a repeat ${shape} notice stays out of the response`, () => {
    const lines = reportedTurnLines(notice(HANDBACK_FROM, 5));
    lines.splice(-1, 1, ...thoughtThenSaid(NOTE, 6));
    const [t] = readTurns(writeTranscript(lines), 'sess');
    assert.equal(t.summary, REPORT);
    assert.deepEqual(
      t.answers.map((answer) => answer.notResponse),
      [undefined, undefined, 'repeat-notice'],
    );
  });
}

test('a note written as two text lines of one message stays out of the response on both lines', () => {
  const lines = reportedTurnLines(completionNotice(HANDBACK_FROM, 5));
  const first = assistantAnswer('The plan recorder finished.', 6) as { message: { id: string } };
  const second = assistantAnswer('Nothing else changed.', 6) as { message: { id: string } };
  second.message.id = first.message.id;
  lines.splice(-1, 1, first, second);
  const [t] = readTurns(writeTranscript(lines), 'sess');
  assert.equal(t.summary, REPORT);
  assert.deepEqual(
    t.answers.map((answer) => answer.notResponse),
    [undefined, undefined, 'repeat-notice', 'repeat-notice'],
  );
});

test('a handback queued while the agent works still makes its later completion notice a repeat', () => {
  const [t] = readTurns(
    writeTranscript([
      userPrompt('draw the commit rows', 0),
      assistantTool('Bash', 1, 'tu-shots'),
      toolDone('tu-shots', 2),
      queued(
        {
          commandMode: 'prompt',
          origin: { kind: 'peer', from: 'ad348d57c8a4b16e9', handback: true },
          prompt: '<agent-message from="ad348d57c8a4b16e9">[Subagent hand-back]</agent-message>',
        },
        3,
      ),
      ...thoughtThenSaid('Recommendation A is ready for review.', 4),
      completionNotice('ad348d57c8a4b16e9', 5),
      assistantAnswer('The review round is still running.', 6),
    ]),
    'sess',
  );
  assert.equal(t.summary, 'Recommendation A is ready for review.');
  assert.deepEqual(
    t.answers.map((answer) => answer.notResponse),
    [undefined, 'repeat-notice'],
  );
  assert.deepEqual(t.laterPrompts, [], 'the handback became a prompt');
});

function toolDone(id: string, second: number) {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  };
}

// Completion notices can arrive between the handback and its reply, including while tools run.

function workedHandback(
  from: string,
  notice: (taskId: string, second: number) => object,
  second: number,
  report: string,
) {
  return [
    peerHandback(from, second),
    assistantTool('Bash', second + 1, `tu-git-${from}`),
    toolDone(`tu-git-${from}`, second + 2),
    assistantTool('Agent', second + 3, `tu-review-${from}`, {
      description: 'reviewer',
      subagent_type: 'general-purpose',
    }),
    toolDone(`tu-review-${from}`, second + 4),
    notice(from, second + 5),
    assistantAnswer(report, second + 6),
  ];
}
const queuedNotice = (taskId: string, second: number) =>
  queued({ commandMode: 'task-notification', prompt: completionNoticeText(taskId) }, second);

for (const [shape, notice] of [
  ['wake', completionNotice],
  ['queued', queuedNotice],
] as const) {
  test(`a ${shape} completion notice that arrives while the agent works on the handback leaves the next reply as the response`, () => {
    const [t] = readTurns(
      writeTranscript([
        userPrompt('ship the plan', 0),
        assistantAnswer('The implementer is running.', 1),
        ...workedHandback('impl', notice, 10, 'The candidate commit passed its gate and a reviewer is checking it.'),
        ...workedHandback('plan', notice, 30, 'The cost plan is written.'),
      ]),
      'sess',
    );
    assert.equal(t.summary, 'The cost plan is written.', `${shape} notice`);
    assert.deepEqual(
      t.answers.map((answer) => answer.notResponse),
      [undefined, undefined, undefined],
      `${shape} notice marked a reply to its handback`,
    );
    // With no work between, the notice still arrives before the reply.
    const [bare] = readTurns(
      writeTranscript([
        userPrompt('ship it', 0),
        peerHandback('z', 1),
        notice('z', 2),
        assistantAnswer('The subagent finished.', 3),
      ]),
      'sess',
    );
    assert.equal(bare.summary, 'The subagent finished.', `${shape} notice`);
    assert.equal(bare.answers[0].notResponse, undefined, `${shape} notice`);
  });
}

test('work or a closed reply after a repeat notice ends the repeat', () => {
  // A background-command completion without a handback permits a new response.
  const [plain] = readTurns(
    writeTranscript([
      userPrompt('run the suite in the background', 0),
      assistantAnswer('The suite is running.', 1),
      completionNotice('bash-7', 2),
      assistantAnswer('The suite passed.', 3),
    ]),
    'sess',
  );
  assert.equal(plain.summary, 'The suite passed.');
  const [worked] = readTurns(
    writeTranscript([
      userPrompt('ship it', 0),
      peerHandback('y', 1),
      assistantAnswer('The report.', 2),
      completionNotice('y', 3),
      assistantTool('Bash', 4, 'tu-b'),
      assistantAnswer('A new commit landed after the notice.', 5),
    ]),
    'sess',
  );
  assert.equal(worked.summary, 'A new commit landed after the notice.');
  // A later reply without a recorded wake can become the response.
  const [ticked] = readTurns(
    writeTranscript([
      ...reportedTurnLines(completionNotice(HANDBACK_FROM, 5)),
      assistantAnswer('The loop checked again and phase 4 is ready.', 7),
    ]),
    'sess',
  );
  assert.equal(ticked.summary, 'The loop checked again and phase 4 is ready.');
  assert.deepEqual(
    ticked.answers.map((answer) => answer.notResponse),
    [undefined, undefined, 'repeat-notice', undefined],
  );
});

// A handback's repeated completion notice can arrive in a later turn.

test('a handback from an earlier turn still makes a later completion notice a repeat', () => {
  const taskId = 'aa60c1c303d5a7c96';
  const longReply = 'I recorded the decision and moved the ledger note into docs/design-goals.md.';
  const shortReply = "The title-trigger subagent's background work has now finished too.";
  const lines = [
    // The first turn receives a handback, then its queued completion notice.

    userPrompt('ship the title-trigger change', 0),
    assistantTool('Agent', 1, 'tu-title-agent', { description: 'title trigger', subagent_type: 'general-purpose' }),
    peerHandback(taskId, 2),
    assistantAnswer('The title-trigger subagent handed back its patch.', 3),
    queued({ commandMode: 'task-notification', prompt: completionNoticeText(taskId) }, 4),
    assistantAnswer('Noted, nothing else changed.', 5),
    // The second turn receives the same task's completion notice after its own reply.

    userPrompt('lets not set it ffor now, record the decision instead', 6),
    assistantAnswer(longReply, 7),
    completionNotice(taskId, 8),
    assistantAnswer(shortReply, 9),
  ];
  const turns = readTurns(writeTranscript(lines), 'sess');
  assert.equal(turns.length, 2, 'the typed prompt still opened a second turn');
  const [, turnB] = turns;
  assert.equal(turnB.summary, longReply, "turn B's own report stayed the response");
  assert.deepEqual(
    turnB.answers.map((answer) => answer.notResponse),
    [undefined, 'repeat-notice'],
  );
  const card = toCard(turnB, true, ms(60));
  assert.equal(card.summary, longReply);
  const activityReplies = card.saidMessages
    .filter((message) => message.kind === 'answer')
    .map((message) => message.text);
  assert.deepEqual(activityReplies, [shortReply], 'the repeat note sits in Activity marked repeat-notice');
});

// Work after a closed reply permits a new response even when a repeated completion notice arrives before it.

test('a completion notice queued while the agent works after an unrelated reply leaves the following reply as the response', () => {
  const taskId = 'ux1';
  const finalAnswer = 'The migration finished and every row now carries the new column.';
  const lines = [
    // The first turn receives a handback and closes its reply.
    userPrompt('ship the migration', 0),
    assistantTool('Agent', 1, 'tu-migration-agent', { description: 'migration', subagent_type: 'general-purpose' }),
    peerHandback(taskId, 2),
    assistantAnswer('The migration subagent handed back.', 3),
    // The second turn runs a tool before the repeated notice and final answer.

    userPrompt('run it now', 4),
    assistantAnswer('Starting the migration run.', 5),
    assistantTool('Bash', 6, 'tu-migrate'),
    toolDone('tu-migrate', 7),
    queued({ commandMode: 'task-notification', prompt: completionNoticeText(taskId) }, 8),
    assistantAnswer(finalAnswer, 9),
  ];
  const turns = readTurns(writeTranscript(lines), 'sess');
  assert.equal(turns.length, 2, 'the typed prompt still opened a second turn');
  const [, turnB] = turns;
  assert.deepEqual(
    turnB.answers.map((answer) => answer.notResponse),
    [undefined, undefined],
    'the notice arrived after work done since the last reply, so the reply that followed it answers that work',
  );
  assert.equal(turnB.summary, finalAnswer, "the turn's real final answer stayed the response");
  const card = toCard(turnB, true, ms(60));
  assert.equal(card.summary, finalAnswer);
  const activityReplies = card.saidMessages
    .filter((message) => message.kind === 'answer')
    .map((message) => message.text);
  assert.deepEqual(
    activityReplies,
    ['Starting the migration run.'],
    'the interim reply sits in Activity once, unmarked',
  );
});

test('a turn opened by a repeat notice for an earlier handback keeps that reply as its response', () => {
  const taskId = 'z9';
  const reply = 'Nothing else changed since my last report.';
  const lines = [
    userPrompt('ship it', 0),
    peerHandback(taskId, 1),
    assistantAnswer('The subagent finished.', 2),
    userPrompt('what else is queued', 3),
    completionNotice(taskId, 4),
    assistantAnswer(reply, 5),
  ];
  const turns = readTurns(writeTranscript(lines), 'sess');
  assert.equal(turns.length, 2);
  const [, turnB] = turns;
  assert.equal(turnB.answers.length, 1, "turn B's only reply answered the repeat notice");
  assert.equal(
    turnB.answers[0].notResponse,
    undefined,
    'the turn had no earlier response reply for the notice to repeat',
  );
  assert.equal(turnB.summary, reply, 'a turn whose only reply answers the notice shows that reply as the response');
  const card = toCard(turnB, true, ms(60));
  assert.equal(card.summary, reply);
  const activityReplies = card.saidMessages.filter((message) => message.kind === 'answer');
  assert.deepEqual(activityReplies, [], 'the reply reads once, as the response, never again in Activity');
});

// Without an earlier response, the first reply remains the response. A second repeat-notice reply stays in Activity.

test('a later turn with two repeat notices keeps its first reply as the response', () => {
  const [x, y] = ['x7', 'y8'];
  const firstReply = 'Filed the follow-up for the title-trigger regression.';
  const secondReply = 'Filed the follow-up for the mockup diff too.';
  const lines = [
    userPrompt('ship both fixes', 0),
    peerHandback(x, 1),
    assistantAnswer('The title-trigger subagent handed back.', 2),
    peerHandback(y, 3),
    assistantAnswer('The mockup subagent handed back.', 4),
    userPrompt('file the follow-ups', 5),
    completionNotice(x, 6),
    assistantAnswer(firstReply, 7),
    completionNotice(y, 8),
    assistantAnswer(secondReply, 9),
  ];
  const turns = readTurns(writeTranscript(lines), 'sess');
  assert.equal(turns.length, 2);
  const [, turnB] = turns;
  assert.deepEqual(
    turnB.answers.map((answer) => answer.notResponse),
    [undefined, 'repeat-notice'],
    'the first reply protected no earlier response, the second answered a repeat with one already closed',
  );
  assert.equal(turnB.summary, firstReply);
  const card = toCard(turnB, true, ms(60));
  assert.equal(card.summary, firstReply);
  const activityReplies = card.saidMessages
    .filter((message) => message.kind === 'answer')
    .map((message) => message.text);
  assert.deepEqual(
    activityReplies,
    [secondReply],
    'the first reply reads once, as the response, not again in Activity',
  );
});

test('a handback id survives a parser state restore split between the turn it closed in and the turn that repeats it', () => {
  const taskId = 'aa60c1c303d5a7c96';
  const longReply = 'I recorded the decision.';
  const shortReply = 'The subagent finished too.';
  const records = [
    userPrompt('ship the title-trigger change', 0),
    peerHandback(taskId, 1),
    assistantAnswer('The subagent handed back.', 2),
    userPrompt('record the decision instead', 3),
    assistantAnswer(longReply, 4),
    completionNotice(taskId, 5),
    assistantAnswer(shortReply, 6),
  ];
  const all = createClaudeSessionReducer('sess');
  for (const record of records) {
    all.pushLine(JSON.stringify(record));
  }
  // Save the checkpoint after the first turn's reply and before the second prompt.
  const first = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 3)) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createClaudeSessionReducer('sess', {}, first.snapshot());
  for (const record of records.slice(3)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(resumed.read(), all.read());
  const [, turnB] = resumed.read().turns;
  assert.equal(turnB.summary, longReply);
  assert.deepEqual(
    turnB.answers.map((answer) => answer.notResponse),
    [undefined, 'repeat-notice'],
  );
});

test('a reply of "No response requested." is never the response', () => {
  const [t] = readTurns(
    writeTranscript([
      userPrompt('run the suite in the background', 0),
      assistantAnswer('The report.', 1),
      completionNotice('bash-8', 2),
      assistantAnswer('No response requested.', 3),
    ]),
    'sess',
  );
  assert.equal(t.summary, 'The report.');
  assert.deepEqual(
    t.answers.map((answer) => answer.notResponse),
    [undefined, 'no-response-requested'],
  );
});

test('a turn whose only reply is "No response requested." has no response', () => {
  const [alone] = readTurns(
    writeTranscript([
      userPrompt('run the suite in the background', 0),
      assistantTool('Bash', 1, 'tu-s'),
      toolDone('tu-s', 2),
      completionNotice('bash-9', 3),
      assistantAnswer('No response requested.', 4),
    ]),
    'sess',
  );
  assert.equal(alone.summary, '');
  assert.equal(toCard(alone, true, ms(60)).summary, '');
});

test('"No response requested." in a second text block of the report line does not take the place of the report', () => {
  const line = assistantAnswer('The report.', 2) as { message: { content: object[] } };
  line.message.content.push({ type: 'text', text: 'No response requested.' });
  const [shared] = readTurns(
    writeTranscript([userPrompt('report', 0), assistantAnswer('Working on it.', 1), line]),
    'sess',
  );
  assert.equal(shared.summary, 'The report.');
  assert.deepEqual(
    shared.answers.map((answer) => [answer.text, answer.notResponse]),
    [
      ['Working on it.', undefined],
      ['The report.', undefined],
      ['No response requested.', 'no-response-requested'],
    ],
  );
  const card = toCard(shared, true, ms(60));
  assert.equal(card.summary, 'The report.');
  assert.deepEqual(
    card.saidMessages.filter((message) => message.kind === 'answer').map((message) => message.text),
    ['Working on it.', 'No response requested.'],
  );
});

test('what counts as a closed answer follows the stop the line carries', () => {
  // Text ending with tool_use stays in updates and leaves the earlier closed answer as the summary.

  const running = writeTranscript([
    userPrompt('go', 0),
    assistantAnswer('Answered once.', 1),
    { ...userPrompt('a peer wake', 2), isMeta: true },
    assistantText('Still working on the follow-up.', 3, undefined, undefined, 'tool_use'),
  ]);
  const [live] = readTurns(running, 'sess');
  assert.deepEqual(
    live.answers.map((a) => a.text),
    ['Answered once.'],
  );
  assert.equal(live.summary, 'Answered once.');
  assert.deepEqual(
    live.updates.map((update) => update.text),
    ['Still working on the follow-up.'],
  );
  // stop_sequence closes an answer and marks the turn finished.

  const stopped = writeTranscript([userPrompt('go', 0), assistantAnswer('Cut short but closed.', 1, 'stop_sequence')]);
  assert.deepEqual(
    readTurns(stopped, 'sess')[0].answers.map((a) => a.text),
    ['Cut short but closed.'],
  );
  // The last text block on a closing message supplies its answer and summary.

  const doubled = writeTranscript([
    userPrompt('go', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'm-double',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'half one' },
          { type: 'text', text: 'half two' },
        ],
      },
    },
  ]);
  const [two] = readTurns(doubled, 'sess');
  assert.deepEqual(
    two.answers.map((a) => a.text),
    ['half two'],
  );
  assert.equal(two.summary, 'half two');
  // A turn with one closed answer uses that answer as its summary.
  const plain = writeTranscript([userPrompt('go', 0), assistantAnswer('Done.', 1)]);
  assert.deepEqual(
    readTurns(plain, 'sess')[0].answers.map((a) => a.text),
    ['Done.'],
  );
});

test('Claude tool-use narration is activity while final and undiscriminated text stays response text', () => {
  const file = writeTranscript([
    userPrompt('do it', 0),
    {
      type: 'assistant',
      uuid: 'narration-record',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'message-one',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'I am checking the workspace.' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'fallback-narration',
      timestamp: at(2),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'I am checking the result.' }],
      },
    },
    assistantAnswer('The workspace is clean.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.summary, 'The workspace is clean.');
  assert.deepEqual(
    turn.answers.map((answer) => answer.text),
    ['The workspace is clean.'],
  );
  assert.deepEqual(turn.updates, [
    {
      sourceId: 'message-one:text:0',
      kind: 'commentary',
      text: 'I am checking the workspace.',
      at: ms(1),
      status: 'done',
      stepsBefore: 0,
    },
    {
      sourceId: 'fallback-narration:text:0',
      kind: 'commentary',
      text: 'I am checking the result.',
      at: ms(2),
      status: 'done',
      stepsBefore: 0,
    },
  ]);
  assert.equal(turn.stepCount, 0);
  assert.deepEqual(turn.toolCounts, {
    reads: 0,
    searches: 0,
    edits: 0,
    commands: 0,
    agents: 0,
    coordination: 0,
    web: 0,
    other: 0,
  });

  const [fallback] = readTurns(
    writeTranscript([
      userPrompt('older record', 0),
      {
        ...assistantText('Keep this response.', 1),
        uuid: 'fallback-record',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Keep this response.' }],
        },
      },
    ]),
    'sess',
  );
  assert.equal(fallback.summary, 'Keep this response.');
  assert.deepEqual(fallback.updates, []);
});

test('Claude narration split across records with one message id keeps every text block', () => {
  const shared = (text: string, second: number) => ({
    type: 'assistant',
    uuid: `record-${second}`,
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: 'message-split',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text }],
    },
  });
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('do it', 0),
      shared('Checking the parser.', 1),
      shared('Running its focused test.', 2),
      assistantAnswer('Done.', 3),
    ]),
    'sess',
  );
  assert.deepEqual(
    turn.updates.map((update) => [update.sourceId, update.text]),
    [
      ['message-split:text:0', 'Checking the parser.'],
      ['message-split:text:1', 'Running its focused test.'],
    ],
  );
});

test('empty and signed Claude thinking does not become visible activity', () => {
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('think', 0),
      {
        type: 'assistant',
        uuid: 'thinking-record',
        timestamp: at(1),
        message: {
          role: 'assistant',
          id: 'thinking-message',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [{ type: 'thinking', thinking: '', signature: 'signed-content' }],
        },
      },
    ]),
    'sess',
  );
  assert.deepEqual(turn.updates, []);
  assert.equal(turn.summary, '');
});

test('edits are summed per file and agent scratch files are left out', () => {
  const scratch = path.join(os.tmpdir(), 'claude', 'probe.py');
  const file = writeTranscript([
    userPrompt('change things', 0),
    editResult('c:/repo/a.ts', 1, 10, 2),
    editResult('c:/repo/a.ts', 2, 5, 1),
    editResult('c:/repo/b.ts', 3, 3, 0),
    editResult(scratch, 4, 99, 0),
    {
      type: 'user',
      timestamp: at(5),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] },
      toolUseResult: { filePath: 'c:/repo/new.md', type: 'create', content: 'one\ntwo\nthree', structuredPatch: [] },
    },
    assistantText('Done.', 6),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.files.map((f) => [path.basename(f.path), f.added, f.removed, f.isNew]),
    [
      ['a.ts', 15, 3, false],
      ['b.ts', 3, 0, false],
      ['new.md', 3, 0, true],
    ],
  );
});

test('a turn keeps the patch text each edit recorded, beside the line counts', () => {
  const file = writeTranscript([
    userPrompt('change things', 0),
    {
      type: 'user',
      timestamp: at(1),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
      toolUseResult: {
        filePath: 'c:/repo/a.ts',
        originalFile: 'one\ntwo\n',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [' one', '-two', '+TWO', '\\ No newline at end of file'],
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] },
      toolUseResult: { filePath: 'c:/repo/new.md', type: 'create', content: 'fresh\ntext\n', structuredPatch: [] },
    },
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  const [edited, created] = turn.files;
  // Line counts and creation flags remain available beside retained patch text.
  assert.deepEqual([edited.added, edited.removed, edited.isNew], [1, 1, false]);
  assert.deepEqual([created.added, created.removed, created.isNew], [2, 0, true]);
  assert.equal(edited.edits.length, 1);
  assert.deepEqual(edited.edits[0].hunks, [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [' one', '-two', '+TWO', '\\ No newline at end of file'],
    },
  ]);
  assert.equal(edited.edits[0].originalFile, 'one\ntwo\n');
  assert.equal(edited.edits[0].content, null, 'an Edit records no after side');
  assert.equal(edited.edits[0].isCreate, false);
  assert.deepEqual(created.edits, [
    {
      hunks: [],
      originalFile: null,
      content: 'fresh\ntext\n',
      isCreate: true,
    },
  ]);
});

test('a malformed structured patch keeps the file-level edit without partial patch detail', () => {
  const malformedPatches = [
    null,
    {},
    [null],
    [{}],
    [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }],
    [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: ['\\ No newline at end of file'] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['\\ No newline at end of file', ' old'] }],
    [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [' a', '+x', '\\ No newline at end of file', ' b'],
      },
    ],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+valid'] }, null],
    [{ oldStart: -1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    [{ oldStart: 1, oldLines: 1.5, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    [{ oldStart: '1', oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', 4] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['old', '+new'] }],
    [{ oldStart: 0, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 1, lines: ['-old', '+new'] }],
    [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new'] }],
    [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['\\ another marker'] }],
  ];

  for (const [index, structuredPatch] of malformedPatches.entries()) {
    const [turn] = readTurns(
      writeTranscript([
        userPrompt(`change malformed file ${index}`, 0),
        {
          type: 'user',
          timestamp: at(1),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
          toolUseResult: {
            filePath: `c:/repo/malformed-${index}.ts`,
            type: 'edit',
            originalFile: 'old\n',
            structuredPatch,
          },
        },
        assistantText('Done.', 2),
      ]),
      'sess',
    );

    assert.equal(turn.files.length, 1, `case ${index} keeps the file edit`);
    assert.deepEqual(turn.files[0], {
      path: `c:/repo/malformed-${index}.ts`,
      added: 0,
      removed: 0,
      isNew: false,
      edits: [
        {
          hunks: [],
          originalFile: 'old\n',
          content: null,
          isCreate: false,
          patchInvalid: true,
        },
      ],
    });
  }
});

test('zero-length structured patch sides and complete Write content remain usable', () => {
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('replace an empty file', 0),
      {
        type: 'user',
        timestamp: at(1),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
        toolUseResult: {
          filePath: 'c:/repo/empty.ts',
          originalFile: '',
          structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }],
        },
      },
      {
        type: 'user',
        timestamp: at(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] },
        toolUseResult: {
          filePath: 'c:/repo/write.ts',
          type: 'write',
          originalFile: 'old\n',
          content: 'new\n',
          structuredPatch: null,
        },
      },
      {
        type: 'user',
        timestamp: at(3),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2', content: 'ok' }] },
        toolUseResult: {
          filePath: 'c:/repo/cleared.ts',
          originalFile: 'old\n',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-old'] }],
        },
      },
      assistantText('Done.', 4),
    ]),
    'sess',
  );

  assert.deepEqual(turn.files[0].edits[0], {
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }],
    originalFile: '',
    content: null,
    isCreate: false,
  });
  assert.deepEqual(turn.files[1].edits[0], {
    hunks: [],
    originalFile: 'old\n',
    content: 'new\n',
    isCreate: false,
    patchInvalid: true,
  });
  assert.deepEqual(turn.files[2].edits[0], {
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-old'] }],
    originalFile: 'old\n',
    content: null,
    isCreate: false,
  });
});

// Drive-letter case and separator differences identify the same file within a session.

test('a file written under two drive letter spellings keeps one row', () => {
  const file = writeTranscript([
    userPrompt('create the files, then edit them', 0),
    editResult('c:/repo/demo/notes.md', 1, 2, 0),
    bashEditResult(
      2,
      {
        files: [
          {
            filePath: 'c:\\repo\\demo\\mod1.txt',
            hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }],
          },
        ],
        moreFiles: 1,
        changedFiles: ['c:\\repo\\demo\\mod1.txt', 'c:\\repo\\demo\\mod6.txt'],
      },
      'b1',
    ),
    bashEditResult(
      3,
      {
        files: [
          {
            filePath: 'C:\\repo\\demo\\mod1.txt',
            hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+B'] }],
          },
          {
            filePath: 'C:\\repo\\demo\\notes.md',
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }],
          },
        ],
        moreFiles: 1,
        changedFiles: ['C:\\repo\\demo\\mod1.txt', 'C:\\repo\\demo\\notes.md', 'C:\\repo\\demo\\mod6.txt'],
      },
      'b2',
    ),
    assistantText('Done.', 4),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.files.map((f) => [f.path, f.added, f.removed, f.isNew, f.countsUnknown ?? false, f.edits.length]),
    [
      ['c:/repo/demo/notes.md', 3, 1, false, false, 2],
      ['c:\\repo\\demo\\mod1.txt', 4, 1, true, false, 2],
      ['c:\\repo\\demo\\mod6.txt', 0, 0, false, true, 0],
    ],
  );
});

test('a shell edit reads its file rows the way an edit tool result does', () => {
  const file = writeTranscript([
    userPrompt('port the fix through the shell', 0),
    bashEditResult(1, {
      files: [
        {
          filePath: 'c:/repo/docs/architecture.md',
          hunks: [
            { oldStart: 12, oldLines: 2, newStart: 12, newLines: 3, lines: [' context', '-old', '+new', '+another'] },
          ],
        },
        {
          filePath: 'c:/repo/extension/src/codex.ts',
          hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+brand new'] }],
        },
      ],
      moreFiles: 1,
      changedFiles: [
        'c:/repo/docs/architecture.md',
        'c:/repo/extension/src/codex.ts',
        'c:/repo/extension/src/unlisted.ts',
      ],
    }),
    assistantText('Done.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.files.map((f) => [
      path.basename(f.path),
      f.added,
      f.removed,
      f.isNew,
      f.countsUnknown ?? false,
      f.unknownReason ?? null,
    ]),
    [
      ['architecture.md', 2, 1, false, false, null],
      ['codex.ts', 1, 0, true, false, null],
      ['unlisted.ts', 0, 0, false, true, 'shell'],
    ],
  );
  // Shell file rows retain hunks for per-turn diffs, including created files.

  assert.deepEqual(turn.files[0].edits, [
    {
      hunks: [
        { oldStart: 12, oldLines: 2, newStart: 12, newLines: 3, lines: [' context', '-old', '+new', '+another'] },
      ],
      originalFile: null,
      content: null,
      isCreate: false,
    },
  ]);
  assert.deepEqual(turn.files[1].edits, [
    {
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+brand new'] }],
      originalFile: null,
      content: null,
      isCreate: true,
    },
  ]);
  assert.deepEqual(turn.files[2].edits, []);
});

// A later shell mention without hunks preserves a file's existing line counts.

test('a counted file that a later shell record names again keeps its counts, order A', () => {
  const file = writeTranscript([
    userPrompt('edit then shell-touch the same file', 0),
    editResult('c:/repo/src/store.ts', 1, 2, 1),
    bashEditResult(2, { changedFiles: ['c:/repo/src/store.ts'] }),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.files.map((f) => [path.basename(f.path), f.added, f.removed, f.countsUnknown ?? false]),
    [['store.ts', 2, 1, false]],
  );
});

// An edit adds line counts to an earlier shell mention of the same file.

test('an unlisted shell mention that a later edit details keeps its counts, order B', () => {
  const file = writeTranscript([
    userPrompt('shell-touch then edit the same file', 0),
    bashEditResult(1, { changedFiles: ['c:/repo/src/store.ts'] }),
    editResult('c:/repo/src/store.ts', 2, 2, 1),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.files.map((f) => [path.basename(f.path), f.added, f.removed, f.countsUnknown ?? false]),
    [['store.ts', 2, 1, false]],
  );
});

test('a record naming 53 files beyond its five-file cap lists all 58', () => {
  const detailed = Array.from({ length: 5 }, (_, i) => ({
    filePath: `c:/repo/src/detailed${i}.ts`,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
  }));
  const uncapped = Array.from({ length: 53 }, (_, i) => `c:/repo/src/more${i}.ts`);
  const file = writeTranscript([
    userPrompt('rewrite the whole tree', 0),
    bashEditResult(1, {
      files: detailed,
      moreFiles: 53,
      changedFiles: [...detailed.map((f) => f.filePath), ...uncapped],
    }),
    assistantText('Done.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.files.length, 58);
  assert.equal(turn.files.filter((f) => !f.countsUnknown).length, 5);
});

test('a shell edit under a scratch root reports no rows, named and unnamed alike', () => {
  const scratch = path.join(os.tmpdir(), 'claude', 'scratch.ts');
  const file = writeTranscript([
    userPrompt('run a scratch script', 0),
    bashEditResult(1, {
      files: [
        { filePath: scratch, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] },
      ],
      changedFiles: [scratch],
    }),
    assistantText('Done.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.files, []);
});

test('a created file is counted the way an editor numbers its lines', () => {
  // A trailing newline terminates the last line without adding another line.

  assert.equal(countLines('one\ntwo\nthree'), 3);
  assert.equal(countLines('one\ntwo\n'), 2);
  assert.equal(countLines('one\r\ntwo\r\n'), 2);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines(''), 0, 'an empty file has no lines');
});

test('a subagent is listed once, and its launch row is filled in by its result', () => {
  const file = writeTranscript([
    userPrompt('delegate this', 0),
    assistantTool('Agent', 1, 'a1', { description: 'Audit the parser', subagent_type: 'Explore' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'done' }] },
      toolUseResult: {
        status: 'completed',
        description: 'Audit the parser',
        agentType: 'Explore',
        agentId: 'child-1',
        resolvedModel: 'claude-haiku-4-5',
        totalDurationMs: 109000,
        totalTokens: 70000,
        totalToolUseCount: 20,
      },
    },
    assistantText('Delegated and back.', 3),
  ]);
  const spend = [
    {
      model: 'claude-haiku-4-5',
      usage: { input: 1, cacheWrite1h: 2, cacheWrite5m: 3, cacheRead: 4, output: 5, thinking: 1 },
    },
  ];
  const [turn] = readTurns(file, 'sess', {
    agentSpendOf: (agent) => ({
      models: agent.id === 'child-1' ? spend : [],
      found: agent.id === 'child-1',
      partial: false,
      effort: agent.id === 'child-1' ? 'high' : null,
    }),
    agentSessionTargetOf: (agent) => (agent.id === 'child-1' && agent.toolUseId === 'a1' ? agent.id : null),
  });
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.steps[0].id, 'a1');
  assert.equal(turn.agents[0].toolUseId, 'a1');
  assert.ok(!Object.keys(turn.steps[0]).includes('id'));
  assert.ok(!Object.keys(turn.agents[0]).includes('toolUseId'));
  assert.deepEqual(turn.agents[0], {
    id: 'child-1',
    description: 'Audit the parser',
    agentType: 'Explore',
    model: 'claude-haiku-4-5',
    effort: 'high',
    spend,
    spendFound: true,
    spendPartial: false,
    durationMs: 109000,
    tokens: 70000,
    toolUses: 20,
    status: 'completed',
    childSessionId: 'child-1',
  });
});

test('Claude child navigation requires a launch and result identity pair', () => {
  const file = writeTranscript([
    userPrompt('result without its launch', 0),
    {
      type: 'user',
      timestamp: at(1),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing-call', content: 'done' }] },
      toolUseResult: { agentId: 'child-1', description: 'Audit the parser', totalToolUseCount: 2, status: 'completed' },
    },
    assistantText('Done.', 2),
  ]);
  const [turn] = readTurns(file, 'sess', { agentSessionTargetOf: () => 'child-1' });
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.agents[0].childSessionId, undefined);
});

test('a selected Claude child reads its sidechain prompt, edits, and response', () => {
  const file = writeTranscript([
    { ...userPrompt('inspect the parser', 0), isSidechain: true, agentId: 'child-1', cwd: 'c:/repo' },
    { ...assistantTool('Edit', 1, 'edit-1', { file_path: 'c:/repo/parser.ts' }), isSidechain: true },
    {
      type: 'user',
      isSidechain: true,
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'ok' }] },
      toolUseResult: {
        filePath: 'c:/repo/parser.ts',
        originalFile: 'old\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      },
    },
    {
      ...assistantText(
        'Child complete.',
        3,
        {
          input_tokens: 17,
          cache_read_input_tokens: 230,
          cache_creation_input_tokens: 40,
          output_tokens: 19,
        },
        undefined,
        'end_turn',
      ),
      isSidechain: true,
    },
  ]);
  const read = readSession(file, 'child-1', { childTranscript: true });
  assert.equal(read.turns[0].prompt, 'inspect the parser');
  assert.equal(read.turns[0].summary, 'Child complete.');
  assert.deepEqual(
    read.turns[0].files.map((entry) => entry.path),
    ['c:/repo/parser.ts'],
  );
  assert.deepEqual(read.turns[0].usage, {
    requests: 1,
    input: 17,
    cacheWrite1h: 40,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 230,
    output: 19,
    thinking: 0,
  });
  assert.equal(read.turns[0].contextTokens, 287);
});

// Nested Agent results in child transcripts carry text without toolUseResult.

const nestedForegroundResult = (agentId: string, tokens: number, tools: number, took: number) =>
  `  This agent's report was delivered to you as a message from "${agentId}" (its SubagentHandback call). ` +
  `Read it there; it is not repeated here.\n  \nagentId: ${agentId} (use SendMessage with to: '${agentId}', ` +
  `summary: '<5-10 word recap>' to continue this agent)\n` +
  `<usage>subagent_tokens: ${tokens}\ntool_uses: ${tools}\nduration_ms: ${took}</usage>`;
const nestedForegroundResultWithoutFigures = (agentId: string) =>
  `  This agent's report was delivered to you as a message from "${agentId}" (its SubagentHandback call). ` +
  'Read it there; it is not repeated here.\n  ';
// A report whose own last line looks like the id line. With no `<usage>` block after it, the
// line is report text and names no child.
const nestedReportEndingOnAnId = 'Report only\nagentId: unrelated-child';
const nestedBackgroundResult = (agentId: string) =>
  'Async agent launched successfully. (This tool result is internal metadata.)\n' +
  `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to continue this agent.)\n` +
  'The agent is working in the background. You will be notified automatically when it completes.';
// This child result identifies its own agent at the top level.
function nestedResult(toolUseId: string, second: number, text: string | string[], isError = false) {
  const blocks = (Array.isArray(text) ? text : [text]).map((part) => ({ type: 'text', text: part }));
  return {
    type: 'user',
    isSidechain: true,
    agentId: 'child-1',
    timestamp: at(second),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, ...(isError ? { is_error: true } : {}), content: blocks },
      ],
    },
  };
}
const nestedRows = (file: string) =>
  readSession(file, 'child-1', { childTranscript: true }).turns[0].agents.map(
    ({ id, description, status, tokens, toolUses, durationMs }) => ({
      id,
      description,
      status,
      tokens,
      toolUses,
      durationMs,
    }),
  );

test('a Claude child closes a nested subagent row when its foreground launch returns', () => {
  const file = writeTranscript([
    { ...userPrompt('launch two nested agents', 0), isSidechain: true, cwd: 'c:/repo' },
    {
      ...assistantTool('Agent', 1, 'launch-b', { description: 'Nested B', model: 'haiku', run_in_background: false }),
      isSidechain: true,
    },
    nestedResult('launch-b', 2, nestedForegroundResult('adf3e8d2cb8d606c4', 28814, 2, 19553)),
    { ...assistantTool('Agent', 3, 'launch-d', { description: 'Nested D', model: 'haiku' }), isSidechain: true },
    nestedResult('launch-d', 4, nestedForegroundResultWithoutFigures('a76cc0a85b2dbe57c')),
    { ...assistantTool('Agent', 5, 'launch-e', { description: 'Nested E' }), isSidechain: true },
    nestedResult('launch-e', 6, nestedReportEndingOnAnId),
    { ...assistantAnswer('The nested agents finished.', 7), isSidechain: true },
  ]);
  assert.deepEqual(nestedRows(file), [
    {
      id: 'adf3e8d2cb8d606c4',
      description: 'Nested B',
      status: 'completed',
      tokens: 28814,
      toolUses: 2,
      durationMs: 19553,
    },
    { id: null, description: 'Nested D', status: 'completed', tokens: null, toolUses: null, durationMs: null },
    { id: null, description: 'Nested E', status: 'completed', tokens: null, toolUses: null, durationMs: null },
  ]);
});

test('a Claude child reads a foreground result whose report and figures sit in separate blocks', () => {
  const file = writeTranscript([
    { ...userPrompt('launch a nested agent', 0), isSidechain: true, cwd: 'c:/repo' },
    { ...assistantTool('Agent', 1, 'launch-sweep', { description: 'Nested sweep' }), isSidechain: true },
    nestedResult('launch-sweep', 2, [
      'All done. The sweep found nothing else.\n\nagentId: in the report is not the id line.',
      "agentId: a6dc23d1b0eaed94d (use SendMessage with to: 'a6dc23d1b0eaed94d', summary: '<5-10 word recap>' to continue this agent)\n" +
        '<usage>subagent_tokens: 63920\ntool_uses: 57\nduration_ms: 221257</usage>',
    ]),
    { ...assistantAnswer('The sweep finished.', 3), isSidechain: true },
  ]);
  assert.deepEqual(nestedRows(file), [
    {
      id: 'a6dc23d1b0eaed94d',
      description: 'Nested sweep',
      status: 'completed',
      tokens: 63920,
      toolUses: 57,
      durationMs: 221257,
    },
  ]);
});

test('a Claude child keeps a background nested subagent row open until its completion notice', () => {
  const records = [
    { ...userPrompt('launch a background nested agent', 0), isSidechain: true, cwd: 'c:/repo' },
    { ...assistantTool('Agent', 1, 'launch-bg', { description: 'Nested scan' }), isSidechain: true },
    nestedResult('launch-bg', 2, nestedBackgroundResult('a17339eacb3e8a85d')),
    { ...assistantAnswer('The scan runs in the background.', 3), isSidechain: true },
  ];
  assert.deepEqual(
    nestedRows(writeTranscript(records)).map((row) => [row.id, row.status]),
    [['a17339eacb3e8a85d', 'running']],
  );
  const notice = queued(
    {
      commandMode: 'task-notification',
      prompt:
        '<task-notification><task-id>a17339eacb3e8a85d</task-id><tool-use-id>launch-bg</tool-use-id>' +
        '<status>completed</status><usage><subagent_tokens>900</subagent_tokens><tool_uses>4</tool_uses>' +
        '<duration_ms>1200</duration_ms></usage></task-notification>',
    },
    4,
  );
  assert.deepEqual(nestedRows(writeTranscript([...records, notice])), [
    {
      id: 'a17339eacb3e8a85d',
      description: 'Nested scan',
      status: 'completed',
      tokens: 900,
      toolUses: 4,
      durationMs: 1200,
    },
  ]);
});

test('a Claude child does not finish a nested subagent row whose launch failed', () => {
  const file = writeTranscript([
    { ...userPrompt('launch a nested agent', 0), isSidechain: true, cwd: 'c:/repo' },
    { ...assistantTool('Agent', 1, 'launch-denied', { description: 'Nested audit' }), isSidechain: true },
    nestedResult('launch-denied', 2, "Agent type 'general' not found.", true),
    { ...assistantAnswer('The launch failed.', 3), isSidechain: true },
  ]);
  const [row] = nestedRows(file);
  assert.notEqual(row.status, 'completed');
  assert.deepEqual([row.id, row.tokens, row.toolUses, row.durationMs], [null, null, null, null]);
  assert.deepEqual(
    readSession(file, 'child-1', { childTranscript: true }).turns[0].failures.map((failure) => failure.tool),
    ['Agent'],
  );
});

test("a child's own edit calls carry the cause `pendingFileEdit` read off each tool's input", () => {
  // Child file causes come from tool inputs. Write, replace_all, and notebook replacement omit measurable prior content.

  // Equal Edit strings produce the zero cause.

  const file = writeTranscript([
    { ...userPrompt('rewrite the config', 0), isSidechain: true, agentId: 'child-2', cwd: 'c:/repo' },
    { ...assistantTool('Write', 1, 'w1', { file_path: 'c:/repo/config.ts', content: 'export {}' }), isSidechain: true },
    { ...toolResult('w1', 2), isSidechain: true },
    {
      ...assistantTool('Edit', 3, 'e1', {
        file_path: 'c:/repo/all.ts',
        old_string: 'a',
        new_string: 'b',
        replace_all: true,
      }),
      isSidechain: true,
    },
    { ...toolResult('e1', 4), isSidechain: true },
    {
      ...assistantTool('NotebookEdit', 5, 'n1', {
        notebook_path: 'c:/repo/nb.ipynb',
        new_source: 'print(1)',
        edit_mode: 'replace',
      }),
      isSidechain: true,
    },
    { ...toolResult('n1', 6), isSidechain: true },
    {
      ...assistantTool('Edit', 7, 'e2', {
        file_path: 'c:/repo/same.ts',
        old_string: 'unchanged\n',
        new_string: 'unchanged\n',
      }),
      isSidechain: true,
    },
    { ...toolResult('e2', 8), isSidechain: true },
    { ...assistantText('Done.', 9), isSidechain: true },
  ]);
  const read = readSession(file, 'child-2', { childTranscript: true });
  assert.deepEqual(
    read.turns[0].files.map((f) => [path.basename(f.path), f.countsUnknown ?? false, f.unknownReason ?? null]),
    [
      ['config.ts', true, 'write'],
      ['all.ts', true, 'replaceAll'],
      ['nb.ipynb', true, 'notebook'],
      ['same.ts', true, 'zero'],
    ],
  );
});

test('Claude child metadata, title, and turn starts read sidechain records as the selected session', () => {
  const file = writeTranscript([
    { ...userPrompt('inspect child metadata', 4), isSidechain: true, cwd: 'c:/repo' },
    { ...assistantAnswer('Child complete.', 5), isSidechain: true },
  ]);
  assert.equal(readSessionMeta(file, 256 * 1024, '', true).title, 'inspect child metadata');
  assert.deepEqual(readSessionTurnStarts(file, undefined, true), { starts: [ms(4)], whole: true });
  const meta = readSessionMeta(file, 256 * 1024, 'child-1', true);
  assert.equal(meta.title, 'inspect child metadata');
  assert.equal(meta.agentRun, true);
  assert.equal(meta.outcome?.finished, true);
  assert.equal(meta.stats?.turns.length, 1);
});

test('verified Claude children survive old parent history and accept a registered sibling worktree', () => {
  const root = tempDir('claude-child-catalog-');
  const parentId = 'parent-1';
  const parent = path.join(root, `${parentId}.jsonl`);
  const childDir = path.join(root, parentId, 'subagents');
  const child = path.join(childDir, 'agent-child-1.jsonl');
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(
    parent,
    [
      assistantTool('Agent', 1, 'launch-1', { description: 'Inspect history' }),
      {
        type: 'user',
        timestamp: at(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-1', content: 'done' }] },
        toolUseResult: { agentId: 'child-1', status: 'completed', totalToolUseCount: 2 },
      },
      { type: 'progress', data: 'x'.repeat(300_000) },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  fs.writeFileSync(
    child,
    JSON.stringify({ ...userPrompt('child prompt', 3), isSidechain: true, cwd: 'd:/trees/topic' }) + '\n',
  );

  const references = readClaudeChildSessionReferences({ file: parent, sessionId: parentId });
  const sessions = claudeChildSessionFiles(references, ['c:/repo/main', 'd:/trees/topic']);
  assert.deepEqual(
    sessions.map((session) => ({
      id: session.sessionId,
      parent: session.parentSessionId,
      cwd: session.cwd,
      agentRun: session.agentRun,
      childTranscript: session.childTranscript,
      toolUseIds: session.toolUseIds,
    })),
    [
      {
        id: 'child-1',
        parent: parentId,
        cwd: 'd:/trees/topic',
        agentRun: true,
        childTranscript: true,
        toolUseIds: ['launch-1'],
      },
    ],
  );
  assert.deepEqual(
    claudeChildSessionFiles(references, ['c:/repo/main']),
    [],
    'an existing child outside the registered repository scope remains unavailable',
  );
});

test('a Claude shell launch resolves one dispatch reference through the existing catalog', () => {
  const parentId = 'parent-dispatch';
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const parent = writeTranscript(
    claudeDispatchTranscript('claude --bg "review the branch"', 'backgrounded · 4f4bf298 · Review the branch'),
  );
  const childFile = path.join(path.dirname(parent), `${childId}.jsonl`);
  const stat = fs.statSync(parent);
  const catalog = [
    {
      agent: 'claude' as const,
      file: childFile,
      sessionId: childId,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    },
  ];
  const scanned = readClaudeChildSessionReferences({ file: parent, sessionId: parentId });
  assert.deepEqual(readSession(parent, parentId).turns[0]?.dispatchToolUseIds, ['dispatch-1']);
  const references = resolveClaudeDispatchReferences(scanned, catalog);
  assert.deepEqual(references, [
    {
      kind: 'dispatch',
      agent: 'claude',
      parentSessionId: parentId,
      sessionId: childId,
      file: childFile,
      toolUseIds: ['dispatch-1'],
      name: 'Review the branch',
      owned: false,
    },
  ]);
  assert.deepEqual(
    resolveClaudeDispatchReferences(readClaudeChildSessionReferences({ file: parent, sessionId: parentId }), catalog),
    references,
    'reading the same parent again duplicated its dispatch edge',
  );
});

// A receipt without `owned` links a child the reader did not ask for, and `"owned":true`
// links one the reader did.
test('opted-in wrappers resolve a named full ID and an unnamed unique prefix', () => {
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const session = {
    agent: 'claude' as const,
    file: `C:/sessions/${childId}.jsonl`,
    sessionId: childId,
    mtimeMs: 1,
    size: 1,
  };
  for (const [command, id, name, owned] of [
    ['python C:/tools/reviewer.py --arc-dispatch task.md', childId, 'Review branch', false],
    ['C:/tools/launch-review --arc-dispatch task.md', childId.slice(0, 8), null, false],
    ['python C:/tools/dispatch.py --arc-dispatch --attach task.md', childId, 'Ship it', true],
  ] as const) {
    const receipt = `ARC_DISPATCH_SESSION=${JSON.stringify({
      agent: 'claude',
      session_id: id,
      ...(name ? { name } : {}),
      ...(owned ? { owned } : {}),
    })}`;
    const parent = writeTranscript(claudeDispatchTranscript(command, `Started\n${receipt}\nFinished`));
    const scanned = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
    assert.deepEqual(scanned, [
      {
        kind: 'dispatch',
        agent: 'claude',
        parentSessionId: 'parent',
        sessionId: id,
        file: null,
        toolUseIds: ['dispatch-1'],
        name,
        owned,
      },
    ]);
    assert.deepEqual(resolveClaudeDispatchReferences(scanned, [session]), [
      {
        ...scanned[0],
        sessionId: childId,
        file: session.file,
      },
    ]);
    assert.deepEqual(resolveClaudeDispatchReferences(scanned, []), [], 'an unknown child became a link');
    if (id.length === 8) {
      assert.deepEqual(
        resolveClaudeDispatchReferences(scanned, [
          session,
          { ...session, sessionId: '4f4bf298-1111-1111-1111-111111111111' },
        ]),
        [],
        'an ambiguous prefix became a link',
      );
    }
    assert.deepEqual(readSession(parent, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1']);
  }
});

test('standalone receipts retain delegated and reader ownership in Claude parents', () => {
  const id = '4f4bf298-958f-4751-8782-d8688ff808a6';
  for (const agent of ['claude', 'codex'])
    for (const flags of ['', '--agent-run', '--agent-run=true', '--agent-run=false', '--attach --agent-run']) {
      const delegated = flags.includes('--agent-run') && !flags.includes('false') && !flags.includes('--attach');
      const marker = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent, session_id: id, name: 'Review', ...(!delegated ? { owned: true } : {}) })}`;
      const command = `arc run --arc-dispatch --provider ${agent} ${flags}`;
      const parent = writeTranscript(
        claudeDispatchTranscript(command, JSON.stringify({ state: 'starting' }) + '\n' + marker),
      );
      const [edge] = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
      assert.equal(edge.kind, 'dispatch');
      if (edge.kind !== 'dispatch') throw new Error('The standalone session has no dispatch relationship.');
      assert.equal(edge.sessionId, id);
      assert.equal(edge.owned, !delegated);
      assert.equal(agentRunAnswer(true, id, new Set(), false, true, edge.owned), delegated);
      assert.equal(agentRunAnswer(false, id, new Set(), true, true, edge.owned), true);
      const missing = writeTranscript(claudeDispatchTranscript(command, JSON.stringify({ state: 'starting' })));
      assert.deepEqual(readClaudeChildSessionReferences({ file: missing, sessionId: 'parent' }), []);
    }
});

test('opted-in wrapper receipts reject malformed, oversized, duplicate, and conflicting lines', () => {
  const id = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const good = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id })}`;
  for (const output of [
    'ARC_DISPATCH_SESSION={bad json}',
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'unknown', session_id: id })}`,
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: '4f4bf298-958f' })}`,
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id, extra: true })}`,
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id, name: 4 })}`,
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id, owned: 'yes' })}`,
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id, owned: false })}`,
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id, owned: true, asked: true })}`,
    `${good}${' '.repeat(4096)}`,
    `${good}\n${good}`,
    `${good}\nARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id.slice(0, 8) })}`,
    `${good}\nARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: 'aaaaaaaa-1111-1111-1111-111111111111', extra: true })}`,
    `> ${good}`,
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript('python arbitrary.py --arc-dispatch', output));
    assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' }), [], output.slice(0, 80));
  }
});

// A command that chains two opted-in launches prints a receipt for each, and both children
// link to the one Bash call.
test('two receipts that name two sessions link both children', () => {
  const first = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const second = 'aaaaaaaa-1111-1111-1111-111111111111';
  const receipt = (fields: Record<string, unknown>) => `ARC_DISPATCH_SESSION=${JSON.stringify(fields)}`;
  const parent = writeTranscript(
    claudeDispatchTranscript(
      'python dispatch.py --arc-dispatch one.md && python dispatch.py --arc-dispatch two.md',
      [
        receipt({ agent: 'claude', session_id: first, name: 'First' }),
        'started',
        receipt({ agent: 'claude', session_id: second, owned: true }),
      ].join('\n'),
    ),
  );
  const launch = {
    kind: 'dispatch',
    agent: 'claude',
    parentSessionId: 'parent',
    file: null,
    toolUseIds: ['dispatch-1'],
  };
  assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' }), [
    { ...launch, sessionId: first, name: 'First', owned: false },
    { ...launch, sessionId: second, name: null, owned: true },
  ]);
});

// Relayed output can contain unrelated receipts. The number of receipts must fit the command's opted-in launches.

test('receipts beyond the opted-in launches of a command link nothing', () => {
  const receipt = (session: string) =>
    `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: session })}`;
  const orchestrator = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const worker = 'aaaaaaaa-1111-1111-1111-111111111111';
  const relayed = [receipt(orchestrator), 'Orchestrator reply:', `  worker said:`, receipt(worker)].join('\n');
  for (const command of [
    'python dispatch.py --arc-dispatch plan.md',
    'cat prompt.md && python dispatch.py --arc-dispatch prompt.md',
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, relayed));
    assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' }), [], command);
  }
  const many = Array.from({ length: 5000 }, (_, at) => receipt(`${at.toString(16).padStart(8, '0')}-1111`)).join('\n');
  const flood = writeTranscript(
    claudeDispatchTranscript('python a.py --arc-dispatch && python b.py --arc-dispatch', many),
  );
  assert.deepEqual(readClaudeChildSessionReferences({ file: flood, sessionId: 'parent' }), []);
});

// A result exceeding the receipt limit links nothing, even with enough opted-in launches.

test('a result with more receipts than the per-result limit links nothing, whatever its launch count', () => {
  const linked = (count: number) => {
    const ids = Array.from(
      { length: count },
      (_, at) => `${at.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`,
    );
    const command = ids.map((_, at) => `python dispatch.py --arc-dispatch ${at}.md`).join(' && ');
    const output = ids
      .map((id) => `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id })}`)
      .join('\n');
    return readClaudeChildSessionReferences({
      file: writeTranscript(claudeDispatchTranscript(command, output)),
      sessionId: 'parent',
    }).length;
  };
  assert.equal(linked(MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT), MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT);
  assert.equal(linked(MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT + 1), 0, 'a result past the limit linked receipts');
  assert.equal(
    linked(MAX_CLAUDE_CHILD_REFERENCES_PER_FILE + 1),
    0,
    'a result linked more receipts than the derived session cache keeps for one parent',
  );
});

// A parent retains its first references up to the shared per-file limit, across subagents and dispatches.

test('a parent past the per-file reference limit keeps the children it linked first', () => {
  const receipts = MAX_CLAUDE_DISPATCH_RECEIPTS_PER_RESULT;
  const dispatched = (result: number) => {
    const ids = Array.from(
      { length: receipts },
      (_, at) => `${(result * receipts + at).toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`,
    );
    return claudeDispatchTranscript(
      ids.map((_, at) => `python dispatch.py --arc-dispatch ${at}.md`).join(' && '),
      ids.map((id) => `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: id })}`).join('\n'),
      `dispatch-${result}`,
    );
  };
  const subagent = (at: number) => [
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `agent-${at}`, name: 'Agent', input: {} }] },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `agent-${at}`, content: 'done' }] },
      toolUseResult: { agentId: `sub${at}` },
    },
  ];
  const scan = (records: object[]) =>
    readClaudeChildSessionReferences({ file: writeTranscript(records), sessionId: 'parent' }).map(
      (reference) => `${reference.kind}:${reference.sessionId}`,
    );
  const full = Array.from({ length: MAX_CLAUDE_CHILD_REFERENCES_PER_FILE / receipts }, (_, at) =>
    dispatched(at),
  ).flat();
  const before = scan(full);
  assert.equal(before.length, MAX_CLAUDE_CHILD_REFERENCES_PER_FILE, 'the fixture did not fill the per-file limit');
  assert.deepEqual(scan([...full, ...subagent(0)]), before, 'a subagent that arrived at the limit evicted a dispatch');

  const subagents = Array.from({ length: MAX_CLAUDE_CHILD_REFERENCES_PER_FILE + 1 }, (_, at) => subagent(at)).flat();
  const linked = scan([...subagents, ...dispatched(0)]);
  assert.equal(
    linked.length,
    MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
    'a parent of subagents and dispatches kept more references than the derived session cache keeps',
  );
  assert.ok(
    linked.every((reference, at) => reference === `subagent:sub${at}`),
    'the parent did not keep the children it named first',
  );
});

test('receipt lines need a standalone opt-in argument and a paired Bash result', () => {
  const receipt = 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"4f4bf298"}';
  for (const command of [
    'python arbitrary.py task.md',
    'python arbitrary.py --arc-dispatch-extra',
    'grep "--arc-dispatch" transcript.jsonl',
    'cat transcript.jsonl',
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, receipt));
    assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' }), [], command);
    assert.deepEqual(readSession(parent, 'parent').turns[0]?.dispatchToolUseIds ?? [], [], command);
  }
  // A receipt names its own session, so a second opted-in launch that printed none leaves it
  // linked. A direct launch beside an opted-in one prints no receipt, so neither links.
  const chained = writeTranscript(
    claudeDispatchTranscript('python first.py --arc-dispatch && python second.py --arc-dispatch', receipt),
  );
  assert.deepEqual(
    readClaudeChildSessionReferences({ file: chained, sessionId: 'parent' }).map((reference) => reference.sessionId),
    ['4f4bf298'],
  );
  const mixed = writeTranscript(
    claudeDispatchTranscript('python first.py --arc-dispatch && claude --bg "review"', receipt),
  );
  assert.deepEqual(readClaudeChildSessionReferences({ file: mixed, sessionId: 'parent' }), []);
});

test('a receipt from a different Bash result does not link', () => {
  const records = claudeDispatchTranscript(
    'python arbitrary.py --arc-dispatch',
    'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"4f4bf298"}',
  );
  const result = records[2] as { message: { content: Array<{ tool_use_id: string }> } };
  result.message.content[0].tool_use_id = 'other-call';
  const unpaired = writeTranscript(records);
  assert.deepEqual(readClaudeChildSessionReferences({ file: unpaired, sessionId: 'parent' }), []);
});

test('a wrapper receipt needs structured Bash stdout', () => {
  const receipt = 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"4f4bf298"}';
  for (const stdout of [undefined, '']) {
    const records = claudeDispatchTranscript('python arbitrary.py --arc-dispatch', receipt);
    const result = records[2] as { toolUseResult: { stdout?: string } };
    if (stdout === undefined) {
      delete result.toolUseResult.stdout;
    } else {
      result.toolUseResult.stdout = stdout;
    }
    const parent = writeTranscript(records);
    assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' }), []);
  }
});

test('two native Claude launches keep the first reported child', () => {
  const records = claudeDispatchTranscript(
    'claude --bg first && claude --bg second',
    'backgrounded · 4f4bf298 · First child',
  );
  const parent = writeTranscript(records);
  assert.equal(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' })[0]?.sessionId, '4f4bf298');
  assert.deepEqual(readSession(parent, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1']);
});

test('an opted-in wrapper keeps its launch ID after activity steps are bounded', () => {
  const receipt = 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"4f4bf298"}';
  const records = claudeDispatchTranscript('python arbitrary.py --arc-dispatch', receipt);
  for (let index = 0; index < TURN_STEP_LIMIT + 1; index++) {
    records.push(assistantTool('Bash', index + 3, `later-${index}`, { command: 'echo later' }));
  }
  const parent = writeTranscript(records);
  const turn = readSession(parent, 'parent').turns[0];
  assert.equal(
    turn?.steps.some((step) => step.sourceId === 'dispatch-1'),
    false,
  );
  assert.deepEqual(turn?.dispatchToolUseIds, ['dispatch-1']);
  assert.equal(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' }).length, 1);
});

// Running child revisions change on each write. Parent render keys and spend reads advance once per cache band.

test('a running child moves its parent render key and its spend read once a band, not once a write', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const child = writeTranscript([
      userPrompt('Inspect', 0),
      assistantText('Reading', 1, { input_tokens: 100, output_tokens: 10 }),
    ]);
    const stamp = () => {
      const now = new Date(Date.now());
      fs.utimesSync(child, now, now);
    };
    stamp();
    const turns = (status: string) =>
      [
        { agents: [{ id: 'child', description: 'Inspect', agentType: null, status, toolUseId: 'call' }] },
      ] as unknown as Parameters<typeof agentSpendDependencyKey>[0];
    const key = (status: string) =>
      agentSpendDependencyKey(
        turns(status),
        () => child,
        (file) => childSpendVersion('claude', file),
        '',
        [],
        Date.now(),
      );
    const cache = new AgentSpendCache();
    let reads = 0;
    const read = () =>
      readChildSpend(
        cache,
        child,
        'running',
        childSpendVersion('claude', child),
        (file) => {
          reads++;
          return readClaudeAgentSpend(file, [], true);
        },
        '',
        true,
        Date.now(),
      );
    const first = read();
    let drawn = key('running');
    let revision = childSpendVersion('claude', child);
    let writes = 0;
    let repaints = 0;
    let revisionMoves = 0;
    let latest = first;
    const writer = setInterval(() => {
      fs.appendFileSync(
        child,
        JSON.stringify(assistantText('Working', 2, { input_tokens: 100, output_tokens: 10 })) + '\n',
      );
      stamp();
      writes++;
      const version = childSpendVersion('claude', child);
      if (version !== revision) {
        revision = version;
        revisionMoves++;
      }
      const next = key('running');
      if (next !== drawn) {
        drawn = next;
        repaints++;
      }
      latest = read();
    }, 250);
    vi.advanceTimersByTime(60_000);
    clearInterval(writer);
    const bands = 60_000 / OPEN_SPEND_BAND_MS;
    assert.deepEqual(
      { writes, revisionMoves, repaints, reads },
      { writes: 240, revisionMoves: 240, repaints: bands, reads: 1 + bands },
    );
    // The latest band read includes additional child usage.
    assert.ok(spendTokens(latest.models) > spendTokens(first.models));
    assert.equal(latest.artifacts, undefined, 'a running child showed its files or commits');
    // A finished child uses its exact revision key.
    assert.match(key('completed'), new RegExp(`${revision.split('\n')[0]}$`));
  } finally {
    vi.useRealTimers();
  }
});

// The cache band grows with the total bytes read from a child and its nested transcripts.

test('a running child that grows to 20 MB parses about 1 MB a second at most', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const child = writeTranscript([userPrompt('Inspect', 0)]);
    const stamp = () => {
      const now = new Date(Date.now());
      fs.utimesSync(child, now, now);
    };
    const turns = [
      { agents: [{ id: 'child', description: 'Inspect', agentType: null, status: 'running', toolUseId: 'call' }] },
    ] as unknown as Parameters<typeof agentSpendDependencyKey>[0];
    const cache = new AgentSpendCache();
    let reads = 0;
    let parsed = 0;
    let repaints = 0;
    let drawn = '';
    // The loader charges file size without parsing content.
    const load = (file: string) => {
      reads++;
      parsed += fs.statSync(file).size;
      return { models: [], found: true, partial: false, effort: null };
    };
    const elapsed = 40 * 60_000;
    const target = 20_000_000;
    let writes = 0;
    // Write and poll every 2.5 seconds.
    const writer = setInterval(() => {
      writes++;
      fs.truncateSync(child, Math.round((target * writes) / (elapsed / 2_500)));
      stamp();
      const now = Date.now();
      const key = agentSpendDependencyKey(
        turns,
        () => child,
        (file) => childSpendVersion('claude', file),
        '',
        [],
        now,
      );
      if (key !== drawn) {
        drawn = key;
        repaints++;
      }
      readChildSpend(cache, child, 'running', childSpendVersion('claude', child), load, '', true, now);
    }, 2_500);
    vi.advanceTimersByTime(elapsed);
    clearInterval(writer);
    const measured = `${writes} writes, ${reads} reads, ${repaints} repaints, ${parsed} bytes parsed`;
    assert.equal(fs.statSync(child).size, target, measured);
    assert.ok(parsed <= elapsed * OPEN_SPEND_BYTES_PER_MS, measured);
    assert.ok(repaints <= elapsed / OPEN_SPEND_BAND_MS, measured);
  } finally {
    vi.useRealTimers();
  }
});

// A background child can finish before its parent records completion. A full quiet band changes its key to the exact revision.

test('a background child that goes quiet without a completion notice reaches its final cost', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const child = writeTranscript([
      userPrompt('Inspect', 0),
      assistantText('Reading', 1, { input_tokens: 100, output_tokens: 10 }),
    ]);
    const stamp = () => {
      const now = new Date(Date.now());
      fs.utimesSync(child, now, now);
    };
    stamp();
    const turns = [
      {
        agents: [{ id: 'child', description: 'Inspect', agentType: null, status: 'async_launched', toolUseId: 'call' }],
      },
    ] as unknown as Parameters<typeof agentSpendDependencyKey>[0];
    const cache = new AgentSpendCache();
    let reads = 0;
    let drawn = '';
    let shown = 0;
    // One host poll: a moved key starts one worker read, and both take one clock reading.
    const poll = () => {
      const now = Date.now();
      const key = agentSpendDependencyKey(
        turns,
        () => child,
        (file) => childSpendVersion('claude', file),
        '',
        [],
        now,
      );
      if (key === drawn) {
        return;
      }
      drawn = key;
      shown = spendTokens(
        readChildSpend(
          cache,
          child,
          'async_launched',
          childSpendVersion('claude', child),
          (file) => {
            reads++;
            return readClaudeAgentSpend(file, [], true);
          },
          '',
          true,
          now,
        ).models,
      );
    };
    poll();
    vi.advanceTimersByTime(1_000);
    fs.appendFileSync(child, JSON.stringify(assistantText('Done', 2, { input_tokens: 400, output_tokens: 40 })) + '\n');
    stamp();
    poll();
    const final = spendTokens(readClaudeAgentSpend(child, [], true).models);
    assert.ok(shown < final, 'the closing write left the band the card had read');
    const poller = setInterval(poll, 5_000);
    vi.advanceTimersByTime(60_000);
    clearInterval(poller);
    assert.equal(shown, final, `the row kept ${shown} tokens of ${final}`);
    // The quiet transition requires one additional read.
    assert.equal(reads, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('a shell-dispatched top-level session supplies its own duration and tool count', () => {
  const file = writeTranscript([
    userPrompt('Review the branch', 0),
    assistantTool('Bash', 2, 'run-check', { command: 'npm test' }),
    assistantText('The checks passed', 5, { input_tokens: 100, output_tokens: 20 }, 'high', 'end_turn'),
  ]);
  const spend = readClaudeAgentSpend(file, [], false);
  assert.deepEqual(
    [spend.found, spend.startedAt, spend.endedAt, spend.toolUses, spend.effort],
    [true, Date.parse(at(0)), Date.parse(at(5)), 1, 'high'],
  );
  assert.equal(spend.models[0]?.usage.output, 20);
});

test('a dispatched session whose first turn has no readable timestamp keeps no start rather than the epoch', () => {
  const file = writeTranscript([
    userPrompt('Review the branch', 0, { timestamp: '' }),
    assistantTool('Bash', 2, 'run-check', { command: 'npm test' }),
    assistantText('The checks passed', 5, { input_tokens: 100, output_tokens: 20 }, 'high', 'end_turn'),
  ]);
  const spend = readClaudeAgentSpend(file, [], false);
  // An unreadable start timestamp leaves startedAt unavailable rather than placing it at the epoch.

  assert.equal(spend.startedAt, null);
  assert.equal(spend.endedAt, Date.parse(at(5)));
});

test('a dispatched session whose first turn recorded a process end before its last record keeps the later time', () => {
  const file = writeTranscript([
    userPrompt('Review the branch', 0),
    assistantTool('Bash', 2, 'run-check', { command: 'npm test' }),
    assistantText('The checks passed', 5, { input_tokens: 100, output_tokens: 20 }, 'high', 'end_turn'),
    // The last activity occurs after the recorded process end and supplies the later endedAt.

    costState(ms(0), 2_000),
  ]);
  const spend = readClaudeAgentSpend(file, [], false);
  assert.equal(spend.endedAt, Date.parse(at(5)));
});

test('a filename-only launch and private output record do not create a dispatched link', () => {
  const parent = writeTranscript(
    claudeDispatchTranscript('C:/tools/dispatch.sh task.md', 'runner: claude\nid: 4f4bf298'),
  );
  assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent-dispatch' }), []);
  assert.deepEqual(readSession(parent, 'parent-dispatch').turns[0]?.dispatchToolUseIds ?? [], []);
  const native = writeTranscript(claudeDispatchTranscript('claude --bg task.md', 'runner: claude\nid: 4f4bf298'));
  assert.deepEqual(readClaudeChildSessionReferences({ file: native, sessionId: 'parent-dispatch' }), []);
});

test('an interpreter-wrapped filename-only launch cannot link native background output', () => {
  for (const command of [
    'bash "C:/tools/dispatch.sh" task.md',
    'sh "C:/tools/dispatch.sh" task.md',
    'pwsh "C:/tools/dispatch.ps1" task.md',
    'powershell "C:/tools/dispatch.ps1" task.md',
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, 'backgrounded · 4f4bf298 · Review branch'));
    assert.deepEqual(readClaudeChildSessionReferences({ file: parent, sessionId: 'parent-dispatch' }), [], command);
    assert.deepEqual(readSession(parent, 'parent-dispatch').turns[0]?.dispatchToolUseIds ?? [], [], command);
  }
});

test('Claude dispatch reads foreground JSON results and rejects quoted output from grep', () => {
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const foreground = writeTranscript(
    claudeDispatchTranscript(
      'claude -p --output-format json "review"',
      `null\n${JSON.stringify({ type: 'result', session_id: childId })}`,
    ),
  );
  assert.equal(readClaudeChildSessionReferences({ file: foreground, sessionId: 'parent' })[0]?.sessionId, childId);
  const quoted = writeTranscript(
    claudeDispatchTranscript('grep "backgrounded ·" parent.jsonl', 'backgrounded · 4f4bf298 · Quoted child'),
  );
  assert.deepEqual(readClaudeChildSessionReferences({ file: quoted, sessionId: 'parent' }), []);
});

// Resuming an existing session creates no dispatch row or delegated ownership. A fork creates a new dispatched session.

test('a Claude command that resumes a session dispatches nothing, and a fork of one does', () => {
  const resumedId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const forkId = '9a1c2e3f-1111-4222-8333-444455556666';
  const catalog = [resumedId, forkId].map((sessionId) => ({
    agent: 'claude' as const,
    file: `C:/sessions/${sessionId}.jsonl`,
    sessionId,
    mtimeMs: 1,
    size: 1,
  }));
  const result = (sessionId: string) => JSON.stringify({ type: 'result', session_id: sessionId });
  for (const command of [
    `claude -p --resume ${resumedId} --output-format json "follow up"`,
    `claude -p "review \`printf task\`" --resume ${resumedId} --output-format json`,
    `claude -p --resume=${resumedId} --output-format json "follow up"`,
    `claude -p -r ${resumedId} --output-format json "follow up"`,
    `claude -pr ${resumedId} --output-format json "follow up"`,
    'claude -p --continue --output-format json "follow up"',
    'claude -pc --output-format json "follow up"',
    `cd C:/repo && claude -p --output-format json "first" && claude -p --resume ${resumedId} --output-format json "again"`,
    `claude -p --output-format json "a" && claude -p --output-format json "b" && claude -p --resume ${resumedId} --output-format json "c"`,
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, result(resumedId)));
    const scanned = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
    assert.deepEqual(
      resolveClaudeDispatchReferences(scanned, catalog),
      [],
      `a resume became a dispatched link: ${command}`,
    );
    assert.deepEqual(
      readSession(parent, 'parent').turns[0]?.dispatchToolUseIds ?? [],
      [],
      `a resume drew a Dispatched row: ${command}`,
    );
  }
  for (const command of [
    `claude -p --resume ${resumedId} --fork-session --output-format json "branch off"`,
    `claude -p "review \`printf task\`" --resume ${resumedId} --fork-session --output-format json`,
    'claude -p --continue --fork-session --output-format json "branch off"',
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, result(forkId)));
    const scanned = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
    assert.deepEqual(
      resolveClaudeDispatchReferences(scanned, catalog).map((reference) => reference.sessionId),
      [forkId],
      `a forked session lost its dispatched link: ${command}`,
    );
    assert.deepEqual(readSession(parent, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], command);
  }
});

// Heredoc and here-string bodies supply prompt text. Their resume flags and quotes do not alter the outer launch's arguments.

test('a prompt passed as a heredoc or here-string never reads as a resume flag', () => {
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const catalog = [
    { agent: 'claude' as const, file: `C:/sessions/${childId}.jsonl`, sessionId: childId, mtimeMs: 1, size: 1 },
  ];
  const result = JSON.stringify({ type: 'result', session_id: childId });
  const body = 'Never run claude --resume or -r, rm -rf, git -c core.pager=cat, python -c pass or git log -pretty.';
  // The here-string contains apostrophes and resume-like text.
  const spoken = "Don't pass --resume or -c here, and don't run rm -rf.";
  const quoted = 'Check the 27" monitor, then never run claude --resume or -r (or -c | cat).';
  // A lone double quote, then a body line that reads as its own resume if the mask ends early.
  const resumeLine = `Check the 27" monitor and never run:\nclaude --resume ${childId}`;
  for (const command of [
    `claude -p --output-format json <<'EOF'\n${body}\nEOF`,
    `claude -p --output-format json <<-EOF\n\t${body}\n\tEOF`,
    `cat <<'EOF' | claude -p --output-format json\n${body}\nEOF`,
    `claude -p --output-format json @'\n${spoken}\n'@`,
    `claude -p --output-format json "$(cat <<'EOF'\n${quoted}\nEOF\n)"`,
    `claude -p "$(cat <<'EOF'\n${quoted}\nEOF\n)" --output-format json`,
    // Both bodies of two openers on one line are input.
    `claude -p "$(cat <<'ONE' - <<'TWO'\nfirst\nONE\n${resumeLine}\nTWO\n)" --output-format json`,
    `claude -p --output-format json <<'ONE' 3<<'TWO'\nfirst\nONE\nclaude --resume ${childId}\nTWO`,
    // A quoted argument inside the substitution closes only itself.
    `claude -p "$(cat "notes.md" - <<'EOF'\n${resumeLine}\nEOF\n)" --output-format json`,
    // A body line ends a heredoc only when it is exactly the delimiter.
    `claude -p "$(cat <<'EOF'\n  EOF  \n${resumeLine}\nEOF\n)" --output-format json`,
    `claude -p --output-format json <<-EOF\n \tEOF\nclaude --resume ${childId}\n\tEOF`,
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, result));
    const scanned = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
    assert.deepEqual(
      resolveClaudeDispatchReferences(scanned, catalog).map((reference) => reference.sessionId),
      [childId],
      `a prompt on standard input dropped the dispatch: ${command}`,
    );
    assert.deepEqual(readSession(parent, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], command);
  }
});

// The flags a resume can take, and the words around them that are not flags.
test('a resume flag counts wherever Claude reads one, and nowhere else', () => {
  const resumedId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  const freshId = '9a1c2e3f-1111-4222-8333-444455556666';
  const catalog = [resumedId, freshId].map((sessionId) => ({
    agent: 'claude' as const,
    file: `C:/sessions/${sessionId}.jsonl`,
    sessionId,
    mtimeMs: 1,
    size: 1,
  }));
  const dispatched = (command: string, sessionId: string): boolean => {
    const parent = writeTranscript(
      claudeDispatchTranscript(command, JSON.stringify({ type: 'result', session_id: sessionId })),
    );
    const scanned = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
    const linked = resolveClaudeDispatchReferences(scanned, catalog).length > 0;
    const drawn = (readSession(parent, 'parent').turns[0]?.dispatchToolUseIds ?? []).length > 0;
    assert.equal(linked, drawn, `the link and the Dispatched row disagree: ${command}`);
    return linked;
  };
  for (const command of [
    `claude -p "follow up" --resume ${resumedId} --output-format json`,
    `claude -p "say \\"hi\\"" --resume ${resumedId} --output-format json`,
    `C:/Users/me/.local/bin/claude -p --resume ${resumedId} --output-format json "x"`,
    `CLAUDE_CODE_ENTRYPOINT=cli claude -p --resume ${resumedId} --output-format json "x"`,
    `claude.exe -p -r ${resumedId} --output-format json "x"`,
    `"C:/Program Files/Claude/claude.exe" --resume ${resumedId} -p --output-format json "x"`,
    // A double quote in a heredoc inside the quoted prompt must not end the words early.
    `claude -p "$(cat <<'EOF'\nsay "hi\nEOF\n)" --resume ${resumedId} --output-format json`,
    // `<<<` passes a string and opens no heredoc, so the words after it still count.
    `claude -p "$(cat <<< 'hello')" --resume ${resumedId} --output-format json\necho finished`,
  ]) {
    assert.equal(dispatched(command, resumedId), false, `a resume became a dispatched link: ${command}`);
  }
  for (const command of [
    'claude -p "run git -c core.pager=cat log --resume nothing" --output-format json',
    "claude -p ' --resume later, -c too' --output-format json",
    'claude -p "say \\" -c" --output-format json',
    'claude -p --output-format json -- --resume',
    // `-d` takes an optional value, so `r` here is its filter and not `-r`.
    'claude -p -dr --output-format json "x"',
    `claude -p --fork-session --resume ${resumedId} --output-format json "x"`,
    'C:/Users/me/.local/bin/claude -p --output-format json "x"',
    'CLAUDE_CODE_ENTRYPOINT=cli claude -p --output-format json "x"',
    'claude.exe -p --output-format json "x"',
  ]) {
    assert.equal(dispatched(command, freshId), true, `a fresh launch lost its dispatched link: ${command}`);
  }
});

test('Claude dispatch recognizes quoted native and opted-in wrapper paths', () => {
  const childId = '4f4bf298-958f-4751-8782-d8688ff808a6';
  for (const [command, output] of [
    [
      'bash "C:/tools/review helper.sh" --arc-dispatch task.md',
      `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`,
    ],
    [
      'python "C:/tools/dispatch.py" --arc-dispatch task.md',
      `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`,
    ],
    [
      'bash "C:/tools/dispatch.sh" --arc-dispatch task.md',
      `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`,
    ],
    ['"C:/Program Files/Claude/claude.exe" --bg task', `backgrounded · 4f4bf298 · Quoted path`],
  ]) {
    const parent = writeTranscript(claudeDispatchTranscript(command, output));
    assert.equal(
      readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' })[0]?.sessionId,
      output.startsWith('backgrounded') ? childId.slice(0, 8) : childId,
      `the quoted launch was not read: ${command}`,
    );
  }
});

test('parenthesized dispatch arguments retain the linked child and launch identity', () => {
  const file = writeTranscript(
    claudeDispatchTranscript(
      powershellDispatchCommand,
      powershellDispatchExecution.stdout,
      powershellDispatchExecution.id,
    ),
  );
  const references = readClaudeChildSessionReferences({ file, sessionId: 'parent' });
  assert.deepEqual(
    references.map((reference) => [reference.sessionId, reference.toolUseIds]),
    [['3f99580e', [powershellDispatchExecution.id]]],
  );
  const catalog = [
    {
      agent: 'claude' as const,
      sessionId: '3f99580e-a054-4ce7-a686-c4e65f32f98a',
      file: 'C:/sessions/child.jsonl',
      size: 1,
      mtimeMs: 1,
    },
  ];
  const linked = resolveClaudeDispatchReferences(references, catalog);
  assert.deepEqual(
    linked.map((reference) => [reference.sessionId, reference.toolUseIds]),
    [[catalog[0].sessionId, [powershellDispatchExecution.id]]],
  );
  assert.deepEqual(
    resolveClaudeDispatchReferences(references, [
      ...catalog,
      { ...catalog[0], sessionId: '3f99580e-1111-4111-8111-111111111111' },
    ]),
    [],
  );
  assert.deepEqual(readSession(file, 'parent').turns[0].dispatchToolUseIds, [powershellDispatchExecution.id]);
});

test('parenthesized dispatch values preserve opt-in ownership and shell boundaries', () => {
  const receipt = powershellDispatchExecution.stdout;
  for (const command of [
    'python dispatch.py --prompt (Join-Path root file) --message "review --arc-dispatch"',
    'echo "python dispatch.py --prompt (Join-Path root file) --arc-dispatch"',
    "python dispatch.py --prompt ('--arc-dispatch')",
    'python dispatch.py --prompt (Join-Path root file | echo --arc-dispatch',
    ') python dispatch.py --arc-dispatch',
    'python dispatch.py --prompt (Join-Path root; file) --arc-dispatch',
    'python dispatch.py --prompt (Join-Path root\nfile) --arc-dispatch',
    'python dispatch.py --prompt $(Join-Path root file) --arc-dispatch',
    'python dispatch.py --prompt @(Join-Path root file) --arc-dispatch',
    'python dispatch.py --prompt <(Join-Path root file) --arc-dispatch',
    'python dispatch.py --prompt name(Join-Path root file) --arc-dispatch',
    'python dispatch.py --prompt (Join-Path root file)--arc-dispatch',
    'python dispatch.py --prompt (Join-Path root file) --message "hello `" --arc-dispatch"',
    'python dispatch.py --prompt (Join-Path root file) --message "hello \\" --arc-dispatch"',
    'python dispatch.py --prompt (Write-Output `) --arc-dispatch | Out-String)',
    'python dispatch.py --prompt (Write-Output `( --arc-dispatch | Out-String)',
    'python show_receipt.py --input (Join-Path root receipt.txt) # --arc-dispatch',
    'python show_receipt.py --input (Join-Path root receipt.txt) # " ; python fake.py --arc-dispatch',
    'python show_receipt.py --input (Join-Path root receipt.txt) <# --arc-dispatch #>',
    'python show_receipt.py --input (Join-Path root receipt.txt) <# " ; python fake.py --arc-dispatch\nclaude --bg task #>',
  ]) {
    const file = writeTranscript(claudeDispatchTranscript(command, receipt));
    assert.equal(claudeLaunchKind(command), null, command);
    assert.deepEqual(readClaudeChildSessionReferences({ file, sessionId: 'parent' }), [], command);
  }
  for (const command of [
    'python outer.py --prompt (python inner.py --arc-dispatch)',
    'python outer.py --prompt (Join-Path root file --arc-dispatch)',
    'python outer.py --prompt (Join-Path root file) | python inner.py --arc-dispatch',
    'python outer.py --prompt (claude --bg task)',
    'python outer.py --prompt (Join-Path root file) --arc-dispatch <# " ; python fake.py --arc-dispatch #>',
  ]) {
    const native = command.includes('claude --bg');
    assert.deepEqual(claudeLaunchKind(command), { kind: native ? 'native' : 'receipt', count: 1 }, command);
    const output = native ? 'backgrounded · 3f99580e · Review' : receipt;
    const file = writeTranscript(claudeDispatchTranscript(command, output));
    assert.equal(readClaudeChildSessionReferences({ file, sessionId: 'parent' }).length, 1, command);
    if (!native) {
      const two = writeTranscript(claudeDispatchTranscript(command, receipt + receipt.replace('3f99580e', '4f4bf298')));
      assert.deepEqual(readClaudeChildSessionReferences({ file: two, sessionId: 'parent' }), [], command);
    }
  }
  const escaped = 'python outer.py --prompt (Write-Output `) | Out-String) --arc-dispatch';
  assert.deepEqual(claudeLaunchKind(escaped, 'powershell'), { kind: 'receipt', count: 1 });
  assert.equal(claudeLaunchKind(escaped, 'bash'), null);
  assert.equal(claudeLaunchKind(escaped), null);
});

test('Bash backtick substitutions retain native launch and quoted text ownership', () => {
  const result = JSON.stringify({ type: 'result', session_id: '3f99580e-a054-4ce7-a686-c4e65f32f98a' });
  for (const command of [
    'claude -p "review `printf task`" --output-format json',
    'cd "`git rev-parse --show-toplevel`" && claude -p hi',
  ]) {
    const file = writeTranscript(claudeDispatchTranscript(command, result));
    assert.deepEqual(claudeLaunchKind(command), { kind: 'native', count: 1 }, command);
    assert.equal(readClaudeChildSessionReferences({ file, sessionId: 'parent' }).length, 1, command);
    assert.deepEqual(readSession(file, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], command);
  }
  const command = 'echo "`date`" "; claude -p hi"';
  const file = writeTranscript(claudeDispatchTranscript(command, result));
  assert.equal(claudeLaunchKind(command), null);
  assert.deepEqual(readClaudeChildSessionReferences({ file, sessionId: 'parent' }), []);
  assert.deepEqual(readSession(file, 'parent').turns[0]?.dispatchToolUseIds ?? [], []);
});

test('Bash arithmetic grouping preserves independent dispatch receipts', () => {
  const childId = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const receipt = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`;
  for (const statement of [
    'echo $((2*(3)))',
    'echo $((2+(3)))',
    'echo $((2*(3+(4))))',
    '((2*(3)))',
    'echo $((((1)+2)*(3)))',
    '((x=((1)+2)*(3)))',
  ]) {
    const command = `${statement}; python child.py --arc-dispatch`;
    const file = writeTranscript(claudeDispatchTranscript(command, receipt));
    assert.deepEqual(claudeLaunchKind(command, 'bash'), { kind: 'receipt', count: 1 }, command);
    assert.deepEqual(
      readClaudeChildSessionReferences({ file, sessionId: 'parent' }).map((reference) => [
        reference.sessionId,
        reference.toolUseIds,
      ]),
      [[childId, ['dispatch-1']]],
      command,
    );
    assert.deepEqual(readSession(file, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], command);
  }
  for (const text of ['"+(tag)"', "'*(tag)'", '\\+(tag)']) {
    assert.deepEqual(claudeLaunchKind(`echo ${text}; python child.py --arc-dispatch`, 'bash'), {
      kind: 'receipt',
      count: 1,
    });
  }
});

test('Bash parameter defaults and conditional patterns preserve receipt ownership', () => {
  const childId = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const receipt = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`;
  for (const command of [
    'echo ${unset_arc_var:-+(tag)}; python child.py --arc-dispatch',
    '[[ $x == @(a|b) ]]; python child.py --arc-dispatch',
    '[[ $x != +(a|b) ]]; python child.py --arc-dispatch',
    '{ [[ $x == @(a|b) ]]; }; python child.py --arc-dispatch',
    '! { [[ $x == @(a|b) ]]; }; python child.py --arc-dispatch',
    'time [[ $x == +(a) ]]; python child.py --arc-dispatch',
    'time -p [[ $x == +(a) ]]; python child.py --arc-dispatch',
    'time -- [[ $x == +(a) ]]; python child.py --arc-dispatch',
    'time -p -- [[ $x == +(a) ]]; python child.py --arc-dispatch',
    '! time [[ $x == +(a) ]]; python child.py --arc-dispatch',
    'time ! [[ $x == +(a) ]]; python child.py --arc-dispatch',
    'if [[ $x == @(a|b) ]]; then python child.py --arc-dispatch; fi',
    'echo ${unset_arc_var:-$(python child.py --arc-dispatch)}',
    'python child.py --prompt [[ literal ]] --arc-dispatch',
    'python child.py --prompt { [[ literal ]] --arc-dispatch',
    'python child.py --prompt time -p -- [[ literal ]] --arc-dispatch',
    'python child.py --prompt "{ [[ literal ]]" --arc-dispatch',
    'python child.py --prompt "time -p -- [[ literal ]]" --arc-dispatch',
  ]) {
    const file = writeTranscript(claudeDispatchTranscript(command, receipt));
    assert.deepEqual(
      readClaudeChildSessionReferences({ file, sessionId: 'parent' }).map((reference) => [
        reference.sessionId,
        reference.toolUseIds,
      ]),
      [[childId, ['dispatch-1']]],
      command,
    );
    assert.deepEqual(readSession(file, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], command);
  }
  for (const command of [
    'echo ${unset_arc_var:-+(python child.py --arc-dispatch)}',
    '[[ $x == @(claude|python) ]]',
    'echo ${unset_arc_var:-$(echo @(tag))}; python child.py --arc-dispatch',
    '[[ $(echo @(tag)) == tag ]]; python child.py --arc-dispatch',
    'echo "{ [[ literal ]]; python child.py --arc-dispatch"',
    'echo "time -p -- [[ literal ]]; python child.py --arc-dispatch"',
    '"{ " [[ @(tag) ]]; python child.py --arc-dispatch',
    '"time" [[ @(tag) ]]; python child.py --arc-dispatch',
    '\\{ [[ @(tag) ]]; python child.py --arc-dispatch',
    'ti\\me [[ @(tag) ]]; python child.py --arc-dispatch',
  ]) {
    const output = `${receipt}\n${JSON.stringify({ type: 'result', session_id: childId })}`;
    const file = writeTranscript(claudeDispatchTranscript(command, output));
    assert.deepEqual(readClaudeChildSessionReferences({ file, sessionId: 'parent' }), [], command);
    assert.deepEqual(readSession(file, 'parent').turns[0]?.dispatchToolUseIds ?? [], [], command);
  }
});

test('Bash backtick heredocs preserve outer receipt and resume ownership', () => {
  const childId = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const result = JSON.stringify({ type: 'result', session_id: childId });
  const receipt = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`;
  for (const statement of [
    'echo `cat <<EOF #comment\nx\nEOF`',
    "echo `cat <<-'EOF' #comment\n\tx\n\tEOF`",
    "echo `cat <<'ONE' 3<<'TWO' #comment\nx\nONE\ny\nTWO`",
  ]) {
    const resumed = `claude -p fresh --output-format text; ${statement}; claude --resume ${childId} --output-format json`;
    const resumedFile = writeTranscript(claudeDispatchTranscript(resumed, `fresh-response\n${result}`));
    assert.deepEqual(readClaudeChildSessionReferences({ file: resumedFile, sessionId: 'parent' }), [], resumed);
    assert.deepEqual(readSession(resumedFile, 'parent').turns[0]?.dispatchToolUseIds ?? [], [], resumed);
    const command = `${statement}; python child.py --arc-dispatch`;
    const file = writeTranscript(claudeDispatchTranscript(command, receipt));
    assert.deepEqual(
      readClaudeChildSessionReferences({ file, sessionId: 'parent' }).map((reference) => [
        reference.sessionId,
        reference.toolUseIds,
      ]),
      [[childId, ['dispatch-1']]],
      command,
    );
    assert.deepEqual(readSession(file, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], command);
  }
});

test('Bash backtick comments preserve later launch ownership', () => {
  const childId = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const result = JSON.stringify({ type: 'result', session_id: childId });
  const receipt = `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'claude', session_id: childId })}`;
  for (const statement of [
    'echo `true #x`',
    'echo `true #x\n`',
    'echo `true # "unterminated`',
    'echo `true #x\\` ignored`',
  ]) {
    const resumed = `claude -p fresh --output-format text; ${statement}; claude -p follow-up --resume ${childId} --output-format json`;
    const resumedFile = writeTranscript(claudeDispatchTranscript(resumed, `fresh-response\n${result}`));
    assert.equal(claudeLaunchKind(resumed, 'bash'), null, resumed);
    assert.equal(claudeLaunchKind(resumed), null, resumed);
    assert.deepEqual(readClaudeChildSessionReferences({ file: resumedFile, sessionId: 'parent' }), [], resumed);
    assert.deepEqual(readSession(resumedFile, 'parent').turns[0]?.dispatchToolUseIds ?? [], [], resumed);
    const fresh = `${statement}; python child.py --arc-dispatch`;
    const freshFile = writeTranscript(claudeDispatchTranscript(fresh, receipt));
    assert.deepEqual(
      readClaudeChildSessionReferences({ file: freshFile, sessionId: 'parent' }).map((reference) => [
        reference.sessionId,
        reference.toolUseIds,
      ]),
      [[childId, ['dispatch-1']]],
      fresh,
    );
    assert.deepEqual(readSession(freshFile, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], fresh);
  }
  for (const statement of ["echo 'literal ` #x'", 'echo "literal \\` #x"', 'echo literal\\`#x']) {
    const command = `${statement}; python child.py --arc-dispatch`;
    assert.deepEqual(claudeLaunchKind(command, 'bash'), { kind: 'receipt', count: 1 }, command);
  }
  const unmatched = 'claude -p fresh --output-format text; echo `true #x; python child.py --arc-dispatch';
  const unmatchedFile = writeTranscript(claudeDispatchTranscript(unmatched, result));
  assert.equal(claudeLaunchKind(unmatched, 'bash'), null);
  assert.deepEqual(readClaudeChildSessionReferences({ file: unmatchedFile, sessionId: 'parent' }), []);
  const nested = 'echo `python child.py --arc-dispatch`';
  const nestedFile = writeTranscript(claudeDispatchTranscript(nested, receipt));
  assert.deepEqual(claudeLaunchKind(nested, 'bash'), { kind: 'receipt', count: 1 });
  assert.deepEqual(
    readClaudeChildSessionReferences({ file: nestedFile, sessionId: 'parent' }).map((reference) => [
      reference.sessionId,
      reference.toolUseIds,
    ]),
    [[childId, ['dispatch-1']]],
  );
  const excessFile = writeTranscript(
    claudeDispatchTranscript(nested, `${receipt}\n${receipt.replace('3f99580e', '4f4bf298')}`),
  );
  assert.deepEqual(readClaudeChildSessionReferences({ file: excessFile, sessionId: 'parent' }), []);
});

test('Bash length expansions and literal hash tails preserve dispatch ownership', () => {
  const childId = '3f99580e-a054-4ce7-a686-c4e65f32f98a';
  const result = JSON.stringify({ type: 'result', session_id: childId });
  const statements = [
    'printf "%s\\n" ${tag}#note',
    'printf "%s\\n" ${tags[@]}#note',
    'printf "%s\\n" $(printf tag)#note',
    'n=${#tasks[@]}',
    'n=${#tag}',
    'printf "%s\\n" $((1 + 1))#note',
    'printf "%s\\n" <(printf tag)#note',
    'printf "%s\\n" path#note',
    'printf "%s\\n" "path "#note',
    "printf '%s\\n' 'path '#note",
    'printf "%s\\n" path\\#note',
    'printf "%s\\n" path\\ #note',
    'printf "%s\\n" path{#note',
    'printf "%s\\n" path}#note',
    'printf "%s\\n" {foo,bar}#note',
    'printf "%s\\n" {1..3}#note',
    'printf "%s\\n" {foo}#note',
    'printf "%s\\n" {}#note',
    'printf "%s\\n" {#note',
    'printf "%s\\n" }#note',
  ];
  for (const statement of statements) {
    const resumed = `claude -p fresh --output-format text; ${statement}; claude -p follow-up --resume ${childId} --output-format json`;
    const resumedFile = writeTranscript(claudeDispatchTranscript(resumed, `fresh-response\npath#note\n${result}`));
    assert.deepEqual(readClaudeChildSessionReferences({ file: resumedFile, sessionId: 'parent' }), [], resumed);
    assert.equal(claudeLaunchKind(resumed, 'bash'), null, resumed);
    assert.deepEqual(readSession(resumedFile, 'parent').turns[0]?.dispatchToolUseIds ?? [], [], resumed);

    const fresh = `${statement}; claude -p summarize --output-format json`;
    const freshFile = writeTranscript(claudeDispatchTranscript(fresh, result));
    assert.deepEqual(claudeLaunchKind(fresh, 'bash'), { kind: 'native', count: 1 }, fresh);
    assert.equal(
      readClaudeChildSessionReferences({ file: freshFile, sessionId: 'parent' })[0]?.sessionId,
      childId,
      fresh,
    );
    assert.deepEqual(readSession(freshFile, 'parent').turns[0]?.dispatchToolUseIds, ['dispatch-1'], fresh);
  }
});

test('real comments retain their launch boundaries after shell expressions', () => {
  const receipt = powershellDispatchExecution.stdout;
  for (const command of [
    'printf tag # ; python fake.py --arc-dispatch',
    'printf "tag " # ; python fake.py --arc-dispatch',
    'printf ${tag} # ; python fake.py --arc-dispatch',
    'printf $(printf tag) # ; python fake.py --arc-dispatch',
    'python show_receipt.py --input (Join-Path root receipt.txt)# --arc-dispatch',
    'python show_receipt.py --input (Join-Path root receipt.txt)<# --arc-dispatch #>',
  ]) {
    const file = writeTranscript(claudeDispatchTranscript(command, receipt));
    assert.equal(claudeLaunchKind(command), null, command);
    assert.deepEqual(readClaudeChildSessionReferences({ file, sessionId: 'parent' }), [], command);
  }
  const scriptBlock = 'Write-Output {tag}# ; python fake.py --arc-dispatch';
  assert.equal(claudeLaunchKind(scriptBlock, 'powershell'), null);
  assert.equal(claudeLaunchKind(scriptBlock), null);
});

test('unknown shell context rejects conflicting native and receipt launch identities', () => {
  const native = 'claude -p fresh; echo {tag}#note; claude --resume existing';
  assert.equal(claudeLaunchKind(native, 'bash'), null);
  assert.deepEqual(claudeLaunchKind(native, 'powershell'), { kind: 'native', count: 1 });
  assert.equal(claudeLaunchKind(native), null);
  const receipt = 'echo {tag}#note; python child.py --arc-dispatch';
  assert.deepEqual(claudeLaunchKind(receipt, 'bash'), { kind: 'receipt', count: 1 });
  assert.equal(claudeLaunchKind(receipt, 'powershell'), null);
  assert.equal(claudeLaunchKind(receipt), null);
  const differentLaunches =
    'echo {tag}#note; python first.py --arc-dispatch\n<#\necho text\n#>; python second.py --arc-dispatch';
  assert.deepEqual(claudeLaunchKind(differentLaunches, 'bash'), { kind: 'receipt', count: 1 });
  assert.deepEqual(claudeLaunchKind(differentLaunches, 'powershell'), { kind: 'receipt', count: 1 });
  assert.equal(claudeLaunchKind(differentLaunches), null);
  for (const prefix of ['@', '?', '!', '+', '*']) {
    const command = `python child.py --arc-dispatch; echo ${prefix}(tag)#note; claude --resume existing`;
    assert.equal(claudeLaunchKind(command, 'bash'), null, command);
    assert.equal(claudeLaunchKind(command), null, command);
  }
});

test('Claude dispatch resolution indexes catalog identifiers once', () => {
  let identifierReads = 0;
  const catalog = Array.from({ length: 20 }, (_unused, index) => ({
    agent: 'claude' as const,
    file: `C:/sessions/${index}.jsonl`,
    get sessionId() {
      identifierReads++;
      return `${index.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`;
    },
    mtimeMs: 1,
    size: 1,
  }));
  const references = catalog.map((_session, index) => ({
    kind: 'dispatch' as const,
    agent: 'claude' as const,
    parentSessionId: 'parent',
    sessionId: index.toString(16).padStart(8, '0'),
    file: null,
    toolUseIds: [`dispatch-${index}`],
    name: null,
    owned: false,
  }));
  assert.equal(resolveClaudeDispatchReferences(references, catalog).length, catalog.length);
  assert.equal(identifierReads, catalog.length, 'resolution rescanned the complete catalog for each reference');
});

test('Claude child discovery reaches verified grandchildren once and keeps their direct parent edges', () => {
  const root = tempDir('claude-child-tree-');
  const parentId = 'parent-tree';
  const parent = path.join(root, `${parentId}.jsonl`);
  const childDir = path.join(root, parentId, 'subagents');
  const child = path.join(childDir, 'agent-child-tree.jsonl');
  const grandchild = path.join(childDir, 'agent-grandchild-tree.jsonl');
  fs.mkdirSync(childDir, { recursive: true });
  const result = (toolUseId: string, agentId: string, second: number, sidechain = false) => ({
    type: 'user',
    timestamp: at(second),
    isSidechain: sidechain,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
    toolUseResult: { agentId, status: 'completed', totalToolUseCount: 1 },
  });
  fs.writeFileSync(
    parent,
    [
      { ...userPrompt('delegate child', 0), cwd: 'c:/repo' },
      assistantTool('Agent', 1, 'launch-child', { description: 'Child' }),
      result('launch-child', 'child-tree', 2),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  fs.writeFileSync(
    child,
    [
      { ...userPrompt('delegate grandchild', 3), isSidechain: true, cwd: 'c:/repo' },
      { ...assistantTool('Agent', 4, 'launch-grandchild', { description: 'Grandchild' }), isSidechain: true },
      result('launch-grandchild', 'grandchild-tree', 5, true),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  fs.writeFileSync(
    grandchild,
    JSON.stringify({ ...userPrompt('finish nested work', 6), isSidechain: true, cwd: 'c:/repo' }) + '\n',
  );
  const stat = fs.statSync(parent);
  const visits = new Map<string, number>();
  const children = discoverClaudeChildSessionFiles(
    [
      {
        agent: 'claude',
        file: parent,
        sessionId: parentId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      },
    ],
    ['c:/repo'],
    (session) => {
      visits.set(session.sessionId, (visits.get(session.sessionId) ?? 0) + 1);
      return readClaudeChildSessionReferences(session);
    },
  );
  assert.deepEqual(
    children.map((session) => [session.sessionId, session.parentSessionId]),
    [
      ['child-tree', parentId],
      ['grandchild-tree', 'child-tree'],
    ],
  );
  assert.deepEqual([...visits].sort(), [
    ['child-tree', 1],
    ['grandchild-tree', 1],
    [parentId, 1],
  ]);
});

test('Claude child discovery reaches a nested child whose launch result is text alone', () => {
  const root = tempDir('claude-child-text-result-');
  const parentId = 'parent-text';
  const parent = path.join(root, `${parentId}.jsonl`);
  const childDir = path.join(root, parentId, 'subagents');
  fs.mkdirSync(childDir, { recursive: true });
  writeRecords(parent, [
    { ...userPrompt('delegate child', 0), cwd: 'c:/repo' },
    assistantTool('Agent', 1, 'launch-child', { description: 'Child' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch-child', content: 'done' }] },
      toolUseResult: { agentId: 'child-1', status: 'completed', totalToolUseCount: 3 },
    },
  ]);
  writeRecords(path.join(childDir, 'agent-child-1.jsonl'), [
    { ...userPrompt('delegate two nested agents', 3), isSidechain: true, cwd: 'c:/repo' },
    { ...assistantTool('Agent', 4, 'launch-fg', { description: 'Nested foreground' }), isSidechain: true },
    nestedResult('launch-fg', 5, nestedForegroundResult('adf3e8d2cb8d606c4', 28814, 2, 19553)),
    { ...assistantTool('Agent', 6, 'launch-bg', { description: 'Nested background' }), isSidechain: true },
    nestedResult('launch-bg', 7, nestedBackgroundResult('a17339eacb3e8a85d')),
    { ...assistantTool('Agent', 8, 'launch-report', { description: 'Nested report' }), isSidechain: true },
    nestedResult('launch-report', 9, nestedReportEndingOnAnId),
  ]);
  for (const id of ['adf3e8d2cb8d606c4', 'a17339eacb3e8a85d', 'unrelated-child']) {
    writeRecords(path.join(childDir, `agent-${id}.jsonl`), [
      { ...userPrompt('nested work', 8), isSidechain: true, cwd: 'c:/repo' },
    ]);
  }
  const stat = fs.statSync(parent);
  const children = discoverClaudeChildSessionFiles(
    [{ agent: 'claude', file: parent, sessionId: parentId, mtimeMs: stat.mtimeMs, size: stat.size }],
    ['c:/repo'],
    readClaudeChildSessionReferences,
  );
  assert.deepEqual(
    children.map((session) => [session.sessionId, session.parentSessionId, session.toolUseIds]),
    [
      ['child-1', parentId, ['launch-child']],
      ['adf3e8d2cb8d606c4', 'child-1', ['launch-fg']],
      ['a17339eacb3e8a85d', 'child-1', ['launch-bg']],
    ],
  );
});

test('Claude child discovery validates each reference once across many parents and children', () => {
  const root = tempDir('claude-child-linear-');
  const parents = Array.from({ length: 12 }, (_unused, parentIndex) => ({
    agent: 'claude' as const,
    file: path.join(root, `parent-${parentIndex}.jsonl`),
    sessionId: `parent-${parentIndex}`,
    mtimeMs: parentIndex,
    size: 1,
  }));
  const references = new Map(
    parents.map((parent, parentIndex) => [
      parent.sessionId,
      Array.from({ length: 8 }, (_unused, childIndex) => ({
        parentSessionId: parent.sessionId,
        sessionId: `child-${parentIndex}-${childIndex}`,
        file: path.join(root, `agent-child-${parentIndex}-${childIndex}.jsonl`),
        toolUseIds: [`launch-${parentIndex}-${childIndex}`],
      })),
    ]),
  );
  let validations = 0;
  const found = discoverClaudeChildSessions(
    parents,
    ['c:/repo'],
    (session) => references.get(session.sessionId) ?? [],
    {
      read(reference) {
        validations++;
        return {
          agent: 'claude',
          ...reference,
          mtimeMs: 1,
          size: 1,
          cwd: 'c:/repo',
          agentRun: true,
          childTranscript: true,
        };
      },
    },
  );
  const referenceCount = parents.length * 8;
  assert.equal(found.children.length, referenceCount);
  assert.equal(
    validations,
    referenceCount,
    'discovery revalidated references it had already accepted while it walked later children',
  );
});

test('Claude child validation reuses cwd until the child revision changes', () => {
  const root = tempDir('claude-child-validation-cache-');
  const file = path.join(root, 'agent-child.jsonl');
  fs.writeFileSync(file, '{}\n');
  let cwdReads = 0;
  const cache = new ClaudeChildSessionCache(() => {
    cwdReads++;
    return 'c:/repo';
  });
  const reference = { parentSessionId: 'parent', sessionId: 'child', file, toolUseIds: ['launch'] };
  assert.ok(cache.read(reference, ['c:/repo']));
  assert.ok(cache.read(reference, ['c:/repo']));
  assert.equal(cwdReads, 1, 'an unchanged child repeated its head read');
  fs.appendFileSync(file, '{}\n');
  assert.ok(cache.read(reference, ['c:/repo']));
  assert.equal(cwdReads, 2, 'a changed child reused validation from an older revision');
});

test('Claude child validation rereads cwd when a same-size same-mtime file replaces the child', () => {
  const root = tempDir('claude-child-validation-identity-');
  const file = path.join(root, 'agent-child.jsonl');
  const replacement = path.join(root, 'replacement.jsonl');
  fs.writeFileSync(file, 'c:/repo\n');
  const fixedTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  fs.utimesSync(file, fixedTime, fixedTime);
  const original = fs.statSync(file);
  let cwdReads = 0;
  const cache = new ClaudeChildSessionCache((target) => {
    cwdReads++;
    return fs.readFileSync(target, 'utf8').trim();
  });
  const reference = { parentSessionId: 'parent', sessionId: 'child', file, toolUseIds: ['launch'] };
  assert.equal(cache.read(reference, ['c:/repo'])?.cwd, 'c:/repo');
  fs.writeFileSync(replacement, 'd:/repo\n');
  fs.unlinkSync(file);
  fs.renameSync(replacement, file);
  fs.utimesSync(file, original.atime, original.mtime);
  const replaced = fs.statSync(file);
  assert.equal(replaced.size, original.size);
  assert.equal(replaced.mtimeMs, original.mtimeMs);
  assert.ok(
    replaced.dev !== original.dev || replaced.ino !== original.ino,
    'the fixture did not replace the child file identity',
  );
  assert.equal(
    cache.read(reference, ['d:/repo'])?.cwd,
    'd:/repo',
    "a replacement child reused the old file identity's working directory",
  );
  assert.equal(cwdReads, 2);
});

test('catalog identity checks bound asynchronous stats and preserve appends', async () => {
  const sources = Array.from({ length: 10_000 }, (_, n) => ({
    agent: 'claude' as const,
    sessionId: String(n),
    file: String(n),
    cwd: '/repo',
    size: 10,
    mtimeMs: 1,
    dev: 1,
    ino: n + 1,
  }));
  let active = 0;
  let peak = 0;
  let calls = 0;
  const changed = await replacedCatalogFiles(sources, new AbortController().signal, async (file) => {
    calls++;
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    const source = sources[Number(file)];
    return file === '0' ? { ...source, ino: 999 } : file === '1' ? null : { ...source, size: 20, mtimeMs: 2 };
  });
  assert.deepEqual(changed.sort(), ['0', '1']);
  assert.equal(calls, sources.length);
  assert.equal(peak, 32);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(
    await replacedCatalogFiles(sources, aborted.signal, async () => {
      throw new Error('aborted check started I/O');
    }),
    [],
  );
});

test('a background subagent stays running until its notification arrives', () => {
  const file = writeTranscript([
    userPrompt('run it in the background', 0),
    assistantTool('Agent', 1, 'bg1', { description: 'Long scan', subagent_type: 'general-purpose' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'launched' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'x1', description: 'Long scan' },
    },
    assistantText('Launched.', 3),
  ]);
  const [running] = readTurns(file, 'sess');
  assert.equal(running.agents[0].status, 'running');
  assert.equal(
    running.agents[0].id,
    'x1',
    'the async launch result identified the child without reporting a final tool count',
  );

  const withNotice = writeTranscript([
    userPrompt('run it in the background', 0),
    assistantTool('Agent', 1, 'bg1', { description: 'Long scan' }),
    {
      type: 'user',
      timestamp: at(3),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: '<task-notification><tool-use-id>bg1</tool-use-id><status>completed</status></task-notification>',
      },
    },
    assistantText('It finished.', 4),
  ]);
  assert.equal(readTurns(withNotice, 'sess')[0].agents[0].status, 'completed');
});

test('turn-start discovery parses only user records in parent and child modes', () => {
  const records = [
    ...Array.from({ length: 200 }, (_unused, index) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: at(index),
        message: { role: 'assistant', content: [] },
      }),
    ),
    JSON.stringify({ ...userPrompt('child prompt', 201), isSidechain: true }),
  ];
  const file = path.join(tempDir('turn-start-prefilter-'), 'session.jsonl');
  fs.writeFileSync(file, `${records.join('\n')}\n`);
  const parse = JSON.parse;
  let parses = 0;
  const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(((
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ) => {
    parses++;
    return parse(text, reviver);
  }) as typeof JSON.parse);
  try {
    assert.deepEqual(readSessionTurnStarts(file, undefined, true).starts, [ms(201)]);
    assert.equal(parses, 1, 'turn-start discovery parsed records that cannot open a turn');
  } finally {
    parseSpy.mockRestore();
  }
});

test('an API error is reported, and is cleared when the model speaks afterwards', () => {
  const failed = writeTranscript([
    userPrompt('retry', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Usage credits are required for this model.' }],
      },
    },
  ]);
  assert.equal(readTurns(failed, 'sess')[0].error, 'Usage credits are required for this model.');

  const recovered = writeTranscript([
    userPrompt('retry', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      isApiErrorMessage: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Overloaded.' }] },
    },
    assistantText('Second attempt worked.', 2),
  ]);
  const [turn] = readTurns(recovered, 'sess');
  assert.equal(turn.error, null);
  assert.equal(turn.summary, 'Second attempt worked.');
});

test('a turn whose prompt falls outside the tail window is dropped', () => {
  const filler = 'x'.repeat(4000);
  const file = writeTranscript([
    userPrompt('older ask', 0),
    assistantText(filler, 1),
    userPrompt('newer ask', 2),
    assistantText('Recent work.', 3),
  ]);
  const turns = readTurns(file, 'sess', { tailBytes: 2000 });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, 'newer ask');
});

test('the selected Claude session discovers its newest turn through disjoint older ranges', async () => {
  const file = writeTranscript([
    userPrompt('older ask', 0),
    assistantAnswer('Older work.', 1),
    userPrompt('newest ask', 2),
    assistantTool('Bash', 3, 'wide', { command: `x${'😀'.repeat(2500)}` }),
    assistantAnswer('Newest work.', 4),
  ]);

  const initial = readSession(file, 'sess', { tailBytes: 256, prepareNewestTurnDiscovery: true });
  assert.deepEqual(initial.turns, [], 'an ordinary tail that starts mid-turn drew a partial card');
  assert.ok(initial.newestTurnCursor);
  const ranges: Array<[number, number]> = [];
  let yields = 0;
  const found = await discoverClaudeNewestTurn(file, initial.newestTurnCursor, {
    chunkBytes: 257,
    readRange: recordingRangeReader(ranges),
    pause: async () => {
      yields += 1;
    },
  });
  assert.equal(found.kind, 'found');
  assert.ok(yields > 1, 'the fixture no longer crosses several yielded chunks');
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i][1], ranges[i - 1][0], 'two discovery reads overlap or leave a gap');
  }
  assert.equal(new Set(ranges.map(([start, end]) => `${start}:${end}`)).size, ranges.length);
  if (found.kind !== 'found') {
    return;
  }
  const recovered = readSession(file, 'sess', { tailBytes: found.readBytes, maxTurns: 1 });
  assert.deepEqual(
    recovered.turns.map((turn) => [turn.prompt, turn.summary]),
    [['newest ask', 'Newest work.']],
  );
  assert.equal(recovered.turnLimitReached, false);
});

test('newest Claude turn discovery notices cancellation and file replacement', async () => {
  const file = writeTranscript([
    userPrompt('newest ask', 0),
    assistantTool('Bash', 1, 'wide', { command: 'x'.repeat(5000) }),
    assistantAnswer('Newest work.', 2),
  ]);
  const initial = readSession(file, 'sess', { tailBytes: 128, prepareNewestTurnDiscovery: true });
  assert.ok(initial.newestTurnCursor);
  const controller = new AbortController();
  const cancelled = await discoverBackwardBoundary(file, initial.newestTurnCursor, () => false, {
    chunkBytes: 64,
    signal: controller.signal,
    pause: async () => controller.abort(),
  });
  assert.equal(cancelled.kind, 'cancelled');

  const cursor = tailOf(file, 128, true).cursor;
  assert.ok(cursor);
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, Buffer.alloc(cursor.revision.size, 0x20));
  fs.rmSync(file);
  fs.renameSync(replacement, file);
  const replaced = fs.statSync(file);
  assert.equal(replaced.size, cursor.revision.size);
  assert.ok(
    replaced.dev !== cursor.revision.dev || replaced.ino !== cursor.revision.ino,
    'the fixture did not replace the transcript identity',
  );
  assert.equal((await discoverClaudeNewestTurn(file, cursor, { chunkBytes: 64 })).kind, 'stale');
});

test('maxTurns keeps the newest turns', () => {
  const lines: object[] = [];
  for (let i = 0; i < 6; i++) {
    lines.push(userPrompt(`ask ${i}`, i * 2), assistantText(`did ${i}`, i * 2 + 1));
  }
  const read = readSession(writeTranscript(lines), 'sess', { maxTurns: 2 });
  assert.deepEqual(
    read.turns.map((t) => t.prompt),
    ['ask 4', 'ask 5'],
  );
  assert.equal(read.turnLimitReached, true);
});

test('the session title is taken from the last ai-title entry', () => {
  const rich = `\uE200visualize\uE202${JSON.stringify({ path: path.resolve('fixtures', 'rail.html') })}\uE201`;
  const file = writeTranscript([
    { type: 'ai-title', aiTitle: 'First guess at a title' },
    userPrompt('do the thing', 0),
    { type: 'ai-title', aiTitle: `Timeline view\n${rich}\nfor agent turns` },
    assistantText('Done.', 1),
  ]);
  assert.equal(readTurns(file, 'sess')[0].sessionTitle, 'Timeline view for agent turns');
});

test('cleanPrompt strips IDE context and slash-command scaffolding', () => {
  const raw = '<ide_selection>The user selected lines 1 to 2 from a.ts</ide_selection>\ncommit do not push yet';
  assert.equal(cleanPrompt(raw), 'commit do not push yet');
  assert.equal(cleanPrompt('<command-name>/model</command-name>\n<command-args>opus</command-args>'), '');
  assert.equal(
    cleanPrompt(
      '<command-message>write-ppm-docs</command-message>\n<command-name>/write-ppm-docs</command-name>\n<command-args>review the plugin pages</command-args>',
    ),
    '/write-ppm-docs review the plugin pages',
    'the command and everything typed after it are cut out of the card',
  );
});

test('literal Claude capture removes known scaffolding and preserves admitted user text', () => {
  const literal = '  Keep <Widget> and <custom-tag> exactly.\n\n\n    indented  words\n';
  const wrappers = [
    'ide_opened_file',
    'ide_selection',
    'ide_diagnostics',
    'system-reminder',
    'local-command-stdout',
    'local-command-stderr',
    'local-command-caveat',
    'command-message',
    'command-contents',
    'task-notification',
  ];
  const cases: [string, string][] = [
    [literal, literal],
    ...wrappers.map((tag): [string, string] => [`<${tag}>PRIVATE CONTEXT</${tag}>\n${literal}`, literal]),
    [`<ide_selection>PRIVATE CONTEXT</ide_selection>\r\n${literal}`, literal],
    [`before<ide_selection>PRIVATE CONTEXT</ide_selection>\nafter`, 'before\nafter'],
    [`${literal}<system-reminder>PRIVATE CONTEXT</system-reminder>`, literal],
    ['Keep <ide_selection> literally.', 'Keep <ide_selection> literally.'],
    [
      `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>\n${literal}`,
      literal,
    ],
    [
      '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>  <Widget>\n\n  exact  text\n</command-args>',
      '/review   <Widget>\n\n  exact  text\n',
    ],
    ['<command-message>review</command-message>\n<command-name>/review</command-name>', '/review'],
  ];
  for (const [raw, expected] of cases) {
    const reducer = createClaudeSessionReducer('sess', { captureSessionText: true });
    reducer.pushLine(JSON.stringify(userPrompt(raw, 0)));
    reducer.pushLine(JSON.stringify(assistantAnswer('Done.', 1)));
    assert.equal(reducer.read().turns[0].prompt, expected, raw);
  }
});

test('headlineOf skips section headings and returns the first line of substance', () => {
  assert.equal(headlineOf('## TLDR\n\n- Review fixes are in.\n- More detail.'), 'Review fixes are in.');
  assert.equal(headlineOf('**Summary:**\n\nAll three findings are addressed.'), 'All three findings are addressed.');
  assert.equal(headlineOf('Done. The hook is restored.'), 'Done. The hook is restored.');
  assert.equal(headlineOf('1. Fixed the parser'), 'Fixed the parser');
  assert.equal(headlineOf('See [store.ts](src/store.ts) for the rest'), 'See store.ts for the rest');
  assert.equal(headlineOf(''), '');
});

test("headlineOf keeps a code span's own underscores and drops only its backticks", () => {
  // Code-span underscores remain literal characters in the headline.

  assert.equal(
    headlineOf('**Phase 0 is done.** Codex publishes `CODEX_SESSION_ID`, so both agents can name themselves.'),
    'Phase 0 is done. Codex publishes CODEX_SESSION_ID, so both agents can name themselves.',
  );
  assert.equal(headlineOf('Run `a*b_c` to reproduce it.'), 'Run a*b_c to reproduce it.');
});

test('headlineOf keeps underscores and stray asterisks outside emphasis, and still strips real emphasis', () => {
  // Filename underscores remain literal characters outside emphasis.

  assert.equal(headlineOf('Renamed my_file.py to calc_total.py'), 'Renamed my_file.py to calc_total.py');
  // A lone `*` with spaces on both sides is not an emphasis marker by the GFM rule.
  assert.equal(headlineOf('The answer is 2 * 3, not 5.'), 'The answer is 2 * 3, not 5.');
  // Real emphasis still loses its markers, on both punctuation marks.
  assert.equal(headlineOf('**Bold** and *em* and _also em_ are done.'), 'Bold and em and also em are done.');
});

test('headlineOf agrees with what marked renders for nested, tripled and intraword markers', () => {
  // Headline text follows the inline Markdown renderer for nested and intraword markers.

  const cases = [
    'nested **bold *em* inside** text',
    '*em **strong** em* text',
    'a ***bold em*** line',
    'a ___bold em___ line',
    'call __init__ to set it up',
    'use *args and **kwargs here',
    'snake_case stays as is',
  ];
  for (const line of cases) {
    const rendered = renderInlineMarkdown(line).replace(/<\/?(strong|em)>/g, '');
    assert.equal(headlineOf(line), rendered, line);
  }
});

test('headlineOf normalizes escaped punctuation without changing code spans or literal backslashes', () => {
  assert.equal(
    headlineOf(SESSION_LINK_RESPONSE),
    'Launched code-coordinate-1-native-session-skills-sol, pinned under packaging.',
  );
  assert.equal(headlineOf(String.raw`**A\-B** and \*literal\* with \q.`), String.raw`A-B and *literal* with \q.`);
  assert.equal(headlineOf('Run `a\\-b`'), String.raw`Run a\-b`);
});

test('headlineOf skips a fence line and reads the content it encloses', () => {
  // A fence opener's language tag supplies no headline text.

  assert.equal(headlineOf('```markdown\n**Done** - the report is ready.\n```'), '**Done** - the report is ready.');
  assert.equal(headlineOf('```\nPlain code line.\n```'), 'Plain code line.');
  const line = '[example](arc-session:01a137a5-3d93-71d0-9492-965abeb0fa32)';
  for (const summary of [
    `1. \`\`\`\n\t${line}\n\t\`\`\``,
    `- \`\`\`\n\t${line}\n\t\`\`\``,
    `- \`\`\`markdown\n  ${line}\n  \`\`\``,
    `> - \`\`\`\n>   ${line}\n>   \`\`\``,
    `> 1. > ~~~~text\n>    > ${line}\n>    > ~~~~`,
    `- \`\`\`\`markdown\n  ${line}\n  \`\`\``,
  ]) {
    assert.equal(headlineOf(summary), line, summary);
    assert.equal(headlineMarkdownOf(summary), line, summary);
  }
  assert.equal(headlineOf('- ~~~\n  \n  ~~~\n\nThe response follows.'), 'The response follows.');
});

test('headlineMarkdownOf picks the same line as headlineOf and keeps its markup', () => {
  const summary = '## TLDR\n\n- Ran `npm test` and **all** pass';
  assert.equal(headlineOf(summary), 'Ran npm test and all pass');
  assert.equal(headlineMarkdownOf(summary), 'Ran `npm test` and **all** pass');

  assert.equal(
    headlineMarkdownOf('**Summary:**\n\nAll three findings are addressed.'),
    'All three findings are addressed.',
  );
  assert.equal(headlineMarkdownOf('1. Fixed the `parser`'), 'Fixed the `parser`');
  assert.equal(
    headlineMarkdownOf('```markdown\n**Done** - the report is ready.\n```'),
    '**Done** - the report is ready.',
  );
  assert.equal(headlineMarkdownOf(''), '');
});

test('shortenTo leaves a line that fits alone, and never cuts a character in half', () => {
  assert.equal(shortenTo('short enough', 20, '...'), 'short enough');
  assert.equal(shortenTo('x'.repeat(20), 20, '...'), 'x'.repeat(20), 'a line at the limit is not cut');
  assert.equal(shortenTo('x'.repeat(21), 20, '...'), 'x'.repeat(17) + '...');

  // The emoji straddles the cut, so a count of code units ends on its first half.
  const straddling = 'x'.repeat(16) + '\u{1F6A7} and more';
  const cut = shortenTo(straddling, 20, '...');
  assert.ok(!HALF_A_CHARACTER.test(cut), 'the cut left half a character behind');
  assert.equal(cut, 'x'.repeat(16) + '...');

  // One place earlier the emoji is whole, and is kept whole.
  assert.equal(shortenTo('x'.repeat(15) + '\u{1F6A7} and more', 20, '...'), 'x'.repeat(15) + '\u{1F6A7}...');

  // Short limits retain the ellipsis without applying a negative substring offset.

  for (const limit of [20, 3, 1, 0]) {
    for (const line of [straddling, 'x'.repeat(60), '\u{1F6A7}'.repeat(30)]) {
      assert.ok(
        shortenTo(line, limit, '...').length <= Math.max(limit, '...'.length),
        `"${line}" was shortened past a limit of ${limit}`,
      );
    }
  }
});

// Title conversion removes complete Markdown syntax and preserves malformed or literal marks.

test('plainTitle reduces link and image syntax to the text a reader would see', () => {
  assert.equal(plainTitle('[link text](https://x.example/page)'), 'link text');
  // Skill links from the editor can escape their target's opening parenthesis.

  assert.equal(plainTitle('[$review-ai-pr]\\(/c:/skills/review-ai-pr/SKILL.md)'), '$review-ai-pr');
  assert.equal(plainTitle('![alt words](chart.png)'), 'alt words');
  assert.equal(plainTitle('see [the doc](a.md) and ![a chart](b.png) here'), 'see the doc and a chart here');
  // Malformed or half-typed syntax is left exactly as typed.
  assert.equal(plainTitle('[text](unclosed'), '[text](unclosed');
  assert.equal(plainTitle('[text] (a gap)'), '[text] (a gap)');
  assert.equal(plainTitle('[no target]'), '[no target]');
});

test('plainTitle keeps the visible text of code and balanced emphasis, and literal marks stay', () => {
  assert.equal(plainTitle('run `npm test` first'), 'run npm test first');
  assert.equal(plainTitle('**bold** and *em* and _low_ and __dunder__'), 'bold and em and low and dunder');
  // Emphasis inside a link is reduced too, the link first.
  assert.equal(plainTitle('[**bold** name](x)'), 'bold name');
  // Intraword and unbalanced marks are someone's real characters, not syntax.
  assert.equal(plainTitle('foo_bar'), 'foo_bar');
  assert.equal(plainTitle('a*b'), 'a*b');
  assert.equal(plainTitle('2*3*4 is 24'), '2*3*4 is 24');
  assert.equal(plainTitle('a ` lone backtick'), 'a ` lone backtick');
  assert.equal(plainTitle('* not emphasis, a bullet'), '* not emphasis, a bullet');
  // A code span shows its text as it stands, so emphasis is not run over what it held.
  assert.equal(plainTitle('`*glob*` patterns'), '*glob* patterns');
});

test('openingLines takes the list a summary opens with, and stops before the one it closes with', () => {
  // The opening list precedes a separator, prose, and a separate closing list.

  const summary = [
    '**TLDR**',
    '',
    '- Batch two landed and the suite is green.',
    '- One decision is still open.',
    '',
    '---',
    '',
    'Some prose about the work, which is not a list at all.',
    '',
    '- **Your actions** - reload the panel',
    '- **Open questions** - none',
  ].join('\n');
  assert.deepEqual(openingLines(summary), ['Batch two landed and the suite is green.', 'One decision is still open.']);

  // The other heading form, and a list with no heading above it at all.
  assert.deepEqual(openingLines('## TLDR\n\n- Only this one.'), ['Only this one.']);
  assert.deepEqual(openingLines('- Straight into it.\n- And a second.'), ['Straight into it.', 'And a second.']);

  // A summary that opens with a sentence has no such list, and neither has an empty one.
  assert.deepEqual(openingLines('Done. The hook is restored.\n\n- a later bullet'), []);
  assert.deepEqual(openingLines(''), []);

  // Numbered items and continuation lines preserve the opening list's later items.

  assert.deepEqual(openingLines('1. First thing.\n2. Second thing.'), ['First thing.', 'Second thing.']);
  assert.deepEqual(openingLines('- First thing,\n  wrapped onto a second line.\n- Second thing.'), [
    'First thing,',
    'Second thing.',
  ]);

  // A blank line separates the opening list from later lists.

  assert.deepEqual(openingLines('- The one thing.\n\n- **Your actions** - reload'), ['The one thing.']);

  // Written on Windows, with a carriage return at the end of every line.
  assert.deepEqual(openingLines('**TLDR**\r\n\r\n- One thing.\r\n- And another.\r\n'), ['One thing.', 'And another.']);

  // Fence openers supply no list item text.

  assert.deepEqual(openingLines('```markdown\n- One thing.\n- And another.\n```'), ['One thing.', 'And another.']);
});

test('projectSlug and transcriptDirsFor match a workspace folder whatever the drive case', () => {
  assert.equal(projectSlug('c:\\Users\\dev\\Projects\\work\\arc'), 'c--Users-dev-Projects-work-arc');
  assert.equal(
    projectSlug('C:\\Users\\dev\\Documents\\game-projects\\Lens_Custom'),
    'C--Users-dev-Documents-game-projects-Lens-Custom',
  );

  const root = tempDir('proj-');
  fs.mkdirSync(path.join(root, 'C--Users-dev-Documents-game-projects-Lens-Custom'));
  fs.mkdirSync(path.join(root, 'c--Users-dev-Projects-elsewhere'));
  const found = transcriptDirsFor(root, ['c:\\Users\\dev\\Documents\\game-projects\\Lens_Custom']);
  assert.deepEqual(
    found.map((d) => path.basename(d)),
    ['C--Users-dev-Documents-game-projects-Lens-Custom'],
    'an empty directory is kept on an exact name match, so the panel can say it was empty',
  );
  assert.deepEqual(transcriptDirsFor(root, []), []);
});

test('a directory whose name matches but whose sessions ran elsewhere is not read', () => {
  // Distinct working directories can share a slug. Recorded cwd determines workspace membership.

  const root = tempDir('proj-');
  const dir = 'c--work-a-b';
  fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(
    path.join(root, dir, 's.jsonl'),
    JSON.stringify({ type: 'user', cwd: 'c:\\work\\a_b', message: { role: 'user', content: 'hi' } }) + '\n',
  );
  assert.deepEqual(
    transcriptDirsFor(root, ['c:\\work\\a-b']),
    [],
    'the name collides but the recorded cwd is a different folder',
  );
  assert.deepEqual(
    transcriptDirsFor(root, ['c:\\work\\a_b']).map((d) => path.basename(d)),
    [dir],
  );
});

test('listSessionFiles returns non-empty jsonl transcripts, newest first', () => {
  const dir = tempDir('sess-');
  fs.writeFileSync(path.join(dir, 'old.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'new.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'old.jsonl'), past, past);
  assert.deepEqual(
    listSessionFiles(dir).map((s) => s.sessionId),
    ['new', 'old'],
  );
  // Session files identify their source agent for parser selection.

  assert.deepEqual(
    listSessionFiles(dir).map((s) => s.agent),
    ['claude', 'claude'],
  );
  for (const session of listSessionFiles(dir)) {
    const stat = fs.statSync(session.file, { bigint: true });
    assert.deepEqual([session.dev, session.ino], [stat.dev.toString(), stat.ino.toString()]);
  }
});

test('a turn says the agent that recorded it, which decides what a card may claim about it', () => {
  const file = writeTranscript([userPrompt('build the timeline', 0), assistantText('Done.', 1, { output_tokens: 10 })]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.agent, 'claude');
  // Without a recorded context window, the turn leaves contextWindow unavailable.

  assert.equal(turn.contextWindow, null, 'no window is recorded per turn, so the table answers');
});

test('normalizeFsPath makes transcript and snapshot-store paths comparable', () => {
  assert.equal(normalizeFsPath('c:/repo/a.ts'), normalizeFsPath('C:\\repo\\a.ts'));
  assert.notEqual(normalizeFsPath('c:/repo/a.ts'), normalizeFsPath('c:/repo/b.ts'));
  for (const platform of ['win32', 'linux', 'darwin']) {
    vi.stubGlobal('process', { ...process, platform });
    try {
      assert.equal(normalizeFsPath('C:/Repo/File.ts'), 'c:/repo/file.ts');
      assert.equal(normalizeFsPath('/Repo/File.ts'), platform === 'win32' ? '/repo/file.ts' : '/Repo/File.ts');
      assert.equal(normalizeFsPath('/Repo/File.ts') === normalizeFsPath('/repo/file.ts'), platform === 'win32');
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

// A matcher built once must answer exactly as isInside does for the same folders.
test('folderMatcher agrees with isInside on drive casing, separators, trailing slashes and prefix collisions', () => {
  const folders = ['C:\\a\\arc\\', 'c:/a/arc-complete', '/srv/Repo'];
  const cases: [string, boolean, boolean][] = [
    // [target, inside on win32, inside on POSIX]
    ['C:\\a\\arc', true, true],
    ['c:/A/ARC/sub/file.ts', true, true],
    ['C:\\a\\arc\\deep\\file.ts', true, true],
    ['c:/a/arc/', true, true],
    ['c:/a/arc-complete-68', false, false],
    ['c:/a/arc-complete-68/x', false, false],
    ['c:/a/arc-complete/x', true, true],
    ['c:/a/arcade', false, false],
    ['c:/a', false, false],
    ['/srv/Repo', true, true],
    ['/srv/Repo/src', true, true],
    ['/srv/repo/src', true, false],
    ['/srv/Repository', false, false],
    ['', false, false],
  ];
  for (const platform of ['win32', 'linux', 'darwin']) {
    vi.stubGlobal('process', { ...process, platform });
    try {
      const inFolders = folderMatcher(folders);
      for (const [target, win, posix] of cases) {
        const expected = platform === 'win32' ? win : posix;
        assert.equal(inFolders(target), expected, `${platform}: ${target}`);
        assert.equal(isInside(target, folders), expected, `${platform}: ${target} through isInside`);
      }
      assert.equal(folderMatcher([])('c:/a/arc'), false, 'no folders contain nothing');
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

// The snapshot hook and transcript parser share the ephemeral-path fixture.

test('isEphemeralPath matches the shared ephemeral-paths fixture', () => {
  const fixtureFile = path.join(__dirname, '..', '..', 'test', 'fixtures', 'ephemeral-paths.json');
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as {
    ignoreRoots: string[];
    shapes: string[];
    cases: { path: string; ephemeral: boolean; why: string }[];
  };
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR =
    path.join(os.homedir(), 'arc-agent-home-parent') + `${path.sep}..${path.sep}arc-claude-home-fixture`;
  process.env.CODEX_HOME =
    path.join(os.homedir(), 'arc-agent-home-parent') + `${path.sep}..${path.sep}arc-codex-home-fixture`;
  const fill = (t: string) =>
    t
      .replace('{arcHome}', process.env.ARC_HOME || path.join(os.homedir(), '.arc'))
      .replace('{claudeHome}', path.normalize(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')))
      .replace('{codexHome}', path.normalize(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')))
      .replace('{tmp}', os.tmpdir())
      .replace('{home}', os.homedir())
      .split('/')
      .join(path.sep);
  const previous = process.env.ARC_IGNORE_ROOTS;
  process.env.ARC_IGNORE_ROOTS = fixture.ignoreRoots.map(fill).join(path.delimiter);
  try {
    // Each fixture path retains its classification across the listed path forms.

    const shape = (native: string, kind: string) => {
      if (kind === 'forward-slash') {
        return native.split(path.sep).join('/');
      }
      if (kind === 'lower-drive') {
        return native.replace(/^([A-Z]):/, (m: string, d: string) => d.toLowerCase() + ':');
      }
      if (kind === 'trailing-slash') {
        return native + path.sep;
      }
      return native;
    };
    for (const c of fixture.cases) {
      for (const kind of fixture.shapes) {
        // File paths omit the trailing-slash form. Directory cases retain it for both classifications.

        if (kind === 'trailing-slash' && /\.[a-z]+$/.test(c.path)) {
          continue;
        }
        assert.equal(isEphemeralPath(shape(fill(c.path), kind)), c.ephemeral, `${c.path} as ${kind}: ${c.why}`);
      }
    }
    // Default ignore roots apply the fixture's classifications without an environment override.

    delete process.env.ARC_IGNORE_ROOTS;
    for (const c of fixture.cases) {
      assert.equal(isEphemeralPath(fill(c.path)), c.ephemeral, `${c.path} against the shipped roots: ${c.why}`);
    }
    process.env.ARC_IGNORE_ROOTS = '';
    assert.equal(isEphemeralPath(fill(fixture.cases[0].path)), false, 'an empty ignore list disables the rule');
  } finally {
    if (previous === undefined) {
      delete process.env.ARC_IGNORE_ROOTS;
    } else {
      process.env.ARC_IGNORE_ROOTS = previous;
    }
    if (previousClaude === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaude;
    }
    if (previousCodex === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodex;
    }
  }
});

test('CLAUDE_CONFIG_DIR moves the transcript tree that session discovery reads', () => {
  const previousProjects = process.env.ARC_PROJECTS_ROOT;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const claudeHome = tempDir('claude-home-');
  const cwd = path.join(tempDir('claude-workspace-'), 'repo');
  const projectDir = path.join(claudeHome, 'projects', projectSlug(cwd).toLowerCase());
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'moved.jsonl'),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n',
  );
  try {
    delete process.env.ARC_PROJECTS_ROOT;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    assert.deepEqual(
      sessionFilesFor(projectsRoot(), [cwd]).map((session) => session.sessionId),
      ['moved'],
    );
  } finally {
    if (previousProjects === undefined) {
      delete process.env.ARC_PROJECTS_ROOT;
    } else {
      process.env.ARC_PROJECTS_ROOT = previousProjects;
    }
    if (previousClaude === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaude;
    }
  }
});

test('the Arc project override wins, and an empty Claude config home uses the home directory', () => {
  const previousProjects = process.env.ARC_PROJECTS_ROOT;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousIgnore = process.env.ARC_IGNORE_ROOTS;
  const projects = path.join(os.tmpdir(), 'arc-projects-fixture');
  const claudeHome = path.join(os.tmpdir(), 'claude-home-fixture');
  const ignored = path.join(os.homedir(), 'arc-ignored-fixture');
  try {
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.ARC_PROJECTS_ROOT = projects;
    assert.equal(projectsRoot(), projects);
    delete process.env.ARC_PROJECTS_ROOT;
    assert.equal(projectsRoot(), path.join(claudeHome, 'projects'));
    process.env.CLAUDE_CONFIG_DIR = 'relative-claude-home';
    assert.equal(projectsRoot(), path.join('relative-claude-home', 'projects'));
    process.env.CLAUDE_CONFIG_DIR = '';
    assert.equal(projectsRoot(), path.join(os.homedir(), '.claude', 'projects'));

    process.env.ARC_IGNORE_ROOTS = ignored;
    assert.equal(isEphemeralPath(path.join(ignored, 'note.md')), true);
    process.env.ARC_IGNORE_ROOTS = '';
    assert.equal(isEphemeralPath(path.join(ignored, 'note.md')), false, 'an empty ignore list disables the rule');
  } finally {
    if (previousProjects === undefined) {
      delete process.env.ARC_PROJECTS_ROOT;
    } else {
      process.env.ARC_PROJECTS_ROOT = previousProjects;
    }
    if (previousClaude === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaude;
    }
    if (previousIgnore === undefined) {
      delete process.env.ARC_IGNORE_ROOTS;
    } else {
      process.env.ARC_IGNORE_ROOTS = previousIgnore;
    }
  }
});

test('a stop by the user ends the turn instead of starting a new one', () => {
  const file = writeTranscript([
    userPrompt('do the long thing', 0),
    assistantTool('Bash', 1),
    { type: 'user', timestamp: at(2), message: { role: 'user', content: '[Request interrupted by user]' } },
    userPrompt('never mind, do this instead', 3),
    assistantText('Done.', 4),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].interrupted, true);
  assert.equal(turns[0].prompt, 'do the long thing');
  assert.equal(turns[1].interrupted, false);
});

test('the tool mix, failures, model and commits are read off the turn', () => {
  const file = writeTranscript([
    userPrompt('build and commit it', 0),
    assistantTool('Read', 1, 't1'),
    assistantTool('Grep', 2, 't2'),
    assistantTool('Edit', 3, 't3'),
    assistantTool('Bash', 4, 't4', { command: 'git commit -a -m "the change" && git commit -a -m "the second"' }),
    commitResult(
      '[feat/x 00facf2ab1] Add the timeline\n 3 files changed, 12 insertions(+)\n' +
        '[main deadbee] Second commit\n 5 files changed, 7 insertions(+), 2 deletions(-)',
      5,
      't4',
    ),
    {
      type: 'user',
      timestamp: at(6),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'denied' }],
      },
    },
    assistantText('Committed.', 7),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.model, 'claude-opus-5');
  assert.equal(turn.toolUses, 4);
  assert.deepEqual(turn.toolCounts, {
    edits: 1,
    reads: 1,
    searches: 1,
    commands: 1,
    agents: 0,
    coordination: 0,
    web: 0,
    other: 0,
  });
  assert.deepEqual(turn.failures, [{ tool: 'Grep', message: 'denied' }]);
  // Two commits in the same turn, each keeping its own figures rather than sharing one.
  assert.deepEqual(turn.commits, [
    {
      sha: '00facf2a',
      printedSha: '00facf2ab1',
      subject: 'Add the timeline',
      head: { kind: 'branch', name: 'feat/x' },
      files: 3,
      added: 12,
      removed: 0,
      at: ms(5),
      place: null,
      dir: null,
    },
    {
      sha: 'deadbee',
      subject: 'Second commit',
      head: { kind: 'branch', name: 'main' },
      files: 5,
      added: 7,
      removed: 2,
      at: ms(5),
      place: null,
      dir: null,
    },
  ]);
});

test('agent coordination is separate from launches, and every tool is tallied', () => {
  const file = writeTranscript([
    userPrompt('delegate and report', 0),
    assistantTool('Agent', 1, 'agent-1', { description: 'Review the diff' }),
    assistantTool('SendMessage', 2, 'message-1', { recipient: 'reviewer' }),
    assistantTool('ListAgents', 3, 'list-1'),
    assistantTool('TaskOutput', 4, 'output-1'),
    assistantTool('TaskStop', 5, 'stop-1'),
    assistantText('Done.', 6),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.toolCounts.agents, 1);
  assert.equal(turn.toolCounts.coordination, 4);
  assert.equal(turn.toolCounts.other, 0);
  assert.deepEqual(turn.toolTally, {
    Agent: 1,
    SendMessage: 1,
    ListAgents: 1,
    TaskOutput: 1,
    TaskStop: 1,
  });
  assert.equal(turn.agents.length, 1);
});

test('the tool tally is complete beyond the activity step window', () => {
  const tools = Array.from({ length: 80 }, (_, i) => assistantTool(`Tool${i}`, i + 1, `t${i}`));
  const [turn] = readTurns(
    writeTranscript([userPrompt('run many tools', 0), ...tools, assistantText('Done.', 81)]),
    'sess',
  );
  assert.equal(Object.keys(turn.toolTally).length, 80);
  assert.equal(
    Object.values(turn.toolTally).reduce((sum, count) => sum + count, 0),
    80,
  );
  assert.equal(turn.steps.length, 60);
  assert.equal(turn.stepCount, 80);
});

test('tool names inherited by ordinary objects remain ordinary tally rows', () => {
  const names = ['constructor', 'toString', '__proto__'];
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('run oddly named tools', 0),
      ...names.map((name, i) => assistantTool(name, i + 1, `t${i}`)),
      assistantText('Done.', 4),
    ]),
    'sess',
  );
  assert.deepEqual(Object.keys(turn.toolTally), names);
  for (const name of names) {
    assert.ok(Object.prototype.hasOwnProperty.call(turn.toolTally, name));
    assert.equal(turn.toolTally[name], 1);
  }
});

test('a deletions-only stat line leaves the insertions figure at zero, not null', () => {
  const file = writeTranscript([
    userPrompt('delete the dead code', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[main a1b2c3d4] Remove dead code\n 2 files changed, 30 deletions(-)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: 'a1b2c3d4',
      subject: 'Remove dead code',
      head: { kind: 'branch', name: 'main' },
      files: 2,
      added: 0,
      removed: 30,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('singular file, insertion and deletion each parse on their own', () => {
  const file = writeTranscript([
    userPrompt('tiny fix', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[main cafebabe] One-line fix\n 1 file changed, 1 insertion(+), 1 deletion(-)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: 'cafebabe',
      subject: 'One-line fix',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 1,
      removed: 1,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('a commit line whose next line is not a stat line reports null figures, not zero', () => {
  const file = writeTranscript([
    userPrompt('commit it', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[main 9988776] Wire up the hook\nwarning: pre-commit hook printed extra output', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: '9988776',
      subject: 'Wire up the hook',
      head: { kind: 'branch', name: 'main' },
      files: null,
      added: null,
      removed: null,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('an amend still reports its figures, though git puts a Date line above the stat line', () => {
  const file = writeTranscript([
    userPrompt('fix that commit', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[main 6441f1a] Second\n Date: Mon Aug 24 15:57:18 2026 -0500\n 1 file changed, 2 insertions(+)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: '6441f1a',
      subject: 'Second',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 2,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('an Author line and a Date line together do not hide the stat line', () => {
  const file = writeTranscript([
    userPrompt('commit for someone else', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult(
      '[main 1ed2347] Other author\n Author: Someone Else <se@x.com>\n Date: Mon Aug 24 15:57:39 2026 -0500\n 1 file changed, 2 insertions(+)',
      2,
    ),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: '1ed2347',
      subject: 'Other author',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 2,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('the scan for a stat line stops at the next commit rather than borrowing its figures', () => {
  const file = writeTranscript([
    userPrompt('commit twice', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[main aaaaaaa1] Quiet one\n[main bbbbbbb2] Loud one\n 4 files changed, 9 insertions(+)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: 'aaaaaaa1',
      subject: 'Quiet one',
      head: { kind: 'branch', name: 'main' },
      files: null,
      added: null,
      removed: null,
      at: ms(2),
      place: null,
      dir: null,
    },
    {
      sha: 'bbbbbbb2',
      subject: 'Loud one',
      head: { kind: 'branch', name: 'main' },
      files: 4,
      added: 9,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('file, insertion and deletion pluralise independently of one another', () => {
  const file = writeTranscript([
    userPrompt('one big edit', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[main deadbee1] One file, many lines\n 1 file changed, 12 insertions(+)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: 'deadbee1',
      subject: 'One file, many lines',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 12,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('a rename records the zeros git printed rather than reading as unknown', () => {
  const file = writeTranscript([
    userPrompt('rename it', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult(
      '[main ecdc9c4] Rename\n 1 file changed, 0 insertions(+), 0 deletions(-)\n rename a.txt => b.txt (100%)',
      2,
    ),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: 'ecdc9c4',
      subject: 'Rename',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 0,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

// Root and detached-head commit output can contain extra words before the hash.

test('a repository first commit is recorded, though git names it a root commit', () => {
  const file = writeTranscript([
    userPrompt('start the repo', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult(
      '[main (root-commit) 882e6ea] Initial commit\n 1 file changed, 1 insertion(+)\n create mode 100644 a.txt',
      2,
    ),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: '882e6ea',
      subject: 'Initial commit',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 1,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('a commit made off a branch is recorded, though git names no branch', () => {
  const file = writeTranscript([
    userPrompt('commit while bisecting', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[detached HEAD cac66e9] On detached\n 1 file changed, 1 insertion(+)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: 'cac66e9',
      subject: 'On detached',
      head: { kind: 'detached' },
      files: 1,
      added: 1,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

test('a first commit made off a branch carries both markers and is still recorded', () => {
  const file = writeTranscript([
    userPrompt('start it detached', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult('[detached HEAD (root-commit) 882e6ea] Initial commit\n 1 file changed, 1 insertion(+)', 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, [
    {
      sha: '882e6ea',
      subject: 'Initial commit',
      head: { kind: 'detached' },
      files: 1,
      added: 1,
      removed: 0,
      at: ms(2),
      place: null,
      dir: null,
    },
  ]);
});

// Commit directory fixtures cover shell location changes and per-command Git directories.

const HOME = 'C:/Users/dev';
const REPO = 'c:/Users/dev/Projects/work/arc';
const NOTES = 'C:/Users/dev/Projects/side-repo';

test('the directory a commit is made in is tracked through the command that made it', () => {
  const dirs = (command: string, cwd: string | null = REPO) => commitDirs(command, cwd, HOME);

  assert.deepEqual(dirs('cd ~/Projects/side-repo && git add -A && git commit -m "notes"'), [NOTES]);
  assert.deepEqual(dirs('cd "C:/Users/dev/Projects/side-repo" && git add . && git commit -m "notes"'), [NOTES]);
  // Git Bash and WSL drive paths resolve to the corresponding Windows directory.

  assert.deepEqual(dirs('cd /c/Users/dev/Projects/side-repo && git commit -m "notes"'), [NOTES]);
  assert.deepEqual(dirs('cd /mnt/c/Users/dev/Projects/side-repo && git commit -m "notes"'), [NOTES]);
  // A relative move resolves against the directory the call started in. This one goes up
  // out of a sub-directory and lands back in the repository it started under.
  assert.deepEqual(dirs('cd .. && git add docs && git commit -m "up one"', REPO + '/extension'), [REPO]);
  // git -C changes one Git command's directory without moving the shell.

  assert.deepEqual(
    dirs(
      'git -C "C:/Users/dev/Projects/side-repo" add . && git -C "C:/Users/dev/Projects/side-repo" commit -m "notes"',
    ),
    [NOTES],
  );
  assert.deepEqual(dirs('git -C C:/Users/dev/Projects/side-repo commit -m "bare"'), [NOTES]);
  assert.deepEqual(dirs('git -C "C:/Users/dev/Projects/side-repo" commit -m "a" && git commit -m "b"'), [NOTES, REPO]);
  // PowerShell moves with its own verb.
  assert.deepEqual(dirs('Push-Location "C:/Users/dev/Projects/side-repo"; git add .; git commit -m "notes"'), [NOTES]);
  // A target this reader cannot expand names nothing rather than a guess.
  assert.deepEqual(dirs('cd "$REPO" && git commit -m "x"'), [null]);
  assert.deepEqual(dirs('cd - && git commit -m "x"'), [null]);
  assert.deepEqual(dirs('git -C "$V" commit -m "x"'), [null]);
  // Nor can a relative move be resolved with no directory recorded for the call.
  assert.deepEqual(dirs('cd sub && git commit -m "x"', null), [null]);
  // A call that makes no commit answers with nothing at all.
  assert.deepEqual(dirs('git log --oneline -1 && git status --short'), []);
});

test('a relative parent command cannot leave a UNC share', () => {
  assert.deepEqual(commitDirs('cd ../.. && git commit -m "x"', '//server/share/repo', HOME), ['//server/share']);
});

// Absolute destinations resolve equally as full paths or as a root followed by relative moves.

test('a destination is read the same in every shape a shell writes it', () => {
  const dirs = (command: string, cwd: string | null = REPO) => commitDirs(command, cwd, HOME);
  const shapes: { whole: string; root: string; under: string }[] = [
    { whole: 'C:/Users/dev/Projects/side-repo', root: 'C:/', under: 'Users/dev/Projects/side-repo' },
    { whole: 'C:\\Users\\dev\\Projects\\side-repo', root: 'C:\\', under: 'Users\\dev\\Projects\\side-repo' },
    { whole: '"C:\\Users\\dev\\Projects\\side-repo"', root: '"C:/"', under: '"Users\\dev\\Projects\\side-repo"' },
    { whole: '/c/Users/dev/Projects/side-repo', root: '/c', under: 'Users/dev/Projects/side-repo' },
    { whole: '/mnt/c/Users/dev/Projects/side-repo', root: '/mnt/c', under: 'Users/dev/Projects/side-repo' },
    { whole: '/cygdrive/c/Users/dev/Projects/side-repo', root: '/cygdrive/c', under: 'Users/dev/Projects/side-repo' },
    { whole: '~/Projects/side-repo', root: '~', under: 'Projects/side-repo' },
    { whole: '$HOME/Projects/side-repo', root: '$HOME', under: 'Projects/side-repo' },
  ];
  for (const s of shapes) {
    assert.deepEqual(dirs(`cd ${s.whole} && git commit -m "x"`), [NOTES], s.whole);
    assert.deepEqual(dirs(`cd ${s.root} && cd ${s.under} && git commit -m "x"`), [NOTES], `${s.root} then ${s.under}`);
  }
  // A backslash can escape a space in an unquoted Bash path.

  assert.deepEqual(dirs('cd /c/Users/dev/My\\ Documents && git commit -m "x"'), ['C:/Users/dev/My Documents']);
});

// PowerShell names the destination as readily as it writes it bare, and `-Path` and
// `-LiteralPath` are the two spellings of the parameter that holds it.
test('a move is read past the parameter that names its destination', () => {
  const dirs = (command: string, cwd: string | null = REPO) => commitDirs(command, cwd, HOME);
  const moves = [
    'cd',
    'chdir',
    'Set-Location',
    'set-location',
    'Push-Location',
    'pushd',
    'Set-Location -Path',
    'Set-Location -LiteralPath',
    'Set-Location -path',
    'Push-Location -Path',
    'cd -Path',
  ];
  for (const move of moves) {
    assert.deepEqual(dirs(`${move} "C:\\Users\\dev\\Projects\\side-repo"; git commit -m "x"`), [NOTES], move);
    assert.deepEqual(
      dirs(`${move} C:\\Users\\dev\\Projects\\side-repo; git commit -m "x"`),
      [NOTES],
      `${move} unquoted`,
    );
  }
  // PowerShell also writes a parameter and its value joined by a colon.
  assert.deepEqual(dirs('Set-Location -Path:"C:\\Users\\dev\\Projects\\side-repo"; git commit -m "x"'), [NOTES]);
  // An unsupported location parameter leaves the destination unavailable.

  assert.deepEqual(dirs('Set-Location -Stack work; git commit -m "x"'), [null]);
  assert.deepEqual(dirs('cd -- sub; git commit -m "x"'), [null]);
});

test('a command is read past its quoting, so neither a heredoc nor a message is taken for a call', () => {
  // The words `git commit` inside a heredoc body are text being written to a file, and the
  // body's own newlines are not command separators either.
  const heredoc = [
    "cat > msg.txt <<'EOF'",
    'The rule is that git commit is what prints the line;',
    'cd /somewhere and run git commit, then read it back.',
    'EOF',
    'git commit -F msg.txt',
  ].join('\n');
  assert.deepEqual(commitDirs(heredoc, REPO, HOME), [REPO]);
  // Quoted commit-message separators and escaped quotes remain inside one argument.

  assert.deepEqual(commitDirs('git commit -m "Keep the panel; do not split it, said \\"the note\\""', REPO, HOME), [
    REPO,
  ]);
  assert.deepEqual(commitDirs('git commit -m "cd /tmp && git commit again"', REPO, HOME), [REPO]);
  // Arithmetic reads `<<` as a shift, so no heredoc hides the commit after it.
  assert.deepEqual(commitDirs('echo "$((1 << 3))"\ngit commit -m real', REPO, HOME), [REPO]);
  assert.deepEqual(commitDirs('echo $((1 << 3))\ngit commit -m real', REPO, HOME), [REPO]);
  // A parenthesis inside arithmetic stays arithmetic, so its `<<` is a shift too.
  assert.deepEqual(commitDirs('echo "$(((1 << 3)))"\ngit commit -m real', REPO, HOME), [REPO]);
  assert.deepEqual(commitDirs('echo $(( (2 + (1 << 3)) * 2 ))\ngit commit -m real', REPO, HOME), [REPO]);
});

test('a directory is attributed to a call only when every commit in it names the same one', () => {
  const call = (command: string, cwd: string | null = REPO) => commitPlaceOf({ command, cwd, at: 0 }, [REPO], HOME);

  assert.deepEqual(call('cd ~/Projects/side-repo && git add -A && git commit -m "notes"'), {
    kind: 'named',
    dir: NOTES,
  });
  // Twice into the same foreign repository is still that one repository, named.
  assert.deepEqual(call('cd ~/Projects/side-repo && git commit -m "a" && git commit -m "b"'), {
    kind: 'named',
    dir: NOTES,
  });
  // Workspace commits carry no foreign-repository label.

  assert.equal(call('git add -A && git commit -m "here"'), null);
  assert.equal(call('cd extension && git commit -m "still here"'), null);
  assert.equal(call('cd .. && git add docs && git commit -m "up one"', REPO + '/extension'), null);
  // Two distinct foreign targets supply an unnamed foreign-repository label.

  assert.deepEqual(
    call('cd ~/Projects/side-repo && git commit -m "a" && cd ~/Projects/work/other-repo && git commit -m "b"'),
    { kind: 'unnamed' },
  );
  // A mixture of local and foreign targets supplies no foreign-repository label.

  assert.equal(call('git commit -m "a" && cd ~/Projects/side-repo && git commit -m "b"'), null);
  assert.equal(call('cd ~/Projects/side-repo && git commit -m "a" && cd ' + REPO + ' && git commit -m "b"'), null);
  // An unresolved target supplies no foreign-repository label.

  assert.equal(call('git -C "$R" commit -m "a" && git -C "C:/Users/dev/Projects/side-repo" commit -m "b"'), null);
  assert.equal(call('git log --oneline -1'), null);
  // Without open folders or a recorded call, repository labels remain unavailable.

  assert.equal(
    commitPlaceOf({ command: 'cd ~/Projects/side-repo && git commit -m "x"', cwd: REPO, at: 0 }, [], HOME),
    null,
  );
  assert.equal(commitPlaceOf(null, [REPO], HOME), null);
});

// Bash call records supply the starting cwd for commit recovery.

function bashCall(second: number, id: string, cwd: string, ...commands: string[]) {
  return {
    type: 'assistant',
    timestamp: at(second),
    cwd,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: commands.map((command, i) => ({
        type: 'tool_use',
        id: `${id}${i || ''}`,
        name: 'Bash',
        input: { command },
      })),
    },
  };
}
function bashResult(stdout: string, second: number, id: string, failed = false) {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: failed }] },
    toolUseResult: { stdout, stderr: '' },
  };
}

test('a commit is read back only when the call status stands for it', () => {
  // A successful && chain requires its commit command to succeed.

  assert.equal(commitStatusIsReadable('git add -A && git commit -q -m "x"'), true);
  assert.equal(commitStatusIsReadable('cd extension && git commit -q -F msg.txt && git log --oneline -1'), true);
  assert.equal(commitStatusIsReadable('git commit --quiet -m "x"'), true);
  // A fallback after || can report success after a guard skips the commit.

  assert.equal(
    commitStatusIsReadable(
      '[[ "$(git rev-parse --short HEAD)" == "abc1234" ]] && git commit -q -F m.txt || echo "HEAD changed, aborting"',
    ),
    false,
  );
  assert.equal(commitStatusIsReadable('git commit -q -m "x" || true'), false);
  assert.equal(commitStatusIsReadable('git commit -m "fix `x`" || true'), false);
  // An or-else before the commit skips it, and the call still succeeds.
  assert.equal(commitStatusIsReadable('true || git commit -q -m "x"'), false);
  // A dry run says outright that it makes no commit.
  assert.equal(commitStatusIsReadable('git commit --dry-run -q'), false);
  // A separator after a commit disconnects its status. A pipeline retains repository-count and head-log checks.

  assert.equal(commitStatusIsReadable('git commit -q -m "x"; echo done'), false);
  assert.equal(commitStatusIsReadable('git commit -q -m "x"\ngit log --oneline -1'), false);
  assert.equal(commitStatusIsReadable('git commit -q -m "x" | tail -3'), true);
  // A conditional can skip the commit and leave the call successful.
  assert.equal(commitStatusIsReadable('if (git rev-parse HEAD) { git commit -q -F msg.txt }'), false);
  // The same characters inside the message are message, not shape.
  assert.equal(commitStatusIsReadable('git commit -q -m "read it back || give up; then stop"'), true);
  // Nothing committed, nothing to read back.
  assert.equal(commitStatusIsReadable('git log --oneline -1'), false);
  // A conditional keyword is a keyword whatever its case, which PowerShell writes either way.
  assert.equal(commitStatusIsReadable('If ($false) { git commit -q }'), false);
  // Any dry-run commit leaves recovery unavailable for the whole command.

  assert.equal(commitStatusIsReadable('git commit --dry-run -q && git commit -q --allow-empty'), false);
  // A committer date the command chose puts its commit outside the window it ran in.
  assert.equal(commitStatusIsReadable('GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git commit -q -m "x"'), false);
  // A background commit reports the shell's status and can still be running.
  assert.equal(commitStatusIsReadable('git commit -q -m "x" & echo done'), false);
  assert.equal(commitStatusIsReadable('git add -A && git commit -q -m "x"'), true);
  // A negated commit reports the opposite of what git said.
  assert.equal(commitStatusIsReadable('! git commit -q -m "x"'), false);
  // A command merely printing commit-like words cannot establish commit recovery.

  assert.equal(commitStatusIsReadable('git commit -q -m "x" && echo git commit'), false);
  // A subshell's commit counts even when its command starts with a location change.

  assert.equal(commitStatusIsReadable('(cd extension && git commit -q -m "x")'), true);
  // A separator after either commit prevents the call status from establishing both commits.

  assert.equal(commitStatusIsReadable('git commit -q -m "a"; git commit -q -m "b"'), false);
  // A separator before every commit leaves the final status available for commit recovery.

  assert.equal(commitStatusIsReadable('git add -A; git commit -q -m "x"'), true);
  // A redirect is not a background commit.
  assert.equal(commitStatusIsReadable('git commit -q -m "x" 2>&1'), true);
  // Quoting an option changes nothing about what git does with it.
  assert.equal(commitStatusIsReadable('git commit "--dry-run" -q'), false);
  // An environment name is not case sensitive on Windows.
  assert.equal(commitStatusIsReadable('$env:git_committer_date = "2000-01-01"; git commit -q'), false);
  // A substitution reports the status of whatever read it, not git's.
  assert.equal(commitStatusIsReadable('echo $(git commit -q -m "x")'), false);
  assert.equal(commitStatusIsReadable('echo `git commit -q -m "x"`'), false);
  // A block can skip its own body and leave the call successful, whatever keyword opened it.
  assert.equal(commitStatusIsReadable('switch ($false) { $true { git commit -q } }'), false);
  assert.equal(commitStatusIsReadable('foreach ($f in $files) { git commit -q }'), false);
  // A brace is what every one of those opens, so a block is refused on its own shape too.
  assert.equal(commitStatusIsReadable('{ git commit -q -m "x" }'), false);
  // `${VAR}` is not a block.
  assert.equal(commitStatusIsReadable('cd ${HOME}/repo && git commit -q -m "x"'), true);
  // A command that leaves before the commit runs reports the leaving, not git.
  assert.equal(commitStatusIsReadable('exit 0; git commit -q'), false);
});

test('a call that names a commit it does not run is never read back', () => {
  // Printing commit-like words alongside a real commit leaves commit recovery unavailable.

  const file = writeTranscript([
    userPrompt('land it and say so', 0),
    bashCall(1, 't1', REPO, 'git commit -q -m "x" && echo git commit'),
    bashResult('git commit', 2, 't1'),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.commitIntents, undefined);
});

test('a commit whose call could have skipped it is never read back', () => {
  const file = writeTranscript([
    userPrompt('land it if head has not moved', 0),
    bashCall(
      1,
      't1',
      REPO,
      '[[ "$(git rev-parse --short HEAD)" == "abc1234" ]] && git commit -q -F m.txt || echo "HEAD changed, aborting"',
    ),
    bashResult('HEAD changed, aborting', 2, 't1'),
    assistantText('Stopped.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.commitIntents, undefined);
});

const GUARDED_HEREDOC_COMMIT = [
  '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F - <<\'EOF\' && git log --oneline -1 || echo "HEAD changed, aborting"',
  'docs(plans): document the plan directory convention',
  '',
  'Move plan folders from .github/prompts to .claude/plans, ...',
  'EOF',
].join('\n');

test('a guarded quiet heredoc commit records the trailing log sha as its success witness', () => {
  const file = writeTranscript([
    userPrompt('land it if head has not moved', 0),
    bashCall(1, 't1', REPO, GUARDED_HEREDOC_COMMIT),
    bashResult('661544f0 docs(plans): document the plan directory convention', 2, 't1'),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commitIntents, [
    {
      dir: REPO,
      from: ms(1),
      to: ms(2),
      expected: 1,
      witnessedSha: '661544f0',
    },
  ]);
});

test('a guarded quiet commit records no intent unless its final log proves the success arm', () => {
  const intentsFor = (command: string, stdout: string) => {
    const file = writeTranscript([
      userPrompt('land it if head has not moved', 0),
      bashCall(1, 't1', REPO, command),
      bashResult(stdout, 2, 't1'),
      assistantText('Done.', 3),
    ]);
    return readTurns(file, 'sess')[0].commitIntents;
  };
  assert.equal(intentsFor(GUARDED_HEREDOC_COMMIT, 'HEAD changed, aborting'), undefined);
  assert.equal(intentsFor('git commit -F msg.txt || echo aborted', 'aborted'), undefined);
  assert.equal(
    intentsFor(
      'git log --oneline -1 && [[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt || echo aborted',
      '661544f0 Prior commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt || echo aborted && git log --oneline -1',
      '661544f0 Prior commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo "$fallback"',
      '661544f0 Claimed commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo "661544f0 Claimed commit"',
      '661544f0 Claimed commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q | true && git log --oneline -1 || echo aborted',
      '661544f0 Prior commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo ""',
      '661544f0 Prior commit\n\n',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo -n',
      '661544f0 Prior commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo *',
      '661544f0 Claimed commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo ?',
      '661544f0 Claimed commit',
    ),
    undefined,
  );
  assert.equal(
    intentsFor(
      '[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo -n 661544f0 Claimed commit',
      '661544f0 Claimed commit',
    ),
    undefined,
  );
  for (const flag of ['-e', '-E', '-ne', '-nE', '-eE', '-neE', '"-En"']) {
    assert.equal(
      intentsFor(
        `[[ "$(git rev-parse --short HEAD)" == "661544f0" ]] && git commit -q -F msg.txt && git log --oneline -1 || echo ${flag} 661544f0 Claimed commit`,
        '661544f0 Claimed commit',
      ),
      undefined,
      `echo ${flag} can print a log-shaped fallback`,
    );
  }
});

test('a piped quiet commit records an intent while a plain or-else still records none', () => {
  const intentsFor = (command: string) => {
    const file = writeTranscript([
      userPrompt('land it', 0),
      bashCall(1, 't1', REPO, command),
      bashResult('', 2, 't1'),
      assistantText('Done.', 3),
    ]);
    return readTurns(file, 'sess')[0].commitIntents;
  };
  assert.deepEqual(intentsFor('git commit -q -F msg.txt | tee commit.log'), [
    { dir: REPO, from: ms(1), to: ms(2), expected: 1 },
  ]);
  assert.equal(intentsFor('git commit -F msg.txt || echo aborted'), undefined);
});

test('a commit that printed nothing is recorded with the window to read it back in', () => {
  // A successful quiet commit supplies a recovery intent without a printed commit row.

  const file = writeTranscript([
    userPrompt('land the change', 0),
    bashCall(1, 't1', REPO, 'git commit -F msg.txt -q'),
    bashResult('', 2, 't1'),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, []);
  assert.deepEqual(turn.commitIntents, [{ dir: REPO, from: ms(1), to: ms(2), expected: 1 }]);
});

test('a commit whose line git printed asks the repository nothing', () => {
  const file = writeTranscript([
    userPrompt('land the change', 0),
    bashCall(1, 't1', REPO, 'git commit -m "the change"'),
    bashResult('[main a1b2c3d4] The change', 2, 't1'),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.commits.length, 1);
  assert.equal(turn.commitIntents, undefined);
});

test('a commit that failed is never read back, because the window would hold somebody else', () => {
  // A failed call supplies no commit recovery intent because its time window can contain unrelated commits.

  const file = writeTranscript([
    userPrompt('land the change', 0),
    bashCall(1, 't1', REPO, 'git commit -q'),
    bashResult('nothing to commit, working tree clean', 2, 't1', true),
    assistantText('Nothing to do.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.commitIntents, undefined);
});

test('a call that committed more than once says how many to expect', () => {
  const file = writeTranscript([
    userPrompt('split it in two', 0),
    bashCall(1, 't1', REPO, 'git commit -q -m "first" && git commit -q -m "second"'),
    bashResult('', 2, 't1'),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commitIntents, [{ dir: REPO, from: ms(1), to: ms(2), expected: 2 }]);
});

test('two calls issued by one record keep the whole record window', () => {
  // Calls in one record share their starting timestamp. Their recovery windows end at their respective results.

  const file = writeTranscript([
    userPrompt('two commits', 0),
    bashCall(1, 't', REPO, 'git commit -q -m "first"', 'git commit -q -m "second"'),
    bashResult('', 2, 't'),
    bashResult('', 3, 't1'),
    assistantText('Done.', 4),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commitIntents, [
    { dir: REPO, from: ms(1), to: ms(2), expected: 1 },
    { dir: REPO, from: ms(1), to: ms(3), expected: 1 },
  ]);
});

test('a call issued after an earlier result starts where that result ended', () => {
  // A later call's recovery window starts at its own recorded timestamp.

  const file = writeTranscript([
    userPrompt('two commits', 0),
    bashCall(1, 't1', REPO, 'git commit -q -m "first"'),
    bashResult('', 2, 't1'),
    bashCall(3, 't2', REPO, 'git commit -q -m "second"'),
    bashResult('', 5, 't2'),
    assistantText('Done.', 6),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commitIntents, [
    { dir: REPO, from: ms(1), to: ms(2), expected: 1 },
    { dir: REPO, from: ms(3), to: ms(5), expected: 1 },
  ]);
});

test('a fast-forward landing is recorded with the window to read it back in', () => {
  // Fast-forward output supplies a landing recovery intent without a commit row.

  const file = writeTranscript([
    userPrompt('land the branch', 0),
    bashCall(1, 't1', REPO, 'git merge --ff-only 1ede4cb1 && git log --oneline -3'),
    bashResult(
      'Updating 4bf2931..1ede4cb\nFast-forward\n 9 files changed, 170 insertions(+), 44 deletions(-)\n1ede4cb1 Bundle the panel script',
      2,
      't1',
    ),
    assistantText('Landed.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, []);
  assert.equal(turn.commitIntents, undefined);
  assert.deepEqual(turn.landingIntents, [{ id: 't1', dir: REPO, from: ms(1), to: ms(2), expected: 1 }]);
});

test('a merge that failed is never read back, because the window would hold somebody else', () => {
  const file = writeTranscript([
    userPrompt('land the branch', 0),
    bashCall(1, 't1', REPO, 'git merge --ff-only topic'),
    bashResult('fatal: Not possible to fast-forward, aborting.', 2, 't1', true),
    assistantText('It would not fast-forward.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.landingIntents, undefined);
});

test('a merge whose call could have skipped it is never read back', () => {
  // A fallback after || can succeed after the guard skips its merge, leaving landing recovery unavailable.

  const file = writeTranscript([
    userPrompt('land it if head has not moved', 0),
    bashCall(
      1,
      't1',
      REPO,
      '[[ "$(git rev-parse --short HEAD)" == "abc1234" ]] && git merge --ff-only topic || echo "main moved, aborting"',
    ),
    bashResult('main moved, aborting', 2, 't1'),
    assistantText('Stopped.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.landingIntents, undefined);
});

test('a merge run in another repository names that repository', () => {
  const file = writeTranscript([
    userPrompt('land the notes branch', 0),
    bashCall(1, 't1', REPO, `cd ${NOTES} && git merge --ff-only topic`),
    bashResult('Fast-forward', 2, 't1'),
    assistantText('Landed.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.landingIntents, [{ id: 't1', dir: NOTES, from: ms(1), to: ms(2), expected: 1 }]);
});

test('a workspace on a network share keeps local commits and marks foreign commits', () => {
  const share = '//build-01/team/arc';
  const inShare = 'cd //build-01/team/arc && git add -A && git commit -m "here"';
  assert.equal(commitPlaceOf({ command: inShare, cwd: share, at: 0 }, [share], HOME), null);
  assert.deepEqual(
    commitPlaceOf({ command: 'cd ~/Projects/side-repo && git commit -m "x"', cwd: REPO, at: 0 }, [REPO], HOME),
    { kind: 'named', dir: NOTES },
  );
  assert.deepEqual(
    commitPlaceOf({ command: 'cd ~/Projects/side-repo && git commit -m "x"', cwd: share, at: 0 }, [share], HOME),
    { kind: 'named', dir: NOTES },
  );
  const network: { commits: TurnCommit[] } = { commits: [] };
  recordCommits(
    network,
    '[main abc1234] Here\n 1 file changed, 1 insertion(+)',
    5,
    { command: 'git commit -m "here"', cwd: share, at: 0 },
    [share],
  );
  assert.deepEqual(network.commits[0], {
    sha: 'abc1234',
    subject: 'Here',
    head: { kind: 'branch', name: 'main' },
    files: 1,
    added: 1,
    removed: 0,
    at: 5,
    place: null,
    dir: share,
  });
});

// Host workspace paths and shell destinations must identify the same directory across supported path forms.

test('a folder and a directory read out of a command are spelled the same way', () => {
  const shapes: [string, string, string][] = [
    ['forward slashes', 'C:/Users/dev/work/repo', 'C:/Users/dev/work/repo'],
    ['a folder spelled with backslashes', 'C:\\Users\\dev\\work\\repo', 'C:/Users/dev/work/repo'],
    ['an unquoted backslash target', 'C:/Users/dev/work/repo', 'C:\\Users\\dev\\work\\repo'],
    ['a Git Bash target', 'C:/Users/dev/work/repo', '/c/Users/dev/work/repo'],
    ['a WSL target', 'C:/Users/dev/work/repo', '/mnt/c/Users/dev/work/repo'],
    ['a Cygwin target', 'C:/Users/dev/work/repo', '/cygdrive/c/Users/dev/work/repo'],
    ['a folder with a trailing slash', 'C:/Users/dev/work/repo/', 'C:/Users/dev/work/repo'],
    ['a target reached through a parent', 'C:/Users/dev/work/repo', 'C:/Users/dev/work/repo/sub/..'],
  ];
  for (const [what, folder, target] of shapes) {
    const dirs = commitDirs(`cd ${target} && git commit -m "x"`, folder, HOME);
    assert.equal(dirs.length, 1, what);
    assert.ok(dirs[0] !== null, `${what}: the target was not resolved at all`);
    assert.ok(
      isInside(dirs[0], [folder]),
      `${what}: the folder and the directory read out of the command do not name the same place, so every commit in it reads as another repository's (${dirs[0]} against ${folder})`,
    );
  }
  const share = '//build-01/team/repo';
  const fromCommand = commitDirs(`cd ${share} && git commit -m "x"`, share, HOME)[0];
  assert.ok(fromCommand !== null);
  assert.equal(fromCommand, share);
  assert.ok(isInside(fromCommand, [share]));
});

// Git command identity determines whether its output supplies printed commits.
test('a call whose command word is git qualifies, whatever the subcommand', () => {
  assert.equal(ranGit('git commit -m "add the plan"'), true);
  assert.equal(ranGit('git cherry-pick feat'), true);
  assert.equal(ranGit('git -C ../side-repo commit -m "notes"'), true);
  assert.equal(ranGit('cd "C:/Users/dev/Projects/side-repo" && git add -A && git commit -m "notes"'), true);
  assert.equal(ranGit('git log --oneline -1;\ngit commit -a -m "x"'), true);
  // An environment assignment in front of the command word is still that command.
  assert.equal(ranGit('GIT_EDITOR=true git rebase --continue'), true);
  assert.equal(ranGit('GIT_AUTHOR_NAME="A B" git commit -m "x"'), true);
});

// Git calls inside conditional blocks and substitutions retain their command identity.

test('a git call inside a conditional block qualifies, though the segment opens with the guard', () => {
  assert.equal(
    ranGit(
      'if ((git rev-parse --short HEAD) -eq "007be02") { git commit -F msg.txt } else { Write-Output "HEAD moved" }',
    ),
    true,
  );
  assert.equal(ranGit('$sha=$(git rev-parse HEAD)'), true);
  assert.equal(ranGit('npm run build | tee log.txt'), false);
});

test('a call that never ran git does not qualify on the word alone', () => {
  assert.equal(ranGit('npm test'), false);
  assert.equal(ranGit('python survey.py --root ~/.codex/sessions'), false);
  // The word inside a quoted string, and inside a commit message, is text and not a command.
  assert.equal(ranGit('echo "git commit -m x" > note.txt'), false);
  assert.equal(ranGit("printf '%s' 'git commit -m x'"), false);
  // A command whose name merely starts with git is a different command.
  assert.equal(ranGit('gitk --all'), false);
  assert.equal(ranGit(''), false);
});

// A heredoc body contains message text. Its following Git command remains visible to command classification.

test('a heredoc body does not qualify a call, and the command after it still does', () => {
  const body = 'cat > /tmp/msg.txt <<\'EOF\'\ngit commit -m "this is the message"\nEOF';
  assert.equal(ranGit(body), false);
  assert.equal(ranGit(`${body}\ngit commit -F /tmp/msg.txt`), true);
});

// Count indexed string access, searches, copies, and character-array reads and writes during command inspection.

function charactersRead(command: string, run: (command: string) => void): number {
  const proto = String.prototype;
  const saved = {
    indexOf: proto.indexOf,
    lastIndexOf: proto.lastIndexOf,
    slice: proto.slice,
    substring: proto.substring,
    split: proto.split,
  };
  const join = Array.prototype.join;
  let read = 0;
  proto.indexOf = function (this: string, search: string, from?: number): number {
    const start = Math.max(0, from ?? 0);
    const at = saved.indexOf.call(this, search, start);
    read += (at < 0 ? this.length : at + search.length) - start;
    return at;
  };
  proto.lastIndexOf = function (this: string, search: string, from?: number): number {
    const at = saved.lastIndexOf.call(this, search, from);
    read += Math.min(from ?? this.length, this.length) - Math.max(at, 0);
    return at;
  };
  proto.slice = function (this: string, start?: number, end?: number): string {
    const part = saved.slice.call(this, start, end);
    read += part.length;
    return part;
  };
  proto.substring = function (this: string, start: number, end?: number): string {
    const part = saved.substring.call(this, start, end);
    read += part.length;
    return part;
  };
  // Bind string methods to the original text while counting indexed access through the proxy.

  const countedString = (text: string): string =>
    new Proxy(Object(text) as object, {
      get(target, key) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          read++;
          return text[Number(key)];
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(text) : value;
      },
    }) as unknown as string;
  // Track character-array reads and writes, then track the string produced by join.

  const countedArray = (items: string[]): string[] =>
    new Proxy(items, {
      get(target, key) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          read++;
        }
        if (key === 'join') {
          return (separator?: string) => countedString(join.call(target, separator));
        }
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          read++;
        }
        return Reflect.set(target, key, value);
      },
    });
  proto.split = function (this: string, separator: string | RegExp, limit?: number): string[] {
    const split = saved.split as (this: string, separator: string | RegExp, limit?: number) => string[];
    const parts = split.call(this, separator, limit);
    return this === command && separator === '' ? countedArray(parts) : parts;
  } as typeof proto.split;
  try {
    run(countedString(command));
  } finally {
    Object.assign(proto, saved);
  }
  return read;
}

// Repeated openers and trailing whitespace must keep character work proportional to command length.

test('reading a command costs work in step with its length', () => {
  const commands = [
    `claude -p "$(${'<<a '.repeat(1 << 14)})" --output-format json`,
    `echo ${"@'x' ".repeat(1 << 14)}\ngit commit -m real`,
    `echo ${"@'x' ".repeat(1 << 12)}${' '.repeat(1 << 12)}\ngit commit -m real`,
  ];
  for (const command of commands) {
    let answer: boolean | undefined;
    const read = charactersRead(command, (counted) => {
      answer = ranGit(counted);
    });
    assert.equal(answer, ranGit(command), 'the counted command read differently from the plain one');
    assert.ok(read >= command.length, `a command of ${command.length} characters counted only ${read} read`);
    assert.ok(read < command.length * 16, `a command of ${command.length} characters read ${read}`);
  }
  for (const depth of [1 << 10, 1 << 12]) {
    const command = `python dispatch.py --prompt (${'python wrapper --prompt ('.repeat(depth)}Join-Path root file${')'.repeat(depth + 1)} --arc-dispatch`;
    let answer: ReturnType<typeof claudeLaunchKind> | undefined;
    const read = charactersRead(command, (counted) => {
      answer = claudeLaunchKind(counted, 'powershell');
    });
    assert.deepEqual(answer, { kind: 'receipt', count: 1 });
    assert.ok(read >= command.length, `a command of ${command.length} characters counted only ${read} read`);
    assert.ok(read < command.length * 24, `a command of ${command.length} characters read ${read}`);
    const unknownRead = charactersRead(command, (counted) => {
      answer = claudeLaunchKind(counted);
    });
    assert.deepEqual(answer, { kind: 'receipt', count: 1 });
    assert.ok(
      unknownRead < command.length * 48,
      `an unknown-shell command of ${command.length} characters read ${unknownRead}`,
    );
  }
  for (const count of [1 << 10, 1 << 12]) {
    const command = `${'echo `true #x`; '.repeat(count)}echo $((2*(3+(4)))); python child.py --arc-dispatch`;
    const read = charactersRead(command, (counted) => {
      assert.deepEqual(claudeLaunchKind(counted, 'bash'), { kind: 'receipt', count: 1 });
    });
    assert.ok(read < command.length * 24, `a backtick command of ${command.length} characters read ${read}`);
  }
});

// A PowerShell here-string containing apostrophes ends at its terminator before the Git command.

const HERE_STRING = [
  "$msg = @'",
  "The weight layer's Off state now reaches On when any of the three toggles",
  'rises, and returns only when all three are off.',
  "'@",
  '[IO.File]::WriteAllText("$env:TEMP\\msg.txt", $msg, (New-Object System.Text.UTF8Encoding($false)))',
  'git add "README.md" "README_JP.md"',
  '$staged = @(git diff --cached --name-only); Write-Output "staged: $($staged.Count)"; $staged',
  'if ($staged.Count -eq 2) { git commit -F "$env:TEMP\\msg.txt" } else { Write-Output "ABORT" }',
  'git log --oneline -1',
].join('\n');

test('a PowerShell here-string body does not qualify a call, and the commit after it still does', () => {
  assert.equal(ranGit(HERE_STRING), true);
  assert.deepEqual(commitDirs(HERE_STRING, REPO, HOME), [REPO]);

  // Git-like text inside a here-string supplies no command.

  const bodyOnly = [
    "$note = @'",
    "The owner's note reads:",
    'git commit -m "the example" is what prints the line.',
    "'@",
    'Write-Output "written"',
  ].join('\n');
  assert.equal(ranGit(bodyOnly), false);
});

test('a here-string is masked to its terminator, and only when its opener ends the line', () => {
  // The `@"` form is the same rule with the other quote.
  const double = [
    '$msg = @"',
    'The note says "keep it and nothing else.',
    'git commit -m "the example" is only the example.',
    '"@',
    'Write-Output "written"',
  ].join('\n');
  assert.equal(ranGit(double), false);
  assert.equal(ranGit(`${double}\ngit commit -F msg.txt`), true);

  // An unterminated here-string masks the remaining command text.

  const unterminated = ["$t = @'", "The plan's next line reads:", 'git commit -m "x"'].join('\n');
  assert.equal(ranGit(unterminated), false);

  // A here-string opener ends its line. An email-like quoted argument leaves the following command visible.

  const notAnOpener = '$addr = user@\'example.com\'\ngit commit -m "x"';
  assert.equal(ranGit(notAnOpener), true);
  assert.deepEqual(commitDirs(notAnOpener, REPO, HOME), [REPO]);
});

// The unreadable command marker permits printed commit extraction without command classification.

test('a source that cannot read its own commands has its output read anyway', () => {
  const unreadable: { commits: TurnCommit[] } = { commits: [] };
  recordCommits(unreadable, '[main f572f41] Add the camera plan\n 1 file changed, 186 insertions(+)', 5, 'unreadable');
  assert.deepEqual(unreadable.commits, [
    {
      sha: 'f572f41',
      subject: 'Add the camera plan',
      head: { kind: 'branch', name: 'main' },
      files: 1,
      added: 186,
      removed: 0,
      at: 5,
      place: null,
      dir: null,
    },
  ]);
  // An absent recorded command supplies no printed commits.

  const unrecorded: { commits: TurnCommit[] } = { commits: [] };
  recordCommits(unrecorded, '[main f572f41] Add the camera plan\n 1 file changed, 186 insertions(+)', 5, null);
  assert.deepEqual(unrecorded.commits, []);
});

test('a commit made in another repository is reported with it, and one made here is not', () => {
  const bash = (command: string, second: number, cwd: string) => ({
    ...assistantTool('Bash', second, 't1', { command }),
    cwd,
  });
  const readWith = (command: string, cwd: string, folders: string[]) => {
    const file = writeTranscript([
      userPrompt('write the run up', 0),
      bash(command, 1, cwd),
      commitResult('[main abc1234] Note the run\n 1 file changed, 4 insertions(+)', 2),
      assistantText('Done.', 3),
    ]);
    return readTurns(file, 'sess', { folders })[0].commits[0];
  };
  const away = 'cd "C:/Users/dev/Projects/side-repo" && git add -A && git commit -m "notes"';
  assert.deepEqual(readWith(away, REPO, [REPO]).place, { kind: 'named', dir: NOTES });
  // Repository labels preserve the commit's subject and figures.
  assert.deepEqual(readWith(away, REPO, [REPO]), {
    sha: 'abc1234',
    subject: 'Note the run',
    head: { kind: 'branch', name: 'main' },
    files: 1,
    added: 4,
    removed: 0,
    at: ms(2),
    place: { kind: 'named', dir: NOTES },
    dir: NOTES,
  });
  const local = readWith('git add -A && git commit -m "here"', REPO, [REPO]);
  assert.equal(local.place, null);
  assert.equal(local.dir, REPO);
  // A commit in the workspace, and the same commit read with no folder open, both say nothing.
  assert.equal(readWith('git add -A && git commit -m "here"', REPO, [REPO]).place, null);
  assert.equal(readWith(away, REPO, []).place, null);
  // Two foreign repositories in one command: every commit the call printed is marked as made
  // outside this workspace, and none of them names a directory.
  const both =
    'cd "C:/Users/dev/Projects/side-repo" && git commit -m "a" && cd "C:/Users/dev/Projects/work/other-repo" && git commit -m "b"';
  const ambiguous = readWith(both, REPO, [REPO]);
  assert.deepEqual(ambiguous.place, { kind: 'unnamed' });
  assert.equal(ambiguous.dir, null);
});

test('the PowerShell tool is read for a commit the same way the Bash tool is', () => {
  // Both tools carry their command in the same input field.

  const file = writeTranscript([
    userPrompt('log the run', 0),
    {
      ...assistantTool('PowerShell', 1, 't1', {
        command: 'Push-Location "C:/Users/dev/Projects/side-repo"; git add .; git commit -m "notes"',
      }),
      cwd: REPO,
    },
    commitResult('[main abc1234] Note the run\n 1 file changed, 4 insertions(+)', 2),
    assistantText('Done.', 3),
  ]);
  assert.deepEqual(readTurns(file, 'sess', { folders: [REPO] })[0].commits[0].place, { kind: 'named', dir: NOTES });
});

test('a relative move is resolved against where the call started, not where it ended', () => {
  // Relative locations resolve against the call record's cwd before execution.

  const file = writeTranscript([
    userPrompt('note it', 0),
    { ...assistantTool('Bash', 1, 't1', { command: 'cd ../../side-repo && git commit -m "notes"' }), cwd: REPO },
    { ...commitResult('[main abc1234] Note the run\n 1 file changed, 4 insertions(+)', 2), cwd: NOTES },
    assistantText('Done.', 3),
  ]);
  // Display paths retain their drive-letter case. normalizeFsPath handles path comparisons.

  assert.deepEqual(readTurns(file, 'sess', { folders: [REPO] })[0].commits[0].place, {
    kind: 'named',
    dir: 'c:/Users/dev/Projects/side-repo',
  });
});

// Unrelated bracketed log lines in Git output supply no commits.

test('a bracketed log line is not read as a commit', () => {
  const noise = [
    '[2026-08-26 10:23:45 deadbeef] service started',
    '[INFO worker 3 abc1234] job done',
    '[ERROR db pool 0123456789abcdef] connection lost',
  ].join('\n');
  const file = writeTranscript([
    userPrompt('run the server', 0),
    assistantTool('Bash', 1, 't1', { command: 'git commit -a -m "the change"' }),
    commitResult(noise, 2),
    assistantText('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.commits, []);
});

// Only Git command output supplies these printed commit rows.

const PLAN_COMMIT = '[main f572f41] Add camera share freeze plan\n 1 file changed, 186 insertions(+)';
const PLAN_ROW = {
  sha: 'f572f41',
  subject: 'Add camera share freeze plan',
  head: { kind: 'branch' as const, name: 'main' },
  files: 1,
  added: 186,
  removed: 0,
  at: ms(2),
  place: null,
  dir: null,
};

// Read commit rows from a paired command and result. A null command leaves that call's command text absent.

function commitsFor(command: string | null, stdout: string) {
  const file = writeTranscript([
    userPrompt('do the work', 0),
    command === null ? assistantTool('Bash', 1, 't1') : assistantTool('Bash', 1, 't1', { command }),
    commitResult(stdout, 2),
    assistantText('Done.', 3),
  ]);
  return readTurns(file, 'sess')[0].commits;
}

test('a commit printed by a plain git commit call is recorded', () => {
  assert.deepEqual(commitsFor('git commit -m "add the plan"', PLAN_COMMIT), [PLAN_ROW]);
});

test('a git commit run after a move is recorded, since the call still ran git', () => {
  assert.deepEqual(commitsFor('cd /c/Users/dev/Projects/side-repo && git commit -m "notes"', PLAN_COMMIT), [
    { ...PLAN_ROW, dir: 'C:/Users/dev/Projects/side-repo' },
  ]);
});

test('a commit made through git -C is recorded', () => {
  assert.deepEqual(commitsFor('git -C ../side-repo commit -m "notes"', PLAN_COMMIT), [PLAN_ROW]);
});

// Cherry-pick and revert output supplies commit rows through Git command identity.

test('a cherry-pick and a revert are recorded, though neither call says commit', () => {
  assert.deepEqual(
    commitsFor(
      'git cherry-pick feat',
      '[other 71af154] feat work\n Date: Thu Aug 27 16:37:23 2026 -0500\n 1 file changed, 1 insertion(+)',
    ),
    [
      {
        sha: '71af154',
        subject: 'feat work',
        head: { kind: 'branch', name: 'other' },
        files: 1,
        added: 1,
        removed: 0,
        at: ms(2),
        place: null,
        dir: null,
      },
    ],
  );
  assert.deepEqual(
    commitsFor(
      'git revert --no-edit HEAD~1',
      '[main 108efd5] Revert "main work"\n Date: Thu Aug 27 16:37:24 2026 -0500\n 1 file changed, 1 deletion(-)',
    ),
    [
      {
        sha: '108efd5',
        subject: 'Revert "main work"',
        head: { kind: 'branch', name: 'main' },
        files: 1,
        added: 0,
        removed: 1,
        at: ms(2),
        place: null,
        dir: null,
      },
    ],
  );
});

// Scripts that quote commit output supply no commit rows without a Git command.

test('a script that quoted a commit line records nothing, since the call never ran git', () => {
  assert.deepEqual(commitsFor("cd /c/Users/dev/scratch && awk 'NR>95' sol.txt", PLAN_COMMIT), []);
  assert.deepEqual(commitsFor('python survey.py --root ~/.codex/sessions', PLAN_COMMIT), []);
});

test('the word git inside a quoted message does not make a call a git call', () => {
  assert.deepEqual(commitsFor('python tools/announce.py --message "git commit -m done"', PLAN_COMMIT), []);
  assert.deepEqual(commitsFor("printf '%s' 'git commit -m x' > note.txt", PLAN_COMMIT), []);
});

test('a result whose call recorded no command records nothing', () => {
  assert.deepEqual(commitsFor(null, PLAN_COMMIT), []);
});

test('reasoning effort is read from the top level of the assistant line, not from message', () => {
  const file = writeTranscript([userPrompt('do it', 0), assistantText('Done.', 1, undefined, 'xhigh')]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.effort, 'xhigh');
});

test('a turn with no effort on any of its lines reports null', () => {
  const file = writeTranscript([userPrompt('do it', 0), assistantText('Done.', 1)]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.effort, null);
});

test("a synthetic line's effort is ignored, since it was not written by the model", () => {
  const file = writeTranscript([
    userPrompt('do it', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      effort: 'xhigh',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Usage credits are required for this model.' }],
      },
    },
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.effort, null);
});

test('effort comes from the last reply that recorded one', () => {
  const file = writeTranscript([
    userPrompt('do it', 0),
    assistantText('First.', 1, undefined, 'low'),
    assistantText('Second.', 2, undefined, 'xhigh'),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.effort, 'xhigh');
});

test('an api error line cannot set the effort, since the model did not write it', () => {
  const file = writeTranscript([
    userPrompt('do it', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      effort: 'xhigh',
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 500' }] },
    },
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.effort, null);
});

test('an effort recorded mid-turn survives a closing reply that records none', () => {
  const file = writeTranscript([
    userPrompt('do it', 0),
    assistantTool('Edit', 1, 'tu1', {}, 'xhigh'),
    assistantText('Done.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(
    turn.effort,
    'xhigh',
    'roughly one line in twenty carries no effort, which does not clear the effort of the turn',
  );
});

test('a turn is finished only when its last reply closed the turn', () => {
  const running = writeTranscript([
    userPrompt('do it', 0),
    {
      ...assistantText('Working on the first part.', 1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Working on the first part.' }],
      },
    },
    {
      ...assistantTool('Bash', 2),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
      },
    },
  ]);
  assert.equal(readTurns(running, 'sess')[0].finished, false);

  const done = writeTranscript([
    userPrompt('do it', 0),
    {
      ...assistantTool('Bash', 1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
      },
    },
    {
      ...assistantText('All done.', 2),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'All done.' }],
      },
    },
  ]);
  assert.equal(readTurns(done, 'sess')[0].finished, true);
});

test('usage is counted once per API response, not once per transcript line', () => {
  // One response is written as several lines (thinking, text, tool_use), each repeating
  // the same usage object. Counting per line multiplies the turn's tokens.
  const usage = {
    input_tokens: 5,
    output_tokens: 1000,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
    output_tokens_details: { thinking_tokens: 600 },
  };
  const reply = (id: string, second: number, content: object[], stop = 'tool_use') => ({
    type: 'assistant',
    timestamp: at(second),
    message: { role: 'assistant', id, model: 'claude-opus-5', stop_reason: stop, content, usage },
  });
  const file = writeTranscript([
    userPrompt('do it', 0),
    reply('msg_1', 1, [{ type: 'thinking', thinking: 'hmm' }]),
    reply('msg_1', 2, [{ type: 'text', text: 'Working.' }]),
    reply('msg_1', 3, [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
    reply('msg_2', 4, [{ type: 'text', text: 'Done.' }], 'end_turn'),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.usage.output, 2000); // two responses, not four lines
  assert.equal(turn.usage.thinking, 1200);
  assert.equal(turn.usage.cacheRead, 180_000);
  assert.equal(turn.usage.cacheWrite1h, 4000);
  assert.equal(turn.usage.input, 10);
  assert.equal(turn.usage.output, 2000);
  assert.equal(
    turn.usage.requests,
    2,
    'the thinking, text and tool-use lines from one response were counted as separate requests',
  );
});

test('an older transcript with no cache TTL split is charged at the 1h rate', () => {
  const file = writeTranscript([
    userPrompt('do it', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'm1',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 5000 },
      },
    },
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.usage.cacheWrite1h, 5000);
  assert.equal(turn.usage.cacheWrite5m, 0);
});

test('a prompt that never got a reply of its own joins the next turn instead of an empty card', () => {
  // Consecutive prompts without intervening work share the next turn's reply.

  const file = writeTranscript([
    userPrompt('first job', 0),
    assistantTool('Bash', 1),
    assistantText('First done.', 2),
    userPrompt('queued one', 3),
    userPrompt('queued two', 4),
    assistantText('Both done.', 5),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, 'first job');
  assert.equal(turns[1].prompt, 'queued one\n\nqueued two');
  assert.equal(turns[1].summary, 'Both done.');
  // Joined prompts retain separate promptParts for individual recall.

  assert.deepEqual(
    turns[1].promptParts?.map((one) => one.text),
    ['queued one', 'queued two'],
  );
  assert.deepEqual(
    turns[0].promptParts?.map((one) => one.text),
    ['first job'],
  );
  // Prompt parts retain their recorded timestamps for ordering.

  assert.ok((turns[1].promptParts ?? []).every((one) => one.at > 0));
});

test('a line the cleaning leaves empty opens no turn and no part', () => {
  // Editor wrappers with no remaining prompt text create no turn or prompt part.

  const file = writeTranscript([
    userPrompt('<ide_selection>lines 4 to 9</ide_selection>', 0),
    userPrompt('fix the parser', 1),
    assistantText('Done.', 2),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].promptParts?.map((one) => one.text),
    ['fix the parser'],
  );
  assert.equal(turns[0].prompt, 'fix the parser', 'the recorded prompt opens on a blank line');
});

test('a run of prompts with no reply between them is kept apart, not folded in pairs', () => {
  // Multiple carried prompts retain distinct parts through repeated turn joins.

  const file = writeTranscript([
    userPrompt('queued one', 0),
    userPrompt('queued two', 1),
    userPrompt('queued three', 2),
    assistantText('All done.', 3),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].promptParts?.map((one) => one.text),
    ['queued one', 'queued two', 'queued three'],
  );
});

test('the turn at the end of the file is kept even before it has done anything', () => {
  // The last unanswered prompt retains its unfinished turn.

  const file = writeTranscript([
    userPrompt('first job', 0),
    assistantText('First done.', 1),
    userPrompt('just asked this', 2),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].prompt, 'just asked this');
  assert.equal(turns[1].finished, false);
});

test('a session run in a subfolder of an open folder belongs to that window', () => {
  const root = tempDir('proj-');
  const home = tempDir('home-');
  const notes = path.join(home, 'notes');
  const decoy = path.join(home, 'notes-elsewhere');

  const mk = (dirName: string, cwd: string) => {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 's.jsonl'),
      JSON.stringify({ type: 'user', cwd, timestamp: at(0), message: { role: 'user', content: 'x' } }) + '\n',
    );
  };
  mk(projectSlug(home), home);
  mk(projectSlug(notes), notes);
  mk(projectSlug(decoy), decoy);

  // opening the parent brings in the sessions run beneath it
  const fromParent = transcriptDirsFor(root, [home])
    .map((d) => path.basename(d))
    .sort();
  assert.deepEqual(fromParent, [projectSlug(decoy), projectSlug(home), projectSlug(notes)].sort());

  // opening the subfolder brings in only its own, not the sibling that shares its prefix
  assert.deepEqual(
    transcriptDirsFor(root, [notes]).map((d) => path.basename(d)),
    [projectSlug(notes)],
  );
});

test('readSessionCwd reads the cwd out of a transcript head', () => {
  const dir = tempDir('cwd-');
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'queue-operation', timestamp: at(0) }),
      JSON.stringify({ type: 'user', cwd: 'c:/repo/here', timestamp: at(1), message: { role: 'user', content: 'x' } }),
    ].join('\n') + '\n',
  );
  assert.equal(readSessionCwd(file), 'c:/repo/here');

  const empty = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(empty, 'not json\n');
  assert.equal(readSessionCwd(empty), null);
});

test('a background subagent reports its figures through the task notification', () => {
  // Notification tags supply aggregate token, tool, and duration figures. Child transcripts supply model usage.

  const file = writeTranscript([
    userPrompt('run the audit in the background', 0),
    assistantTool('Agent', 1, 'bg9', { description: 'Audit the parser', subagent_type: 'Explore' }),
    {
      type: 'user',
      timestamp: at(2),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<task-notification><task-id>child-bg9</task-id><tool-use-id>bg9</tool-use-id><status>completed</status></task-notification>' +
          '<subagent_tokens>176288</subagent_tokens><tool_uses>49</tool_uses><duration_ms>940926</duration_ms>',
      },
    },
    assistantText('The audit came back.', 3),
  ]);
  const spend = [
    {
      model: 'claude-sonnet-5',
      usage: { input: 2, cacheWrite1h: 0, cacheWrite5m: 3, cacheRead: 40, output: 5, thinking: 1 },
    },
  ];
  const [turn] = readTurns(file, 'sess', {
    agentSpendOf: (agent) => ({
      models: agent.id === 'child-bg9' ? spend : [],
      found: agent.id === 'child-bg9',
      partial: false,
      effort: null,
    }),
  });
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.agents[0].tokens, 176288);
  assert.equal(turn.agents[0].toolUses, 49);
  assert.equal(turn.agents[0].durationMs, 940926);
  assert.equal(turn.agents[0].status, 'completed');
  assert.equal(turn.agents[0].id, 'child-bg9');
  assert.deepEqual(turn.agents[0].spend, spend);
});

test('a finished background subagent with no <tool_uses> tag counts its own calls', () => {
  // A completion notice can close the child without a tool_uses tag.

  const file = writeTranscript([
    userPrompt('run the audit in the background', 0),
    assistantTool('Agent', 1, 'bg9', { description: 'Audit the parser', subagent_type: 'Explore' }),
    {
      type: 'user',
      timestamp: at(2),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content:
          '<task-notification><task-id>child-bg9</task-id><tool-use-id>bg9</tool-use-id><status>completed</status></task-notification>',
      },
    },
    assistantText('The audit came back.', 3),
  ]);
  const artifacts = {
    files: [],
    commits: [],
    tools: { Bash: 5, Edit: 2 },
    complete: true,
    revision: 'child-r1',
  };
  const [turn] = readTurns(file, 'sess', {
    agentSpendOf: (agent) => ({
      models: [],
      found: agent.id === 'child-bg9',
      partial: false,
      effort: null,
      artifacts: agent.id === 'child-bg9' ? artifacts : undefined,
    }),
  });
  assert.equal(turn.agents.length, 1);
  // The count from its own calls fills the row rather than leaving it with no tool count at all.
  assert.equal(turn.agents[0].toolUses, 7);
  assert.equal(turn.agents[0].status, 'completed');
});

test('a still-running background subagent with no tool-use tag keeps no tool count', () => {
  // Only finished children receive a tool-count fallback from their recorded calls.

  const file = writeTranscript([
    userPrompt('run the audit in the background', 0),
    assistantTool('Agent', 1, 'bg9', { description: 'Audit the parser', subagent_type: 'Explore' }),
    backgroundLaunch('bg9', 'child-bg9', 2),
  ]);
  const artifacts = {
    files: [],
    commits: [],
    tools: { Bash: 5 },
    complete: false,
    revision: 'child-r1',
  };
  const [turn] = readTurns(file, 'sess', {
    agentSpendOf: (agent) => ({
      models: [],
      found: agent.id === 'child-bg9',
      partial: true,
      effort: null,
      artifacts: agent.id === 'child-bg9' ? artifacts : undefined,
    }),
  });
  assert.equal(turn.agents.length, 1);
  assert.equal(turn.agents[0].status, 'running');
  assert.equal(turn.agents[0].id, 'child-bg9');
  assert.equal(turn.agents[0].toolUses, null);
});

test('a background subagent that reports back as an attachment still leaves its row finished', () => {
  // Queued completion attachments carry notification text in attachment.prompt without an origin field.

  const asked: string[] = [];
  const spend = [
    {
      model: 'claude-opus-5',
      usage: { input: 4, cacheWrite1h: 0, cacheWrite5m: 6, cacheRead: 80, output: 9, thinking: 2 },
    },
  ];
  const file = writeTranscript([
    userPrompt('trace the submit path in the background', 0),
    assistantTool('Agent', 1, 'bg4', { description: 'Trace webview submit render path', subagent_type: 'Explore' }),
    queued(
      {
        commandMode: 'task-notification',
        prompt:
          '<task-notification><task-id>child-bg4</task-id><tool-use-id>bg4</tool-use-id><status>completed</status></task-notification>' +
          '<subagent_tokens>204311</subagent_tokens><tool_uses>31</tool_uses><duration_ms>512000</duration_ms>',
      },
      4,
    ),
    assistantText('The trace came back.', 5),
  ]);
  const [turn] = readTurns(file, 'sess', {
    agentSpendOf: (agent) => {
      asked.push(String(agent.id));
      return {
        models: agent.id === 'child-bg4' ? spend : [],
        found: agent.id === 'child-bg4',
        partial: false,
        effort: null,
      };
    },
  });
  assert.equal(turn.agents.length, 1, 'the attachment notice drew a second row for the same agent');
  assert.equal(turn.agents[0].status, 'completed', 'the row kept the status its launch wrote');
  assert.equal(turn.agents[0].id, 'child-bg4', 'the row never learned the child id, so its cost stays unread');
  assert.deepEqual(asked, ['child-bg4'], 'the child transcript was never opened');
  assert.deepEqual(turn.agents[0].spend, spend);
  assert.equal(turn.agents[0].tokens, 204311);
  assert.equal(turn.agents[0].toolUses, 31);
  assert.equal(turn.agents[0].durationMs, 512000);
});

test('an attachment notice for an agent that is still running leaves the row running', () => {
  // Notifications without a matching launched row create no additional subagent row.

  const file = writeTranscript([
    userPrompt('start two background traces', 0),
    assistantTool('Agent', 1, 'bg7', { description: 'Trace host submit path', subagent_type: 'Explore' }),
    queued(
      {
        commandMode: 'task-notification',
        prompt:
          '<task-notification><task-id>child-bg7</task-id><tool-use-id>bg7</tool-use-id><status>running</status></task-notification>',
      },
      2,
    ),
    queued(
      {
        commandMode: 'task-notification',
        prompt:
          '<task-notification><task-id>child-other</task-id><tool-use-id>msg-9</tool-use-id><status>completed</status></task-notification>',
      },
      3,
    ),
    assistantText('Still waiting.', 4),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.agents.length, 1, 'a notice under an unknown tool-use id drew a row of its own');
  assert.equal(turn.agents[0].status, 'running', 'a running agent stopped reading as running');
  assert.equal(turn.agents[0].id, 'child-bg7');
});

test('a notice under an unknown tool-use id leaves the call that holds that id alone', () => {
  // A completion notice under a SendMessage id leaves that call available for its later result.

  const file = writeTranscript([
    userPrompt('wake the trace agent', 0),
    assistantTool('Agent', 1, 'bg7', { description: 'Trace host submit path', subagent_type: 'Explore' }),
    assistantTool('SendMessage', 2, 'msg-9', { agent_id: 'child-bg7', message: 'check the refresh path too' }),
    queued(
      {
        commandMode: 'task-notification',
        prompt:
          '<task-notification><task-id>child-bg7</task-id><tool-use-id>msg-9</tool-use-id><status>completed</status></task-notification>',
      },
      3,
    ),
    {
      type: 'user',
      timestamp: at(4),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'msg-9', is_error: true, content: 'the agent had already stopped' },
        ],
      },
    },
    assistantAnswer('The message did not land.', 5),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.steps.map((step) => [step.name, step.status]),
    [
      ['Agent', 'done'],
      ['SendMessage', 'failed'],
    ],
    'the notice ended a call it does not own, so the failed result found no step',
  );
});

test('a notice recorded in a block shape the reader has no name for still gives up its tags', () => {
  // Notification tags remain readable inside unfamiliar content blocks.

  const file = writeTranscript([
    userPrompt('trace the submit path in the background', 0),
    assistantTool('Agent', 1, 'bg2', { description: 'Trace transcript append boundaries', subagent_type: 'Explore' }),
    {
      type: 'user',
      timestamp: at(2),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: [
          {
            type: 'task_notification',
            notification:
              '<task-notification><task-id>child-bg2</task-id><tool-use-id>bg2</tool-use-id><status>completed</status></task-notification>',
          },
        ],
      },
    },
    assistantAnswer('The trace came back.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.agents[0].status, 'completed');
  assert.equal(turn.agents[0].id, 'child-bg2', 'the child id was lost with the block the reader could not name');
});

test('a turn that ends on an attachment notice ends when the notice arrived', () => {
  // A queued completion notice advances the usage reducer's newest turn end.

  const reducer = createClaudeUsageLineReducer();
  reducer.pushLine(JSON.stringify(userPrompt('trace the submit path in the background', 1)));
  reducer.pushLine(JSON.stringify(assistantText('Launched.', 2, { output_tokens: 1 }, undefined, 'end_turn')));
  assert.equal(reducer.newestTurnOutcome()?.endedAt, ms(2));
  reducer.pushLine(
    JSON.stringify(
      queued(
        {
          commandMode: 'task-notification',
          prompt:
            '<task-notification><task-id>child-bg4</task-id><tool-use-id>bg4</tool-use-id><status>completed</status></task-notification>',
        },
        9,
      ),
    ),
  );
  assert.equal(
    reducer.newestTurnOutcome()?.endedAt,
    ms(9),
    'the turn ended before the agent it was waiting on reported back',
  );
});

// Child transcript fixtures carry isSidechain for child-aware usage classification.

test('a Claude child transcript keeps model rates apart, reports nested work, and retains its last effort', () => {
  const file = writeTranscript([
    {
      type: 'assistant',
      isSidechain: true,
      uuid: 'u1',
      effort: 'low',
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 40 },
          output_tokens: 5,
          output_tokens_details: { thinking_tokens: 3 },
        },
      },
    },
    // The same response is written again as it grows, and only the last record carries the
    // whole output and thinking count.
    {
      type: 'assistant',
      isSidechain: true,
      uuid: 'u2',
      effort: '',
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 40 },
          output_tokens: 137,
          output_tokens_details: { thinking_tokens: 9 },
        },
      },
    },
    {
      type: 'assistant',
      isSidechain: true,
      uuid: 'u3',
      effort: 'high',
      message: {
        id: 'm2',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 11,
          cache_creation_input_tokens: 13,
          output_tokens: 17,
        },
      },
    },
    {
      type: 'assistant',
      isSidechain: true,
      uuid: 'u4',
      message: {
        id: 'm3',
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', name: 'Agent', id: 'nested', input: { description: 'check it' } }],
      },
    },
  ]);
  const { artifacts, requests, ...spend } = readClaudeAgentSpend(file);
  assert.deepEqual([artifacts?.files, artifacts?.commits, artifacts?.complete], [[], [], true]);
  assert.deepEqual(
    requests?.map((request) => request.model),
    ['claude-opus-5', 'claude-sonnet-5'],
  );
  assert.deepEqual(
    { ...spend, models: spend.models.map(({ usageParts: _usageParts, ...model }) => model) },
    {
      models: [
        {
          model: 'claude-opus-5',
          usage: {
            requests: 1,
            input: 2,
            cacheWrite1h: 0,
            cacheWrite5m: 40,
            cacheWrite30m: 0,
            cacheRead: 30,
            output: 137,
            thinking: 9,
          },
        },
        {
          model: 'claude-sonnet-5',
          usage: {
            requests: 1,
            input: 7,
            cacheWrite1h: 13,
            cacheWrite5m: 0,
            cacheWrite30m: 0,
            cacheRead: 11,
            output: 17,
            thinking: 0,
          },
        },
      ],
      ownModel: 'claude-opus-5',
      found: true,
      partial: true,
      effort: 'high',
    },
  );
  assert.deepEqual(
    spend.models.map((model) =>
      model.usageParts?.map((part) => [
        part.model,
        part.provider,
        part.contextBand,
        part.inferenceClass,
        part.serviceTier,
      ]),
    ),
    [[['claude-opus-5', null, null, null, null]], [['claude-sonnet-5', null, null, null, null]]],
  );
  assert.deepEqual(readClaudeAgentSpend(path.join(path.dirname(file), 'missing.jsonl')), {
    models: [],
    found: false,
    partial: false,
    effort: null,
  });
});

// Write each transcript record as a newline-terminated JSON line.

function writeRecords(file: string, records: object[]): void {
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}
function writeSubagentMeta(folder: string, id: string, toolUseId: string, parentAgentId?: string): void {
  fs.writeFileSync(
    path.join(folder, `agent-${id}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', toolUseId, ...(parentAgentId ? { parentAgentId } : {}) }),
  );
}
function haikuRequest(id: string, second: number, stop: string, content: object[], sidechain = true) {
  return {
    type: 'assistant',
    isSidechain: sidechain,
    timestamp: at(second),
    message: {
      role: 'assistant',
      id,
      model: 'claude-haiku-4-5',
      stop_reason: stop,
      content,
      usage: { input_tokens: 1000, output_tokens: 0 },
    },
  };
}
const agentLaunch = (id: string) => [{ type: 'tool_use', id, name: 'Agent', input: { description: id } }];
const doneText = [{ type: 'text', text: 'Done.' }];

test('a nested subagent counts as running until its own last turn closes', () => {
  const folder = tempDir('nested-running-');
  const launcher = path.join(folder, 'agent-a1.jsonl');
  const nested = path.join(folder, 'agent-a2.jsonl');
  writeRecords(launcher, [
    userPrompt('launch a nested agent', 0, { isSidechain: true }),
    haikuRequest('m1', 1, 'end_turn', [...agentLaunch('launch-2'), ...doneText]),
  ]);
  writeSubagentMeta(folder, 'a2', 'launch-2', 'a1');
  writeRecords(nested, [
    userPrompt('nested work', 2, { isSidechain: true }),
    haikuRequest('m2', 3, 'tool_use', [{ type: 'tool_use', id: 'run', name: 'Bash', input: { command: 'ls' } }]),
  ]);
  const running = readClaudeAgentSpend(launcher);
  assert.deepEqual([running.models[0]?.usage.input, running.partial], [2000, true]);
  fs.appendFileSync(nested, JSON.stringify(haikuRequest('m3', 4, 'end_turn', doneText)) + '\n');
  const finished = readClaudeAgentSpend(launcher);
  assert.deepEqual([finished.models[0]?.usage.input, finished.partial], [3000, false]);
  assert.equal(
    finished.models[0]?.usageParts?.reduce((total, part) => total + part.usage.input, 0),
    3000,
  );
});

test('a malformed meta cycle reads each subagent once', () => {
  const folder = tempDir('nested-cycle-');
  const launcher = path.join(folder, 'agent-a1.jsonl');
  writeSubagentMeta(folder, 'a1', 'launch-1', 'a2');
  writeRecords(launcher, [
    userPrompt('first', 0, { isSidechain: true }),
    haikuRequest('m1', 1, 'end_turn', [...agentLaunch('launch-2'), ...doneText]),
  ]);
  writeSubagentMeta(folder, 'a2', 'launch-2', 'a1');
  writeRecords(path.join(folder, 'agent-a2.jsonl'), [
    userPrompt('second', 2, { isSidechain: true }),
    haikuRequest('m2', 3, 'end_turn', [...agentLaunch('launch-1'), ...doneText]),
  ]);
  assert.equal(readClaudeAgentSpend(launcher).models[0]?.usage.input, 2000);
  assert.equal(claudeAgentSpendVersion(launcher).split('\n').length, 2);
});

test('a dispatched session folds its own subagents and theirs', () => {
  const folder = tempDir('nested-dispatch-');
  const session = path.join(folder, 'sess.jsonl');
  const subagents = path.join(folder, 'sess', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  writeRecords(session, [
    userPrompt('dispatch work', 0),
    haikuRequest('m0', 1, 'end_turn', [...agentLaunch('launch-1'), ...doneText], false),
  ]);
  writeSubagentMeta(subagents, 'a1', 'launch-1');
  writeRecords(path.join(subagents, 'agent-a1.jsonl'), [
    userPrompt('first level', 2, { isSidechain: true }),
    haikuRequest('m1', 3, 'end_turn', [...agentLaunch('launch-2'), ...doneText]),
  ]);
  // The second level launches a third that never wrote a meta file.
  writeSubagentMeta(subagents, 'a2', 'launch-2', 'a1');
  writeRecords(path.join(subagents, 'agent-a2.jsonl'), [
    userPrompt('second level', 4, { isSidechain: true }),
    haikuRequest('m2', 5, 'end_turn', [...agentLaunch('launch-3'), ...doneText]),
  ]);
  const spend = readClaudeAgentSpend(session, [], false);
  assert.deepEqual([spend.models[0]?.usage.input, spend.partial], [3000, true]);
  fs.writeFileSync(
    path.join(subagents, 'agent-a2.jsonl'),
    [userPrompt('second level', 4, { isSidechain: true }), haikuRequest('m2', 5, 'end_turn', doneText)]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const whole = readClaudeAgentSpend(session, [], false);
  assert.deepEqual([whole.models[0]?.usage.input, whole.partial], [3000, false]);
});

// A subagent request record opens with its type, session, and agent, then its id and send time.
function childRequest(id: string, second: number) {
  return { type: 'api-request', sessionId: 'sess', agentId: 'a1', id, timestamp: at(second), version: '2.1.302' };
}
function childBlock(
  id: string,
  requestRef: string,
  second: number,
  output: number,
  stop: string | null = 'end_turn',
  model = 'claude-opus-5',
  content: object[] = doneText,
) {
  const block = requestBlock(id, requestRef, second, output, 'end_turn', model);
  return { ...block, isSidechain: true, message: { ...block.message, stop_reason: stop, content } };
}
const childTurn = (text: string, second: number) => userPrompt(text, second, { isSidechain: true });
const childRate = (file: string) => {
  const spend = readClaudeAgentSpend(file);
  return spend.outputRate ? { ...spend.outputRate, model: spend.outputRateModel } : undefined;
};

test('a Claude subagent read times its own turns from their request records', () => {
  const folder = tempDir('child-rate-');
  const file = path.join(folder, 'agent-a1.jsonl');
  writeRecords(file, [
    childTurn('work', 0),
    childRequest('req-1', 10),
    childBlock('m1', 'req-1', 12, 5, null),
    childBlock('m1', 'req-1', 14, 400),
  ]);
  const turn = readSession(file, 'agent-a1', { childTranscript: true }).turns[0];
  assert.deepEqual(turn.outputRate, { output: 400, milliseconds: 4000 });
  assert.equal(turn.outputRateBasis, 'request');
  assert.deepEqual(turn.timedResponseIds, ['m1']);
  assert.equal(turn.responseIds, undefined, 'cache-expiry matching never sees child responses');
  assert.deepEqual(childRate(file), { output: 400, milliseconds: 4000, model: 'claude-opus-5' });
});

test('a Claude subagent speed leaves out unstopped responses, other models, interrupted turns, and nested work', () => {
  const folder = tempDir('child-rate-rules-');
  const opening = path.join(folder, 'agent-opening.jsonl');
  // Most child responses end on the opening output count and never record a stop reason.
  writeRecords(opening, [childTurn('work', 0), childRequest('req-1', 10), childBlock('m1', 'req-1', 12, 5, null)]);
  assert.equal(childRate(opening), undefined);

  const models = path.join(folder, 'agent-models.jsonl');
  writeRecords(models, [
    childTurn('first', 0),
    childRequest('req-1', 10),
    childBlock('m1', 'req-1', 14, 400),
    childTurn('second', 20),
    childRequest('req-2', 21),
    childBlock('m2', 'req-2', 22, 100, 'end_turn', 'claude-sonnet-5'),
  ]);
  assert.equal(childRate(models), undefined);

  const interrupted = path.join(folder, 'agent-interrupted.jsonl');
  writeRecords(interrupted, [
    childTurn('first', 0),
    childRequest('req-1', 10),
    childBlock('m1', 'req-1', 14, 400),
    childTurn('second', 20),
    childRequest('req-2', 21),
    childBlock('m2', 'req-2', 22, 100, 'tool_use'),
    childTurn('[Request interrupted by user]', 23),
  ]);
  assert.deepEqual(childRate(interrupted), { output: 400, milliseconds: 4000, model: 'claude-opus-5' });

  // The launcher times its own launch response, and its nested subagent adds spend but no time.
  const launcher = path.join(folder, 'agent-a1.jsonl');
  writeRecords(launcher, [
    childTurn('launch', 0),
    childRequest('req-1', 10),
    childBlock('m1', 'req-1', 14, 400, 'end_turn', 'claude-opus-5', [...agentLaunch('launch-2'), ...doneText]),
  ]);
  writeSubagentMeta(folder, 'a2', 'launch-2', 'a1');
  writeRecords(path.join(folder, 'agent-a2.jsonl'), [
    childTurn('nested', 15),
    childRequest('req-9', 16),
    childBlock('m9', 'req-9', 17, 900),
  ]);
  const nested = readClaudeAgentSpend(launcher);
  assert.equal(nested.models[0]?.usage.output, 1300, 'the nested subagent adds its spend');
  assert.deepEqual(childRate(launcher), { output: 400, milliseconds: 4000, model: 'claude-opus-5' });
  writeRecords(launcher, [
    childTurn('launch', 0),
    haikuRequest('m1', 1, 'end_turn', [...agentLaunch('launch-2'), ...doneText]),
  ]);
  assert.equal(childRate(launcher), undefined, 'an untimed launcher takes no time from its nested subagent');
});

test('a dispatched Claude session read times its row from its own turns', () => {
  const file = writeTranscript([userPrompt('work'), requestRecord('req-1', 10), requestBlock('m1', 'req-1', 14, 400)]);
  assert.equal(readSession(file, 'sess').turns[0].outputRateBasis, 'request', 'the session turn itself is timed');
  const spend = readClaudeAgentSpend(file, [], false);
  assert.deepEqual(spend.outputRate, { output: 400, milliseconds: 4000 });
  assert.equal(spend.outputRateModel, 'claude-opus-5');
});

test('a dispatched Claude session row takes no time from its nested subagent', () => {
  const folder = tempDir('timed-dispatch-nested-');
  const session = path.join(folder, 'sess.jsonl');
  const subagents = path.join(folder, 'sess', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const launch = requestBlock('m1', 'req-1', 14, 400);
  writeRecords(session, [
    userPrompt('dispatch work', 0),
    requestRecord('req-1', 10),
    { ...launch, message: { ...launch.message, content: [...agentLaunch('launch-1'), ...doneText] } },
  ]);
  writeSubagentMeta(subagents, 'a1', 'launch-1');
  writeRecords(path.join(subagents, 'agent-a1.jsonl'), [
    childTurn('nested', 15),
    childRequest('req-9', 16),
    childBlock('m9', 'req-9', 17, 900),
  ]);
  const spend = readClaudeAgentSpend(session, [], false);
  assert.equal(spend.models[0]?.usage.output, 1300, 'the nested subagent adds its spend');
  assert.deepEqual(spend.outputRate, { output: 400, milliseconds: 4000 });
  assert.equal(spend.outputRateModel, 'claude-opus-5');
});

test('a dispatched Claude session timed on two models keeps no speed for its row', () => {
  const file = writeTranscript([
    userPrompt('first', 0),
    requestRecord('req-1', 10),
    requestBlock('m1', 'req-1', 14, 400),
    userPrompt('second', 20),
    requestRecord('req-2', 21),
    requestBlock('m2', 'req-2', 22, 100, 'end_turn', 'claude-sonnet-5'),
  ]);
  const spend = readClaudeAgentSpend(file, [], false);
  assert.equal(spend.outputRate, undefined);
  assert.equal(spend.outputRateModel, undefined);
});

test('a subagent launch that failed before it started leaves the row complete', () => {
  const folder = tempDir('nested-failed-launch-');
  const launcher = path.join(folder, 'agent-a1.jsonl');
  writeRecords(launcher, [
    userPrompt('launch a nested agent', 0, { isSidechain: true }),
    haikuRequest('m1', 1, 'tool_use', agentLaunch('launch-denied')),
    {
      type: 'user',
      isSidechain: true,
      timestamp: at(2),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'launch-denied', is_error: true, content: 'Agent type not found' },
        ],
      },
    },
    haikuRequest('m2', 3, 'end_turn', doneText),
  ]);
  const spend = readClaudeAgentSpend(launcher);
  assert.deepEqual([spend.models[0]?.usage.input, spend.partial], [2000, false]);
});

test('a nested subagent write reads that subagent again and not its launcher', () => {
  const folder = tempDir('nested-own-cache-');
  const launcher = path.join(folder, 'agent-a1.jsonl');
  const nested = path.join(folder, 'agent-a2.jsonl');
  const records = [
    userPrompt('launch a nested agent', 0, { isSidechain: true }),
    haikuRequest('m1', 1, 'end_turn', [...agentLaunch('launch-2'), ...doneText]),
  ];
  writeRecords(launcher, records);
  fs.utimesSync(launcher, 1000, 1000);
  writeSubagentMeta(folder, 'a2', 'launch-2', 'a1');
  writeRecords(nested, [
    userPrompt('nested work', 2, { isSidechain: true }),
    haikuRequest('m2', 3, 'end_turn', doneText),
  ]);
  assert.equal(readClaudeAgentSpend(launcher).models[0]?.usage.input, 2000);
  // Same size and time, other bytes: only a fresh parse of the launcher would see the change.
  fs.writeFileSync(launcher, fs.readFileSync(launcher, 'utf8').replace('"input_tokens":1000', '"input_tokens":9000'));
  fs.utimesSync(launcher, 1000, 1000);
  fs.appendFileSync(nested, JSON.stringify(haikuRequest('m3', 4, 'end_turn', doneText)) + '\n');
  assert.equal(readClaudeAgentSpend(launcher).models[0]?.usage.input, 3000);
});

test('a nested transcript that appears or grows changes its launcher spend version', () => {
  const folder = tempDir('nested-version-');
  const launcher = path.join(folder, 'agent-a1.jsonl');
  writeRecords(launcher, [
    userPrompt('launch a nested agent', 0, { isSidechain: true }),
    haikuRequest('m1', 1, 'end_turn', [...agentLaunch('launch-2'), ...doneText]),
  ]);
  const alone = claudeAgentSpendVersion(launcher);
  const nested = path.join(folder, 'agent-a2.jsonl');
  writeSubagentMeta(folder, 'a2', 'launch-2', 'a1');
  writeRecords(nested, [userPrompt('nested work', 2, { isSidechain: true })]);
  const appeared = claudeAgentSpendVersion(launcher);
  assert.notEqual(appeared, alone);
  fs.appendFileSync(nested, JSON.stringify(haikuRequest('m2', 3, 'end_turn', doneText)) + '\n');
  assert.notEqual(claudeAgentSpendVersion(launcher), appeared);
});

test('a Claude child spend read carries commits from its own sidechain turns', () => {
  const fileWithCommit = writeTranscript([
    { ...userPrompt('commit the parser fix', 0), isSidechain: true, cwd: 'c:/repo' },
    {
      ...assistantTool('Bash', 1, 'commit-1', { command: 'git commit -am "fix parser"' }),
      isSidechain: true,
      cwd: 'c:/repo',
    },
    {
      type: 'user',
      isSidechain: true,
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'commit-1', content: 'done' }] },
      toolUseResult: {
        stdout: '[topic abc1234] Fix parser\n 1 file changed, 4 insertions(+), 1 deletion(-)',
        stderr: '',
      },
    },
    { ...assistantAnswer('Committed.', 3), isSidechain: true },
  ]);
  assert.deepEqual(
    readClaudeAgentSpend(fileWithCommit).commits?.map((commit) => [
      commit.sha,
      commit.subject,
      commit.added,
      commit.removed,
    ]),
    [['abc1234', 'Fix parser', 4, 1]],
  );
});

test('a Claude child transcript ignores synthetic and failed response effort', () => {
  const file = writeTranscript([
    { type: 'assistant', isSidechain: true, uuid: 'u1', effort: 'high', message: { id: 'm1', model: 'claude-opus-5' } },
    { type: 'assistant', isSidechain: true, uuid: 'u2', effort: 'low', message: { id: 'm2', model: '<synthetic>' } },
    {
      type: 'assistant',
      isSidechain: true,
      uuid: 'u3',
      effort: 'medium',
      isApiErrorMessage: true,
      message: { id: 'm3', model: 'claude-opus-5' },
    },
  ]);
  assert.equal(readClaudeAgentSpend(file).effort, 'high');
});

test('a parent read refuses to bill a child line, and a child read bills it', () => {
  const record = {
    type: 'assistant',
    isSidechain: true,
    uuid: 'u1',
    timestamp: at(1),
    message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: 4 } },
  };
  assert.equal(
    reduceClaudeUsageRecord(emptyClaudeUsageReducerState(), record),
    null,
    'the child transcript holds this request, so a parent read must not bill it twice',
  );
  const counted = reduceClaudeUsageRecord(emptyClaudeUsageReducerState(), record, { countSidechain: true });
  assert.equal(counted?.usage.output, 4);
  assert.equal(counted?.usage.input, 3);
});

test('a repeat is dropped by default, and the child reader keeps the last one', () => {
  const growing = (output: number, uuid: string) => ({
    type: 'assistant',
    isSidechain: true,
    uuid,
    timestamp: at(1),
    message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: output } },
  });
  const dropping = emptyClaudeUsageReducerState();
  assert.equal(reduceClaudeUsageRecord(dropping, growing(2, 'u1'), { countSidechain: true })?.usage.output, 2);
  assert.equal(
    reduceClaudeUsageRecord(dropping, growing(90, 'u2'), { countSidechain: true }),
    null,
    'a parent transcript repeats the finished counts, so a repeat adds nothing there',
  );
  const keeping = emptyClaudeUsageReducerState();
  const opts = { countSidechain: true, emitRepeats: true };
  assert.equal(reduceClaudeUsageRecord(keeping, growing(2, 'u1'), opts)?.usage.output, 2);
  const last = reduceClaudeUsageRecord(keeping, growing(90, 'u2'), opts);
  assert.equal(last?.usage.output, 90, 'the child reader needs the repeat to reach the whole output count');
  assert.equal(last?.requestKey, 'claude:m1', 'both records share one key, so the last one replaces the first');
});

test('child turn and spend readers share replacement accounting', () => {
  const growing = (output: number, uuid: string) => ({
    type: 'assistant',
    isSidechain: true,
    uuid,
    timestamp: at(1),
    message: {
      id: 'same-request',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 3, output_tokens: output },
    },
  });
  const file = writeTranscript([
    { ...userPrompt('do child work', 0), isSidechain: true },
    growing(2, 'u1'),
    growing(90, 'u2'),
  ]);
  const turnUsage = readSession(file, 'child', { childTranscript: true }).turns[0].usage;
  const spendUsage = readClaudeAgentSpend(file).models[0].usage;
  assert.deepEqual(
    turnUsage,
    spendUsage,
    'the selected child and parent-card spend applied different repeated-request rules',
  );
});

test('a child line reducer replaces a repeated cumulative response after restored state', () => {
  const growing = (output: number) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      uuid: `u${output}`,
      timestamp: at(output),
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: output } },
    });
  const first = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  assert.deepEqual(first.pushLine(growing(4))[0].usage, {
    requests: 1,
    input: 3,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 4,
    thinking: 0,
  });
  const resumed = createClaudeUsageLineReducer(first.snapshot(), { childTranscript: true });
  const replacement = resumed.pushLine(growing(10));
  assert.equal(replacement.length, 2);
  assert.deepEqual(replacement[0].usage, {
    requests: -1,
    input: -3,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: -4,
    thinking: 0,
  });
  assert.deepEqual(replacement[1].usage, {
    requests: 1,
    input: 3,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 10,
    thinking: 0,
  });
});

// Response records share a message id across content blocks while each block has its own uuid.

const usageRecord = (id: string, output: number, opts: { block?: number; sidechain?: boolean } = {}) =>
  JSON.stringify({
    type: 'assistant',
    ...(opts.sidechain === true ? { isSidechain: true } : {}),
    uuid: `${id}-${opts.block ?? output}`,
    timestamp: at(output),
    message: { id, model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: output } },
  });

const growingChildRequest = (id: string, output: number) => usageRecord(id, output, { sidechain: true });

test('a child snapshot keeps an event for every request its queue still counts', () => {
  const reducer = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  const requests = RETAINED_REQUESTS + 20;
  for (let request = 0; request < requests; request++) {
    reducer.pushLine(growingChildRequest(`m${request}`, 1));
  }

  const snapshot = reducer.snapshot();
  assert.equal(snapshot.seenRequestKeys.length, RETAINED_REQUESTS);
  assert.deepEqual(
    Object.keys(snapshot.requestEvents ?? {}).sort(),
    [...snapshot.seenRequestKeys].sort(),
    'the two halves of the memory hold the same requests, so no counted request loses its event',
  );

  const oldest = snapshot.seenRequestKeys[0].replace('claude:', '');
  const revision = reducer.pushLine(growingChildRequest(oldest, 9));
  assert.equal(revision.length, 2, 'the oldest request the queue still counts can still be revised');
  assert.equal(revision[0].usage.output, -1);
  assert.equal(revision[1].usage.output, 9);
});

test('a record saved under a smaller window refuses to count its late revision twice', () => {
  const keys = Array.from({ length: 4 }, (unused, request) => `claude:m${request}`);
  const reducer = createClaudeUsageLineReducer(
    {
      seenRequestKeys: keys,
      closedTurns: 0,
      openTurn: false,
      openTurnAnswered: false,
      compactionCount: 0,
      recentCompactions: [],
      visibleTurns: 0,
      firstTurnAt: null,
      currentTurnStartedAt: null,
      currentTurnEndedAt: null,
      currentTurnOutcome: null,
      requestEvents: {},
    },
    { childTranscript: true },
  );

  assert.deepEqual(
    reducer.pushLine(growingChildRequest('m0', 9)),
    [],
    'the saved record already counted that request and kept no event to remove',
  );
  assert.equal(reducer.pushLine(growingChildRequest('m9', 9)).length, 1, 'an uncounted request is still counted');
});

test('a parent read bills one response once however many requests separate its records', () => {
  // Repeated response blocks retain one billed request despite intervening requests and checkpoint restoration.

  const reducer = createClaudeUsageLineReducer();
  const billed = (id: string, block: number) => reducer.pushLine(usageRecord(id, 1, { block })).length;
  assert.equal(billed('msg_01first', 1), 1);
  for (let other = 0; other < RETAINED_REQUESTS + 20; other++) {
    assert.equal(billed(`msg_01other${other}`, 1), 1, 'a separating request was not billed');
  }
  assert.equal(billed('msg_01first', 2), 0, 'a later content block was billed as a second request');

  const resumed = createClaudeUsageLineReducer(JSON.parse(JSON.stringify(reducer.snapshot())));
  assert.equal(
    resumed.pushLine(usageRecord('msg_01first', 1, { block: 3 })).length,
    0,
    'a read resumed from the saved record billed a request that record already counted',
  );
});

test('a parent read carries forward no event map', () => {
  const child = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  child.pushLine(growingChildRequest('msg_01kept', 1));
  const saved = JSON.parse(JSON.stringify(child.snapshot()));
  assert.ok(saved.requestEvents, 'the record under test must hold an event');

  const parent = createClaudeUsageLineReducer(saved);
  assert.equal(
    parent.snapshot().requestEvents,
    undefined,
    'a parent read saved an event map that nothing pairs with its queue',
  );
});

test('a child read replaces a repeated response after a window of other requests', () => {
  const reducer = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  const requests = RETAINED_REQUESTS + 20;
  for (let request = 0; request < requests; request++) {
    reducer.pushLine(growingChildRequest(`msg_01r${request}`, 1));
  }
  const saved = JSON.parse(JSON.stringify(reducer.snapshot()));
  assert.deepEqual(
    Object.keys(saved.requestEvents ?? {}).sort(),
    [...saved.seenRequestKeys].sort(),
    'a saved child record keeps an event for every request its queue still counts',
  );

  const resumed = createClaudeUsageLineReducer(saved, { childTranscript: true });
  const revision = resumed.pushLine(growingChildRequest(`msg_01r${requests - 1}`, 9));
  assert.equal(revision.length, 2, 'the revision must remove what the earlier record reported');
  assert.equal(
    (revision[0].usage.requests ?? 0) + (revision[1].usage.requests ?? 0),
    0,
    'the revision counted the response a second time',
  );
  assert.equal(revision[0].usage.output, -1);
  assert.equal(revision[1].usage.output, 9);
});

test('Claude usage events retain request metadata and deduplicate after state is restored', () => {
  const record = {
    type: 'assistant',
    uuid: 'line-1',
    timestamp: at(3),
    message: {
      id: 'message-1',
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 4,
        output_tokens: 6,
        service_tier: 'priority',
        inference_geo: 'us',
        cost_usd: 0.42,
      },
    },
  };
  const state = emptyClaudeUsageReducerState();
  const event = reduceClaudeUsageRecord(state, record);
  assert.deepEqual(event, {
    timestamp: ms(3),
    agent: 'claude',
    provider: null,
    model: 'claude-sonnet-5',
    contextWindow: null,
    contextBand: null,
    billingClass: 'unknown',
    inferenceClass: 'in-region',
    serviceTier: 'priority',
    effort: null,
    toolListVersion: 0,
    reportedCost: 0.42,
    requestKey: 'claude:message-1',
    // An unsplit cache write names no lifetime, and a record before any typed prompt names
    // no visible turn. Both stay null so the adjacency pass calls the pair unavailable.
    visibleTurnId: null,
    cacheLifetime: null,
    compactionsBefore: 0,
    contextTokens: 24,
    usage: {
      requests: 1,
      input: 12,
      cacheWrite1h: 4,
      cacheWrite5m: 0,
      cacheWrite30m: 0,
      cacheRead: 8,
      output: 6,
      thinking: 0,
    },
  });
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(reduceClaudeUsageRecord(restored, record), null);
  assert.equal(
    reduceClaudeUsageRecord(restored, {
      ...record,
      uuid: 'line-2',
      message: { ...record.message, id: 'message-2' },
    })?.requestKey,
    'claude:message-2',
  );
});

test('a fast-mode Claude turn carries its speed through the service tier field', () => {
  const record = {
    type: 'assistant',
    uuid: 'line-1',
    timestamp: at(3),
    message: {
      id: 'message-1',
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        service_tier: 'standard',
        speed: 'fast',
      },
    },
  };
  const event = reduceClaudeUsageRecord(emptyClaudeUsageReducerState(), record);
  assert.equal(event?.serviceTier, 'fast', 'a fast speed must override a standard service tier');
  const quote = quoteUsage({
    usage: event!.usage,
    model: event!.model,
    provider: event!.provider,
    inferenceClass: event!.inferenceClass,
    serviceTier: event!.serviceTier,
  });
  assert.equal(quote?.cost, 8 + 40, 'a fast Opus 5.5 request is priced at the fast rate');
});

test('a Claude turn with no speed field still reads as standard', () => {
  const record = {
    type: 'assistant',
    uuid: 'line-1',
    timestamp: at(3),
    message: {
      id: 'message-1',
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        service_tier: 'standard',
      },
    },
  };
  const event = reduceClaudeUsageRecord(emptyClaudeUsageReducerState(), record);
  assert.equal(event?.serviceTier, 'standard', 'an older transcript with no speed field must still price standard');
});

test('a Claude turn with speed explicitly standard keeps its service tier', () => {
  const record = {
    type: 'assistant',
    uuid: 'line-1',
    timestamp: at(3),
    message: {
      id: 'message-1',
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        service_tier: 'priority',
        speed: 'standard',
      },
    },
  };
  const event = reduceClaudeUsageRecord(emptyClaudeUsageReducerState(), record);
  assert.equal(event?.serviceTier, 'priority', 'a standard speed must not mask another recorded service tier');
});

test('the incremental Claude usage filter accepts a spaced assistant record and skips large tool output', () => {
  const reducer = createClaudeUsageLineReducer();
  const record = JSON.stringify({
    type: 'assistant',
    uuid: 'line-1',
    timestamp: at(3),
    message: { id: 'message-1', model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 1 } },
  }).replace('"type":"assistant"', '"type" : "assistant"');
  assert.equal(reducer.pushLine(record)[0]?.requestKey, 'claude:message-1');
  assert.deepEqual(
    reducer.pushLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'x'.repeat(1024 * 1024) }] },
      }),
    ),
    [],
  );
});

test('the incremental Claude usage reducer counts drawable turns across a resume', () => {
  const prompt = (text: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: at(1),
      message: { role: 'user', content: text },
    });
  const answer = (id: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid: id,
      timestamp: at(2),
      message: { id, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'done' }], usage: { output_tokens: 1 } },
    });
  const first = createClaudeUsageLineReducer();
  first.pushLine(prompt('first'));
  assert.equal(first.turnCount(), 1, 'the current open turn is omitted');
  first.pushLine(answer('answer-1'));

  const resumed = createClaudeUsageLineReducer(first.snapshot());
  resumed.pushLine(prompt('queued without an answer'));
  resumed.pushLine(prompt('second answered turn'));
  resumed.pushLine(answer('answer-2'));
  assert.equal(resumed.turnCount(), 2, 'an absorbed prompt was counted as its own turn');
  resumed.pushLine(prompt('third still open'));
  assert.equal(resumed.turnCount(), 3, 'a resumed reducer lost its closed turn count');
});

test('the incremental Claude usage reducer tracks compactions and the session span across a resume', () => {
  const prompt = (n: number, text: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: at(n),
      message: { role: 'user', content: text },
    });
  const answer = (n: number, id: string) =>
    JSON.stringify({
      type: 'assistant',
      uuid: id,
      timestamp: at(n),
      message: { id, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'done' }], usage: { output_tokens: 1 } },
    });
  const compaction = (n: number) =>
    JSON.stringify({
      type: 'user',
      timestamp: at(n),
      isCompactSummary: true,
      message: { content: 'summary' },
    });
  const first = createClaudeUsageLineReducer();
  assert.equal(first.compactionCount(), 0, 'a session with no compaction reports zero, not a missing value');
  assert.equal(first.firstTurnAt(), null);
  assert.equal(first.lastTurnAt(), null);

  first.pushLine(prompt(1, 'first'));
  assert.equal(first.firstTurnAt(), ms(1));
  assert.equal(first.lastTurnAt(), ms(1), 'an unanswered open turn falls back to its startedAt');
  first.pushLine(answer(2, 'answer-1'));
  assert.equal(first.newestTurnStartedAt(), ms(1));
  assert.deepEqual(first.newestTurnOutcome(), {
    finished: false,
    error: false,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
  assert.equal(first.lastTurnAt(), ms(2), 'an answered turn reports its last activity as endedAt');
  first.pushLine(compaction(3));
  assert.equal(first.compactionCount(), 1);
  assert.equal(first.lastTurnAt(), ms(2), 'a compaction does not move the last turn span');

  const resumed = createClaudeUsageLineReducer(first.snapshot());
  assert.equal(resumed.newestTurnStartedAt(), ms(1));
  assert.deepEqual(resumed.newestTurnOutcome(), {
    finished: false,
    error: false,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
  assert.equal(resumed.compactionCount(), 1, 'a resumed reducer kept its compaction count');
  assert.equal(resumed.firstTurnAt(), ms(1), 'a resumed reducer kept the first turn it saw');
  resumed.pushLine(prompt(4, 'second'));
  assert.equal(resumed.firstTurnAt(), ms(1), 'the first turn never moves once a later turn opens');
  assert.equal(resumed.lastTurnAt(), ms(4), 'the newly opened turn is now the last one, open and unanswered');
  resumed.pushLine(compaction(5));
  assert.equal(resumed.compactionCount(), 2);
});

test('a Claude process end stops an unfinished rail turn in full and indexed reads', () => {
  const records = [
    userPrompt('run the command', 0),
    {
      ...assistantTool('PowerShell', 1, 'stop-call', { command: 'Start-Sleep -Seconds 60' }),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'stop-call', name: 'PowerShell', input: { command: 'Start-Sleep -Seconds 60' } },
        ],
      },
    },
    costState(ms(0), 5_000),
    costState(ms(0), 6_000),
  ];
  const file = writeTranscript(records);
  const read = readSession(file, 'sess');
  const full = read.turns[0] as (typeof read.turns)[number] & { processEndedAt?: number };
  assert.equal(full.processEndedAt, ms(6));
  assert.equal(full.endedAt, ms(1), 'process shutdown must not move the last activity time');
  assert.equal(readSessionActivity(file), ms(1), 'process shutdown must not move rail recency');
  assert.equal(statusOf(full, true, ms(2)), 'stopped', 'the selected rail turn still says running');
  assert.equal(readSessionMeta(file).outcome?.processEndedAt, ms(6));

  const semantic = createClaudeSessionReducer('sess');
  for (const record of records) {
    semantic.pushLine(JSON.stringify(record));
  }
  assert.equal(semantic.completedTurns().length, 1);
  assert.equal(semantic.openRange(), null);

  const indexed = createClaudeUsageLineReducer();
  for (const record of records) {
    indexed.pushLine(JSON.stringify(record));
  }
  const outcome = indexed.newestTurnOutcome() as ReturnType<typeof indexed.newestTurnOutcome> & {
    processEndedAt?: number;
  };
  assert.ok(outcome);
  assert.equal(outcome?.processEndedAt, ms(6));
  assert.equal(
    statusOf(outcome, true, ms(2)),
    'stopped',
    'a fresh rail rebuilt from the lifetime index still says running',
  );

  const restored = createClaudeUsageLineReducer(indexed.snapshot());
  assert.equal(restored.newestTurnOutcome()?.processEndedAt, ms(6));
  restored.pushLine(JSON.stringify(userPrompt('resume the session', 7)));
  assert.equal(restored.newestTurnOutcome()?.processEndedAt, undefined);

  const boundaryOnly = createClaudeUsageLineReducer();
  boundaryOnly.pushLine(JSON.stringify(userPrompt('stop before an answer', 8)));
  boundaryOnly.pushLine(JSON.stringify(costState(ms(8), 1_000)));
  assert.equal(boundaryOnly.lastTurnAt(), ms(8), 'the process boundary must not become activity');
  boundaryOnly.pushLine(JSON.stringify(userPrompt('start again', 10)));
  assert.equal(boundaryOnly.turnCount(), 2, 'a stopped unanswered turn was lost after resume');
  assert.equal(boundaryOnly.newestTurnOutcome()?.processEndedAt, undefined);

  fs.appendFileSync(file, JSON.stringify(userPrompt('resume the session', 7)) + '\n');
  const resumed = readSession(file, 'sess').turns;
  assert.equal(resumed.length, 2);
  assert.equal(resumed[0].processEndedAt, ms(6));
  assert.equal(resumed[1].processEndedAt, undefined);
});

// Local command records include a caveat, the command, and its answer linked by parentUuid.
// `user` records the answer as a user record that holds only the output element, as the CLI
// does for most built-in commands, such as `/mcp`.

function localCommand(
  name: string,
  args: string,
  second: number,
  uuid: string,
  answer: { stdout?: string; stderr?: string; parent?: string; user?: boolean },
): object[] {
  const tag = answer.stdout !== undefined ? 'local-command-stdout' : 'local-command-stderr';
  const output = `<${tag}>${answer.stdout ?? answer.stderr ?? ''}</${tag}>`;
  return [
    {
      type: 'user',
      isMeta: true,
      timestamp: at(second),
      message: {
        role: 'user',
        content: '<local-command-caveat>Caveat: The messages below were generated by the user.</local-command-caveat>',
      },
    },
    {
      type: 'user',
      uuid,
      timestamp: at(second),
      message: {
        role: 'user',
        content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
      },
    },
    answer.user
      ? {
          type: 'user',
          uuid: `${uuid}-answer`,
          parentUuid: answer.parent ?? uuid,
          timestamp: at(second),
          message: { role: 'user', content: output },
        }
      : {
          type: 'system',
          subtype: 'local_command',
          parentUuid: answer.parent ?? uuid,
          timestamp: at(second),
          level: 'info',
          isMeta: false,
          content: output,
          commandRun: { command: name.slice(1), args },
        },
  ];
}

const RENAMED = 'Session renamed to: claude entrypoint auto handback';

test('command-only CLI transcripts supply neither admission nor a fallback name', () => {
  for (const answer of [
    { stdout: 'Login interrupted', user: true },
    { stdout: 'Login interrupted' },
    { stderr: 'Login interrupted', user: true },
  ]) {
    const records = localCommand('/usage-credits', '', 2, 'command', answer);
    records[0] = { ...records[0], uuid: 'caveat', timestamp: at(2.001) };
    records[1] = { ...records[1], parentUuid: 'caveat' };
    const file = writeTranscript(records);
    assert.equal(holdsHumanPrompt(fs.readFileSync(file, 'utf8')), false);
    const scan = scanForHumanPrompt(file, fs.statSync(file).size);
    assert.equal(scan.found, false);
    assert.equal(scan.command?.withdrawn, true);
    assert.equal(readSessionMeta(file).title, null);
    assert.equal(localAnswerStatuses(records, AFTER_COMMAND, true).count, 0);
  }
});

test('command admission withdraws and stays withdrawn after model work across appends, chunk edges and incomplete lines', () => {
  const [caveat, command, answer] = localCommand('/usage-credits', '', 2, 'command', {
    stdout: 'Login interrupted',
    user: true,
  });
  const file = writeTranscript([caveat, command]);
  let scan = scanForHumanPrompt(file, fs.statSync(file).size);
  assert.equal(scan.found, false);
  assert.equal(scan.command?.withdrawn, false);
  assert.equal(promptScanLists(scan), true);
  fs.appendFileSync(file, JSON.stringify(answer));
  const partial = scanForHumanPrompt(file, fs.statSync(file).size, scan);
  assert.deepEqual(partial, { ...scan, complete: false });
  fs.appendFileSync(file, '\n');
  scan = scanForHumanPrompt(file, fs.statSync(file).size, partial);
  assert.equal(scan.command?.withdrawn, true);
  assert.equal(promptScanLists(scan), false);
  fs.appendFileSync(file, JSON.stringify(assistantAnswer('model work', 3)) + '\n');
  scan = scanForHumanPrompt(file, fs.statSync(file).size, scan);
  assert.equal(scan.found, false);
  assert.equal(scan.command?.withdrawn, true);
  assert.equal(promptScanLists(scan), false);
  assert.deepEqual(scanForHumanPrompt(file, fs.statSync(file).size, scan), scan);
  fs.writeFileSync(file, JSON.stringify({ ...userPrompt('fresh file', 0), uuid: 'fresh' }) + '\n');
  const shrunk = scanForHumanPrompt(file, fs.statSync(file).size, scan);
  assert.equal(shrunk.found, false);
  assert.equal(shrunk.command?.id, 'fresh');

  const long = writeTranscript([
    command,
    ...Array.from({ length: 8 }, () => ({ type: 'bookkeeping', padding: 'x'.repeat(150_000) })),
  ]);
  const size = fs.statSync(long).size;
  const meter = openReadWindow();
  const pending = scanForHumanPrompt(long, size);
  assert.equal(closeReadWindow(meter).bytes, size);
  const retryMeter = openReadWindow();
  assert.deepEqual(scanForHumanPrompt(long, size, pending), pending);
  assert.equal(closeReadWindow(retryMeter).bytes, 0);
  fs.appendFileSync(long, JSON.stringify(answer) + '\n');
  const appendMeter = openReadWindow();
  assert.equal(scanForHumanPrompt(long, fs.statSync(long).size, pending).command?.withdrawn, true);
  assert.equal(closeReadWindow(appendMeter).bytes, fs.statSync(long).size - size);

  const prefix = JSON.stringify(command) + '\n';
  const padding =
    JSON.stringify({ type: 'bookkeeping', padding: 'x'.repeat(256 * 1024 - Buffer.byteLength(prefix) - 45) }) + '\n';
  fs.writeFileSync(long, prefix + padding + JSON.stringify(answer) + '\n');
  assert.equal(scanForHumanPrompt(long, fs.statSync(long).size).command?.withdrawn, true);
  fs.writeFileSync(long, JSON.stringify(userPrompt('new file', 0)) + '\n');
  assert.equal(scanForHumanPrompt(long, fs.statSync(long).size, pending).found, true);
});

test('command admission keeps mismatched answers and process-ended commands, and confirms queued asks', () => {
  const [caveat, command, answer] = localCommand('/usage-credits', '', 2, 'command', {
    stdout: 'Login interrupted',
    user: true,
  });
  const ended = { type: 'cost-state', startTime: ms(2), totalDuration: 1 };
  for (const records of [
    [caveat, command, { ...answer, parentUuid: 'other' }],
    [caveat, command, ended, answer],
    [caveat, command, typedMidTurn('next ask', 3), answer],
    [caveat, command, answer, typedMidTurn('next ask', 3)],
    [caveat, { ...command, uuid: undefined }, answer],
  ]) {
    assert.equal(holdsHumanPrompt(records.map((record) => JSON.stringify(record)).join('\n')), true);
    const file = writeTranscript(records);
    assert.equal(promptScanLists(scanForHumanPrompt(file, fs.statSync(file).size)), true);
  }
});

test('fallback names skip withdrawn commands, including ones model work follows, and use only the head window', () => {
  const records = localCommand('/usage-credits', '', 2, 'command', { stdout: 'Login interrupted', user: true });
  const real = readSessionMeta(
    writeTranscript([...records, userPrompt('actual task', 3), assistantAnswer('answer', 4)]),
  );
  assert.equal(real.title, 'actual task');
  assert.equal(real.withdrawnPrompt, true);
  const followed = readSessionMeta(writeTranscript([...records, assistantAnswer('model work', 3)]));
  assert.equal(followed.title, null);
  assert.equal(followed.withdrawnPrompt, true);
  for (const queued of [
    [...records.slice(0, 2), typedMidTurn('queued task', 3), records[2]],
    [...records, typedMidTurn('queued task', 3)],
    [...records, { type: 'bookkeeping', padding: 'x'.repeat(150 * 1024) }, typedMidTurn('queued task', 3)],
  ]) {
    const meta = readSessionMeta(writeTranscript(queued));
    assert.equal(meta.title, 'queued task');
    assert.equal(meta.withdrawnPrompt, true);
  }
  const [, command, answer] = records;
  const file = writeTranscript([command, { type: 'bookkeeping', padding: 'x'.repeat(300 * 1024) }, answer]);
  assert.equal(readSessionMeta(file, 512).title, '/usage-credits');
  assert.equal(readSessionMeta(file, 1024 * 1024).title, '/usage-credits');
});

for (const [name, prompt] of [
  ['typed prompt', { ...userPrompt('human task', 2), uuid: 'human' }],
  ['unanswered unknown command', localCommand('/unknown-command', '', 2, 'command', {})[1]],
] as const) {
  test(`a peer prompt and its model reply retain admission for a pending ${name}`, () => {
    const file = writeTranscript([prompt]);
    const before = scanForHumanPrompt(file, fs.statSync(file).size);
    assert.equal(before.found, false);
    assert.equal(promptScanLists(before), true);
    assert.deepEqual(readSessionTurnStarts(file).starts, [ms(2)]);
    const peer = { ...userPrompt('peer wake', 3), uuid: 'peer', origin: { kind: 'peer' } };
    fs.appendFileSync(file, JSON.stringify(peer) + '\n');
    const afterPeer = scanForHumanPrompt(file, fs.statSync(file).size, before);
    assert.equal(promptScanLists(afterPeer), true);
    fs.appendFileSync(file, JSON.stringify(assistantAnswer('peer reply', 4)) + '\n');
    assert.equal(holdsHumanPrompt(fs.readFileSync(file, 'utf8')), true);
    const afterReply = scanForHumanPrompt(file, fs.statSync(file).size, afterPeer);
    assert.equal(afterReply.found, true);
    assert.equal(promptScanLists(afterReply), true);
    assert.equal(promptScanLists(scanForHumanPrompt(file, fs.statSync(file).size)), true);
    assert.deepEqual(readSessionTurnStarts(file).starts, [ms(2), ms(3)]);
  });
}

test('a peer prompt and its model reply do not restore withdrawn command admission', () => {
  const records = localCommand('/usage-credits', '', 2, 'command', { stdout: 'Login interrupted', user: true });
  const file = writeTranscript(records);
  const before = scanForHumanPrompt(file, fs.statSync(file).size);
  const peer = { ...userPrompt('peer wake', 3), uuid: 'peer', origin: { kind: 'peer' } };
  const reply = assistantAnswer('peer reply', 4);
  fs.appendFileSync(file, [peer, reply].map((record) => JSON.stringify(record)).join('\n') + '\n');
  assert.equal(holdsHumanPrompt(fs.readFileSync(file, 'utf8')), false);
  const after = scanForHumanPrompt(file, fs.statSync(file).size, before);
  assert.equal(after.found, false);
  assert.equal(promptScanLists(after), false);
  assert.deepEqual(readSessionTurnStarts(file).starts, [ms(3)]);
});

test('whole-file fallback naming reaches a first prompt record beyond the command evidence window', () => {
  const file = writeTranscript([
    {
      ...userPrompt('screenshot task', 2),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'screenshot task' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(150 * 1024) } },
        ],
      },
    },
  ]);
  assert.equal(readSessionMeta(file).title, 'screenshot task');
  const records = localCommand('/usage-credits', '', 2, 'command', { stdout: 'Login interrupted', user: true });
  const later = writeTranscript([
    ...records,
    { type: 'bookkeeping', padding: 'x'.repeat(150 * 1024) },
    userPrompt('later task', 3),
  ]);
  assert.equal(readSessionMeta(later).title, 'later task');
  assert.equal(readSessionMeta(later).withdrawnPrompt, true);
});
const renameRecords = (): object[] => [
  userPrompt('first question', 0),
  assistantAnswer('first answer', 1),
  ...localCommand('/rename', 'claude entrypoint auto handback', 2, 'rename-1', { stdout: RENAMED }),
];
// Evaluate one minute after the command, within the quiet window for an unfinished turn.

const AFTER_COMMAND = ms(2) + 60_000;

// What each reader of the newest turn's outcome says about it at one clock. `childTranscript`
// marks every record as a sidechain record and reads the file as a subagent's own transcript.
// `tailBytes` narrows the session metadata read to that many bytes from the end.
function localAnswerStatuses(
  input: object[],
  now = AFTER_COMMAND,
  sessionSnapshots = false,
  { childTranscript = false, tailBytes = 256 * 1024 }: { childTranscript?: boolean; tailBytes?: number } = {},
) {
  const records = childTranscript ? input.map((record) => ({ ...record, isSidechain: true })) : input;
  const file = writeTranscript(records);
  const turns = readSession(file, 'sess', { childTranscript }).turns;
  const rail = readSessionMeta(file, tailBytes, '', childTranscript).outcome;
  const indexed = createClaudeUsageLineReducer(undefined, { childTranscript });
  for (const record of records) {
    indexed.pushLine(JSON.stringify(record));
  }
  const newest = indexed.newestTurnOutcome();
  // An index saved and restored between any two records reads the same newest turn and count.
  for (let split = 1; split < records.length; split++) {
    const first = createClaudeUsageLineReducer(undefined, { childTranscript });
    for (const record of records.slice(0, split)) {
      first.pushLine(JSON.stringify(record));
    }
    const resumed = createClaudeUsageLineReducer(JSON.parse(JSON.stringify(first.snapshot())), { childTranscript });
    for (const record of records.slice(split)) {
      resumed.pushLine(JSON.stringify(record));
    }
    assert.deepEqual(
      [resumed.turnCount(), resumed.newestTurnOutcome()],
      [indexed.turnCount(), newest],
      `an index restored after record ${split} reads the turns differently`,
    );
    if (sessionSnapshots) {
      const session = createClaudeSessionReducer('sess', { childTranscript });
      records.slice(0, split).forEach((record) => session.pushLine(JSON.stringify(record)));
      const restored = createClaudeSessionReducer('sess', { childTranscript }, structuredClone(session.snapshot()));
      records.slice(split).forEach((record) => restored.pushLine(JSON.stringify(record)));
      assert.deepEqual(
        restored.read().turns,
        turns,
        `a session restored after record ${split} reads the turns differently`,
      );
    }
  }
  return {
    turns,
    full: turns.length > 0 ? statusOf(turns[turns.length - 1], true, now) : null,
    rail: rail ? statusOf(rail, true, now) : null,
    index: newest ? statusOf(newest, true, now) : null,
    count: indexed.turnCount(),
    // Start times from the full read, session metadata, and usage index.
    starts: [turns[turns.length - 1]?.startedAt ?? null, rail?.startedAt ?? null, newest?.startedAt ?? null],
    railOutcome: rail,
    indexOutcome: newest,
  };
}

function manualCompactRecords(reverse = false): object[] {
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'compact-boundary',
    timestamp: at(14),
    compactMetadata: {
      trigger: 'manual',
      preTokens: 62077,
      postTokens: 4336,
      cumulativeDroppedTokens: 57741,
      durationMs: 12409,
    },
  };
  const summary = {
    ...userPrompt('This session is being continued from a previous conversation.\n\nSummary:\nKept context.', 13.988),
    isCompactSummary: true,
    parentUuid: 'compact-boundary',
    uuid: 'compact-summary',
  };
  const [caveat, wrapped] = localCommand('/compact', '', 2.003, 'compact-wrapped', { stdout: 'Compacted' });
  // The caveat names the last record before the boundary, and the wrapped command names the
  // caveat. A link from the wrapped command back past the boundary would revoke the compaction.
  return [
    userPrompt('/compact', 2, { uuid: 'compact-opening' }),
    ...(reverse ? [summary, boundary] : [boundary, summary]),
    { ...caveat, uuid: 'compact-caveat', parentUuid: 'compact-opening' },
    { ...wrapped, parentUuid: 'compact-caveat' },
    userPrompt('<local-command-stdout>Compacted</local-command-stdout>', 14.099, { parentUuid: 'compact-wrapped' }),
  ];
}

test('completed manual CLI compaction removes the running command card in every reader', () => {
  const prior = [
    userPrompt('test', 0),
    assistantText('Test received.', 1, { input_tokens: 100, output_tokens: 5 }, undefined, 'end_turn'),
  ];
  for (const reverse of [false, true]) {
    const records = [...prior, ...manualCompactRecords(reverse)];
    const file = writeTranscript(records);
    const read = localAnswerStatuses(records);
    assert.deepEqual(
      read.turns.map((turn) => turn.prompt),
      ['test'],
    );
    assert.deepEqual([read.full, read.rail, read.index, read.count], ['done', 'done', 'done', 1]);
    assert.deepEqual(read.starts, [ms(0), ms(0), ms(0)]);
    assert.deepEqual(readSessionTurnStarts(file).starts, [ms(0)]);
    const full = readSession(file, 'sess');
    const compact = full.compactions[0];
    assert.deepEqual(
      [compact.trigger, compact.contextBefore, compact.contextAfter, compact.droppedTokens, compact.durationMs],
      ['manual', 62077, 4336, 57741, 12409],
    );
    assert.equal(full.turns[0].usage.input, 100);
    assert.equal(full.turns[0].usage.output, 5);
    const index = createClaudeUsageLineReducer();
    const events = records.flatMap((record) => index.pushLine(JSON.stringify(record)));
    assert.equal(index.compactionCount(), 1);
    assert.equal(events.filter((event) => event.compactionEstimate).length, 1);
    assert.equal(index.snapshot().visibleTurns, 2);
    for (let split = 1; split < records.length; split++) {
      const first = createClaudeSessionReducer('sess');
      records.slice(0, split).forEach((record) => first.pushLine(JSON.stringify(record)));
      const resumed = createClaudeSessionReducer('sess', {}, structuredClone(first.snapshot()));
      records.slice(split).forEach((record) => resumed.pushLine(JSON.stringify(record)));
      assert.deepEqual(resumed.read().turns, full.turns);
      assert.deepEqual(
        resumed.read().compactions,
        full.compactions.map(({ firstRequestCachedTokens: _read, ...compaction }) => compaction),
      );
    }
    const appended = [
      ...records,
      userPrompt('next task', 70),
      assistantText('Next answer.', 71, { input_tokens: 200, output_tokens: 6 }, undefined, 'end_turn'),
    ];
    const after = localAnswerStatuses(appended, ms(72));
    assert.deepEqual(
      after.turns.map((turn) => turn.prompt),
      ['test', 'next task'],
    );
    assert.equal(after.count, 2);
    const appendedIndex = createClaudeUsageLineReducer();
    const appendedEvents = appended.flatMap((record) => appendedIndex.pushLine(JSON.stringify(record)));
    assert.deepEqual(
      appendedEvents.filter((event) => !event.compactionEstimate).map((event) => event.visibleTurnId),
      ['claude-turn:1', 'claude-turn:3'],
    );
  }
});

test('completed manual CLI compaction without a preceding turn leaves no outcome', () => {
  const records = manualCompactRecords();
  const pending = localAnswerStatuses(records.slice(0, 1));
  assert.deepEqual([pending.full, pending.rail, pending.index, pending.count], ['running', 'running', 'running', 1]);
  const completed = localAnswerStatuses(records);
  assert.deepEqual([completed.full, completed.rail, completed.index, completed.count], [null, null, null, 0]);
  assert.deepEqual(readSessionTurnStarts(writeTranscript(records)).starts, []);
  const rename = localAnswerStatuses([
    ...records,
    ...localCommand('/rename', 'kept name', 16, 'rename-after', { stdout: 'Renamed' }),
  ]);
  assert.deepEqual([rename.full, rename.rail, rename.index, rename.count], [null, null, null, 0]);
});

test('manual compaction preserves real work before and after the command', () => {
  const records = manualCompactRecords();
  for (const after of [
    assistantTool('Read', 15),
    assistantText('Continuing work.', 15, { output_tokens: 4 }),
    assistantAnswer('Continued work.', 15),
  ]) {
    const expected = 'stop_reason' in after.message && after.message.stop_reason ? 'done' : 'running';
    const read = localAnswerStatuses([...records, after], AFTER_COMMAND, true);
    assert.deepEqual(
      read.turns.map((turn) => turn.prompt),
      ['/compact'],
    );
    assert.equal(read.count, 1);
    assert.deepEqual([read.full, read.rail, read.index], [expected, expected, expected]);
    assert.deepEqual(readSessionTurnStarts(writeTranscript([...records, after])).starts, [ms(2)]);
    const closed = [...records, after, assistantAnswer('Finished.', 16)];
    const done = localAnswerStatuses(closed, AFTER_COMMAND, true);
    assert.deepEqual([done.full, done.rail, done.index, done.count], ['done', 'done', 'done', 1]);
    const later = localAnswerStatuses([...closed, assistantTool('Read', 17, 'later')], AFTER_COMMAND, true);
    assert.deepEqual([later.full, later.rail, later.index], ['done', 'done', 'done']);
  }
  const prior = localAnswerStatuses([userPrompt('unfinished work', 0), ...records]);
  assert.deepEqual(
    prior.turns.map((turn) => turn.prompt),
    ['unfinished work'],
  );
  assert.deepEqual([prior.full, prior.rail, prior.index], ['running', 'running', 'running']);
  const resumedPrior = localAnswerStatuses([userPrompt('unfinished work', 0), ...records, userPrompt('next work', 16)]);
  assert.equal(resumedPrior.turns.length, resumedPrior.count);
  const queuedPrior = localAnswerStatuses([
    userPrompt('unfinished work', 0),
    typedMidTurn('queued before compact', 1),
    ...records,
  ]);
  assert.deepEqual(
    queuedPrior.turns.map((turn) => turn.prompt),
    ['unfinished work'],
  );
  assert.equal(queuedPrior.turns[0].laterPrompts[0].text, 'queued before compact');
  assert.deepEqual([queuedPrior.full, queuedPrior.rail, queuedPrior.index], ['running', 'running', 'running']);
  const next = localAnswerStatuses([...records, userPrompt('new work', 16)]);
  assert.deepEqual(
    next.turns.map((turn) => turn.prompt),
    ['new work'],
  );
  assert.deepEqual([next.full, next.rail, next.index], ['running', 'running', 'running']);
});

test('prompts queued after completed manual compaction retain their unread turn start', () => {
  for (const prior of [[], [userPrompt('prior', 0), assistantAnswer('Finished.', 1)]]) {
    const compact = [...prior, ...manualCompactRecords()];
    const queue = [typedMidTurn('next task', 15), typedMidTurn('another task', 16)];
    for (let length = 1; length <= queue.length; length++) {
      const records = [...compact, ...queue.slice(0, length)];
      const read = localAnswerStatuses(records, AFTER_COMMAND, true);
      assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
      assert.equal(read.turns.length, prior.length ? 2 : 1);
      assert.equal(read.count, read.turns.length);
      assert.deepEqual(read.starts, [ms(15), ms(15), ms(15)]);
      const starts = readSessionTurnStarts(writeTranscript(records));
      assert.deepEqual(starts.starts, prior.length ? [ms(0), ms(15)] : [ms(15)]);
      const windows = new Map([['sess', starts]]);
      assert.deepEqual(newCounts([], windows, [], new Map([['sess', ms(1)]])).get('sess'), {
        count: 1,
        atLeast: false,
      });
      assert.equal(newestTurnStarts([], windows).get('sess'), ms(15));
      for (const work of [assistantTool('Read', 17), assistantAnswer('Finished queued tasks.', 17)]) {
        const restored = [...records, work];
        const after = localAnswerStatuses(restored, AFTER_COMMAND, true);
        const status = 'stop_reason' in work.message && work.message.stop_reason ? 'done' : 'running';
        assert.deepEqual([after.full, after.rail, after.index], [status, status, status]);
        assert.equal(after.count, after.turns.length);
        assert.deepEqual(after.starts, [ms(2), ms(2), ms(2)]);
        assert.deepEqual(
          readSessionTurnStarts(writeTranscript(restored)).starts,
          prior.length ? [ms(0), ms(2)] : [ms(2)],
        );
      }
    }
  }
});

test('manual compaction retains queued work when carried prompts reach the retention limit', () => {
  const [opening, ...completed] = manualCompactRecords();
  const records = [
    userPrompt('unanswered prior', 0),
    ...Array.from({ length: TURN_ASK_LIMIT }, (_, index) => typedMidTurn(`queued ${index + 1}`, 1 + index / 100)),
    opening,
    typedMidTurn('queued after opening', 3),
    ...completed,
  ];
  for (const answer of [[], [assistantAnswer('Answer to prior and queued work.', 15)]]) {
    const all = [...records, ...answer];
    const read = localAnswerStatuses(all, AFTER_COMMAND, true);
    const status = answer.length ? 'done' : 'running';
    assert.deepEqual([read.full, read.rail, read.index, read.count], [status, status, status, 1]);
    assert.equal(read.turns.length, 1);
    assert.equal(read.turns[0].prompt, 'unanswered prior\n\n/compact');
    assert.equal(read.turns[0].laterPrompts.length, TURN_ASK_LIMIT);
    assert.equal(read.turns[0].laterPrompts.at(-1)?.text, 'queued after opening');
    assert.equal(read.turns[0].summary, answer.length ? 'Answer to prior and queued work.' : '');
    assert.deepEqual(read.starts, [ms(2), ms(2), ms(2)]);
    assert.deepEqual(readSessionTurnStarts(writeTranscript(all)).starts, [ms(0), ms(2)]);
  }
});

test('manual compaction consumes no unrelated automatic malformed or sidechain work', () => {
  const [opening, boundary, ...rest] = manualCompactRecords();
  for (const change of [
    { compactMetadata: { trigger: 'auto', preTokens: 62077, postTokens: 4336 } },
    { compactMetadata: { preTokens: 62077, postTokens: 4336 } },
    { compactMetadata: { trigger: 'manual', preTokens: '62077', postTokens: 4336 } },
    { compactMetadata: { trigger: 'manual', preTokens: 62077, postTokens: -1 } },
    { isSidechain: true },
    { timestamp: 'invalid' },
  ]) {
    const read = localAnswerStatuses([opening, { ...boundary, ...change }, ...rest]);
    assert.deepEqual([read.full, read.rail, read.index, read.count], ['running', 'running', 'running', 1]);
  }
  for (const prompt of ['please /compact', '/compact instructions', '/unknown']) {
    const read = localAnswerStatuses([userPrompt(prompt, 2, { uuid: 'compact-opening' }), boundary, ...rest]);
    assert.deepEqual(
      read.turns.map((turn) => turn.prompt),
      [prompt],
    );
    assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
  }
  for (const work of [assistantTool('Read', 3), typedMidTurn('queued work', 3), userPrompt('later real prompt', 3)]) {
    const read = localAnswerStatuses([opening, work, boundary, ...rest]);
    assert.equal(read.full, 'running');
    assert.equal(read.rail, 'running');
    assert.equal(read.index, 'running');
    assert.ok(
      readSessionTurnStarts(writeTranscript([opening, work, boundary, ...rest])).starts.includes(ms(3)) ||
        readSessionTurnStarts(writeTranscript([opening, work, boundary, ...rest])).starts.includes(ms(2)),
    );
  }
  const child = manualCompactRecords().map((record, index) =>
    index === 0 ? { ...record, isSidechain: true } : record,
  );
  const childFile = writeTranscript(child);
  assert.equal(readSession(childFile, 'sess', { childTranscript: true }).turns.length, 1);
  const childIndex = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  child.forEach((record) => childIndex.pushLine(JSON.stringify(record)));
  assert.equal(childIndex.turnCount(), 1);
});

test('manual compaction retains preceding outcomes and independent background activity', () => {
  const records = manualCompactRecords();
  for (const prior of [
    [userPrompt('prior work', 0), assistantAnswer('Finished.', 1)],
    [userPrompt('prior work', 0), assistantTool('Read', 1)],
    [userPrompt('prior work', 0), costState(ms(0), 1000)],
    [userPrompt('prior work', 0), { ...assistantAnswer('API failed.', 1), isApiErrorMessage: true }],
    [userPrompt('prior work', 0), userPrompt('[Request interrupted by user]', 1)],
  ]) {
    const before = localAnswerStatuses(prior);
    const after = localAnswerStatuses([...prior, ...records]);
    assert.deepEqual([after.full, after.rail, after.index], [before.full, before.rail, before.index]);
    assert.deepEqual(after.railOutcome, before.railOutcome);
    assert.deepEqual(after.indexOutcome, before.indexOutcome);
  }
  const launch = [
    userPrompt('launch background work', 0),
    assistantTool('Agent', 0.2, 'compact-child-call', { description: 'worker' }),
    {
      type: 'user',
      timestamp: at(0.4),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'compact-child-call', content: 'launched' }],
      },
      toolUseResult: { agentId: 'compact-child', status: 'async_launched' },
    },
    assistantAnswer('Background work started.', 1),
  ];
  const child = localAnswerStatuses([...launch, ...records]);
  assert.deepEqual(child.railOutcome?.openChildren, ['compact-child']);
  assert.deepEqual(child.indexOutcome?.openChildren, ['compact-child']);
  assert.equal(child.turns[0].agents[0].id, 'compact-child');
  const commandRecords = [
    ...backgroundCommandTurn,
    ...records.map((record) => ({ ...record, timestamp: at(5 + records.indexOf(record)) })),
  ];
  const before = readSessionMeta(writeTranscript(backgroundCommandTurn)).outcome?.backgroundCommands;
  const after = readSessionMeta(writeTranscript(commandRecords)).outcome?.backgroundCommands;
  assert.deepEqual(after, before);
  assert.equal(after?.length, 1);
  const automatic = localAnswerStatuses([
    userPrompt('real work', 0),
    assistantTool('Read', 1),
    { ...records[1], compactMetadata: { trigger: 'auto', preTokens: 62077, postTokens: 4336 } },
    records[2],
  ]);
  assert.deepEqual([automatic.full, automatic.rail, automatic.index], ['running', 'running', 'running']);
});

test('a Claude local command answer makes no turn in the full read', () => {
  const file = writeTranscript(renameRecords());
  const turns = readSession(file, 'sess').turns;
  assert.deepEqual(
    turns.map((turn) => turn.prompt),
    ['first question'],
    'the command drew a card of its own',
  );
  assert.equal(statusOf(turns[0], true, AFTER_COMMAND), 'done');

  fs.appendFileSync(file, JSON.stringify(userPrompt('the next prompt', 70)) + '\n');
  assert.deepEqual(
    readSession(file, 'sess').turns.map((turn) => turn.prompt),
    ['first question', 'the next prompt'],
    'the command text carried onto the next card',
  );
});

test('a Claude local command answer leaves the rail outcome on the turn before it', () => {
  const before = readSessionMeta(
    writeTranscript([userPrompt('first question', 0), assistantAnswer('first answer', 1)]),
  ).outcome;
  const outcome = readSessionMeta(writeTranscript(renameRecords())).outcome;
  assert.ok(before);
  assert.deepEqual(outcome, before, 'the rail outcome is the command, not the turn before it');
  assert.equal(statusOf(outcome!, true, AFTER_COMMAND), 'done');

  const alone = localCommand('/rename', 'claude entrypoint auto handback', 2, 'rename-1', { stdout: RENAMED });
  assert.equal(
    readSessionMeta(writeTranscript(alone)).outcome,
    null,
    'a command with no turn before it has an outcome',
  );
});

test('a Claude local command answer makes no indexed turn across a resume', () => {
  const lines = renameRecords().map((record) => JSON.stringify(record));
  const indexed = createClaudeUsageLineReducer();
  for (const line of lines) {
    indexed.pushLine(line);
  }
  assert.equal(indexed.turnCount(), 1, 'the index counts the command as a turn');
  assert.equal(indexed.newestTurnOutcome()?.startedAt, ms(0), 'the newest indexed outcome is the command');
  assert.equal(statusOf(indexed.newestTurnOutcome()!, true, AFTER_COMMAND), 'done');
  indexed.pushLine(JSON.stringify(userPrompt('the next prompt', 70)));
  assert.equal(indexed.turnCount(), 2, 'the command turn was counted when the next prompt arrived');

  // Checkpoint restoration preserves the earlier turn when a local command answer removes the command's provisional turn.

  const first = createClaudeUsageLineReducer();
  for (const line of lines.slice(0, -1)) {
    first.pushLine(line);
  }
  const resumed = createClaudeUsageLineReducer(first.snapshot());
  resumed.pushLine(lines[lines.length - 1]);
  assert.equal(resumed.turnCount(), 1, 'a restored index counts the command as a turn');
  assert.equal(resumed.newestTurnOutcome()?.startedAt, ms(0), 'a restored index lost the turn before the command');
});

test('a Claude local command answer makes no semantic reader turn and passes the page filter', () => {
  const lines = renameRecords().map((record) => JSON.stringify(record));
  assert.equal(claudeSessionLineMayAffectRead(lines[lines.length - 1]), true, 'the page filter drops the answer');
  const semantic = createClaudeSessionReducer('sess');
  for (const line of lines) {
    semantic.pushLine(line);
  }
  assert.equal(semantic.openRange(), null, 'the command turn is still open');
  assert.deepEqual(
    semantic.completedTurns().map((completed) => completed.turn.prompt),
    ['first question'],
    'the command is a completed turn',
  );
});

test('a Claude local command answer followed by a synthetic no-response record makes no turn', () => {
  const synthetic = {
    type: 'assistant',
    timestamp: at(3),
    message: {
      role: 'assistant',
      id: 'synthetic-1',
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'No response requested.' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  const read = localAnswerStatuses([...renameRecords(), synthetic]);
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
  assert.deepEqual([read.turns.length, read.count], [1, 1], 'the command became a turn');
});

test('a Claude local command error answer makes no turn', () => {
  const read = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    ...localCommand('/rename', '', 2, 'rename-1', { stderr: 'Please provide a name' }),
  ]);
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
  assert.deepEqual([read.turns.length, read.count], [1, 1], 'the failed command became a turn');
});

test('two Claude local commands in a row make no turn, the first with an empty answer', () => {
  const records = [
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    ...localCommand('/usage', '', 2, 'usage-1', { stdout: '' }),
    ...localCommand('/rename', 'claude entrypoint auto handback', 3, 'rename-1', { stdout: RENAMED }),
  ];
  const read = localAnswerStatuses(records);
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
  assert.deepEqual([read.turns.length, read.count], [1, 1], 'a command became a turn');
  const next = readSession(writeTranscript([...records, userPrompt('the next prompt', 70)]), 'sess').turns;
  assert.deepEqual(
    next.map((turn) => turn.prompt),
    ['first question', 'the next prompt'],
    'a command text carried onto the next card',
  );
});

test('a Claude local command answer to another record leaves an unanswered prompt running', () => {
  const read = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('an unanswered prompt', 2, { uuid: 'prompt-2' }),
    ...localCommand('/effort', 'high', 2, 'effort-1', { stdout: 'Set effort level to high' }),
  ]);
  assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
  assert.equal(read.turns[1].prompt, 'an unanswered prompt');
});

test('a Claude local command answer leaves an earlier unanswered prompt on a card of its own', () => {
  const records = [
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('an unanswered prompt', 2, { uuid: 'prompt-2' }),
    ...localCommand('/rename', 'claude entrypoint auto handback', 2, 'rename-1', { stdout: RENAMED }),
  ];
  const read = localAnswerStatuses(records);
  // The local command leaves the earlier unanswered prompt as the stopped newest turn.
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(
    [read.turns[1].processEndedAt, read.railOutcome?.processEndedAt, read.indexOutcome?.processEndedAt],
    [ms(2), ms(2), ms(2)],
    'the readers stop the prompt at different times',
  );
  assert.deepEqual(
    read.turns.map((turn) => [turn.prompt, turn.summary]),
    [
      ['first question', 'first answer'],
      ['an unanswered prompt', ''],
    ],
    'the command made a turn or took in the earlier prompt',
  );
  assert.equal(read.count, read.turns.length, 'the index counts the turns differently');

  const next = [...records, userPrompt('the next prompt', 70)];
  const turns = readSession(writeTranscript(next), 'sess').turns;
  assert.deepEqual(
    turns.map((turn) => turn.prompt),
    ['first question', 'an unanswered prompt', 'the next prompt'],
  );
  const indexed = createClaudeUsageLineReducer();
  for (const record of next) {
    indexed.pushLine(JSON.stringify(record));
  }
  assert.equal(indexed.turnCount(), turns.length, 'the index counts the turns differently after the next prompt');
});

test("a Claude local command answer hours after an unanswered prompt keeps the prompt's own duration", () => {
  // The prompt was typed at second 2. The session was resumed 14 hours later for /rename.
  const later = 2 + 14 * 60 * 60;
  const records = [
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('an unanswered prompt', 2, { uuid: 'prompt-2' }),
    ...localCommand('/rename', 'claude entrypoint auto handback', later, 'rename-1', { stdout: RENAMED }),
  ];
  const now = ms(later) + 60_000;
  const read = localAnswerStatuses(records, now);
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(
    [read.turns[1].processEndedAt, read.railOutcome?.processEndedAt, read.indexOutcome?.processEndedAt],
    [ms(2), ms(2), ms(2)],
    'a reader stops the prompt at the answer, so its duration runs to the command',
  );
  const card = read.turns[1];
  assert.equal(
    toCard(card, true, now).duration,
    toCard({ ...card, processEndedAt: undefined }, false, now).duration,
    'the stopped card counts its duration past its own last record',
  );
});

test('model work after a Claude local command answer resumes the prompt that waited across it', () => {
  const records = [
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('an unanswered prompt', 2, { uuid: 'prompt-2' }),
    ...localCommand('/rename', 'claude entrypoint auto handback', 3, 'rename-1', { stdout: RENAMED }),
    assistantText('working on it', 4, { input_tokens: 10, output_tokens: 5 }, undefined, 'tool_use'),
  ];
  const read = localAnswerStatuses(records);
  assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
  assert.deepEqual(read.starts, [ms(2), ms(2), ms(2)], 'a reader takes the command as the newest turn');
  assert.deepEqual([read.turns.length, read.count], [2, 2], 'a reader counts the command as a turn');
  // The model works on the waiting prompt, so the answer does not stop it.
  const prompt = read.turns[read.turns.length - 1];
  assert.equal(prompt.prompt, 'an unanswered prompt');
  assert.equal(prompt.processEndedAt, undefined, 'the answer still stops the prompt the model went on from');
  // A read restored between the answer and the model work removes the stop too.
  const session = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, -1)) {
    session.pushLine(JSON.stringify(record));
  }
  const restored = createClaudeSessionReducer('sess', {}, structuredClone(session.snapshot()));
  restored.pushLine(JSON.stringify(records[records.length - 1]));
  const card = restored.finish().turns.find((turn) => turn.prompt === 'an unanswered prompt');
  assert.ok(card, 'a restored read lost the unanswered prompt card');
  assert.equal(card.processEndedAt, undefined, 'a restored read still stops the prompt the model went on from');
});

test('a Claude local command after a real turn leaves the header turn count and the rail on that turn', () => {
  const before = [userPrompt('first question', 0), assistantAnswer('first answer', 1)];
  const count = (records: object[]) => {
    const indexed = createClaudeUsageLineReducer();
    for (const record of records) {
      indexed.pushLine(JSON.stringify(record));
    }
    return indexed.turnCount();
  };
  const read = localAnswerStatuses(renameRecords());
  assert.deepEqual([read.count, count(before)], [1, 1], 'the header counts the command as a turn');
  assert.equal(read.rail, 'done', 'the rail row does not read done');
  assert.deepEqual(
    readSessionMeta(writeTranscript(renameRecords())).outcome,
    readSessionMeta(writeTranscript(before)).outcome,
    'the rail outcome is not the turn before the command',
  );

  const alone = localCommand('/usage', '', 0, 'usage-1', { stdout: 'Current session' });
  const empty = localAnswerStatuses(alone);
  assert.deepEqual([empty.turns.length, empty.count, empty.rail, empty.index], [0, 0, null, null]);
});

test('a Claude built-in command the CLI answers in a user record draws no turn in any reader', () => {
  const before = [userPrompt('first question', 0), assistantAnswer('first answer', 1)];
  const railBefore = readSessionMeta(writeTranscript(before)).outcome;
  for (const answer of [
    { stdout: 'Failed to reconnect to shotcut.', user: true },
    { stdout: '(no content)', user: true },
    { stderr: 'Unknown command', user: true },
    { stdout: 'MCP dialog dismissed' },
  ]) {
    const records = [...before, ...localCommand('/mcp', '', 2, 'mcp-1', answer)];
    const label = JSON.stringify(answer);
    const read = localAnswerStatuses(records, AFTER_COMMAND, true);
    assert.deepEqual(
      [read.turns.map((turn) => turn.prompt), read.count],
      [['first question'], 1],
      `the timeline or the header counts /mcp as a turn for ${label}`,
    );
    assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done'], label);
    assert.deepEqual(readSessionMeta(writeTranscript(records)).outcome, railBefore, label);
    assert.deepEqual(
      readSessionTurnStarts(writeTranscript(records)).starts,
      [ms(0)],
      `the rail's unread count counts /mcp as a turn for ${label}`,
    );
  }
});

test('a prompt queued before the CLI answers a Claude built-in command is the newest turn in every reader', () => {
  for (const shape of [{ user: true }, {}]) {
    const [caveat, command, answer] = localCommand('/mcp', '', 2, 'mcp-1', {
      stdout: 'MCP dialog dismissed',
      ...shape,
    });
    const records = [
      userPrompt('first question', 0),
      assistantAnswer('first answer', 1),
      caveat,
      command,
      typedMidTurn('a queued follow-up', 3),
      { ...answer, timestamp: at(4) },
    ];
    const label = JSON.stringify(shape);
    const read = localAnswerStatuses(records, AFTER_COMMAND, true);
    assert.deepEqual(
      read.turns.map((turn) => turn.prompt),
      ['first question', 'a queued follow-up'],
      label,
    );
    assert.equal(read.count, read.turns.length, `the header counts the turns differently for ${label}`);
    assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)], `the readers disagree on the newest turn for ${label}`);
    assert.deepEqual([read.rail, read.index], [read.full, read.full], label);
    assert.deepEqual(
      readSessionTurnStarts(writeTranscript(records)).starts,
      [ms(0), ms(3)],
      `the rail's unread count disagrees with the timeline for ${label}`,
    );
  }
});

test('model work after a Claude built-in command answered in a user record joins the turn before it', () => {
  const records = [
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    ...localCommand('/mcp', '', 2, 'mcp-1', { stdout: 'Reconnected to shotcut.', user: true }),
    assistantAnswer('The server is back.', 3),
  ];
  const read = localAnswerStatuses(records, AFTER_COMMAND, true);
  assert.deepEqual([read.turns.length, read.count], [1, 1], 'the readers made the command a turn');
  assert.deepEqual(read.starts, [ms(0), ms(0), ms(0)]);
  assert.deepEqual(readSessionTurnStarts(writeTranscript(records)).starts, [ms(0)]);
});

test('a Claude prompt that quotes a local command output element stays a prompt', () => {
  const [, command] = localCommand('/mcp', '', 2, 'mcp-1', { stdout: '', user: true });
  const quote = userPrompt('why did <local-command-stdout>Failed</local-command-stdout> happen', 3, {
    uuid: 'quote-1',
    parentUuid: 'mcp-1',
  });
  const records = [userPrompt('first question', 0), assistantAnswer('first answer', 1), command, quote];
  const read = localAnswerStatuses(records, AFTER_COMMAND, true);
  assert.deepEqual([read.turns.length, read.count], [2, 2], 'a quoting prompt withdrew the command before it');
  assert.match(read.turns[1].prompt, /why did/);
  assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)]);
  assert.deepEqual(readSessionTurnStarts(writeTranscript(records)).starts, [ms(0), ms(2), ms(3)]);
});

test('a Claude local command answer after a process end leaves every reader stopped', () => {
  const [caveat, command, answer] = localCommand('/rename', 'claude entrypoint auto handback', 2, 'rename-1', {
    stdout: RENAMED,
  });
  const read = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    caveat,
    command,
    costState(ms(0), 2_000),
    answer,
  ]);
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
  assert.equal(read.turns[1].summary, '');
});

test('a Claude local command answer after a model reply leaves the reply in charge', () => {
  const [caveat, command, answer] = localCommand('/rename', 'claude entrypoint auto handback', 2, 'rename-1', {
    stdout: RENAMED,
  });
  const reply = assistantText('working on it', 3, { input_tokens: 10, output_tokens: 5 }, undefined, 'tool_use');
  const without = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    caveat,
    command,
    reply,
  ]);
  const read = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    caveat,
    command,
    reply,
    { ...(answer as Record<string, unknown>), timestamp: at(4) },
  ]);
  assert.deepEqual([without.full, without.rail, without.index], ['running', 'running', 'running']);
  assert.deepEqual(
    [read.full, read.rail, read.index],
    ['running', 'running', 'running'],
    'the answer finished a turn the model answered',
  );
  assert.deepEqual(
    [read.turns[1].summary, read.turns[1].endedAt, read.turns[1].finished],
    [without.turns[1].summary, without.turns[1].endedAt, without.turns[1].finished],
    'the answer replaced the reply on the card',
  );
});

test('a hand-back reply after a Claude local command answer joins the turn before it in every reader', () => {
  const usage = localCommand('/usage', '', 3, 'usage-1', { stdout: 'Current session: 4% used' });
  const handback = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    ...usage,
    peerHandback('a1b2c3d4e5f6a7b8c', 4),
    assistantAnswer('The subagent finished its review.', 5),
  ]);
  assert.deepEqual(
    [handback.turns.length, handback.count],
    [1, 1],
    'the timeline or the header counts the command as a turn',
  );
  assert.deepEqual(handback.starts, [ms(0), ms(0), ms(0)], 'the readers disagree on the newest turn');
  assert.deepEqual([handback.full, handback.rail, handback.index], ['done', 'done', 'done']);
  assert.equal(handback.turns[0].summary, 'The subagent finished its review.');
});

test('a reply to a prompt that waited across a Claude local command answers that prompt in every reader', () => {
  const usage = localCommand('/usage', '', 3, 'usage-1', { stdout: 'Current session: 4% used' });
  const waiting = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('a waiting prompt', 2, { uuid: 'prompt-2' }),
    ...usage,
    assistantAnswer('The waiting prompt is answered.', 5),
  ]);
  assert.deepEqual(
    [waiting.turns.length, waiting.count],
    [2, 2],
    'the timeline or the header counts the command as a turn',
  );
  assert.equal(waiting.turns[1].prompt, 'a waiting prompt');
  assert.equal(waiting.turns[1].summary, 'The waiting prompt is answered.');
  assert.deepEqual(waiting.starts, [ms(2), ms(2), ms(2)], 'the readers disagree on the newest turn');
  assert.deepEqual([waiting.full, waiting.rail, waiting.index], ['done', 'done', 'done']);
});

test('model work after two Claude local commands in a row joins the turn before them in every reader', () => {
  const answered = [
    userPrompt('first question', 0),
    assistantText('first answer', 1, { input_tokens: 10, output_tokens: 5 }, undefined, 'end_turn'),
  ];
  const commands = [
    ...localCommand('/usage', '', 3, 'usage-1', { stdout: 'Current session: 4% used' }),
    ...localCommand('/cost', '', 4, 'cost-1', { stdout: 'Total cost: $0.10' }),
  ];
  const renamed = [
    ...localCommand('/rename', 'claude entrypoint auto handback', 3, 'rename-1', { stdout: RENAMED }),
    ...localCommand('/cost', '', 4, 'cost-1', { stdout: 'Total cost: $0.10' }),
  ];
  const waiting = [userPrompt('waiting', 2, { uuid: 'prompt-2' })];
  for (const [stop, status] of [
    ['end_turn', 'done'],
    ['tool_use', 'running'],
  ]) {
    const reply = assistantText('the reply', 5, { input_tokens: 10, output_tokens: 7 }, undefined, stop);
    const now = ms(5) + 60_000;
    for (const [label, middle, cards] of [
      // Each card as its prompt and its output tokens. The reply carries 7 of them.
      ['an answered turn', commands, [['first question', 12]]],
      ['an answered turn and /rename', renamed, [['first question', 12]]],
      [
        'a waiting prompt',
        [...waiting, ...commands],
        [
          ['first question', 5],
          ['waiting', 7],
        ],
      ],
    ] as const) {
      const read = localAnswerStatuses([...answered, ...middle, reply], now, true);
      const where = `after ${label} with a ${stop} reply`;
      assert.deepEqual(
        read.turns.map((turn) => [turn.prompt, turn.usage.output]),
        cards,
        `the reply lands on the wrong card ${where}`,
      );
      assert.equal(read.count, cards.length, `the header count is wrong ${where}`);
      const start = cards.length === 1 ? ms(0) : ms(2);
      assert.deepEqual(read.starts, [start, start, start], `the readers disagree on the newest turn ${where}`);
      assert.deepEqual([read.full, read.rail, read.index], [status, status, status], `a reader keeps a stop ${where}`);
      assert.equal(read.turns.at(-1)?.processEndedAt, undefined, `the full read keeps the inferred stop ${where}`);
      const file = writeTranscript([...answered, ...middle, reply]);
      assert.deepEqual(
        readSessionTurnStarts(file).starts,
        cards.length === 1 ? [ms(0)] : [ms(0), ms(2)],
        `turn starts keep a command ${where}`,
      );
    }
  }
});

test('a hand-back reply after a Claude /rename never makes the command a prompt', () => {
  const answered = [
    userPrompt('first question', 0),
    assistantText('first answer', 1, { input_tokens: 10, output_tokens: 5 }, undefined, 'end_turn'),
    { type: 'system', subtype: 'stop_hook_summary', timestamp: at(1.5) },
  ];
  const rename = localCommand('/rename', 'broken caching', 3, 'rename-1', {
    stdout: 'Session renamed to: broken caching',
  });
  const wake = [peerHandback('a1b2c3d4e5f6a7b8c', 5), assistantAnswer('The subagent finished its review.', 6)];
  const records = [...answered, ...rename, ...wake];
  const read = localAnswerStatuses(records, ms(6) + 60_000, true);
  assert.deepEqual([read.turns.map((turn) => turn.prompt), read.count], [['first question'], 1]);
  assert.equal(read.turns[0].summary, 'The subagent finished its review.');
  assert.deepEqual(read.starts, [ms(0), ms(0), ms(0)]);
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
  const file = writeTranscript(records);
  assert.deepEqual(readSessionTurnStarts(file).starts, [ms(0)]);
  assert.equal(promptScanLists(scanForHumanPrompt(file, fs.statSync(file).size)), true);
  assert.equal(readSessionMeta(file).title, 'first question');
  // With no turn before the command, the reply belongs to no turn and the session has no fallback name.
  const alone = writeTranscript([...rename, ...wake]);
  const empty = localAnswerStatuses([...rename, ...wake], ms(6) + 60_000, true);
  assert.deepEqual([empty.turns.length, empty.count], [0, 0]);
  assert.deepEqual(readSessionTurnStarts(alone).starts, []);
  assert.equal(promptScanLists(scanForHumanPrompt(alone, fs.statSync(alone).size)), false);
  assert.equal(readSessionMeta(alone).title, null);
});

test('a hand-back reply after a manual compaction still makes /compact a turn', () => {
  const records = [
    ...manualCompactRecords(),
    peerHandback('a1b2c3d4e5f6a7b8c', 15),
    assistantAnswer('The subagent finished its review.', 16),
  ];
  const read = localAnswerStatuses(records, AFTER_COMMAND, true);
  assert.deepEqual([read.turns.map((turn) => turn.prompt), read.count], [['/compact'], 1]);
  assert.deepEqual(read.starts, [ms(2), ms(2), ms(2)]);
  assert.deepEqual(readSessionTurnStarts(writeTranscript(records)).starts, [ms(2)]);
});

test('a process end after a Claude local command answer stops the turn before it in every reader', () => {
  const read = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('a waiting prompt', 2, { uuid: 'prompt-2' }),
    ...localCommand('/rename', 'claude entrypoint auto handback', 3, 'rename-1', { stdout: RENAMED }),
    costState(ms(0), 4_000),
  ]);
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
  assert.deepEqual([read.turns.length, read.count], [2, 2]);
  assert.deepEqual(read.starts, [ms(2), ms(2), ms(2)]);
});

test('a Claude local command answer hands background children back to the turn before it', () => {
  const launch = [
    userPrompt('launch in background', 0),
    assistantTool('Agent', 1, 'background-call', { description: 'worker', subagent_type: 'general-purpose' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'background-call', content: 'launched' }],
      },
      toolUseResult: { agentId: 'background-agent', description: 'worker', status: 'async_launched' },
    },
    assistantAnswer('It is running in the background.', 3),
  ];
  const open = localAnswerStatuses([
    ...launch,
    ...localCommand('/rename', 'claude entrypoint auto handback', 4, 'rename-1', { stdout: RENAMED }),
  ]);
  assert.deepEqual(open.starts, [ms(0), ms(0), ms(0)]);
  assert.deepEqual(open.indexOutcome?.openChildren, ['background-agent'], 'the index lost the open child');
  assert.deepEqual(open.indexOutcome?.openChildren, open.railOutcome?.openChildren, 'the index and the rail disagree');

  const [caveat, command, answer] = localCommand('/rename', 'claude entrypoint auto handback', 4, 'rename-1', {
    stdout: RENAMED,
  });
  const closed = localAnswerStatuses([
    ...launch,
    caveat,
    command,
    completionNotice('background-agent', 5),
    { ...(answer as Record<string, unknown>), timestamp: at(6) },
  ]);
  assert.deepEqual(closed.starts, [ms(0), ms(0), ms(0)]);
  assert.equal(closed.indexOutcome?.openChildren, undefined, 'the index kept a closed child open');
  assert.deepEqual(
    closed.indexOutcome?.closedChildren?.map((child) => (typeof child === 'string' ? child : child.id)),
    ['background-agent'],
    'the index lost the closed child',
  );
});

test('a Claude usage index forgets the turn before an answered prompt', () => {
  const indexed = createClaudeUsageLineReducer();
  indexed.pushLine(JSON.stringify(userPrompt('first question', 0)));
  indexed.pushLine(JSON.stringify(assistantAnswer('first answer', 1)));
  indexed.pushLine(JSON.stringify(userPrompt('second question', 2)));
  indexed.pushLine(JSON.stringify(assistantAnswer('second answer', 3)));
  assert.equal(indexed.snapshot().currentTurnPrevious, null, 'the saved index keeps a turn no answer can restore');
});

test('a prompt queued after a Claude local command answer waits on an unanswered card in every reader', () => {
  const records = [...renameRecords(), typedMidTurn('a queued follow-up', 3)];
  const read = localAnswerStatuses(records);
  assert.deepEqual(
    read.turns.map((turn) => [turn.prompt, turn.summary]),
    [
      ['first question', 'first answer'],
      ['a queued follow-up', ''],
    ],
    'the queued prompt is on no card',
  );
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
  assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)], 'the readers disagree on the newest turn');

  // Another local command answer stops the queued prompt, as it stops a typed one.
  const stopped = localAnswerStatuses([
    ...records,
    ...localCommand('/rename', 'second name', 4, 'rename-2', { stdout: 'Session renamed to: second name' }),
  ]);
  assert.deepEqual(
    stopped.turns.map((turn) => turn.prompt),
    ['first question', 'a queued follow-up'],
  );
  assert.equal(stopped.count, stopped.turns.length, 'the header counts the turns differently after the command');
  assert.deepEqual([stopped.full, stopped.rail, stopped.index], ['stopped', 'stopped', 'stopped']);
});

test('a typed prompt takes in a prompt queued after a Claude local command answer once', () => {
  const records = [
    ...renameRecords(),
    typedMidTurn('a queued follow-up', 3),
    userPrompt('the next prompt', 70),
    assistantAnswer('the next answer', 71),
  ];
  const read = localAnswerStatuses(records, ms(71) + 60_000);
  assert.deepEqual(
    read.turns.map((turn) => turn.prompt),
    ['first question', 'a queued follow-up\n\nthe next prompt'],
    'the queued prompt is on a card of its own or on none',
  );
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
});

test('a process end after a prompt queued behind a Claude local command stops that prompt in every reader', () => {
  const read = localAnswerStatuses([
    ...renameRecords(),
    typedMidTurn('a queued follow-up', 3),
    costState(ms(0), 4_000),
  ]);
  assert.deepEqual(
    read.turns.map((turn) => turn.prompt),
    ['first question', 'a queued follow-up'],
  );
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)], 'the readers disagree on the newest turn');
});

test('a typed prompt after a stopped prompt queued behind a Claude local command starts its own card', () => {
  const read = localAnswerStatuses(
    [
      ...renameRecords(),
      typedMidTurn('a queued follow-up', 3),
      costState(ms(0), 4_000),
      userPrompt('the next prompt', 70),
      assistantAnswer('the next answer', 71),
    ],
    ms(71) + 60_000,
  );
  assert.deepEqual(
    read.turns.map((turn) => turn.prompt),
    ['first question', 'a queued follow-up', 'the next prompt'],
    'the typed prompt took in a queued prompt the process end had stopped',
  );
  assert.equal(read.turns[1].processEndedAt, ms(4), 'the queued prompt lost its process end');
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual([read.full, read.rail, read.index], ['done', 'done', 'done']);
  assert.deepEqual(read.starts, [ms(70), ms(70), ms(70)], 'the readers disagree on the newest turn');
});

test('a second prompt queued behind a Claude local command joins the first across a process end', () => {
  const read = localAnswerStatuses([
    ...renameRecords(),
    typedMidTurn('a queued follow-up', 3),
    costState(ms(0), 4_000),
    typedMidTurn('another follow-up', 5),
  ]);
  assert.deepEqual(
    read.turns.map((turn) => turn.prompt),
    ['first question', 'a queued follow-up\n\nanother follow-up'],
  );
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)], 'the readers disagree on the newest turn');
});

test('model work after a stopped prompt queued behind a Claude local command answers the queued turn', () => {
  const read = localAnswerStatuses([
    ...renameRecords(),
    typedMidTurn('a queued follow-up', 3),
    costState(ms(0), 4_000),
    assistantText('working on it', 5, { input_tokens: 10, output_tokens: 5 }, undefined, 'tool_use'),
  ]);
  assert.deepEqual(
    read.turns.map((turn) => turn.prompt),
    ['first question', 'a queued follow-up'],
    'the command became a turn',
  );
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)], 'the readers disagree on the newest turn');
  assert.equal(read.turns[1].usage.output, 5, 'the model work is missing from the queued card');
  // The process end stopped the queued prompt, and the model work joins its card.
  assert.deepEqual([read.full, read.rail, read.index], ['stopped', 'stopped', 'stopped']);
});

test('a prompt queued after a Claude local command stopped an earlier prompt gets a card of its own', () => {
  const read = localAnswerStatuses([
    userPrompt('first question', 0),
    assistantAnswer('first answer', 1),
    userPrompt('an unanswered prompt', 2, { uuid: 'prompt-2' }),
    ...localCommand('/rename', 'claude entrypoint auto handback', 2, 'rename-1', { stdout: RENAMED }),
    typedMidTurn('a queued follow-up', 3),
  ]);
  assert.deepEqual(
    read.turns.map((turn) => turn.prompt),
    ['first question', 'an unanswered prompt', 'a queued follow-up'],
  );
  assert.equal(statusOf(read.turns[1], false, AFTER_COMMAND), 'stopped');
  assert.equal(read.count, read.turns.length, 'the header counts the turns differently');
  assert.deepEqual([read.full, read.rail, read.index], ['running', 'running', 'running']);
  assert.deepEqual(read.starts, [ms(3), ms(3), ms(3)], 'the readers disagree on the newest turn');
});

test('a Claude record that only mentions local_command still reaches the readers', () => {
  const records = [
    userPrompt('find the local commands', 0),
    assistantTool('Grep', 1, 'grep-1', { pattern: 'local_command' }),
    toolResult('grep-1', 2),
    assistantAnswer('found them', 3),
  ];
  assert.ok(JSON.stringify(records[1]).includes('"local_command"'));
  const turns = readSession(writeTranscript(records), 'sess').turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].toolUses, 1, 'the tool call was dropped');
  assert.equal(turns[0].summary, 'found them');
});

test('a synthetic Claude API error closes the newest spend-reducer turn without usage', () => {
  const prompt = JSON.stringify({
    type: 'user',
    timestamp: at(1),
    message: { role: 'user', content: 'retry' },
  });
  const error = JSON.stringify({
    type: 'assistant',
    timestamp: at(2),
    isApiErrorMessage: true,
    message: { model: '<synthetic>', content: 'service unavailable' },
  });
  const reducer = createClaudeUsageLineReducer();
  reducer.pushLine(prompt);
  assert.deepEqual(reducer.pushLine(error), []);
  assert.equal(reducer.lastTurnAt(), ms(2));
  assert.deepEqual(reducer.newestTurnOutcome(), {
    finished: false,
    error: true,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
  const resumed = createClaudeUsageLineReducer(reducer.snapshot());
  assert.deepEqual(resumed.newestTurnOutcome(), {
    finished: false,
    error: true,
    interrupted: false,
    endedAt: ms(2),
    startedAt: ms(1),
  });
});

test('sessions are matched to a workspace one file at a time, not one directory at a time', () => {
  // Slug collisions share a directory. Each transcript's cwd determines its workspace membership.

  const root = tempDir('proj-');
  const dir = path.join(root, 'c--work-a-b');
  fs.mkdirSync(dir);
  const write = (name: string, cwd: string, ageMs: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  write('underscore.jsonl', 'c:\\work\\a_b', 60_000);
  write('dash.jsonl', 'c:\\work\\a-b', 0); // newest, and the other project's

  assert.deepEqual(
    sessionFilesFor(root, ['c:\\work\\a_b']).map((s) => s.sessionId),
    ['underscore'],
    'the newest file belongs elsewhere, but this project keeps its own session',
  );
  assert.deepEqual(
    sessionFilesFor(root, ['c:\\work\\a-b']).map((s) => s.sessionId),
    ['dash'],
    'and the other project sees only its own',
  );
  assert.deepEqual(sessionFilesFor(root, []), []);
});

test('a Claude transcript identity with shell syntax never becomes a resume command', () => {
  const root = tempDir('proj-');
  const cwd = 'c:\\work\\repo';
  const dir = path.join(root, projectSlug(cwd).toLowerCase());
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'safe;calc.jsonl'),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n',
  );
  const [session] = sessionFilesFor(root, [cwd]);
  assert.equal(session.sessionId, 'safe;calc');
  assert.equal(resumeCommand(session.agent, session.sessionId), null);
});

test('a transcript with no readable cwd is kept only where the directory name matches exactly', () => {
  const root = tempDir('proj-');
  const exact = path.join(root, projectSlug('c:\\work\\thing').toLowerCase());
  fs.mkdirSync(exact);
  fs.writeFileSync(path.join(exact, 'nameless.jsonl'), '{"type":"user"}\n');
  const prefixed = path.join(root, projectSlug('c:\\work\\thing').toLowerCase() + '-extra');
  fs.mkdirSync(prefixed);
  fs.writeFileSync(path.join(prefixed, 'stray.jsonl'), '{"type":"user"}\n');

  assert.deepEqual(
    sessionFilesFor(root, ['c:\\work\\thing']).map((s) => s.sessionId),
    ['nameless'],
    'a prefix-matched directory needs a cwd to earn its sessions',
  );
});

test('registered worktree roots widen membership without widening the missing-cwd fallback', () => {
  const root = tempDir('proj-');
  const main = 'c:\\work\\main';
  const sibling = 'd:\\trees\\topic';
  const dir = path.join(root, projectSlug(sibling).toLowerCase());
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'known.jsonl'),
    JSON.stringify({ type: 'user', cwd: sibling, message: { role: 'user', content: 'hi' } }) + '\n',
  );
  fs.writeFileSync(path.join(dir, 'unknown.jsonl'), '{"type":"user"}\n');

  const found = sessionFilesFor(root, [main, sibling], readSessionCwd, [main]);
  assert.deepEqual(
    found.map((session) => session.sessionId),
    ['known'],
  );
  assert.equal(found[0].cwd, sibling);
});

test('filesystem roots admit Claude directories for their descendants', () => {
  const root = tempDir('proj-');
  const write = (cwd: string, sessionId: string) => {
    const dir = path.join(root, projectSlug(cwd).toLowerCase());
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n',
    );
  };
  write('/home/dev/repo', 'posix-root-child');
  write('c:\\work\\repo', 'drive-root-child');

  assert.deepEqual(
    sessionFilesFor(root, ['/']).map((session) => session.sessionId),
    ['posix-root-child'],
  );
  assert.deepEqual(
    sessionFilesFor(root, ['c:\\']).map((session) => session.sessionId),
    ['drive-root-child'],
  );
});

// Closing action and question rows retain their own text across supported Markdown forms.

test('the closing rows are read from the line they are written on', () => {
  const summary = [
    '- The hook is back and the suite is green.',
    '',
    '- 🙋 **Your actions** — reload the window, then open a turn.',
    '- ❓ **Open questions / follow-ups** — (1) keep the store? (2) rename the view?',
    '- 📊 **Context** — 9% of 1M (92k)',
  ].join('\n');
  assert.deepEqual(closingRows(summary), {
    actions: 'reload the window, then open a turn.',
    questions: '(1) keep the store? (2) rename the view?',
  });
});

test('the hyphen inside follow-ups is not the separator', () => {
  // The hyphen within follow-ups does not separate its heading from its text.

  const rows = closingRows('- ❓ **Open questions / follow-ups** - whether to keep the store.');
  assert.equal(rows.questions, 'whether to keep the store.');
});

test('a row written as a heading takes the list under it', () => {
  const summary = [
    '**Did** — read-only investigation.',
    '',
    '**Your actions**',
    '- Reload the editor windows.',
    '- Answer the item 5 question above.',
    '',
    '**Open questions / follow-ups**',
    '- Whether item 7 comes before item 3.',
  ].join('\n');
  assert.deepEqual(closingRows(summary), {
    actions: 'Reload the editor windows. Answer the item 5 question above.',
    questions: 'Whether item 7 comes before item 3.',
  });
});

test("a row named in passing in the summary's own prose is not a row", () => {
  // Prose references to row names supply no closing rows.
  const prose = [
    'Measured over every transcript: `Your actions` 8 times, `Context` 7, `Open questions` 6.',
    'The rows are 🙋 Your actions, ❓ Open questions, 📊 Context, 💭 Reflection candidates.',
  ].join('\n');
  assert.deepEqual(closingRows(prose), { actions: null, questions: null });
});

test('a row wrapped onto a second line keeps what is on it', () => {
  const summary = [
    '- ❓ **Open questions / follow-ups** — (1) the first one, which runs long',
    '  and wraps onto another line. (2) the second one.',
    '- 📊 **Context** — 9% of 1M (92k)',
  ].join('\n');
  assert.equal(
    closingRows(summary).questions,
    '(1) the first one, which runs long and wraps onto another line. (2) the second one.',
  );
});

test('the row that closes the summary wins over one quoted earlier in it', () => {
  const summary = [
    '- 🙋 **Your actions** — the one from the quoted example.',
    '',
    'That was the shape. This turn wrote its own:',
    '',
    '- 🙋 **Your actions** — the real one.',
  ].join('\n');
  assert.equal(closingRows(summary).actions, 'the real one.');
});

test('a summary with neither row has neither', () => {
  assert.deepEqual(closingRows('- Done, and the suite is green.'), { actions: null, questions: null });
  assert.deepEqual(closingRows(''), { actions: null, questions: null });
});

test('openingLines still stops before the rows closingRows reads', () => {
  const summary = ['- The one thing it did.', '', '- 🙋 **Your actions** — reload the window.'].join('\n');
  assert.deepEqual(openingLines(summary), ['The one thing it did.']);
  assert.equal(closingRows(summary).actions, 'reload the window.');
});

test('a row holds what is under it, and stops where the next row starts', () => {
  // A following heading starts a separate row even when both headings use bullets.

  const summary = [
    '- 🙋 **Your actions**',
    '  - Reload the window.',
    '- ❓ **Open questions / follow-ups** — none.',
    '- 📊 **Context** — 9% of 1M (92k)',
  ].join('\n');
  assert.deepEqual(closingRows(summary), { actions: 'Reload the window.', questions: 'none.' });

  // An empty action heading leaves the following question text in its own row.

  const empty = ['- 🙋 **Your actions**', '- ❓ **Open questions / follow-ups** — whether to keep the store.'].join(
    '\n',
  );
  assert.deepEqual(closingRows(empty), { actions: null, questions: 'whether to keep the store.' });
});

test('a sentence that opens with a row name does not empty the row above it', () => {
  // Prose mentioning a row name preserves the earlier row's text.

  const summary = [
    '- 🙋 **Your actions** — reload the window and confirm.',
    '',
    'Your actions are done once that reload lands.',
  ].join('\n');
  assert.equal(closingRows(summary).actions, 'reload the window and confirm.');
});

test("a row written out inside a fenced example is not the turn's own row", () => {
  // Fenced examples supply no closing row values.
  const summary = [
    '- Wrote the rule down.',
    '',
    'The shape is:',
    '',
    '```',
    '- 🙋 **Your actions** — what only they can do',
    '- ❓ **Open questions / follow-ups** — what is waiting on an answer',
    '```',
    '',
    '- 🙋 **Your actions** — commit the rule.',
  ].join('\n');
  assert.deepEqual(closingRows(summary), { actions: 'commit the rule.', questions: null });
});

test('a row that is only a name, with nothing under it, is not a row', () => {
  assert.deepEqual(closingRows('- 🙋 **Your actions**'), { actions: null, questions: null });
  assert.deepEqual(closingRows('- 🙋 **Your actions**\n\nProse, not a list.'), { actions: null, questions: null });
});

test('an item that opens with a row name is an item, not the next row', () => {
  // Indented items beginning with a row name remain content of their containing row.

  const summary = [
    '- ❓ **Open questions / follow-ups**',
    '  - Your actions here decide whether we ship Friday or slip to Monday.',
    '  - Should the store rename land in the same release?',
  ].join('\n');
  assert.deepEqual(closingRows(summary), {
    actions: null,
    questions:
      'Your actions here decide whether we ship Friday or slip to Monday.' +
      ' Should the store rename land in the same release?',
  });

  // Inline action text and a separate question section keep their own content.
  const mixed = [
    '- 🙋 **Your actions** — reload the window.',
    '- ❓ **Open questions / follow-ups**',
    '  - Your actions on this ticket decide the release date, so should we ship Friday?',
  ].join('\n');
  assert.deepEqual(closingRows(mixed), {
    actions: 'reload the window.',
    questions: 'Your actions on this ticket decide the release date, so should we ship Friday?',
  });
});

test('the section the newer format closes with is read as the actions row', () => {
  // A Waiting on you section supplies action text without a separate question row.

  const summary = [
    'The rail keeps its focus, and the suite is green.',
    '',
    '**Done**',
    '- Moved the roving tab stop onto the rail.',
    '- Added the two tests that hold it there.',
    '',
    '**Waiting on you**',
    '- Reload the window and walk the rail with the arrow keys.',
    '- Decide whether the picker keeps a tab stop of its own.',
  ].join('\n');
  assert.deepEqual(closingRows(summary), {
    actions:
      'Reload the window and walk the rail with the arrow keys.' +
      '\nDecide whether the picker keeps a tab stop of its own.',
    questions: null,
  });
});

test('the label is read with its colon written on either side of the bold', () => {
  // A heading colon can sit inside or outside its bold markers.

  const inside = ['**Waiting on you:**', '- Reload the window.'].join('\n');
  assert.deepEqual(closingRows(inside), { actions: 'Reload the window.', questions: null });
  const outside = ['**Waiting on you**:', '- Reload the window.'].join('\n');
  assert.deepEqual(closingRows(outside), { actions: 'Reload the window.', questions: null });
});

test('the section takes both bullet markers, and a blank line above its first item', () => {
  // Both bullet markers and a leading blank line retain the section's items.

  const summary = ['**Waiting on you**', '', '- Reload the window.', '* Decide the icon set.'].join('\n');
  assert.deepEqual(closingRows(summary), {
    actions: 'Reload the window.\nDecide the icon set.',
    questions: null,
  });
});

test('the section takes the item shapes the older reader takes, and a wrap does not end it', () => {
  // Numbered items and wrapped lines remain in the section alongside bullets.

  const summary = [
    '**Waiting on you**',
    '- Install the build and look at the rail,',
    '  the buckets most of all.',
    '1. Decide the done-glyph shape.',
    '- Answer the breakpoint question.',
  ].join('\n');
  assert.deepEqual(closingRows(summary), {
    actions:
      'Install the build and look at the rail, the buckets most of all.\nDecide the done-glyph shape.\nAnswer the breakpoint question.',
    questions: null,
  });
  // An indented line without a preceding item ends the section.

  const stray = ['**Waiting on you**', '  not an item', '- Too late to count.'].join('\n');
  assert.equal(closingRows(stray).actions, null);
});

test('the words waiting on you inside a sentence do not open a section', () => {
  // Row names within prose supply no section or action text.

  const prose = [
    'The rest of it is waiting on you to decide.',
    '- Not an item of anything.',
    '',
    '**Waiting on you** is where the asks go now, and the symbols are gone.',
    '- Nor is this one.',
  ].join('\n');
  assert.deepEqual(closingRows(prose), { actions: null, questions: null });
});

test("the newer section written out inside a fenced example is not the turn's own", () => {
  // A fenced section supplies no action text.

  const summary = [
    'Wrote the newer format down.',
    '',
    'The shape is:',
    '',
    '```',
    '**Waiting on you**',
    '- what only the reader can do',
    '```',
  ].join('\n');
  assert.deepEqual(closingRows(summary), { actions: null, questions: null });
});

test('between the two shapes the one written later in the summary wins', () => {
  // The last supported action row or section supplies the action value.

  const sectionLast = [
    '- 🙋 **Your actions** — the shape this turn replaced.',
    '- ❓ **Open questions / follow-ups** — whether to keep the store.',
    '',
    '**Waiting on you**',
    '- Reload the window.',
  ].join('\n');
  assert.deepEqual(closingRows(sectionLast), { actions: 'Reload the window.', questions: null });

  // A later action row replaces an earlier section's action value.

  const rowLast = [
    '**Waiting on you**',
    '- The shape this turn quoted.',
    '',
    '- 🙋 **Your actions** — reload the window.',
  ].join('\n');
  assert.deepEqual(closingRows(rowLast), { actions: 'reload the window.', questions: null });
});

test('a relative path is written against the folder holding it, with forward slashes', () => {
  const one = ['C:/Users/dev/work/repo'];
  // Relative paths use forward slashes for both recorded separator styles.

  assert.equal(relativePath('C:/Users/dev/work/repo/src/a.ts', one), 'src/a.ts');
  const BS = String.fromCharCode(92);
  assert.equal(relativePath(['C:', 'Users', 'dev', 'work', 'repo', 'src', 'a.ts'].join(BS), one), 'src/a.ts');
  // The drive letter's case follows whichever session wrote it, so it cannot decide a match.
  assert.equal(relativePath('c:/Users/dev/work/repo/src/a.ts', one), 'src/a.ts');
  // A trailing separator on the folder is not part of the answer.
  assert.equal(relativePath('C:/Users/dev/work/repo/src/a.ts', ['C:/Users/dev/work/repo/']), 'src/a.ts');
});

test('the result keeps the case the disk holds, not the case the comparison used', () => {
  // Relative paths retain the source path's case after case-insensitive workspace matching.

  assert.equal(relativePath('C:/Users/dev/work/repo/src/MyFile.TS', ['c:/users/dev/work/repo']), 'src/MyFile.TS');
});

test('with more than one folder open the answer says which one', () => {
  const two = ['C:/work/alpha', 'C:/work/beta'];
  assert.equal(relativePath('C:/work/alpha/src/a.ts', two), 'alpha/src/a.ts');
  assert.equal(relativePath('C:/work/beta/b.ts', two), 'beta/b.ts');
  // A single open folder supplies no folder-name prefix.
  assert.equal(relativePath('C:/work/alpha/src/a.ts', ['C:/work/alpha']), 'src/a.ts');
});

test('a folder inside another names the file by the nearer of the two', () => {
  const nested = ['C:/work/repo', 'C:/work/repo/packages/inner'];
  // The inner folder's own name and the path under it, not the outer folder's.
  assert.equal(relativePath('C:/work/repo/packages/inner/x.ts', nested), 'inner/x.ts');
  assert.equal(relativePath('C:/work/repo/top.ts', nested), 'repo/top.ts');
});

test('a path outside every folder has no relative form, so it keeps its own', () => {
  const one = ['C:/work/repo'];
  const outside = 'C:/Users/dev/AppData/Local/Temp/scratch.txt';
  assert.equal(relativePath(outside, one), outside);
  // And with no folder open at all there is nothing to be relative to.
  assert.equal(relativePath(outside, []), outside);
  // A sibling whose name merely starts the same way is not inside it.
  assert.equal(relativePath('C:/work/repo-two/a.ts', one), 'C:/work/repo-two/a.ts');
});

test('the four recorded spellings of one file copy as one string', () => {
  // Absolute Windows paths normalize separator style and drive-letter case for copying.

  const want = 'C:\\Users\\dev\\work\\repo\\src\\a.ts';
  assert.equal(nativePath('c:\\Users\\dev\\work\\repo\\src\\a.ts'), want);
  assert.equal(nativePath('C:\\Users\\dev\\work\\repo\\src\\a.ts'), want);
  assert.equal(nativePath('c:/Users/dev/work/repo/src/a.ts'), want);
  assert.equal(nativePath('C:/Users/dev/work/repo/src/a.ts'), want);
  // Every drive letter follows the same conversion.
  assert.equal(nativePath('d:/work/repo/b.ts'), 'D:\\work\\repo\\b.ts');
  assert.equal(nativePath('d:\\work\\repo\\b.ts'), 'D:\\work\\repo\\b.ts');
});

test('a path with no drive letter is copied byte for byte', () => {
  // Relative paths retain their separator style.

  assert.equal(nativePath('src/a.ts'), 'src/a.ts');
  assert.equal(nativePath('docs/architecture.md'), 'docs/architecture.md');
  // A POSIX absolute path is already native where it names something.
  assert.equal(nativePath('/home/dev/x'), '/home/dev/x');
  // UNC paths retain their existing leading separators.

  assert.equal(nativePath('\\\\server\\share\\a.ts'), '\\\\server\\share\\a.ts');
});

test('a drive letter with no separator after it is not an absolute path', () => {
  // Bare drives and drive-relative paths remain unchanged because they are not absolute paths.

  assert.equal(nativePath(''), '');
  assert.equal(nativePath('C:'), 'C:');
  assert.equal(nativePath('c:'), 'c:');
  assert.equal(nativePath('c:relative/x.ts'), 'c:relative/x.ts');
});

test('a link names its file with the anchor stripped, and a URL names nothing', () => {
  assert.equal(linkTarget('src/store.ts#L42'), 'src/store.ts');
  assert.equal(linkTarget('src/store.ts#L42-L51'), 'src/store.ts');
  assert.equal(linkTarget('src/store.ts:42'), 'src/store.ts');
  assert.equal(linkTarget('src/store.ts:42:7'), 'src/store.ts');
  assert.equal(linkTarget('src/store.ts'), 'src/store.ts');
  // An absolute Windows drive path remains a file after its trailing line number is removed.

  assert.equal(linkTarget('c:/repo/a.ts:42'), 'c:/repo/a.ts');
  assert.equal(linkTarget('https://example.com/a.ts'), null);
  assert.equal(linkTarget('HTTP://x/y#L4'), null);
  assert.equal(linkTarget(''), null);
  // An anchor alone names nothing to copy.
  assert.equal(linkTarget('#L42'), null);
  for (const prefix of ['C:/Users/Reader/Notes', '/Users/Reader/Notes', '/home/reader/Notes', 'docs']) {
    assert.equal(linkTarget(`${prefix}/guide.md#wait-without-repeated-model-requests`), `${prefix}/guide.md`);
    assert.equal(linkTarget(`${prefix}/guide.markdown#section:42`), `${prefix}/guide.markdown`);
  }
  assert.equal(linkTarget('report.csv#part'), 'report.csv#part');
});

test('a linked HTML file is recognized by its resolved suffix', () => {
  for (const target of ['report.html', 'report.htm', 'nested/report.HTML', 'nested/report.HtM']) {
    assert.equal(linkTargetIsHtml(target), true, `${target} did not use the browser route`);
  }
  for (const target of ['report.xhtml', 'report.html.md', 'report.md', 'html']) {
    assert.equal(linkTargetIsHtml(target), false, `${target} used the browser route`);
  }
  assert.equal(
    linkTargetIsHtml(linkTarget('report.html#L42') ?? ''),
    true,
    'a line anchor prevented an HTML target from using the browser route',
  );
});

test('a linked Markdown file is recognized by its resolved suffix', () => {
  for (const target of ['README.md', 'notes.markdown', 'nested/README.MD', 'nested/notes.MarkDown']) {
    assert.equal(linkTargetIsMarkdown(target), true, `${target} did not use the Markdown Preview route`);
  }
  for (const target of ['notes.mdx', 'notes.md.txt', 'report.html', 'extensionless', '']) {
    assert.equal(linkTargetIsMarkdown(target), false, `${target} used the Markdown Preview route`);
  }
  assert.equal(
    linkTargetIsMarkdown(linkTarget('README.md#L42') ?? ''),
    true,
    'a line anchor prevented a Markdown target from using the Markdown Preview route',
  );
});

test('a linked video uses only the supported resolved suffixes', () => {
  for (const suffix of ['mp4', 'm4v', 'mov', 'webm', 'avi', 'mkv']) {
    assert.equal(linkTargetIsVideo(`outside/story.${suffix}`), true);
    assert.equal(linkTargetIsVideo(`outside/story.${suffix.toUpperCase()}`), true);
  }
  for (const target of ['story.mp4.txt', 'story.mp4#L10', 'story.mp4:10', 'story.svg', 'story.mp3', 'story', '']) {
    assert.equal(linkTargetIsVideo(target), false, target);
  }
  assert.equal(linkTargetIsVideo(linkTarget('story.MP4#L10')!), true);
});

test('a relative link resolves to the folder that holds it, or the first folder', () => {
  const folders = ['/ws/app', '/ws/lib'];
  const inLib = path.join('/ws/lib', 'src/a.ts');
  assert.equal(
    resolveLink('src/a.ts', folders, (p) => p === inLib),
    inLib,
  );
  // Nothing holds it: the first folder's join, which is where opening would have looked.
  assert.equal(
    resolveLink('src/missing.ts', folders, () => false),
    path.join('/ws/app', 'src/missing.ts'),
  );
  const abs = path.resolve('/abs/x.ts');
  assert.equal(
    resolveLink(abs, folders, () => false),
    abs,
  );
  assert.equal(
    resolveLink('a.ts', [], () => false),
    null,
  );
  assert.equal(
    resolveLink('', folders, () => false),
    null,
  );
});

test('local link candidates preserve platform spelling and allow paths outside open folders', () => {
  for (const [platform, root, outside, expected] of [
    ['win32', 'C:/Work/App', 'D:/Notes/Guide.md', 'D:\\Notes\\Guide.md'],
    ['darwin', '/Users/Reader/Work/App', '/Users/Reader/Notes/Guide.md', '/Users/Reader/Notes/Guide.md'],
    ['linux', '/home/reader/Work/App', '/home/reader/Notes/Guide.md', '/home/reader/Notes/Guide.md'],
  ] as const) {
    assert.deepEqual(linkCandidates(outside, [root], platform), [expected]);
    assert.deepEqual(linkCandidates(outside, [], platform), [expected]);
    const parent = platform === 'win32' ? 'C:\\Work\\Guide.md' : root.replace(/\/App$/, '/Guide.md');
    assert.deepEqual(linkCandidates('../Guide.md', [root], platform), [parent]);
    assert.deepEqual(linkCandidates('Guide.md', [], platform), []);
    assert.deepEqual(linkCandidates('', [root], platform), []);
  }
  assert.deepEqual(linkCandidates('c:\\Notes\\Mixed.md', ['C:/Work'], 'win32'), ['c:\\Notes\\Mixed.md']);
});

test('a session was last active when it last recorded a time, not when its file was touched', () => {
  // Untimed bookkeeping after the last activity leaves the recorded activity timestamp unchanged.

  const closed = writeTranscript([
    userPrompt('why does the panel show nothing in this repo', 0),
    assistantText('because no folder holding a transcript is open', 30),
    { type: 'ai-title', aiTitle: 'Panel shows nothing' },
    { type: 'last-prompt', prompt: 'why does the panel show nothing in this repo' },
    { type: 'mode', mode: 'default' },
    { type: 'file-history-snapshot', messageId: 'm1', snapshot: {} },
    { type: 'bridge-session', bridgeSessionId: 'b1' },
  ]);
  assert.equal(readSessionActivity(closed), ms(30), 'the closing bookkeeping was read as activity');

  // Bookkeeping alone leaves activity time unavailable.

  const silent = writeTranscript([
    { type: 'ai-title', aiTitle: 'Named but never spoken in' },
    { type: 'mode', mode: 'default' },
  ]);
  assert.equal(readSessionActivity(silent), null);

  // Invalid timestamps supply no activity time.

  const broken = writeTranscript([
    userPrompt('a real prompt', 10),
    { type: 'system', timestamp: 'not a date', content: 'hook fired' },
  ]);
  assert.equal(readSessionActivity(broken), ms(10));
  assert.equal(readSessionActivity(writeTranscript([{ type: 'system', timestamp: 'not a date' }])), null);
});

test('a record that lands out of order cannot pull a session back in time', () => {
  // A late sidechain record with an older timestamp preserves the newest recorded activity time.

  const out = writeTranscript([
    userPrompt('run three agents', 0),
    assistantText('all three are done', 300),
    {
      type: 'user',
      isSidechain: true,
      timestamp: at(120),
      message: { role: 'user', content: [{ type: 'text', text: 'the second agent reporting' }] },
    },
  ]);
  assert.equal(readSessionActivity(out), ms(300), 'a late line carrying an older time lowered the answer');
});

test('a session name and its last activity come out of one read of the tail', () => {
  const file = writeTranscript([
    userPrompt('build the timeline', 0),
    assistantText('here is the first card', 45),
    { type: 'ai-title', aiTitle: 'Timeline view for agent turns' },
    { type: 'mode', mode: 'default' },
  ]);
  // A session still in its first unfinished turn has no agent-run classification.

  const { headKey, titleAt, coverage, ...meta } = readSessionMeta(file);
  assert.deepEqual(coverage, { whole: true, windowBytes: 256 * 1024 });
  assert.ok(headKey && titleAt, 'the read names the first record and places the title record');
  assert.deepEqual(meta, {
    title: 'Timeline view for agent turns',
    fullTitle: 'Timeline view for agent turns',
    titleSource: 'generated',
    activityMs: ms(45),
    agentRun: false,
    outcome: { finished: false, error: false, interrupted: false, endedAt: ms(45), startedAt: ms(0) },
  });
  assert.deepEqual(
    { ...readSessionMeta(writeTranscript([{ type: 'mode', mode: 'default' }])), headKey: undefined },
    {
      coverage: { whole: true, windowBytes: 256 * 1024 },
      headKey: undefined,
      title: null,
      fullTitle: null,
      titleSource: null,
      activityMs: null,
      agentRun: false,
      outcome: null,
    },
  );
});

test('session metadata carries the newest turn outcome only when its start is in the tail', () => {
  const failed = writeTranscript([
    userPrompt('make the rail show failures', 0),
    { type: 'assistant', isApiErrorMessage: true, timestamp: at(5), message: { content: 'stream disconnected' } },
  ]);
  const meta = readSessionMeta(failed);
  assert.deepEqual(meta.outcome, {
    finished: false,
    error: true,
    interrupted: false,
    endedAt: ms(5),
    startedAt: ms(0),
  });

  const partial = writeTranscript([
    userPrompt('make the rail show failures', 0),
    { type: 'assistant', isApiErrorMessage: true, timestamp: at(5), message: { content: 'stream disconnected' } },
  ]);
  const narrow = readSessionMeta(partial, 20);
  assert.equal(narrow.outcome, null);
});

test('Claude metadata starts an externally running rail card without a busy child', () => {
  const file = writeTranscript([userPrompt('keep working', 0)]);
  const outcome = readSessionMeta(file).outcome;
  const starts = sessionRunningSince([], new Set(), new Map([['external', outcome]]), ms(2));
  assert.deepEqual([...starts], [['external', ms(0)]]);
});

test('Claude metadata statistics use the parser over the tail already in memory', () => {
  const file = writeTranscript([
    userPrompt('measure this turn', 0),
    assistantText('Done.', 5, { input_tokens: 20_000, cache_read_input_tokens: 10_000, output_tokens: 500 }),
  ]);
  const parsed = readSession(file, 'sess', { tailBytes: 256 * 1024, maxTurns: 40 });
  assert.deepEqual(readSessionMeta(file, 256 * 1024, 'sess').stats, sessionStatFactsOf(parsed));
  assert.deepEqual(sessionOutcomeOf(parsed), readSessionMeta(file).outcome);
  assert.equal(
    readSessionMeta(file, 20, 'sess').stats,
    null,
    'a tail that cannot reach the newest turn start supplies no rail figures',
  );
});

test('session metadata follows the parser through API errors and a turn that resumes work', () => {
  const failed = writeTranscript([
    userPrompt('show the error', 0),
    {
      type: 'assistant',
      isApiErrorMessage: true,
      timestamp: at(1),
      message: { model: '<synthetic>', content: 'service unavailable' },
    },
  ]);
  assert.equal(
    readSessionMeta(failed).outcome?.error,
    true,
    'a real API error carries the synthetic marker the harness also uses',
  );

  const continued = writeTranscript([
    userPrompt('continue after the first answer', 0),
    assistantAnswer('The first answer closed.', 1),
    {
      ...assistantTool('Read', 2),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'e1', name: 'Read', input: {} }],
      },
    },
    {
      type: 'user',
      timestamp: at(3),
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: 'the child finished' },
    },
    editResult('c:\\repo\\a.ts', 4, 1, 0),
  ]);
  const parsed = readTurns(continued, 'sess')[0];
  assert.equal(parsed.finished, false);
  assert.equal(parsed.endedAt, ms(4));
  assert.deepEqual(readSessionMeta(continued).outcome, {
    finished: false,
    error: false,
    interrupted: false,
    endedAt: parsed.endedAt,
    startedAt: parsed.startedAt,
  });
});

// A background Agent result identifies its child and asynchronous launch state.

function backgroundLaunch(toolUseId: string, agentId: string, second: number) {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'launched' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: `Scan ${agentId}` },
  };
}
function childNoticeText(toolUseId: string, taskId: string): string {
  return `<task-notification><task-id>${taskId}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>completed</status></task-notification>`;
}
const twoBackgroundChildren = [
  userPrompt('scan both halves in the background', 0),
  assistantTool('Agent', 1, 'bg1', { description: 'Scan x1', run_in_background: true }),
  backgroundLaunch('bg1', 'x1', 2),
  assistantTool('Agent', 3, 'bg2', { description: 'Scan x2', run_in_background: true }),
  backgroundLaunch('bg2', 'x2', 4),
  assistantAnswer('Both scans are running.', 5),
  userPrompt('what else is left?', 6),
  assistantAnswer('Nothing else, the scans are still running.', 7),
  {
    type: 'user',
    timestamp: at(8),
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: childNoticeText('bg1', 'x1') },
  },
  assistantAnswer('The first scan is back.', 9),
];

function outcomeReaders(records: object[]) {
  const file = writeTranscript(records);
  const indexed = createClaudeUsageLineReducer();
  for (const record of records) {
    indexed.pushLine(JSON.stringify(record));
  }
  return {
    tail: readSessionMeta(file).outcome,
    full: sessionOutcomeOf(readSession(file, 'sess')),
    lifetime: indexed.newestTurnOutcome(),
    restored: createClaudeUsageLineReducer(structuredClone(indexed.snapshot())).newestTurnOutcome(),
  };
}

test('a closed turn names the background children no notice has closed yet', () => {
  const readers = outcomeReaders(twoBackgroundChildren);
  for (const [reader, outcome] of Object.entries(readers)) {
    assert.equal(outcome?.finished, true, `${reader}: the newest turn closed`);
    assert.deepEqual(outcome?.openChildren, ['x2'], `${reader}: one child is still open`);
    assert.deepEqual(outcome?.closedChildren, [{ id: 'x1', closedAt: ms(8) }], `${reader}: the close has a time`);
  }
});

// A command completion notice identifies its task, tool call, status, and timestamp.

function commandNotice(toolUseId: string, taskId: string, status: string, second: number) {
  return {
    type: 'user',
    timestamp: at(second),
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification><task-id>${taskId}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status></task-notification>`,
    },
  };
}
const backgroundCommandTurn = [
  userPrompt('run the suite in the background', 0),
  assistantTool('Bash', 1, 'cmd1', { command: 'npm test', run_in_background: true }),
  {
    type: 'user',
    timestamp: at(2),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'cmd1', content: 'Command running in background with ID: b349silf3' },
      ],
    },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b349silf3' },
  },
  assistantAnswer('The suite runs in the background.', 3),
];

// Derive session status from transcript metadata and the supplied open-child count at one clock reading.

function railStatusFromTranscript(records: object[], now: number, openChildren = new Map<string, number>()) {
  const outcomes = new Map([['sess', readSessionMeta(writeTranscript(records)).outcome]]);
  return sessionStatusOf(
    [],
    new Set(),
    outcomes,
    now,
    new Set(),
    new Map(),
    openChildren,
    liveBackgroundCommands(outcomes, new Map(), now),
  ).get('sess');
}

test('a closed turn reads background while a command it started in the background runs', () => {
  const noCommand = railStatusFromTranscript([userPrompt('run the suite', 0), assistantAnswer('Done.', 3)], ms(4));
  assert.equal(noCommand, 'done');
  assert.equal(railStatusFromTranscript(backgroundCommandTurn, ms(4)), 'background');
  // Any end record ends the state, whatever status it reports, in either notice shape.
  for (const status of ['completed', 'failed', 'killed']) {
    assert.equal(
      railStatusFromTranscript([...backgroundCommandTurn, commandNotice('cmd1', 'b349silf3', status, 5)], ms(6)),
      noCommand,
      `a ${status} end record`,
    );
  }
  assert.equal(
    railStatusFromTranscript(
      [
        ...backgroundCommandTurn,
        queued(
          {
            commandMode: 'task-notification',
            prompt: commandNotice('cmd1', 'b349silf3', 'completed', 5).message.content,
          },
          5,
        ),
      ],
      ms(6),
    ),
    noCommand,
    'a queued end record',
  );
  // An end record for another call leaves the command running.
  assert.equal(
    railStatusFromTranscript([...backgroundCommandTurn, commandNotice('other', 'b000', 'completed', 5)], ms(6)),
    'background',
  );
  // The state lasts one hour from the launch at most.
  assert.equal(railStatusFromTranscript(backgroundCommandTurn, ms(1) + BACKGROUND_COMMAND_CAP_MS - 1), 'background');
  assert.equal(railStatusFromTranscript(backgroundCommandTurn, ms(1) + BACKGROUND_COMMAND_CAP_MS), noCommand);
  // Live subagents take precedence over background-command status.
  assert.equal(railStatusFromTranscript(backgroundCommandTurn, ms(4), new Map([['sess', 1]])), 'subagents');
});

// A stop call writes no end record. Its input names the task id the launch result reported.
test('a command the agent stops leaves the background state', () => {
  const [prompt, launch, launched] = backgroundCommandTurn;
  const stopTurn = (name: string, input: Record<string, unknown>) => [
    prompt,
    launch,
    launched,
    assistantTool(name, 3, 'stop1', input),
    {
      type: 'user',
      timestamp: at(4),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'stop1', content: 'Successfully stopped task: b349silf3 (npm test)' },
        ],
      },
      toolUseResult: {
        message: 'Successfully stopped task: b349silf3 (npm test)',
        task_id: 'b349silf3',
        task_type: 'local_bash',
        command: 'npm test',
      },
    },
    assistantAnswer('The suite is stopped.', 5),
  ];
  assert.equal(railStatusFromTranscript(stopTurn('TaskStop', { task_id: 'b349silf3' }), ms(6)), 'done');
  assert.equal(railStatusFromTranscript(stopTurn('KillShell', { shell_id: 'b349silf3' }), ms(6)), 'done');
  assert.equal(
    railStatusFromTranscript(stopTurn('TaskStop', { task_id: 'b000' }), ms(6)),
    'background',
    'a stop of another task',
  );
});

// A launch the reader rejects, or one that fails before its process starts, has an error result.
test('a background launch whose result is an error does not read background', () => {
  const rejected = [
    userPrompt('run the suite in the background', 0),
    assistantTool('Bash', 1, 'cmd1', { command: 'npm test', run_in_background: true }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'cmd1',
            is_error: true,
            content: "The user doesn't want to proceed with this tool use.",
          },
        ],
      },
      toolUseResult: "Error: The user doesn't want to proceed with this tool use.",
    },
    assistantAnswer('The suite did not start.', 3),
  ];
  assert.equal(readSessionMeta(writeTranscript(rejected)).outcome?.backgroundCommands, undefined);
  assert.equal(railStatusFromTranscript(rejected, ms(4)), 'done');
});

test('a background subagent launch with no end record does not read background', () => {
  const agentTurn = [
    userPrompt('scan in the background', 0),
    assistantTool('Agent', 1, 'bg1', { description: 'Scan x1', run_in_background: true }),
    backgroundLaunch('bg1', 'x1', 2),
    assistantAnswer('The scan is running.', 3),
  ];
  assert.equal(readSessionMeta(writeTranscript(agentTurn)).outcome?.backgroundCommands, undefined);
  assert.equal(railStatusFromTranscript(agentTurn, ms(4)), 'done');
});

// A long turn that end records keep waking. Its typed prompt lies before the tail read, and the
// command it launched last lies inside it.
test('a long turn reads background when its typed prompt lies before the tail read', () => {
  const records = [
    userPrompt('orchestrate the release', 0),
    assistantTool('Bash', 1, 'cmd0', { command: 'npm run build', run_in_background: true }),
    assistantAnswer(`The build runs in the background. ${'x'.repeat(8_000)}`, 2),
    commandNotice('cmd0', 'b000', 'completed', 3),
    ...backgroundCommandTurn.slice(1).map((record, index) => ({ ...record, timestamp: at(4 + index) })),
  ];
  const file = writeTranscript(records);
  const meta = readSessionMeta(file, 2_048, 'sess');
  assert.equal(meta.outcome, null, 'the tail holds no typed prompt');
  const indexed = createClaudeUsageLineReducer();
  for (const record of records) {
    indexed.pushLine(JSON.stringify(record));
  }
  const parsed = sessionOutcomeOf(readSession(file, 'sess'));
  // `outcomeWithWiderChildren` adds the tail's commands to the lifetime outcome of the same turn.
  const outcomes = new Map([
    ['sess', outcomeWithWiderChildren(meta.outcome, indexed.newestTurnOutcome(), parsed, meta.backgroundCommands)],
  ]);
  const now = ms(10);
  const status = sessionStatusOf(
    [],
    new Set(),
    outcomes,
    now,
    new Set(),
    new Map(),
    new Map(),
    liveBackgroundCommands(outcomes, new Map(), now),
  ).get('sess');
  assert.equal(status, 'background', 'no tail outcome');
});

// A process end stops every command the process started, and a resume starts with none running.
test('a recorded process end clears the background commands of the tail read', () => {
  const [prompt, launch, launched] = backgroundCommandTurn;
  const resumed = [
    prompt,
    launch,
    launched,
    costState(ms(0), ms(3) - ms(0)),
    userPrompt('is the suite done?', 4),
    assistantAnswer('The suite stopped with the session.', 5),
  ];
  const outcome = readSessionMeta(writeTranscript(resumed)).outcome;
  assert.equal(outcome?.startedAt, ms(4), 'the tail outcome is the resumed turn');
  assert.equal(outcome?.backgroundCommands, undefined);
  assert.equal(railStatusFromTranscript(resumed, ms(6)), 'done');
});

test('the last completion notice empties the open children', () => {
  const readers = outcomeReaders([
    ...twoBackgroundChildren,
    queued({ commandMode: 'task-notification', prompt: childNoticeText('bg2', 'x2') }, 10),
    assistantAnswer('Both scans are back.', 11),
  ]);
  for (const [reader, outcome] of Object.entries(readers)) {
    assert.equal(outcome?.finished, true, `${reader}: the newest turn closed`);
    assert.equal(
      outcome !== null && Object.prototype.hasOwnProperty.call(outcome, 'openChildren'),
      false,
      `${reader}: no child is open`,
    );
    assert.deepEqual(
      outcome?.closedChildren,
      [
        { id: 'x1', closedAt: ms(8) },
        { id: 'x2', closedAt: ms(10) },
      ],
      `${reader}: both closes have their record times`,
    );
  }
});

test('a restored lifetime scan indexes closed child ids once across a large completion burst', () => {
  const count = 1_000;
  let identifierReads = 0;
  const closedChildren = Array.from({ length: count }, (_, index) =>
    Object.defineProperty({ closedAt: ms(index) }, 'id', {
      enumerable: true,
      get: () => {
        identifierReads++;
        return `old-${index}`;
      },
    }),
  ) as NonNullable<TurnOutcome['closedChildren']>;
  const state = {
    ...emptyClaudeUsageReducerState(),
    openTurn: true,
    currentTurnOutcome: {
      finished: true,
      error: false,
      interrupted: false,
      endedAt: ms(0),
      closedChildren,
    },
  };

  for (let index = 0; index < count; index++) {
    reduceClaudeUsageLine(
      state,
      JSON.stringify({
        type: 'user',
        timestamp: at(count + index),
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: childNoticeText(`call-${index}`, `new-${index}`) },
      }),
    );
  }

  assert.equal(identifierReads, count, 'each restored identifier is read once to build the index');
  assert.equal(state.currentTurnOutcome?.closedChildren?.length, count * 2);
  const lastRestored = state.currentTurnOutcome?.closedChildren?.[count - 1];
  assert.equal(typeof lastRestored === 'string' ? lastRestored : lastRestored?.id, `old-${count - 1}`);
  assert.deepEqual(state.currentTurnOutcome?.closedChildren?.[count], { id: 'new-0', closedAt: ms(count) });
});

test('a resume after a recorded process end carries no open child into the new turn', () => {
  const readers = outcomeReaders([
    ...twoBackgroundChildren,
    costState(ms(0), 10_000),
    userPrompt('pick up where you left off', 12),
    assistantAnswer('Picking up.', 13),
  ]);
  for (const [reader, outcome] of Object.entries(readers)) {
    assert.equal(outcome?.startedAt, ms(12), `${reader}: the resumed turn is the newest`);
    assert.equal(
      outcome !== null && Object.prototype.hasOwnProperty.call(outcome, 'openChildren'),
      false,
      `${reader}: the process end closed every child it held`,
    );
  }
});

// Child references and outcome facts share the launch result's agent id for write-time lookup.

test('a child discovery reference joins the open child its launch names', () => {
  const file = writeTranscript(twoBackgroundChildren);
  const references = readClaudeChildSessionReferences({ file, sessionId: 'sess' });
  assert.deepEqual(references.map((reference) => reference.sessionId).sort(), ['x1', 'x2']);
  const now = ms(20);
  const version = `2048:${now - 60_000}`;
  const subagentReferences = references.filter(isClaudeSubagentReference);
  const writes = new Map(
    subagentReferences.map((reference) => [reference.file, writeTimeOfVersion(version) as number]),
  );
  const index = claudeChildWriteIndex([], subagentReferences, writes);
  const outcomes = new Map([['sess', readSessionMeta(file).outcome]]);
  const live = liveOpenChildren(outcomes, (session, child) => index.get(childWriteKey(session, child)), new Map(), now);
  assert.deepEqual(live, new Map([['sess', ['x2']]]));
  assert.equal(writeTimeOfVersion('missing'), null);
  assert.equal(writeTimeOfVersion('not-file'), null);
  assert.equal(writeTimeOfVersion('2048:'), null);
});

// Cards and the session list count the same live children. Quiet children supply no running figure.

test('the agents figure counts the live open children the rail counts', () => {
  const file = writeTranscript(twoBackgroundChildren);
  const read = readSession(file, 'sess');
  const launched = read.turns.find((turn) => turn.agents.length > 0);
  assert.ok(launched, 'the launch turn was not parsed');
  assert.deepEqual(
    launched.agents.map((agent) => agent.status),
    ['completed', 'running'],
  );
  const outcomes = new Map([['sess', sessionOutcomeOf(read)]]);
  const now = ms(20);
  const figure = (written: number) => {
    const live = liveOpenChildren(outcomes, () => written, new Map(), now);
    const chip = toCard(launched, false, now, [], null, false, new Set(live.get('sess'))).chips.find(
      (one) => one.metric === 'agents',
    );
    return { rail: openChildCounts(live).get('sess'), card: chip?.running };
  };
  assert.deepEqual(figure(now - 60_000), { rail: 1, card: 1 });
  assert.deepEqual(figure(now - TURN_QUIET_MS - 1), { rail: undefined, card: undefined });
});

// The newest finished card includes live subagents launched by earlier turns.

test('the newest turn card counts a carried subagent', () => {
  const records = [
    userPrompt('scan in the background', 0),
    assistantTool('Agent', 1, 'bg1', { description: 'Scan x1', run_in_background: true }),
    backgroundLaunch('bg1', 'x1', 2),
    assistantAnswer('The scan is running.', 3),
    userPrompt('anything else?', 4),
    assistantAnswer('Nothing else yet.', 5),
  ];
  const read = readSession(writeTranscript(records), 'sess');
  const [first, newest] = [...read.turns].sort((a, b) => a.startedAt - b.startedAt);
  assert.ok(first && newest && first !== newest, 'both turns were parsed');
  assert.equal(newest.agents.length, 0, 'the newest turn launched nothing');
  const now = ms(20);
  const live = liveOpenChildren(new Map([['sess', sessionOutcomeOf(read)]]), () => now - 60_000, new Map(), now);
  const children = new Set(live.get('sess'));
  const card = toCard(newest, true, now, [], null, false, children);
  const chip = card.chips.find((one) => one.metric === 'agents');
  assert.equal(card.statusWord, 'finished');
  assert.equal(openChildCounts(live).get('sess'), 1, 'the rail counts one subagent');
  assert.equal(chip?.running, 1, 'the newest card draws no running figure for the child the rail counts');
  assert.equal(chip?.label, '1 subagent');
  assert.equal(chip?.detailList?.heading?.label, '1 subagent started before this turn');
  // The older card launched the child and draws its own row. It counts no carried subagent,
  // even beside a second live child that another turn launched.
  const older = toCard(first, false, now, [], null, false, new Set([...children, 'x2'])).chips.find(
    (one) => one.metric === 'agents',
  );
  assert.deepEqual(
    {
      label: older?.label,
      running: older?.running,
      heading: older?.detailList?.heading?.label,
      footer: older?.detailList?.footer,
    },
    { label: '1 subagent', running: 1, heading: '1 subagent in this turn', footer: undefined },
    'the older card counts only its own row',
  );
  // Running and stopped newest turns supply no carried-subagent figure.

  const railFor = (outcome: TurnOutcome) =>
    sessionStatusOf([], new Set(), new Map([['sess', outcome]]), now, new Set(), new Map(), openChildCounts(live)).get(
      'sess',
    );
  const runningTurn = { ...newest, finished: false, endedAt: now - 1_000 };
  const stoppedTurn = { ...newest, finished: false, processEndedAt: ms(6) };
  const stoppedOwn = { ...first, finished: false, processEndedAt: ms(6) };
  const figureOf = (card: ReturnType<typeof toCard>) => card.chips.find((one) => one.metric === 'agents')?.running;
  assert.deepEqual(
    {
      running: {
        status: statusOf(runningTurn, true, now),
        card: figureOf(toCard(runningTurn, true, now, [], null, false, children)),
      },
      stopped: {
        status: statusOf(stoppedTurn, true, now),
        card: figureOf(toCard(stoppedTurn, true, now, [], null, false, children)),
      },
      stoppedOwn: {
        status: statusOf(stoppedOwn, true, now),
        card: figureOf(toCard(stoppedOwn, true, now, [], null, false, children)),
      },
    },
    {
      running: { status: 'running', card: undefined },
      stopped: { status: 'stopped', card: undefined },
      stoppedOwn: { status: 'stopped', card: undefined },
    },
  );
  const outcome = sessionOutcomeOf(read)!;
  assert.equal(
    railFor({ ...outcome, finished: false, processEndedAt: ms(6) }),
    'stopped',
    'the rail counts no child on a stopped turn',
  );
  assert.equal(railFor({ ...outcome, finished: false, endedAt: now - 1_000 }), 'running');
  // A live child whose row on the newest turn reads closed is still one the rail counts.
  const closedRow = { ...newest, agents: [{ ...first.agents[0], status: 'completed' }] };
  assert.equal(
    figureOf(toCard(closedRow, true, now, [], null, false, children)),
    1,
    'the newest card counts every live child the rail counts',
  );
});

// Cached outcomes retain carried subagents without closed-child facts.

test('a session at rest keeps its carried subagent through the derived cache', () => {
  const read = readSession(
    writeTranscript([
      userPrompt('scan in the background', 0),
      assistantTool('Agent', 1, 'bg1', { description: 'Scan x1', run_in_background: true }),
      backgroundLaunch('bg1', 'x1', 2),
      assistantAnswer('The scan is running.', 3),
      userPrompt('anything else?', 4),
      assistantAnswer('Nothing else yet.', 5),
    ]),
    'sess',
  );
  const newest = [...read.turns].sort((a, b) => b.startedAt - a.startedAt)[0];
  const stored = sessionOutcomeOf(read);
  assert.deepEqual(stored?.openChildren, ['x1'], 'the stored outcome holds the open child');
  assert.equal(stored?.closedChildren, undefined, 'nothing closed, so the outcome names none');
  const entry: DerivedTitleEntry = {
    mtimeMs: 10,
    size: 20,
    label: 'A session',
    fullLabel: 'A session',
    activityMs: 30,
    agentRun: false,
    outcome: stored,
    stats: null,
    starts: { starts: [0], whole: true },
    foldedLabel: 'a session',
  };
  const cacheFile = path.join(tempDir('carried-cache-'), 'cache.json');
  saveDerivedCache(cacheFile, [['/sess.jsonl', entry]]);
  const cached = loadDerivedCache(cacheFile).titles.get('/sess.jsonl')?.outcome ?? null;
  const now = ms(20);
  const outcomes = new Map([['sess', cached]]);
  const live = liveOpenChildren(outcomes, () => now - 60_000, new Map(), now);
  const counts = openChildCounts(live);
  const chip = toCard(newest, true, now, [], null, false, new Set(live.get('sess'))).chips.find(
    (one) => one.metric === 'agents',
  );
  assert.deepEqual(
    {
      status: sessionStatusOf([], new Set(), outcomes, now, new Set(), new Map(), counts).get('sess'),
      rail: counts.get('sess'),
      card: chip?.running,
      heading: chip?.detailList?.heading?.label,
    },
    { status: 'subagents', rail: 1, card: 1, heading: '1 subagent started before this turn' },
  );

  saveDerivedCache(cacheFile, [
    [
      '/legacy.jsonl',
      {
        ...entry,
        outcome: { ...stored!, openChildren: undefined, closedChildren: ['x1'] },
      },
    ],
  ]);
  assert.deepEqual(
    loadDerivedCache(cacheFile).titles.get('/legacy.jsonl')?.outcome?.closedChildren,
    ['x1'],
    'a persisted id without a close time still loads',
  );

  const commands = [{ id: 'cmd1', startedAt: ms(1) }];
  saveDerivedCache(cacheFile, [
    ['/command.jsonl', { ...entry, outcome: { ...stored!, backgroundCommands: commands } }],
  ]);
  assert.deepEqual(loadDerivedCache(cacheFile).titles.get('/command.jsonl')?.outcome?.backgroundCommands, commands);
  const unstamped = [{ id: 'cmd1' }] as unknown as typeof commands;
  saveDerivedCache(cacheFile, [
    ['/unstamped.jsonl', { ...entry, outcome: { ...stored!, backgroundCommands: unstamped } }],
  ]);
  assert.equal(
    loadDerivedCache(cacheFile).titles.get('/unstamped.jsonl')?.outcome?.backgroundCommands,
    undefined,
    'a command without a launch time is refused',
  );
  saveDerivedCache(cacheFile, [['/tail.jsonl', { ...entry, outcome: null, backgroundCommands: commands }]]);
  assert.deepEqual(
    loadDerivedCache(cacheFile).titles.get('/tail.jsonl')?.backgroundCommands,
    commands,
    'commands beside no tail outcome',
  );
  saveDerivedCache(cacheFile, [['/tail-unstamped.jsonl', { ...entry, outcome: null, backgroundCommands: unstamped }]]);
  assert.equal(
    loadDerivedCache(cacheFile).titles.get('/tail-unstamped.jsonl'),
    undefined,
    'an unstamped command beside no tail outcome is refused',
  );
});

// A completion observed by metadata or lifetime readers prevents a parsed open row from reopening the child.

test('a child that any read closed does not count as open', () => {
  const { tail, full, lifetime } = outcomeReaders([
    userPrompt('scan in the background', 0),
    assistantTool('Agent', 1, 'bg1', { description: 'Scan x1', run_in_background: true }),
    backgroundLaunch('bg1', 'x1', 2),
    assistantAnswer('The scan is running.', 3),
    {
      type: 'user',
      timestamp: at(4),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: '<task-notification><task-id>x1</task-id><status>completed</status></task-notification>',
      },
    },
    assistantAnswer('The scan is back.', 5),
    userPrompt('anything else?', 6),
    assistantAnswer('Nothing else.', 7),
  ]);
  assert.deepEqual(full?.openChildren, ['x1'], 'the parsed window keeps the row open');
  assert.equal(tail?.openChildren, undefined, 'the tail read closed the child');
  assert.equal(lifetime?.openChildren, undefined, 'the lifetime facts closed the child');
  const merged = outcomeWithWiderChildren(tail, lifetime, full);
  const now = ms(20);
  assert.deepEqual(
    liveOpenChildren(new Map([['sess', merged]]), () => now - 60_000, new Map(), now),
    new Map(),
  );
});

// A launch outside the metadata tail remains available through the parsed window for live-child counts.

test('the rail counts a live child only the parsed window holds', () => {
  const file = writeTranscript([
    userPrompt('scan in the background', 0),
    assistantTool('Agent', 1, 'bg1', { description: 'Scan x1', run_in_background: true }),
    backgroundLaunch('bg1', 'x1', 2),
    assistantAnswer(`The scan is running. ${'x'.repeat(8_000)}`, 3),
    userPrompt('anything else?', 4),
    assistantAnswer('Nothing else yet.', 5),
  ]);
  const tail = readSessionMeta(file, 2_048, 'sess').outcome;
  assert.equal(tail?.startedAt, ms(4), 'the tail reaches the newest turn');
  assert.equal(tail?.openChildren, undefined, 'the tail does not reach the launch');
  const read = readSession(file, 'sess');
  const launched = read.turns.find((turn) => turn.agents.length > 0);
  assert.ok(launched, 'the parsed window holds the launch');
  const now = ms(20);
  const outcomes = new Map([['sess', outcomeWithWiderChildren(tail, null, sessionOutcomeOf(read))]]);
  const live = liveOpenChildren(outcomes, () => now - 60_000, new Map(), now);
  const chip = toCard(launched, false, now, [], null, false, new Set(live.get('sess'))).chips.find(
    (one) => one.metric === 'agents',
  );
  assert.deepEqual({ rail: openChildCounts(live).get('sess'), card: chip?.running }, { rail: 1, card: 1 });
});

test('session metadata skips an ordinary successful tool result like the full parser', () => {
  const file = writeTranscript([
    userPrompt('run the command', 0),
    assistantTool('Bash', 1, 't1'),
    {
      type: 'user',
      timestamp: at(4),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ordinary output' }] },
      toolUseResult: { stdout: 'ordinary output' },
    },
  ]);
  const parsed = readTurns(file, 'sess')[0];
  assert.equal(parsed.endedAt, ms(1));
  assert.equal(readSessionMeta(file).outcome?.endedAt, parsed.endedAt);
});

// A completed single-prompt session without reader evidence receives agent-run classification.

test('a session with no sign of a person in it is an agent run', () => {
  const run = writeTranscript([
    userPrompt('write the closing message for a long working turn', 0),
    assistantAnswer('Here it is.', 12),
  ]);
  assert.equal(readSessionMeta(run).agentRun, true);
});

test('any one sign of a person is enough to say a person was there', () => {
  // Each case closes its turn before reader evidence determines its classification.

  const done = assistantAnswer('done', 1);
  const cases: [string, object[]][] = [
    [
      'a second prompt',
      [userPrompt('first', 0), done, userPrompt('and now this', 5), assistantAnswer('done again', 6)],
    ],
    [
      'an editor selection',
      [userPrompt('<ide_selection>lines 1 to 4 of store.ts</ide_selection>\nrename this', 0), done],
    ],
    ['an opened file', [userPrompt('<ide_opened_file>store.ts</ide_opened_file>\nwhat does this do', 0), done]],
    [
      'an editor diagnostic',
      [userPrompt('<ide_diagnostics>store.ts has 2 errors</ide_diagnostics>\nfix them', 0), done],
    ],
    ['a slash command', [userPrompt('<command-name>/model</command-name>', 0), done]],
    [
      'a remote-control bridge record',
      [userPrompt('one ask', 0), done, { type: 'bridge-session', bridgeSessionId: 'cse_1' }],
    ],
    ['a local command record', [userPrompt('one ask', 0), done, { type: 'system', subtype: 'local_command' }]],
    [
      'a system record of a kind the rule does not know',
      [userPrompt('one ask', 0), done, { type: 'system', subtype: 'a_later_kind' }],
    ],
    ['a system record with no kind', [userPrompt('one ask', 0), done, { type: 'system' }]],
    ['a prompt with a human origin', [userPrompt('one ask', 0, { origin: { kind: 'human' } }), done]],
    [
      'a refused tool call',
      [
        userPrompt('one ask', 0),
        done,
        { type: 'user', timestamp: at(2), toolDenialKind: 'user-rejected', message: { role: 'user', content: [] } },
      ],
    ],
    ['a question put to the reader', [userPrompt('one ask', 0), assistantTool('AskUserQuestion', 1, 'q1'), done]],
    // A second typed prompt counts even without promptId.

    [
      'a second prompt with no id of its own',
      [
        userPrompt('first', 0),
        done,
        {
          type: 'user',
          timestamp: at(5),
          message: { role: 'user', content: [{ type: 'text', text: 'and now this' }] },
        },
        assistantAnswer('done again', 6),
      ],
    ],
  ];
  for (const [what, lines] of cases) {
    assert.equal(readSessionMeta(writeTranscript(lines)).agentRun, false, `${what} was not read as a person`);
  }
});

test('the system records Claude Code writes with nobody present are no sign of a person', () => {
  for (const subtype of ['stop_hook_summary', 'compact_boundary', 'turn_duration', 'api_error', 'informational']) {
    const run = writeTranscript([
      userPrompt('review the diff and report', 0, { origin: { kind: 'sdk' }, entrypoint: 'sdk-cli' }),
      assistantAnswer('Reported.', 4),
      { type: 'system', subtype, timestamp: at(5) },
    ]);
    assert.equal(readSessionMeta(run).agentRun, true, `a ${subtype} record was read as a person`);
  }
});

// Editor entrypoint compaction establishes reader evidence without a recorded origin.

test('a compaction record in an editor session is a sign of a person', () => {
  const editor = writeTranscript([
    userPrompt('walk me through the store module', 0, { entrypoint: 'claude-vscode', version: '2.1.195' }),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(3), entrypoint: 'claude-vscode' },
    assistantAnswer('Here is how it fits together.', 4),
  ]);
  assert.equal(readSessionMeta(editor).agentRun, false, 'an editor session that compacted was read as an agent run');
});

test('a follow-up the reader typed while the agent worked is a second prompt', () => {
  const followed = writeTranscript([
    userPrompt('review the diff and report', 0, { entrypoint: 'sdk-cli' }),
    queued({ commandMode: 'prompt', prompt: 'and check the docs too' }, 1),
    assistantAnswer('Reported.', 2),
  ]);
  assert.equal(readSessionMeta(followed).agentRun, false, 'a queued follow-up was not counted as a prompt');
  const notified = writeTranscript([
    userPrompt('review the diff and report', 0, { entrypoint: 'sdk-cli' }),
    queued({ commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>' }, 1),
    assistantAnswer('Reported.', 2),
  ]);
  assert.equal(readSessionMeta(notified).agentRun, true, 'a background task notice was counted as a prompt');
});

// A finished single-prompt run from an SDK caller, whose tool result pads it past one read chunk.
function sdkRunLines(padding: string): object[] {
  return [
    userPrompt('review the diff and report', 0, { entrypoint: 'sdk-cli' }),
    assistantTool('Bash', 1, 'b1'),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: padding }] },
    },
    assistantAnswer('Reported.', 3),
  ];
}

test('the agent-run scan never answers run while the final line has no newline', () => {
  const file = writeTranscript(sdkRunLines('x'.repeat(300 * 1024)));
  const complete = fs.statSync(file).size;
  assert.equal(agentRunOfScan(scanForAgentRun(file, complete), complete), true);
  fs.appendFileSync(file, JSON.stringify(userPrompt('and the tests', 4)));
  const size = fs.statSync(file).size;
  const scan = scanForAgentRun(file, size);
  assert.equal(scan.bytes, complete);
  assert.equal(agentRunOfScan(scan, size), false, 'a scan that has not read the final line answered run');
});

test('the agent-run scan reads a character split across two read chunks', () => {
  const chunk = 256 * 1024;
  const build = (lead: string) => {
    const file = writeTranscript(sdkRunLines(lead + '€'.repeat(100_000)));
    return { file, bytes: fs.readFileSync(file) };
  };
  let built = build('');
  const shift = (chunk - built.bytes.indexOf('€')) % 3;
  if (shift === 0) {
    built = build('x');
  }
  assert.equal(built.bytes[chunk] & 0xc0, 0x80, 'the fixture no longer splits a character across the chunk boundary');
  const scan = scanForAgentRun(built.file, built.bytes.length);
  assert.equal(scan.bytes, built.bytes.length);
  assert.equal(agentRunOfScan(scan, built.bytes.length), true, 'a line crossing the chunk boundary did not parse');
});

// Person scans and child spend use the same reader evidence as agentRunIn.

test('a dispatched session reads as a person only on a sign a person leaves', () => {
  const bg = { sessionKind: 'bg' };
  const human = { origin: { kind: 'human' } };
  const launch = userPrompt('Review the branch', 1, { ...bg, ...human });
  const slashLaunch = userPrompt('<command-name>/review-and-report</command-name>', 1, { ...bg, ...human });
  const queuedPrompt = (origin: Record<string, unknown>, text: string) =>
    queued({ commandMode: 'prompt', ...origin, prompt: [{ type: 'text', text }] }, 3);
  const denied = (kind: string) => ({
    type: 'user',
    timestamp: at(3),
    toolDenialKind: kind,
    message: { role: 'user', content: [] },
  });
  const cases: Array<[string, object[], boolean]> = [
    ['a background launch prompt', [launch, assistantAnswer('Reviewed.', 2)], false],
    [
      'a launch prompt after the record that names the background',
      [
        { type: 'system', subtype: 'informational', sessionKind: 'bg', timestamp: at(0) },
        userPrompt('Review the branch', 1, human),
      ],
      false,
    ],
    [
      'a human-origin prompt after the launch',
      [launch, userPrompt('Use the other fixture', 3, { ...bg, ...human })],
      true,
    ],
    ["a non-background child's first human-origin prompt", [userPrompt('Review the branch', 1, human)], true],
    ['an SDK follow-up', [launch, userPrompt('Continue', 3, { ...bg, promptSource: 'sdk' })], false],
    ['a human-origin queued follow-up', [launch, queuedPrompt(human, 'Stop there')], true],
    ['a queued follow-up with no origin', [launch, queuedPrompt({}, 'Stop there')], true],
    ['a peer hand-back', [launch, queuedPrompt({ origin: { kind: 'peer' } }, 'Handed back')], false],
    [
      'a task notice',
      [launch, queued({ commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>' }, 3)],
      false,
    ],
    ['an editor tag on a later prompt', [launch, userPrompt('<ide_selection>x</ide_selection> fix this', 3, bg)], true],
    [
      'an editor tag quoted in the launch prompt',
      [userPrompt('Check the <ide_selection> tag', 1, { ...bg, ...human })],
      false,
    ],
    [
      'an editor tag quoted in an SDK follow-up',
      [launch, userPrompt('Check the <ide_opened_file> tag', 3, { ...bg, promptSource: 'sdk' })],
      false,
    ],
    ['a tool call the reader refused', [launch, denied('user-rejected')], true],
    ['a tool call a permission rule refused', [launch, denied('permission-rule')], false],
    [
      'a human-origin slash command',
      [launch, userPrompt('<command-name>/review</command-name>', 3, { ...bg, ...human })],
      true,
    ],
    [
      'a human-origin slash command marked meta',
      [launch, userPrompt('<command-name>/review</command-name>', 3, { ...bg, ...human, isMeta: true })],
      true,
    ],
    ['a background launch prompt that is a slash command', [slashLaunch, assistantAnswer('Reviewed.', 2)], false],
    [
      'a repeated background launch command',
      [{ ...slashLaunch, uuid: 'l' }, assistantAnswer('Reviewed.', 2), { ...slashLaunch, uuid: 'l' }],
      false,
    ],
    [
      'a repeated background launch prompt',
      [{ ...launch, uuid: 'l' }, assistantAnswer('Reviewed.', 2), { ...launch, uuid: 'l' }],
      false,
    ],
    [
      'a human-origin slash command after a slash-command launch',
      [slashLaunch, userPrompt('<command-name>/review</command-name>', 3, { ...bg, ...human })],
      true,
    ],
  ];
  for (const [name, lines, person] of cases) {
    const file = writeTranscript(lines);
    assert.equal(scanForPerson(file, fs.statSync(file).size).person, person, name);
    assert.equal(readClaudeAgentSpend(file, [], false).person === true, person, `${name}, in the spend read`);
    if (person) {
      assert.equal(
        agentRunIn(fs.readFileSync(file, 'utf8').split('\n'), true),
        false,
        `${name} is no person to agentRunIn`,
      );
    }
  }
});

// An end-position scan counts a later launch prompt as the first prompt it observes.

test('a dispatched session read from its end counts no prompt it could not see', () => {
  const file = writeTranscript([{ type: 'system', subtype: 'informational', sessionKind: 'bg', timestamp: at(0) }]);
  const end = fs.statSync(file).size;
  let scan = scanForPerson(file, end, undefined, end);
  fs.appendFileSync(file, JSON.stringify(userPrompt('Review the branch', 1, { origin: { kind: 'human' } })) + '\n');
  scan = scanForPerson(file, fs.statSync(file).size, scan);
  assert.equal(scan.person, false, 'the launch prompt written after discovery read as a person');
  fs.appendFileSync(
    file,
    JSON.stringify(
      queued({ commandMode: 'prompt', origin: { kind: 'human' }, prompt: [{ type: 'text', text: 'Stop there' }] }, 2),
    ) + '\n',
  );
  scan = scanForPerson(file, fs.statSync(file).size, scan);
  assert.equal(scan.person, true, 'a queued follow-up read from the end did not read as a person');
});

test('a dispatched session read from its end skips a repeated launch command', () => {
  const launch = {
    ...userPrompt('<command-name>/review-and-report</command-name>', 1, {
      sessionKind: 'bg',
      origin: { kind: 'human' },
    }),
    uuid: 'l',
  };
  const file = writeTranscript([launch, assistantAnswer('Reviewed.', 2)]);
  const end = fs.statSync(file).size;
  let scan = scanForPerson(file, end, undefined, end);
  fs.appendFileSync(file, JSON.stringify(launch) + '\n');
  scan = scanForPerson(file, fs.statSync(file).size, scan);
  assert.equal(scan.person, false, 'a repeated launch command read as a person');
  fs.appendFileSync(file, JSON.stringify({ ...launch, uuid: 'm', timestamp: at(3) }) + '\n');
  scan = scanForPerson(file, fs.statSync(file).size, scan);
  assert.equal(scan.person, true, 'a new human-origin command did not read as a person');
});

// An end-position scan distinguishes a later slash-command launch from a follow-up after an earlier launch.

test('a dispatched session read from its end tells a slash-command launch from a person', () => {
  const bg = { sessionKind: 'bg' };
  const human = { origin: { kind: 'human' } };
  const header = [
    { type: 'custom-title', customTitle: 'review', sessionId: 's' },
    { type: 'mode', mode: 'default', sessionId: 's' },
    { type: 'file-history-snapshot', messageId: 'm', snapshot: { trackedFileBackups: {} } },
  ];
  const append = (file: string, record: object) => fs.appendFileSync(file, JSON.stringify(record) + '\n');
  const slash = (name: string, n: number) =>
    userPrompt(`<command-name>/${name}</command-name>`, n, { ...bg, ...human });
  const early = writeTranscript(header);
  let end = fs.statSync(early).size;
  let scan = scanForPerson(early, end, undefined, end);
  append(early, slash('review-and-report', 1));
  scan = scanForPerson(early, fs.statSync(early).size, scan);
  assert.equal(scan.person, false, 'a slash-command launch written after discovery read as a person');
  const late = writeTranscript([
    ...header,
    userPrompt('Review the branch', 1, { ...bg, ...human }),
    assistantAnswer('Reviewed.', 2),
  ]);
  end = fs.statSync(late).size;
  scan = scanForPerson(late, end, undefined, end);
  append(late, slash('review', 3));
  scan = scanForPerson(late, fs.statSync(late).size, scan);
  assert.equal(scan.person, true, 'a slash command a person typed after the launch did not read as a person');
});

// A first unfinished turn remains outside agent-run classification.

test('a session still inside its first turn is not called a run', () => {
  const live = writeTranscript([
    userPrompt('why is the panel slow', 0),
    assistantTool('Read', 1, 't1', { file_path: 'store.ts' }),
    {
      type: 'user',
      promptId: 'p1',
      sourceToolAssistantUUID: 'a1',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    },
    assistantText('still looking', 3),
  ]);
  assert.equal(readSessionMeta(live).agentRun, false);
  // The same session once its turn closes.
  const over = writeTranscript([
    userPrompt('why is the panel slow', 0),
    assistantTool('Read', 1, 't1', { file_path: 'store.ts' }),
    assistantAnswer('Because the rail re-reads every tail.', 3),
  ]);
  assert.equal(readSessionMeta(over).agentRun, true);
});

// Sidechain answers leave the parent's first turn unfinished.

test('a subagent answering does not close the turn the reader is still in', () => {
  const live = writeTranscript([
    userPrompt('why is the panel slow', 0),
    assistantTool('Task', 1, 't1', { prompt: 'go and look at the rail' }),
    { ...assistantAnswer('the subagent finished', 2), isSidechain: true },
    assistantText('still looking', 3),
  ]);
  assert.equal(readSessionMeta(live).agentRun, false);
});

// Synthetic assistant records leave the first turn unfinished.

test('a record the harness wrote does not close the turn either', () => {
  const live = writeTranscript([
    userPrompt('why is the panel slow', 0),
    assistantTool('Read', 1, 't1', { file_path: 'store.ts' }),
    {
      type: 'assistant',
      timestamp: at(2),
      message: {
        role: 'assistant',
        model: '<synthetic>',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    },
  ]);
  assert.equal(readSessionMeta(live).agentRun, false);
});

// Malformed complete lines leave classification unavailable. An unfinished final line waits for a later read.

test('a complete line that will not parse leaves the question unanswered rather than assumed', () => {
  const dir = tempDir('tl-');
  const file = path.join(dir, 'sess.jsonl');
  const whole = [userPrompt('one ask', 0), assistantAnswer('done', 1)].map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(file, whole + '\n');
  assert.equal(readSessionMeta(file).agentRun, true);
  fs.writeFileSync(file, whole + '\n{"type":"system"\n');
  assert.equal(readSessionMeta(file).agentRun, null, 'a complete line that will not parse was answered');
  fs.writeFileSync(file, whole + '\n{"type":"system"');
  assert.equal(readSessionMeta(file).agentRun, true, 'a half-written last record changed the answer');
  // A null JSON value leaves classification available without a record to inspect.

  fs.writeFileSync(file, whole + '\nnull\n');
  assert.equal(readSessionMeta(file).agentRun, true);
});

// An edit call without an SDK entrypoint supplies reader evidence.

test('a changed file with no SDK entrypoint is never an agent run', () => {
  // The edit call establishes intent without requiring a result.

  const fixed = writeTranscript([
    userPrompt('help, on windows i get a hook error', 0),
    assistantTool('Edit', 4, 'e1', { file_path: 'scripts/register-hooks.js' }),
    assistantAnswer('Fixed.', 6),
  ]);
  assert.equal(readSessionMeta(fixed).agentRun, false);
  // A read is not a change, or nothing an agent ran would ever be marked.
  const looked = writeTranscript([
    userPrompt('what does register-hooks do', 0),
    assistantTool('Read', 4, 'r1', { file_path: 'scripts/register-hooks.js' }),
    assistantAnswer('It registers them.', 6),
  ]);
  assert.equal(readSessionMeta(looked).agentRun, true);
});

// An SDK-only session can retain agent-run classification after a file change.

test('a changed file under an SDK entrypoint is an agent run, tail read and whole-file scan alike', () => {
  const small = writeTranscript(sdkFileChangeTranscript('ok'));
  assert.equal(
    readSessionMeta(small).agentRun,
    true,
    'the tail read still called a changed file a person under sdk-cli',
  );

  const file = writeTranscript(sdkFileChangeTranscript('x'.repeat(300 * 1024)));
  const complete = fs.statSync(file).size;
  assert.equal(
    agentRunOfScan(scanForAgentRun(file, complete), complete),
    true,
    'the whole-file scan still called a changed file a person under sdk-cli',
  );

  // File-change classification accepts an SDK entrypoint recorded after the Write call.

  const lateEntrypoint = (padding: string): object[] => [
    userPrompt('write the plan file', 0),
    assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
    {
      type: 'user',
      timestamp: at(2),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: padding }] },
    },
    assistantAnswer('Wrote the plan.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(lateEntrypoint('ok'))).agentRun,
    true,
    'the tail read held a changed file against a person once the sdk-cli entrypoint named itself late',
  );
  const lateFile = writeTranscript(lateEntrypoint('x'.repeat(300 * 1024)));
  const lateComplete = fs.statSync(lateFile).size;
  assert.equal(
    agentRunOfScan(scanForAgentRun(lateFile, lateComplete), lateComplete),
    true,
    'the whole-file scan held a changed file against a person once the sdk-cli entrypoint named itself late',
  );
});

// Classify the complete transcript through the incremental agent-run scan.

function scannedAgentRun(lines: object[]): boolean {
  const file = writeTranscript(lines);
  const complete = fs.statSync(file).size;
  return agentRunOfScan(scanForAgentRun(file, complete), complete);
}

test('the SDK file-change exception does not reach a terminal entrypoint or a human prompt', () => {
  const terminal = writeTranscript([
    userPrompt('write the plan file', 0, { entrypoint: 'cli' }),
    assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
    assistantAnswer('Wrote the plan.', 2),
  ]);
  assert.equal(
    readSessionMeta(terminal).agentRun,
    false,
    'a changed file under a terminal entrypoint was read as a run',
  );
  assert.equal(
    scannedAgentRun([
      userPrompt('write the plan file', 0, { entrypoint: 'cli' }),
      assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
      {
        type: 'user',
        timestamp: at(2),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'x'.repeat(300 * 1024) }],
        },
      },
      assistantAnswer('Wrote the plan.', 3),
    ]),
    false,
    'the whole-file scan read a changed file under a terminal entrypoint as a run',
  );

  const humanPrompt = writeTranscript([
    userPrompt('write the plan file', 0, { entrypoint: 'sdk-cli', origin: { kind: 'human' } }),
    assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
    assistantAnswer('Wrote the plan.', 2),
  ]);
  assert.equal(
    readSessionMeta(humanPrompt).agentRun,
    false,
    'a human origin under an SDK entrypoint was read as a run',
  );
  assert.equal(
    scannedAgentRun([
      userPrompt('write the plan file', 0, { entrypoint: 'sdk-cli', origin: { kind: 'human' } }),
      assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
      {
        type: 'user',
        timestamp: at(2),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'x'.repeat(300 * 1024) }],
        },
      },
      assistantAnswer('Wrote the plan.', 3),
    ]),
    false,
    'the whole-file scan read a human origin under an SDK entrypoint as a run',
  );

  // A terminal entrypoint recorded after the Write call retains reader classification.

  const changeFirst = [
    userPrompt('write the plan file', 0),
    assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
    {
      type: 'user',
      timestamp: at(2),
      entrypoint: 'cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] },
    },
    assistantAnswer('Wrote the plan.', 3),
  ];
  assert.equal(
    agentRunIn(
      changeFirst.map((l) => JSON.stringify(l)),
      true,
    ),
    false,
    'the tail reader excused a changed file that led a late terminal entrypoint',
  );
  assert.equal(
    scannedAgentRun([
      userPrompt('write the plan file', 0),
      assistantTool('Write', 1, 'w1', { file_path: '.claude/plans/plan.md' }),
      {
        type: 'user',
        timestamp: at(2),
        entrypoint: 'cli',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'x'.repeat(300 * 1024) }],
        },
      },
      assistantAnswer('Wrote the plan.', 3),
    ]),
    false,
    'the whole-file scan excused a changed file that led a late terminal entrypoint',
  );
});

// Padding moves earlier reader evidence beyond the metadata tail without changing that evidence.

function padded(second: number, padding: string): object {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pad', content: padding }] },
  };
}

// Permission-rule denials permit SDK-only agent-run classification. User-rejected denials establish reader evidence under every entrypoint.

test('a rule denial under an SDK entrypoint follows the same exception as a changed file', () => {
  const excusedLines = (padding: string): object[] => [
    userPrompt('run the safe commands', 0, { entrypoint: 'sdk-cli' }),
    { type: 'user', timestamp: at(1), toolDenialKind: 'permission-rule', message: { role: 'user', content: [] } },
    padded(2, padding),
    assistantAnswer('Done.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(excusedLines('ok'))).agentRun,
    true,
    'a rule denial under sdk-cli was read as a person',
  );
  assert.equal(
    scannedAgentRun(excusedLines('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan read a rule denial under sdk-cli as a person',
  );

  const terminalLines = (padding: string): object[] => [
    userPrompt('run the safe commands', 0, { entrypoint: 'cli' }),
    { type: 'user', timestamp: at(1), toolDenialKind: 'permission-rule', message: { role: 'user', content: [] } },
    padded(2, padding),
    assistantAnswer('Done.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(terminalLines('ok'))).agentRun,
    false,
    'a rule denial under a terminal entrypoint was read as a run',
  );
  assert.equal(
    scannedAgentRun(terminalLines('x'.repeat(300 * 1024))),
    false,
    'the whole-file scan read a rule denial under a terminal entrypoint as a run',
  );

  const rejectedLines = (padding: string): object[] => [
    userPrompt('run the safe commands', 0, { entrypoint: 'sdk-cli' }),
    { type: 'user', timestamp: at(1), toolDenialKind: 'user-rejected', message: { role: 'user', content: [] } },
    padded(2, padding),
    assistantAnswer('Done.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(rejectedLines('ok'))).agentRun,
    false,
    'a reader rejection under sdk-cli was read as a run',
  );
  assert.equal(
    scannedAgentRun(rejectedLines('x'.repeat(300 * 1024))),
    false,
    'the whole-file scan read a reader rejection under sdk-cli as a run',
  );

  // The denial arrives before the record naming the sdk-cli entrypoint, on both readers.
  const denialFirst = (padding: string): object[] => [
    userPrompt('run the safe commands', 0),
    { type: 'user', timestamp: at(1), toolDenialKind: 'permission-rule', message: { role: 'user', content: [] } },
    {
      type: 'user',
      timestamp: at(2),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pad', content: padding }] },
    },
    assistantAnswer('Done.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(denialFirst('ok'))).agentRun,
    true,
    'the tail read held a rule denial against a person once the sdk-cli entrypoint named itself late',
  );
  assert.equal(
    scannedAgentRun(denialFirst('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan held a rule denial against a person once the sdk-cli entrypoint named itself late',
  );
});

test("a slash command with no origin in an SDK-only session is the run's own prompt", () => {
  assert.equal(
    readSessionMeta(writeTranscript(sdkSlashCommandTranscript())).agentRun,
    true,
    'the tail read called an SDK slash command a person',
  );
  assert.equal(
    scannedAgentRun(sdkSlashCommandTranscript('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan called an SDK slash command a person',
  );

  // SDK-only classification accepts an entrypoint recorded after the slash command.

  const entrypointLate = (padding: string): object[] => [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<command-message>hello</command-message>\n<command-name>/hello</command-name>' },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at(1),
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Say hello back' }] },
    },
    assistantTool('Bash', 2, 'b1', { command: 'echo hi' }),
    {
      type: 'user',
      timestamp: at(3),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: padding }] },
    },
    assistantAnswer('Hello!', 4),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(entrypointLate('ok'))).agentRun,
    true,
    'the tail read held an SDK slash command against a person once the sdk-cli entrypoint named itself late',
  );
  assert.equal(
    scannedAgentRun(entrypointLate('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan held an SDK slash command against a person once the sdk-cli entrypoint named itself late',
  );
});

test('a slash command with a human origin under sdk-cli is still a person', () => {
  const humanCommand = writeTranscript([
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'sdk-cli',
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<command-message>hello</command-message>\n<command-name>/hello</command-name>' },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at(1),
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Say hello back' }] },
    },
    assistantAnswer('Hello!', 2),
  ]);
  assert.equal(
    readSessionMeta(humanCommand).agentRun,
    false,
    "a slash command Arc's own panel sent under sdk-cli was read as a run",
  );
});

test("a background session's one prompt reads as an agent run, tail read and whole-file scan alike", () => {
  assert.equal(
    readSessionMeta(writeTranscript(bgSessionTranscript())).agentRun,
    true,
    'the tail read called a background session a person',
  );
  assert.equal(
    scannedAgentRun(bgSessionTranscript('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan called a background session a person',
  );

  // A bridge record preceding the background marker preserves background agent-run classification.

  const bridgeFirst = (padding: string): object[] => [
    {
      type: 'bridge-session',
      timestamp: at(0),
      sessionId: 'sess',
      bridgeSessionId: 'bridge-1',
      lastSequenceNum: 1,
      ownerAccountUuid: 'acct-1',
      ownerOrganizationUuid: 'org-1',
    },
    userPrompt('fix the failing lint rule', 1, { entrypoint: 'cli', origin: { kind: 'human' }, sessionKind: 'bg' }),
    { type: 'system', timestamp: at(2), subtype: 'stop_hook_summary' },
    assistantTool('Edit', 3, 'e1', { file_path: 'lint.config.ts' }),
    {
      type: 'user',
      timestamp: at(4),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    assistantAnswer('Fixed the rule.', 5),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(bridgeFirst('ok'))).agentRun,
    true,
    'the tail read held a bridge-session record against a person once sessionKind named the session background late',
  );
  assert.equal(
    scannedAgentRun(bridgeFirst('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan held a bridge-session record against a person once sessionKind named the session background late',
  );
});

// A background slash-command launch counts like a typed launch. A later human-origin command establishes reader evidence.

test("a background session's slash-command launch reads as its typed launch does", () => {
  const command = (name: string, n: number, extra: object = {}): object => ({
    type: 'user',
    timestamp: at(n),
    entrypoint: 'cli',
    origin: { kind: 'human' },
    ...extra,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` },
      ],
    },
  });
  const slashLaunch = (padding?: string): object[] => {
    const [launch, ...rest] = bgSessionTranscript(padding);
    return [{ ...launch, ...command('review-and-report', 0, { promptId: 'p1', sessionKind: 'bg' }) }, ...rest];
  };
  for (const [form, launch] of [
    ['typed', bgSessionTranscript],
    ['slash-command', slashLaunch],
  ] as const) {
    assert.equal(
      readSessionMeta(writeTranscript(launch())).agentRun,
      true,
      `the tail read called a background session with a ${form} launch a person`,
    );
    assert.equal(
      scannedAgentRun(launch('x'.repeat(300 * 1024))),
      true,
      `the whole-file scan called a background session with a ${form} launch a person`,
    );
    assert.equal(
      readSessionMeta(writeTranscript([...launch(), command('hello', 7)])).agentRun,
      false,
      `a second slash command with a human origin after a ${form} launch was read as a run`,
    );
  }
});

test("a background session's second typed prompt is still a person", () => {
  const second = writeTranscript([...bgSessionTranscript(), userPrompt('actually also update the readme', 7)]);
  assert.equal(readSessionMeta(second).agentRun, false, "a background session's second typed prompt was read as a run");
});

// Background follow-ups with promptSource sdk and no human origin leave the counted launch prompt unchanged.

test("a background worker's dispatched follow-up is an agent run, tail read and whole-file scan alike", () => {
  assert.equal(
    readSessionMeta(writeTranscript(bgWorkerFollowUpTranscript())).agentRun,
    true,
    'the tail read called a background worker with a dispatched follow-up a person',
  );
  assert.equal(
    scannedAgentRun(bgWorkerFollowUpTranscript('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan called a background worker with a dispatched follow-up a person',
  );
});

// A second human-origin prompt establishes reader evidence even with promptSource sdk.

test("a background session's second prompt with a human origin is still a person even under promptSource: sdk", () => {
  const humanSecond = (padding: string): object[] => [
    ...bgWorkerFollowUpTranscript(padding).slice(0, 4),
    {
      type: 'user',
      promptId: 'p2',
      timestamp: at(4),
      entrypoint: 'sdk-cli',
      promptSource: 'sdk',
      origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text: 'also update the readme' }] },
    },
    assistantAnswer('Updated.', 5),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(humanSecond('ok'))).agentRun,
    false,
    'the tail read excused a human-origin second prompt under promptSource: sdk',
  );
  assert.equal(
    scannedAgentRun(humanSecond('x'.repeat(300 * 1024))),
    false,
    'the whole-file scan excused a human-origin second prompt under promptSource: sdk',
  );
});

// An SDK-shaped prompt after the background marker supplies no counted launch prompt.

test('a background session whose only prompt is a dispatched-shaped follow-up counts no prompt', () => {
  const onlyDispatchedShape = (padding: string): object[] => [
    {
      type: 'bridge-session',
      timestamp: at(0),
      sessionId: 'sess',
      bridgeSessionId: 'bridge-1',
      lastSequenceNum: 1,
      ownerAccountUuid: 'acct-1',
      ownerOrganizationUuid: 'org-1',
      sessionKind: 'bg',
    },
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(1),
      entrypoint: 'sdk-cli',
      promptSource: 'sdk',
      message: { role: 'user', content: [{ type: 'text', text: 'continue the review and report back' }] },
    },
    assistantTool('Read', 2, 'e1', { file_path: 'saved-views.ts' }),
    padded(3, padding),
    assistantAnswer('Reviewed the prototype.', 4),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(onlyDispatchedShape('ok'))).agentRun,
    false,
    'the tail read counted a dispatched-shaped prompt with sessionKind: bg already known',
  );
  assert.equal(
    scannedAgentRun(onlyDispatchedShape('x'.repeat(300 * 1024))),
    false,
    'the whole-file scan counted a dispatched-shaped prompt with sessionKind: bg already known',
  );
});

// An away_summary record preserves background agent-run classification.

test('an away_summary record in a background session is an agent run, tail read and whole-file scan alike', () => {
  assert.equal(
    readSessionMeta(writeTranscript(bgAwaySummaryTranscript())).agentRun,
    true,
    'the tail read called a background session with an away_summary record a person',
  );
  assert.equal(
    scannedAgentRun(bgAwaySummaryTranscript('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan called a background session with an away_summary record a person',
  );
});

// An away_summary record preceding the background marker receives the same classification as one following it.

test("an away_summary record seen before sessionKind: 'bg' is still an agent run for both readers", () => {
  const awayBeforeBg = (padding: string): object[] => [
    {
      type: 'system',
      timestamp: at(0),
      subtype: 'away_summary',
      content: 'Goal was to review the saved-views prototype and report back. (disable recaps in /config)',
    },
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(1),
      entrypoint: 'cli',
      origin: { kind: 'human' },
      promptSource: 'typed',
      sessionKind: 'bg',
      message: { role: 'user', content: [{ type: 'text', text: 'review the saved-views prototype' }] },
    },
    assistantTool('Read', 2, 'e1', { file_path: 'saved-views.ts' }),
    {
      type: 'user',
      timestamp: at(3),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    assistantAnswer('Reviewed the prototype.', 4),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(awayBeforeBg('ok'))).agentRun,
    true,
    'the tail read held an away_summary record against a person once sessionKind named the session background late',
  );
  assert.equal(
    scannedAgentRun(awayBeforeBg('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan held an away_summary record against a person once sessionKind named the session background late',
  );
});

// A background agent run requires exactly one counted prompt.

test('a background session with no counted prompt is never an agent run', () => {
  const noPrompt = writeTranscript([
    { type: 'system', timestamp: at(0), subtype: 'stop_hook_summary', sessionKind: 'bg' },
    assistantAnswer('Fixed the rule.', 1),
  ]);
  assert.equal(
    readSessionMeta(noPrompt).agentRun,
    false,
    'a background session with no counted prompt was read as a run',
  );
});

test("a background session's reader rejection is still a person", () => {
  const rejected = writeTranscript([
    userPrompt('fix the failing lint rule', 0, { entrypoint: 'cli', origin: { kind: 'human' }, sessionKind: 'bg' }),
    { type: 'user', timestamp: at(1), toolDenialKind: 'user-rejected', message: { role: 'user', content: [] } },
    assistantAnswer('Stopped.', 2),
  ]);
  assert.equal(readSessionMeta(rejected).agentRun, false, "a background session's reader rejection was read as a run");
});

test('a cli session with a human prompt and a changed file, but no sessionKind, is still a person', () => {
  const changed = writeTranscript([
    userPrompt('fix the failing lint rule', 0, { entrypoint: 'cli', origin: { kind: 'human' } }),
    assistantTool('Edit', 1, 'e1', { file_path: 'lint.config.ts' }),
    assistantAnswer('Fixed the rule.', 2),
  ]);
  assert.equal(
    readSessionMeta(changed).agentRun,
    false,
    'a cli session with a human prompt and a changed file, but no sessionKind, was read as a run',
  );
});

test("a resumed SDK review's two prompts read as one agent run, tail read and whole-file scan alike", () => {
  assert.equal(
    readSessionMeta(writeTranscript(resumedSdkTranscript())).agentRun,
    true,
    'the tail read called a resumed SDK review a person',
  );
  assert.equal(
    scannedAgentRun(resumedSdkTranscript('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan called a resumed SDK review a person',
  );
});

test('a resumed SDK review with a human-origin second prompt is still a person', () => {
  const humanSecond = writeTranscript([
    userPrompt('review the diff', 0, { entrypoint: 'sdk-cli' }),
    assistantAnswer('Looks fine.', 1),
    userPrompt('now check the tests', 2, { entrypoint: 'sdk-cli', origin: { kind: 'human' } }),
    assistantAnswer('Tests pass.', 3),
  ]);
  assert.equal(
    readSessionMeta(humanSecond).agentRun,
    false,
    'a resumed SDK review with a human-origin second prompt was read as a run',
  );
});

// A background launch permits a human-origin first prompt under the SDK entrypoint.

test('a background session under sdk-cli with a human-origin first prompt is an agent run', () => {
  const bgSdk = (padding: string): object[] => [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'sdk-cli',
      origin: { kind: 'human' },
      sessionKind: 'bg',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the failing lint rule' }] },
    },
    { type: 'system', timestamp: at(1), subtype: 'stop_hook_summary' },
    assistantTool('Edit', 2, 'e1', { file_path: 'lint.config.ts' }),
    {
      type: 'user',
      timestamp: at(3),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    assistantAnswer('Fixed the rule.', 4),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(bgSdk('ok'))).agentRun,
    true,
    'the tail read called a background session under sdk-cli a person',
  );
  assert.equal(
    scannedAgentRun(bgSdk('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan called a background session under sdk-cli a person',
  );
});

// Reader evidence remains effective in both small metadata reads and scans spanning more than 256 KiB.

test("a background session's other person signs still mark a person, tail read and whole-file scan alike", () => {
  const bgFirst = () =>
    userPrompt('fix the failing lint rule', 0, { entrypoint: 'cli', origin: { kind: 'human' }, sessionKind: 'bg' });
  const cases: [string, (padding: string) => object[]][] = [
    [
      'an editor selection',
      (padding) => [
        userPrompt('<ide_selection>lines 1 to 4 of lint.config.ts</ide_selection>\nfix it', 0, {
          entrypoint: 'cli',
          origin: { kind: 'human' },
          sessionKind: 'bg',
        }),
        padded(1, padding),
        assistantAnswer('Fixed the rule.', 2),
      ],
    ],
    [
      'a question put to the reader',
      (padding) => [
        bgFirst(),
        assistantTool('AskUserQuestion', 1, 'q1'),
        padded(2, padding),
        assistantAnswer('Fixed the rule.', 3),
      ],
    ],
    [
      'a local command record',
      (padding) => [
        bgFirst(),
        { type: 'system', timestamp: at(1), subtype: 'local_command' },
        padded(2, padding),
        assistantAnswer('Fixed the rule.', 3),
      ],
    ],
    [
      'a queued follow-up',
      (padding) => [
        bgFirst(),
        typedMidTurn('and check the docs too', 1),
        padded(2, padding),
        assistantAnswer('Fixed the rule.', 3),
      ],
    ],
    [
      'a second typed prompt',
      (padding) => [
        bgFirst(),
        padded(1, padding),
        assistantAnswer('Fixed the rule.', 2),
        userPrompt('actually also update the readme', 5),
        assistantAnswer('done again', 6),
      ],
    ],
  ];
  for (const [what, build] of cases) {
    assert.equal(
      readSessionMeta(writeTranscript(build('ok'))).agentRun,
      false,
      `${what} in a background session was not read as a person, tail read`,
    );
    assert.equal(
      scannedAgentRun(build('x'.repeat(300 * 1024))),
      false,
      `${what} in a background session was not read as a person, whole-file scan`,
    );
  }
});

// A terminal entrypoint observed before the background marker retains reader classification.

test("a non-SDK entrypoint seen before sessionKind: 'bg' is a person for both readers", () => {
  const entrypointBeforeBg = (padding: string): object[] => [
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'cli',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the failing lint rule' }] },
    },
    assistantTool('Edit', 1, 'e1', { file_path: 'lint.config.ts' }),
    {
      type: 'user',
      timestamp: at(2),
      sessionKind: 'bg',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: padding }] },
    },
    assistantAnswer('Fixed the rule.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(entrypointBeforeBg('ok'))).agentRun,
    false,
    'the tail read excused a non-SDK entrypoint because sessionKind: bg arrived late',
  );
  assert.equal(
    scannedAgentRun(entrypointBeforeBg('x'.repeat(300 * 1024))),
    false,
    'the whole-file scan excused a non-SDK entrypoint because sessionKind: bg arrived late',
  );
});

// Sidechain and synthetic records supply no entrypoint or background markers for the parent session.

test('a sidechain record and a synthetic-model record contribute no entrypoint or background marker', () => {
  const leakage = (padding: string): object[] => [
    {
      type: 'user',
      isSidechain: true,
      entrypoint: 'cli',
      sessionKind: 'bg',
      timestamp: at(0),
      message: { role: 'user', content: [{ type: 'text', text: 'a subagent aside' }] },
    },
    {
      type: 'assistant',
      entrypoint: 'cli',
      sessionKind: 'bg',
      timestamp: at(1),
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'synthetic filler' }] },
    },
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(2),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'review the diff' }] },
    },
    assistantAnswer('Looks fine.', 3),
    {
      type: 'user',
      timestamp: at(4),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'text', text: 'now check the tests' }] },
    },
    assistantTool('Bash', 5, 'b1', { command: 'npm test' }),
    padded(6, padding),
    assistantAnswer('Tests pass.', 7),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(leakage('ok'))).agentRun,
    true,
    'the tail read let a sidechain entrypoint or a synthetic sessionKind reach the tally',
  );
  assert.equal(
    scannedAgentRun(leakage('x'.repeat(300 * 1024))),
    true,
    'the whole-file scan let a sidechain entrypoint or a synthetic sessionKind reach the tally',
  );
});

test("a bridge-session record with no sessionKind: 'bg' under sdk-cli stays a person", () => {
  const noBg = writeTranscript([
    userPrompt('fix the failing lint rule', 0, { entrypoint: 'sdk-cli' }),
    {
      type: 'bridge-session',
      timestamp: at(1),
      sessionId: 'sess',
      bridgeSessionId: 'bridge-1',
      lastSequenceNum: 1,
      ownerAccountUuid: 'acct-1',
      ownerOrganizationUuid: 'org-1',
    },
    assistantAnswer('Fixed the rule.', 2),
  ]);
  assert.equal(
    readSessionMeta(noBg).agentRun,
    false,
    'a bridge-session record with no sessionKind: bg was read as a run',
  );
});

test('a slash command with no origin stays a person when entrypoints mix sdk-cli and cli', () => {
  const mixed = writeTranscript([
    {
      type: 'user',
      promptId: 'p1',
      timestamp: at(0),
      entrypoint: 'sdk-cli',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<command-message>hello</command-message>\n<command-name>/hello</command-name>' },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at(1),
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Say hello back' }] },
    },
    assistantTool('Bash', 2, 'b1', { command: 'echo hi' }),
    {
      type: 'user',
      timestamp: at(3),
      entrypoint: 'cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] },
    },
    assistantAnswer('Hello!', 4),
  ]);
  assert.equal(
    readSessionMeta(mixed).agentRun,
    false,
    'a slash command with no origin was excused once a cli-entrypoint record joined the sdk-cli ones',
  );
});

test('a slash command with no origin in a bg session under cli is still a second prompt', () => {
  const bgSecondCommand = writeTranscript([
    userPrompt('fix the failing lint rule', 0, { entrypoint: 'cli', origin: { kind: 'human' }, sessionKind: 'bg' }),
    assistantAnswer('Fixed.', 1),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<command-message>hello</command-message>\n<command-name>/hello</command-name>' },
        ],
      },
    },
    assistantAnswer('Hello!', 3),
  ]);
  assert.equal(
    readSessionMeta(bgSecondCommand).agentRun,
    false,
    "a slash command with no origin as a bg session's second prompt was read as a run",
  );
});

// A human-origin prompt preceding the SDK entrypoint retains reader classification.

test('a resumed SDK review with a human-origin sign before the entrypoint record is still a person, tail read and whole-file scan alike', () => {
  const signFirst = (padding: string): object[] => [
    userPrompt('now check the tests', 0, { origin: { kind: 'human' } }),
    assistantTool('Bash', 1, 'b1', { command: 'npm test' }),
    {
      type: 'user',
      timestamp: at(2),
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: padding }] },
    },
    assistantAnswer('Tests pass.', 3),
  ];
  assert.equal(
    readSessionMeta(writeTranscript(signFirst('ok'))).agentRun,
    false,
    'the tail read excused a human-origin prompt because the sdk-cli entrypoint named itself late',
  );
  assert.equal(
    scannedAgentRun(signFirst('x'.repeat(300 * 1024))),
    false,
    'the whole-file scan excused a human-origin prompt because the sdk-cli entrypoint named itself late',
  );
});

// AskUserQuestion establishes reader evidence in a completed single-prompt session.

test('a question the reader answered is never an agent run', () => {
  const chose = writeTranscript([
    userPrompt('ask me which colour I prefer, with blue and red as options', 0),
    assistantTool('AskUserQuestion', 1, 'q1', { questions: [{ header: 'Colour' }] }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Blue' }] },
    },
    assistantAnswer('You chose Blue.', 3),
  ]);
  assert.equal(readSessionMeta(chose).agentRun, false);
});

// Tool results carrying promptId supply no additional typed prompts.

test('the results a tool writes back are not read as the reader typing again', () => {
  const run = writeTranscript([
    userPrompt('one ask', 0),
    assistantTool('Read', 1, 't1', { file_path: 'store.ts' }),
    {
      type: 'user',
      promptId: 'p1',
      sourceToolAssistantUUID: 'a1',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    },
    assistantAnswer('Read it.', 3),
  ]);
  assert.equal(readSessionMeta(run).agentRun, true);
});

// A metadata window that excludes the file start leaves agent-run classification unavailable.

test('a window that did not reach the start of the file says nothing either way', () => {
  const long = writeTranscript([
    userPrompt('the first ask, which the small window below will not reach', 0),
    ...Array.from({ length: 40 }, (_, n) => assistantText('a line of an answer that takes up room', n + 1)),
    assistantAnswer('and the answer that closed it', 41),
  ]);
  assert.equal(readSessionMeta(long, 512).agentRun, null);
  assert.equal(readSessionMeta(long).agentRun, true);
});

// Turn-start reads report window coverage beside their retained timestamps.

test('the turn starts in a window come back with whether the window reached the start', () => {
  const file = writeTranscript([
    userPrompt('first ask', 0),
    assistantAnswer('Done.', 1),
    userPrompt('second ask', 10),
    assistantAnswer('Done again.', 11),
    userPrompt('third ask', 20),
  ]);
  // A window wider than the file reaches its start, so the figure taken from it is a total.
  assert.deepEqual(readSessionTurnStarts(file), { starts: [ms(0), ms(10), ms(20)], whole: true });

  // A window opening inside the second prompt drops that incomplete record and retains the third prompt.

  const raw = fs.readFileSync(file, 'utf8');
  const secondAsk = raw.indexOf('second ask');
  const cut = readSessionTurnStarts(file, raw.length - secondAsk - 4);
  assert.equal(
    cut.whole,
    false,
    `a window of ${raw.length - secondAsk - 4} bytes over a ${raw.length} byte file claims to have read all of it`,
  );
  assert.deepEqual(
    cut.starts,
    [ms(20)],
    'the window did not open inside the second prompt, so this measures nothing about a partial one',
  );

  // Sidechain, tool-result, task-notification, and compact-summary records supply no typed turn starts.

  const noise = writeTranscript([
    userPrompt('first ask', 0),
    { ...userPrompt('a subagent asking itself', 1), isSidechain: true },
    { ...userPrompt('a task notification', 3), origin: { kind: 'task-notification' } },
    { ...userPrompt('the summary that carried over', 4), isCompactSummary: true },
    editResult('/tmp/a.ts', 5, 1, 0),
    userPrompt('second ask', 6),
  ]);
  assert.deepEqual(readSessionTurnStarts(noise).starts, [ms(0), ms(6)]);

  // Peer prompts count as turn starts in both the full read and the start-timestamp read.

  // Closing replies keep the fixture's prompts in separate turns.

  const woken = writeTranscript([
    userPrompt('first ask', 0),
    assistantAnswer('Done.', 1),
    { ...userPrompt('a wake from another session', 2), origin: { kind: 'peer' } },
    assistantAnswer('Done again.', 3),
    userPrompt('second ask', 6),
    assistantAnswer('And again.', 7),
  ]);
  assert.deepEqual(readSessionTurnStarts(woken).starts, [ms(0), ms(2), ms(6)]);
  assert.deepEqual(
    readTurns(woken, 's').map((t) => t.startedAt),
    [ms(0), ms(2), ms(6)],
    'the parse and the glance disagree about whether a peer prompt starts a turn',
  );
  // Peer prompts alone supply no human-prompt evidence for session discovery.

  assert.equal(holdsHumanPrompt(JSON.stringify({ ...userPrompt('a wake', 0), origin: { kind: 'peer' } })), false);

  // An unprompted answer supplies no turn starts.

  assert.deepEqual(readSessionTurnStarts(writeTranscript([assistantAnswer('unprompted', 0)])), {
    starts: [],
    whole: true,
  });

  // Invalid prompt timestamps supply no turn-start time.

  assert.deepEqual(
    readSessionTurnStarts(
      writeTranscript([{ ...userPrompt('untimed', 0), timestamp: 'not a date' }, userPrompt('timed', 7)]),
    ).starts,
    [ms(7)],
  );

  // A missing file supplies no starts and incomplete coverage.

  assert.deepEqual(readSessionTurnStarts(path.join(os.tmpdir(), 'no-such-transcript.jsonl')), {
    starts: [],
    whole: false,
  });

  // Turn-start reads begin with a 1 MiB window and expand to at most 16 MiB.

  assert.equal(TURN_START_BYTES, 1024 * 1024);
  assert.equal(TURN_START_MAX_BYTES, 16 * 1024 * 1024);
});

test('a Claude glance grows backward when the newest turn starts before its first window', () => {
  const bytes = 128;
  const file = writeTranscript([userPrompt('the only ask', 7), assistantAnswer('x'.repeat(bytes * 5), 8)]);
  // Expansion reaching byte zero reports complete coverage.

  assert.deepEqual(
    readSessionTurnStarts(file, bytes),
    { starts: [ms(7)], whole: true },
    'the Claude glance did not find the turn start before its first window',
  );
});

test('a glance that stops short of the file start reports a partial answer', () => {
  const bytes = 128;
  const file = writeTranscript([
    userPrompt('the older ask', 5),
    assistantAnswer('x'.repeat(bytes * 40), 6),
    userPrompt('the newer ask', 7),
    assistantAnswer('x'.repeat(bytes * 4), 8),
  ]);
  // A window ending its expansion before the older turn reports partial coverage.

  assert.deepEqual(
    readSessionTurnStarts(file, bytes),
    { starts: [ms(7)], whole: false },
    'a glance that stopped short of the file start claimed to hold every turn',
  );
});

test('a glance keeps a turn start that begins on the byte its last read began on', () => {
  const bytes = 128;
  const ceiling = bytes * ((16 * 1024 * 1024) / (1024 * 1024));
  const prompt = JSON.stringify(userPrompt('the ask on the boundary', 7)) + '\n';
  // The prompt begins exactly at the widest read's boundary and remains a complete record.

  const body = ignoredClaudeLineOfBytes(512) + prompt + ignoredClaudeLineOfBytes(ceiling - Buffer.byteLength(prompt));
  const dir = tempDir('tl-');
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, body);
  assert.equal(fs.statSync(file).size - ceiling, 512, 'the fixture did not put the prompt on the boundary');
  assert.deepEqual(
    readSessionTurnStarts(file, bytes),
    { starts: [ms(7)], whole: false },
    'the glance dropped a whole record that began on its own read boundary',
  );
});

test('a glance stops at its backward ceiling when no nearer turn start exists', () => {
  const bytes = 128;
  const file = writeTranscript([userPrompt('past the ceiling', 7), assistantAnswer('x'.repeat(bytes * 20), 8)]);
  assert.deepEqual(
    readSessionTurnStarts(file, bytes),
    { starts: [], whole: false },
    'the glance read past its backward ceiling',
  );
});

test('the panel watches directories rather than files, so a new session is seen', () => {
  // Directory watches cover new session files created after watch setup.

  const dir = path.join('C:', 'Users', 'dev', '.claude', 'projects', 'a-repo');
  const dirs = watchDirs([
    { file: path.join(dir, 'one.jsonl') },
    { file: path.join(dir, 'two.jsonl') },
    { file: path.join('C:', 'Users', 'dev', '.codex', 'sessions', '2026', '08', '29', 'three.jsonl') },
  ]);
  assert.equal(dirs.length, 2, 'two files in one directory are watched twice over');
  assert.ok(dirs.includes(dir));

  // Sorted unique directories keep watcher-set comparisons independent of input order.

  assert.deepEqual(watchDirs([{ file: path.join(dir, 'b.jsonl') }, { file: path.join(dir, 'a.jsonl') }]), [dir]);
  assert.deepEqual(watchDirs([]), []);
  assert.deepEqual(watchDirs([{ file: path.join('C:', 'b', 'x.jsonl') }, { file: path.join('C:', 'a', 'y.jsonl') }]), [
    path.join('C:', 'a'),
    path.join('C:', 'b'),
  ]);
});

test('transcript watches stay bounded and prefer every folder with a warm source', () => {
  assert.equal(TRANSCRIPT_WATCH_LIMIT, 256);
  const files = Array.from({ length: 1024 }, (_, index) => ({
    file: path.join('transcripts', String(index).padStart(4, '0'), 'session.jsonl'),
  }));
  const mixed = { file: path.join('transcripts', '1023', 'warm.jsonl') };
  const warm = new Set([normalizeFsPath(mixed.file), normalizeFsPath(files[1022].file)]);
  const allocated = watchDirs([...files, mixed, { file: 'bare.jsonl' }], warm);
  assert.equal(allocated.length, 256);
  assert.deepEqual(allocated.slice(0, 2), [path.dirname(files[1022].file), path.dirname(mixed.file)]);
  assert.deepEqual(
    allocated.slice(2),
    files.slice(0, 254).map((source) => path.dirname(source.file)),
  );
  assert.deepEqual(watchDirs([mixed, ...files].reverse(), warm), allocated);
  assert.deepEqual(
    watchDirs(files, new Set(files.map((source) => normalizeFsPath(source.file)))),
    files.slice(0, 256).map((source) => path.dirname(source.file)),
  );
});

test('a burst of appends is gathered before the panel reads again', () => {
  // Transcript writes use a 200 ms wake delay, below the poll floor.

  assert.equal(TRANSCRIPT_WAKE_MS, 200);
  assert.ok(
    TRANSCRIPT_WAKE_MS < 2000,
    'the wake is slower than the poll floor, so watching the transcript buys nothing',
  );
});

test('a turn records what it did in order, and what each call was about', () => {
  // Retained steps preserve call order, details, timestamps, and outcomes beside aggregate counts.

  const file = writeTranscript([
    userPrompt('take the sandbox', 0),
    assistantTool('Read', 1, 'a1', { file_path: 'extension/src/panelhost.ts' }),
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'ok' }] },
    },
    assistantTool('Bash', 3, 'a2', { command: 'npm test' }),
    {
      type: 'user',
      timestamp: at(4),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a2', is_error: true, content: 'exit 1' }],
      },
    },
    assistantTool('Grep', 5, 'a3', { pattern: 'livePressOver' }),
    assistantAnswer('Done.', 6),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.steps.map((s) => [s.name, s.detail, s.status]),
    [
      ['Read', 'extension/src/panelhost.ts', 'done'],
      ['Bash', 'npm test', 'failed'],
      ['Grep', 'livePressOver', 'done'],
    ],
  );
  assert.deepEqual(
    turn.steps.map((s) => s.at),
    [ms(1), ms(3), ms(5)],
  );
  assert.equal(turn.stepCount, 3);
});

test('Claude Bash steps prefer the human description and retain the exact command off JSON', () => {
  const exact = ['npm test', '-- --runInBand', 'x'.repeat(STEP_DETAIL_LIMIT)].join('\n');
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('verify it', 0),
      assistantTool('Bash', 1, 'both', { description: 'Run the focused checks', command: exact }),
      assistantTool('Bash', 2, 'command-only', { command: 'git status --short' }),
      assistantTool('Bash', 3, 'description-only', { description: 'Inspect generated output' }),
      assistantAnswer('Done.', 4),
    ]),
    'sess',
  );
  const [both, commandOnly, descriptionOnly] = turn.steps;
  assert.equal(both.sourceId, 'both');
  assert.equal(both.headline, 'Run the focused checks');
  assert.equal(both.detail.length, STEP_DETAIL_LIMIT);
  assert.equal(both.fullDetail, exact);
  assert.equal(Object.keys(both).includes('fullDetail'), false);
  assert.equal(JSON.stringify(turn).includes(exact), false);
  assert.deepEqual(
    [commandOnly.headline, commandOnly.detail, descriptionOnly.headline, descriptionOnly.detail],
    [undefined, 'git status --short', 'Inspect generated output', ''],
  );
});

test('non-Bash tool detail and shared permission wording keep their field precedence', () => {
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('inspect it', 0),
      assistantTool('Read', 1, 'read-one', { description: 'human words', file_path: 'a.ts' }),
      assistantTool('Agent', 2, 'agent-one', { description: 'Review the parser', prompt: 'long instructions' }),
      assistantAnswer('Done.', 3),
    ]),
    'sess',
  );
  assert.deepEqual(
    turn.steps.map((step) => [step.name, step.detail, step.headline]),
    [
      ['Read', 'a.ts', undefined],
      ['Agent', 'Review the parser', undefined],
    ],
  );
  assert.equal(describeToolInput({ command: 'npm test', description: 'Run the checks' }), 'npm test');
});

test('saved Claude activity keeps captured query, recipient, task, and question subjects', () => {
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('inspect it', 0),
      assistantTool('WebSearch', 1, 'search', { query: 'activity details' }),
      assistantTool('SendMessage', 2, 'message', { recipient: 'reviewer', message: 'Review it' }),
      assistantTool('TaskOutput', 3, 'task', { task_id: 'task-1' }),
      assistantTool('AskUserQuestion', 4, 'question', { questions: [{ question: 'Which option?' }] }),
      assistantAnswer('Done.', 5),
    ]),
    'sess',
  );
  assert.deepEqual(
    turn.steps.map((step) => [step.name, step.detail]),
    [
      ['WebSearch', 'activity details'],
      ['SendMessage', 'reviewer'],
      ['TaskOutput', 'task-1'],
      ['AskUserQuestion', 'Which option?'],
    ],
  );
});

test('a shortened non-command subject retains its exact text outside the card payload', () => {
  const exact = `C:\\workspace\\${'deep-folder\\'.repeat(20)}file.ts`;
  const [turn] = readTurns(
    writeTranscript([
      userPrompt('inspect it', 0),
      assistantTool('Read', 1, 'read-long', { file_path: exact }),
      assistantAnswer('Done.', 2),
    ]),
    'sess',
  );
  const [step] = turn.steps;
  assert.ok(step.detail.endsWith(STEP_CUT));
  assert.equal(step.fullDetail, exact);
  assert.equal(Object.prototype.propertyIsEnumerable.call(step, 'fullDetail'), false);
});

test('the call the agent is on is the one still running, and nothing else is', () => {
  // A newer assistant message ends earlier pending calls. Calls in the newest message remain running.

  const running = writeTranscript([
    userPrompt('take the sandbox', 0),
    assistantTool('Read', 1, 'a1', { file_path: 'a.ts' }),
    assistantTool('Bash', 2, 'a2', { command: 'npm test' }),
  ]);
  assert.deepEqual(
    readTurns(running, 'sess')[0].steps.map((s) => s.status),
    ['done', 'running'],
  );

  // Calls issued in one message remain running together.

  const together = writeTranscript([
    userPrompt('take the sandbox', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'a2', name: 'Read', input: { file_path: 'b.ts' } },
        ],
      },
    },
  ]);
  assert.deepEqual(
    readTurns(together, 'sess')[0].steps.map((s) => s.status),
    ['running', 'running'],
  );

  // A failed result retains its call's failure after later assistant activity.

  const failed = writeTranscript([
    userPrompt('take the sandbox', 0),
    assistantTool('Bash', 1, 'a1', { command: 'npm test' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a1', is_error: true, content: 'exit 1' }],
      },
    },
    assistantAnswer('It failed.', 3),
  ]);
  assert.deepEqual(
    readTurns(failed, 'sess')[0].steps.map((s) => s.status),
    ['failed'],
  );
});

test('a skill is a step under its own name, and needs no reading of its own', () => {
  // Skill input names the skill separately from its prompt body.

  const file = writeTranscript([
    userPrompt('review this', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'review-the-change', prompt: 'the whole body of the skill' }),
    assistantAnswer('Done.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.steps.map((s) => [s.name, s.detail]),
    [['Skill', 'review-the-change']],
  );
});

// The record Claude Code writes once a skill has loaded, carrying the skill's own
// instructions. It names the call that loaded it and opens on the directory it was read from.
function skillLoaded(directory: string, second: number, id = 'a1') {
  return {
    type: 'user',
    timestamp: at(second),
    isMeta: true,
    sourceToolUseID: id,
    message: {
      role: 'user',
      content: [{ type: 'text', text: `Base directory for this skill: ${directory}\n\n# Polish\n\nTidy the wording.` }],
    },
  };
}

// A successful Skill result supplies no definition path. Its instructions record carries that path separately.

function skillResult(name: string, second: number, id = 'a1') {
  return {
    type: 'user',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Launching skill: ${name}` }] },
    toolUseResult: { success: true, commandName: name },
  };
}

// What the reader typed, exactly as the harness wraps it: the same tags `cleanPrompt` rewrites
// into one line for the card.
function typedCommand(name: string, args: string, second: number) {
  const bare = name.replace(/^\//, '');
  return userPrompt(
    `<command-message>${bare}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`,
    second,
  );
}

// The record Claude Code writes right after a typed command that loaded a skill. It carries
// no call id of its own: the command record immediately before it is the one it proves.
function typedSkillCompanion(directory: string, second: number) {
  return {
    type: 'user',
    timestamp: at(second),
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: `Base directory for this skill: ${directory}\n\n# Land\n\nRun the task.` }],
    },
  };
}

test('a Claude skill load is recorded with the file the client read', () => {
  const file = writeTranscript([
    userPrompt('clean the copy', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    skillResult('polish', 2),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 3),
    assistantAnswer('Done.', 4),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.skillUses, [
    {
      sourceId: 'a1',
      name: 'polish',
      at: ms(1),
      evidence: 'recorded',
      path: 'C:\\Users\\dev\\.claude\\skills\\polish/SKILL.md',
    },
  ]);
  assert.equal(turn.skillUseCount, 1);
});

test('a POSIX directory and a namespaced skill name are recorded as they were written', () => {
  const file = writeTranscript([
    userPrompt('write it simply', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'plain-language:plain-language' }),
    skillResult('plain-language:plain-language', 2),
    skillLoaded('/home/dev/.claude/skills/plain-language', 3),
    assistantAnswer('Done.', 4),
  ]);
  assert.deepEqual(
    readTurns(file, 'sess')[0].skillUses.map((use) => [use.name, use.path]),
    [['plain-language:plain-language', '/home/dev/.claude/skills/plain-language/SKILL.md']],
  );
});

test('a skill load is in no tool category, and holds its own place in the call kinds', () => {
  // Skill calls retain a separate step kind and count toward raw tool totals without entering other.

  const file = writeTranscript([
    userPrompt('clean the copy', 0),
    assistantTool('Read', 1, 'a0', { file_path: 'a.ts' }),
    assistantTool('Skill', 2, 'a1', { skill: 'polish' }),
    assistantAnswer('Done.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.toolCounts.other, 0);
  assert.deepEqual(turn.stepKinds, ['reads', 'skill']);
  assert.equal(turn.toolUses, 2);
  assert.deepEqual(turn.toolTally, { Read: 1, Skill: 1 });
});

test('a skill call that came back as an error loaded nothing', () => {
  const file = writeTranscript([
    userPrompt('clean the copy', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    {
      type: 'user',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a1', is_error: true, content: 'no such skill' }],
      },
    },
    assistantAnswer('It failed.', 3),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.skillUses, []);
  assert.equal(turn.skillUseCount, 0);
  assert.deepEqual(
    turn.steps.map((step) => step.status),
    ['failed'],
    'the call itself keeps its row',
  );
});

test('a skill load with no instructions record keeps no path', () => {
  // A Skill call without instructions retains its use without a definition path.

  const file = writeTranscript([
    userPrompt('clean the copy', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    skillResult('polish', 2),
    assistantAnswer('Done.', 3),
  ]);
  assert.deepEqual(readTurns(file, 'sess')[0].skillUses, [
    { sourceId: 'a1', name: 'polish', at: ms(1), evidence: 'recorded' },
  ]);
});

test("an instructions record names its own call, so one load's file is never another's", () => {
  // sourceToolUseID pairs instructions with their Skill call, even when another call arrived later.

  const file = writeTranscript([
    userPrompt('clean the copy then rewrite it', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    skillResult('polish', 2),
    assistantTool('Skill', 3, 'a2', { skill: 'summarize' }),
    skillResult('summarize', 4),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 5, 'a1'),
    assistantAnswer('Done.', 6),
  ]);
  assert.deepEqual(
    readTurns(file, 'sess')[0].skillUses.map((use) => [use.name, use.path]),
    [
      ['polish', 'C:\\Users\\dev\\.claude\\skills\\polish/SKILL.md'],
      ['summarize', undefined],
    ],
  );
});

test('two Skill calls for the same name in one turn record two uses', () => {
  // Distinct Skill call ids retain separate uses of the same skill name.

  const file = writeTranscript([
    userPrompt('clean the copy twice', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    skillResult('polish', 2),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 3, 'a1'),
    assistantTool('Skill', 4, 'a2', { skill: 'polish' }),
    skillResult('polish', 5, 'a2'),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 6, 'a2'),
    assistantAnswer('Done.', 7),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.skillUseCount, 2, 'a second real load under a different call id is a second use');
  assert.deepEqual(
    turn.skillUses.map((use) => use.sourceId),
    ['a1', 'a2'],
  );
});

test('a failed first Skill call does not withdraw a second call for the same name', () => {
  // A failed Skill result withdraws only the use identified by its own call id.

  const file = writeTranscript([
    userPrompt('retry the skill', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    assistantTool('Skill', 2, 'a2', { skill: 'polish' }),
    {
      type: 'user',
      timestamp: at(3),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a1', is_error: true, content: 'no such skill' }],
      },
    },
    skillResult('polish', 4, 'a2'),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 5, 'a2'),
    assistantAnswer('Done.', 6),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.skillUseCount, 1, 'the second call really did load the skill, even though the first call failed');
  assert.deepEqual(
    turn.skillUses.map((use) => use.sourceId),
    ['a2'],
  );
});

test('a skill load outlives the step window that held the call', () => {
  const lines: object[] = [
    userPrompt('clean the copy', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    skillResult('polish', 2),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 3),
  ];
  for (let i = 0; i < TURN_STEP_LIMIT + 5; i++) {
    lines.push(assistantTool('Read', i + 4, `r${i}`, { file_path: `file-${i}.ts` }));
  }
  lines.push(assistantAnswer('Done.', TURN_STEP_LIMIT + 20));
  const [turn] = readTurns(writeTranscript(lines), 'sess');
  assert.equal(
    turn.steps.some((step) => step.name === 'Skill'),
    false,
    'the call left the window',
  );
  assert.deepEqual(
    turn.skillUses.map((use) => use.name),
    ['polish'],
  );
  assert.equal(turn.skillUseCount, 1);
});

test('a record read twice reports one skill load', () => {
  // The reader works in byte windows and rereads its tail, so the same call can arrive twice.
  // The call id is the identity: the later copy replaces the earlier one.
  const records = [
    userPrompt('clean the copy', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'polish' }),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\polish', 2),
  ];
  const reducer = createClaudeSessionReducer('sess');
  for (const record of [...records, ...records.slice(1)]) {
    reducer.pushLine(JSON.stringify(record));
  }
  const [turn] = reducer.read().turns;
  assert.deepEqual(turn.skillUses, [
    {
      sourceId: 'a1',
      name: 'polish',
      at: ms(1),
      evidence: 'recorded',
      path: 'C:\\Users\\dev\\.claude\\skills\\polish/SKILL.md',
    },
  ]);
  assert.equal(turn.skillUseCount, 1);
});

test('typing a command that loaded a skill records it exactly as a Skill call would', () => {
  const file = writeTranscript([
    typedCommand('/land', 'Phase 2', 0),
    typedSkillCompanion('C:\\Users\\dev\\.claude\\skills\\land', 0),
    assistantAnswer('Done.', 1),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.skillUses, [
    {
      sourceId: `at-${ms(0)}`,
      name: 'land',
      at: ms(0),
      evidence: 'recorded',
      path: 'C:\\Users\\dev\\.claude\\skills\\land/SKILL.md',
    },
  ]);
  assert.equal(turn.skillUseCount, 1);
  // The card prompt contains the command and arguments without the skill instructions.

  assert.equal(turn.prompt, '/land Phase 2');
  assert.equal(
    turn.prompt.includes('Base directory for this skill'),
    false,
    'the companion record proves the load; its SKILL.md body never reaches the card',
  );
  assert.equal(turn.prompt.includes('Run the task'), false);
});

test('a typed skill invocation prefers the record uuid over the timestamp fallback for its source id', () => {
  const file = writeTranscript([
    userPrompt(
      '<command-message>land</command-message>\n<command-name>/land</command-name>\n<command-args>Phase 2</command-args>',
      0,
      { uuid: 'uuid-land-1' },
    ),
    typedSkillCompanion('C:\\Users\\dev\\.claude\\skills\\land', 0),
    assistantAnswer('Done.', 1),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.skillUses.map((use) => use.sourceId),
    ['uuid-land-1'],
  );
});

test('a typed plugin-namespaced skill is recorded with its name verbatim', () => {
  const file = writeTranscript([
    typedCommand('/plain-language:plain-language', '', 0),
    typedSkillCompanion('/home/dev/.claude/skills/plain-language', 0),
    assistantAnswer('Done.', 1),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(
    turn.skillUses.map((use) => [use.name, use.path]),
    [['plain-language:plain-language', '/home/dev/.claude/skills/plain-language/SKILL.md']],
  );
});

test('a plain custom command with no base-directory record loads no skill', () => {
  const rawText =
    '<command-message>standup</command-message>\n<command-name>/standup</command-name>\n<command-args>today</command-args>';
  const file = writeTranscript([typedCommand('/standup', 'today', 0), assistantAnswer('Standing up now.', 1)]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.skillUses, []);
  assert.equal(turn.skillUseCount, 0);
  assert.equal(turn.prompt, cleanPrompt(rawText));
});

test('a typed command followed by an unrelated meta record loads no skill', () => {
  // Unrelated metadata after a typed command supplies no skill-use evidence.

  const file = writeTranscript([
    typedCommand('/standup', 'today', 0),
    {
      type: 'user',
      timestamp: at(1),
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Unrelated system note.' }] },
    },
    assistantAnswer('Standing up now.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.skillUses, []);
  assert.equal(turn.skillUseCount, 0);
});

test('a harness command right after a typed skill clears the pending skill without resolving it', () => {
  // A following compact command supplies no instructions evidence for the pending typed skill.

  const file = writeTranscript([
    typedCommand('/land', 'Phase 2', 0),
    typedCommand('/compact', '', 1),
    assistantAnswer('Compacted.', 2),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 1, 'the harness command opens no turn of its own');
  assert.deepEqual(turns[0].skillUses, []);
  assert.equal(turns[0].skillUseCount, 0);
});

test('a Claude effort change writes command scaffolding but opens no turn of its own', () => {
  // The later assistant record updates effort within the existing turn. The effort command and local metadata open no new turn.

  const file = writeTranscript([
    userPrompt('write the migration', 0),
    assistantText(
      'Working on it.',
      1,
      { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 2 },
      'high',
      'end_turn',
    ),
    userPrompt(
      '<local-command-caveat>Caveat: the messages below were generated by the user while ' +
        'running local commands. Do not respond to them unless the user explicitly asks you ' +
        'to.</local-command-caveat>',
      2,
    ),
    typedCommand('/effort', 'low', 3),
    { type: 'system', timestamp: at(4), subtype: 'local_command' },
    assistantText('Set effort level to low.', 5, undefined, 'low', 'end_turn'),
  ]);
  const turns = readTurns(file, 'sess');
  assert.equal(turns.length, 1, 'an effort change opens no turn of its own');
  assert.equal(turns[0].effort, 'low', 'the recorded effort follows the newest assistant record');
  assert.equal(turns[0].contextRequest?.effort, 'high');
});

test('a stray base-directory line long after a typed command records no skill', () => {
  // Only the next record resolves a typed skill's pending instructions. A later base-directory record supplies no use.

  const file = writeTranscript([
    typedCommand('/standup', 'today', 0),
    assistantAnswer('Standing up now.', 1),
    typedSkillCompanion('C:\\Users\\dev\\.claude\\skills\\land', 2),
    assistantAnswer('Done.', 3),
  ]);
  const turns = readTurns(file, 'sess');
  assert.deepEqual(
    turns.flatMap((turn) => turn.skillUses),
    [],
    'the base-directory line arrived too late to prove the standup command loaded a skill',
  );
});

test('a harness command name is excluded even when stray text keeps its record open', () => {
  // Extra prompt text can survive a local command wrapper, but its command name remains excluded from skill-use evidence.

  const file = writeTranscript([
    userPrompt('please <command-name>/compact</command-name><command-args></command-args>', 0),
    typedSkillCompanion('C:\\Users\\dev\\.claude\\skills\\compact', 1),
    assistantAnswer('Compacted.', 2),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.deepEqual(turn.skillUses, []);
  assert.equal(turn.skillUseCount, 0);
});

test('a typed skill invocation and a later Skill call for the same name record one use', () => {
  const file = writeTranscript([
    typedCommand('/land', 'Phase 2', 0),
    typedSkillCompanion('C:\\Users\\dev\\.claude\\skills\\land', 0),
    assistantTool('Skill', 1, 'a1', { skill: 'land' }),
    skillResult('land', 2),
    skillLoaded('C:\\Users\\dev\\.claude\\skills\\land', 3),
    assistantAnswer('Done.', 4),
  ]);
  const [turn] = readTurns(file, 'sess');
  assert.equal(turn.skillUseCount, 1, 'the typed load and the tool call name the same skill');
  assert.deepEqual(
    turn.skillUses.map((use) => use.name),
    ['land'],
  );
});

test('a reread of a typed skill companion alone does not double the load', () => {
  // Repeating a resolved companion record without its typed command retains one skill use.

  const command = typedCommand('/land', 'Phase 2', 0);
  const companion = typedSkillCompanion('C:\\Users\\dev\\.claude\\skills\\land', 0);
  const reducer = createClaudeSessionReducer('sess');
  for (const record of [command, companion, companion]) {
    reducer.pushLine(JSON.stringify(record));
  }
  const [turn] = reducer.read().turns;
  assert.equal(turn.skillUseCount, 1);
  assert.deepEqual(
    turn.skillUses.map((use) => use.name),
    ['land'],
  );
});

test('a long turn carries its newest steps and says how many it ran', () => {
  // The retained step list keeps its newest calls while stepCount keeps the complete total.

  const lines: object[] = [userPrompt('do a lot', 0)];
  for (let i = 0; i < TURN_STEP_LIMIT + 5; i++) {
    lines.push(assistantTool('Read', i + 1, `a${i}`, { file_path: `file-${i}.ts` }));
  }
  lines.push(assistantAnswer('Done.', TURN_STEP_LIMIT + 10));
  const [turn] = readTurns(writeTranscript(lines), 'sess');
  assert.equal(turn.steps.length, TURN_STEP_LIMIT);
  assert.equal(
    turn.stepCount,
    TURN_STEP_LIMIT + 5,
    'the count is cut with the list, so the card cannot say what it is not showing',
  );
  assert.equal(turn.steps[0].detail, 'file-5.ts', 'the oldest steps were kept and the newest dropped');
  assert.equal(turn.steps[turn.steps.length - 1].detail, `file-${TURN_STEP_LIMIT + 4}.ts`);
});

test('the Claude step cap preserves every message and the original call positions', () => {
  for (const total of [TURN_STEP_LIMIT + 5, (TURN_STEP_LIMIT + 5) * 10]) {
    const lines: object[] = [userPrompt('keep the complete log', 0)];
    for (let ordinal = 1; ordinal <= total; ordinal++) {
      lines.push(assistantTool('Read', ordinal, `call-${ordinal}`, { file_path: `${ordinal}.ts` }));
      if (ordinal === 1) {
        lines.push({
          type: 'user',
          timestamp: at(ordinal),
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'Missing file' }],
          },
        });
      }
      if (ordinal % 10 === 0) {
        lines.push(assistantText(`After call ${ordinal}`, ordinal, undefined, undefined, 'tool_use'));
      }
      if (ordinal === 20) {
        lines.push(assistantAnswer('The first check is complete.', ordinal));
      }
      if (ordinal === 30) {
        lines.push(typedMidTurn('Check the second file too.', ordinal));
      }
    }
    const [turn] = readTurns(writeTranscript(lines), 'sess');
    assert.equal(turn.steps.length, TURN_STEP_LIMIT);
    assert.equal(turn.stepCount, total);
    assert.deepEqual(
      turn.steps.map((step) => step.ordinal),
      Array.from({ length: TURN_STEP_LIMIT }, (_, i) => total - TURN_STEP_LIMIT + i + 1),
    );
    assert.equal(turn.updates.length, Math.floor(total / 10));
    assert.deepEqual(
      turn.updates.map((update) => update.stepsBefore),
      Array.from({ length: Math.floor(total / 10) }, (_, i) => (i + 1) * 10),
    );
    assert.deepEqual(turn.answers, [{ text: 'The first check is complete.', at: ms(20), stepsBefore: 20 }]);
    assert.deepEqual(turn.laterPrompts, [{ text: 'Check the second file too.', at: ms(30), stepsBefore: 30 }]);
    assert.deepEqual(turn.failedOrdinals, [1]);
    assert.deepEqual(turn.stepKinds, Array(total).fill('reads'));
  }
});

test('the one thing a call acted on is read from whichever field named it', () => {
  // Tool descriptions prefer the skill name over its accompanying prompt body.

  assert.equal(describeToolInput({ skill: 'polish', prompt: 'the body' }), 'polish');
  assert.equal(describeToolInput({ command: 'npm test' }), 'npm test');
  assert.equal(describeToolInput({ file_path: 'a.ts' }), 'a.ts');
  assert.equal(describeToolInput({ pattern: 'livePress' }), 'livePress');
  assert.equal(describeToolInput({ description: 'review the diff', prompt: 'a very long brief' }), 'review the diff');
  // Codex names a subagent it starts by its task rather than by a description, and the
  // message beside it is an encrypted blob.
  assert.equal(describeToolInput({ task_name: 'head_review', message: 'gAAAAAB...' }), 'head_review');
  assert.equal(describeToolInput({}), '', 'a tool taking no arguments is given words it never said');
  assert.equal(describeToolInput({ command: '   ' }), '', 'whitespace is drawn as though it were a command');

  // Step details normalize whitespace and apply their length limit to full shell commands.

  const heredoc = ['cat > f <<EOF', 'x'.repeat(600), 'EOF'].join('\n');
  assert.equal(
    stepDetail({ command: heredoc }).length,
    STEP_DETAIL_LIMIT,
    'the detail reaches the card whole, so a heredoc is carried as a step name',
  );
  assert.equal(
    stepDetail({ command: ['npm  test', '', '  --watch'].join('\n') }),
    'npm test --watch',
    'a command keeps the gaps between its lines, so the row is mostly empty space',
  );
  assert.equal(stepDetail({ command: 'npm test' }), 'npm test', 'a short command is cut anyway');
});

test('a prompt typed while the turn ran reaches the turn, and the two things beside it do not', () => {
  // Reader prompts in queued attachments enter laterPrompts. Peer prompts and task notifications stay outside that list.

  const file = writeTranscript([
    userPrompt('start the parser work', 0),
    assistantTool('Read', 1, 'tu1', { file_path: 'a.ts' }),
    typedMidTurn('and keep the tests green', 2),
    queued({ commandMode: 'prompt', origin: { kind: 'peer' }, prompt: 'another session says hello' }, 3),
    queued({ commandMode: 'task-notification', prompt: 'a background task finished' }, 4),
    assistantAnswer('Done.', 5),
  ]);
  const { turns } = readSession(file, 'sess');
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].laterPrompts.map((a) => a.text),
    ['and keep the tests green'],
  );
  assert.equal(
    turns[0].laterPrompts[0].at,
    new Date(at(2)).getTime(),
    'the prompt reached the turn with the wrong time',
  );
  assert.equal(
    turns[0].prompt,
    'start the parser work',
    'a mid-turn prompt was folded into the one that started the turn',
  );
});

test('a prompt typed into a turn that never answered goes to the turn that absorbs it', () => {
  // An unanswered turn carries its prompt and laterPrompts into the following turn.

  const file = writeTranscript([
    userPrompt('the first ask', 0),
    typedMidTurn('and this while it sat there', 1),
    userPrompt('the second ask', 2),
    assistantAnswer('Done.', 3),
  ]);
  const { turns } = readSession(file, 'sess');
  assert.equal(turns.length, 1, 'a turn with no reply of its own was drawn as an empty card');
  assert.ok(turns[0].prompt.includes('the first ask') && turns[0].prompt.includes('the second ask'));
  assert.deepEqual(
    turns[0].laterPrompts.map((a) => a.text),
    ['and this while it sat there'],
    'what was typed into the held turn was dropped when it was absorbed',
  );
});

test('a queued prompt written by a subagent is not the reader typing', () => {
  // Sidechain queued prompts stay outside the parent's laterPrompts.

  const file = writeTranscript([
    userPrompt('start the parser work', 0),
    assistantTool('Read', 1, 'tu1', { file_path: 'a.ts' }),
    { ...typedMidTurn('the subagent own queued prompt', 2), isSidechain: true },
    assistantAnswer('Done.', 5),
  ]);
  const { turns } = readSession(file, 'sess');
  assert.deepEqual(turns[0].laterPrompts, []);
});

test('a mid-turn prompt is read as blocks, kept in order, and bounded', () => {
  // Queued prompt content uses the same block reading as user-message content.

  const many: object[] = [userPrompt('start', 0), assistantTool('Read', 1, 'tu1', { file_path: 'a.ts' })];
  for (let i = 0; i < TURN_ASK_LIMIT + 3; i += 1) {
    many.push(typedMidTurn(`ask ${i}`, 2 + i));
  }
  many.push(assistantAnswer('Done.', 90));
  const { turns } = readSession(writeTranscript(many), 'sess');
  const kept = turns[0].laterPrompts;
  assert.equal(kept.length, TURN_ASK_LIMIT, 'a turn asked over and over drew every one of them');
  // The bounded laterPrompts list retains its newest prompts in order.

  assert.equal(kept[0].text, 'ask 3');
  assert.equal(kept[kept.length - 1].text, `ask ${TURN_ASK_LIMIT + 2}`);
});

test('an ordinary line that happens to hold the words is still read as itself', () => {
  // queued_command text inside prompts and tool arguments leaves ordinary records intact.

  // These prompt and search values equal the prefilter's quoted marker.

  const file = writeTranscript([
    userPrompt('queued_command', 0),
    assistantTool('Grep', 1, 'tu1', { pattern: 'queued_command' }),
    assistantAnswer('It is how a queued prompt is written.', 2),
  ]);
  const { turns } = readSession(file, 'sess');
  assert.equal(turns.length, 1, 'a turn was dropped by a line that only quoted the words');
  assert.equal(turns[0].prompt, 'queued_command');
  assert.equal(turns[0].summary, 'It is how a queued prompt is written.');
  assert.equal(turns[0].toolUses, 1, 'a tool call was dropped because its argument quoted the words');
  assert.deepEqual(
    turns[0].steps.map((st) => st.detail),
    ['queued_command'],
  );
  assert.deepEqual(turns[0].laterPrompts, [], 'a line that quoted the words was read as a prompt');
});

test('the rule that picks the reader out reads the fields rather than the shape', () => {
  // Queued prompts without origin count as reader prompts.

  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'prompt' }), true);
  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' } }), true);
  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'peer' } }), false);
  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'task-notification' }), false);
  // And nothing else on that line is one of these at all.
  assert.equal(isReaderQueued({ type: 'total_tokens_reminder', commandMode: 'prompt' }), false);
  assert.equal(isReaderQueued(null), false);
  // Malformed origin values supply no reader-queued prompt.

  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'prompt', origin: 'peer' }), false);
  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'prompt', origin: [] }), false);
  assert.equal(isReaderQueued({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 7 } }), false);
});

test('a selection reads one transcript again and not the whole workspace', () => {
  // Selection revalidates only its session while reusing the held workspace catalog.

  const held = [
    { agent: 'claude' as const, file: 'a.jsonl', sessionId: 'a', mtimeMs: 1, size: 10 },
    { agent: 'claude' as const, file: 'b.jsonl', sessionId: 'b', mtimeMs: 2, size: 20 },
    { agent: 'claude' as const, file: 'c.jsonl', sessionId: 'c', mtimeMs: 3, size: 30 },
  ];

  // One stat, for the session being shown, and none for its neighbours.
  const asked: string[] = [];
  const statOf = (file: string) => {
    asked.push(file);
    return { mtimeMs: 9, size: 90 };
  };
  const next = revalidatedCatalog(held, 'b', statOf);
  assert.deepEqual(asked, ['b.jsonl'], 'a selection still reads files it was not asked about');
  assert.ok(next);
  assert.deepEqual(
    next[1],
    { agent: 'claude', file: 'b.jsonl', sessionId: 'b', mtimeMs: 9, size: 90 },
    'the session the reader selected keeps the revision the last walk saw',
  );
  assert.deepEqual([next[0], next[2]], [held[0], held[2]], 'a selection rewrote a session it was not about');
  assert.notEqual(next, held, 'the held catalog was written through rather than copied');

  // A session that has not moved is handed back as it was.
  const still = revalidatedCatalog(held, 'b', () => ({ mtimeMs: 2, size: 20 }));
  assert.deepEqual(still, held);
});

test('a selection the held catalog cannot account for falls back to the walk', () => {
  const held = [{ agent: 'claude' as const, file: 'a.jsonl', sessionId: 'a', mtimeMs: 1, size: 10 }];
  const stat = () => ({ mtimeMs: 1, size: 10 });

  // Without a selected session, the held catalog requires a fresh walk.
  assert.equal(revalidatedCatalog(held, null, stat), null);
  // A selected id absent from the held catalog requires a fresh walk.

  assert.equal(revalidatedCatalog(held, 'gone', stat), null);
  // A missing selected transcript requires a fresh walk.
  assert.equal(
    revalidatedCatalog(held, 'a', () => null),
    null,
  );
});

test('watcher revalidation stats only known changed files and preserves their revisions', () => {
  const held = [
    { agent: 'claude' as const, file: 'a.jsonl', sessionId: 'a', mtimeMs: 1, size: 10 },
    { agent: 'claude' as const, file: 'b.jsonl', sessionId: 'b', mtimeMs: 2, size: 20 },
    { agent: 'claude' as const, file: 'c.jsonl', sessionId: 'c', mtimeMs: 3, size: 30 },
  ];
  const asked: string[] = [];
  const next = revalidatedCatalogPaths(held, ['a.jsonl', 'c.jsonl'], (file) => {
    asked.push(file);
    return { mtimeMs: file === 'a.jsonl' ? 11 : 33, size: file === 'a.jsonl' ? 110 : 330 };
  });

  assert.deepEqual(asked, ['a.jsonl', 'c.jsonl']);
  assert.deepEqual(next, [{ ...held[0], mtimeMs: 11, size: 110 }, held[1], { ...held[2], mtimeMs: 33, size: 330 }]);
});

test('unknown, removed, and empty watcher paths require an authoritative catalog walk', () => {
  const held = [{ agent: 'claude' as const, file: 'a.jsonl', sessionId: 'a', mtimeMs: 1, size: 10 }];
  const stat = () => ({ mtimeMs: 1, size: 10 });

  assert.equal(revalidatedCatalogPaths(held, [], stat), null);
  assert.equal(revalidatedCatalogPaths(held, ['new.jsonl'], stat), null);
  assert.equal(
    revalidatedCatalogPaths(held, ['a.jsonl'], () => null),
    null,
  );
});

test('a reused catalog offers only the revision it read again', () => {
  // A full catalog walk supplies every listed revision to Project cost indexing.

  const held = [
    { agent: 'claude' as const, file: 'a.jsonl', sessionId: 'a', mtimeMs: 1, size: 10 },
    { agent: 'claude' as const, file: 'b.jsonl', sessionId: 'b', mtimeMs: 2, size: 20 },
  ];
  assert.deepEqual([...trustedListedRevisions(held, true, 'a').keys()], ['a.jsonl', 'b.jsonl']);

  // A reused catalog supplies only its revalidated selected revision, leaving other sources for independent revision reads.

  const trusted = trustedListedRevisions(held, false, 'a');
  assert.deepEqual(
    [...trusted.keys()],
    ['a.jsonl'],
    'a reused catalog hands the offer revisions it did not read, so a grown source is skipped',
  );
  assert.deepEqual(trusted.get('a.jsonl'), { mtimeMs: 1, size: 10 });

  // Without a selected session, the reused catalog supplies no checked revisions.
  assert.equal(trustedListedRevisions(held, false, null).size, 0);
});

test('a cache write with no recorded split names no lifetime', () => {
  // Unsplit cache writes use the one-hour price category without establishing a recorded cache lifetime.

  const unsplit = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 620_000 } as never;
  assert.equal(claudeUsage(unsplit).cacheWrite1h, 620_000, 'the unsplit write stopped being priced at the hour');
  assert.equal(claudeCacheLifetime(unsplit), null, 'a price fallback is reported as a recorded lifetime');

  const hour = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation: { ephemeral_1h_input_tokens: 620_000 },
  } as never;
  assert.equal(claudeCacheLifetime(hour), '1h');

  const short = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 6_000 },
  } as never;
  assert.equal(claudeCacheLifetime(short), '5m');

  assert.equal(
    claudeCacheLifetime({ input_tokens: 10, output_tokens: 5 }),
    null,
    'a request that wrote no cache names a lifetime',
  );
});

// Context state retains its establishing request separately from aggregate usage and the turn's end timestamp.

test('a turn records the request that set its context level', () => {
  const file = writeTranscript([
    userPrompt('do the thing', 0),
    // The earlier request writes one-hour cache. The later request writes five-minute cache and sets the context level.

    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'm-a',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'tu-a', name: 'Bash', input: {} }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 1_000,
          cache_creation: { ephemeral_1h_input_tokens: 400_000 },
          service_tier: 'standard',
        },
      },
    },
    {
      type: 'assistant',
      timestamp: at(2),
      message: {
        role: 'assistant',
        id: 'm-b',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Working on it.' }],
        usage: {
          input_tokens: 20,
          output_tokens: 40,
          cache_read_input_tokens: 500_000,
          cache_creation: { ephemeral_5m_input_tokens: 6_000 },
          inference_geo: 'global',
          service_tier: 'standard',
        },
      },
    },
    // A later synthetic record advances the turn end without refreshing the context request.

    {
      type: 'assistant',
      timestamp: at(7_200),
      message: {
        role: 'assistant',
        id: 'm-x',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: overloaded' }],
      },
    },
  ]);
  const [only] = readTurns(file, 'sess');
  assert.ok(only.contextRequest, 'the turn records nothing about the request behind its level');
  assert.equal(
    only.contextRequest.at,
    Date.parse(at(2)),
    'the request is dated from the turn end rather than from itself',
  );
  assert.equal(only.contextRequest.lifetime, '5m', 'the lifetime comes from the whole turn rather than that request');
  assert.equal(only.contextRequest.readBack, true);
  assert.equal(only.contextRequest.outputTokens, 40);
  assert.equal(only.contextRequest.inferenceClass, 'global');
  assert.equal(only.contextRequest.serviceTier, 'standard');
  assert.equal(only.endedAt, Date.parse(at(7_200)), 'the turn no longer ends on its last activity');
  assert.equal(only.contextTokens, 506_020);
});

// Compaction after the context request invalidates its cache state even when later activity advances the turn end.

test('a compaction between the last request and the end of its turn still drops the cache', () => {
  const file = writeTranscript([
    userPrompt('do the thing', 0),
    {
      type: 'assistant',
      timestamp: at(2),
      message: {
        role: 'assistant',
        id: 'm-a',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'tu-a', name: 'Bash', input: {} }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 600_000,
          cache_creation: { ephemeral_1h_input_tokens: 20_000 },
        },
      },
    },
    {
      type: 'system',
      timestamp: at(3),
      compactMetadata: { trigger: 'manual', preTokens: 620_010, postTokens: 42_000 },
    },
    { ...userPrompt('summary', 3), isCompactSummary: true, message: { role: 'user', content: 'summary' } },
    // Later synthetic activity advances the turn end without a model request.
    {
      type: 'assistant',
      timestamp: at(7_200),
      message: {
        role: 'assistant',
        id: 'm-x',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: overloaded' }],
      },
    },
  ]);
  const read = readSession(file, 'sess');
  const newest = read.turns[read.turns.length - 1];
  const compaction = read.compactions[read.compactions.length - 1];
  assert.ok(newest.contextRequest, 'the turn records nothing about the request behind its level');
  assert.ok(
    newest.contextRequest.at < compaction.at && compaction.at < newest.endedAt,
    'the fixture does not put the compaction between the request and the end of its turn',
  );
  const basis = nextTurnBasisOf(newest, compaction);
  assert.equal(basis?.afterCompaction, true, 'the cache state is dated from the turn rather than from its request');
  assert.equal(basis?.tier, null, 'the panel carries the lifetime a request before the compaction bought');
  assert.equal(basis?.readBack, false);
  assert.equal(basis?.lastRequestAt, compaction.at, 'the compaction is the newest request and is not the clock');
});

test('a request that only reads the prefix back keeps the lifetime the session bought', () => {
  const file = writeTranscript([
    userPrompt('first', 0),
    assistantText('One.', 1, undefined, undefined, 'end_turn'),
    userPrompt('second', 2),
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        role: 'assistant',
        id: 'm-c',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'tu-c', name: 'Read', input: {} }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 500_000 },
        },
      },
    },
    {
      type: 'assistant',
      timestamp: at(4),
      message: {
        role: 'assistant',
        id: 'm-d',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Two.' }],
        usage: { input_tokens: 5, output_tokens: 30, cache_read_input_tokens: 510_000 },
      },
    },
  ]);
  const turns = readTurns(file, 'sess');
  const last = turns[turns.length - 1];
  // A read-only cache request retains the earlier write's lifetime while recording its own request timestamp.

  assert.equal(last.contextRequest?.lifetime, '1h');
  assert.equal(last.contextRequest?.at, Date.parse(at(4)));
  assert.equal(last.contextRequest?.readBack, true);
});

test('a request that wrote two lifetimes at once names neither', () => {
  const file = writeTranscript([
    userPrompt('mixed', 0),
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        id: 'm-e',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 619_000 },
        },
      },
    },
  ]);
  const [only] = readTurns(file, 'sess');
  // Mixed cache-write lifetimes leave the context request's lifetime unavailable.

  assert.equal(only.contextRequest?.lifetime, null);
  assert.equal(only.contextRequest?.readBack, false);
});

test('a session whose first prompt is a slash command is named by the command and its arguments', () => {
  const file = writeTranscript([
    userPrompt(
      '<command-message>land</command-message>\n<command-name>/land</command-name>\n<command-args>stable session names</command-args>',
      0,
    ),
    assistantAnswer('Done.', 1),
    userPrompt('looks good', 2),
  ]);
  assert.equal(readSessionMeta(file).title, '/land stable session names');
  assert.equal(readSessionMeta(file).titleSource, 'prompt');
});

test('a name the owner gave outranks a newer generated title', () => {
  const file = writeTranscript([
    userPrompt('build the timeline', 0),
    { type: 'custom-title', customTitle: 'Owner name', sessionId: 'sess' },
    { type: 'ai-title', aiTitle: 'Generated name', sessionId: 'sess' },
    assistantAnswer('Done.', 1),
  ]);
  assert.equal(readSessionMeta(file).title, 'Owner name');
  assert.equal(readSessionMeta(file).titleSource, 'custom');
  const turn = readSession(file, 'sess').turns[0];
  assert.equal(turn.sessionTitle, 'Owner name');
  assert.equal(turn.sessionTitleSource, 'custom');
});

test('a blank custom title clears the custom name in the tail read and in the parse alike', () => {
  const file = writeTranscript([
    userPrompt('build the timeline', 0),
    { type: 'ai-title', aiTitle: 'Generated name', sessionId: 'sess' },
    { type: 'custom-title', customTitle: 'Owner name', sessionId: 'sess' },
    assistantAnswer('Done.', 1),
    { type: 'custom-title', customTitle: '   ', sessionId: 'sess' },
  ]);
  const meta = readSessionMeta(file);
  const turn = readSession(file, 'sess').turns[0];
  assert.deepEqual([meta.title, meta.titleSource], ['Generated name', 'generated']);
  assert.deepEqual([turn.sessionTitle, turn.sessionTitleSource], ['Generated name', 'generated']);
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: '', sessionId: 'sess' }) + '\n');
  assert.equal(readSessionMeta(file).title, 'Generated name');
  assert.equal(readSession(file, 'sess').turns[0].sessionTitle, 'Generated name');
});

// A blank custom-title record clears the parsed custom title while SessionNames retains its held custom name.

test('a blank custom title leaves a held custom name where it was', () => {
  const file = writeTranscript([
    userPrompt('build the timeline', 0),
    { type: 'ai-title', aiTitle: 'Generated name', sessionId: 'sess' },
    { type: 'custom-title', customTitle: 'Owner name', sessionId: 'sess' },
    assistantAnswer('Done.', 1),
  ]);
  const names = new SessionNames();
  const named = readSessionMeta(file);
  assert.deepEqual([named.title, named.titleSource], ['Owner name', 'custom']);
  names.observe(
    'sess',
    {
      label: named.title ?? '',
      fullLabel: named.fullTitle ?? '',
      source: 'custom',
      at: named.titleAt,
    },
    { size: fs.statSync(file).size },
  );

  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: '   ', sessionId: 'sess' }) + '\n');
  const cleared = readSessionMeta(file);
  assert.deepEqual([cleared.title, cleared.titleSource], ['Generated name', 'generated']);
  names.observe(
    'sess',
    {
      label: cleared.title ?? '',
      fullLabel: cleared.fullTitle ?? '',
      source: 'generated',
      at: cleared.titleAt,
    },
    { size: fs.statSync(file).size },
  );
  assert.equal(
    names.get('sess')?.label,
    'Owner name',
    'the panel dropped the custom name a blank record cleared for one read',
  );
});

test('a title read from the tail knows the byte offset of its record', () => {
  const file = writeTranscript([
    userPrompt(`build the timeline ${'y'.repeat(3000)}`, 0),
    { type: 'ai-title', aiTitle: 'Generated name', sessionId: 'sess' },
    assistantAnswer('x'.repeat(2048), 1),
  ]);
  const text = fs.readFileSync(file, 'utf8');
  const at = Buffer.byteLength(text.slice(0, text.indexOf('{"type":"ai-title"')));
  assert.equal(readSessionMeta(file).titleAt, at);
  assert.equal(readSessionMeta(file, 1024 + text.length - at).titleAt, at, 'a window that starts mid-file');
});

test('the saved Claude title file is read whole up to 4 KiB and not at all beyond it', () => {
  const dir = tempDir('custom-title-');
  const file = path.join(dir, 'session-7.jsonl');
  fs.writeFileSync(file, '');
  fs.mkdirSync(path.join(dir, 'session-7'));
  const sidecar = path.join(dir, 'session-7', 'custom-title.json');
  const saved = (title: string, padding = 0) =>
    fs.writeFileSync(sidecar, JSON.stringify({ customTitle: title }) + ' '.repeat(padding));
  const long = 'x'.repeat(300);
  saved(long);
  assert.equal(readCustomTitleSidecar(file), long, 'the saved title came back cut short');
  const frame = JSON.stringify({ customTitle: 'Complete name' }).length;
  saved('Complete name', CUSTOM_TITLE_SIDECAR_BYTES - frame);
  assert.equal(fs.statSync(sidecar).size, CUSTOM_TITLE_SIDECAR_BYTES);
  assert.equal(readCustomTitleSidecar(file), 'Complete name');
  saved('Complete name', CUSTOM_TITLE_SIDECAR_BYTES - frame + 1);
  assert.equal(readCustomTitleSidecar(file), null, 'a saved title file over 4 KiB was read');
});

// Read the Bedrock tool-call transcript fixture.

const BEDROCK_SESSION = fs.readFileSync(
  path.join(__dirname, '..', '..', 'test', 'fixtures', 'bedrock-tool-calls.jsonl'),
  'utf8',
);
const BEDROCK_LIST_PRICE = 0.1585482;

function bedrockSessionCost(text: string) {
  const [turn] = readSession(
    writeTranscript(
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ),
    'sess',
  ).turns;
  const cost = (turn.usageParts ?? []).reduce(
    (total, part) =>
      total +
      (quoteUsage({
        usage: part.usage,
        model: part.model,
        inferenceClass: part.inferenceClass,
        serviceTier: part.serviceTier,
      })?.cost ?? Number.NaN),
    0,
  );
  return { turn, cost };
}

test('a Bedrock session prices each response once at 1.1 times list on a regional profile', () => {
  const { turn, cost } = bedrockSessionCost(BEDROCK_SESSION);
  assert.deepEqual(
    turn.usageParts?.map((part) => [part.model, part.inferenceClass, part.usage.requests]),
    [['claude-opus-5-5', 'bedrock-regional', 2]],
  );
  assert.ok(Math.abs(cost - BEDROCK_LIST_PRICE * 1.1) < 1e-9, `priced at ${cost}`);
});

test('every Bedrock profile but global. pays 1.1 times list, and a session with no profile does too', () => {
  const profiles: Array<[string, number]> = [
    ['global.anthropic.claude-opus-5-5[1m]', 1],
    ['apac.anthropic.claude-opus-5-5', 1.1],
    ['eu.anthropic.claude-opus-5-5', 1.1],
    ['anthropic.claude-opus-5-5', 1.1],
  ];
  for (const [profile, multiplier] of profiles) {
    const { cost } = bedrockSessionCost(BEDROCK_SESSION.replace('us.anthropic.claude-opus-5-5[1m]', profile));
    assert.ok(Math.abs(cost - BEDROCK_LIST_PRICE * multiplier) < 1e-9, `${profile} priced at ${cost}`);
  }
  const unnamed = BEDROCK_SESSION.split('\n')
    .filter((line) => !line.includes('"modelId"'))
    .join('\n');
  assert.ok(Math.abs(bedrockSessionCost(unnamed).cost - BEDROCK_LIST_PRICE * 1.1) < 1e-9);
});

test('a Bedrock request read as in-region pays the regional charge once', () => {
  const { turn, cost } = bedrockSessionCost(BEDROCK_SESSION.replaceAll('"inference_geo":""', '"inference_geo":"us"'));
  assert.equal(turn.usageParts?.[0].inferenceClass, 'bedrock-regional');
  assert.ok(Math.abs(cost - BEDROCK_LIST_PRICE * 1.1) < 1e-9, `priced at ${cost}`);
});

test('a global. Bedrock request read as in-region still pays list', () => {
  const { turn, cost } = bedrockSessionCost(
    BEDROCK_SESSION.replace('us.anthropic.claude-opus-5-5[1m]', 'global.anthropic.claude-opus-5-5[1m]').replaceAll(
      '"inference_geo":""',
      '"inference_geo":"us"',
    ),
  );
  assert.equal(turn.usageParts?.[0].inferenceClass, null);
  assert.ok(Math.abs(cost - BEDROCK_LIST_PRICE) < 1e-9, `priced at ${cost}`);
});

test('the next-turn price and the compaction estimate carry the Bedrock class', () => {
  const { turn } = bedrockSessionCost(BEDROCK_SESSION);
  assert.equal(turn.contextRequest?.inferenceClass, 'bedrock-regional');
  const reducer = createClaudeUsageLineReducer();
  for (const line of BEDROCK_SESSION.trim().split('\n')) {
    reducer.pushLine(line);
  }
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: '2026-09-24T00:09:00.000Z',
    compactMetadata: { trigger: 'manual', preTokens: 29_500, postTokens: 400 },
  };
  const summary = {
    type: 'user',
    isCompactSummary: true,
    timestamp: '2026-09-24T00:09:00.100Z',
    message: { role: 'user', content: 'summary' },
  };
  reducer.pushLine(JSON.stringify(boundary));
  const [estimate] = reducer.pushLine(JSON.stringify(summary));
  assert.equal(estimate?.compactionEstimate, true);
  assert.equal(estimate?.inferenceClass, 'bedrock-regional');
});

test('a Bedrock request pays by the newest model attachment, across a model switch and a restored state', () => {
  const lines = BEDROCK_SESSION.trim().split('\n');
  const attachment = lines.find((line) => line.includes('"modelId"'))!;
  const requests = lines.filter((line) => line.includes('"type":"assistant"'));
  const globalAttachment = attachment.replace('us.anthropic.claude-opus-5-5[1m]', 'global.anthropic.claude-opus-5-5');
  const first = createClaudeUsageLineReducer();
  first.pushLine(globalAttachment);
  const [onGlobal] = first.pushLine(requests[0]);
  assert.equal(onGlobal.inferenceClass, null);
  const resumed = createClaudeUsageLineReducer(JSON.parse(JSON.stringify(first.snapshot())));
  assert.equal(resumed.pushLine(requests[3])[0].inferenceClass, null, 'the restored state lost the profile');
  resumed.pushLine(attachment);
  const later = JSON.parse(requests[3]);
  later.message.id = 'msg_bdrk_after_switch';
  assert.equal(resumed.pushLine(JSON.stringify(later))[0].inferenceClass, 'bedrock-regional');
});

test('an appended Bedrock request after a cached parse still prices a global. session at list', () => {
  const lines = BEDROCK_SESSION.trim()
    .split('\n')
    .map((line) => line.replace('us.anthropic.claude-opus-5-5[1m]', 'global.anthropic.claude-opus-5-5'));
  const last = lines.map((line) => line.includes('"type":"assistant"')).lastIndexOf(true);
  const file = writeTranscript(lines.slice(0, last).map((line) => JSON.parse(line)));
  const initial = readClaudeSessionIncremental(file, 'sess');
  assert.ok(initial.checkpoint);
  fs.appendFileSync(file, lines.slice(last).join('\n') + '\n');
  const applied = readClaudeSessionIncremental(file, 'sess', initial.checkpoint ?? undefined);
  assert.equal(applied.kind, 'appended');
  const [turn] = applied.read?.turns ?? [];
  assert.deepEqual(
    turn?.usageParts?.map((part) => [part.inferenceClass, part.usage.requests]),
    [[null, 2]],
  );
  assert.equal(turn?.contextRequest?.inferenceClass, null);
});

test('a Bedrock subagent prices by the model attachment in its own transcript', () => {
  const classes = (text: string) => {
    const records = text
      .trim()
      .split('\n')
      .map((line) => ({ ...JSON.parse(line), isSidechain: true }));
    const spend = readClaudeAgentSpend(writeTranscript(records), [], true);
    return spend.models.flatMap((model) => (model.usageParts ?? []).map((part) => part.inferenceClass));
  };
  assert.deepEqual(classes(BEDROCK_SESSION), ['bedrock-regional']);
  assert.deepEqual(
    classes(BEDROCK_SESSION.replace('us.anthropic.claude-opus-5-5[1m]', 'global.anthropic.claude-opus-5-5')),
    [null],
  );
});

test('Claude parents link exact Codex receipts and direct stdout without prefix or provider collisions', () => {
  const ids = ['aaaaaaaa-1111-1111-1111-111111111111', 'aaaaaaaa-2222-2222-2222-222222222222'];
  const receipt = (id: string) => `ARC_DISPATCH_SESSION=${JSON.stringify({ agent: 'codex', session_id: id })}`;
  const parent = writeTranscript(
    claudeDispatchTranscript('python a.py --arc-dispatch && python b.py --arc-dispatch', ids.map(receipt).join('\n')),
  );
  const raw = readClaudeChildSessionReferences({ file: parent, sessionId: 'parent' });
  assert.deepEqual(
    raw.map((reference) => reference.sessionId),
    ids,
  );
  const catalog = ids.map((id) => ({
    agent: 'codex' as const,
    file: `C:/sessions/${id}.jsonl`,
    sessionId: id,
    mtimeMs: 1,
    size: 1,
  }));
  assert.equal(resolveClaudeDispatchReferences(raw, catalog).length, 2);
  assert.deepEqual(
    resolveClaudeDispatchReferences(
      raw,
      catalog.map((session) => ({ ...session, agent: 'claude' as const })),
    ),
    [],
  );
  const short = writeTranscript(claudeDispatchTranscript('python a.py --arc-dispatch', receipt('aaaaaaaa')));
  assert.deepEqual(readClaudeChildSessionReferences({ file: short, sessionId: 'parent' }), []);
  const event = JSON.stringify({ type: 'thread.started', thread_id: ids[0] });
  for (const command of ['codex exec --json -', '"C:/Tools/codex.cmd" exec --json -', '/usr/bin/codex exec --json -']) {
    const file = writeTranscript(claudeDispatchTranscript(command, event));
    assert.deepEqual(
      readClaudeChildSessionReferences({ file, sessionId: 'parent' }).map((reference) => reference.sessionId),
      [ids[0]],
    );
    assert.deepEqual(readSession(file, 'parent').turns[0].dispatchToolUseIds, ['dispatch-1']);
  }
});

test('a Claude turn keeps the model attachment that names its reply model', () => {
  const attach = (modelId: string, extra: Record<string, unknown> = {}) => ({
    type: 'attachment',
    timestamp: at(0),
    attachment: { type: 'model', identity: { modelId } },
    ...extra,
  });
  const reply = (model: string, text: string, second: number) => {
    const record = assistantAnswer(text, second);
    record.message.model = model;
    return record;
  };
  const records = [
    attach('claude-opus-5-5[1m]'),
    userPrompt('one', 1),
    reply('claude-opus-5-5', 'a', 2),
    attach('claude-opus-5-5'),
    userPrompt('two', 3),
    reply('claude-opus-5-5', 'b', 4),
    userPrompt('three', 5),
    reply('claude-sonnet-5-5', 'c', 6),
    userPrompt('four', 7),
    reply('claude-opus-5-5', 'd', 8),
    attach('global.anthropic.claude-opus-5-5[1m]'),
    userPrompt('five', 9),
    reply('claude-opus-5-5', 'e', 10),
    attach('claude-opus-5-5', { isSidechain: true }),
    userPrompt('six', 11),
    reply('claude-opus-5-5', 'f', 12),
  ];
  const whole = createClaudeSessionReducer('sess');
  for (const record of records) {
    whole.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(
    whole.read().turns.map((turn) => [turn.prompt, turn.model, turn.modelAttachment ?? null]),
    [
      ['one', 'claude-opus-5-5', 'claude-opus-5-5[1m]'],
      ['two', 'claude-opus-5-5', 'claude-opus-5-5'],
      ['three', 'claude-sonnet-5-5', null],
      ['four', 'claude-opus-5-5', null],
      ['five', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]'],
      ['six', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]'],
    ],
  );
  const first = createClaudeSessionReducer('sess');
  for (const record of records.slice(0, 4)) {
    first.pushLine(JSON.stringify(record));
  }
  const resumed = createClaudeSessionReducer('sess', {}, first.snapshot());
  for (const record of records.slice(4)) {
    resumed.pushLine(JSON.stringify(record));
  }
  assert.deepEqual(resumed.read(), whole.read(), 'a restored checkpoint lost the attachment it had applied');
});

test('a reply before the first retained prompt invalidates attachment evidence', () => {
  const reducer = createClaudeSessionReducer('sess');
  reducer.pushLine(
    JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } } }),
  );
  const reply = assistantAnswer('before prompt', 1);
  reply.message.model = 'claude-sonnet-5-5';
  reducer.pushLine(JSON.stringify(reply));
  reducer.pushLine(JSON.stringify(userPrompt('Go', 2)));
  reply.message.model = 'claude-opus-5-5';
  reducer.pushLine(JSON.stringify(reply));
  assert.equal(reducer.read().turns[0].modelAttachment, undefined);
});

test('an invalid model attachment cannot restore stale composer evidence', () => {
  for (const invalidation of ['reply', 'skipped']) {
    const reducer = createClaudeSessionReducer('sess');
    reducer.pushLine(
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } },
      }),
    );
    reducer.pushLine(JSON.stringify(userPrompt('Go', 1)));
    const reply = assistantAnswer('Done', 2);
    reply.message.model = 'claude-sonnet-5-5';
    if (invalidation === 'reply') reducer.pushLine(JSON.stringify(reply));
    else reducer.skipped();
    reducer.pushLine(
      JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: null } } }),
    );
    reply.message.model = 'claude-opus-5-5';
    reducer.pushLine(JSON.stringify(reply));
    assert.equal(reducer.read().turns[0].modelAttachment, undefined, invalidation);
    assert.equal(reducer.snapshot().usageState.modelProfile, 'claude-opus-5-5[1m]');
  }
});

test('literal nested commit scripts retain complete targets without output ordering', () => {
  const command =
    "Set-Location C:/repo; & 'C:/tools/bash.exe' -c 'cd child && git -C ../notes -C nested commit -m first; git -C C:/other commit -q -m second'";
  assert.deepEqual(inspectCommitCommand(command, 'C:/start', 'powershell'), {
    dirs: ['C:/repo/notes/nested', 'C:/other'],
    complete: true,
    ran: true,
  });
  for (const reverse of [false, true]) {
    const row = { commits: [] as TurnCommit[] };
    const stdout = '[main abc1234] Printed second\n 1 file changed, 2 insertions(+)';
    if (reverse) recordCommits(row, stdout, 1, 'unreadable', [], 'C:/start');
    recordCommits(row, stdout, 2, { command, shell: 'powershell', cwd: 'C:/start', at: 0 });
    if (!reverse) recordCommits(row, stdout, 3, 'unreadable', [], 'C:/start');
    assert.equal(row.commits.length, 1);
    assert.equal(row.commits[0].dir, null);
    assert.deepEqual(row.commits[0].candidates, {
      dirs: ['C:/start', 'C:/repo/notes/nested', 'C:/other'],
      complete: true,
    });
    assert.equal(row.commits[0].at, reverse ? 1 : 2);
    assert.equal(row.commits[0].added, 2);
  }
});

test('nested script admission rejects copied output and ambiguous arguments', () => {
  for (const command of [
    "echo bash -c 'git commit -m copied'",
    "# bash -c 'git commit -m copied'",
    'bash -c $script',
    'bash -c "git -C $repo commit -m dynamic"',
  ]) {
    const row = { commits: [] as TurnCommit[] };
    recordCommits(row, '[main abc1234] Copied', 1, { command, shell: 'bash', cwd: 'C:/repo', at: 0 });
    assert.deepEqual(row.commits, [], command);
  }
  assert.equal(inspectCommitCommand('cd $target; git commit -m unknown', 'C:/repo', 'bash').complete, false);
  const quiet = { commits: [] as TurnCommit[], commitIntents: [] };
  recordCommits(
    quiet,
    '',
    2,
    { command: "bash -c 'git commit -q -m quiet'", shell: 'bash', cwd: 'C:/repo', at: 0 },
    [],
    null,
    { from: 0, failed: false },
  );
  assert.deepEqual(quiet.commitIntents, [], 'nested exit status borrowed a quiet commit');
});

test('printed identities retain distinct full hashes behind the same displayed prefix', () => {
  const row = { commits: [] as TurnCommit[] };
  const first = 'abc12345' + '1'.repeat(32);
  const second = 'abc12345' + '2'.repeat(32);
  recordCommits(row, `[main ${first}] First\n[main ${second}] Second`, 1, {
    command: 'git commit -m first',
    cwd: 'C:/repo',
    at: 0,
  });
  assert.deepEqual(
    row.commits.map((c) => c.printedSha),
    [first, second],
  );
});

test('decoded nested scripts reject commented Git beside copied commit output', () => {
  const slash = String.fromCharCode(92);
  for (const command of [
    "bash -c '# ignored\ngit --version # genuine read'",
    "pwsh -Command '# ignored\ngit --version # genuine read'",
  ]) {
    assert.equal(inspectCommitCommand(command, 'C:/repo', 'bash').ran, true);
  }
  for (const command of [
    "bash -c '# git commit -m copied'",
    "pwsh -Command '# git commit -m copied'",
    '# git commit -m copied',
    `pwsh -Command 'Set-Location C:${slash}repo${slash} # copied; git commit -m copied'`,
  ]) {
    const row = { commits: [] as TurnCommit[] };
    recordCommits(row, '[main abc1234] Copied', 1, { command, shell: 'bash', cwd: 'C:/repo', at: 0 });
    assert.deepEqual(row.commits, [], command);
    assert.deepEqual(inspectCommitCommand(command, 'C:/repo', 'bash').dirs, [], command);
  }
});

test('decoded PowerShell scripts preserve literal directory quotes and trailing backslashes', () => {
  const slash = String.fromCharCode(92);
  for (const [command, dir] of [
    [`pwsh -Command "Set-Location 'C:/O''Brien/'; git commit -m saved"`, "C:/O'Brien"],
    [`pwsh -Command "git -C 'C:/O''Brien/' -C nested commit -m saved"`, "C:/O'Brien/nested"],
    [`pwsh -Command 'Set-Location "C:${slash}repo${slash}"; git commit -m saved'`, 'C:/repo'],
    [`pwsh -Command 'git -C "C:${slash}repo${slash}" commit -m saved'`, 'C:/repo'],
  ]) {
    assert.deepEqual(
      inspectCommitCommand(command, 'C:/start', 'bash'),
      {
        dirs: [dir],
        complete: true,
        ran: true,
      },
      command,
    );
  }
  assert.equal(
    inspectCommitCommand(`pwsh -Command 'Set-Location "$repo"; git commit -m saved'`, 'C:/start', 'bash').complete,
    false,
  );
});

test('a subagent head read counts its bounded bytes once and a cached head counts none', () => {
  const directory = tempDir('claude-child-head-meter-');
  const file = path.join(directory, 'agent-child.jsonl');
  fs.writeFileSync(
    file,
    [
      { type: 'user', cwd: directory },
      { type: 'assistant', padding: 'x'.repeat(100 * 1024) },
    ]
      .map((record) => JSON.stringify(record) + '\n')
      .join(''),
  );
  const reference = {
    kind: 'subagent' as const,
    file,
    sessionId: 'child',
    parentSessionId: 'parent',
    toolUseIds: ['launch'],
  };
  const cache = new ClaudeChildSessionCache();
  let clock = 10;
  try {
    const cold = openReadWindow(() => clock);
    assert.equal(cache.read(reference, [directory])?.cwd, directory);
    clock = 13;
    assert.deepEqual(
      closeReadWindow(cold, () => clock),
      { files: 1, bytes: 64 * 1024, ms: 3 },
    );
    const warm = openReadWindow(() => clock);
    assert.equal(cache.read(reference, [directory])?.cwd, directory);
    assert.deepEqual(
      closeReadWindow(warm, () => clock),
      { files: 0, bytes: 0, ms: 0 },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('mixed-tier prefix lifetime survives only preserved executor prefixes and clears unknown writes', () => {
  const cases = [
    ['hour prefix', PER_PASS_ITERATIONS, '1h'],
    [
      'short prefix',
      PER_PASS_ITERATIONS.map((pass) => ({
        ...pass,
        cache_creation: {
          ephemeral_5m_input_tokens: pass.cache_creation.ephemeral_1h_input_tokens,
          ephemeral_1h_input_tokens: pass.cache_creation.ephemeral_5m_input_tokens,
        },
      })),
      '5m',
    ],
    [
      'rewrite',
      PER_PASS_ITERATIONS.map((pass, index) => (index === 2 ? { ...pass, cache_read_input_tokens: 65579 } : pass)),
      null,
    ],
    [
      'initial read',
      PER_PASS_ITERATIONS.map((pass, index) => (index === 0 ? { ...pass, cache_read_input_tokens: 1 } : pass)),
      null,
    ],
    [
      'omitted initial read',
      PER_PASS_ITERATIONS.map((pass, index) => {
        if (index !== 0) return pass;
        const { cache_read_input_tokens: _read, ...withoutRead } = pass;
        return withoutRead;
      }) as unknown as typeof PER_PASS_ITERATIONS,
      null,
    ],
    [
      'null initial read',
      PER_PASS_ITERATIONS.map((pass, index) =>
        index === 0 ? { ...pass, cache_read_input_tokens: null } : pass,
      ) as unknown as typeof PER_PASS_ITERATIONS,
      null,
    ],
    [
      'unknown write',
      PER_PASS_ITERATIONS.map((pass, index) =>
        index === 2
          ? {
              ...pass,
              cache_creation: {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: 0,
              },
            }
          : pass,
      ),
      null,
    ],
    ['later read lost', [...PER_PASS_ITERATIONS, advisorIteration({ cache_read_input_tokens: 65579 })], null],
    [
      'single tier',
      [
        PER_PASS_ITERATIONS[0],
        advisorIteration({
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 453,
          },
        }),
      ],
      '1h',
    ],
  ] as const;
  for (const [name, iterations, expected] of cases) {
    const seed = advisorResponseRecords({ id: 'known', iterations: [PER_PASS_ITERATIONS[0]], blocks: 1 });
    const records = advisorResponseRecords({ id: name, at: 30, iterations, blocks: 1 });
    const first = createClaudeUsageLineReducer();
    seed.forEach((record) => first.pushLine(JSON.stringify(record)));
    const restored = createClaudeUsageLineReducer(JSON.parse(JSON.stringify(first.snapshot())));
    const events = records.flatMap((record) => restored.pushLine(JSON.stringify(record)));
    assert.equal(events[0].cacheLifetime, expected, name);
    assert.equal(restored.snapshot().lastRequest?.lifetime, expected, name);
    const readOnly = advisorResponseRecords({
      id: 'read-only',
      at: 60,
      blocks: 1,
      iterations: [advisorIteration({ cache_read_input_tokens: 66033 })],
    });
    const later = readOnly.flatMap((record) => restored.pushLine(JSON.stringify(record)));
    assert.equal(later[0].cacheLifetime, expected, `${name} read-only`);
    const turns = readTurns(writeTranscript([userPrompt('prefix', 0), ...seed, ...records, ...readOnly]), 'sess');
    assert.equal(turns.at(-1)?.contextRequest?.lifetime, expected, `${name} context`);
  }
});

test('mixed-tier prefix lifetime keeps a ten-minute compaction warm through a restored reducer', () => {
  const records = [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations: PER_PASS_ITERATIONS, blocks: 1 })];
  const initial = createClaudeUsageLineReducer();
  records.forEach((record) => initial.pushLine(JSON.stringify(record)));
  const resumed = createClaudeUsageLineReducer(JSON.parse(JSON.stringify(initial.snapshot())));
  assert.equal(resumed.snapshot().lastRequest?.lifetime, '1h');
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: '2026-10-11T09:18:10.214Z',
    compactMetadata: { trigger: 'manual', preTokens: 66035, postTokens: 1000 },
  };
  const summary = {
    type: 'user',
    timestamp: '2026-10-11T09:18:10.215Z',
    isCompactSummary: true,
    message: { role: 'user', content: 'summary'.repeat(100) },
  };
  const estimates = [boundary, summary].flatMap((record) => resumed.pushLine(JSON.stringify(record)));
  const estimate = estimates.find((event) => event.compactionEstimate)!;
  assert.ok(estimate);
  assert.equal(estimate.usage.cacheRead, 65580);
  assert.equal(estimate.usage.cacheWrite5m, 453);
  assert.equal(estimate.usage.cacheWrite1h, 0);
  assert.equal(estimate.usage.input, 2000);
});

test('a Claude advisor consultation is its own request, and the executor prices and measures from its passes', () => {
  const reducer = createClaudeUsageLineReducer();
  const events = advisorProbeRecords().flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.deepEqual(
    events.map((event) => [event.model, event.usageOrigin ?? null, event.requestKey]),
    [
      [ADVISOR_EXECUTOR, null, 'claude:msg_011CfvBmiDT7FY5p5pPVZ2WC'],
      [ADVISOR_MODEL, 'claude-advisor', 'claude:msg_011CfvBmiDT7FY5p5pPVZ2WC:advisor:1'],
    ],
  );
  // The top-level split names only the first pass's hour writes. The last pass wrote 244 five-minute tokens.
  assert.deepEqual(
    { ...events[0].usage, byContextBand: undefined },
    {
      byContextBand: undefined,
      requests: 1,
      input: 4,
      cacheRead: 43_227,
      cacheWrite1h: 43_227,
      cacheWrite5m: 244,
      cacheWrite30m: 0,
      output: 41,
      thinking: 0,
    },
  );
  const price = events.reduce((sum, event) => sum + (estimateCost(event.usage, event.model) ?? Number.NaN), 0);
  assert.ok(Math.abs(price - 0.10366307) < 1e-9, String(price));
  // The context is what the last executor pass read: 2 input, 43,227 cache read and 244 cache write.
  assert.equal(reducer.snapshot().lastRequest?.tokens, 43_473);
  assert.equal(events[0].contextTokens, 43_473);
  assert.equal(events[1].contextTokens, undefined);
  assert.equal(reducer.snapshot().firstRequestCachedTokens, 43_227);
  const file = path.join(tempDir('advisor-turns-'), 'advisor-probe.jsonl');
  fs.writeFileSync(
    file,
    advisorProbeRecords()
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const turn = readTurns(file, 'advisor-probe').at(-1)!;
  assert.equal(turn.contextTokens, 43_473);
  assert.deepEqual(
    turn.usageParts?.map((part) => [part.model, part.usage.requests, part.usageOrigin ?? null]),
    [
      [ADVISOR_EXECUTOR, 1, null],
      [ADVISOR_MODEL, 1, 'claude-advisor'],
    ],
  );
});

test('a child read replaces each advisor consultation of a growing response, across a restored state', () => {
  // The child transcript writes the response while it runs, so later records carry more iterations.
  const lines = [1, 2, 3, 3].map((count) =>
    JSON.stringify(
      advisorResponseRecords({ sidechain: true, blocks: 1, iterations: ADVISOR_ITERATIONS.slice(0, count) })[0],
    ),
  );
  const totals = (events: readonly { model: string | null; usage: TurnUsage }[]) => {
    const byModel = new Map<string | null, [number, number]>();
    for (const { model, usage } of events) {
      const [requests, tokens] = byModel.get(model) ?? [0, 0];
      byModel.set(model, [
        requests + (usage.requests ?? 0),
        tokens + usage.input + usage.output + usage.cacheRead + usage.cacheWrite1h + usage.cacheWrite5m,
      ]);
    }
    return [...byModel].filter(([, [requests, tokens]]) => requests || tokens);
  };
  const single = [
    [ADVISOR_EXECUTOR, [1, 4 + 41 + 43_227 + 43_227 + 244]],
    [ADVISOR_MODEL, [1, 44_807 + 492]],
  ];
  const full = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  assert.deepEqual(totals(lines.flatMap((line) => full.pushLine(line))), single);
  const first = createClaudeUsageLineReducer(undefined, { childTranscript: true });
  const head = lines.slice(0, 2).flatMap((line) => first.pushLine(line));
  // A saved state is JSON, so the resumed read starts from a JSON copy.
  const resumed = createClaudeUsageLineReducer(JSON.parse(JSON.stringify(first.snapshot())), { childTranscript: true });
  assert.deepEqual(totals([...head, ...lines.slice(2).flatMap((line) => resumed.pushLine(line))]), single);
});

test('per-pass pricing measures the post-compaction prefix from the first executor pass', () => {
  const prefix = claudeCompactionTranscript(COMPACTION_SAMPLES[0]);
  const lastAt = Math.max(...prefix.map((record) => Date.parse((record as { timestamp: string }).timestamp)));
  const after = advisorResponseRecords({
    iterations: [
      advisorIteration({ cache_read_input_tokens: 1200 }),
      advisorIteration({ cache_read_input_tokens: 4000 }),
    ],
  }).map((record) => ({ ...record, timestamp: new Date(lastAt + 1000).toISOString() }));
  const file = writeTranscript([...prefix, ...after]);
  const read = readSession(file, 's');
  assert.equal(read.compactions.at(-1)?.postCompactionCacheRead, 1200);
  const reducer = createClaudeUsageLineReducer();
  const events = [...prefix, ...after].flatMap((record) => reducer.pushLine(JSON.stringify(record)));
  assert.equal(
    events.filter((event) => !event.usageOrigin && !event.compactionEstimate).at(-1)?.compactionSignal?.prefixTokens,
    1200,
  );
});

test('a child agent names its executor model when its advisor used more tokens', () => {
  const iterations = [
    advisorIteration({ input_tokens: 10, output_tokens: 5 }),
    advisorIteration({ type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 50_000, output_tokens: 600 }),
  ];
  const file = path.join(tempDir('advisor-child-'), 'agent-advisor.jsonl');
  fs.writeFileSync(file, JSON.stringify(advisorResponseRecords({ sidechain: true, iterations })[0]) + '\n');
  const spend = readClaudeAgentSpend(file);
  assert.equal(spend.ownModel, ADVISOR_EXECUTOR);
  assert.deepEqual(spend.models.map((model) => model.model).sort(), [ADVISOR_EXECUTOR, ADVISOR_MODEL]);
});

test('an advisor consultation before a compaction leaves the compaction estimate unchanged', () => {
  const row = COMPACTION_SAMPLES[0];
  const estimate = (advised: boolean) => {
    const records = claudeCompactionTranscript(row).map((record) => {
      const message = (record as { message?: { id?: string; usage?: Record<string, unknown> } }).message;
      if (!advised || message?.id !== 'answer-1' || !message.usage) return record;
      const consultation = advisorIteration({
        type: 'advisor_message',
        model: ADVISOR_MODEL,
        input_tokens: 400_000,
        output_tokens: 900,
      });
      const usage = { ...message.usage, iterations: [{ type: 'message', ...message.usage }, consultation] };
      return { ...record, message: { ...message, usage } };
    });
    const reducer = createClaudeUsageLineReducer();
    const events = records.flatMap((record) => reducer.pushLine(JSON.stringify(record)));
    return events.filter((event) => event.compactionEstimate).map((event) => [event.model, event.usage]);
  };
  const plain = estimate(false);
  assert.equal(plain.length, 1);
  assert.deepEqual(estimate(true), plain);
});

test('background retirement requires an unambiguous terminal notice for each retained launch', () => {
  const work = new ClaudeBackgroundWork();
  work.retain(
    [
      { id: 'first', startedAt: 1 },
      { id: 'second', startedAt: 2 },
    ],
    [],
  );
  const notice = (tool: string, status: string) => ({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>task-${tool}</task-id><tool-use-id>${tool}</tool-use-id><status>${status}</status></task-notification>`,
    },
  });
  for (const status of ['running', 'unknown', '', 'completed</status><status>running']) {
    const single = new ClaudeBackgroundWork();
    single.retain([{ id: 'first', startedAt: 1 }], []);
    single.observe(notice('first', status));
    assert.equal(single.pending, true, `nonterminal status ${status} released the launch`);
    work.observe(notice('first', status));
  }
  work.observe(notice('unrelated', 'completed'));
  work.observe({ ...notice('first', 'completed'), origin: undefined });
  assert.equal(work.pending, true);
  work.observe(notice('first', 'completed'));
  assert.equal(work.pending, true);
  work.observe(notice('second', 'failed'));
  assert.equal(work.pending, false);
  work.retain([{ id: 'first', startedAt: 1 }], []);
  assert.equal(work.pending, false, 'older accepted metadata reopened a completed launch');
  work.observe({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', id: 'first', input: { run_in_background: true } }] },
  });
  work.observe(notice('first', 'completed'));
  assert.equal(work.pending, true, 'a reused identity accepted an ambiguous older completion');
});

test('background retirement retains valid mixed-content launches and requires their associated task', () => {
  const work = new ClaudeBackgroundWork();
  const malformed = [null, false, 7, 'text', []];
  work.observe({
    type: 'assistant',
    message: {
      content: [...malformed, { type: 'tool_use', name: 'Bash', id: 'command', input: { run_in_background: true } }],
    },
  });
  assert.equal(work.pending, true);
  work.observe({
    type: 'user',
    tool_use_result: { backgroundTaskId: 'actual-task' },
    message: { content: [...malformed, { type: 'tool_result', tool_use_id: 'command' }] },
  });
  const notice = (task: string, extra = '') => ({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>${task}</task-id><tool-use-id>command</tool-use-id><status>completed</status>${extra}</task-notification>`,
    },
  });
  work.observe(notice('unrelated-task'));
  assert.equal(work.pending, true, 'an unrelated task released its known tool');
  for (const field of ['status', 'tool-use-id', 'task-id']) {
    for (const extra of [
      `<${field}></${field}>`,
      `<${field}/>`,
      `<${field}<nested>>`,
      `<${field}=broken>`,
      `<${field} value="x"></${field}>`,
      `<${field}>`,
      `</${field}>`,
      `<${field}><nested>x</nested></${field}>`,
    ]) {
      work.observe(notice('actual-task', extra));
      assert.equal(work.pending, true, `malformed ${field} evidence released work: ${extra}`);
    }
    work.observe({
      ...notice('actual-task'),
      message: {
        content: notice('actual-task').message.content.replace(
          new RegExp(`<${field}>[^<]+</${field}>`),
          `<${field}><nested>x</nested></${field}>`,
        ),
      },
    });
    assert.equal(work.pending, true, `a nested ${field} value released work`);
  }
  work.observe(notice('actual-task'));
  assert.equal(work.pending, false);
});

test('a background launch envelope without a UUID is serialized once', () => {
  const work = new ClaudeBackgroundWork();
  const record = {
    type: 'assistant',
    message: {
      content: Array.from({ length: 20 }, (_, index) => ({
        type: 'tool_use',
        name: 'Bash',
        id: `command-${index}`,
        input: { run_in_background: true },
      })),
    },
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    work.observe(record);
    assert.equal(stringify.mock.calls.filter(([value]) => value === record).length, 1);
    assert.equal(work.pending, true);
  } finally {
    stringify.mockRestore();
  }
});

test('a mixed-content result retains its task association without a launch record', () => {
  const work = new ClaudeBackgroundWork();
  work.observe({
    type: 'user',
    tool_use_result: { backgroundTaskId: 'actual-task' },
    message: { content: [null, false, 7, 'text', [], { type: 'tool_result', tool_use_id: 'command' }] },
  });
  assert.equal(work.pending, true);
  work.observe({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content:
        '<task-notification><task-id>actual-task</task-id><tool-use-id>command</tool-use-id><status>completed</status></task-notification>',
    },
  });
  assert.equal(work.pending, false);
});

test('a later child or submission cannot release a reused unresolved background launch', () => {
  for (const nextOwner of ['child-a:2', 'child-b:1']) {
    const work = new ClaudeBackgroundWork();
    const launch = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', id: 'shared', input: { run_in_background: true } }] },
    };
    work.observe(launch, 'child-a:1');
    work.observe(launch, 'child-a:1');
    work.observe(launch, nextOwner);
    work.observe({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content:
          '<task-notification><task-id>old-task</task-id><tool-use-id>shared</tool-use-id><status>completed</status></task-notification>',
      },
    });
    assert.equal(work.pending, true, 'an older completion released the ambiguous later launch');
  }
});

test('Claude enumeration retains unread subtree uncertainty and distinguishes missing roots from I/O failure', () => {
  const root = tempDir('claude-enumeration-');
  const cwd = 'C:/work/coverage';
  const dir = path.join(root, projectSlug(cwd));
  fs.mkdirSync(dir);
  const file = path.join(dir, 'retained.jsonl');
  fs.writeFileSync(file, '{}\n');
  const native = createRequire(__filename)('node:fs') as typeof fs;
  const read = native.readdirSync;
  const spy = vi.spyOn(native, 'readdirSync').mockImplementation(((target: fs.PathLike, ...args: any[]) => {
    if (String(target) === dir) throw Object.assign(new Error('unread subtree'), { code: 'EACCES' });
    return (read as any)(target, ...args);
  }) as typeof fs.readdirSync);
  syncBuiltinESMExports();
  try {
    const partial = enumerateSessionFilesFor(root, [cwd], () => cwd);
    assert.equal(partial.status, 'incomplete');
    assert.deepEqual(partial.sessions, []);
    assert.deepEqual(partial.uncertain, [dir]);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  fs.unlinkSync(file);
  const complete = enumerateSessionFilesFor(root, [cwd], () => cwd);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.sessions, []);
  assert.equal(enumerateSessionFiles(path.join(root, 'missing')).missingRoot, true);
  const failure = vi.spyOn(native, 'readdirSync').mockImplementation(() => {
    throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(enumerateSessionFilesFor(root, [cwd]).status, 'unavailable');
    assert.equal(enumerateSessionFilesFor(root, [cwd]).missingRoot, undefined);
  } finally {
    failure.mockRestore();
    syncBuiltinESMExports();
  }
});

test('Claude candidate stat failure remains incomplete instead of successful empty membership', () => {
  const dir = tempDir('claude-stat-coverage-');
  const file = path.join(dir, 'retained.jsonl');
  fs.writeFileSync(file, '{}\n');
  const native = createRequire(__filename)('node:fs') as typeof fs;
  const stat = native.statSync;
  const spy = vi.spyOn(native, 'statSync').mockImplementation(((target: fs.PathLike, ...args: any[]) => {
    if (String(target) === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return (stat as any)(target, ...args);
  }) as typeof fs.statSync);
  syncBuiltinESMExports();
  try {
    const listing = enumerateSessionFiles(dir);
    assert.equal(listing.status, 'incomplete');
    assert.deepEqual(listing.sessions, []);
    assert.deepEqual(listing.uncertain, [file]);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('physical child census retains unreferenced identity competitors across source changes', () => {
  const root = tempDir('claude-identity-census-');
  const parents = ['parent-a', 'parent-b'].map((sessionId) => ({
    agent: 'claude' as const,
    sessionId,
    file: path.join(root, sessionId + '.jsonl'),
    size: 1,
    mtimeMs: 1,
  }));
  const files = parents.map((parent) => path.join(root, parent.sessionId, 'subagents', 'agent-shared-child.jsonl'));
  const bytes = (cwd: string) => JSON.stringify({ cwd }) + String.fromCharCode(10);
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes('c:/repo'));
    fs.utimesSync(file, new Date('2026-10-21T12:00:00Z'), new Date('2026-10-21T12:00:00Z'));
  }
  const read = () => enumerateClaudeChildSources(parents);
  assert.deepEqual(
    read().sessions.map((source) => source.sessionId),
    ['shared-child', 'shared-child'],
  );
  assert.equal(read().status, 'complete');
  const before = read().sessions[0];
  fs.writeFileSync(files[0], bytes('d:/repo'));
  fs.utimesSync(files[0], new Date('2026-10-21T12:00:01Z'), new Date('2026-10-21T12:00:01Z'));
  assert.equal(read().sessions[0].cwd, 'd:/repo');
  assert.notEqual(read().sessions[0].mtimeMs, before.mtimeMs);
  fs.appendFileSync(files[0], '{}' + String.fromCharCode(10));
  assert.ok(read().sessions[0].size > before.size);
  fs.writeFileSync(files[0], '{}' + String.fromCharCode(10));
  assert.equal(read().status, 'incomplete');
  assert.equal(read().sessions[0].sessionId, 'shared-child');
  assert.equal(read().sessions[0].cwd, undefined);
  fs.unlinkSync(files[0]);
  assert.deepEqual(
    read().sessions.map((source) => source.file),
    [files[1]],
  );
  assert.ok(read().directories?.includes(path.dirname(files[0])));
});

// Claude subagent results cost about 2.79 UTF-8 bytes a token, frame included.
const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 2.79);
// The system-reminder frame a request carries around a stored completion notice.
const NOTICE_FRAME_BYTES = 535;
const rendered = (from: string, report: string) =>
  `<system-reminder id="r1">\nAnother Claude session sent a message while you were working:\n<agent-message from="${from}">\n${report}\n</agent-message>\n</system-reminder id="r1">`;
function asyncLaunch(second: number, launchId: string, agentId: string, description: string) {
  return {
    type: 'user',
    timestamp: at(second),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: launchId, content: 'Async agent launched' }],
    },
    toolUseResult: { agentId, status: 'async_launched', isAsync: true, description },
  };
}
const SUBAGENT_USAGE = { input_tokens: 2, cache_read_input_tokens: 39_998, output_tokens: 10 };
const HANDBACK_REPORT = `## Report\n${'The usage reducer keys its cache by the session path. '.repeat(160)}`.slice(
  0,
  8192,
);
const SAVED_PATH = 'Report saved to C:/work/.claude/runs/reviewer/report-2026.md';
const HANDBACK_POINTER =
  'This agent\'s report was delivered to you as a message from "agent-report" (its SubagentHandback call).';

function twoSubagentSession() {
  return [
    userPrompt('Review the parser and list the fixtures', 0),
    assistantTool('Agent', 1, 'tu-report', { description: 'Review the parser', subagent_type: 'general-purpose' }),
    assistantTool('Agent', 2, 'tu-path', { description: 'List the fixtures', subagent_type: 'general-purpose' }),
    claudeSubagentResult.foreground(at(3), 'tu-path', 'agent-path', 'List the fixtures', SAVED_PATH),
    claudeSubagentResult.foreground(at(4), 'tu-report', 'agent-report', 'Review the parser', HANDBACK_POINTER),
    claudeSubagentResult.handbackAttachment(at(5), 'agent-report', 'general-purpose', HANDBACK_REPORT),
    assistantText('Both subagents finished.', 6, SUBAGENT_USAGE, undefined, 'end_turn'),
  ];
}

test('a Claude session counts each subagent result in context, its hand-back report included', () => {
  assert.equal(SAVED_PATH.length, 60);
  const read = readSession(writeTranscript(twoSubagentSession()), 'sess');
  const report = estimate(HANDBACK_POINTER) + estimate(rendered('agent-report', HANDBACK_REPORT));
  const total = report + estimate(SAVED_PATH);
  assert.ok(report > 2000, 'the 8 KB hand-back report counts');
  assert.equal(read.turns[0].contextTokens, 40_000);
  assert.deepEqual(read.turns[0].subagentContext, {
    tokens: total,
    partial: false,
    removed: false,
    agents: [
      { name: 'Review the parser', tokens: report },
      { name: 'List the fixtures', tokens: 22 },
    ],
  });
  assert.deepEqual(sessionStatFactsOf(read)?.turns[0].subagentContext, read.turns[0].subagentContext);
});

test('a Claude background notice and an idle hand-back each count once', () => {
  const report = 'The fixtures live in turnfixtures.ts.';
  const notice = claudeSubagentResult.notice(at(3), 'tu-bg', 'agent-bg', 'Delivered as a message.');
  const read = readSession(
    writeTranscript([
      userPrompt('Find the fixtures', 0),
      assistantTool('Agent', 1, 'tu-bg', { description: 'Find the fixtures', run_in_background: true }),
      {
        type: 'user',
        timestamp: at(2),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-bg', content: 'Async agent launched' }],
        },
        toolUseResult: {
          agentId: 'agent-bg',
          status: 'async_launched',
          isAsync: true,
          description: 'Find the fixtures',
        },
      },
      notice,
      claudeSubagentResult.handbackAttachment(at(4), 'agent-bg', 'general-purpose', report),
      claudeSubagentResult.handbackMeta(at(5), 'agent-bg', report),
      assistantText('Found them.', 6, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  const noticeBytes = Buffer.byteLength(notice.message.content, 'utf8') + NOTICE_FRAME_BYTES;
  const tokens = Math.ceil(noticeBytes / 2.79) + estimate(rendered('agent-bg', report));
  assert.deepEqual(read.turns[0].subagentContext, {
    tokens,
    partial: false,
    removed: false,
    agents: [{ name: 'Find the fixtures', tokens }],
  });
});

test('a Claude compaction removes earlier subagent results and splits the turn it falls in', () => {
  const summary = [
    { type: 'system', subtype: 'compact_boundary', timestamp: at(5), compactMetadata: { trigger: 'auto' } },
    { ...userPrompt('summary', 6), isCompactSummary: true, message: { role: 'user', content: 'summary' } },
  ];
  const before = [
    userPrompt('Run two reviews', 0),
    assistantTool('Agent', 1, 'tu-a', { description: 'First review' }),
    claudeSubagentResult.foreground(at(2), 'tu-a', 'agent-a', 'First review', 'First review found nothing.'),
  ];
  const removed = readSession(
    writeTranscript([...before, ...summary, assistantText('Done.', 7, SUBAGENT_USAGE, undefined, 'end_turn')]),
    'sess',
  );
  assert.deepEqual(removed.turns[0].subagentContext, { tokens: 0, partial: false, removed: true, agents: [] });

  const split = readSession(
    writeTranscript([
      ...before,
      ...summary,
      assistantTool('Agent', 8, 'tu-b', { description: 'Second review' }),
      claudeSubagentResult.foreground(at(9), 'tu-b', 'agent-b', 'Second review', 'Second review found one defect.'),
      assistantText('Done.', 10, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  const tokens = estimate('Second review found one defect.');
  assert.deepEqual(split.turns[0].subagentContext, {
    tokens,
    partial: false,
    removed: false,
    agents: [{ name: 'Second review', tokens }],
  });
});

test('a Claude subagent figure read from a tail or a cut record is partial', () => {
  const file = writeTranscript([
    userPrompt('Earlier work', 0, { padding: 'x'.repeat(8192) }),
    assistantText('Earlier answer.', 1, SUBAGENT_USAGE, undefined, 'end_turn'),
    ...twoSubagentSession().map((record, index) => ({ ...record, timestamp: at(10 + index) })),
  ]);
  assert.equal(readSession(file, 'sess').turns.at(-1)?.subagentContext?.partial, false);
  const tail = readSession(file, 'sess', { tailBytes: fs.statSync(file).size - 4096 }).turns.at(-1);
  assert.equal(tail?.subagentContext?.partial, true, 'the tail started after the start of the record');

  const reducer = createClaudeSessionReducer('sess');
  let start = 0;
  for (const record of twoSubagentSession()) {
    const text = JSON.stringify(record);
    reducer.pushLine({
      text,
      start,
      end: start + text.length,
      ...(record.type === 'attachment' ? { reduced: true } : {}),
    });
    start += text.length + 1;
  }
  assert.equal(reducer.finish().turns[0].subagentContext?.partial, true, 'the hand-back record was cut');
});

test('a completed background command notice is not subagent text', () => {
  const read = readSession(
    writeTranscript([
      userPrompt('Run the build', 0),
      assistantTool('Bash', 1, 'tu-sh', { command: 'npm run build', run_in_background: true }),
      {
        type: 'user',
        timestamp: at(2),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-sh', content: 'Running in the background.' }],
        },
      },
      claudeSubagentResult.notice(at(3), 'tu-sh', 'b1', 'Build finished.'),
      assistantText('Built.', 4, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  assert.equal(read.turns[0].subagentContext, undefined);
});

test('two hand-backs with the same text count twice, and one record read twice counts once', () => {
  const report = 'No defects found.';
  const read = readSession(
    writeTranscript([
      userPrompt('Review twice', 0),
      claudeSubagentResult.handbackMeta(at(1), 'agent-r', report, 'u-1'),
      claudeSubagentResult.handbackMeta(at(2), 'agent-r', report, 'u-2'),
      claudeSubagentResult.handbackMeta(at(2), 'agent-r', report, 'u-2'),
      assistantText('Done.', 3, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  const one = estimate(`<agent-message from="agent-r">\n${report}\n</agent-message>`);
  assert.equal(read.turns[0].subagentContext?.tokens, 2 * one);
});

test('a subagent result recorded after the last request of a turn counts in the next turn', () => {
  const notice = claudeSubagentResult.notice(at(4), 'tu-late', 'agent-late', 'The cache key is stale.');
  const read = readSession(
    writeTranscript([
      userPrompt('Start a review', 0),
      assistantTool('Agent', 1, 'tu-late', { description: 'Late review', run_in_background: true }),
      asyncLaunch(2, 'tu-late', 'agent-late', 'Late review'),
      assistantText('Started.', 3, SUBAGENT_USAGE, undefined, 'end_turn'),
      notice,
      userPrompt('What did it find?', 5),
      assistantText('A stale key.', 6, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  assert.equal(read.turns.length, 2);
  assert.equal(read.turns[0].subagentContext, undefined, 'the last request of the first turn never read the notice');
  const tokens = Math.ceil((Buffer.byteLength(notice.message.content, 'utf8') + NOTICE_FRAME_BYTES) / 2.79);
  assert.equal(read.turns[1].subagentContext?.tokens, tokens);
});

test('a later compaction leaves the subagent results at the end of an earlier turn', () => {
  const report = 'First review found nothing.';
  const read = readSession(
    writeTranscript([
      userPrompt('Run a review', 0),
      assistantTool('Agent', 1, 'tu-a', { description: 'First review' }),
      claudeSubagentResult.foreground(at(2), 'tu-a', 'agent-a', 'First review', report),
      assistantText('Reviewed.', 3, SUBAGENT_USAGE, undefined, 'end_turn'),
      { type: 'system', subtype: 'compact_boundary', timestamp: at(4), compactMetadata: { trigger: 'manual' } },
      { ...userPrompt('summary', 5), isCompactSummary: true, message: { role: 'user', content: 'summary' } },
      userPrompt('Next task', 6),
      assistantText('Next.', 7, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  const tokens = estimate(report);
  assert.deepEqual(read.turns[0].subagentContext, {
    tokens,
    partial: false,
    removed: false,
    agents: [{ name: 'First review', tokens }],
  });
  const removed = { tokens: 0, partial: false, removed: true, agents: [] };
  assert.deepEqual(read.turns.at(-1)?.subagentContext, removed);
  assert.deepEqual(read.compactions[0].subagentContext, removed);
});

test('subagent results that no request read stay out of the figure, and an overflow marks it partial', () => {
  const report = 'No defects found.';
  const waiting = Array.from({ length: 1025 }, (_, index) =>
    claudeSubagentResult.handbackMeta(at(4), 'agent-r', report, `u-${index}`),
  );
  const read = readSession(
    writeTranscript([
      userPrompt('Start the reviews', 0),
      assistantText('Started.', 3, SUBAGENT_USAGE, undefined, 'end_turn'),
      ...waiting,
      userPrompt('What did they find?', 5),
      assistantText('Nothing.', 6, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  const one = estimate(`<agent-message from="agent-r">\n${report}\n</agent-message>`);
  assert.equal(read.turns[0].subagentContext, undefined, 'no request of the first turn read the results');
  assert.equal(read.turns[1].subagentContext?.tokens, 1024 * one);
  assert.equal(read.turns[1].subagentContext?.partial, true, 'the oldest waiting result was dropped');
});

test('a completion notice for a launch the read no longer holds marks the figure partial', () => {
  const launches = Array.from({ length: 1025 }, (_, index) =>
    assistantTool('Agent', 1, `tu-${index}`, { description: `Review ${index}`, run_in_background: true }),
  );
  const read = readSession(
    writeTranscript([
      userPrompt('Run many reviews', 0),
      ...launches,
      claudeSubagentResult.notice(at(2), 'tu-0', 'agent-0', 'The oldest review finished.'),
      claudeSubagentResult.foreground(at(3), 'tu-1024', 'agent-last', 'Review 1024', 'The newest review finished.'),
      assistantText('Done.', 4, SUBAGENT_USAGE, undefined, 'end_turn'),
    ]),
    'sess',
  );
  assert.equal(read.turns[0].subagentContext?.tokens, estimate('The newest review finished.'));
  assert.equal(read.turns[0].subagentContext?.partial, true);
});

test('a Claude read that skips appended bytes restarts the subagent figure as partial', () => {
  const reducer = createClaudeSessionReducer('sess');
  let start = 0;
  const push = (records: object[]) => {
    for (const record of records) {
      const text = JSON.stringify(record);
      reducer.pushLine({ text, start, end: start + Buffer.byteLength(text) });
      start += Buffer.byteLength(text) + 1;
    }
  };
  push(twoSubagentSession());
  reducer.skipped();
  start += 4096;
  const report = 'Third review found nothing.';
  push([
    userPrompt('Run the third review', 20),
    assistantTool('Agent', 21, 'tu-c', { description: 'Third review' }),
    claudeSubagentResult.foreground(at(22), 'tu-c', 'agent-c', 'Third review', report),
    assistantText('Done.', 23, SUBAGENT_USAGE, undefined, 'end_turn'),
  ]);
  const tokens = estimate(report);
  assert.deepEqual(reducer.finish().turns.at(-1)?.subagentContext, {
    tokens,
    partial: true,
    removed: false,
    agents: [{ name: 'Third review', tokens }],
  });
});

test('a Remote Control bridge record changes no turn, title, or metadata', () => {
  const records = [userPrompt('check the build', 0), assistantText('the build passes', 30)];
  const bridge = {
    type: 'bridge-session',
    bridgeSessionId: 'bridge-identity-7',
    ownerAccountUuid: 'account-identity-7',
    ownerOrganizationUuid: 'organization-identity-7',
  };
  const plain = writeTranscript(records);
  const bridged = writeTranscript([records[0], bridge, records[1], bridge]);
  const read = (file: string) =>
    JSON.stringify({ turns: readTurns(file, 's'), meta: readSessionMeta(file), activity: readSessionActivity(file) })
      .replaceAll(plain, 'FILE')
      .replaceAll(bridged, 'FILE');
  const result = read(bridged);
  assert.doesNotMatch(result, /identity-7/, 'a bridge identifier reached session data');
  assert.equal(
    result.replace(/"(start|end|size|offset|bytes)":\d+/g, ''),
    read(plain).replace(/"(start|end|size|offset|bytes)":\d+/g, ''),
  );
});

// A Claude turn reads its tool results as `arc cost --by-tool` does, so its cost popover draws Tools rows.
test('a Claude turn cost popover draws Tools rows from the results each request read', () => {
  const usage = { input_tokens: 100_000, output_tokens: 1_000 };
  const calls = (second: number, id: string, tools: [string, string, Record<string, unknown>][]) => ({
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-5',
      content: tools.map(([toolId, name, input]) => ({ type: 'tool_use', id: toolId, name, input })),
      usage,
    },
  });
  const records = [
    userPrompt('Find the bug', 0),
    calls(1, 'm-read', [
      ['r1', 'Read', { file_path: 'a.ts' }],
      ['g1', 'Grep', { pattern: 'bug' }],
    ]),
    toolResult('r1', 2),
    toolResult('g1', 3),
    assistantText('Fixed it', 4, usage, undefined, 'end_turn'),
  ];
  const [turn] = readSession(writeTranscript(records), 'sess').turns;
  const cost = toCard(turn, false, Date.parse(at(60))).chips.find((chip) => chip.metric === 'cost')!.detailList!.cost!;
  assert.deepEqual(
    cost.tabs.map((tab) => tab.name),
    ['Usage', 'Tools'],
  );
  assert.deepEqual(
    cost.tabs[1].parts[0].rows.map((row) => [row.label, row.percent, row.title.split(', ')[1]]),
    [
      ['No tool result', '50%', '1 request'],
      ['File read', '25%', '1 request'],
      ['Search', '25%', '1 request'],
    ],
  );
});
