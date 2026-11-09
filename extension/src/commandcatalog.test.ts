import assert from 'node:assert';
import { test, vi } from 'vitest';
import * as path from 'node:path';
import { PromptEntry } from './agentwire.ts';
import {
  CommandCatalogs,
  CommandDiscovery,
  commandScope,
  commandConfiguration,
  commandSources,
} from './commandcatalog.ts';

const native: PromptEntry = {
  kind: 'command',
  name: 'compact',
  description: 'Compact the session',
  argumentHint: '',
};

const skill = (name: string): PromptEntry => ({
  kind: 'skill',
  name,
  description: `${name} description`,
  argumentHint: '',
});

test('optional commands retain supplying child generations across idle catalogs, replacement and retirement', () => {
  const catalogs = new CommandCatalogs();
  const supplied = (release: string) => ({
    ...skill('arc-sessions'),
    sessionSkillRelease: release,
    path: `/${release}/SKILL.md`,
  });
  let sources = [
    {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      key: 'one',
      usageSource: 1,
      sessionId: 'first',
      commands: [supplied('one')],
    },
    {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      key: 'two',
      usageSource: 2,
      sessionId: 'second',
      commands: [supplied('two')],
    },
    {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      key: 'plain',
      usageSource: 3,
      sessionId: 'plain',
      commands: [],
    },
  ];
  for (const source of sources) catalogs.publish(sources, { ...source, complete: true });
  catalogs.publish(sources, {
    agent: 'claude',
    commandScope: 'claude',
    commandOutcome: 'success' as const,
    commands: [native, supplied('idle')],
    complete: true,
  });
  assert.deepEqual(catalogs.current().claude, [native]);
  assert.equal(catalogs.childCommands(sources).first[0].path, '/one/SKILL.md');
  assert.equal(catalogs.childCommands(sources).second[0].path, '/two/SKILL.md');
  assert.deepEqual(catalogs.childCommands(sources).plain, []);
  catalogs.publish(sources, { ...sources[0], commands: [], complete: true, optionalOnly: true });
  assert.deepEqual(catalogs.current().claude, [native], 'optional admission must retain ordinary provider fallback');
  assert.deepEqual(catalogs.childCommands(sources).first, []);
  assert.equal(catalogs.childCommands(sources).second[0].path, '/two/SKILL.md');
  sources = sources.map((source) =>
    source.key === 'one' ? { ...source, usageSource: 4, commands: [supplied('replacement')] } : source,
  );
  catalogs.publish(sources, { ...sources[0], complete: true });
  catalogs.publish(sources, {
    agent: 'claude',
    commandScope: 'claude',
    commandOutcome: 'success' as const,
    key: 'one',
    usageSource: 1,
    commands: [supplied('stale')],
    complete: true,
  });
  assert.equal(catalogs.childCommands(sources).first[0].path, '/replacement/SKILL.md');
  catalogs.publish(sources.slice(1));
  assert.equal(catalogs.childCommands(sources).first, undefined);
  assert.equal(catalogs.childCommands(sources).second[0].path, '/two/SKILL.md');
});

test('a command list republished with only its built-in flag changed publishes again', () => {
  const catalogs = new CommandCatalogs();
  const entry = (builtin?: boolean): PromptEntry => ({ ...native, ...(builtin === undefined ? {} : { builtin }) });
  catalogs.publish([], {
    agent: 'claude',
    commandScope: 'claude',
    commandOutcome: 'success' as const,
    commands: [entry()],
    complete: true,
  });
  assert.equal(
    catalogs.publish([], {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      commands: [entry()],
      complete: true,
    }),
    null,
  );
  const flagged = catalogs.publish([], {
    agent: 'claude',
    commandScope: 'claude',
    commandOutcome: 'success' as const,
    commands: [entry(true)],
    complete: true,
  });
  assert.equal(flagged?.claude[0].builtin, true);
  assert.equal(
    catalogs.publish([], {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      commands: [entry(true)],
      complete: true,
    }),
    null,
  );
  assert.equal(
    catalogs.publish([], {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      commands: [entry(false)],
      complete: true,
    })?.claude[0].builtin,
    false,
  );
  const supplied = (builtin?: boolean): PromptEntry => ({ ...entry(builtin), sessionSkillRelease: 'one' });
  const sources = [
    {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      key: 'one',
      usageSource: 1,
      sessionId: 'first',
      commands: [supplied()],
    },
  ];
  const publishSupplied = (builtin?: boolean) =>
    catalogs.publish(sources, { ...sources[0], commands: [supplied(builtin)], complete: true });
  publishSupplied();
  assert.equal(publishSupplied(), null);
  assert.notEqual(publishSupplied(true), null, 'a supplied command that gains the flag is a change');
});

