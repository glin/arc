import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { parseHostToPanel } from './protocol.ts';
import { replaceRows, replaceStats, RowDeltaReceiver, RowDeltaSender, rowOrderEdit } from './row-deltas.ts';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface Listed {
  id: string;
  label: string;
  status: string;
  cost: number;
}

interface Drawn {
  sessions: readonly { id: string }[];
  rail: readonly { id: string }[];
  stats: Record<string, unknown>;
  showing: string | null;
}

// Build the complete message a host without deltas posts for one panel.
function complete(
  type: 'render' | 'rail' | 'selection',
  listed: readonly Listed[],
  placement: readonly string[],
  showing: string | null,
  previous: string | null,
  hidden: string[],
) {
  const byId = new Map(listed.map((one) => [one.id, one]));
  const rail = placement.map((id) => {
    const one = byId.get(id)!;
    return { id, name: one.label, status: one.status, current: id === showing, archived: hidden.includes(id) };
  });
  const stats = Object.fromEntries(
    listed.filter((one) => one.cost > 0).map((one) => [one.id, [{ metric: 'cost', label: `$${one.cost}` }]]),
  );
  const sessions = listed.map((one) => ({ id: one.id, label: one.label, shown: one.id === showing }));
  if (type === 'selection') {
    // A selection message replaces the rows of the previous and the new selected session, as `selectionPayload` builds it.
    const replaces = [...new Set([showing, previous].filter((id): id is string => id !== null))];
    return {
      type,
      replaces,
      sessions: sessions.filter((row) => replaces.includes(row.id)),
      rail: rail.filter((row) => replaces.includes(row.id)),
      stats: Object.fromEntries(Object.entries(stats).filter(([id]) => replaces.includes(id))),
      showing,
    };
  }
  const shared = { rail, stats, labels: [], views: [], railFilters: [], hidden, pinnedTop: [] };
  return type === 'rail'
    ? { type, ...shared, sessionAdoptions: [] }
    : { type, ...shared, cards: [], sessions, comments: [], iconFonts: [], sessionAdoptions: [], showing };
}

// Apply a message to a panel's drawn lists the way the panel's render, session list and selection handlers do.
function draw(drawn: Drawn | null, message: any): Drawn | null {
  if (message.type === 'render') {
    return { sessions: message.sessions, rail: message.rail, stats: message.stats, showing: message.showing };
  }
  if (message.type === 'rail') return drawn && { ...drawn, rail: message.rail, stats: message.stats };
  const held = drawn ?? { sessions: [], rail: [], stats: {}, showing: null };
  return {
    sessions: replaceRows(held.sessions, message.sessions, message.replaces),
    rail: replaceRows(held.rail, message.rail, message.replaces),
    stats: replaceStats(held.stats, message.stats, message.replaces),
    showing: message.showing,
  };
}

interface StreamPanel {
  sender: RowDeltaSender;
  receiver: RowDeltaReceiver;
  gaps: number;
  // Messages the host posts before it handles the panel's `rowsGap`.
  gapIn: number | null;
  showing: string | null;
  previous: string | null;
  drawn: Drawn | null;
  // The same panel fed complete messages.
  reference: Drawn | null;
}

