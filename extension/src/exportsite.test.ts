import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EXPORT_LIMITS } from './exportlimits';
import { ExportTransaction, ExportCancelled } from './exportwriter';
import { exportCard, exportTurn, exportScriptJson, projectSessionSite } from './exportsite';
import { toCard } from './turncard';
import { turn, sessionSiteFixture, exportedSiteData } from './turnfixtures';
import { tempDir } from './temproot';
import type { CardView } from './webview/payload-contracts';
import type { ExportBlock } from './exportdata';
import { exportBrowserAssets } from './panelbundle';
import { exportFactValue } from './view/export-facts';

test('portable projection retains every body beyond previews and removes post-builder action metadata', async () => {
  const directory = tempDir('arc-export-site-');
  const writer = await ExportTransaction.create(directory);
  const model = await sessionSiteFixture(writer);
  const assets = exportBrowserAssets();
  await projectSessionSite(model, writer, assets);
  const result = await writer.publish(async () => {});
  const { manifest, data } = exportedSiteData(result.directory);
  assert.equal((await fs.readdir(result.directory)).length, 2);
  assert.ok(manifest);
  assert.equal(manifest.sessions[0].pages.length, 2);
  assert.equal(manifest.sessions[0].pages[0].keys.length, 20);
  assert.equal(JSON.stringify(manifest.relationships), JSON.stringify(model.relationships));
  assert.equal(JSON.stringify(manifest.omissions), JSON.stringify(model.omissions));
  const cards = manifest.sessions[0].pages[0].cards!.map(
    (asset) => data.get(asset.id) as { card: CardView; blocks: ExportBlock[] },
  );
  assert.equal(cards[0].card.statusWord, 'Unfinished at capture');
  assert.equal(cards[0].card.fileCount, 1);
  assert.match(cards[0].card.dispatched![0].description, /Work is not included: missing/);
  assert.equal(cards[0].card.added, 5);
  assert.equal(cards[0].card.removed, 2);
  const blocks = cards[0].blocks;
  assert.equal(blocks.filter((block) => block.kind === 'prompt').length, 14);
  const answer = blocks.find((block) => block.kind === 'answer')!;
  assert.ok(answer.text.endsWith('![image](https://example.invalid/image)'));
  assert.ok(cards[0].card.summary.includes('final sentinel'));
  assert.equal(cards[0].card.laterPrompts?.length, 13);
  assert.equal(cards[0].card.saidMessages?.[0].text, 'Commentary 21');
  for (const html of [
    cards[0].card.summaryHtml,
    ...(cards[0].card.saidMessages ?? []).map((message) => message.summaryHtml),
  ])
    assert.doesNotMatch(html ?? '', /<(?:a|button|img|script|iframe)\b|data-(?:link|image|visualization)|on\w+=/i);
  const unsafe = {
    ...toCard(turn(), false, model.capturedAt),
    headlineHtml: '<a href="file:///private">x</a>',
    resume: '/private',
    activity: [{ title: '/private/raw-tool' }],
    chips: [{ kind: 'plain', label: '$1', detail: 'Numeric fact', detailList: { actions: true }, record: '/private' }],
  };
  const safe = exportCard(unsafe as unknown as ReturnType<typeof toCard>);
  assert.doesNotMatch(JSON.stringify(safe), /private|detailList|"record"|headlineHtml|resume/);
  await writer.dispose();
});

test('script JSON preserves literal content', () => {
  const text = '</script><img src=x onerror=alert(1)>\u2028\u2029' + '\u{1f642}\u{1f680}\u20ac'.repeat(20000);
  assert.doesNotMatch(exportScriptJson(text), /<|\u2028|\u2029/);
  assert.equal(JSON.parse(exportScriptJson(text)), text);
});

test('projection cancellation stops before publication and removes its staging assets', async () => {
  const directory = tempDir('arc-export-cancel-');
  const controller = new AbortController();
  const writer = await ExportTransaction.create(directory, controller.signal);
  const model = await sessionSiteFixture(writer);
  const original = writer.readSpool.bind(writer);
  let writes = 0;
  writer.readSpool = async <T>(...args: Parameters<typeof writer.readSpool>) => {
    const result = await original(...args);
    if (++writes === 3) controller.abort();
    return result as T;
  };
  await assert.rejects(projectSessionSite(model, writer, { script: '', stylesheet: '' }), ExportCancelled);
  await writer.dispose();
  assert.deepEqual(await fs.readdir(directory), []);
});

test('static bundle uses the production panel entry and an exhaustive local host policy', () => {
  const assets = exportBrowserAssets();
  for (const owner of ['main.ts', 'bootstrap.ts', 'panel.ts', 'export-host.ts'])
    assert.ok(
      assets.inputs.some((file) => file.endsWith(path.join('webview', owner))),
      owner,
    );
  assert.ok(!assets.inputs.some((file) => file.endsWith(path.join('webview', 'export-main.ts'))));
});

