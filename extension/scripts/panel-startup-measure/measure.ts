// Measure a frozen corpus in a unique disposable editor and isolated build.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { instrumentSelection, measureSelection } from './selection';
import { codexSessionFiles, codexSessionsRoot } from '../../src/codex.ts';
import { DIAGNOSTICS_LOG_DIRECTORY } from '../../src/diagnosticslog.ts';
import type { StartupMilestone } from '../../src/performancediagnostics.ts';
import { parseWorktreeRoots } from '../../src/repositoryscope.ts';
import { arcHome } from '../../src/store.ts';
import {
  discoverClaudeChildSessionFiles,
  normalizeFsPath,
  projectsRoot,
  scanForHumanPrompt,
  sessionFilesFor,
} from '../../src/transcript.ts';

const MILESTONES: StartupMilestone[] = ['shellReady', 'catalogReady', 'railReady', 'firstCard', 'completeRender'];

// Background session-list completion and selected content share one bounded measurement.
const AWAITED = MILESTONES;
const LAST_MILESTONE: StartupMilestone = 'completeRender';

const REPOSITORY = path.resolve(__dirname, '../../..');
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === __filename;
const SCRATCH = IS_MAIN
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'arc-startup-measure-'))
  : path.join(os.tmpdir(), 'arc-startup-measure-unused');
let fixture: {
  workspace: string;
  projects: string;
  codex: string;
  store: string;
  state: string;
};
const STATE = path.join(SCRATCH, 'state.json');
const MEASUREMENT_RUN = randomUUID();
let selectionRequested = false;
let expectedSelection: { session: string; key?: string; prompt?: string; summary?: string } | null = null;
function isolatedEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(SCRATCH, 'claude-config'),
    CODEX_HOME: path.join(SCRATCH, 'codex-config'),
    ARC_HOME: ARC_STORE,
    ARC_PROJECTS_ROOT: fixture.projects,
    ARC_CODEX_ROOT: fixture.codex,
    ARC_MEASURE_STATE: STATE,
    ARC_MEASURE_BLOCK_AGENTS: '1',
    ARC_MEASURE_RUN: MEASUREMENT_RUN,
    ...(selectionRequested ? { ARC_MEASURE_TRACE: path.join(SCRATCH, 'selection-trace') } : {}),
  };
}
const USER_DATA = path.join(SCRATCH, 'user-data');
const EXTENSIONS = path.join(SCRATCH, 'extensions');
const ARC_STORE = path.join(SCRATCH, 'arc-home');
const BUILD_TREE = path.join(SCRATCH, 'build');
const NODE_MODULES = ['node_modules', 'extension/node_modules', 'cli/node_modules'];

interface Options {
  commit: string | null;
  fixture: string;
  workspace: string;
  timeoutMs: number;
  keep: boolean;
  selection: boolean;
}

interface LogLine {
  at?: string;
  event?: string;
  milestone?: string;
  elapsedMs?: number;
  panelElapsedMs?: number;
  instance?: string;
  kind?: string;
  bytes?: number;
  measurementRun?: string;
  stage?: string;
  accepted?: boolean;
  usableRows?: boolean;
  observation?: {
    session?: string;
    key?: string;
    prompt?: string;
    summary?: string;
    responseRegion?: 'response' | 'headline';
    renderedResponse?: string;
    visibleResponse?: string;
    expectedRenderedResponse?: string;
  };
}

// What one milestone line carries. `elapsedMs` counts from the extension host process and
// `panelElapsedMs` counts from the moment the panel opened. The two answer different
// questions, so they stay in separate columns.
interface Elapsed {
  hostMs: number | null;
  panelMs: number | null;
}

interface Outcome {
  lines: LogLine[];
  instance: string | null;
  complete: boolean;
  note: string | null;
}

function stop(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readOptions(argv: string[]): Options {
  const options: Options = {
    commit: null,
    workspace: REPOSITORY,
    timeoutMs: 30_000,
    keep: false,
    fixture: '',
    selection: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--selection') {
      options.selection = true;
      continue;
    }
    if (flag === '--keep') {
      options.keep = true;
      continue;
    }
    if (value === undefined) {
      stop(`${flag} takes a value.`);
    }
    if (value.startsWith('--')) {
      stop(`${flag} takes a value, and ${value} is another option.`);
    }
    if (flag === '--fixture') {
      options.fixture = path.resolve(value);
    } else if (flag === '--commit') {
      options.commit = value;
    } else if (flag === '--timeout') {
      options.timeoutMs = Number(value) * 1000;
    } else {
      stop(`Unknown option ${flag}.`);
    }
    i += 1;
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    stop('--timeout takes a number of seconds.');
  }
  if (!options.fixture) stop('--fixture requires a frozen input manifest.');
  return options;
}