test('one edit stream sent as row deltas to two panels leaves each the rows, figures and selection of complete messages', () => {
  const random = seeded(20261011);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  let next = 0;
  const fresh = (): Listed => ({
    id: `s${next++}`,
    label: `Session ${next}`,
    status: 'done',
    cost: 0,
  });
  const listed: Listed[] = Array.from({ length: 40 }, fresh);
  let placement = listed.map((one) => one.id);
  let hidden: string[] = [];
  let day = 0;
  const panel = (showing: string): StreamPanel => {
    const one: StreamPanel = {
      sender: new RowDeltaSender(),
      receiver: new RowDeltaReceiver(() => {
        one.gaps++;
        one.gapIn = Math.floor(random() * 3);
      }),
      gaps: 0,
      gapIn: null,
      showing,
      previous: null,
      drawn: null,
      reference: null,
    };
    return one;
  };
  const panels = [panel(listed[0].id), panel(listed[1].id)];
  // A render reaches the panel, the next render is lost, a session list snapshot arrives, and a render with no changed session rows follows.
  const script = new Map<number, { type: 'render' | 'rail'; lost?: true; rename?: true; day?: true }>([
    [300, { type: 'render' }],
    [301, { type: 'render', lost: true, rename: true }],
    [302, { type: 'rail', day: true }],
    [303, { type: 'render' }],
  ]);
  let deltas = 0;
  let selections = 0;
  let lost = 0;
  for (let step = 0; step < 900; step++) {
    const scripted = script.get(step);
    const target = scripted ? panels[0] : pick(panels);
    if (step === 300) {
      // The panel holds a snapshot when the scripted sequence starts.
      target.sender.reset('ready');
      target.gapIn = null;
      target.showing = listed[0].id;
    }
    const edit = scripted ? (scripted.rename ? 0 : 1) : random();
    if (edit < 0.25) {
      pick(listed).label = `Renamed ${step}`;
    } else if (scripted) {
      // A scripted step changes nothing else.
    } else if (edit < 0.4) {
      const one = pick(listed);
      one.status = pick(['running', 'done', 'waiting']);
      one.cost = random() < 0.5 ? 0 : step;
    } else if (edit < 0.5) {
      const one = fresh();
      listed.splice(Math.floor(random() * (listed.length + 1)), 0, one);
      placement.splice(Math.floor(random() * (placement.length + 1)), 0, one.id);
    } else if (edit < 0.6 && listed.length > 2) {
      const [gone] = listed.splice(Math.floor(random() * listed.length), 1);
      placement = placement.filter((id) => id !== gone.id);
    } else if (edit < 0.7) {
      // Newest activity moves a session to the top of the catalog.
      const at = Math.floor(random() * listed.length);
      listed.unshift(...listed.splice(at, 1));
    } else if (edit < 0.75) {
      hidden = random() < 0.5 ? [] : [pick(listed).id];
    } else if (edit < 0.78) {
      day++;
    }
    if (scripted?.day) day++;
    for (const one of panels) {
      // The host forgets a panel's rows when that panel's `rowsGap` arrives. A new sender stands in for the reset half the time.
      if (one.gapIn !== null && one.gapIn-- <= 0) {
        one.gapIn = null;
        if (random() < 0.5) one.sender.reset('ready');
        else one.sender = new RowDeltaSender();
      }
    }
    let type: 'render' | 'rail' | 'selection' =
      scripted?.type ?? (random() < 0.2 ? 'selection' : random() < 0.4 ? 'rail' : 'render');
    if (type === 'selection') {
      target.previous = target.showing;
      target.showing = random() < 0.1 ? null : pick(listed).id;
    }
    // A removed selected session leaves no selection for the next complete message to name.
    if (target.showing !== null && !listed.some((one) => one.id === target.showing)) {
      if (type !== 'selection') type = 'selection';
      target.previous = target.showing;
      target.showing = null;
    }
    const whole: any = complete(type, listed, placement, target.showing, target.previous, hidden);
    if (whole.type === 'selection') selections++;
    // Selection messages post unchanged. Render and session list messages travel as row deltas.
    const encoded = whole.type === 'selection' ? whole : target.sender.encode(whole, { day });
    const fate = scripted ? (scripted.lost ? 'lost' : 1) : random();
    if (fate === 'lost' || (typeof fate === 'number' && fate < 0.03)) {
      // The panel never receives this message, and the host does not learn of it.
      lost++;
      continue;
    }
    if (typeof fate === 'number' && fate < 0.05) {
      // VS Code reports the post as not delivered, so the host forgets the panel's rows.
      if (whole.type !== 'selection') target.sender.reset('ready');
      continue;
    }
    if (typeof fate === 'number' && fate < 0.06) {
      // The page reloads. The host forgets the panel's rows on `ready`, and the new page draws nothing yet.
      target.sender.reset('ready');
      target.receiver = new RowDeltaReceiver(() => {
        target.gaps++;
        target.gapIn = Math.floor(random() * 3);
      });
      target.gapIn = null;
      target.drawn = null;
      target.reference = null;
      continue;
    }
    const wire = JSON.parse(JSON.stringify(encoded));
    const parsed = whole.type === 'selection' ? wire : parseHostToPanel(wire);
    assert.ok(parsed, `step ${step} posted a message the panel rejects`);
    const expanded = parsed.type === 'selection' ? parsed : target.receiver.expand(parsed);
    if (expanded === null) continue;
    if ('rows' in encoded && encoded.rows && encoded.rows.base !== null) deltas++;
    if (whole.type !== 'selection') {
      assert.deepEqual(expanded.rail, whole.rail, `step ${step} left other session list rows or order`);
      assert.deepEqual(expanded.stats, whole.stats, `step ${step} left other session figures`);
    }
    if (whole.type === 'render') {
      assert.deepEqual(expanded.sessions, whole.sessions, `step ${step} left other session rows or order`);
    }
    target.drawn = draw(target.drawn, expanded);
    target.reference = draw(target.reference, whole);
    assert.deepEqual(target.drawn, target.reference, `step ${step} drew other rows, figures or selection`);
    if (whole.type !== 'rail') {
      assert.equal(target.drawn?.showing, target.showing, `step ${step} drew another panel's selection`);
    }
  }
  const gaps = panels.reduce((sum, one) => sum + one.gaps, 0);
  assert.ok(deltas > 450, `only ${deltas} messages were deltas`);
  assert.ok(selections > 100, `only ${selections} messages were selections`);
  assert.ok(gaps > 0 && gaps <= lost, `the panels asked ${gaps} times for a snapshot after ${lost} lost messages`);
});

