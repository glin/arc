// Runs checks concurrently, at most two at a time, and groups output unless streaming is requested.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const extensionDir = path.join(root, 'extension');
const cliDir = path.join(root, 'cli');

// Resolves the executable installed by the requested package in its project directory.
function toolBin(packageName, binName, baseDir) {
  const packageFile = require.resolve(`${packageName}/package.json`, { paths: [baseDir] });
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  return path.join(path.dirname(packageFile), manifest.bin[binName]);
}

function tscArgs(baseDir, tsconfig) {
  return [toolBin('typescript', 'tsc', baseDir), '--noEmit', '-p', tsconfig];
}

function compilerChecks() {
  return [
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
}

function runCheck(
  check,
  { spawnFn, stream, write, writeError, signal, onResult, onOutput, platform, killGroup, killWindowsTree },
) {
  return new Promise((resolve) => {
    const chunks = [];
    let child;
    let settled = false;
    let fallback;
    let aborting = false;
    let groupRetired = false;
    const finish = (status, childSignal = null, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      signal?.removeEventListener('abort', abort);
      const result = {
        label: check.label,
        status: status ?? 1,
        signal: childSignal,
        error,
        output: Buffer.concat(chunks).toString('utf8'),
      };
      check.observe?.({ exitCode: status, signal: childSignal, error });
      onResult?.(result);
      resolve(result);
    };
    const abort = () => {
      if (!child) return;
      aborting = true;
      if (platform === 'win32' && child.pid) {
        if (!killWindowsTree(child.pid)) child.kill('SIGTERM');
      } else if (child.pid) {
        try {
          killGroup(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      } else child.kill?.('SIGTERM');
      if (!settled) {
        fallback = setTimeout(() => {
          if (child.pid && platform !== 'win32') {
            try {
              killGroup(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          } else child.kill?.('SIGKILL');
        }, 5_000);
        fallback.unref?.();
      }
    };
    if (signal?.aborted) return finish(null, 'SIGTERM');
    try {
      child = spawnFn(check.command ?? process.execPath, check.args, {
        cwd: check.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        ...(check.env ? { env: check.env } : {}),
      });
    } catch (error) {
      return finish(null, null, error.message);
    }
    check.observe?.({ childPid: child.pid ?? null, started: true });
    signal?.addEventListener('abort', abort, { once: true });
    const output = (chunk, stderr) => {
      onOutput?.(check, chunk, stderr);
      if (stream) (stderr ? writeError : write)(chunk);
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => output(chunk, false));
    child.stderr.on('data', (chunk) => output(chunk, true));
    child.on('error', (error) => {
      output(Buffer.from(`${error.message}\n`), true);
      finish(null, null, error.message);
    });
    const retireGroup = (code, signal) => {
      if (
        !groupRetired &&
        child.pid &&
        platform !== 'win32' &&
        (aborting || signal || [129, 130, 143].includes(code))
      ) {
        groupRetired = true;
        try {
          killGroup(-child.pid, 'SIGKILL');
        } catch {
          /* The owned group has already closed. */
        }
      }
    };
    child.on('exit', retireGroup);
    child.on('close', (code, signal) => {
      retireGroup(code, signal);
      finish(code, signal ?? null);
    });
  });
}

// Each type check holds several hundred megabytes, so two run at once by default.
const CHECK_CONCURRENCY = 2;

// Start each check when a running one finishes, and keep results in check order.
async function runPooled(items, concurrency, start) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await start(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Reports results after all checks finish and returns the failed labels.
async function runChecks(
  checksToRun,
  {
    spawnFn = spawn,
    log = console.log,
    logError = console.error,
    stream = false,
    write = (chunk) => process.stdout.write(chunk),
    writeError = (chunk) => process.stderr.write(chunk),
    signal,
    onResult,
    onOutput,
    platform = process.platform,
    killGroup = process.kill,
    killWindowsTree = (pid) => {
      const result = require('node:child_process').spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
      return !result.error && result.status === 0;
    },
    concurrency = CHECK_CONCURRENCY,
  } = {},
) {
  const results = await runPooled(checksToRun, concurrency, (check) =>
    runCheck(check, {
      spawnFn,
      stream,
      write,
      writeError,
      signal,
      onResult,
      onOutput,
      platform,
      killGroup,
      killWindowsTree,
    }),
  );
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
    logError(`\nChecks failed: ${failed.join(', ')}`);
  }
  return failed;
}

async function main() {
  const failed = await runChecks(compilerChecks());
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

module.exports = {
  runChecks,
  compilerChecks,
  get checks() {
    return compilerChecks();
  },
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
