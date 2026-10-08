import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'extension', 'resources');
const sourceFile = path.join(root, 'extension', 'src', 'windowpipe-source.ts');
const binaryFile = path.join(resources, 'windowpipe.exe');
const identityFile = path.join(resources, 'windowpipe.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHash = () => hash(fs.readFileSync(sourceFile, 'utf8').replace(/\r\n/g, '\n'));

export function copyWindowsPipe(destination) {
  const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  if (identity.source !== sourceHash() || identity.binary !== hash(fs.readFileSync(binaryFile))) {
    throw new Error(
      'The Windows pipe bridge does not match its source. Run node scripts/windowpipe-build.mjs --refresh on Windows.',
    );
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(binaryFile, path.join(destination, 'windowpipe.exe'));
}

if (process.argv.includes('--refresh')) {
  if (process.platform !== 'win32') throw new Error('Refresh the Windows pipe bridge on Windows.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-pipe-build-'));
  try {
    const text = fs.readFileSync(sourceFile, 'utf8');
    const source = text.slice(text.indexOf('String.raw`') + 11, text.lastIndexOf('`;'));
    const input = path.join(directory, 'bridge.cs');
    fs.writeFileSync(input, source);
    fs.mkdirSync(resources, { recursive: true });
    execFileSync(
      path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      ['/nologo', '/optimize+', '/target:exe', `/out:${binaryFile}`, input],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 },
    );
    fs.writeFileSync(
      identityFile,
      JSON.stringify({ source: sourceHash(), binary: hash(fs.readFileSync(binaryFile)) }, null, 2) + '\n',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
