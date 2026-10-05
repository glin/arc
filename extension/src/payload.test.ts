import { test } from 'vitest';
import assert from 'node:assert';

import {
  DUPLICATE_CENSUS_MINIMUM,
  duplicateStrings,
  messageFieldBytes,
  railPayload,
  railRowBytes,
  renderPayload,
  selectionPayload,
  totalWastedBytes,
  type PayloadSessionRow,
  type RailPayloadInput,
} from './payload';
import {
  sessionCostStats,
  sessionCostProjection,
  sessionTurnStats,
  sessionStatsFromFacts,
  toCard,
  type SessionCostTotal,
  type SessionCostUsage,
  type SessionStatChip,
  type TurnCard,
} from './turncard';
import type { SessionStatFacts, TurnUsage } from './transcript';
import type { NewCount } from './turnread';
import type { RailCacheMark, UnsentInput } from './turnrail';
import { heavySubagentTurn } from './turnfixtures.ts';
import { shortenTo } from './domain/text.ts';
import { railStatChips, type RailStatus } from './view/rail.ts';
import { parseHostToPanel } from './webview/protocol.ts';
import { StaticStatChip } from './webview/stat-chip.ts';

// A workspace the size the owner is aiming at. The corpus on this machine indexes 1,624
// sources today, so a thousand sessions is under the real target and still an order of
// magnitude past what any other test here builds.
const SESSIONS = 1000;

// Mirrors RAIL_NAME_LIMIT in `panelhost.ts`. Kept as its own constant rather than an
// import, so a change to the production bound shows up here as a mismatch to reconcile
// rather than silently resizing this fixture's worst case along with it.
const RAIL_NAME_BOUND = 200;

// What the panel is sent, and what it may cost.
//
// These are ceilings, not measurements. Each one sits just above what the payload weighs
// today, so the suite goes red the moment a field grows, and `SLACK` below refuses a
// ceiling parked far above the real number. A step that cuts the payload lowers the
// ceiling it moved in the same commit and quotes the new figure in its message.
const CEILINGS = {
  // The render total covers the corpus fields and the fixed cost of the cards below, so its
  // room holds the corpus room alone: the cards' own bytes are added to it, and a corpus field
  // that grows still fails under its own name before it reaches this one.
  //
  // Raised here, alongside renderRail, railMessageTotal and railRow, when the rail's own
  // name field first carried a bounded worst-case name on every row instead of on one row
  // alone: a real workspace names most sessions from a first prompt, so most rows hit the
  // 200-character rail bound `panelhost.ts` derives from having no maximum rail width to
  // measure against, not the short label's 60. Lowered once the name stopped riding
  // the wire twice per row: `name` is sent only where it differs from `label`, and the
  // clauses in `nameBeforeAge` no longer repeat it, so a row with a long name pays for that
  // name once rather than twice. Lowered again once the unsent-input clause stopped riding
  // the wire twice per row as well: `nameBeforeAge` no longer folds in the same text the
  // card's own `unsentName` field already carries, so `railCardName` appends that field once.
  renderTotal: 3_105_039,
  renderRail: 1_146_658,
  renderStats: 1_516_000,
  renderSessions: 305_000,
  // The heavy fixture's commits carry their branch, their repository at a real checkout's depth
  // and their maker's session, as every real commit row does, so this ceiling also bounds what
  // grouping the Commits record costs a row. The same fixture weighs 108,927 bytes without those
  // fields and 112,227 with them, a growth of 3%, under the 5% at which a card would send each
  // repository once rather than on every row.
  renderCards: 113_000,
  selectionTotal: 8_134,
  railMessageTotal: 2_678_977,
  railRow: 1_255,
  duplicateWaste: 278_000,
};

// How far above the measured figure a ceiling may sit. A ceiling with room in it is a
// ceiling that lets the payload grow back, so every step has to re-record what it cut.
const SLACK = 1.05;

