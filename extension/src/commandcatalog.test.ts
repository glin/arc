import assert from 'node:assert';
import { test } from 'vitest';
import { PromptEntry } from './agentwire.ts';
import { CommandCatalogs } from './commandcatalog.ts';

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
