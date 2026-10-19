import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { copyWindowsPipe } from '../scripts/windowpipe-build.mjs';
import { sourceIdentity } from '../scripts/source-identity.mjs';

const cliRoot = fileURLToPath(new URL('./', import.meta.url));
const identity = sourceIdentity(path.resolve(cliRoot, '..'));
const output = path.join(cliRoot, 'dist/arc.cjs');

const { version } = JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8'));
copyWindowsPipe(path.join(cliRoot, 'dist'));

await fs.rm(output + '.map', { force: true });

await esbuild.build({
  absWorkingDir: cliRoot,
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  define: {
    ARC_BUILD_COMMIT: JSON.stringify(identity.sourceCommit ?? 'unknown'),
    ARC_BUILD_DIRTY: JSON.stringify(identity.dirty),
    ARC_VERSION: JSON.stringify(version),
  },
  banner: { js: '#!/usr/bin/env node' },
  outfile: 'dist/arc.cjs',
});

await fs.chmod(output, 0o755);