test('a session list snapshot after a lost render does not hide that render from later renders', () => {
  let gaps = 0;
  const sender = new RowDeltaSender();
  const receiver = new RowDeltaReceiver(() => gaps++);
  const render = (label: string) => ({ sessions: [{ id: 'a', label }], rail: [{ id: 'a' }], stats: {} });
  assert.ok(receiver.expand(sender.encode(render('First'), { day: 1 })));
  sender.encode(render('Renamed'), { day: 1 });
  assert.ok(receiver.expand(sender.encode({ rail: [{ id: 'a' }], stats: {} }, { day: 2 })));
  const after = receiver.expand(sender.encode(render('Renamed'), { day: 2 }));
  if (after) assert.deepEqual(after.sessions, [{ id: 'a', label: 'Renamed' }], 'a later render kept the lost rename');
  else assert.equal(gaps, 1, 'the panel kept stale session rows without asking for a snapshot');
});

test('a new sender never reuses a revision the panel holds', () => {
  const receiver = new RowDeltaReceiver();
  const rows = (label: string) => ({ sessions: [{ id: 'a', label }], rail: [{ id: 'a', label }], stats: {} });
  assert.ok(receiver.expand(new RowDeltaSender().encode(rows('First'), {})));
  const replaced = new RowDeltaSender();
  // The replacement's snapshot is lost, and its next message is a delta against that snapshot.
  replaced.encode(rows('Renamed'), {});
  const after = receiver.expand(replaced.encode(rows('Renamed'), {}));
  assert.ok(
    after === null || (after.rail[0] as { label?: string }).label === 'Renamed',
    'the panel applied another sender delta to the rows it held',
  );
});

test('a panel asks once for a snapshot after a loss and draws nothing until one arrives', () => {
  let gaps = 0;
  const sender = new RowDeltaSender();
  const receiver = new RowDeltaReceiver(() => gaps++);
  const rows = (label: string) => ({ rail: [{ id: 'a', label }], stats: {} });
  assert.ok(receiver.expand(sender.encode(rows('A'), {})));
  sender.encode(rows('B'), {});
  for (const label of ['C', 'D', 'E']) {
    assert.equal(
      receiver.expand(sender.encode(rows(label), {})),
      null,
      `the panel applied delta ${label} after a loss`,
    );
  }
  assert.equal(gaps, 1, 'one lost message asked for more than one snapshot');
  sender.reset('ready');
  assert.deepEqual(receiver.expand(sender.encode(rows('F'), {}))?.rail, [{ id: 'a', label: 'F' }]);
  assert.deepEqual(receiver.expand(sender.encode(rows('G'), {}))?.rail, [{ id: 'a', label: 'G' }]);
  assert.equal(gaps, 1, 'the panel asked for a snapshot after one arrived');
});

// The encoding record is the only evidence of why a panel received a snapshot instead of a delta.

