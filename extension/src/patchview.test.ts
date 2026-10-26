// Recorded patch sides.
import { test } from 'vitest';
import assert from 'node:assert';
import { structuredPatch } from 'diff';
import { contributedFileSides, sidesFor } from './patchview.ts';
import { EditRecord } from './transcript.ts';

// Generate hunks from before and after text with the diff package.

function edit(before: string, after: string, extra: Partial<EditRecord> = {}): EditRecord {
  return {
    hunks: structuredPatch('f', 'f', before, after).hunks,
    originalFile: before,
    content: null,
    isCreate: false,
    ...extra,
  };
}

test('an edit with the file recorded beside it gives both whole files', () => {
  const before = 'one\ntwo\nthree\n';
  const after = 'one\nTWO\nthree\n';
  assert.deepEqual(sidesFor([edit(before, after)]), { before, after, source: 'recorded' });
});

test('a created file has an empty before side and its whole text after', () => {
  const record: EditRecord = { hunks: [], originalFile: null, content: 'one\ntwo\n', isCreate: true };
  assert.deepEqual(sidesFor([record]), { before: '', after: 'one\ntwo\n', source: 'recorded' });
});

test('a malformed patch without complete after text cannot produce an exact whole-file diff', () => {
  const record: EditRecord = {
    hunks: [],
    originalFile: 'old\n',
    content: null,
    isCreate: false,
    patchInvalid: true,
  };
  assert.deepEqual(sidesFor([record]), { before: '', after: '', source: 'hunks' });
});

test('complete Write content remains exact when its structured patch is malformed', () => {
  const record: EditRecord = {
    hunks: [],
    originalFile: 'old\n',
    content: 'new\n',
    isCreate: false,
    patchInvalid: true,
  };
  assert.deepEqual(sidesFor([record]), { before: 'old\n', after: 'new\n', source: 'recorded' });
});

test('an edit that removes every line leaves the after side empty', () => {
  // There is no delete result in the recorded data, so emptying a file is what a delete
  // looks like here: a real patch whose lines are all removals.
  const before = 'one\ntwo\nthree';
  const sides = sidesFor([edit(before, '')]);
  assert.equal(sides.source, 'recorded');
  assert.equal(sides.before, before);
  assert.equal(sides.after, '');
});

test('a file edited twice in one turn shows the first before side and both edits', () => {
  const start = 'one\ntwo\nthree\n';
  const middle = 'one\nTWO\nthree\n';
  const end = 'one\nTWO\nTHREE\n';
  const sides = sidesFor([edit(start, middle), edit(middle, end)]);
  assert.deepEqual(sides, { before: start, after: end, source: 'recorded' });
});

test('two ordered hunks keep their recorded old and new positions', () => {
  const beforeLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines[1] = 'changed near the start';
  afterLines[21] = 'changed near the end';
  const before = `${beforeLines.join('\n')}\n`;
  const after = `${afterLines.join('\n')}\n`;
  const record = edit(before, after);
  assert.equal(record.hunks.length, 2, 'the fixture must exercise progression between hunks');
  assert.deepEqual(sidesFor([record]), { before, after, source: 'recorded' });
});

test('a Write records the whole after side, so its content is used as it stands', () => {
  const before = 'one\ntwo\n';
  const after = 'wholly\ndifferent\ntext\n';
  // A Write over an existing file carries a patch and the after side. The recorded text
  // is what the file became, so it is taken rather than rebuilt.
  const sides = sidesFor([edit(before, after, { content: after })]);
  assert.deepEqual(sides, { before, after, source: 'recorded' });
});

test('a file with no newline at its end keeps that on both sides', () => {
  const before = 'one\ntwo';
  const after = 'one\nTWO';
  const sides = sidesFor([edit(before, after)]);
  assert.deepEqual(sides, { before, after, source: 'recorded' });
  assert.ok(!sides.before.endsWith('\n'), 'a trailing newline was invented on the before side');
  assert.ok(!sides.after.endsWith('\n'), 'a trailing newline was invented on the after side');
});

