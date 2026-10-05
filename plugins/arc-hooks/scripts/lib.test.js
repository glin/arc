// plugins/arc-hooks/scripts/lib.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { writeFileAtomically } = require('./persistence.js');

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  process.env.ARC_HOME = d;
  process.env.ARC_IGNORE_ROOTS = ''; // Capture edits in temporary test workspaces.
  const snapshots = path.join(d, 'snapshots');
  fs.mkdirSync(snapshots);
  return snapshots;
}

test('ARC_HOME is the home and snapshots are below it', () => {
  tmpRoot();
  const home = process.env.ARC_HOME;
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  assert.equal(lib.storeRoot(), path.join(home, 'snapshots'));
});

test('ARC_IGNORE_ROOTS replaces the ignore roots, and an empty value disables the rule', () => {
  const previousArc = process.env.ARC_IGNORE_ROOTS;
  const ignored = path.join(process.cwd(), 'arc-ignored-fixture');
  try {
    process.env.ARC_IGNORE_ROOTS = ignored;
    delete require.cache[require.resolve('./lib.js')];
    let lib = require('./lib.js');
    assert.equal(lib.isEphemeral(path.join(ignored, 'note.md')), true);
    process.env.ARC_IGNORE_ROOTS = '';
    delete require.cache[require.resolve('./lib.js')];
    lib = require('./lib.js');
    assert.equal(lib.isEphemeral(path.join(ignored, 'note.md')), false);
  } finally {
    if (previousArc === undefined) delete process.env.ARC_IGNORE_ROOTS;
    else process.env.ARC_IGNORE_ROOTS = previousArc;
  }
});

test('the default ignore roots include ARC_HOME and an explicit override replaces them', () => {
  const previousHome = process.env.ARC_HOME;
  const previousIgnore = process.env.ARC_IGNORE_ROOTS;
  const home = path.join(process.cwd(), 'arc-home-fixture');
  try {
    process.env.ARC_HOME = home;
    delete process.env.ARC_IGNORE_ROOTS;
    delete require.cache[require.resolve('./lib.js')];
    let lib = require('./lib.js');
    assert.equal(lib.isEphemeral(path.join(home, 'cache', 'state.json')), true);
    process.env.ARC_IGNORE_ROOTS = '';
    delete require.cache[require.resolve('./lib.js')];
    lib = require('./lib.js');
    assert.equal(lib.isEphemeral(path.join(home, 'cache', 'state.json')), false);
  } finally {
    if (previousHome === undefined) delete process.env.ARC_HOME;
    else process.env.ARC_HOME = previousHome;
    if (previousIgnore === undefined) delete process.env.ARC_IGNORE_ROOTS;
    else process.env.ARC_IGNORE_ROOTS = previousIgnore;
  }
});

test('the vendor homes use their variables and treat empty values as unset', () => {
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousCodex = process.env.CODEX_HOME;
  try {
    const claudeHome = path.join(os.tmpdir(), 'arc-agent-home-parent') + `${path.sep}..${path.sep}claude-home`;
    const codexHome = path.join(os.tmpdir(), 'arc-agent-home-parent') + `${path.sep}..${path.sep}codex-home`;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.CODEX_HOME = codexHome;
    delete require.cache[require.resolve('./lib.js')];
    let lib = require('./lib.js');
    assert.equal(lib.claudeConfigHome(), path.normalize(claudeHome));
    assert.equal(lib.codexHome(), path.normalize(codexHome));
    process.env.CLAUDE_CONFIG_DIR = 'relative-claude-home';
    process.env.CODEX_HOME = 'relative-codex-home';
    assert.equal(lib.claudeConfigHome(), 'relative-claude-home');
    assert.equal(lib.codexHome(), 'relative-codex-home');
    process.env.CLAUDE_CONFIG_DIR = '';
    process.env.CODEX_HOME = '';
    delete require.cache[require.resolve('./lib.js')];
    lib = require('./lib.js');
    assert.equal(lib.claudeConfigHome(), path.join(os.homedir(), '.claude'));
    assert.equal(lib.codexHome(), path.join(os.homedir(), '.codex'));
  } finally {
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
});

test("recordBaseline skips the agent's own scratch files but keeps edits elsewhere", () => {
  const root = tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  // Designate a scratch root (stands in for the OS temp dir / ~/.claude default).
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-'));
  process.env.ARC_IGNORE_ROOTS = scratchRoot;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));

  const real = path.join(work, 'real.txt'); // an intentional edit (e.g. another repo)
  const scratch = path.join(scratchRoot, 'plan.md'); // the agent's own scratch
  fs.writeFileSync(real, 'x');
  fs.writeFileSync(scratch, 'plan');

  assert.equal(lib.recordBaseline('s', real, work).skipped, false);
  assert.equal(lib.recordBaseline('s', scratch, work).skipped, true);

  const paths = Object.values(JSON.parse(fs.readFileSync(path.join(root, 's', 'index.json'), 'utf8')).files).map(
    (f) => f.path,
  );
  assert.ok(paths.includes(real), 'intentional edit captured');
  assert.ok(!paths.includes(scratch), 'scratch file skipped');
});

