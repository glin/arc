import assert from 'node:assert';
import { test } from 'vitest';
import { tempDir } from './temproot.ts';
import { claudeCheckLaunch } from '../scripts/demo-catalog-check.ts';

test('catalog check launches Claude without user settings or personal model and effort variables', () => {
  const inherited = {
    PATH: '/bin',
    ANTHROPIC_MODEL: 'haiku',
    anthropic_default_haiku_model: 'haiku',
    ANTHROPIC_DEFAULT_MODEL: 'haiku',
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Personal',
    CLAUDE_EFFORT: 'high',
    Claude_Code_Effort_Level: 'high',
    CLAUDE_CODE_SESSION_ID: 'parent',
  };
  const launch = claudeCheckLaunch(tempDir('catalog-check-'), inherited, {
    ANTHROPIC_MODEL: 'opus',
  });
  const at = launch.args.indexOf('--setting-sources');
  assert.equal(launch.args[at + 1], 'project,local');
  assert.deepEqual(
    Object.keys(launch.env).filter((key) => /model|effort|session_id/i.test(key)),
    [],
  );
  assert.equal(launch.env.PATH, '/bin');
});
