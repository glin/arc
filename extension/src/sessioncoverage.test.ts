import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  sessionPresence,
  sessionCoverageMember,
  reconcileSessionCollisions,
  type SessionCollisionObservation,
  type SessionCoverage,
} from './sessioncoverage';
import { sessionPageSources } from './sessionreads';
import type { SessionFile } from './transcript';

const context = { domain: 'admitted' as const, scope: 'repository', revision: 'accepted' };
const source: SessionFile = {
  agent: 'claude',
  sessionId: 'retained',
  file: 'C:/sources/retained.jsonl',
  size: 1,
  mtimeMs: 1,
  dev: 1,
  ino: 2,
};
const fact = (status: SessionCoverage['status'] = 'complete'): SessionCoverage => ({
  ...context,
  status,
  files: [],
  uncertain: [],
  members: new Set(),
});

test('absence requires the matching domain scope and accepted revision', () => {
  const complete = fact();
  assert.equal(sessionPresence(complete, context, { sessionId: 'missing' }), 'absent');
  for (const field of ['domain', 'scope', 'revision'] as const) {
    assert.equal(sessionPresence({ ...complete, [field]: 'other' }, context, { sessionId: 'missing' }), 'unknown');
  }
  for (const domain of ['published', 'relationships', 'classification', 'selected', 'accounting', 'durable'] as const) {
    assert.equal(sessionPresence({ ...complete, domain }, { ...context, domain }, { sessionId: 'missing' }), 'unknown');
  }
  for (const status of ['incomplete', 'unavailable'] as const) {
    assert.equal(sessionPresence(fact(status), context, { sessionId: 'missing' }), 'unknown');
  }
});

test('retained sources and colliding identities remain unknown until current membership qualifies', () => {
  const complete = fact();
  assert.equal(sessionPresence(complete, context, { sessionId: source.sessionId }, [source]), 'unknown');
  complete.members = new Set([sessionCoverageMember(source)]);
  assert.equal(sessionPresence(complete, context, { sessionId: source.sessionId }, [source]), 'present');
  for (const collision of [
    { ...source, ino: 3 },
    { ...source, file: 'C:/sources/duplicate.jsonl' },
    { ...source, agent: 'codex' as const },
  ]) {
    assert.equal(sessionPresence(complete, context, { sessionId: source.sessionId }, [source, collision]), 'unknown');
  }
  assert.equal(sessionPresence(complete, context, { sessionId: source.sessionId }, [{ ...source, ino: 0 }]), 'unknown');
});

test('physical absence is local to completely visited paths', () => {
  const physical = { domain: 'physical' as const, scope: context.scope, revision: context.revision };
  const coverage: SessionCoverage = {
    ...physical,
    status: 'incomplete',
    files: ['C:/sources/known.jsonl'],
    uncertain: ['C:/sources/Unread'],
  };
  assert.equal(sessionPresence(coverage, physical, { file: 'c:/sources/unread/retained.jsonl' }), 'unknown');
  assert.equal(sessionPresence(coverage, physical, { file: 'C:/sources/known.jsonl' }), 'present');
  assert.equal(
    sessionPresence({ ...coverage, uncertain: ['C:/sources/known.jsonl'] }, physical, {
      file: 'C:/sources/known.jsonl',
    }),
    'unknown',
  );
  assert.equal(sessionPresence(coverage, physical, { file: 'C:/sources/read/missing.jsonl' }), 'absent');
  assert.equal(
    sessionPresence({ ...coverage, status: 'complete', uncertain: [] }, physical, {
      file: 'C:/sources/Unread/retained.jsonl',
    }),
    'absent',
  );
});

test('a completed supported traversal retains child paths outside its visited directories', () => {
  const context = { domain: 'physical' as const, scope: 'repository', revision: 'accepted' };
  const coverage: SessionCoverage = {
    ...context,
    root: 'C:/sources',
    directories: ['C:/sources/project'],
    status: 'complete',
    files: [],
    uncertain: [],
  };
  const child = { file: 'C:/sources/project/parent/subagents/retained.jsonl' };
  assert.equal(sessionPresence(coverage, context, child), 'unknown');
  assert.equal(sessionPresence(coverage, context, { file: 'C:/sources/project/missing.jsonl' }), 'absent');
  assert.equal(sessionPresence(coverage, context, { file: 'D:/elsewhere/missing.jsonl' }), 'unknown');
  assert.equal(sessionPresence({ ...coverage, missingRoot: true }, context, child), 'absent');
});