test('recordBaseline copies existing file content on first touch only', () => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'ORIGINAL');

  const r1 = lib.recordBaseline('sess1', file, work);
  assert.equal(r1.skipped, false);
  assert.equal(r1.isNew, false);

  // A second touch after an edit must preserve the first baseline.
  fs.writeFileSync(file, 'CHANGED');
  const r2 = lib.recordBaseline('sess1', file, work);
  assert.equal(r2.skipped, true);

  const idx = JSON.parse(fs.readFileSync(path.join(root, 'sess1', 'index.json'), 'utf8'));
  const key = Object.keys(idx.files)[0];
  assert.equal(idx.files[key].path, file);
  assert.equal(idx.files[key].isNew, false);
  assert.equal(idx.cwd, work);
  assert.equal(fs.readFileSync(path.join(root, 'sess1', 'baseline', key), 'utf8'), 'ORIGINAL');
});

test('recordBaseline marks a not-yet-existing file as isNew with empty baseline', () => {
  tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'new.txt');
  const r = lib.recordBaseline('sess2', file, work);
  assert.equal(r.isNew, true);
});

test('recordBaseline repairs an index missing after its baseline was stored', () => {
  const root = tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'a.txt');
  const baselineDir = path.join(root, 'repair', 'baseline');
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.writeFileSync(file, 'CHANGED');
  fs.writeFileSync(path.join(baselineDir, lib.keyFor(file)), 'ORIGINAL');

  assert.deepEqual(lib.recordBaseline('repair', file, work), { skipped: false, isNew: false });
  const idx = lib.readIndex(path.join(root, 'repair'));
  assert.deepEqual(idx.files[lib.keyFor(file)], { path: file, isNew: false });
  assert.equal(fs.readFileSync(path.join(baselineDir, lib.keyFor(file)), 'utf8'), 'ORIGINAL');
});

test('recordBaseline removes an abandoned index request', () => {
  const root = tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'ORIGINAL');
  const dir = path.join(root, 'stale-lock');
  fs.mkdirSync(dir, { recursive: true });
  const queue = path.join(dir, 'index-lock');
  fs.mkdirSync(queue);
  const name = '999999999-1-abandoned.request';
  const request = path.join(queue, name);
  fs.mkdirSync(request);
  fs.writeFileSync(path.join(request, 'ticket-1'), '');

  assert.equal(lib.recordBaseline('stale-lock', file, work).skipped, false);
  assert.equal(fs.existsSync(request), false);
});

test('recordBaseline does not confuse a reused process id with a live request', () => {
  const root = tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'ORIGINAL');
  const queue = path.join(root, 'reused-pid', 'index-lock');
  fs.mkdirSync(queue, { recursive: true });
  const name = `${process.pid}-1-old.request`;
  const request = path.join(queue, name);
  fs.mkdirSync(request);
  fs.writeFileSync(path.join(request, 'ticket-1'), '');

  assert.equal(lib.recordBaseline('reused-pid', file, work).skipped, false);
  assert.equal(fs.existsSync(request), false);
});

