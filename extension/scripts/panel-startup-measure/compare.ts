// Measure two builds on one frozen fixture, in series, and fail past a margin.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { arcHome } from '../../src/store.ts';
import { REQUIRED_DISCOVERY_MEASURES } from './soak';

// A candidate regresses when its value exceeds the baseline by this ratio and by the floor of its kind.
export const MARGINS = { time: 1.5, count: 1.5, bytes: 1.5, memory: 1.25 } as const;
// Differences below these floors are noise on a shared machine, whatever their ratio.
export const FLOORS = { time: 1000, count: 5, bytes: 1024 * 1024, memory: 64 * 1024 * 1024 } as const;
type Kind = keyof typeof MARGINS;

export interface Measure {
  name: string;
  kind: Kind;
  baseline: number | null;
  candidate: number | null;
  ratio: number | null;
  margin: number;
  // A bounded row compares the candidate with its bound, and a report-only row never regresses.
  bound: Bound | null;
  reportOnly: boolean;
  regressed: boolean;
}

// The candidate must stay at or under a limit, and at or over a floor, in every repetition.
export interface Bound {
  limit?: number;
  floor?: number;
}

export type Bounds = Record<string, Bound>;

// A measure's own ratio from `--margin`. It replaces the class margin for that row and applies no floor.
export type Margins = Record<string, number>;

interface RunResult {
  source?: string;
  complete?: boolean;
  note?: string | null;
  startupRecord?: { stages?: Record<string, number> } | null;
  memory?: { peakWorkingSetBytes?: number | null; sampledMaximumWorkingSetBytes?: number | null };
  soak?: { end?: Record<string, number> | null };
  // The snapshot that the runner takes after a `--warm-until` hold ends.
  warmUp?: { hold?: { snapshot?: Record<string, number> | null } | null } | null;
  // The measures the runner computes from files after the editor exits.
  runner?: Record<string, number> | null;
}

const COUNTS = new Set([
  'publications',
  'partialPublications',
  'continuations',
  'dispatchSpendVisits',
  'dispatchSpendRootRestarts',
  'catalogWalks',
  'compressedRows',
  'compressedDecodes',
  'compressedPending',
  'compressedTempEntries',
]);
const BYTES = new Set(['dispatchSpendBytes', 'readBytes', 'compressedStoreWriteBytes', 'compressedStoreBytes']);
// Measures that the report shows and the comparison gates only through a bound. Every row whose name starts with a
// prefix of `REPORT_ONLY_PREFIXES` is report-only too.
export const REPORT_ONLY = new Set([
  'loopDelayMaxMs',
  'loopDelayP99Ms',
  'compressedLoadMs',
  'backfillMs',
  'compressedStoreWriteBytes',
  'compressedStoreBytes',
  'refreshCount:compressed-facts',
]);
export const REPORT_ONLY_PREFIXES = ['refreshMs:', 'refreshMaxMs:'] as const;

