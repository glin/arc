// plugins/arc-hooks/scripts/lib.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  writeFileAtomically,
  replaceFileAtomically,
  withIndexLock,
  baselineTransaction,
  baselineTransactions,
  createBaselineTransaction,
  removeBaselineTransaction,
} = require('./persistence.js');

// `ARC_HOME` names the store home, and snapshots sit below it.
function storeRoot() {
  if (process.env.ARC_HOME) return path.join(process.env.ARC_HOME, 'snapshots');
  return path.join(os.homedir(), '.arc', 'snapshots');
}
function sessionDir(sessionId) {
  return path.join(storeRoot(), sessionId);
}
function claudeConfigHome() {
  return path.normalize(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}
function codexHome() {
  return path.normalize(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
function keyFor(absPath) {
  return crypto.createHash('sha1').update(absPath).digest('hex');
}

// Locations the agent writes to for itself -- scratch plans, memory, internal state -- which
// are not changes the user wants to review. Edits anywhere else, including other repos the
// user asked the agent to touch, are still captured. The turn timeline hides the same
// paths, and test/fixtures/ephemeral-paths.json holds the cases both sides must agree on.
// Override with ARC_IGNORE_ROOTS, separated like PATH entries (':' on POSIX, ';' on Windows,
// where ':' would split absolute paths at the drive letter); set empty to disable, e.g. in
// tests.
function ignoreRoots() {
  const env = process.env.ARC_IGNORE_ROOTS;
  if (env !== undefined) return env.split(path.delimiter).filter(Boolean);
  const arcHome = path.resolve(process.env.ARC_HOME || path.join(os.homedir(), '.arc'));
  return [os.tmpdir(), claudeConfigHome(), codexHome(), arcHome];
}
// Path shapes differ between what a tool reports and what the OS hands back: separators,
// a trailing slash, and on Windows the case of the drive letter. All three must be
// levelled before comparing, or the same file counts as scratch on one side of the
// extension and as the user's work on the other. This must stay in step with
// `normalizeFsPath` in extension/src/transcript.ts; test/fixtures/ephemeral-paths.json is
// run by both test suites to catch the two drifting apart.
function normalizePath(target) {
  const unified = String(target).replace(/\\/g, '/').replace(/\/$/, '');
  const drive = /^([a-zA-Z]):\//.exec(unified);
  const cased = drive ? drive[1].toLowerCase() + unified.slice(1) : unified;
  return process.platform === 'win32' ? cased.toLowerCase() : cased;
}
function isEphemeral(absPath) {
  const t = normalizePath(absPath);
  return ignoreRoots().some((root) => {
    const r = normalizePath(root);
    return t === r || t.startsWith(r + '/');
  });
}

function readIndex(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.cwd !== null && typeof value.cwd !== 'string') ||
      !value.files ||
      typeof value.files !== 'object' ||
      Array.isArray(value.files)
    ) {
      return { cwd: null, files: {} };
    }
    for (const info of Object.values(value.files)) {
      if (
        !info ||
        typeof info !== 'object' ||
        Array.isArray(info) ||
        typeof info.path !== 'string' ||
        !info.path ||
        typeof info.isNew !== 'boolean'
      ) {
        return { cwd: null, files: {} };
      }
    }
    return value;
  } catch {
    return { cwd: null, files: {} };
  }
}

function writeIndex(dir, idx) {
  writeFileAtomically(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2));
}

function materializeBaseline(dir, transaction) {
  const baselineFile = path.join(dir, 'baseline', transaction.key);
  if (!fs.existsSync(baselineFile)) {
    replaceFileAtomically(baselineFile, (temporary) => fs.copyFileSync(transaction.baseline, temporary));
  }
  return baselineFile;
}

