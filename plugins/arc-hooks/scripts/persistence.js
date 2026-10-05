const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TEMPORARY_GRACE_MILLISECONDS = 60_000;
const TEMPORARY_NAME = /^(.+)\.(\d+)\.(\d+)\.[^.]+\.tmp$/;
const INDEX_QUEUE_RETRY_MILLISECONDS = 10;
const FILE_REPLACE_MAX_ATTEMPTS = 10;
const FILE_REPLACE_RETRY_MILLISECONDS = 20;
const INDEX_REQUEST_STALE_MILLISECONDS = 30_000;
const PROCESS_START_TOLERANCE_MILLISECONDS = 2_000;
const SELF_PROCESS_STARTED_AT = Date.now() - process.uptime() * 1_000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function processStartedAt(pid) {
  if (pid === process.pid) return SELF_PROCESS_STARTED_AT;
  try {
    if (process.platform === 'win32') {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
        windowsHide: true,
      }).trim();
      const startedAt = Date.parse(value);
      return Number.isFinite(startedAt) ? startedAt : null;
    }
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    const startedAt = Date.parse(value);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

function processOwnsRequest(pid, createdAt, now) {
  if (!processIsRunning(pid)) return false;
  if (now - createdAt <= INDEX_REQUEST_STALE_MILLISECONDS) return true;
  const startedAt = processStartedAt(pid);
  return startedAt === null || startedAt <= createdAt + PROCESS_START_TOLERANCE_MILLISECONDS;
}

function removeStaleTemporaries(target) {
  const directory = path.dirname(target);
  const targetName = path.basename(target);
  const now = Date.now();
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const parts = TEMPORARY_NAME.exec(name);
    if (!parts || parts[1] !== targetName) continue;
    const pid = Number(parts[2]);
    const createdAt = Number(parts[3]);
    if (pid !== process.pid && (now - createdAt < TEMPORARY_GRACE_MILLISECONDS || processIsRunning(pid))) continue;
    try {
      fs.unlinkSync(path.join(directory, name));
    } catch {
      /* another writer removed it */
    }
  }
}

function replaceFileAtomically(target, writeTemporary, replace = fs.renameSync) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  removeStaleTemporaries(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    writeTemporary(temporary);
    for (let attempt = 1; ; attempt++) {
      try {
        replace(temporary, target);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt >= FILE_REPLACE_MAX_ATTEMPTS) throw error;
        Atomics.wait(waitCell, 0, 0, FILE_REPLACE_RETRY_MILLISECONDS);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* the rename already took it */
    }
  }
}

function writeFileAtomically(target, data, replace) {
  replaceFileAtomically(target, (temporary) => fs.writeFileSync(temporary, data), replace);
}

function indexRequest(requestDir, name) {
  const [pidText, createdText] = name.split('-', 2);
  const pid = Number(pidText);
  const createdAt = Number(createdText);
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !Number.isFinite(createdAt) ||
    !processOwnsRequest(pid, createdAt, Date.now())
  )
    return null;
  let states;
  try {
    states = fs.readdirSync(requestDir);
  } catch {
    return { name, pid, choosing: true, ticket: 0 };
  }
  if (states.includes('choosing')) return { name, pid, choosing: true, ticket: 0 };
  const tickets = states.flatMap((state) => {
    const match = /^ticket-(\d+)$/.exec(state);
    const ticket = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(ticket) && ticket > 0 ? [ticket] : [];
  });
  return tickets.length === 1
    ? { name, pid, choosing: false, ticket: tickets[0] }
    : { name, pid, choosing: true, ticket: 0 };
}

function indexRequests(queueDir) {
  let names;
  try {
    names = fs.readdirSync(queueDir).filter((name) => name.endsWith('.request'));
  } catch {
    return [];
  }
  const requests = [];
  for (const name of names) {
    const requestDir = path.join(queueDir, name);
    const request = indexRequest(requestDir, name);
    if (request) {
      requests.push(request);
      continue;
    }
    // Request names are unique for one process invocation. Removing an abandoned request
    // cannot remove a later writer's ownership, even if another process cleans it first.
    try {
      fs.rmSync(requestDir, { recursive: true, force: true });
    } catch {
      /* already removed */
    }
  }
  return requests;
}