test('a complete live command catalog wins over older sibling state and publishes once', () => {
  const catalogs = new CommandCatalogs();
  const sibling = {
    agent: 'codex',
    commandScope: 'codex',
    commandOutcome: 'success' as const,
    commands: [native, skill('old')],
  };

  const published = catalogs.publish([sibling], {
    agent: 'codex',
    commandScope: 'codex',
    commandOutcome: 'success' as const,
    commands: [native, skill('current')],
    complete: true,
  });
  assert.deepEqual(
    published?.codex.map((entry) => entry.name),
    ['compact', 'current'],
  );
  assert.equal(
    catalogs.publish([sibling], {
      agent: 'codex',
      commandScope: 'codex',
      commandOutcome: 'success' as const,
      commands: [native, skill('current')],
      complete: true,
    }),
    null,
  );
});

test('a delayed idle command catalog cannot replace a newer live refresh', () => {
  const catalogs = new CommandCatalogs();
  catalogs.publish([], {
    agent: 'codex',
    commandScope: 'codex',
    commandOutcome: 'success' as const,
    commands: [native, skill('old')],
    complete: true,
  });
  const idleRevision = catalogs.revision('codex');
  catalogs.publish([], {
    agent: 'codex',
    commandScope: 'codex',
    commandOutcome: 'success' as const,
    commands: [native, skill('current')],
    complete: true,
  });

  assert.equal(
    catalogs.publish(
      [],
      {
        agent: 'codex',
        commandScope: 'codex',
        commandOutcome: 'success' as const,
        commands: [native, skill('idle')],
        complete: false,
      },
      idleRevision,
    ),
    null,
  );
  assert.deepEqual(
    catalogs.current().codex.map((entry) => entry.name),
    ['compact', 'current'],
  );
});

test('a complete command catalog can remove the last skill', () => {
  const catalogs = new CommandCatalogs();
  catalogs.publish([], {
    agent: 'codex',
    commandScope: 'codex',
    commandOutcome: 'success' as const,
    commands: [native, skill('old')],
    complete: true,
  });

  const published = catalogs.publish([], {
    agent: 'codex',
    commandScope: 'codex',
    commandOutcome: 'success' as const,
    commands: [native],
    complete: true,
  });
  assert.deepEqual(
    published?.codex.map((entry) => entry.name),
    ['compact'],
  );
});

test('a read-only child reports a shorter list without replacing the skills on the commands or ready event', () => {
  const full = [native, skill('close-session'), skill('deep-research')];
  const narrow = [native, skill('deep-research')];
  const policies: Record<string, unknown> = { readonly: { readOnly: true, readTools: [] } };
  const policyOf = (key: string) => policies[key];
  const states = [
    {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      key: 'ordinary',
      usageSource: 1,
      sessionId: 'a',
      commands: full,
    },
    {
      agent: 'claude',
      commandScope: 'claude',
      commandOutcome: 'success' as const,
      key: 'readonly',
      usageSource: 2,
      sessionId: 'b',
      commands: narrow,
    },
  ];
  const sources = commandSources(states, policyOf);
  const names = (catalogs: CommandCatalogs) => catalogs.current().claude?.map((entry) => entry.name);
  assert.deepEqual(
    sources.map((source) => source.restricted),
    [false, true],
  );

  const catalogs = new CommandCatalogs();
  catalogs.publish(sources, { ...sources[0], complete: true });
  assert.deepEqual(names(catalogs), ['compact', 'close-session', 'deep-research']);
  const revision = catalogs.revision('claude');
  // The commands event, then the ready event, of the read-only child.
  catalogs.publish(sources, { ...sources[1], complete: true });
  catalogs.publish(sources, { ...sources[1], complete: false });
  assert.deepEqual(names(catalogs), ['compact', 'close-session', 'deep-research']);
  assert.equal(catalogs.revision('claude'), revision, 'a restricted update must not supersede an idle read');
  assert.ok(
    catalogs.publish(
      sources,
      {
        agent: 'claude',
        commandScope: 'claude',
        commandOutcome: 'success' as const,
        commands: narrow,
        complete: false,
      },
      revision,
    ),
  );

  // An ordinary child still replaces the list, so the list stays last-writer-wins.
  const later = new CommandCatalogs();
  later.publish(sources, { ...sources[1], complete: true });
  later.publish(sources, { ...sources[0], complete: true });
  assert.deepEqual(names(later), ['compact', 'close-session', 'deep-research']);
  later.publish(sources, { ...sources[0], commands: [native], complete: true });
  assert.deepEqual(names(later), ['compact']);
});

