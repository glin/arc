import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: [fileURLToPath(new URL('../../../extension/test/temp-run.ts', import.meta.url))],
    include: ['.claude/skills/panel-mockup/mockupscale*.test.ts'],
    // Vitest otherwise starts one worker per core but one. A lane on this machine runs at most four.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});
