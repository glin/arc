import { test } from 'vitest';
import assert from 'node:assert';
import {
  SessionNames,
  resolveSessionName,
  sessionLabelOf,
  transcriptIdentity,
  type SessionName,
} from './sessionnames.ts';

const name = (label: string, source: SessionName['source']): SessionName => ({ label, fullLabel: label, source });

test('a lower-ranked source never replaces a held name', () => {
  assert.deepEqual(
    resolveSessionName(name('Generated', 'generated'), name('typed', 'prompt')),
    name('Generated', 'generated'),
  );
  assert.deepEqual(
    resolveSessionName(name('Owner', 'custom'), name('Generated', 'generated')),
    name('Owner', 'custom'),
  );
  assert.deepEqual(resolveSessionName(name('Owner', 'custom'), null), name('Owner', 'custom'));
});

test('a custom name beats a newer generated one, and a later rename or title replaces its own rank', () => {
  assert.deepEqual(
    resolveSessionName(name('Generated', 'generated'), name('Owner', 'custom')),
    name('Owner', 'custom'),
  );
  const renamed = { ...name('Renamed', 'custom'), at: 20 };
  const titled = { ...name('New title', 'generated'), at: 20 };
  assert.deepEqual(resolveSessionName({ ...name('Owner', 'custom'), at: 10 }, renamed), renamed);
  assert.deepEqual(resolveSessionName({ ...name('Old title', 'generated'), at: 10 }, titled), titled);
});

test('a prompt name never changes', () => {
  assert.deepEqual(
    resolveSessionName(name('first ask', 'prompt'), name('a later ask', 'prompt')),
    name('first ask', 'prompt'),
  );
  assert.deepEqual(resolveSessionName(null, name('first ask', 'prompt')), name('first ask', 'prompt'));
});

test('within one rank the later record wins, whatever order the reads report in', () => {
  const older = { ...name('Old title', 'generated'), at: 100 };
  const newer = { ...name('New title', 'generated'), at: 900 };
  assert.deepEqual(resolveSessionName(older, newer), newer);
  assert.deepEqual(resolveSessionName(newer, older), newer);
  assert.deepEqual(
    resolveSessionName(newer, name('Unplaced title', 'generated')),
    newer,
    'a read that did not know its record offset never replaces a held name of its rank',
  );
});

test('a transcript that shrank or changed its first record drops the held name', () => {
  const names = new SessionNames();
  const owner = { ...name('Owner', 'custom'), at: 500 };
  assert.equal(names.observe('s1', owner, { size: 1000, headKey: 'a' }), true);
  assert.equal(names.observe('s1', { ...name('typed', 'prompt'), at: 0 }, { size: 1200, headKey: 'a' }), false);
  assert.deepEqual(names.get('s1'), owner);
  names.observe('s1', { ...name('another ask', 'prompt'), at: 0 }, { size: 1300, headKey: 'b' });
  assert.equal(names.get('s1')?.label, 'another ask', 'a reused session id keeps the old name');
  names.observe('s1', null, { size: 10, headKey: 'b' });
  assert.equal(names.get('s1'), null, 'a truncated transcript keeps the old name');
});

// A parse and the first metadata read of the same path happen at different moments. A name
// the parse found in the file that was there must not name the file that is there now, which
// the stored entry would then keep across a restart.
test('a name parsed from turns belongs to the transcript the turns were read from', () => {
  const names = new SessionNames();
  const turn = {
    sessionId: 's1',
    sessionTitle: 'Owner',
    sessionFullTitle: 'Owner',
    sessionTitleSource: 'custom' as const,
    sessionTitleAt: 900,
  };
  assert.deepEqual([...names.observeTurns([turn], () => ({ size: 1000 }))], ['s1']);
  assert.equal(names.get('s1')?.label, 'Owner');
  names.observe('s1', { ...name('typed', 'prompt'), at: 0 }, { size: 400, headKey: 'b' });
  assert.equal(names.get('s1')?.label, 'typed', 'a replaced transcript kept the name parsed from the file it replaced');
});

test('a read that carries no fingerprint keeps the one an earlier read of the same file left', () => {
  const names = new SessionNames();
  names.observe('s1', { ...name('Owner', 'custom'), at: 500 }, { size: 1000, headKey: 'a' });
  names.observeTurns(
    [
      {
        sessionId: 's1',
        sessionTitle: 'Owner',
        sessionFullTitle: 'Owner',
        sessionTitleSource: 'custom' as const,
        sessionTitleAt: 500,
      },
    ],
    () => ({ size: 1100 }),
  );
  names.observe('s1', { ...name('typed', 'prompt'), at: 0 }, { size: 1200, headKey: 'b' });
  assert.equal(names.get('s1')?.label, 'typed', 'a grown file with another first record kept the old name');
});

// A transcript can be replaced by one the same size or larger, which neither size tells from
// an append, and the parse of a window carries no fingerprint of the head. The file system's
// own number for the file answers on its own.
test('a transcript replaced by a larger one at the same path drops the held name', () => {
  const names = new SessionNames();
  names.observeTurns(
    [
      {
        sessionId: 's1',
        sessionTitle: 'Owner',
        sessionFullTitle: 'Owner',
        sessionTitleSource: 'custom' as const,
        sessionTitleAt: 4000,
      },
    ],
    () => ({ size: 4200, ino: 7 }),
  );
  assert.equal(names.get('s1')?.label, 'Owner');
  names.observe('s1', { ...name('Second', 'custom'), at: 150 }, { size: 8300, ino: 8 });
  assert.equal(
    names.get('s1')?.label,
    'Second',
    'a new transcript that grew past the old one kept the name of the file it replaced',
  );
});

test('a transcript that only grew keeps the name held for it', () => {
  const names = new SessionNames();
  names.observe('s1', { ...name('Owner', 'custom'), at: 500 }, { size: 1000, headKey: 'a', ino: 7 });
  names.observeTurns(
    [
      {
        sessionId: 's1',
        sessionTitle: 'Generated',
        sessionFullTitle: 'Generated',
        sessionTitleSource: 'generated' as const,
        sessionTitleAt: 1200,
      },
    ],
    () => ({ size: 1400, ino: 7 }),
  );
  assert.equal(names.get('s1')?.label, 'Owner', 'an append dropped the name the panel held');
  assert.deepEqual(
    transcriptIdentity({ size: 1400, ino: 0 }),
    { size: 1400 },
    'a host with no number for the file reported one anyway',
  );
});

test('a session no source names yet draws a placeholder with its id', () => {
  assert.deepEqual(sessionLabelOf(null, '0123456789abcdef'), {
    label: 'Session 01234567',
    fullLabel: 'Session 01234567',
  });
});
