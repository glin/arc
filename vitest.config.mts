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
  },
});
