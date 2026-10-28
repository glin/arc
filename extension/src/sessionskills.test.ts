import { test, vi } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot';
import { sessionHookEnvironment } from './bundledtools';
import { childEnv } from './agenthost';
import {
  admitClaudeSessionSkill,
  admitClaudeSessionComponents,
  claudeNativeSkillSettings,
  claudeSkillHome,
  codexRawSkills,
  codexSkillConfiguration,
  canonicalSessionSkillInput,
  listSessionSkillInput,
  readSessionSkillInput,
  sessionComponentsDiagnostics,
  type SessionComponentsWithheld,
  type SessionSkillRelease,
} from './sessionskills';

function componentFlags(input: Parameters<typeof admitClaudeSessionComponents>[0]) {
  const { skill, hooks } = admitClaudeSessionComponents(input);
  return { skill, hooks };
}

// Linux and macOS report a path through a regular file as ENOTDIR, and Windows reports ENOENT.
// This reproduces the ENOTDIR result on every host, so the production path resolvers meet it everywhere.
function throughRegularFile<T>(run: () => T): T {
  const realpath = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((file: fs.PathLike, options?: never) => {
    const resolved = path.resolve(String(file));
    for (let folder = path.dirname(resolved); path.dirname(folder) !== folder; folder = path.dirname(folder))
      if (fs.statSync(folder, { throwIfNoEntry: false })?.isFile())
        throw Object.assign(new Error(`ENOTDIR: not a directory, realpath '${resolved}'`), { code: 'ENOTDIR' });
    return realpath(file, options);
  }) as typeof fs.realpathSync.native);
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

// The real readers, with every path outside the fixture root mapped to a missing fixture path and recorded.
// `strays()` lists recorded paths other than managed settings and the project settings of the root's ancestors.
function ownedReaders(root: string) {
  const unmapped: string[] = [];
  const inside = (folder: string, file: string) => {
    const relative = path.relative(folder, file);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const mapped = (file: string) => {
    if (inside(root, file)) return file;
    unmapped.push(file);
    return path.join(root, 'absent', Buffer.from(file).toString('hex'));
  };
  const managed = path.resolve(
    process.platform === 'win32'
      ? 'C:/Program Files/ClaudeCode'
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code',
  );
  const ancestors: string[] = [];
  for (let folder = path.dirname(root); ; folder = path.dirname(folder)) {
    ancestors.push(folder);
    if (path.dirname(folder) === folder) break;
  }
  return {
    read: (file: string, limit?: number) => readSessionSkillInput(mapped(file), limit),
    list: (file: string) => listSessionSkillInput(mapped(file)),
    canonical: (file: string) => canonicalSessionSkillInput(mapped(file)),
    strays: () =>
      unmapped.filter(
        (file) =>
          !inside(managed, file) &&
          !ancestors.some((folder) => file === path.join(folder, '.git') || inside(path.join(folder, '.claude'), file)),
      ),
  };
}

test.each(['win32', 'darwin', 'linux'] as const)(
  'the frozen %s child environment retains its selected Claude configuration home',
  (platform) => {
    const cwd = tempDir('session-skill-home-');
    const selected = path.join(cwd, 'selected');
    const override = path.join(cwd, 'override');
    const inherited = { cLaUdE_cOnFiG_dIr: selected, CUSTOM: 'kept' };
    const frozen = childEnv(inherited, {}, undefined, cwd, undefined, platform);
    if (platform === 'win32') assert.equal(claudeSkillHome(frozen, cwd), selected);
    else assert.notEqual(claudeSkillHome(frozen, cwd), selected);
    const wanted = { cLaUdE_cOnFiG_dIr: override };
    const explicit = childEnv(
      { CLAUDE_CONFIG_DIR: selected, CUSTOM: 'kept' },
      wanted,
      undefined,
      cwd,
      undefined,
      platform,
    );
    assert.equal(claudeSkillHome(explicit, cwd), platform === 'win32' ? override : selected);
    assert.equal(explicit.CUSTOM, 'kept');
    assert.deepEqual(inherited, { cLaUdE_cOnFiG_dIr: selected, CUSTOM: 'kept' });
    assert.deepEqual(wanted, { cLaUdE_cOnFiG_dIr: override });
    assert.equal(
      Object.keys(explicit).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR').length,
      platform === 'win32' ? 1 : 2,
    );
  },
);

// These guards protect explicit disablement and identity. Pure readers keep their recurring cost small.
const release: SessionSkillRelease = {
  contentId: 'a'.repeat(64),
  directory: '/release',
  claudePlugin: '/release/session-plugin',
  codexRoot: '/release/skills',
  claudeDefinition: '/release/session-plugin/skills/arc-sessions/SKILL.md',
  codexDefinition: '/release/skills/arc-sessions/SKILL.md',
};

test('Claude omits its automatic skill for matching and customized manual directory links', () => {
  const root = tempDir('session-skill-link-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const target = path.join(root, 'manual');
  const payload = path.join(root, 'payload');
  for (const folder of [path.join(home, 'skills'), cwd, target, payload]) fs.mkdirSync(folder, { recursive: true });
  for (const folder of [target, payload]) {
    fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: arc-sessions\n---\nRead [details](details.md).\n');
    fs.writeFileSync(path.join(folder, 'details.md'), 'matching resources');
  }
  fs.symlinkSync(target, path.join(home, 'skills/arc-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  const readers = ownedReaders(root);
  const input = {
    cwd,
    home,
    args: [],
    env: {},
    release: { ...release, claudeDefinition: path.join(payload, 'SKILL.md') },
    ...readers,
  };
  assert.equal(admitClaudeSessionSkill(input), false);
  fs.writeFileSync(path.join(target, 'details.md'), 'custom instructions');
  assert.equal(admitClaudeSessionSkill(input), false);
  assert.deepEqual(readers.strays(), []);
});

test('Claude admits its skill and hooks when a skills folder holds regular files', () => {
  const root = tempDir('session-skill-file-entry-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  for (const folder of [path.join(home, 'skills', 'writing'), path.join(cwd, '.claude')])
    fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'CLAUDE.md'), 'notes');
  fs.writeFileSync(path.join(home, 'skills', 'writing', 'SKILL.md'), '---\nname: writing\n---\n');
  // A project `skills` entry that is a file fails every host's directory listing.
  // On Linux and macOS, its skill definition path also fails canonical resolution through the file.
  fs.writeFileSync(path.join(cwd, '.claude', 'skills'), 'notes');
  const readers = ownedReaders(root);
  const input = { cwd, home, args: [], env: {}, release, ...readers };
  assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
  assert.deepEqual(readers.strays(), []);
  // The production resolver resolves the same path through the file.
  assert.deepEqual(
    throughRegularFile(() => componentFlags({ ...input, canonical: undefined })),
    { skill: true, hooks: true },
  );
});

test('withheld session tools reach the diagnostics log after the launch step, in order', () => {
  const lines: unknown[] = [];
  const deferred: (() => void)[] = [];
  const write = sessionComponentsDiagnostics({ warn: (event, record) => lines.push({ event, ...record }) }, (next) =>
    deferred.push(next),
  );
  const record = (stage: SessionComponentsWithheld['stage']): SessionComponentsWithheld => ({
    provider: 'claude',
    stage,
    withheld: { skill: 'settings-refusal' },
  });
  write(record('launch'));
  write(record('running'));
  assert.deepEqual(lines, []);
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.deepEqual(
    lines.map((line) => (line as { stage: string }).stage),
    ['launch', 'running'],
  );
});

// The diagnostics log receives this check, so it must name the file a user can inspect and the plugin.
test('Claude names the unlocated catalog of a plugin without a manifest', () => {
  const root = tempDir('session-skill-manifest-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const installPath = path.join(home, 'plugins', 'cache', 'market', 'tool', '1.0.0');
  for (const folder of [installPath, cwd]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ market: { source: { source: 'github', repo: 'owner/market' } } }),
  );
  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'tool@market': [{ scope: 'user', version: '1.0.0', installPath }] } }),
  );
  const readers = ownedReaders(root);
  const result = admitClaudeSessionComponents({ cwd, home, args: [], env: {}, release, ...readers });
  const check = `${path.join(home, 'plugins', 'known_marketplaces.json')}:tool@market`;
  assert.deepEqual(result, {
    skill: false,
    hooks: false,
    reasons: { skill: 'unreadable-plugin-catalog', hooks: 'unreadable-plugin-catalog', configuration: 'admitted' },
    checks: { skill: check, hooks: check },
  });
  // The diagnostics log receives this error, so it must name the manifest a user can inspect.
  const manifest = path.join(installPath, '.claude-plugin', 'plugin.json');
  fs.mkdirSync(path.dirname(manifest));
  fs.writeFileSync(manifest, '{}');
  assert.equal(
    admitClaudeSessionComponents({ cwd, home, args: [], env: {}, release, ...readers }).error,
    `A plugin identity is unreadable: ${manifest}`,
  );
  assert.deepEqual(readers.strays(), []);
});

