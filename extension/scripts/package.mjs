import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const sizeNotice = /^The file extension\/dist\/extension\.js is large \([^)]+\)\r?\n$/;
const child = spawn(process.execPath, [vsce, 'package', ...process.argv.slice(2)], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'inherit'],
});

let stdout = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  let end = stdout.indexOf('\n');
  while (end !== -1) {
    const line = stdout.slice(0, end + 1);
    stdout = stdout.slice(end + 1);
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
});
