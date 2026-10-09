import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot.ts';
import { ExportCancelled, ExportTransaction, withExportTransaction } from './exportwriter.ts';
import { ExportLimitError } from './exportlimits.ts';

// The writer guards no-overwrite publication and cleanup ownership, including cancellation and replacement.
test('concurrent exports publish independent directories and never replace an existing site', async () => {
  const parent = tempDir('export-writer-');
  const previous = path.join(parent, 'arc-session-author');
  fs.mkdirSync(previous);
  fs.writeFileSync(path.join(previous, 'index.html'), 'author');
  const publish = (text: string) =>
    withExportTransaction(parent, async (writer) => {
      await writer.writeIndex(text);
      const key = await writer.writeAsset('js', 'window.example = true;');
      assert.match(key, /^a-[a-z0-9]+\.js$/);
      return writer.publish(async () => {});
    });
  const results = await Promise.all([publish('first'), publish('second')]);
  assert.notEqual(results[0].directory, results[1].directory);
  assert.equal(fs.readFileSync(results[0].index, 'utf8'), 'first');
  assert.equal(fs.readFileSync(results[1].index, 'utf8'), 'second');
  assert.equal(fs.readFileSync(path.join(previous, 'index.html'), 'utf8'), 'author');
});

test('a failed source recheck removes staging before publication', async () => {
  const parent = tempDir('export-writer-');
  await assert.rejects(
    withExportTransaction(parent, async (writer) => {
      await writer.writeIndex('capture');
      await writer.publish(async () => {
        throw new Error('source changed');
      });
    }),
    /source changed/,
  );
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('asset admission rejects an oversized file without publishing any directory', async () => {
  const parent = tempDir('export-writer-');
  await assert.rejects(
    withExportTransaction(parent, (writer) => writer.writeAsset('js', 'x'.repeat(11)), undefined, 10),
    (error) => error instanceof ExportLimitError && error.boundary === 'asset',
  );
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('cancellation after writes prevents publication and removes only owned files', async () => {
  const parent = tempDir('export-writer-');
  const controller = new AbortController();
  fs.writeFileSync(path.join(parent, 'author.txt'), 'author');
  await assert.rejects(
    withExportTransaction(
      parent,
      async (writer) => {
        await writer.writeIndex('capture');
        await writer.spool({ text: 'body' });
        controller.abort();
        await writer.publish(async () => {});
      },
      controller.signal,
    ),
    ExportCancelled,
  );
  assert.deepEqual(fs.readdirSync(parent), ['author.txt']);
});

test('cleanup stops after staging replacement and never follows the replacement directory link', async () => {
  const parent = tempDir('export-writer-');
  const target = path.join(parent, 'author');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'author');
  const writer = await ExportTransaction.create(parent);
  const original = `${writer.staging}-kept`;
  fs.renameSync(writer.staging, original);
  fs.symlinkSync(target, writer.staging, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await writer.dispose();
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'author');
    assert.ok(fs.lstatSync(writer.staging).isSymbolicLink());
  } finally {
    fs.unlinkSync(writer.staging);
    fs.rmdirSync(original);
  }
});

test('cleanup refuses externally replaced files without deleting their contents', async () => {
  const parent = tempDir('export-writer-');
  const writer = await ExportTransaction.create(parent);
  await writer.writeIndex('capture');
  const file = path.join(writer.staging, 'index.html');
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'author replacement');
  await assert.rejects(writer.dispose(), /export file changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'author replacement');
});

test('the writer refuses duplicate index writes and source-controlled spool paths', async () => {
  const parent = tempDir('export-writer-');
  await withExportTransaction(parent, async (writer) => {
    await writer.writeIndex('capture');
    await assert.rejects(writer.writeIndex('replace'), { code: 'EEXIST' });
    await assert.rejects(writer.readSpool('../author.json'), /unavailable/);
  });
  assert.deepEqual(fs.readdirSync(parent), []);
});
