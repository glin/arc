import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import {
  MAX_PROMPT_ASSETS,
  MAX_PROMPT_ASSET_BYTES,
  MAX_PROMPT_ASSET_TOTAL_BYTES,
  normalizeAssetName,
  normalizeAssetMime,
  normalizePromptAssetBook,
  stagedAssetPath,
  stagePromptAssets,
  resolvePromptAssets,
  deleteStagedPromptAssets,
  validatePromptAssetBatch,
  mergePromptAssets,
  PromptAssetCompletionBook,
  promptAssetReleaseIndexes,
  promptAssetsSafeToDelete,
  adoptPromptAssetOperationTarget,
  agentTakesAsset,
  assetBatchRefusal,
  assetKindWord,
  assetMimeForName,
  browserAssetMime,
  pastedAssetName,
  splitAssetName,
  stagedAssetMime,
  storedAssetsForPrompt,
  unsupportedPromptAsset,
  validatePromptAssetBytes,
} from './promptassets.ts';

const ID = '12345678-1234-4123-8123-123456789abc';
const DIGEST = '0'.repeat(64);

test('attachment limits are fixed at the product bounds', () => {
  assert.equal(MAX_PROMPT_ASSETS, 8);
  assert.equal(MAX_PROMPT_ASSET_BYTES, 7 * 1024 * 1024);
  assert.equal(MAX_PROMPT_ASSET_TOTAL_BYTES, 20 * 1024 * 1024);
});

test('asset kind words distinguish PDF, text, and generic files', () => {
  assert.equal(assetKindWord('application/pdf'), 'PDF');
  assert.equal(assetKindWord('text/plain'), 'text');
  assert.equal(assetKindWord('application/zip'), 'file');
});

test('asset name splitting preserves the visible stem and extension', () => {
  assert.deepEqual(splitAssetName('report.final.pdf'), { stem: 'report.final', ext: '.pdf' });
  assert.deepEqual(splitAssetName('.gitignore'), { stem: '.gitignore', ext: '' });
  assert.deepEqual(splitAssetName('NOTICE'), { stem: 'NOTICE', ext: '' });
});

test('generic pasted image names gain a local clock name', () => {
  const now = new Date(2026, 7, 31, 4, 5, 6);
  assert.equal(pastedAssetName('image.png', now), 'pasted-04-05-06.png');
  assert.equal(pastedAssetName('image.JPEG', now), 'pasted-04-05-06.jpeg');
  assert.equal(pastedAssetName('diagram.png', now), 'diagram.png');
});

