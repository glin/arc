// Measure a frozen corpus in an isolated editor profile and build.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { removeMeasurementTree } from './cleanup';
import { pathRewriter, rebindDispatch } from './freeze';
import { instrumentSelection, measureSelection, instrumentResponse, measureResponse } from './selection';
import {
  appendDispatchTurn,
  hostMemory,
  missingSoakMeasures,
  instrumentSoak,
  linkTree,
  soakMeasures,
  startDispatch,
  type HostMemory,
} from './soak';
import {
  CODEX_OPENING_BYTES,
  ROLLOUT_NAME,
  codexRowAdmitted,
  codexSessionFiles,
  codexSessionsRoot,
  openingRecordOf,
  readRolloutStat,
} from '../../src/codex.ts';
import { isCompressedRollout, readCompressedFirstRecord } from '../../src/compressedrollouts.ts';
import { DIAGNOSTICS_LOG_DIRECTORY } from '../../src/diagnosticslog.ts';
import type { StartupMilestone } from '../../src/performancediagnostics.ts';
import { parseWorktreeRoots } from '../../src/repositoryscope.ts';
import { arcHome } from '../../src/store.ts';
import {
  discoverClaudeChildSessionFiles,
  folderMatcher,
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
let responseRequested = false;
let expectedSelection: { session: string; key?: string; prompt?: string; summary?: string } | null = null;
let soakRequested = false;
// A warm-up hold reads its measures through the soak overlay.
let warmUntilRequested = false;
// The variables that the isolated editor driver keeps from the editor, loaded at startup.
let scrubbedVariables = /$^/;
const SOAK = path.join(SCRATCH, 'soak');
const SOAK_PROJECTS = path.join(SCRATCH, 'soak-projects');
const SOAK_CODEX = path.join(SCRATCH, 'soak-codex');
// The editor inherits no editor, Electron, Arc, Claude, Node option or Git variable. A runner started by an agent
// inherits ELECTRON_RUN_AS_NODE=1, and Code.exe then runs as Node and opens no window.
function isolatedEnvironment(run: string = MEASUREMENT_RUN): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !scrubbedVariables.test(name))),
    CLAUDE_CONFIG_DIR: path.join(SCRATCH, 'claude-config'),
    CODEX_HOME: path.join(SCRATCH, 'codex-config'),
    ARC_HOME: ARC_STORE,
    ARC_PROJECTS_ROOT: soakRequested ? SOAK_PROJECTS : fixture.projects,
    ARC_CODEX_ROOT: responseRequested
      ? path.join(SCRATCH, 'response-codex')
      : soakRequested
        ? SOAK_CODEX
        : fixture.codex,
    ARC_MEASURE_STATE: STATE,
    ARC_MEASURE_BLOCK_AGENTS: '1',
    ARC_MEASURE_RUN: run,
    ...(selectionRequested ? { ARC_MEASURE_TRACE: path.join(SCRATCH, 'selection-trace') } : {}),
    ...(soakRequested || warmUntilRequested ? { ARC_MEASURE_SOAK: SOAK } : {}),
  };
}
const WARM_USER_DATA = path.join(SCRATCH, 'warm-user-data');
const USER_DATA = path.join(SCRATCH, 'user-data');
const EXTENSIONS = path.join(SCRATCH, 'extensions');
const ARC_STORE = path.join(SCRATCH, 'arc-home');
const BUILD_TREE = path.join(SCRATCH, 'build');
const NODE_MODULES = ['node_modules', 'extension/node_modules', 'cli/node_modules'];

export interface Options {
  commit: string | null;
  fixture: string;
  workspace: string;
  timeoutMs: number;
  keep: boolean;
  selection: boolean;
  response: boolean;
  soakMinutes: number;
  warmUp: boolean;
  warmUntil: WarmCondition[];
  buildCache: string | null;
  countCompressed: string | null;
  minimumFreeGb: number;
}

export interface WarmCondition {
  measure: string;
  value: number;
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
  hostPid?: number;
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

// Keep host elapsed time and panel elapsed time in separate columns.
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

export function readOptions(argv: string[]): Options {
  const options: Options = {
    commit: null,
    workspace: REPOSITORY,
    timeoutMs: 30_000,
    keep: false,
    fixture: '',
    selection: false,
    response: false,
    soakMinutes: 0,
    warmUp: false,
    warmUntil: [],
    buildCache: null,
    countCompressed: null,
    // 1.5 times the largest extension host peak working set that saved measurements record.
    minimumFreeGb: 5.4,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--warm-up') {
      options.warmUp = true;
      continue;
    }
    if (flag === '--response') {
      options.response = true;
      options.selection = true;
      continue;
    }
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
    } else if (flag === '--soak') {
      options.soakMinutes = Number(value);
    } else if (flag === '--min-free-gb') {
      options.minimumFreeGb = Number(value);
    } else if (flag === '--warm-until') {
      const match = /^([^=]+)=(.+)$/.exec(value);
      if (!match || !Number.isFinite(Number(match[2]))) stop('--warm-until takes <measure>=<number>.');
      options.warmUntil.push({ measure: match[1], value: Number(match[2]) });
      options.warmUp = true;
    } else if (flag === '--build-cache') {
      options.buildCache = path.resolve(value);
    } else if (flag === '--count-compressed') {
      options.countCompressed = path.resolve(value);
    } else {
      stop(`Unknown option ${flag}.`);
    }
    i += 1;
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    stop('--timeout takes a number of seconds.');
  }
  if (options.countCompressed) return options;
  if (!options.fixture) stop('--fixture requires a frozen input manifest.');
  if (!Number.isFinite(options.soakMinutes) || options.soakMinutes < 0) stop('--soak takes a number of minutes.');
  if (!Number.isFinite(options.minimumFreeGb) || options.minimumFreeGb < 0)
    stop('--min-free-gb takes a number of gigabytes.');
  if (options.soakMinutes > 0 && options.selection) stop('--soak runs without --selection and --response.');
  return options;
}