export function isReportOnly(name: string): boolean {
  return REPORT_ONLY.has(name) || REPORT_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function kindOf(name: string): Kind {
  return COUNTS.has(name) || name.startsWith('refreshCount:') ? 'count' : BYTES.has(name) ? 'bytes' : 'time';
}

// The refresh rows that the comparison reads from the hold snapshot when the run holds, and from the end snapshot of
// the measured launch otherwise.
export function readFromHold(name: string): boolean {
  return name.startsWith('refreshMs:') || name.startsWith('refreshMaxMs:') || name === 'refreshCount:compressed-facts';
}

// Read the comparison's measures from one runner result.
export function measuresOf(result: RunResult): Map<string, { kind: Kind; value: number | null }> {
  const out = new Map<string, { kind: Kind; value: number | null }>();
  // Both startup times come from the measured host's startup record, so every value shares the host's clock origin.
  out.set('firstUsableRowMs', { kind: 'time', value: result.startupRecord?.stages?.firstUsableRow ?? null });
  out.set('firstPassMs', { kind: 'time', value: result.startupRecord?.stages?.completeRender ?? null });
  for (const [name, value] of Object.entries(result.runner ?? {})) out.set(name, { kind: kindOf(name), value });
  const hold = result.warmUp?.hold?.snapshot ?? null;
  for (const [name, value] of Object.entries(result.soak?.end ?? {}))
    if (!hold || !readFromHold(name)) out.set(name, { kind: kindOf(name), value });
  for (const [name, value] of Object.entries(hold ?? {}))
    if (readFromHold(name)) out.set(name, { kind: kindOf(name), value });
  out.set('peakHostMemoryBytes', {
    kind: 'memory',
    value: result.memory?.peakWorkingSetBytes ?? result.memory?.sampledMaximumWorkingSetBytes ?? null,
  });
  return out;
}

// The measures each side must report. A missing one makes the comparison incomplete instead of within its margin.
// A refresh reason may be absent on one side, because a build can run no refresh for that reason.
export const REQUIRED_MEASURES = [
  'firstUsableRowMs',
  'firstPassMs',
  'peakHostMemoryBytes',
  ...REQUIRED_DISCOVERY_MEASURES,
];

// Every repetition must report each required measure, each bounded measure and each measure with its own margin. A
// non-finite value counts as missing.
export function missingMeasures(result: RunResult | RunResult[], bounds: Bounds = {}, margins: Margins = {}): string[] {
  const runs = Array.isArray(result) ? result : [result];
  const required = [...new Set([...REQUIRED_MEASURES, ...Object.keys(bounds), ...Object.keys(margins)])];
  return required.filter((name) => runs.some((run) => !Number.isFinite(measuresOf(run).get(name)?.value ?? NaN)));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function past(value: number, bound: Bound): number {
  if (bound.limit !== undefined && value > bound.limit) return value - bound.limit;
  if (bound.floor !== undefined && value < bound.floor) return bound.floor - value;
  return 0;
}

// Compare the medians of each side's repetitions. A bounded row compares every candidate repetition with its bound,
// and reports the repetition farthest past it, or the median when every repetition holds.
export function compareResults(
  baseline: RunResult | RunResult[],
  candidate: RunResult | RunResult[],
  bounds: Bounds = {},
  margins: Margins = {},
): Measure[] {
  const values = (runs: RunResult | RunResult[]) => {
    const out = new Map<string, { kind: Kind; values: number[] }>();
    for (const run of Array.isArray(runs) ? runs : [runs])
      for (const [name, { kind, value }] of measuresOf(run)) {
        const entry = out.get(name) ?? { kind, values: [] };
        if (value !== null && Number.isFinite(value)) entry.values.push(value);
        out.set(name, entry);
      }
    return out;
  };
  const before = values(baseline);
  const after = values(candidate);
  const candidates = Array.isArray(candidate) ? candidate.length : 1;
  const names = [...new Set([...before.keys(), ...after.keys(), ...Object.keys(bounds)])];
  return names.map((name) => {
    const kind = (before.get(name) ?? after.get(name))?.kind ?? kindOf(name);
    const a = median(before.get(name)?.values ?? []);
    const runs = after.get(name)?.values ?? [];
    const bound = bounds[name] ?? null;
    const worst = bound
      ? runs.reduce((held, value) => (past(value, bound) > past(held, bound) ? value : held), runs[0])
      : 0;
    const outside = bound !== null && runs.length > 0 && past(worst, bound) > 0;
    const b = outside ? worst : median(runs);
    const ratio = a !== null && b !== null ? (a === 0 ? (b === 0 ? 1 : Infinity) : b / a) : null;
    const own = margins[name];
    const margin = own ?? MARGINS[kind];
    const floor = own === undefined ? FLOORS[kind] : 0;
    const reportOnly = !bound && own === undefined && isReportOnly(name);
    // A measure only the candidate reports compares with zero, so a new refresh reason still counts.
    const regressed = bound
      ? outside || runs.length < candidates
      : !reportOnly && b !== null && b - (a ?? 0) > floor && (a === null || a === 0 || b / a > margin);
    return { name, kind, baseline: a, candidate: b, ratio, margin, bound, reportOnly, regressed };
  });
}

// Read each `--margin` value, as `<measure>=<ratio>`. The flag repeats.
export function marginsOf(args: string[]): Margins {
  const margins: Margins = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--margin') continue;
    const match = /^([^=]+)=(.+)$/.exec(args[index + 1] ?? '');
    const ratio = match ? Number(match[2]) : NaN;
    if (!match || !Number.isFinite(ratio) || ratio <= 0) throw new Error('--margin takes <measure>=<ratio>.');
    margins[match[1]] = ratio;
  }
  return margins;
}

// Read each `--limit` and `--floor` value, as `<measure>=<value>`. Either flag repeats.
export function boundsOf(args: string[]): Bounds {
  const bounds: Bounds = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--limit' && flag !== '--floor') continue;
    const match = /^([^=]+)=(.+)$/.exec(args[index + 1] ?? '');
    const value = match ? Number(match[2]) : NaN;
    if (!match || !Number.isFinite(value)) throw new Error(`${flag} takes <measure>=<number>.`);
    bounds[match[1]] = { ...bounds[match[1]], [flag === '--limit' ? 'limit' : 'floor']: value };
  }
  return bounds;
}

