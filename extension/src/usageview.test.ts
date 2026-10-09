import { test } from 'vitest';
import assert from 'node:assert';
import {
  AgentUsage,
  SpendReading,
  UsageBook,
  UsageResetTimer,
  UsageWriteQueue,
  WindowReading,
  MAX_USAGE_RESET_DELAY_MS,
  USAGE_FRESH_MS,
  USAGE_AGENT_ORDER,
  agentsWithNewTurns,
  foldUsage,
  limitReading,
  moneyWord,
  nextMonthStartUtc,
  resetWord,
  usageBar,
  windowWord,
} from './usageview';
import { CONTEXT_BANDS } from './turnview';
import { RateLimit } from './agentwire';

// A fixed local afternoon, built out of the parts rather than parsed, so the clock wording
// below is the same on a machine in any time zone. It is a Friday.
const NOW = new Date(2026, 7, 28, 14, 32, 0).getTime();
const seconds = (at: number): number => Math.round(at / 1000);
const inHours = (h: number): number => seconds(NOW + h * 3600_000);
const at = (...parts: [number, number, number, number, number]): number =>
  seconds(new Date(parts[0], parts[1], parts[2], parts[3], parts[4], 0).getTime());

function limit(over: Partial<RateLimit> = {}): RateLimit {
  return {
    window: 'five_hour',
    utilization: 0.31,
    resetsAtSeconds: inHours(3),
    status: '',
    group: '',
    scope: '',
    ...over,
  };
}

function reading(over: Partial<WindowReading> = {}): WindowReading {
  return { ...limit(), readAt: NOW, ...over };
}

function spendReading(over: Partial<SpendReading> = {}): SpendReading {
  return {
    usedMinor: 187519,
    limitMinor: 200000,
    exponent: 2,
    currency: 'USD',
    utilization: 187519 / 200000,
    readAt: NOW,
    ...over,
  };
}

function usage(over: Partial<AgentUsage> = {}): AgentUsage {
  return {
    agent: 'claude',
    plan: 'max',
    windows: [reading()],
    ...over,
    spend: over.spend ?? null,
    creditResetsAtSeconds: over.creditResetsAtSeconds ?? null,
    checkedAt: over.checkedAt ?? NOW,
  };
}

// Claude fixture windows include session, weekly, and model-scoped limits in a different order from their display order.

const CLAUDE = usage({
  agent: 'claude',
  plan: 'max',
  windows: [
    reading({ window: 'weekly_all', group: 'weekly', utilization: 0.07, resetsAtSeconds: at(2026, 7, 30, 16, 0) }),
    reading({
      window: 'weekly_scoped',
      group: 'weekly',
      scope: 'Fable',
      utilization: 0.02,
      resetsAtSeconds: at(2026, 7, 30, 16, 0),
    }),
    reading({ window: 'session', group: 'session', utilization: 0.1, resetsAtSeconds: at(2026, 7, 28, 19, 0) }),
  ],
});

// The Codex fixture names its account windows by duration.

const CODEX = usage({
  agent: 'codex',
  plan: 'plus',
  windows: [
    reading({ window: 'five_hour', group: 'session', utilization: 0.38, resetsAtSeconds: at(2026, 7, 28, 17, 44) }),
    reading({ window: 'seven_day', group: 'weekly', utilization: 0.1, resetsAtSeconds: at(2026, 8, 1, 9, 0) }),
  ],
});

test('fresh Codex and twelve-hour-old Claude expose distinct ages until Claude admits a reading', () => {
  const claude = usage({ windows: [reading({ readAt: NOW - 12 * 3600_000 })] });
  const codex = usage({ agent: 'codex' });
  const bar = usageBar([claude, codex], NOW)!;
  assert.equal(bar.age, 'updated 12h ago');
  assert.equal(bar.groups[0].age, 'updated 12h ago');
  assert.equal(bar.groups[1].age, 'updated just now');
  assert.ok(bar.groups[0].exact);
  assert.notEqual(bar.groups[0].exact, bar.groups[1].exact);
  const book = new UsageBook([claude, codex]);
  book.note('claude', {
    plan: 'max',
    limits: [limit()],
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt: NOW,
  });
  assert.equal(book.bar(NOW)?.age, '');
  assert.equal(book.bar(NOW)?.groups[0].age, 'updated just now');
});

test('usage progress survives absent or expired figures and retains retry after mixed outcomes', () => {
  const refresh: import('./view/usage').UsageRefresh = {
    id: 7,
    agents: { claude: { phase: 'waiting', detail: '' }, codex: { phase: 'success', detail: '' } },
  };
  for (const readings of [[], [usage({ windows: [reading({ resetsAtSeconds: seconds(NOW - 1) })] })]]) {
    const bar = usageBar(readings, NOW, refresh)!;
    assert.equal(bar.groups.length, 2);
    assert.equal(bar.briefs.length, 0);
    assert.equal(bar.age, '');
    assert.equal(bar.groups[0].age, '');
    assert.equal(bar.groups[0].exact, '');
    assert.equal(bar.refresh?.busy, true);
    assert.equal(bar.refresh?.announcement, '');
    assert.match(bar.refresh!.name, /Claude: Waiting.*Codex: Usage read/);
    refresh.agents.claude = { phase: 'failed', detail: 'Read again to retry.' };
    const terminal = usageBar(readings, NOW, refresh)!;
    assert.equal(terminal.refresh?.busy, false);
    assert.equal(terminal.read, 'Read again');
    assert.match(terminal.refresh!.announcement, /Claude.*failed.*Codex.*read/);
    refresh.agents.claude = { phase: 'waiting', detail: '' };
  }
});

// These limits supply window names without explicit groups.

const UNGROUPED = usage({
  windows: [
    reading({ window: 'seven_day', utilization: 0.07, resetsAtSeconds: at(2026, 7, 30, 16, 0) }),
    reading({ window: 'five_hour', utilization: 0.1, resetsAtSeconds: at(2026, 7, 28, 19, 0) }),
  ],
});

test('the opened list gives each agent its plan and every limit it reported', () => {
  const bar = usageBar([CODEX, CLAUDE], NOW);
  assert.ok(bar);
  assert.deepEqual(
    bar.groups.map((g) => g.agent),
    ['claude', 'codex'],
  );
  assert.deepEqual(
    bar.groups.map((g) => g.label),
    ['Claude', 'Codex'],
  );
  assert.deepEqual(
    bar.groups.map((g) => g.plan),
    ['Max plan', 'plus plan'],
  );
  assert.deepEqual(
    bar.groups.map((g) => g.lines.length),
    [3, 2],
  );
});