function usage(scale: number): TurnUsage {
  return {
    requests: 3 + (scale % 5),
    input: 1200 + scale * 7,
    cacheWrite1h: 400 + scale,
    cacheWrite5m: 9000 + scale * 31,
    cacheRead: 260000 + scale * 911,
    output: 1800 + scale * 13,
    thinking: 600 + scale * 3,
  };
}

function costParts(scale: number): SessionCostUsage[] {
  return [
    {
      agent: 'claude',
      role: 'main',
      model: 'claude-opus-4-6',
      provider: null,
      contextWindow: 200000,
      contextBand: 'short',
      inferenceClass: 'in-region',
      serviceTier: 'standard',
      usage: usage(scale),
    },
    {
      agent: 'claude',
      role: 'delegated',
      model: 'claude-sonnet-4-5',
      provider: null,
      contextWindow: 200000,
      contextBand: 'short',
      inferenceClass: 'in-region',
      serviceTier: 'standard',
      usage: usage(scale + 17),
    },
  ];
}

function statFacts(scale: number, at: number): SessionStatFacts {
  return {
    turns: [0, 1, 2].map((step) => ({
      startedAt: at - (3 - step) * 60_000,
      endedAt: at - (3 - step) * 60_000 + 42_000,
      finished: true,
      error: false,
      model: 'claude-opus-4-6',
      provider: null,
      usage: usage(scale + step),
      contextTokens: 60_000 + scale * 11 + step * 900,
      contextWindow: 200_000,
      childSpendPartial: step === 1,
    })),
    compactions: [],
  };
}

// The prompt line a session is named by. Real labels are the reader's first sentence,
// so they are long and they do not repeat.
function sessionLabel(index: number): string {
  const subjects = [
    'the rail filter losing its selection on a rebuild',
    'why the project cost chip reads Calculating for minutes',
    'a diff that shows no change after a formatter ran',
    'the composer dropping an attachment on resume',
    'the timeline scrolling to the wrong turn after a compaction',
  ];
  return `Look at ${subjects[index % subjects.length]} in session ${index}`;
}

function sessionId(index: number): string {
  const tail = index.toString(16).padStart(12, '0');
  return `9f2c41a8-${(index % 0xffff).toString(16).padStart(4, '0')}-4b1d-8e7a-${tail}`;
}

interface FixtureSessionRow extends PayloadSessionRow {
  // The complete name answers a question about one session at a time, so the extension
  // sends it on the chosen session alone. No row carries a resume command at all, because
  // the panel words one from the agent key and the id every row already holds.
  fullLabel?: string;
  agentKey: string;
  shown: boolean;
}

interface Fixture extends RailPayloadInput {
  sessions: FixtureSessionRow[];
}

