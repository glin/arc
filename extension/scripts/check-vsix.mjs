import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = resolve(process.argv[2] ?? join(extensionRoot, 'arc.vsix'));
const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const expectedFiles = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.txt',
  'extension/dist/extension.js',
  'extension/dist/build-identity.json',
  'extension/dist/cli.cjs',
  'extension/dist/export-viewer.js',
  'extension/dist/export-viewer.css',
  'extension/dist/windowpipe.exe',
  'extension/dist/bin/arc',
  'extension/dist/bin/arc.cmd',
  'extension/package.json',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readArchive(file) {
  const zip = await new Promise((resolveZip, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, opened) => (error ? reject(error) : resolveZip(opened)));
  });
  return new Promise((resolveEntries, reject) => {
    const entries = new Map();
    zip.on('error', reject);
    zip.on('end', () => resolveEntries(entries));
    zip.on('entry', (entry) => {
      if (entry.fileName === 'extension/dist/bin/arc') {
        assert.equal(entry.versionMadeBy >> 8, 3, 'Arc launcher permissions need a Unix archive identity');
        assert.equal((entry.externalFileAttributes >>> 16) & 0o777, 0o755, 'Arc launcher is not executable');
      }
      zip.openReadStream(entry, async (error, stream) => {
        if (error) return reject(error);
        try {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          entries.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        } catch (readError) {
          reject(readError);
        }
      });
    });
    zip.readEntry();
  });
}

const entries = await readArchive(archive);
assert.deepEqual([...entries.keys()].sort(), expectedFiles.sort(), 'VSIX contents differ from the release allowlist');
const packaged = JSON.parse(entries.get('extension/package.json').toString('utf8'));
for (const key of ['name', 'publisher', 'version', 'engines', 'main']) {
  assert.deepEqual(packaged[key], manifest[key], `packaged ${key} differs from the source manifest`);
}
assert.equal(`${packaged.publisher}.${packaged.name}`, 'glin.arc');
const vsixManifest = entries.get('extension.vsixmanifest').toString('utf8');
assert.match(
  vsixManifest,
  new RegExp(`<Identity [^>]*Id="arc" [^>]*Version="${packaged.version.replaceAll('.', '\\.')}" Publisher="glin"`),
);
assert.equal(
  sha256(entries.get('extension/dist/extension.js')),
  sha256(await readFile(join(extensionRoot, 'dist', 'extension.js'))),
  'VSIX bundle differs from the current build',
);
for (const file of ['cli.cjs', 'export-viewer.js', 'export-viewer.css', 'bin/arc', 'bin/arc.cmd', 'windowpipe.exe']) {
  assert.equal(
    sha256(entries.get(`extension/dist/${file}`)),
    sha256(await readFile(join(extensionRoot, 'dist', file))),
    `VSIX ${file} differs from the current build`,
  );
}
console.log(`Checked ${basename(archive)}: glin.arc ${packaged.version} and ${entries.size} allowed files.`);