// Find the editor CLI used to install the build and open the measured window.
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

// Windows launches .cmd files through a shell. Quote arguments containing whitespace or shell metacharacters.
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

// Build the selected revision in its own checkout with linked dependencies.
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
  removeMeasurementTree(REPOSITORY, SCRATCH, BUILD_TREE);
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
  if (responseRequested) fs.cpSync(fixture.codex, path.join(SCRATCH, 'response-codex'), { recursive: true });
  if (soakRequested) {
    linkTree(fixture.projects, SOAK_PROJECTS);
    linkTree(fixture.codex, SOAK_CODEX);
    fs.mkdirSync(SOAK, { recursive: true });
  }
  if (warmUntilRequested) fs.mkdirSync(SOAK, { recursive: true });
  for (const profile of [USER_DATA, WARM_USER_DATA]) {
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'User', 'settings.json'),
      JSON.stringify({
        'arc.diagnostics.log': true,
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
        'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'workbench.welcomePage.experimentalOnboarding': false,
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
      }),
    );
  }
  fs.writeFileSync(STATE, JSON.stringify(sanitizeMeasurementState(JSON.parse(fs.readFileSync(fixture.state, 'utf8')))));
  seedMeasurementStore(fixture.store, ARC_STORE);
  runRecord.dispatchRebind = rebindDispatch(
    path.join(ARC_STORE, 'dispatch'),
    soakRequested
      ? pathRewriter([
          [fixture.projects, SOAK_PROJECTS],
          [fixture.codex, SOAK_CODEX],
        ])
      : undefined,
  );
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

// A recorded transcript path must sit inside the fixture, with no link on its way. The transcript itself can be
// absent: a receipt can name a report that its agent never wrote, and Codex can archive a rollout that a record names.
export function frozenReference(root: string, input: string): void {
  const canonicalRoot = fs.realpathSync(root);
  const lexical = path.resolve(canonicalRoot, input);
  const rootIdentity = normalizeFsPath(canonicalRoot).replace(/\/$/, '');
  if (!normalizeFsPath(lexical).startsWith(rootIdentity + '/'))
    throw new Error(`Frozen input sits outside its fixture: ${input}`);
  let ancestor = canonicalRoot;
  for (const part of path.relative(canonicalRoot, lexical).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    const stat = fs.lstatSync(ancestor, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Frozen input contains a link: ${ancestor}`);
  }
  frozenPath(root, input);
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

// Check every absolute transcript path that a JSON file of the fixture records. A receipt's logAlias names where a
// launch writes its log. Arc reads it only to launch, which the measured editor blocks, and it can sit in the workspace
// that launched the dispatch.
export function checkFrozenReferences(root: string, hashes: Record<string, string>): void {
  const check = (value: unknown, key?: string): void => {
    if (typeof value === 'string' && path.isAbsolute(value) && value.endsWith('.jsonl')) {
      if (key !== 'logAlias') frozenReference(root, value);
    } else if (Array.isArray(value)) value.forEach((item) => check(item, key));
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) check(item, name);
  };
  for (const file of Object.keys(hashes).filter((name) => name.endsWith('.json')))
    check(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
}

// The measured editor reads its own Arc home, so a fixture may sit in the Arc home's measure directory.
export function liveDirectories(root: string, home = arcHome()): string[] {
  const measureHome = normalizeFsPath(path.join(fs.existsSync(home) ? fs.realpathSync(home) : home, 'measure'));
  const inMeasureHome = normalizeFsPath(fs.realpathSync(root)).startsWith(measureHome + '/');
  return [...(inMeasureHome ? [] : [home]), projectsRoot(), codexSessionsRoot()];
}

function loadFixture(manifest: string): void {
  const root = path.dirname(fs.realpathSync(manifest));
  const live = liveDirectories(root);
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
  checkFrozenReferences(root, hashes);
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

// Add selected-card observations and paint acceptance to startup diagnostics.
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
          hostMs: performance.now(), hostPid: process.pid,
        });
        this.browserPainted(host, msg.generation, msg.stage, msg.usableRows);`,
  );
}

// Add the measurement launch block and state seed when a selected baseline lacks them.
export function protectBaseline(tree: string): void {
  const edit = (name: string, needle: string, replacement: string) => {
    const file = path.join(tree, 'extension', 'src', name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('ARC_MEASURE_BLOCK_AGENTS') || text.includes('MEASUREMENT_ENVIRONMENT')) return;
    if (!text.includes(needle)) throw new Error(`The baseline lacks its isolation boundary: ${name}`);
    fs.writeFileSync(file, text.replace(needle, replacement));
  };
  const spawner = fs.readFileSync(path.join(tree, 'extension', 'src', 'agenthost.ts'), 'utf8');
  // A baseline that already blocks agents keeps its own spawn signature.
  if (!spawner.includes('ARC_MEASURE_BLOCK_AGENTS') && !spawner.includes('MEASUREMENT_ENVIRONMENT')) {
    const spawnDeclaration = spawner.match(
      /export const spawnCli: Spawner = \(command, args, cwd, env(?:, agent(?:, cli)?)?\) => \{/,
    );
    if (!spawnDeclaration) throw new Error('The baseline lacks its agent launch boundary.');
    edit(
      'agenthost.ts',
      spawnDeclaration[0],
      spawnDeclaration[0] +
        " if (process.env.ARC_MEASURE_BLOCK_AGENTS === '1') throw new Error('Agent connections are disabled in this measurement window.');",
    );
  }
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

// Read appended bytes once per file. Retain each offset and incomplete trailing line for the next read.
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
    // Split bytes at newline before decoding. This preserves UTF-8 characters spanning reads.
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
        // Ignore a line that does not parse as JSON.
      }
    }
  }
}

