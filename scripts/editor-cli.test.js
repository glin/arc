const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const resolver = path.join(__dirname, 'editor-cli.sh');
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

const catalogUrl = 'https://github.com/glin/arc/releases/latest/download/arc-marketplace.json';

function installerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-source-install-'));
  const source = path.join(dir, 'source with spaces');
  const bin = path.join(dir, 'bin');
  const hostBin = path.join(dir, 'host-bin');
  const temporary = path.join(dir, 'temporary');
  const unrelated = path.join(dir, 'unrelated');
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
  const absoluteBash = bashPath(path.dirname(bashExecutable)) + '/' + path.basename(bashExecutable);
  for (const [index, name] of utilities.entries()) {
    const command = `#!${absoluteBash}\nexec '${utilityPaths[index].replaceAll("'", "'\\''")}' "$@"\n`;
    fs.writeFileSync(path.join(hostBin, name), command, { mode: 0o755 });
    fs.copyFileSync(path.join(hostBin, name), path.join(bin, name));
  }
  for (const name of ['git', 'node', 'npm'])
    fs.writeFileSync(path.join(hostBin, name), `#!${absoluteBash}\nexit 97\n`, { mode: 0o755 });
  write(
    'node',
    'case "$1" in */register-hooks.js) echo legacy-migration >> "$ARC_TEST_LOG" ;; esac\nexec "$ARC_TEST_REAL_NODE" "$@"',
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
  const log = path.join(dir, 'commands.log');
  const plugins = path.join(dir, 'plugins.json');
  const marketplaces = path.join(dir, 'marketplaces.json');
  const managed = path.join(dir, 'claude home', 'managed-copy');
  const claudeFixture = path.join(dir, 'claude-fixture.cjs');
  const curlFixture = path.join(dir, 'curl-fixture.cjs');
  const artifact = path.join(dir, 'artifacts');
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
  const zip = path.join(artifact, 'arc-hooks-0.1.0.zip');
  const tar = path.join(dir, 'source.tar.gz');
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
if (command === '--version') { console.log(process.env.ARC_TEST_CLAUDE_VERSION || '2.1.224 (Claude Code)'); return; }
if (command === process.env.ARC_TEST_FAIL_COMMAND) { console.error('Claude failed'); process.exit(1); }
if (command === 'plugin marketplace list --json') process.stdout.write(fs.readFileSync(process.env.ARC_TEST_MARKETPLACES));
else if (command === 'plugin list --json') process.stdout.write(process.env.ARC_TEST_PLUGIN_LIST ?? fs.readFileSync(process.env.ARC_TEST_PLUGINS));
else if (command.startsWith('plugin marketplace add ')) {
  const location = process.argv[5];
  fs.writeFileSync(process.env.ARC_TEST_MARKETPLACES, JSON.stringify([{name:'arc',...(location.startsWith('https:') ? {source:'url',url:location} : {source:'directory',path:location})}]));
}
else if (command === 'plugin install arc-hooks@arc --scope user' || command === 'plugin enable arc-hooks@arc --scope user') {
  const plugins = JSON.parse(fs.readFileSync(process.env.ARC_TEST_PLUGINS));
  let plugin = plugins.find(p => p.id === 'arc-hooks@arc' && p.scope === 'user');
  if (command.startsWith('plugin install')) {
    const marketplace = JSON.parse(fs.readFileSync(process.env.ARC_TEST_MARKETPLACES)).find(entry=>entry.name==='arc');
    const source = typeof marketplace.source === 'object' ? marketplace.source : marketplace;
    if (source.source === 'directory') {
      const readFromFolder = path.join(source.path, 'plugins', 'arc-hooks');
      if (!plugin) plugins.push({id:'arc-hooks@arc',scope:'user',enabled:true,version:'0.1.0',errors:[],readFromFolder});
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
if (url.startsWith('https://api.github.com/')) fs.writeFileSync(output, JSON.stringify({sha:'a'.repeat(40)}));
else if (process.env.ARC_TEST_BAD_ARCHIVE) fs.writeFileSync(output,'invalid archive');
else fs.copyFileSync(process.env.ARC_TEST_SOURCE_ARCHIVE,output);
`,
  );
  const settings = path.join(dir, 'claude home', 'settings.json');
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
  const codex = path.join(dir, 'codex home');
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
    run(args = ['code'], env = {}, { stdin = false, cwd = unrelated, terminalInput, scriptFile } = {}) {
      fs.writeFileSync(log, '');
      let input;
      if (stdin) {
        input = fs.readFileSync(path.join(source, 'install.sh'), 'utf8');
        if (terminalInput !== undefined) {
          // A separate stream supplies terminal choices while children receive no script input.
          fs.writeFileSync(path.join(dir, 'terminal-input'), terminalInput);
          input = input.replaceAll('/dev/tty', `"${bashPath(dir)}/terminal-input"`);
        }
        input += '\nprintf "ARC_INSTALL_SCRIPT_TAIL\\n"\n';
      }
      const script = 'export PATH="$1"; shift; command -v git >/dev/null && exit 98; exec "$1" "${@:2}"';
      const command = [
        '-c',
        script,
        'bash',
        bashPath(bin),
        absoluteBash,
        ...(stdin ? ['-s', '--'] : [scriptFile ?? bashPath(source) + '/install.sh']),
        ...args,
      ];
      const result = spawnSync(bashExecutable, command, {
        cwd,
        input,
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          TERM_PROGRAM: '',
          VSCODE_GIT_ASKPASS_MAIN: '',
          VSCODE_GIT_ASKPASS_NODE: '',
          ARC_TEST_REAL_NODE: process.execPath,
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
          TMPDIR: bashPath(temporary),
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

test('local installation refreshes its directory marketplace and migrates owned legacy hooks after plugin success', () => {
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
    assert.equal(fs.realpathSync(plugin.readFromFolder), fs.realpathSync(path.join(f.source, 'plugins', 'arc-hooks')));
    exerciseManagedHooks({ ...f, managed: plugin.readFromFolder });
  } finally {
    f.cleanup();
  }
});

test('source installation enables only the disabled user plugin and rejects unsuccessful enablement', () => {
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
});

test('local installation accepts its canonical directory in flat and nested Claude marketplace metadata', () => {
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
});

test('local installation rejects unrelated directories and hosted marketplace ownership before building', () => {
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
      assert.doesNotMatch(
        r.commands,
        /npm|package|editor|plugin (?:marketplace (?:add|update|remove)|install|update|enable)/,
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplaces)), [entry]);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
    }
  } finally {
    f.cleanup();
  }
});

test('invalid plugin state reports partial installation and preserves legacy hooks', () => {
  const f = installerFixture();
  try {
    for (const state of [
      'invalid json',
      '{}',
      '[]',
      '[{"id":"arc-hooks@arc","scope":"project","enabled":true}]',
      '[{"id":"arc-hooks@arc","scope":"user","enabled":"true"}]',
      '[{"id":"arc-hooks@arc","scope":"user","enabled":true,"errors":["Failed to load hooks/hooks.json"]}]',
    ]) {
      const r = f.run(['code'], { ARC_TEST_PLUGIN_LIST: state });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /extension is installed, but Claude snapshot plugin setup failed/);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
      assert.equal(fs.readFileSync(path.join(f.dir, 'codex home', 'hooks.json'), 'utf8'), f.legacy);
      assert.doesNotMatch(r.stdout, /==> Installed Arc\./);
      assert.doesNotMatch(r.commands, /plugin enable/);
    }
  } finally {
    f.cleanup();
  }
});

test('--no-hooks preserves plugin and both legacy settings without requiring Claude', () => {
  const f = installerFixture();
  try {
    fs.unlinkSync(path.join(f.bin, 'claude'));
    const r = f.run(['--no-hooks', 'code']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.commands, /claude/);
    assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
    assert.equal(fs.readFileSync(path.join(f.dir, 'codex home', 'hooks.json'), 'utf8'), f.legacy);
    assert.equal(fs.readFileSync(f.plugins, 'utf8'), '[]');
  } finally {
    f.cleanup();
  }
});

test('prerequisite failures install nothing and hook failures preserve successful editor installation', () => {
  for (const failure of [
    'missing',
    'plugin marketplace list --json',
    `plugin marketplace add ${catalogUrl}`,
    'plugin install arc-hooks@arc --scope user',
    'plugin update arc-hooks@arc --scope user',
    'plugin list --json',
    'plugin enable arc-hooks@arc --scope user',
  ]) {
    const f = installerFixture();
    try {
      if (failure === 'missing') fs.unlinkSync(path.join(f.bin, 'claude'));
      if (failure.startsWith('plugin enable'))
        fs.writeFileSync(f.plugins, '[{"id":"arc-hooks@arc","scope":"user","enabled":false}]');
      const r = f.run(['--marketplace-url', catalogUrl, 'code'], { ARC_TEST_FAIL_COMMAND: failure });
      assert.equal(r.status, 1, r.stderr);
      assert.doesNotMatch(r.stdout, /==> Installed Arc\./);
      if (failure === 'missing' || failure === 'plugin marketplace list --json')
        assert.doesNotMatch(r.commands, /npm|editor/);
      else assert.match(r.commands, /editor code --install-extension/);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
      assert.deepEqual(fs.readdirSync(f.temporary), []);
    } finally {
      f.cleanup();
    }
  }
});

test('hosted catalog override never replaces another marketplace source', () => {
  const f = installerFixture();
  try {
    const override = 'https://staging.example.com/arc.json';
    for (const entry of [
      { name: 'arc', source: 'directory', path: f.source },
      { name: 'arc', source: { source: 'directory', path: f.source } },
      { name: 'arc', source: 'github', repo: 'glin/agent-diff-review' },
      { name: 'arc', source: 'url', url: catalogUrl },
    ]) {
      fs.writeFileSync(f.marketplaces, JSON.stringify([entry]));
      const r = f.run(['--marketplace-url', override, 'code']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /marketplace belongs to another source/);
      const source = typeof entry.source === 'object' ? entry.source : entry;
      assert.ok(r.stderr.includes(source.path ?? source.repo ?? source.url), r.stderr);
      assert.ok(r.stderr.includes(`Expected HTTPS catalog: ${override}`), r.stderr);
      assert.match(r.stderr, /--no-hooks.*preserve the existing Claude setup/);
      assert.doesNotMatch(r.commands, /npm|package|editor/);
      assert.doesNotMatch(r.commands, /plugin (?:marketplace (?:add|update|remove)|install|update|enable)/);
      assert.equal(fs.readFileSync(f.settings, 'utf8'), f.legacy);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.marketplaces)), [entry]);
    }
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
});

test('explicit editors retain success and report each failed target without choosing extra editors', () => {
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
    const failed = f.run(['code'], { ARC_TEST_FAIL_EDITOR: 'code' });
    assert.equal(failed.status, 1);
    assert.match(failed.commands, /claude plugin marketplace list --json/);
    assert.doesNotMatch(failed.commands, /plugin (?:marketplace (?:add|update|remove)|install|update|enable|list)/);
  } finally {
    f.cleanup();
  }
});

test('stdin installation selects local source without Git and children cannot consume script input', () => {
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
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--local requires/);
    fs.writeFileSync(f.marketplaces, '[]');
    const detected = f.run([], {}, { stdin: true });
    assert.equal(detected.status, 0, detected.stderr);
    assert.match(detected.stderr, /1\) All detected editors \(code, cursor\)/);
    assert.match(detected.commands, /editor code --install-extension/);
    assert.match(detected.commands, /editor cursor --install-extension/);
    assert.match(detected.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
    fs.writeFileSync(f.marketplaces, '[]');
    fs.unlinkSync(path.join(f.bin, 'cursor'));
    const sole = f.run(['--local'], {}, { stdin: true, cwd: f.source });
    assert.equal(sole.status, 0, sole.stderr);
    assert.match(sole.commands, /editor code/);
  } finally {
    f.cleanup();
  }
});

test('the current editor receives the extension while other detected editors remain unselected', () => {
  const f = installerFixture();
  try {
    for (const [product, layout, cliName] of [
      ['code', 'linux'],
      ['code-insiders', 'windows'],
      ['cursor', 'linux'],
      ['positron', 'macos', 'code'],
      ['codium', 'macos'],
    ]) {
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
    }
    const editor = f.editor('positron', 'windows');
    if (process.platform === 'win32') {
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
    }
    const piped = f.run(['--no-hooks'], editor.env, { stdin: true });
    assert.equal(piped.status, 0, piped.stderr);
    assert.match(piped.commands, /curl.*codeload/);
    assert.deepEqual(
      [...piped.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
      ['positron'],
    );
    assert.match(piped.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
    const explicit = f.run(['--local', '--no-hooks', 'code', 'cursor'], editor.env, { cwd: f.source });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(
      [...explicit.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
      ['code', 'cursor'],
    );
    assert.doesNotMatch(explicit.stdout, /Current editor/);
  } finally {
    f.cleanup();
  }
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

test('the current editor uses the outer Windows launcher with versioned resources', () => {
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

test('the current editor accepts a flat installation named with ten hexadecimal digits', () => {
  const f = installerFixture();
  try {
    const editor = f.editor('code-insiders', 'windows', 'code-insiders', { installationName: '123456abcd' });
    for (const node of [editor.executable, '']) {
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
    }
  } finally {
    f.cleanup();
  }
});

test('the current editor accepts matching metadata versions and rejects ambiguous copied identities', () => {
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
    const accepted = f.run(['--local', '--no-hooks'], editor.env, { stdin: true, cwd: f.source, terminalInput: '\n' });
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
});

test('unverified current editor hints retain the all-editor menu and default', () => {
  const f = installerFixture();
  try {
    const editor = f.editor('cursor', 'windows');
    const other = f.editor('code', 'linux');
    const unknown = f.editor('unlisted', 'linux');
    const missingMetadata = f.editor('positron', 'windows');
    fs.unlinkSync(missingMetadata.metadata);
    const missingLauncher = f.editor('codium', 'linux');
    fs.unlinkSync(missingLauncher.launcher);
    const malformed = f.editor('code-insiders', 'linux');
    fs.writeFileSync(malformed.metadata, '{');
    for (const env of [
      {},
      { TERM_PROGRAM: 'vscode' },
      { ...editor.env, TERM_PROGRAM: 'other' },
      { ...editor.env, VSCODE_GIT_ASKPASS_MAIN: path.join(f.dir, 'missing.js') },
      { ...editor.env, VSCODE_GIT_ASKPASS_NODE: other.executable },
      { ...editor.env, VSCODE_GIT_ASKPASS_NODE: path.join(f.dir, 'missing.exe') },
      unknown.env,
      missingMetadata.env,
      missingLauncher.env,
      malformed.env,
    ]) {
      const r = f.run(['--local', '--no-hooks'], env, { stdin: true, cwd: f.source, terminalInput: '\n' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /1\) All detected editors \(code, cursor\)/);
      assert.deepEqual(
        [...r.commands.matchAll(/editor (\S+) --install-extension/g)].map((match) => match[1]),
        ['code', 'cursor'],
      );
      assert.doesNotMatch(r.stdout, /Current editor/);
    }
  } finally {
    f.cleanup();
  }
});

test('the editor menu defaults to all and individual choices limit installation', () => {
  const f = installerFixture();
  try {
    for (const [terminalInput, expected] of [
      ['\n', ['code', 'cursor']],
      ['1\n', ['code', 'cursor']],
      ['2\n', ['code']],
      ['3\n', ['cursor']],
    ]) {
      const r = f.run(['--local', '--no-hooks'], {}, { stdin: true, cwd: f.source, terminalInput });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /1\) All detected editors \(code, cursor\)\s+2\) code\s+3\) cursor/);
      assert.deepEqual(
        [...r.commands.matchAll(/editor (\w+) --install-extension/g)].map((match) => match[1]),
        expected,
      );
      assert.match(r.stdout, /ARC_INSTALL_SCRIPT_TAIL/);
    }
    for (const terminalInput of ['0\n', '4\n', 'invalid\n', '999999999\n']) {
      const r = f.run(['--local'], {}, { stdin: true, cwd: f.source, terminalInput });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /select a listed editor number/);
      assert.doesNotMatch(r.commands, /npm|editor|claude plugin/);
    }
  } finally {
    f.cleanup();
  }
});

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
          ? ['--remote', '--repo', 'fixture/arc', '--ref', 'feature/test', 'code']
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

test('remote stdin installation from an unrelated directory cleans failures and interruptions', () => {
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
      { ARC_TEST_INTERRUPT: '1' },
      { ARC_TEST_NPM_FAILURE: '1' },
      { ARC_TEST_PACKAGE_FAILURE: '1' },
    ]) {
      const r = f.run(['code'], env, { stdin: true });
      assert.notEqual(r.status, 0, JSON.stringify(env));
      assert.deepEqual(fs.readdirSync(f.temporary), []);
      assert.doesNotMatch(r.commands, /editor/);
    }
  } finally {
    f.cleanup();
  }
});

test('source installer rejects invalid options, missing tools, and old Claude before installation', () => {
  const f = installerFixture();
  try {
    for (const args of [
      ['--unknown'],
      ['--local', '--remote'],
      ['--ref'],
      ['--repo', 'bad'],
      ['--marketplace-url', 'http://example.com/arc.json'],
      ['missing-editor'],
    ]) {
      const r = f.run(args);
      assert.equal(r.status, 1, r.stderr);
      assert.doesNotMatch(r.commands, /npm|editor|claude plugin|curl/);
    }
    const old = f.run(['--marketplace-url', catalogUrl, 'code'], { ARC_TEST_CLAUDE_VERSION: '2.1.223' });
    assert.equal(old.status, 1);
    assert.match(old.stderr, /require Claude Code 2.1.224/);
    const oldRemote = f.run(['--remote', 'code'], { ARC_TEST_CLAUDE_VERSION: '2.1.223' });
    assert.equal(oldRemote.status, 1);
    assert.match(oldRemote.stderr, /require Claude Code 2.1.224/);
    assert.doesNotMatch(oldRemote.commands, /curl|npm|editor/);
    const local = f.run(['code'], { ARC_TEST_CLAUDE_VERSION: '2.1.223' });
    assert.equal(local.status, 0, local.stderr);
    for (const tool of ['node', 'npm']) {
      assert.equal(bash('PATH="$1"; command -v "$2"', bashPath(f.hostBin), tool), bashPath(f.hostBin) + '/' + tool);
      const file = path.join(f.bin, tool);
      const saved = fs.readFileSync(file);
      fs.unlinkSync(file);
      const r = f.run(['code']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(tool + ' is required'));
      fs.writeFileSync(file, saved, { mode: 0o755 });
    }
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

test('the installer refuses unsupported packaging Node versions before npm', () => {
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
      ['20.19.0', true],
      ['21.0.0', false],
      ['22.0.0', false],
      ['22.12.0', true],
      ['23.0.0', true],
    ]) {
      const r = f.run(['--no-hooks', 'code'], { ARC_TEST_NODE_VERSION: version, ARC_TEST_NPM_FAILURE: '99' });
      assert.equal(r.status, supported ? 99 : 1, r.stderr);
      if (supported) assert.match(r.commands, /npm install/);
      else {
        assert.match(r.stderr, /packaging tools need Node.js/);
        assert.doesNotMatch(r.commands, /npm/);
      }
    }
  } finally {
    f.cleanup();
  }
});
