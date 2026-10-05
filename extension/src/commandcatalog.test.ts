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