// The editor's command line, which both installs the build and opens the measured window.
function editorCommandLine(): string {
  const named = process.env.ARC_MEASURE_EDITOR;
  for (const root of named ? [named] : editorRoots()) {
    const candidate = commandLineIn(root);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return stop('No VS Code install found. Name its directory in ARC_MEASURE_EDITOR.');
}

function commandLineIn(root: string): string {
  if (process.platform === 'win32') {
    return path.join(root, 'bin', 'code.cmd');
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'Contents', 'Resources', 'app', 'bin', 'code');
  }
  return path.join(root, 'bin', 'code');
}

function editorRoots(): string[] {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return [path.join(local, 'Programs', 'Microsoft VS Code'), 'C:/Program Files/Microsoft VS Code'];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Visual Studio Code.app', path.join(os.homedir(), 'Applications/Visual Studio Code.app')];
  }
  return ['/usr/share/code', '/opt/visual-studio-code'];
}

// Windows refuses to start a `.cmd` file without a shell, and a shell splits an argument on
// its spaces, so every argument of one carries its own quotes. Both the editor command line
// and npm arrive as `.cmd` files, and the path of each holds a space.
function quoted(argument: string): string {
  return /[\s&|<>^"]/.test(argument) ? `"${argument}"` : argument;
}

function run(program: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  const shell = process.platform === 'win32' && program.toLowerCase().endsWith('.cmd');
  const invoke = () =>
    spawnSync(shell ? quoted(program) : program, shell ? args.map(quoted) : args, {
      cwd,
      env: env ?? process.env,
      stdio: 'inherit',
      shell,
    });
  const result = invoke();
  if (result.error) {
    stop(`${path.basename(program)} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    stop(`${path.basename(program)} ${args.join(' ')} exited with ${String(result.status)}.`);
  }
}

function npm(args: string[], cwd: string): void {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}

function git(args: string[]): string {
  const result = spawnSync('git', ['-C', REPOSITORY, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    stop(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// Every revision builds in its own checkout with linked dependencies.
function prepareTree(commit: string): string {
  fs.mkdirSync(path.dirname(BUILD_TREE), { recursive: true });
  git(['worktree', 'add', '--detach', BUILD_TREE, commit]);
  for (const name of NODE_MODULES) {
    const link = path.join(BUILD_TREE, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(REPOSITORY, name), link, 'junction');
  }
  return BUILD_TREE;
}

function removeTree(): void {
  if (!fs.existsSync(BUILD_TREE)) return;
  const helper = path.join(os.homedir(), '.claude', 'skills', 'references', 'scripts', 'remove-worktree.py');
  if (!fs.existsSync(helper)) throw new Error(`Cleanup helper is missing. Keep ${BUILD_TREE}.`);
  run(
    process.platform === 'win32' ? 'python' : 'python3',
    [helper, '--repository', REPOSITORY, '--force', BUILD_TREE],
    REPOSITORY,
  );
}

export function sanitizeMeasurementState(raw: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of [
    'showing',
    'hidden',
    'pinnedTop',
    'railFilter',
    'railFilterId',
    'railSort',
    'railDefaultSort',
    'railWidth',
    'railFolds',
    'railQuickFilters',
    'railHeadLenses',
    'railShowArchived',
    'railShowRuns',
    'railGroupBy',
    'railDensity',
    'railFilters',
    'views',
    'read',
    'since',
    'labels',
  ]) {
    if (raw[key] !== undefined) safe[key] = raw[key];
  }
  return safe;
}

export function frozenPath(root: string, input: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const lexical = path.resolve(canonicalRoot, input);
  const rootIdentity = normalizeFsPath(canonicalRoot).replace(/\/$/, '');
  const lexicalIdentity = normalizeFsPath(lexical);
  if (lexicalIdentity === rootIdentity || !lexicalIdentity.startsWith(rootIdentity + '/'))
    throw new Error(`Frozen input sits outside its fixture: ${input}`);
  let ancestor = canonicalRoot;
  for (const part of path.relative(canonicalRoot, lexical).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Frozen input contains a link: ${ancestor}`);
  }
  const resolved = fs.realpathSync(path.resolve(root, input));
  const resolvedIdentity = normalizeFsPath(resolved);
  if (resolvedIdentity === rootIdentity || !resolvedIdentity.startsWith(rootIdentity + '/')) {
    throw new Error(`Frozen input sits outside its fixture: ${input}`);
  }
  const walk = (file: string) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Frozen input contains a link: ${file}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name));
  };
  walk(resolved);
  return resolved;
}

