import assert from 'node:assert';
import { test, vi } from 'vitest';
import * as fs from 'node:fs';
import { tempDir } from './temproot.ts';
import * as path from 'node:path';
import type { Page } from 'playwright-core';
import { firstProjectPayload, shoot, writeLosslessWebp, runPanelShots, panelShotDestination, loadBoundedPanelCapture } from '../scripts/panel-shots.ts';
import { RAIL_STATS, renderPayload } from './panelfixture.ts';
import { missingUsageLimits, publish } from '../scripts/readme-shots.ts';
import { DEMO_LABELS, DEMO_SESSION_IDS, README_SCENES, demoPayload, readmePayload } from '../scripts/readme-fixture.ts';
import { turnCost } from './turncard.ts';
import { claudeLaunchKind } from './transcript.ts';
import type { SessionStatChip, TurnCard } from './turncard.ts';
import type { RailCard, SessionParent } from './turnrail.ts';
import { estimateCost, formatCost } from './pricing.ts';
import { manifestMenu, whenHolds } from '../scripts/web-demo-menu.ts';
import type { UsageBar } from './usageview.ts';
import type { ComposerView, SessionLauncherView } from './composerview.ts';
import { CAPTURE_TIME, DEMO_RAIL_FOLDS } from '../scripts/readme-fixture.ts';
import { DEMO_DEFAULTS, DEMO_MODELS, codexDefaultContext } from '../scripts/demo-catalog.ts';
import { defaultsSnapshot } from '../scripts/demo-catalog-check.ts';
import { readDefaultConfiguration, readModels } from './codexwire.ts';
import { modelPicks, effortPicks } from './view/model-picks.ts';
import { railSections, RAIL_FOLDS } from './view/rail.ts';
import { DEMO_HOST_POLICY, demoContextReply } from '../scripts/web-demo-host.ts';
import { DEMO_DEFAULT_EXPIRY, DEMO_TURNS, demoContextSample } from '../scripts/readme-fixture.ts';
import { validContextDetail } from './domain/context-detail.ts';
import { parseHostToPanel, parsePanelToHost } from './webview/protocol.ts';
import type { TurnComment } from './turncomments.ts';

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }));

test('ordinary shots command awaits the bounded owner capture and preserves its failure', async () => {
  const argv = ['--owner', '2026-10-07-example', '--run', 'one', '--reservation', '1000000', '--shots', 'wide'];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const capture = vi.fn<(argv: string[]) => Promise<void>>(async () => { await pending; });
  const legacy = vi.fn<(directory: string) => Promise<void>>(async () => {});
  let finished = false;
  const running = runPanelShots(argv, async () => capture, legacy).then(() => { finished = true; });
  try {
    await vi.waitFor(() => assert.deepEqual(capture.mock.calls, [[argv]]));
    assert.equal(finished, false);
    assert.equal(legacy.mock.calls.length, 0);
  } finally {
    release();
    await running;
  }
  const failure = new Error('bounded finish failed');
  await assert.rejects(runPanelShots(argv, async () => async () => { throw failure; }, legacy), (error) => error === failure);
  assert.equal(legacy.mock.calls.length, 0);
});

test('ordinary shots command rejects incomplete options and preserves safe legacy destinations', async () => {
  const load = vi.fn<() => Promise<(argv: string[]) => Promise<void>>>(async () => async () => {});
  const legacy = vi.fn<(directory: string) => Promise<void>>(async () => {});
  for (const argv of [
    ['--owner', 'example'], ['--owner', '--run', 'one', '--reservation', '1000000'],
    ['--owner', 'example', '--run', 'one', '--reservation'],
    ['--owner', 'example', '--run', 'one', '--reservation', '1000000', '--owner', 'other'],
    ['--unknown', 'value'], ['safe', 'extra'], ['--shots', 'wide'],
  ]) await assert.rejects(runPanelShots(argv, load, legacy));
  assert.equal(load.mock.calls.length, 0);
  assert.equal(legacy.mock.calls.length, 0);
  const safe = path.join(tempDir('shots-command-'), 'safe');
  await runPanelShots([safe], load, legacy);
  await runPanelShots([], load, legacy);
  assert.deepEqual(legacy.mock.calls, [[safe], [path.resolve(__dirname, '../shots')]]);
  assert.equal(fs.existsSync(safe), false);
  assert.equal(load.mock.calls.length, 0);
});

test('ordinary shots command refuses direct plans before capture on every platform', async () => {
  const directory = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const cwd = platform === 'win32' ? 'C:\\Arc' : '/arc';
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const inspect = vi.fn<(file: string) => ReturnType<typeof directory>>(directory);
    for (const destination of ['.claude/plans', '.CLAUDE/PlAnS/owner/run']) {
      assert.throws(() => panelShotDestination(destination, cwd, platform, inspect), /Plan screenshots require/);
    }
    assert.equal(inspect.mock.calls.length, 0);
    assert.equal(panelShotDestination('safe/shots', cwd, platform, inspect), paths.resolve(cwd, 'safe/shots'));
    if (platform !== 'win32') {
      assert.equal(panelShotDestination('.claude\\plans', cwd, platform, inspect), '/arc/.claude\\plans');
    }
  }
  const legacy = vi.fn<(directory: string) => Promise<void>>(async () => {});
  const load = vi.fn<() => Promise<(argv: string[]) => Promise<void>>>(async () => async () => {});
  const destination = path.join(tempDir('shots-plan-'), '.claude', 'plans', 'owner', 'run');
  await assert.rejects(runPanelShots([destination], load, legacy), /Plan screenshots require/);
  assert.equal(legacy.mock.calls.length, 0);
  assert.equal(load.mock.calls.length, 0);
  assert.equal(fs.existsSync(destination), false);
});

