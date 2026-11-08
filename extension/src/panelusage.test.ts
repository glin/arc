import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './temproot';
import {
  openPanelUsageMetrics,
  PANEL_USAGE_DIRECTORY,
  PanelUsageMetrics,
  usageDayName,
  USAGE_KEY_LIMIT,
  USAGE_QUERY_LIMIT,
  USAGE_WRITE_MS,
  type PanelUsageMetricsFile,
} from './panelusage.ts';
import { parsePanelToHost, type PanelToHost } from './webview/protocol.ts';
import {
  chordName,
  createPageUsageMetrics,
  startPageUsageMetrics,
  USAGE_POST_MS,
  type ChordEvent,
} from './webview/panel-usage-metrics.ts';

beforeEach(() => {
  // Real file promises keep running. Only the clock and its timers are controlled.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function usageHome(): { home: string; directory: string } {
  const home = tempDir('panel-metrics-');
  const directory = path.join(home, PANEL_USAGE_DIRECTORY);
  fs.mkdirSync(directory);
  return { home, directory };
}

function readUsage(file: string): PanelUsageMetricsFile {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// File promises run on the real event loop. This polls real loop turns without moving the fake clock.
async function untilSettled(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'the write did not settle');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function temporaryFiles(file: string): string[] {
  return fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
}

test('with no panel-usage folder, Arc keeps no metrics and creates nothing', () => {
  const home = tempDir('panel-metrics-off-');
  assert.equal(openPanelUsageMetrics(home), undefined);
  assert.deepEqual(fs.readdirSync(home), []);
  fs.writeFileSync(path.join(home, PANEL_USAGE_DIRECTORY), 'not a folder');
  assert.equal(openPanelUsageMetrics(home), undefined);
});

test('the host writes no sooner than a minute after its last write, only after a change, and on dispose', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const file = metrics.fileFor('2026-11-07');
  // The first write step starts on a timer turn, so this count reads whether a write began.
  const writes = vi.spyOn(fs.promises, 'mkdir');
  metrics.count('cmd:arc.newSession');
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS - 1);
  assert.equal(writes.mock.calls.length, 0, 'the first write came within a minute of opening');
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(writes.mock.calls.length, 1);
  await metrics.flush();
  assert.deepEqual(readUsage(file), { v: 1, counts: { 'cmd:arc.newSession': 1 }, queries: {} });

  // A count inside the minute after the preceding write waits for the end of that minute.
  metrics.count('cmd:arc.newSession');
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS - 1);
  assert.equal(writes.mock.calls.length, 1, 'a write came within a minute of the preceding write');
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(writes.mock.calls.length, 2);
  await metrics.flush();
  assert.deepEqual(readUsage(file).counts, { 'cmd:arc.newSession': 2 });

  // With no change nothing is written, however long the window sits idle.
  await vi.advanceTimersByTimeAsync(3 * USAGE_WRITE_MS);
  assert.equal(writes.mock.calls.length, 2, 'the host wrote with no changed count');

  // After an idle minute, the next count writes at once.
  metrics.count('cmd:arc.newSession');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(writes.mock.calls.length, 3, 'the count after an idle interval did not write at once');
  await metrics.flush();
  assert.deepEqual(readUsage(file).counts, { 'cmd:arc.newSession': 3 });

  metrics.count('cmd:arc.newSession');
  metrics.dispose();
  assert.deepEqual(readUsage(file).counts, { 'cmd:arc.newSession': 4 });
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  writes.mockRestore();
});

test('a window open across local midnight writes the old day one last time, then starts from zero', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 23, 59, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  metrics.count('key:Ctrl+Enter');
  metrics.count('key:Ctrl+Enter');
  vi.setSystemTime(new Date(2026, 10, 8, 0, 1, 0));
  await metrics.flush();
  assert.deepEqual(readUsage(metrics.fileFor('2026-11-07')).counts, { 'key:Ctrl+Enter': 2 });
  metrics.count('key:Escape');
  await metrics.flush();
  assert.deepEqual(readUsage(metrics.fileFor('2026-11-08')).counts, { 'key:Escape': 1 });
  assert.deepEqual(readUsage(metrics.fileFor('2026-11-07')).counts, { 'key:Ctrl+Enter': 2 });
  metrics.dispose();
});