function seedProfile(): void {
  fs.mkdirSync(path.join(USER_DATA, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(USER_DATA, 'User', 'settings.json'),
    JSON.stringify({
      'arc.diagnostics.log': true,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
    }),
  );
  fs.writeFileSync(STATE, JSON.stringify(sanitizeMeasurementState(JSON.parse(fs.readFileSync(fixture.state, 'utf8')))));
  seedMeasurementStore(fixture.store, ARC_STORE);
}

export function seedMeasurementStore(source: string, target: string): void {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (file) => ![DIAGNOSTICS_LOG_DIRECTORY, 'startup'].includes(path.relative(source, file).split(path.sep)[0]),
  });
}

export function frozenFixturePaths(root: string, raw: Record<string, string>, live: string[]): typeof fixture {
  const canonical = (file: string) => (fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file));
  const overlaps = (left: string, right: string) => {
    const a = normalizeFsPath(left);
    const b = normalizeFsPath(right);
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  };
  if (live.some((file) => overlaps(canonical(root), canonical(file))))
    throw new Error('A live data directory is not a frozen fixture.');
  const resolved = Object.fromEntries(
    ['workspace', 'projects', 'codex', 'store', 'state'].map((key) => [key, frozenPath(root, raw[key])]),
  ) as typeof fixture;
  for (const input of [canonical(root), ...Object.values(resolved)])
    if (live.some((file) => overlaps(input, canonical(file))))
      throw new Error('A live data directory is not a frozen fixture.');
  return resolved;
}

export function inputHashes(root: string, inputs: string[]): Record<string, string> {
  const canonicalRoot = fs.realpathSync(root);
  const hashes: Record<string, string> = {};
  const walk = (file: string) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Frozen input contains a link: ${file}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name));
    else hashes[path.relative(canonicalRoot, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  };
  for (const input of inputs) walk(frozenPath(canonicalRoot, input));
  return hashes;
}