export interface Repetition {
  file: string | null;
  scratch: string | null;
  result: RunResult;
}

export type Side = 'baseline' | 'candidate';

// Run the sides in turn, baseline first, `repeat` times each. Each side passes one build directory to every
// repetition, so the runner builds it once. Every repetition runs in its own scratch directory with its own Arc home,
// profile and store. Before each repetition, the runner deletes the scratch of the one before, unless `keep` is set.
export async function runRepetitions(options: {
  repeat: number;
  buildDirectory: (side: Side) => string;
  run: (side: Side, index: number, buildDirectory: string) => Promise<Repetition>;
  keep?: boolean;
  discard?: (scratch: string) => void;
}): Promise<Record<Side, Repetition[]>> {
  const out: Record<Side, Repetition[]> = { baseline: [], candidate: [] };
  let previous: string | null = null;
  for (let index = 0; index < options.repeat; index++)
    for (const side of ['baseline', 'candidate'] as const) {
      if (previous && !options.keep) (options.discard ?? discardScratch)(previous);
      const repetition = await options.run(side, index, options.buildDirectory(side));
      out[side].push(repetition);
      previous = repetition.scratch;
    }
  return out;
}

// The runner removes its build worktree before it exits, so a finished scratch directory holds no link. A scratch
// directory that still holds a build stays.
function discardScratch(scratch: string): void {
  if (!path.basename(scratch).startsWith('arc-startup-measure-') || fs.existsSync(path.join(scratch, 'build'))) return;
  fs.rmSync(scratch, { recursive: true, force: true });
}

function figure(value: number | null, kind: Kind): string {
  if (value === null) return 'not reported';
  if (kind === 'time') return `${(value / 1000).toFixed(1)} s`;
  if (kind === 'bytes' || kind === 'memory') return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return String(value);
}

