// extension/src/turnread.test.ts
//
// The tests for turnread.ts. One that reads a second seam's names lives in turnview.test.ts
// instead, because neither file owns it. The builders a test is written against are here
// while only this file needs them, and in turnfixtures.ts once a second file does.
import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import {
  NewestTurnRecovery,
  cachedReadCanServeDiscovery,
  isTurnRead,
  matchingRetainedTail,
  newBySession,
  newCounts,
  newestPerSession,
  newestTurnDiscoveryOrder,
  retainedRangeFingerprint,
  retainedTailBytes,
  retainedTailHasNewTurn,
  retainedTurnLimit,
  retainsNewestTurnTail,
  transcriptReadCacheKey,
  turnKey,
} from './turnread.ts';
import { MB } from './turnfixtures.ts';

test('selection reuses an equivalent parsed transcript window', () => {
  const revision = { size: 8 * MB, mtimeMs: 1234 };
  const ordinary = transcriptReadCacheKey(revision, 40, 4 * MB, ['c:/repo']);
  assert.equal(transcriptReadCacheKey(revision, 40, 4 * MB, ['c:/repo']), ordinary);
  assert.notEqual(transcriptReadCacheKey({ ...revision, size: revision.size + 1 }, 40, 4 * MB, ['c:/repo']), ordinary);
  assert.notEqual(transcriptReadCacheKey(revision, 80, 4 * MB, ['c:/repo']), ordinary);
  assert.notEqual(transcriptReadCacheKey(revision, 40, 8 * MB, ['c:/repo']), ordinary);
  assert.notEqual(transcriptReadCacheKey(revision, 40, 4 * MB, ['c:/other']), ordinary);

  assert.equal(
    cachedReadCanServeDiscovery(false, 1),
    true,
    'a complete turn makes the ordinary read equivalent to a selected read',
  );
  assert.equal(
    cachedReadCanServeDiscovery(false, 0),
    false,
    'an empty ordinary read must be repeated to prepare backward discovery',
  );
  assert.equal(
    cachedReadCanServeDiscovery(true, 0),
    true,
    'an empty read already prepared for discovery has settled that work',
  );
});
test("newestPerSession keeps each session's own latest turn", () => {
  const t = (sessionId: string, startedAt: number) => ({ sessionId, startedAt });
  // The newest turn is deliberately not the first one seen, so keeping the latest and
  // keeping the first give different answers.
  const newest = newestPerSession([t('a', 100), t('b', 200), t('a', 300)]);
  assert.equal(newest.get('a'), 300);
  assert.equal(newest.get('b'), 200, 'the older session still reports its own newest turn');
  assert.equal(newestPerSession([]).size, 0);
});

test('newest-turn discovery serves selected, pinned, then active sessions', () => {
  const sessions = ['recent', 'active-a', 'pinned-a', 'selected', 'pinned-b', 'active-b'].map((sessionId) => ({
    sessionId,
  }));
  assert.deepEqual(
    newestTurnDiscoveryOrder(
      sessions,
      'selected',
      new Set(['pinned-a', 'selected', 'pinned-b', 'active-b']),
      new Set(['active-a', 'active-b']),
    ).map((session) => session.sessionId),
    ['selected', 'pinned-a', 'pinned-b', 'active-b', 'active-a'],
  );
});

test('a newest-turn tail is retained while selected, active, unread, or newly recovered', () => {
  assert.equal(retainsNewestTurnTail('selected', 'selected', false), true);
  assert.equal(retainsNewestTurnTail('running', 'other', true), true);
  assert.equal(retainsNewestTurnTail('unread', 'other', false, true), true);
  assert.equal(retainsNewestTurnTail('recovered', 'other', false, false, true), true);
  assert.equal(retainsNewestTurnTail('quiet', 'other', false), false);
});

test('a retained tail stays until its newest turn is read', () => {
  const retained = {
    identity: 'sess',
    size: 100,
    bytes: 100,
    maxTurns: 40,
    turnKeys: ['sess:100', 'sess:200'],
    fingerprint: 'same',
  };
  assert.equal(retainedTailHasNewTurn(retained, 'sess', [], new Map()), true);
  assert.equal(retainedTailHasNewTurn(retained, 'sess', ['sess:200'], new Map()), false);
  assert.equal(retainedTailHasNewTurn(retained, 'sess', [], new Map([['sess', 200]])), false);
  assert.equal(retainedTailHasNewTurn({ ...retained, turnKeys: ['wrong'] }, 'sess', [], new Map()), true);
});

