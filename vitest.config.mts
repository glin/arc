import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: [fileURLToPath(new URL('./extension/test/temp-run.ts', import.meta.url))],
    globals: true,
    include: ['plugins/**/*.test.js', 'scripts/**/*.test.js', 'test/**/*.test.js'],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    strictTags: true,
    tags: [
      {
        name: 'subprocess',
        description:
          'Starts real processes such as Git Bash, git, node, or an installer. These tests run in the test:subprocess lane.',
        // One process start costs 0.4 to 1.2 s on a loaded Windows machine, and one installer run starts about twenty.
        timeout: 120_000,
      },
    ],
  },
});