// Baseline bytes and pending writers retain history even without their index metadata.
function hasSnapshotHistory(dir) {
  if (Object.keys(readIndex(dir).files).length > 0) return true;
  for (const name of ['baseline', 'pending-baselines']) {
    try {
      if (fs.readdirSync(path.join(dir, name)).length > 0) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return Array.isArray(manifest.files) && manifest.files.length > 0;
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
    return false;
  }
}

// The caller holds the session index lock through recovery and publication.
function recoverBaselineTransactions(dir, cwd) {
  const transactions = baselineTransactions(dir);
  for (const transaction of transactions) materializeBaseline(dir, transaction);
  const idx = readIndex(dir);
  for (const transaction of transactions) {
    idx.files[transaction.key] = { path: transaction.path, isNew: transaction.isNew };
    if (!idx.cwd && transaction.cwd) idx.cwd = transaction.cwd;
  }
  if (cwd) idx.cwd = cwd;
  if (transactions.length > 0 || cwd) writeIndex(dir, idx);
  for (const transaction of transactions) removeBaselineTransaction(transaction);
  return idx;
}

function recordBaseline(sessionId, absPath, cwd) {
  const dir = sessionDir(sessionId);
  if (isEphemeral(absPath)) {
    if (!hasSnapshotHistory(dir)) return { skipped: true };
    return withIndexLock(dir, () => {
      const idx = readIndex(dir);
      if (cwd) idx.cwd = cwd;
      writeIndex(dir, idx);
      return { skipped: true };
    });
  }
  const key = keyFor(absPath);
  const baselineFile = path.join(dir, 'baseline', key);
  const before = readIndex(dir);
  if (before.files[key] && fs.existsSync(baselineFile)) {
    const result = withIndexLock(dir, () => {
      const idx = readIndex(dir);
      if (cwd) idx.cwd = cwd;
      writeIndex(dir, idx);
      return { skipped: true };
    });
    removeBaselineTransaction(baselineTransaction(dir, key));
    return result;
  }
  let transaction = baselineTransaction(dir, key);
  const isNew =
    transaction?.isNew ?? before.files[key]?.isNew ?? (!fs.existsSync(baselineFile) && !fs.existsSync(absPath));
  if (!transaction && !fs.existsSync(baselineFile)) {
    transaction = createBaselineTransaction(dir, key, absPath, isNew, cwd);
  }
  const result = withIndexLock(dir, () => {
    // Stop can finish a published transaction while this writer waits for the lock.
    transaction = baselineTransaction(dir, key);
    if (transaction) materializeBaseline(dir, transaction);
    const idx = readIndex(dir);
    if (cwd) idx.cwd = cwd;
    if (!transaction && !fs.existsSync(baselineFile)) {
      throw new Error(`Missing baseline transaction for ${absPath}`);
    }
    const saved = idx.files[key];
    const recordedIsNew = transaction?.isNew ?? saved?.isNew ?? isNew;
    idx.files[key] = { path: transaction?.path || saved?.path || absPath, isNew: recordedIsNew };
    writeIndex(dir, idx);
    removeBaselineTransaction(transaction);
    return { skipped: false, isNew: recordedIsNew };
  });
  return result;
}

function computeManifest(sessionId, cwd) {
  const dir = sessionDir(sessionId);
  if (!hasSnapshotHistory(dir)) return [];
  return withIndexLock(dir, () => manifestEntries(dir, recoverBaselineTransactions(dir, cwd)));
}

function manifestEntries(dir, idx) {
  const entries = [];
  for (const [key, info] of Object.entries(idx.files || {})) {
    if (!fs.existsSync(info.path)) continue; // deletions not tracked in v1
    const baselineFile = path.join(dir, 'baseline', key);
    let baseline = Buffer.alloc(0);
    try {
      baseline = fs.readFileSync(baselineFile);
    } catch {
      /* missing -> treat as empty */
    }
    const current = fs.readFileSync(info.path);
    const pending = info.isNew ? true : !current.equals(baseline);
    if (pending) entries.push({ path: info.path, snapshot: baselineFile, isNew: info.isNew });
  }
  return entries;
}

// Extract the session's AI-generated title from its transcript (the last `ai-title`
// entry wins). Returns null if unavailable (e.g. title not generated yet).
const TITLE_TAIL_BYTES = 256 * 1024;
function readSessionTitle(transcriptPath) {
  if (!transcriptPath) return null;
  let fd = -1;
  let lines;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const windowStart = Math.max(0, size - TITLE_TAIL_BYTES);
    const start = windowStart > 0 ? windowStart - 1 : 0;
    const buffer = Buffer.allocUnsafe(size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (count <= 0) break;
      read += count;
    }
    lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines.shift();
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('ai-title') === -1) continue; // cheap prefilter
    try {
      const o = JSON.parse(line);
      if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) return o.aiTitle;
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

function writeManifest(sessionId, entries, title) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const idx = readIndex(dir);
  writeFileAtomically(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ sessionId, cwd: idx.cwd || null, title: title || null, files: entries }, null, 2),
  );
  writeFileAtomically(path.join(dir, 'trigger'), String(Date.now()));
}

function publishManifest(sessionId, cwd, title) {
  const dir = sessionDir(sessionId);
  if (!hasSnapshotHistory(dir)) return;
  withIndexLock(dir, () => {
    const idx = recoverBaselineTransactions(dir, cwd);
    writeManifest(sessionId, manifestEntries(dir, idx), title);
  });
}

module.exports = {
  storeRoot,
  sessionDir,
  claudeConfigHome,
  codexHome,
  keyFor,
  readIndex,
  writeIndex,
  recordBaseline,
  computeManifest,
  writeManifest,
  publishManifest,
  readSessionTitle,
  isEphemeral,
  TITLE_TAIL_BYTES,
};