test('a turn is read by its own key or by how far its session is marked', () => {
  // The one predicate, with every answer written out. Two ways in, and a card that drew one
  // and reported the other is what a second copy of this rule costs.
  const c = (sessionId: string, startedAt: number) => ({ key: `${sessionId}:${startedAt}`, sessionId, startedAt });
  const read = new Set(['a:200']);
  const readTo = new Map([['a', 500]]);
  // Its own key, whatever the watermark says.
  assert.equal(isTurnRead(c('a', 200), read, readTo), true);
  assert.equal(isTurnRead(c('b', 200), read, new Map()), false);
  // Under the watermark, with no key of its own: read, which is the whole point of it.
  assert.equal(isTurnRead(c('a', 100), new Set(), readTo), true);
  // At the watermark exactly: the mark is the newest turn the reader marked, so it is read.
  assert.equal(isTurnRead(c('a', 500), new Set(), readTo), true);
  // Over it: unread, because that turn arrived after the reader said they were caught up.
  assert.equal(isTurnRead(c('a', 501), new Set(), readTo), false);
  // A session with no watermark answers from the read set alone.
  assert.equal(isTurnRead(c('z', 100), new Set(), readTo), false);
  assert.equal(isTurnRead(c('z', 100), new Set(['z:100']), readTo), true);
  // The watermark names one session and no other: sessions do not share a mark.
  assert.equal(isTurnRead(c('b', 100), new Set(), readTo), false);
});

test('a session marked read counts nothing new, and counts a turn that came after', () => {
  const c = (sessionId: string, startedAt: number, kind = 'turn') => ({
    key: `${sessionId}:${startedAt}`,
    sessionId,
    startedAt,
    kind,
  });
  // The session as it stood when the reader marked it read: its newest turn was still
  // running, so the mark gave it a watermark and a key for every turn but that one.
  const drawn = [c('a', 300), c('a', 200)];
  const keys = ['a:200'];
  const readTo = new Map([['a', 300]]);
  assert.equal(newBySession(drawn, keys, readTo).get('a'), 0);
  assert.equal(
    newBySession(drawn, keys, new Map()).get('a'),
    1,
    'the read set alone already answers 0 here, so this fixture cannot see the watermark',
  );
  // A deeper read then brings in an older turn nobody ever marked. The watermark covers it
  // and the count holds at nothing new, which is what the reader was told when they marked
  // the session.
  const deeper = [...drawn, c('a', 100)];
  assert.equal(newBySession(deeper, keys, readTo).get('a'), 0);
  assert.equal(newBySession(deeper, keys, new Map()).get('a'), 1);
  // A turn that started after the mark is new, which is the half a watermark must not eat.
  const later = [...deeper, c('a', 400)];
  assert.equal(newBySession(later, keys, readTo).get('a'), 1);
  // With no keys at all the watermark still answers, so a session whose keys the cap
  // dropped does not come back unread.
  assert.equal(newBySession(deeper, [], readTo).get('a'), 0);
  // And it names one session: another session keeps counting its own turns.
  const both = [...deeper, c('b', 50)];
  assert.equal(newBySession(both, [], readTo).get('b'), 1);
  assert.equal(newBySession(both, [], readTo).get('a'), 0);
});

// The rail lists every session in the workspace and the panel parses a handful, so
// nearly every card had no count and could draw no unread mark: with the default of three
// parsed, 26 of this workspace's 29 sessions were silent whatever was waiting in them.
// That is the bug the reader reported as the mark appearing only once they clicked in.
test('a workspace opened for the first time is not handed every turn it already holds', () => {
  // The reader did not fail to read what an agent did in a project before they installed
  // this. They were not being offered it. So the moment the panel is first drawn is a floor,
  // and everything under it counts as read.
  //
  // Held on the counts rather than on the predicate alone, because the count is what the
  // reader meets: a rail saying 400 new in a project they have just opened is the failure,
  // and it reaches that figure through here.
  const none = new Map<string, number>();
  const window = (starts: number[], whole = true) => ({ starts, whole });
  const SINCE = 1_000;
  const old = [100, 200, 300];
  const fresh = [1_100, 1_200];
  const card = (sessionId: string, startedAt: number) => ({
    key: turnKey({ sessionId, startedAt }),
    sessionId,
    startedAt,
    kind: 'turn',
  });

  // A session that ran entirely before the floor: nothing new, on the parsed path and
  // on the glanced one both.
  const before = old.map((at) => card('a', at));
  assert.deepEqual(newCounts(before, new Map(), [], none, SINCE).get('a'), { count: 0, atLeast: false });
  assert.deepEqual(newCounts([], new Map([['a', window(old)]]), [], none, SINCE).get('a'), {
    count: 0,
    atLeast: false,
  });
  // And the same session with no floor is every turn new, which is what it did before.
  assert.deepEqual(newCounts(before, new Map(), [], none).get('a'), { count: 3, atLeast: false });

  // A session with turns either side counts only the ones after the floor. This is the
  // whole point: a project the reader opens and then works in is new from that moment on.
  const both = [...old, ...fresh].map((at) => card('b', at));
  assert.deepEqual(newCounts(both, new Map(), [], none, SINCE).get('b'), { count: 2, atLeast: false });
  assert.deepEqual(newCounts([], new Map([['b', window([...old, ...fresh])]]), [], none, SINCE).get('b'), {
    count: 2,
    atLeast: false,
  });

  // The floor answers for every session at once, which is why it is a floor and not a
  // watermark each: the rail lists sessions the panel has never parsed.
  const many = new Map([
    ['c', window(old)],
    ['d', window(old)],
    ['e', window(fresh)],
  ]);
  assert.deepEqual(newCounts([], many, [], none, SINCE).get('c'), { count: 0, atLeast: false });
  assert.deepEqual(newCounts([], many, [], none, SINCE).get('d'), { count: 0, atLeast: false });
  assert.deepEqual(newCounts([], many, [], none, SINCE).get('e'), { count: 2, atLeast: false });

  // A session the reader marked unread keeps its own answer over the floor. Its
  // watermark is zero, which is what that press writes, and every turn in it is new again.
  const put = new Map([['a', 0]]);
  assert.deepEqual(newCounts(before, new Map(), [], put, SINCE).get('a'), { count: 3, atLeast: false });

  // A turn started before the floor and read since is still read, and reading it changes no
  // count: the floor and the read set answer the same way and neither counts twice.
  const readKey = [turnKey({ sessionId: 'a', startedAt: 300 })];
  assert.deepEqual(newCounts(before, new Map(), readKey, none, SINCE).get('a'), { count: 0, atLeast: false });
});