test('agent attachment support stays in the shared mime rule', () => {
  assert.equal(agentTakesAsset('codex', 'application/zip'), true);
  assert.equal(agentTakesAsset('claude', 'image/webp'), true);
  assert.equal(agentTakesAsset('claude', 'application/pdf'), true);
  assert.equal(agentTakesAsset('claude', 'text/markdown'), true);
  assert.equal(
    agentTakesAsset('claude', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    false,
  );
  const unsupported = {
    name: 'report.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  assert.equal(
    unsupportedPromptAsset('claude', [{ name: 'notes.md', mime: 'text/markdown' }, unsupported]),
    unsupported,
  );
  assert.equal(unsupportedPromptAsset('codex', [unsupported]), null);
});

test('browser files use known extensions before browser media guesses', () => {
  assert.equal(assetMimeForName('settings.json'), 'text/json');
  assert.equal(browserAssetMime('settings.json', 'application/json'), 'text/json');
  assert.equal(browserAssetMime('photo.PNG', 'application/octet-stream'), 'image/png');
  assert.equal(browserAssetMime('archive.thing', 'APPLICATION/ZIP'), 'application/zip');
  assert.equal(browserAssetMime('archive.thing', 'not a mime'), 'application/octet-stream');
});

test('a staged file with an unlisted extension counts as text only when its bytes read as plain UTF-8', () => {
  const text = new TextEncoder().encode(
    'def main():' + String.fromCharCode(10) + '    print("héllo")' + String.fromCharCode(10),
  );
  const binary = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
  const invalid = Uint8Array.from([0x68, 0x69, 0xff, 0xfe]);
  assert.equal(stagedAssetMime('tool.py', '', text), 'text/plain');
  assert.equal(stagedAssetMime('tool.py', 'application/octet-stream', text), 'text/plain');
  assert.equal(stagedAssetMime('blob.py', '', binary), 'application/octet-stream');
  assert.equal(stagedAssetMime('latin1.py', '', invalid), 'application/octet-stream');
  assert.equal(stagedAssetMime('notes.json', '', binary), 'text/json');
  assert.equal(stagedAssetMime('photo.png', '', text), 'image/png');
  assert.equal(stagedAssetMime('doc.pdf', '', text), 'application/pdf');
  assert.equal(stagedAssetMime('x.thing', 'application/zip', text), 'application/zip');
  assert.equal(agentTakesAsset('claude', stagedAssetMime('tool.py', '', text)), true);
  assert.equal(agentTakesAsset('claude', stagedAssetMime('blob.py', '', binary)), false);
});

test('delivery descriptors follow the prompt snapshot rather than later attachments', () => {
  const first = { id: ID, name: 'first.png', mime: 'image/png', size: 1, digest: DIGEST };
  const second = { ...first, id: '87654321-4321-4321-8321-cba987654321', name: 'later.pdf' };
  const prompt = [{ ...first, path: 'C:\\staged\\first' }];
  assert.deepEqual(storedAssetsForPrompt([first, second], prompt), [first]);
  assert.deepEqual(storedAssetsForPrompt([first, second], []), []);
});

test('a compaction turn end cannot release the next attachment prompt', () => {
  assert.deepEqual(promptAssetReleaseIndexes([22], false, 21), []);
  assert.deepEqual(promptAssetReleaseIndexes([22], false, 22), [0]);
});

test('Claude completion releases its exact batch and Stop releases every batch', () => {
  assert.deepEqual(promptAssetReleaseIndexes([21, 22, 23], false, 22), [1]);
  assert.deepEqual(promptAssetReleaseIndexes([21, 22, 23], true), [0, 1, 2]);
});

test('a Claude idle report releases every batch it settled and none sent after it', () => {
  assert.deepEqual(promptAssetReleaseIndexes([21, null, 22, 23], false, [21, 22]), [0, 2]);
  assert.deepEqual(promptAssetReleaseIndexes([21, 22], false, []), []);
});

test('a completion arriving during acceptance stays with that attachment handoff', () => {
  const completions = new PromptAssetCompletionBook();
  completions.complete('session');
  const existing = completions.begin();
  completions.complete('session');
  assert.equal(completions.finish(existing, 'session'), true);

  const draft = completions.begin();
  completions.complete('adopted-session');
  assert.equal(
    completions.finish(draft, 'adopted-session'),
    true,
    'a fresh draft did not yet know the session id when its handoff began',
  );

  const later = completions.begin();
  assert.equal(completions.finish(later, 'adopted-session'), false, 'a completion from before this handoff was reused');
});

test('overlapping attachment handoffs do not inherit another session completion', () => {
  const completions = new PromptAssetCompletionBook();
  const first = completions.begin();
  completions.complete('second');
  const second = completions.begin();
  assert.equal(
    completions.finish(second, 'second'),
    false,
    'the later handoff inherited a completion that preceded it',
  );
  assert.equal(completions.finish(first, 'first'), false);
});

test('attachment names, media types, and stored descriptors are normalized', () => {
  assert.equal(normalizeAssetName(' report.txt '), 'report.txt');
  assert.equal(normalizeAssetName('../report.txt'), null);
  assert.equal(normalizeAssetName('bad\u0000name'), null);
  assert.equal(normalizeAssetMime(' IMAGE/PNG '), 'image/png');
  assert.equal(normalizeAssetMime('not a mime'), null);
  assert.deepEqual(
    normalizePromptAssetBook({
      one: [
        { id: ID.toUpperCase(), name: ' report.txt ', mime: 'TEXT/PLAIN', size: 4, digest: DIGEST.toUpperCase() },
        { id: '../escape', name: 'bad', mime: 'text/plain', size: 1 },
      ],
    }),
    { one: [{ id: ID, name: 'report.txt', mime: 'text/plain', size: 4, digest: DIGEST }] },
  );
});

test('staged paths cannot leave the attachment root', () => {
  const root = path.join('C:\\storage', 'prompt-assets');
  assert.equal(path.basename(stagedAssetPath(root, ID)), ID);
  assert.throws(() => stagedAssetPath(root, '../outside'), /id is invalid/);
});

test('staging writes generated-id copies and deletion touches only those copies', async () => {
  const root = tempDir('arc-assets-');
  const source = path.join(root, 'source.txt');
  await fs.promises.writeFile(source, 'reader copy');
  try {
    const staged = await stagePromptAssets(path.join(root, 'staged'), [
      {
        name: 'source.txt',
        mime: 'text/plain',
        bytes: Buffer.from('reader copy'),
      },
    ]);
    assert.equal(staged.length, 1);
    const resolved = resolvePromptAssets(path.join(root, 'staged'), staged);
    assert.equal(path.basename(resolved[0].path), staged[0].id);
    await deleteStagedPromptAssets(path.join(root, 'staged'), staged);
    assert.equal(await fs.promises.readFile(source, 'utf8'), 'reader copy');
    assert.throws(() => resolvePromptAssets(path.join(root, 'staged'), staged), /no longer available/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('staging refuses count, per-file, and total overflow before writing', async () => {
  const root = tempDir('arc-assets-limits-');
  try {
    const existing = Array.from({ length: MAX_PROMPT_ASSETS }, (_, index) => ({
      id: `12345678-1234-4123-8123-${String(index).padStart(12, '0')}`,
      name: `${index}.txt`,
      mime: 'text/plain',
      size: 1,
      digest: DIGEST,
    }));
    assert.throws(
      () => validatePromptAssetBatch(existing, [{ name: 'extra.txt', mime: 'text/plain', size: 1 }]),
      /at most/,
    );
    await assert.rejects(
      stagePromptAssets(root, [
        { name: 'large.bin', mime: 'application/octet-stream', bytes: new Uint8Array(MAX_PROMPT_ASSET_BYTES + 1) },
      ]),
      /per-file/,
    );
    assert.throws(
      () =>
        validatePromptAssetBatch(
          [
            {
              id: ID,
              name: 'held.bin',
              mime: 'application/octet-stream',
              size: MAX_PROMPT_ASSET_TOTAL_BYTES,
              digest: DIGEST,
            },
          ],
          [{ name: 'more.bin', mime: 'application/octet-stream', size: 1 }],
        ),
      /total/,
    );
    assert.deepEqual(await fs.promises.readdir(root), []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('delivery detects same-size replacement and non-regular staged entries', async () => {
  const root = tempDir('arc-assets-integrity-');
  try {
    const staged = await stagePromptAssets(root, [
      { name: 'note.txt', mime: 'text/plain', bytes: Buffer.from('first') },
    ]);
    await fs.promises.writeFile(stagedAssetPath(root, staged[0].id), 'other');
    assert.throws(() => resolvePromptAssets(root, staged), /does not match/);
    await fs.promises.unlink(stagedAssetPath(root, staged[0].id));
    await fs.promises.mkdir(stagedAssetPath(root, staged[0].id));
    assert.throws(() => resolvePromptAssets(root, staged), /does not match/);
    await fs.promises.rmdir(stagedAssetPath(root, staged[0].id));
    const substitute = path.join(root, 'substitute.txt');
    await fs.promises.writeFile(substitute, 'first');
    try {
      await fs.promises.symlink(substitute, stagedAssetPath(root, staged[0].id));
      assert.throws(() => resolvePromptAssets(root, staged), /does not match/);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') {
        throw error;
      }
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('wire-time validation checks the digest of the exact bytes being sent', () => {
  const bytes = Buffer.from('first');
  const asset = {
    id: ID,
    name: 'note.txt',
    mime: 'text/plain',
    size: bytes.byteLength,
    digest: 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e',
    path: 'C:\\staged\\note',
  };
  validatePromptAssetBytes(asset, bytes);
  assert.throws(() => validatePromptAssetBytes(asset, Buffer.from('other')), /does not match/);
});

test('attachment metadata can be bounded before file contents are read', () => {
  assert.throws(
    () =>
      validatePromptAssetBatch(
        [],
        [
          {
            name: 'large.bin',
            mime: 'application/octet-stream',
            size: MAX_PROMPT_ASSET_BYTES + 1,
          },
        ],
      ),
    /per-file/,
  );
  assert.throws(
    () =>
      validatePromptAssetBatch(
        [],
        [
          {
            name: 'broken.bin',
            mime: 'application/octet-stream',
            size: Number.NaN,
          },
        ],
      ),
    /invalid size/,
  );
});

test('an async staging result merges with current state without reviving removed files', () => {
  const removed = { id: ID, name: 'old.txt', mime: 'text/plain', size: 1, digest: DIGEST };
  const written = {
    id: '22345678-1234-4123-8123-123456789abc',
    name: 'new.txt',
    mime: 'text/plain',
    size: 1,
    digest: '1'.repeat(64),
  };
  assert.deepEqual(mergePromptAssets([], [written]), [written]);
  assert.deepEqual(mergePromptAssets([removed], [written]), [removed, written]);
  assert.throws(() => mergePromptAssets([removed], [{ ...written, id: ID }]), /duplicate staging id/);
});

test('only unreferenced assets outside a handoff are safe to delete', () => {
  const described = { id: ID, name: 'held.txt', mime: 'text/plain', size: 1, digest: DIGEST };
  const inHandoff = {
    id: '22345678-1234-4123-8123-123456789abc',
    name: 'sending.txt',
    mime: 'text/plain',
    size: 1,
    digest: DIGEST,
  };
  const removed = {
    id: '32345678-1234-4123-8123-123456789abc',
    name: 'removed.txt',
    mime: 'text/plain',
    size: 1,
    digest: DIGEST,
  };
  assert.deepEqual(
    promptAssetsSafeToDelete({ one: [described] }, new Set([inHandoff.id]), [described, inHandoff, removed]),
    [removed],
  );
});

test('an open staging operation keeps its adopted target without the routing alias', () => {
  const operation = { browserSession: 'draft:one', target: 'draft:one' };
  assert.equal(adoptPromptAssetOperationTarget(operation, 'draft:one', 'thread-one'), true);
  assert.deepEqual(operation, { browserSession: 'draft:one', target: 'thread-one' });
  assert.equal(adoptPromptAssetOperationTarget(operation, 'draft:one', 'other-thread'), false);
  assert.equal(operation.target, 'thread-one');
});

test('a batch is refused from sizes alone on count, then file size, then total size', () => {
  const limits = { count: 3, fileBytes: 10, totalBytes: 20 };
  const held = [{ size: 4 }];
  assert.equal(assetBatchRefusal(held, [{ name: 'a', size: 5 }], limits), null);
  assert.deepEqual(
    assetBatchRefusal(
      held,
      ['a', 'b', 'c'].map((name) => ({ name, size: 99 })),
      limits,
    ),
    { code: 'count', name: '', size: 0, rejected: 3 },
  );
  assert.deepEqual(assetBatchRefusal(held, [{ name: 'big.png', size: 11 }], limits), {
    code: 'file-size',
    name: 'big.png',
    size: 11,
    rejected: 0,
  });
  assert.deepEqual(
    assetBatchRefusal(
      held,
      [
        { name: 'a', size: 9 },
        { name: 'b', size: 9 },
      ],
      limits,
    ),
    { code: 'total-size', name: '', size: 22, rejected: 0 },
  );
});
