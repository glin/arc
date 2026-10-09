import { test, vi } from 'vitest';
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
      await writer.writeIndexChunks(
        (async function* () {
          yield text;
        })(),
      );
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
      await writer.writeIndexChunks(
        (async function* () {
          yield 'capture';
        })(),
      );
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
        await writer.writeIndexChunks(
          (async function* () {
            yield 'capture';
          })(),
        );
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
  await writer.writeIndexChunks(
    (async function* () {
      yield 'capture';
    })(),
  );
  const file = path.join(writer.staging, 'index.html');
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'author replacement');
  await assert.rejects(writer.dispose(), /export file changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'author replacement');
});

test('the writer refuses duplicate index writes and source-controlled spool paths', async () => {
  const parent = tempDir('export-writer-');
  await withExportTransaction(parent, async (writer) => {
    await writer.writeIndexChunks(
      (async function* () {
        yield 'capture';
      })(),
    );
    await assert.rejects(
      writer.writeIndexChunks(
        (async function* () {
          yield 'replace';
        })(),
      ),
      { code: 'EEXIST' },
    );
    await assert.rejects(writer.readSpool('../author.json'), /unavailable/);
  });
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('cancellation between HTML chunks stops writing and removes owned staging', async () => {
  const parent = tempDir('export-writer-');
  const controller = new AbortController();
  await assert.rejects(
    withExportTransaction(
      parent,
      async (writer) => {
        await writer.writeIndexChunks(
          (async function* () {
            yield 'first';
            controller.abort();
            yield 'second';
          })(),
        );
      },
      controller.signal,
    ),
    ExportCancelled,
  );
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a temporary spool lock recovers before atomic publication without staging private pages beside the destination', async () => {
  const parent = tempDir('export-writer-lock-');
  const original = fs.promises.unlink;
  let attempts = 0;
  let spoolDirectory = '';
  const unlink = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
    if (path.basename(String(file)).startsWith('s-')) {
      spoolDirectory = path.dirname(String(file));
      if (++attempts <= 2) throw Object.assign(new Error('locked spool'), { code: 'EBUSY' });
    }
    return original(file);
  });
  vi.useFakeTimers();
  try {
    const operation = withExportTransaction(parent, async (writer) => {
      await writer.spool({ private: 'recorded body' });
      assert.deepEqual(fs.readdirSync(writer.staging), []);
      await writer.writeIndexChunks(
        (async function* () {
          yield 'complete';
        })(),
      );
      return writer.publish(async () => {});
    });
    let completed = false;
    void operation.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await vi.waitFor(() => assert.ok(completed));
    const result = await operation;
    assert.equal(attempts, 3);
    assert.equal(fs.readFileSync(result.index, 'utf8'), 'complete');
    assert.deepEqual(fs.readdirSync(result.directory), ['index.html']);
    assert.notEqual(path.dirname(spoolDirectory), parent);
    assert.equal(fs.existsSync(spoolDirectory), false);
  } finally {
    vi.useRealTimers();
    unlink.mockRestore();
  }
});

for (const failure of ['persistent', 'cancel', 'replaced'] as const) {
  test(`a ${failure} spool lock prevents publication and preserves the original outcome`, async () => {
    const parent = tempDir('export-writer-lock-');
    const original = fs.promises.unlink;
    const controller = new AbortController();
    let attempts = 0;
    let writer: ExportTransaction | undefined;
    let replacedFile = '';
    const unlink = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
      if (path.basename(String(file)).startsWith('s-')) {
        attempts++;
        if (failure === 'cancel') controller.abort();
        if (failure === 'replaced') {
          replacedFile = String(file);
          fs.writeFileSync(replacedFile, 'external replacement');
        }
        throw Object.assign(new Error('locked spool'), { code: 'EBUSY' });
      }
      return original(file);
    });
    vi.useFakeTimers();
    try {
      writer = await ExportTransaction.create(parent, controller.signal);
      await writer.spool({ private: 'body' });
      await writer.writeIndexChunks(
        (async function* () {
          yield 'complete';
        })(),
      );
      let observed: unknown;
      let completed = false;
      const publishing = writer
        .publish(async () => {})
        .then(
          () => {
            completed = true;
          },
          (error) => {
            observed = error;
            completed = true;
          },
        );
      await vi.waitFor(() => assert.ok(completed));
      await publishing;
      assert.ok(observed instanceof Error);
      if (failure === 'cancel') assert.ok(observed instanceof ExportCancelled);
      else assert.match(observed.message, failure === 'replaced' ? /export file changed/ : /locked spool/);
      assert.equal(attempts, failure === 'persistent' ? 4 : 1);
      assert.ok(fs.readdirSync(parent).every((name) => name.startsWith('.arc-export-')));
    } finally {
      vi.useRealTimers();
      unlink.mockRestore();
      if (failure !== 'replaced') await writer?.dispose();
      else if (writer && replacedFile) {
        fs.unlinkSync(replacedFile);
        fs.rmdirSync(path.dirname(replacedFile));
        fs.unlinkSync(path.join(writer.staging, 'index.html'));
        fs.rmdirSync(writer.staging);
      }
    }
  });
}

test('cleanup locks never replace a source failure with a cleanup failure', async () => {
  const parent = tempDir('export-writer-lock-');
  let writer: ExportTransaction | undefined;
  const sourceError = new Error('source unavailable');
  const unlink = vi
    .spyOn(fs.promises, 'unlink')
    .mockRejectedValue(Object.assign(new Error('cleanup locked'), { code: 'EIO' }));
  try {
    await assert.rejects(
      withExportTransaction(parent, async (transaction) => {
        writer = transaction;
        await writer.spool({ body: 'private' });
        throw sourceError;
      }),
      (error) => error === sourceError,
    );
  } finally {
    unlink.mockRestore();
    await writer?.dispose();
  }
});