test('an agent that named no plan says nothing where the plan goes', () => {
  const bar = usageBar([usage({ plan: '' })], NOW);
  assert.equal(bar?.groups[0].plan, '', 'a plan nobody reported was invented for the heading');
});

test('Claude Max reads as Max plan, with no tier multiplier beside it', () => {
  const bar = usageBar([usage({ plan: 'max' })], NOW);
  assert.equal(bar?.groups[0].plan, 'Max plan');
});

test('Codex capitalizes Pro and leaves opaque plan names as reported', () => {
  const lite = usageBar([usage({ agent: 'codex', plan: 'prolite' })], NOW);
  const pro = usageBar([usage({ agent: 'codex', plan: 'pro' })], NOW);
  assert.equal(lite?.groups[0].plan, 'prolite plan');
  assert.equal(pro?.groups[0].plan, 'Pro plan');
});

test('a partial mid-turn reading keeps the plan name the complete one carried', () => {
  const complete = { plan: 'max', limits: [limit()], complete: true, spend: null, readAt: NOW };
  const first = foldUsage(null, 'claude', complete);
  const partial = foldUsage(first, 'claude', limitReading(limit(), NOW + 1));
  assert.equal(first.plan, 'max');
  assert.equal(partial.plan, 'max', 'a mid-turn event that names no plan dropped the name');
});

test('the opened list reads the session, then the week, then the models a limit was scoped to', () => {
  // Session limits precede weekly limits on both status surfaces.

  const bar = usageBar([CLAUDE, CODEX], NOW);
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['5h', '7d', 'Fable'],
  );
  assert.deepEqual(
    bar?.groups[1].lines.map((l) => l.label),
    ['5h', '7d'],
  );
});

test('an agent that named no groups is read by its window names instead', () => {
  // Window names supply grouping and duration when no explicit group is present.

  const bar = usageBar([UNGROUPED], NOW);
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['5h', '7d'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((f) => f.unit),
    ['5h', '7d'],
  );
});

test('a limit whose window states its own length is named by that rather than by its clock', () => {
  // A session limit running on some other clock must not be called five hours. Codex names
  // every window for its own length, so the length it reported is the length drawn.
  const bar = usageBar(
    [
      usage({
        windows: [reading({ window: '600_minute', group: 'session', utilization: 0.2 })],
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['10h'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((f) => f.unit),
    ['10h'],
  );
});

test('a limit on a clock the panel has no word for is drawn under its own name, after the week', () => {
  const bar = usageBar(
    [
      usage({
        windows: [
          reading({ window: '30_minute', utilization: 0.5, resetsAtSeconds: inHours(0.4) }),
          reading({ window: 'five_hour', utilization: 0.1 }),
          reading({ window: 'seven_day', utilization: 0.2, resetsAtSeconds: inHours(70) }),
        ],
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['5h', '7d', '30m'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((f) => f.unit),
    ['5h', '7d', '30m'],
  );
});

test('each line is the figure, its width and when it resets', () => {
  const week = usageBar([CLAUDE], NOW)?.groups[0].lines[1];
  assert.equal(week?.percent, 7);
  assert.equal(week?.fill, 7);
  assert.equal(week?.resets, 'resets in 2d');
  assert.equal(week?.resetsExact, 'Sunday 4:00 PM, 30 August');
  assert.equal(week?.level, null, 'a fourteenth of a limit is below the first caution band');
  assert.equal(usageBar([CODEX], NOW)?.groups[0].lines[0].resets, 'resets in 3h');
});

test('an agent whose only reading is a cap draws one figure and one line', () => {
  const bar = usageBar([usage({ plan: 'enterprise', windows: [], spend: spendReading() })], NOW);
  assert.ok(bar);
  const reset = resetWord(Date.UTC(2026, 8, 1) / 1000, NOW);
  const expectedReset = { resets: reset.resets, resetsExact: `expected ${reset.resetsExact}` };
  assert.deepEqual(
    bar.briefs.map((brief) => brief.figures.map((figure) => `${figure.percent}% ${figure.unit}`)),
    [['94% credits']],
  );
  assert.equal(bar.groups.length, 1);
  assert.equal(bar.groups[0].lines.length, 1);
  assert.deepEqual(bar.groups[0].lines[0], {
    key: 'claude:spend',
    label: 'credits',
    percent: 94,
    fill: 94,
    level: 'nearlyFull',
    resets: expectedReset.resets,
    resetsExact: expectedReset.resetsExact,
    detail: '$1,875.19 of $2,000.00',
    name: `credits, 94% used, ${expectedReset.resets}, ${expectedReset.resetsExact}, $1,875.19 of $2,000.00`,
  });
  assert.equal(bar.briefs[0].name, 'Claude, 94% of the credit cap');
});

test('a live overage window supplies the credit reset instead of drawing a second bar', () => {
  const bar = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [
          reading({
            window: 'overage',
            utilization: 0.99,
            resetsAtSeconds: inHours(0.5),
            status: 'allowed_warning',
            source: 'event',
          }),
        ],
        spend: spendReading({
          usedMinor: 198241,
          utilization: 198241 / 200000,
        }),
      }),
    ],
    NOW,
  );
  assert.ok(bar);
  assert.deepEqual(
    bar.briefs[0].figures.map((figure) => `${figure.percent}% ${figure.unit}`),
    ['99% credits'],
  );
  assert.equal(bar.groups[0].lines.length, 1);
  assert.deepEqual(bar.groups[0].lines[0], {
    key: 'claude:spend',
    label: 'credits',
    percent: 99,
    fill: 99,
    level: 'nearlyFull',
    resets: 'resets in 30m',
    resetsExact: 'Friday 3:02 PM, 28 August',
    detail: '$1,982.41 of $2,000.00',
    name: 'credits, 99% used, resets in 30m, Friday 3:02 PM, 28 August, $1,982.41 of $2,000.00',
  });
  assert.ok(!bar.groups[0].lines[0].resetsExact.includes('expected'));
  assert.ok(!bar.name.includes('overage'));
});

test('the live credit clock follows the overage window and precedes the expected boundary', () => {
  const creditReset = inHours(2);
  const fromEvent = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [reading({ window: 'five_hour', source: 'event' })],
        spend: spendReading(),
        creditResetsAtSeconds: creditReset,
      }),
    ],
    NOW,
  );
  assert.equal(fromEvent?.groups[0].lines[1].resetsExact, resetWord(creditReset, NOW).resetsExact);

  const fromWindow = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [reading({ window: 'overage', resetsAtSeconds: inHours(1), source: 'event' })],
        spend: spendReading(),
        creditResetsAtSeconds: creditReset,
      }),
    ],
    NOW,
  );
  assert.equal(fromWindow?.groups[0].lines[0].resetsExact, resetWord(inHours(1), NOW).resetsExact);

  const expected = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [],
        spend: spendReading(),
        creditResetsAtSeconds: seconds(NOW - 1),
      }),
    ],
    NOW,
  );
  assert.equal(
    expected?.groups[0].lines[0].resetsExact,
    `expected ${resetWord(nextMonthStartUtc(NOW), NOW).resetsExact}`,
  );
});

