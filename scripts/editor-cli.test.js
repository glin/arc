const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const resolver = path.join(__dirname, 'editor-cli.sh');
const skillSource = path.join(__dirname, '../cli/skills/arc-sessions');
// The installed skill carries SKILL.md and every reference file beside it.
function expectSkillCopy(directory) {
  const files = (root) =>
    fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .filter((file) => fs.statSync(path.join(root, file)).isFile())
      .sort();
  assert.ok(files(skillSource).length > 1);
  assert.deepEqual(files(directory), files(skillSource));
  for (const file of files(skillSource))
    assert.deepEqual(fs.readFileSync(path.join(directory, file)), fs.readFileSync(path.join(skillSource, file)));
}
function gitBashExecutable() {
  if (process.platform !== 'win32') {
    const result = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.realpathSync(result.stdout.trim());
  }
  if (process.env.GIT_BASH_PATH && fs.existsSync(process.env.GIT_BASH_PATH)) {
    return path.resolve(process.env.GIT_BASH_PATH);
  }
  for (const root of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean)) {
    for (const relative of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = path.join(root, 'Git', relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Git Bash was not found. Set GIT_BASH_PATH to its executable.');
}

const bashExecutable = gitBashExecutable();

// Compile the actual command once. Every source fixture executes this implementation.
const skillCLI = require('../extension/node_modules/esbuild').buildSync({
  entryPoints: [path.join(__dirname, '../cli/src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].contents;
const catalogUrl = 'https://github.com/glin/arc/releases/latest/download/arc-marketplace.json';
// One installer run stops after this time. Git Bash starts every child process of a run.
// One run with hooks starts about twenty of them. On a loaded Windows machine that takes more than 20 seconds.
const RUN_TIMEOUT = 60_000;
// A case gets the run budget for each installer run, plus time for its fixture and assertions.
function runBudget(runs) {
  return runs * RUN_TIMEOUT + 10_000;
}
vi.setConfig({ testTimeout: runBudget(1) });

test.each(
  ['installed', 'linked', 'external', 'failed', 'skipped', 'hook-failed', 'cancelled'].flatMap((outcome) => [
    [outcome, false],
    [outcome, true],
  ]),
)('installer output modes retain component outcomes for %s (JSON %s)', (outcome, json) => {
  const f = installerFixture();
  try {
    const args = ['--skill-agent', 'claude', '--skill-agent', 'codex', 'code'];
    const env = { CLAUDE_CONFIG_DIR: '' };
    let status = 0;
    let skillStatuses = ['installed', 'installed'];
    if (['linked', 'external'].includes(outcome)) {
      const destination = path.join(f.dir, '.agents/skills/arc-sessions');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const payload = path.join(f.source, 'cli/skills/arc-sessions');
      if (outcome === 'linked') fs.symlinkSync(payload, destination, process.platform === 'win32' ? 'junction' : 'dir');
      else fs.cpSync(payload, destination, { recursive: true });
      skillStatuses = ['installed', outcome === 'linked' ? 'incomplete' : 'external-match-preserved'];
      status = outcome === 'linked' ? 1 : 0;
      if (outcome === 'external') {
        // Temporary homes cannot establish stable external storage. Supply that result for presentation coverage.
        const receipt = {
          version: 1,
          action: 'install',
          results: ['claude', 'codex'].map((agent, index) => ({
            agent,
            destination: path.join(f.dir, agent === 'claude' ? '.claude' : '.agents', 'skills/arc-sessions'),
            status: skillStatuses[index],
          })),
          cancellation: null,
        };
        fs.writeFileSync(
          path.join(f.source, 'extension/dist/cli.cjs'),
          `console.log(${JSON.stringify(JSON.stringify(receipt))});`,
        );
      }
    }
    if (outcome === 'failed') {
      env.CLAUDE_CONFIG_DIR = path.dirname(f.settings);
      skillStatuses = ['failed', 'installed'];
      status = 1;
    }
    if (outcome === 'skipped') args.splice(0, 4, '--no-skills');
    if (outcome === 'hook-failed') {
      fs.unlinkSync(path.join(f.bin, 'claude'));
      status = 1;
    } else args.unshift('--no-hooks');
    if (outcome === 'cancelled') {
      fs.writeFileSync(path.join(f.source, 'extension/dist/cli.cjs'), 'process.exit(130);');
      status = 130;
    }
    const result = f.run(args, env, { skills: true, json });
    assert.equal(result.status, status, result.stdout + result.stderr);
    if (json) {
      const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.deepEqual(receipt.editors, [{ editor: 'code', status: 'completed' }]);
      assert.equal(receipt.cancellation, outcome === 'cancelled' ? 130 : null);
      assert.equal(receipt.components.hooks, outcome === 'hook-failed' ? 'failed' : 'skipped');
      if (outcome === 'skipped') assert.equal(receipt.components.skills, 'skipped');
      else if (outcome === 'cancelled') assert.equal(receipt.components.skills, 'cancelled');
      else
        assert.deepEqual(
          receipt.skills.results.map((r) => r.status),
          skillStatuses,
        );
    } else {
      assert.doesNotMatch(result.stdout, /^\s*\{/m);
      assert.match(result.stdout, /Editor.*code.*installed/i);
      assert.match(result.stdout, outcome === 'hook-failed' ? /hooks.*failed/i : /hooks.*skipped/i);
      if (outcome === 'skipped') assert.match(result.stdout, /skills.*skipped/i);
      else if (outcome === 'cancelled') {
        assert.match(result.stdout, /Claude.*cancelled/i);
        assert.match(result.stdout, /Codex.*cancelled/i);
        assert.match(result.stdout, /cancelled.*130/i);
      } else {
        assert.match(result.stdout, outcome === 'failed' ? /Claude.*failed/i : /Claude.*installed/i);
        assert.match(
          result.stdout,
          outcome === 'linked'
            ? /Codex.*incomplete/i
            : outcome === 'external'
              ? /Codex.*preserved/i
              : /Codex.*installed/i,
        );
        for (const agent of ['claude', 'codex']) {
          assert.ok(
            result.stdout
              .toLowerCase()
              .includes(
                path.join(f.dir, agent === 'claude' ? '.claude' : '.agents', 'skills/arc-sessions').toLowerCase(),
              ),
            result.stdout,
          );
        }
      }
    }
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  } finally {
    f.cleanup();
  }
});

test.each([[['codex']], [['claude']], [['claude', 'codex']]])(
  'downloaded source installs stable selected skills through the real compiled CLI with independent hooks (%j)',
  (agents) => {
    const f = installerFixture();
    try {
      const args = ['--remote', '--no-hooks', ...agents.flatMap((agent) => ['--skill-agent', agent]), 'code'];
      const result = f.run(args, { CLAUDE_CONFIG_DIR: '' }, { skills: true });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
      fs.rmSync(f.source, { recursive: true });
      for (const agent of agents) {
        const directory = path.join(f.dir, agent === 'claude' ? '.claude' : '.agents', 'skills/arc-sessions');
        expectSkillCopy(directory);
        assert.equal(fs.lstatSync(path.join(directory, 'SKILL.md')).isSymbolicLink(), false);
      }
      assert.match(result.stdout, /"skills":"completed"/);
      const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.deepEqual(receipt.selectedAgents, agents);
      assert.deepEqual(receipt.editors, [{ editor: 'code', status: 'completed' }]);
      assert.doesNotMatch(result.commands, /claude plugin/);
    } finally {
      f.cleanup();
    }
  },
);

test('Git Bash cancellation after skill child success retains source until exit and preserves completed receipt', () => {
  const f = installerFixture();
  try {
    const script = path.join(f.source, 'install.sh');
    fs.writeFileSync(
      script,
      fs
        .readFileSync(script, 'utf8')
        .replaceAll('\r\n', '\n')
        .replace(
          '    ARC_INSTALL_CHILD=\'\'\n    return "$status"',
          () =>
            '    if [ -f "$ARC_INSTALL_TEMP/skills.json" ]; then\n      kill -TERM "$$"\n      kill -HUP "$$"\n      [ -f "$REPO/extension/dist/cli.cjs" ] || return 98\n      echo child-exit-source-retained >> "$ARC_TEST_LOG"\n    fi\n    ARC_INSTALL_CHILD=\'\'\n    return "$status"',
        ),
    );
    assert.match(fs.readFileSync(script, 'utf8'), /kill -TERM "\$\$"\n      kill -HUP "\$\$"/);
    const result = f.run(['--no-hooks', '--skill-agent', 'codex', 'code'], { CLAUDE_CONFIG_DIR: '' }, { skills: true });
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.match(result.commands, /child-exit-source-retained/);
    assert.match(result.stdout, /"skills":"completed"/);
    assert.match(result.stdout, /"cancellation":143/);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
    expectSkillCopy(path.join(f.dir, '.agents/skills/arc-sessions'));
  } finally {
    f.cleanup();
  }
});

for (const mode of ['local', 'remote'])
  test(
    `${mode} handled cancellation before temporary allocation stops without a download failure`,
    { timeout: runBudget(3) },
    () => {
      for (const [first, second, status] of [
        ['TERM', 'HUP', 143],
        ['HUP', 'INT', 129],
        ['INT', 'TERM', 130],
      ]) {
        const f = installerFixture();
        try {
          const script = path.join(f.source, 'install.sh');
          const original = fs.readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
          const changed = original.replace(
            '  hook_source="$marketplace_url"',
            () =>
              `  hook_source="$marketplace_url"\n  echo acknowledged-before-temp >> "$ARC_TEST_LOG"\n  kill -${first} "$$"\n  kill -${second} "$$"`,
          );
          assert.notEqual(changed, original);
          fs.writeFileSync(script, changed);
          const allocator = path.join(f.bin, 'mktemp');
          fs.writeFileSync(
            allocator,
            fs.readFileSync(allocator, 'utf8').replace('exec ', 'echo temporary-allocation >> "$ARC_TEST_LOG"\nexec '),
          );
          const result = f.run(
            [`--${mode}`, '--skill-agent', 'claude', '--skill-agent', 'codex', 'code'],
            { CLAUDE_CONFIG_DIR: '' },
            { skills: true },
          );
          assert.equal(result.status, status, result.stdout + result.stderr);
          assert.equal(result.commands.trim(), 'acknowledged-before-temp');
          assert.doesNotMatch(result.stderr, /download failed|extraction failed/);
          const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
          assert.deepEqual(receipt.selectedAgents, ['claude', 'codex']);
          assert.deepEqual(receipt.editors, []);
          assert.deepEqual(receipt.components, { editors: 'unattempted', skills: 'cancelled', hooks: 'cancelled' });
          assert.equal(receipt.cancellation, status);
          assert.equal(receipt.skills, undefined);
          assert.deepEqual(fs.readdirSync(f.temporary), []);
        } finally {
          f.cleanup();
        }
      }
    },
  );

test.each([
  ['revision', '    if ! run_child curl --fail', /curl|tar-attempt|package/],
  [
    'archive',
    '    if ! run_child curl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 "https://codeload',
    /codeload|tar-attempt|package/,
  ],
  ['extraction', '    if ! run_child tar -xzf', /tar-attempt|package/],
  ['packaging', '  if ! run_child node scripts/package.mjs', /package/],
  ['version', '  version="$(node -p', /editor|legacy-migration/],
])('cancelled %s admission reports cancellation without an unattempted child failure', (phase, boundary, forbidden) => {
  const f = installerFixture();
  try {
    const script = path.join(f.source, 'install.sh');
    const original = fs.readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
    const changed = original.replace(boundary, () =>
      phase === 'version'
        ? `  export ARC_TEST_INSTALLER_PID="$$"\n${boundary}`
        : `  echo cancelled-at-admission >> "$ARC_TEST_LOG"\n  kill -TERM "$$"\n  kill -HUP "$$"\n${boundary}`,
    );
    assert.notEqual(changed, original);
    fs.writeFileSync(script, changed);
    if (phase === 'version') {
      const node = path.join(f.bin, 'node');
      fs.writeFileSync(
        node,
        fs
          .readFileSync(node, 'utf8')
          .replace(
            'exec ',
            'if [ "$1" = -p ]; then echo cancelled-at-admission >> "$ARC_TEST_LOG"; kill -TERM "$ARC_TEST_INSTALLER_PID"; fi\nexec ',
          ),
      );
    }
    const tar = path.join(f.bin, 'tar');
    fs.writeFileSync(tar, fs.readFileSync(tar, 'utf8').replace('exec ', 'echo tar-attempt >> "$ARC_TEST_LOG"\nexec '));
    const result = f.run(
      ['--remote', '--skill-agent', 'claude', '--skill-agent', 'codex', 'code'],
      { CLAUDE_CONFIG_DIR: '' },
      { skills: true },
    );
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.match(result.commands, /cancelled-at-admission/);
    assert.doesNotMatch(result.commands.split('cancelled-at-admission\n')[1], forbidden);
    assert.doesNotMatch(result.stderr, /download failed|extraction failed|packaging failed|no editor installed Arc/);
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(receipt.selectedAgents, ['claude', 'codex']);
    assert.deepEqual(receipt.editors, []);
    assert.deepEqual(receipt.components, { editors: 'unattempted', skills: 'cancelled', hooks: 'cancelled' });
    assert.equal(receipt.cancellation, 143);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  } finally {
    f.cleanup();
  }
});

test.each(['before-version', 'version-child', 'validation-child'])(
  'marketplace preflight %s cancellation stops probes and preserves the cancellation receipt',
  (phase) => {
    const f = installerFixture();
    try {
      const script = path.join(f.source, 'install.sh');
      const original = fs.readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
      const changed = original.replace(
        '  hook_source="$marketplace_url"',
        () =>
          `  export ARC_TEST_INSTALLER_PID="$$"\n  hook_source="$marketplace_url"${phase === 'before-version' ? '\n  kill -INT "$$"\n  kill -TERM "$$"' : ''}`,
      );
      assert.notEqual(changed, original);
      fs.writeFileSync(script, changed);
      const claude = path.join(f.bin, 'claude');
      fs.writeFileSync(
        claude,
        fs
          .readFileSync(claude, 'utf8')
          .replace(
            'exec ',
            phase === 'version-child'
              ? 'if [ "$1" = --version ]; then echo version-attempt >> "$ARC_TEST_LOG"; kill -INT "$ARC_TEST_INSTALLER_PID"; kill -TERM "$ARC_TEST_INSTALLER_PID"; else exec '
              : 'echo version-attempt >> "$ARC_TEST_LOG"\nexec ',
          ) + (phase === 'version-child' ? '\nfi\n' : ''),
      );
      const node = path.join(f.bin, 'node');
      fs.writeFileSync(
        node,
        fs
          .readFileSync(node, 'utf8')
          .replace(
            'exec ',
            `if [[ "$1" = -e && "$2" = *'m=process.argv[1].match'* ]]; then\n  echo validation-attempt >> "$ARC_TEST_LOG"\n${phase === 'validation-child' ? '  kill -INT "$ARC_TEST_INSTALLER_PID"\n  kill -TERM "$ARC_TEST_INSTALLER_PID"\n' : ''}fi\nexec `,
          ),
      );
      const result = f.run(
        ['--marketplace-url', catalogUrl, '--skill-agent', 'claude', '--skill-agent', 'codex', 'code'],
        { CLAUDE_CONFIG_DIR: '', ARC_TEST_CLAUDE_VERSION: 'invalid' },
        { skills: true },
      );
      assert.equal(result.status, 130, result.stdout + result.stderr);
      assert.equal(
        result.commands.trim(),
        phase === 'before-version'
          ? ''
          : phase === 'version-child'
            ? 'version-attempt'
            : 'version-attempt\nclaude --version\nvalidation-attempt',
      );
      assert.doesNotMatch(result.stderr, /require Claude Code|download failed|extraction failed/);
      const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.deepEqual(receipt.selectedAgents, ['claude', 'codex']);
      assert.deepEqual(receipt.editors, []);
      assert.deepEqual(receipt.components, { editors: 'unattempted', skills: 'cancelled', hooks: 'cancelled' });
      assert.equal(receipt.cancellation, 130);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
    } finally {
      f.cleanup();
    }
  },
);

test('downloaded bundled hook cancellation awaits the acknowledged child before source cleanup', () => {
  const f = installerFixture();
  try {
    const watcher = path.join(f.dir, 'hook-wait.cjs');
    fs.writeFileSync(
      watcher,
      String.raw`const fs = require('node:fs');
const path = require('node:path');
const root = process.env.ARC_TEST_ROOT;
const release = path.join(root, 'hook-release');
const setup = process.argv[2];
fs.writeFileSync(path.join(root, 'hook-ready'), process.cwd());
const observer = fs.watch(path.join(root, 'temporary'), check);
const control = fs.watch(root, check);
const deadline = setTimeout(() => finish('hook-deadline', 98), 10000);
function finish(message, status) {
  fs.appendFileSync(process.env.ARC_TEST_LOG, message + '\n');
  observer.close(); control.close(); clearTimeout(deadline); process.exitCode = status;
}
function check() {
  if (!fs.existsSync(setup)) finish('hook-source-lost', 98);
  else if (fs.existsSync(release)) finish('hook-child-settled', 0);
}
check();`,
    );
    const node = path.join(f.bin, 'node');
    const originalNode = fs.readFileSync(node, 'utf8');
    fs.writeFileSync(
      node,
      originalNode.replace(
        'exec "$ARC_TEST_REAL_NODE" "$@"',
        'if [[ "$1" == */dist/setup.cjs ]]; then "$ARC_TEST_REAL_NODE" "$ARC_TEST_ROOT/hook-wait.cjs" "$1" || exit $?; fi\nexec "$ARC_TEST_REAL_NODE" "$@"',
      ),
    );
    const script = path.join(f.source, 'install.sh');
    const original = fs.readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
    const injection = String.raw`    if [[ "$*" == *'/dist/setup.cjs'* ]]; then
      boundary_deadline=$((SECONDS + 10))
      while [ ! -f "$ARC_TEST_ROOT/hook-ready" ]; do
        if [ "$SECONDS" -ge "$boundary_deadline" ]; then return 98; fi
      done
      kill -TERM "$$"
      kill -HUP "$$"
      kill -TERM "$BASHPID"
      [ -f "$REPO/extension/dist/setup.cjs" ] || return 98
      echo released > "$ARC_TEST_ROOT/hook-release"
    fi
`;
    const changed = original.replace('    ARC_INSTALL_CHILD=$!\n', () => '    ARC_INSTALL_CHILD=$!\n' + injection);
    assert.notEqual(changed, original);
    fs.writeFileSync(script, changed);
    const result = f.run(['--remote', 'code'], { CLAUDE_CONFIG_DIR: '' });
    assert.match(result.commands, /hook-child-settled/);
    assert.doesNotMatch(result.commands, /hook-source-lost|hook-deadline/);
    assert.equal(result.status, 143, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(receipt.components.hooks, 'completed');
    assert.equal(receipt.cancellation, 143);
    assert.equal(fs.readFileSync(path.join(f.dir, 'hook-ready'), 'utf8'), path.join(f.dir, 'unrelated'));
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  } finally {
    f.cleanup();
  }
});

test('skill selector conflicts refuse before build or native writes', { timeout: runBudget(3) }, () => {
  const f = installerFixture();
  try {
    for (const args of [['--skill-agent'], ['--skill-agent', 'other'], ['--no-skills', '--skill-agent', 'codex']]) {
      const result = f.run([...args, 'code'], {}, { skills: true });
      assert.equal(result.status, 2, result.stderr);
      assert.doesNotMatch(result.commands, /npm|editor/);
      assert.equal(fs.existsSync(path.join(f.dir, '.agents/skills')), false);
    }
  } finally {
    f.cleanup();
  }
});

test.each(['none', 'codex', 'claude', 'both', 'missing-hook', 'old-hook', 'bad-marketplace', 'no-skills'])(
  'detected provider %s retains independent skill and editor outcomes',
  (mode) => {
    const f = installerFixture();
    try {
      if (['none', 'codex', 'missing-hook'].includes(mode)) fs.unlinkSync(path.join(f.bin, 'claude'));
      if (['codex', 'both'].includes(mode))
        fs.writeFileSync(path.join(f.bin, 'codex'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      const hooks = ['missing-hook', 'old-hook', 'bad-marketplace'].includes(mode);
      const args = hooks
        ? ['--skill-agent', 'codex', '--marketplace-url', catalogUrl, 'code']
        : ['--no-hooks', ...(mode === 'no-skills' ? ['--no-skills'] : []), 'code'];
      const result = f.run(
        args,
        {
          CLAUDE_CONFIG_DIR: '',
          ...(mode === 'old-hook' ? { ARC_TEST_CLAUDE_VERSION: '2.1.223' } : {}),
          ...(mode === 'bad-marketplace' ? { ARC_TEST_FAIL_COMMAND: 'plugin marketplace list --json' } : {}),
        },
        { skills: true },
      );
      assert.equal(result.status, hooks ? 1 : 0, result.stdout + result.stderr);
      assert.match(result.commands, /editor code/);
      const expected = hooks
        ? ['codex']
        : mode === 'both'
          ? ['claude', 'codex']
          : ['none', 'no-skills'].includes(mode)
            ? []
            : [mode];
      for (const agent of ['claude', 'codex'])
        assert.equal(
          fs.existsSync(path.join(f.dir, agent === 'claude' ? '.claude' : '.agents', 'skills/arc-sessions/SKILL.md')),
          expected.includes(agent),
        );
      if (hooks) assert.match(result.stdout, /"hooks":"failed"/);
      const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.deepEqual(receipt.selectedAgents, expected);
      assert.deepEqual(receipt.editors, [{ editor: 'code', status: 'completed' }]);
    } finally {
      f.cleanup();
    }
  },
);

test.each([
  'plugin marketplace list --json',
  'plugin marketplace add',
  'plugin marketplace update arc',
  'plugin install arc-hooks@arc --scope user',
  '--plugin-report',
])('cancellation refuses later build, hook mutations and legacy cleanup after child settlement (%s)', (command) => {
  const f = installerFixture();
  try {
    const script = path.join(f.source, 'install.sh');
    const injection = `    if [[ "$*" == *'${command}'* ]]; then\n      kill -TERM "$$"\n      echo cancelled-after-child >> "$ARC_TEST_LOG"\n    fi\n`;
    const original = fs.readFileSync(script, 'utf8').replaceAll('\r\n', '\n');
    const changed = original.replace(
      '    ARC_INSTALL_CHILD=\'\'\n    return "$status"',
      () => injection + '    ARC_INSTALL_CHILD=\'\'\n    return "$status"',
    );
    assert.notEqual(changed, original);
    fs.writeFileSync(script, changed);
    if (command === '--plugin-report') {
      const helper = path.join(f.source, 'scripts/install-claude-hooks.sh');
      const originalHelper = fs.readFileSync(helper, 'utf8').replaceAll('\r\n', '\n');
      const report = `  printf '%s' "$plugins" | node "$repo/scripts/check-claude-marketplace.js" --plugin-report "$catalog" "$source_type"`;
      const changedHelper = originalHelper.replace(
        report,
        () => `${report}\n  kill -TERM "$$"\n  echo cancelled-after-child >> "$ARC_TEST_LOG"`,
      );
      assert.notEqual(changedHelper, originalHelper);
      fs.writeFileSync(helper, changedHelper);
    }
    const result = f.run(['code']);
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.match(result.commands, /cancelled-after-child/);
    assert.doesNotMatch(
      result.stderr,
      /snapshot plugin setup failed|legacy hook settings need manual review|Claude rejected|hosted catalog is unavailable/,
    );
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(receipt.components.hooks, command === '--plugin-report' ? 'completed' : 'cancelled');
    assert.equal(receipt.cancellation, 143);
    assert.doesNotMatch(result.stdout, /==> Installed Arc\./);
    assert.doesNotMatch(result.commands, /legacy-migration/);
    if (command.includes('list')) assert.doesNotMatch(result.commands, /npm|editor/);
    else if (command.includes('marketplace update'))
      assert.doesNotMatch(result.commands, /plugin (install|update|enable)/);
    else if (command !== '--plugin-report') assert.doesNotMatch(result.commands, /plugin (update|enable)/);
    assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  } finally {
    f.cleanup();
  }
});

test('cancelled skill child reports cancellation and prevents later hooks', () => {
  const f = installerFixture();
  try {
    fs.writeFileSync(path.join(f.source, 'extension/dist/cli.cjs'), 'process.exit(130);');
    const result = f.run(['--skill-agent', 'codex', 'code'], { CLAUDE_CONFIG_DIR: '' }, { skills: true });
    assert.equal(result.status, 130, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(receipt.components.skills, 'cancelled');
    assert.equal(receipt.components.editors, 'completed');
    assert.equal(receipt.cancellation, 130);
    assert.doesNotMatch(result.commands, /plugin marketplace update|legacy-migration/);
  } finally {
    f.cleanup();
  }
});

test('missing selected editor refuses globally before build', () => {
  const f = installerFixture();
  try {
    fs.appendFileSync(
      path.join(f.source, 'scripts/editor-cli.sh'),
      "\nresolve_editor_cli() { printf '%s\\n' 'missing-resolved-editor'; }\n",
    );
    const result = f.run(['--no-hooks', 'code']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /editor CLI not found: missing-resolved-editor/);
    assert.doesNotMatch(result.commands, /npm|editor/);
  } finally {
    f.cleanup();
  }
});

function fixturePaths(dir) {
  const artifact = path.join(dir, 'artifacts');
  return {
    source: path.join(dir, 'source with spaces'),
    bin: path.join(dir, 'bin'),
    hostBin: path.join(dir, 'host-bin'),
    temporary: path.join(dir, 'temporary'),
    unrelated: path.join(dir, 'unrelated'),
    log: path.join(dir, 'commands.log'),
    plugins: path.join(dir, 'plugins.json'),
    marketplaces: path.join(dir, 'marketplaces.json'),
    managed: path.join(dir, 'claude home', 'managed-copy'),
    claudeFixture: path.join(dir, 'claude-fixture.cjs'),
    curlFixture: path.join(dir, 'curl-fixture.cjs'),
    artifact,
    zip: path.join(artifact, 'arc-hooks-0.1.0.zip'),
    tar: path.join(dir, 'source.tar.gz'),
    settings: path.join(dir, 'claude home', 'settings.json'),
    codex: path.join(dir, 'codex home'),
  };
}

let absoluteBashPath;
function absoluteBash() {
  absoluteBashPath ??= bashPath(path.dirname(bashExecutable)) + '/' + path.basename(bashExecutable);
  return absoluteBashPath;
}

const parentBashPaths = new Map();
// One conversion serves every fixture folder in the same parent folder.
function fixtureBashPath(dir) {
  const parent = path.dirname(dir);
  if (!parentBashPaths.has(parent)) parentBashPaths.set(parent, bashPath(parent));
  return parentBashPaths.get(parent) + '/' + path.basename(dir);
}

let templateDir;
// The installer fixture contents do not depend on their folder, so each fixture copies one built template.
function fixtureTemplate() {
  if (templateDir) return templateDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-template-'));
  const { source, bin, hostBin, temporary, unrelated, plugins, marketplaces, claudeFixture, curlFixture, artifact } =
    fixturePaths(dir);
  for (const folder of [
    bin,
    hostBin,
    temporary,
    unrelated,
    path.join(source, 'extension', 'scripts'),
    path.join(source, 'scripts'),
    path.join(source, '.claude-plugin'),
  ])
    fs.mkdirSync(folder, { recursive: true });
  for (const name of ['editor-cli.sh', 'register-hooks.js', 'install-claude-hooks.sh', 'check-claude-marketplace.js'])
    fs.copyFileSync(path.join(__dirname, name), path.join(source, 'scripts', name));
  fs.cpSync(path.join(__dirname, '..', 'plugins'), path.join(source, 'plugins'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'cli', 'skills'), path.join(source, 'cli', 'skills'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', '.claude-plugin', 'marketplace.json'),
    path.join(source, '.claude-plugin', 'marketplace.json'),
  );
  const pluginManifest = path.join(source, 'plugins', 'arc-hooks', '.claude-plugin', 'plugin.json');
  fs.writeFileSync(
    pluginManifest,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(pluginManifest)), version: '0.1.0' }),
  );
  fs.copyFileSync(path.join(__dirname, '..', 'install.sh'), path.join(source, 'install.sh'));
  fs.writeFileSync(path.join(source, 'extension', 'package.json'), '{"version":"0.0.9"}');
  fs.writeFileSync(path.join(source, 'extension', 'package-lock.json'), '{}');
  fs.writeFileSync(
    path.join(source, 'extension', 'scripts', 'package.mjs'),
    String.raw`import fs from 'node:fs';
fs.appendFileSync(process.env.ARC_TEST_LOG, 'package\n');
if (process.env.ARC_TEST_PACKAGE_FAILURE) process.exit(1);
fs.writeFileSync(process.argv.at(-1), 'fixture VSIX');`,
  );
  const write = (name, text) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
  const utilities = ['awk', 'basename', 'cat', 'chmod', 'dirname', 'gzip', 'mkdir', 'mktemp', 'readlink', 'rm', 'tar'];
  const utilityPaths = bash('for utility in "$@"; do command -v "$utility" || exit 1; done', ...utilities).split('\n');
  for (const [index, name] of utilities.entries()) {
    const command = `#!${absoluteBash()}\nexec '${utilityPaths[index].replaceAll("'", "'\\''")}' "$@"\n`;
    fs.writeFileSync(path.join(hostBin, name), command, { mode: 0o755 });
    fs.copyFileSync(path.join(hostBin, name), path.join(bin, name));
  }
  for (const name of ['git', 'node', 'npm'])
    fs.writeFileSync(path.join(hostBin, name), `#!${absoluteBash()}\nexit 97\n`, { mode: 0o755 });
  write(
    'node',
    'case "$1" in */dist/setup.cjs) echo source-snapshot-setup >> "$ARC_TEST_LOG" ;; */register-hooks.js) echo legacy-migration >> "$ARC_TEST_LOG" ;; esac\nexec "$ARC_TEST_REAL_NODE" "$@"',
  );
  write(
    'npm',
    'cat >/dev/null\necho "npm $*" >> "$ARC_TEST_LOG"\nif [ "$1" = ci ] && [ "${ARC_TEST_LOCKED_DEPENDENCY:-0}" = 1 ]; then echo "EPERM: cannot unlink esbuild.exe" >&2; exit 1; fi\nexit "${ARC_TEST_NPM_FAILURE:-0}"',
  );
  for (const name of ['code', 'cursor'])
    write(
      name,
      `cat >/dev/null
echo "editor ${name} $*" >> "$ARC_TEST_LOG"
[ "${name}" != "$ARC_TEST_FAIL_EDITOR" ]`,
    );
  write('claude', 'exec "$ARC_TEST_REAL_NODE" "$ARC_TEST_CLAUDE_FIXTURE" "$@"');
  write(
    'curl',
    'if [[ -n "${ARC_TEST_INTERRUPT:-}" && "$*" == *codeload* ]]; then "$ARC_TEST_REAL_NODE" "$ARC_TEST_CURL_FIXTURE" "$@"; kill -TERM "$PPID"; exit 1; fi\nexec "$ARC_TEST_REAL_NODE" "$ARC_TEST_CURL_FIXTURE" "$@"',
  );
  const built = spawnSync(
    process.execPath,
    [
      '-e',
      'require(process.argv[1]).packageClaudePlugin(process.argv[2],process.argv[3]).catch(error=>{console.error(error);process.exitCode=1})',
      path.join(__dirname, 'package-claude-plugin.js'),
      artifact,
      path.join(source, 'plugins', 'arc-hooks'),
    ],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(built.status, 0, built.stderr);
  const dist = path.join(source, 'extension', 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'cli.cjs'), skillCLI);
  fs.writeFileSync(path.join(dist, 'windowpipe.exe'), 'fixture helper');
  fs.copyFileSync(path.join(__dirname, '..', 'LICENSE'), path.join(source, 'LICENSE'));
  const setup = require('../extension/node_modules/esbuild').buildSync({
    stdin: {
      resolveDir: path.join(__dirname, '..', 'extension'),
      contents: String.raw`import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {BundledTools, readToolPackage} from './src/bundledtools';
import {ClaudePluginSetup, pluginTarget} from './src/claudeplugin';
if (process.argv.slice(2).join(' ') !== '--snapshots') throw Error('Unexpected setup operation');
const tools = new BundledTools(readToolPackage(__dirname), process.env.ARC_HOME);
const target = pluginTarget(process.cwd(), process.env.CLAUDE_CONFIG_DIR,
  {command:process.env.ARC_TEST_REAL_NODE,leadingArgs:[process.env.ARC_TEST_CLAUDE_FIXTURE],env:{},problem:null},'fixture');
const run = async command => {
  if(command.args.join(' ') === '--version' && command.command === process.env.ARC_TEST_REAL_NODE && command.args.length === 1) return {stdout:process.version,stderr:''};
  const result = spawnSync(command.command,command.args,{cwd:command.cwd,env:command.env,input:'',encoding:'utf8'});
  if(result.status !== 0) throw Error(result.stderr || 'Fixture Claude failed');
  return result;
};
const read = file => {
  const relative = path.relative(process.env.ARC_TEST_ROOT,file);
  if(relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) return undefined;
  try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch(error) { if(error.code === 'ENOENT') return undefined; throw error; }
};
new ClaudePluginSetup(run,undefined,read,tools,()=>process.env.ARC_TEST_REAL_NODE)
  .install(target,new AbortController().signal).then(console.log).catch(error=>{console.error(error.message);process.exitCode=1});`,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].contents;
  fs.writeFileSync(path.join(dist, 'setup.cjs'), setup);
  const payload = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import {bundledTools} from ' +
        JSON.stringify(
          require('node:url').pathToFileURL(path.join(__dirname, '..', 'extension', 'scripts', 'bundled-tools.mjs'))
            .href,
        ) +
        '; import fs from "node:fs"; const identity=bundledTools(process.argv[1],process.argv[2],{}).identity; fs.writeFileSync(process.argv[1]+"/build-identity.json",JSON.stringify({tools:identity}));',
      dist,
      source,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(payload.status, 0, payload.stderr);
  const tarResult = spawnSync(
    bashExecutable,
    [
      '-c',
      'tar -czf "$1" -C "$2" "$3"',
      'bash',
      bashPath(dir) + '/source.tar.gz',
      bashPath(dir),
      path.basename(source),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(tarResult.status, 0, tarResult.stderr);
  fs.writeFileSync(plugins, '[]');
  fs.writeFileSync(marketplaces, '[]');
  fs.writeFileSync(
    claudeFixture,
    String.raw`const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const yauzl = createRequire(process.env.ARC_TEST_EXTENSION_MANIFEST)('yauzl');
async function main() {
const command = process.argv.slice(2).join(' ');
fs.appendFileSync(process.env.ARC_TEST_LOG, 'claude ' + command + '\n');
if (fs.readFileSync(0).length) throw new Error('Claude consumed installer input');
if (command === '--version') { console.log(process.env.ARC_TEST_CLAUDE_VERSION || '2.1.268 (Claude Code)'); return; }
if (command === process.env.ARC_TEST_FAIL_COMMAND) { console.error('Claude failed'); process.exit(1); }
if (command === 'plugin marketplace list --json') process.stdout.write(fs.readFileSync(process.env.ARC_TEST_MARKETPLACES));
else if (command === 'plugin list --json') process.stdout.write(process.env.ARC_TEST_PLUGIN_LIST ?? fs.readFileSync(process.env.ARC_TEST_PLUGINS));
else if (command.startsWith('plugin marketplace add ')) {
  if (process.env.ARC_TEST_NO_RELEASES && process.argv[5].startsWith('https:')) { console.error('Release catalog unavailable'); process.exit(1); }
  const location = process.argv[5];
  fs.writeFileSync(process.env.ARC_TEST_MARKETPLACES, JSON.stringify([{name:'arc',...(location.startsWith('https:') ? {source:'url',url:location} : {source:'directory',path:location})}]));
}
else if (command === 'plugin install arc-hooks@arc --scope user' || command === 'plugin enable arc-hooks@arc --scope user' || /^plugin (install|update) arc-hooks@arc --scope user --json$/.test(command)) {
  const plugins = JSON.parse(fs.readFileSync(process.env.ARC_TEST_PLUGINS));
  let plugin = plugins.find(p => p.id === 'arc-hooks@arc' && p.scope === 'user');
  if (command.startsWith('plugin install') || command.startsWith('plugin update')) {
    const marketplace = JSON.parse(fs.readFileSync(process.env.ARC_TEST_MARKETPLACES)).find(entry=>entry.name==='arc');
    const source = typeof marketplace.source === 'object' ? marketplace.source : marketplace;
    if (source.source === 'directory') {
      const root = process.platform === 'win32' ? source.path.replace(/^\/([a-z])\//i, '$1:/') : source.path;
      const catalog = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json')));
      const readFromFolder = path.resolve(root, catalog.plugins[0].source);
      if (!plugin) plugins.push({id:'arc-hooks@arc',scope:'user',enabled:true,version:'0.1.0',errors:[],readFromFolder});
      else plugin.readFromFolder=readFromFolder;
    } else {
    fs.mkdirSync(process.env.ARC_TEST_MANAGED, {recursive:true});
    const zip = await new Promise((resolve,reject)=>yauzl.open(process.env.ARC_TEST_PLUGIN_ZIP,{lazyEntries:true},(err,zip)=>err?reject(err):resolve(zip)));
    await new Promise((resolve,reject)=>{
      zip.on('error',reject);
      zip.on('end',resolve);
      zip.on('entry',entry=>zip.openReadStream(entry,(error,stream)=>{
        if(error) return reject(error);
        const target=path.join(process.env.ARC_TEST_MANAGED,entry.fileName);
        fs.mkdirSync(path.dirname(target),{recursive:true});
        const output=fs.createWriteStream(target);
        output.on('error',reject);
        output.on('finish',()=>zip.readEntry());
        stream.on('error',reject);
        stream.pipe(output);
      }));
      zip.readEntry();
    });
    if (!plugin) plugins.push({id:'arc-hooks@arc',scope:'user',enabled:true,version:'0.1.0',errors:[],source:JSON.parse(fs.readFileSync(process.env.ARC_TEST_PLUGIN_CATALOG)).plugins[0].source});
    }
  } else { plugin.enabled = process.env.ARC_TEST_STILL_DISABLED !== '1'; }
  fs.writeFileSync(process.env.ARC_TEST_PLUGINS, JSON.stringify(plugins));
  if (command.endsWith('--json')) console.log(JSON.stringify({command:process.argv[3],outcome:'ok',scope:'user',pluginId:'arc-hooks@arc'}));
}
}
main().catch(error=>{console.error(error);process.exitCode=1;});`,
  );
  fs.writeFileSync(
    curlFixture,
    String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('https:'));
fs.appendFileSync(process.env.ARC_TEST_LOG, 'curl ' + args.join(' ') + '\n');
if (process.env.ARC_TEST_HTTP_FAILURE && url.includes(process.env.ARC_TEST_HTTP_FAILURE)) process.exit(28);
const output = args[args.indexOf('--output')+1];
if (url.startsWith('https://api.github.com/')) fs.writeFileSync(output, JSON.stringify({sha:process.env.ARC_TEST_BAD_REVISION ? 'invalid' : 'a'.repeat(40)}));
else if (process.env.ARC_TEST_BAD_ARCHIVE) fs.writeFileSync(output,'invalid archive');
else fs.copyFileSync(process.env.ARC_TEST_SOURCE_ARCHIVE,output);
`,
  );
  templateDir = dir;
  return dir;
}

function installerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-install-'));
  fs.cpSync(fixtureTemplate(), dir, { recursive: true });
  const {
    source,
    bin,
    hostBin,
    temporary,
    unrelated,
    log,
    plugins,
    marketplaces,
    managed,
    claudeFixture,
    curlFixture,
    artifact,
    zip,
    tar,
    settings,
    codex,
  } = fixturePaths(dir);
  const dirBashPath = fixtureBashPath(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const legacy = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${source.replaceAll(String.fromCharCode(92), '/')}/hooks/stop-manifest.cjs"`,
            },
          ],
        },
      ],
    },
  });
  fs.writeFileSync(settings, legacy);
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, 'hooks.json'), legacy);
  return {
    dir,
    source,
    bin,
    hostBin,
    marketplaces,
    plugins,
    managed,
    settings,
    temporary,
    legacy,
    editor(product, layout, cliName = product, { copied = false, target, version = '', installationName } = {}) {
      const installation = path.join(
        dir,
        installationName ?? `${product}-${layout}${target ? '-' + target : ''}${version ? '-' + version : ''}`,
      );
      const root = layout === 'macos' ? path.join(installation, `${product}.app`, 'Contents') : installation;
      const app = path.join(root, version, layout === 'macos' ? 'Resources' : 'resources', 'app');
      const askpass = copied
        ? path.join(dir, 'storage', path.basename(installation), 'askpass', 'a'.repeat(16), 'askpass-main.js')
        : path.join(app, 'extensions', 'git', 'dist', 'askpass-main.js');
      const metadata = path.join(app, 'product.json');
      const executable = path.join(
        root,
        ...(layout === 'macos'
          ? ['Frameworks', `${product} Helper (Plugin).app`, 'Contents', 'MacOS', `${product} Helper (Plugin)`]
          : [product + (layout === 'windows' ? '.exe' : '')]),
      );
      const launcher = path.join(layout === 'windows' ? root : app, 'bin', cliName);
      for (const file of [askpass, metadata, executable, launcher])
        fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(askpass, '');
      fs.writeFileSync(metadata, JSON.stringify({ applicationName: product, target }));
      fs.writeFileSync(executable, '');
      fs.writeFileSync(launcher, `#!/bin/bash\necho "editor ${product} $*" >> "$ARC_TEST_LOG"\n`, { mode: 0o755 });
      return {
        env: { TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: askpass, VSCODE_GIT_ASKPASS_NODE: executable },
        metadata,
        launcher,
        executable,
        root,
      };
    },
    run(
      args = ['code'],
      env = {},
      { stdin = false, cwd = unrelated, terminalInput, scriptFile, skills = false, json = true } = {},
    ) {
      fs.writeFileSync(log, '');
      let input;
      if (stdin) {
        input = fs.readFileSync(path.join(source, 'install.sh'), 'utf8');
        if (terminalInput !== undefined) {
          // A separate stream supplies terminal choices while children receive no script input.
          fs.writeFileSync(path.join(dir, 'terminal-input'), terminalInput);
          input = input.replaceAll('/dev/tty', `"${dirBashPath}/terminal-input"`);
        }
        input += '\nprintf "ARC_INSTALL_SCRIPT_TAIL\\n"\n';
      }
      const script = 'export PATH="$1"; shift; command -v git >/dev/null && exit 98; exec "$1" "${@:2}"';
      const command = [
        '-c',
        script,
        'bash',
        dirBashPath + '/bin',
        absoluteBash(),
        ...(stdin ? ['-s', '--'] : [scriptFile ?? dirBashPath + '/' + path.basename(source) + '/install.sh']),
        ...(json ? ['--json'] : []),
        ...(!skills ? ['--no-skills'] : []),
        ...args,
      ];
      const result = spawnSync(bashExecutable, command, {
        cwd,
        input,
        encoding: 'utf8',
        timeout: RUN_TIMEOUT,
        env: {
          ...process.env,
          TERM_PROGRAM: '',
          VSCODE_GIT_ASKPASS_MAIN: '',
          VSCODE_GIT_ASKPASS_NODE: '',
          ARC_TEST_REAL_NODE: process.execPath,
          ARC_TEST_ROOT: dir,
          ARC_HOME: path.join(dir, 'arc home'),
          ARC_TEST_LOG: log,
          ARC_TEST_MARKETPLACES: marketplaces,
          ARC_TEST_PLUGINS: plugins,
          ARC_TEST_CLAUDE_FIXTURE: claudeFixture,
          ARC_TEST_CURL_FIXTURE: curlFixture,
          ARC_TEST_SOURCE_ARCHIVE: tar,
          ARC_TEST_PLUGIN_ZIP: zip,
          ARC_TEST_PLUGIN_CATALOG: path.join(artifact, 'arc-marketplace.json'),
          ARC_TEST_MANAGED: managed,
          ARC_TEST_EXTENSION_MANIFEST: path.join(__dirname, '..', 'extension', 'package.json'),
          ARC_TEST_FAIL_COMMAND: '',
          ARC_TEST_FAIL_EDITOR: '',
          CLAUDE_CONFIG_DIR: path.dirname(settings),
          CODEX_HOME: codex,
          HOME: dir.replaceAll(String.fromCharCode(92), '/'),
          USERPROFILE: dir,
          TMPDIR: dirBashPath + '/temporary',
          ...env,
        },
      });
      return { ...result, commands: fs.readFileSync(log, 'utf8') };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const missing of ['SKILL.md', 'compaction.md']) {
  test(`source setup refuses an incomplete checkout before building when its session skill lacks ${missing}`, () => {
    const f = installerFixture();
    try {
      fs.unlinkSync(path.join(f.source, 'cli/skills/arc-sessions', missing));
      const result = f.run(['--local', '--no-hooks', 'code']);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--local requires a complete Arc source directory/);
      assert.doesNotMatch(result.commands, /npm |editor /);
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test(`downloaded incomplete source refuses globally before build or native installation when the session skill lacks ${missing}`, () => {
    const f = installerFixture();
    try {
      fs.unlinkSync(path.join(f.source, 'cli/skills/arc-sessions', missing));
      const archive = spawnSync(
        bashExecutable,
        [
          '-c',
          'tar -czf "$1" -C "$2" "$3"',
          'bash',
          bashPath(f.dir) + '/source.tar.gz',
          bashPath(f.dir),
          path.basename(f.source),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(archive.status, 0, archive.stderr);
      const result = f.run(
        ['--remote', '--no-hooks', '--skill-agent', 'codex', 'code'],
        { CLAUDE_CONFIG_DIR: '' },
        { skills: true },
      );
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /downloaded archive lacks required Arc source files/);
      assert.doesNotMatch(result.commands, /npm|editor/);
      assert.equal(fs.existsSync(path.join(f.dir, '.agents/skills')), false);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
    } finally {
      f.cleanup();
    }
  });
}

test(
  'local installation refreshes its directory marketplace and migrates owned legacy hooks after plugin success',
  { timeout: runBudget(2) },
  () => {
    const f = installerFixture();
    try {
      for (let run = 0; run < 2; run++) {
        const r = f.run(['code'], { ARC_TEST_LOCKED_DEPENDENCY: '1' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(
          r.commands,
          /claude plugin marketplace list --json[\s\S]*npm install[\s\S]*editor code --install-extension[\s\S]*claude plugin marketplace update/,
        );
        assert.equal((r.commands.match(/marketplace add /g) ?? []).length, run ? 0 : 1);
        assert.match(r.commands, /plugin marketplace update arc/);
        assert.match(r.commands, /plugin update arc-hooks@arc --scope user/);
        assert.doesNotMatch(r.commands, /plugin enable|curl|npm ci/);
        assert.match(r.stdout, /Built extension version: 0.0.9/);
        assert.match(r.stdout, /Installed plugin version: 0.1.0/);
        assert.ok(
          r.stdout.includes(`Plugin directory: ${path.join(fs.realpathSync(f.source), 'plugins', 'arc-hooks')}`),
          r.stdout,
        );
        assert.doesNotMatch(r.stdout, /Plugin archive/);
        const [marketplace] = JSON.parse(fs.readFileSync(f.marketplaces));
        assert.equal(marketplace.source, 'directory');
        assert.equal(fs.realpathSync(marketplace.path), fs.realpathSync(f.source));
        assert.equal(fs.existsSync(f.managed), false);
        assert.deepEqual(fs.readdirSync(f.temporary), []);
      }
      assert.equal(JSON.parse(fs.readFileSync(f.settings)).hooks, undefined);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'codex home', 'hooks.json'))).hooks, undefined);
      const [plugin] = JSON.parse(fs.readFileSync(f.plugins));
      assert.equal(
        fs.realpathSync(plugin.readFromFolder),
        fs.realpathSync(path.join(f.source, 'plugins', 'arc-hooks')),
      );
      exerciseManagedHooks({ ...f, managed: plugin.readFromFolder });
    } finally {
      f.cleanup();
    }
  },
);

test(
  'source installation enables only the disabled user plugin and rejects unsuccessful enablement',
  { timeout: runBudget(2) },
  () => {
    const f = installerFixture();
    try {
      for (const stillDisabled of ['', '1']) {
        fs.writeFileSync(
          f.plugins,
          JSON.stringify([
            { id: 'arc-hooks@arc', scope: 'project', enabled: true },
            { id: 'arc-hooks@arc', scope: 'user', enabled: false },
          ]),
        );
        const r = f.run(['code'], { ARC_TEST_STILL_DISABLED: stillDisabled });
        assert.equal(r.status, stillDisabled ? 1 : 0, r.stderr);
        assert.match(r.commands, /plugin enable arc-hooks@arc --scope user/);
      }
    } finally {
      f.cleanup();
    }
  },
);

test(
  'local installation accepts its canonical directory in flat and nested Claude marketplace metadata',
  { timeout: runBudget(4) },
  () => {
    const f = installerFixture();
    try {
      const entries = [
        { name: 'arc', source: 'directory', path: f.source },
        {
          name: 'arc',
          source: {
            source: 'directory',
            path:
              process.platform === 'win32'
                ? f.source
                    .replaceAll(String.fromCharCode(92), '/')
                    .replace(/^([a-z]):/i, (_, drive) => '/' + drive.toLowerCase())
                : bashPath(f.source),
          },
        },
        { name: 'arc', source: 'directory', path: f.source + path.sep + '.' },
      ];
      if (process.platform === 'win32')
        entries.push({ name: 'arc', source: { source: 'directory', path: f.source.toUpperCase() } });
      for (const entry of entries) {
        fs.writeFileSync(f.marketplaces, JSON.stringify([entry]));
        const r = f.run();
        assert.equal(r.status, 0, r.stderr);
        assert.doesNotMatch(r.commands, /marketplace (?:add|remove)|curl/);
        assert.match(r.commands, /plugin marketplace update arc/);
        assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplaces)), [entry]);
      }
    } finally {
      f.cleanup();
    }
  },
);

test('local hook ownership failures preserve successful editor installation', { timeout: runBudget(3) }, () => {
  const f = installerFixture();
  try {
    for (const entry of [
      { name: 'arc', source: 'directory', path: f.dir },
      { name: 'arc', source: { source: 'directory', path: f.dir } },
      { name: 'arc', source: 'url', url: catalogUrl },
    ]) {
      fs.writeFileSync(f.marketplaces, JSON.stringify([entry]));
      const r = f.run();
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /marketplace belongs to another source/);
      assert.ok(
        r.stderr.includes(`Expected local directory: ${f.source.replaceAll(String.fromCharCode(92), '/')}`),
        r.stderr,
      );
      const source = typeof entry.source === 'object' ? entry.source : entry;
      assert.ok(r.stderr.includes(source.path ?? source.url), r.stderr);
      assert.doesNotMatch(r.commands, /plugin (?:marketplace (?:add|update|remove)|install|update|enable)/);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplaces)), [entry]);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
    }
  } finally {
    f.cleanup();
  }
});