test('a read-only child as the only live child leaves the idle read to seed the provider list', () => {
  const full = [native, skill('close-session'), skill('deep-research')];
  const narrow = [native, skill('deep-research')];
  const policyOf = (key: string) => (key === 'readonly' ? { readOnly: true, readTools: [] } : undefined);
  const readOnly = {
    agent: 'claude',
    commandScope: 'claude',
    commandOutcome: 'success' as const,
    key: 'readonly',
    usageSource: 2,
    sessionId: 'b',
    commands: narrow,
  };
  const ordinary = {
    agent: 'claude',
    commandScope: 'claude',
    commandOutcome: 'success' as const,
    key: 'ordinary',
    usageSource: 1,
    sessionId: 'a',
    commands: full,
  };
  const sources = commandSources([readOnly], policyOf);

  // The fallback loop does not seed the list from the restricted child, and neither does its update.
  const catalogs = new CommandCatalogs();
  catalogs.publish(sources);
  catalogs.publish(sources, { ...sources[0], complete: true });
  assert.equal(catalogs.current().claude, undefined);

  // The idle read then answers and seeds the list.
  const revision = catalogs.revision('claude');
  const seeded = catalogs.publish(
    sources,
    { agent: 'claude', commandScope: 'claude', commandOutcome: 'success' as const, commands: full, complete: false },
    revision,
  );
  assert.deepEqual(
    seeded?.claude.map((entry) => entry.name),
    ['compact', 'close-session', 'deep-research'],
  );

  // An ordinary sibling still seeds the list through the fallback loop.
  const fresh = new CommandCatalogs();
  assert.deepEqual(
    fresh.publish(commandSources([readOnly, ordinary], policyOf))?.claude.map((entry) => entry.name),
    ['compact', 'close-session', 'deep-research'],
  );
});

test('draft discovery keeps successful scoped skills after fallback and rejects only older results in that scope', () => {
  const catalogs = new CommandCatalogs();
  const a = commandScope('codex', '/work/a', 'configuration');
  const b = commandScope('codex', '/work/b', 'configuration');
  catalogs.publish([], {
    agent: 'codex',
    commandScope: a,
    commands: [skill('a')],
    complete: true,
    commandOutcome: 'success',
  });
  const revision = catalogs.revision(a);
  catalogs.publish([], {
    agent: 'codex',
    commandScope: b,
    commands: [skill('b')],
    complete: true,
    commandOutcome: 'success',
  });
  assert.ok(
    catalogs.publish(
      [],
      { agent: 'codex', commandScope: a, commandOutcome: 'success', commands: [skill('fresh-a')], complete: true },
      revision,
    ),
  );
  catalogs.publish([], {
    agent: 'codex',
    commandScope: a,
    commands: [native],
    complete: true,
    commandOutcome: 'failed',
  });
  catalogs.publish([], { agent: 'codex', commandScope: a, commands: [], complete: true, commandOutcome: 'unanswered' });
  assert.deepEqual(
    catalogs.current()[a].map((entry) => entry.name),
    ['fresh-a'],
  );
  assert.deepEqual(
    catalogs.current()[b].map((entry) => entry.name),
    ['b'],
  );
  assert.equal(
    catalogs.publish(
      [],
      { agent: 'codex', commandScope: a, commandOutcome: 'success', commands: [skill('old-a')], complete: true },
      revision,
    ),
    null,
  );
});

test('draft discovery scope follows platform folder rules and resolved executable configuration', () => {
  for (const rules of [path.win32, path.posix]) {
    const upper = rules === path.win32 ? 'C:/Work/Project' : '/Work/Project';
    const lower = rules === path.win32 ? 'c:/work/project' : '/work/project';
    assert.equal(
      commandScope('codex', upper, 'one', rules) === commandScope('codex', lower, 'one', rules),
      rules === path.win32,
    );
    assert.notEqual(commandScope('codex', upper, 'one', rules), commandScope('codex', upper, 'two', rules));
    assert.notEqual(commandScope('codex', upper, 'one', rules), commandScope('claude', upper, 'one', rules));
  }
  const launch = { command: 'node', leadingArgs: ['/codex.js'], env: { SECOND: '2', FIRST: '1' } };
  assert.equal(commandConfiguration(launch), commandConfiguration({ ...launch, env: { FIRST: '1', SECOND: '2' } }));
  assert.notEqual(commandConfiguration(launch), commandConfiguration({ ...launch, leadingArgs: ['/other.js'] }));
  assert.notEqual(commandConfiguration(launch), commandConfiguration({ ...launch, env: { FIRST: 'changed' } }));
});