function fixture(count = SESSIONS): Fixture {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const sessions: FixtureSessionRow[] = [];
  const counts = new Map<string, NewCount>();
  const newest = new Map<string, number>();
  const statuses = new Map<string, RailStatus>();
  const unsent = new Map<string, UnsentInput>();
  const hidden = new Set<string>();
  const pinnedTop = new Set<string>();
  const metadataStats: Record<string, SessionStatChip[]> = {};
  const lifetimeStats: Record<string, SessionStatChip[]> = {};
  const lifetimeCosts: Record<string, SessionCostTotal> = {};
  const labels: Record<string, string[]> = {};
  const caches: Record<string, RailCacheMark | null> = {};
  const statusWords: RailStatus[] = ['done', 'running', 'failed', 'waiting', 'interrupted'];

  for (let index = 0; index < count; index++) {
    const id = sessionId(index);
    const at = now - index * 900_000;
    const agentKey = index % 3 === 0 ? 'codex' : 'claude';
    const label = sessionLabel(index);
    sessions.push({
      id,
      persisted: true,
      label,
      ...(index === 0 ? { fullLabel: `${label}, including its complete first prompt` } : {}),
      // Every row carries a rail name at the bound, not only the shown session: a real
      // workspace names most of its sessions from a first prompt, so most rows hit
      // RAIL_NAME_LIMIT (`panelhost.ts`) rather than staying at `label`'s length. A fixture
      // that gave this to one row alone would measure a payload no real workspace sends.
      railName: shortenTo(`${label} ${label} ${label}`, RAIL_NAME_BOUND, '...'),
      agent: agentKey === 'codex' ? 'Codex' : 'Claude',
      agentKey,
      when: new Date(at).toISOString(),
      // One row at a time, the way the host marks the session it is drawing.
      shown: index === 0,
      at,
      relative: `${index + 1}m ago`,
      agentRun: index % 11 === 0,
    });
    counts.set(id, { count: index % 7, atLeast: index % 13 === 0 });
    newest.set(id, at);
    if (index % 5 !== 4) {
      statuses.set(id, statusWords[index % statusWords.length]);
    }
    if (index % 23 === 0) {
      unsent.set(id, { prompt: true, comments: index % 3 });
    }
    if (index % 17 === 0) {
      hidden.add(id);
    }
    if (index % 97 === 0) {
      pinnedTop.add(id);
    }
    metadataStats[id] = sessionStatsFromFacts(statFacts(index, at));
    lifetimeStats[id] = [
      ...sessionCostStats(costParts(index)),
      ...sessionTurnStats({
        turnCount: 4 + (index % 40),
        compactionCount: index % 6,
        firstTurnAt: at - 3 * 60_000,
        lastTurnAt: at,
      }),
    ];
    const cost = lifetimeStats[id].find((chip) => chip.metric === 'cost');
    if (cost?.dollars !== undefined) {
      lifetimeCosts[id] = { dollars: cost.dollars, partial: cost.partial === true };
    }
    labels[id] = index % 4 === 0 ? ['performance', 'panel'] : index % 4 === 1 ? ['review'] : [];
    // The decorative cache mark is two clock boundaries. Written here rather than derived,
    // because what it costs on the wire is two numbers whatever the pricing rule decides.
    caches[id] = index % 3 === 0 ? { expiresAt: at + 5 * 60_000, nearlyGoneAt: at + 4 * 60_000 } : null;
  }

  return {
    now,
    sessions,
    counts,
    newest,
    statuses,
    runningSince: new Map(),
    openChildren: new Map(),
    backgroundCommands: new Map(),
    hidden,
    showing: sessions[0].id,
    pinnedTop,
    unsent,
    parsedStats: {},
    metadataStats,
    lifetimeStats,
    lifetimeCosts,
    labels,
    caches,
    views: [
      {
        id: 'view-performance',
        name: 'Performance',
        query: 'label:performance',
        archived: false,
      },
      {
        id: 'view-review',
        name: 'Waiting on review',
        query: 'label:review status:waiting',
        archived: false,
      },
    ],
    railFilters: [],
  };
}

// Two cards of the session on screen, each carrying several subagents with enough commits and
// files behind them to weigh what a subagent row's own figures cost. `cards` never scales with
// `SESSIONS`, because the host sends the cards for the shown session alone, so this stays a
// fixed fixture rather than a function of `count`. Two cards are a fraction of the field's own
// top: the host sends up to `TRANSCRIPT_TURN_LIMIT` turns and keeps retained older pages
// beyond that, so this weighs the cost of a row and not the cost of a full window.
function sessionCards(): TurnCard[] {
  return [
    toCard(heavySubagentTurn(4, 13, 5), true, Date.UTC(2026, 8, 5, 12, 0, 0)),
    toCard(heavySubagentTurn(2, 4, 2), false, Date.UTC(2026, 8, 5, 11, 0, 0)),
  ];
}

// The host strips `railName` from the `sessions` array it sends: that field exists for
// `railSessions` to read while it builds the rail's own cards, and it would otherwise ride
// this array a second time for no reader here to use. Mirrored here so this fixture weighs
// what a real render actually carries rather than a copy it never sends.
function withoutRailName(sessions: readonly FixtureSessionRow[]): object[] {
  return sessions.map(({ railName: _railName, ...row }) => row);
}

