import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { require as tsRequire } from 'tsx/cjs/api';

// The scoped TypeScript loader lets Node import panelbundle.ts from this build script.
const { browserBundle, browserStylesheet } = tsRequire('./src/panelbundle.ts', import.meta.url);

// panelbundle.ts supplies the browser program and stylesheet to production builds and test pages.
// Development builds select Vite without parsing browser sources.
const PANEL_CSS = 'src/webview/panel.css';

function panelText(developmentServerUrl) {
  const worker = esbuild.buildSync({
    entryPoints: ['src/progressiveworker-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    minify: true,
    metafile: true,
  });
  const workerSource = brotliCompressSync(worker.outputFiles[0].text).toString('base64');
  if (developmentServerUrl !== null) {
    return {
      defines: {
        PANEL_CSS: JSON.stringify(''),
        PANEL_JS: JSON.stringify(''),
        PANEL_DEV_SERVER_URL: JSON.stringify(developmentServerUrl),
        PROGRESSIVE_WORKER_BROTLI: JSON.stringify(workerSource),
      },
      inputs: Object.keys(worker.metafile.inputs),
    };
  }
  const browser = browserBundle();
  return {
    defines: {
      PANEL_CSS: JSON.stringify(browserStylesheet()),
      PANEL_JS: JSON.stringify(browser.text),
      PANEL_DEV_SERVER_URL: 'null',
      PROGRESSIVE_WORKER_BROTLI: JSON.stringify(workerSource),
    },
    inputs: [...new Set([PANEL_CSS, ...browser.inputs, ...Object.keys(worker.metafile.inputs)])],
  };
}

function manifestVersion() {
  return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
}

function sourceIdentity() {
  const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const unavailable = { sourceCommit: null, dirty: null };
  if (!fs.existsSync(path.join(root, '.git'))) return unavailable;
  try {
    const git = (args) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) return unavailable;
    return {
      sourceCommit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain']) !== '',
    };
  } catch {
    return unavailable;
  }
}

async function createBuildContext(developmentServerUrl) {
  const panel = panelText(developmentServerUrl);
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    sourcemap: true,
    minify: true,
    keepNames: true,
    metafile: true,
    define: { ...panel.defines, EXTENSION_VERSION: JSON.stringify(manifestVersion()) },
  });
  return { context, inputs: panel.inputs };
}

export async function buildExtension({ watch = false, developmentServerUrl = null } = {}) {
  if (watch) fs.rmSync('dist/build-identity.json', { force: true });
  let current = await createBuildContext(developmentServerUrl);
  if (!watch) {
    const result = await current.context.rebuild();
    const inputs = [
      ...new Set(
        [
          ...current.inputs,
          ...Object.keys(result.metafile.inputs),
          'package.json',
          'esbuild.mjs',
          'src/panelbundle.ts',
        ].map((file) => path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/')),
      ),
    ];
    const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(
      'dist/build-identity.json',
      JSON.stringify({
        version: manifestVersion(),
        ...sourceIdentity(),
        extensionSha256: hash('dist/extension.js'),
        inputsSha256: createHash('sha256')
          .update(
            inputs
              .slice()
              .sort()
              .map((file) => `${file}:${hash(file)}`)
              .join('\n'),
          )
          .digest('hex'),
      }) + '\n',
    );
    await current.context.dispose();
    return async () => undefined;
  }

  await current.context.watch();
  let watchers = [];
  let pending = null;
  const rebuildPanel = async () => {
    await current.context.dispose();
    try {
      current = await createBuildContext(developmentServerUrl);
      await current.context.watch();
      rewatch();
      console.log(`rebuilt: the ${developmentServerUrl === null ? 'panel' : 'worker'} source changed`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.log('not rebuilt: the panel source does not build');
    }
  };
  const rewatch = () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers = current.inputs.map((file) =>
      fs.watch(file, () => {
        clearTimeout(pending);
        pending = setTimeout(() => {
          void rebuildPanel();
        }, 50);
      }),
    );
  };
  rewatch();
  return async () => {
    clearTimeout(pending);
    for (const watcher of watchers) {
      watcher.close();
    }
    await current.context.dispose();
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await buildExtension({ watch: process.argv.includes('--watch') });
}