test('a credit reset over a year away leaves the expected monthly boundary', () => {
  const bar = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [],
        spend: spendReading(),
        creditResetsAtSeconds: seconds(NOW + 366 * 24 * 3600_000),
      }),
    ],
    NOW,
  );
  assert.equal(bar?.groups[0].lines[0].resetsExact, `expected ${resetWord(nextMonthStartUtc(NOW), NOW).resetsExact}`);

  const overage = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [reading({ window: 'overage', resetsAtSeconds: seconds(NOW + 366 * 24 * 3600_000) })],
        spend: spendReading(),
      }),
    ],
    NOW,
  );
  assert.equal(
    overage?.groups[0].lines[0].resetsExact,
    `expected ${resetWord(nextMonthStartUtc(NOW), NOW).resetsExact}`,
  );
});

test('an expired overage window leaves the expected monthly reset on the credits row', () => {
  const bar = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [
          reading({
            window: 'overage',
            resetsAtSeconds: seconds(NOW - 1),
            source: 'event',
          }),
        ],
        spend: spendReading(),
      }),
    ],
    NOW,
  );
  assert.ok(bar);
  const reset = resetWord(Date.UTC(2026, 8, 1) / 1000, NOW);
  assert.equal(bar.groups[0].lines[0].resetsExact, `expected ${reset.resetsExact}`);
});

test('a live overage window draws the credits row before the spend answer arrives', () => {
  const bar = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [
          reading({
            window: 'overage',
            utilization: 0.99,
            resetsAtSeconds: inHours(0.5),
            source: 'event',
          }),
        ],
        spend: null,
      }),
    ],
    NOW,
  );
  assert.ok(bar);
  assert.deepEqual(
    bar.groups[0].lines.map((line) => line.label),
    ['credits'],
  );
  assert.equal(bar.groups[0].lines[0].key, 'claude:spend');
  assert.equal(bar.groups[0].lines[0].resets, 'resets in 30m');
  assert.equal(bar.groups[0].lines[0].detail, '');
  assert.deepEqual(
    bar.briefs[0].figures.map((figure) => figure.unit),
    ['credits'],
  );
  assert.ok(!bar.name.includes('overage'));
});

// The weekly bucket for one model, as a live event reports it. The window name and the
// clock arrive, and no model at all.
const MODEL_BUCKET = reading({
  window: 'seven_day_overage_included',
  group: 'weekly-overage',
  utilization: 0.42,
  resetsAtSeconds: inHours(48),
  source: 'event',
});

test('the weekly bucket for one model draws no row of its own', () => {
  // The event names no model, so the panel has no name for the row and draws none.
  const bar = usageBar([{ ...CLAUDE, windows: [...CLAUDE.windows, MODEL_BUCKET] }], NOW);
  assert.ok(bar);
  assert.deepEqual(
    bar.groups[0].lines.map((line) => line.label),
    ['5h', '7d', 'Fable'],
  );
  assert.deepEqual(
    bar.briefs[0].figures.map((figure) => figure.unit),
    ['5h', '7d'],
  );
  assert.ok(!bar.name.includes('extra'));
});

test('the same window scoped to a model keeps its row, under the model name', () => {
  // The drop is about the missing model and not about the window. A limit that arrives with
  // a model has a name to draw, so it is drawn.
  const bar = usageBar([usage({ windows: [{ ...MODEL_BUCKET, scope: 'Fable' }] })], NOW);
  assert.deepEqual(
    bar?.groups[0].lines.map((line) => line.label),
    ['Fable'],
  );
});

test('an agent whose only window is that bucket draws no bar at all', () => {
  // The window is dropped before the bar decides whether it has anything to draw. The agent
  // takes no empty group and no name on the collapsed line.
  assert.equal(usageBar([usage({ windows: [MODEL_BUCKET] })], NOW), null);
});

