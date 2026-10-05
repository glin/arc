// Shared browser script and stylesheet builds for the extension host, page fixtures, and web demo.

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BROWSER_ENTRY = path.join(__dirname, 'webview', 'main.ts');

// Share the compact stylesheet between the host bundle and browser fixtures.
export function browserStylesheet(): string {
  return esbuild.transformSync(fs.readFileSync(path.join(__dirname, 'webview', 'panel.css'), 'utf8'), {
    loader: 'css',
    minifyWhitespace: true,
  }).code;
}

export interface BrowserBundle {
  // Minified classic-script IIFE for an inline script tag.
  text: string;
  // Absolute build input paths used by watch mode.
  inputs: string[];
}

// Shared options for in-memory browser builds, including the panel and web demo label rules.
export const BROWSER_BUILD = {
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  logLevel: 'silent',
  minify: true,
} as const satisfies esbuild.BuildOptions;

export function browserBundle(): BrowserBundle {
  const root = path.join(__dirname, '..');
  const result = esbuild.buildSync({
    ...BROWSER_BUILD,
    entryPoints: [BROWSER_ENTRY],
    metafile: true,
    absWorkingDir: root,
  });
  const text = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file));
  return { text, inputs };
}