function renderMessage(input: Fixture): Record<string, unknown> {
  const rail = railPayload(input);
  return {
    ...renderPayload({
      rail,
      hidden: input.hidden,
      pinnedTop: input.pinnedTop,
      comments: [],
      sessions: withoutRailName(input.sessions),
      showing: input.showing,
      sessionAdoptions: [],
      maxSessions: 3,
      olderHistory: null,
      projectSpend: null,
      diagnosis: null,
      timelineLayout: { cardLayout: 'compact', promptPosition: 'above' },
    }),
    // The two fields the host adds per webview. The cards belong to the session on screen, so
    // they carry no corpus scaling, and a subagent row's own figures still cost bytes the
    // `renderCards` ceiling has to cover. Two cards weigh a row. They do not weigh the field,
    // whose top is the host's turn window plus every retained older page.
    cards: sessionCards(),
    stats: rail.stats,
    iconFonts: [],
  };
}

function railMessage(input: Fixture): Record<string, unknown> {
  const rail = railPayload(input);
  return {
    type: 'rail',
    rail: rail.rail,
    stats: rail.stats,
    labels: rail.labels,
    views: rail.views,
    railFilters: rail.railFilters,
  };
}

function selectionMessage(input: Fixture): Record<string, unknown> {
  const rail = railPayload(input);
  return {
    ...selectionPayload({
      rail,
      sessions: withoutRailName(input.sessions),
      showing: input.showing,
      previousShowing: input.sessions.find((session) => session.id !== input.showing)?.id ?? null,
      olderHistory: null,
      diagnosis: null,
    }),
    cards: [],
    usage: null,
    startup: null,
  };
}

function bytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8');
}

function fieldBytes(message: unknown, field: string): number {
  return messageFieldBytes(message).find((entry) => entry.field === field)?.bytes ?? 0;
}

function report(message: unknown, label: string): string {
  const top = messageFieldBytes(message)
    .slice(0, 5)
    .map((entry) => `${entry.field} ${entry.bytes}`)
    .join(', ');
  return `${label} is ${bytes(message)} bytes over ${SESSIONS} sessions; largest fields: ${top}`;
}

// The numbers a commit message quotes. Printed on every run, because the payload work
// lowers a ceiling per step and the step has to say what it measured.
test('the payload weighs what the ceilings record', () => {
  const input = fixture();
  const render = renderMessage(input);
  const rail = railMessage(input);
  const selection = selectionMessage(input);
  const duplicates = duplicateStrings(render);
  console.log(
    [
      `payload over ${SESSIONS} sessions:`,
      `  render total ${bytes(render)}`,
      ...messageFieldBytes(render)
        .filter((entry) => entry.bytes > 1000)
        .map((entry) => `    render.${entry.field} ${entry.bytes}`),
      `  selection total ${bytes(selection)}`,
      `  rail message total ${bytes(rail)}`,
      `  one rail row ${railRowBytes(railPayload(input).rail)}`,
      `  repeated long strings cost ${totalWastedBytes(duplicates)} in ${duplicates.length} values,` +
        ` against the allowance of ${CEILINGS.duplicateWaste}`,
      `  the production render budget is 250,000, and this render total is` +
        ` ${bytes(render) <= 250_000 ? 'inside it' : 'above it'}`,
    ].join('\n'),
  );
  assert.ok(bytes(render) > 0);
});

test('the render message stays under its byte ceiling', () => {
  const message = renderMessage(fixture());
  const total = bytes(message);
  assert.ok(total <= CEILINGS.renderTotal, `${report(message, 'render')}, over the ceiling of ${CEILINGS.renderTotal}`);
});