for (const [first, act] of [
  ['count', (metrics: PanelUsageMetrics) => metrics.count('msg:goForward')],
  ['merge', (metrics: PanelUsageMetrics) => metrics.merge({ 'msg:goForward': 1 }, [])],
] as const) {
  test(`a ${first} after an idle midnight joins the new day and leaves the finished day untouched`, async () => {
    vi.setSystemTime(new Date(2026, 10, 7, 23, 59, 0));
    const { home } = usageHome();
    const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
    metrics.count('msg:goBack');
    await metrics.flush();
    vi.setSystemTime(new Date(2026, 10, 8, 0, 10, 0));
    act(metrics);
    metrics.merge({ 'key:Escape': 1 }, ['is:running']);
    await metrics.flush();
    assert.deepEqual(readUsage(metrics.fileFor('2026-11-07')), { v: 1, counts: { 'msg:goBack': 1 }, queries: {} });
    assert.deepEqual(readUsage(metrics.fileFor('2026-11-08')), {
      v: 1,
      counts: { 'msg:goForward': 1, 'key:Escape': 1 },
      queries: { 'is:running': 1 },
    });
    metrics.dispose();
  });
}

test('each asynchronous write uses its own temporary file', async () => {
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const writes = vi.spyOn(fs.promises, 'writeFile');
  metrics.count('msg:goBack');
  await metrics.flush();
  metrics.count('msg:goBack');
  await metrics.flush();
  const names = writes.mock.calls.map(([name]) => name);
  writes.mockRestore();
  assert.equal(new Set(names).size, 2, String(names));
  metrics.dispose();
});

test('dispose publishes over a write still in flight, and that write leaves no temporary file', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const file = metrics.fileFor('2026-11-07');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const writeFile = fs.promises.writeFile;
  const held = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
    await gate;
    return writeFile(...args);
  });
  metrics.count('msg:goBack');
  const inFlight = metrics.flush();
  await vi.waitFor(() => assert.equal(held.mock.calls.length, 1));
  metrics.count('msg:goBack');
  metrics.dispose();
  assert.deepEqual(readUsage(file).counts, { 'msg:goBack': 2 });
  release();
  await inFlight;
  held.mockRestore();
  assert.deepEqual(readUsage(file).counts, { 'msg:goBack': 2 }, 'an older asynchronous write replaced the newer body');
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('a rename that fails during dispose leaves no temporary file', () => {
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const file = metrics.fileFor('2026-11-07');
  // A folder where the file belongs makes the rename fail after the temporary file is written.
  fs.mkdirSync(file, { recursive: true });
  metrics.count('msg:goBack');
  metrics.dispose();
  assert.deepEqual(temporaryFiles(file), []);
});

test('a failed write retries on the write interval with no new count, and the retry stops at dispose', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const file = metrics.fileFor('2026-11-07');
  fs.mkdirSync(file, { recursive: true });
  const attempts = vi.spyOn(fs.promises, 'mkdir');
  const timers = vi.spyOn(globalThis, 'setTimeout');
  metrics.count('msg:goBack');
  await metrics.flush();
  assert.equal(attempts.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 1, 'the failed write armed no retry');
  const retry = timers.mock.results.at(-1)!.value as NodeJS.Timeout;
  assert.equal(retry.hasRef(), false, 'the retry timer holds the host open');

  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS - 1);
  assert.equal(attempts.mock.calls.length, 1, 'the retry came within a minute of the failed write');
  await vi.advanceTimersByTimeAsync(1);
  await untilSettled(() => attempts.mock.calls.length === 2 && vi.getTimerCount() === 1);

  // The file's place clears, and the next retry writes with no new count.
  fs.rmdirSync(file);
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS - 1);
  assert.equal(fs.existsSync(file), false, 'a repeated failure retried within a minute');
  await vi.advanceTimersByTimeAsync(1);
  await untilSettled(() => fs.existsSync(file) && vi.getTimerCount() === 0);
  assert.deepEqual(readUsage(file).counts, { 'msg:goBack': 1 });
  attempts.mockRestore();
  timers.mockRestore();

  // A write that fails again at dispose leaves no timer behind.
  fs.rmSync(file);
  fs.mkdirSync(file);
  metrics.count('msg:goForward');
  await metrics.flush();
  assert.equal(vi.getTimerCount(), 1);
  metrics.dispose();
  assert.equal(vi.getTimerCount(), 0, 'a retry timer outlived dispose');
  assert.deepEqual(temporaryFiles(file), []);
});