function requestComesFirst(left, right) {
  return left.ticket < right.ticket || (left.ticket === right.ticket && left.name < right.name);
}

function acquireIndexLock(dir) {
  const queueDir = path.join(dir, 'index-lock');
  fs.mkdirSync(queueDir, { recursive: true });
  const name = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.request`;
  const requestDir = path.join(queueDir, name);
  const preparing = `${requestDir}.preparing`;
  try {
    fs.mkdirSync(preparing);
    fs.writeFileSync(path.join(preparing, 'choosing'), '');
    fs.renameSync(preparing, requestDir);
  } finally {
    try {
      fs.rmSync(preparing, { recursive: true, force: true });
    } catch {
      /* rename took it */
    }
  }
  const ticket = indexRequests(queueDir).reduce((highest, request) => Math.max(highest, request.ticket), 0) + 1;
  fs.renameSync(path.join(requestDir, 'choosing'), path.join(requestDir, `ticket-${ticket}`));
  const own = { name, pid: process.pid, choosing: false, ticket };
  while (true) {
    const blocked = indexRequests(queueDir).some(
      (request) => request.name !== name && (request.choosing || requestComesFirst(request, own)),
    );
    if (!blocked) break;
    Atomics.wait(waitCell, 0, 0, INDEX_QUEUE_RETRY_MILLISECONDS);
  }
  return () => {
    try {
      fs.rmSync(requestDir, { recursive: true, force: true });
    } catch {
      /* already removed */
    }
  };
}

function withIndexLock(dir, work) {
  const release = acquireIndexLock(dir);
  try {
    return work();
  } finally {
    release();
  }
}

function baselineTransaction(dir, key) {
  if (!/^[a-f0-9]{40}$/.test(key)) return null;
  const transactionDir = path.join(dir, 'pending-baselines', key);
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(path.join(transactionDir, 'entry.json'), 'utf8'));
  } catch {
    return null;
  }
  const baseline = path.join(transactionDir, 'baseline');
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    typeof entry.path !== 'string' ||
    !entry.path ||
    typeof entry.isNew !== 'boolean' ||
    (entry.cwd !== null && typeof entry.cwd !== 'string') ||
    !fs.existsSync(baseline)
  )
    return null;
  return { path: entry.path, isNew: entry.isNew, cwd: entry.cwd, baseline, transactionDir, key };
}

function baselineTransactions(dir) {
  const parent = path.join(dir, 'pending-baselines');
  let keys;
  try {
    keys = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return keys.flatMap((key) => {
    const transaction = baselineTransaction(dir, key);
    return transaction ? [transaction] : [];
  });
}

function createBaselineTransaction(dir, key, absPath, isNew, cwd) {
  const parent = path.join(dir, 'pending-baselines');
  const transactionDir = path.join(parent, key);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${transactionDir}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(temporary);
    const baseline = path.join(temporary, 'baseline');
    if (isNew) fs.writeFileSync(baseline, '');
    else fs.copyFileSync(absPath, baseline);
    fs.writeFileSync(path.join(temporary, 'entry.json'), JSON.stringify({ path: absPath, isNew, cwd: cwd || null }));
    try {
      fs.renameSync(temporary, transactionDir);
    } catch (error) {
      if (!fs.existsSync(transactionDir)) throw error;
    }
  } finally {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      /* rename took it */
    }
  }
  return baselineTransaction(dir, key);
}

function removeBaselineTransaction(transaction) {
  if (!transaction) return;
  try {
    fs.rmSync(transaction.transactionDir, { recursive: true, force: true });
  } catch {
    /* next touch retries */
  }
}

module.exports = {
  writeFileAtomically,
  replaceFileAtomically,
  withIndexLock,
  baselineTransaction,
  baselineTransactions,
  createBaselineTransaction,
  removeBaselineTransaction,
};