test('every field that grows with the corpus stays under its own ceiling', () => {
  const message = renderMessage(fixture());
  for (const [field, ceiling] of [
    ['rail', CEILINGS.renderRail],
    ['stats', CEILINGS.renderStats],
    ['sessions', CEILINGS.renderSessions],
  ] as const) {
    const measured = fieldBytes(message, field);
    assert.ok(measured <= ceiling, `render.${field} is ${measured} bytes, over the ceiling of ${ceiling}`);
  }
});

// `cards` carries no corpus scaling, so its ceiling stands apart from the fields above. It
// bounds what a subagent row's own figures cost, which is the per-figure record, its paths and
// its full-length shas, rather than what a thousand sessions cost.
test('the cards a session draws stay under their byte ceiling', () => {
  const message = renderMessage(fixture());
  const measured = fieldBytes(message, 'cards');
  assert.ok(
    measured <= CEILINGS.renderCards,
    `render.cards is ${measured} bytes, over the ceiling of ${CEILINGS.renderCards}`,
  );
});

test('the rail message stays under its byte ceiling', () => {
  const message = railMessage(fixture());
  const total = bytes(message);
  assert.ok(
    total <= CEILINGS.railMessageTotal,
    `${report(message, 'rail')}, over the ceiling of ${CEILINGS.railMessageTotal}`,
  );
});

test('one rail row stays under its byte ceiling', () => {
  const rail = railPayload(fixture()).rail;
  const perRow = railRowBytes(rail);
  assert.ok(perRow <= CEILINGS.railRow, `a rail row costs ${perRow} bytes, over the ceiling of ${CEILINGS.railRow}`);
});

test('one oversized rail row cannot hide behind smaller rows', () => {
  const large = { id: 'large', detail: 'x'.repeat(5_000) };
  assert.equal(railRowBytes([{ id: 'small' }, large]), bytes(large));
});

test('no long string is repeated more than the recorded allowance', () => {
  const message = renderMessage(fixture());
  const duplicates = duplicateStrings(message, DUPLICATE_CENSUS_MINIMUM);
  const wasted = totalWastedBytes(duplicates);
  const worst = duplicates
    .slice(0, 3)
    .map((entry) => `${entry.count} copies of ${JSON.stringify(entry.text.slice(0, 60))} costing ${entry.wastedBytes}`)
    .join('; ');
  assert.ok(
    wasted <= CEILINGS.duplicateWaste,
    `repeated strings of ${DUPLICATE_CENSUS_MINIMUM} characters or more cost ${wasted} bytes, over the allowance of ${CEILINGS.duplicateWaste}. Worst: ${worst}`,
  );
});

test('the census counts a repeated value and ignores a repeated key', () => {
  const long = 'a'.repeat(DUPLICATE_CENSUS_MINIMUM);
  const found = duplicateStrings({ one: { detail: long }, two: { detail: long } });
  assert.deepEqual(
    found.map((entry) => [entry.text, entry.count]),
    [[long, 2]],
  );
  assert.equal(found[0].wastedBytes, bytes(long));
  assert.deepEqual(duplicateStrings({ one: { detail: long }, two: { detail: 'b'.repeat(4) } }), []);
});

test('duplicate waste includes JSON escaping', () => {
  const escaped = 'a long value with a quote " and a slash \\ and a newline\n'.repeat(2);
  const found = duplicateStrings([escaped, escaped]);
  assert.equal(found[0].wastedBytes, bytes(escaped));
});

test('a string one character under the census length is not counted', () => {
  const short = 'a'.repeat(DUPLICATE_CENSUS_MINIMUM - 1);
  assert.deepEqual(duplicateStrings({ one: short, two: short }), []);
});

test('field bytes name the largest field first', () => {
  const measured = messageFieldBytes({ small: 1, large: 'x'.repeat(500) });
  assert.deepEqual(
    measured.map((entry) => entry.field),
    ['large', 'small'],
  );
});

test('field bytes leave excluded fields unexamined', () => {
  const excluded = {
    toJSON() {
      throw new Error('the excluded field was serialized');
    },
  };
  assert.deepEqual(messageFieldBytes({ included: 'yes', excluded }, new Set(['excluded'])), [
    { field: 'included', bytes: 5 },
  ]);
});

