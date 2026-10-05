const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the installed hooks capture modified and new edit-tool files', () => {
  const plugin = path.resolve(__dirname, '..', 'plugins', 'arc-hooks');
  const config = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const pre = config.PreToolUse[0];
  assert.equal(pre.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(config.PreToolUse.length, 1);
  assert.equal(config.Stop.length, 1);
  const hookPaths = {
    'pretooluse-snapshot.cjs': pre.hooks[0],
    'stop-manifest.cjs': config.Stop[0].hooks[0],
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-smoke-work-'));
  const arcHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-smoke-home-'));
  const sessionId = `smoke-${process.pid}`;
  const env = {
    ...process.env,
    ARC_HOME: arcHome,
    ARC_IGNORE_ROOTS: '',
  };

  function runHook(name, payload) {
    const hook = hookPaths[name];
    assert.equal(hook.command, 'node');
    assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/' + name]);
    const result = spawnSync(process.execPath, [hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}', plugin)], {
      cwd: work,
      env,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${name} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  try {
    const changedFile = path.join(work, 'a.txt');
    const createdFile = path.join(work, 'created.txt');
    fs.writeFileSync(changedFile, 'line1\nline2\nline3\n');

    runHook('pretooluse-snapshot.cjs', {
      session_id: sessionId,
      cwd: work,
      tool_name: 'Edit',
      tool_input: { file_path: changedFile },
    });
    fs.writeFileSync(changedFile, 'line1\nEDITED\nline3\n');

    runHook('pretooluse-snapshot.cjs', {
      session_id: sessionId,
      cwd: work,
      tool_name: 'Write',
      tool_input: { file_path: createdFile },
    });
    fs.writeFileSync(createdFile, 'brand new\n');
    runHook('stop-manifest.cjs', { session_id: sessionId, cwd: work });

    const manifestFile = path.join(arcHome, 'snapshots', sessionId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const names = manifest.files.map((file) => path.basename(file.path)).sort();
    assert.ok(names.includes('a.txt'), 'a.txt (modified) is missing');
    assert.ok(names.includes('created.txt'), 'created.txt (new file) is missing');
    const created = manifest.files.find((file) => path.basename(file.path) === 'created.txt');
    assert.equal(created.isNew, true, 'created.txt is not marked isNew');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(arcHome, { recursive: true, force: true });
  }
});
