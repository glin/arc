// Shared browser script and stylesheet builds for the extension host, page fixtures, and web demo.

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fillPanelText, panelValues } from './paneltext';
import { DARK_MODERN_THEME, LIGHT_MODERN_THEME, ONE_DARK_PRO_DARKER_THEME } from './view/static-themes';
import { manifestMenu } from './webview/static-menu';

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

export function browserBundle(entry = BROWSER_ENTRY): BrowserBundle {
  const root = path.join(__dirname, '..');
  const result = esbuild.buildSync({
    ...BROWSER_BUILD,
    entryPoints: [entry],
    metafile: true,
    absWorkingDir: root,
  });
  const text = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file));
  return { text, inputs };
}

export function exportBrowserAssets(): { script: string; stylesheet: string; inputs: string[] } {
  const browser = browserBundle();
  const host = browserBundle(path.join(__dirname, 'webview', 'export-host.ts'));
  const cssPaths = ['static-page.css', 'static-shell.css', 'static-menu.css'].map((name) =>
    path.join(__dirname, 'webview', name),
  );
  const manifestPath = path.join(__dirname, '..', 'package.json');
  const menu = manifestMenu(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    new Set(['arc.copySessionId', 'arc.showSessionDetails', 'arc.copyTurnSummary']),
  );
  return {
    script: `window.__arcExportMenu=${JSON.stringify(menu)};` + host.text + fillPanelText(browser.text, panelValues()),
    stylesheet: staticThemeStylesheet() + fillPanelText(browserStylesheet(), panelValues()) + staticShellStylesheet(),
    inputs: [
      ...browser.inputs,
      ...host.inputs,
      ...cssPaths,
      manifestPath,
      path.join(__dirname, 'view', 'static-themes.ts'),
    ],
  };
}

export function staticThemeStylesheet(): string {
  const theme = (css: string, name: string) =>
    css.replaceAll(':root', `:root[data-theme="${name}"]`).replaceAll('body{', `body[data-theme="${name}"]{`);
  return [
    theme(ONE_DARK_PRO_DARKER_THEME, 'onedark'),
    theme(DARK_MODERN_THEME, 'dark'),
    theme(LIGHT_MODERN_THEME, 'light'),
  ].join('\n');
}

export function staticShellStylesheet(): string {
  return ['static-page.css', 'static-shell.css', 'static-menu.css']
    .map((name) => fs.readFileSync(path.join(__dirname, 'webview', name), 'utf8'))
    .join('\n');
}
