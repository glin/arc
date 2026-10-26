import { discoveryCompatibility } from './progressiveworker';
import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import { normalizeFsPath, scanClaudeRelationshipQuantum, RelationshipReader } from './transcript';
import { scanCodexDispatchReferencesAsync } from './codex';
import { commitSourceStamp } from './transcript';
import {
  MAX_COMMIT_REPOSITORIES,
  MAX_SOURCE_COMMIT_REPOSITORIES,
  MAX_COMMIT_REPOSITORY_BYTES,
  boundedCommitRepositories,
  type VerifiedCommitRepository,
} from './commitrepositories';

// The newest generation the legacy cache format was written at.
const LEGACY_GENERATION = 64;

test('verified commit cache bounds and validates its independent observation format', () => {
  const directory = folder();
  const file = path.join(directory, 'source.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(file, '{}\n');
  const row: VerifiedCommitRepository = {
    version: 2,
    file,
    stamp: commitSourceStamp(file)!,
    dir: directory,
    occurrence: '1'.repeat(64),
    sha: 'a'.repeat(40),
    root: { path: directory, dev: '1', ino: '2' },
    command: { path: directory, dev: '1', ino: '2' },
    common: { path: path.join(directory, '.git'), dev: '1', ino: '3' },
  };
  const rows = Array.from({ length: MAX_SOURCE_COMMIT_REPOSITORIES + 1 }, (_, index) => ({
    ...row,
    occurrence: index.toString(16).padStart(64, '0'),
  }));
  saveDerivedCache(cache, [], [], [], undefined, undefined, [...rows, row]);
  assert.equal(loadDerivedCache(cache).commitRepositories?.length, MAX_SOURCE_COMMIT_REPOSITORIES);
  const stored = JSON.parse(fs.readFileSync(cache, 'utf8'));
  for (const invalid of [
    { ...row, version: 1 },
    { ...row, sha: 'a'.repeat(8) },
    { ...row, stamp: { ...row.stamp, mtimeNs: '0' } },
    { ...row, root: { ...row.root, ino: '0' } },
    {
      ...row,
      recovered: {
        intent: 'quiet',
        commit: { sha: 'b'.repeat(8), subject: 'Fix', at: 1, files: 1, added: 1, removed: 0 },
      },
    },
    {
      ...row,
      recovered: {
        intent: 'quiet',
        commit: { sha: 'a'.repeat(8), subject: 'Fix', at: 1, files: -1, added: 1, removed: 0 },
      },
    },
  ]) {
    stored.commitRepositories = [invalid];
    fs.writeFileSync(cache, JSON.stringify(stored));
    assert.deepEqual(loadDerivedCache(cache).commitRepositories, []);
  }
  const many = Array.from({ length: MAX_COMMIT_REPOSITORIES + 1 }, (_, index) => ({
    ...row,
    file: `/source/${index}`,
    dir: '/repo',
    root: { ...row.root, path: '/repo' },
    command: { ...row.command, path: '/repo' },
    common: { ...row.common, path: '/repo/.git' },
  }));
  assert.equal(boundedCommitRepositories(many).length, MAX_COMMIT_REPOSITORIES);
  const large = many.map((item) => ({ ...item, dir: 'x'.repeat(4096) }));
  const bounded = boundedCommitRepositories(large);
  assert.ok(bounded.length < large.length);
  assert.ok(
    bounded.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0) <= MAX_COMMIT_REPOSITORY_BYTES,
  );
});

test('Codex skipped relationship records retain incomplete coverage through cache reload', () => {
  const directory = folder();
  const file = path.join(directory, 'oversized.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: 'parent' } }) +
      '\n' +
      JSON.stringify({ type: 'ignored', payload: 'x'.repeat(5 * 1024 * 1024) }) +
      '\n',
  );
  const scan = scanCodexDispatchReferences(file, 'parent');
  assert.equal(scan.traversed, true);
  assert.equal(scan.complete, false);
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'codex',
    sessionId: 'parent',
    childTranscript: false,
    ...scan.cursor.evidence!.provisional,
    references: [],
    complete: false,
    relationshipComplete: false,
    visitedEof: true,
    cursor: scan.cursor,
  };
  saveDerivedCache(cache, [], [[file, entry]]);
  const restored = loadDerivedCache(cache).claudeChildReferences.get(normalizeFsPath(file));
  assert.ok(restored?.cursor);
  assert.equal(restored.cursor.lostRecords, true);
  assert.equal(scanCodexDispatchReferences(file, 'parent', restored.cursor).complete, false);
});

test.each(['claude', 'codex'] as const)(
  '%s terminal deadline checkpoints retain progress through reload',
  async (agent) => {
    const directory = folder();
    const file = path.join(directory, 'terminal.jsonl');
    const cache = path.join(directory, 'cache.json');
    fs.writeFileSync(
      file,
      '{"type":"event_msg","timestamp":"2026-10-08T12:00:00Z","payload":{"type":"task_complete"}}',
    );
    const parent = { file, sessionId: 'parent' };
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const first =
      agent === 'claude'
        ? await scanClaudeRelationshipQuantum(parent, undefined)
        : await scanCodexDispatchReferencesAsync(file, 'parent');
    assert.equal(first.cursor.terminalApplied, true);
    fs.appendFileSync(file, '\n');
    const read = RelationshipReader.prototype.read;
    const observed = vi.spyOn(RelationshipReader.prototype, 'read').mockImplementation(function (
      this: RelationshipReader,
      ...args
    ) {
      const bytes = read.apply(this, args);
      clock = 15;
      return bytes;
    });
    const pending =
      agent === 'claude'
        ? await scanClaudeRelationshipQuantum(parent, first.cursor as import('./transcript').ClaudeRelationshipCursor)
        : await scanCodexDispatchReferencesAsync(file, 'parent', first.cursor as import('./codex').CodexDispatchCursor);
    observed.mockRestore();
    assert.equal(pending.qualified, false);
    assert.equal(pending.reset, false);
    assert.equal(pending.cursor.offset, first.cursor.offset);
    assert.equal(pending.cursor.evidence?.validation, undefined);
    const entry: ClaudeChildReferenceCacheEntry = {
      parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      source: agent,
      ...pending.cursor.evidence!.provisional,
      sessionId: 'parent',
      childTranscript: false,
      complete: false,
      relationshipComplete: false,
      references: [],
      ...(agent === 'claude'
        ? { claudeCursor: pending.cursor as import('./transcript').ClaudeRelationshipCursor }
        : { cursor: pending.cursor as import('./codex').CodexDispatchCursor }),
    };
    saveDerivedCache(cache, [], [[file, entry]]);
    const restored = loadDerivedCache(cache).claudeChildReferences.get(normalizeFsPath(file));
    assert.ok(restored, 'reload discarded the terminal checkpoint');
    clock = 0;
    const resumed =
      agent === 'claude'
        ? await scanClaudeRelationshipQuantum(parent, restored.claudeCursor)
        : await scanCodexDispatchReferencesAsync(file, 'parent', restored.cursor);
    assert.equal(resumed.reset, false);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.cursor.offset, first.cursor.offset + 1);
    assert.equal(resumed.readBytes, 2, 'resume reread the already matched prefix');
  },
);

// An evicted launch or fragment cannot be recovered from the retained byte offset.
test('Claude pending cursors survive soft cache pressure and reject corrupt durable fragments', async () => {
  const directory = folder();
  const file = path.join(directory, 'parent.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'launch' }] } }) +
      '\n' +
      '{"type":"ignored","payload":"' +
      'x'.repeat(300000) +
      '"}\n',
  );
  const scan = await scanClaudeRelationshipQuantum({ file, sessionId: 'parent' }, undefined, 65536);
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    sourceGeneration: 2,
    sequence: 5,
    source: 'claude',
    complete: false,
    ...scan.cursor.revision,
    sessionId: 'parent',
    childTranscript: false,
    references: [],
    claudeCursor: scan.cursor,
  };
  const limited = limitCodexDispatchCursors([[file, entry]], 1);
  assert.equal(limited[0][1].claudeCursor, scan.cursor, 'pressure dropped pending launch ownership');
  const parent = { file, sessionId: 'parent', agent: 'claude' as const, ...scan.cursor.revision };
  const discovery = {
    epoch: 'durable-epoch',
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    parents: [parent],
    catalog: [parent],
    repositoryRoots: [directory],
    completed: [],
    position: 1,
    sequence: 5,
    spendSources: { claude: [{ file, sessionId: 'parent', primary: true }], codex: [], children: [] },
  };
  saveDerivedCache(cache, [], limited, [], undefined, discovery);
  assert.deepEqual(loadDerivedCache(cache).discovery, discovery);
  const restored = loadDerivedCache(cache).claudeChildReferences.get(normalizeFsPath(file));
  assert.deepEqual(restored?.claudeCursor, scan.cursor);
  assert.equal(restored?.sourceGeneration, 2);
  assert.equal(restored?.sequence, 5);
  const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
  data.claudeChildReferences[0].entry.claudeCursor.fragmentBytes++;
  fs.writeFileSync(cache, JSON.stringify(data));
  assert.equal(loadDerivedCache(cache).claudeChildReferences.size, 0, 'corrupt fragments survived durable validation');
});
import {
  VERSION,
  CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  DISPATCH_FACTS_VERSION,
  MAX_CLAUDE_CHILD_REFERENCE_FILES,
  CLAUDE_METADATA_TAIL_BYTES,
  MAX_CLAUDE_CHILD_REFERENCES_PER_FILE,
  DerivedCacheCheckpointState,
  carryDerivedTitleFacts,
  derivedTitleCacheCurrent,
  derivedTitleCacheRevision,
  derivedTitleNeedsRailFacts,
  derivedTitleStats,
  enrichDerivedTitleEntry,
  loadDerivedCache,
  limitCodexDispatchCursors,
  limitSavedDispatchFacts,
  needsAgentRunScan,
  railEnrichmentNeeds,
  METADATA_EXHAUSTED_RULE,
  saveDerivedCache,
  scanForRailEnrichment,
  withAgentRunScanProgress,
  withRailEnrichment,
  withMetadataCoverage,
  withSessionName,
  type ClaudeChildReferenceCacheEntry,
  type DerivedTitleEntry,
} from './derivedcache.ts';

test('durable prefix validation rejects inconsistent stamps offsets framing and oversized evidence', async () => {
  const directory = folder();
  const file = path.join(directory, 'source.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    file,
    Array.from({ length: 100 }, () => '{"type":"ignored","text":"' + 'x'.repeat(1024) + '"}\n').join(''),
  );
  const parent = { file, sessionId: 'parent' };
  const first = await scanClaudeRelationshipQuantum(parent, undefined);
  // A same-size change starts a whole-prefix comparison.
  const touched = new Date(first.cursor.revision.mtimeMs + 2000);
  fs.utimesSync(file, touched, touched);
  const pending = await scanClaudeRelationshipQuantum(parent, first.cursor, 32768);
  assert.ok(pending.cursor.evidence?.validation);
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'claude',
    sourceGeneration: 1,
    sequence: 2,
    ...pending.cursor.revision,
    sessionId: 'parent',
    childTranscript: false,
    references: [],
    complete: false,
    relationshipComplete: false,
    claudeCursor: pending.cursor,
  };
  saveDerivedCache(cache, [], [[file, entry]]);
  assert.deepEqual(
    loadDerivedCache(cache).claudeChildReferences.get(normalizeFsPath(file))?.claudeCursor,
    pending.cursor,
  );
  const saved = fs.readFileSync(cache, 'utf8');
  const corruptions = [
    (cursor: typeof pending.cursor) => {
      cursor.evidence!.validation!.required++;
    },
    (cursor: typeof pending.cursor) => {
      cursor.evidence!.provisional.size++;
    },
    (cursor: typeof pending.cursor) => {
      cursor.evidence!.accepted!.ctimeNs = 'invalid';
    },
    (cursor: typeof pending.cursor) => {
      cursor.evidence!.tail += 'AAAA';
    },
    (cursor: typeof pending.cursor) => {
      cursor.evidence!.validation!.digest.offset = cursor.offset + 1;
    },
    (cursor: typeof pending.cursor) => {
      (cursor.evidence as unknown as Record<string, unknown>).extra = 'x'.repeat(16384);
    },
  ];
  for (const corrupt of corruptions) {
    const data = JSON.parse(saved);
    corrupt(data.claudeChildReferences[0].entry.claudeCursor);
    fs.writeFileSync(cache, JSON.stringify(data));
    assert.equal(loadDerivedCache(cache).claudeChildReferences.size, 0);
  }
  const limited = limitCodexDispatchCursors(
    [
      [
        file,
        {
          ...entry,
          claudeCursor: first.cursor,
          complete: true,
          relationshipComplete: true,
          validatedRevision: first.cursor.revision,
        },
      ],
    ],
    0,
  )[0][1];
  assert.equal(limited.complete, true);
  assert.equal(limited.relationshipComplete, true);
  assert.equal(limited.claudeCursor, undefined);
  assert.deepEqual(limited.evidence, first.cursor.evidence);
  assert.deepEqual(limited.validatedRevision, first.cursor.revision);
});

test('partial empty and positive metadata remains eligible and exhaustion survives restart', () => {
  const file = path.join(folder(), 'cache.json');
  for (const stats of [null, { ...title.stats!, turns: [] }]) {
    const entry = {
      ...title,
      sourceIdentity: { dev: '0', ino: '56576470320201115' },
      stats,
      outcome: null,
      starts: { starts: [], whole: false },
    };
    const partial = withMetadataCoverage(entry, { whole: false, windowBytes: 16 * 1024 * 1024 });
    assert.deepEqual(railEnrichmentNeeds(partial, partial), { starts: false, metadata: false, recovery: true });
    const earlier = { ...partial, metadataWindow: { ...partial.metadataWindow!, exhausted: true } };
    const limited = {
      ...partial,
      metadataWindow: { ...earlier.metadataWindow, exhaustedRule: METADATA_EXHAUSTED_RULE },
    };
    saveDerivedCache(file, [
      ['session.jsonl', limited],
      ['earlier.jsonl', earlier],
    ]);
    const loaded = loadDerivedCache(file).titles.get('session.jsonl')!;
    assert.deepEqual(loaded.sourceIdentity, entry.sourceIdentity, 'cache reload lost exact filesystem identity');
    assert.equal(railEnrichmentNeeds(loaded, loaded), null);
    assert.equal(derivedTitleNeedsRailFacts(loaded), false);
    const reopened = loadDerivedCache(file).titles.get('earlier.jsonl')!;
    assert.equal(
      railEnrichmentNeeds(reopened, reopened)?.recovery,
      true,
      'an entry exhausted under the earlier rule stayed closed',
    );
    assert.equal(derivedTitleNeedsRailFacts(reopened), true);
    assert.equal(loaded.expandedStatsRead, undefined);
    assert.equal(
      railEnrichmentNeeds(
        enrichDerivedTitleEntry(loaded, {
          turns: [],
          compactions: [],
          readBytes: 1,
          turnLimitReached: false,
        }),
        loaded,
      )?.recovery,
      true,
    );
    const read = { turns: [], compactions: [], readBytes: 1, turnLimitReached: false };
    assert.deepEqual(
      enrichDerivedTitleEntry(loaded, read).metadataWindow,
      { whole: false, windowBytes: 16 * 1024 * 1024, exhausted: false },
      'an accepted read cleared the exhaustion and kept its rule',
    );
  }
});