test('the sender names why each message was a snapshot and counts the rows it carried', () => {
  const sender = new RowDeltaSender();
  const rows = (version: number) => [
    { id: 'a', version },
    { id: 'b', version: 0 },
    { id: 'c', version: 0 },
  ];
  const message = (version: number) => ({ type: 'rail' as const, rail: rows(version), stats: { a: [version] } });
  const globals = { day: 'Mon', scope: ['root'] };

  sender.encode(message(1), globals);
  assert.deepEqual({ ...sender.lastEncoding }, { whole: true, reason: 'first', rowsHeld: 3, rowsSent: 3 });

  sender.encode(message(1), globals);
  assert.deepEqual({ ...sender.lastEncoding }, { whole: false, reason: null, rowsHeld: 3, rowsSent: 0 });

  sender.encode(message(2), globals);
  assert.deepEqual({ ...sender.lastEncoding }, { whole: false, reason: null, rowsHeld: 3, rowsSent: 1 });

  sender.encode(message(2), { ...globals, scope: ['root', 'added'] });
  assert.deepEqual({ ...sender.lastEncoding }, { whole: true, reason: 'globalMoved:scope', rowsHeld: 3, rowsSent: 3 });

  sender.reset('gap');
  sender.encode(message(2), { ...globals, scope: ['root', 'added'] });
  assert.deepEqual({ ...sender.lastEncoding }, { whole: true, reason: 'reset:gap', rowsHeld: 3, rowsSent: 3 });

  sender.encode(
    { type: 'rail' as const, rail: [...rows(2), { id: 'a', version: 9 }], stats: {} },
    {
      ...globals,
      scope: ['root', 'added'],
    },
  );
  assert.equal(sender.lastEncoding?.reason, 'repeatedIds');
  sender.encode(message(2), { ...globals, scope: ['root', 'added'] });
  assert.equal(sender.lastEncoding?.reason, 'reset:repeatedIds');

  sender.encode(
    { type: 'rail' as const, rail: [{ id: 'a' }, { noId: true } as unknown as { id: string }], stats: {} },
    globals,
  );
  assert.deepEqual({ ...sender.lastEncoding }, { whole: true, reason: 'unkeyedRows', rowsHeld: 0, rowsSent: 0 });

  const withSessions = new RowDeltaSender();
  withSessions.encode({ type: 'render' as const, sessions: [{ id: 's' }], rail: rows(1), stats: {} }, globals);
  assert.deepEqual(withSessions.lastEncoding, { whole: true, reason: 'first', rowsHeld: 4, rowsSent: 4 });
});

test('a delta carries only rows whose content changed', () => {
  const sender = new RowDeltaSender();
  const rows = (label: string) => [
    { id: 'a', label: 'A' },
    { id: 'b', label },
    { id: 'c', label: 'C' },
  ];
  const first = sender.encode({ sessions: rows('B'), rail: rows('B'), stats: { a: 1, b: 2 } }, {});
  assert.equal(first.rows?.base, null);
  assert.equal(first.rows?.sessionsBase, null);
  const second = sender.encode({ sessions: rows('B2'), rail: rows('B2'), stats: { a: 1 } }, {});
  assert.deepEqual(second.sessions, [{ id: 'b', label: 'B2' }]);
  assert.deepEqual(second.rail, [{ id: 'b', label: 'B2' }]);
  assert.deepEqual(second.stats, {});
  const revision = first.rows?.revision ?? Number.NaN;
  assert.deepEqual(second.rows, {
    revision: revision + 1,
    base: revision,
    sessionsBase: revision,
    statsRemoved: ['b'],
  });
  assert.equal(sender.encode({ rail: rows('B2'), stats: { a: 1 } }, { day: 'next' }).rows?.base, null);
});

test('an order edit keeps the common start and end of the held order', () => {
  assert.equal(rowOrderEdit(['a', 'b', 'c'], ['a', 'b', 'c']), undefined);
  assert.deepEqual(rowOrderEdit(['a', 'b', 'c', 'd'], ['c', 'a', 'b', 'd']), {
    head: 0,
    tail: 1,
    ids: ['c', 'a', 'b'],
  });
  assert.deepEqual(rowOrderEdit(['a', 'b'], ['a', 'b', 'c']), {
    head: 2,
    tail: 0,
    ids: ['c'],
  });
  assert.deepEqual(rowOrderEdit(['a', 'b', 'c'], ['a', 'c']), {
    head: 1,
    tail: 1,
    ids: [],
  });
});

test('the panel rebuilds render and session list rows before any handler reads them', () => {
  const source = fs.readFileSync(new URL('./panel.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes("new RowDeltaReceiver(() => vscode.postMessage({ type: 'rowsGap' }))"),
    'a lost row delta no longer asks the host for a snapshot',
  );
  const receive = source.slice(source.indexOf('function receiveHostMessage'));
  const expand = receive.indexOf('rowDeltas.expand(parsed)');
  assert.ok(expand > 0, 'the panel hands row deltas to its handlers unexpanded');
  const dispatch = receive.indexOf('dispatchHostToPanel(message');
  assert.ok(expand < dispatch, 'the panel dispatches before it expands row deltas');
  // A delta that cannot apply leaves the drawn rows until the snapshot arrives.
  assert.ok(
    /\n\s*if \(!message\) return;\n/.test(receive.slice(expand, dispatch)),
    'the panel draws a row delta it could not apply',
  );
});
