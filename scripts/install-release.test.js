const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { packageClaudePlugin } = require('./package-claude-plugin.js');
const yauzl = createRequire(path.join(__dirname, '..', 'extension', 'package.json'))('yauzl');

// Tests that start real processes run in the test:subprocess lane.
const SUBPROCESS = { tags: ['subprocess'] };

const installer = path.join(__dirname, 'install-release.sh');
const asset = 'glin.arc-0.1.0.vsix';
const body = Buffer.from('fixture VSIX');
const digest = createHash('sha256').update(body).digest('hex');

function bashPath(file) {
  if (process.platform !== 'win32') return file;
  return `/${file[0].toLowerCase()}${file.slice(2).replaceAll('\\', '/')}`;
}

function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  if (process.env.GIT_BASH_PATH && fs.existsSync(process.env.GIT_BASH_PATH)) return process.env.GIT_BASH_PATH;
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const candidate = path.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bash';
}

async function fixture(checksum, editors, selection = '', explicit = false, configure = () => ({})) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-release-test-'));
  const standalone = path.join(directory, 'install-release.sh');
  fs.copyFileSync(installer, standalone);
  const commands = path.join(directory, 'commands');
  fs.mkdirSync(commands);
  const installed = path.join(directory, 'installed.txt');
  for (const editor of editors) {
    const file = path.join(commands, editor);
    fs.writeFileSync(file, '#!/usr/bin/env bash\nprintf "%s\\n" "$0 $*" >> "$ARC_INSTALL_LOG"\n');
    fs.chmodSync(file, 0o755);
  }
  const extraEnv = configure({ directory, commands, installed });
  const server = http.createServer((request, response) => {
    const name = request.url?.split('/').pop();
    if (name === asset) response.end(body);
    else if (name === `${asset}.sha256`) response.end(`${checksum}  ${asset}\n`);
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const command = 'PATH="$1:/mingw64/bin:/usr/bin:/bin"; shift; bash "$@"';
    const args = ['-c', command, 'bash', bashPath(commands), bashPath(standalone), '0.1.0'];
    if (explicit) args.push(bashPath(path.join(commands, editors[0])));
    const child = spawn(bashExecutable(), args, {
      env: {
        ...process.env,
        ARC_RELEASE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        ARC_INSTALL_LOG: bashPath(installed),
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(selection);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => child.on('close', resolve));
    return { status, stdout, stderr, installed: fs.existsSync(installed) ? fs.readFileSync(installed, 'utf8') : '' };
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the standalone installer downloads, verifies, and installs in the sole editor', SUBPROCESS, async () => {
  const result = await fixture(digest, ['code']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.installed, /code --install-extension .*glin\.arc-0\.1\.0\.vsix --force/);
});

test('the standalone installer gives an explicit editor instruction without a terminal', SUBPROCESS, async () => {
  const result = await fixture(digest, ['code', 'cursor']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose one editor:/);
  assert.match(result.stderr, /Pass one as EDITOR/);
  assert.equal(result.installed, '');
});

test('the standalone installer finds a macOS app-bundle CLI outside PATH', SUBPROCESS, async () => {
  const result = await fixture(digest, [], '', false, ({ directory }) => {
    const home = path.join(directory, 'home');
    const cli = path.join(
      home,
      'Applications',
      'Visual Studio Code.app',
      'Contents',
      'Resources',
      'app',
      'bin',
      'code',
    );
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '#!/usr/bin/env bash\nprintf "%s\\n" "$0 $*" >> "$ARC_INSTALL_LOG"\n', { mode: 0o755 });
    return { HOME: bashPath(home) };
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.installed, /Visual Studio Code\.app.*code --install-extension/);
});

test('the standalone installer uses the Positron extension CLI beside its desktop command', SUBPROCESS, async () => {
  const result = await fixture(digest, ['positron'], '', false, ({ commands }) => {
    fs.writeFileSync(path.join(commands, 'positron'), '#!/usr/bin/env bash\nexit 99\n');
    const cli = path.join(commands, 'bin', 'positron');
    fs.mkdirSync(path.dirname(cli));
    fs.writeFileSync(cli, '#!/usr/bin/env bash\nprintf "%s\\n" "$0 $*" >> "$ARC_INSTALL_LOG"\n', { mode: 0o755 });
    return {};
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.installed, /bin\/positron --install-extension/);
});

test.skipIf(process.platform === 'win32')(
  'the standalone installer verifies a download under a backslash temp path',
  SUBPROCESS,
  async () => {
    const result = await fixture(digest, ['code'], '', false, ({ directory }) => {
      const tmpdir = path.join(directory, 'back\\slash');
      fs.mkdirSync(tmpdir);
      return { TMPDIR: tmpdir };
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.installed, /code --install-extension/);
  },
);

test('the standalone installer rejects an uppercase digest as an invalid checksum file', SUBPROCESS, async () => {
  const result = await fixture(digest.toUpperCase(), ['code']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid Arc checksum file/);
  assert.equal(result.installed, '');
});

test('the standalone installer accepts one explicit editor CLI', SUBPROCESS, async () => {
  const result = await fixture(digest, ['code', 'cursor'], '', true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.installed, /code --install-extension/);
  assert.doesNotMatch(result.installed, /cursor --install-extension/);
});

test('the standalone installer rejects a changed VSIX before opening the editor', SUBPROCESS, async () => {
  const result = await fixture('0'.repeat(64), ['code']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed checksum verification/);
  assert.equal(result.installed, '');
});

test('the candidate workflow prepares the full test prerequisites with read-only access', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'vsix-candidate.yml'), 'utf8');
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /sudo apt-get install --yes zsh imagemagick/);
  assert.match(workflow, /sudo tee \/usr\/local\/bin\/magick/);
  assert.match(workflow, /magick -list format \| grep -i webp/);
  assert.ok(workflow.indexOf('magick -list format') < workflow.indexOf('- run: npm run test:all'));
  assert.match(workflow, /node scripts\/package-claude-plugin\.js release/);
});

