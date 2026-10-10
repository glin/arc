import { test } from 'vitest';
import assert from 'node:assert';
import {
  fileUriToPath,
  promptPath,
  resolveDroppedUris,
  uriStringsFromCommand,
  urisFromTransfer,
  type DropPlatform,
} from './droppeduris.ts';

const folders = new Set(['c:\\work\\proj\\src', '/home/me/proj/src', '/Users/me/Proj/src', '/home/me/other']);

function resolve(uris: string[], platform: DropPlatform, workingDirectory: string) {
  return resolveDroppedUris(uris, {
    workingDirectory,
    platform,
    isDirectory: async (path) => folders.has(platform === 'win32' ? path.toLowerCase() : path),
  });
}

test('Windows paths are relative inside the working directory, ignore case, and keep the dropped spelling', async () => {
  const result = await resolve(
    [
      'file:///c%3A/work/proj/SRC/Main.ts',
      'file:///c%3A/Work/Proj/src',
      'file:///c%3A/Work/Proj/My%20Notes.txt',
      'file:///d%3A/Elsewhere/a.ts',
    ],
    'win32',
    'C:\\Work\\Proj',
  );
  assert.equal(result.text, 'SRC\\Main.ts src\\ "My Notes.txt" d:\\Elsewhere\\a.ts');
  assert.deepEqual(result.images, []);
  assert.equal(result.skipped, 0);
});

test('a Windows working directory written with forward slashes still makes inside paths relative', async () => {
  const result = await resolve(
    ['file:///c%3A/Work/Proj/src', 'file:///c%3A/Work/Proj/a.ts', 'file:///d%3A/x.ts'],
    'win32',
    'C:/Work/Proj/',
  );
  assert.equal(result.text, 'src\\ a.ts d:\\x.ts');
  assert.equal(promptPath('C:\\Work\\Proj', true, 'C:/Work/Proj', 'win32'), '.\\');
});

test('Windows UNC URIs become UNC paths and a drop of the working directory names the dot folder', () => {
  assert.equal(fileUriToPath('file://server/share/a%20b.txt', 'win32'), '\\\\server\\share\\a b.txt');
  assert.equal(promptPath('C:\\Work\\Proj', true, 'C:\\Work\\Proj', 'win32'), '.\\');
  assert.equal(promptPath('C:\\Work\\ProjectX\\a.ts', false, 'C:\\Work\\Proj', 'win32'), 'C:\\Work\\ProjectX\\a.ts');
});

test('macOS and Linux compare case exactly, so a different case writes an absolute path', async () => {
  const mac = await resolve(
    ['file:///Users/me/Proj/src/a.ts', 'file:///Users/me/proj/src/b.ts', 'file:///Users/me/Proj/src'],
    'darwin',
    '/Users/me/Proj',
  );
  assert.equal(mac.text, 'src/a.ts /Users/me/proj/src/b.ts src/');
  const linux = await resolve(
    ['file:///home/me/proj/src/a%20b.ts', 'file:///home/me/proj/src', 'file:///home/me/other', 'file:///tmp/x.py'],
    'linux',
    '/home/me/proj',
  );
  assert.equal(linux.text, '"src/a b.ts" src/ /home/me/other/ /tmp/x.py');
});

test('file URIs read as paths only where the platform can hold them', () => {
  assert.equal(fileUriToPath('file:///c%3A/x', 'linux'), '/c:/x');
  assert.equal(fileUriToPath('file://server/share/x', 'linux'), null);
  assert.equal(fileUriToPath('file://localhost/etc/hosts', 'linux'), '/etc/hosts');
  assert.equal(fileUriToPath('file:///bad%E0%A4%A', 'linux'), null);
});

test('image files become attachments, and other files and folders become path text in order', async () => {
  const result = await resolve(
    [
      'file:///home/me/proj/a.PNG',
      'file:///home/me/proj/doc.pdf',
      'file:///home/me/proj/src',
      'file:///home/me/proj/a.PNG',
    ],
    'linux',
    '/home/me/proj',
  );
  assert.deepEqual(result.images, [{ path: '/home/me/proj/a.PNG', name: 'a.PNG', mime: 'image/png' }]);
  assert.equal(result.text, 'doc.pdf src/');
});