test('a shared final context line may carry the no-newline marker', () => {
  const before = 'ONE\ntwo';
  const after = 'one\ntwo';
  const record = edit(before, after);
  assert.deepEqual(record.hunks[0].lines.slice(-2), [' two', '\\ No newline at end of file']);
  assert.deepEqual(sidesFor([record]), { before, after, source: 'recorded' });
});

test('carriage returns survive both routes', () => {
  const before = 'one\r\ntwo\r\nthree\r\n';
  const after = 'one\r\nTWO\r\nthree\r\n';
  // A Write hands over the whole after side, so the file arrives byte for byte.
  assert.deepEqual(sidesFor([edit(before, after, { content: after })]), { before, after, source: 'recorded' });
  // applyPatch cannot match these carriage-return lines. The hunk fallback preserves their recorded endings.

  const fallback = sidesFor([edit(before, after)]);
  assert.equal(fallback.source, 'hunks');
  assert.ok(fallback.before.includes('two\r'), 'the before side lost its carriage returns');
  assert.ok(fallback.after.includes('TWO\r'), 'the after side lost its carriage returns');
});

test('a patch that does not fit the file recorded with it falls back to the regions', () => {
  const record = edit('one\ntwo\nthree\n', 'one\nTWO\nthree\n', { originalFile: 'nothing\nlike\nit\n' });
  const sides = sidesFor([record]);
  assert.equal(sides.source, 'hunks', 'a patch that will not apply must not produce a whole file');
  assert.equal(sides.before, '@@ -1,3 +1,3 @@\none\ntwo\nthree');
  assert.equal(sides.after, '@@ -1,3 +1,3 @@\none\nTWO\nthree');
});

test('a hunk cannot move away from its recorded position and still produce a whole-file diff', () => {
  const record: EditRecord = {
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' b', '+x'] }],
    originalFile: 'a\nb\n',
    content: null,
    isCreate: false,
  };
  assert.equal(sidesFor([record]).source, 'hunks');
});

test('an addition-only hunk outside the recorded file cannot produce a whole-file diff', () => {
  const record: EditRecord = {
    hunks: [
      {
        oldStart: Number.MAX_SAFE_INTEGER,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ['+x'],
      },
    ],
    originalFile: 'a\n',
    content: null,
    isCreate: false,
  };
  assert.equal(sidesFor([record]).source, 'hunks');
});

test('a hunk whose new position disagrees with the preceding line delta stays partial', () => {
  const record: EditRecord = {
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 2, newLines: 1, lines: ['-a', '+A'] }],
    originalFile: 'a\n',
    content: null,
    isCreate: false,
  };
  assert.equal(sidesFor([record]).source, 'hunks');
});

test('a no-newline marker cannot end a side before that side reaches the end of file', () => {
  const record: EditRecord = {
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [' a', '+x', '\\ No newline at end of file'],
      },
    ],
    originalFile: 'a\nb\nc\n',
    content: null,
    isCreate: false,
  };
  assert.equal(sidesFor([record]).source, 'hunks');
});

test('with neither the file nor its new text recorded, both sides are the changed regions', () => {
  const record = edit('one\ntwo\nthree\nfour\n', 'one\ntwo\nTHREE\nfour\n', { originalFile: null });
  const sides = sidesFor([record]);
  assert.equal(sides.source, 'hunks');
  assert.equal(sides.before, '@@ -1,4 +1,4 @@\none\ntwo\nthree\nfour');
  assert.equal(sides.after, '@@ -1,4 +1,4 @@\none\ntwo\nTHREE\nfour');
});

test('the regions of a file edited twice are shown in the order the edits arrived', () => {
  const first = edit('one\ntwo\n', 'one\nTWO\n', { originalFile: null });
  const second = edit('alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n', 'alpha\nbeta\ngamma\ndelta\nepsilon\nZETA\n', {
    originalFile: null,
  });
  const sides = sidesFor([first, second]);
  assert.equal(sides.source, 'hunks');
  assert.deepEqual(sides.before.split('\n'), [
    '@@ -1,2 +1,2 @@',
    'one',
    'two',
    '@@ -2,5 +2,5 @@',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
  ]);
  assert.deepEqual(sides.after.split('\n'), [
    '@@ -1,2 +1,2 @@',
    'one',
    'TWO',
    '@@ -2,5 +2,5 @@',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'ZETA',
  ]);
});

