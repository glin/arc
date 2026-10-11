import { renderNextTurn, renderStatus, snapshotFromClaude } from './status.ts';
import { runCost } from './cost.ts';
import { runWindows } from './windows.ts';
import { runSessions } from './sessions.ts';
import { runManagement } from './manage.ts';
import { runCompact } from './compact.ts';

declare const ARC_VERSION: string;

// The build sets `ARC_VERSION` from the package manifest.
const VERSION = typeof ARC_VERSION === 'string' ? ARC_VERSION : 'unknown';

function help(): string {
  return [
    'Usage: arc statusline [--json | --next-turn] [--width COLUMNS]',
    '       arc windows [--json]',
    '       arc compact request --self --after-turn --request-id WINDOW:UUID --window WINDOW --json',
    '       arc compact status --request-id WINDOW:UUID --window WINDOW --json',
    '       arc sessions [--window ID] [--limit 1-128] [--cursor CURSOR] [--json]',
    '       arc session ID [--turns 1-20] [--window ID] [--json]',
    '       arc setups [--window ID] [--json]',
    '       arc start --prompt-file PATH (--setup KEY | --provider claude|codex [--model MODEL] [--effort EFFORT] [--permissions MODE]) (--agent-run | --untagged) [--name NAME] [--label NAME] [--pinned] [--arc-dispatch] [--window ID] [--request-id ID]',
    '       arc label add|remove ID --label NAME [--dry-run] [--window ID] [--request-id ID]',
    '       arc pin|unpin|archive|unarchive ID [--dry-run] [--window ID] [--request-id ID]',
    '       arc archive ID --force [--window ID] [--request-id ID]',
    '       arc send ID --prompt-file PATH --observation OBSERVATION --request-id ID [--window ID] [--json]',
    '       arc cost TARGET [--since TIME] [--until TIME] [--projects PATH] [--codex-sessions PATH] [--by-model] [--source-only] [--by-tool-kind] [--until-text REGEX] [--window-agent ID] [--json]',
    '',
    'Reads Claude Code status-line JSON from stdin.',
    'Text output includes context, prompt-cache state, next-turn starting price, session cost, and account limits.',
    'Cost reads one transcript and its children. It prints JSON by default.',
    '--source-only reads an exact transcript file path without discovering children.',
    '--by-model adds billing subtotals for each model to the parent and child sources.',
    'Windows lists running Arc windows and their panel and repository readiness.',
    "Sessions lists one page of the selected window's repository sessions as JSON. Pass its next value to --cursor for the following page.",
    'Session reads bounded turns without marking them read.',
    '--window selects an Arc window. Otherwise ARC_WINDOW or one unambiguous live window selects it.',
    '--request-id accepts a fresh ID prefixed with the selected window hostId and a colon.',
    'Start and curation accept identical-payload retries in that window activation. Old activation IDs have an unknown outcome after reload.',
    'Never retry a compaction request with uncertain admission.',
    'Send delivers a follow-up to an idle session that the calling session started with --arc-dispatch in that window. The observation comes from arc session --json.',
  ].join('\n');
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}

function widthFrom(args: string[]): number {
  const index = args.indexOf('--width');
  const raw = index >= 0 ? args[index + 1] : process.env.COLUMNS;
  const width = raw ? Number(raw) : Number.POSITIVE_INFINITY;
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : Number.POSITIVE_INFINITY;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args[0] === 'help' || args.length === 0) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args[0] === 'cost') {
    process.stdout.write(`${runCost(args.slice(1))}\n`);
    return;
  }
  if (args[0] === 'windows') {
    process.stdout.write(`${await runWindows(args.slice(1))}\n`);
    return;
  }
  if (args[0] === 'compact') {
    process.stdout.write(`${await runCompact(args.slice(1))}\n`);
    return;
  }
  if (args[0] === 'sessions' || args[0] === 'session') {
    process.stdout.write(`${await runSessions(args[0], args.slice(1))}\n`);
    return;
  }
  if (['setups', 'start', 'send', 'pin', 'unpin', 'archive', 'unarchive'].includes(args[0])) {
    process.stdout.write(`${await runManagement(args[0], args.slice(1))}\n`);
    return;
  }
  if (args[0] === 'label' && ['add', 'remove'].includes(args[1])) {
    process.stdout.write(`${await runManagement(`label-${args[1]}`, args.slice(2))}\n`);
    return;
  }
  if (args[0] !== 'statusline') {
    throw new Error(`Unknown command: ${args[0]}`);
  }

  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error('Claude status input is empty.');
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Claude status input is not valid JSON.');
  }
  const snapshot = snapshotFromClaude(input);
  const json = args.includes('--json');
  const nextTurn = args.includes('--next-turn');
  if (json && nextTurn) {
    throw new Error('--json and --next-turn cannot be used together.');
  }
  const output = json
    ? JSON.stringify(snapshot)
    : nextTurn
      ? renderNextTurn(snapshot)
      : renderStatus(snapshot, widthFrom(args));
  process.stdout.write(`${output}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`arc-status: ${message}\n`);
  process.exitCode = 1;
});
