import { test } from 'vitest';
import assert from 'node:assert';
import { createClock, TICK_MS, writeRelativeTimes } from './clock.ts';
import { formatCacheSpan, formatDuration, formatRelative } from '../view/time.ts';
import { railHoverLines, railRunningWord, type RailHoverCard } from '../view/rail.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import { railHoverCard } from './rail-hover.ts';

// A node that counts its own text writes. The count is the point: a figure the clock rewrites
// when the wording has not moved replaces the text node the reader is selecting.
class FakeNode {
  dataset: Record<string, string>;
  writes = 0;
  private value: string;

  constructor(dataset: Record<string, string>, text = '') {
    this.dataset = dataset;
    this.value = text;
  }

  get textContent(): string {
    return this.value;
  }

  set textContent(next: string) {
    this.value = next;
    this.writes += 1;
  }
}

interface FakePage {
  document: Document;
  asked: string[];
}

function page(found: Record<string, FakeNode[]>): FakePage {
  const asked: string[] = [];
  const document = {
    querySelectorAll(selector: string) {
      asked.push(selector);
      return (found[selector] ?? []) as unknown as NodeListOf<HTMLElement>;
    },
  } as unknown as Document;
  return { document, asked };
}

const NOW = 1_700_000_000_000;

test('the clock words a duration and an age from the shared rules', () => {
  const running = new FakeNode({ since: String(NOW - 3_570_000) });
  const age = new FakeNode({ at: String(NOW - 7_200_000) });
  const left = new FakeNode({ at: String(NOW + 1_800_000), remaining: 'true' });
  const drawn = page({ '[data-since]': [running], '[data-at]:not(.railwhen)': [age, left] });

  writeRelativeTimes(drawn.document, NOW);

  assert.equal(running.textContent, formatDuration(3_570_000));
  assert.equal(age.textContent, formatRelative(NOW - 7_200_000, NOW));
  assert.equal(left.textContent, formatCacheSpan(1_800_000));
});

test('a running subagent time reads as the session rail words a running session', () => {
  const young = new FakeNode({ runningSince: String(NOW - 59_000) });
  const old = new FakeNode({ runningSince: String(NOW - 21 * 60_000 - 5_000) });
  const drawn = page({ '[data-running-since]': [young, old] });

  writeRelativeTimes(drawn.document, NOW);

  assert.deepEqual([young.textContent, old.textContent], ['', ' 21m']);
  assert.equal(old.textContent, ` ${railRunningWord(NOW - 21 * 60_000 - 5_000, NOW)}`);
  writeRelativeTimes(drawn.document, NOW + 1_000);
  assert.deepEqual([young.textContent, young.writes], [' 1m', 1]);
});

test('the clock leaves a figure alone while its wording has not moved', () => {
  // The tick runs sixty times for every time a minute figure changes. A rewrite each time
  // drops the selection the reader is holding inside the line.
  const running = new FakeNode({ since: String(NOW - 300_000) });
  const age = new FakeNode({ at: String(NOW - 300_000) });
  const drawn = page({ '[data-since]': [running], '[data-at]:not(.railwhen)': [age] });

  writeRelativeTimes(drawn.document, NOW);
  assert.equal(running.writes, 1);
  assert.equal(age.writes, 1);

  writeRelativeTimes(drawn.document, NOW + 1_000);
  assert.equal(running.writes, 1, 'a duration whose wording has not moved was written again');
  assert.equal(age.writes, 1, 'an age whose wording has not moved was written again');

  writeRelativeTimes(drawn.document, NOW + 60_000);
  assert.equal(running.writes, 2, 'a duration that moved a minute was not reworded');
  assert.equal(age.writes, 2, 'an age that moved a minute was not reworded');
});

test('the clock never rewords a rail age', () => {
  // The rail rewords its own cards, because an age moving there can also move the card's
  // cache band. Two writers would answer that with two different draws.
  const drawn = page({});
  writeRelativeTimes(drawn.document, NOW);
  assert.deepEqual(drawn.asked, ['[data-since]', '[data-running-since]', '[data-at]:not(.railwhen)']);
});

