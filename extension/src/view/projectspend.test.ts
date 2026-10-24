import { test } from 'vitest';
import assert from 'node:assert';
import {
  PROJECT_SPEND_INDEXING_HOLD_MS,
  PROJECT_SPEND_INDEXING_SHOW_MS,
  PROJECT_SPEND_WHEN,
  projectSpendFace,
  projectSpendIndexingWord,
  projectSpendRateLines,
  projectSpendWordMark,
  projectSpendWordWake,
} from './projectspend.ts';
import type { ProjectSpendWindow } from './projectspend.ts';
import { PROJECT_SPEND, PROJECT_SPEND_PEER_RATES, PROJECT_SPEND_UNDATED_RATES } from '../panelfixture.ts';
import { projectSpendWindows } from '../projectspend.ts';

const TODAY = PROJECT_SPEND.windows[0] as ProjectSpendWindow;
const SEVEN_DAYS = PROJECT_SPEND.windows[1] as ProjectSpendWindow;
const THIRTY_DAYS = PROJECT_SPEND.windows[2] as ProjectSpendWindow;

test('the Project cost face names its period without ever breaking its label', () => {
  assert.deepEqual(projectSpendFace(PROJECT_SPEND, TODAY, 'rail'), {
    label: 'Project cost',
    value: '$4.82',
    when: 'today',
    quiet: false,
  });
  assert.deepEqual(projectSpendFace(PROJECT_SPEND, SEVEN_DAYS, 'rail'), {
    label: 'Project cost',
    value: 'At least $18.24',
    when: '· 7d',
    quiet: false,
  });
  assert.deepEqual(projectSpendFace(PROJECT_SPEND, THIRTY_DAYS, 'rail'), {
    label: 'Project cost',
    value: 'At least $52.10',
    when: '· 30d',
    quiet: false,
  });
  assert.deepEqual(projectSpendFace({ ...PROJECT_SPEND, calculating: true }, SEVEN_DAYS, 'rail'), {
    label: 'Project cost',
    value: 'Calculating…',
    when: '',
    quiet: true,
  });
  assert.deepEqual(projectSpendFace({ ...PROJECT_SPEND, calculating: true }, TODAY, 'compact'), {
    label: '',
    value: 'Calculating…',
    when: '',
    quiet: true,
  });
  assert.equal(projectSpendFace(PROJECT_SPEND, TODAY, 'compact').label, '');
  assert.equal(projectSpendFace(PROJECT_SPEND, TODAY, 'rail').label, 'Project cost');

  const unknown = { ...TODAY, display: 'Cost unknown', status: 'unknown' };
  assert.deepEqual(projectSpendFace(PROJECT_SPEND, unknown, 'rail'), {
    label: 'Project cost',
    value: 'Cost unknown',
    when: 'today',
    quiet: true,
  });
  assert.equal(projectSpendFace(PROJECT_SPEND, { ...TODAY, id: 'ninetyDays' }, 'rail').when, '');
  assert.deepEqual(
    Object.keys(PROJECT_SPEND_WHEN),
    projectSpendWindows().map((window) => window.id),
  );
});
test('the Project cost rates read as one line each and not as a chain of joining words', () => {
  const on = (year: number, month: number, day: number): string =>
    new Date(year, month, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const ordered = [
    'Provider-reported, where recorded',
    `Workspace contract, effective ${on(2026, 7, 1)}`,
    `Anthropic list price, effective ${on(2026, 7, 1)}`,
  ];
  assert.deepEqual(projectSpendRateLines(PROJECT_SPEND.rateSources), ordered);
  assert.deepEqual(projectSpendRateLines([...PROJECT_SPEND.rateSources].reverse()), ordered);
  assert.doesNotMatch(projectSpendRateLines(PROJECT_SPEND.rateSources).join(' '), /list price list price/);
  assert.deepEqual(projectSpendRateLines(PROJECT_SPEND_UNDATED_RATES), [
    'Provider-reported, where recorded',
    `Workspace contract, effective ${on(2026, 7, 1)}`,
    'OpenAI list price',
  ]);
  assert.deepEqual(
    projectSpendRateLines([
      { source: 'Provider-reported cost', effectiveDate: null, provenance: 'reported' },
      { source: 'Workspace contract', effectiveDate: '2026-08-01', provenance: 'configured' },
      { source: 'Anthropic list price', effectiveDate: '2026-07-01', provenance: 'public' },
    ]),
    [
      'Provider-reported, where recorded',
      `Workspace contract, effective ${on(2026, 7, 1)}`,
      `Anthropic list price, effective ${on(2026, 6, 1)}`,
    ],
  );
  assert.notEqual(on(2025, 7, 10), on(2026, 7, 10));
  assert.deepEqual(
    projectSpendRateLines([
      { source: 'Workspace contract', effectiveDate: '2025-08-10', provenance: 'configured' },
      { source: 'Anthropic list price', effectiveDate: '2026-08-10', provenance: 'public' },
    ]),
    [`Workspace contract, effective ${on(2025, 7, 10)}`, `Anthropic list price, effective ${on(2026, 7, 10)}`],
  );
  const pair = [
    { source: 'Anthropic list price', effectiveDate: '2026-08-10', provenance: 'public' },
    { source: 'Anthropic list price', effectiveDate: null, provenance: 'public' },
  ];
  const twice = ['Anthropic list price', `Anthropic list price, effective ${on(2026, 7, 10)}`];
  assert.deepEqual(projectSpendRateLines(pair), twice);
  assert.deepEqual(projectSpendRateLines([...pair].reverse()), twice);
  const peers = ['Anthropic list price', 'OpenAI list price'];
  assert.deepEqual(projectSpendRateLines(PROJECT_SPEND_PEER_RATES), peers);
  assert.deepEqual(projectSpendRateLines([...PROJECT_SPEND_PEER_RATES].reverse()), peers);
  assert.deepEqual(
    projectSpendRateLines([
      { source: 'Workspace contract', effectiveDate: null, provenance: 'configured' },
      { source: 'Anthropic list price', effectiveDate: null, provenance: 'public' },
      { source: 'OpenAI list price', effectiveDate: null, provenance: 'public' },
    ]),
    ['Workspace contract', 'Anthropic list price', 'OpenAI list price'],
  );
  const one = (provenance: string): string =>
    projectSpendRateLines([{ source: 'Workspace contract', effectiveDate: null, provenance }])[0];
  assert.doesNotMatch(one('reported'), /[Ee]stimate/);
  assert.equal(one('reported'), 'Provider-reported, where recorded');
  assert.equal(one('configured'), 'Workspace contract');
  assert.equal(one('public'), 'Workspace contract');
  assert.deepEqual(projectSpendRateLines([]), []);
  assert.deepEqual(projectSpendRateLines(undefined), []);
});

test('the Project cost indexing word waits for a run worth reading and then holds', () => {
  const now = 1_700_000_000_000;
  assert.equal(projectSpendIndexingWord(true, now - 100, 0, now), false);
  assert.equal(projectSpendIndexingWord(true, now - (PROJECT_SPEND_INDEXING_SHOW_MS - 1), 0, now), false);
  assert.equal(projectSpendIndexingWord(true, now - PROJECT_SPEND_INDEXING_SHOW_MS, 0, now), true);
  assert.equal(projectSpendIndexingWord(true, 0, 0, now), false);
  assert.equal(projectSpendIndexingWord(false, 0, now - 100, now), true);
  assert.equal(projectSpendIndexingWord(false, 0, now - (PROJECT_SPEND_INDEXING_HOLD_MS - 1), now), true);
  assert.equal(projectSpendIndexingWord(false, 0, now - PROJECT_SPEND_INDEXING_HOLD_MS, now), false);
  assert.equal(projectSpendIndexingWord(false, 0, 0, now), false);
  assert.equal(projectSpendWordMark(true, true, now - 100, now), now);
  assert.equal(projectSpendWordMark(false, true, now - 100, now), now - 100);
  assert.equal(projectSpendWordMark(true, false, 0, now), 0);
  assert.equal(projectSpendWordMark(true, true, 0, now), now);
  let wordAt = 0;
  let shown = projectSpendIndexingWord(true, now - PROJECT_SPEND_INDEXING_SHOW_MS, wordAt, now);
  wordAt = projectSpendWordMark(true, shown, wordAt, now);
  const again = now + PROJECT_SPEND_INDEXING_HOLD_MS - 100;
  shown = projectSpendIndexingWord(true, again, wordAt, again);
  wordAt = projectSpendWordMark(true, shown, wordAt, again);
  assert.equal(projectSpendIndexingWord(true, again, wordAt, now + PROJECT_SPEND_INDEXING_HOLD_MS + 100), true);
  assert.equal(projectSpendWordWake(now - 100, 0, now), now - 100 + PROJECT_SPEND_INDEXING_SHOW_MS);
  assert.equal(projectSpendWordWake(0, now - 100, now), now - 100 + PROJECT_SPEND_INDEXING_HOLD_MS);
  assert.equal(projectSpendWordWake(0, 0, now), 0);
  assert.equal(projectSpendWordWake(0, now - PROJECT_SPEND_INDEXING_HOLD_MS, now), 0);
  assert.equal(projectSpendWordWake(now - PROJECT_SPEND_INDEXING_SHOW_MS, now, now), 0);
});