function loadFixture(manifest: string): void {
  const root = path.dirname(fs.realpathSync(manifest));
  const live = [arcHome(), projectsRoot(), codexSessionsRoot()];
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fixture = frozenFixturePaths(root, raw, live);
  const selected = sanitizeMeasurementState(JSON.parse(fs.readFileSync(fixture.state, 'utf8'))).showing;
  expectedSelection = typeof selected === 'string' ? { session: selected, ...raw.expectedSelection } : null;
  if (!expectedSelection || expectedSelection.session !== selected)
    throw new Error('The frozen fixture must name its selected session.');
  if (
    Object.entries(expectedSelection).some(
      ([key, value]) => !['session', 'key', 'prompt', 'summary'].includes(key) || typeof value !== 'string' || !value,
    )
  )
    throw new Error('Frozen selected-turn expectations must contain nonempty text.');
  if (fs.existsSync(path.join(fixture.workspace, '.git')))
    throw new Error('The frozen workspace must not resolve a live repository scope.');
  const hashes = inputHashes(root, [manifest, ...Object.values(fixture)]);
  const checkReferences = (value: unknown): void => {
    if (typeof value === 'string' && path.isAbsolute(value) && value.endsWith('.jsonl')) frozenPath(root, value);
    else if (Array.isArray(value)) value.forEach(checkReferences);
    else if (value && typeof value === 'object') Object.values(value).forEach(checkReferences);
  };
  for (const file of Object.keys(hashes).filter((name) => name.endsWith('.json')))
    checkReferences(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
  const scope = spawnSync('git', ['-C', fixture.workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (scope.status === 0) throw new Error('The frozen workspace resolves a repository outside its fixture.');
  fs.writeFileSync(
    path.join(SCRATCH, 'inputs.json'),
    JSON.stringify(
      {
        manifest,
        hashes,
        owned: {
          scratch: SCRATCH,
          profile: USER_DATA,
          extensions: EXTENSIONS,
          store: ARC_STORE,
          build: BUILD_TREE,
          state: STATE,
        },
        fixture,
      },
      null,
      2,
    ),
  );
}

// The overlay records the visible card and accepted paint on the existing message route.
export function instrumentStartup(tree: string): void {
  const patch = (relative: string, needle: string, replacement: string) => {
    const file = path.join(tree, 'extension', 'src', relative);
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes(needle)) throw new Error(`The baseline lacks its startup observation boundary: ${relative}`);
    fs.writeFileSync(file, source.replace(needle, replacement));
  };
  patch(
    'webview/panel.ts',
    'stage: stage,',
    `stage: stage,
          measurementObservation: (() => {
            const article = list.querySelector<HTMLElement>('.timeline-owner:not([hidden]) article.turn');
            const card = latest?.cards.find((item) => item.key === article?.dataset.key);
            const visible = (element: HTMLElement | null) => element && !element.closest('[hidden]');
            const response = article?.querySelector<HTMLElement>('.body .sectionheading.saidonly + .summary') ?? null;
            const headline = article?.querySelector<HTMLElement>('.headline') ?? null;
            const responseRegion = visible(response) ? 'response' : visible(headline) ? 'headline' : undefined;
            const region = responseRegion === 'response' ? response : responseRegion === 'headline' ? headline : null;
            const content = region?.cloneNode(true) as HTMLElement | undefined;
            content?.querySelectorAll('.copy').forEach((button) => button.remove());
            const expected = document.createElement('div');
            expected.innerHTML = responseRegion === 'response' ? card?.summaryHtml ?? '' : card?.headlineHtml ?? '';
            const normalize = (text: string) => text.replace(/\\s+/g, ' ').trim();
            return { session: article?.dataset.session, key: article?.dataset.key,
              prompt: card?.prompt, summary: card?.summary, responseRegion,
              visibleResponse: region?.innerText ?? '',
              renderedResponse: normalize(content?.textContent ?? ''),
              expectedRenderedResponse: normalize(expected.textContent || (responseRegion === 'headline' ? card?.headline ?? '' : '')) };
          })(),`,
  );
  patch(
    'panelhost.ts',
    'this.browserPainted(host, msg.generation, msg.stage, msg.usableRows);',
    `this.diagnostics.log('measurementPaint', {
          stage: msg.stage, generation: msg.generation, usableRows: msg.usableRows === true,
          accepted: this.readyHosts.has(host) && msg.generation === this.refreshGeneration,
          observation: (raw as { measurementObservation?: unknown }).measurementObservation,
          hostMs: performance.now(),
        });
        this.browserPainted(host, msg.generation, msg.stage, msg.usableRows);`,
  );
}

// Older baselines receive the same measurement-only launch block and state seed.
export function protectBaseline(tree: string): void {
  const edit = (name: string, needle: string, replacement: string) => {
    const file = path.join(tree, 'extension', 'src', name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('ARC_MEASURE_BLOCK_AGENTS') || text.includes('MEASUREMENT_ENVIRONMENT')) return;
    if (!text.includes(needle)) throw new Error(`The baseline lacks its isolation boundary: ${name}`);
    fs.writeFileSync(file, text.replace(needle, replacement));
  };
  const spawner = fs.readFileSync(path.join(tree, 'extension', 'src', 'agenthost.ts'), 'utf8');
  const spawnDeclaration = spawner.match(
    /export const spawnCli: Spawner = \(command, args, cwd, env(?:, agent)?\) => \{/,
  );
  if (!spawnDeclaration) throw new Error('The baseline lacks its agent launch boundary.');
  edit(
    'agenthost.ts',
    spawnDeclaration[0],
    spawnDeclaration[0] +
      " if (process.env.ARC_MEASURE_BLOCK_AGENTS === '1') throw new Error('Agent connections are disabled in this measurement window.');",
  );
  edit(
    'panelhost.ts',
    'const stored = this.memento?.get(STATE_KEY);',
    "const stored = process.env.ARC_MEASURE_BLOCK_AGENTS === '1' && process.env.ARC_MEASURE_STATE ? JSON.parse(fs.readFileSync(process.env.ARC_MEASURE_STATE, 'utf8')) : this.memento?.get(STATE_KEY);",
  );
  const activation = fs.readFileSync(path.join(tree, 'extension', 'src', 'extension.ts'), 'utf8');
  if (!activation.includes('ARC_MEASURE_BLOCK_AGENTS') && !activation.includes('MEASUREMENT_ENVIRONMENT')) {
    const registrations = activation.match(
      /^[ \t]*const panel = registerPanel\(context, root, [A-Za-z_$][\w$]*\);(?=[ \t]*\r?$)/gm,
    );
    if (registrations?.length !== 1) throw new Error('The baseline lacks its isolation boundary: extension.ts');
    edit(
      'extension.ts',
      registrations[0],
      registrations[0] +
        " if (process.env.ARC_MEASURE_BLOCK_AGENTS === '1' && process.env.ARC_MEASURE_STATE) panel.openInEditor();",
    );
  }
  const host = path.join(tree, 'extension', 'src', 'panelhost.ts');
  const text = fs.readFileSync(host, 'utf8');
  if (!text.includes('measurementRun:')) {
    const needle = 'startedAt: Math.round(performance.timeOrigin),';
    if (!text.includes(needle)) throw new Error('The baseline lacks its diagnostics identity boundary.');
    fs.writeFileSync(host, text.replace(needle, needle + ' measurementRun: process.env.ARC_MEASURE_RUN,'));
  }
  const logger = path.join(tree, 'extension', 'src', 'diagnosticslog.ts');
  const logText = fs.readFileSync(logger, 'utf8');
  if (!logText.includes('measurementRun?:')) {
    const options = 'keptFiles?: number;';
    const record = 'instance: this.instance,';
    if (!logText.includes(options) || !logText.includes(record))
      throw new Error('The baseline lacks its diagnostics identity fields.');
    fs.writeFileSync(
      logger,
      logText
        .replace(options, options + ' measurementRun?: string;')
        .replace(record, record + ' measurementRun: this.options.measurementRun,'),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Every line the run has written so far, read once. Each file keeps the byte it was read to
// and the bytes after its last newline, so a tick reads only what arrived since the last
// one. A file the editor is still appending to ends in a partial line, and that line waits
// for the read that finds the rest of it.
class LogReader {
  private readonly offsets = new Map<string, number>();
  private readonly tails = new Map<string, Buffer>();
  private readonly lines: LogLine[] = [];

  constructor(private readonly directory: string) {}

  read(): LogLine[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.directory).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return this.lines;
    }
    for (const name of names.sort()) {
      this.readFile(path.join(this.directory, name));
    }
    return this.lines;
  }

  private readFile(file: string): void {
    const offset = this.offsets.get(file) ?? 0;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) {
      return;
    }
    const buffer = Buffer.alloc(size - offset);
    let read = 0;
    let handle = -1;
    try {
      handle = fs.openSync(file, 'r');
      read = fs.readSync(handle, buffer, 0, buffer.length, offset);
    } catch {
      return;
    } finally {
      if (handle >= 0) {
        fs.closeSync(handle);
      }
    }
    this.offsets.set(file, offset + read);
    // Split on the byte, not the decoded text. A character of several bytes can straddle two
    // reads, and 0x0A never appears inside one of them.
    const pending = Buffer.concat([this.tails.get(file) ?? Buffer.alloc(0), buffer.subarray(0, read)]);
    const end = pending.lastIndexOf(0x0a);
    this.tails.set(file, end < 0 ? pending : pending.subarray(end + 1));
    if (end < 0) {
      return;
    }
    for (const text of pending.subarray(0, end).toString('utf8').split('\n')) {
      if (text.trim() === '') {
        continue;
      }
      try {
        this.lines.push(JSON.parse(text) as LogLine);
      } catch {
        // A line this script does not read.
      }
    }
  }
}

// The extension host that produced the measured run. Every line carries the identity of the
// host that wrote it, and a host that restarts writes a second one, so the numbers come from
// one identity and the report names it. The host that reached the awaited milestone wins, and
// the one that recorded the most milestones stands in when none did.
export function measuredInstance(lines: LogLine[], measurementRun: string): string | null {
  const counts = new Map<string, number>();
  const finished: string[] = [];
  for (const line of lines) {
    if (line.measurementRun !== measurementRun || line.event !== 'startup' || typeof line.instance !== 'string') {
      continue;
    }
    counts.set(line.instance, (counts.get(line.instance) ?? 0) + 1);
    if (line.milestone === LAST_MILESTONE && !finished.includes(line.instance)) {
      finished.push(line.instance);
    }
  }
  if (finished.length > 0) {
    return finished[0];
  }
  let best: string | null = null;
  for (const [instance, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = instance;
    }
  }
  return best;
}

export function linesOf(lines: LogLine[], instance: string | null, measurementRun: string): LogLine[] {
  return lines.filter(
    (line) => line.measurementRun === measurementRun && instance !== null && line.instance === instance,
  );
}

function milestoneOf(lines: LogLine[], milestone: string): Elapsed {
  for (const line of lines) {
    if (line.event !== 'startup' || line.milestone !== milestone) {
      continue;
    }
    return {
      hostMs: typeof line.elapsedMs === 'number' ? line.elapsedMs : null,
      panelMs: typeof line.panelElapsedMs === 'number' ? line.panelElapsedMs : null,
    };
  }
  return { hostMs: null, panelMs: null };
}

function reached(lines: LogLine[], milestone: string): boolean {
  return lines.some((line) => line.event === 'startup' && line.milestone === milestone);
}

// Every startup milestone must arrive before the measurement deadline.
export function outcomeOf(
  lines: LogLine[],
  instance: string | null,
  note: string | null,
  selection: { session: string; key?: string; prompt?: string; summary?: string } | null = null,
  deadline = Infinity,
): Outcome {
  const timely = lines.filter((line) => deadline === Infinity || Date.parse(line.at ?? '') <= deadline);
  const missing: string[] = AWAITED.filter((milestone) => !reached(timely, milestone));
  if (selection) {
    if (!selection.key || !selection.prompt || !selection.summary) missing.push('frozen newest-turn expectation');
    const paints = timely.filter((line) => line.event === 'measurementPaint' && line.accepted === true);
    if (!paints.some((line) => line.stage === 'railReady' && line.usableRows === true))
      missing.push('usable session-list rows');
    if (
      !paints.some((line) => {
        const observation = line.observation;
        return (
          line.stage === 'firstCard' &&
          observation?.session === selection.session &&
          !!observation.key &&
          !!observation.prompt &&
          !!observation.summary &&
          (observation.responseRegion === 'response' || observation.responseRegion === 'headline') &&
          !!observation.renderedResponse &&
          !!observation.visibleResponse?.trim() &&
          observation.renderedResponse === observation.expectedRenderedResponse &&
          (!selection.key || observation.key === selection.key) &&
          (!selection.prompt || observation.prompt === selection.prompt) &&
          (!selection.summary || observation.summary === selection.summary)
        );
      })
    )
      missing.push('selected newest-turn text');
  }
  if (missing.length === 0) {
    return { lines, instance, complete: true, note };
  }
  return {
    lines,
    instance,
    complete: false,
    note: note ?? `The panel reported no ${missing.join(' and no ')} line.`,
  };
}

// What the editor reports while it starts. An editor that exits before the run ends is a
// failure, and the command line that opens the window is not: it hands the window on and
// exits at once, which is a zero exit code.
interface Launch {
  failure: string | null;
}

// The measured window, started the same way a reader starts one. The application binary opens
// nothing when a script starts it directly, so the run goes through the command line, which
// returns as soon as the window is on its way.
function launchEditor(commandLine: string, workspace: string): Launch {
  const launch: Launch = { failure: null };
  const shell = process.platform === 'win32';
  const args = [
    '--user-data-dir',
    USER_DATA,
    '--extensions-dir',
    EXTENSIONS,
    '--disable-workspace-trust',
    '--new-window',
    ...(selectionRequested ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] : []),
    workspace,
  ];
  const stdout = fs.openSync(path.join(SCRATCH, 'launch.stdout.log'), 'w');
  const stderr = fs.openSync(path.join(SCRATCH, 'launch.stderr.log'), 'w');
  const child = spawn(shell ? quoted(commandLine) : commandLine, shell ? args.map(quoted) : args, {
    cwd: SCRATCH,
    env: isolatedEnvironment(),
    stdio: ['ignore', stdout, stderr],
    detached: true,
    shell,
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const receipt = (code: number | null, signal: string | null, error?: string) =>
    fs.writeFileSync(
      path.join(SCRATCH, 'launch.json'),
      JSON.stringify({
        commandLine,
        args,
        pid: child.pid ?? null,
        profile: USER_DATA,
        code,
        signal,
        error: error ?? null,
      }),
    );
  receipt(null, null);
  child.on('error', (error: Error) => {
    launch.failure = `The editor did not start: ${error.message}`;
    receipt(null, null, error.message);
  });
  child.on('exit', (code: number | null, signal: string | null) => {
    receipt(code, signal);
    if (code === 0) {
      return;
    }
    launch.failure = `The editor exited with ${signal ?? String(code)} before the run finished.`;
  });
  child.unref();
  return launch;
}

// The window the run opened is nobody's child, because the command line handed it on and
// exited. Every process of the run carries the throwaway profile on its command line, and
// that is what tells them apart from the editor the reader is working in.
function stopEditor(): void {
  if (process.platform === 'win32') {
    const escaped = USER_DATA.replaceAll("'", "''");
    const owned = path.join(SCRATCH, 'process-ownership.json').replaceAll("'", "''");
    const query = `$profile='${escaped}'; $owned=@(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) }); $owned | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json | Set-Content -LiteralPath '${owned}'; foreach($entry in $owned) { $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)"; if($current -and $current.CreationDate -eq $entry.CreationDate -and $current.CommandLine -eq $entry.CommandLine) { Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue } }`;
    spawnSync('powershell', ['-NoProfile', '-Command', query], {
      stdio: 'ignore',
    });
    return;
  }
  const list = () =>
    spawnSync('ps', ['-eo', 'pid=,lstart=,args='], {
      encoding: 'utf8',
    }).stdout.split('\n');
  const owned = list().filter((line) => line.includes(USER_DATA));
  fs.writeFileSync(path.join(SCRATCH, 'process-ownership.json'), JSON.stringify(owned));
  for (const line of owned) {
    if (!list().includes(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isSafeInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid);
      } catch {}
    }
  }
}

export async function pollStartup(
  read: () => LogLine[],
  launch: Launch,
  timeoutMs: number,
  measurementRun: string,
  selection: typeof expectedSelection,
): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  const waited = Math.round(timeoutMs / 1000);
  for (;;) {
    const lines = read();
    const instance = measuredInstance(lines, measurementRun);
    const run = linesOf(lines, instance, measurementRun);
    const outcome = outcomeOf(run, instance, null, selection, deadline);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ...outcome,
        complete: false,
        note:
          lines.length === 0
            ? `Arc wrote no diagnostics line in ${waited}s. Check that the window opened and that the panel tab is in the stored window state.`
            : `The startup remained incomplete after ${waited}s. ${outcome.note ?? ''}`,
      };
    }
    if (launch.failure !== null) return { ...outcome, complete: false, note: launch.failure };
    if (outcome.complete) return outcome;
    await delay(Math.min(1000, remaining));
  }
}