test('partial negative coverage retains held facts and detected replacement releases them', () => {
  const grown = { ...title, stats: null, size: title.size + 1, sourceIdentity: { dev: 1, ino: 1 } };
  const previous = { ...title, sourceIdentity: { dev: 1, ino: 1 } };
  const partial = carryDerivedTitleFacts(previous, withMetadataCoverage(grown, { whole: false, windowBytes: 16 }));
  assert.ok(partial.heldStats);
  const complete = carryDerivedTitleFacts(partial, withMetadataCoverage(grown, { whole: true, windowBytes: 16 }));
  assert.equal(complete.heldStats, undefined);
  const replaced = carryDerivedTitleFacts(partial, { ...grown, sourceIdentity: { dev: 1, ino: 2 } });
  assert.equal(replaced.heldStats, undefined);
});

test('reference cache retains a stable subset above its file cap', () => {
  const file = path.join(folder(), 'reference-cap.json');
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'claude',
    complete: true,
    mtimeMs: 1,
    size: 2,
    dev: 3,
    ino: 4,
    sessionId: 'parent',
    childTranscript: false,
    references: [],
  };
  const rows: Array<[string, ClaudeChildReferenceCacheEntry]> = Array.from(
    { length: MAX_CLAUDE_CHILD_REFERENCE_FILES + 1 },
    (_unused, index) => [`/parent-${String(index).padStart(5, '0')}.jsonl`, entry],
  );
  const discovery = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    parents: [],
    catalog: [],
    repositoryRoots: [],
    completed: [rows.at(-1)![0]],
    position: 0,
    sequence: 1,
  };
  saveDerivedCache(file, [], rows, [], undefined, discovery);
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).discovery,
    undefined,
    'evicted relationships persisted dependent scheduling',
  );
  assert.equal(loadDerivedCache(file).discovery, undefined, 'evicted relationships retained dependent scheduling');
  const restored = loadDerivedCache(file).claudeChildReferences;
  assert.equal(restored.size, MAX_CLAUDE_CHILD_REFERENCE_FILES);
  assert.ok(restored.has(rows[0][0]));
  assert.ok(!restored.has(rows.at(-1)![0]));
});

test('cursor byte budget preserves unfinished progress and complete parent references', () => {
  const cursor = { candidates: [], seenBloom: 'x'.repeat(200) } as unknown as NonNullable<
    ClaudeChildReferenceCacheEntry['cursor']
  >;
  const entry = (sessionId: string, complete: boolean): ClaudeChildReferenceCacheEntry => ({
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'codex',
    complete,
    cursor,
    mtimeMs: 1,
    size: 2,
    dev: 3,
    ino: 4,
    sessionId,
    childTranscript: false,
    references: [],
  });
  const partial = entry('partial', false);
  const complete = entry('complete', true);
  const budget = Buffer.byteLength(JSON.stringify(cursor));
  const limited = new Map(
    limitCodexDispatchCursors(
      [
        ['partial', partial],
        ['complete', complete],
      ],
      budget,
    ),
  );
  assert.equal(limited.get('partial')?.cursor, cursor);
  assert.equal(limited.get('complete')?.cursor, undefined);
  const evicted = new Map(limitCodexDispatchCursors([['partial', partial]], budget - 1));
  assert.equal(evicted.get('partial')?.cursor, undefined);
  assert.equal(evicted.get('partial')?.complete, false);
});
import {
  CodexMetaCache,
  codexSessionFiles,
  readCodexSessionMeta,
  readCodexSessionActivity,
  scanCodexDispatchReferences,
  staleMetas,
} from './codex.ts';
import type { CodexSessionMeta } from './codex.ts';
import {
  CODEX_META_VERSION,
  CODEX_OPENINGS_LOCK_STALE_MS,
  CODEX_OPENINGS_RETRY_MS,
  CodexOpeningsWriter,
  codexOpeningsAtStartup,
  loadCodexOpenings,
  saveCodexOpenings,
  takeCodexOpeningsLock,
} from './codexopenings.ts';
import { spawn } from 'node:child_process';
import type { AgentRunScan, SessionRead, SessionStatFacts, TurnOutcome } from './transcript.ts';
import { readSessionMeta, scanForAgentRun, readSession, sessionStatFactsOf } from './transcript.ts';
import {
  bedrockAstraRecords,
  runningSdkTranscript,
  powershellDispatchExecution,
  advisorProbeRecords,
  advisorResponseRecords,
  PER_PASS_ITERATIONS,
  MIXED_PASS_ITERATIONS,
} from './turnfixtures.ts';
import { estimateCost } from './pricing.ts';
import { averageContextPerRequest } from './turncard.ts';
import { railBuckets } from './view/rail.ts';

const folder = () => tempDir('derived-cache-');

const codexMeta: CodexSessionMeta = {
  sessionId: 'session',
  cwd: 'c:\\repo',
  modelProvider: 'openai',
  launchSource: 'vscode',
  openedAt: 1,
  startedAt: 1,
  replayBoundaryAt: 1,
  threadSource: 'user',
  parentThreadId: null,
  agentPath: null,
  subagentKind: null,
  hasSubagentSource: false,
};

const outcome: TurnOutcome = { finished: true, error: false, interrupted: false, endedAt: 42 };
const stats: SessionStatFacts = {
  turns: [
    {
      startedAt: 10,
      endedAt: 20,
      finished: true,
      error: false,
      model: 'claude-opus-5',
      provider: null,
      usage: { input: 100, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 20, output: 10, thinking: 0 },
      contextTokens: 120,
      contextWindow: 1_000_000,
      contextRequest: {
        at: 20,
        lifetime: '1h',
        inferenceClass: 'global',
        serviceTier: 'standard',
        readBack: true,
        outputTokens: 40,
      },
      childSpendPartial: false,
    },
  ],
  compactions: [],
};
const title: DerivedTitleEntry = {
  mtimeMs: 10,
  size: 20,
  label: 'A session',
  fullLabel: 'A session',
  activityMs: 30,
  agentRun: false,
  outcome,
  stats,
  starts: { starts: [10], whole: true },
  foldedLabel: 'a session',
};

test('observed Codex turn effort survives metadata and a derived-cache reload', () => {
  const source = path.join(folder(), 'effort.jsonl');
  const cache = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    source,
    [
      { type: 'session_meta', payload: { id: 'effort' } },
      { type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'user_message', message: 'work' } },
      {
        type: 'turn_context',
        timestamp: '2026-01-01T00:00:02Z',
        payload: { turn_id: 'turn', model: 'gpt-6.1-sol', effort: 'low' },
      },
      { type: 'event_msg', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'task_complete', turn_id: 'turn' } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const facts = readCodexSessionActivity(source, 256 * 1024, {
    sessionId: 'effort',
    meta: readCodexSessionMeta(source),
  }).stats!;
  assert.equal(facts.turns[0].effort, 'low');
  saveDerivedCache(cache, [[source, { ...title, stats: facts }]]);
  assert.equal(loadDerivedCache(cache).titles.get(source)!.stats!.turns[0].effort, 'low');
  for (const effort of [null, undefined, 7, '']) {
    saveDerivedCache(cache, [
      [source, { ...title, stats: { ...facts, turns: [{ ...facts.turns[0], effort } as any] } }],
    ]);
    const restored = loadDerivedCache(cache).titles.get(source);
    if (effort === null || effort === undefined) assert.ok(restored);
    else assert.equal(restored, undefined);
  }
});

test('per-pass pricing survives a derived-cache reload with both bands and request input averages', () => {
  const directory = folder();
  const source = path.join(directory, 'session.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    source,
    [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations: MIXED_PASS_ITERATIONS, thinking: 3 })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const facts = sessionStatFactsOf(readSession(source, 's'));
  assert.ok(facts);
  saveDerivedCache(cache, [[source, { ...title, stats: facts }]]);
  const restored = loadDerivedCache(cache).titles.get(source)!.stats!.turns[0];
  assert.ok(Math.abs(estimateCost(restored.usage, restored.model)! - 0.0600315) < 1e-12);
  assert.equal(averageContextPerRequest(restored.usage), 200001);
  assert.deepEqual(restored.usage, facts.turns[0].usage);
});

test('prior derived generations drop saved figures and carry valid names for bounded rereading', () => {
  for (const version of [35, 36, 60]) {
    const file = path.join(folder(), 'cache.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version,
        codexMetaVersion: CODEX_META_VERSION,
        codexMetas: [{ file: '/empty.jsonl', meta: codexMeta }],
        titles: [
          { file: '/empty.jsonl', entry: { ...title, label: '', fullLabel: '', foldedLabel: '' } },
          { file: '/named.jsonl', entry: title },
        ],
      }),
    );
    const loaded = loadDerivedCache(file);
    assert.equal(loaded.titles.size, 0);
    assert.ok(!loaded.carriedNames.has('/empty.jsonl'));
    assert.equal(loaded.carriedNames.get('/named.jsonl')?.label, title.label);
    assert.deepEqual(loaded.codexMetas.get('/empty.jsonl'), codexMeta);
  }
});

// Version 46 saved Claude turn usage with no request band, so its Haiku 5.5 totals cannot be priced.
test('a derived cache saved before Claude request bands rereads its Haiku 5.5 usage', () => {
  const file = path.join(folder(), 'cache.json');
  const [turn] = stats.turns;
  const haiku = {
    ...title,
    stats: {
      ...stats,
      turns: [
        {
          ...turn,
          model: 'claude-haiku-5-5',
          usage: { ...turn.usage, requests: 2, input: 10_001, cacheRead: 140_000 },
        },
      ],
    },
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 46,
      codexMetaVersion: CODEX_META_VERSION,
      titles: [{ file: '/haiku.jsonl', entry: haiku }],
    }),
  );
  const loaded = loadDerivedCache(file);
  assert.equal(loaded.titles.size, 0, 'a turn total saved without its request bands was read');
  assert.equal(loaded.carriedNames.get('/haiku.jsonl')?.label, title.label);
});

// Only Haiku 5.5 requests carry a band, so a turn that also holds a Sonnet request has a total no band covers.
test('a turn of Haiku 5.5 and Sonnet requests survives a save and reload of the derived cache', async () => {
  const { readSession, sessionStatFactsOf } = await import('./transcript.ts');
  const directory = folder();
  const source = path.join(directory, 'mixed.jsonl');
  const cache = path.join(directory, 'cache.json');
  const at = (second: number) => new Date(Date.UTC(2026, 9, 7, 12, 0, second)).toISOString();
  const request = (second: number, model: string, stop: string) => ({
    type: 'assistant',
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: `m${second}`,
      model,
      stop_reason: stop,
      content: [{ type: 'text', text: `step ${second}` }],
      usage: { input_tokens: 50_000, output_tokens: 1_000 },
    },
  });
  const records = [
    { type: 'user', promptId: 'p1', timestamp: at(0), message: { role: 'user', content: 'Summarize the logs' } },
    request(1, 'claude-haiku-5-5', 'tool_use'),
    request(2, 'claude-sonnet-5-5', 'end_turn'),
  ];
  fs.writeFileSync(source, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stats = sessionStatFactsOf(readSession(source, 'mixed'));
  assert.equal(stats?.turns[0].usage.requests, 2);
  assert.equal(stats?.turns[0].usage.input, 100_000);
  const entry: DerivedTitleEntry = { ...title, stats };
  saveDerivedCache(cache, [[source, entry]]);
  assert.deepEqual(loadDerivedCache(cache).titles.get(source), entry, 'the saved mixed-model turn was rejected');
});

test('a full parse fills missing derived facts without replacing facts already cached', () => {
  const read = {
    turns: [
      {
        startedAt: 10,
        endedAt: 20,
        model: 'claude-opus-5',
        provider: null,
        usage: stats.turns[0].usage,
        contextTokens: 120,
        contextWindow: 1_000_000,
        contextRequest: stats.turns[0].contextRequest,
        agents: [],
        finished: true,
        error: null,
        interrupted: false,
      },
    ],
    compactions: [],
    readBytes: 1,
    turnLimitReached: false,
  } as unknown as SessionRead;
  const missing = { ...title, stats: null, outcome: null };
  const enriched = enrichDerivedTitleEntry(missing, read);
  assert.deepEqual(enriched.stats, stats);
  assert.deepEqual(enriched.outcome, { ...outcome, startedAt: 10, endedAt: 20 });
  assert.equal(enrichDerivedTitleEntry(title, read), title);
});

test('complete persisted rail facts suppress another discovery pass', () => {
  assert.equal(derivedTitleNeedsRailFacts(title), false);
  assert.equal(derivedTitleNeedsRailFacts({ ...title, stats: null }), true);
  assert.equal(derivedTitleNeedsRailFacts({ ...title, outcome: null }), true);
  assert.equal(derivedTitleNeedsRailFacts({ ...title, starts: undefined }), true);
  assert.equal(derivedTitleNeedsRailFacts({ ...title, foldedLabel: undefined }), true);
  assert.equal(
    derivedTitleNeedsRailFacts({ ...title, stats: null, expandedStatsRead: true }),
    false,
    'a completed expanded read with no parsed turn remained eligible for every refresh',
  );
});

test('a later cache entry checkpoints even when the first render changed nothing', () => {
  const checkpoint = new DerivedCacheCheckpointState(1_000);
  assert.equal(checkpoint.nextDelay(1_000, 30_000), null);

  checkpoint.markChanged(true);
  assert.equal(checkpoint.nextDelay(1_001, 30_000), 0, 'a new entry waits behind the ordinary update interval');
  checkpoint.markSaved(1_001);
  assert.equal(checkpoint.nextDelay(1_001, 30_000), null);

  checkpoint.markChanged();
  assert.equal(
    checkpoint.nextDelay(2_001, 30_000),
    29_000,
    'an ordinary revision update bypassed the checkpoint interval',
  );
  assert.equal(checkpoint.nextDelay(31_001, 30_000), 0);
});

