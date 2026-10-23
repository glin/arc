import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SESSION_NAME_LIMIT,
  InitialNameOperation,
  InitialNameCancelled,
  normalizeInitialSessionNames,
  restoreInitialSessionNames,
  type InitialSessionName,
  answerSessionRename,
  confirmClaudeRename,
  emptyCodexRollout,
  requestSessionRename,
  sessionRenameOpening,
  sessionRenameTitle,
} from './sessionrename.ts';

function initialNameFixture(rename: (current: () => boolean) => Promise<void>, persist?: () => Promise<void>) {
  const item: InitialSessionName = {
    provider: 'codex',
    session: 'accepted',
    activation: 'activation',
    cwd: '/workspace',
    requested: 'Initial name',
    revision: 'revision',
    state: 'pending',
    attempts: 0,
    possibleWrite: false,
  };
  let evidence = '';
  let title: string | undefined;
  let valid = true;
  let disposed = 0;
  let wake = () => {};
  let durable = structuredClone(item);
  const operation = new InitialNameOperation(
    () => item,
    async () => {
      await persist?.();
      durable = structuredClone(item);
    },
    () => valid,
    rename,
  );
  operation.start((changed) => {
    wake = changed;
    return {
      current: () => ({ current: valid, evidence, source: evidence ? 'source' : '', title }),
      dispose: () => {
        disposed++;
      },
    };
  });
  return {
    item,
    operation,
    durable: () => durable,
    disposed: () => disposed,
    advance: (next: string) => {
      evidence = next;
      wake();
    },
    named: (name: string) => {
      title = name;
      wake();
    },
    cancel: () => {
      valid = false;
      operation.changed();
    },
  };
}

const emptyInitialName = (session = 'accepted') =>
  new Error(
    `failed to set thread name: failed to update thread metadata ${session}: rollout at /sessions/rollout-${session}.jsonl is empty`,
  );

test('initial-name recovery requires new exact-session readiness and bounds its requests', async () => {
  let calls = 0;
  const f = initialNameFixture(async () => {
    calls++;
    throw emptyInitialName();
  });
  await vi.waitFor(() => assert.equal(f.durable().possibleWrite, false));
  await vi.waitFor(() => assert.equal(calls, 1));
  for (let attempt = 2; attempt <= 40; attempt++) {
    f.advance(String(attempt));
    await vi.waitFor(() => assert.equal(calls, attempt));
    await vi.waitFor(() => assert.equal(f.item.possibleWrite, false));
  }
  await vi.waitFor(() => assert.equal(f.item.state, 'failed'));
  f.advance('extra');
  assert.equal(calls, 40);
  assert.equal(f.disposed(), 1);
});

test.each([
  ['foreign', 'failed'],
  ['refused', 'failed'],
  ['timeout', 'uncertain'],
] as const)('initial-name recovery preserves %s failure without retry', async (kind, state) => {
  let calls = 0;
  const f = initialNameFixture(async () => {
    calls++;
    throw kind === 'foreign' ? emptyInitialName('another') : new Error(kind);
  });
  await vi.waitFor(() => assert.equal(f.item.state, state));
  f.advance('readable');
  assert.equal(calls, 1);
});

test('initial-name submission requires a durable possible write and records uncertain persistence', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = initialNameFixture(
    async () => {
      calls++;
    },
    () => held,
  );
  assert.equal(calls, 0);
  assert.equal(f.durable().possibleWrite, false);
  release();
  await vi.waitFor(() => assert.equal(f.item.state, 'saved'));
  assert.equal(calls, 1);
  let resultWrites = 0;
  const lostResult = initialNameFixture(
    async () => {},
    async () => {
      if (++resultWrites === 2) throw new Error('result save refused');
    },
  );
  await vi.waitFor(() => assert.equal(lostResult.item.state, 'uncertain'));
  assert.equal(lostResult.durable().possibleWrite, true);
  assert.equal(lostResult.durable().state, 'pending');
  for (const failureAt of [1, 2]) {
    let writes = 0;
    let attempts = 0;
    const failed = initialNameFixture(
      async () => {
        attempts++;
        throw emptyInitialName();
      },
      async () => {
        if (++writes === failureAt) throw new Error('storage refused');
      },
    );
    await vi.waitFor(() => assert.equal(failed.item.state, 'uncertain'));
    assert.equal(attempts, failureAt - 1);
    const restored = { accepted: failed.durable() };
    restoreInitialSessionNames(restored);
    assert.equal(restored.accepted.state, failureAt === 1 ? 'cancelled' : 'uncertain');
  }
});

