import { test } from 'vitest';
import assert from 'node:assert/strict';
import { completePath, MAX_PATH_COMPLETIONS } from './pathcompletion.ts';

test('path completion resolves home and keeps directories before files', async () => {
  const reads: string[] = [];
  const result = await completePath({
    token: '~/Projects/wo',
    workingDirectory: '/work',
    homeDirectory: '/home/reader',
    platform: 'posix',
    reader: {
      async readDirectory(directory) {
        reads.push(directory);
        return [
          { name: 'word.txt', directory: false },
          { name: 'work', directory: true },
          { name: '.work', directory: true },
          { name: 'World', directory: true },
        ];
      },
    },
  });
  assert.deepEqual(reads, ['/home/reader/Projects/']);
  assert.equal(result.prefix, '~/Projects/');
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['work', 'word.txt'],
  );
});

test('path completion uses the recorded directory and Windows case rules', async () => {
  const reads: string[] = [];
  const result = await completePath({
    token: '.\\src\\RE',
    workingDirectory: 'C:\\project',
    homeDirectory: 'C:\\Users\\reader',
    platform: 'win32',
    reader: {
      async readDirectory(directory) {
        reads.push(directory);
        return [
          { name: 'README.md', directory: false },
          { name: 'release', directory: true },
        ];
      },
    },
  });
  assert.deepEqual(reads, ['C:\\project\\.\\src\\']);
  assert.equal(result.separator, '\\');
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['release', 'README.md'],
  );
});

test('path completion reads absolute Windows drive and UNC parents', async () => {
  const reads: string[] = [];
  const reader = {
    async readDirectory(directory: string) {
      reads.push(directory);
      return [{ name: 'work', directory: true }];
    },
  };
  await completePath({
    token: 'D:\\Repos\\wo',
    workingDirectory: 'C:\\project',
    homeDirectory: 'C:\\Users\\reader',
    platform: 'win32',
    reader,
  });
  await completePath({
    token: '\\\\server\\share\\wo',
    workingDirectory: 'C:\\project',
    homeDirectory: 'C:\\Users\\reader',
    platform: 'win32',
    reader,
  });
  assert.deepEqual(reads, ['D:\\Repos\\', '\\\\server\\share\\']);
});

test('path completion resolves a rooted Windows path from its drive or share root', async () => {
  const reads: string[] = [];
  const reader = {
    async readDirectory(directory: string) {
      reads.push(directory);
      return [];
    },
  };
  await completePath({
    token: '\\root\\wo',
    workingDirectory: 'D:\\project\\nested',
    homeDirectory: 'D:\\Users\\reader',
    platform: 'win32',
    reader,
  });
  await completePath({
    token: '/root/wo',
    workingDirectory: 'D:\\project\\nested',
    homeDirectory: 'D:\\Users\\reader',
    platform: 'win32',
    reader,
  });
  await completePath({
    token: '\\root\\wo',
    workingDirectory: '\\\\server\\share\\project',
    homeDirectory: 'C:\\Users\\reader',
    platform: 'win32',
    reader,
  });
  assert.deepEqual(reads, ['D:\\root\\', 'D:\\root\\', '\\\\server\\share\\root\\']);
});

test('path completion reveals hidden entries only for a hidden leaf and bounds replies', async () => {
  const entries = Array.from({ length: MAX_PATH_COMPLETIONS + 5 }, (_, index) => ({
    name: `.item${index}`,
    directory: false,
  }));
  const hidden = await completePath({
    token: './.',
    workingDirectory: '/work',
    homeDirectory: '/home/reader',
    platform: 'posix',
    reader: {
      async readDirectory() {
        return entries;
      },
    },
  });
  assert.equal(hidden.entries.length, MAX_PATH_COMPLETIONS);
  const normal = await completePath({
    token: './i',
    workingDirectory: '/work',
    homeDirectory: '/home/reader',
    platform: 'posix',
    reader: {
      async readDirectory() {
        return entries;
      },
    },
  });
  assert.equal(normal.entries.length, 0);
});

test('path completion returns no rows when an immediate directory cannot be read', async () => {
  const result = await completePath({
    token: '/missing/a',
    workingDirectory: '/work',
    homeDirectory: '/home/reader',
    platform: 'posix',
    reader: {
      async readDirectory() {
        throw new Error('denied');
      },
    },
  });
  assert.deepEqual(result.entries, []);
});