test('generation 61 discards mixed-tier normal and held context facts and persists inferred lifetime', () => {
  const directory = folder();
  const source = path.join(directory, 'advisor.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    source,
    [advisorProbeRecords()[0], ...advisorResponseRecords({ iterations: PER_PASS_ITERATIONS })]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const fresh = sessionStatFactsOf(readSession(source, 'advisor-probe'))!;
  assert.equal(fresh.turns[0].contextRequest?.lifetime, '1h');
  const stale = {
    ...fresh,
    turns: fresh.turns.map((turn) => ({ ...turn, contextRequest: { ...turn.contextRequest!, lifetime: null } })),
  };
  fs.writeFileSync(
    cache,
    JSON.stringify({
      version: 61,
      codexMetas: [],
      titles: [
        { file: source, entry: { ...title, stats: stale } },
        { file: '/held.jsonl', entry: { ...title, stats: null, heldStats: stale } },
      ],
    }),
  );
  const loaded = loadDerivedCache(cache);
  assert.equal(loaded.titles.size, 0);
  assert.equal(loaded.reuse?.reason, 'generation-mismatch');
  saveDerivedCache(cache, [
    [source, { ...title, stats: fresh }],
    ['/held.jsonl', { ...title, stats: null, heldStats: fresh }],
  ]);
  for (let refresh = 0; refresh < 3; refresh++) {
    const restored = loadDerivedCache(cache).titles;
    assert.equal(restored.get(source)?.stats?.turns[0].contextRequest?.lifetime, '1h');
    assert.equal(restored.get('/held.jsonl')?.heldStats?.turns[0].contextRequest?.lifetime, '1h');
  }
});

test('derived cache round trips positive metadata and outcome facts', () => {
  const file = path.join(folder(), 'nested', 'cache.json');
  saveDerivedCache(file, [['/session.jsonl', title]]);
  const loaded = loadDerivedCache(file);
  assert.deepEqual(loaded.titles.get('/session.jsonl'), title);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /status/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['cache.json']);
});

// Earlier cache versions discard outcomes, including stored child state.
// Current-version outcomes preserve open children without requiring a closed-child list.
// A missing closed-child list has the same meaning as an empty list.
test('a derived cache from an earlier version keeps no outcome that predates the closed children', () => {
  const file = path.join(folder(), 'cache.json');
  const open = { ...title, outcome: { ...outcome, openChildren: ['x1'] } };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION - 1,
      codexMetas: [],
      titles: [{ file: '/open.jsonl', entry: open }],
    }),
  );
  assert.equal(loadDerivedCache(file).titles.size, 0, 'a cache written before this version was read');
  // Current-version outcomes retain open children through a save and reload.
  // Stored child state remains available for carried subagents.
  saveDerivedCache(file, [
    ['/open.jsonl', open],
    ['/quiet.jsonl', title],
  ]);
  const again = loadDerivedCache(file);
  assert.deepEqual(again.titles.get('/open.jsonl'), open);
  assert.deepEqual(again.titles.get('/quiet.jsonl'), title);
});

// A version bump drops every stored fact, and only a well-formed name survives it. The name
// then waits in the file until a title for the same session is stored.
test('a derived cache from an earlier version carries only well-formed names', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION - 1,
      titles: [
        { file: '/named.jsonl', entry: { ...title, label: 'Named', fullLabel: 'Named in full' } },
        { file: '/empty.jsonl', entry: { ...title, label: '' } },
        { file: '/numbered.jsonl', entry: { ...title, fullLabel: 7 } },
        { file: '/unlabelled.jsonl', entry: { ...title, label: undefined } },
        { file: '/bare.jsonl' },
        { file: '', entry: title },
        { file: 3, entry: title },
        'row',
      ],
      carriedNames: [
        { file: '/older.jsonl', label: 'Older', fullLabel: 'Older in full' },
        { file: '/blank.jsonl', label: '', fullLabel: 'Blank' },
      ],
    }),
  );
  const loaded = loadDerivedCache(file);
  assert.equal(loaded.titles.size, 0, 'a cache written before this version was read');
  assert.deepEqual(
    loaded.carriedNames,
    new Map([
      ['/older.jsonl', { label: 'Older', fullLabel: 'Older in full' }],
      ['/named.jsonl', { label: 'Named', fullLabel: 'Named in full' }],
    ]),
    'a malformed row carried a name, or a well-formed one was lost',
  );

  saveDerivedCache(file, [], [], loaded.carriedNames);
  const unread = loadDerivedCache(file);
  assert.deepEqual(unread.carriedNames, loaded.carriedNames, 'saving before a session read lost its carried name');
  assert.equal(unread.titles.size, 0);

  saveDerivedCache(file, [['/older.jsonl', title]], [], unread.carriedNames);
  const again = loadDerivedCache(file);
  assert.deepEqual(again.titles.get('/older.jsonl'), title);
  assert.deepEqual(
    again.carriedNames,
    new Map([['/named.jsonl', { label: 'Named', fullLabel: 'Named in full' }]]),
    'a carried name outlived the title stored for its session, or an unread one was lost',
  );
});

test('derived cache round trips completed Claude child-reference facts including negative results', () => {
  const file = path.join(folder(), 'cache.json');
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    mtimeMs: 10,
    size: 20,
    dev: 1,
    ino: 2,
    sessionId: 'parent',
    childTranscript: false,
    references: [
      {
        kind: 'subagent',
        parentSessionId: 'parent',
        sessionId: 'child',
        file: '/agent-child.jsonl',
        toolUseIds: ['launch'],
      },
      {
        kind: 'dispatch',
        agent: 'claude',
        parentSessionId: 'parent',
        sessionId: '4f4bf298',
        file: null,
        toolUseIds: ['dispatch'],
        name: 'Review branch',
        owned: false,
      },
    ],
  };
  const negative = { ...entry, sessionId: 'quiet', references: [] };
  saveDerivedCache(
    file,
    [],
    [
      ['C:\\Parent.jsonl', entry],
      ['/quiet.jsonl', negative],
    ],
  );
  const loaded = loadDerivedCache(file).claudeChildReferences;
  assert.deepEqual(loaded.get('c:/parent.jsonl'), entry);
  assert.deepEqual(loaded.get('/quiet.jsonl'), negative);

  // A dispatch reference without an explicit owned value requires a parent rescan.
  // Missing ownership must not classify the dispatch as unowned.
  const { owned: _owned, ...unmarked } = entry.references[1] as { owned: boolean };
  saveDerivedCache(file, [], [['/parent.jsonl', { ...entry, references: [entry.references[0], unmarked as never] }]]);
  assert.equal(
    loadDerivedCache(file).claudeChildReferences.size,
    0,
    'a stored dispatch reference without its owned mark was kept',
  );
});

test('derived cache rejects child references from another parser generation', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: LEGACY_GENERATION,
      codexMetas: [],
      titles: [],
      claudeChildReferences: [
        {
          file: '/parent.jsonl',
          entry: {
            parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION + 1,
            mtimeMs: 10,
            size: 20,
            dev: 1,
            ino: 2,
            sessionId: 'parent',
            childTranscript: false,
            references: [],
          },
        },
      ],
    }),
  );
  assert.equal(loadDerivedCache(file).claudeChildReferences.size, 0);
});

test('derived cache drops saved dispatched facts of another facts version and keeps their rows', () => {
  const file = path.join(folder(), 'cache.json');
  const revision = { size: 20, mtimeMs: 10, dev: 1, ino: 2 };
  const dispatch = (sessionId: string, toolUses: number) => ({
    version: DISPATCH_FACTS_VERSION,
    revision,
    tree: '20:10',
    facts: {
      sessionId,
      refreshAt: null,
      revision,
      spend: { models: [], found: true, partial: false, effort: null },
      startedAt: null,
      endedAt: null,
      toolUses,
      person: false,
    },
  });
  const entry = (sessionId: string, toolUses: number): ClaudeChildReferenceCacheEntry => ({
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    ...revision,
    sessionId,
    childTranscript: false,
    references: [],
    dispatch: dispatch(sessionId, toolUses),
  });
  saveDerivedCache(file, [], [['/dispatched.jsonl', entry('dispatched', 1)]]);
  assert.deepEqual(
    loadDerivedCache(file).claudeChildReferences.get('/dispatched.jsonl')?.dispatch,
    dispatch('dispatched', 1),
  );
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.claudeChildReferences[0].entry.dispatch.version = DISPATCH_FACTS_VERSION + 1;
  fs.writeFileSync(file, JSON.stringify(stored));
  const loaded = loadDerivedCache(file);
  assert.equal(loaded.reuse?.rejectedRelationships, 0);
  assert.equal(loaded.claudeChildReferences.get('/dispatched.jsonl')?.dispatch, undefined);
  assert.equal(loaded.claudeChildReferences.get('/dispatched.jsonl')?.sessionId, 'dispatched');
  // The byte cap keeps the smaller facts and the row of the larger.
  const rows = [
    { file: '/large.jsonl', entry: entry('large', 1_000_000) },
    { file: '/small.jsonl', entry: entry('small', 1) },
  ];
  const limit = Buffer.byteLength(JSON.stringify(rows[1].entry.dispatch));
  const limited = limitSavedDispatchFacts(rows, limit);
  assert.deepEqual(
    limited.map((row) => [row.file, row.entry.dispatch?.facts.sessionId]),
    [
      ['/large.jsonl', undefined],
      ['/small.jsonl', 'small'],
    ],
  );
});

// References from older parser generations require an unchanged parent to be rescanned.
// This includes receipt detection, heredoc boundaries, and launch classification.
// Cache format compatibility alone does not establish parser compatibility.
test('derived cache rescans an unchanged parent after the receipt parser upgrade', () => {
  const file = path.join(folder(), 'cache.json');
  for (const parserVersion of [2, 7, 12, 13, 14, 17, 18, 24]) {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: LEGACY_GENERATION,
        codexMetas: [],
        titles: [],
        claudeChildReferences: [
          {
            file: '/parent.jsonl',
            entry: {
              parserVersion,
              mtimeMs: 10,
              size: 20,
              dev: 1,
              ino: 2,
              sessionId: 'parent',
              childTranscript: false,
              references: [],
            },
          },
        ],
      }),
    );
    assert.equal(loadDerivedCache(file).claudeChildReferences.size, 0, `parser ${parserVersion} was kept`);
  }
  const parent = path.join(folder(), 'parent.jsonl');
  fs.writeFileSync(parent, JSON.stringify({ type: 'session_meta', payload: { id: 'parent' } }) + '\n');
  const cursor = scanCodexDispatchReferences(parent, 'parent').cursor;
  for (const complete of [true, false]) {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: LEGACY_GENERATION,
        codexMetaVersion: CODEX_META_VERSION,
        codexMetas: [{ file: '/opening.jsonl', meta: codexMeta }],
        titles: [{ file: '/unrelated.jsonl', entry: title }],
        claudeChildReferences: [
          {
            file: parent,
            entry: {
              parserVersion: 18,
              source: 'codex',
              complete,
              visitedEof: true,
              cursor,
              mtimeMs: cursor.mtimeMs,
              size: cursor.size,
              dev: cursor.dev,
              ino: cursor.ino,
              sessionId: 'parent',
              childTranscript: false,
              references: [],
            },
          },
        ],
      }),
    );
    const loaded = loadDerivedCache(file);
    assert.equal(
      loaded.claudeChildReferences.size,
      0,
      `a parser 18 ${complete ? 'complete' : 'visited-EOF'} entry survived`,
    );
    assert.equal(loaded.carriedNames.get('/unrelated.jsonl')?.label, title.label);
    assert.deepEqual(loaded.codexMetas.get('/opening.jsonl'), codexMeta);
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 28, codexMetas: [], titles: [{ file: '/bg.jsonl', entry: title }] }),
  );
  assert.equal(loadDerivedCache(file).titles.size, 0, 'a cache from version 28 was kept');
});

test('an oversized child-reference entry falls back to scanning instead of truncating relationships', () => {
  const file = path.join(folder(), 'cache.json');
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    mtimeMs: 10,
    size: 20,
    dev: 1,
    ino: 2,
    sessionId: 'parent',
    childTranscript: false,
    references: Array.from({ length: MAX_CLAUDE_CHILD_REFERENCES_PER_FILE + 1 }, (_unused, index) => ({
      parentSessionId: 'parent',
      kind: 'subagent' as const,
      sessionId: `child-${index}`,
      file: `/agent-child-${index}.jsonl`,
      toolUseIds: [`launch-${index}`],
    })),
  };
  saveDerivedCache(file, [], [['/parent.jsonl', entry]]);
  assert.equal(loadDerivedCache(file).claudeChildReferences.size, 0);
});

test('derived cache retains a completed expanded read with no stats', () => {
  const file = path.join(folder(), 'cache.json');
  const completed = { ...title, stats: null, expandedStatsRead: true };
  saveDerivedCache(file, [['/session.jsonl', completed]]);
  assert.deepEqual(loadDerivedCache(file).titles.get('/session.jsonl'), completed);
});

test('derived cache rejects malformed bounded starts and folded labels', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [
        { file: '/starts.jsonl', entry: { ...title, starts: { starts: ['later'], whole: true } } },
        { file: '/label.jsonl', entry: { ...title, foldedLabel: 4 } },
      ],
    }),
  );
  assert.equal(loadDerivedCache(file).titles.size, 0);
});

test('derived cache round trips request pricing bands', () => {
  const file = path.join(folder(), 'cache.json');
  const counts = {
    requests: 1,
    input: 300_000,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWrite30m: 0,
    cacheRead: 0,
    output: 20_000,
    thinking: 0,
  };
  const banded: DerivedTitleEntry = {
    ...title,
    stats: {
      turns: [
        {
          ...stats.turns[0],
          model: 'gpt-5.5',
          provider: 'openai',
          usage: { ...counts, byContextBand: { long: counts } },
          usageParts: [
            {
              model: 'gpt-5.5',
              provider: 'openai',
              contextWindow: 1_000_000,
              contextBand: 'long',
              inferenceClass: null,
              serviceTier: 'priority',
              usage: { ...counts, byContextBand: { long: counts } },
            },
          ],
        },
      ],
      compactions: [],
    },
  };
  saveDerivedCache(file, [['/session.jsonl', banded]]);
  assert.deepEqual(loadDerivedCache(file).titles.get('/session.jsonl'), banded);
});

