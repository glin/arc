import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { browserBundle } from './panelbundle.ts';
import { fillPanelText, panelValues } from './paneltext.ts';
import { pageHtml } from './panelfixture.ts';

test('the browser bundle carries the panel and names its source', { tags: ['subprocess'] }, () => {
  const bundle = browserBundle();
  const panelPath = path.join(__dirname, 'webview', 'panel.ts');
  const panel = fs.readFileSync(panelPath, 'utf8');
  assert.ok(
    bundle.text.includes('acquireVsCodeApi()'),
    'the bundle never acquires the VS Code API, so the panel is not in it',
  );
  assert.ok(
    bundle.inputs.some((file) => file.endsWith(path.join('webview', 'panel.ts'))),
    `panel.ts is not among the bundle's inputs: ${bundle.inputs.join(', ')}`,
  );
  assert.equal(fs.existsSync(path.join(__dirname, 'webview', ['panel', 'js'].join('.'))), false);
  assert.equal(
    fs.existsSync(path.join(__dirname, 'webview', 'page.ts')),
    false,
    'page.ts returned as a second composition boundary',
  );
  assert.match(panel, /dispatchHostToPanel\(message, \{/, 'panel.ts no longer owns exhaustive host-message dispatch');
  assert.doesNotMatch(
    panel,
    /document\.createElement|\.innerHTML\s*=|\.replaceChildren\(|\.style\./,
    'the composition root constructs or replaces feature presentation',
  );
});

test('the page fixture runs the bundle the host build embeds', { tags: ['subprocess'] }, () => {
  const bundle = browserBundle();
  const filled = fillPanelText(bundle.text, panelValues());
  assert.ok(pageHtml().includes(filled), 'the fixture page does not carry the built bundle');
});

test('the host build takes its panel script from the same builder', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'esbuild.mjs'), 'utf8');
  assert.ok(build.includes("tsRequire('./src/panelbundle.ts'"), 'esbuild.mjs does not import panelbundle.ts');
  assert.ok(build.includes('browserBundle()'), 'esbuild.mjs never calls browserBundle');
  assert.ok(
    !/readFileSync[(][^)]*panel[.]js/.test(build),
    'esbuild.mjs reads the old panel source as text instead of building it',
  );
});