function boundText(bound: Bound): string {
  return [
    bound.limit !== undefined ? `at most ${bound.limit}` : '',
    bound.floor !== undefined ? `at least ${bound.floor}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export function markdownTable(measures: Measure[], baseline: string, candidate: string): string {
  const rows = measures.map(
    (m) =>
      `| ${m.name} | ${figure(m.baseline, m.kind)} | ${figure(m.candidate, m.kind)} | ${
        m.ratio === null ? 'n/a' : Number.isFinite(m.ratio) ? m.ratio.toFixed(2) : 'new'
      } | ${m.bound ? boundText(m.bound) : m.reportOnly ? 'report only' : m.margin} | ${
        m.regressed ? 'regressed' : m.reportOnly ? 'reported' : 'within'
      } |`,
  );
  return [
    `| Measure | ${baseline} | ${candidate} | Ratio | Margin | Result |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

// The commit of the installed build, from the owner's newest startup history record.
export function installedCommit(
  startup = path.join(arcHome(), 'startup'),
): { commit: string; dirty: boolean; at: string } | null {
  let newest: { commit: string; dirty: boolean; at: string } | null = null;
  try {
    for (const name of fs.readdirSync(startup).filter((entry) => entry.endsWith('.jsonl'))) {
      for (const text of fs.readFileSync(path.join(startup, name), 'utf8').split('\n')) {
        if (!text.trim()) continue;
        const record = JSON.parse(text) as { at?: string; artifact?: { sourceCommit?: string; dirty?: boolean } };
        const commit = record.artifact?.sourceCommit;
        if (commit && record.at && (!newest || record.at > newest.at))
          newest = { commit, dirty: record.artifact?.dirty === true, at: record.at };
      }
    }
  } catch {
    return null;
  }
  return newest;
}

// Run the runner and read its result. A runner that exits nonzero or writes no result yields an incomplete result.
function runMeasure(args: string[], log: string): Promise<Repetition> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '../../node_modules/tsx/dist/cli.mjs'), path.join(__dirname, 'measure.ts'), ...args],
      {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = fs.createWriteStream(log);
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      output.write(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output.write(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code: number | null, signal: string | null) => {
      output.end();
      const scratch = /^Owned paths and artifacts: (.+)$/m.exec(text)?.[1]?.trim();
      const file = scratch ? path.join(scratch, 'result.json') : null;
      let result: RunResult = {};
      try {
        if (file) result = JSON.parse(fs.readFileSync(file, 'utf8')) as RunResult;
      } catch {
        result = {};
      }
      if (code === 0 && file && result.complete === true) resolve({ file, scratch: scratch ?? null, result });
      else
        resolve({
          file: file && fs.existsSync(file) ? file : null,
          scratch: scratch ?? null,
          result: {
            ...result,
            complete: false,
            note: `The runner exited with ${signal ?? String(code)}. ${result.note ?? ''} Read ${log}.`,
          },
        });
    });
  });
}

function write(output: string, report: Record<string, unknown>, table: string): void {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'compare.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'compare.md'), table + '\n');
}

// What a comparison calls outside itself. A test replaces them.
export interface ComparisonDependencies {
  measure?: (args: string[], log: string) => Promise<Repetition>;
  installed?: () => ReturnType<typeof installedCommit>;
  discard?: (scratch: string) => void;
}