// Select the first host instance to report completeRender for this run.
// Otherwise, select the instance with the most startup lines.
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

// Require every startup milestone by the measurement deadline.
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

// Editor launch failure state. A successful CLI exit leaves the measured window running.
interface Launch {
  failure: string | null;
}

// Launches an isolated editor window through its CLI and releases the launcher process.
function launchEditor(
  commandLine: string,
  workspace: string,
  profile = USER_DATA,
  run: string = MEASUREMENT_RUN,
): Launch {
  const launch: Launch = { failure: null };
  const prefix = profile === USER_DATA ? '' : 'warm-';
  const shell = process.platform === 'win32';
  const args = [
    '--user-data-dir',
    profile,
    '--extensions-dir',
    EXTENSIONS,
    '--disable-workspace-trust',
    '--new-window',
    ...(selectionRequested ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] : []),
    workspace,
  ];
  const stdout = fs.openSync(path.join(SCRATCH, `${prefix}launch.stdout.log`), 'w');
  const stderr = fs.openSync(path.join(SCRATCH, `${prefix}launch.stderr.log`), 'w');
  const child = spawn(shell ? quoted(commandLine) : commandLine, shell ? args.map(quoted) : args, {
    cwd: SCRATCH,
    env: isolatedEnvironment(run),
    stdio: ['ignore', stdout, stderr],
    detached: true,
    shell,
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const receipt = (code: number | null, signal: string | null, error?: string) =>
    fs.writeFileSync(
      path.join(SCRATCH, `${prefix}launch.json`),
      JSON.stringify({
        commandLine,
        args,
        pid: child.pid ?? null,
        profile,
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

// The runner waits this long for the stopped editor processes to exit, and probes them at this interval.
export const EDITOR_EXIT_MS = 30_000;
const EDITOR_EXIT_CHECK_MS = 500;

// Probe the process ids until none exists or the deadline passes. Return the ids that exist at the last probe.
export async function awaitExit(
  pids: readonly number[],
  options: {
    alive: (pids: readonly number[]) => number[];
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<number[]> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const deadline = now() + EDITOR_EXIT_MS;
  for (;;) {
    const alive = pids.length ? options.alive(pids) : [];
    if (!alive.length || now() >= deadline) return alive;
    await wait(Math.min(EDITOR_EXIT_CHECK_MS, deadline - now()));
  }
}

// The ids that one Windows exit probe reports alive. A spawn error or a nonzero status means that the probe failed, so
// every id counts as alive. A zero status means that the output names every live id.
export function probedAlive(
  pids: readonly number[],
  status: number | null,
  stdout: string | null,
  error: Error | undefined,
): number[] {
  if (error || status !== 0) return [...pids];
  const found = new Set((stdout ?? '').split(/\s+/).filter(Boolean).map(Number));
  return pids.filter((pid) => found.has(pid));
}

// The ids of the processes that have not exited. Windows reads `HasExited`, which turns true only after the process
// teardown ends. `Get-Process` exits with status 1 when an id does not exist, so the query ends with `exit 0`.
// Linux and macOS send signal 0, which fails with `ESRCH` for a process that does not exist.
function aliveProcesses(pids: readonly number[]): number[] {
  if (process.platform === 'win32') {
    const query = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited } | ForEach-Object { $_.Id }; exit 0`;
    const result = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' });
    return probedAlive(pids, result.status, result.stdout, result.error);
  }
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  });
}

// The note of a run whose editor processes did not exit in time. A live process can still write the stores.
export function survivorNote(pids: readonly number[]): string {
  return `The editor processes ${pids.join(', ')} did not exit within ${EDITOR_EXIT_MS / 1000} s of the stop.`;
}

// Identify the run's editor processes by their isolated profile path before stopping them. Then wait until they exit,
// and return the ids of the processes that outlive the wait.
async function stopEditor(profile = USER_DATA): Promise<number[]> {
  const ownership = path.join(
    SCRATCH,
    profile === USER_DATA ? 'process-ownership.json' : 'warm-process-ownership.json',
  );
  if (process.platform === 'win32') {
    const escaped = profile.replaceAll("'", "''");
    const owned = ownership.replaceAll("'", "''");
    const query = `$profile='${escaped}'; $owned=@(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) }); $owned | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json | Set-Content -LiteralPath '${owned}'; foreach($entry in $owned) { $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)"; if($current -and $current.CreationDate -eq $entry.CreationDate -and $current.CommandLine -eq $entry.CommandLine) { Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue; $entry.ProcessId } }`;
    const stopped = spawnSync('powershell', ['-NoProfile', '-Command', query], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = (stopped.stdout ?? '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
    return awaitExit(pids, { alive: aliveProcesses });
  }
  const list = () =>
    spawnSync('ps', ['-eo', 'pid=,lstart=,args='], {
      encoding: 'utf8',
    }).stdout.split('\n');
  const owned = list().filter((line) => line.includes(profile));
  fs.writeFileSync(ownership, JSON.stringify(owned));
  const pids: number[] = [];
  for (const line of owned) {
    if (!list().includes(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isSafeInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid);
        pids.push(pid);
      } catch {}
    }
  }
  return awaitExit(pids, { alive: aliveProcesses });
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

// Measures of the measured launch beyond its startup milestones, written into result.json.
const runRecord: Record<string, unknown> = {};

// Wait until free memory reaches the floor. The runner holds every heavy lane lock, so no heavy lane runs beside it.
// Static and unit lanes can run beside it.
async function awaitMachine(minimumFreeGb: number, deadlineMs: number): Promise<void> {
  const { freeMemoryBytes } = await import('../../test/machineload.mjs');
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const free = freeMemoryBytes();
    if (free >= minimumFreeGb * 1024 ** 3) return;
    const busy = `Free memory is ${(free / 1024 ** 3).toFixed(1)} GB, below the ${minimumFreeGb} GB floor.`;
    if (Date.now() >= deadline) throw new Error(`The machine stayed loaded: ${busy}`);
    process.stdout.write(`Waiting before launch. ${busy}\n`);
    await delay(30_000);
  }
}

// The time from launch to the first accepted paint with usable session-list rows.
export function firstUsableRowMs(lines: LogLine[], launchedAt: number): number | null {
  const paint = lines.find(
    (line) =>
      line.event === 'measurementPaint' &&
      line.accepted === true &&
      line.stage === 'railReady' &&
      line.usableRows === true,
  );
  const at = Date.parse(paint?.at ?? '');
  return Number.isFinite(at) ? at - launchedAt : null;
}

// The measured host's startup history record, matched by process ID. The warm-up host writes its own record.
export function measuredStartupRecord(directory: string, pid: number | null): Record<string, unknown> | null {
  let records: Array<Record<string, unknown>> = [];
  try {
    records = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => fs.readFileSync(path.join(directory, name), 'utf8').split('\n'))
      .filter((text) => text.trim())
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  } catch {
    return null;
  }
  const own = records.filter((record) => pid !== null && record.pid === pid);
  const last = own.at(-1);
  if (!last) return null;
  return {
    pid,
    outcome: last.outcome,
    stages: last.stages,
    hidden: last.hidden ?? null,
    memory: last.memory,
    counters: last.counters ?? null,
  };
}

// The process ID that the measured extension host logged with its first accepted paint.
export function measuredHostPid(lines: LogLine[]): number | null {
  const paint = lines.find((line) => line.event === 'measurementPaint' && typeof line.hostPid === 'number');
  return paint?.hostPid ?? null;
}

// Keep the extension host's memory. Windows and Linux report the process's own peak, so the runner reads it once at
// the end. macOS reports only current resident size, so the runner keeps the largest of its ten-second samples.
class MemoryWatch {
  pid: number | null = null;
  last: HostMemory | null = null;
  maximumWorkingSetBytes = 0;
  samples = 0;
  sample(): void {
    if (this.pid === null) return;
    const memory = hostMemory(this.pid);
    if (!memory) return;
    this.samples++;
    this.maximumWorkingSetBytes = Math.max(this.maximumWorkingSetBytes, memory.workingSetBytes);
    this.last = memory;
  }
  record(): Record<string, unknown> {
    return {
      pid: this.pid,
      samples: this.samples,
      sampledMaximumWorkingSetBytes: this.maximumWorkingSetBytes || null,
      peakWorkingSetBytes: this.last?.peakWorkingSetBytes ?? null,
      lastPrivateBytes: this.last?.privateBytes ?? null,
    };
  }
}

async function requestSnapshot(name: string, deadlineMs: number): Promise<Record<string, unknown> | null> {
  fs.writeFileSync(path.join(SOAK, `${name}.request`), '');
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(SOAK, `${name}.failed`))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(SOAK, `${name}.json`), 'utf8')) as Record<string, unknown>;
    } catch {
      await delay(1000);
    }
  }
  return null;
}

