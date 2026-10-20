import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { vscode: fileURLToPath(new URL('./test/vscode.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globalSetup: [fileURLToPath(new URL('./test/temp-run.ts', import.meta.url))],
    include: ['src/**/*.test.ts'],
    // Cap direct Vitest and IDE runs at four workers.
    // extension/test.mjs sets the lane cap and honors VITEST_MAX_WORKERS.
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    strictTags: true,
    tags: [{ name: 'subprocess', description: 'Builds bundles or exercises real processes.' }],
    restoreMocks: true,
  },
});
