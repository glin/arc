// extension/src/panelbundle.ts
//
// The panel's browser program, built here and nowhere else.
//
// Three things need the script the page runs. The host build substitutes it into the
// extension bundle. The page fixture draws it for the layout test and the screenshot script.
// The guard beside this file holds those two to one another. Each asks this function, so there
// is one artifact and not a built one in production beside a raw one in the tests.

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
  // The script, as one classic-script IIFE for the page's inline tag.
  text: string;
  // Every file the script was built from, absolute. Watch mode watches these.
  inputs: string[];
}

// How every script the page runs is built: one minified classic-script IIFE, in memory. The
// panel bundle below and the web demo's label rules both build with these, so a change to
// the target or the charset reaches both.
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