test('derived cache round trips subagent wait usage and drops an impossible timeout count', () => {
  const file = path.join(folder(), 'cache.json');
  const turn = stats.turns[0];
  const waitPart = (timedOut: number) => ({
    model: 'gpt-6-sol',
    provider: 'openai',
    contextWindow: null,
    contextBand: null,
    inferenceClass: null,
    serviceTier: null,
    waits: { requests: 2, timedOut, usage: { ...turn.usage, requests: 2 } },
    usage: { ...turn.usage, requests: 3 },
  });
  const waited = (timedOut: number): DerivedTitleEntry => ({
    ...title,
    stats: { turns: [{ ...turn, model: 'gpt-6-sol', usageParts: [waitPart(timedOut)] }], compactions: [] },
  });
  saveDerivedCache(file, [['/session.jsonl', waited(1)]]);
  assert.deepEqual(loadDerivedCache(file).titles.get('/session.jsonl'), waited(1));
  saveDerivedCache(file, [['/session.jsonl', waited(3)]]);
  assert.equal(loadDerivedCache(file).titles.get('/session.jsonl'), undefined);
});

test('derived cache round trips a regional Bedrock request', () => {
  const file = path.join(folder(), 'cache.json');
  const turn = stats.turns[0];
  const bedrock: DerivedTitleEntry = {
    ...title,
    stats: {
      turns: [
        {
          ...turn,
          model: 'claude-opus-5-5',
          contextRequest: {
            ...turn.contextRequest!,
            inferenceClass: 'bedrock-regional',
            bedrock: true,
            effort: 'high',
          },
          usageParts: [
            {
              model: 'claude-opus-5-5',
              provider: null,
              contextWindow: null,
              contextBand: null,
              inferenceClass: 'bedrock-regional',
              serviceTier: 'standard',
              usage: { ...turn.usage, requests: 1 },
            },
          ],
        },
      ],
      compactions: [],
    },
  };
  saveDerivedCache(file, [['/session.jsonl', bedrock]]);
  assert.deepEqual(loadDerivedCache(file).titles.get('/session.jsonl'), bedrock);
});

// Unsupported cache versions must not supply stored Bedrock pricing.
test('a derived cache from before the Bedrock charge serves no list-priced Bedrock parse', () => {
  const file = path.join(folder(), 'cache.json');
  const turn = stats.turns[0];
  const listPriced: DerivedTitleEntry = {
    ...title,
    stats: {
      turns: [
        {
          ...turn,
          model: 'claude-opus-5-5',
          usageParts: [
            {
              model: 'claude-opus-5-5',
              provider: null,
              contextWindow: null,
              contextBand: null,
              inferenceClass: null,
              serviceTier: 'standard',
              usage: { ...turn.usage, requests: 1 },
            },
          ],
        },
      ],
      compactions: [],
    },
  };
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 27, codexMetas: [], titles: [{ file: '/bedrock.jsonl', entry: listPriced }] }),
  );
  assert.equal(loadDerivedCache(file).titles.size, 0, 'a parse stored before the Bedrock charge was served');
});

test('derived cache discards GPT-6.1 Sol Bedrock facts saved without provider support', () => {
  const file = path.join(folder(), 'cache.json');
  const unpriced: DerivedTitleEntry = {
    ...title,
    stats: {
      turns: [
        {
          ...stats.turns[0],
          model: 'openai.gpt-6.1-sol',
          provider: 'amazon-bedrock',
          contextWindow: null,
          contextRequest: null,
        },
      ],
      compactions: [],
    },
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 33,
      codexMetaVersion: CODEX_META_VERSION,
      codexMetas: [],
      titles: [{ file: '/bedrock.jsonl', entry: unpriced }],
    }),
  );
  const loaded = loadDerivedCache(file);
  assert.equal(loaded.titles.size, 0, 'saved unavailable provider facts prevented a fresh context read');
  assert.deepEqual(loaded.carriedNames.get('/bedrock.jsonl'), { label: title.label, fullLabel: title.fullLabel });
});

test('derived cache rejects malformed request pricing identities', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [
        {
          file: '/bad-parts.jsonl',
          entry: {
            ...title,
            stats: {
              ...stats,
              turns: [
                {
                  ...stats.turns[0],
                  usageParts: [
                    {
                      model: 'gpt-5.5',
                      provider: 'openai',
                      contextWindow: 1_000_000,
                      contextBand: 'huge',
                      inferenceClass: null,
                      serviceTier: 'priority',
                      usage: stats.turns[0].usage,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    }),
  );
  assert.equal(loadDerivedCache(file).titles.size, 0);
});

test('derived cache rejects a rail request fact that cannot name a cache state', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [
        {
          file: '/session.jsonl',
          entry: {
            ...title,
            stats: {
              ...stats,
              turns: [
                {
                  ...stats.turns[0],
                  contextRequest: { ...stats.turns[0].contextRequest, at: 'later' },
                },
              ],
            },
          },
        },
      ],
    }),
  );
  assert.equal(
    loadDerivedCache(file).titles.size,
    0,
    'an invalid request clock would let an old rail row claim that a cache remains warm',
  );
});

test('derived cache rejects rail facts that cannot say whether the last context is complete', () => {
  const file = path.join(folder(), 'cache.json');
  const { finished: _finished, ...unfinishedFacts } = stats.turns[0];
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [
        {
          file: '/session.jsonl',
          entry: { ...title, stats: { ...stats, turns: [unfinishedFacts] } },
        },
      ],
    }),
  );
  assert.equal(
    loadDerivedCache(file).titles.size,
    0,
    'a row with no completion fact could quote a request before an unmeasured tool result',
  );
});

test('derived cache rejects rail facts that cannot say whether the last request failed', () => {
  const file = path.join(folder(), 'cache.json');
  const { error: _error, ...unknownFailureFacts } = stats.turns[0];
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [
        {
          file: '/session.jsonl',
          entry: { ...title, stats: { ...stats, turns: [unknownFailureFacts] } },
        },
      ],
    }),
  );
  assert.equal(
    loadDerivedCache(file).titles.size,
    0,
    'a row with no failure fact could mark an earlier successful request as warm',
  );
});

test('derived cache uses the transcript lifetime guard for rail request facts', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [
        {
          file: '/session.jsonl',
          entry: {
            ...title,
            stats: {
              ...stats,
              turns: [
                {
                  ...stats.turns[0],
                  contextRequest: { ...stats.turns[0].contextRequest, lifetime: 'forever' },
                },
              ],
            },
          },
        },
      ],
    }),
  );
  assert.equal(
    loadDerivedCache(file).titles.size,
    0,
    'a lifetime accepted outside the transcript union can outlive the cache a provider sold',
  );
});

test('missing, corrupt, and invalid-version caches are empty', () => {
  const file = path.join(folder(), 'cache.json');
  assert.equal(loadDerivedCache(file).codexMetas.size, 0);
  fs.writeFileSync(file, '{');
  assert.equal(loadDerivedCache(file).titles.size, 0);
  fs.writeFileSync(file, JSON.stringify({ version: 99, codexMetas: [], titles: [] }));
  assert.equal(loadDerivedCache(file).codexMetas.size, 0);
  fs.writeFileSync(
    file,
    JSON.stringify({ version: VERSION - 1, codexMetas: [], titles: [{ file: '/old.jsonl', entry: title }] }),
  );
  assert.equal(loadDerivedCache(file).titles.size, 0);
});

test('a cache row without its full title is rejected on reload', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [],
      titles: [{ file: '/old.jsonl', entry: { ...title, fullLabel: undefined } }],
    }),
  );
  assert.equal(
    loadDerivedCache(file).titles.size,
    0,
    'a cache written before full titles can pair a new detail value with an old display title',
  );
});

test('workspace-specific cache files keep their rows separate', () => {
  const root = folder();
  const first = path.join(root, 'first', 'cache.json');
  const second = path.join(root, 'second', 'cache.json');
  saveDerivedCache(first, [['/first.jsonl', title]]);
  saveDerivedCache(second, [['/second.jsonl', { ...title, label: 'second' }]]);
  assert.deepEqual([...loadDerivedCache(first).titles.keys()], ['/first.jsonl']);
  assert.deepEqual([...loadDerivedCache(second).titles.keys()], ['/second.jsonl']);
});

test('invalid rows and old title entries are discarded without losing valid rows', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: LEGACY_GENERATION,
      codexMetaVersion: CODEX_META_VERSION,
      codexMetas: [
        { file: '/good-rollout.jsonl', meta: codexMeta },
        { file: '/bad-rollout.jsonl', meta: { ...codexMeta, hasSubagentSource: 'yes' } },
        { file: '/bad-boundary.jsonl', meta: { ...codexMeta, replayBoundaryAt: 'early' } },
        { file: '/bad-kind.jsonl', meta: { ...codexMeta, subagentKind: 1 } },
      ],
      titles: [
        { file: '/good-session.jsonl', entry: title },
        { file: '/old-session.jsonl', entry: { ...title, stats: undefined } },
        { file: '/bad-session.jsonl', entry: { ...title, outcome: { ...outcome, endedAt: 'later' } } },
        { file: '/bad-process-end.jsonl', entry: { ...title, outcome: { ...outcome, processEndedAt: null } } },
        {
          file: '/bad-stats.jsonl',
          entry: { ...title, stats: { ...stats, turns: [{ ...stats.turns[0], contextTokens: 'many' }] } },
        },
        {
          file: '/bad-bands.jsonl',
          entry: {
            ...title,
            stats: {
              ...stats,
              turns: [
                {
                  ...stats.turns[0],
                  usage: { ...stats.turns[0].usage, byContextBand: { short: { input: 'many' } } },
                },
              ],
            },
          },
        },
        {
          file: '/empty-bands.jsonl',
          entry: {
            ...title,
            stats: {
              ...stats,
              turns: [
                {
                  ...stats.turns[0],
                  usage: { ...stats.turns[0].usage, byContextBand: {} },
                },
              ],
            },
          },
        },
        {
          file: '/mismatched-bands.jsonl',
          entry: {
            ...title,
            stats: {
              ...stats,
              turns: [
                {
                  ...stats.turns[0],
                  usage: {
                    ...stats.turns[0].usage,
                    byContextBand: {
                      short: { ...stats.turns[0].usage, input: 99 },
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    }),
  );
  // The legacy format carries Codex openings. Only the current format holds the current generation.
  assert.equal(loadDerivedCache(file).codexMetas.size, 1);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ formatVersion: 1, metadataVersion: VERSION, titles: rows.titles }));
  const loaded = loadDerivedCache(file);
  assert.deepEqual(loaded.titles.get('/good-session.jsonl'), title);
  assert.equal(loaded.titles.has('/old-session.jsonl'), false);
  assert.equal(loaded.titles.has('/bad-session.jsonl'), false);
  assert.equal(loaded.titles.has('/bad-stats.jsonl'), false);
  assert.equal(loaded.titles.has('/bad-bands.jsonl'), false);
  assert.equal(loaded.titles.has('/empty-bands.jsonl'), false);
  assert.equal(loaded.titles.has('/mismatched-bands.jsonl'), false);
});

test('a half-written target is treated as a cold cache', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(file, `{"version":${VERSION},"codexMetas":[`);
  const loaded = loadDerivedCache(file);
  assert.equal(loaded.codexMetas.size, 0);
  assert.equal(loaded.titles.size, 0);
});

test('a failed replacement preserves the old cache and removes its temporary file', () => {
  const file = path.join(folder(), 'cache.json');
  saveDerivedCache(file, [['/old.jsonl', title]]);
  let temporary = '';
  assert.throws(
    () =>
      saveDerivedCache(file, [['/new.jsonl', title]], [], [], (from) => {
        temporary = from;
        throw new Error('replacement failed');
      }),
    /replacement failed/,
  );
  assert.deepEqual([...loadDerivedCache(file).titles.keys()], ['/old.jsonl']);
  assert.equal(fs.existsSync(temporary), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['cache.json']);
});

test('a save clears the temporaries a killed process left beside the cache', () => {
  const file = path.join(folder(), 'cache.json');
  saveDerivedCache(file, []);
  for (const at of [1, 2, 3]) {
    fs.writeFileSync(`${file}.${process.pid}.${at}.tmp`, '');
  }
  saveDerivedCache(file, [['/session.jsonl', title]]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['cache.json']);
  assert.deepEqual([...loadDerivedCache(file).titles.keys()], ['/session.jsonl']);
});

test('an empty cached Codex field is rejected and the next lookup reads the rollout', () => {
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION,
      codexMetas: [{ file: '/empty-rollout.jsonl', meta: { ...codexMeta, cwd: '' } }],
      titles: [],
    }),
  );
  const loaded = loadDerivedCache(file);
  let reads = 0;
  const cache = new CodexMetaCache(() => {
    reads += 1;
    return codexMeta;
  });
  cache.load(loaded.codexMetas);
  assert.deepEqual(cache.get('/empty-rollout.jsonl'), codexMeta);
  assert.equal(reads, 1);
});

test('a metadata read that finds no facts publishes the last ones, and still asks for the whole file', () => {
  const grown: DerivedTitleEntry = { ...title, mtimeMs: 11, size: 40, stats: null };
  const carried = carryDerivedTitleFacts(title, grown);
  assert.equal(carried.stats, null, 'the empty read is filled in, so nothing asks for the whole file');
  assert.deepEqual(derivedTitleStats(carried), stats);
  assert.deepEqual(railEnrichmentNeeds(carried, { mtimeMs: 11, size: 40 }), { starts: false, metadata: true });
  assert.deepEqual(carried.heldRevision, { mtimeMs: 10, size: 20 }, 'the held facts lost the revision that read them');
  const again = carryDerivedTitleFacts(carried, { ...title, mtimeMs: 12, size: 60, stats: null });
  assert.deepEqual(derivedTitleStats(again), stats, 'the held facts last one read only');
  assert.deepEqual(again.heldRevision, { mtimeMs: 10, size: 20 }, 'a later read moved the revision of held facts');
  const found = carryDerivedTitleFacts(again, { ...title, mtimeMs: 13, size: 80 });
  assert.equal(found.heldStats, undefined, 'a read of its own keeps a stand-in beside it');
  assert.equal(found.heldRevision, undefined, 'a read of its own keeps the revision of released facts');
  assert.deepEqual(derivedTitleStats(found), stats);
  const cold = carryDerivedTitleFacts(undefined, grown);
  assert.equal(derivedTitleStats(cold), null);
});

