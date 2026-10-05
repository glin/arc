import { test, vi } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentSpendCache,
  addModelUsage,
  agentSpendIsOpen,
  emptyUsage,
  modelSpends,
  readChildSpend,
  scanLines,
  spendFileVersion,
  spendTokens,
} from './agentspend.ts';
import { tempDir } from './temproot.ts';
import { agentSpendDependencyKey } from './transcript';

const usage = (input: number) => ({ ...emptyUsage(), input });

test('model usage stays split by the model that incurred it', () => {
  const found = new Map();
  addModelUsage(found, 'one', usage(10));
  addModelUsage(found, 'two', usage(20));
  addModelUsage(found, 'one', usage(5));
  assert.deepEqual(modelSpends(found), [
    { model: 'one', usage: usage(15) },
    { model: 'two', usage: usage(20) },
  ]);
  assert.equal(spendTokens(modelSpends(found)), 35);
});

test('a 30-minute cache write survives aggregation and token totals', () => {
  const found = new Map();
  addModelUsage(found, 'openai.gpt-5.6-sol', { ...emptyUsage(), cacheWrite30m: 25 });
  addModelUsage(found, 'openai.gpt-5.6-sol', { ...emptyUsage(), cacheWrite30m: 75 });
  const spend = modelSpends(found, 'amazon-bedrock');
  assert.equal(spend[0].provider, 'amazon-bedrock');
  assert.equal(spend[0].usage.cacheWrite30m, 100);
  assert.equal(spendTokens(spend), 100);
});

test('cache writes without a recorded lifetime remain in child token volume', () => {
  assert.equal(
    spendTokens([
      {
        model: 'claude-opus-5',
        usage: usage(25),
        unclassifiedCacheWrite: 75,
      },
    ]),
    100,
  );
});

test('model usage keeps short and long request totals apart', () => {
  const found = new Map();
  addModelUsage(found, 'gpt-5.5', usage(100), 'short');
  addModelUsage(found, 'gpt-5.5', usage(300), 'long');
  const [spend] = modelSpends(found, 'openai');
  assert.equal(spend.usage.input, 400);
  assert.deepEqual(spend.usage.byContextBand, {
    short: usage(100),
    long: usage(300),
  });
});

test('only a child whose completion is still outstanding is open', () => {
  for (const status of ['running', 'async_launched', 'launched']) {
    assert.equal(agentSpendIsOpen(status), true, status);
  }
  for (const status of ['completed', 'interrupted', 'failed']) {
    assert.equal(agentSpendIsOpen(status), false, status);
  }
});

test('the line scanner crosses chunks and reads a final line with no newline', () => {
  const dir = tempDir('agent-spend-lines-');
  const file = path.join(dir, 'child.jsonl');
  const middle = 'x'.repeat(70 * 1024);
  fs.writeFileSync(file, `first\r\n${middle}\nlast`);
  const lines: string[] = [];
  assert.equal(
    scanLines(file, (line) => lines.push(line)),
    true,
  );
  assert.deepEqual(lines, ['first', middle, 'last']);
});

test('the line scanner keeps a character split between byte chunks', () => {
  const dir = tempDir('agent-spend-utf8-');
  const file = path.join(dir, 'child.jsonl');
  const line = 'x'.repeat(64 * 1024 - 1) + '€';
  fs.writeFileSync(file, `${line}\n`);
  const lines: string[] = [];
  assert.equal(
    scanLines(file, (read) => lines.push(read)),
    true,
  );
  assert.deepEqual(lines, [line]);
  assert.equal(
    scanLines(path.join(dir, 'missing.jsonl'), () => {}),
    false,
  );
});

test('the line scanner stops at the line its visit answers true for', () => {
  const dir = tempDir('agent-spend-stop-');
  const file = path.join(dir, 'child.jsonl');
  fs.writeFileSync(file, 'first\nsecond\nthird\n');
  const lines: string[] = [];
  assert.equal(
    scanLines(file, (line) => {
      lines.push(line);
      return line === 'second';
    }),
    false,
  );
  assert.deepEqual(lines, ['first', 'second']);
});

test('the line scanner preserves empty lines, malformed UTF-8, CRLF, and an incomplete final line', () => {
  const dir = tempDir('agent-spend-line-semantics-');
  const file = path.join(dir, 'child.jsonl');
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from('first\r\n\r\n'), Buffer.from([0xe2, 0x28, 0xa1]), Buffer.from('\nlast\r')]),
  );
  const lines: string[] = [];
  assert.equal(
    scanLines(file, (line) => lines.push(line)),
    true,
  );
  assert.deepEqual(lines, ['first', '', '\ufffd(\ufffd', 'last']);
});

