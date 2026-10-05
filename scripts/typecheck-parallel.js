// scripts/typecheck-parallel.js
//
// Runs every project's type check at the same time instead of one after another. Each check
// keeps its own output buffered so two checks running together never interleave their lines,
// and the run fails if any check fails, naming which one.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const extensionDir = path.join(root, 'extension');
const cliDir = path.join(root, 'cli');

// Resolves a package's own binary the same way tool-scope.test.js does, so a check runs the
// exact executable its package installed instead of whatever a shell would find on PATH.
function toolBin(packageName, binName, baseDir) {
  const packageFile = require.resolve(`${packageName}/package.json`, { paths: [baseDir] });
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  return path.join(path.dirname(packageFile), manifest.bin[binName]);
}

function tscArgs(baseDir, tsconfig) {
  return [toolBin('typescript', 'tsc', baseDir), '--noEmit', '-p', tsconfig];
}

const checks = [
  {
    label: 'extension webview globals',
    args: ['--import', 'tsx', 'scripts/check-webview-globals.ts'],
    cwd: extensionDir,
  },
  {
    label: 'extension tsc',
    args: tscArgs(extensionDir, 'tsconfig.json'),
    cwd: extensionDir,
  },
  {
    label: 'extension webview tsc',
    args: tscArgs(extensionDir, 'src/webview/tsconfig.json'),
    cwd: extensionDir,
  },
  {
    label: 'cli tsc',
    args: tscArgs(cliDir, 'tsconfig.json'),
    cwd: cliDir,
  },
];

function runCheck(check, spawnFn) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawnFn(check.command ?? process.execPath, check.args, {
      cwd: check.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      resolve({ label: check.label, status: 1, output: `${error.message}\n` });
    });
    child.on('close', (code) => {
      resolve({ label: check.label, status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

// Runs every check at the same time and reports each one's outcome once every check has
// finished, so a fast check's output never interleaves with a slow one's. Returns the failed
// labels instead of exiting directly, so a caller can assert on the outcome without a real
// process exit getting in the way.
async function runChecks(checksToRun, { spawnFn = spawn, log = console.log, logError = console.error } = {}) {
  const results = await Promise.all(checksToRun.map((check) => runCheck(check, spawnFn)));
  const failed = [];
  for (const result of results) {
    const status = result.status === 0 ? 'passed' : 'failed';
    log(`--- ${result.label} (${status}) ---`);
    if (result.output.trim().length > 0) {
      log(result.output.trimEnd());
    }
    if (result.status !== 0) {
      failed.push(result.label);
    }
  }
  if (failed.length > 0) {
    logError(`\nType check failed: ${failed.join(', ')}`);
  }
  return failed;
}

async function main() {
  const failed = await runChecks(checks);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

module.exports = { runChecks, checks };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