test('the render message reaches the panel with the fields the panel reads', () => {
  const message = renderMessage(fixture(3));
  assert.equal(message.type, 'render');
  for (const field of [
    'hidden',
    'pinnedTop',
    'comments',
    'sessions',
    'rail',
    'labels',
    'views',
    'showing',
    'maxSessions',
    'olderHistory',
    'usage',
    'projectSpend',
    'diagnosis',
  ]) {
    assert.ok(field in message, `render is missing ${field}`);
  }
  assert.deepEqual(
    parseHostToPanel(message),
    message,
    'the measured render payload is not valid on the production wire',
  );
});

test('a selection sends only fields that choosing another session can change', () => {
  const message = selectionMessage(fixture(3));
  assert.deepEqual(Object.keys(message).sort(), [
    'cards',
    'diagnosis',
    'olderHistory',
    'rail',
    'replaces',
    'sessions',
    'showing',
    'startup',
    'stats',
    'type',
    'usage',
  ]);
  assert.deepEqual(
    parseHostToPanel(message),
    message,
    'the measured selection payload is not valid on the production wire',
  );
});

test('a selection message stays under its byte ceiling', () => {
  const message = selectionMessage(fixture());
  assert.ok(
    bytes(message) <= CEILINGS.selectionTotal,
    `${report(message, 'selection')} over the ceiling of ${CEILINGS.selectionTotal}`,
  );
});

test('structured stat detail follows selection while rail tooltips keep their text', () => {
  const input = fixture(3);
  for (const selected of input.sessions.map((session) => session.id)) {
    const projected = railPayload({ ...input, showing: selected });
    for (const row of projected.rail) {
      const heading = projected.stats[row.id];
      assert.equal(
        heading.some((chip) => !!chip.detailList),
        row.id === selected,
      );
      // The figures the rail draws are taken out of the same record, so their native
      // tooltip text is the heading's own and no card carries a second copy of it.
      const drawn = railStatChips(heading);
      assert.ok(drawn.length > 0);
      assert.ok(drawn.every((chip) => chip.detail.length > 0));
      // What the reader meets on the drawn figure. The rail hands the chip to the figure
      // component as it stands, so a record the heading grows later reaches the rail too.
      // A figure given both halves of a hint pair takes the keyboard, opens a hint box, and
      // loses the tooltip text a reader hovers for.
      for (const chip of drawn) {
        const figure = StaticStatChip({ stat: chip, contextClass: () => '' }).props as unknown as Record<
          string,
          unknown
        >;
        assert.equal(figure.title, chip.detail, `the ${chip.metric} figure drew no tooltip text`);
        assert.equal(figure.tabIndex, undefined, `the ${chip.metric} figure became a focus stop`);
        assert.equal(figure['data-hint'], undefined, `the ${chip.metric} figure drew a popover row`);
        assert.equal(figure['data-hint-detail'], undefined, `the ${chip.metric} figure drew a popover row`);
        assert.ok(
          !String(figure.class).includes('has-detail'),
          `the ${chip.metric} figure marked itself as holding a record`,
        );
      }
    }
  }
  assert.ok(input.lifetimeStats[input.sessions[0].id].some((chip) => !!chip.detailList));
});

test('every rail row finds its figures under its own id', () => {
  const input = fixture(3);
  const messages: [string, Record<string, unknown>][] = [
    ['render', renderMessage(input)],
    ['rail', railMessage(input)],
    ['selection', selectionMessage(input)],
  ];
  for (const [label, message] of messages) {
    const rows = message.rail as { id: string }[];
    const keyed = message.stats as Record<string, unknown[]>;
    assert.ok(rows.length > 0, `the ${label} message carries no rail row to check`);
    for (const row of rows) {
      // A row whose id the record misses draws the empty fallback and hides its figures,
      // while the name the host worded still says the cost, the turns and the context.
      assert.ok(
        Array.isArray(keyed[row.id]) && keyed[row.id].length > 0,
        `the ${label} message draws a row for ${row.id} with no figures under that id`,
      );
    }
  }
});