test('expiry held past the write interval leaves one failed attempt, and its retry waits a full interval', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 23, 59, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  metrics.message({ type: 'painted', stage: 'railReady' } as PanelToHost);

  // The first write after midnight succeeds, then that day's expiry holds the write queue.
  let release!: (names: string[]) => void;
  const held = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  const listing = vi.spyOn(fs.promises, 'readdir').mockImplementation((() => held) as never);
  vi.setSystemTime(new Date(2026, 10, 8, 0, 0, 1));
  metrics.count('msg:goBack');
  void metrics.flush();
  await untilSettled(() => listing.mock.calls.length === 1);

  // Every later write fails, because a folder takes the file's place.
  const file = metrics.fileFor('2026-11-08');
  fs.rmSync(file);
  fs.mkdirSync(file);
  const attempts = vi.spyOn(fs.promises, 'mkdir');
  metrics.count('msg:goForward');
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS);
  metrics.count('msg:refresh');
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS);
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS);
  assert.equal(attempts.mock.calls.length, 0, 'a write ran while expiry held the queue');

  release([]);
  await untilSettled(() => attempts.mock.calls.length >= 1 && vi.getTimerCount() === 1);
  assert.equal(attempts.mock.calls.length, 1, 'the writes queued during the hold each made an attempt');
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS - 1);
  assert.equal(attempts.mock.calls.length, 1, 'the retry came within a minute of the failed attempt');
  await vi.advanceTimersByTimeAsync(1);
  await untilSettled(() => attempts.mock.calls.length === 2);
  listing.mockRestore();
  attempts.mockRestore();
  metrics.dispose();
});

test('a deleted panel-usage folder stays deleted while the window keeps running', async () => {
  const { home, directory } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  fs.rmSync(directory, { recursive: true });
  metrics.count('msg:goBack');
  await metrics.flush();
  assert.equal(fs.existsSync(directory), false, 'a write recreated the folder');
  assert.equal(vi.getTimerCount(), 0, 'a missing folder kept the retry timer running');

  // The next count tries again, and the retry timer stays off.
  const attempts = vi.spyOn(fs.promises, 'mkdir');
  metrics.count('msg:goBack');
  await vi.advanceTimersByTimeAsync(USAGE_WRITE_MS);
  await untilSettled(() => attempts.mock.calls.length === 1 && vi.getTimerCount() === 0);
  attempts.mockRestore();
  assert.equal(fs.existsSync(directory), false, 'the next count recreated the folder');

  metrics.count('msg:goBack');
  metrics.dispose();
  assert.equal(fs.existsSync(directory), false, 'the write on dispose recreated the folder');
});

test('expiry keeps day 89, deletes day 91, leaves other names, and runs once a day', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 12, 0, 0));
  const { home, directory } = usageHome();
  const daysAgo = (days: number) => usageDayName(new Date(2026, 10, 7 - days, 12).getTime());
  for (const name of [daysAgo(89), daysAgo(91), 'notes', '2026-02-30']) {
    fs.mkdirSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name, 'w0.json'), '{}');
  }
  const metrics = openPanelUsageMetrics(home)!;
  await metrics.expireDue();
  assert.deepEqual(fs.readdirSync(directory).sort(), ['2026-02-30', daysAgo(89), 'notes'].sort());
  fs.mkdirSync(path.join(directory, daysAgo(120)));
  await metrics.expireDue();
  assert.ok(fs.existsSync(path.join(directory, daysAgo(120))), 'expiry ran twice on one day');
  vi.setSystemTime(new Date(2026, 10, 8, 0, 0, 1));
  await metrics.expireDue();
  assert.equal(fs.existsSync(path.join(directory, daysAgo(120))), false, 'expiry did not run on the next day');
  metrics.dispose();
});

