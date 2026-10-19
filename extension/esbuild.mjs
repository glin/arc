import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { require as tsRequire } from 'tsx/cjs/api';
import { sourceIdentity } from '../scripts/source-identity.mjs';
import { copyWindowsPipe } from '../scripts/windowpipe-build.mjs';
import { bundledTools } from './scripts/bundled-tools.mjs';

// The scoped TypeScript loader lets Node import panelbundle.ts from this build script.
const { browserBundle, browserStylesheet, exportBrowserAssets } = tsRequire('./src/panelbundle.ts', import.meta.url);

// panelbundle.ts supplies the browser program and stylesheet to production builds and test pages.
// Development builds select Vite without parsing browser sources.
const PANEL_CSS = 'src/webview/panel.css';

function panelText(developmentServerUrl) {
  const exported = exportBrowserAssets();
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/export-viewer.js', exported.script);
  fs.writeFileSync('dist/export-viewer.css', exported.stylesheet);
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
      inputs: [...exported.inputs, ...Object.keys(worker.metafile.inputs)],
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
    inputs: [...new Set([PANEL_CSS, ...exported.inputs, ...browser.inputs, ...Object.keys(worker.metafile.inputs)])],
  };
}

function manifestVersion() {
  return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
}

async function createBuildContext(developmentServerUrl, identity, watch = false) {
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
    define: {
      ...panel.defines,
      EXTENSION_VERSION: JSON.stringify(manifestVersion()),
      HOST_BUILD_IDENTITY: JSON.stringify(
        JSON.stringify(
          watch
            ? { sourceCommit: null, dirty: null, builtAt: 0, unavailable: 'watch' }
            : { ...identity, builtAt: Date.now() },
        ),
      ),
    },
  });
  return { context, inputs: panel.inputs };
}

async function createCliContext(identity) {
  fs.mkdirSync('dist/bin', { recursive: true });
  fs.writeFileSync(
    'dist/bin/arc',
    '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$ARC_EDITOR_EXECUTABLE" "${0%/*}/../cli.cjs" "$@"\n',
    { mode: 0o755 },
  );
  fs.chmodSync('dist/bin/arc', 0o755);
  fs.writeFileSync(
    'dist/bin/arc.cmd',
    '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%ARC_EDITOR_EXECUTABLE%" "%~dp0..\\cli.cjs" %*\r\n',
  );
  return esbuild.context({
    entryPoints: ['../cli/src/main.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/cli.cjs',
    metafile: true,
    define: {
      ARC_VERSION: JSON.stringify(manifestVersion()),
      ARC_BUILD_COMMIT: JSON.stringify(identity.sourceCommit ?? 'unknown'),
      ARC_BUILD_DIRTY: JSON.stringify(identity.dirty),
    },
  });
}

export async function buildExtension({ watch = false, developmentServerUrl = null } = {}) {
  const identity = watch
    ? { sourceCommit: null, dirty: null }
    : sourceIdentity(fileURLToPath(new URL('../', import.meta.url)));
  copyWindowsPipe('dist');
  if (watch) fs.rmSync('dist/build-identity.json', { force: true });
  const cli = await createCliContext(identity);
  let current = await createBuildContext(developmentServerUrl, identity, watch);
  if (!watch) {
    const cliResult = await cli.rebuild();
    const result = await current.context.rebuild();
    const setup = await esbuild.build({
      entryPoints: ['src/bundledsetup.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      outfile: 'dist/setup.cjs',
      metafile: true,
    });
    const tools = bundledTools(path.resolve('dist'), path.resolve('..'), {
      extensionVersion: manifestVersion(),
      sourceCommit: identity.sourceCommit,
    });
    const inputs = [
      ...new Set(
        [
          ...current.inputs,
          ...Object.keys(result.metafile.inputs),
          ...Object.keys(cliResult.metafile.inputs),
          ...Object.keys(setup.metafile.inputs),
          'package.json',
          'esbuild.mjs',
          'src/panelbundle.ts',
          'resources/windowpipe.exe',
          'resources/windowpipe.json',
          '../scripts/windowpipe-build.mjs',
          '../scripts/source-identity.mjs',
          'scripts/bundled-tools.mjs',
          ...tools.inputs,
        ].map((file) => path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/')),
      ),
    ];
    const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(
      'dist/build-identity.json',
      JSON.stringify({
        version: manifestVersion(),
        ...identity,
        tools: tools.identity,
        extensionSha256: hash('dist/extension.js'),
        exportViewerScriptSha256: hash('dist/export-viewer.js'),
        exportViewerStylesheetSha256: hash('dist/export-viewer.css'),
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
    await cli.dispose();
    return async () => undefined;
  }

  await cli.rebuild();
  await current.context.watch();
  await cli.watch();
  let watchers = [];
  let pending = null;
  const rebuildPanel = async () => {
    await current.context.dispose();
    try {
      current = await createBuildContext(developmentServerUrl, identity, watch);
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
    await cli.dispose();
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await buildExtension({ watch: process.argv.includes('--watch') });
}