test('plugin candidate archive and catalog preserve the standalone runtime layout and exact digest', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-plugin-package-'));
  const version = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'plugins', 'arc-hooks', '.claude-plugin', 'plugin.json')),
  ).version;
  try {
    const first = await packageClaudePlugin(output);
    const archive = path.join(output, first.asset);
    assert.equal(first.sha256, createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
    assert.equal(fs.readFileSync(`${archive}.sha256`, 'utf8'), `${first.sha256}  ${first.asset}\n`);
    assert.equal(first.catalog.name, 'arc');
    assert.deepEqual(first.catalog.plugins[0].source, {
      source: 'archive',
      url: `https://github.com/glin/arc/releases/download/v${version}/${first.asset}`,
      sha256: first.sha256,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'arc-marketplace.json'))), first.catalog);
    const zip = await new Promise((resolve, reject) =>
      yauzl.open(archive, { lazyEntries: true }, (error, opened) => (error ? reject(error) : resolve(opened))),
    );
    const entries = await new Promise((resolve, reject) => {
      const files = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, async (error, stream) => {
          if (error) return reject(error);
          try {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          } catch (readError) {
            reject(readError);
          }
        }),
      );
      zip.readEntry();
    });
    assert.deepEqual([...entries.keys()].sort(), [
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'scripts/lib.js',
      'scripts/persistence.js',
      'scripts/pretooluse-snapshot.cjs',
      'scripts/stop-manifest.cjs',
    ]);
    assert.equal(JSON.parse(entries.get('.claude-plugin/plugin.json')).version, version);
    const hooks = JSON.parse(entries.get('hooks/hooks.json')).hooks;
    for (const event of ['PreToolUse', 'Stop']) {
      const hook = hooks[event][0].hooks[0];
      assert.equal(hook.command, 'node');
      assert.ok(entries.has(hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '')));
    }
    const second = await packageClaudePlugin(output);
    assert.equal(second.sha256, first.sha256);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