test('a session list paint expires old folders, and a later write repeats it once a day without a new paint', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 12, 0, 0));
  const { home, directory } = usageHome();
  const daysAgo = (days: number) => usageDayName(new Date(2026, 10, 7 - days, 12).getTime());
  fs.mkdirSync(path.join(directory, daysAgo(91)));
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  // Before the first session list paint, a write leaves expiry alone.
  metrics.count('msg:goBack');
  await metrics.flush();
  assert.ok(fs.existsSync(path.join(directory, daysAgo(91))), 'a write before the first paint expired a folder');

  metrics.message({ type: 'painted', stage: 'railReady' } as PanelToHost);
  await vi.waitFor(() => assert.equal(fs.existsSync(path.join(directory, daysAgo(91))), false));

  // The same day's writes do not expire again.
  fs.mkdirSync(path.join(directory, daysAgo(120)));
  metrics.count('msg:goBack');
  await metrics.flush();
  assert.ok(fs.existsSync(path.join(directory, daysAgo(120))), 'expiry ran twice on one day');

  // On the next day a write alone expires, with no new paint.
  vi.setSystemTime(new Date(2026, 10, 8, 0, 0, 1));
  metrics.count('msg:goBack');
  await metrics.flush();
  assert.equal(fs.existsSync(path.join(directory, daysAgo(120))), false, 'a write on the next day did not expire');
  metrics.dispose();
});

test('the 201st distinct query adds to other', async () => {
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const queries = Array.from({ length: USAGE_QUERY_LIMIT }, (_, at) => `label:q${at}`);
  metrics.merge({}, queries);
  metrics.merge({}, ['label:q0', 'label:late', 'label:q0', 'label:late']);
  await metrics.flush();
  const written = readUsage(metrics.fileFor(usageDayName(Date.now())));
  assert.equal(Object.keys(written.queries).length, USAGE_QUERY_LIMIT);
  assert.equal(written.queries['label:q0'], 3);
  assert.equal(written.queries['label:late'], undefined);
  assert.equal(written.other, 2);
  metrics.dispose();
});

test('a new count key past the limit is dropped, and existing keys keep counting', async () => {
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  for (let at = 0; at < USAGE_KEY_LIMIT; at += 1) metrics.count(`msg:k${at}`);
  metrics.count('msg:late');
  metrics.merge({ 'msg:lateMerge': 3, 'msg:k0': 2 }, []);
  metrics.count('msg:k1');
  await metrics.flush();
  const { counts } = readUsage(metrics.fileFor(usageDayName(Date.now())));
  assert.equal(Object.keys(counts).length, USAGE_KEY_LIMIT);
  assert.equal(counts['msg:k0'], 3);
  assert.equal(counts['msg:k1'], 2);
  assert.equal(counts['msg:late'], undefined);
  assert.equal(counts['msg:lateMerge'], undefined);
  metrics.dispose();
});

test('a label editor refresh does not count, and a reader opening the editor does', async () => {
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  metrics.message({ type: 'labelEditor', session: 's1', refresh: true });
  metrics.message({ type: 'labelEditor', session: 's1' });
  await metrics.flush();
  assert.deepEqual(readUsage(metrics.fileFor(usageDayName(Date.now()))).counts, { 'msg:labelEditor': 1 });
  metrics.dispose();
});

test('a query repeated from another tab counts once, and an interleaved query counts again', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const firstTab: PanelToHost[] = [];
  const secondTab: PanelToHost[] = [];
  const first = createPageUsageMetrics((message) => firstTab.push(message), pageTimers);
  const second = createPageUsageMetrics((message) => secondTab.push(message), pageTimers);
  const deliver = (posted: PanelToHost[]) => {
    for (const message of posted.splice(0)) {
      if (message.type === 'panelUsageMetrics') metrics.merge(message.counts, message.queries);
    }
  };
  first.query('label:composer');
  first.flush();
  deliver(firstTab);
  second.query('label:composer');
  second.flush();
  deliver(secondTab);
  second.query('is:running');
  first.query('label:composer');
  second.flush();
  first.flush();
  deliver(secondTab);
  deliver(firstTab);
  await metrics.flush();
  assert.deepEqual(readUsage(metrics.fileFor('2026-11-07')).queries, { 'label:composer': 2, 'is:running': 1 });
  metrics.dispose();
});

test('a repeated query alone changes no count and writes nothing', async () => {
  vi.setSystemTime(new Date(2026, 10, 7, 10, 0, 0));
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  metrics.merge({}, ['is:running']);
  await metrics.flush();
  const writes = vi.spyOn(fs.promises, 'mkdir');
  metrics.merge({}, ['is:running']);
  await vi.advanceTimersByTimeAsync(2 * USAGE_WRITE_MS);
  assert.equal(writes.mock.calls.length, 0, 'a repeated query started a write');
  writes.mockRestore();
  metrics.dispose();
});