const CHILD_TURN_MS = 30_000;

// The appends a soak of this length schedules: one every 30 seconds after its start, before its end.
export function scheduledAppends(minutes: number): number {
  return Math.max(0, Math.ceil((minutes * 60_000) / CHILD_TURN_MS) - 1);
}

// Keep the editor open, append a dispatched child turn every half minute, and save diagnostics every minute.
// Appends run on their own schedule, so a slow snapshot never reduces the work a build receives.
async function soak(minutes: number, launch: Launch): Promise<{ complete: boolean; note: string | null }> {
  const snapshots: Array<{ name: string; at: string; measures: Record<string, number> | null }> = [];
  const take = async (name: string) => {
    const snapshot = await requestSnapshot(name, 120_000);
    snapshots.push({ name, at: new Date().toISOString(), measures: snapshot ? soakMeasures(snapshot) : null });
    return snapshot;
  };
  const first = await take('000-start');
  const simulation = startDispatch(SOAK_PROJECTS, SOAK_CODEX, fixture.workspace);
  const start = Date.now();
  const end = start + minutes * 60_000;
  const appender = (async () => {
    for (let turn = 1; turn <= scheduledAppends(minutes) && launch.failure === null; turn++) {
      await delay(Math.max(0, start + turn * CHILD_TURN_MS - Date.now()));
      appendDispatchTurn(simulation, fixture.workspace);
    }
  })();
  for (let minute = 1; start + minute * 60_000 < end && launch.failure === null; minute++) {
    await delay(Math.max(0, start + minute * 60_000 - Date.now()));
    await take(String(minute).padStart(3, '0'));
  }
  await delay(Math.max(0, end - Date.now()));
  await appender;
  const last = await take('999-end');
  const startMeasures = first ? soakMeasures(first) : null;
  const endMeasures = last ? soakMeasures(last) : null;
  runRecord.soak = {
    minutes,
    snapshots,
    start: startMeasures,
    end: endMeasures,
    dispatch: {
      childId: simulation.childId,
      appends: simulation.appends,
      scheduled: scheduledAppends(minutes),
      bytes: simulation.bytes,
    },
    limits: [
      'The dispatched child is a synthetic Codex rollout that a synthetic Claude parent names. No agent process runs, and no dispatch receipt exists.',
      'The child grows by one completed turn every 30 seconds, with fixed token totals and 256 KiB of reasoning text per turn.',
      'The soak overlay reads its request directory once a second in the extension host of both builds.',
    ],
  };
  if (launch.failure !== null) return { complete: false, note: launch.failure };
  const missing = endMeasures ? missingSoakMeasures(endMeasures) : ['the end snapshot'];
  if (!startMeasures || missing.length)
    return { complete: false, note: `The soak saved no ${startMeasures ? missing.join(', ') : 'start snapshot'}.` };
  if (simulation.appends < scheduledAppends(minutes))
    return {
      complete: false,
      note: `The soak appended ${simulation.appends} of ${scheduledAppends(minutes)} scheduled child turns.`,
    };
  return { complete: true, note: null };
}