// The panel acknowledges completion after discovery and session-list metadata settle.
async function measure(commandLine: string, workspace: string, timeoutMs: number): Promise<Outcome> {
  const { acquireBrowserLock } = await import('../../test/browserlock.mjs');
  const lock = await acquireBrowserLock({ deadlineMs: timeoutMs });
  const logs = path.join(ARC_STORE, DIAGNOSTICS_LOG_DIRECTORY);
  const reader = new LogReader(logs);
  const launch = launchEditor(commandLine, workspace);
  try {
    const outcome = await pollStartup(() => reader.read(), launch, timeoutMs, MEASUREMENT_RUN, expectedSelection);
    if (outcome.complete && selectionRequested) {
      const result = await measureSelection(SCRATCH, timeoutMs);
      return { ...outcome, note: result.note, complete: result.complete };
    }
    return outcome;
  } finally {
    stopEditor();
    lock?.release();
  }
}

interface SessionCount {
  claude: number;
  children: number;
  codex: number;
  total: number;
}

// The folder plus every registered worktree of its repository, which is the scope the rail
// lists sessions over.
function repositoryRoots(workspace: string): string[] {
  const result = spawnSync('git', ['-C', workspace, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' });
  const found = new Map<string, string>();
  for (const root of [workspace, ...(result.status === 0 ? parseWorktreeRoots(result.stdout) : [])]) {
    const key = normalizeFsPath(root);
    if (key && !found.has(key)) {
      found.set(key, root);
    }
  }
  return [...found.values()];
}

// The rail's own count, taken from the production listing. The rail scopes sessions to the
// folder and every worktree of its repository, keeps the Claude sessions that carry a human
// prompt, and adds the Claude child sessions to the Codex ones.
function sessionCount(workspace: string): SessionCount {
  const roots = repositoryRoots(workspace);
  const parents = sessionFilesFor(projectsRoot(), roots, undefined, [workspace]);
  const claude = parents.filter((session) => scanForHumanPrompt(session.file, session.size).found);
  const children = discoverClaudeChildSessionFiles(parents, roots);
  const codex = codexSessionFiles(codexSessionsRoot(), roots).sessions;
  return {
    claude: claude.length,
    children: children.length,
    codex: codex.length,
    total: claude.length + children.length + codex.length,
  };
}

function seconds(ms: number | null): string {
  return ms === null ? 'not reported' : `${(ms / 1000).toFixed(1)}s`;
}

function bytesOf(lines: LogLine[]): { largest: number; count: number } {
  const renders = lines.filter(
    (line) => line.event === 'message' && line.kind === 'render' && typeof line.bytes === 'number',
  );
  return {
    largest: renders.reduce((most, line) => Math.max(most, line.bytes ?? 0), 0),
    count: renders.length,
  };
}

function report(outcome: Outcome, label: string, workspace: string): void {
  const lines = outcome.lines;
  const end = lines.findIndex((line) => line.event === 'startup' && line.milestone === 'firstCard');
  const startup = bytesOf(end < 0 ? lines : lines.slice(0, end + 1));
  const whole = bytesOf(lines);
  process.env.ARC_PROJECTS_ROOT = fixture.projects;
  process.env.ARC_CODEX_ROOT = fixture.codex;
  const sessions = sessionCount(workspace);
  const rows = MILESTONES.map((milestone) => {
    const elapsed = milestoneOf(lines, milestone);
    return `  ${milestone.padEnd(16)}${seconds(elapsed.hostMs).padEnd(14)}${seconds(elapsed.panelMs)}`;
  });
  process.stdout.write(
    [
      '',
      `Panel startup on ${workspace}`,
      `  build           ${label}`,
      `  host            ${outcome.instance ?? 'not identified'}`,
      `  milestone       ${'host clock'.padEnd(14)}panel clock`,
      ...rows,
      ...(end < 0
        ? [
            `  render          ${whole.largest.toLocaleString()} bytes, largest of ${whole.count} posted before the run stopped`,
          ]
        : [
            `  startup render  ${startup.largest.toLocaleString()} bytes, largest of ${startup.count} posted up to firstCard`,
            `  whole run       ${whole.largest.toLocaleString()} bytes, largest of ${whole.count} posted`,
          ]),
      `  sessions        ${sessions.total.toLocaleString()} in the rail: ${sessions.claude.toLocaleString()} Claude, ${sessions.children.toLocaleString()} Claude children, ${sessions.codex.toLocaleString()} Codex`,
      ...(outcome.complete ? [] : [`  run             incomplete. ${outcome.note ?? ''}`.trimEnd()]),
      '',
      `Log        ${path.join(ARC_STORE, DIAGNOSTICS_LOG_DIRECTORY)}`,
      `Profile    ${USER_DATA}`,
      `Arc home   ${ARC_STORE}`,
      '',
    ].join('\n'),
  );
  if (!outcome.complete) {
    process.stderr.write(`${outcome.note ?? `The run never reported ${LAST_MILESTONE}.`}\n`);
  }
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  selectionRequested = options.selection;
  loadFixture(options.fixture);
  options.workspace = fixture.workspace;
  const commandLine = editorCommandLine();
  for (const directory of [SCRATCH, USER_DATA, EXTENSIONS, ARC_STORE]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  try {
    const source = git(['rev-parse', options.commit ?? 'HEAD']);
    const tree = prepareTree(source);
    protectBaseline(tree);
    instrumentStartup(tree);
    if (selectionRequested) instrumentSelection(tree);
    const label = git(['rev-parse', '--short', source]);
    npm(['run', 'build'], path.join(tree, 'extension'));
    npm(['run', 'package'], path.join(tree, 'extension'));
    run(
      commandLine,
      [
        '--user-data-dir',
        USER_DATA,
        '--extensions-dir',
        EXTENSIONS,
        '--install-extension',
        path.join(tree, 'extension', 'arc.vsix'),
        '--force',
      ],
      SCRATCH,
      isolatedEnvironment(),
    );
    seedProfile();
    const artifact = createHash('sha256')
      .update(fs.readFileSync(path.join(tree, 'extension', 'dist', 'extension.js')))
      .digest('hex');
    if (!fs.readFileSync(path.join(tree, 'extension', 'dist', 'extension.js'), 'utf8').includes('MEASURE_BLOCK_AGENTS'))
      throw new Error('The built extension lacks the agent launch block.');
    fs.writeFileSync(
      path.join(SCRATCH, 'artifact.json'),
      JSON.stringify({
        artifact,
        label,
        source,
        measurementRun: MEASUREMENT_RUN,
        measurementOverlay: true,
        startupOverlaySha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
        ...(selectionRequested
          ? {
              selectionOverlaySha256: createHash('sha256')
                .update(fs.readFileSync(path.join(__dirname, 'selection.ts')))
                .digest('hex'),
            }
          : {}),
        route: 'created',
        settings: { detailedLog: true },
        cacheStore: ARC_STORE,
      }),
    );
    process.stdout.write(`Owned paths and artifacts: ${SCRATCH}\n`);
    const outcome = await measure(commandLine, options.workspace, options.timeoutMs);
    fs.writeFileSync(
      path.join(SCRATCH, 'result.json'),
      JSON.stringify(
        {
          source,
          artifact,
          expectedSelection,
          deadlineMs: options.timeoutMs,
          ...outcome,
          byteMeasurement: 'JSON content-size proxy',
          nativeCloneBytes: null,
          persistenceDurationMs: null,
        },
        null,
        2,
      ),
    );
    report(outcome, label, options.workspace);
    if (!outcome.complete) {
      process.exitCode = 1;
    }
  } finally {
    if (!options.keep) {
      removeTree();
    }
  }
}

if (IS_MAIN)
  void main().catch((error: unknown) => {
    stop(error instanceof Error ? error.message : String(error));
  });