test('the no-newline marker is a note about the file, not a line of it', () => {
  // `\\ No newline at end of file` sits in the patch beside the line it describes. Read as
  // content it would put a stray backslash line into both sides of the diff.
  const record = edit('one\ntwo', 'one\nTWO', { originalFile: null });
  assert.ok(
    record.hunks[0].lines.some((l) => l.startsWith('\\')),
    'the fixture has no marker to drop',
  );
  const sides = sidesFor([record]);
  assert.deepEqual(sides.before.split('\n'), ['@@ -1,2 +1,2 @@', 'one', 'two']);
  assert.deepEqual(sides.after.split('\n'), ['@@ -1,2 +1,2 @@', 'one', 'TWO']);
});

test('a file with no edits recorded has two empty sides rather than throwing', () => {
  assert.deepEqual(sidesFor([]), { before: '', after: '', source: 'hunks' });
});

test('a file recorded as empty while its hunks are deep inside it is not believed', () => {
  // An empty originalFile cannot supply the lines this hunk replaces. The result must use the hunk fallback.

  const record: EditRecord = {
    hunks: [
      {
        oldStart: 74,
        oldLines: 3,
        newStart: 74,
        newLines: 3,
        lines: [' ## Steps', '-2. Open a ticket with the same report.', '+2. Send the follow-up instead.'],
      },
    ],
    originalFile: '',
    content: null,
    isCreate: false,
  };
  const sides = sidesFor([record]);
  assert.equal(sides.source, 'hunks', 'an empty original must not be taken as the whole file');
  assert.deepEqual(sides.before.split('\n'), [
    '@@ -74,3 +74,3 @@',
    '## Steps',
    '2. Open a ticket with the same report.',
  ]);
  assert.deepEqual(sides.after.split('\n'), ['@@ -74,3 +74,3 @@', '## Steps', '2. Send the follow-up instead.']);
});

// One child created the file and a later child changed it with hunks only.
const created = 'title\nfirst\nlast\n';
const changed = 'title\nfirst\nmiddle\nlast\n';
const creation = (): EditRecord => ({ ...edit('', created), originalFile: null, content: created, isCreate: true });
const laterHunks = (): EditRecord => ({ ...edit(created, changed), originalFile: null });

test('contributors in a proven order whose text agrees replay as whole files', () => {
  assert.deepEqual(
    contributedFileSides([
      { edits: [laterHunks()], startedAt: 30, endedAt: 40 },
      { edits: [creation()], startedAt: 10, endedAt: 20 },
    ]),
    { before: '', after: changed, source: 'recorded' },
  );
});

test('contributors without a proven order or with disagreeing text show changed regions only', () => {
  const overlapping = contributedFileSides([
    { edits: [creation()], startedAt: 10, endedAt: 35 },
    { edits: [laterHunks()], startedAt: 30, endedAt: 40 },
  ]);
  const unclocked = contributedFileSides([
    { edits: [creation()] },
    { edits: [laterHunks()], startedAt: 30, endedAt: 40 },
  ]);
  const disagreeing = contributedFileSides([
    { edits: [creation()], startedAt: 10, endedAt: 20 },
    { edits: [{ ...edit('other\n', 'other text\n'), originalFile: null }], startedAt: 30, endedAt: 40 },
  ]);
  // A complete later write names no starting text, so it cannot prove what the earlier contributor left.
  const blindWrite = contributedFileSides([
    { edits: [creation()], startedAt: 10, endedAt: 20 },
    { edits: [{ hunks: [], originalFile: null, content: changed, isCreate: false }], startedAt: 30, endedAt: 40 },
  ]);
  for (const sides of [overlapping, unclocked, disagreeing, blindWrite]) {
    assert.equal(sides?.source, 'hunks');
  }
  assert.ok(overlapping?.after.includes('middle'));
  assert.equal(contributedFileSides([{ edits: [] }, { edits: [] }]), null);
});