// Run one comparison from its command line arguments, and answer the exit status.
export async function runComparison(args: string[], dependencies: ComparisonDependencies = {}): Promise<number> {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const output = path.resolve(value('--output') ?? path.join(os.tmpdir(), `arc-compare-${Date.now()}`));
  const installed = (dependencies.installed ?? installedCommit)();
  const bounds = boundsOf(args);
  const margins = marginsOf(args);
  const repeat = Number(value('--repeat') ?? '1');
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat takes a whole number of repetitions.');
  let baselineResults: RunResult[];
  let candidateResults: RunResult[];
  let baselineLabel: string;
  let candidateLabel: string;
  let fixture: Record<string, unknown> | null = null;
  const results = value('--results');
  if (results) {
    // Compare two saved runner results without launching an editor.
    const [a, b] = [results, args[args.indexOf('--results') + 2]];
    baselineResults = [JSON.parse(fs.readFileSync(a, 'utf8')) as RunResult];
    candidateResults = [JSON.parse(fs.readFileSync(b, 'utf8')) as RunResult];
    baselineLabel = baselineResults[0].source?.slice(0, 9) ?? 'baseline';
    candidateLabel = candidateResults[0].source?.slice(0, 9) ?? 'candidate';
  } else {
    const manifest = value('--fixture');
    const candidate = value('--candidate');
    const baseline = value('--baseline') ?? installed?.commit;
    if (!manifest || !candidate || !baseline)
      throw new Error('Name --fixture and --candidate. Name --baseline when no installed build is recorded.');
    const soak = value('--soak') ?? '10';
    const timeout = value('--timeout') ?? '900';
    // The candidate alone holds its warm-up until each named measure reads its value.
    const warmUntil = args.flatMap((arg, index) =>
      arg === '--warm-until' && args[index + 1] !== undefined ? ['--warm-until', args[index + 1]] : [],
    );
    fs.mkdirSync(output, { recursive: true });
    const manifestText = fs.readFileSync(manifest);
    fixture = {
      manifest: path.resolve(manifest),
      sha256: createHash('sha256').update(manifestText).digest('hex'),
      frozen: (JSON.parse(manifestText.toString('utf8')) as { frozen?: unknown }).frozen ?? null,
    };
    const refs: Record<Side, string> = { baseline, candidate };
    // Each repetition runs its warm-up launch and its measured launch back to back. The builds never overlap.
    const run = async (side: Side, index: number, buildDirectory: string) => {
      const suffix = repeat > 1 ? `-${index + 1}` : '';
      const repetition = await (dependencies.measure ?? runMeasure)(
        [
          '--fixture',
          manifest,
          '--commit',
          refs[side],
          '--warm-up',
          '--soak',
          soak,
          '--timeout',
          timeout,
          '--build-cache',
          buildDirectory,
          ...(side === 'candidate' ? warmUntil : []),
          ...(args.includes('--keep') ? ['--keep'] : []),
        ],
        path.join(output, `${side}${suffix}.log`),
      );
      if (repetition.file) fs.copyFileSync(repetition.file, path.join(output, `${side}-result${suffix}.json`));
      return repetition;
    };
    const repetitions = await runRepetitions({
      repeat,
      buildDirectory: (side) => path.join(output, `${side}-build`),
      run,
      keep: args.includes('--keep'),
      discard: dependencies.discard,
    });
    baselineResults = repetitions.baseline.map((repetition) => repetition.result);
    candidateResults = repetitions.candidate.map((repetition) => repetition.result);
    baselineLabel = baseline.slice(0, 9);
    candidateLabel = candidate.slice(0, 9);
  }
  const measures = compareResults(baselineResults, candidateResults, bounds, margins);
  const missing = {
    baseline: missingMeasures(baselineResults, {}, margins),
    candidate: missingMeasures(candidateResults, bounds, margins),
  };
  // A repetition that fails or times out leaves the comparison incomplete.
  const complete =
    [...baselineResults, ...candidateResults].every((result) => result.complete === true) &&
    !missing.baseline.length &&
    !missing.candidate.length;
  const regressions = measures.filter((m) => m.regressed).map((m) => m.name);
  const table = markdownTable(measures, baselineLabel, candidateLabel);
  const sideReport = (label: string, runs: RunResult[]) => ({
    label,
    source: runs[0]?.source ?? null,
    complete: runs.every((result) => result.complete === true),
    note: runs.map((result) => result.note).find((note) => note) ?? null,
    repetitions: runs.length,
  });
  write(
    output,
    {
      baseline: sideReport(baselineLabel, baselineResults),
      candidate: sideReport(candidateLabel, candidateResults),
      installed,
      fixture,
      repeat,
      margins: MARGINS,
      floors: FLOORS,
      bounds,
      measureMargins: margins,
      measures,
      missing,
      regressions,
      complete,
    },
    table,
  );
  process.stdout.write(`\n${table}\n\nComparison: ${output}\n`);
  if (!complete) {
    process.stderr.write('A run remained incomplete or missed a required measure, so the comparison proves nothing.\n');
    return 2;
  }
  if (regressions.length) {
    process.stderr.write(`The candidate regressed past its margin: ${regressions.join(', ')}.\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename)
  void runComparison(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(3);
    },
  );
