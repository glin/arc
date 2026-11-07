import path from 'node:path';
import { arcHome } from '../../extension/src/store.ts';
import {
  readUsageRecords,
  USAGE_STORE_DIRECTORY,
  type UsageReadProblem,
  type UsageRecordLine,
} from '../../extension/src/usagerecord.ts';

declare const ARC_BUILD_COMMIT: string;

const AGENTS = ['claude', 'codex'];

function newer(held: UsageRecordLine | undefined, record: UsageRecordLine): boolean {
  if (!held) return true;
  if (held.complete !== record.complete) return record.complete;
  return record.readAt >= held.readAt;
}

interface SavedUsage {
  readings: UsageRecordLine[];
  readSlots: number;
  problems: UsageReadProblem[];
}

// The newest complete reading of each agent, window, and scope, or the newest reading when none is complete.
export async function savedUsage(home: string, agent?: string): Promise<SavedUsage> {
  const newest = new Map<string, UsageRecordLine>();
  const { readSlots, problems } = await readUsageRecords(path.join(home, 'usage', USAGE_STORE_DIRECTORY), (record) => {
    if (!record.window || (agent && record.agent !== agent)) return;
    const key = JSON.stringify([record.agent, record.window, record.scope]);
    if (newer(newest.get(key), record)) newest.set(key, record);
  });
  const readings = [...newest.values()].sort(
    (a, b) => a.agent.localeCompare(b.agent) || a.window.localeCompare(b.window) || a.scope.localeCompare(b.scope),
  );
  return { readings, readSlots, problems };
}

function span(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts = days ? [`${days}d`, `${hours}h`] : hours ? [`${hours}h`, `${minutes % 60}m`] : [`${minutes}m`];
  return ms >= 0 ? `in ${parts.join(' ')}` : `${parts.join(' ')} ago`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function usageText(records: UsageRecordLine[], now: number): string {
  const label = (value: string) => JSON.stringify(value).slice(1, -1);
  const cells = [
    ['Agent', 'Window', 'Used', 'Resets', 'Read'],
    ...records.map((record) => [
      label(record.agent),
      label(record.scope ? `${record.window} ${record.scope}` : record.window),
      record.utilization === null ? 'unknown' : `${Number((record.utilization * 100).toFixed(1))}%`,
      record.resetsAt === null ? 'unknown' : `${iso(record.resetsAt * 1000)} (${span(record.resetsAt * 1000 - now)})`,
      `${iso(record.readAt)} (${span(record.readAt - now)})${record.complete ? '' : ' incomplete'}`,
    ]),
  ];
  const widths = cells[0].map((_, column) => Math.max(...cells.map((cell) => cell[column].length)));
  return cells
    .map((cell) =>
      cell
        .map((value, column) => (column === 2 ? value.padStart(widths[2]) : value.padEnd(widths[column])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function problemText(directory: string, problems: UsageReadProblem[]): string {
  return [`Problems in ${directory}:`, ...problems.map(({ file, message }) => `  ${file}: ${message}.`)].join('\n');
}

// Exits 1 only when the store has problems and no slot could be read.
export async function runUsage(
  args: string[],
  now: () => number = Date.now,
): Promise<{ output: string; status: number }> {
  let json = false;
  let agent: string | undefined;
  let home: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--agent' || arg === '--home') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--agent') {
        if (!AGENTS.includes(value)) throw new Error('--agent must be claude or codex.');
        agent = value;
      } else home = value;
      continue;
    }
    throw new Error(`Unknown usage option: ${arg}`);
  }
  const root = path.resolve(home ?? arcHome());
  const directory = path.join(root, 'usage', USAGE_STORE_DIRECTORY);
  const { readings, readSlots, problems } = await savedUsage(root, agent);
  const status = problems.length && !readSlots ? 1 : 0;
  if (json) {
    const output = JSON.stringify({
      schemaVersion: 1,
      buildCommit: typeof ARC_BUILD_COMMIT === 'string' ? ARC_BUILD_COMMIT : 'unknown',
      directory,
      readings: readings.map(({ v: _v, ...record }) => record),
      problems,
    });
    return { output, status };
  }
  const parts = readings.length ? [usageText(readings, now())] : [];
  if (problems.length) parts.push(problemText(directory, problems));
  else if (!readings.length)
    parts.push(`No saved ${agent ? `${agent} ` : ''}usage exists in ${directory}, where Arc saves usage readings.`);
  return { output: parts.join('\n\n'), status };
}
