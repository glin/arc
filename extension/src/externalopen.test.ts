import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { externalOpenEligible, externalOpenPath, externalOpenSample, type ExternalOpenFs } from './externalopen';

const documentBytes = Buffer.from([0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52, 0, 0x76]);
const deniedSuffixes = (
  'exe com scr pif cpl dll sys drv ocx msi msp mst msix msixbundle appx appxbundle appinstaller application manifest ' +
  'bat cmd ps1 ps1xml ps2 ps2xml psc1 psc2 vbs vbe js jse wsf wsh hta reg inf ins isp sct ' +
  'lnk url website desktop app command sh bash zsh fish py pyw rb pl php jar class jnlp scpt applescript workflow action ' +
  'iso img vhd vhdx dmg pkg mpkg'
).split(' ');

test('external document suffix policy excludes programs and launchers on every platform', () => {
  for (const root of ['C:\\Mixed Folder\\', '/Users/Reader/Mixed Folder/', '/home/reader/Mixed Folder/']) {
    for (const suffix of deniedSuffixes) {
      assert.equal(externalOpenPath(`${root}document.${suffix}`), false, suffix);
      assert.equal(externalOpenPath(`${root}document.${suffix.toUpperCase()}`), false, suffix);
    }
    for (const name of ['file.blend', 'file.unknown', 'file.EXE.blend', 'exe', 'file', 'file.'])
      assert.equal(externalOpenPath(root + name), true, name);
  }
});

test('external document samples exclude executable and launcher signatures regardless of suffix', () => {
  for (const hex of [
    '4d5a',
    '7f454c46',
    'feedface',
    'feedfacf',
    'cefaedfe',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
    '4c00000001140200',
    '2321',
  ]) {
    assert.equal(externalOpenSample(Buffer.concat([Buffer.from(hex, 'hex'), documentBytes])), false, hex);
  }
  expect(externalOpenSample(documentBytes)).toBe(true);
});

test('external document samples exclude encoded text and incomplete byte-order marks', () => {
  for (const hex of ['efbbbf', 'fffe', 'feff', 'fffe0000', '0000feff']) {
    const mark = Buffer.from(hex, 'hex');
    assert.equal(externalOpenSample(Buffer.concat([mark, documentBytes])), false, hex);
    for (let length = 1; length < mark.length; length++)
      assert.equal(externalOpenSample(mark.subarray(0, length)), false, `${hex} prefix ${length}`);
  }
  for (const bytes of [
    [],
    [0],
    [65],
    [65, 0],
    [0, 65],
    [65, 0, 66, 0],
    [0, 65, 0, 66],
    [65, 0, 66],
    [0, 65, 0],
    [65, 66, 67],
  ])
    assert.equal(externalOpenSample(Uint8Array.from(bytes)), false, String(bytes));
  for (const bytes of [
    [65, 0, 0],
    [0, 65, 66],
    [65, 66, 0],
    [0, 0, 65],
  ])
    assert.equal(externalOpenSample(Uint8Array.from(bytes)), true, String(bytes));
  const beyond = Buffer.alloc(1024, 65);
  beyond[512] = 0;
  expect(externalOpenSample(beyond)).toBe(false);
});