test('the summary script totals every file, including query words that name Object members', () => {
  const { home, directory } = usageHome();
  const day = path.join(directory, '2026-11-07');
  fs.mkdirSync(day);
  const body = (one: number, two: number) =>
    `{"v":1,"counts":{"view:sort=latest":${one},"constructor":${two},"toString":${two},"__proto__":${two}},` +
    `"queries":{"constructor":${one},"toString":${one},"__proto__":${two},"label:composer":${two}},"other":${one}}`;
  fs.writeFileSync(path.join(day, 'w1.json'), body(2, 3));
  fs.writeFileSync(path.join(day, 'w2.json'), body(5, 7));
  fs.writeFileSync(path.join(day, 'w3.json'), 'unreadable');
  fs.writeFileSync(path.join(day, 'w1.json.1.tmp'), body(100, 100));
  const script = path.join(__dirname, '..', 'scripts', 'panel-usage-summary.mjs');
  const result = spawnSync(process.execPath, [script, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ARC_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.files, 2);
  assert.deepEqual(summary.days, { first: '2026-11-07', last: '2026-11-07', count: 1 });
  assert.equal(summary.counts['view:sort=latest'], 7);
  assert.equal(summary.counts.constructor, 10);
  assert.equal(summary.counts.toString, 10);
  assert.equal(summary.counts['__proto__'], 10);
  assert.equal(summary.topQueries.constructor, 7);
  assert.equal(summary.topQueries.toString, 7);
  assert.equal(summary.topQueries['__proto__'], 10);
  assert.equal(summary.topQueries['label:composer'], 10);
  assert.equal(summary.otherQueries, 7);
  assert.ok(!summary.unusedViewValues.includes('view:sort=latest'));
  assert.ok(summary.unusedViewValues.includes('view:sort=cost-desc'));
  assert.ok(summary.unusedViewValues.includes('view:window=6h'));
});

test('a prompt and a session name never reach the metrics file', async () => {
  const { home } = usageHome();
  const metrics = openPanelUsageMetrics(home, { windowId: 'w1' })!;
  const prompt = 'Prompt text that must stay private';
  const title = 'Private session name';
  const messages = [
    parsePanelToHost({ type: 'sendPrompt', text: prompt, session: 's1', revision: 1 }),
    parsePanelToHost({ type: 'renameSession', session: 's1', request: 1, title }),
    parsePanelToHost({ type: 'saveState', state: { railFilter: prompt } }),
  ];
  for (const message of messages) metrics.message(message as PanelToHost);
  await metrics.flush();
  const body = fs.readFileSync(metrics.fileFor(usageDayName(Date.now())), 'utf8');
  assert.deepEqual(JSON.parse(body).counts, { 'msg:sendPrompt': 1, 'msg:renameSession': 1 });
  assert.ok(!body.includes(prompt) && !body.includes(title), body);
  metrics.dispose();
});

test('a failed write keeps the counts for the next try and never throws', async () => {
  const { directory } = usageHome();
  const metrics = new PanelUsageMetrics(directory, { windowId: 'w1' });
  const day = usageDayName(Date.now());
  // A file where the day folder belongs makes the write fail.
  fs.writeFileSync(path.join(directory, day), '');
  metrics.count('msg:goBack');
  await metrics.flush();
  fs.rmSync(path.join(directory, day));
  await metrics.flush();
  assert.deepEqual(readUsage(metrics.fileFor(day)).counts, { 'msg:goBack': 1 });
  metrics.dispose();
  metrics.count('msg:goBack');
});

function chord(key: string, extra: Partial<ChordEvent> = {}): ChordEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    defaultPrevented: true,
    isComposing: false,
    ...extra,
  };
}

const pageTimers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

test('a chord counts only when a panel handler consumed it, with modifiers in a fixed order', () => {
  const posted: PanelToHost[] = [];
  const page = createPageUsageMetrics((message) => posted.push(message), pageTimers);
  // The capture listener sees the key before any handler runs. A handler marks it consumed afterwards.
  const consumed = chord('Enter', { ctrlKey: true, defaultPrevented: false });
  page.key(consumed);
  consumed.defaultPrevented = true;
  page.key(chord('Enter', { ctrlKey: true, defaultPrevented: false }));
  page.key(chord('k', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }));
  page.key(chord('a', { isComposing: true }));
  page.key(chord('Shift', { shiftKey: true }));
  page.key(chord(' '));
  page.flush();
  assert.deepEqual(posted, [
    {
      type: 'panelUsageMetrics',
      counts: { 'key:Ctrl+Enter': 1, 'key:Ctrl+Alt+Shift+Meta+K': 1, 'key:Space': 1 },
      queries: [],
    },
  ]);
  assert.equal(chordName(chord('Control', { ctrlKey: true })), null);
});