// A user-scope plugin without a manifest whose catalog entry lists two skill folders, as the owner's configuration has.
test('Claude admits its skill and hooks beside a plugin that its marketplace catalog describes', () => {
  const root = tempDir('session-skill-catalog-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const installLocation = path.join(home, 'plugins', 'marketplaces', 'posit-dev-skills');
  const installPath = path.join(home, 'plugins', 'cache', 'posit-dev-skills', 'posit-dev', 'a1b2c3d');
  const catalogFile = path.join(installLocation, '.claude-plugin', 'marketplace.json');
  const skills = ['./posit-dev/critical-code-reviewer', './posit-dev/describe-design', './posit-dev/Arc-Sessions'];
  for (const folder of [cwd, path.dirname(catalogFile), ...skills.map((skill) => path.join(installPath, skill))])
    fs.mkdirSync(folder, { recursive: true });
  for (const skill of skills)
    fs.writeFileSync(path.join(installPath, skill, 'SKILL.md'), `---\nname: ${path.basename(skill)}\n---\n`);
  fs.writeFileSync(
    path.join(home, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'posit-dev-skills': { source: { source: 'github', repo: 'posit-dev/skills' }, installLocation } }),
  );
  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'posit-dev@posit-dev-skills': [{ scope: 'user', version: 'a1b2c3d', installPath }] },
    }),
  );
  const entry = { name: 'posit-dev', source: './', strict: false, skills: skills.slice(0, 2) };
  const catalog = (plugin: Record<string, unknown>) =>
    fs.writeFileSync(catalogFile, JSON.stringify({ name: 'posit-dev-skills', plugins: [plugin] }));
  catalog(entry);
  const readers = ownedReaders(root);
  const input = { cwd, home, args: [], env: {}, release, ...readers };
  assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
  const capture = { Stop: [{ hooks: [{ type: 'command', command: 'node stop-manifest.cjs' }] }] };
  const unrelated = { Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] };
  const check = `${catalogFile}:posit-dev@posit-dev-skills`;
  for (const [plugin, withheld] of [
    [{ ...entry, hooks: unrelated }, {}],
    [{ ...entry, skills }, { skill: 'native-definition' }],
    [{ ...entry, commands: { 'arc-sessions': { content: 'Run Arc.' } } }, { skill: 'native-definition' }],
    [{ ...entry, skills: ['../outside'] }, { skill: 'unclassified-component-path' }],
    [{ ...entry, hooks: capture }, { hooks: 'conflicting-or-unreadable-declaration' }],
    [{ ...entry, hooks: './hooks/extra.json' }, { hooks: 'conflicting-or-unreadable-declaration' }],
    [{ ...entry, hooks: { hooks: unrelated } }, { hooks: 'conflicting-or-unreadable-declaration' }],
    [{ ...entry, hooks: { ...unrelated, hooks: unrelated } }, { hooks: 'conflicting-or-unreadable-declaration' }],
    [
      { ...entry, name: 'other' },
      { skill: 'unreadable-plugin-catalog', hooks: 'unreadable-plugin-catalog' },
    ],
  ] as const) {
    catalog(plugin);
    const result = admitClaudeSessionComponents(input);
    const components = (['skill', 'hooks'] as const).filter((component) => !result[component]);
    assert.deepEqual(
      Object.fromEntries(components.map((component) => [component, result.reasons[component]])),
      withheld,
      JSON.stringify(plugin),
    );
    assert.deepEqual(result.checks ?? {}, Object.fromEntries(components.map((component) => [component, check])));
  }
  // A settings refusal of the hooks and a later catalog refusal report the later refusal's reason and check together.
  const settingsFile = path.join(home, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: capture }));
  catalog({ ...entry, hooks: capture });
  const paired = admitClaudeSessionComponents(input);
  assert.deepEqual([paired.reasons.hooks, paired.checks?.hooks], ['conflicting-or-unreadable-declaration', check]);
  fs.rmSync(settingsFile);
  // The official Claude catalog exceeds 128 KiB. Arc reads it once for all plugins installed from it.
  const secondPath = path.join(home, 'plugins', 'cache', 'posit-dev-skills', 'second', 'e4f5');
  fs.mkdirSync(secondPath, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'posit-dev@posit-dev-skills': [{ scope: 'user', version: 'a1b2c3d', installPath }],
        'second@posit-dev-skills': [{ scope: 'user', version: 'e4f5', installPath: secondPath }],
      },
    }),
  );
  const second = { name: 'second', source: './second', strict: false };
  const filler = Array.from({ length: 1500 }, (_, index) => ({
    name: `filler-${index}`,
    source: `./plugins/filler-${index}`,
    description: 'A plugin listed in the same catalog. '.repeat(3),
  }));
  fs.writeFileSync(catalogFile, JSON.stringify({ name: 'posit-dev-skills', plugins: [...filler, entry, second] }));
  assert.ok(fs.statSync(catalogFile).size > 128 * 1024);
  let catalogReads = 0;
  const counted = {
    ...input,
    read: (file: string, limit?: number) => {
      if (file === catalogFile) catalogReads++;
      return readers.read(file, limit);
    },
  };
  assert.deepEqual(admitClaudeSessionComponents(counted).reasons, {
    skill: 'eligible',
    hooks: 'eligible',
    configuration: 'admitted',
  });
  assert.equal(catalogReads, 1);
  // A catalog over 1 MiB, or one that is not JSON, withholds both components and names the catalog.
  const secondCheck = `${catalogFile}:second@posit-dev-skills`;
  for (const content of [
    JSON.stringify({ plugins: [entry, second, { name: 'padding', description: 'x'.repeat(1024 * 1024) }] }),
    '{"plugins": [',
  ]) {
    fs.writeFileSync(catalogFile, content);
    const unreadable = admitClaudeSessionComponents(input);
    assert.deepEqual(
      { reasons: unreadable.reasons, checks: unreadable.checks },
      {
        reasons: { skill: 'unreadable-plugin-catalog', hooks: 'unreadable-plugin-catalog', configuration: 'admitted' },
        checks: { skill: secondCheck, hooks: secondCheck },
      },
    );
  }
  // A Git marketplace reads its catalog at the source's `path` under its install location.
  const gitCatalog = path.join(installLocation, 'catalogs', 'market.json');
  fs.mkdirSync(path.dirname(gitCatalog));
  fs.writeFileSync(gitCatalog, JSON.stringify({ plugins: [entry, second] }));
  fs.writeFileSync(
    path.join(home, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({
      'posit-dev-skills': {
        source: { source: 'git', url: 'https://example.com/skills.git', path: 'catalogs/market.json' },
        installLocation,
      },
    }),
  );
  assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
  fs.writeFileSync(gitCatalog, JSON.stringify({ plugins: [{ ...entry, skills }, second] }));
  const git = admitClaudeSessionComponents(input);
  assert.deepEqual(
    { reason: git.reasons.skill, check: git.checks?.skill },
    { reason: 'native-definition', check: `${gitCatalog}:posit-dev@posit-dev-skills` },
  );
  assert.deepEqual(readers.strays(), []);
});

