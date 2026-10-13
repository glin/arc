import { test } from 'vitest';
import assert from 'node:assert';
import { claudeReadOnlyArgs, claudeReadOnlyMcp, launchPolicy } from './launchpolicy';
import { claudePlan } from './agenthost';
import { LaunchPolicyStore } from './launchpolicystore';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './temproot';

test('read-only policy refuses incompatible permissions and misplaced or wildcard MCP tools', () => {
  for (const [agent, readOnly, tools, permission] of [
    ['claude', true, [], 'bypassPermissions'],
    ['codex', true, ['mcp__server__read'], ''],
    ['claude', false, ['mcp__server__read'], ''],
    ['claude', true, ['mcp__server__*'], ''],
    ['claude', true, ['mcp__server__read Bash'], ''],
  ] as const)
    assert.throws(() => launchPolicy(agent, readOnly, tools, permission));
});

test('exact MCP reads deny both shells while isolating permission settings', () => {
  const policy = launchPolicy('claude', true, ['mcp__server__read'])!;
  const args = claudeReadOnlyArgs(policy, 'opus');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('Bash'));
  assert.ok(args.includes('PowerShell'));
  assert.ok(args.includes('mcp__server__read'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args.includes('--strict-mcp-config'), true);
  assert.ok(args.includes('{"disableAllHooks":true}'));
});

test.each(['claude-3-opus', 'claude-sonnet-4-20250514', 'claude-opus-4-5', 'haiku-4-5'])(
  'older Claude model %s does not receive auto permission mode',
  (model) => {
    const args = claudeReadOnlyArgs(launchPolicy('claude', true)!, model);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  },
);

test('read-only Claude preserves executable, environment and requested settings', () => {
  const launch = {
    command: 'custom-cli',
    leadingArgs: ['custom-script'],
    env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CUSTOM: 'kept' },
  };
  const plan = claudePlan(launch, {
    cwd: '/review',
    model: 'opus',
    effort: 'high',
    sessionId: 'review',
    policy: launchPolicy('claude', true),
    agentRun: true,
  });
  assert.equal(plan.command, 'custom-cli');
  assert.equal(plan.args[0], 'custom-script');
  assert.equal(plan.env.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
  assert.equal(plan.env.CUSTOM, 'kept');
  assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'opus');
  assert.equal(plan.args[plan.args.indexOf('--effort') + 1], 'high');
});

test('independent windows retain authoritative restrictions without reading or rewriting other sessions', () => {
  const root = tempDir('arc-policies-');
  try {
    const first = new LaunchPolicyStore(root);
    const second = new LaunchPolicyStore(root);
    const policy = launchPolicy('claude', true, ['mcp__notes__read'])!;
    first.write('session', policy);
    for (let index = 0; index < 100; index++) first.write(`other-${index}`, policy);
    assert.deepEqual(second.read('session'), policy);
    const files = fs
      .readdirSync(root)
      .flatMap((folder) => fs.readdirSync(path.join(root, folder)).map((file) => path.join(root, folder, file)));
    const owned = files.find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).session === 'session')!;
    fs.writeFileSync(owned, '{broken');
    assert.throws(() => second.read('session'), /unreadable/);
    assert.throws(() => second.write('session', policy), /unreadable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exact MCP copies selected definitions with local precedence and excludes inherited grants and hooks', () => {
  const root = tempDir('arc-mcp-policy-');
  try {
    const project = path.join(root, 'Project');
    const config = path.join(root, 'config');
    fs.mkdirSync(project);
    fs.mkdirSync(config);
    fs.mkdirSync(path.join(project, '.git'));
    const nested = path.join(project, 'Nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(
      path.join(config, '.claude.json'),
      JSON.stringify({
        mcpServers: { notes: { command: 'user' }, foreign: { command: 'other' } },
        projects: { [project.replaceAll('\\', '/')]: { mcpServers: { notes: { command: 'local' } } } },
        permissions: { allow: ['mcp__notes__*'] },
        hooks: { SessionStart: [] },
      }),
    );
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { notes: { command: 'project' } } }),
    );
    const policy = launchPolicy('claude', true, ['mcp__notes__read'])!;
    const serialized = claudeReadOnlyMcp(policy, nested, { CLAUDE_CONFIG_DIR: config });
    assert.deepEqual(JSON.parse(serialized), { mcpServers: { notes: { command: 'local' } } });
    const plan = claudePlan(
      { command: 'custom', leadingArgs: [], env: { CLAUDE_CONFIG_DIR: config } },
      { cwd: nested, policy },
    );
    assert.equal(plan.args[plan.args.indexOf('--mcp-config') + 1], serialized);
    assert.equal(plan.args[plan.args.indexOf('--setting-sources') + 1], '');
    assert.ok(plan.args.includes('{"disableAllHooks":true}'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