test('a turn is new when it is unread and newer than the newest read turn of its session', () => {
  const c = (sessionId: string, startedAt: number, kind = 'turn') => ({
    key: `${sessionId}:${startedAt}`,
    sessionId,
    startedAt,
    kind,
  });
  const cards = [c('a', 300), c('a', 200), c('a', 100)];
  const none = new Map<string, number>();
  // Nothing read: nothing in the session has been seen, so every turn is new.
  assert.equal(newBySession(cards, [], none).get('a'), 3);
  // The newest turn read: the reader has seen past everything, middle turns included.
  assert.equal(newBySession(cards, ['a:300'], none).get('a'), 0);
  // A middle turn read: only what came after it is new; the older unread one was passed by.
  assert.equal(newBySession(cards, ['a:200'], none).get('a'), 1);
  // Two sessions are counted apart: reading all of one leaves the other's count alone.
  const two = [...cards, c('b', 250), c('b', 150)];
  const counts = newBySession(two, ['a:300', 'a:200', 'a:100'], none);
  assert.equal(counts.get('a'), 0);
  assert.equal(counts.get('b'), 2);
  // A compaction is neither read nor counted, and alone it earns its session no entry:
  // an entry says the count is knowable, and there are no turns to know it from.
  const withCompaction = [...cards, c('a', 250, 'compaction'), c('z', 50, 'compaction')];
  assert.equal(newBySession(withCompaction, ['a:300'], none).get('a'), 0);
  assert.equal(newBySession(withCompaction, [], none).has('z'), false);
  // A parsed session with every turn read keeps its entry, at zero: that answer is known,
  // where a session with no cards at all has none.
  assert.equal(newBySession(cards, ['a:300', 'a:200', 'a:100'], none).has('a'), true);
  assert.equal(newBySession(cards, [], none).has('missing'), false);
});

test('a retained tail keeps its beginning fixed while the selected transcript grows', () => {
  const retained = {
    identity: 'one',
    size: 100 * MB,
    bytes: 32 * MB,
    maxTurns: 40,
    turnKeys: ['old'],
    fingerprint: 'same',
  };
  assert.equal(retainedTailBytes(4 * MB, 100 * MB), 4 * MB);
  assert.equal(retainedTailBytes(4 * MB, 101 * MB, retained), 33 * MB);
  assert.equal(
    retainedTailBytes(40 * MB, 101 * MB, retained),
    40 * MB,
    'an explicit deeper read was discarded in favour of the smaller retained window',
  );
  assert.equal(
    retainedTailBytes(4 * MB, 90 * MB, retained),
    4 * MB,
    'a truncated transcript kept byte positions from the old file',
  );
  assert.equal(
    matchingRetainedTail('two', 101 * MB, 'same', retained),
    undefined,
    'a replacement session kept state from the old file',
  );
});

