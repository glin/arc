import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function skillFiles(directory: string) {
  return fs
    .readdirSync(directory, { recursive: true })
    .map(String)
    .filter((file) => fs.statSync(join(directory, file)).isFile())
    .map((file) => file.split(sep).join('/'))
    .sort();
}
const collectWindow = 'a'.repeat(24);
const collectRow = (source: string, id = source, extra: Record<string, unknown> = {}) => ({
  source,
  id,
  provider: 'claude',
  ambiguous: false,
  truncated: [],
  attention: 'unknown',
  ...extra,
});
const collectPage = (sessions: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  version: 1,
  requester: null,
  sessions,
  complete: true,
  notes: [],
  next: null,
  coverage: 'complete',
  freshness: 'current',
  ...extra,
});
const collectTurns = (id: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  requester: null,
  id,
  provider: 'claude',
  state: 'current',
  turns: [],
  partial: true,
  readByteLimit: 524288,
  notes: ['bounded'],
  ...extra,
});
const collectArgs = ['--window', collectWindow];

const fixture = JSON.parse(readFileSync(new URL('./fixtures/warm.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
fixture.prompt_cache.expires_at = Math.ceil(Date.now() / 1000) + 300;
const input = JSON.stringify(fixture);
const cli = fileURLToPath(new URL('../dist/arc.cjs', import.meta.url));
let version: string | undefined;
function expectedVersion() {
  return (version ??= execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim());
}
const smokeEnv = {
  ...process.env,
  CLAUDE_CODE_SESSION_ID: '',
  CODEX_THREAD_ID: '',
  TERM_PROGRAM: '',
  VSCODE_PID: '',
  VSCODE_IPC_HOOK_CLI: '',
};

const setupReply = {
  version: 1,
  project: '/project',
  primary: 'recent:0',
  setups: [
    { key: 'recent:0', provider: 'claude', model: 'opus', effort: 'high' },
    { key: 'pin:stored', provider: 'codex', model: 'retired', missingValue: 'model' },
    { key: 'recent:1', provider: 'codex' },
  ],
  agents: [
    {
      provider: 'claude',
      models: [
        { value: '', efforts: ['', 'low', 'high'] },
        { value: 'default', efforts: ['', 'low'] },
        { value: 'opus', efforts: ['', 'high'] },
        { value: 'claude-opus-full', efforts: ['', 'high'] },
      ],
      permissions: ['', 'auto', 'manual', 'acceptEdits', 'plan'],
    },
    {
      provider: 'codex',
      models: [
        { value: '', efforts: ['', 'medium', 'high'] },
        { value: 'codex-alias', efforts: ['', 'medium', 'high'] },
        { value: 'codex-full', efforts: ['', 'medium', 'high'] },
      ],
      permissions: ['', 'read-only', 'untrusted', 'on-request', 'never'],
    },
  ],
};

export {
  skillFiles,
  collectWindow,
  collectRow,
  collectPage,
  collectTurns,
  collectArgs,
  fixture,
  packageJson,
  input,
  cli,
  expectedVersion,
  smokeEnv,
  setupReply,
};