test('Claude reads the catalog entry of a directory marketplace for a plugin without a manifest', () => {
  const root = tempDir('session-skill-directory-catalog-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const market = path.join(root, 'market');
  const catalogFile = path.join(market, '.claude-plugin', 'marketplace.json');
  const installPath = path.join(home, 'plugins', 'cache', 'local-market', 'tool', '1.0.0');
  for (const folder of [cwd, path.dirname(catalogFile), path.join(market, 'tool', 'extra'), installPath])
    fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(market, 'tool', 'extra', 'SKILL.md'), '---\nname: extra\n---\n');
  fs.writeFileSync(
    path.join(home, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'local-market': { source: { source: 'directory', path: market } } }),
  );
  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'tool@local-market': [{ scope: 'user', version: '1.0.0', installPath }] },
    }),
  );
  const entry = { name: 'tool', source: './tool', skills: ['./extra'] };
  const catalog = (plugins: unknown[]) => fs.writeFileSync(catalogFile, JSON.stringify({ plugins }));
  catalog([entry]);
  const readers = ownedReaders(root);
  const input = { cwd, home, args: [], env: {}, release, ...readers };
  assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
  catalog([{ ...entry, commands: { 'Arc-Sessions': { content: 'Run Arc.' } } }]);
  const listed = admitClaudeSessionComponents(input);
  assert.deepEqual(
    { skill: listed.skill, hooks: listed.hooks, reason: listed.reasons.skill, checks: listed.checks },
    { skill: false, hooks: true, reason: 'native-definition', checks: { skill: `${catalogFile}:tool@local-market` } },
  );
  // Arc finds the plugin root through this catalog, so a catalog without the plugin leaves the configuration uncertain.
  catalog([{ ...entry, name: 'other' }]);
  const missing = admitClaudeSessionComponents(input);
  assert.deepEqual(
    { reasons: missing.reasons, error: missing.error },
    {
      reasons: { skill: 'uncertain-configuration', hooks: 'uncertain-configuration', configuration: 'uncertain' },
      error: `${catalogFile} does not list plugin tool@local-market once with a relative source.`,
    },
  );
  assert.deepEqual(readers.strays(), []);
});

