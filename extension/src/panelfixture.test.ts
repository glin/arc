// The page fixture, checked against itself.
//
// `panelfixture.ts` writes its rail and heading figures out as text, because a fixture a
// reader cannot read is not a fixture. Written text goes stale: the heading said
// `62% of 1M ctx (620k)` while every card under it said `59% of 200k ctx (118k)`, because the
// cards are built from the turns and the heading was not. Only the fixture was wrong, so no
// guard that measured the page could see it.
//
// Context is the one written figure that cannot honestly differ from the turns. Cost, turns
// and files are lifetime totals for a session the page only draws part of, so the
// fixture is free to write those larger than what the 24 cards add up to. Context is a level
// off the newest turn, and the newest turn is on the page.

import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANCHOR_HOUR,
  ANCHOR_MINUTE,
  FIXTURE_TURNS,
  NEWEST_TURN_AGE,
  RAIL_STATS,
  fixtureClock,
  nextTurnPayload,
} from './panelfixture.ts';
import { sessionStats } from './turncard.ts';
import { railBuckets } from './view/rail.ts';
import { repoTestFiles } from '../test/source-tree.ts';

function writtenContext() {
  const chip = RAIL_STATS.s1.find((one) => one.metric === 'context');
  assert.ok(chip, 'the selected session writes out no context figure');
  return chip;
}

test('the context figure the fixture writes out agrees with the session it draws', () => {
  const built = sessionStats(FIXTURE_TURNS, []).find((one) => one.metric === 'context');
  assert.ok(built, 'the fixture turns produce no context figure');
  const written = writtenContext();
  assert.equal(written.label, built.label, 'the written context figure is not what the turns produce');
  assert.equal(
    written.compactLabel,
    built.compactLabel,
    'the written compact context face is not what the turns produce',
  );
  assert.equal(written.level ?? null, built.level ?? null, 'the written context band is not what the turns produce');
});

test('each next-turn fixture carries the cost line its browser state measures', () => {
  for (const state of ['warm', 'cold', 'no-tier', 'compacted'] as const) {
    const payload = nextTurnPayload(state) as { usage: { composer: { nextTurn: unknown } } };
    assert.ok(payload.usage.composer.nextTurn, `${state} has no next-turn cost line`);
  }
});

// How far the fixture must stand clear of both local midnights. A card sits behind the clock,
// so a clock near midnight puts that card in the day before it.
const CLEARANCE = 60 * 60_000;

// The local calendar day an instant falls in, which is the day the rail files a card under.
function localDay(at: number): string {
  const on = new Date(at);
  return `${on.getFullYear()}-${on.getMonth()}-${on.getDate()}`;
}

test('the fixture clock places its cards in the local day it runs the page on', () => {
  // Every minute of one day, plus the three the rail fails on when the clock is the real one.
  // Those three are the stroke of midnight, five minutes past it, and five minutes short of
  // the next one.
  //
  // Three calendar days carry this sweep. One is of standard length. The other two are the
  // days a daylight-saving change shortens or lengthens by an hour.
  const days: Array<[number, number, number]> = [
    [2026, 8, 5],
    [2026, 2, 8],
    [2026, 10, 1],
  ];
  const times: number[] = [];
  const standings = new Set<string>();
  for (const [year, month, day] of days) {
    for (const [hour, minute, second] of [
      [0, 0, 0],
      [0, 5, 0],
      [23, 55, 0],
    ]) {
      times.push(new Date(year, month, day, hour, minute, second).getTime());
    }
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      times.push(new Date(year, month, day, 0, minute, 30).getTime());
    }
  }
  for (const at of times) {
    const when = new Date(at).toString();
    const clock = fixtureClock(at);
    const cards = clock - NEWEST_TURN_AGE;
    assert.ok(clock <= at, `the fixture clock sits in the future of ${when}`);
    assert.ok(cards <= clock - 60_000, `the newest card is under a minute behind the fixture clock at ${when}`);
    assert.equal(
      localDay(cards),
      localDay(clock),
      `the cards and the clock the page runs on fall in different local days at ${when}`,
    );
    const on = new Date(clock);
    const dayStart = new Date(on.getFullYear(), on.getMonth(), on.getDate()).getTime();
    const dayEnd = new Date(on.getFullYear(), on.getMonth(), on.getDate() + 1).getTime();
    assert.ok(
      cards - dayStart >= CLEARANCE && dayEnd - clock >= CLEARANCE,
      `the fixture sits within ${CLEARANCE / 60_000} minutes of a local midnight at ${when}`,
    );
    // The symptom itself. The browser buckets against the clock it is started on, so a card
    // the fixture placed must reach Today and not Yesterday.
    const card = { at: cards, pinnedTop: false, current: false, archived: false };
    assert.equal(
      railBuckets([card], clock).buckets[0]?.id,
      'today',
      `the rail files the newest fixture card under the wrong day at ${when}`,
    );
    standings.add(`${on.getHours()}:${on.getMinutes()}:${on.getSeconds()}.${on.getMilliseconds()}`);
  }
  // One position in the local day, whatever the minute the suite runs at. The fixture reaches
  // back more than a day. A clock that follows the real one moves the session an hour
  // behind the newest one. It swaps that card between Today and Yesterday with the hour of
  // the run.
  const standing = `${ANCHOR_HOUR}:${ANCHOR_MINUTE}:0.0`;
  assert.deepEqual(
    [...standings].sort(),
    [standing],
    'the fixture stands at a different point in the local day depending on when it is read',
  );
});

