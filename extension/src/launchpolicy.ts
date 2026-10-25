import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface LaunchPolicy {
  readonly readOnly: true;
  readonly readTools: readonly string[];
}

const codexModelShorthands: Readonly<Record<string, string>> = {
  sol: 'gpt-6.1-sol',
  sol6: 'gpt-6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-6-luna',
  luna6: 'gpt-6-luna',
  astra: 'gpt-6-astra',
};

// Claude Code reads its prompt cache lifetime from this variable. A Claude launch can request one of these values.
export const CACHE_TTL_ENV = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
export const CACHE_LIFETIMES = ['5m', '1h'] as const;
export type RequestedCacheLifetime = (typeof CACHE_LIFETIMES)[number];

export function isCacheLifetime(value: unknown): value is RequestedCacheLifetime {
  return (CACHE_LIFETIMES as readonly unknown[]).includes(value);
}

// Returns the refusal for a requested cache lifetime, or null when the launch accepts it.
export function cacheLifetimeRefusal(value: string, agent: string): string | null {
  if (!isCacheLifetime(value)) return 'Choose --cache-lifetime 5m or 1h.';
  return agent === 'claude' ? null : '--cache-lifetime applies only to Claude launches.';
}

// Returns the cache lifetime a Claude launch sets, or null to keep the inherited environment and provider default.
// A requested lifetime replaces an inherited value. Without one, delegated work gets 5m unless the environment names a lifetime.
export function claudeCacheLifetime(
  inherited: Record<string, string | undefined>,
  requested: RequestedCacheLifetime | undefined,
  agentRun: boolean,
): RequestedCacheLifetime | null {
  if (requested) return requested;
  return agentRun && !Object.keys(inherited).some((key) => key.toUpperCase() === CACHE_TTL_ENV) ? '5m' : null;
}

export function standaloneModel(agent: 'claude' | 'codex', model: string, env: NodeJS.ProcessEnv): string {
  if (agent === 'claude') return model === 'haiku' ? 'claude-haiku-5-5' : model;
  const resolved = Object.hasOwn(codexModelShorthands, model) ? codexModelShorthands[model] : model;
  let provider: string | undefined;
  try {
    const config = readFileSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8');
    for (const line of config.split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped.startsWith('[')) break;
      const match = /^model_provider\s*=\s*['"]([^'"]+)['"]/.exec(stripped);
      if (match) {
        provider = match[1];
        break;
      }
    }
  } catch {
    // An unavailable config retains the provider's unprefixed model name.
  }
  return provider === 'amazon-bedrock' && resolved.startsWith('gpt-') ? `openai.${resolved}` : resolved;
}

export function launchPolicy(
  agent: string,
  readOnly: boolean,
  readTools: readonly string[] = [],
  permission = '',
): LaunchPolicy | undefined {
  if (!readOnly) {
    if (readTools.length) throw new Error('--read-tool requires Claude --read-only.');
    return undefined;
  }
  if (permission) throw new Error('--read-only cannot combine with a permission override.');
  if (readTools.length && agent !== 'claude') throw new Error('--read-tool requires Claude --read-only.');
  if (
    readTools.length > 20 ||
    readTools.some(
      (tool) =>
        typeof tool !== 'string' || tool.length > 200 || !/^mcp__[A-Za-z0-9_.:-]+__[A-Za-z0-9_.:-]+$/.test(tool),
    )
  )
    throw new Error('--read-tool must name one exact MCP tool.');
  return Object.freeze({ readOnly: true, readTools: Object.freeze([...readTools]) });
}

