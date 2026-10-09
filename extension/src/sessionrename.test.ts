import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SESSION_NAME_LIMIT,
  answerSessionRename,
  confirmClaudeRename,
  renameInitialCodexSession,
  requestSessionRename,
  sessionRenameOpening,
  sessionRenameTitle,
} from './sessionrename.ts';

test('a session name is cleaned by the shared name rule and an empty one is refused', () => {
  assert.equal(sessionRenameTitle('  A\n session   name  '), 'A session name');
  assert.equal(sessionRenameTitle('x'.repeat(SESSION_NAME_LIMIT + 20))?.length, SESSION_NAME_LIMIT);
  assert.equal(sessionRenameTitle(' \n\t '), null);
  assert.equal(sessionRenameTitle('​'), null);
  assert.equal(sessionRenameTitle(7), null);
});

test('Claude rename confirmation rejects a false success and accepts a later match', async () => {
  const titles = ['other name', 'Complete name'];
  await confirmClaudeRename('Complete name', () => titles.shift() ?? null, { pause: async () => undefined });
  await assert.rejects(
    confirmClaudeRename('Complete name', () => 'other name', {
      attempts: 2,
      pause: async () => undefined,
    }),
    /did not save/,
  );
});

test('a rename request cleans once, refuses a blank name or a draft, and keeps failed text', async () => {
  const sent: string[] = [];
  const cleaned = await requestSessionRename(`  ${'x'.repeat(SESSION_NAME_LIMIT + 20)}  `, true, async (title) => {
    sent.push(title);
  });
  assert.equal(cleaned.error, '');
  assert.equal(cleaned.title.length, SESSION_NAME_LIMIT);
  assert.deepEqual(sent, [cleaned.title]);
  const never = async () => {
    throw new Error('must not run');
  };
  assert.deepEqual(await requestSessionRename(' \n ', true, never), { title: ' \n ', error: 'Enter a name.' });
  assert.deepEqual(await requestSessionRename('Draft name', false, never), {
    title: 'Draft name',
    error: 'This session is no longer available.',
  });
  assert.deepEqual(
    await requestSessionRename('Edited name', true, async () => {
      throw new Error('provider refused');
    }),
    { title: 'Edited name', error: 'provider refused' },
  );
});

test('the rename editor opens on the full name, not the shortened card label', () => {
  assert.deepEqual(sessionRenameOpening('s1', { label: 'The complete…', fullLabel: 'The complete session name' }), {
    type: 'openSessionRename',
    session: 's1',
    title: 'The complete session name',
  });
  // The host posts the message built by sessionRenameOpening.
  const host = fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8');
  assert.match(host, /this\.post\(sessionRenameOpening\(sessionId, this\.sessionLabel\(session\)\)\)/);
});

test('a rename request is always answered, even when the rename throws before it answers', async () => {
  const sent: unknown[] = [];
  const ask = { session: 's1', request: 4, title: 'Typed name' };
  await answerSessionRename(
    ask,
    async () => {
      throw new TypeError('catalog is gone');
    },
    (message) => {
      sent.push(message);
    },
  );
  assert.deepEqual(sent, [
    {
      type: 'sessionRenameResult',
      session: 's1',
      request: 4,
      title: 'Typed name',
      error: 'The session was not renamed.',
    },
  ]);
  await answerSessionRename(
    { ...ask, request: 5 },
    async () => ({ title: 'Typed name', error: '' }),
    (message) => {
      sent.push(message);
    },
  );
  assert.deepEqual(sent.at(-1), {
    type: 'sessionRenameResult',
    session: 's1',
    request: 5,
    title: 'Typed name',
    error: '',
  });
  const host = fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8');
  assert.match(
    host,
    /renameSession: async \(msg\) => \{\s*await answerSessionRename\(/,
    'the host answers a rename outside the helper that always answers',
  );
});

test('session rename adds no Claude Agent SDK dependency', () => {
  const extension = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'], undefined);
  assert.equal(manifest.devDependencies?.['@anthropic-ai/claude-agent-sdk'], undefined);
  for (const file of ['src/sessionrename.ts', 'src/agenthost.ts', 'src/claudewire.ts', 'src/extension.ts']) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(extension, file), 'utf8'),
      /claude-agent-sdk/,
      `${file} renames a session through the Claude Agent SDK`,
    );
  }
});

test('initial Codex naming preserves unrelated refusals and bounds empty-rollout retries to the accepted identity', async () => {
  vi.useFakeTimers();
  try {
    const session = '01a11dea-0d57-7c20-aae4-73e85aa349a5';
    const empty = (id: string) =>
      new Error(
        `failed to set thread name: Fatal error: failed to update thread metadata ${id}: thread-store internal error: failed to read session metadata C:/sessions/rollout-${id}.jsonl: rollout at C:/sessions/rollout-${id}.jsonl is empty`,
      );
    for (const error of [new Error('name refused'), empty('foreign-session'), new Error('rollout is empty')]) {
      const rename = vi.fn<() => Promise<void>>(async () => {
        throw error;
      });
      await assert.rejects(renameInitialCodexSession(session, rename), (caught) => caught === error);
      assert.equal(rename.mock.calls.length, 1);
    }
    const error = empty(session);
    const rename = vi.fn<() => Promise<void>>(async () => {
      throw error;
    });
    const pending = assert.rejects(renameInitialCodexSession(session, rename), (caught) => caught === error);
    await vi.runAllTimersAsync();
    await pending;
    assert.equal(rename.mock.calls.length, 40);
  } finally {
    vi.useRealTimers();
  }
});
