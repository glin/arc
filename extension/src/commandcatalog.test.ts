import assert from 'node:assert';
import { test } from 'vitest';
import { PromptEntry } from './agentwire.ts';
import { CommandCatalogs, commandSources } from './commandcatalog.ts';

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
    { agent: 'claude', key: 'one', usageSource: 1, sessionId: 'first', commands: [supplied('one')] },
    { agent: 'claude', key: 'two', usageSource: 2, sessionId: 'second', commands: [supplied('two')] },
    { agent: 'claude', key: 'plain', usageSource: 3, sessionId: 'plain', commands: [] },
  ];
  for (const source of sources) catalogs.publish(sources, { ...source, complete: true });
  catalogs.publish(sources, { agent: 'claude', commands: [native, supplied('idle')], complete: true });
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
  catalogs.publish([], { agent: 'claude', commands: [entry()], complete: true });
  assert.equal(catalogs.publish([], { agent: 'claude', commands: [entry()], complete: true }), null);
  const flagged = catalogs.publish([], { agent: 'claude', commands: [entry(true)], complete: true });
  assert.equal(flagged?.claude[0].builtin, true);
  assert.equal(catalogs.publish([], { agent: 'claude', commands: [entry(true)], complete: true }), null);
  assert.equal(
    catalogs.publish([], { agent: 'claude', commands: [entry(false)], complete: true })?.claude[0].builtin,
    false,
  );
  const supplied = (builtin?: boolean): PromptEntry => ({ ...entry(builtin), sessionSkillRelease: 'one' });
  const sources = [{ agent: 'claude', key: 'one', usageSource: 1, sessionId: 'first', commands: [supplied()] }];
  const publishSupplied = (builtin?: boolean) =>
    catalogs.publish(sources, { ...sources[0], commands: [supplied(builtin)], complete: true });
  publishSupplied();
  assert.equal(publishSupplied(), null);
  assert.notEqual(publishSupplied(true), null, 'a supplied command that gains the flag is a change');
});

test('a complete live command catalog wins over older sibling state and publishes once', () => {
  const catalogs = new CommandCatalogs();
  const sibling = { agent: 'codex', commands: [native, skill('old')] };

  const published = catalogs.publish([sibling], {
    agent: 'codex',
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
      commands: [native, skill('current')],
      complete: true,
    }),
    null,
  );
});

test('a delayed idle command catalog cannot replace a newer live refresh', () => {
  const catalogs = new CommandCatalogs();
  catalogs.publish([], { agent: 'codex', commands: [native, skill('old')], complete: true });
  const idleRevision = catalogs.revision('codex');
  catalogs.publish([], { agent: 'codex', commands: [native, skill('current')], complete: true });

  assert.equal(
    catalogs.publish(
      [],
      {
        agent: 'codex',
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
  catalogs.publish([], { agent: 'codex', commands: [native, skill('old')], complete: true });

  const published = catalogs.publish([], { agent: 'codex', commands: [native], complete: true });
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
    { agent: 'claude', key: 'ordinary', usageSource: 1, sessionId: 'a', commands: full },
    { agent: 'claude', key: 'readonly', usageSource: 2, sessionId: 'b', commands: narrow },
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
  assert.ok(catalogs.publish(sources, { agent: 'claude', commands: narrow, complete: false }, revision));

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
  const readOnly = { agent: 'claude', key: 'readonly', usageSource: 2, sessionId: 'b', commands: narrow };
  const ordinary = { agent: 'claude', key: 'ordinary', usageSource: 1, sessionId: 'a', commands: full };
  const sources = commandSources([readOnly], policyOf);

  // The fallback loop does not seed the list from the restricted child, and neither does its update.
  const catalogs = new CommandCatalogs();
  catalogs.publish(sources);
  catalogs.publish(sources, { ...sources[0], complete: true });
  assert.equal(catalogs.current().claude, undefined);

  // The idle read then answers and seeds the list.
  const revision = catalogs.revision('claude');
  const seeded = catalogs.publish(sources, { agent: 'claude', commands: full, complete: false }, revision);
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