test('URIs that are not file URIs are skipped and counted', async () => {
  const result = await resolve(
    [
      'vscode-remote://ssh-remote+host/home/me/a.ts',
      'https://example.com/a.png',
      'untitled:Untitled-1',
      'file:///home/me/proj/ok.ts',
    ],
    'linux',
    '/home/me/proj',
  );
  assert.equal(result.text, 'ok.ts');
  assert.equal(result.skipped, 3);
});

test('each drag type yields its URIs, with type names matched without case', () => {
  const list = 'file:///a/one.ts\r\n# comment\r\nfile:///a/two.ts\r\n';
  assert.deepEqual(urisFromTransfer([{ type: 'application/vnd.code.uri-list', data: list }]), [
    'file:///a/one.ts',
    'file:///a/two.ts',
  ]);
  assert.deepEqual(urisFromTransfer([{ type: 'ResourceURLs', data: JSON.stringify(['file:///b/x.ts']) }]), [
    'file:///b/x.ts',
  ]);
  assert.deepEqual(urisFromTransfer([{ type: 'resourceurls', data: JSON.stringify(['file:///b/y.ts']) }]), [
    'file:///b/y.ts',
  ]);
  assert.deepEqual(
    urisFromTransfer([
      {
        type: 'codeeditors',
        data: JSON.stringify([
          { resource: { $mid: 1, external: 'file:///c/tab.ts', path: '/c/tab.ts', scheme: 'file' } },
          { resource: { fsPath: 'C:\\Users\\me\\My File.ts' } },
          { resource: { scheme: 'untitled', path: 'Untitled-1' } },
        ]),
      },
    ]),
    ['file:///c/tab.ts', 'file:///C%3A/Users/me/My%20File.ts', 'untitled://Untitled-1'],
  );
  assert.deepEqual(urisFromTransfer([{ type: 'text/uri-list', data: 'file:///d/z.ts' }]), ['file:///d/z.ts']);
  assert.deepEqual(
    urisFromTransfer([
      { type: 'codeeditors', data: 'not json' },
      { type: 'text/plain', data: 'x' },
    ]),
    [],
  );
});

test('the first drag type that yields a URI wins, so one item is not added twice', () => {
  assert.deepEqual(
    urisFromTransfer([
      { type: 'text/uri-list', data: 'file:///a/one.ts' },
      { type: 'ResourceURLs', data: JSON.stringify(['file:///a/one.ts']) },
      { type: 'application/vnd.code.uri-list', data: 'file:///a/one.ts' },
    ]),
    ['file:///a/one.ts'],
  );
});

test('Add to Arc takes the Explorer selection when it holds the clicked file, and the clicked file otherwise', async () => {
  const uri = (text: string) => ({ scheme: 'file', toString: () => text });
  const a = uri('file:///home/me/proj/a.ts');
  const b = uri('file:///home/me/proj/src');
  const c = uri('file:///home/me/proj/c.png');
  assert.deepEqual(uriStringsFromCommand(a, [a, b, c]), [
    'file:///home/me/proj/a.ts',
    'file:///home/me/proj/src',
    'file:///home/me/proj/c.png',
  ]);
  assert.deepEqual(uriStringsFromCommand(c, [a, b]), ['file:///home/me/proj/c.png']);
  assert.deepEqual(uriStringsFromCommand(a, undefined), ['file:///home/me/proj/a.ts']);
  assert.deepEqual(uriStringsFromCommand(undefined, undefined), []);
  assert.deepEqual(uriStringsFromCommand({}, [{}]), []);
  const result = await resolve(uriStringsFromCommand(a, [a, b, c]), 'linux', '/home/me/proj');
  assert.equal(result.text, 'a.ts src/');
  assert.deepEqual(
    result.images.map((image) => image.name),
    ['c.png'],
  );
});