function readerFixture(bytes = documentBytes) {
  const events: string[] = [];
  const unmapped: string[] = [];
  const reads: Array<{ offset: number; length: number; position: number; buffer: Buffer }> = [];
  const file = '/owned/Mixed Folder/document.blend';
  let mode = 0o644;
  let kind = 'file';
  let descriptorKind = 'file';
  let descriptorMode: number | undefined;
  let fail = '';
  let chunk = 512;
  const io: ExternalOpenFs = {
    constants: { O_RDONLY: 0x100, O_NONBLOCK: 0x200 },
    lstat: async (target) => {
      if (target !== file) {
        unmapped.push(target);
        throw new Error('unmapped test file');
      }
      events.push('lstat');
      if (fail === 'lstat') throw new Error('metadata unavailable');
      return { isFile: () => kind === 'file', isSymbolicLink: () => kind === 'symlink', mode };
    },
    open: async (target, flags) => {
      if (target !== file) {
        unmapped.push(target);
        throw new Error('unmapped test file');
      }
      events.push(`open:${flags}`);
      if (fail === 'open') throw new Error('open unavailable');
      return {
        stat: async () => {
          events.push('stat');
          if (fail === 'stat') throw new Error('descriptor metadata unavailable');
          return { isFile: () => descriptorKind === 'file', mode: descriptorMode ?? mode };
        },
        read: async (buffer, offset, length, position) => {
          events.push('read');
          reads.push({ buffer, offset, length, position });
          if (fail === 'read') throw new Error('read unavailable');
          const bytesRead = Math.min(chunk, length, Math.max(0, bytes.length - position));
          bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        close: async () => {
          events.push('close');
          if (fail === 'close') throw new Error('close unavailable');
        },
      };
    },
  };
  return {
    io,
    file,
    events,
    reads,
    read: async (platform: NodeJS.Platform, target = file) => {
      const result = await externalOpenEligible(target, platform, io);
      expect(unmapped).toEqual([]);
      return result;
    },
    configure: (changes: {
      mode?: number;
      kind?: string;
      descriptorKind?: string;
      descriptorMode?: number;
      fail?: string;
      chunk?: number;
    }) => {
      mode = changes.mode ?? mode;
      kind = changes.kind ?? kind;
      descriptorKind = changes.descriptorKind ?? descriptorKind;
      descriptorMode = changes.descriptorMode ?? descriptorMode;
      fail = changes.fail ?? fail;
      chunk = changes.chunk ?? chunk;
    },
  };
}

describe.each(['win32', 'darwin', 'linux'] as const)('external document reader on %s', (platform) => {
  test('rejects excluded suffixes before any metadata or read operation', async () => {
    const f = readerFixture();
    expect(await f.read(platform, '/owned/document.EXE')).toBe(false);
    expect(f.events).toEqual([]);
  });
  test('accumulates short reads through EOF in one bounded buffer', async () => {
    const f = readerFixture();
    f.configure({ chunk: 2 });
    expect(await f.read(platform)).toBe(true);
    expect(f.events.at(-1)).toBe('close');
    expect(f.events[1]).toBe(platform === 'win32' ? 'open:256' : 'open:768');
    expect(f.reads.map(({ offset, length, position }) => [offset, length, position])).toEqual([
      [0, 512, 0],
      [2, 510, 2],
      [4, 508, 4],
      [6, 506, 6],
      [8, 504, 8],
      [9, 503, 9],
    ]);
    expect(new Set(f.reads.map(({ buffer }) => buffer)).size).toBe(1);
    expect(f.reads[0].buffer.length).toBe(512);
  });

  test('never reads or inspects beyond byte 511', async () => {
    const bytes = Buffer.alloc(4096, 65);
    bytes[512] = 0;
    const f = readerFixture(bytes);
    f.configure({ chunk: 100 });
    expect(await f.read(platform)).toBe(false);
    expect(f.reads.map(({ offset, length, position }) => [offset, length, position])).toEqual([
      [0, 512, 0],
      [100, 412, 100],
      [200, 312, 200],
      [300, 212, 300],
      [400, 112, 400],
      [500, 12, 500],
    ]);
    expect(f.events.at(-1)).toBe('close');
    bytes[511] = 0;
    expect(await f.read(platform)).toBe(true);
  });

  test('rejects observed nonregular files and descriptor replacements without reading', async () => {
    for (const kind of ['symlink', 'directory', 'fifo', 'socket', 'device']) {
      const f = readerFixture();
      f.configure({ kind });
      assert.equal(await f.read(platform), false, kind);
      expect(f.events).toEqual(['lstat']);
    }
    for (const descriptorKind of ['directory', 'fifo', 'socket', 'device']) {
      const f = readerFixture();
      f.configure({ descriptorKind });
      assert.equal(await f.read(platform), false, descriptorKind);
      expect(f.reads).toEqual([]);
      expect(f.events.at(-1)).toBe('close');
    }
  });

  test('checks executable permission bits only on POSIX at both metadata boundaries', async () => {
    for (const bit of [0o100, 0o010, 0o001]) {
      for (const boundary of ['mode', 'descriptorMode'] as const) {
        const f = readerFixture();
        f.configure({ [boundary]: 0o644 | bit });
        expect(await f.read(platform)).toBe(platform === 'win32');
        expect(f.reads.length > 0).toBe(platform === 'win32');
      }
    }
  });

  test('fails eligibility on metadata, open, read, or close errors and closes every opened descriptor', async () => {
    for (const fail of ['lstat', 'open', 'stat', 'read', 'close']) {
      const f = readerFixture();
      f.configure({ fail });
      assert.equal(await f.read(platform), false, fail);
      expect(f.events.filter((event) => event === 'close').length).toBe(['lstat', 'open'].includes(fail) ? 0 : 1);
    }
    for (const bytes of [Buffer.alloc(0), Buffer.from([0]), Buffer.from('plain text')]) {
      const f = readerFixture(bytes);
      expect(await f.read(platform)).toBe(false);
      expect(f.events.at(-1)).toBe('close');
    }
  });
});