test('ordinary shots command stops ancestor inspection at a redirect or unreadable path', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const cwd = platform === 'win32' ? 'C:\\Arc' : '/arc';
    const redirect = paths.join(cwd, 'linked');
    const inspect = vi.fn<(file: string) => Pick<fs.Stats, 'isDirectory' | 'isSymbolicLink'>>((file: string) => ({ isDirectory: () => true, isSymbolicLink: () => file === redirect }));
    assert.throws(() => panelShotDestination('linked/unopened/shots', cwd, platform, inspect), /contains a redirect/);
    assert.equal(inspect.mock.calls.at(-1)![0], redirect);
    assert.ok(inspect.mock.calls.every(([file]) => !file.includes('unopened')));
    assert.throws(() => panelShotDestination('safe', cwd, platform, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), /denied/);
  }
});

test('ordinary shots command fails closed without its adapter', async () => {
  const argv = ['--owner', '2026-10-07-example', '--run', 'one', '--reservation', '1000000'];
  const legacy = vi.fn<(directory: string) => Promise<void>>(async () => {});
  const missing = path.join(tempDir('shots-adapter-'), 'missing.mjs');
  await assert.rejects(runPanelShots(argv, () => loadBoundedPanelCapture(missing), legacy), /adapter is unavailable/);
  assert.equal(legacy.mock.calls.length, 0);
});

test('README capture keeps the previous complete image set when a scene is missing', () => {
  const staged = tempDir('readme-staged-');
  const publicDir = tempDir('readme-public-');
  for (const scene of README_SCENES) fs.writeFileSync(path.join(publicDir, `readme-${scene}.webp`), `old ${scene}`);
  for (const scene of README_SCENES.slice(0, -1)) fs.writeFileSync(path.join(staged, `readme-${scene}.webp`), `new ${scene}`);
  assert.throws(() => publish(staged, publicDir));
  for (const scene of README_SCENES) {
    assert.equal(fs.readFileSync(path.join(publicDir, `readme-${scene}.webp`), 'utf8'), `old ${scene}`);
  }
});

