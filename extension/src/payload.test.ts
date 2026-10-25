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

// Use a thousand sessions to check payload scaling.

const SESSIONS = 1000;

// Keep this name bound independent of RAIL_NAME_LIMIT so a production change does not resize the fixture automatically.

const RAIL_NAME_BOUND = 200;

// Byte ceilings bound each payload field. SLACK also limits excess room above the measured fixture.

const CEILINGS = {
  // The render total includes session data and the fixed card fixture. Session names and unsent text each travel once per row.

  renderTotal: 3_103_033,
  renderRail: 1_146_658,
  renderStats: 1_476_250,
  renderSessions: 305_000,
  // The card ceiling includes commit branches, repository paths, and author sessions.

  renderCards: 113_000,
  selectionTotal: 9_400,
  railMessageTotal: 2_676_966,
  railRow: 1_255,
  duplicateWaste: 243_665,
};

// Each ceiling stays within five percent of its measured fixture.

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

// Give each session a distinct prompt-based label.

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
  // Only the selected session carries fullLabel. The panel constructs resume commands from the agent key and session id.

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
      // Give every session a name at RAIL_NAME_BOUND to measure the maximum per-row name cost.

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
    // The cache mark carries expiry and nearly-gone timestamps.

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

// Two fixed cards exercise subagent commits and files. Their size does not represent a full selected-session history window.

function sessionCards(): TurnCard[] {
  return [
    toCard(heavySubagentTurn(4, 13, 5), true, Date.UTC(2026, 8, 5, 12, 0, 0)),
    toCard(heavySubagentTurn(2, 4, 2), false, Date.UTC(2026, 8, 5, 11, 0, 0)),
  ];
}

// Match the host payload by omitting railName from sessions. The session list cards carry it separately.

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
    // Cards belong only to the selected session. This fixed fixture measures card detail without scaling it by session count.

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

// Report payload field sizes and duplicate strings.

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

// The card ceiling covers subagent details, paths, and full commit hashes.

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
      // Session list figures use the heading tooltip text.

      const drawn = railStatChips(heading);
      assert.ok(drawn.length > 0);
      assert.ok(drawn.every((chip) => chip.detail.length > 0));
      // Read-only figures expose native tooltips without becoming focus stops or opening hint popovers.

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
      // Every session list row requires figures under its own id.

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
  // Only the selected session has a full label. No session row carries a resume command.

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

// Limit unused ceiling room so payload growth cannot remain hidden below a loose bound.

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
  // Report all ceilings with excess room in one assertion.

  const roomy = measured
    .filter(([, actual, ceiling]) => ceiling > Math.ceil(actual * SLACK) && ceiling !== 0)
    .map(
      ([name, actual, ceiling]) =>
        `the ceiling for ${name} is ${ceiling} and the payload weighs ${actual}. Lower it to about ${Math.ceil(actual * SLACK)}.`,
    );
  assert.deepEqual(roomy, [], roomy.join('\n'));
});