test('running-turn recovery survives completion until the current revision is retained', () => {
  const recovery = new NewestTurnRecovery();
  const running = { file: 'rollout.jsonl', sessionId: 'codex' };
  recovery.remember(running);

  // Completion changes the file revision and removes running status. Neither a cancelled read
  // of the old revision nor a stale result releases this identity, so the quiet session remains
  // in the discovery order for a read of the current revision.
  const completed = { ...running, size: 101, mtimeMs: 2 };
  assert.deepEqual(newestTurnDiscoveryOrder([completed], null, new Set(), recovery.sessionIds([completed])), [
    completed,
  ]);
  assert.equal(recovery.has(completed), true);

  recovery.release(completed);
  assert.deepEqual(
    recovery.sessionIds([completed]),
    new Set(),
    'a current retained range did not return the quiet session to the bounded tail',
  );

  recovery.remember(running);
  recovery.retainOnly([{ file: running.file, sessionId: 'replacement' }]);
  assert.equal(
    recovery.has(running),
    false,
    'a replacement transcript inherited recovery state from the previous session',
  );
});

test('a same-session file replacement resets retained state while an append keeps it', () => {
  const dir = tempDir('retained-tail-');
  const file = path.join(dir, 'rollout.jsonl');
  const original = Buffer.alloc(128 * 1024, 'a');
  fs.writeFileSync(file, original);
  const size = fs.statSync(file).size;
  const fingerprint = retainedRangeFingerprint(file, 0, size);
  assert.ok(fingerprint);
  const retained = { identity: 'same-session', size, bytes: size, maxTurns: 3, turnKeys: ['old'], fingerprint };

  fs.appendFileSync(file, 'appended turn\n');
  assert.equal(
    matchingRetainedTail('same-session', fs.statSync(file).size, retainedRangeFingerprint(file, 0, size), retained),
    retained,
  );

  const replacement = Buffer.alloc(size + 32, 'a');
  replacement.fill('b', 16 * 1024, 20 * 1024);
  fs.writeFileSync(file, replacement);
  const replacedSize = fs.statSync(file).size;
  assert.ok(replacedSize >= size, 'the fixture no longer covers an equal-or-larger replacement');
  assert.equal(
    matchingRetainedTail('same-session', replacedSize, retainedRangeFingerprint(file, 0, size), retained),
    undefined,
  );
});

test('a retained turn limit makes room for new turns without dropping ones already shown', () => {
  const retained = {
    identity: 'one',
    size: 100,
    bytes: 32,
    maxTurns: 3,
    turnKeys: ['a', 'b', 'c'],
    fingerprint: 'same',
  };
  assert.equal(retainedTurnLimit(3, ['new', 'a', 'b'], retained), 4);
  assert.equal(
    retainedTurnLimit(3, ['newer', 'new', 'a', 'b'], retained),
    4,
    'a repeated parse grew once for the same missing retained turn',
  );
  assert.equal(retainedTurnLimit(6, ['new', 'a', 'b'], retained), 7, 'a deeper setting was not kept as the floor');
  assert.equal(retainedTurnLimit(3, ['a', 'b', 'c'], retained), 3);
  assert.equal(retainedTurnLimit(3, ['a', 'b'], undefined), 3);
});

test('a session nobody parsed still says how much is new in it', () => {
  const none = new Map<string, number>();
  const window = (starts: number[], whole = true) => ({ starts, whole });

  // Nothing parsed at all, and a window that reached the start of the file: an exact count,
  // over the same rule a parsed session's count goes through.
  const counts = newCounts([], new Map([['a', window([100, 200, 300])]]), [], none);
  assert.deepEqual(counts.get('a'), { count: 3, atLeast: false });

  // A turn read while the session was parsed stays read once it is only glanced at.
  // The window's starts are keyed by `turnKey`, the same spelling the read set holds, and a
  // second spelling here would count turns the reader has already read.
  const read = [turnKey({ sessionId: 'a', startedAt: 300 })];
  assert.deepEqual(newCounts([], new Map([['a', window([100, 200, 300])]]), read, none).get('a'), {
    count: 0,
    atLeast: false,
  });

  // Three different answers, and the rail draws each differently.
  //
  // A session whose every turn is older than its watermark reports zero, not silence.
  const readTo = new Map([['a', 300]]);
  assert.deepEqual(newCounts([], new Map([['a', window([100, 200, 300])]]), [], readTo).get('a'), {
    count: 0,
    atLeast: false,
  });
  // A session whose window found no turn reports silence, not zero: the window cannot
  // support a claim that there is nothing new.
  assert.equal(newCounts([], new Map([['b', window([])]]), [], none).has('b'), false);
  // A session nobody has glanced at yet reports silence too, and is simply absent.
  assert.equal(newCounts([], new Map(), [], none).has('c'), false);

  // A parsed session keeps its real count and is never routed through its window. The
  // window here would say two and the parse says one, and the parse is the answer.
  const parsed = [{ key: turnKey({ sessionId: 'd', startedAt: 900 }), sessionId: 'd', startedAt: 900, kind: 'turn' }];
  assert.deepEqual(newCounts(parsed, new Map([['d', window([700, 900])]]), [], none).get('d'), {
    count: 1,
    atLeast: false,
  });
});