test('the credit cap is still drawn beside that bucket', () => {
  const bar = usageBar(
    [
      usage({
        plan: 'enterprise',
        windows: [MODEL_BUCKET],
        spend: spendReading(),
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((line) => line.label),
    ['credits'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((figure) => figure.unit),
    ['credits'],
  );
});

test('money amounts use the reported currency and fixed grouping', () => {
  assert.equal(moneyWord(187519, 2, 'USD'), '$1,875.19');
  assert.equal(moneyWord(187519, 2, 'CHF'), 'CHF 1,875.19');
  assert.equal(moneyWord(200000, 2, 'USD'), '$2,000.00');
});

test('a figure is rounded to nearest, with 100% kept for a limit with nothing left', () => {
  const percentOf = (utilization: number): number | undefined =>
    usageBar([usage({ windows: [reading({ utilization })] })], NOW)?.groups[0].lines[0].percent;
  const fillOf = (utilization: number): number | undefined =>
    usageBar([usage({ windows: [reading({ utilization })] })], NOW)?.groups[0].lines[0].fill;
  // Round the usage and context figures consistently.

  assert.equal(percentOf(0.4989), 50);
  assert.equal(percentOf(0.004), 1, 'a limit that has been touched reads as untouched');
  assert.equal(percentOf(0.999), 99);
  assert.equal(percentOf(1), 100);
  // Neither end can leave the bar: a share past one, which either CLI is free to report
  // when a limit is overrun, would otherwise draw a bar wider than its own track.
  assert.equal(fillOf(1.4), 100);
  assert.equal(fillOf(-0.2), 0);
  assert.equal(
    usageBar([usage({ windows: [reading({ utilization: 0.999 })] })], NOW)?.briefs[0].figures[0].percent,
    99,
  );
});

test('the bar takes the context chip’s bands, at the context chip’s thresholds', () => {
  // Usage levels use the shared CONTEXT_BANDS thresholds.

  const drawn = (utilization: number) => usageBar([usage({ windows: [reading({ utilization })] })], NOW);
  for (const band of CONTEXT_BANDS) {
    assert.equal(
      drawn(band.at)?.groups[0].lines[0].level,
      band.level,
      `${band.at} should be drawn in the ${band.level} band`,
    );
    assert.equal(
      drawn(band.at)?.briefs[0].figures[0].level,
      band.level,
      `${band.at} took the ${band.level} band on the list but not on the collapsed line`,
    );
    assert.notEqual(
      drawn(band.at - 0.01)?.groups[0].lines[0].level,
      band.level,
      `${band.at - 0.01} is below ${band.level} and took its tone anyway`,
    );
  }
  // And below the first band there is no tone at all, the same as every other quiet figure
  // on the panel.
  assert.equal(drawn(0.49)?.groups[0].lines[0].level, null);
});

test('the collapsed line carries the session first, the week after it, and no bars at all', () => {
  const bar = usageBar([CLAUDE, CODEX], NOW);
  assert.deepEqual(
    bar?.briefs.map((b) => b.figures.map((f) => `${f.percent}%${f.unit}`)),
    [
      ['10%5h', '7%7d'],
      ['38%5h', '10%7d'],
    ],
  );
  // Collapsed figures carry a caution level without a bar fill width.

  const figure = bar?.briefs[0].figures[0];
  assert.ok(figure && !('fill' in figure), 'a collapsed figure carries a width for a bar that is not drawn');
});

test('a limit scoped to one model stays off the collapsed line', () => {
  const bar = usageBar([CLAUDE], NOW);
  assert.equal(bar?.groups[0].lines.length, 3);
  assert.equal(bar?.briefs[0].figures.length, 2, 'the scoped limit took a place on the one collapsed line');
  assert.ok(!bar?.briefs[0].name.includes('Fable'), 'the collapsed line named a model it does not draw');
});

test('an agent whose only live limit is scoped keeps its group and leaves the line alone', () => {
  const bar = usageBar(
    [
      usage({
        windows: [
          reading({ window: 'weekly_all', group: 'weekly', resetsAtSeconds: inHours(-1) }),
          reading({ window: 'session', group: 'session', resetsAtSeconds: inHours(-1) }),
          reading({ window: 'weekly_scoped', group: 'weekly', scope: 'Fable', utilization: 0.02 }),
        ],
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['Fable'],
  );
  assert.deepEqual(bar?.briefs, [], 'an agent with nothing to say collapsed put its name there anyway');
  assert.equal(bar?.name, 'Press to show every limit.');
});

test('one model with a limit on both clocks keeps a line and a key for each', () => {
  // Distinct clock keys preserve both model-scoped limit rows across redraws.

  const bar = usageBar(
    [
      usage({
        windows: [
          reading({ window: 'five_hour', group: 'session', utilization: 0.04 }),
          reading({
            window: 'weekly_scoped',
            group: 'weekly',
            scope: 'Fable',
            utilization: 0.02,
            resetsAtSeconds: at(2026, 8, 2, 13, 0),
          }),
          reading({ window: 'session', group: 'session', scope: 'Fable', utilization: 0.09 }),
        ],
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['5h', 'Fable', 'Fable'],
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.key),
    ['claude:session:', 'claude:weekly:Fable', 'claude:session:Fable'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((f) => f.percent),
    [4],
  );
});

test('a limit that has already rolled over is drawn nowhere', () => {
  // Expired limits appear on neither usage surface.

  const bar = usageBar(
    [
      usage({
        windows: [
          reading({ window: 'seven_day', utilization: 0.93, resetsAtSeconds: inHours(-1), readAt: NOW - 90_000_000 }),
          reading({ window: 'five_hour', utilization: 0.31 }),
        ],
      }),
    ],
    NOW,
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((l) => l.label),
    ['5h'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((f) => f.percent),
    [31],
  );
  assert.ok(!bar?.name.includes('93'), 'a figure for a period that has ended was announced anyway');
});

test('an agent whose every limit has rolled over is left off the bar entirely', () => {
  const bar = usageBar(
    [usage({ windows: [reading({ resetsAtSeconds: inHours(-1), readAt: NOW - 90_000_000 })] }), CODEX],
    NOW,
  );
  assert.deepEqual(
    bar?.groups.map((g) => g.agent),
    ['codex'],
  );
  assert.deepEqual(
    bar?.briefs.map((b) => b.agent),
    ['codex'],
  );
});

test('there is no bar at all when no agent has a live limit', () => {
  assert.equal(usageBar([usage({ windows: [reading({ resetsAtSeconds: inHours(-1) })] })], NOW), null);
  assert.equal(usageBar([usage({ windows: [] })], NOW), null);
  assert.equal(usageBar([], NOW), null);
});

test('a limit with no reset time says nothing about when it resets', () => {
  const bar = usageBar([usage({ windows: [reading({ resetsAtSeconds: null })] })], NOW);
  assert.equal(bar?.groups[0].lines[0].resets, '');
  assert.equal(bar?.groups[0].lines[0].resetsExact, '', 'a moment was written out for a reset the agent never named');
  assert.ok(
    !bar?.groups[0].lines[0].name.includes('resets'),
    'a reset time nobody reported was invented for the line’s name',
  );
});

test('every line is found again by its own key after a repaint', () => {
  assert.deepEqual(
    usageBar([CLAUDE], NOW)?.groups[0].lines.map((l) => l.key),
    ['claude:session:', 'claude:weekly:', 'claude:weekly:Fable'],
  );
  // Equivalent window names retain the same keys across source changes.

  assert.deepEqual(
    usageBar([UNGROUPED], NOW)?.groups[0].lines.map((l) => l.key),
    ['claude:session:', 'claude:weekly:'],
  );
});

test('a figure that has aged says when it was read, and a fresh one does not', () => {
  const aged = (ms: number) => usageBar([usage({ windows: [reading({ readAt: NOW - ms })] })], NOW);
  assert.equal(aged(USAGE_FRESH_MS)?.age, '', 'a figure still inside the fresh window put an age on itself');
  assert.equal(aged(USAGE_FRESH_MS + 1000)?.age, 'updated 2m ago');
  // One bar, one age: the oldest figure prevents a newer one from making every fact sound fresh.
  const mixed = usageBar(
    [
      usage({
        windows: [
          reading({ window: 'seven_day', resetsAtSeconds: inHours(70), readAt: NOW - 600_000 }),
          reading({ window: 'five_hour', readAt: NOW - 300_000 }),
        ],
      }),
    ],
    NOW,
  );
  assert.equal(mixed?.age, 'updated 10m ago');
});

test('the age is read in the same units as a reset, in the largest one that fits', () => {
  // Usage ages and reset durations use the same compact units.

  const aged = (ms: number) => usageBar([usage({ windows: [reading({ readAt: NOW - ms })] })], NOW)?.age;
  assert.equal(aged(USAGE_FRESH_MS + 1000), 'updated 2m ago');
  assert.equal(aged(4 * 3600_000), 'updated 4h ago');
  assert.equal(aged(50 * 3600_000), 'updated 2d ago');
  // And rounded down, the way a reset is: a figure a minute short of three hours old is two
  // hours old, never three.
  assert.equal(aged(3 * 3600_000 - 60_000), 'updated 2h ago');
});

test('the age on the line and the age on the control are one wording', () => {
  // The status line and control share the reading's age wording.

  for (const ms of [USAGE_FRESH_MS + 1000, 600_000, 4 * 3600_000, 50 * 3600_000]) {
    const bar = usageBar([usage({ windows: [reading({ readAt: NOW - ms })] })], NOW);
    assert.ok(bar?.read.startsWith(`${bar.age} ·`), `the line says "${bar?.age}" and the control says "${bar?.read}"`);
  }
});

test('the control that reads again always says so, and says how old the figure is', () => {
  const read = (ms: number) => usageBar([usage({ windows: [reading({ readAt: NOW - ms })] })], NOW)?.read;
  assert.equal(read(0), 'updated just now · press to read again');
  assert.equal(read(USAGE_FRESH_MS), 'updated just now · press to read again');
  assert.equal(read(240_000), 'updated 4m ago · press to read again');
});

test('the bar is announced by every figure on the collapsed line, and by what the press does', () => {
  // Colour is what tells a caution band from a quiet figure, and a reader listening to the
  // bar gets none of it, so every figure has to be in the name.
  assert.equal(
    usageBar([CLAUDE, CODEX], NOW)?.name,
    'Claude, 10% of the session, 7% of the week. ' +
      'Codex, 38% of the session, 10% of the week. Press to show every limit.',
  );
  assert.equal(usageBar([CLAUDE], NOW)?.briefs[0].name, 'Claude, 10% of the session, 7% of the week');
});

test('an aged bar says its age out loud, and the moment behind it', () => {
  // The accessible name carries the reading time as well as its relative age.

  const bar = usageBar([usage({ windows: [reading({ readAt: NOW - 600_000 })] })], NOW);
  assert.ok(bar?.name.includes('updated 10m ago, 2:22 PM'), `the age is drawn and never said: ${bar?.name}`);
});

test('each line is announced by its label, its figure and both wordings of its reset', () => {
  // The hover is the one place the exact moment is drawn, and a reader listening to the line
  // reaches no hover, so the name carries it as well as the duration.
  const lines = usageBar([CLAUDE], NOW)?.groups[0].lines ?? [];
  assert.equal(lines[0].name, '5h, 10% used, resets in 4h, Friday 7:00 PM, 28 August');
  assert.equal(lines[2].name, 'Fable, 2% used, resets in 2d, Sunday 4:00 PM, 30 August');
  assert.ok(lines.every((line) => !line.resetsExact.includes('expected')));
});

test('the expected month boundary rolls from December into the next year', () => {
  assert.equal(nextMonthStartUtc(Date.UTC(2026, 11, 15, 12)), Date.UTC(2027, 0, 1) / 1000);
});

test('a reset is worded as how long is left, in the largest unit that fits', () => {
  assert.equal(resetWord(inHours(0.75), NOW).resets, 'resets in 45m');
  assert.equal(resetWord(inHours(3), NOW).resets, 'resets in 3h');
  assert.equal(resetWord(inHours(70), NOW).resets, 'resets in 2d');
  assert.equal(resetWord(null, NOW).resets, '');
});

test('a reset is rounded down, so the time it names is time the reader has', () => {
  // A minute short of five hours is four hours left. Rounding up would promise time that is
  // not there.
  assert.equal(resetWord(inHours(5) - 60, NOW).resets, 'resets in 4h');
  assert.equal(resetWord(inHours(1), NOW).resets, 'resets in 1h');
  assert.equal(resetWord(inHours(1) - 60, NOW).resets, 'resets in 59m');
  assert.equal(resetWord(inHours(24), NOW).resets, 'resets in 1d');
  assert.equal(resetWord(inHours(24) - 60, NOW).resets, 'resets in 23h');
});

test('a reset about to happen is said in words rather than as no time at all', () => {
  assert.equal(resetWord(seconds(NOW + 59_000), NOW).resets, 'resets in less than a minute');
  assert.equal(resetWord(seconds(NOW + 60_000), NOW).resets, 'resets in 1m');
});

test('the exact moment carries the weekday, the clock and the date, and never a duration', () => {
  // A duration says how long is left and cannot be written into a calendar, so the hover
  // carries the moment itself.
  assert.equal(resetWord(at(2026, 8, 4, 16, 0), NOW).resetsExact, 'Friday 4:00 PM, 4 September');
  assert.equal(resetWord(inHours(3), NOW).resetsExact, 'Friday 5:32 PM, 28 August');
});

test('a reset the agent never named leaves both wordings empty together', () => {
  assert.deepEqual(resetWord(null, NOW), { resets: '', resetsExact: '' });
});

test('a window is named by how long its clock runs, whatever the wire called it', () => {
  assert.equal(windowWord('five_hour'), '5h');
  assert.equal(windowWord('seven_day'), '7d');
  // Unknown numeric window durations retain their formatted duration.

  assert.equal(windowWord('30_minute'), '30m');
  assert.equal(windowWord('60_minute'), '1h');
  assert.equal(windowWord('1440_minute'), '1d');
  assert.equal(windowWord('4320_minute'), '3d');
  // A length that rounds up to a full day of hours is a day, not 24 hours.
  assert.equal(windowWord('1439_minute'), '1d');
  assert.equal(windowWord('1410_minute'), '1d');
  assert.equal(windowWord('1409_minute'), '23h');
  assert.equal(windowWord('rolling_month'), 'rolling month');
  // A name that would find something on the prototype instead of in the table.
  assert.equal(windowWord('constructor'), 'constructor');
});

test('a reading of one limit leaves the others alone', () => {
  // Partial events replace only their named limit.

  const full = foldUsage(null, 'claude', {
    plan: 'max',
    readAt: NOW - 600_000,
    complete: true,
    spend: null,
    limits: [
      limit({ window: 'five_hour', utilization: 0.31 }),
      limit({ window: 'seven_day', utilization: 0.93, resetsAtSeconds: inHours(70) }),
    ],
  });
  const later = foldUsage(full, 'claude', limitReading(limit({ window: 'five_hour', utilization: 0.44 }), NOW));
  assert.equal(later.windows.length, 2, 'the untouched limit was dropped');
  const byName = new Map(later.windows.map((w) => [w.window, w]));
  assert.equal(byName.get('five_hour')?.utilization, 0.44);
  assert.equal(byName.get('five_hour')?.readAt, NOW, 'the replaced limit kept the old reading time');
  assert.equal(byName.get('seven_day')?.utilization, 0.93);
  assert.equal(byName.get('seven_day')?.readAt, NOW - 600_000, 'the untouched limit took a reading time it never had');
  // A partial event without a plan retains the existing plan.

  assert.equal(later.plan, 'max');
});

test('two limits on one clock are kept apart by the model each is scoped to', () => {
  const folded = foldUsage(null, 'claude', {
    plan: 'max',
    readAt: NOW,
    complete: true,
    spend: null,
    limits: [
      limit({ window: 'weekly_all', group: 'weekly', utilization: 0.07 }),
      limit({ window: 'weekly_scoped', group: 'weekly', scope: 'Fable', utilization: 0.02 }),
    ],
  });
  assert.equal(folded.windows.length, 2, 'the scoped weekly limit and the one over every model folded into one');
});

test('one clock an agent named two ways is folded into one limit', () => {
  // Equivalent window names fold into one limit.

  const full = foldUsage(null, 'claude', {
    plan: 'max',
    readAt: NOW - 600_000,
    complete: true,
    spend: null,
    limits: [limit({ window: 'session', group: 'session', utilization: 0.1 })],
  });
  const later = foldUsage(
    full,
    'claude',
    limitReading(limit({ window: 'five_hour', group: 'session', utilization: 0.44 }), NOW),
  );
  assert.equal(later.windows.length, 1);
  assert.equal(later.windows[0].utilization, 0.44);
});

test('a mid-turn limit keeps the cap, and a full reading replaces it', () => {
  const first = foldUsage(null, 'claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading({ readAt: NOW - 600_000 }),
    readAt: NOW - 600_000,
  });
  const withWindow = foldUsage(first, 'claude', limitReading(limit(), NOW));
  assert.equal(withWindow.spend?.usedMinor, 187519);
  assert.equal(withWindow.spend?.readAt, NOW - 600_000);

  const replacement = spendReading({ usedMinor: 190000, utilization: 0.95 });
  const newer = foldUsage(withWindow, 'claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: replacement,
    readAt: NOW,
  });
  assert.equal(newer.spend?.usedMinor, 190000);
  assert.equal(newer.spend?.readAt, NOW);
});

test('a complete account reading keeps the credit clock from a live event', () => {
  const reset = inHours(2);
  const event = foldUsage(null, 'claude', limitReading(limit(), NOW, reset));
  const account = foldUsage(event, 'claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading(),
    creditResetsAtSeconds: null,
    readAt: NOW + 1,
  });
  assert.equal(account.creditResetsAtSeconds, reset);
});

test('a complete reading with no cap clears the one previously held', () => {
  const first = foldUsage(null, 'claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading(),
    readAt: NOW,
  });
  const cleared = foldUsage(first, 'claude', {
    plan: 'max',
    limits: [limit()],
    complete: true,
    spend: null,
    readAt: NOW + 1,
  });
  assert.equal(cleared.spend, null);
  assert.equal(cleared.checkedAt, NOW + 1);
});

test('a complete cap-only reading clears account windows but keeps a live event window', () => {
  const max = foldUsage(null, 'claude', {
    plan: 'max',
    limits: [limit({ window: 'five_hour' }), limit({ window: 'seven_day', resetsAtSeconds: inHours(70) })],
    complete: true,
    spend: null,
    readAt: NOW,
  });
  const live = foldUsage(
    max,
    'claude',
    limitReading(limit({ window: 'five_hour', utilization: 0.44, resetsAtSeconds: inHours(4) }), NOW + 1),
  );
  const enterprise = foldUsage(live, 'claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading(),
    readAt: NOW + 2,
  });
  assert.deepEqual(
    enterprise.windows.map((window) => ({
      window: window.window,
      utilization: window.utilization,
      resetsAtSeconds: window.resetsAtSeconds,
    })),
    [
      {
        window: 'five_hour',
        utilization: 0.44,
        resetsAtSeconds: inHours(4),
      },
    ],
  );
  assert.equal(enterprise.spend?.usedMinor, 187519);
});

test('a complete account read removes an unmatched unscoped live window', () => {
  const account = foldUsage(null, 'codex', {
    plan: 'pro',
    limits: [limit({ window: 'seven_day', group: 'weekly', utilization: 0.3, resetsAtSeconds: inHours(70) })],
    complete: true,
    spend: null,
    readAt: NOW - 600_000,
  });
  const corrupted = foldUsage(
    account,
    'codex',
    limitReading(
      limit({ window: 'five_hour', group: 'session', utilization: 0, resetsAtSeconds: inHours(4) }),
      NOW - 300_000,
    ),
  );
  const repaired = foldUsage(corrupted, 'codex', {
    plan: 'pro',
    limits: [limit({ window: 'seven_day', group: 'weekly', utilization: 0.31, resetsAtSeconds: inHours(70) })],
    complete: true,
    spend: null,
    readAt: NOW,
  });

  assert.deepEqual(
    repaired.windows.map((window) => [window.group, window.scope, window.utilization]),
    [['weekly', '', 0.31]],
  );
  assert.deepEqual(
    usageBar([repaired], NOW)?.briefs[0].figures.map((figure) => [figure.percent, figure.unit]),
    [[31, '7d']],
  );
});

test('named Codex live buckets stay scoped after an account refresh but stay out of the usage bar', () => {
  const account = foldUsage(null, 'codex', {
    plan: 'pro',
    limits: [limit({ window: 'seven_day', group: 'weekly', utilization: 0.31, resetsAtSeconds: inHours(70) })],
    complete: true,
    spend: null,
    readAt: NOW - 1,
  });
  const spark = foldUsage(
    account,
    'codex',
    limitReading(
      limit({
        window: 'five_hour',
        group: 'session',
        scope: 'GPT-5.3-Codex-Spark',
        utilization: 0,
        resetsAtSeconds: inHours(4),
      }),
      NOW,
    ),
  );
  const sparkOnBothClocks = foldUsage(
    spark,
    'codex',
    limitReading(
      limit({
        window: 'seven_day',
        group: 'weekly',
        scope: 'GPT-5.3-Codex-Spark',
        utilization: 0.08,
        resetsAtSeconds: inHours(70),
      }),
      NOW + 1,
    ),
  );
  const refreshed = foldUsage(sparkOnBothClocks, 'codex', {
    plan: 'pro',
    limits: [limit({ window: 'seven_day', group: 'weekly', utilization: 0.31, resetsAtSeconds: inHours(70) })],
    complete: true,
    spend: null,
    readAt: NOW + 1,
  });
  const bar = usageBar([refreshed], NOW + 1);

  assert.deepEqual(refreshed.windows.map((window) => `${window.window}:${window.scope}`).sort(), [
    'five_hour:GPT-5.3-Codex-Spark',
    'seven_day:',
    'seven_day:GPT-5.3-Codex-Spark',
  ]);
  assert.deepEqual(
    bar?.briefs[0].figures.map((figure) => [figure.percent, figure.unit]),
    [[31, '7d']],
  );
  assert.deepEqual(
    bar?.groups[0].lines.map((line) => [line.label, line.percent]),
    [['7d', 31]],
  );
  assert.ok(!bar?.groups[0].lines.some((line) => line.label === 'GPT-5.3-Codex-Spark'));
});

test('the cap reads last after every rate window', () => {
  const bar = usageBar([usage({ ...CLAUDE, spend: spendReading() })], NOW);
  assert.deepEqual(
    bar?.groups[0].lines.map((line) => line.label),
    ['5h', '7d', 'Fable', 'credits'],
  );
  assert.deepEqual(
    bar?.briefs[0].figures.map((figure) => figure.unit),
    ['5h', '7d', 'credits'],
  );
});

test('the bar draws every agent the folder uses, in the offered order', () => {
  // Show usage for every agent with folder readings, independently of the selected session.

  const bar = usageBar([CODEX, CLAUDE], NOW);
  assert.deepEqual(
    bar?.briefs.map((b) => b.agent),
    ['claude', 'codex'],
  );
  assert.deepEqual(
    bar?.groups.map((g) => g.agent),
    ['claude', 'codex'],
  );
  // An agent without a reading adds no usage group.
  assert.deepEqual(
    usageBar([CLAUDE], NOW)?.groups.map((g) => g.agent),
    ['claude'],
  );
});

test('the book records complete and live readings before it folds them', () => {
  const recorded: { agent: string; complete: boolean }[] = [];
  const book = new UsageBook([], (agent, value) => recorded.push({ agent, complete: value.complete }));
  book.note('claude', { plan: 'max', limits: [limit()], complete: true, spend: null, readAt: NOW });
  book.noteLimit('codex', limit(), NOW + 1);
  assert.deepEqual(recorded, [
    { agent: 'claude', complete: true },
    { agent: 'codex', complete: false },
  ]);
});

test('recorder callback failures preserve current complete and live figures and persistence values', () => {
  const book = new UsageBook([], () => {
    throw new Error('history unavailable');
  });
  book.noteSilent('claude');
  assert.doesNotThrow(() =>
    book.note('claude', { plan: 'max', limits: [limit()], complete: true, spend: null, readAt: NOW }),
  );
  assert.doesNotThrow(() => book.noteLimit('codex', limit(), NOW + 1));
  assert.equal(book.usages().length, 2);
  assert.equal(book.usages()[0].checkedAt, NOW);
  assert.equal(book.bar(NOW)?.groups.length, 2);
  assert.deepEqual(book.toAsk(['claude'], NOW, false), []);
});

test('a refresh asks only for what has gone stale, and a press asks for everything', () => {
  const book = new UsageBook();
  // Nothing read yet: both are worth asking.
  assert.deepEqual(book.toAsk(USAGE_AGENT_ORDER, NOW, false), ['claude', 'codex']);
  book.note('claude', { plan: 'max', limits: [limit()], complete: true, spend: null, readAt: NOW });
  assert.deepEqual(
    book.toAsk(USAGE_AGENT_ORDER, NOW, false),
    ['codex'],
    'a figure read this instant was asked for again, which is a process start for nothing',
  );
  assert.deepEqual(book.toAsk(USAGE_AGENT_ORDER, NOW + USAGE_FRESH_MS + 1, false), ['claude', 'codex']);
  // The press means now, whatever is on screen.
  assert.deepEqual(book.toAsk(USAGE_AGENT_ORDER, NOW, true), ['claude', 'codex']);
});

test('a fresh cap alone prevents another read until it ages', () => {
  const book = new UsageBook();
  book.note('claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading(),
    readAt: NOW,
  });
  assert.deepEqual(book.toAsk(['claude'], NOW, false), []);
  assert.deepEqual(book.toAsk(['claude'], NOW + USAGE_FRESH_MS + 1, false), ['claude']);
});

test('an idle cap repaints at the month boundary before its reset wording expires', () => {
  const book = new UsageBook([
    usage({
      plan: 'enterprise',
      windows: [],
      spend: spendReading(),
      checkedAt: NOW,
    }),
  ]);
  const boundary = nextMonthStartUtc(NOW);
  const before = book.bar(NOW)?.groups[0].lines[0];
  assert.ok(before);
  assert.equal(book.nextReset(NOW), boundary);
  const after = book.bar(boundary * 1000 + 1)?.groups[0].lines[0];
  assert.ok(after);
  assert.notEqual(after.resetsExact, before.resetsExact);
  assert.equal(book.nextReset(boundary * 1000 + 1), nextMonthStartUtc(boundary * 1000 + 1));
});

test('a fresh live event does not hide that the complete account reading is stale', () => {
  const book = new UsageBook();
  book.note('claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading({ readAt: NOW - 600_000 }),
    readAt: NOW - 600_000,
  });
  book.noteLimit('claude', limit({ utilization: 0.44, resetsAtSeconds: inHours(4) }), NOW);
  assert.deepEqual(book.toAsk(['claude'], NOW, false), ['claude']);
});

test('the bar age describes the oldest figure it displays', () => {
  const book = new UsageBook();
  book.note('claude', {
    plan: 'enterprise',
    limits: [],
    complete: true,
    spend: spendReading({ readAt: NOW - 600_000 }),
    readAt: NOW - 600_000,
  });
  book.noteLimit('claude', limit({ utilization: 0.44, resetsAtSeconds: inHours(4) }), NOW);
  assert.equal(book.bar(NOW)?.age, 'updated 10m ago');
});

test('an agent that could not answer is not asked again until the reader asks', () => {
  const book = new UsageBook();
  book.noteSilent('codex');
  assert.deepEqual(
    book.toAsk(USAGE_AGENT_ORDER, NOW, false),
    ['claude'],
    'a machine without one of the CLIs pays a failed process start on every glance at the panel',
  );
  // An explicit refresh clears the failed-read state.
  assert.deepEqual(book.toAsk(['codex'], NOW, true), ['codex']);
  assert.deepEqual(book.toAsk(USAGE_AGENT_ORDER, NOW, false), ['claude', 'codex']);
});

test('the book keeps the last figure an agent gave, and grows its age by itself', () => {
  const book = new UsageBook();
  book.note('claude', { plan: 'max', limits: [limit()], complete: true, spend: null, readAt: NOW });
  assert.equal(book.bar(NOW)?.age, '');
  // Calculate age from the draw clock even when no new reading arrives.

  assert.equal(book.bar(NOW + USAGE_FRESH_MS + 1000)?.age, 'updated 2m ago');
});

test('a restored live reset survives reload and leaves the bar after its reset time', () => {
  const reset = inHours(4);
  const book = new UsageBook([
    usage({
      windows: [reading({ source: 'event', resetsAtSeconds: reset })],
      checkedAt: NOW,
    }),
  ]);
  assert.equal(book.bar(NOW)?.groups[0].lines[0].resets, 'resets in 4h');
  assert.equal(book.nextReset(NOW), reset);
  assert.equal(book.bar(reset * 1000 + 1), null);
  assert.equal(book.nextReset(reset * 1000 + 1), null);
});

test('the credit clock schedules the credits row without an overage window', () => {
  const reset = inHours(2);
  const book = new UsageBook([
    usage({
      plan: 'enterprise',
      windows: [],
      spend: spendReading(),
      creditResetsAtSeconds: reset,
    }),
  ]);
  assert.equal(book.nextReset(NOW), reset);
});

test('the model bucket sets no repaint timer of its own', () => {
  // The bucket resets first, and a repaint at its reset changes nothing on screen. The week
  // beside it is the next reset the bar has anything to redraw for.
  const book = new UsageBook([
    usage({
      windows: [MODEL_BUCKET, reading({ source: 'event', resetsAtSeconds: inHours(96) })],
      checkedAt: NOW,
    }),
  ]);
  assert.equal(book.nextReset(NOW), inHours(96));
});

test('clearing remembered usage removes every figure and reset', () => {
  const book = new UsageBook([CLAUDE]);
  book.noteSilent('codex');
  book.clear();
  assert.deepEqual(book.usages(), []);
  assert.equal(book.bar(NOW), null);
  assert.equal(book.nextReset(NOW), null);
  assert.deepEqual(book.toAsk(['claude', 'codex'], NOW, false), ['claude', 'codex']);
});

test('the reset timer repaints at the reset and clamps delays Node cannot hold', () => {
  let callback: (() => void) | null = null;
  let delay = -1;
  let cleared = 0;
  const timer = new UsageResetTimer({
    set: (run, wait) => {
      callback = run;
      delay = wait;
      return 1;
    },
    clear: () => {
      cleared += 1;
    },
  });
  let repaints = 0;
  timer.schedule(inHours(4), NOW, () => {
    repaints += 1;
  });
  assert.equal(delay, 4 * 3600_000 + 1);
  assert.ok(callback);
  (callback as () => void)();
  assert.equal(repaints, 1);

  timer.schedule(seconds(NOW + 40 * 24 * 3600_000), NOW, () => {
    repaints += 1;
  });
  assert.equal(delay, MAX_USAGE_RESET_DELAY_MS);
  timer.dispose();
  assert.equal(cleared, 1);
});

test('the usage write queue continues after a rejected write and drains the last write', async () => {
  const queue = new UsageWriteQueue();
  const order: string[] = [];
  let release: () => void = () => {
    throw new Error('the queued write did not start');
  };
  void queue.write(() => {
    order.push('rejected');
    return Promise.reject(new Error('storage unavailable'));
  });
  void queue.write(
    () =>
      new Promise<void>((resolve) => {
        order.push('saved');
        release = resolve;
      }),
  );
  let drained = false;
  const done = queue.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['rejected', 'saved']);
  assert.equal(drained, false);
  release();
  await done;
  assert.equal(drained, true);
});

test('the first look after a reload counts nothing, so opening a window pays no reads', () => {
  // The first completed-turn scan initializes its seen set without starting additional usage reads.

  const first = agentsWithNewTurns(new Set(), [
    { id: 'a', agent: 'claude', finished: true },
    { id: 'b', agent: 'codex', finished: true },
  ]);
  assert.deepEqual(first.agents, []);
  assert.deepEqual([...first.seen].sort(), ['a', 'b'], 'a primed look forgot what it had already seen');
  // And the next look names only what arrived after it.
  const second = agentsWithNewTurns(first.seen, [
    { id: 'a', agent: 'claude', finished: true },
    { id: 'b', agent: 'codex', finished: true },
    { id: 'c', agent: 'codex', finished: true },
  ]);
  assert.deepEqual(second.agents, ['codex']);
});

test('a turn still running is counted when it finishes, and not before', () => {
  const seen = new Set(['a']);
  const running = agentsWithNewTurns(seen, [
    { id: 'a', agent: 'claude', finished: true },
    { id: 'b', agent: 'codex', finished: false },
  ]);
  assert.deepEqual(running.agents, []);
  assert.ok(!running.seen.has('b'), 'an unfinished turn was counted, so it can never be counted again');
  const done = agentsWithNewTurns(running.seen, [{ id: 'b', agent: 'codex', finished: true }]);
  assert.deepEqual(done.agents, ['codex']);
});

test('an agent that finished several turns is named once, in the offered order', () => {
  const { agents } = agentsWithNewTurns(new Set(['old']), [
    { id: 'a', agent: 'codex', finished: true },
    { id: 'b', agent: 'codex', finished: true },
    { id: 'c', agent: 'claude', finished: true },
    { id: 'd', agent: 'codex', finished: true },
  ]);
  assert.deepEqual(agents, ['claude', 'codex']);
});