test('README capture keeps recoverable originals when a failed copy also blocks rollback', () => {
  const staged = tempDir('readme-staged-');
  const publicDir = tempDir('readme-public-');
  for (const scene of README_SCENES) {
    const name = `readme-${scene}.webp`;
    fs.writeFileSync(path.join(staged, name), `new ${scene}`);
    fs.writeFileSync(path.join(publicDir, name), `old ${scene}`);
  }
  let stagedCopies = 0;
  let backup = '';
  assert.throws(
    () =>
      publish(staged, publicDir, (source, target) => {
        const sourcePath = String(source);
        if (sourcePath.startsWith(staged) && ++stagedCopies === 2) throw new Error('destination is locked');
        if (sourcePath.includes('arc-readme-backup-') && path.basename(sourcePath) === `readme-${README_SCENES[0]}.webp`) {
          backup = path.dirname(sourcePath);
          throw new Error('rollback destination is locked');
        }
        fs.copyFileSync(source, target);
      }),
    /Previous images remain in/,
  );
  assert.ok(backup);
  for (const scene of README_SCENES) {
    assert.equal(fs.readFileSync(path.join(backup, `readme-${scene}.webp`), 'utf8'), `old ${scene}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
});

test('README scenes use one synthetic session and a matching selected card', () => {
  const payload = readmePayload() as { cards: { sessionId: string }[]; sessions: { id: string }[]; showing: string; rail: unknown[] };
  assert.equal(payload.sessions.length, 6);
  assert.equal(payload.rail.length, payload.sessions.length);
  assert.equal(payload.cards[0].sessionId, payload.showing);
});

// These checks cover relationships and money without launching a browser.
test('demo samples keep dispatched costs and reader-started usage separate from README scenes', () => {
  type DemoPayload = {
    cards: TurnCard[];
    showing: string;
    sessions: { id: string; parent?: SessionParent }[];
    stats: Record<string, SessionStatChip[]>;
    rail: RailCard[];
    railVariants: Record<string, Record<string, Pick<RailCard, 'agentRun' | 'menuSection'>>>;
    usage: { bar: UsageBar };
  };
  const before = README_SCENES.map((scene) => readmePayload(scene));
  const samples = DEMO_SESSION_IDS.map((id) => demoPayload(id) as DemoPayload);
  assert.deepEqual(DEMO_SESSION_IDS.slice(-3), ['arc-demo-dispatch', 'arc-demo-review', 'arc-demo-continuation']);
  assert.equal(samples[0].showing, 'arc-read-state');
  assert.equal(samples[0].cards[0].agent, 'Claude');
  assert.equal(DEMO_TURNS['arc-codex-read-state'][0].agent, 'codex');
  const prompts = new Set<string>();
  for (const payload of samples) {
    assert.equal(payload.cards[0].sessionId, payload.showing);
    assert.deepEqual(new Set(payload.sessions.map((row) => row.id)), new Set(DEMO_SESSION_IDS));
    assert.deepEqual(new Set(payload.rail.map((row) => row.id)), new Set(DEMO_SESSION_IDS));
    assert.equal(Object.keys(payload.railVariants).length, 6);
    for (const id of DEMO_SESSION_IDS) {
      assert.ok(payload.stats[id]?.length, `No figures for ${id}`);
      assert.ok(DEMO_LABELS[id]);
      for (const variants of Object.values(payload.railVariants)) assert.ok(variants[id], `No rail variant for ${id}`);
    }
    for (const card of payload.cards) {
      assert.ok(!prompts.has(card.key), `Duplicate turn key ${card.key}`);
      prompts.add(card.key);
    }
    assert.ok(payload.usage.bar.groups.length);
  }
  const [parent, review, continuation] = samples.slice(-3);
  const parentOf = (payload: DemoPayload) => payload.sessions.find((row) => row.id === payload.showing)?.parent;
  assert.deepEqual(parentOf(review), { id: 'arc-demo-dispatch', label: 'Review the web demo', relation: 'dispatched' });
  assert.deepEqual(parentOf(continuation), { id: 'arc-demo-dispatch', label: 'Review the web demo', relation: 'reader' });
  assert.equal(parentOf(parent), undefined);
  assert.equal(review.rail.find((row) => row.id === review.showing)?.runByAgent, true);
  assert.equal(continuation.rail.find((row) => row.id === continuation.showing)?.runByAgent, false);
  assert.equal(review.railVariants['normal:read'][review.showing].agentRun, true);
  assert.equal(review.railVariants['pinned:unread'][review.showing].agentRun, true);
  assert.equal(review.railVariants['archived:unread'][review.showing].agentRun, false);
  const card = parent.cards[0];
  assert.equal(card.agents.length, 0);
  assert.equal(card.dispatched?.length, 1);
  assert.ok(card.dispatched);
  assert.equal(card.dispatched[0].sessionId, 'arc-demo-review');
  assert.deepEqual(card.dispatched[0].files, []);
  assert.deepEqual(card.dispatched[0].commits, []);
  assert.equal(card.chips.find((chip) => chip.metric === 'dispatched')?.detailList?.layout, 'dispatched');
  assert.equal(card.dispatched[0].effort, 'xhigh');
  assert.deepEqual(review.cards[0].files, []);
  assert.deepEqual(review.cards[0].commits, []);
  const dollars = (payload: DemoPayload) => payload.stats[payload.showing].find((chip) => chip.metric === 'cost')!.dollars!;
  const own = estimateCost({ requests: 4, input: 8_000, cacheWrite5m: 20_000, cacheWrite1h: 0, cacheRead: 64_000, output: 2_500, thinking: 0 }, 'claude-opus-5-5', null, 200_000)!;
  assert.ok(Math.abs(dollars(parent) - own - dollars(review)) < 1e-9);
  assert.equal(card.chips.find((chip) => chip.metric === 'cost')?.label, formatCost(own));
  const readerOwn = estimateCost({ requests: 2, input: 4_000, cacheWrite5m: 0, cacheWrite1h: 9_000, cacheRead: 9_000, output: 1_500, thinking: 0 }, 'claude-opus-5-5', null, 200_000)!;
  assert.equal(dollars(continuation), readerOwn);
  assert.deepEqual(DEMO_LABELS['arc-demo-continuation'], DEMO_LABELS['arc-demo-dispatch']);
  assert.notEqual(DEMO_LABELS['arc-demo-continuation'], DEMO_LABELS['arc-demo-dispatch']);
  assert.deepEqual(README_SCENES.map((scene) => readmePayload(scene)), before);
  assert.equal((readmePayload('main').usage as { bar: unknown }).bar, null);
});

test('demo selections keep available setups, cache facts, and their own prompt target', () => {
  type Payload = { cards: (TurnCard & { summaryHtml: string })[]; rail: RailCard[]; usage: { composer: ComposerView; launcher: SessionLauncherView } };
  for (const id of DEMO_SESSION_IDS) {
    const payload = demoPayload(id) as Payload;
    assert.equal(payload.usage.composer.sessionId, id);
    if (id === 'arc-cache-run' || id === 'arc-sol-read-state') assert.equal(payload.usage.composer.nextTurn, null);
    else assert.ok(payload.usage.composer.nextTurn, `No Next turn for ${id}`);
    assert.deepEqual(payload.usage.launcher.pinned.map((row) => [row.profile.agent, row.profile.model, row.profile.effort, row.profile.permissionMode, row.available]), [
      ['claude', 'claude-opus-5-5', 'high', 'auto', true],
      ['codex', 'gpt-6.1-sol', 'high', 'never', true],
    ]);
    assert.deepEqual(payload.usage.launcher.agents.map((agent) => agent.value), ['claude', 'codex']);
    const setup = payload.usage.launcher.primary?.profile;
    if (!setup) { assert.equal(id, 'arc-cache-run'); continue; }
    const agent = payload.usage.launcher.agents.find((agent) => agent.value === setup.agent)!;
    const model = agent.models.find((model) => model.value === setup.model || model.identity === setup.model || model.aliases?.includes(setup.model))!;
    assert.ok(model);
    assert.ok(model.efforts.some((effort) => effort.value === setup.effort));
    const warm = payload.rail.find((row) => row.id === 'delegated-cost')!.cache!;
    const expiring = payload.rail.find((row) => row.id === 'arc-demo-continuation')!.cache!;
    assert.ok(warm.expiresAt > CAPTURE_TIME);
    assert.ok(warm.nearlyGoneAt! > CAPTURE_TIME);
    assert.ok(expiring.expiresAt > CAPTURE_TIME);
    assert.ok(expiring.nearlyGoneAt! < CAPTURE_TIME);
  }
  const main = demoPayload('arc-read-state') as Payload;
  assert.equal(main.usage.launcher.primary!.profile.model, 'opus');
  assert.match(main.cards[0].summaryHtml, /<table>/);
  assert.deepEqual(DEMO_SESSION_IDS.filter((id) => id === 'arc-open-changes' || id === 'session-search'), []);
  const cost = demoPayload('delegated-cost') as Payload;
  assert.equal(cost.cards.length, 4);
  assert.ok(cost.cards.every((card) => card.sessionId === 'delegated-cost'));
});

test('default demo review command supports direct Codex dispatch recognition', () => {
  const launch = DEMO_TURNS['arc-read-state'][0].steps.find((step) => step.ordinal === 24);
  assert.ok(launch);
  assert.deepEqual(claudeLaunchKind(launch.detail, 'bash'), { kind: 'codex-native', count: 1 });
});

test('demo makers open distinct children with matching parent and turn chronology', () => {
  const main = demoPayload('arc-read-state') as { cards: TurnCard[] };
  const maker = main.cards[0].agents.find((agent) => agent.sessionId === 'arc-luna-read-state-tests')!;
  assert.ok(maker);
  const sourceAgent = DEMO_TURNS['arc-read-state'][0].agents.find((agent) => agent.childSessionId === maker.sessionId)!;
  const sourceChild = DEMO_TURNS[maker.sessionId!][0];
  assert.deepEqual(sourceAgent.spend[0].usage, sourceChild.usage, 'the child and parent disagree on delegated usage');
  assert.equal(sourceAgent.model, sourceChild.model, 'the child and parent disagree on the priced model');
  const usage = sourceChild.usage;
  assert.equal(sourceAgent.tokens, usage.input + usage.cacheWrite1h + usage.cacheWrite5m + (usage.cacheWrite30m ?? 0) + usage.cacheRead + usage.output, 'delegated tokens omit a usage category');
  const child = demoPayload('arc-luna-read-state-tests') as { cards: TurnCard[]; sessions: { id: string; parent?: SessionParent }[]; rail: RailCard[] };
  assert.equal(child.sessions.find((row) => row.id === 'arc-luna-read-state-tests')!.parent!.id, 'arc-read-state');
  assert.equal(child.rail.find((row) => row.id === 'arc-luna-read-state-tests')!.runByAgent, true);
  assert.ok(child.cards[0].startedAt >= main.cards[0].startedAt);
  assert.ok(child.cards[0].endedAt <= main.cards[0].endedAt);
  assert.equal(child.cards[0].endedAt - child.cards[0].startedAt, 68_000);
  assert.ok(child.cards[0].commits.length > 0);
  for (const commit of child.cards[0].commits) {
    assert.ok(commit.at >= child.cards[0].startedAt, 'the child commit precedes its turn');
    assert.ok(commit.at <= child.cards[0].endedAt, 'the child commit follows its turn');
  }
  const parent = demoPayload('arc-demo-dispatch') as { cards: TurnCard[] };
  const review = demoPayload('arc-demo-review') as { cards: TurnCard[] };
  const continuation = demoPayload('arc-demo-continuation') as { cards: TurnCard[] };
  assert.ok(review.cards[0].startedAt >= parent.cards[0].startedAt);
  assert.ok(continuation.cards[0].startedAt >= parent.cards[0].endedAt);
});

test('demo catalogs, permissions, groups and running children match production inputs', () => {
  assert.deepEqual(DEMO_RAIL_FOLDS, { [RAIL_FOLDS.agent]: false, [RAIL_FOLDS.archived]: false });
  assert.match(fs.readFileSync(path.join(__dirname, '../scripts/web-demo-adapter.js'), 'utf8'), /railFolds: sample.railFolds/);
  const main = demoPayload('arc-read-state') as { rail: RailCard[]; views: Parameters<typeof railSections>[2]; hidden: string[]; cards: TurnCard[]; projectSpend: unknown; usage: { composer: ComposerView; menus: Record<string, { items: { value: string; checked: boolean }[] }>; launcher: SessionLauncherView } };
  for (const agent of ['claude', 'codex'] as const) {
    const sample = demoPayload(agent === 'claude' ? 'arc-read-state' : 'arc-codex-read-state') as typeof main;
    const production = modelPicks(DEMO_MODELS[agent], DEMO_DEFAULTS[agent], true);
    assert.deepEqual(sample.usage.menus.model.items.map((row) => row.value), production.map((row) => row.value));
    const launcher = sample.usage.launcher.agents.find((row) => row.value === agent)!;
    assert.deepEqual(launcher.models.map((row) => [row.value, row.efforts.map((effort) => effort.value)]), production.map((row) => [row.value, row.efforts.map((effort) => effort.value)]));
    assert.deepEqual(sample.usage.menus.askmode.items.map((row) => row.value), launcher.permissions.map((row) => row.value));
    assert.equal(sample.usage.menus.askmode.items.find((row) => row.checked)!.value, agent === 'codex' ? 'never' : 'auto');
  }
  const groups = railSections(main.rail, CAPTURE_TIME, main.views).sections;
  assert.ok(groups.find((group) => group.id === RAIL_FOLDS.agent)!.cards.length > 0);
  assert.ok(groups.find((group) => group.id === RAIL_FOLDS.archived)!.cards.length > 0);
  assert.ok(groups.find((group) => group.id.includes('view:review'))!.cards.length < 3);
  assert.deepEqual(main.hidden, ['arc-demo-dispatch']);
  const running = demoPayload('arc-cache-run') as typeof main;
  assert.equal(running.cards[0].status, 'running');
  assert.equal(running.cards[0].live, true);
  assert.equal(running.rail.find((row) => row.id === 'arc-cache-run')!.status, 'running');
  assert.equal(running.usage.composer.box.actionKind, 'stop');
  assert.ok(running.cards[1].chips.find((chip) => chip.metric === 'cost')!.warnings!.length > 0);
  const child = demoPayload('arc-sol-read-state') as typeof main;
  assert.equal(child.cards[0].status, 'running');
  assert.equal(child.cards[0].endedAt, CAPTURE_TIME);
  assert.equal(main.cards[0].status, 'done');
  assert.equal(main.rail.find((row) => row.id === 'arc-read-state')!.status, 'subagents');
  assert.equal(main.rail.find((row) => row.id === 'arc-read-state')!.subagents, 1);
  const runningChild = main.cards[0].agents.find((row) => row.sessionId === 'arc-sol-read-state')!;
  assert.equal(runningChild.state, 'running');
  assert.notEqual(runningChild.since, null);
  assert.equal(runningChild.since, child.cards[0].startedAt);
  assert.ok(main.usage.composer.nextTurn);
  assert.ok(main.projectSpend);
  const comment = demoPayload('delegated-cost') as { comments: TurnComment[]; cards: TurnCard[]; usage: { composer: ComposerView } };
  assert.equal(comment.comments[0].turnKey, comment.cards[0].key);
  assert.ok(comment.usage.composer.annotations);
  assert.ok(comment.usage.composer.draft);
  const review = readmePayload('review') as { cards: TurnCard[]; rail: RailCard[]; stats: Record<string, SessionStatChip[]> };
  const reviewRunningChild = review.cards[0].agents.find((row) => row.sessionId === 'arc-sol-read-state')!;
  assert.equal(reviewRunningChild.state, 'running');
  assert.notEqual(reviewRunningChild.since, null);
  assert.equal(reviewRunningChild.since, child.cards[0].startedAt);
  assert.equal(review.rail.find((row) => row.id === 'arc-read-state')!.subagents, 1);
  assert.equal(review.stats['arc-read-state'].find((chip) => chip.metric === 'cost')!.label, review.cards[0].chips.find((chip) => chip.metric === 'cost')!.label);
  assert.equal(review.rail.find((row) => row.id === 'arc-sol-read-state')!.runningSince, child.cards[0].startedAt);
  const waiting = main.rail.filter((row) => row.status === 'waiting');
  assert.deepEqual(waiting.map((row) => row.id), ['delegated-cost']);
  for (const row of main.rail) {
    const selected = demoPayload(row.id) as { showing: string; usage: { composer: ComposerView } };
    assert.equal(selected.showing, row.id);
    assert.equal(selected.usage.composer.sessionId, row.id);
    assert.equal(selected.usage.composer.asks.length > 0, row.status === 'waiting');
    if (row.status === 'waiting') {
      assert.equal(selected.usage.composer.asks[0].kind, 'question');
      assert.equal(selected.usage.composer.asks[0].questions.length, 1);
      assert.equal(selected.usage.composer.box.actionKind, 'send');
    }
  }
});

test('catalog refresh preserves omitted and null effort across models with different defaults', () => {
  const catalog = { data: [
    { id: 'sol', model: 'sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
    { id: 'astra', model: 'astra', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
  ] };
  const policy = { requirements: null };
  for (const config of [{ model: 'sol' }, { model: 'sol', model_reasoning_effort: null }]) {
    const configuration = readDefaultConfiguration({ config: { ...config, api_key: 'private', cwd: 'private' } })!;
    const live = codexDefaultContext(configuration, catalog, policy);
    const captured = JSON.parse(JSON.stringify(defaultsSnapshot(live, { configuration, catalog, policy })));
    const refreshed = codexDefaultContext(captured, catalog, policy);
    assert.equal(refreshed.base!.effort, 'low');
    assert.equal(refreshed.models!.astra.effort, 'medium');
    assert.deepEqual(refreshed, live);
    const efforts = effortPicks(readModels(catalog, 0)!.models, 'astra', refreshed);
    assert.equal(efforts.find((effort) => effort.configuredDefault)!.value, 'medium');
    assert.deepEqual(captured, { config });
  }
});

// Node builds the Project cost scene and a Chicago browser draws it. The fixture is loaded
// afresh under each zone, so a date read from the host calendar at load time shows here.
test('README Project cost scene is the same under any host time zone', async () => {
  const previous = process.env.TZ;
  const views: unknown[] = [];
  try {
    for (const zone of ['America/Chicago', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      vi.resetModules();
      const fixture = await import('../scripts/readme-fixture.ts');
      views.push((fixture.readmePayload('project-cost') as { projectSpend: unknown }).projectSpend);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
  assert.deepEqual(views[1], views[0]);
  assert.equal((views[0] as { earliestRecord: string }).earliestRecord, '2026-08-29');
});

test('README usage scene holds a 5h and a 7d limit for Claude and Codex', () => {
  const bar = (readmePayload('usage') as { usage: { bar: UsageBar } }).usage.bar;
  const groups = bar.groups.map((group) => ({ agent: group.label, limits: group.lines.map((line) => line.label) }));
  assert.deepEqual(missingUsageLimits(groups), []);
});

test('default shoot preserves plan evidence before any page work, including escaped shot names', async () => {
  const root = tempDir('panel-shot-plan-');
  const directory = path.join(root, '.ClAuDe', 'PlAnS', 'owner');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'protected.webp');
  const evaluate = vi.fn<() => Promise<void>>(async () => { throw new Error('page work started'); });
  const page = { evaluate } as unknown as Page;
  for (const [outDir, name] of [[directory, 'protected'], [root, '.ClAuDe/PlAnS/owner/protected'], [path.join(root, 'safe'), '../.ClAuDe/PlAnS/owner/protected']]) {
    fs.writeFileSync(file, 'existing evidence');
    await assert.rejects(shoot(page, { name }, outDir), /Plan screenshots require/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing evidence');
    assert.equal(evaluate.mock.calls.length, 0);
  }
});

test('the direct lossless writer preserves plan evidence without creating a temporary PNG', async () => {
  const directory = path.join(tempDir('panel-shot-writer-plan-'), '.claude', 'plans', 'owner');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'protected.webp');
  fs.writeFileSync(file, 'existing evidence');
  const screenshot = vi.fn<Parameters<typeof writeLosslessWebp>[0]['screenshot']>(async (options) => {
    fs.writeFileSync(options.path!, 'temporary PNG');
    throw new Error('screenshot work started');
  });
  await assert.rejects(writeLosslessWebp({ screenshot }, file), /Plan screenshots require/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing evidence');
  assert.equal(screenshot.mock.calls.length, 0);
  assert.deepEqual(fs.readdirSync(directory), ['protected.webp']);
});

test('exported default writers refuse redirected ancestors and file targets before capture or replacement', async () => {
  const root = tempDir('panel-shot-redirect-');
  const directory = path.join(root, 'redirected');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'protected.webp');
  fs.writeFileSync(file, 'existing evidence');
  const inspect = fs.lstatSync;
  const evaluate = vi.fn<() => Promise<void>>(async () => { throw new Error('page work started'); });
  const screenshot = vi.fn<Parameters<typeof writeLosslessWebp>[0]['screenshot']>(async () => { throw new Error('screenshot work started'); });
  const page = { evaluate, screenshot } as unknown as Page;
  for (const redirected of [directory, file]) {
    const mock = vi.spyOn(fs, 'lstatSync').mockImplementation((candidate: fs.PathLike) => {
      const stat = inspect(candidate);
      if (String(candidate) === redirected) stat.isSymbolicLink = () => true;
      return stat;
    });
    try {
      await assert.rejects(shoot(page, { name: 'protected' }, directory), /contains a redirect/);
      await assert.rejects(writeLosslessWebp({ screenshot }, file), /contains a redirect/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'existing evidence');
      assert.equal(evaluate.mock.calls.length, 0);
      assert.equal(screenshot.mock.calls.length, 0);
      assert.deepEqual(fs.readdirSync(directory), ['protected.webp']);
    } finally {
      mock.mockRestore();
    }
  }
});

test('a missing screenshot state cannot leave an older image at the target path', async () => {
  const directory = tempDir('panel-shot-');
  const file = path.join(directory, 'missing.webp');
  fs.writeFileSync(file, 'older image');
  const page = {
    evaluate: async () => undefined,
    locator: () => ({ first: () => ({ click: async () => { throw new Error('missing selector'); } }) }),
  } as unknown as Page;

  await shoot(page, { name: 'missing', click: '.not-on-the-page' }, directory);
  assert.equal(fs.existsSync(file), false);
  fs.rmdirSync(directory);
});

// One black pixel, as a PNG. The browser writes a real file here, so the conversion and the
// lossless check below run the way they run on a real shot.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

test('a screenshot stays clear of the browser scrollbar edge and lands as a lossless WebP', async () => {
  const directory = tempDir('panel-shot-');
  let captured: Record<string, unknown> | undefined;
  const page = {
    evaluate: async () => undefined,
    waitForTimeout: async () => undefined,
    mouse: { move: async () => undefined },
    viewportSize: () => ({ width: 300, height: 900 }),
    screenshot: async (options: Record<string, unknown>) => {
      captured = options;
      fs.writeFileSync(options.path as string, ONE_PIXEL_PNG);
    },
  } as unknown as Page;

  await shoot(page, { name: 'plain' }, directory);
  assert.deepEqual(captured?.clip, { x: 0, y: 0, width: 287, height: 900 });
  const file = path.join(directory, 'plain.webp');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file).subarray(8, 12).toString('ascii'), 'WEBP');
  fs.rmSync(file);
  fs.rmdirSync(directory);
});

test('an injected screenshot writer receives the target intact and bypasses the default writer', async () => {
  const directory = tempDir('panel-shot-sink-');
  const file = path.join(directory, 'plain.webp');
  fs.writeFileSync(file, 'existing evidence');
  const page = {
    evaluate: async () => undefined,
    waitForTimeout: async () => undefined,
    mouse: { move: async () => undefined },
    viewportSize: () => ({ width: 300, height: 900 }),
    screenshot: async () => { throw new Error('default writer reached the screenshot'); },
  } as unknown as Page;
  const calls: unknown[] = [];
  try {
    await shoot(page, { name: 'plain' }, directory, async (target, destination, options) => {
      assert.equal(fs.readFileSync(destination, 'utf8'), 'existing evidence');
      calls.push({ target, destination, options });
    });
    assert.deepEqual(calls, [{ target: page, destination: file, options: { clip: { x: 0, y: 0, width: 287, height: 900 } } }]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing evidence');
    const planDirectory = path.join(directory, '.claude', 'plans', 'owner');
    fs.mkdirSync(planDirectory, { recursive: true });
    const planFile = path.join(planDirectory, 'plain.webp');
    fs.writeFileSync(planFile, 'bounded evidence');
    const writer = vi.fn<typeof writeLosslessWebp>(async (_target, destination) => {
      assert.equal(fs.readFileSync(destination, 'utf8'), 'bounded evidence');
    });
    await shoot(page, { name: 'plain' }, planDirectory, writer);
    assert.equal(writer.mock.calls.length, 1);
    assert.equal(writer.mock.calls[0][1], planFile);
    assert.equal(fs.readFileSync(planFile, 'utf8'), 'bounded evidence');
    fs.unlinkSync(planFile);
    fs.rmdirSync(planDirectory);
    fs.rmdirSync(path.dirname(planDirectory));
    fs.rmdirSync(path.dirname(path.dirname(planDirectory)));
    await assert.rejects(() => shoot(page, { name: 'plain' }, directory), /default writer reached the screenshot/);
    assert.throws(() => assert.equal(fs.existsSync(file), true), assert.AssertionError);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

// The draft first-project shot draws a session that has answered no prompt, so it drops that
// session's entry from the keyed figures. One process draws the whole shot list twice, once
// per theme kind, and every shot after this one reads the same fixture. A drop that reached
// the fixture would take the figures off every later shot, and the light pass would find no
// context figure to read at all.
test('the draft first-project shot drops a session from its own figures alone', () => {
  const payload = firstProjectPayload(true) as { stats: Record<string, unknown> };
  assert.equal('s1' in payload.stats, false);
  assert.ok(RAIL_STATS.s1, 'the fixture lost the figures for s1');
  const later = renderPayload() as { stats: Record<string, unknown> };
  assert.ok(later.stats.s1, 'a payload built after the draft shot lost the figures for s1');
});

test('README menu reads every manifest when clause and refuses one it cannot read', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(manifestMenu(manifest).length > 0);
  assert.equal(whenHolds("webviewSection == 'arcSessionLive' && !sessionPinned", { webviewSection: 'arcSessionLive' }), true);
  for (const clause of [
    'webviewSection in arcSections',
    'resourceFilename =~ /x/',
    'count < 3',
    'count >= 3',
    'sessionPinned sessionArchived',
    '(sessionPinned',
    'sessionPinned &&',
    'webviewSection ==',
  ]) {
    assert.throws(() => whenHolds(clause, {}), /cannot read the when clause/, clause);
  }
  const unread = { contributes: { commands: [], menus: { 'webview/context': [{ command: 'arc.x', when: 'a in b' }] } } };
  assert.throws(() => manifestMenu(unread, new Set()), /cannot read the when clause "a in b"/);
});


test('demo context replies cover both providers and preserve request identities and totals', () => {
  for (const session of DEMO_SESSION_IDS) {
    const request = { type: 'contextDetail' as const, session, request: 7, generation: 3 };
    assert.deepEqual(parsePanelToHost(request), request);
    const sample = demoContextSample(session);
    const reply = demoContextReply(request, sample, CAPTURE_TIME);
    assert.ok(validContextDetail(reply.detail));
    assert.deepEqual(parseHostToPanel(reply), reply);
    assert.equal(reply.detail.status, 'available');
    assert.equal(reply.detail.session, session);
    assert.equal(reply.detail.request, 7);
    assert.equal(reply.detail.generation, 3);
    assert.equal(reply.detail.model, sample.model);
    assert.equal(reply.detail.provider, sample.agent);
    assert.equal(reply.detail.used, sample.contextTokens);
    assert.equal(reply.detail.capacity, sample.contextWindow);
    assert.equal(reply.detail.measurement, sample.agent === 'codex' ? 'local-estimate' : 'provider-estimate');
    assert.equal(reply.detail.categories.reduce((sum, row) => sum + row.tokens, 0), reply.detail.used);
  }
});

test('demo handled messages have adapter branches and use the production parsers', () => {
  const adapter = fs.readFileSync(path.join(__dirname, '../scripts/web-demo-adapter.js'), 'utf8');
  const cases = new Set([...adapter.matchAll(/case '([^']+)':/g)].map((match) => match[1]));
  assert.equal(DEMO_HOST_POLICY.contextDetail, 'handled');
  for (const [message, behavior] of Object.entries(DEMO_HOST_POLICY)) {
    if (behavior === 'handled') assert.ok(cases.has(message), `Missing demo handler for ${message}`);
  }
  assert.match(adapter, /sample.host.parsePanelToHost\(raw\)/);
  assert.match(adapter, /sample.host.parseHostToPanel\(data\)/);
});

test('default demo history keeps distinct turns and provider-scoped expiry evidence', () => {
  const main = demoPayload('arc-read-state') as { cards: TurnCard[]; stats: Record<string, SessionStatChip[]>; sessions: { id: string; parent?: SessionParent }[] };
  assert.equal(main.cards.length, 3);
  for (let index = 1; index < main.cards.length; index++) assert.ok(main.cards[index].endedAt < main.cards[index - 1].startedAt);
  assert.equal(new Set(main.cards.map((card) => card.key)).size, 3);
  assert.ok(main.cards.slice(1).every((card) => !card.agents.length && !card.commits.length && !card.files.length));
  assert.ok(main.stats['arc-read-state'].find((chip) => chip.metric === 'cache-expiry'));
  assert.equal(DEMO_DEFAULT_EXPIRY.returns.length, 1);
  const history = DEMO_TURNS['arc-read-state'].filter((item) => item.usage.requests === 1);
  for (const item of history) {
    assert.equal(item.contextRequest!.lifetime, '1h', 'the Claude request lost its recorded cache lifetime');
  }
  assert.ok(DEMO_DEFAULT_EXPIRY.returns.every((item) => item.request.agent === 'claude' && item.request.model === 'claude-opus-5-5' && item.lifetime === '1h'));
  const codex = demoPayload('arc-codex-read-state') as typeof main;
  assert.ok(codex.stats['arc-codex-read-state'].find((chip) => chip.metric === 'cache-expiry')!.detail.includes('cache-key'));
  assert.equal(main.cards[0].dispatched![0].sessionId, 'arc-demo-sketch');
  const child = demoPayload('arc-demo-sketch') as typeof main;
  assert.equal(child.sessions.find((row) => row.id === 'arc-demo-sketch')!.parent!.id, 'arc-read-state');
  assert.equal(child.cards[0].agent, 'Codex');
  assert.equal(DEMO_TURNS['arc-demo-sketch'][0].model, 'gpt-6.1-sol');
  assert.equal(DEMO_TURNS['arc-demo-sketch'][0].effort, 'high');
  assert.ok(DEMO_TURNS['arc-read-state'][0].agents.some((agent) => agent.model === 'claude-sonnet-5-5'));
  assert.ok(DEMO_TURNS['arc-read-state'][0].agents.some((agent) => agent.model?.startsWith('claude-haiku-4-5')));
  assert.ok(child.cards[0].startedAt >= main.cards[0].startedAt);
  assert.ok(child.cards[0].endedAt <= main.cards[0].endedAt);
  const dollars = main.stats['arc-read-state'].find((chip) => chip.metric === 'cost')!.dollars!;
  const own = DEMO_TURNS['arc-read-state'].reduce((sum, item) => sum + turnCost(item).dollars!, 0);
  const childDollars = child.stats['arc-demo-sketch'].find((chip) => chip.metric === 'cost')!.dollars!;
  const cost = main.cards[0].chips.find((chip) => chip.metric === 'cost')!;
  assert.equal(cost.label, formatCost(turnCost(DEMO_TURNS['arc-read-state'][0]).dollars! + childDollars)! + '+', 'turn total omits dispatched usage');
  const entries = cost.detailList!.entries;
  const dispatched = entries.find((entry) => entry.label === DEMO_TURNS['arc-demo-sketch'][0].sessionTitle);
  assert.ok(dispatched, 'turn cost detail omits the dispatched child');
  assert.equal(dispatched.value, formatCost(childDollars), 'dispatched detail has the wrong cost');
  assert.ok(Math.abs(dollars - own - childDollars) < 1e-9, 'dispatched usage was omitted or counted twice');
});