test('held session facts survive a cache round trip and a malformed one is rejected', () => {
  const file = path.join(folder(), 'cache.json');
  const held: DerivedTitleEntry = { ...title, stats: null, heldStats: stats, heldRevision: { mtimeMs: 9, size: 10 } };
  saveDerivedCache(file, [['/session.jsonl', held]]);
  assert.deepEqual(loadDerivedCache(file).titles.get('/session.jsonl'), held);
  const withoutHeld: Partial<DerivedTitleEntry> = { ...held };
  delete withoutHeld.heldStats;
  for (const entry of [
    { ...held, heldStats: { turns: 'none', compactions: [] } },
    { ...held, heldRevision: { mtimeMs: 9 } },
    withoutHeld,
  ]) {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: VERSION, codexMetas: [], titles: [{ file: '/session.jsonl', entry }] }),
    );
    assert.equal(loadDerivedCache(file).titles.size, 0, JSON.stringify(entry));
  }
});

test('a hold ends when a read of the whole file proves there are no facts', () => {
  const grown: DerivedTitleEntry = { ...title, mtimeMs: 11, size: 40, stats: null };
  const carried = carryDerivedTitleFacts(title, grown);
  assert.deepEqual(derivedTitleStats(carried), stats);
  const proved = carryDerivedTitleFacts(carried, {
    ...grown,
    mtimeMs: 12,
    size: 50,
    expandedStatsRead: true,
  });
  assert.equal(
    proved.heldStats,
    undefined,
    'a session whose whole file holds no facts keeps the earlier figures for good',
  );
  assert.equal(derivedTitleStats(proved), null);
});

test('a transcript that shrank does not inherit the figures of the one it replaced', () => {
  const carried = carryDerivedTitleFacts(title, { ...title, mtimeMs: 11, size: 40, stats: null });
  const rewritten = carryDerivedTitleFacts(carried, { ...title, mtimeMs: 12, size: 4, stats: null });
  assert.equal(rewritten.heldStats, undefined, 'figures read from one transcript are drawn on the card of another');
  assert.equal(derivedTitleStats(rewritten), null);
});

test('a turn that has not reported its context draws the figures the session last had', () => {
  const started: SessionStatFacts = {
    turns: [...stats.turns, { ...stats.turns[0], startedAt: 30, endedAt: 30, contextTokens: 0 }],
    compactions: [],
  };
  const boundary = carryDerivedTitleFacts(title, { ...title, mtimeMs: 11, size: 40, stats: started });
  assert.deepEqual(derivedTitleStats(boundary), stats, 'the context chip leaves the card at every turn boundary');
  const reported = carryDerivedTitleFacts(boundary, {
    ...title,
    mtimeMs: 12,
    size: 50,
    stats: {
      ...started,
      turns: [...stats.turns, { ...stats.turns[0], startedAt: 30, endedAt: 30, contextTokens: 300 }],
    },
  });
  assert.equal(reported.heldStats, undefined, 'the first usage record of a turn does not end the hold');
  assert.equal(derivedTitleStats(reported)?.turns.length, 2);
});

test('cache facts rest on the revision of the read that found them', () => {
  const own = { mtimeMs: 12, size: 50 };
  const heldAt = { mtimeMs: 11, size: 40 };
  const entry = { ...title, ...own };
  const pending: SessionStatFacts = {
    turns: [{ ...stats.turns[0], startedAt: 30, endedAt: 30, contextTokens: 0, contextRequest: null }],
    compactions: [],
  };
  const failed: SessionStatFacts = { ...pending, turns: [{ ...pending.turns[0], error: true }] };
  const compaction = { at: 40, contextAfter: 3, trigger: 'manual' as const, model: null };
  const compacted: SessionStatFacts = {
    turns: [{ ...pending.turns[0], startedAt: 50, endedAt: 50 }],
    compactions: [compaction],
  };
  const held = { heldStats: stats, heldRevision: heldAt };
  const cases: [name: string, entry: DerivedTitleEntry, revision: typeof own | null][] = [
    ['current context', entry, own],
    ['held facts beside a pending turn', { ...entry, stats: pending, ...held }, heldAt],
    ['held facts without a revision', { ...entry, stats: pending, heldStats: stats }, null],
    ['held facts beside a tail with no prompt', { ...entry, stats: null, ...held }, heldAt],
    ['held facts beside a current failure', { ...entry, stats: failed, ...held }, own],
    ['held facts beside a later compaction', { ...entry, stats: compacted, ...held }, own],
    [
      'held facts beside an earlier compaction',
      { ...entry, stats: { ...pending, compactions: [{ ...compaction, at: 5 }] }, ...held },
      heldAt,
    ],
    ['a compaction without held facts', { ...entry, stats: compacted }, own],
    ['a pending turn without held facts', { ...entry, stats: pending }, null],
    ['no facts', { ...entry, stats: null }, null],
  ];
  for (const [name, entry, revision] of cases) {
    assert.deepEqual(derivedTitleCacheRevision(entry), revision, name);
    assert.equal(derivedTitleCacheCurrent(entry), revision === own, name);
  }
});

test('a stored Claude name survives a later metadata read that saw only a lower-ranked source', () => {
  const named: DerivedTitleEntry = {
    ...title,
    size: 100,
    label: 'Fix login flow',
    fullLabel: 'Fix login flow',
    nameSource: 'generated',
    foldedLabel: 'fix login flow',
  };
  const prompt: DerivedTitleEntry = {
    ...title,
    size: 200,
    label: 'retry',
    fullLabel: 'retry',
    nameSource: 'prompt',
    foldedLabel: 'retry',
  };
  const carried = carryDerivedTitleFacts(named, prompt);
  assert.deepEqual(
    [carried.label, carried.nameSource, carried.foldedLabel],
    ['Fix login flow', 'generated', 'fix login flow'],
  );
  const replaced = carryDerivedTitleFacts(named, { ...prompt, size: 50 });
  assert.equal(replaced.label, 'retry', 'a file that shrank is a new transcript');
});

test('a stored Claude name is dropped when the transcript at its path is replaced', () => {
  const named: DerivedTitleEntry = {
    ...title,
    size: 100,
    label: 'Owner',
    fullLabel: 'Owner',
    nameSource: 'custom',
    nameAt: 40,
    headKey: 'a',
  };
  const prompt: DerivedTitleEntry = {
    ...title,
    size: 200,
    label: 'typed',
    fullLabel: 'typed',
    nameSource: 'prompt',
    nameAt: 0,
    headKey: 'a',
  };
  assert.equal(carryDerivedTitleFacts(named, prompt).label, 'Owner');
  assert.equal(carryDerivedTitleFacts(named, { ...prompt, headKey: 'b' }).label, 'typed', 'a reused session id');
  const renamed = carryDerivedTitleFacts(named, {
    ...prompt,
    label: 'Renamed',
    fullLabel: 'Renamed',
    nameSource: 'custom',
    nameAt: 150,
  });
  assert.deepEqual([renamed.label, renamed.nameAt], ['Renamed', 150]);
  const lagging = carryDerivedTitleFacts(renamed, {
    ...prompt,
    label: 'Owner',
    fullLabel: 'Owner',
    nameSource: 'custom',
    nameAt: 40,
  });
  assert.equal(lagging.label, 'Renamed', 'a read that reached only the older record');
});

test('a held name survives a save and a load of the derived cache', () => {
  const file = path.join(tempDir('arc-derived-name-'), 'cache.json');
  const entry = withSessionName(
    {
      ...title,
      size: 100,
      label: 'typed',
      fullLabel: 'typed',
      nameSource: 'prompt',
      nameAt: 0,
      foldedLabel: 'typed',
      headKey: 'a',
    },
    { label: 'Rail row names', fullLabel: 'Rail row names', source: 'generated', at: 60 },
  );
  saveDerivedCache(file, new Map([['session.jsonl', entry]]));
  const loaded = loadDerivedCache(file).titles.get('session.jsonl');
  assert.deepEqual(
    [loaded?.label, loaded?.nameSource, loaded?.nameAt, loaded?.foldedLabel, loaded?.headKey],
    ['Rail row names', 'generated', 60, 'rail row names', 'a'],
  );
});

test('a child transcript drops a carried agent-run scan instead of reapplying it', () => {
  const staleScan: AgentRunScan = {
    bytes: 20,
    prompts: 0,
    finished: true,
    unattended: true,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false,
    person: false,
  };
  const cached: DerivedTitleEntry = { ...title, agentRun: false, agentRunScan: staleScan };
  const session = { agent: 'claude', size: 300_000, childTranscript: true as const };
  const reread: DerivedTitleEntry = { ...title, agentRun: true, size: 300_000, agentRunScan: undefined };
  const carried = carryDerivedTitleFacts(cached, reread, session);
  assert.equal(carried.agentRunScan, undefined, 'a child transcript still carries a stale agent-run scan forward');
});

test('rail enrichment for a child transcript past the metadata tail keeps the metadata reading and drops a stale scan', () => {
  const staleScan: AgentRunScan = {
    bytes: 20,
    prompts: 0,
    finished: true,
    unattended: true,
    changedFile: false,
    deniedTool: false,
    command: false,
    bridgeSession: false,
    bg: false,
    person: false,
  };
  const session = { agent: 'claude', size: CLAUDE_METADATA_TAIL_BYTES + 1024, childTranscript: true as const };
  const metadataEntry: DerivedTitleEntry = { ...title, agentRun: true };
  const found = withRailEnrichment(metadataEntry, title.starts!, scanForRailEnrichment(session, staleScan));
  assert.equal(
    found.agentRun,
    true,
    'a stale scan overrode the metadata reading for a child transcript past the metadata tail',
  );
  assert.equal(
    found.agentRunScan,
    undefined,
    'a stale scan survived rail enrichment for a child transcript past the metadata tail',
  );
});

// Build the progressive worker's metadata entry for one Claude transcript.
// Only an explicit true agent-run reading classifies the session as an agent run.
function metadataEntry(file: string): DerivedTitleEntry {
  const size = fs.statSync(file).size;
  const meta = readSessionMeta(file, CLAUDE_METADATA_TAIL_BYTES);
  return { ...title, size, agentRun: meta.agentRun === true, ...(meta.headKey ? { headKey: meta.headKey } : {}) };
}

// Return the session list buckets for one metadata entry.
function railBucketsOf(entry: DerivedTitleEntry): string[] {
  const now = new Date(2026, 0, 1).getTime();
  const card = { at: now, pinnedTop: false, current: false, archived: false, agentRun: entry.agentRun ?? false };
  return railBuckets([card], now).buckets.map((bucket) => bucket.id);
}

// Read transcript metadata, then scan beyond the metadata window when needed.
// Enrichment combines the metadata and scan before assigning session list buckets.
// Return the transcript size alongside its buckets.
function railBucketsOfTranscript(file: string): { size: number; buckets: string[] } {
  const entry = metadataEntry(file);
  const session = { agent: 'claude', size: entry.size };
  const scan = needsAgentRunScan(session) ? scanForAgentRun(file, entry.size) : undefined;
  const found = withRailEnrichment(entry, title.starts!, scanForRailEnrichment(session, scan));
  return { size: entry.size, buckets: railBucketsOf(found) };
}

function writeRunningTranscript(records: object[], tail = '\n'): string {
  const file = path.join(folder(), 'running.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + tail);
  return file;
}

const pastWindow = 'x'.repeat(CLAUDE_METADATA_TAIL_BYTES);

// Both sizes, so the tail reader answers for the small file and the whole-file scan for the
// large one.
const transcriptSizes = [
  { name: 'inside the metadata window', padding: 'ok' },
  { name: 'past the metadata window', padding: pastWindow },
];

// Return session list buckets for each generated transcript size.
// and whether each file is past the metadata window.
function railBucketsBySize(records: (padding: string) => object[]): {
  buckets: Record<string, string[]>;
  past: boolean[];
} {
  const read = transcriptSizes.map(({ name, padding }) => ({
    name,
    ...railBucketsOfTranscript(writeRunningTranscript(records(padding))),
  }));
  return {
    buckets: Object.fromEntries(read.map(({ name, buckets }) => [name, buckets])),
    past: read.map(({ size }) => size > CLAUDE_METADATA_TAIL_BYTES),
  };
}

const eachSize = (buckets: string[]) => Object.fromEntries(transcriptSizes.map(({ name }) => [name, buckets]));

test('a running SDK-only run files under Run by agents before its turn finishes', () => {
  const found = railBucketsBySize((padding) => runningSdkTranscript({ padding }));
  assert.deepEqual(found.past, [false, true], 'the running SDK transcripts do not straddle the metadata window');
  assert.deepEqual(found.buckets, eachSize(['agent']), 'a running SDK-only run filed under today');
});

test('a running SDK transcript whose prompt carries a human origin files under Today', () => {
  assert.deepEqual(
    railBucketsBySize((padding) => runningSdkTranscript({ padding, origin: { kind: 'human' } })).buckets,
    eachSize(['today']),
    'a panel-sent SDK session filed as a run',
  );
});

// A running transcript already files under Today because its turn has not finished, so that
// alone cannot show what a claude-vscode entrypoint does. Finishing the turn removes that
// confound: `personSignIn` locks a non-SDK entrypoint to a person on its first record, so a
// finished claude-vscode session still files under Today even though every other sign here
// reads as a run.
test('a finished claude-vscode session files under Today because its entrypoint locks a person', () => {
  const finished = (padding: string) => [
    ...runningSdkTranscript({ padding, entrypoint: 'claude-vscode' }),
    {
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString(),
      entrypoint: 'claude-vscode',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
      },
    },
  ];
  assert.deepEqual(
    railBucketsBySize(finished).buckets,
    eachSize(['today']),
    'a finished claude-vscode session filed as a run',
  );
});

// `claude --bg` sends its first prompt with a human origin, often under an SDK entrypoint.
test('a running background session files under Today until its turn finishes', () => {
  const background = (padding: string) => {
    const [prompt, ...rest] = runningSdkTranscript({ padding, origin: { kind: 'human' } });
    return [{ ...prompt, sessionKind: 'bg' }, ...rest];
  };
  assert.deepEqual(
    railBucketsBySize(background).buckets,
    eachSize(['today']),
    'a running background session filed as a run',
  );
});

// A read can land while Claude Code is still writing the last record.
const halfWritten = '\n{"type":"assistant","message":{"role":"assi';

test('a running SDK-only run whose last record is half written files under Run by agents', () => {
  const file = writeRunningTranscript(runningSdkTranscript(), halfWritten);
  assert.deepEqual(
    railBucketsOfTranscript(file).buckets,
    ['agent'],
    'a half-written last record filed a running run under today',
  );
});

