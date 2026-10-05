import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

let buildCommit = 'unknown';
try {
  buildCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // A packaged build can run without its Git checkout.
}

const { version } = JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8'));

await fs.rm('dist/arc-status.cjs.map', { force: true });

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  define: { ARC_BUILD_COMMIT: JSON.stringify(buildCommit), ARC_VERSION: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
  outfile: 'dist/arc-status.cjs',
});

await fs.chmod('dist/arc-status.cjs', 0o755);
