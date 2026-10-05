// Checks host-built session list cards against the browser contract.
import { test } from 'vitest';
import assert from 'node:assert';
import { railSessions } from '../turnrail.ts';
import type { RailCardView } from './payload-contracts.ts';

// runByAgent is optional, so typechecking cannot detect its omission. Check the host-built card's runtime value.
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
  // Model the wire boundary because the host card lacks RailCardView's index signature.
  const view = card as unknown as RailCardView;
  assert.equal(view.runByAgent, true, 'the host stopped sending runByAgent on an agent-run card');
});
