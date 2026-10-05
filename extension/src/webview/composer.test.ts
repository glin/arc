import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';
import { sendWaitsForStaging } from './composer.ts';

// `createComposerRenderer` renders through Preact into a real document, so its `send` press
// needs a browser to run. These tests cover the decision that press makes through the pure
// function it calls, and a text scan below confirms the press still calls it before it sends.

test('a Codex /rename draft sends while a file stages', () => {
  assert.equal(sendWaitsForStaging('codex', '/rename quest pro root', true), false);
});

test('a Codex plain prompt waits while a file stages', () => {
  assert.equal(sendWaitsForStaging('codex', 'quest pro root', true), true);
});

test('a Claude /rename waits while a file stages, because the Claude CLI runs it as a prompt', () => {
  assert.equal(sendWaitsForStaging('claude', '/rename quest pro root', true), true);
});

test('no draft waits once staging ends', () => {
  assert.equal(sendWaitsForStaging('codex', 'quest pro root', false), false);
  assert.equal(sendWaitsForStaging('claude', '/rename quest pro root', false), false);
  assert.equal(sendWaitsForStaging('codex', '/rename quest pro root', false), false);
});

test('the send press checks sendWaitsForStaging before it posts sendPrompt', () => {
  const source = fs.readFileSync(path.join(__dirname, 'composer.ts'), 'utf8');
  const sendAt = source.indexOf('send(fromKey)');
  assert.ok(sendAt >= 0, 'the send press is no longer named send(fromKey)');
  const sendToHostAt = source.indexOf("sendToHost({ type: 'sendPrompt'", sendAt);
  assert.ok(sendToHostAt > sendAt, 'the send press no longer posts sendPrompt');
  const gate = source.slice(sendAt, sendToHostAt);
  const ifAt = gate.indexOf('if (sendWaitsForStaging(');
  assert.ok(ifAt >= 0, 'the send press no longer refuses the prompt on what sendWaitsForStaging returns');
  const returnAt = gate.indexOf('return false;', ifAt);
  assert.ok(
    returnAt >= 0 && returnAt - ifAt < 120,
    'the send press no longer returns false right after sendWaitsForStaging refuses the prompt',
  );
  assert.equal(
    (gate.match(/isFileStaging\(/g) ?? []).length,
    1,
    'the send press keeps a staging check beside sendWaitsForStaging instead of only inside it',
  );
});
