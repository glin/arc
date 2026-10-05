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
    // A run that bypasses extension/test.mjs, such as an IDE runner or a bare `npx vitest
    // run`, still needs a cap. extension/test.mjs overrides this for the node lane with its
    // own `--maxWorkers=8` CLI flag, which wins over this config value.
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});