// A non-urgent derived-cache save waits up to five minutes after the last save, as `DERIVED_CACHE_CHECKPOINT_MS` in
// `panelhost.ts` sets. The warm-up stays open past that point, so its store holds what it learned.
export const WARM_UP_OPEN_MS = 5.5 * 60_000;

// A `--warm-until` hold starts a read at this interval, and fails the run this long after the warm-up launch.
export const WARM_UNTIL_INTERVAL_MS = 15_000;
export const WARM_UNTIL_CAP_MS = 30 * 60_000;
// The hold checks the warm-up editor at this interval while it keeps the minimum open time.
const WARM_UP_CHECK_MS = 5_000;

export interface WarmHold {
  reached: boolean;
  reads: number;
  // The reading that ended the hold, or the last reading.
  measures: Record<string, number> | null;
  // The measures of the snapshot that the runner takes after the hold ends.
  snapshot: Record<string, number> | null;
  note: string | null;
}

// One reading of a warm-up hold: the measures of a diagnostics snapshot and the runner measures, in one map. A
// snapshot that fails to arrive gives no reading.
export function holdReading(
  snapshot: Parameters<typeof soakMeasures>[0] | null,
  runner: () => Record<string, number>,
): Record<string, number> | null {
  if (!snapshot) return null;
  const measures = soakMeasures(snapshot);
  for (const [name, value] of Object.entries(runner())) {
    if (Object.hasOwn(measures, name))
      throw new Error(`The runner measure ${name} has the name of a snapshot measure.`);
    measures[name] = value;
  }
  return measures;
}

// Keep the warm-up open for `minimumMs` after its launch. Then start a read every interval, until one reading holds
// every condition. Reads start on a fixed schedule, so a slow read does not delay the next start. A read that runs past
// a start moves the next read to the first later start. A reading that is missing holds no condition. The hold fails
// at the cap after the launch, and a read that returns after the cap fails it too. An editor failure before a read
// starts or before its values count fails the hold.
export async function holdUntil(options: {
  conditions: WarmCondition[];
  launchedAt: number;
  sample: (index: number) => Promise<Record<string, number> | null>;
  minimumMs?: number;
  failure?: () => string | null;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<WarmHold> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const deadline = options.launchedAt + WARM_UNTIL_CAP_MS;
  let next = options.launchedAt + (options.minimumMs ?? WARM_UP_OPEN_MS);
  let measures: Record<string, number> | null = null;
  let reads = 0;
  const ended = (reached: boolean, note: string | null): WarmHold => ({
    reached,
    reads,
    measures,
    snapshot: null,
    note,
  });
  const capped = () => {
    const wanted = options.conditions.map((condition) => `${condition.measure}=${condition.value}`).join(', ');
    const last = options.conditions
      .map((condition) => `${condition.measure} read ${measures?.[condition.measure] ?? 'nothing'}`)
      .join(', ');
    return ended(
      false,
      `The warm-up did not reach ${wanted} within ${WARM_UNTIL_CAP_MS / 60_000} min of its launch: ${last}.`,
    );
  };
  while (now() < next) {
    const failure = options.failure?.() ?? null;
    if (failure) return ended(false, failure);
    await wait(Math.min(WARM_UP_CHECK_MS, next - now()));
  }
  for (;;) {
    const failure = options.failure?.() ?? null;
    if (failure) return ended(false, failure);
    if (now() >= deadline) return capped();
    const startedAt = now();
    const sampled = await options.sample(++reads);
    const failed = options.failure?.() ?? null;
    if (failed) return ended(false, failed);
    measures = sampled;
    if (now() > deadline) return capped();
    const read = measures;
    if (read && options.conditions.every((condition) => read[condition.measure] === condition.value))
      return ended(true, null);
    next = Math.max(next, startedAt) + WARM_UNTIL_INTERVAL_MS;
    while (next < now()) next += WARM_UNTIL_INTERVAL_MS;
    await wait(Math.max(0, Math.min(next, deadline) - now()));
  }
}

// Take the snapshot after a hold that reached every value. The hold fails when that snapshot does not return, or when
// the editor fails before the runner accepts it.
export async function finishHold(
  hold: WarmHold,
  requestEnd: () => Promise<Parameters<typeof soakMeasures>[0] | null>,
  failure: () => string | null,
): Promise<WarmHold> {
  if (!hold.reached) return hold;
  const snapshot = await requestEnd();
  const failed = failure();
  if (failed) return { ...hold, reached: false, note: `The editor failed during the end snapshot. ${failed}` };
  if (!snapshot) return { ...hold, reached: false, note: 'The end snapshot of the warm-up did not return.' };
  return { ...hold, snapshot: soakMeasures(snapshot) };
}

// The peak scratch disk of one repetition: the fixture tree hard-linked under the scratch directory, or copied when the
// two sit on different volumes.
export const SCRATCH_PEAK_BYTES = { linked: 4 * 1024 ** 3, copied: 16.5 * 1024 ** 3 } as const;

export function scratchPeakBytes(source: string, scratch: string): number {
  return fs.statSync(source).dev === fs.statSync(scratch).dev ? SCRATCH_PEAK_BYTES.linked : SCRATCH_PEAK_BYTES.copied;
}

export function freeDiskBytes(directory: string): number {
  const volume = fs.statfsSync(directory);
  return volume.bavail * volume.bsize;
}

// A repetition starts only with free disk of at least twice its peak scratch.
export function diskPreCheck(freeBytes: number, peakBytes: number): string | null {
  if (freeBytes >= 2 * peakBytes) return null;
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `Free disk is ${gb(freeBytes)} GB, under twice the ${gb(peakBytes)} GB peak scratch of one repetition.`;
}

export interface BuildKey {
  source: string;
  selection: boolean;
  response: boolean;
  snapshots: boolean;
}

export interface Build {
  vsix: string;
  artifact: string;
}

// A build directory holds one packaged build and the key it was built for. A repetition with an equal key installs it
// and builds nothing.
export function cachedBuild(directory: string, key: BuildKey): Build | null {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8')) as {
      key?: BuildKey;
      artifact?: string;
    };
    const vsix = path.join(directory, 'arc.vsix');
    if (JSON.stringify(saved.key) !== JSON.stringify(key) || typeof saved.artifact !== 'string' || !fs.existsSync(vsix))
      return null;
    return { vsix, artifact: saved.artifact };
  } catch {
    return null;
  }
}