test('the spend cache reuses an unchanged file, refreshes a changed one, and stays bounded', () => {
  const dir = tempDir('agent-spend-cache-');
  const first = path.join(dir, 'first.jsonl');
  const second = path.join(dir, 'second.jsonl');
  fs.writeFileSync(first, 'a');
  fs.writeFileSync(second, 'b');
  const cache = new AgentSpendCache(1);
  const firstVersion = spendFileVersion(first);
  let reads = 0;
  const load = (file: string) => {
    reads++;
    return {
      models: [{ model: 'one', usage: usage(fs.readFileSync(file, 'utf8').length) }],
      found: true,
      partial: false,
      effort: null,
    };
  };
  assert.equal(spendTokens(cache.read(first, load).models), 1);
  assert.equal(spendTokens(cache.read(first, load).models), 1);
  assert.equal(reads, 1, 'an unchanged file was read twice');
  fs.appendFileSync(first, 'aa');
  assert.notEqual(spendFileVersion(first), firstVersion);
  assert.equal(spendTokens(cache.read(first, load).models), 3);
  assert.equal(reads, 2, 'a changed file kept its old total');
  cache.read(second, load);
  cache.read(first, load);
  assert.equal(reads, 4, 'the oldest entry survived past the cache bound');
  assert.equal(spendFileVersion(path.join(dir, 'missing.jsonl')), 'missing');
});

test('completed Codex children retain artifacts while descendant cost settles after its quiet band', () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  try {
    const file = path.join(tempDir('aggregate-band-'), 'child.jsonl');
    fs.writeFileSync(file, 'child');
    const cache = new AgentSpendCache();
    let input = 10;
    let partial = true;
    let version = 'codex-aggregate\n["grandchild"]\nchild:5:100000\ngrandchild:5:100000';
    let reads = 0;
    const load = () => {
      reads++;
      return {
        models: [{ model: 'one', usage: usage(input) }],
        found: true,
        partial,
        effort: null,
        startedAt: 1,
        endedAt: 2,
      };
    };
    const read = () => readChildSpend(cache, file, 'completed', version, load, '["grandchild"]', true, Date.now());
    const turns = [
      {
        agents: [
          {
            id: 'child',
            description: 'child',
            agentType: null,
            status: 'completed',
            model: null,
            effort: null,
            spend: [],
            spendFound: false,
            spendPartial: true,
            durationMs: null,
            tokens: null,
            toolUses: null,
          },
        ],
      },
    ];
    const key = () =>
      agentSpendDependencyKey(
        turns,
        () => file,
        () => version,
        '',
        [file],
        Date.now(),
      );
    const firstKey = key();
    assert.equal(read().endedAt, 2);
    vi.advanceTimersByTime(100);
    input = 20;
    partial = false;
    version = 'codex-aggregate\n["grandchild"]\nchild:5:100000\ngrandchild:10:100100';
    assert.equal(key(), firstKey);
    assert.equal(read().partial, true);
    assert.equal(reads, 1);
    vi.advanceTimersByTime(5_001);
    assert.notEqual(key(), firstKey);
    assert.equal(read().partial, false);
    assert.equal(read().models[0].usage.input, 20);
    assert.equal(read().endedAt, 2);
    version = version.replace('["grandchild"]', '["replacement"]');
    assert.notEqual(key(), firstKey);
    assert.equal(reads, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('missing Codex aggregate roots still load surviving descendants while Claude roots remain absent', () => {
  const file = path.join(tempDir('aggregate-missing-'), 'missing');
  const cache = new AgentSpendCache();
  let reads = 0;
  const load = () => {
    reads++;
    return { models: [{ model: 'one', usage: usage(20) }], found: false, partial: true, effort: null };
  };
  for (const nonFile of [false, true]) {
    if (nonFile) fs.mkdirSync(file);
    const spend = readChildSpend(
      cache,
      file,
      'completed',
      'codex-aggregate\n["child"]\nchild:20:0',
      load,
      '',
      true,
      10_000,
    );
    assert.equal(spend.models[0]?.usage.input, 20);
    assert.equal(spend.partial, true);
    assert.equal(cache.read(file, load).models.length, 0);
  }
  assert.equal(reads, 2);
});