// A `--vscode-` custom property a real browser test sets by hand rather than through `themed`,
// defined above, which is the one place that carries the editor's real theme tables into a test
// page. A test that sets one directly can pass on a value no theme uses, the way a light theme
// once drew no contrast at all because nothing but a hand-set variable stood in for it.
//
// A hand-set property is allowed only where it sweeps one realistic value on a page `themed`
// has already dressed, to exercise a live update or a neutral font substitution the fixed tables
// cannot parameterize on their own. Each entry names the exact property, so a new hand-set
// variable cannot hide inside a stale allowance, and a removed sweep has to bring its entry down.
const ALLOWED_HAND_SET_THEME_VARS: Record<string, string[]> = {
  // Both sweep `--vscode-font-size` across realistic sizes on an already-`themed` page, to prove
  // the live update path a real editor font-size change takes, not to fake an untested theme.
  'extension/src/panel.layout.cards.test.ts': [
    '--vscode-font-size',
    '--vscode-font-family',
    '--vscode-editor-font-family',
  ],
  'extension/src/panel.layout.comments.test.ts': ['--vscode-font-size'],
  'extension/src/webview/composer.browser.test.ts': ['--vscode-font-size'],
};

// A real browser test drives a live page through `browserOrNone`, in `extension/test/browser.ts`.
// A test that only checks CSS source text or a fixture's theme-table constants as strings, such
// as `tones.test.ts`, never opens a page, and a `--vscode-` mention there is fixture data under
// test, not a hand-dressed page.
const BROWSER_TEST_MARKER = /browserOrNone/;

// Every mention of a `--vscode-` name, however it is spelled: a `setProperty` call, bracket
// access, an object-literal key, or a variable that only holds the name.
const VSCODE_VAR_NAME = /--vscode-[\w-]+/g;
// `var(--vscode-x)` reads an existing value from the cascade rather than setting one, so a name
// that appears only inside it does not count as a hand-set mention.
const READ_THROUGH_VAR = /var\(\s*--vscode-[\w-]+\s*\)/g;

function handSetThemeVars(source: string): string[] {
  const withoutReads = source.replace(READ_THROUGH_VAR, '');
  return [...new Set([...withoutReads.matchAll(VSCODE_VAR_NAME)].map((match) => match[0]))];
}

test('no browser test sets a --vscode- theme property by hand outside its allowance', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const files = repoTestFiles(repoRoot);
  const offenders: string[] = [];
  for (const [repoRelativePath, absolutePath] of files) {
    // This file names the exact `--vscode-` property strings the scan searches for, so its own
    // source always matches.
    if (repoRelativePath === 'extension/src/panelfixture.test.ts') continue;
    const source = fs.readFileSync(absolutePath, 'utf8');
    if (!BROWSER_TEST_MARKER.test(source)) continue;
    const allowed = new Set(ALLOWED_HAND_SET_THEME_VARS[repoRelativePath] ?? []);
    for (const name of handSetThemeVars(source)) {
      if (!allowed.has(name)) {
        offenders.push(
          `${repoRelativePath}: sets ${name} by hand. ` +
            'Dress the page with themed() from panelfixture.ts, or add a narrow named exception with a reason.',
        );
      }
    }
  }
  for (const [file, names] of Object.entries(ALLOWED_HAND_SET_THEME_VARS)) {
    const absolutePath = files.get(file);
    if (!absolutePath) {
      offenders.push(
        `${file}: has a theme-var allowance but no longer exists in the scanned lanes. ` +
          'Remove the entry from extension/src/panelfixture.test.ts.',
      );
      continue;
    }
    const found = new Set(handSetThemeVars(fs.readFileSync(absolutePath, 'utf8')));
    for (const name of names) {
      if (!found.has(name)) {
        offenders.push(
          `${file}: allows ${name} but no longer sets it. ` +
            'Remove the entry from extension/src/panelfixture.test.ts.',
        );
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