test('a running SDK-only run past the metadata window whose last record is half written files under Run by agents', () => {
  const found = railBucketsOfTranscript(
    writeRunningTranscript(runningSdkTranscript({ padding: pastWindow }), halfWritten),
  );
  assert.equal(found.size > CLAUDE_METADATA_TAIL_BYTES, true, 'the transcript fits the metadata window');
  assert.deepEqual(found.buckets, ['agent'], 'a half-written last record filed a large running run under today');
});

// Each append makes a new metadata entry before the rail enrichment scans the appended bytes.
test('a running SDK-only run past the metadata window stays under Run by agents while it grows', () => {
  const file = writeRunningTranscript(runningSdkTranscript({ padding: pastWindow }));
  const session = () => ({ agent: 'claude', size: fs.statSync(file).size });
  const first = metadataEntry(file);
  const scanned = withRailEnrichment(first, title.starts!, scanForAgentRun(file, first.size));
  assert.deepEqual(railBucketsOf(scanned), ['agent'], 'the scanned run filed under today');
  const append = (record: object) => {
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    return metadataEntry(file);
  };
  const grown = append({
    type: 'assistant',
    entrypoint: 'sdk-cli',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'git diff' } }],
    },
  });
  const carried = carryDerivedTitleFacts(scanned, grown, session());
  assert.deepEqual(
    railBucketsOf(carried),
    ['agent'],
    'an append filed the running run under today before the scan read it',
  );
  const rewritten = carryDerivedTitleFacts(scanned, { ...grown, headKey: 'another transcript' }, session());
  assert.deepEqual(railBucketsOf(rewritten), ['today'], 'a replaced transcript kept the run answer of the one before');
  const typed = append({
    type: 'user',
    entrypoint: 'sdk-cli',
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text: 'a person typed this' }] },
  });
  const held = carryDerivedTitleFacts(carried, typed, session());
  assert.deepEqual(railBucketsOf(held), ['agent'], 'a second append dropped the run answer before the scan read it');
  const rescanned = withRailEnrichment(held, title.starts!, scanForAgentRun(file, held.size, held.agentRunScan));
  assert.deepEqual(railBucketsOf(rescanned), ['today'], 'the scan kept a run answer past a typed prompt');
});

// A running SDK-only transcript retains its agent-run classification while crossing the metadata window.
// The small file receives its classification from the metadata tail without a scan.
// The larger metadata entry must retain that classification until the first scan completes.
test('a running SDK-only run crossing the metadata window stays under Run by agents until the first scan', () => {
  const file = writeRunningTranscript(runningSdkTranscript());
  const before = metadataEntry(file);
  assert.equal(before.agentRun, true, 'the running transcript inside the window was not read as a run');
  assert.equal(before.agentRunScan, undefined, 'the running transcript inside the window already carried a scan');
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: pastWindow }] },
    }) + '\n',
  );
  const grown = metadataEntry(file);
  assert.equal(grown.size > CLAUDE_METADATA_TAIL_BYTES, true, 'the append did not cross the metadata window');
  assert.equal(grown.agentRun, false, 'the grown entry answered a run on its own tail read past the window');
  const carried = carryDerivedTitleFacts(before, grown, { agent: 'claude', size: grown.size });
  assert.deepEqual(railBucketsOf(carried), ['agent'], 'the crossing append filed the running run under today');
});

// The no-scan carry only forwards a run answer while the file grows in place. Without that
// gate a replaced or shrunk transcript would keep a stale run answer indefinitely.
test('a run answer carried past the metadata window does not survive a replaced or shrunk transcript', () => {
  const file = writeRunningTranscript(runningSdkTranscript());
  const before = metadataEntry(file);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: pastWindow }] },
    }) + '\n',
  );
  const grown = metadataEntry(file);
  const session = { agent: 'claude', size: grown.size };
  const carried = carryDerivedTitleFacts(before, grown, session);
  assert.deepEqual(railBucketsOf(carried), ['agent'], 'the crossing append did not carry the run answer to build from');

  const replaced = carryDerivedTitleFacts(carried, { ...grown, headKey: 'another transcript' }, session);
  assert.deepEqual(
    railBucketsOf(replaced),
    ['today'],
    'a replaced transcript carried a stale run answer past the window',
  );

  const shrunk = { ...grown, size: grown.size - 64 };
  assert.equal(
    shrunk.size > CLAUDE_METADATA_TAIL_BYTES,
    true,
    'the shrunk transcript no longer fits the case being tested',
  );
  const afterShrink = carryDerivedTitleFacts(carried, shrunk, { agent: 'claude', size: shrunk.size });
  assert.deepEqual(
    railBucketsOf(afterShrink),
    ['today'],
    'a shrunk transcript carried a stale run answer past the window',
  );
});

test('an agent-run scan that arrived through a stale worker read still carries its run answer to the next append', () => {
  const file = writeRunningTranscript(runningSdkTranscript({ padding: pastWindow }));
  const entry = metadataEntry(file);
  assert.equal(entry.agentRun, false, 'the tail read past the window answered anything but a person');
  const scan = scanForAgentRun(file, entry.size);
  assert.equal(scan.person, false, 'the scan found a person in a running SDK-only transcript');
  const stale = withAgentRunScanProgress(entry, scan);
  assert.ok(stale);
  assert.equal(stale.agentRun, false, 'a scan arriving through the stale path touched the agentRun field');
  const session = () => ({ agent: 'claude', size: fs.statSync(file).size });
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      entrypoint: 'sdk-cli',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'git diff' } }],
      },
    }) + '\n',
  );
  const grown = metadataEntry(file);
  const carried = carryDerivedTitleFacts(stale, grown, session());
  assert.deepEqual(
    railBucketsOf(carried),
    ['agent'],
    'a run answer the scan itself found was lost because the entry it arrived on answered agentRun: false',
  );
});

test('a scan that found a person files under Today and stays there across the next append', () => {
  const file = writeRunningTranscript(runningSdkTranscript({ padding: pastWindow, origin: { kind: 'human' } }));
  const entry = metadataEntry(file);
  const scan = scanForAgentRun(file, entry.size);
  assert.equal(scan.person, true, 'the scan did not find the human-origin prompt past the metadata window');
  const scanned = withRailEnrichment(entry, title.starts!, scan);
  assert.deepEqual(railBucketsOf(scanned), ['today'], 'a scan that found a person filed the session under agent');
  const session = () => ({ agent: 'claude', size: fs.statSync(file).size });
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      entrypoint: 'sdk-cli',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'git diff' } }],
      },
    }) + '\n',
  );
  const grown = metadataEntry(file);
  const carried = carryDerivedTitleFacts(scanned, grown, session());
  assert.deepEqual(
    railBucketsOf(carried),
    ['today'],
    'an append carried a run answer beside a scan that found a person',
  );
});

// A late first scan finds a human-origin prompt outside the metadata window.
// Two intervening metadata entries have retained agentRun: true without a scan.
// The scan's person classification must clear the carried agent-run value immediately.
test('a stale first scan that finds a person clears a previously carried run answer', () => {
  const file = writeRunningTranscript(runningSdkTranscript());
  const before = metadataEntry(file);
  const session = () => ({ agent: 'claude', size: fs.statSync(file).size });
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: pastWindow }] },
    }) + '\n',
  );
  const grown = metadataEntry(file);
  const carried = carryDerivedTitleFacts(before, grown, session());
  assert.deepEqual(railBucketsOf(carried), ['agent'], 'the crossing append did not carry a run answer to build from');

  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text: 'a person typed this' }] },
    }) + '\n',
  );
  const grownAgain = metadataEntry(file);
  const carriedAgain = carryDerivedTitleFacts(carried, grownAgain, session());
  assert.deepEqual(
    railBucketsOf(carriedAgain),
    ['agent'],
    'a second crossing append lost the carried run answer before the first scan ran',
  );

  const scan = scanForAgentRun(file, carriedAgain.size);
  assert.equal(scan.person, true, 'the first whole-file scan did not find the human-origin prompt');
  const stale = withAgentRunScanProgress(carriedAgain, scan);
  assert.ok(stale);
  assert.equal(
    stale.agentRun,
    false,
    'a person scan arriving through the stale path left a carried run answer standing',
  );
  assert.deepEqual(railBucketsOf(stale), ['today'], 'a stale scan that found a person still filed under agent');
});

// A Codex sessions tree with one rollout per id, each opened in the tree's own root.
function rolloutTree(count: number, opening: (id: string, root: string) => object = userOpening) {
  const root = tempDir('codex-openings-');
  const day = path.join(root, '2026', '09', '20');
  fs.mkdirSync(day, { recursive: true });
  const files = Array.from({ length: count }, (_, n) => {
    const id = `01a032c9-0000-7000-8000-${String(n).padStart(12, '0')}`;
    const file = path.join(day, `rollout-2026-09-20T10-00-00-${id}.jsonl`);
    const turn = { timestamp: '2026-09-20T10:00:01.000Z', type: 'event_msg', payload: { type: 'task_started' } };
    fs.writeFileSync(file, [JSON.stringify(opening(id, root)), JSON.stringify(turn), ''].join('\n'));
    return file;
  });
  return { root, files };
}

function userOpening(id: string, root: string): object {
  return {
    timestamp: '2026-09-20T10:00:00.000Z',
    type: 'session_meta',
    payload: { id, cwd: root, source: 'vscode', thread_source: 'user' },
  };
}

// A Codex opening cache whose every head read is counted.
function countingCodexMetas() {
  let reads = 0;
  const cache = new CodexMetaCache((file) => {
    reads += 1;
    return readCodexSessionMeta(file);
  });
  const list = (root: string, folders: string[]) => codexSessionFiles(root, folders, (file) => cache.get(file));
  return { cache, list, reads: () => reads };
}

function storedRows(cache: CodexMetaCache) {
  return cache.snapshot().map(([file, meta]) => ({ file, meta }));
}

test('a derived cache from an earlier version keeps Codex opening rows at the current Codex meta version', () => {
  const { root } = rolloutTree(3);
  const first = countingCodexMetas();
  first.list(root, [root]);
  assert.equal(first.reads(), 3);
  const file = path.join(folder(), 'cache.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: VERSION - 1,
      codexMetaVersion: CODEX_META_VERSION,
      codexMetas: storedRows(first.cache),
      titles: [],
    }),
  );
  const again = countingCodexMetas();
  again.cache.load(loadDerivedCache(file).codexMetas);
  assert.equal(again.list(root, [root]).sessions.length, 3);
  assert.equal(again.reads(), 0, 'a derived cache version bump read every rollout head again');
});

test('a second workspace with no cache partition reads no opening record the shared file holds', () => {
  const { root } = rolloutTree(3);
  const shared = path.join(folder(), 'codex-openings.json');
  const first = countingCodexMetas();
  const listing = first.list(root, [root]);
  assert.ok(saveCodexOpenings(shared, new Map(first.cache.snapshot()), listing.walked));
  const second = countingCodexMetas();
  const partition = path.join(folder(), 'second', 'derived-session-cache.json');
  second.cache.load(codexOpeningsAtStartup(shared, loadDerivedCache(partition).codexMetas).rows);
  assert.equal(second.list(root, [path.join(root, 'elsewhere')]).sessions.length, 0);
  assert.equal(second.reads(), 0, 'a workspace opened for the first time read every rollout head');
});

test('legacy workspace files discard opening rows with obsolete clocks', () => {
  const { root } = rolloutTree(3);
  const first = countingCodexMetas();
  first.list(root, [root]);
  const missing = path.join(folder(), 'codex-openings.json');
  for (const [version, reads] of [
    [29, 3],
    [28, 3],
    [27, 3],
    [26, 3],
  ]) {
    const workspace = path.join(folder(), 'derived-session-cache.json');
    fs.writeFileSync(
      workspace,
      JSON.stringify({ version, codexMetas: storedRows(first.cache), titles: [], claudeChildReferences: [] }),
    );
    const openings = codexOpeningsAtStartup(missing, loadDerivedCache(workspace).codexMetas);
    assert.equal(openings.seeded, true);
    const window = countingCodexMetas();
    window.cache.load(openings.rows);
    window.list(root, [root]);
    assert.equal(window.reads(), reads, `a version ${version} workspace file`);
  }
});

test('obsolete opening clocks rebuild guardian and delayed direct metadata', () => {
  for (const guardian of [true, false]) {
    const payloadClock = '2026-09-20T09:59:52.000Z';
    const { root, files } = rolloutTree(1, (id, cwd) => ({
      timestamp: '2026-09-20T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id,
        cwd,
        timestamp: payloadClock,
        thread_source: guardian ? 'guardian_review' : 'user',
        parent_thread_id: guardian ? 'parent' : undefined,
        source: guardian ? { subagent: { other: 'guardian' } } : 'vscode',
      },
    }));
    const current = readCodexSessionMeta(files[0]);
    assert.equal(current?.startedAt, Date.parse(payloadClock));
    const shared = path.join(folder(), 'codex-openings.json');
    const stale = { ...current, startedAt: current?.openedAt, replayBoundaryAt: current?.openedAt };
    fs.writeFileSync(shared, JSON.stringify({ codexMetaVersion: 1, codexMetas: [{ file: files[0], meta: stale }] }));
    const window = countingCodexMetas();
    window.cache.load(codexOpeningsAtStartup(shared, undefined).rows);
    const listing = window.list(root, [root]);
    assert.equal(window.reads(), 1, 'a row from an older Codex meta version was served');
    assert.equal(
      guardian ? listing.subagents[0]?.startedAt : window.cache.get(files[0])?.startedAt,
      Date.parse(payloadClock),
    );
    assert.equal(window.cache.get(files[0])?.replayBoundaryAt, Date.parse(payloadClock) + (guardian ? 4_000 : 0));
  }
});

test('literal native opening generation 2 rebuilds an unchanged delayed spawn clock', () => {
  const created = '2026-09-20T09:59:52.750Z';
  const { root, files } = rolloutTree(1, (id, cwd) => ({
    type: 'session_meta',
    timestamp: '2026-09-20T10:00:00.000Z',
    payload: {
      id,
      cwd,
      timestamp: created,
      session_id: 'parent',
      parent_thread_id: 'parent',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    },
  }));
  const current = readCodexSessionMeta(files[0])!;
  const stale = { ...current, startedAt: current.openedAt, replayBoundaryAt: current.openedAt, nativeSpawnedAt: null };
  const shared = path.join(folder(), 'codex-openings.json');
  fs.writeFileSync(shared, JSON.stringify({ codexMetaVersion: 2, codexMetas: [{ file: files[0], meta: stale }] }));
  const window = countingCodexMetas();
  window.cache.load(codexOpeningsAtStartup(shared, undefined).rows);
  window.list(root, [root]);
  assert.equal(window.reads(), 1);
  assert.equal(window.cache.get(files[0])?.nativeSpawnedAt, Date.parse(created));
  assert.equal(window.cache.get(files[0])?.replayBoundaryAt, Date.parse(created) + 5000);
});

