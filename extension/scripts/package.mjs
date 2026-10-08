import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const sizeNotice = /^The file extension\/dist\/extension\.js is large \([^)]+\)\r?\n$/;

// Windows filesystem modes do not retain execute permission in a cross-platform VSIX.
async function executableLauncher(file) {
  const bytes = await readFile(file);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557)) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    end -= 1;
  }
  if (end < Math.max(0, bytes.length - 65_557)) throw new Error('The VSIX directory is unavailable.');
  let found = false;
  for (let at = bytes.readUInt32LE(end + 16); at < end;) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('The VSIX directory is invalid.');
    const nameBytes = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameBytes);
    if (name === 'extension/dist/bin/arc') {
      bytes[at + 5] = 3;
      bytes.writeUInt32LE((0o100755 << 16) >>> 0, at + 38);
      found = true;
    }
    at += 46 + nameBytes + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (!found) throw new Error('The Arc launcher is missing from the VSIX.');
  await writeFile(file, bytes);
}

const child = spawn(process.execPath, [vsce, 'package', ...process.argv.slice(2)], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'inherit'],
});

let stdout = '';
let archive = null;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  let end = stdout.indexOf('\n');
  while (end !== -1) {
    const line = stdout.slice(0, end + 1);
    stdout = stdout.slice(end + 1);
    // VSCE resolves output overrides, directory outputs, target names, and version options.
    const packaged = /^\s*(?:DONE\s+)?Packaged: (.+) \(\d+ files, [^)]+\)\s*$/.exec(stripVTControlCharacters(line));
    if (packaged) archive = path.resolve(root, packaged[1]);
    if (!sizeNotice.test(line)) {
      process.stdout.write(line);
    }
    end = stdout.indexOf('\n');
  }
});
child.stdout.on('end', () => {
  if (stdout) {
    process.stdout.write(stdout);
  }
});
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
  if (code === 0) {
    void (async () => {
      if (!archive) throw new Error('VSCE did not identify the packaged archive.');
      await executableLauncher(archive);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
});