test('recordBaseline recovers a new-file fact published with an interrupted baseline', () => {
  const root = tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'new.txt');
  const key = lib.keyFor(file);
  const pending = path.join(root, 'interrupted', 'pending-baselines', key);
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'baseline'), '');
  fs.writeFileSync(path.join(pending, 'entry.json'), JSON.stringify({ path: file, isNew: true, cwd: work }));
  fs.writeFileSync(file, 'CREATED AFTER THE INTERRUPTED HOOK');

  const entries = lib.computeManifest('interrupted', work);
  assert.deepEqual(entries, [
    {
      path: file,
      snapshot: path.join(root, 'interrupted', 'baseline', key),
      isNew: true,
    },
  ]);
  const idx = lib.readIndex(path.join(root, 'interrupted'));
  assert.deepEqual(idx.files[key], { path: file, isNew: true });
  assert.equal(idx.cwd, work);
  assert.equal(fs.readFileSync(path.join(root, 'interrupted', 'baseline', key), 'utf8'), '');
  assert.equal(fs.existsSync(pending), false);
});

test('computeManifest lists only files differing from baseline', () => {
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const changed = path.join(work, 'changed.txt');
  const same = path.join(work, 'same.txt');
  fs.writeFileSync(changed, 'v1');
  fs.writeFileSync(same, 'const');

  lib.recordBaseline('s', changed, work);
  lib.recordBaseline('s', same, work);
  fs.writeFileSync(changed, 'v2'); // now differs from baseline

  const entries = lib.computeManifest('s');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, changed);
  assert.equal(entries[0].isNew, false);
  assert.ok(entries[0].snapshot.endsWith(lib.keyFor(changed)));
});

test('Stop preserves orphan baseline bytes without reconstructing lost file facts', () => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  for (const [name, original, wasNew] of [
    ['existing', 'ORIGINAL', false],
    ['existing-absent', 'ORIGINAL', false],
    ['existing-empty', '', false],
    ['new-empty', '', true],
  ]) {
    const file = path.join(work, name);
    if (!wasNew) fs.writeFileSync(file, original);
    lib.recordBaseline(name, file, work);
    fs.writeFileSync(file, original ? 'CHANGED' : '');
    const dir = path.join(root, name);
    const baseline = path.join(dir, 'baseline', lib.keyFor(file));
    fs.unlinkSync(path.join(dir, 'index.json'));
    lib.publishManifest(name, work);
    assert.equal(fs.readFileSync(baseline, 'utf8'), original);
    assert.deepEqual(lib.readIndex(dir).files, {});
    if (name === 'existing-absent') fs.unlinkSync(file);
    lib.recordBaseline(name, file, work);
    assert.equal(fs.readFileSync(baseline, 'utf8'), original);
    // Current existence and absence supply no historical new-file fact.
    fs.writeFileSync(file, original);
    lib.publishManifest(name, work);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files, []);
    assert.equal(lib.readIndex(dir).files[lib.keyFor(file)].isNew, false);
  }
});

test('Stop recovers published transactions including a new empty file', () => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  for (const isNew of [false, true]) {
    const session = `published-${isNew}`;
    const file = path.join(work, session);
    fs.writeFileSync(file, '');
    const key = lib.keyFor(file);
    const pending = path.join(root, session, 'pending-baselines', key);
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'baseline'), isNew ? '' : 'ORIGINAL');
    fs.writeFileSync(path.join(pending, 'entry.json'), JSON.stringify({ path: file, isNew, cwd: work }));
    lib.publishManifest(session, work);
    const dir = path.join(root, session);
    assert.deepEqual(lib.readIndex(dir).files[key], { path: file, isNew });
    assert.equal(fs.readFileSync(path.join(dir, 'baseline', key), 'utf8'), isNew ? '' : 'ORIGINAL');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files[0].isNew, isNew);
    assert.equal(fs.existsSync(pending), false);
  }
});

