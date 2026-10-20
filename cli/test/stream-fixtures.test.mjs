import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { auditStreams } from './fixtures/stream/audit-core.mjs';

const directory = fileURLToPath(new URL('./fixtures/stream/', import.meta.url));
const audit = join(directory, 'audit.mjs');
const keys = new Set(
  'type subtype session_id model tools timestamp parent_tool_use_id message id role usage input_tokens cache_creation_input_tokens cache_read_input_tokens cache_creation ephemeral_5m_input_tokens ephemeral_1h_input_tokens output_tokens content name thinking signature is_error num_turns duration_ms duration_api_ms ttft_ms total_cost_usd permission_denials modelUsage inputTokens outputTokens thinkingTokens cacheReadInputTokens cacheCreationInputTokens costUSD api_error_status terminal_reason subagent_stats tool_name requests tool_calls cost_usd uncached cache_write_5m cache_write_1h cache_read total run turns client_cost_usd subagent_requests expiries rebuild_tokens rebuild_usd cache cache_read_share denials schemaVersion source kind sessionId parent children combined subagentRequests toolCalls costUsd cacheWrite5m cacheWrite1h cacheRead reasoningOutputTokens cacheReadShare writeWarning writeShare writeUsd expiryReturns returnInputTokens returnInputUsd longestExpiryGapSeconds models canonical clientCostUsd priceMultiplier priced contextWindow costByType output avgInputPerRequest contextFirst contextMax durationMs durationApiMs ttftMs isError error status terminalReason subagents spawned completed failed byType parentToolUseId Read Grep Bash'.split(
    ' ',
  ),
);
const values = new Set([
  'system',
  'init',
  'assistant',
  'user',
  'result',
  'success',
  'error_during_execution',
  'tool_use',
  'thinking',
  'Read',
  'Grep',
  'Bash',
  'rate_limit_error',
  'error',
  'completed',
  'claude-stream',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-unknown-9',
  'us.anthropic.claude-opus-5-5[1m]',
  'global.anthropic.claude-opus-5-5[1m]',
]);

function inspect(value) {
  if (Array.isArray(value)) return value.forEach(inspect);
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(keys.has(key) || values.has(key), `unexpected key: ${key}`);
      inspect(item);
    }
  } else if (typeof value === 'string') {
    assert.ok(
      values.has(value) ||
        /^00000000-0000-4000-8000-0000000000\d\d$/.test(value) ||
        /^(?:msg|toolu|req)_\d{20}$/.test(value) ||
        /^2026-01-01T00:0[0-5]:\d\d\.000Z$/.test(value) ||
        value === '',
      `unexpected string: ${value}`,
    );
  }
}

test('stream corpus contains only synthetic allowlisted strings', () => {
  const files = readdirSync(directory).filter((name) => /\.jsonl?$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(directory, file), 'utf8');
    if (file.endsWith('.jsonl'))
      text
        .trim()
        .split('\n')
        .forEach((line) => inspect(JSON.parse(line)));
    else inspect(JSON.parse(text));
  }
});

test('the allowlist rejects an injected real-looking id', () => {
  const copy = JSON.parse(readFileSync(join(directory, 'one-request.json'), 'utf8'));
  copy[0].session_id = '4a6d7c8e-1234-4567-89ab-1234567890ab';
  expect(() => inspect(copy)).toThrow(/unexpected string/);
});

test('stream expectations keep unavailable evidence unknown', () => {
  const subagent = JSON.parse(readFileSync(join(directory, 'subagent.expected.json'), 'utf8'));
  expect(subagent.parent.models[0].clientCostUsd).toBeNull();
  expect(subagent.children[0].models[0].clientCostUsd).toBeNull();
  expect(subagent.combined.models[0].clientCostUsd).toBe(0.0016);
  expect(subagent.run.clientCostUsd).toBe(0.0016);

  const noBoundary = JSON.parse(readFileSync(join(directory, 'five-requests.expected.json'), 'utf8'));
  expect(noBoundary.parent.cache.expiryReturns).toBeNull();
  expect(noBoundary.parent.cache.returnInputTokens).toBeNull();
  expect(noBoundary.parent.cache.returnInputUsd).toBeNull();

  const sameTurn = JSON.parse(readFileSync(join(directory, 'same-turn-gap.expected.json'), 'utf8'));
  expect(sameTurn.parent.cache.expiryReturns).toBe(0);
});

