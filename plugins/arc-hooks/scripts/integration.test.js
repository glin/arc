// plugins/arc-hooks/scripts/integration.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function runHook(script, payload, root) {
  return execFileSync(process.execPath, [path.join(__dirname, `${script}.cjs`)], {
    input: JSON.stringify(payload),
    // Disable ignored roots so the hook captures edits in temporary test workspaces.
    env: { ...process.env, ARC_HOME: root, ARC_IGNORE_ROOTS: '' },
  });
}

function snapshotRoot(home) {
  return path.join(home, 'snapshots');
}

test('pretooluse-snapshot records a baseline from hook JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'BEFORE');

  runHook(
    'pretooluse-snapshot',
    {
      session_id: 'abc',
      cwd: work,
      tool_name: 'Edit',
      tool_input: { file_path: file },
    },
    root,
  );

  const snapshots = snapshotRoot(root);
  const idx = JSON.parse(fs.readFileSync(path.join(snapshots, 'abc', 'index.json'), 'utf8'));
  const key = Object.keys(idx.files)[0];
  assert.equal(fs.readFileSync(path.join(snapshots, 'abc', 'baseline', key), 'utf8'), 'BEFORE');
});

test('pretooluse-snapshot never throws on malformed input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [path.join(__dirname, 'pretooluse-snapshot.cjs')], {
      input: 'not json',
      env: { ...process.env, ARC_HOME: root, ARC_IGNORE_ROOTS: '' },
    }),
  );
});

test('read-only and ignored-only turns never create a snapshot session store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  for (let turn = 0; turn < 3; turn++) {
    runHook('stop-manifest', { session_id: 'read-only', cwd: work }, root);
    execFileSync(process.execPath, [path.join(__dirname, 'pretooluse-snapshot.cjs')], {
      input: JSON.stringify({
        session_id: 'ignored',
        cwd: work,
        tool_name: 'Write',
        tool_input: { file_path: path.join(work, 'plan.md') },
      }),
      env: { ...process.env, ARC_HOME: root, ARC_IGNORE_ROOTS: work },
    });
    runHook('stop-manifest', { session_id: 'ignored', cwd: work }, root);
  }
  assert.equal(fs.existsSync(path.join(snapshotRoot(root), 'read-only')), false);
  assert.equal(fs.existsSync(path.join(snapshotRoot(root), 'ignored')), false);
});

test('stop-manifest writes a manifest after edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'BEFORE');

  runHook(
    'pretooluse-snapshot',
    {
      session_id: 's9',
      cwd: work,
      tool_name: 'Edit',
      tool_input: { file_path: file },
    },
    root,
  );
  fs.writeFileSync(file, 'AFTER'); // simulate the edit

  runHook('stop-manifest', { session_id: 's9', cwd: work }, root);

  const m = JSON.parse(fs.readFileSync(path.join(snapshotRoot(root), 's9', 'manifest.json'), 'utf8'));
  assert.equal(m.files.length, 1);
  assert.equal(m.files[0].path, file);
});

test('stop-manifest completes a published first-touch transaction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'created.txt');
  const lib = require('./lib.js');
  const key = lib.keyFor(file);
  const snapshots = snapshotRoot(root);
  const pending = path.join(snapshots, 'recover', 'pending-baselines', key);
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'baseline'), '');
  fs.writeFileSync(
    path.join(pending, 'entry.json'),
    JSON.stringify({
      path: file,
      isNew: true,
      cwd: work,
    }),
  );
  fs.writeFileSync(file, 'AFTER');

  runHook('stop-manifest', { session_id: 'recover', cwd: work }, root);

  const manifest = JSON.parse(fs.readFileSync(path.join(snapshots, 'recover', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files, [
    {
      path: file,
      snapshot: path.join(snapshots, 'recover', 'baseline', key),
      isNew: true,
    },
  ]);
  assert.equal(fs.readFileSync(manifest.files[0].snapshot, 'utf8'), '');
  assert.equal(fs.existsSync(pending), false);
});