test('Stop leaves first-touch temporaries untouched and completes publication before index creation', () => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  for (const isNew of [false, true]) {
    const session = `capture-${isNew}`;
    const file = path.join(work, session);
    if (!isNew) fs.writeFileSync(file, 'ORIGINAL');
    const key = lib.keyFor(file);
    const dir = path.join(root, session);
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    let temporarySeen = false;
    let publishedSeen = false;
    fs.writeFileSync = function (target, ...args) {
      const result = write.call(this, target, ...args);
      if (path.basename(target) === 'entry.json') {
        const temporary = path.dirname(target);
        lib.publishManifest(session, work);
        assert.equal(fs.existsSync(temporary), true);
        assert.deepEqual(lib.readIndex(dir).files, {});
        assert.equal(fs.existsSync(path.join(dir, 'baseline', path.basename(temporary))), false);
        temporarySeen = true;
      }
      return result;
    };
    fs.renameSync = function (from, to) {
      const result = rename.call(this, from, to);
      if (to === path.join(dir, 'pending-baselines', key)) {
        fs.writeFileSync(file, isNew ? '' : 'CHANGED');
        lib.publishManifest(session, work);
        publishedSeen = true;
      }
      return result;
    };
    try {
      lib.recordBaseline(session, file, work);
    } finally {
      fs.writeFileSync = write;
      fs.renameSync = rename;
    }
    assert.equal(temporarySeen && publishedSeen, true);
    lib.publishManifest(session, work);
    assert.deepEqual(lib.readIndex(dir).files[key], { path: file, isNew });
    assert.equal(fs.readFileSync(path.join(dir, 'baseline', key), 'utf8'), isNew ? '' : 'ORIGINAL');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files[0].path, file);
  }
});

test('existing zero-byte baselines clear reverted edits and retain their first touch', () => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'empty');
  fs.writeFileSync(file, '');
  lib.recordBaseline('empty', file, work);
  fs.writeFileSync(file, 'EDIT');
  lib.publishManifest('empty', work);
  const dir = path.join(root, 'empty');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files.length, 1);
  fs.writeFileSync(file, '');
  lib.publishManifest('empty', work);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files, []);
  assert.equal(fs.readFileSync(path.join(dir, 'baseline', lib.keyFor(file)), 'utf8'), '');
  assert.equal(lib.readIndex(dir).files[lib.keyFor(file)].isNew, false);
});

test('large Stop comparisons read baseline and current bytes once per captured file', () => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const dir = path.join(root, 'large');
  fs.mkdirSync(path.join(dir, 'baseline'), { recursive: true });
  const files = {};
  const contents = new Set();
  for (let i = 0; i < 1000; i++) {
    const file = path.join(work, `${i}.txt`);
    const key = lib.keyFor(file);
    const baseline = path.join(dir, 'baseline', key);
    fs.writeFileSync(file, 'CURRENT');
    fs.writeFileSync(baseline, 'BASELINE');
    files[key] = { path: file, isNew: false };
    contents.add(file);
    contents.add(baseline);
  }
  lib.writeIndex(dir, { cwd: work, files });
  const read = fs.readFileSync;
  const list = fs.readdirSync;
  const counts = new Map();
  fs.readFileSync = function (target, ...args) {
    if (contents.has(target)) counts.set(target, (counts.get(target) || 0) + 1);
    return read.call(this, target, ...args);
  };
  fs.readdirSync = function (target, ...args) {
    assert.ok(target.startsWith(dir + path.sep), 'Stop inspected another session');
    return list.call(this, target, ...args);
  };
  try {
    lib.publishManifest('large', work);
  } finally {
    fs.readFileSync = read;
    fs.readdirSync = list;
  }
  assert.equal(counts.size, 2000);
  assert.ok([...counts.values()].every((count) => count === 1));
});

test('readSessionTitle returns the last ai-title from a transcript', () => {
  tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-')), 't.jsonl');
  fs.writeFileSync(
    tx,
    [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'First title' }),
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Build VS Code diff review' }),
    ].join('\n'),
  );
  assert.equal(lib.readSessionTitle(tx), 'Build VS Code diff review');
  assert.equal(lib.readSessionTitle('/no/such/file'), null);
  assert.equal(lib.readSessionTitle(undefined), null);
});

test('readSessionTitle reads a bounded tail and drops its first partial line', () => {
  tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tx-')), 't.jsonl');
  const old = JSON.stringify({ type: 'ai-title', aiTitle: 'Old title' });
  const latest = JSON.stringify({ type: 'ai-title', aiTitle: 'Latest title' });
  fs.writeFileSync(tx, `${old}\n${'x'.repeat(lib.TITLE_TAIL_BYTES)}\n${latest}\n`);

  const original = fs.readFileSync;
  fs.readFileSync = function (...args) {
    if (args[0] === tx) throw new Error('whole-file read');
    return original.apply(this, args);
  };
  try {
    assert.equal(lib.readSessionTitle(tx), 'Latest title');
    const exact = `${latest}\n${'y'.repeat(lib.TITLE_TAIL_BYTES - Buffer.byteLength(latest) - 1)}`;
    fs.writeFileSync(tx, `${old}\n${exact}`);
    assert.equal(lib.readSessionTitle(tx), 'Latest title', 'a title on the exact tail edge is complete');
  } finally {
    fs.readFileSync = original;
  }
});