test('draft discovery shares one read and retries once after failure and confirmed exit', async () => {
  vi.useFakeTimers();
  const discovery = new CommandDiscovery();
  let exit!: (outcome: 'failed') => void;
  let calls = 0;
  const read = vi.fn<() => Promise<'failed' | 'success'>>(() => {
    calls++;
    return calls === 1
      ? new Promise<'failed'>((resolve) => {
          exit = resolve;
        })
      : Promise.resolve('success' as const);
  });
  try {
    const first = discovery.request('scope', read, false, 'first');
    assert.equal(discovery.request('scope', read, false, 'second'), first);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(calls, 1, 'recovery ran before the failed child exited');
    exit('failed');
    await first;
    await vi.advanceTimersByTimeAsync(999);
    assert.equal(calls, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(calls, 2);
    await vi.advanceTimersByTimeAsync(10_000);
    await discovery.request('scope', read, false, 'first');
    assert.equal(calls, 2);
  } finally {
    discovery.dispose();
    vi.useRealTimers();
  }
});

test.each(['failed', 'throw'])(
  'draft discovery stops after two failures and explicit refresh starts another cycle for %s',
  async (failure) => {
    vi.useFakeTimers();
    const discovery = new CommandDiscovery();
    const read = vi.fn<() => Promise<'failed'>>(async () => {
      if (failure === 'throw') throw new Error('opening failed');
      return 'failed';
    });
    try {
      await discovery.request('scope', read);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await discovery.request('scope', read);
      assert.equal(read.mock.calls.length, 2);
      await discovery.request('scope', read, true);
      assert.equal(read.mock.calls.length, 3);
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(read.mock.calls.length, 4);
    } finally {
      discovery.dispose();
      vi.useRealTimers();
    }
  },
);

test('draft discovery cancellation, scope replacement and disposal cancel unsent retries', async () => {
  vi.useFakeTimers();
  try {
    for (const end of ['cancel', 'replace', 'close', 'dispose']) {
      const discovery = new CommandDiscovery();
      const read = vi.fn<() => Promise<'failed'>>(async () => 'failed');
      await discovery.request('a', read, false, 'draft');
      if (end === 'cancel') discovery.cancel('draft');
      if (end === 'replace') await discovery.request('b', async () => 'success', false, 'draft');
      if (end === 'close') discovery.cancelAll();
      if (end === 'dispose') discovery.dispose();
      await vi.advanceTimersByTimeAsync(2_000);
      assert.equal(read.mock.calls.length, 1, end);
      await discovery.request('a', read, false, 'draft');
      assert.equal(
        read.mock.calls.length,
        end === 'dispose' ? 1 : 2,
        'an authorized request did not restart cancelled discovery',
      );
      discovery.dispose();
    }
  } finally {
    vi.useRealTimers();
  }
});

test.each(['abandon', 'close'])(
  'draft discovery waits for aborted exit before an authorized same-directory request after %s',
  async (end) => {
    const discovery = new CommandDiscovery();
    let exit!: (value: 'failed') => void;
    let signal!: AbortSignal;
    const read = vi.fn<(abort: AbortSignal) => Promise<'failed'>>((abort) => {
      signal = abort;
      return new Promise<'failed'>((resolve) => {
        exit = resolve;
      });
    });
    const first = discovery.request('scope', read, false, 'old-draft');
    await vi.waitFor(() => assert.equal(read.mock.calls.length, 1));
    if (end === 'close') discovery.cancelAll();
    else discovery.cancel('old-draft');
    assert.equal(signal.aborted, true);
    const replacement = vi.fn<() => Promise<'success'>>(async () => 'success');
    const later = discovery.request('scope', replacement, false, 'new-draft');
    assert.equal(replacement.mock.calls.length, 0);
    exit('failed');
    await Promise.all([first, later]);
    assert.equal(replacement.mock.calls.length, 1);
    discovery.dispose();
  },
);

test('draft discovery bounds children across scopes and cancels queued owners', async () => {
  const discovery = new CommandDiscovery();
  const exits: Array<() => void> = [];
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const requests = ['a', 'b', 'c', 'd', 'e'].map((scope) =>
    discovery.request(scope, async () => {
      started.push(scope);
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => exits.push(resolve));
      active--;
      return 'success';
    }),
  );
  await vi.waitFor(() => assert.equal(started.length, 2));
  assert.deepEqual(started, ['a', 'b']);
  discovery.cancel('c');
  exits.shift()!();
  await vi.waitFor(() => assert.equal(started.length, 3));
  assert.deepEqual(started, ['a', 'b', 'd']);
  exits.shift()!();
  await vi.waitFor(() => assert.equal(started.length, 4));
  assert.deepEqual(started, ['a', 'b', 'd', 'e']);
  for (const exit of exits) exit();
  await Promise.all(requests);
  assert.equal(peak, 2);
  discovery.dispose();
});