test.each([
  { name: 'malformed JSON', state: 'invalid json' },
  { name: 'an object instead of a list', state: '{}' },
  { name: 'an empty list', state: '[]' },
  { name: 'project scope only', state: '[{"id":"arc-hooks@arc","scope":"project","enabled":true}]' },
  { name: 'a string enabled flag', state: '[{"id":"arc-hooks@arc","scope":"user","enabled":"true"}]' },
  {
    name: 'a hook loading error',
    state: '[{"id":"arc-hooks@arc","scope":"user","enabled":true,"errors":["Failed to load hooks/hooks.json"]}]',
  },
])('invalid plugin state $name reports partial installation and preserves legacy hooks', ({ state }) => {
  const f = installerFixture();
  try {
    const r = f.run(['code'], { ARC_TEST_PLUGIN_LIST: state });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /extension is installed, but Claude snapshot plugin setup failed/);
    assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
    assert.equal(fs.readFileSync(path.join(f.dir, 'codex home', 'hooks.json'), 'utf8'), f.legacy);
    assert.doesNotMatch(r.stdout, /==> Installed Arc\./);
    assert.doesNotMatch(r.commands, /plugin enable/);
  } finally {
    f.cleanup();
  }
});

test.each([[[]], [['--remote']]])(
  '--no-hooks preserves plugin and both legacy settings without requiring Claude (%j)',
  (mode) => {
    const f = installerFixture();
    try {
      fs.unlinkSync(path.join(f.bin, 'claude'));
      const r = f.run(['--no-hooks', ...mode, 'code']);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.commands, /claude/);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
      assert.equal(fs.readFileSync(path.join(f.dir, 'codex home', 'hooks.json'), 'utf8'), f.legacy);
      assert.equal(fs.readFileSync(f.plugins, 'utf8'), '[]');
    } finally {
      f.cleanup();
    }
  },
);