test('recorded opening prompts remain complete and later non-response answers cannot replace the response', async () => {
  const writer = await ExportTransaction.create(tempDir('arc-site-response-'));
  try {
    const model = await sessionSiteFixture(writer);
    const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
    const value = page.turns[0];
    value.blocks = [
      {
        key: 'p1',
        kind: 'prompt',
        text: 'opening '.repeat(8000),
        at: 1,
        sourceOrder: 0,
        opening: true,
        notResponse: null,
      },
      { key: 'p2', kind: 'prompt', text: 'second opening', at: 1, sourceOrder: 1, opening: true, notResponse: null },
      { key: 'a1', kind: 'answer', text: 'response '.repeat(10000), at: 2, sourceOrder: 2, notResponse: null },
      {
        key: 'a2',
        kind: 'answer',
        text: 'interrupted answer',
        at: 3,
        sourceOrder: 3,
        notResponse: 'no-response-requested',
      },
    ];
    const projected = exportTurn(value, 'codex', 'root');
    assert.equal(projected.prompt, value.blocks[0].text + '\n\nsecond opening');
    assert.equal(projected.summary, value.blocks[2].text);
    assert.deepEqual(
      projected.answers.map((answer) => answer.sourceOrder),
      [2, 3],
    );
    assert.equal(projected.answers[1].notResponse, 'no-response-requested');
    const card = exportCard(toCard(projected, false, model.capturedAt));
    assert.equal(card.prompt, projected.prompt);
    assert.equal(card.summary, projected.summary);
  } finally {
    await writer.dispose();
  }
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

test('one admitted large card keeps its full text on a separate decoded page', async () => {
  const writer = await ExportTransaction.create(tempDir('arc-site-large-'));
  try {
    const model = await sessionSiteFixture(writer);
    const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
    const answer = page.turns[0].blocks.find((block) => block.kind === 'answer')!;
    const commentary = page.turns[0].blocks.find((block) => block.kind === 'commentary')!;
    answer.text = 'x'.repeat(4 * 1024 * 1024) + 'answer end';
    commentary.text = 'y'.repeat(4 * 1024 * 1024) + 'commentary end';
    assert.ok(
      page.turns[0].blocks.reduce((bytes, block) => bytes + Buffer.byteLength(block.text), 0) < EXPORT_LIMITS.turnBytes,
    );
    model.sessions[0].pages = [await writer.spool(page), model.sessions[0].pages[1]];
    model.sessions = [model.sessions[0]];
    await projectSessionSite(model, writer, { script: '', stylesheet: '' });
    const { directory } = await writer.publish(async () => {});
    const { manifest, data } = exportedSiteData(directory);
    const first = manifest.sessions[0].pages[0];
    assert.equal(first.cards!.length, 1);
    assert.ok(first.bytes > EXPORT_LIMITS.retainedBytes);
    assert.equal(manifest.sessions[0].pages.length, 2);
    const retained = data.get(first.cards![0].id) as { card: CardView; blocks: ExportBlock[] };
    assert.equal(retained.card.summary, answer.text);
    assert.equal(retained.card.saidMessages![0].text, commentary.text);
  } finally {
    await writer.dispose();
  }
});

test('matched native agent rows retain completion and figures with missing or ambiguous child qualifications', async () => {
  for (const reason of ['missing', 'ambiguous', 'unreadable', 'conflicting'] as const) {
    const writer = await ExportTransaction.create(tempDir('arc-site-child-'));
    try {
      const model = await sessionSiteFixture(writer);
      const page = await writer.readSpool<import('./exportdata').ExportPage>(model.sessions[0].pages[0]);
      const value = page.turns[0];
      value.agents = [
        {
          key: 'tool-use-launch',
          relationships: ['missing-link'],
          description: 'Native task',
          agentType: null,
          model: 'claude-sonnet-4-5',
          effort: 'high',
          status: 'completed',
          startedAt: 1,
          durationMs: 1000,
          tokens: 30,
          toolUses: 2,
          partial: false,
        },
      ];
      const expected = exportCard(toCard(exportTurn(value, 'claude', 'root'), false, model.capturedAt)).agents![0];
      model.relationships[1] = { ...model.relationships[1], kind: 'subagent', reason };
      model.sessions[0].pages[0] = await writer.spool(page);
      await projectSessionSite(model, writer, { script: '', stylesheet: '' });
      const { directory } = await writer.publish(async () => {});
      const { manifest, data } = exportedSiteData(directory);
      const card = (data.get(manifest.sessions[0].pages[0].cards![0].id) as { card: CardView }).card;
      assert.equal(card.agents!.length, 2);
      const native = card.agents![0];
      assert.equal(native.description, expected.description);
      assert.equal(native.state, expected.state);
      assert.equal(native.stateWord, expected.stateWord);
      assert.deepEqual(native.figures, JSON.parse(JSON.stringify(expected.figures)));
      assert.equal(native.sessionId, null);
      assert.ok(native.hintDetail?.includes(`Work is not included: ${reason}.`));
    } finally {
      await writer.dispose();
    }
  }
});
