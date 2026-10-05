const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeLegacyHooks } = require('./register-hooks.js');

const legacyDir = path.join(__dirname, '..', 'hooks').replace(/\\/g, '/');

function fixture(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, value);
  return { dir, file };
}

test('source installer removes old Arc entries without adding checkout hooks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  assert.match(source, /node "\$REPO\/scripts\/register-hooks\.js"/);
  assert.doesNotMatch(source, /chmod \+x "\$REPO\/hooks\//);
  const { dir, file } = fixture(
    JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              { type: 'command', command: `node "${legacyDir}/pretooluse-snapshot.cjs"` },
              { type: 'command', command: 'other-tool' },
              { type: 'command', command: 'echo /other/hooks/pretooluse-snapshot.cjs' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: `${legacyDir}/stop-manifest` }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: `${legacyDir}/session-start` }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      },
    }),
  );
  try {
    assert.equal(removeLegacyHooks(file), 3);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.permissions.allow, ['Read']);
    assert.deepEqual(after.hooks.PreToolUse[0].hooks, [
      { type: 'command', command: 'other-tool' },
      { type: 'command', command: 'echo /other/hooks/pretooluse-snapshot.cjs' },
    ]);
    assert.equal(after.hooks.Stop, undefined);
    assert.equal(after.hooks.SessionStart, undefined);
    assert.deepEqual(after.hooks.Notification, [{ hooks: [{ type: 'command', command: 'notify' }] }]);
    assert.equal(removeLegacyHooks(file), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing and malformed Claude settings are never replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-settings-'));
  const file = path.join(dir, 'settings.json');
  try {
    assert.equal(removeLegacyHooks(file), 0);
    assert.equal(fs.existsSync(file), false);
    for (const source of ['{ broken', '[]', '{"hooks":{"Stop":{}}}']) {
      fs.writeFileSync(file, source);
      assert.throws(() => removeLegacyHooks(file));
      assert.equal(fs.readFileSync(file, 'utf8'), source);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI migration uses both agent homes and leaves unrelated hooks unchanged', () => {
  const { dir, file } = fixture(
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `node "${legacyDir}/stop-manifest.cjs"` },
              { type: 'command', command: 'node other.js' },
            ],
          },
        ],
      },
    }),
  );
  const codexDir = path.join(dir, 'codex');
  const codexFile = path.join(codexDir, 'hooks.json');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(codexFile, fs.readFileSync(file));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'register-hooks.js')], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: codexDir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop[0].hooks, [
      { type: 'command', command: 'node other.js' },
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexFile, 'utf8')).hooks.Stop[0].hooks, [
      { type: 'command', command: 'node other.js' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct same-name hooks outside this checkout survive with a manual-cleanup warning', () => {
  const commands = {
    PreToolUse: '/opt/company/hooks/pretooluse-snapshot.cjs',
    Stop: '/opt/company/hooks/stop-manifest.cjs',
    SessionStart: '/opt/company/hooks/session-start.cjs',
  };
  const { dir, file } = fixture(
    JSON.stringify({
      hooks: Object.fromEntries(
        Object.entries(commands).map(([event, command]) => [event, [{ hooks: [{ type: 'command', command }] }]]),
      ),
    }),
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(removeLegacyHooks(file), 0);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [event, command] of Object.entries(commands)) {
      assert.equal(after.hooks[event][0].hooks[0].command, command);
      assert.ok(warnings.some((warning) => warning.includes(command) && warning.includes('manual')));
    }
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an old checkout path remains until its Arc ownership can be confirmed', () => {
  const command = 'node "/old/checkout/hooks/stop-manifest.cjs"';
  const { dir, file } = fixture(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(removeLegacyHooks(file), 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0].command, command);
    assert.ok(warnings.some((warning) => warning.includes(command) && warning.includes('manual')));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration preserves restrictive settings mode on POSIX', { skip: process.platform === 'win32' }, () => {
  const { dir, file } = fixture(
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${legacyDir}/stop-manifest.cjs"` }] }] },
    }),
  );
  try {
    fs.chmodSync(file, 0o600);
    const originalUmask = process.umask(0o022);
    try {
      assert.equal(removeLegacyHooks(file), 1);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      process.umask(originalUmask);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration preserves managed settings symlinks on POSIX', { skip: process.platform === 'win32' }, () => {
  const { dir, file: target } = fixture(
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${legacyDir}/stop-manifest.cjs"` }] }] },
    }),
  );
  const link = path.join(dir, 'linked-settings.json');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    fs.symlinkSync(target, link);
    assert.equal(removeLegacyHooks(link), 0);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.Stop.length, 1);
    assert.ok(warnings.some((warning) => warning.includes('symlink')));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