test('collision release requires current scope coverage and the complete listed revision', () => {
  const physical = { ...context, domain: 'physical' as const };
  const competitor = { ...source, file: 'C:/sources/competitor.jsonl', ino: 3 };
  const enumeration = {
    claude: { status: 'complete' as const, files: [source.file], directories: ['C:/sources'], uncertain: [] },
    codex: { status: 'complete' as const, files: [], uncertain: [] },
  };
  const previous = { scope: context.scope, sources: [source, competitor] };
  const current = sessionPageSources([source]);
  const observation = { ...physical, source, excluded: false };
  for (const invalid of [
    { ...observation, scope: 'other' },
    { ...observation, revision: 'other' },
    { ...observation, source: { ...source, size: source.size + 1 } },
    { ...observation, source: { ...source, mtimeMs: source.mtimeMs + 1 } },
    { ...observation, source: { ...source, ino: 4 } },
    { ...observation, source: { ...source, sessionId: 'other' } },
  ]) {
    assert.ok(reconcileSessionCollisions(current, previous, physical, enumeration, [invalid]).sources.length);
  }
  assert.deepEqual(reconcileSessionCollisions(current, previous, physical, enumeration, [observation]).sources, []);
  assert.ok(reconcileSessionCollisions(current, previous, physical, enumeration, []).sources.length);
});

test('hidden Codex collision evidence reserves current identity without a displayed row', () => {
  const physical = { ...context, domain: 'physical' as const };
  const competitor = { ...source, agent: 'codex' as const, file: 'C:/sources/competitor.jsonl', ino: 3 };
  const replacement = { ...competitor, sessionId: 'replacement', ino: 4 };
  const enumeration = {
    claude: { status: 'complete' as const, files: [source.file], directories: ['C:/sources'], uncertain: [] },
    codex: { status: 'complete' as const, files: [competitor.file], directories: ['C:/sources'], uncertain: [] },
  };
  const previous = { scope: context.scope, sources: [source, competitor] };
  const survivor = { ...physical, source, excluded: false };
  const hidden: SessionCollisionObservation = { ...physical, source: replacement, excluded: false, hidden: true };
  const current = sessionPageSources([source]);
  const result = reconcileSessionCollisions(current, previous, physical, enumeration, [survivor, hidden]);
  assert.deepEqual(result.sources, []);
  for (const invalid of [
    { ...hidden, scope: 'other' },
    { ...hidden, revision: 'other' },
    { ...hidden, source: { ...replacement, agent: 'claude' as const } },
    { ...hidden, source: { ...replacement, agent: 'unsupported' } } as unknown as SessionCollisionObservation,
    { ...hidden, source: { ...replacement, ino: 0 } },
    { ...hidden, source: { ...replacement, dev: -1 } },
    { ...hidden, source: { ...replacement, size: -1 } },
    { ...hidden, source: { ...replacement, size: 0.5 } },
    { ...hidden, source: { ...replacement, size: NaN } },
    { ...hidden, source: { ...replacement, mtimeMs: NaN } },
    { ...hidden, source: { ...replacement, mtimeMs: -1 } },
    { ...hidden, hidden: false },
  ]) {
    const denied = reconcileSessionCollisions(current, previous, physical, enumeration, [survivor, invalid]);
    assert.ok(denied.sources.some((entry) => entry.sessionId === source.sessionId));
  }
  assert.ok(
    reconcileSessionCollisions(
      current,
      previous,
      physical,
      { ...enumeration, codex: { ...enumeration.codex, status: 'unavailable', files: [] } },
      [survivor, hidden],
    ).sources.some((entry) => entry.sessionId === source.sessionId),
  );
  assert.ok(
    reconcileSessionCollisions(
      sessionPageSources([source, { ...replacement, ino: 5 }]),
      previous,
      physical,
      enumeration,
      [survivor, hidden],
    ).sources.some((entry) => entry.sessionId === source.sessionId),
  );
  const sameId = { ...hidden, source: { ...replacement, sessionId: source.sessionId } };
  assert.equal(
    reconcileSessionCollisions(current, previous, physical, enumeration, [survivor, sameId]).sources.length,
    2,
  );
  const third = { ...source, sessionId: replacement.sessionId, file: 'C:/sources/third.jsonl', ino: 5 };
  const newCollision = reconcileSessionCollisions(
    sessionPageSources([source, third]),
    previous,
    physical,
    { ...enumeration, claude: { ...enumeration.claude, files: [source.file, third.file] } },
    [survivor, hidden],
  );
  assert.deepEqual(
    newCollision.sources.map((entry) => entry.sessionId),
    ['replacement', 'replacement'],
  );
  assert.ok(
    reconcileSessionCollisions(current, previous, physical, enumeration, [hidden]).sources.some(
      (entry) => entry.sessionId === source.sessionId,
    ),
    'hidden evidence released an unqualified displayed survivor',
  );
});
