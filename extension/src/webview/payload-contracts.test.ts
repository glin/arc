// extension/src/webview/payload-contracts.test.ts
//
// The tests for payload-contracts.ts.
import { test } from 'vitest';
import assert from 'node:assert';
import { railSessions } from '../turnrail.ts';
import type { RailCardView } from './payload-contracts.ts';

// `RailCardView` declares `runByAgent` beside `archived` and `agentRun`, but a card that
// carries it still satisfies the type without the field present: the type's own index
// signature accepts any extra key. Only a build from the real host path, read back through
// the panel's own contract type, can catch the host dropping the fact.
test('an agent-run session keeps its runByAgent fact on the card the host builds for the panel', () => {
  const session = {
    id: 'agent-1',
    label: 'Agent session',
    agent: 'Claude',
    when: '2:32 PM',
    at: 4200,
    relative: '3 hours ago',
    agentRun: true,
  };
  const [card] = railSessions(
    [session],
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    null,
    new Set(),
    new Map(),
    {},
    {},
  );
  // The host's own `RailCard` carries no index signature, so a straight assignment does not
  // type-check against `RailCardView`; the wire crossing itself is what erases that
  // difference, and this test stands in for it.
  const view = card as unknown as RailCardView;
  assert.equal(view.runByAgent, true, 'the host stopped sending runByAgent on an agent-run card');
});