export function claudeAutoMode(model = ''): boolean {
  const name = model.toLowerCase();
  if (name === 'haiku' || /haiku-5-5(?:$|[-.[:])/.test(name)) return true;
  if (name.includes('haiku') || name.includes('claude-3')) return false;
  const match = /(?:opus|sonnet)-4(?:[-.]([0-9]+))?/.exec(name);
  return !match || (!!match[1] && match[1].length < 8 && Number(match[1]) >= 6);
}

const deniedTools = [
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'CronCreate',
  'CronDelete',
  'DesignSync',
  'EnterWorktree',
  'ExitWorktree',
  'PushNotification',
  'RemoteTrigger',
  'ScheduleWakeup',
  'SendMessage',
  'ShareOnboardingGuide',
  'TaskStop',
];
const deniedGitVerbs = [
  'add',
  'am',
  'apply',
  'archive',
  'bisect',
  'bundle',
  'checkout',
  'checkout-index',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'commit-tree',
  'config',
  'credential',
  'fast-import',
  'fetch',
  'filter-branch',
  'format-patch',
  'gc',
  'hash-object',
  'init',
  'maintenance',
  'merge',
  'merge-file',
  'mergetool',
  'mktag',
  'mktree',
  'mv',
  'pack-refs',
  'prune',
  'pull',
  'push',
  'read-tree',
  'rebase',
  'reflog delete',
  'reflog expire',
  'repack',
  'replace',
  'rerere',
  'reset',
  'restore',
  'revert',
  'rm',
  'sparse-checkout',
  'stash',
  'submodule',
  'switch',
  'symbolic-ref',
  'update-index',
  'update-ref',
  'worktree add',
  'worktree lock',
  'worktree move',
  'worktree prune',
  'worktree remove',
  'worktree repair',
  'worktree unlock',
  'write-tree',
];

export function claudeReadOnlyMcp(policy: LaunchPolicy, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const read = (file: string): Record<string, any> => {
    try {
      if (statSync(file).size > 4 * 1024 * 1024) throw new Error('oversized configuration');
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`MCP server configuration is unreadable: ${file}`, { cause: error });
    }
  };
  let project = resolve(cwd);
  while (!existsSync(join(project, '.git')) && dirname(project) !== project) project = dirname(project);
  if (!existsSync(join(project, '.git'))) project = resolve(cwd);
  const config = read(
    env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'),
  );
  const projectConfig = read(join(project, '.mcp.json'));
  const local = config.projects?.[project.replace(/\\/g, '/')] ?? config.projects?.[project];
  const servers = { ...config.mcpServers, ...projectConfig.mcpServers, ...local?.mcpServers };
  const selected: Record<string, unknown> = {};
  for (const tool of policy.readTools) {
    const name = tool.slice(5, tool.lastIndexOf('__'));
    if (!servers[name]) throw new Error(`MCP server ${name} is unavailable for the requested read tool.`);
    selected[name] = servers[name];
  }
  return JSON.stringify({ mcpServers: selected });
}

export function claudeReadOnlyArgs(policy: LaunchPolicy, model = '', mcpConfig?: string): string[] {
  const mcp = policy.readTools.length > 0;
  const denied = mcp
    ? ['Bash', 'PowerShell', ...deniedTools]
    : [
        'PowerShell',
        ...deniedTools,
        ...deniedGitVerbs.flatMap((verb) => [
          `Bash(git ${verb})`,
          `Bash(git ${verb} *)`,
          `Bash(git -C * ${verb})`,
          `Bash(git -C * ${verb} *)`,
        ]),
        ...['branch', 'notes', 'remote', 'tag'].flatMap((verb) => [`Bash(git ${verb} *)`, `Bash(git -C * ${verb} *)`]),
        'Bash(git * --output*)',
      ];
  return [
    '--permission-mode',
    mcp || !claudeAutoMode(model) ? 'dontAsk' : 'auto',
    '--permission-prompts',
    'none',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    ...(mcp ? ['--mcp-config', mcpConfig ?? '{"mcpServers":{}}'] : []),
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    ...policy.readTools,
    '--disallowedTools',
    ...denied,
  ];
}

export function refusePolicyChange(session?: string): never {
  throw new Error(
    `${session ? `Session ${session}` : 'This session'} keeps its read-only launch permissions. Start a new session to choose other permissions.`,
  );
}
