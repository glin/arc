#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  childEnvironment,
  editorExecutable,
  editorCli,
  listProcesses,
  namesProfile,
  ownedProcesses,
  rememberProcesses,
  waitFor,
} from './isolated-editor.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const manifestName = 'installer-run.json';
const directories = ['home', 'arc', 'editor', 'extensions', 'workspace', 'evidence', 'source', 'bin', 'temporary'];
const excluded = /^(?:\.git|\.claude|\.agents|node_modules)(?:\/|$)|(?:^|\/)node_modules(?:\/|$)/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (run) =>
  fs.writeFileSync(path.join(run.root, manifestName), JSON.stringify(run, null, 2), { mode: 0o600 });

export function inside(root, file, api = path) {
  const relative = api.relative(root, file);
  return api.isAbsolute(file) && relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative);
}

export function privateEnvironment(root, parent = process.env, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const home = api.join(root, 'home');
  const env = childEnvironment(
    parent,
    {
      arcHome: api.join(root, 'arc'),
      projects: api.join(home, '.claude', 'projects'),
      codexSessions: api.join(home, '.codex', 'sessions'),
      claudeConfig: api.join(home, '.claude'),
      codexHome: api.join(home, '.codex'),
    },
    { openPanel: false },
  );
  for (const key of Object.keys(env)) {
    if (
      /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|CODEX|XDG_|APPDATA|LOCALAPPDATA|NODE_|NPM_|npm_config_|TMP|TEMP|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|CDPATH|SSH_|ANTHROPIC|OPENAI|API_KEY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(
        key,
      ) ||
      /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(key)
    )
      delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const discoveryPath = env[pathKey] ?? '';
  delete env[pathKey];
  return {
    ...env,
    PATH: api.join(root, 'bin') + (platform === 'win32' ? ';' : ':') + discoveryPath,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: api.join(home, '.claude'),
    CODEX_HOME: api.join(home, '.codex'),
    ARC_HOME: api.join(root, 'arc'),
    XDG_CONFIG_HOME: api.join(home, '.config'),
    XDG_CACHE_HOME: api.join(home, '.cache'),
    XDG_DATA_HOME: api.join(home, '.local', 'share'),
    XDG_STATE_HOME: api.join(home, '.local', 'state'),
    APPDATA: api.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: api.join(home, 'AppData', 'Local'),
    TMPDIR: api.join(root, 'temporary'),
    TMP: api.join(root, 'temporary'),
    TEMP: api.join(root, 'temporary'),
    npm_config_cache: api.join(home, '.npm'),
    npm_config_userconfig: api.join(home, '.npmrc'),
    npm_config_globalconfig: api.join(home, 'global-npmrc'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: api.join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
}

function noLinks(file) {
  for (let current = file; ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw Error(`Redirected path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) break;
  }
}

function treeFiles(root, admittedLinks = []) {
  const files = [];
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        if (admittedLinks.includes(file)) continue;
        throw Error(`Redirected descendant: ${file}`);
      }
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
      else throw Error(`Unsupported file: ${file}`);
    }
  }
  if (fs.existsSync(root)) visit(root);
  return files;
}

export function createSandbox(parent = os.tmpdir()) {
  parent = fs.realpathSync(parent);
  noLinks(parent);
  const id = randomUUID();
  const root = fs.mkdtempSync(path.join(parent, 'arc-installer-'));
  const stat = fs.statSync(root);
  const run = {
    kind: 'arc-installer',
    version: 1,
    id,
    root,
    identity: [stat.dev, stat.ino, stat.birthtimeMs],
    directories,
    aliases: [],
    links: [],
    processes: [],
    sources: [],
    steps: [],
    acceptance: 'registration-only',
    platform: process.platform,
  };
  save(run);
  for (const name of directories) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const env = privateEnvironment(root);
  for (const name of [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
  ])
    fs.mkdirSync(env[name], { recursive: true });
  return run;
}

function internalLinks(run, capture = false) {
  const found = [];
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        const stat = fs.lstatSync(file);
        if (!inside(run.root, target)) throw Error(`Link leaves the sandbox: ${file}`);
        const identity = { path: file, target, identity: [stat.dev, stat.ino, stat.birthtimeMs] };
        if (!capture && !run.links?.some((link) => JSON.stringify(link) === JSON.stringify(identity)))
          throw Error(`Unowned link: ${file}`);
        found.push(identity);
      } else if (entry.isDirectory()) visit(file);
      else if (!entry.isFile()) throw Error(`Unsupported file: ${file}`);
    }
  };
  for (const name of directories) {
    noLinks(path.join(run.root, name));
    visit(path.join(run.root, name));
  }
  if (capture) {
    run.links = found;
    save(run);
  }
  return found;
}

export function readSandbox(root) {
  if (!path.isAbsolute(root)) throw Error('The run root must be absolute.');
  root = path.resolve(root);
  noLinks(root);
  root = fs.realpathSync.native(root);
  noLinks(path.join(root, manifestName));
  const run = json(path.join(root, manifestName));
  const stat = fs.statSync(root);
  if (
    run.kind !== 'arc-installer' ||
    run.version !== 1 ||
    run.root !== root ||
    JSON.stringify(run.directories) !== JSON.stringify(directories) ||
    JSON.stringify(run.identity) !== JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs])
  )
    throw Error('Unknown installer run root.');
  return run;
}

function git(checkout, args, encoding = 'utf8') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync('git', ['-C', checkout, ...args], {
    env,
    encoding,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw Error(String(result.stderr || 'Git source selection failed.'));
  return result.stdout;
}

export function stageSource(run, checkout, { baseline, include = [] } = {}) {
  const source = path.join(run.root, 'source');
  noLinks(source);
  const commit = git(checkout, ['rev-parse', '--verify', baseline ? `${baseline}^{commit}` : 'HEAD']).trim();
  const names = baseline
    ? git(checkout, ['ls-tree', '-rz', '--name-only', commit]).split('\0')
    : git(checkout, ['ls-files', '-z']).split('\0');
  const files = {};
  for (const name of [...new Set([...names, ...include])].filter(Boolean)) {
    if (excluded.test(name)) continue;
    const target = path.resolve(source, name);
    if (!inside(source, target)) throw Error(`Source path leaves staging: ${name}`);
    let bytes;
    if (baseline) bytes = git(checkout, ['show', `${commit}:${name}`], null);
    else {
      const original = path.resolve(checkout, name);
      noLinks(original);
      if (!fs.existsSync(original)) continue;
      if (!fs.statSync(original).isFile()) throw Error(`Source is not a file: ${name}`);
      bytes = fs.readFileSync(original);
    }
    noLinks(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    files[name] = sha256(bytes);
  }
  const previous = run.sources.at(-1);
  for (const name of Object.keys(previous?.files ?? {})) {
    if (!(name in files)) {
      const file = path.resolve(source, name);
      if (!inside(source, file)) throw Error('Invalid previous source manifest.');
      noLinks(file);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  const modified = !baseline && (git(checkout, ['diff', 'HEAD', '--']).length > 0 || include.length > 0);
  run.sources.push({ commit, modified, files, digest: sha256(JSON.stringify(files)), baseline: !!baseline });
  save(run);
  return source;
}

export async function execute(
  run,
  command,
  args,
  { cwd = path.join(run.root, 'workspace'), env = privateEnvironment(run.root), expect = 0 } = {},
) {
  const index = run.steps.length;
  const step = { command, args, cwd, status: 'running', log: `evidence/step-${index}.log` };
  run.steps.push(step);
  save(run);
  const log = fs.openSync(path.join(run.root, step.log), 'wx', 0o600);
  const output = [];
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const processEntry = { pid: child.pid, terminal: false };
  run.processes.push(processEntry);
  save(run);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      fs.writeSync(log, bytes);
      output.push(bytes);
    });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => fs.closeSync(log));
  processEntry.terminal = true;
  step.status = code;
  step.digest = sha256(fs.readFileSync(path.join(run.root, step.log)));
  save(run);
  internalLinks(run, true);
  const text = Buffer.concat(output).toString('utf8');
  if (code !== expect)
    throw Error(`Command exited ${code}, expected ${expect}. Read ${path.join(run.root, step.log)}.`);
  return text;
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  for (const candidate of [
    process.env.GIT_BASH_PATH,
    ...[process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
      .filter(Boolean)
      .map((root) => path.join(root, 'Git', 'bin', 'bash.exe')),
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw Error('Git Bash is required. Set GIT_BASH_PATH to its executable.');
}

function wrapper(run, editor) {
  const executable = editorExecutable({ editor });
  const cli = editorCli(executable);
  const file = path.join(run.root, 'bin', 'isolated-editor');
  const values = [
    executable,
    cli,
    '--user-data-dir',
    path.join(run.root, 'editor'),
    '--extensions-dir',
    path.join(run.root, 'extensions'),
  ];
  fs.writeFileSync(
    file,
    '#!/usr/bin/env bash\nexec env ELECTRON_RUN_AS_NODE=1 ' +
      values.map((value) => quote(value.replaceAll('\\', '/'))).join(' ') +
      ' "$@"\n',
    { mode: 0o700 },
  );
  run.editor = { executable, cli, wrapper: file };
  save(run);
  return file;
}

export async function npmWrapper(run) {
  const file = path.join(run.root, 'bin', 'npm');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const launcher = (await execute(run, bashExecutable(), ['-c', 'command -v npm'])).trim();
  if (!launcher || launcher.includes('\n')) throw Error('The npm launcher is unavailable.');
  const source = run.sources.at(-1);
  fs.writeFileSync(
    file,
    '#!/usr/bin/env bash\n' +
      'if [ "$*" = "run build" ] && [ -z "${ARC_SOURCE_COMMIT:-}" ]; then\n' +
      `  export ARC_SOURCE_COMMIT=${quote(source.commit)} ARC_SOURCE_DIRTY=${quote(String(source.modified))}\nfi\n` +
      `exec ${quote(launcher)} "$@"\n`,
    { mode: 0o700 },
  );
  run.buildSource = { sourceCommit: source.commit, dirty: source.modified, npmLauncher: launcher };
  save(run);
}

async function preflight(run) {
  const file = path.join(run.root, 'bin', 'preflight.cjs');
  const bundle = require('../extension/node_modules/esbuild').buildSync({
    stdin: {
      resolveDir: repository,
      contents: `import os from 'node:os'; import path from 'node:path';
      import {toolRoot} from './extension/src/bundledtools'; import {claudeConfigHome,codexHome} from './extension/src/agentpaths';
      import {skillFolder} from './cli/src/skills';
      const home=os.homedir();
      const result=['claude','codex'].map(agent=>path.join(skillFolder(agent,home).area,'arc-sessions'));
      console.log(JSON.stringify({home,tools:toolRoot(),claude:claudeConfigHome(),codex:codexHome(),skills:result}));`,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].contents;
  fs.writeFileSync(file, bundle);
  const text = await execute(run, process.execPath, [file]);
  const resolved = JSON.parse(text.trim());
  for (const value of [
    resolved.home,
    resolved.tools,
    resolved.claude,
    resolved.codex,
    ...resolved.skills,
    path.join(run.root, 'editor'),
    path.join(run.root, 'extensions'),
  ]) {
    if (!inside(run.root, value)) throw Error(`Writable path leaves the sandbox: ${value}`);
    noLinks(value);
  }
  run.resolved = resolved;
  save(run);
}

async function claude(run, args, options) {
  // Bash resolves native executables and npm launchers under the same private environment as install.sh.
  return execute(run, bashExecutable(), ['-c', 'exec claude "$@"', 'bash', ...args], options);
}

export async function checkPlugin(run) {
  internalLinks(run);
  const markets = JSON.parse(await claude(run, ['plugin', 'marketplace', 'list', '--json']));
  const plugins = JSON.parse(await claude(run, ['plugin', 'list', '--json']));
  const selected = plugins.filter((entry) => entry.id === 'arc-hooks@arc');
  if (selected.length !== 1 || selected[0].scope !== 'user' || !selected[0].enabled || selected[0].errors?.length)
    throw Error('Expected one enabled user Arc plugin.');
  const plugin = selected[0];
  const location = plugin.readFromFolder || plugin.installPath;
  if (!location || !inside(run.root, location)) throw Error('Selected plugin leaves the sandbox.');
  noLinks(location);
  const bytes = Object.fromEntries(
    treeFiles(location).map((file) => [
      path.relative(location, file).replaceAll('\\', '/'),
      sha256(fs.readFileSync(file)),
    ]),
  );
  const market = markets.filter((entry) => entry.name === 'arc');
  if (market.length !== 1) throw Error('Expected one Arc marketplace.');
  let managed;
  if (!run.hosted) {
    const registrations = treeFiles(path.join(run.root, 'arc')).filter(
      (file) => path.basename(file) === 'registration.json',
    );
    if (registrations.length !== 1) throw Error('Expected one managed Arc registration.');
    const registration = json(registrations[0]);
    const source = typeof market[0].source === 'object' ? market[0].source : market[0];
    if (
      !registration.complete ||
      registration.scope !== 'user' ||
      source.source !== 'directory' ||
      fs.realpathSync(source.path) !== fs.realpathSync(registration.source)
    )
      throw Error('Managed marketplace selection disagrees with registration.');
    const release = json(path.join(run.root, 'arc', 'tools', 'releases', registration.contentId, 'release.json'));
    managed = { registration, release };
    const expected = Object.fromEntries(
      Object.entries(release.files)
        .filter(([name]) => name.startsWith('plugin/'))
        .map(([name, item]) => [name.slice(7), item.sha256]),
    );
    if (JSON.stringify(Object.entries(bytes).sort()) !== JSON.stringify(Object.entries(expected).sort()))
      throw Error('Claude selected different plugin bytes.');
    if (
      registration.observedPath !== fs.realpathSync(location) &&
      registration.observedPath !== fs.realpathSync(location).toLowerCase()
    )
      throw Error('Claude selected another plugin path.');
  }
  const extensions = treeFiles(path.join(run.root, 'extensions'))
    .filter((file) => file.endsWith(path.join('dist', 'build-identity.json')))
    .filter((file) => {
      const manifest = json(path.join(path.dirname(file), '..', 'package.json'));
      return manifest.publisher === 'glin' && manifest.name === 'arc';
    })
    .map((file) => {
      const identity = json(file);
      const extension = path.join(path.dirname(file), 'extension.js');
      if (identity.extensionSha256 !== sha256(fs.readFileSync(extension)))
        throw Error('Installed extension bytes disagree with their build identity.');
      return { file, identity, digest: sha256(fs.readFileSync(file)) };
    });
  if (extensions.length !== 1) throw Error('Expected one installed Arc extension identity.');
  if (managed) {
    const tools = extensions[0].identity.tools;
    const expected = Object.fromEntries(
      Object.entries(tools?.files ?? {})
        .filter(([name]) => name.startsWith('plugin/'))
        .map(([name, item]) => [name.slice(7), item.sha256]),
    );
    if (
      tools?.contentId !== managed.registration.contentId ||
      JSON.stringify(Object.entries(bytes).sort()) !== JSON.stringify(Object.entries(expected).sort())
    )
      throw Error('Installed extension and managed plugin select different payloads.');
  }
  const identity = { market: market[0], plugin, files: bytes, digest: sha256(JSON.stringify(bytes)), extensions };
  run.plugin = identity;
  run.selections ??= [];
  run.selections.push(identity);
  save(run);
  return identity;
}

async function install(run, source, options, extra = [], expect = 0) {
  const bootstrap = path.join(run.root, 'source', 'install.sh');
  if (!fs.existsSync(bootstrap)) stageSource(run, options.checkout ?? repository, { include: options.include });
  await npmWrapper(run);
  const args = [bootstrap.replaceAll('\\', '/'), '--json', `--${source}`];
  if (source === 'remote') {
    if (!options.repo || !options.ref) throw Error('Remote installation requires --repo and --ref.');
    args.push('--repo', options.repo, '--ref', options.ref);
  }
  if (options['marketplace-url']) {
    args.push('--marketplace-url', options['marketplace-url']);
    run.hosted = true;
  }
  args.push(...extra, run.editor.wrapper.replaceAll('\\', '/'));
  const digest = sha256(fs.readFileSync(bootstrap));
  let text;
  try {
    text = await execute(run, bashExecutable(), args, { expect });
  } catch (error) {
    const output = fs.readFileSync(path.join(run.root, run.steps.at(-1).log), 'utf8');
    run.failureKind = /(?:403|429|rate limit)/i.test(output)
      ? 'source-rate-limit'
      : /(?:404|422)/.test(output)
        ? 'source-ref-unavailable'
        : /source revision download/.test(output)
          ? 'source-network-or-revision'
          : /valid source revision/.test(output)
            ? 'source-revision-response'
            : /source archive download/.test(output)
              ? 'source-archive-download'
              : /archive extraction|archive lacks/.test(output)
                ? 'source-archive-content'
                : /snapshot plugin setup failed/.test(output)
                  ? 'plugin-setup'
                  : /dependency installation failed|Building extension/.test(output)
                    ? 'extension-build'
                    : 'installer';
    save(run);
    throw error;
  }
  const resolvedCommit = /Source revision: (\S+)/.exec(text)?.[1];
  run.steps.at(-1).source = {
    selection: source,
    bootstrapDigest: digest,
    downloadedRevision: resolvedCommit ?? null,
    staged: run.sources.at(-1)?.digest,
    download: source === 'remote' ? 'GitHub' : null,
  };
  save(run);
  if (expect === 0 && !extra.includes('--no-hooks')) await checkPlugin(run);
  return text;
}

export function cleanupSandbox(run, { list = listProcesses, platform = process.platform } = {}) {
  run = readSandbox(run.root);
  const access = path.join(run.root, 'evidence', 'checkout-access');
  fs.mkdirSync(access);
  try {
    cleanupOwnedSandbox(run, { list, platform });
  } finally {
    if (fs.existsSync(access)) fs.rmdirSync(access);
  }
}

function cleanupOwnedSandbox(run, { list, platform }) {
  if (run.active) {
    try {
      process.kill(run.active, 0);
      throw Error('The installer driver is still running.');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  if (run.processes.some((entry) => !entry.terminal))
    throw Error('A child process has no terminal receipt. Preserve this run.');
  const processes = list();
  for (const name of fs.readdirSync(path.join(run.root, 'evidence'))) {
    if (!/^checkout-launch-[\w-]+\.json$/.test(name)) continue;
    const file = path.join(run.root, 'evidence', name);
    noLinks(file);
    const receipt = json(file);
    if (receipt.terminal !== true) throw Error('A checkout session has no terminal receipt. Preserve this run.');
    if (ownedProcesses(processes, path.join(run.root, 'editor'), { known: receipt.processes, platform }).length)
      throw Error('The checkout session still has running processes.');
  }
  const ancestors = new Set();
  for (let pid = process.pid; pid && !ancestors.has(pid); pid = processes.find((entry) => entry.pid === pid)?.parentPid)
    ancestors.add(pid);
  const normalized = (value) => (platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value);
  const active = processes.filter(
    (entry) =>
      !ancestors.has(entry.pid) &&
      (namesProfile(entry.commandLine, path.join(run.root, 'editor'), platform) ||
        normalized(entry.commandLine).includes(normalized(run.root) + '/')),
  );
  if (active.length) throw Error('The sandbox still has running processes.');
  const aliases = run.aliases ?? [];
  for (const alias of aliases) {
    if (
      alias.path !== path.join(run.root, 'source-link') ||
      alias.target !== path.join(run.root, 'source') ||
      !fs.lstatSync(alias.path).isSymbolicLink() ||
      fs.realpathSync(alias.path) !== fs.realpathSync(alias.target)
    )
      throw Error('Unfamiliar directory alias.');
  }
  for (const entry of fs.readdirSync(run.root)) {
    if (![...directories, manifestName, ...aliases.map((alias) => path.basename(alias.path))].includes(entry))
      throw Error(`Unowned run entry: ${entry}`);
  }
  const links = internalLinks(run);
  for (const alias of aliases) {
    const before = treeFiles(
      alias.target,
      links.map((link) => link.path),
    ).map((file) => [file, sha256(fs.readFileSync(file))]);
    if (process.platform === 'win32') {
      const result = spawnSync('cmd.exe', ['/d', '/c', 'rmdir', alias.path], { windowsHide: true });
      if (result.status !== 0) throw Error('Directory alias removal failed.');
    } else fs.unlinkSync(alias.path);
    if (
      JSON.stringify(before) !==
      JSON.stringify(
        treeFiles(
          alias.target,
          links.map((link) => link.path),
        ).map((file) => [file, sha256(fs.readFileSync(file))]),
      )
    )
      throw Error('Alias target changed during removal.');
  }
  for (const link of links) {
    if (process.platform === 'win32' && fs.statSync(link.path).isDirectory()) fs.rmdirSync(link.path);
    else fs.unlinkSync(link.path);
  }
  for (const name of directories) fs.rmSync(path.join(run.root, name), { recursive: true });
  fs.unlinkSync(path.join(run.root, manifestName));
  fs.rmdirSync(run.root);
}

function snapshotTree(folder) {
  return Object.fromEntries(
    treeFiles(folder).map((file) => [path.relative(folder, file), sha256(fs.readFileSync(file))]),
  );
}

export async function legacyUpgrade(run, options) {
  if (!options.baseline || !options.checkout) throw Error('Legacy upgrade requires --baseline and --checkout.');
  const source = stageSource(run, options.checkout, { baseline: options.baseline });
  let selected = source;
  if (options['via-link']) {
    selected = path.join(run.root, 'source-link');
    run.aliases.push({ path: selected, target: source });
    save(run);
    fs.symlinkSync(source, selected, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await claude(run, ['plugin', 'marketplace', 'add', selected, '--scope', 'user', '--json']);
  await claude(run, ['plugin', 'install', 'arc-hooks@arc', '--scope', 'user', '--json']);
  run.legacy = {
    markets: JSON.parse(await claude(run, ['plugin', 'marketplace', 'list', '--json'])),
    plugins: JSON.parse(await claude(run, ['plugin', 'list', '--json'])),
  };
  const original = run.legacy.plugins.filter((entry) => entry.id.endsWith('@arc'));
  if (original.length !== 1 || original[0].id !== 'arc-hooks@arc' || original[0].scope !== 'user')
    throw Error('Unexpected legacy ownership.');
  let installed = original[0].readFromFolder || original[0].installPath;
  if (!installed || !inside(run.root, installed)) throw Error('Legacy plugin leaves the sandbox.');
  if (selected !== source && installed === path.join(selected, 'plugins', 'arc-hooks')) {
    const alias = run.aliases.find((entry) => entry.path === selected && entry.target === source);
    if (!alias || !fs.lstatSync(selected).isSymbolicLink() || fs.realpathSync(selected) !== fs.realpathSync(source))
      throw Error('Unfamiliar directory alias.');
    installed = path.join(source, 'plugins', 'arc-hooks');
  }
  noLinks(installed);
  const selectedFiles = Object.fromEntries(
    Object.entries(snapshotTree(installed)).map(([file, digest]) => [file.replaceAll('\\', '/'), digest]),
  );
  const expectedFiles = Object.fromEntries(
    Object.entries(run.sources.at(-1).files)
      .filter(([file]) => file.startsWith('plugins/arc-hooks/'))
      .map(([file, digest]) => [file.slice('plugins/arc-hooks/'.length), digest]),
  );
  if (JSON.stringify(Object.entries(selectedFiles).sort()) !== JSON.stringify(Object.entries(expectedFiles).sort()))
    throw Error('Legacy plugin differs from the selected baseline bytes.');
  run.legacy.selectedFiles = selectedFiles;
  stageSource(run, options.checkout, { include: options.include });
  await npmWrapper(run);
  const home = path.join(run.root, 'home');
  const settings = path.join(home, '.claude', 'settings.json');
  const value = fs.existsSync(settings) ? json(settings) : {};
  const stop = (command) => ({ hooks: [{ type: 'command', command }] });
  const physicalHook = `node "${source.replaceAll('\\', '/')}/hooks/stop-manifest.cjs"`;
  const aliasHook = `node "${selected.replaceAll('\\', '/')}/hooks/stop-manifest.cjs"`;
  value.hooks = {
    ...value.hooks,
    Stop: [stop(physicalHook), ...(selected !== source ? [stop(aliasHook)] : []), stop('echo unrelated-sentinel')],
  };
  fs.writeFileSync(settings, JSON.stringify(value));
  const bootstrap = path.join(selected, 'install.sh');
  for (const disabled of [false, true]) {
    if (disabled) await claude(run, ['plugin', 'disable', 'arc-hooks@arc', '--scope', 'user', '--json']);
    const before = snapshotTree(path.join(home, '.claude'));
    const args = [
      bootstrap.replaceAll('\\', '/'),
      '--local',
      '--json',
      '--no-skills',
      run.editor.wrapper.replaceAll('\\', '/'),
    ];
    const text = await execute(run, bashExecutable(), args, { expect: 1 });
    if (!disabled && !text.includes('uses this checkout'))
      throw Error('The same-checkout transition explanation is missing.');
    await execute(run, bashExecutable(), [...args.slice(0, -1), '--no-hooks', args.at(-1)]);
    if (JSON.stringify(before) !== JSON.stringify(snapshotTree(path.join(home, '.claude'))))
      throw Error('Legacy refusal or --no-hooks changed Claude files.');
    const backup = path.join(run.root, 'evidence', `legacy-backup-${disabled ? 'disabled' : 'enabled'}`);
    fs.cpSync(home, backup, { recursive: true, errorOnExist: true, force: false });
    // Rehearse a stopped conversion after the real declaration removal, before managed setup.
    await claude(run, ['plugin', 'uninstall', 'arc-hooks@arc', '--scope', 'user', '--keep-data', '--json']);
    await claude(run, ['plugin', 'marketplace', 'remove', 'arc', '--scope', 'user', '--json']);
    treeFiles(home);
    fs.rmSync(home, { recursive: true });
    fs.cpSync(backup, home, { recursive: true });
    if (JSON.stringify(snapshotTree(backup)) !== JSON.stringify(snapshotTree(home)))
      throw Error('Legacy backup restoration changed bytes.');
    const restored = JSON.parse(await claude(run, ['plugin', 'list', '--json'])).filter(
      (entry) => entry.id === 'arc-hooks@arc',
    );
    if (restored.length !== 1 || restored[0].enabled === disabled)
      throw Error('Restoration changed the enabled state.');
    run.steps.push({
      operation: 'legacy-restoration',
      disabled,
      failure: 'simulated interruption after declaration removal',
      backup,
    });
    if (disabled) await claude(run, ['plugin', 'enable', 'arc-hooks@arc', '--scope', 'user', '--json']);
  }
  await claude(run, ['plugin', 'uninstall', 'arc-hooks@arc', '--scope', 'user', '--keep-data', '--json']);
  await claude(run, ['plugin', 'marketplace', 'remove', 'arc', '--scope', 'user', '--json']);
  await execute(run, bashExecutable(), [
    bootstrap.replaceAll('\\', '/'),
    '--local',
    '--json',
    '--no-skills',
    run.editor.wrapper.replaceAll('\\', '/'),
  ]);
  await checkPlugin(run);
  await claude(run, ['plugin', 'disable', 'arc-hooks@arc', '--scope', 'user', '--json']);
  const final = JSON.parse(await claude(run, ['plugin', 'list', '--json'])).find(
    (entry) => entry.id === 'arc-hooks@arc',
  );
  if (!final || final.enabled) throw Error('Migration did not preserve the disabled choice.');
  run.plugin.finalEnabled = false;
  const hooks = JSON.stringify(json(settings).hooks);
  const commands = json(settings).hooks.Stop.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  if (
    !hooks.includes('unrelated-sentinel') ||
    commands.includes(physicalHook) ||
    (selected !== source && !commands.includes(aliasHook))
  )
    throw Error('Legacy cleanup changed its ownership boundary.');
  save(run);
}

export async function checkoutPlugin(run, checkout) {
  const source = fs.realpathSync(checkout);
  const plugin = path.join(source, 'plugins', 'arc-hooks');
  noLinks(plugin);
  if (!fs.statSync(plugin).isDirectory()) throw Error('The checkout plugin directory is unavailable.');
  const plugins = JSON.parse(await claude(run, ['plugin', 'list', '--json']));
  if (plugins.some((entry) => entry.id === 'arc-hooks@arc'))
    throw Error('Checkout plugin would duplicate an installed Arc plugin.');
  const env = privateEnvironment(run.root);
  if (process.platform === 'win32') {
    env.PATH = (await execute(run, bashExecutable(), ['-c', 'printf "%s" "$PATH"'], { env })).trim();
  }
  const command =
    `cd ${quote(path.join(run.root, 'workspace').replaceAll('\\', '/'))} || exit 1\n` +
    'exec env -i ' +
    Object.entries(env)
      .map(([name, value]) => quote(`${name}=${value}`))
      .join(' ') +
    ` ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(fileURLToPath(import.meta.url).replaceAll('\\', '/'))}` +
    ` launch-checkout --run-root ${quote(run.root.replaceAll('\\', '/'))}`;
  const launcher = path.join(run.root, 'bin', 'checkout-plugin');
  fs.writeFileSync(launcher, '#!/usr/bin/env bash\n' + command + '\n', { mode: 0o700 });
  run.liveSource = { checkout: source, plugin, ownership: 'read-only' };
  run.checkoutCommand = `bash ${quote(launcher.replaceAll('\\', '/'))}`;
  save(run);
  return run.checkoutCommand;
}

export async function launchCheckout(root) {
  const run = readSandbox(root);
  const access = path.join(root, 'evidence', 'checkout-access');
  fs.mkdirSync(access);
  const receipt = { sessionId: randomUUID(), processes: [], terminal: false };
  const file = path.join(root, 'evidence', `checkout-launch-${receipt.sessionId}.json`);
  const record = () => {
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  try {
    record();
  } finally {
    fs.rmdirSync(access);
  }
  // Retain creation identities before Claude starts. An interrupted observer leaves its receipt unsettled.
  rememberProcesses(receipt, listProcesses({ pids: [process.pid] }));
  if (receipt.processes.length !== 1) throw Error('Cannot identify the checkout launcher. Preserve this run.');
  record();
  const child = spawn(
    bashExecutable(),
    [
      '-c',
      `claude --plugin-dir ${quote(run.liveSource.plugin.replaceAll('\\', '/'))} --session-id ${quote(receipt.sessionId)}; status=$?; exit "$status"`,
    ],
    {
      cwd: path.join(root, 'workspace'),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  // The process query is a launcher child, so exclude it from session ownership.
  const observe = () => {
    let queryPid;
    const processes = listProcesses({
      run: (...args) => {
        const result = spawnSync(...args);
        queryPid = result.pid;
        return result;
      },
    });
    const queries = new Set([queryPid]);
    for (const entry of processes) if (queries.has(entry.parentPid)) queries.add(entry.pid);
    // Git Bash native parent edges can disappear before the next process snapshot.
    rememberProcesses(
      receipt,
      processes.filter((entry) => entry.commandLine.includes(receipt.sessionId)),
    );
    const owned = ownedProcesses(processes, path.join(root, 'editor'), {
      known: receipt.processes,
      selfPid: -1,
    }).filter((entry) => !queries.has(entry.pid));
    rememberProcesses(receipt, owned);
    record();
    return owned.filter((entry) => entry.pid !== process.pid);
  };
  let observationError;
  const timer = setInterval(() => {
    try {
      observe();
    } catch (error) {
      observationError = error;
    }
  }, 1000);
  try {
    observe();
    const code = await ended;
    clearInterval(timer);
    if (observationError) throw observationError;
    await waitFor('checkout session descendants to exit', () => observe().length === 0, { deadlineMs: 30000 });
    receipt.terminal = true;
    receipt.exitCode = code;
    record();
    process.exitCode = code ?? 1;
  } finally {
    clearInterval(timer);
  }
}

function parse(args) {
  const [operation, ...rest] = args;
  const options = { include: [] };
  const values = [
    'source',
    'first',
    'checkout',
    'editor',
    'repo',
    'ref',
    'marketplace-url',
    'baseline',
    'run-root',
    'include',
  ];
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index].replace(/^--/, '');
    if (rest[index] === '--via-link') options[name] = true;
    else if (
      rest[index].startsWith('--') &&
      values.includes(name) &&
      rest[index + 1] &&
      !rest[index + 1].startsWith('--')
    ) {
      if (name === 'include') options.include.push(rest[++index]);
      else {
        if (options[name] !== undefined) throw Error(`Repeated option: --${name}`);
        options[name] = rest[++index];
      }
    } else throw Error(`Unknown or incomplete option: ${rest[index]}`);
  }
  return { operation, options };
}

export async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log(
      'Usage: node scripts/test-installer.mjs <install|sequence|legacy-upgrade|checkout-plugin|check-plugin|cleanup> [options]\n' +
        'install --source local|remote --checkout PATH --editor INSTALL [--repo OWNER/REPO --ref REF] [--marketplace-url HTTPS_URL]\n' +
        'sequence --first local|remote --checkout PATH --repo OWNER/REPO --ref REF --editor INSTALL\n' +
        'legacy-upgrade --baseline COMMIT --checkout PATH --editor INSTALL [--via-link]\n' +
        'checkout-plugin --checkout PATH\n' +
        'check-plugin|cleanup --run-root ABSOLUTE_PATH\n' +
        'Runs retain private evidence. Authentication and functional hook acceptance require a separate disposable OS account.',
    );
    return;
  }
  const { operation, options } = parse(args);
  if (operation === 'launch-checkout') {
    await launchCheckout(options['run-root']);
    return;
  }
  if (['check-plugin', 'cleanup'].includes(operation)) {
    const run = readSandbox(options['run-root'] ?? '');
    if (operation === 'cleanup') cleanupSandbox(run);
    else console.log(JSON.stringify(await checkPlugin(run), null, 2));
    return;
  }
  if (!['install', 'sequence', 'legacy-upgrade', 'checkout-plugin'].includes(operation))
    throw Error('Unknown installer operation.');
  if (operation === 'install' && !['local', 'remote'].includes(options.source))
    throw Error('Select --source local or remote.');
  if (operation === 'sequence' && !['local', 'remote'].includes(options.first))
    throw Error('Select --first local or remote.');
  if (operation !== 'checkout-plugin' && !options.editor)
    throw Error('An explicit --editor installation directory is required.');
  const run = createSandbox();
  run.active = process.pid;
  save(run);
  console.log(`Installer sandbox: ${run.root}`);
  try {
    await preflight(run);
    if (operation === 'checkout-plugin') {
      console.log(await checkoutPlugin(run, options.checkout ?? repository));
    } else {
      wrapper(run, options.editor);
      if (operation === 'legacy-upgrade') await legacyUpgrade(run, options);
      else {
        stageSource(run, options.checkout ?? repository, { include: options.include });
        const sources =
          operation === 'install'
            ? [options.source]
            : [options.first, options.first === 'local' ? 'remote' : 'local', options.first];
        for (const source of sources) {
          await install(run, source, options);
          console.log(JSON.stringify({ source, plugin: run.plugin }));
        }
      }
    }
    run.status = 'completed';
    run.nativeFunctionalAcceptance = 'unproven';
  } catch (error) {
    run.status = 'failed';
    run.failure = error.message;
    throw error;
  } finally {
    delete run.active;
    save(run);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
