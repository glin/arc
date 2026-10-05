import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: [fileURLToPath(new URL('../extension/test/temp-run.ts', import.meta.url))],
    include: ['test/**/*.test.{ts,mjs}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