test.each(['Initial name', 'Reader name'])(
  'a provider title %s settles recovery without another write',
  async (title) => {
    let calls = 0;
    const f = initialNameFixture(async () => {
      calls++;
      throw emptyInitialName();
    });
    await vi.waitFor(() => assert.equal(calls, 1));
    await vi.waitFor(() => assert.equal(f.item.possibleWrite, false));
    f.named(title);
    await vi.waitFor(() => assert.equal(f.item.state, title === 'Initial name' ? 'saved' : 'cancelled'));
    assert.equal(calls, 1);
  },
);

test.each([
  ['persistence', 'Initial name'],
  ['persistence', 'Reader name'],
  ['host', 'Initial name'],
  ['host', 'Reader name'],
] as const)(
  'a provider title arriving during the %s wait settles %s without an initial write',
  async (boundary, title) => {
    let release = () => {};
    let entered = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitted: string[] = [];
    const wait = async () => {
      entered = true;
      await held;
    };
    const f = initialNameFixture(
      async (current) => {
        if (boundary === 'host') await wait();
        if (!current()) throw new InitialNameCancelled();
        submitted.push('Initial name');
      },
      boundary === 'persistence' ? wait : undefined,
    );
    try {
      await vi.waitFor(() => assert.equal(entered, true));
      f.named(title);
      release();
      await vi.waitFor(() => assert.equal(f.item.state, title === 'Initial name' ? 'saved' : 'cancelled'));
      await vi.waitFor(() => assert.equal(f.durable().state, f.item.state));
      assert.deepEqual(submitted, []);
      assert.equal(f.item.possibleWrite, false);
      assert.equal(f.disposed(), 1);
    } finally {
      release();
      f.operation.cancel();
    }
  },
);

test('cancellation preserves an unanswered write and a queued cancellation proves no write', async () => {
  let refuse = (_error: Error) => {};
  const f = initialNameFixture(
    () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await vi.waitFor(() => assert.equal(f.durable().possibleWrite, true));
  f.operation.cancel();
  assert.equal(f.item.state, 'uncertain');
  refuse(new InitialNameCancelled());
  await vi.waitFor(() => assert.equal(f.item.state, 'cancelled'));
  assert.equal(f.item.possibleWrite, false);
});

test('initial-name state normalization bounds retention and rejects forged identities and attempts', () => {
  const f = initialNameFixture(async () => {});
  f.operation.cancel();
  const item = { ...f.item, state: 'pending' as const };
  const normalized = normalizeInitialSessionNames(
    { wrong: item, accepted: item, invalid: { ...item, session: 'invalid', attempts: 41 } },
    1,
  );
  assert.deepEqual(Object.keys(normalized), ['accepted']);
  restoreInitialSessionNames(normalized);
  assert.equal(normalized.accepted.state, 'uncertain');
});

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

test.each(['C:/sessions', '/Users/reader/.codex/sessions', '/home/reader/.codex/sessions'])(
  'initial naming accepts only the exact empty-rollout refusal from %s',
  (directory) => {
    const session = '01a11dea-0d57-7c20-aae4-73e85aa349a5';
    const error = new Error(
      `failed to set thread name: failed to update thread metadata ${session}: rollout at ${directory}/rollout-${session}.jsonl is empty`,
    );
    assert.equal(emptyCodexRollout(error, session), true);
    assert.equal(emptyCodexRollout(error, 'foreign'), false);
    assert.equal(emptyCodexRollout(new Error('rollout is empty'), session), false);
    assert.equal(emptyCodexRollout(new Error('name refused'), session), false);
  },
);