// The build key of a run: its source commit and the overlays its options add.
export function buildKeyOf(options: Options, source: string): BuildKey {
  return {
    source,
    selection: options.selection,
    response: options.response,
    snapshots: options.soakMinutes > 0 || options.warmUntil.length > 0,
  };
}

// Install the kept build of the cache directory when its key is equal, and otherwise build and keep the result.
export function preparedBuild(directory: string | null, key: BuildKey, build: () => Build): Build {
  const cached = directory ? cachedBuild(directory, key) : null;
  if (cached) return cached;
  const built = build();
  return directory ? saveBuild(directory, key, built) : built;
}

export function saveBuild(directory: string, key: BuildKey, build: Build): Build {
  fs.mkdirSync(directory, { recursive: true });
  const vsix = path.join(directory, 'arc.vsix');
  fs.copyFileSync(build.vsix, vsix);
  fs.writeFileSync(path.join(directory, 'build.json'), JSON.stringify({ key, artifact: build.artifact }));
  return { vsix, artifact: build.artifact };
}

// The two compressed rollout stores: the machine store of openings in the cache directory, and the facts store in each
// workspace directory of the cache.
export const COMPRESSED_STORES = {
  openings: 'compressed-rollout-openings-v1',
  facts: 'compressed-rollout-facts-v1',
} as const;
const COMPRESSED_TEMP_PREFIX = 'arc-compressed-';

type Stat = (file: string) => { size: number };

