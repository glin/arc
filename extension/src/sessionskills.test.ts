import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot';
import { canonicalToolPath } from './toolownership';
import { childEnv } from './agenthost';
import {
  admitClaudeSessionSkill,
  claudeNativeSkillSettings,
  claudeSkillHome,
  codexRawSkills,
  codexSkillConfiguration,
  type SessionSkillRelease,
} from './sessionskills';

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

test('Claude reads matching manual directory links and refuses changed linked resources', () => {
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
  const mapped = (file: string) =>
    path.relative(root, file).startsWith('..') ? path.join(root, 'absent', Buffer.from(file).toString('hex')) : file;
  const input = {
    cwd,
    home,
    args: [],
    env: {},
    release: { ...release, claudeDefinition: path.join(payload, 'SKILL.md') },
    read: (file: string) => {
      const owned = mapped(file);
      try {
        return fs.readFileSync(owned, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    list: (file: string) => {
      const owned = mapped(file);
      try {
        return fs.readdirSync(owned);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    canonical: (file: string) => canonicalToolPath(mapped(file)),
  };
  assert.equal(admitClaudeSessionSkill(input), true);
  fs.writeFileSync(path.join(target, 'details.md'), 'custom instructions');
  assert.equal(admitClaudeSessionSkill(input), false);
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
      for (const tail of ['settings.json', 'settings.local.json', 'skills/arc-sessions/SKILL.md', 'skills'])
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
    fs.mkdirSync(owned(managed));
    const mixedManaged = path.join(owned(managed), 'Managed-Settings.d');
    fs.mkdirSync(mixedManaged);
    fs.writeFileSync(path.join(mixedManaged, '10-policy.json'), '{}');
    assert.equal(admitClaudeSessionSkill(input), platform !== 'win32');
    fs.unlinkSync(path.join(mixedManaged, '10-policy.json'));
    fs.rmdirSync(mixedManaged);
    assert.deepEqual(unmapped, []);
    write(definition, 'matching skill');
    assert.equal(admitClaudeSessionSkill(input), true);
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
