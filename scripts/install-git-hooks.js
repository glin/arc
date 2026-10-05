// Points Git at .githooks when this package folder is the root of its own Git repository.
// A copy of the folder inside another repository leaves that repository's hook settings alone.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');

function git(...args) {
  return execFileSync('git', args, { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

let topLevel;
try {
  topLevel = git('rev-parse', '--show-toplevel');
} catch {
  process.exit(0);
}

if (fs.realpathSync.native(topLevel) === fs.realpathSync.native(packageRoot)) {
  git('config', 'core.hooksPath', '.githooks');
}