test('manual CLI compaction drops generation 45 running facts at unchanged EOF', () => {
  const directory = folder();
  const source = path.join(directory, 'compact.jsonl');
  const cache = path.join(directory, 'cache.json');
  const records = [
    {
      type: 'user',
      uuid: 'compact-opening',
      timestamp: '2026-10-07T09:17:51.416Z',
      message: { role: 'user', content: '/compact' },
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-10-07T09:18:03.839Z',
      compactMetadata: { trigger: 'manual', preTokens: 62077, postTokens: 4336, durationMs: 12409 },
    },
    {
      type: 'user',
      isCompactSummary: true,
      timestamp: '2026-10-07T09:18:03.827Z',
      message: { role: 'user', content: 'Retained summary' },
    },
  ];
  fs.writeFileSync(source, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const before = fs.statSync(source);
  const stale: DerivedTitleEntry = {
    ...title,
    size: before.size,
    mtimeMs: before.mtimeMs,
    outcome: { finished: false, error: false, interrupted: false, endedAt: Date.parse(records[0].timestamp) },
  };
  fs.writeFileSync(cache, JSON.stringify({ version: 45, codexMetas: [], titles: [{ file: source, entry: stale }] }));
  const loaded = loadDerivedCache(cache);
  assert.equal(loaded.titles.size, 0);
  assert.equal(loaded.reuse?.reason, 'generation-mismatch');
  const fresh = { ...stale, outcome: readSessionMeta(source).outcome };
  assert.equal(fresh.outcome, null);
  saveDerivedCache(cache, [[source, fresh]]);
  assert.equal(loadDerivedCache(cache).titles.get(source)?.outcome, null);
  assert.equal(fs.statSync(source).size, before.size);
  assert.equal(fs.statSync(source).mtimeMs, before.mtimeMs);
});

test('literal native derived generation 38 discards saved missing-turn figures', () => {
  const file = path.join(folder(), 'cache.json');
  const stale = { ...title, stats: { turns: [], compactions: [] }, starts: { starts: [], whole: true } };
  for (const version of [38, 39, 40]) {
    fs.writeFileSync(
      file,
      JSON.stringify({ version, codexMetas: [], titles: [{ file: '/native.jsonl', entry: stale }] }),
    );
    const loaded = loadDerivedCache(file);
    assert.equal(loaded.titles.has('/native.jsonl'), false);
    assert.equal(loaded.carriedNames.get('/native.jsonl')?.label, title.label);
  }
});

test('literal native child-reference generation 22 discards an excluded dispatch cursor at unchanged EOF', () => {
  const directory = folder();
  const file = path.join(directory, 'native.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-09-20T10:00:10Z',
      payload: {
        id: 'native',
        session_id: 'parent',
        parent_thread_id: 'parent',
        timestamp: '2026-09-20T10:00:00Z',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
      },
    }) +
      '\n' +
      [
        {
          type: 'event_msg',
          timestamp: '2026-09-20T10:00:11Z',
          payload: {
            type: 'task_started',
            turn_id: 'own',
            started_at: Date.parse('2026-09-20T10:00:01Z') / 1000,
          },
        },
        {
          type: 'turn_context',
          timestamp: '2026-09-20T10:00:12Z',
          payload: { turn_id: 'own', model: 'gpt-6-astra', effort: 'high' },
        },
        {
          type: 'event_msg',
          timestamp: '2026-09-20T10:00:13Z',
          payload: { type: 'item_completed', item: powershellDispatchExecution },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') +
      '\n',
  );
  const scan = scanCodexDispatchReferences(file, 'native');
  assert.equal(scan.references.length, 1);
  const stat = fs.statSync(file);
  const cursor = {
    ...scan.cursor,
    openingTimestamp: Date.parse('2026-09-20T10:00:10Z'),
    nativeSpawnedAt: null,
    currentTurnCopied: true,
    candidates: [],
    pendingOwnershipTurnIds: [],
  };
  const entry = {
    parserVersion: 22,
    source: 'codex',
    sessionId: 'native',
    childTranscript: true,
    complete: true,
    visitedEof: true,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    references: [],
    cursor,
  };
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    cache,
    JSON.stringify({ version: VERSION, codexMetas: [], titles: [], claudeChildReferences: [{ file, entry }] }),
  );
  const loaded = loadDerivedCache(cache).claudeChildReferences;
  assert.equal(loaded.has(normalizeFsPath(file)), false);
  assert.equal(
    scanCodexDispatchReferences(file, 'native', loaded.get(normalizeFsPath(file))?.cursor ?? null).references.length,
    1,
  );
});

test('a deleted rollout stays gone when another window saved it earlier', () => {
  const { root, files } = rolloutTree(3);
  const shared = path.join(folder(), 'codex-openings.json');
  const other = countingCodexMetas();
  const walked = other.list(root, [root]).walked;
  assert.ok(saveCodexOpenings(shared, new Map(other.cache.snapshot()), walked));
  assert.equal(loadCodexOpenings(shared)?.size, 3);
  fs.unlinkSync(files[0]);
  const window = countingCodexMetas();
  window.cache.load(codexOpeningsAtStartup(shared, undefined).rows);
  const listing = window.list(root, [root]);
  for (const file of staleMetas(window.cache.keys(), listing.walked)) {
    window.cache.delete(file);
  }
  assert.ok(saveCodexOpenings(shared, new Map(window.cache.snapshot()), listing.walked));
  const saved = loadCodexOpenings(shared);
  assert.equal(saved?.has(files[0]), false, 'the older file brought a deleted rollout back');
  assert.equal(saved?.size, fs.readdirSync(path.dirname(files[0])).length);
  // The first window saves again from its walk before the deletion.
  other.list(root, [root]);
  assert.ok(saveCodexOpenings(shared, new Map(other.cache.snapshot()), walked));
  const after = loadCodexOpenings(shared);
  assert.equal(after?.has(files[0]), false, 'an older walk brought a deleted rollout back');
  assert.equal(after?.size, fs.readdirSync(path.dirname(files[0])).length);
});

test('two windows that judge one lock abandoned leave only one of them holding it', () => {
  const lock = path.join(folder(), 'codex-openings.json.lock');
  fs.writeFileSync(lock, 'a window that died');
  const abandoned = (Date.now() - CODEX_OPENINGS_LOCK_STALE_MS - 1_000) / 1000;
  fs.utimesSync(lock, abandoned, abandoned);
  let second: string | null = null;
  // The second window takes the lock between the first window's judgment and its removal.
  const first = takeCodexOpeningsLock(lock, Date.now(), () => {
    second = takeCodexOpeningsLock(lock, Date.now());
  });
  assert.notEqual(second, null, 'the second window did not take the abandoned lock');
  assert.equal(first, null, 'both windows hold the lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), second);
});

test('a save whose file replacement fails releases the lock', () => {
  const { root, files } = rolloutTree(1);
  const window = countingCodexMetas();
  const listing = window.list(root, [root]);
  const shared = path.join(folder(), 'codex-openings.json');
  const failing = () => {
    throw new Error('the replacement failed');
  };
  assert.throws(() => saveCodexOpenings(shared, new Map(window.cache.snapshot()), listing.walked, failing));
  assert.equal(fs.existsSync(`${shared}.lock`), false, 'a failed save kept the lock');
  assert.ok(saveCodexOpenings(shared, new Map(window.cache.snapshot()), listing.walked));
  assert.deepEqual([...(loadCodexOpenings(shared)?.keys() ?? [])], files);
});

test('a save that finds the lock busy saves once the lock is free with no further checkpoint', () => {
  vi.useFakeTimers();
  try {
    const { root, files } = rolloutTree(1);
    const window = countingCodexMetas();
    const shared = path.join(folder(), 'codex-openings.json');
    const writer = new CodexOpeningsWriter(shared, window.cache, false);
    writer.setWalk(window.list(root, [root]).walked);
    fs.writeFileSync(`${shared}.lock`, 'another window');
    assert.equal(writer.write(), false);
    fs.unlinkSync(`${shared}.lock`);
    vi.advanceTimersByTime(CODEX_OPENINGS_RETRY_MS);
    assert.deepEqual([...(loadCodexOpenings(shared)?.keys() ?? [])], files, 'the busy save never ran again');
    writer.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test('a workspace seed reaches the shared file at the first save when the walk reads nothing new', () => {
  const { root } = rolloutTree(3);
  const first = countingCodexMetas();
  first.list(root, [root]);
  const directory = folder();
  const shared = path.join(directory, 'codex-openings.json');
  const workspace = path.join(directory, 'derived-session-cache.json');
  // The workspace cache carries opening rows with the current clock classification.
  fs.writeFileSync(
    workspace,
    JSON.stringify({
      version: 29,
      codexMetaVersion: CODEX_META_VERSION,
      codexMetas: storedRows(first.cache),
      titles: [],
      claudeChildReferences: [],
    }),
  );
  const cached = loadDerivedCache(workspace);
  const openings = codexOpeningsAtStartup(shared, cached.codexMetas);
  const window = countingCodexMetas();
  window.cache.load(openings.rows);
  const writer = new CodexOpeningsWriter(shared, window.cache, openings.seeded);
  writer.setWalk(window.list(root, [root]).walked);
  assert.equal(window.reads(), 0);
  // The first checkpoint writes both files and removes the workspace opening seed.
  saveDerivedCache(workspace, cached.titles, cached.claudeChildReferences);
  assert.ok(writer.write());
  const next = countingCodexMetas();
  next.cache.load(codexOpeningsAtStartup(shared, loadDerivedCache(workspace).codexMetas).rows);
  next.list(root, [root]);
  assert.equal(next.reads(), 0, 'the first checkpoint lost the rows the workspace file held');
});

test('a save skips a held lock and removes an abandoned one', () => {
  const { root, files } = rolloutTree(1);
  const window = countingCodexMetas();
  const listing = window.list(root, [root]);
  const shared = path.join(folder(), 'codex-openings.json');
  const lock = `${shared}.lock`;
  fs.writeFileSync(lock, '');
  assert.equal(saveCodexOpenings(shared, new Map(window.cache.snapshot()), listing.walked), false);
  assert.equal(fs.existsSync(shared), false, 'a save wrote while another window held the lock');
  const abandoned = (Date.now() - CODEX_OPENINGS_LOCK_STALE_MS - 1_000) / 1000;
  fs.utimesSync(lock, abandoned, abandoned);
  assert.equal(saveCodexOpenings(shared, new Map(window.cache.snapshot()), listing.walked), true);
  assert.deepEqual([...(loadCodexOpenings(shared)?.keys() ?? [])], files);
  assert.equal(fs.existsSync(lock), false);
});

test('a holder paused past the stale age replaces nothing once another window took its lock over and saved', () => {
  const paused = rolloutTree(1);
  const other = rolloutTree(1);
  const pausedWindow = countingCodexMetas();
  const pausedListing = pausedWindow.list(paused.root, [paused.root]);
  const otherWindow = countingCodexMetas();
  const otherListing = otherWindow.list(other.root, [other.root]);
  const shared = path.join(folder(), 'codex-openings.json');
  const lock = `${shared}.lock`;
  let tookOver = false;
  // The paused window stops in its merge, after it read the file and before it checks its
  // token. Its lock ages past the stale age, and the other window takes it over and saves.
  const pausedSave = saveCodexOpenings(
    shared,
    new Map(pausedWindow.cache.snapshot()),
    pausedListing.walked,
    fs.renameSync,
    (rollout) => {
      if (!tookOver) {
        tookOver = true;
        const abandoned = (Date.now() - CODEX_OPENINGS_LOCK_STALE_MS - 1_000) / 1000;
        fs.utimesSync(lock, abandoned, abandoned);
        assert.equal(
          saveCodexOpenings(shared, new Map(otherWindow.cache.snapshot()), otherListing.walked),
          true,
          'the other window never took the stale lock over',
        );
      }
      return fs.existsSync(rollout);
    },
  );
  assert.ok(tookOver, 'the paused window never paused');
  assert.deepEqual(
    [...(loadCodexOpenings(shared)?.keys() ?? [])],
    other.files,
    "the paused holder replaced the file and lost the other window's rows",
  );
  assert.equal(pausedSave, false, 'a holder whose lock was taken reported its save as done');
  assert.equal(fs.existsSync(lock), false);
});

// One editor window that dies inside a stale-lock takeover. It exits in the removal of the
// abandoned lock, before or after the removal, the way a killed process stops.
const DYING_WINDOW_SCRIPT = `
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && path.extname(specifier) === '') {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const [modulePath, lock, death] = process.argv.slice(2);
const unlink = fs.unlinkSync;
fs.unlinkSync = (file) => {
  if (file === lock && death === 'before') {
    process.exit(9);
  }
  unlink(file);
  if (file === lock) {
    process.exit(9);
  }
};
syncBuiltinESMExports();
const { takeCodexOpeningsLock } = await import(pathToFileURL(modulePath).href);
takeCodexOpeningsLock(lock);
`;

test(
  'a window that dies inside a stale-lock takeover blocks no save past the stale age and leaves no guard',
  { tags: ['subprocess'] },
  async () => {
    const { root } = rolloutTree(1);
    const window = countingCodexMetas();
    const listing = window.list(root, [root]);
    const script = path.join(folder(), 'dying-window.mjs');
    fs.writeFileSync(script, DYING_WINDOW_SCRIPT);
    const age = (file: string) => {
      const abandoned = (Date.now() - CODEX_OPENINGS_LOCK_STALE_MS - 1_000) / 1000;
      fs.utimesSync(file, abandoned, abandoned);
    };
    for (const death of ['before', 'after']) {
      const directory = folder();
      const shared = path.join(directory, 'codex-openings.json');
      const lock = `${shared}.lock`;
      fs.writeFileSync(lock, 'a window that died holding the lock');
      age(lock);
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [script, path.join(__dirname, 'codexopenings.ts'), lock, death], {
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('exit', resolve);
      });
      assert.equal(code, 9, `${death}: the window did not die inside the takeover`);
      // Time passes, and every guard the dead window left ages past the stale age. The lock
      // keeps its time, because a guard is named for it.
      for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.takeover'))) {
        age(path.join(directory, name));
      }
      let saved = false;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        saved = saveCodexOpenings(shared, new Map(window.cache.snapshot()), listing.walked);
      }
      assert.ok(saved, `${death}: a window that died in a takeover blocked every later save`);
      assert.deepEqual(
        fs.readdirSync(directory).filter((name) => name.endsWith('.takeover')),
        [],
        `${death}: the guard of a window that died in a takeover stays beside the shared file`,
      );
    }
  },
);

// One editor window saving the shared file. It loads the file at startup, adds its own new
// rollout, and saves. The rename that commits its write waits until the other window has read
// the file or found the lock busy, so both windows read before either writes whenever nothing
// serializes them.
const WINDOW_SCRIPT = `
import { registerHooks } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// The extension's sources import each other with no file extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && path.extname(specifier) === '') {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const [modulePath, shared, signals, self, peer, ownJson, walkedJson] = process.argv.slice(2);
const { loadCodexOpenings, saveCodexOpenings } = await import(pathToFileURL(modulePath).href);
const deadline = Date.now() + 20000;
const pause = new Int32Array(new SharedArrayBuffer(4));
function poll(done) {
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(self + ' waited past its deadline');
    }
    Atomics.wait(pause, 0, 0, 5);
  }
}
const signal = (name) => fs.writeFileSync(path.join(signals, self + '.' + name), '');
const peerSaid = (name) => fs.existsSync(path.join(signals, peer + '.' + name));
const rows = new Map([...(loadCodexOpenings(shared) ?? new Map()), ...JSON.parse(ownJson)]);
const replace = (temporary, target) => {
  signal('read');
  poll(() => peerSaid('read') || peerSaid('busy'));
  fs.renameSync(temporary, target);
};
poll(() => {
  if (saveCodexOpenings(shared, rows, JSON.parse(walkedJson), replace)) {
    return true;
  }
  signal('busy');
  return false;
});
`;

test(
  'two windows that read the shared file before either saves both keep their new rows',
  { tags: ['subprocess'], timeout: 30_000 },
  async () => {
    const { root, files } = rolloutTree(4);
    const all = countingCodexMetas();
    all.list(root, [root]);
    const metas = new Map(all.cache.snapshot());
    const base = files.slice(0, 2);
    const shared = path.join(folder(), 'codex-openings.json');
    assert.ok(saveCodexOpenings(shared, new Map(base.map((file) => [file, metas.get(file)!])), base));
    const signals = folder();
    const script = path.join(signals, 'window.mjs');
    fs.writeFileSync(script, WINDOW_SCRIPT);
    const window = (self: string, peer: string, own: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            path.join(__dirname, 'codexopenings.ts'),
            shared,
            signals,
            self,
            peer,
            JSON.stringify([[own, metas.get(own)]]),
            JSON.stringify([...base, own]),
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`window ${self} exited ${code}: ${stderr}`)),
        );
      });
    await Promise.all([window('a', 'b', files[2]), window('b', 'a', files[3])]);
    assert.deepEqual([...(loadCodexOpenings(shared)?.keys() ?? [])].sort(), [...files].sort());
  },
);