// The audit compares expected files with a command's output. These cases run the comparison in
// process with the command replaced by a reader of the expected files, so each case starts no process.
function readExpected(expectedDirectory) {
  return (invocation) => {
    const fixture = basename(invocation[invocation.length - 1]);
    const file = fixture.replace(/\.jsonl?$/, '.expected.json');
    return {
      status: 0,
      stdout: readFileSync(join(expectedDirectory, file), 'utf8'),
      stderr: '',
    };
  };
}

function copyFixtures(temp, filter = () => true) {
  for (const file of readdirSync(directory).filter((name) => /\.jsonl?$/.test(name) && filter(name))) {
    copyFileSync(join(directory, file), join(temp, file));
  }
}

test('stream audit rejects changed expected values', () => {
  const temp = mkdtempSync(join(tmpdir(), 'arc-stream-audit-'));
  try {
    copyFixtures(temp, (name) => /^(?:one-request|bedrock-regional)\./.test(name));
    const audit = () =>
      auditStreams({
        directory: temp,
        command: ['reader', '{}'],
        execute: readExpected(directory),
      });
    assert.deepEqual(audit(), []);
    const expectedPath = join(temp, 'one-request.expected.json');
    const changed = JSON.parse(readFileSync(expectedPath, 'utf8'));
    changed.parent.requests = 999;
    writeFileSync(expectedPath, JSON.stringify(changed));
    assert.deepEqual(audit(), ['one-request parent.requests: expected 999, actual 1']);
    const bedrockPath = join(temp, 'bedrock-regional.expected.json');
    const bedrock = JSON.parse(readFileSync(bedrockPath, 'utf8'));
    bedrock.parent.costUsd = 0.008;
    writeFileSync(bedrockPath, JSON.stringify(bedrock));
    assert.deepEqual(audit(), [
      'bedrock-regional parent.costUsd: expected 0.008, actual 0.0088',
      'one-request parent.requests: expected 999, actual 1',
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('stream audit command prints each mismatch and exits with the failure status', { tags: ['subprocess'] }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'arc-stream-audit-cli-'));
  try {
    copyFixtures(temp, (name) => name.startsWith('one-request'));
    const command = join(temp, 'expected.mjs');
    writeFileSync(
      command,
      `import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const fixture = basename(process.argv[2]).replace(/\\.jsonl?$/, '.expected.json');
process.stdout.write(readFileSync(join(${JSON.stringify(directory)}, fixture), 'utf8'));`,
    );
    const expectedPath = join(temp, 'one-request.expected.json');
    writeFileSync(expectedPath, readFileSync(join(directory, 'one-request.expected.json')));
    const invocation = [audit, '--fixtures', temp, '--', process.execPath, command, '{}', '--fixtures', '--map'];
    const baseline = spawnSync(process.execPath, invocation, {
      encoding: 'utf8',
    });
    assert.equal(baseline.status, 0, baseline.stderr);
    const changed = JSON.parse(readFileSync(expectedPath, 'utf8'));
    changed.parent.requests = 999;
    writeFileSync(expectedPath, JSON.stringify(changed));
    const run = spawnSync(process.execPath, invocation, { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /one-request parent.requests: expected 999, actual 1/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('stream audit rejects missing input and expected files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'arc-stream-audit-empty-'));
  try {
    const audit = () =>
      auditStreams({
        directory: temp,
        command: ['reader', '{}'],
        execute: readExpected(directory),
      });
    assert.deepEqual(audit(), ['No expected stream fixtures found']);
    copyFileSync(join(directory, 'one-request.json'), join(temp, 'one-request.json'));
    copyFileSync(join(directory, 'five-requests.json'), join(temp, 'five-requests.json'));
    copyFileSync(join(directory, 'one-request.expected.json'), join(temp, 'one-request.expected.json'));
    assert.deepEqual(audit(), ['five-requests has no expected file']);
    rmSync(join(temp, 'five-requests.json'));
    copyFileSync(join(directory, 'five-requests.expected.json'), join(temp, 'five-requests.expected.json'));
    assert.deepEqual(audit(), ['five-requests has no input file']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