function directoryBytes(directory: string, stat: Stat): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(target, stat);
    else if (entry.isFile()) {
      // The worker can replace a store file between the listing and the stat. A replaced file adds nothing.
      try {
        bytes += stat(target).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return bytes;
}

// The bytes of both compressed rollout stores under an Arc home. An absent store or file reads 0.
export function compressedStoreBytes(home: string, stat: Stat = fs.statSync): number {
  const cache = path.join(home, 'cache');
  let bytes = directoryBytes(path.join(cache, COMPRESSED_STORES.openings), stat);
  let workspaces: fs.Dirent[] = [];
  try {
    workspaces = fs.readdirSync(cache, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const workspace of workspaces)
    if (workspace.isDirectory() && workspace.name !== COMPRESSED_STORES.openings)
      bytes += directoryBytes(path.join(cache, workspace.name, COMPRESSED_STORES.facts), stat);
  return bytes;
}

// The top-level names in a Temp listing that a compressed rollout reader can leave behind.
export function compressedTempNames(names: readonly string[]): Set<string> {
  return new Set(names.filter((name) => name.startsWith(COMPRESSED_TEMP_PREFIX)));
}

function listTemp(): string[] {
  return fs.readdirSync(os.tmpdir());
}

// The measures the runner computes from files under the run's Arc home and from the Temp directory. Every runner
// measure is added here, and the warm-up hold and the `runner` block of `result.json` both read this map.
export function runnerMeasures(input: {
  home: string;
  tempBefore: ReadonlySet<string>;
  listTemp?: () => string[];
}): Record<string, number> {
  const after = compressedTempNames((input.listTemp ?? listTemp)());
  return {
    compressedStoreBytes: compressedStoreBytes(input.home),
    compressedTempEntries: [...after].filter((name) => !input.tempBefore.has(name)).length,
  };
}

// Count the compressed rollouts of a fixture that would list as session rows. The roots are those of `sessionCount`.
// A `.jsonl` twin excludes its compressed copy, and the count holds each session key once. A rollout without an id in
// its first record takes the id of its file name, as `codexSessionFiles` keys it.
export async function countCompressed(input: {
  workspace: string;
  codex: string;
  rollouts: ReadonlyArray<{ file: string }>;
}): Promise<number> {
  const inFolders = folderMatcher(repositoryRoots(input.workspace));
  const keys = new Set<string>();
  for (const entry of input.rollouts) {
    const file = path.join(input.codex, path.relative('codex', entry.file));
    const plain = file.slice(0, -'.zst'.length);
    if (!isCompressedRollout(file) || fs.existsSync(plain)) continue;
    const meta = openingRecordOf(await readCompressedFirstRecord(file, CODEX_OPENING_BYTES));
    if (!meta || !codexRowAdmitted(meta, readRolloutStat(file), inFolders)) continue;
    const named = ROLLOUT_NAME.exec(path.basename(plain));
    keys.add(meta.sessionId || (named ? named[1] : path.basename(plain, '.jsonl')));
  }
  return keys.size;
}

// Wait for every startup milestone by the measurement deadline.
// Selection runs also measure session switching. A soak keeps the editor open afterwards.
// Editor failure or timeout ends an incomplete run.
async function measure(commandLine: string, workspace: string, options: Options): Promise<Outcome> {
  const timeoutMs = options.timeoutMs;
  const { acquireHeavyLaneLocks } = await import('../../test/machineload.mjs');
  const { createTestObservation } = await import('../../test/observations.mjs');
  const observation = createTestObservation({ lane: 'panel startup measurement', cwd: REPOSITORY, capacity: 1 });
  observation.unavailable('build', 'The measured build is prepared before this request.');
  let failure: string | null = null;
  let complete = false;
  let locks: { release(): void } | null = null;
  const survivors: number[] = [];
  try {
    // A measured launch holds every heavy lane lock, so no heavy test lane overlaps it. The runner waits for each lock
    // like a suite lane does, and refuses to start inside a test run.
    locks = await acquireHeavyLaneLocks({ observation });
    const logs = path.join(ARC_STORE, DIAGNOSTICS_LOG_DIRECTORY);
    const reader = new LogReader(logs);
    if (options.warmUp) {
      await awaitMachine(options.minimumFreeGb, 10 * 60_000);
      const warmRun = `${MEASUREMENT_RUN}-warm`;
      const warmTempBefore = compressedTempNames(listTemp());
      const warmAt = Date.now();
      const warmLaunch = launchEditor(commandLine, workspace, WARM_USER_DATA, warmRun);
      try {
        const warm = await pollStartup(() => reader.read(), warmLaunch, timeoutMs, warmRun, expectedSelection);
        runRecord.warmUp = {
          complete: warm.complete,
          note: warm.note,
          completeRenderMs: milestoneOf(warm.lines, 'completeRender').hostMs,
          openMs: null as number | null,
        };
        // A failed warm-up leaves a partly filled store, which no comparison may treat as warm.
        if (!warm.complete) return { ...warm, complete: false, note: `The warm-up launch failed. ${warm.note ?? ''}` };
        if (options.warmUntil.length) {
          const failure = () => warmLaunch.failure;
          const reading = await holdUntil({
            conditions: options.warmUntil,
            launchedAt: warmAt,
            sample: async (index) =>
              holdReading(await requestSnapshot(`warm-${String(index).padStart(3, '0')}`, 120_000), () =>
                runnerMeasures({ home: ARC_STORE, tempBefore: warmTempBefore }),
              ),
            failure,
          });
          const hold = await finishHold(reading, () => requestSnapshot('warm-end', 120_000), failure);
          Object.assign(runRecord.warmUp as object, { until: options.warmUntil, hold });
          (runRecord.warmUp as { openMs: number | null }).openMs = Date.now() - warmAt;
          if (!hold.reached) return { ...warm, complete: false, note: `The warm-up hold failed. ${hold.note ?? ''}` };
        } else {
          while (Date.now() < warmAt + WARM_UP_OPEN_MS && warmLaunch.failure === null)
            await delay(Math.min(5_000, warmAt + WARM_UP_OPEN_MS - Date.now()));
          (runRecord.warmUp as { openMs: number | null }).openMs = Date.now() - warmAt;
        }
      } finally {
        survivors.push(...(await stopEditor(WARM_USER_DATA)));
      }
      // A warm-up process that outlives the wait can still write the store that the measured launch reads.
      if (survivors.length) return { lines: [], instance: null, complete: false, note: survivorNote(survivors) };
    }
    await awaitMachine(options.minimumFreeGb, 10 * 60_000);
    const memory = new MemoryWatch();
    const tempBefore = compressedTempNames(listTemp());
    const launchedAt = Date.now();
    const launch = launchEditor(commandLine, workspace);
    const sampler =
      process.platform === 'darwin'
        ? setInterval(() => {
            memory.pid ??= measuredHostPid(reader.read());
            memory.sample();
          }, 10_000)
        : null;
    observation.begin('execution', { boundary: 'Startup and selection measurement await' });
    try {
      const outcome = await pollStartup(() => reader.read(), launch, timeoutMs, MEASUREMENT_RUN, expectedSelection);
      memory.pid ??= measuredHostPid(outcome.lines);
      runRecord.firstUsableRowMs = firstUsableRowMs(outcome.lines, launchedAt);
      if (outcome.complete && selectionRequested) {
        const result = responseRequested
          ? await measureResponse(SCRATCH, timeoutMs)
          : await measureSelection(SCRATCH, timeoutMs);
        complete = result.complete;
        return { ...outcome, note: result.note, complete: result.complete };
      }
      if (outcome.complete && options.soakMinutes > 0) {
        const result = await soak(options.soakMinutes, launch);
        complete = result.complete;
        return {
          ...outcome,
          lines: linesOf(reader.read(), outcome.instance, MEASUREMENT_RUN),
          note: result.note,
          complete,
        };
      }
      complete = outcome.complete;
      return outcome;
    } finally {
      if (sampler) clearInterval(sampler);
      memory.sample();
      runRecord.memory = memory.record();
      observation.end('execution');
      observation.begin('cleanup');
      // The stores and the Temp listing are read only after the editor processes exit, or after the wait ends.
      survivors.push(...(await stopEditor()));
      if (survivors.length) complete = false;
      runRecord.editorSurvivors = survivors;
      runRecord.runner = runnerMeasures({ home: ARC_STORE, tempBefore });
      runRecord.startupRecord = measuredStartupRecord(path.join(ARC_STORE, 'startup'), memory.pid);
      observation.end('cleanup', { descendants: 'unobserved' });
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    locks?.release();
    observation.finish({
      outcome: failure ? 'failure' : complete ? 'success' : 'incomplete',
      reason: failure ?? (complete ? null : 'Startup measurement remained incomplete.'),
    });
  }
}

interface SessionCount {
  claude: number;
  children: number;
  codex: number;
  total: number;
}

// Include the workspace folder and its repository's registered worktrees.
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

// Count Claude sessions with human prompts, discovered Claude children, and Codex sessions across repository roots.
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

async function loadScrubbedVariables(): Promise<void> {
  ({ SCRUBBED_VARIABLES: scrubbedVariables } = await import('../../../scripts/isolated-editor.mjs'));
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  if (options.countCompressed) {
    const root = path.dirname(fs.realpathSync(options.countCompressed));
    const raw = JSON.parse(fs.readFileSync(options.countCompressed, 'utf8'));
    const paths = frozenFixturePaths(root, raw, liveDirectories(root));
    const count = await countCompressed({
      workspace: paths.workspace,
      codex: paths.codex,
      rollouts: raw.frozen?.compressed?.rollouts ?? [],
    });
    fs.rmdirSync(SCRATCH);
    process.stdout.write(`Compressed rows: ${count}\n`);
    return;
  }
  selectionRequested = options.selection;
  soakRequested = options.soakMinutes > 0;
  responseRequested = options.response;
  warmUntilRequested = options.warmUntil.length > 0;
  await loadScrubbedVariables();
  loadFixture(options.fixture);
  options.workspace = fixture.workspace;
  const disk = diskPreCheck(freeDiskBytes(SCRATCH), scratchPeakBytes(fixture.codex, SCRATCH));
  if (disk) stop(disk);
  const commandLine = editorCommandLine();
  for (const directory of [SCRATCH, USER_DATA, EXTENSIONS, ARC_STORE]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  try {
    const source = git(['rev-parse', options.commit ?? 'HEAD']);
    const label = git(['rev-parse', '--short', source]);
    const key = buildKeyOf(options, source);
    const build = preparedBuild(options.buildCache, key, () => {
      const tree = prepareTree(source);
      protectBaseline(tree);
      instrumentStartup(tree);
      if (selectionRequested) instrumentSelection(tree);
      if (responseRequested) instrumentResponse(tree);
      if (key.snapshots) instrumentSoak(tree);
      npm(['run', 'build'], path.join(tree, 'extension'));
      npm(['run', 'package'], path.join(tree, 'extension'));
      const bundle = fs.readFileSync(path.join(tree, 'extension', 'dist', 'extension.js'));
      if (!bundle.toString('utf8').includes('MEASURE_BLOCK_AGENTS'))
        throw new Error('The built extension lacks the agent launch block.');
      return {
        vsix: path.join(tree, 'extension', 'arc.vsix'),
        artifact: createHash('sha256').update(bundle).digest('hex'),
      };
    });
    run(
      commandLine,
      ['--user-data-dir', USER_DATA, '--extensions-dir', EXTENSIONS, '--install-extension', build.vsix, '--force'],
      SCRATCH,
      isolatedEnvironment(),
    );
    seedProfile();
    const artifact = build.artifact;
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
        ...(key.snapshots
          ? {
              soakOverlaySha256: createHash('sha256')
                .update(fs.readFileSync(path.join(__dirname, 'soak.ts')))
                .digest('hex'),
            }
          : {}),
        warmUp: options.warmUp,
        warmUntil: options.warmUntil,
        buildCache: options.buildCache,
        route: 'created',
        settings: { detailedLog: true },
        cacheStore: ARC_STORE,
      }),
    );
    process.stdout.write(`Owned paths and artifacts: ${SCRATCH}\n`);
    const measured = await measure(commandLine, options.workspace, options);
    // A process that outlives the stop can still write the stores, so the runner block is not reliable.
    const survivors = (runRecord.editorSurvivors ?? []) as number[];
    const outcome = survivors.length
      ? { ...measured, complete: false, note: `${survivorNote(survivors)} ${measured.note ?? ''}`.trimEnd() }
      : measured;
    fs.writeFileSync(
      path.join(SCRATCH, 'result.json'),
      JSON.stringify(
        {
          source,
          artifact,
          expectedSelection,
          deadlineMs: options.timeoutMs,
          ...runRecord,
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