test('the clock starts one repeating tick and calls every subscriber with one instant', () => {
  const started: { ms: number; run(): void }[] = [];
  const drawn = page({});
  const seen: number[] = [];
  const clock = createClock({
    document: drawn.document,
    now: () => NOW,
    start(run, ms) {
      started.push({ ms, run });
    },
  });
  clock.subscribe((now) => seen.push(now));
  clock.subscribe((now) => seen.push(now + 1));

  assert.equal(started.length, 1, 'the clock started more than one repeating tick');
  assert.equal(started[0].ms, TICK_MS);
  started[0].run();
  assert.deepEqual(seen, [NOW, NOW + 1]);
});

test('a dropped subscriber stops being called', () => {
  const drawn = page({});
  const seen: string[] = [];
  const clock = createClock({ document: drawn.document, now: () => NOW, start() {} });
  const stop = clock.subscribe(() => seen.push('first'));
  clock.subscribe(() => seen.push('second'));

  clock.tick();
  stop();
  clock.tick();

  assert.deepEqual(seen, ['first', 'second', 'second']);
});

test('a subscriber that drops itself mid-tick leaves the rest of the walk intact', () => {
  const drawn = page({});
  const seen: string[] = [];
  const clock = createClock({ document: drawn.document, now: () => NOW, start() {} });
  const stop = clock.subscribe(() => {
    seen.push('first');
    stop();
  });
  clock.subscribe(() => seen.push('second'));

  clock.tick();
  clock.tick();

  assert.deepEqual(seen, ['first', 'second', 'second']);
});

test('a tick with no instant reads the clock once for every listener', () => {
  const drawn = page({});
  let reads = 0;
  const seen: number[] = [];
  const clock = createClock({
    document: drawn.document,
    now: () => {
      reads += 1;
      return NOW + reads;
    },
    start() {},
  });
  clock.subscribe((now) => seen.push(now));
  clock.subscribe((now) => seen.push(now));

  clock.tick();

  assert.equal(reads, 1, 'the clock was read more than once inside one tick');
  assert.deepEqual(seen, [NOW + 1, NOW + 1]);
});

// The few members a hover card's build and the clock touch. Every element the page creates is
// kept, so the page can find the ones the clock asks for.
class CardElement {
  className = '';
  title = '';
  dataset: Record<string, string> = {};
  children: (CardElement | { textContent: string })[] = [];
  private text = '';

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }

  append(...nodes: (CardElement | { textContent: string })[]): void {
    this.children.push(...nodes);
  }

  setAttribute(): void {}
}

function cardPage(): Document {
  const created: CardElement[] = [];
  return {
    createElement() {
      const node = new CardElement();
      created.push(node);
      return node;
    },
    createTextNode(textContent: string) {
      return { textContent };
    },
    querySelectorAll(selector: string) {
      return selector === '[data-running-since]' ? created.filter((node) => node.dataset.runningSince) : [];
    },
  } as unknown as Document;
}

// A compact row's hover card opened in a run's first minute says `running`. No host update
// arrives when the minute passes, so the clock alone moves the open card to `running for 1m`.
test('an open hover card gains its running duration when the first minute passes', () => {
  const document = cardPage();
  const card: RailHoverCard = {
    label: 'Fix login',
    agent: 'Claude',
    agentWord: 'Claude',
    status: 'running',
    subagents: null,
    commands: null,
    runningSince: NOW - 30_000,
    unsentWord: null,
    at: NOW - 30_000,
    labels: [],
  };
  const drawn = railHoverCard(document, railHoverLines(card, NOW, CARD_ACTIONS), []) as unknown as CardElement;
  const meta = drawn.children[1];
  assert.equal(meta.textContent, 'Claude · running');

  writeRelativeTimes(document, NOW + 20_000);
  assert.equal(meta.textContent, 'Claude · running');
  writeRelativeTimes(document, NOW + 31_000);
  assert.equal(meta.textContent, 'Claude · running for 1m');
  writeRelativeTimes(document, NOW + 91_000);
  assert.equal(meta.textContent, 'Claude · running for 2m');
});