test('the page posts at most once every 5 seconds, and queries keep their commit order', async () => {
  const posted: PanelToHost[] = [];
  const page = createPageUsageMetrics((message) => posted.push(message), pageTimers);
  page.view('sort', 'cost-desc');
  page.query(' label:composer ');
  page.query('');
  page.count('key:Escape');
  await vi.advanceTimersByTimeAsync(USAGE_POST_MS - 1);
  assert.deepEqual(posted, []);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(posted, [
    {
      type: 'panelUsageMetrics',
      counts: { 'view:sort=cost-desc': 1, 'key:Escape': 1 },
      queries: ['label:composer'],
    },
  ]);
  await vi.advanceTimersByTimeAsync(10 * USAGE_POST_MS);
  assert.equal(posted.length, 1, 'the page posted with no changed count');
  page.query('is:running');
  page.query('is:running');
  page.query('label:composer');
  page.flush();
  assert.deepEqual(posted.at(-1), {
    type: 'panelUsageMetrics',
    counts: {},
    queries: ['is:running', 'is:running', 'label:composer'],
  });
  for (const message of posted) assert.ok(parsePanelToHost(message), 'the host refuses what the page posts');
});

test('a page whose shell lacks the recording option installs no listener and posts nothing', () => {
  const listeners: unknown[] = [];
  const posted: PanelToHost[] = [];
  const noDocument = { addEventListener() {}, removeEventListener() {} };
  const off = startPageUsageMetrics(
    false,
    (message) => posted.push(message),
    pageTimers,
    (...args) => {
      listeners.push(args);
    },
    noDocument,
  );
  assert.equal(off, undefined);
  assert.deepEqual(listeners, []);
  assert.deepEqual(posted, []);
  let keydown: ((event: unknown) => void) | undefined;
  const on = startPageUsageMetrics(
    true,
    (message) => posted.push(message),
    pageTimers,
    (type, listener, capture) => {
      assert.equal(type, 'keydown');
      assert.equal(capture, true);
      keydown = listener;
    },
    noDocument,
  )!;
  keydown!(chord('Enter', { ctrlKey: true }));
  on.flush();
  assert.equal(posted.length, 1);
});

// The order a keydown visits the page's listeners: window capture, panel handlers, the document's
// listeners, then VS Code's own window listener, which cancels chords such as Ctrl+V.
test('a chord counts when a panel listener cancels it, not when the webview script does', () => {
  const posted: PanelToHost[] = [];
  const documentListeners = new Set<(event: unknown) => void>();
  let capture: ((event: unknown) => void) | undefined;
  const metrics = startPageUsageMetrics(
    true,
    (message) => posted.push(message),
    pageTimers,
    (_type, listener) => {
      capture = listener;
    },
    {
      addEventListener: (_type, listener) => documentListeners.add(listener),
      removeEventListener: (_type, listener) => documentListeners.delete(listener),
    },
  )!;
  const cancel = (event: ChordEvent) => {
    event.defaultPrevented = true;
  };
  const press = (event: ChordEvent, panelHandler?: (event: ChordEvent) => void) => {
    capture!(event);
    panelHandler?.(event);
    if (panelHandler === stopAfterCancel) return;
    for (const listener of [...documentListeners]) listener(event);
    if (event.key === 'V') cancel(event);
  };
  const stopAfterCancel = (event: ChordEvent) => cancel(event);
  press(chord('v', { ctrlKey: true, defaultPrevented: false, key: 'V' }));
  // A panel handler that stops propagation reaches neither the document nor VS Code's listener.
  press(chord('Z', { ctrlKey: true, defaultPrevented: false }), stopAfterCancel);
  // A document listener added after the metrics' listener still runs first, and its cancel counts.
  documentListeners.add((event) => cancel(event as ChordEvent));
  press(chord('K', { ctrlKey: true, defaultPrevented: false }));
  metrics.flush();
  assert.deepEqual(posted, [{ type: 'panelUsageMetrics', counts: { 'key:Ctrl+Z': 1, 'key:Ctrl+K': 1 }, queries: [] }]);
});