test.each(['win32', 'darwin', 'linux'] as const)(
  'Claude read admission maps all %s inputs into owned files',
  (platform) => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const cwd = platform === 'win32' ? 'C:\\Work\\Project' : '/work/project';
    const home = platform === 'win32' ? 'C:\\Reader\\.claude' : '/reader/.claude';
    const managed =
      platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode'
        : platform === 'darwin'
          ? '/Library/Application Support/ClaudeCode'
          : '/etc/claude-code';
    const definition = paths.join(home, 'skills/arc-sessions/SKILL.md');
    const supplied = paths.join(
      platform === 'win32' ? 'C:\\Release' : '/release',
      'session-plugin/skills/arc-sessions/SKILL.md',
    );
    const root = tempDir('session-skill-inputs-');
    const mapped = new Map<string, string>();
    const unmapped: string[] = [];
    const key = (file: string) => (platform === 'win32' ? paths.normalize(file).toLowerCase() : paths.normalize(file));
    const admit = (file: string) => {
      if (!mapped.has(key(file))) mapped.set(key(file), path.join(root, String(mapped.size)));
    };
    const folders = [home];
    for (let folder = cwd; ; folder = paths.dirname(folder)) {
      folders.push(paths.join(folder, '.claude'));
      admit(paths.join(folder, '.git'));
      if (paths.dirname(folder) === folder) break;
    }
    for (const folder of folders)
      for (const tail of [
        'settings.json',
        'settings.local.json',
        'skills/arc-sessions/SKILL.md',
        'commands/arc-sessions.md',
        'skills',
      ])
        admit(paths.join(folder, tail));
    for (const tail of ['installed_plugins.json', 'known_marketplaces.json', 'known_marketplaces_claudeai.json'])
      admit(paths.join(home, 'plugins', tail));
    for (const file of [
      paths.join(managed, 'managed-settings.json'),
      paths.join(managed, 'managed-mcp.json'),
      managed,
      supplied,
      paths.join(cwd, '.git'),
    ])
      admit(file);
    const owned = (file: string) => {
      const found = mapped.get(key(file));
      if (!found) {
        unmapped.push(file);
        throw new Error('Unmapped fixture input.');
      }
      return found;
    };
    const read = (file: string) => {
      const target = owned(file);
      try {
        return fs.readFileSync(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const write = (file: string, text: string) => fs.writeFileSync(owned(file), text);
    const input = {
      cwd,
      home,
      release: { ...release, claudeDefinition: supplied },
      args: [] as string[],
      env: {},
      platform,
      read,
      list: (directory: string) => {
        const target = owned(directory);
        return fs.existsSync(target) ? fs.readdirSync(target) : ([] as string[]);
      },
      canonical: (file: string) => {
        owned(file);
        return key(file);
      },
    };
    write(supplied, 'matching skill');
    assert.equal(admitClaudeSessionSkill(input), true);
    const marketplaces = {
      extraKnownMarketplaces: {
        writing: { source: { source: 'github', repo: 'example/writing' } },
        local: { source: { source: 'directory', path: paths.join(home, 'marketplace') } },
      },
    };
    for (const file of [paths.join(home, 'settings.json'), paths.join(cwd, '.claude/settings.json')]) {
      write(file, JSON.stringify(marketplaces));
      assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
      write(definition, 'personal skill');
      assert.equal(admitClaudeSessionSkill(input), false);
      fs.unlinkSync(owned(definition));
      write(file, '{}');
    }
    for (const source of ['userSettings', 'projectSettings', 'localSettings', 'flagSettings'])
      assert.equal(
        claudeNativeSkillSettings({
          effective: marketplaces,
          sources: [{ source, settings: marketplaces }],
          applied: {},
        }),
        true,
      );
    for (const extraKnownMarketplaces of [null, [], { inline: { source: { source: 'settings', plugins: [] } } }]) {
      write(paths.join(home, 'settings.json'), JSON.stringify({ extraKnownMarketplaces }));
      assert.equal(admitClaudeSessionSkill(input), false);
    }
    write(paths.join(home, 'settings.json'), '{}');
    for (const env of [
      { NODE_EXTRA_CA_CERTS: '/custom/certificates.pem' },
      { NODE_CHANNEL_FD: '3' },
      { nOdE_eXtRa_Ca_CeRtS: '/custom' },
      { NODE_EXTRA_CA_CERTS: '', node_extra_ca_certs: '/custom' },
      { NODE_CHANNEL_FD: 3 },
      { CUSTOM: null },
      { CUSTOM: 'first', custom: 'second' },
      { NODE_EXTRA_CA_CERTS: '' },
    ]) {
      const hooks =
        Object.values(env).every((value) => typeof value === 'string') &&
        !!sessionHookEnvironment(env as NodeJS.ProcessEnv, platform);
      for (const file of [
        paths.join(home, 'settings.json'),
        paths.join(cwd, '.claude/settings.json'),
        paths.join(cwd, '.claude/settings.local.json'),
      ]) {
        write(file, JSON.stringify({ env }));
        assert.deepEqual(componentFlags(input), { skill: true, hooks }, `${platform} ${file} ${JSON.stringify(env)}`);
        write(file, '{}');
      }
      assert.deepEqual(componentFlags({ ...input, args: ['--settings', JSON.stringify({ env })] }), {
        skill: true,
        hooks,
      });
      const settingsFile = paths.join(home, 'settings.json');
      write(settingsFile, JSON.stringify({ env }));
      assert.deepEqual(componentFlags({ ...input, args: ['--settings', settingsFile] }), { skill: true, hooks });
      write(settingsFile, '{}');
      for (const source of ['userSettings', 'projectSettings', 'localSettings', 'flagSettings']) {
        for (const effective of [true, false]) {
          const response = {
            effective: effective ? { env } : {},
            applied: {},
            sources: [{ source, settings: effective ? {} : { env } }],
          };
          assert.equal(claudeNativeSkillSettings(response, 'hooks', platform), hooks);
          assert.equal(claudeNativeSkillSettings(response, 'skill', platform), true);
        }
      }
    }
    assert.deepEqual(unmapped, []);
    fs.mkdirSync(owned(managed));
    const mixedManaged = path.join(owned(managed), 'Managed-Settings.d');
    fs.mkdirSync(mixedManaged);
    fs.writeFileSync(path.join(mixedManaged, '10-policy.json'), '{}');
    assert.equal(admitClaudeSessionSkill(input), platform !== 'win32');
    fs.unlinkSync(path.join(mixedManaged, '10-policy.json'));
    fs.rmdirSync(mixedManaged);
    assert.deepEqual(unmapped, []);
    write(definition, 'matching skill');
    assert.deepEqual(componentFlags(input), { skill: false, hooks: true });
    write(definition, 'custom skill');
    assert.equal(admitClaudeSessionSkill(input), false);
    write(definition, 'matching skill');
    for (const settings of [
      { enabledPlugins: { 'arc-session-tools@inline': false } },
      { enabledPlugins: { 'arc-session-tools@other': true } },
      { disableSideloadFlags: true },
      { env: { pAtH: '/other' } },
      { strictKnownMarketplaces: [] },
    ]) {
      write(paths.join(home, 'settings.json'), JSON.stringify(settings));
      assert.equal(admitClaudeSessionSkill(input), false, JSON.stringify(settings));
    }
    fs.unlinkSync(owned(definition));
    write(paths.join(home, 'settings.json'), '{}');
    assert.equal(
      admitClaudeSessionSkill({
        ...input,
        read: (file) => {
          if (key(file) === key(definition)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return read(file);
        },
      }),
      false,
    );
    for (const args of [['--disable-slash-commands'], ['--bare'], ['--plugin-dir=/other'], ['--setting-sources=user']])
      assert.equal(admitClaudeSessionSkill({ ...input, args }), false);
    const marketplace = platform === 'win32' ? 'C:\\Marketplace' : '/marketplace';
    const sourceRoot = paths.join(marketplace, 'plugin');
    const cachedRoot = paths.join(marketplace, 'cache');
    for (const file of [
      paths.join(marketplace, '.claude-plugin/marketplace.json'),
      paths.join(sourceRoot, '.claude-plugin/plugin.json'),
      paths.join(sourceRoot, 'skills/arc-sessions/SKILL.md'),
      paths.join(sourceRoot, 'commands/arc-sessions.md'),
      paths.join(sourceRoot, 'hooks/hooks.json'),
      paths.join(cachedRoot, '.claude-plugin/plugin.json'),
      marketplace,
      sourceRoot,
    ])
      admit(file);
    write(
      paths.join(home, 'plugins/known_marketplaces.json'),
      JSON.stringify({ arc: { source: { source: 'directory', path: marketplace }, installLocation: marketplace } }),
    );
    write(
      paths.join(home, 'plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'arc-hooks@arc': [{ scope: 'user', version: '0.1.0', installPath: cachedRoot }] },
      }),
    );
    write(
      paths.join(marketplace, '.claude-plugin/marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'arc-hooks', source: './plugin' }] }),
    );
    write(paths.join(sourceRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'arc-hooks' }));
    write(paths.join(cachedRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'arc-session-tools' }));
    assert.equal(admitClaudeSessionSkill(input), true, 'the selected local source must coexist with Arc hooks');
    write(paths.join(sourceRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'arc-session-tools' }));
    assert.equal(admitClaudeSessionSkill(input), false, 'cached bytes cannot hide a selected source collision');
    write(paths.join(sourceRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'arc-hooks' }));
    assert.deepEqual(componentFlags(input), { skill: true, hooks: false });
    // Renaming a plugin cannot authorize a second capture command.
    write(
      paths.join(home, 'plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'renamed@arc': [{ scope: 'user', version: '0.1.0', installPath: cachedRoot }] },
      }),
    );
    write(
      paths.join(marketplace, '.claude-plugin/marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'renamed', source: './plugin' }] }),
    );
    const capture = { Stop: [{ hooks: [{ type: 'command', command: 'node "manual/stop-manifest.cjs" --flag' }] }] };
    const unrelated = { Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] };
    const customHooks = paths.join(sourceRoot, 'custom-hooks.json');
    admit(customHooks);
    for (const declaration of ['default', 'selected', 'inline']) {
      write(
        paths.join(sourceRoot, '.claude-plugin/plugin.json'),
        JSON.stringify({
          name: 'renamed',
          ...(declaration === 'selected'
            ? { hooks: './custom-hooks.json' }
            : declaration === 'inline'
              ? { hooks: capture }
              : {}),
        }),
      );
      if (declaration === 'default')
        write(paths.join(sourceRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: capture }));
      else fs.rmSync(owned(paths.join(sourceRoot, 'hooks/hooks.json')), { force: true });
      if (declaration === 'selected') write(customHooks, JSON.stringify({ hooks: capture }));
      assert.deepEqual(componentFlags(input), { skill: true, hooks: false }, declaration);
    }
    write(paths.join(sourceRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'renamed' }));
    write(paths.join(sourceRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: unrelated }));
    assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
    const defaultHookPath = paths.join(sourceRoot, 'hooks/hooks.json');
    let omittedReads = 0;
    const omitted = admitClaudeSessionComponents(
      {
        ...input,
        read: (file) => {
          if (key(file) === key(defaultHookPath)) omittedReads++;
          return read(file);
        },
      },
      false,
    );
    assert.equal(omittedReads, 0, 'omitted hooks read their declaration');
    assert.deepEqual({ skill: omitted.skill, hooks: omitted.hooks }, { skill: true, hooks: false });
    assert.deepEqual(
      componentFlags({
        ...input,
        canonical: (file) =>
          key(file) === key(defaultHookPath)
            ? paths.join(paths.parse(cwd).root, 'outside-plugin', 'hooks.json')
            : input.canonical(file),
      }),
      { skill: true, hooks: false },
    );
    for (const settings of [
      { disableAllHooks: true },
      { allowManagedHooksOnly: true },
      { disableAllHooks: 'false' },
      { enabledPlugins: { 'arc-hooks@inline': false } },
      { hooks: capture },
      { hooks: { Stop: 'invalid' } },
      { hooks: { Stop: [{ matcher: 3, hooks: [] }] } },
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: '' }] }] } },
    ]) {
      write(paths.join(home, 'settings.json'), JSON.stringify(settings));
      assert.deepEqual(componentFlags(input), { skill: true, hooks: false }, JSON.stringify(settings));
    }
    write(paths.join(home, 'settings.json'), '{}');
    assert.deepEqual(componentFlags({ ...input, args: ['--disable-slash-commands'] }), {
      skill: false,
      hooks: true,
    });
    for (const inputOverride of [
      {
        read: (file: string) =>
          key(file) === key(paths.join(home, 'settings.json')) ? ' '.repeat(128 * 1024 + 1) : read(file),
      },
      { list: () => Array.from({ length: 257 }, (_, index) => String(index)) },
    ])
      assert.deepEqual(componentFlags({ ...input, ...inputOverride }), { skill: false, hooks: false });
    // An unrelated project registration cannot suppress this child's components.
    const otherProject = paths.join(paths.parse(cwd).root, 'OtherProject');
    admit(otherProject);
    admit(cwd);
    write(
      paths.join(home, 'plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'renamed@arc': [{ scope: 'project', projectPath: otherProject, version: '0.1.0', installPath: cachedRoot }],
        },
      }),
    );
    write(paths.join(sourceRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: capture }));
    assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
    for (const scope of ['managed', 'unknown']) {
      write(
        paths.join(home, 'plugins/installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: {
            'renamed@arc': [{ scope, version: '0.1.0', installPath: cachedRoot }],
          },
        }),
      );
      assert.deepEqual(componentFlags(input), { skill: false, hooks: false });
    }
    // A plugin without a manifest takes its components from its catalog entry under each platform's path rules.
    const location = paths.join(home, 'plugins/marketplaces/Posit-Skills');
    const installed = paths.join(home, 'plugins/cache/Posit-Skills/posit-dev/A1B2');
    const listedSkill = paths.join(installed, 'Posit-Dev/Arc-Sessions');
    for (const file of [
      paths.join(location, '.claude-plugin/marketplace.json'),
      paths.join(installed, '.claude-plugin/plugin.json'),
      paths.join(installed, 'skills/arc-sessions/SKILL.md'),
      paths.join(installed, 'commands/arc-sessions.md'),
      paths.join(installed, 'hooks/hooks.json'),
      paths.join(installed, 'skills'),
      paths.join(installed, 'commands'),
      paths.join(listedSkill, 'arc-sessions/SKILL.md'),
      paths.join(listedSkill, 'SKILL.md'),
      location,
      installed,
      listedSkill,
    ])
      admit(file);
    write(
      paths.join(home, 'plugins/known_marketplaces.json'),
      JSON.stringify({ posit: { source: { source: 'github', repo: 'posit/skills' }, installLocation: location } }),
    );
    write(
      paths.join(home, 'plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'posit-dev@posit': [{ scope: 'user', version: 'A1B2', installPath: installed }] },
      }),
    );
    write(
      paths.join(location, '.claude-plugin/marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'posit-dev', source: './', skills: ['./Posit-Dev/Arc-Sessions'] }] }),
    );
    assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
    write(paths.join(listedSkill, 'SKILL.md'), 'listed skill');
    assert.deepEqual(componentFlags(input), { skill: false, hooks: true });
    // A listed folder holding `Arc-Sessions/SKILL.md` withholds the skill on every platform.
    const listedFolder = paths.join(installed, 'Posit-Dev');
    for (const file of [listedFolder, paths.join(listedFolder, 'arc-sessions/SKILL.md')]) admit(file);
    write(
      paths.join(location, '.claude-plugin/marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'posit-dev', source: './', skills: ['./Posit-Dev'] }] }),
    );
    assert.deepEqual(componentFlags(input), { skill: true, hooks: true });
    fs.mkdirSync(path.join(owned(listedFolder), 'Arc-Sessions'), { recursive: true });
    assert.deepEqual(componentFlags(input), { skill: false, hooks: true });
    assert.deepEqual(unmapped, []);
    write(paths.join(home, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
    write(paths.join(home, 'commands/arc-sessions.md'), 'matching skill');
    assert.deepEqual(componentFlags(input), { skill: false, hooks: true });
    write(paths.join(managed, 'managed-settings.json'), '{}');
    assert.equal(admitClaudeSessionSkill(input), false);
    assert.deepEqual(unmapped, []);
    assert.equal(paths.isAbsolute(supplied), true);
    assert.equal(key(cwd), platform === 'win32' ? 'c:\\work\\project' : '/work/project');
  },
);

test('native Claude personal tiers retain raw disablement and reject policy origins', () => {
  const response = {
    effective: {},
    sources: ['userSettings', 'projectSettings', 'localSettings', 'flagSettings'].map((source) => ({
      source,
      settings: {},
    })),
    applied: {},
  };
  assert.equal(claudeNativeSkillSettings(response), true);
  for (const source of ['policySettings', 'managed', 'unknown'])
    assert.equal(claudeNativeSkillSettings({ ...response, sources: [{ source, settings: {} }] }), false);
  assert.equal(
    claudeNativeSkillSettings({
      ...response,
      sources: [{ source: 'userSettings', settings: { enabledPlugins: { 'arc-session-tools@inline': false } } }],
    }),
    false,
  );
  for (const invalid of [null, {}, { ...response, sources: {} }, { ...response, applied: null }])
    assert.equal(claudeNativeSkillSettings(invalid), false);
});

test('Codex admission keeps raw duplicate identities and configured disabled paths outside native roots', () => {
  const ownedDefinitions = tempDir('disabled-skill-identities-');
  const disabledPath = path.join(ownedDefinitions, 'disabled', 'SKILL.md');
  fs.mkdirSync(path.dirname(disabledPath));
  for (const [definition, admitted] of [
    ['---\nname: Arc-Sessions\n---\nInstructions', false],
    ['---\ndescription: no identity\n---\nname: unrelated', false],
    ['---\nname: unrelated\n---\nInstructions', true],
  ] as const) {
    fs.writeFileSync(disabledPath, definition);
    assert.equal(
      codexSkillConfiguration(
        { config: { skills: { config: [{ path: disabledPath, enabled: false }] } }, origins: {}, layers: [] },
        { requirements: null },
        { ...release, codexDefinition: path.join(ownedDefinitions, 'selected', 'SKILL.md') },
      ),
      admitted,
      definition,
    );
  }
  // The production resolver resolves a configured path through a regular file like a missing path.
  fs.writeFileSync(path.join(ownedDefinitions, 'notes'), 'notes');
  assert.equal(
    throughRegularFile(() =>
      codexSkillConfiguration(
        {
          config: { skills: { config: [{ path: path.join(ownedDefinitions, 'notes', 'SKILL.md'), enabled: true }] } },
          origins: {},
          layers: [],
        },
        { requirements: null },
        release,
      ),
    ),
    true,
  );
  const cwd = process.cwd();
  const skill = {
    name: 'arc-sessions',
    path: path.resolve('selected/SKILL.md'),
    enabled: true,
    description: '',
    scope: 'user',
    pluginId: null,
  };
  const listing = {
    data: [{ cwd, errors: [], skills: [skill, { ...skill, path: path.resolve('personal/SKILL.md'), enabled: false }] }],
  };
  assert.equal(codexRawSkills(listing, cwd).length, 2);
  for (const invalid of [
    { data: [] },
    { data: [listing.data[0], listing.data[0]] },
    { data: [{ ...listing.data[0], errors: ['unreadable'] }] },
  ])
    assert.throws(() => codexRawSkills(invalid, cwd));
  const config = {
    config: {},
    origins: {},
    layers: [
      { name: { type: 'system' }, version: '1', config: {} },
      { name: { type: 'user' }, version: '2', config: {} },
    ],
  };
  assert.equal(codexSkillConfiguration(config, { requirements: null }, release), true);
  assert.equal(codexSkillConfiguration({ ...config, config: { skills: null } }, { requirements: null }, release), true);
  assert.equal(codexSkillConfiguration(config, { requirements: {} }, release), false);
  for (const type of ['mdm', 'enterpriseManaged', 'legacyManaged', 'unknown'])
    assert.equal(
      codexSkillConfiguration(
        { ...config, layers: [{ name: { type }, version: '1', config: {} }] },
        { requirements: null },
        release,
      ),
      false,
    );
  for (const enabled of [false, true])
    assert.equal(
      codexSkillConfiguration(
        { ...config, config: { skills: { config: [{ path: skill.path, enabled }] } } },
        { requirements: null },
        { ...release, codexDefinition: skill.path },
      ),
      enabled,
    );
  assert.equal(
    codexSkillConfiguration(
      {
        ...config,
        config: {
          skills: { config: [{ path: path.resolve('retired/skills/arc-sessions/SKILL.md'), enabled: false }] },
        },
      },
      { requirements: null },
      release,
    ),
    false,
  );
  assert.equal(
    codexSkillConfiguration(
      {
        ...config,
        config: {
          skills: {
            config: [
              { path: skill.path, enabled: true },
              { path: skill.path, enabled: true },
            ],
          },
        },
      },
      { requirements: null },
      release,
    ),
    false,
  );
});

test.each(['win32', 'darwin', 'linux'] as const)(
  'Codex %s admission keeps native absolute paths and independent case rules',
  (platform) => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const selected =
      platform === 'win32' ? 'C:\\Release\\skills\\arc-sessions\\SKILL.md' : '/Release/skills/arc-sessions/SKILL.md';
    const alias =
      platform === 'win32' ? 'c:\\release\\SKILLS\\arc-sessions\\skill.md' : '/release/skills/arc-sessions/SKILL.md';
    const cwd = platform === 'win32' ? 'C:\\Project' : '/project';
    const raw = {
      data: [
        {
          cwd,
          errors: [],
          skills: [{ name: 'arc-sessions', path: selected, enabled: true, scope: 'user', description: '' }],
        },
      ],
    };
    assert.equal(codexRawSkills(raw, cwd, platform)[0].path, selected);
    assert.throws(() =>
      codexRawSkills(
        { data: [{ ...raw.data[0], skills: [{ ...raw.data[0].skills[0], path: 'relative/SKILL.md' }] }] },
        cwd,
        platform,
      ),
    );
    const root = tempDir('codex-skill-paths-');
    const normalize = (file: string) =>
      platform === 'win32' ? paths.normalize(file).toLowerCase() : paths.normalize(file);
    const owned = new Map([
      [normalize(selected), path.join(root, 'selected')],
      [normalize(alias), path.join(root, platform === 'win32' ? 'selected' : 'alias')],
    ]);
    const unmapped: string[] = [];
    const canonical = (file: string) => {
      const target = owned.get(normalize(file));
      if (!target) {
        unmapped.push(file);
        throw new Error('Unmapped fixture path.');
      }
      return target;
    };
    const config = {
      config: {
        skills: {
          config: [
            { path: selected, enabled: true },
            { path: alias, enabled: true },
          ],
        },
      },
      layers: [],
      origins: {},
    };
    assert.equal(
      codexSkillConfiguration(
        config,
        { requirements: null },
        { ...release, codexDefinition: selected },
        { platform, canonical },
      ),
      platform !== 'win32',
    );
    assert.deepEqual(unmapped, []);
  },
);

// Inherited Node redirection changes hook execution without changing skill availability.
test.each(['win32', 'darwin', 'linux'] as const)(
  'hook environment admission retains %s native names and refuses Node redirection',
  (platform) => {
    const ordinary = { PATH: '/external', ELECTRON_RUN_AS_NODE: '1' };
    assert.deepEqual(sessionHookEnvironment(ordinary, platform), ordinary);
    for (const value of ['--require /preload.cjs', '--invalid-option']) {
      assert.equal(sessionHookEnvironment({ ...ordinary, NODE_OPTIONS: value }, platform), undefined);
      assert.equal(sessionHookEnvironment({ ...ordinary, NODE_PATH: '/modules' }, platform), undefined);
    }
    assert.equal(sessionHookEnvironment({ ...ordinary, NODE_EXTRA_CA_CERTS: '/custom' }, platform), undefined);
    const mixed = { ...ordinary, nOdE_oPtIoNs: '--require /preload.cjs' };
    assert.equal(!!sessionHookEnvironment(mixed, platform), platform !== 'win32');
    assert.equal(!!sessionHookEnvironment({ ...ordinary, Path: '/other' }, platform), platform !== 'win32');
    assert.equal(
      !!sessionHookEnvironment({ ...ordinary, NODE_OPTIONS: '', node_options: '--preload' }, platform),
      platform !== 'win32',
    );
  },
);