for (const failure of [
  'missing',
  'plugin marketplace list --json',
  `plugin marketplace add ${catalogUrl}`,
  'plugin install arc-hooks@arc --scope user',
  'plugin update arc-hooks@arc --scope user',
  'plugin list --json',
  'plugin enable arc-hooks@arc --scope user',
])
  test(`hook failures preserve successful editor installation: ${failure}`, () => {
    const f = installerFixture();
    try {
      if (failure === 'missing') fs.unlinkSync(path.join(f.bin, 'claude'));
      if (failure.startsWith('plugin enable'))
        fs.writeFileSync(f.plugins, '[{"id":"arc-hooks@arc","scope":"user","enabled":false}]');
      const r = f.run(['--marketplace-url', catalogUrl, 'code'], { ARC_TEST_FAIL_COMMAND: failure });
      assert.equal(r.status, 1, r.stderr);
      assert.doesNotMatch(r.stdout, /==> Installed Arc\./);
      assert.match(r.commands, /editor code --install-extension/);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
    } finally {
      f.cleanup();
    }
  });

const hostedOverride = 'https://staging.example.com/arc.json';

test.each(['flat directory', 'nested directory', 'github', 'default catalog'])(
  'hosted catalog override never replaces another marketplace source: %s',
  (kind) => {
    const f = installerFixture();
    try {
      const override = hostedOverride;
      const entry = {
        'flat directory': { name: 'arc', source: 'directory', path: f.source },
        'nested directory': { name: 'arc', source: { source: 'directory', path: f.source } },
        github: { name: 'arc', source: 'github', repo: 'glin/agent-diff-review' },
        'default catalog': { name: 'arc', source: 'url', url: catalogUrl },
      }[kind];
      fs.writeFileSync(f.marketplaces, JSON.stringify([entry]));
      const r = f.run(['--marketplace-url', override, 'code']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /marketplace belongs to another source/);
      const source = typeof entry.source === 'object' ? entry.source : entry;
      assert.ok(r.stderr.includes(source.path ?? source.repo ?? source.url), r.stderr);
      assert.ok(r.stderr.includes(`Expected HTTPS catalog: ${override}`), r.stderr);
      assert.match(r.stderr, /--no-hooks.*preserve the existing Claude setup/);
      assert.match(r.commands, /editor code --install-extension/);
      assert.doesNotMatch(r.commands, /plugin (?:marketplace (?:add|update|remove)|install|update|enable)/);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplaces)), [entry]);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'hosted catalog override reuses its own marketplace and keeps a directory source without hooks',
  { timeout: runBudget(3) },
  () => {
    const f = installerFixture();
    try {
      const override = hostedOverride;
      fs.writeFileSync(f.marketplaces, JSON.stringify([{ name: 'arc', source: { source: 'url', url: override } }]));
      const r = f.run(['--marketplace-url', override, 'code']);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.commands, /marketplace add/);
      fs.writeFileSync(f.marketplaces, '[]');
      const missing = f.run(['--marketplace-url', override, 'code']);
      assert.equal(missing.status, 0, missing.stderr);
      assert.ok(missing.commands.includes(`plugin marketplace add ${override}`), missing.commands);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplaces)), [{ name: 'arc', source: 'url', url: override }]);
      fs.writeFileSync(f.marketplaces, JSON.stringify([{ name: 'arc', source: 'directory', path: f.source }]));
      const extensionOnly = f.run(['--no-hooks', 'code']);
      assert.equal(extensionOnly.status, 0, extensionOnly.stderr);
      assert.match(extensionOnly.commands, /editor code --install-extension/);
      assert.doesNotMatch(extensionOnly.commands, /claude/);
      assert.equal(
        fs.readFileSync(f.marketplaces, 'utf8'),
        JSON.stringify([{ name: 'arc', source: 'directory', path: f.source }]),
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  'explicit editors retain success and report each failed target without choosing extra editors',
  { timeout: runBudget(4) },
  () => {
    const f = installerFixture();
    try {
      const sole = f.run(['code']);
      assert.equal(sole.status, 0, sole.stderr);
      assert.doesNotMatch(sole.commands, /editor cursor/);
      const fullPath = f.run([bashPath(f.bin) + '/code']);
      assert.equal(fullPath.status, 0, fullPath.stderr);
      const partial = f.run(['code', 'cursor'], { ARC_TEST_FAIL_EDITOR: 'cursor' });
      assert.equal(partial.status, 1, partial.stderr);
      assert.match(partial.commands, /editor code --install-extension/);
      assert.match(partial.commands, /editor cursor --install-extension/);
      assert.match(partial.stderr, /installation failed in cursor/);
      const receipt = JSON.parse(partial.stdout.trim().split('\n').at(-1));
      assert.deepEqual(receipt.editors, [
        { editor: 'code', status: 'completed' },
        { editor: 'cursor', status: 'failed' },
      ]);
      assert.equal(receipt.components.editors, 'partial');
      const failed = f.run(['code'], { ARC_TEST_FAIL_EDITOR: 'code' });
      assert.equal(failed.status, 1);
      assert.match(failed.commands, /claude plugin marketplace list --json/);
      assert.doesNotMatch(failed.commands, /plugin (?:marketplace (?:add|update|remove)|install|update|enable|list)/);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'stdin installation selects local source without Git and children cannot consume script input',
  { timeout: runBudget(5) },
  () => {
    const f = installerFixture();
    try {
      assert.equal(fs.existsSync(path.join(f.source, '.git')), false);
      assert.equal(bash('PATH="$1"; command -v git', bashPath(f.hostBin)), bashPath(f.hostBin) + '/git');
      const standalone = path.join(f.dir, 'standalone.sh');
      fs.copyFileSync(path.join(f.source, 'install.sh'), standalone);
      const current = f.run(['code'], {}, { cwd: f.source, scriptFile: bashPath(f.dir) + '/standalone.sh' });
      assert.equal(current.status, 0, current.stderr);
      assert.doesNotMatch(current.commands, /curl/);
      assert.match(current.stdout, /Local plugin source:/);
      const r = f.run(['--local', 'code'], {}, { stdin: true, cwd: f.source });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.commands, /curl/);
      assert.match(r.stdout, /==> Installed Arc\./);
      assert.match(r.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
      const missing = f.run(['--local', 'code'], {}, { stdin: true });
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /--local requires/);
      fs.writeFileSync(f.marketplaces, '[]');
      fs.writeFileSync(f.plugins, '[]');
      const detected = f.run([], {}, { stdin: true });
      assert.equal(detected.status, 0, detected.stderr);
      assert.match(detected.stderr, /1\) All detected editors \(code, cursor\)/);
      assert.match(detected.commands, /editor code --install-extension/);
      assert.match(detected.commands, /editor cursor --install-extension/);
      assert.match(detected.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
      fs.writeFileSync(f.marketplaces, '[]');
      fs.writeFileSync(f.plugins, '[]');
      fs.unlinkSync(path.join(f.bin, 'cursor'));
      const sole = f.run(['--local'], {}, { stdin: true, cwd: f.source });
      assert.equal(sole.status, 0, sole.stderr);
      assert.match(sole.commands, /editor code/);
    } finally {
      f.cleanup();
    }
  },
);

describe('the current editor receives the extension while other detected editors remain unselected', () => {
  let f;
  let editor;
  beforeAll(() => {
    f = installerFixture();
    editor = f.editor('positron', 'windows');
  });
  afterAll(() => f.cleanup());
  for (const [product, layout, cliName] of [
    ['code', 'linux'],
    ['code-insiders', 'windows'],
    ['cursor', 'linux'],
    ['positron', 'macos', 'code'],
    ['codium', 'macos'],
  ])
    test(`${product} on ${layout}`, () => {
      const editor = f.editor(product, layout, cliName);
      const r = f.run(['--local', '--no-hooks'], editor.env, { cwd: f.source });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
        [product],
      );
      const launcher = bashPath(path.dirname(editor.launcher)) + '/' + path.basename(editor.launcher);
      const installed = r.stdout.match(/^==> Installing extension into: (.+)$/m)[1];
      assert.equal(bash('test "$1" -ef "$2" && echo same', installed, launcher), 'same');
      assert.match(r.stdout, /==> Current editor:/);
      assert.doesNotMatch(r.stderr, /Choose editors/);
    });
  for (const pathFormat of process.platform === 'win32' ? ['drive'] : [])
    test(`Windows ${pathFormat} paths`, () => {
      assert.match(editor.env.VSCODE_GIT_ASKPASS_MAIN, /\\/);
      assert.match(editor.env.VSCODE_GIT_ASKPASS_NODE, /\\/);
      const drivePaths = {
        ...editor.env,
        VSCODE_GIT_ASKPASS_MAIN: bashPath(path.dirname(editor.env.VSCODE_GIT_ASKPASS_MAIN)) + '/askpass-main.js',
        VSCODE_GIT_ASKPASS_NODE: bashPath(path.dirname(editor.executable)) + '/positron.exe',
      };
      const drive = f.run(['--local', '--no-hooks'], drivePaths, { cwd: f.source });
      assert.equal(drive.status, 0, drive.stderr);
      assert.deepEqual(
        [...drive.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
        ['positron'],
      );
    });
  test('remote stdin installation', () => {
    const piped = f.run(['--no-hooks'], editor.env, { stdin: true });
    assert.equal(piped.status, 0, piped.stderr);
    assert.match(piped.commands, /curl.*codeload/);
    assert.deepEqual(
      [...piped.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
      ['positron'],
    );
    assert.match(piped.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
  });
  test('explicit editors override the current editor', () => {
    const explicit = f.run(['--local', '--no-hooks', 'code', 'cursor'], editor.env, { cwd: f.source });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(
      [...explicit.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
      ['code', 'cursor'],
    );
    assert.doesNotMatch(explicit.stdout, /Current editor/);
  });
});

for (const target of ['user', 'system'])
  for (const version of ['', '0123456789'])
    test(`the current editor uses copied askpass scripts for Windows ${target} setups ${version || 'flat'}`, () => {
      const f = installerFixture();
      try {
        const editor = f.editor('code-insiders', 'windows', 'code-insiders', { copied: true, target, version });
        const r = f.run(['--local', '--no-hooks'], editor.env, { stdin: true, cwd: f.source, terminalInput: '\n' });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(
          [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
          ['code-insiders'],
        );
        assert.match(r.stdout, /==> Current editor:/);
        assert.doesNotMatch(r.stderr, /Choose editors/);
      } finally {
        f.cleanup();
      }
    });

test('the current editor uses the outer Windows launcher with versioned resources', { timeout: runBudget(2) }, () => {
  const f = installerFixture();
  try {
    const editor = f.editor('positron', 'windows', 'positron', { version: 'abcdef0123' });
    const r = f.run(['--local', '--no-hooks'], editor.env, { stdin: true, cwd: f.source, terminalInput: '\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
      ['positron'],
    );
    assert.match(r.stdout, /==> Current editor:/);
    const other = f.editor('code', 'windows');
    const conflict = f.run(
      ['--local', '--no-hooks'],
      { ...editor.env, VSCODE_GIT_ASKPASS_NODE: other.executable },
      {
        stdin: true,
        cwd: f.source,
        terminalInput: '\n',
      },
    );
    assert.equal(conflict.status, 0, conflict.stderr);
    assert.deepEqual(
      [...conflict.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
      ['code', 'cursor'],
    );
    assert.doesNotMatch(conflict.stdout, /Current editor/);
  } finally {
    f.cleanup();
  }
});

test.each(['its executable', 'no executable'])(
  'the current editor accepts a flat installation named with ten hexadecimal digits and %s',
  (hint) => {
    const f = installerFixture();
    try {
      const editor = f.editor('code-insiders', 'windows', 'code-insiders', { installationName: '123456abcd' });
      const node = hint === 'its executable' ? editor.executable : '';
      const r = f.run(
        ['--local', '--no-hooks'],
        { ...editor.env, VSCODE_GIT_ASKPASS_NODE: node },
        {
          stdin: true,
          cwd: f.source,
          terminalInput: '\n',
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
        ['code-insiders'],
      );
      assert.match(r.stdout, /==> Current editor:/);
    } finally {
      f.cleanup();
    }
  },
);

test(
  'the current editor accepts matching metadata versions and rejects ambiguous copied identities',
  { timeout: runBudget(4) },
  () => {
    const f = installerFixture();
    try {
      const editor = f.editor('code-insiders', 'windows', 'code-insiders', { copied: true, target: 'user' });
      const second = path.join(editor.root, '0123456789', 'resources', 'app', 'product.json');
      fs.mkdirSync(path.dirname(second), { recursive: true });
      fs.copyFileSync(editor.metadata, second);
      fs.writeFileSync(
        path.join(editor.root, 'bin', 'cursor'),
        '#!/bin/bash\necho "editor cursor $*" >> "$ARC_TEST_LOG"\n',
        {
          mode: 0o755,
        },
      );
      const accepted = f.run(['--local', '--no-hooks'], editor.env, {
        stdin: true,
        cwd: f.source,
        terminalInput: '\n',
      });
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.deepEqual(
        [...accepted.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
        ['code-insiders'],
      );
      for (const [product, env] of [
        [{ applicationName: 'cursor', target: 'user' }, editor.env],
        [{ applicationName: 'code-insiders' }, editor.env],
        [
          { applicationName: 'code-insiders', target: 'user' },
          { ...editor.env, VSCODE_GIT_ASKPASS_NODE: '' },
        ],
      ]) {
        fs.writeFileSync(second, JSON.stringify(product));
        const r = f.run(['--local', '--no-hooks'], env, { stdin: true, cwd: f.source, terminalInput: '\n' });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(
          [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
          ['code', 'cursor'],
        );
        assert.doesNotMatch(r.stdout, /Current editor/);
      }
    } finally {
      f.cleanup();
    }
  },
);

describe('unverified current editor hints retain the all-editor menu and default', () => {
  let f;
  let hints;
  beforeAll(() => {
    f = installerFixture();
    const editor = f.editor('cursor', 'windows');
    const other = f.editor('code', 'linux');
    const unknown = f.editor('unlisted', 'linux');
    const missingMetadata = f.editor('positron', 'windows');
    fs.unlinkSync(missingMetadata.metadata);
    const missingLauncher = f.editor('codium', 'linux');
    fs.unlinkSync(missingLauncher.launcher);
    const malformed = f.editor('code-insiders', 'linux');
    fs.writeFileSync(malformed.metadata, '{');
    hints = [
      { TERM_PROGRAM: 'vscode' },
      { ...editor.env, TERM_PROGRAM: 'other' },
      { ...editor.env, VSCODE_GIT_ASKPASS_MAIN: path.join(f.dir, 'missing.js') },
      { ...editor.env, VSCODE_GIT_ASKPASS_NODE: other.executable },
      { ...editor.env, VSCODE_GIT_ASKPASS_NODE: path.join(f.dir, 'missing.exe') },
      unknown.env,
      missingMetadata.env,
      missingLauncher.env,
      malformed.env,
    ];
  });
  afterAll(() => f.cleanup());
  for (const [index, hint] of [
    'terminal program alone',
    'another terminal program',
    'missing askpass script',
    'executable from another editor',
    'missing executable',
    'unsupported product',
    'missing product metadata',
    'missing launcher',
    'malformed product metadata',
  ].entries())
    test(`all editors for ${hint}`, () => {
      const env = hints[index];
      const r = f.run(['--local', '--no-hooks'], env, { stdin: true, cwd: f.source, terminalInput: '\n' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /1\) All detected editors \(code, cursor\)/);
      assert.deepEqual(
        [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
        ['code', 'cursor'],
      );
      assert.doesNotMatch(r.stdout, /Current editor/);
    });
});

test.each([
  ['\n', ['code', 'cursor']],
  ['1\n', ['code', 'cursor']],
  ['2\n', ['code']],
  ['3\n', ['cursor']],
])('the editor menu choice %j installs %j', (terminalInput, expected) => {
  const f = installerFixture();
  try {
    const r = f.run(['--local', '--no-hooks'], {}, { stdin: true, cwd: f.source, terminalInput });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /1\) All detected editors \(code, cursor\)\s+2\) code\s+3\) cursor/);
    assert.deepEqual(
      [...r.commands.matchAll(/editor (\w+) --install-extension/g)].map((match) => match[1]),
      expected,
    );
    assert.match(r.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
    assert.doesNotMatch(r.stdout, /Current editor/);
  } finally {
    f.cleanup();
  }
});

test.each(['0\n', '4\n', 'invalid\n', '999999999\n'])(
  'the editor menu refuses choice %j before installation',
  (terminalInput) => {
    const f = installerFixture();
    try {
      const r = f.run(['--local'], {}, { stdin: true, cwd: f.source, terminalInput });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /select a listed editor number/);
      assert.doesNotMatch(r.commands, /npm|editor|claude plugin/);
    } finally {
      f.cleanup();
    }
  },
);

function exerciseManagedHooks(f) {
  const work = path.join(f.dir, 'edited files');
  const home = path.join(f.dir, 'custom arc home');
  fs.mkdirSync(work);
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'before edit\n');
  const config = JSON.parse(fs.readFileSync(path.join(f.managed, 'hooks', 'hooks.json'))).hooks;
  const run = (event, payload) => {
    const hook = config[event][0].hooks[0];
    const r = spawnSync(process.execPath, [hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}', f.managed)], {
      cwd: work,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ARC_HOME: home, ARC_IGNORE_ROOTS: '' },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  run('PreToolUse', { session_id: 'managed-copy', cwd: work, tool_input: { file_path: file } });
  fs.writeFileSync(file, 'after edit\n');
  run('Stop', { session_id: 'managed-copy', cwd: work });
  const snapshot = path.join(home, 'snapshots', 'managed-copy');
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json')));
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, file);
  assert.equal(fs.readFileSync(manifest.files[0].snapshot, 'utf8'), 'before edit\n');
}

for (const mode of ['local', 'remote'])
  test(`${mode} installer fixture hooks survive source deletion in a separate archive-managed copy`, () => {
    const f = installerFixture();
    try {
      const r = f.run(
        mode === 'remote'
          ? ['--remote', '--repo', 'fixture/arc', '--ref', 'feature/test', '--marketplace-url', catalogUrl, 'code']
          : ['--local', '--marketplace-url', catalogUrl, 'code'],
        {},
        { stdin: true, cwd: f.source },
      );
      assert.equal(r.status, 0, r.stderr);
      if (mode === 'remote') {
        assert.match(r.commands, /npm ci/);
        assert.doesNotMatch(r.commands, /npm install/);
        assert.match(r.commands, /api.github.com\/repos\/fixture\/arc\/commits\/feature%2Ftest/);
        assert.match(r.commands, /codeload.github.com\/fixture\/arc\/tar.gz\/a{40}/);
        assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
        assert.doesNotMatch(r.commands, /legacy-migration/);
        assert.equal((r.commands.match(/--connect-timeout 15 --max-time 900/g) ?? []).length, 2);
      }
      assert.deepEqual(fs.readdirSync(f.temporary), []);
      assert.equal(fs.existsSync(path.join(f.managed, '.claude-plugin', 'plugin.json')), true);
      const [marketplace] = JSON.parse(fs.readFileSync(f.marketplaces));
      assert.deepEqual(marketplace, { name: 'arc', source: 'url', url: catalogUrl });
      assert.match(
        r.stdout,
        /Plugin archive: https:\/\/github.com\/glin\/arc\/releases\/download\/v0.1.0\/arc-hooks-0.1.0.zip/,
      );
      assert.match(r.stdout, /Plugin archive digest: [a-f0-9]{64}/);
      assert.doesNotMatch(r.stdout, /Plugin directory/);
      fs.rmSync(f.source, { recursive: true });
      exerciseManagedHooks(f);
    } finally {
      f.cleanup();
    }
  });

test('source-main hooks survive downloaded source cleanup without GitHub Releases', { timeout: runBudget(2) }, () => {
  const f = installerFixture();
  try {
    for (const args of [['code'], ['--remote', 'code']]) {
      const r = f.run(
        args,
        { ARC_TEST_NO_RELEASES: '1' },
        { stdin: true, cwd: args.includes('--remote') ? f.source : f.dir },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.commands, /api.github.com\/repos\/glin\/arc\/commits\/main/);
      assert.match(r.commands, /codeload.github.com\/glin\/arc\/tar.gz\/a{40}/);
      assert.match(r.commands, /source-snapshot-setup/);
      assert.doesNotMatch(r.commands, /releases\/|legacy-migration/);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
    }
    const [marketplace] = JSON.parse(fs.readFileSync(f.marketplaces));
    assert.equal(marketplace.source, 'directory');
    assert.equal(
      path
        .relative(fs.realpathSync(path.join(f.dir, 'arc home')), fs.realpathSync(marketplace.path))
        .split(path.sep)[0],
      'tools',
    );
    const [plugin] = JSON.parse(fs.readFileSync(f.plugins));
    assert.match(plugin.readFromFolder, /releases[\\/][a-f0-9]{64}[\\/]plugin$/);
    fs.rmSync(f.source, { recursive: true });
    exerciseManagedHooks({ ...f, managed: plugin.readFromFolder });
  } finally {
    f.cleanup();
  }
});

for (const conflict of ['disabled settings', 'project', 'local'])
  test(`source-main hooks preserve caller ${conflict} without plugin mutation`, () => {
    const f = installerFixture();
    try {
      const caller = path.join(f.dir, 'caller project');
      const settings = path.join(caller, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(
        settings,
        JSON.stringify({ enabledPlugins: { 'arc-hooks@arc': conflict !== 'disabled settings' } }),
      );
      if (conflict !== 'disabled settings')
        fs.writeFileSync(
          f.plugins,
          JSON.stringify([
            {
              id: 'arc-hooks@arc',
              scope: conflict,
              projectPath: caller,
              enabled: true,
              version: '0.1.0',
              readFromFolder: path.join(f.source, 'plugins', 'arc-hooks'),
            },
          ]),
        );
      const preserved = [settings, f.settings, f.plugins, f.marketplaces].map((file) => fs.readFileSync(file));
      const r = f.run(['code'], { ARC_TEST_NO_RELEASES: '1' }, { stdin: true, cwd: caller });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.commands, /editor code --install-extension[\s\S]*source-snapshot-setup/);
      assert.match(r.stderr, /Arc extension is installed, but Claude snapshot plugin setup failed/);
      assert.match(
        r.stderr,
        conflict === 'disabled settings' ? /snapshot plugin is disabled/ : /belongs to another installation or scope/,
      );
      assert.doesNotMatch(r.commands, /plugin (?:marketplace (?:add|update|remove)|install|update|enable)/);
      for (const [index, file] of [settings, f.settings, f.plugins, f.marketplaces].entries())
        assert.deepEqual(fs.readFileSync(file), preserved[index]);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
    } finally {
      f.cleanup();
    }
  });

test(
  'remote stdin installation from an unrelated directory cleans failures and interruptions',
  { timeout: runBudget(8) },
  () => {
    const f = installerFixture();
    try {
      const success = f.run(['code'], {}, { stdin: true });
      assert.equal(success.status, 0, success.stderr);
      assert.match(success.commands, /api.github.com\/repos\/glin\/arc\/commits\/main/);
      assert.match(success.commands, /codeload.github.com\/glin\/arc\/tar.gz/);
      for (const env of [
        { ARC_TEST_HTTP_FAILURE: 'api.github' },
        { ARC_TEST_HTTP_FAILURE: 'codeload' },
        { ARC_TEST_BAD_ARCHIVE: '1' },
        { ARC_TEST_BAD_REVISION: '1' },
        { ARC_TEST_INTERRUPT: '1' },
        { ARC_TEST_NPM_FAILURE: '1' },
        { ARC_TEST_PACKAGE_FAILURE: '1' },
      ]) {
        const r = f.run(['code'], env, { stdin: true });
        assert.equal(
          r.status,
          env.ARC_TEST_INTERRUPT
            ? 143
            : env.ARC_TEST_HTTP_FAILURE || env.ARC_TEST_BAD_ARCHIVE || env.ARC_TEST_BAD_REVISION
              ? 2
              : 1,
          r.stdout + r.stderr,
        );
        assert.deepEqual(fs.readdirSync(f.temporary), []);
        assert.doesNotMatch(r.commands, /editor/);
      }
    } finally {
      f.cleanup();
    }
  },
);

test.each([
  [['--unknown']],
  [['--local', '--remote']],
  [['--ref']],
  [['--repo', 'bad']],
  [['--marketplace-url', 'http://example.com/arc.json']],
  [['missing-editor']],
])('source installer rejects invalid options %j before installation', (args) => {
  const f = installerFixture();
  try {
    const r = f.run(args);
    assert.equal(r.status, 2, r.stderr);
    assert.doesNotMatch(r.stdout, /^\{/m);
    assert.doesNotMatch(r.commands, /npm|editor|claude plugin|curl/);
  } finally {
    f.cleanup();
  }
});

test('source installer rejects missing tools and old Claude before installation', { timeout: runBudget(4) }, () => {
  const f = installerFixture();
  try {
    const old = f.run(['--marketplace-url', catalogUrl, 'code'], { ARC_TEST_CLAUDE_VERSION: '2.1.223' });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /require Claude Code 2.1.224/);
    const oldRemote = f.run(['--remote', 'code'], { ARC_TEST_CLAUDE_VERSION: '2.1.223' });
    assert.equal(oldRemote.status, 1);
    assert.match(oldRemote.stderr, /needs Claude Code 2.1.268/);
    assert.match(oldRemote.commands, /curl[\s\S]*npm[\s\S]*editor/);
    const local = f.run(['code'], { ARC_TEST_CLAUDE_VERSION: '2.1.223' });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(bash('PATH="$1"; command -v npm', bashPath(f.hostBin)), bashPath(f.hostBin) + '/npm');
    const npm = path.join(f.bin, 'npm');
    fs.unlinkSync(npm);
    const missing = f.run(['code']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /npm is required/);
  } finally {
    f.cleanup();
  }
});

test.each(['--help', '-h'])('source installer %s omits installation receipts and executable work', (option) => {
  const f = installerFixture();
  try {
    const node = path.join(f.bin, 'node');
    fs.writeFileSync(
      node,
      fs
        .readFileSync(node, 'utf8')
        .replace('exec "$ARC_TEST_REAL_NODE"', 'echo node >> "$ARC_TEST_LOG"\nexec "$ARC_TEST_REAL_NODE"'),
    );
    const result = f.run([option]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /^\{/m);
    assert.equal(result.commands, '');
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  } finally {
    f.cleanup();
  }
});

test('missing Node admission omits installation receipts and never attempts the missing executable', () => {
  const f = installerFixture();
  try {
    fs.unlinkSync(path.join(f.bin, 'node'));
    const script = path.join(f.source, 'install.sh');
    fs.writeFileSync(
      script,
      'command_not_found_handle() { echo "missing-command $1" >> "$ARC_TEST_LOG"; return 127; }\n' +
        fs.readFileSync(script, 'utf8'),
    );
    const result = f.run(['--no-hooks', 'code']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /node is required/);
    assert.equal(result.commands, '');
    assert.doesNotMatch(result.stdout, /^\{/m);
    assert.deepEqual(fs.readdirSync(f.temporary), []);
  } finally {
    f.cleanup();
  }
});

function bash(script, ...args) {
  const result = spawnSync(bashExecutable, ['-c', script, 'bash', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function resolve(cli) {
  return bash('source "$1"; resolve_editor_cli "$2"', resolver, cli);
}

// The resolver prints the paths bash gives it, which on Windows are not the paths Node
// builds. Ask bash for its own name for the fixture, and compare within one path form.
function bashPath(dir) {
  return bash('cd "$1" && pwd -P', dir);
}

test('a Positron desktop command uses the bundled extension CLI', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-positron-'));
  try {
    const app = path.join(temp, 'app');
    fs.mkdirSync(path.join(app, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(app, 'positron'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'bin', 'positron'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // The PATH entry is a link into the install directory. A junction is the one kind of
    // link Windows makes without Developer Mode, and Node writes a plain directory
    // symlink for it everywhere else.
    fs.symlinkSync(app, path.join(temp, 'link'), 'junction');

    const root = bashPath(temp);
    const launcher = `${root}/app/bin/positron`;

    assert.equal(resolve(`${root}/link/positron`), launcher);
    assert.equal(resolve(launcher), launcher);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the installer resolves each editor CLI before it uses one', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  assert.match(installer, /source "\$REPO\/scripts\/editor-cli\.sh"/);
  assert.match(installer, /CLIS\[\$i\]="\$\(resolve_editor_cli "\$\{CLIS\[\$i\]\}"\)"/);
  assert.match(installer, /install_editor_extension "\$cli" "\$VSIX"/);
  // Positron on macOS ships its extension CLI as bin/code, with no bin/positron beside it.
  assert.match(installer, /^positron\|\/Applications\/Positron\.app\/Contents\/Resources\/app\/bin\/code$/m);
});

for (const product of ['Code', 'Positron']) {
  test(`an editor compatibility failure keeps the ${product} error`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-install-'));
    try {
      const editor = path.join(temp, process.platform === 'win32' ? 'positron.exe' : 'positron');
      fs.writeFileSync(
        editor,
        '#!/bin/sh\n' +
          "printf '%s\\n' '[0907/145233.489:ERROR:third_party\\crashpad\\crashpad\\util\\win\\registration_protocol_win.cc:108] CreateFile: The system cannot find the file specified. (0x2)' >&2\n" +
          "printf '%s\\n' '(node:85732) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.' >&2\n" +
          `printf '%s\\n' '(Use \`${product} --trace-deprecation ...\` to show where the warning was created)' >&2\n` +
          'echo "not compatible with VS Code 1.111.0" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        bashExecutable,
        ['-c', 'source "$1"; install_editor_extension "$2" package.vsix', 'bash', resolver, editor],
        { encoding: 'utf8' },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /not compatible with VS Code 1\.111\.0/);
      assert.match(result.stderr, /installation failed in/);
      assert.doesNotMatch(result.stderr, /registration_protocol_win\.cc:108/);
      assert.doesNotMatch(result.stderr, /DEP0169|trace-deprecation/);
      assert.doesNotMatch(result.stderr, /did not accept --install-extension|not a VS Code-based CLI/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

test('a traced DEP0169 warning keeps its stack', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-deprecation-'));
  try {
    const editor = path.join(temp, process.platform === 'win32' ? 'code.exe' : 'code');
    fs.writeFileSync(
      editor,
      '#!/bin/sh\n' +
        "printf '%s\\n' '(node:85732) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.' >&2\n" +
        'echo "    at urlParse (node:url:123:4)" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      bashExecutable,
      ['-c', 'source "$1"; install_editor_extension "$2" package.vsix', 'bash', resolver, editor],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[DEP0169\] DeprecationWarning: `url\.parse\(\)`/);
    assert.match(result.stderr, /at urlParse \(node:url:123:4\)/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('sourcing the installer from zsh reports the supported invocation', { skip: process.platform === 'win32' }, () => {
  const installer = path.join(__dirname, '..', 'install.sh');
  const result = spawnSync('zsh', ['-c', 'source "$1"', 'zsh', installer], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /install\.sh requires Bash; run: bash install\.sh/);
  assert.doesNotMatch(result.stderr, /bad substitution/);
});

test('the installer refuses unsupported packaging Node versions before npm', { timeout: runBudget(8) }, () => {
  const f = installerFixture();
  try {
    fs.writeFileSync(
      path.join(f.bin, 'node'),
      `#!/bin/bash
if [ "$1" = --version ]; then echo "v$ARC_TEST_NODE_VERSION"; exit 0; fi
if [ "$1" = -e ]; then exec "$ARC_TEST_REAL_NODE" -e 'Object.defineProperty(process.versions,"node",{value:process.env.ARC_TEST_NODE_VERSION}); const script=process.argv[1]; process.argv.splice(1,1); eval(script)' "$2" "\${@:3}"; fi
exec "$ARC_TEST_REAL_NODE" "$@"
`,
      { mode: 0o755 },
    );
    for (const [version, supported] of [
      ['18.18.0', false],
      ['20.18.1', false],
      ['20.19.0', false],
      ['21.0.0', false],
      ['22.0.0', false],
      ['22.11.0', false],
      ['22.12.0', true],
      ['23.0.0', true],
    ]) {
      const r = f.run(['--no-hooks', 'code'], { ARC_TEST_NODE_VERSION: version, ARC_TEST_NPM_FAILURE: '99' });
      assert.equal(r.status, supported ? 99 : 2, r.stderr);
      if (supported) assert.match(r.commands, /npm install/);
      else {
        assert.match(r.stderr, /installation needs Node.js 22\.12\+/);
        assert.doesNotMatch(r.commands, /npm/);
      }
    }
  } finally {
    f.cleanup();
  }
});
