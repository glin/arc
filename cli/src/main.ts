import { renderNextTurn, renderStatus, snapshotFromClaude } from './status.ts';
import { runCost } from './cost.ts';
import { runWindows } from './windows.ts';
import { runSessions } from './sessions.ts';
import { runManagement } from './manage.ts';
import { runCompact } from './compact.ts';
import { findCommand, renderCommandHelp, renderOverviewHelp } from './commands.ts';
import { runSkills } from './skills.ts';

declare const ARC_VERSION: string;

// The build sets `ARC_VERSION` from the package manifest.
const VERSION = typeof ARC_VERSION === 'string' ? ARC_VERSION : 'unknown';

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
  const command = findCommand(args);
  if (args.includes('--help') || args[0] === 'help' || args.length === 0) {
    process.stdout.write(`${command ? renderCommandHelp(command) : renderOverviewHelp()}\n`);
    return;
  }
  if (!command) throw new Error(`Unknown command: ${args[0]}`);
  const commandArgs = args.slice(command.name.split(' ').length);
  switch (command.route) {
    case 'skills':
      await runSkills(command.action!, commandArgs);
      return;
    case 'cost':
      process.stdout.write(`${runCost(commandArgs)}\n`);
      return;
    case 'windows':
      process.stdout.write(`${await runWindows(commandArgs)}\n`);
      return;
    case 'compact':
      process.stdout.write(`${await runCompact(args.slice(1))}\n`);
      return;
    case 'sessions':
      process.stdout.write(`${await runSessions(command.name as 'sessions' | 'session' | 'filter', commandArgs)}\n`);
      return;
    case 'management':
      process.stdout.write(`${await runManagement(command.action!, commandArgs)}\n`);
      return;
    case 'label':
      throw new Error(`Unknown command: ${args[0]}`);
    case 'statusline':
      break;
    default: {
      const unhandled: never = command.route;
      throw new Error(`Unknown command route: ${unhandled}`);
    }
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
  process.stderr.write(`arc: ${message}\n`);
  process.exitCode ||= 1;
});