test('the selected heading retains partial lifetime cost independently of its visible cards', () => {
  const input = fixture(1);
  const id = input.sessions[0].id;
  const cost = sessionCostProjection(costParts(1), { main: false, delegated: true, delegatedScopeIds: new Set() });
  input.lifetimeStats = { ...input.lifetimeStats, [id]: cost.stats };
  input.lifetimeCosts = { ...input.lifetimeCosts, [id]: cost.total };
  for (const message of [renderMessage(input), railMessage(input), selectionMessage(input)]) {
    const stats = (message.stats as Record<string, SessionStatChip[]>)[id];
    const figure = stats.find((stat) => stat.metric === 'cost')!;
    assert.equal(figure.dollars, cost.total.dollars);
    assert.match(figure.compactLabel, /\+$/);
  }
});

test('the measured sessions carry the full production row shape', () => {
  const message = renderMessage(fixture(3));
  const sessions = message.sessions as Record<string, unknown>[];
  for (const session of sessions) {
    for (const field of ['persisted', 'label', 'agentKey', 'shown']) {
      assert.ok(field in session, `the measured session is missing ${field}`);
    }
  }
  // The scoped field and the dropped one. The extension sends a complete name for the
  // chosen session, and it sends no resume command to any row, so a fixture that put either
  // on every row would weigh a payload the panel is never sent.
  assert.deepEqual(
    sessions.map((session) => 'fullLabel' in session),
    [true, false, false],
    'the measured sessions send a complete name beyond the chosen one',
  );
  assert.deepEqual(
    sessions.map((session) => session.shown),
    [true, false, false],
    'the measured sessions mark a session the host is not drawing as shown',
  );
  assert.deepEqual(
    sessions.filter((session) => 'resumeCommand' in session).map((session) => session.id),
    [],
    'the measured sessions carry a resume command the panel words for itself',
  );
});

// A ceiling with room in it lets the payload grow back to it without anything going red,
// which is how the last megabyte arrived. So each ceiling has to sit close to the figure it
// covers, and a step that cuts a field has to lower its ceiling in the same commit.
test('no ceiling sits far above what the payload actually weighs', () => {
  const input = fixture();
  const render = renderMessage(input);
  const rail = railMessage(input);
  const selection = selectionMessage(input);
  const measured: [string, number, number][] = [
    ['renderTotal', bytes(render), CEILINGS.renderTotal],
    ['renderRail', fieldBytes(render, 'rail'), CEILINGS.renderRail],
    ['renderStats', fieldBytes(render, 'stats'), CEILINGS.renderStats],
    ['renderSessions', fieldBytes(render, 'sessions'), CEILINGS.renderSessions],
    ['renderCards', fieldBytes(render, 'cards'), CEILINGS.renderCards],
    ['selectionTotal', bytes(selection), CEILINGS.selectionTotal],
    ['railMessageTotal', bytes(rail), CEILINGS.railMessageTotal],
    ['railRow', railRowBytes(railPayload(input).rail), CEILINGS.railRow],
    ['duplicateWaste', totalWastedBytes(duplicateStrings(render)), CEILINGS.duplicateWaste],
  ];
  // Every ceiling is reported, not only the first one that has room in it. A cut moves
  // several at once, and a run that names one of them costs a run for each of the rest.
  const roomy = measured
    .filter(([, actual, ceiling]) => ceiling > Math.ceil(actual * SLACK) && ceiling !== 0)
    .map(
      ([name, actual, ceiling]) =>
        `the ceiling for ${name} is ${ceiling} and the payload weighs ${actual}. Lower it to about ${Math.ceil(actual * SLACK)}.`,
    );
  assert.deepEqual(roomy, [], roomy.join('\n'));
});
