import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { EXPORT_LIMITS } from './exportlimits';
import { ExportTransaction, ExportCancelled } from './exportwriter';
import { exportCard, exportScriptJson, exportTextChunks, projectSessionSite } from './exportsite';
import { toCard } from './turncard';
import { turn, sessionSiteFixture } from './turnfixtures';
import { tempDir } from './temproot';
import type { SiteAsset, SiteBlock, SiteCard, SiteManifest, SiteText } from './webview/export-model';
import { exportBrowserAssets } from './panelbundle';
import { exportFactValue } from './view/export-facts';

test('portable projection retains every body beyond previews and removes post-builder action metadata', async () => {
  const directory = tempDir('arc-export-site-');
  const writer = await ExportTransaction.create(directory);
  const model = await sessionSiteFixture(writer);
  const assets = exportBrowserAssets();
  await projectSessionSite(model, writer, assets);
  const result = await writer.publish(async () => {});
  let manifest: SiteManifest | undefined;
  for (const name of await fs.readdir(result.directory)) {
    const source = await fs.readFile(path.join(result.directory, name), 'utf8');
    assert.ok(Buffer.byteLength(source) <= EXPORT_LIMITS.assetBytes, name);
    if (source.startsWith('window.__arcExportManifest=')) {
      const window = { __arcExportManifest: undefined };
      runInNewContext(source, { window });
      manifest = window.__arcExportManifest;
    }
  }
  assert.ok(manifest);
  assert.equal(manifest.sessions[0].pages.length, 2);
  assert.equal(manifest.sessions[0].pages[0].keys.length, 20);
  assert.equal(JSON.stringify(manifest.relationships), JSON.stringify(model.relationships));
  assert.equal(JSON.stringify(manifest.omissions), JSON.stringify(model.omissions));
  const load = async <T>(asset: SiteAsset): Promise<T> => {
    let data: unknown;
    runInNewContext(await fs.readFile(path.join(result.directory, asset.file), 'utf8'), {
      window: {
        __arcExportReceive(id: string, value: unknown) {
          assert.equal(id, asset.id);
          data = value;
        },
      },
    });
    return data as T;
  };
  const cards = await load<SiteCard[]>(manifest.sessions[0].pages[0]);
  assert.equal(cards[0].card.statusWord, 'Unfinished at capture');
  assert.equal(cards[0].card.fileCount, 1);
  assert.equal(cards[0].card.added, 5);
  assert.equal(cards[0].card.removed, 2);
  const blocks = await load<SiteBlock[]>(cards[0].bodies[0]);
  assert.equal(blocks.filter((block) => block.kind === 'prompt').length, 14);
  const answer = blocks.find((block) => block.kind === 'answer')!;
  const chunks = await Promise.all(answer.chunks.map((chunk) => load<SiteText>(chunk)));
  assert.ok(
    chunks
      .map((chunk) => chunk.raw)
      .join('')
      .endsWith('![image](https://example.invalid/image)'),
  );
  for (const chunk of chunks)
    assert.doesNotMatch(chunk.html, /<(?:a|button|img|script|iframe)\b|data-(?:link|image|visualization)|on\w+=/i);
  const unsafe = {
    ...toCard(turn(), false, model.capturedAt),
    headlineHtml: '<a href="file:///private">x</a>',
    resume: '/private',
    activity: [{ title: '/private/raw-tool' }],
    chips: [{ kind: 'plain', label: '$1', detail: 'Numeric fact', detailList: { actions: true }, record: '/private' }],
  };
  const safe = exportCard(unsafe as unknown as ReturnType<typeof toCard>);
  assert.doesNotMatch(JSON.stringify(safe), /private|detailList|"record"|headlineHtml|resume|activity/);
  await writer.dispose();
});

test('script JSON and Unicode text chunks preserve literal content within their budgets', () => {
  const text = '</script><img src=x onerror=alert(1)>\u2028\u2029' + '\u{1f642}\u{1f680}\u20ac'.repeat(20000);
  assert.doesNotMatch(exportScriptJson(text), /<|\u2028|\u2029/);
  assert.equal(JSON.parse(exportScriptJson(text)), text);
  const chunks = [...exportTextChunks(text)];
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= EXPORT_LIMITS.textBytes);
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk);
  }
});

test('projection cancellation stops before publication and removes its staging assets', async () => {
  const directory = tempDir('arc-export-cancel-');
  const controller = new AbortController();
  const writer = await ExportTransaction.create(directory, controller.signal);
  const model = await sessionSiteFixture(writer);
  const original = writer.writeAsset.bind(writer);
  let writes = 0;
  writer.writeAsset = async (...args) => {
    const result = await original(...args);
    if (++writes === 3) controller.abort();
    return result;
  };
  await assert.rejects(projectSessionSite(model, writer, { script: '', stylesheet: '' }), ExportCancelled);
  await writer.dispose();
  assert.deepEqual(await fs.readdir(directory), []);
});

test('static bundle excludes editor startup, mutable owners and file-read entrypoints', () => {
  const assets = exportBrowserAssets();
  for (const owner of ['bootstrap.ts', 'panel.ts', 'composer.ts', 'comments.ts', 'prompt-files.ts', 'host.ts'])
    assert.ok(!assets.inputs.some((file) => file.endsWith(path.join('webview', owner))), owner);
  assert.doesNotMatch(assets.script, /acquireVsCodeApi|FileReader|showOpenFilePicker|XMLHttpRequest|fetch\(/);
});

test('readable exported facts preserve literal source values that match classification names', () => {
  for (const key of ['title', 'model', 'subject', 'description', 'scope', 'path', 'sha256', 'error']) {
    for (const value of ['main', 'partial', 'recorded', 'missing', 'reader-started'])
      assert.equal(exportFactValue(key, value), value);
  }
  assert.equal(exportFactValue('role', 'main'), 'Main agent');
  assert.equal(exportFactValue('ownership', 'navigation'), 'Navigation only, no delegated cost');
  assert.match(exportFactValue('dollars', 1.23456789), /1\.23456789 USD/);
});
