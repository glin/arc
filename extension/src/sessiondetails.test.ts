import assert from 'node:assert';
import { test } from 'vitest';
import { resumeCommand } from './domain/resume.ts';
import { drawnSessionCards } from './sessiondetails.ts';

test("resume commands use each terminal tool's stable session identity syntax", () => {
  const claude = '01a032c9-1a92-7931-845c-723117d24dbe';
  const codex = '01a032c9-8581-7942-9262-ab4289a674c4';
  assert.equal(resumeCommand('claude', claude), `claude --resume ${claude}`);
  assert.equal(resumeCommand('codex', codex), `codex resume ${codex}`);
  assert.equal(resumeCommand('claude', 'safe; calc'), null);
  assert.equal(resumeCommand('codex', 'safe && calc'), null);
  assert.equal(resumeCommand('claude', '--dangerously-skip-permissions'), null);
  assert.equal(resumeCommand('claude', 's1'), 'claude --resume s1');
  assert.equal(resumeCommand('agent', claude), null);
});

test('selected mode keeps full details on only the cards that the panel posts', () => {
  const cards = [{ sessionId: 'selected' }, { sessionId: 'hidden' }];
  assert.deepEqual(drawnSessionCards(cards, 'selected'), [{ sessionId: 'selected' }]);
  assert.deepEqual(drawnSessionCards(cards, null), cards);
});