test.each([
  ['win32', 'EPERM', 10],
  ['win32', 'EACCES', 1],
  ['win32', 'EIO', 1],
  ['linux', 'EPERM', 1],
  ['darwin', 'EPERM', 1],
])('writeFileAtomically preserves the old file after %s %s replacement failure', (platform, code, expectedAttempts) => {
  const dir = tmpRoot();
  const target = path.join(dir, 'state.json');
  writeFileAtomically(target, 'old');
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  let attempts = 0;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    assert.throws(
      () =>
        writeFileAtomically(target, 'new', (temporary) => {
          attempts++;
          assert.equal(fs.readFileSync(target, 'utf8'), 'old');
          assert.equal(fs.readFileSync(temporary, 'utf8'), 'new');
          throw Object.assign(new Error('replacement failed'), { code });
        }),
      /replacement failed/,
    );
    assert.equal(attempts, expectedAttempts);
    assert.equal(wait.mock.calls.length, expectedAttempts - 1);
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    wait.mockRestore();
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test.each(['index.json', 'manifest.json', 'trigger'])(
  'Stop renews useful stores after transient Windows %s replacement failures',
  (name) => {
    const root = tmpRoot();
    const lib = require('./lib.js');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
    for (const reverted of [false, true]) {
      const session = `retry-${name}-${reverted}`;
      const file = path.join(work, session);
      fs.writeFileSync(file, 'ORIGINAL');
      lib.recordBaseline(session, file, work);
      fs.writeFileSync(file, 'CHANGED');
      lib.publishManifest(session, work);
      if (reverted) fs.writeFileSync(file, 'ORIGINAL');
      const dir = path.join(root, session);
      const target = path.join(dir, name);
      const originalTarget = fs.readFileSync(target, 'utf8');
      const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path.join(dir, 'trigger'), aged, aged);
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      const rename = fs.renameSync;
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      let attempts = 0;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      fs.renameSync = function (from, to) {
        if (to === target) {
          attempts++;
          assert.equal(fs.readFileSync(target, 'utf8'), originalTarget);
          if (name !== 'trigger') JSON.parse(fs.readFileSync(from, 'utf8'));
          if (attempts < 3) throw Object.assign(new Error('Windows replacement denied'), { code: 'EPERM' });
        }
        return rename.call(this, from, to);
      };
      try {
        lib.publishManifest(session, work);
        assert.equal(attempts, 3);
        assert.equal(wait.mock.calls.length, 2);
      } finally {
        fs.renameSync = rename;
        Object.defineProperty(process, 'platform', platformDescriptor);
        wait.mockRestore();
      }
      assert.ok(fs.statSync(path.join(dir, 'trigger')).mtimeMs > aged.getTime());
      const files = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files;
      assert.equal(files.length, reverted ? 0 : 1);
      assert.equal(fs.readFileSync(path.join(dir, 'baseline', lib.keyFor(file)), 'utf8'), 'ORIGINAL');
      assert.ok(fs.readdirSync(dir).every((entry) => !entry.endsWith('.tmp')));
    }
  },
);

test.each(['edit', 'revert'])('overlapping Stops preserve the later %s publication', async (change) => {
  const root = tmpRoot();
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const file = path.join(work, 'file.txt');
  fs.writeFileSync(file, 'BASE');
  lib.recordBaseline('overlap', file, work);
  if (change === 'revert') fs.writeFileSync(file, 'EDIT');
  const ready = path.join(root, 'ready');
  const release = path.join(root, 'release');
  const blocked = path.join(root, 'blocked');
  const completed = path.join(root, 'completed');
  const script = [
    "const fs=require('node:fs')",
    "const lib=require('./plugins/arc-hooks/scripts/lib.js')",
    'const [role,work,ready,release,blocked,completed]=process.argv.slice(1)',
    'const cell=new Int32Array(new SharedArrayBuffer(4))',
    'const wait=Atomics.wait.bind(Atomics)',
    'const write=fs.writeFileSync.bind(fs)',
    "fs.writeFileSync=(target,...args)=>{const result=write(target,...args);if(role==='first'&&target.includes('manifest.json.')&&target.endsWith('.tmp')){write(ready,'ready');while(!fs.existsSync(release))wait(cell,0,0,2)}return result}",
    "if(role==='second')Atomics.wait=(...args)=>{write(blocked,'blocked');return wait(...args)}",
    "require('./plugins/arc-hooks/scripts/stop-manifest.cjs')",
    "process.stdin.emit('data',JSON.stringify({session_id:'overlap',cwd:work,transcript_path:null}))",
    "if(role==='second')process.on('exit',()=>write(completed,'completed'))",
    "process.stdin.emit('end')",
  ].join(';');
  const children = [];
  const start = (role) => {
    const processHandle = spawn(process.execPath, ['-e', script, role, work, ready, release, blocked, completed], {
      cwd: path.join(__dirname, '..', '..', '..'),
      env: { ...process.env, ARC_HOME: path.dirname(root), ARC_IGNORE_ROOTS: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    processHandle.stderr.on('data', (chunk) => {
      errorText += chunk;
    });
    const done = new Promise((resolve, reject) => {
      processHandle.on('error', reject);
      processHandle.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Stop exited ${code}: ${errorText}`)),
      );
    });
    const child = { processHandle, done };
    children.push(child);
    return child;
  };
  try {
    const first = start('first');
    await vi.waitFor(() => assert.ok(fs.existsSync(ready)), { timeout: 5_000, interval: 5 });
    fs.writeFileSync(file, change === 'edit' ? 'EDIT' : 'BASE');
    const second = start('second');
    await vi.waitFor(() => assert.ok(fs.existsSync(blocked) || fs.existsSync(completed)), {
      timeout: 5_000,
      interval: 5,
    });
    fs.writeFileSync(release, 'release');
    await Promise.all([first.done, second.done]);
  } finally {
    fs.writeFileSync(release, 'release');
    for (const { processHandle } of children) if (processHandle.exitCode === null) processHandle.kill();
    await Promise.allSettled(children.map(({ done }) => done));
  }
  const dir = path.join(root, 'overlap');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, change === 'edit' ? 1 : 0);
  assert.equal(fs.existsSync(path.join(dir, 'trigger')), true);
});

test('concurrent baseline hooks retain every first touch', async () => {
  const root = tmpRoot();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const gate = path.join(root, 'start');
  const readyDir = path.join(root, 'ready');
  fs.mkdirSync(readyDir);
  const files = Array.from({ length: 8 }, (_, index) => {
    const file = path.join(work, `${index}.txt`);
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024, index));
    return file;
  });
  const ready = files.map((_, index) => path.join(readyDir, String(index)));
  const children = files.map((file, index) => {
    const script = [
      "const fs=require('node:fs')",
      "const lib=require('./plugins/arc-hooks/scripts/lib.js')",
      'const [gate,ready,file,cwd]=process.argv.slice(1)',
      'const cell=new Int32Array(new SharedArrayBuffer(4))',
      "fs.writeFileSync(ready,'ready')",
      'while(!fs.existsSync(gate)) Atomics.wait(cell,0,0,2)',
      "lib.recordBaseline('shared',file,cwd)",
    ].join(';');
    const processHandle = spawn(process.execPath, ['-e', script, gate, ready[index], file, work], {
      cwd: path.join(__dirname, '..', '..', '..'),
      env: { ...process.env, ARC_HOME: path.dirname(root), ARC_IGNORE_ROOTS: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    processHandle.stderr.on('data', (chunk) => {
      errorText += chunk;
    });
    const done = new Promise((resolve, reject) => {
      processHandle.on('error', reject);
      processHandle.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`hook exited ${code}: ${errorText.trim()}`)),
      );
    });
    return { processHandle, done };
  });
  const allDone = Promise.all(children.map(({ done }) => done));
  try {
    await vi.waitFor(
      () => {
        if (!ready.every((file) => fs.existsSync(file))) throw new Error('hook processes did not reach the start gate');
      },
      { timeout: 5_000, interval: 5 },
    );
    fs.writeFileSync(gate, 'go');
    await allDone;
  } finally {
    if (!fs.existsSync(gate)) fs.writeFileSync(gate, 'stop');
    for (const { processHandle } of children) {
      if (processHandle.exitCode === null) processHandle.kill();
    }
    await Promise.allSettled(children.map(({ done }) => done));
  }

  const idx = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'index.json'), 'utf8'));
  assert.deepEqual(new Set(Object.values(idx.files).map((entry) => entry.path)), new Set(files));
  const lib = require('./lib.js');
  for (const [index, file] of files.entries()) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'shared', 'baseline', lib.keyFor(file))),
      Buffer.alloc(1024 * 1024, index),
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'shared', 'index-lock')), []);
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'shared')).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('a wall-clock jump does not evict the writer inside the index lock', async () => {
  const root = tmpRoot();
  const dir = path.join(root, 'clock-jump');
  const ready = path.join(root, 'writer-ready');
  const release = path.join(root, 'release-writer');
  const published = path.join(root, 'second-published');
  const advanceClock = path.join(root, 'advance-clock');
  const waiting = path.join(root, 'second-waiting');
  const secondDone = path.join(root, 'second-done');
  const cwd = path.join(__dirname, '..', '..', '..');
  const environment = { ...process.env, ARC_HOME: path.dirname(root), ARC_IGNORE_ROOTS: '' };
  const firstScript = [
    "const fs=require('node:fs')",
    "const lib=require('./plugins/arc-hooks/scripts/lib.js')",
    "const {withIndexLock}=require('./plugins/arc-hooks/scripts/persistence.js')",
    'const [dir,ready,release]=process.argv.slice(1)',
    'const cell=new Int32Array(new SharedArrayBuffer(4))',
    "withIndexLock(dir,()=>{const idx=lib.readIndex(dir);fs.writeFileSync(ready,'ready');while(!fs.existsSync(release))Atomics.wait(cell,0,0,2);idx.files.first={path:'first',isNew:false};lib.writeIndex(dir,idx)})",
  ].join(';');
  const secondScript = [
    "const fs=require('node:fs')",
    'const [dir,published,advanceClock,waiting,done]=process.argv.slice(1)',
    'const cell=new Int32Array(new SharedArrayBuffer(4))',
    'const wait=Atomics.wait.bind(Atomics)',
    'const rename=fs.renameSync.bind(fs)',
    "fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith('.request')){fs.writeFileSync(published,'published');while(!fs.existsSync(advanceClock))wait(cell,0,0,2);const actualNow=Date.now;Date.now=()=>actualNow()+60000}}",
    "let announced=false;Atomics.wait=(...args)=>{if(!announced){fs.writeFileSync(waiting,'waiting');announced=true}return wait(...args)}",
    "const lib=require('./plugins/arc-hooks/scripts/lib.js')",
    "const {withIndexLock}=require('./plugins/arc-hooks/scripts/persistence.js')",
    "withIndexLock(dir,()=>{const idx=lib.readIndex(dir);idx.files.second={path:'second',isNew:false};lib.writeIndex(dir,idx)})",
    "fs.writeFileSync(done,'done')",
  ].join(';');
  const children = [];
  const start = (script, args) => {
    const processHandle = spawn(process.execPath, ['-e', script, ...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    processHandle.stderr.on('data', (chunk) => {
      errorText += chunk;
    });
    const done = new Promise((resolve, reject) => {
      processHandle.on('error', reject);
      processHandle.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`hook exited ${code}: ${errorText.trim()}`)),
      );
    });
    const child = { processHandle, done };
    children.push(child);
    return child;
  };
  try {
    const first = start(firstScript, [dir, ready, release]);
    // Settles only if the first writer crashes, so racing it below fails a crash at once
    // instead of leaving the poll to retry against a process that will never signal ready.
    const firstCrashed = new Promise((_resolve, reject) => {
      first.done.catch(reject);
    });
    await Promise.race([
      vi.waitFor(
        () => {
          if (!fs.existsSync(ready)) throw new Error('first writer did not acquire the index lock');
        },
        { timeout: 5_000, interval: 5 },
      ),
      firstCrashed,
    ]);
    const second = start(secondScript, [dir, published, advanceClock, waiting, secondDone]);
    // Settles only if the second writer crashes, so racing it below fails a crash at once
    // instead of leaving the poll to retry against a process that will never publish.
    const secondCrashed = new Promise((_resolve, reject) => {
      second.done.catch(reject);
    });
    await Promise.race([
      vi.waitFor(
        () => {
          if (!fs.existsSync(published)) throw new Error('second writer did not publish its index request');
        },
        { timeout: 5_000, interval: 5 },
      ),
      firstCrashed,
      secondCrashed,
    ]);
    fs.writeFileSync(advanceClock, 'advance');
    await Promise.race([
      vi.waitFor(
        () => {
          if (!fs.existsSync(waiting)) throw new Error('second writer did not wait behind the first');
        },
        { timeout: 5_000, interval: 5 },
      ),
      firstCrashed,
      secondCrashed,
    ]);
    fs.writeFileSync(release, 'release');
    await Promise.all([first.done, second.done]);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, 'release');
    for (const { processHandle } of children) {
      if (processHandle.exitCode === null) processHandle.kill();
    }
    await Promise.allSettled(children.map(({ done }) => done));
  }

  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(new Set(Object.keys(idx.files)), new Set(['first', 'second']));
});

test('writeManifest writes manifest.json (with title) and bumps trigger', () => {
  const root = tmpRoot();
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const f = path.join(work, 'a.txt');
  fs.writeFileSync(f, 'x');
  lib.recordBaseline('s', f, work);
  fs.writeFileSync(f, 'y');
  lib.writeManifest('s', lib.computeManifest('s'), 'My Session Title');

  const m = JSON.parse(fs.readFileSync(path.join(root, 's', 'manifest.json'), 'utf8'));
  assert.equal(m.sessionId, 's');
  assert.equal(m.cwd, work);
  assert.equal(m.title, 'My Session Title');
  assert.equal(m.files.length, 1);
  assert.ok(fs.existsSync(path.join(root, 's', 'trigger')));
});

// The turn timeline hides the same paths this hook skips. Both sides run the cases in
// test/fixtures/ephemeral-paths.json, so a change to one rule fails on the other.
test('isEphemeral matches the shared ephemeral-paths fixture', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'ephemeral-paths.json'), 'utf8'),
  );
  const previousIgnore = process.env.ARC_IGNORE_ROOTS;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR =
    path.join(os.homedir(), 'arc-agent-home-parent') + `${path.sep}..${path.sep}arc-hook-claude-home-fixture`;
  process.env.CODEX_HOME =
    path.join(os.homedir(), 'arc-agent-home-parent') + `${path.sep}..${path.sep}arc-hook-codex-home-fixture`;
  const fill = (t) =>
    t
      .replace('{arcHome}', process.env.ARC_HOME || path.join(os.homedir(), '.arc'))
      .replace('{claudeHome}', path.normalize(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')))
      .replace('{codexHome}', path.normalize(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')))
      .replace('{tmp}', os.tmpdir())
      .replace('{home}', os.homedir())
      .split('/')
      .join(path.sep);
  process.env.ARC_IGNORE_ROOTS = fixture.ignoreRoots.map(fill).join(path.delimiter);
  delete require.cache[require.resolve('./lib.js')];
  const lib = require('./lib.js');
  // Each case is checked in every shape the fixture lists. A rule that normalises one
  // shape while the other side compares it raw is how the two drift apart, and only a
  // shaped case can see it. A trailing slash is not applied to a file path.
  const shape = (native, kind) => {
    if (kind === 'forward-slash') {
      return native.split(path.sep).join('/');
    }
    if (kind === 'lower-drive') {
      return native.replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ':');
    }
    if (kind === 'trailing-slash') {
      return native + path.sep;
    }
    return native;
  };
  try {
    for (const c of fixture.cases) {
      for (const kind of fixture.shapes) {
        if (kind === 'trailing-slash' && /\.[a-z]+$/.test(c.path)) {
          continue;
        }
        assert.equal(lib.isEphemeral(shape(fill(c.path), kind)), c.ephemeral, `${c.path} as ${kind}: ${c.why}`);
      }
    }
    // Test the default roots too. Explicit fixture roots alone cannot detect a missing default.
    delete process.env.ARC_IGNORE_ROOTS;
    for (const c of fixture.cases) {
      assert.equal(lib.isEphemeral(fill(c.path)), c.ephemeral, `${c.path} against the shipped roots: ${c.why}`);
    }
    process.env.ARC_IGNORE_ROOTS = '';
  } finally {
    if (previousIgnore === undefined) delete process.env.ARC_IGNORE_ROOTS;
    else process.env.ARC_IGNORE_ROOTS = previousIgnore;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
});