test('version 42 null Bedrock lifetimes rebuild and persist with unchanged source statistics', async () => {
  const { readCodexSession } = await import('./codex.ts');
  const { sessionStatFactsOf } = await import('./transcript.ts');
  for (const version of [41, 42]) {
    const directory = folder();
    const source = path.join(directory, 'bedrock.jsonl');
    const cache = path.join(directory, 'cache.json');
    const at = '2026-10-01T00:00:00Z';
    const records = [
      {
        type: 'session_meta',
        timestamp: at,
        payload: { id: 'sess', cwd: directory, model_provider: 'amazon-bedrock' },
      },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'turn_context', timestamp: at, payload: { turn_id: 't1', model: 'openai.gpt-6.1-sol' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'prompt' } },
      {
        type: 'event_msg',
        timestamp: at,
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 1000, output_tokens: 10 } },
        },
      },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: 't1' } },
    ];
    fs.writeFileSync(source, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const before = fs.statSync(source);
    const fresh = sessionStatFactsOf(readCodexSession(source, 'sess'));
    assert.ok(fresh);
    assert.equal(fresh.turns[0].contextRequest?.lifetime, '30m');
    const stale = {
      ...title,
      size: before.size,
      mtimeMs: before.mtimeMs,
      stats: {
        ...fresh,
        turns: fresh.turns.map((turn) => ({ ...turn, contextRequest: { ...turn.contextRequest!, lifetime: null } })),
      },
    };
    fs.writeFileSync(cache, JSON.stringify({ version, codexMetas: [], titles: [{ file: source, entry: stale }] }));
    const loaded = loadDerivedCache(cache);
    assert.equal(loaded.titles.size, 0);
    assert.equal(loaded.reuse?.reason, 'generation-mismatch');
    const rebuilt = { ...stale, stats: sessionStatFactsOf(readCodexSession(source, 'sess')) };
    saveDerivedCache(cache, [[source, rebuilt]]);
    const persisted = loadDerivedCache(cache).titles.get(source);
    assert.equal(persisted?.stats?.turns[0].contextRequest?.lifetime, '30m');
    assert.equal(persisted?.size, before.size);
    assert.equal(persisted?.mtimeMs, before.mtimeMs);
    assert.equal(fs.statSync(source).size, before.size);
    assert.equal(fs.statSync(source).mtimeMs, before.mtimeMs);
    assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).metadataVersion, VERSION);
  }
});

test('Bedrock Astra discards literal derived generation 44 and rebuilds unchanged short-request source facts', async () => {
  const { readCodexSession } = await import('./codex.ts');
  const { sessionStatFactsOf } = await import('./transcript.ts');
  const directory = folder();
  const source = path.join(directory, 'rollout-astra.jsonl');
  const cache = path.join(directory, 'cache.json');
  fs.writeFileSync(
    source,
    bedrockAstraRecords()
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const clock = new Date('2026-10-06T20:00:00Z');
  fs.utimesSync(source, clock, clock);
  const before = fs.statSync(source);
  const fresh = sessionStatFactsOf(readCodexSession(source, 'bedrock-astra-parent'));
  assert.ok(fresh);
  const usage = fresh.turns[0].usage;
  assert.equal(usage.requests, 33);
  assert.ok(usage.input + usage.cacheRead + (usage.cacheWrite30m ?? 0) > 272_000);
  assert.equal(usage.byContextBand?.short?.requests, 33);
  const stale: DerivedTitleEntry = {
    ...title,
    size: before.size,
    mtimeMs: before.mtimeMs,
    stats: {
      ...fresh,
      turns: fresh.turns.map((turn) => ({
        ...turn,
        contextWindow: null,
        contextRequest: null,
        usage: { ...turn.usage, byContextBand: undefined },
      })),
    },
  };
  fs.writeFileSync(cache, JSON.stringify({ version: 44, codexMetas: [], titles: [{ file: source, entry: stale }] }));
  const loaded = loadDerivedCache(cache);
  assert.equal(loaded.titles.size, 0);
  assert.equal(loaded.reuse?.reason, 'generation-mismatch');
  assert.deepEqual(loaded.carriedNames.get(source), { label: title.label, fullLabel: title.fullLabel });
  const rebuilt = { ...stale, stats: sessionStatFactsOf(readCodexSession(source, 'bedrock-astra-parent')) };
  saveDerivedCache(cache, [[source, rebuilt]]);
  const persisted = loadDerivedCache(cache).titles.get(source);
  assert.equal(persisted?.stats?.turns[0].contextWindow, 258_400);
  assert.equal(persisted?.stats?.turns[0].contextRequest?.lifetime, null);
  assert.equal(persisted?.stats?.turns[0].usage.byContextBand?.short?.requests, 33);
  assert.equal(persisted?.size, before.size);
  assert.equal(persisted?.mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(source).size, before.size);
  assert.equal(fs.statSync(source).mtimeMs, before.mtimeMs);
});

test('derived cache retains global Bedrock request effort without changing pricing class', () => {
  const file = path.join(folder(), 'cache.json');
  const saved = {
    ...title,
    stats: {
      ...stats,
      turns: [
        {
          ...stats.turns[0],
          contextRequest: { ...stats.turns[0].contextRequest!, effort: 'high', bedrock: true, inferenceClass: null },
        },
      ],
    },
  };
  saveDerivedCache(file, [['/session.jsonl', saved]]);
  assert.deepEqual(loadDerivedCache(file).titles.get('/session.jsonl'), saved);
});

// These families retain different semantic dependencies across quiet-source restarts.
test('cache family admission and format fallback preserve only qualified facts', async () => {
  const root = folder();
  const current = path.join(root, 'derived-session-cache-v1.json');
  const legacy = path.join(root, 'derived-session-cache.json');
  const file = path.join(root, 'parent.jsonl');
  fs.writeFileSync(file, '{"type":"ignored","text":"' + 'x'.repeat(100000) + '"}\n');
  const scan = await scanClaudeRelationshipQuantum({ file, sessionId: 'parent' }, undefined, 32768);
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'claude',
    sessionId: 'parent',
    ...scan.cursor.evidence!.provisional,
    childTranscript: false,
    references: [],
    complete: false,
    claudeCursor: scan.cursor,
  };
  saveDerivedCache(current, [[file, title]], [[file, entry]]);
  const supported = JSON.parse(fs.readFileSync(current, 'utf8'));
  const old = { version: 63, titles: supported.titles, claudeChildReferences: supported.claudeChildReferences };
  const legacyBytes = JSON.stringify(old);
  fs.writeFileSync(legacy, legacyBytes);
  const read = (value: unknown) => {
    fs.writeFileSync(current, JSON.stringify(value));
    return loadDerivedCache(current, legacy);
  };
  const mismatch = read({ ...supported, metadataVersion: VERSION - 1 });
  assert.equal(mismatch.titles.size, 0);
  assert.equal(mismatch.carriedNames.get(file)?.label, title.label);
  assert.deepEqual(mismatch.claudeChildReferences.get(normalizeFsPath(file)), entry);
  assert.equal(read({ ...supported, titles: null }).claudeChildReferences.size, 1);
  assert.equal(read({ ...supported, claudeChildReferences: null }).titles.size, 1);
  const discovery = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    epoch: 'qualified',
    parents: [],
    catalog: [],
    repositoryRoots: [root],
    completed: [],
    position: 0,
    sequence: 1,
  };
  assert.ok(read({ ...supported, discovery }).discovery);
  const rejected = read({
    ...supported,
    discovery,
    claudeChildReferences: [{ file, entry: { ...entry, parserVersion: 25 } }],
  });
  assert.equal(rejected.titles.size, 1);
  assert.equal(rejected.claudeChildReferences.size, 0);
  assert.equal(rejected.discovery, undefined, 'a rejected relationship retained dependent discovery');
  assert.equal(read({ ...supported, discovery: { ...discovery, compatibility: undefined } }).discovery, undefined);
  assert.equal(read({ ...supported, formatVersion: 9 }).titles.size, 0);
  fs.writeFileSync(current, '{');
  assert.equal(loadDerivedCache(current, legacy).carriedNames.size, 0, 'corruption revived legacy names');
  assert.equal(loadDerivedCache(current, legacy).titles.size, 0, 'corruption revived legacy metadata');
  assert.equal(
    loadDerivedCache(current, legacy).claudeChildReferences.size,
    0,
    'corruption revived legacy relationships',
  );
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  assert.equal(loadDerivedCache(directory, legacy).titles.size, 0, 'a failed read revived legacy metadata');
  fs.unlinkSync(current);
  const imported = loadDerivedCache(current, legacy);
  assert.equal(imported.migrationPending, true);
  assert.equal(imported.claudeChildReferences.size, 1);
  assert.equal(imported.titles.size, 0, `legacy metadata 63 survived generation ${VERSION}`);
  fs.writeFileSync(legacy, JSON.stringify({ ...old, version: LEGACY_GENERATION }));
  const main64 = loadDerivedCache(current, legacy);
  assert.equal(main64.titles.size, 0, `legacy metadata ${LEGACY_GENERATION} survived generation ${VERSION}`);
  assert.equal(main64.carriedNames.size, 1);
  assert.equal(main64.claudeChildReferences.size, 1);
  fs.writeFileSync(legacy, JSON.stringify({ ...old, version: 62 }));
  assert.equal(
    loadDerivedCache(current, legacy).claudeChildReferences.size,
    0,
    'unknown legacy rows acquired compatibility',
  );
  fs.writeFileSync(legacy, legacyBytes);
  saveDerivedCache(current, [], imported.claudeChildReferences);
  assert.equal(loadDerivedCache(current, legacy).carriedNames.size, 0, 'a removed name returned beside legacy data');
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBytes);
});

test('Codex cursor eviction discards dependent discovery while retaining the source row', async () => {
  const root = folder();
  const file = path.join(root, 'partial.jsonl');
  const cache = path.join(root, 'cache.json');
  fs.writeFileSync(file, JSON.stringify({ type: 'ignored', text: 'x'.repeat(100000) }) + '\n');
  const scan = await scanCodexDispatchReferencesAsync(file, 'parent', null, 32768);
  assert.ok(scan.cursor.offset > 0 && scan.cursor.offset < fs.statSync(file).size);
  const entry: ClaudeChildReferenceCacheEntry = {
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    source: 'codex',
    sessionId: 'parent',
    ...scan.cursor.evidence!.provisional,
    childTranscript: false,
    references: [],
    complete: false,
    cursor: scan.cursor,
  };
  const discovery = {
    compatibility: discoveryCompatibility(CLAUDE_CHILD_REFERENCE_PARSER_VERSION),
    parserVersion: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
    epoch: 'evicted-cursor',
    parents: [],
    catalog: [],
    repositoryRoots: [root],
    completed: [],
    position: 1,
    sequence: 1,
  };
  const serialized = JSON.stringify(scan.cursor);
  const byteLength = Buffer.byteLength;
  const size = vi
    .spyOn(Buffer, 'byteLength')
    .mockImplementation((value, encoding) => (value === serialized ? 65 * 1024 * 1024 : byteLength(value, encoding)));
  try {
    saveDerivedCache(cache, [], [[file, entry]], [], undefined, discovery);
  } finally {
    size.mockRestore();
  }
  const loaded = loadDerivedCache(cache);
  assert.equal(loaded.claudeChildReferences.size, 1);
  assert.equal(loaded.claudeChildReferences.get(normalizeFsPath(file))?.cursor, undefined);
  assert.equal(loaded.discovery, undefined, 'an evicted partial cursor retained its scheduler');
});
