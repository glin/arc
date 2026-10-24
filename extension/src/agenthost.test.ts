import { afterEach, onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert';
import { CONTEXT_FRAME_BYTES, contextFrameId } from './contextframe';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  AgentHost,
  AgentHostTimer,
  AgentPlan,
  AgentSession,
  IdleAnswers,
  LineReader,
  ChildLike,
  MODELS_FRESH_MS,
  McpBook,
  McpPendingRefreshes,
  ModelBook,
  SAVED_DEFAULTS_LIMIT,
  SavedDefaults,
  saveCatalog,
  savedCatalogs,
  type SavedStateStorage,
  SessionEvent,
  SessionState,
  UsageReadQueue,
  USAGE_REFRESH_DEADLINE_MS,
  askIdle,
  askIdleMcp,
  askIdleMcpChange,
  askIdleDefaults,
  arcCliSpawner,
  childEnv,
  claudeAskMode,
  claudeIdlePlan,
  claudePlan,
  claudeRenamePlan,
  codexAskMode,
  codexIdlePlan,
  codexPlan,
  codexRenamePlan,
  modelChange,
  openDraftMcp,
  pickedEffort,
  pickedModel,
  renameAgentSession,
  spawnCli,
  unstartable,
  withDeadline,
  existingHostKey,
  freshHostKey,
  retireDraftProfile,
  liveMcpTarget,
  STOP_ENDING_GRACE_MS,
} from './agenthost.ts';

test('measurement windows refuse agent processes before launch', { tags: ['subprocess'] }, () => {
  const previous = process.env.ARC_MEASURE_BLOCK_AGENTS;
  process.env.ARC_MEASURE_BLOCK_AGENTS = '1';
  try {
    assert.throws(() => spawnCli('measurement-must-never-launch', [], '.', {}), /disabled in this measurement window/);
  } finally {
    if (previous === undefined) delete process.env.ARC_MEASURE_BLOCK_AGENTS;
    else process.env.ARC_MEASURE_BLOCK_AGENTS = previous;
  }
});
import { ClaudeWire, CONTROL_DEADLINE_MS, type PermissionMode } from './claudewire.ts';
import {
  CompactHost,
  promptAsReader,
  routeCompactionEvent,
  type CompactChild,
  type ReplyHolder,
} from './compactrequest.ts';
import { livePress } from './turnfixtures.ts';
import { RepositoryScope } from './repositoryscope';
import { sessionCoverageMember } from './sessioncoverage';
import { revisionOf as fileRevisionOf } from './transcript';
import { RecordedReplies } from './sessionreads.ts';
import { CODEX_DEADLINE_MS, sandboxPolicy } from './codexwire.ts';
import { requesterIdentity } from './sessionrequests.ts';
import { GuardedAttempt, McpServer, ModelList, UsageReading, WireEvent } from './agentwire.ts';
import {
  CLAUDE_ASK_MODES,
  CODEX_ASK_MODES,
  SessionProfile,
  askMode,
  defaultAskMode,
  acceptedPermissionMode,
  sessionSettings,
  sessionSettingsForProfile,
  draftProfileAfterPick,
  newSessionDraft,
  withSessionSettings,
} from './composerview.ts';
import { USAGE_FRESH_MS, UsageBook, usageBar } from './usageview.ts';
import { missingSetupValues } from './domain/session-setups.ts';
import { tempDir } from './temproot.ts';
import { QuestionRecovery, questionContinuation } from './questionrecovery';
import { QuestionEvidenceReader } from './questionrecords';
import { askCard, queueSubmissionAfter } from './composerview';
import { normalizeQueuedSubmissions } from './turnview';
import { asyncQuestionId, buildQuestionReply } from './codexreply';
import { launchPolicy, type LaunchPolicy } from './launchpolicy.ts';
import { DispatchReceipts } from './dispatchreceipts';
import { HostedDispatch, type SavedDispatchResponse } from './dispatchhost';
import { payloadSha256 } from './sessionwrites';
import { LaunchPolicyStore } from './launchpolicystore.ts';
import * as esbuild from 'esbuild';
import { callSources, declarationSource, statementFrom, sourceMatch } from '../test/source-contract.ts';

const CLAUDE = { command: 'C:\\claude.exe', leadingArgs: [], env: {} };
const CODEX = { command: 'node', leadingArgs: ['C:\\codex.js'], env: {} };
const WS = 'C:\\ws';
const CODEX_CLIENT = { name: 'arc', title: 'Arc', version: '0.1.0' };

const recoveryOrigin = 'a'.repeat(32);
function recoveryAt(
  root: string,
  activation: string,
  options: Partial<ConstructorParameters<typeof QuestionRecovery>[0]> = {},
) {
  return new QuestionRecovery({ root, origin: recoveryOrigin, activation: activation.repeat(24), ...options });
}
function questionRequest(request = 'request', item = 'question') {
  return (
    JSON.stringify({
      type: 'control_request',
      request_id: request,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: item,
        input: {
          questions: [
            {
              question: 'Which option?',
              header: 'Choice',
              options: [
                { label: 'One', description: 'First' },
                { label: 'Two', description: 'Second' },
              ],
              multiSelect: true,
            },
          ],
        },
      },
    }) + '\n'
  );
}
async function recoveryHost(recovery: QuestionRecovery) {
  const fixture = fakeHost(undefined, undefined, { recovery });
  const opening = fixture.host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'session' }));
  fixture.children[0].answerHandshake();
  await opening;
  return fixture;
}

test.each(['sync', 'async'])(
  'a visible Codex %s question survives fresh-host replacement without resuming a provider',
  async (kind) => {
    const root = tempDir('question-recovery-codex-');
    const before = fakeHost(undefined, undefined, { recovery: recoveryAt(root, '1') });
    const opening = before.host.session(
      'codex',
      codexPlan(CODEX, { cwd: WS, resume: 'session', clientInfo: CODEX_CLIENT }),
    );
    const child = before.children[0];
    child.reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
    child.reply({ data: [{ cwd: WS, skills: [] }] });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/resume'));
    child.reply({ thread: { id: 'session' } });
    await opening;
    child.say(
      JSON.stringify(
        kind === 'sync'
          ? {
              id: 900,
              method: 'item/tool/requestUserInput',
              params: {
                itemId: 'question',
                threadId: 'session',
                turnId: 'turn',
                questions: [
                  {
                    id: 'choice',
                    question: 'Which option?',
                    header: 'Choice',
                    options: [{ label: 'One', description: 'First' }],
                  },
                ],
              },
            }
          : {
              method: 'item/completed',
              params: {
                threadId: 'session',
                turnId: 'turn',
                item: {
                  type: 'agentMessage',
                  id: 'question',
                  text: '',
                  phase: 'commentary',
                  delivery: 'async',
                  questions: [{ title: 'Which option?', options: ['One'] }],
                },
              },
            },
      ) + '\n',
    );
    assert.equal(before.host.waiting().length, 1);
    before.host.dispose();
    const after = fakeHost(undefined, undefined, { recovery: recoveryAt(root, '2') });
    const restored = after.host.waiting()[0];
    assert.equal(restored.session, 'session');
    assert.equal(restored.recovered?.kind, `codex-${kind}`);
    assert.equal(askCard(restored.ask, 'Codex').questions[0].legend, 'Which option?');
    assert.equal(after.children.length, 0);
    after.host.dispose();
  },
);

// A fresh host must publish the question that was visible before the original host ended.
// The fake child reaches the native request and the production card projection without launching a provider.
test.each(['disposal', 'abrupt replacement'])(
  'a visible Claude question survives %s in a fresh host',
  async (ending) => {
    const root = tempDir('question-recovery-');
    let ended = false;
    const store = recoveryAt(root, '1', { pid: 123456, dead: () => ended });
    const before = await recoveryHost(store);
    before.children[0].say(questionRequest());
    assert.equal(askCard(before.host.waiting()[0].ask, 'Claude').questions[0].legend, 'Which option?');
    if (ending === 'disposal') before.host.dispose();
    else ended = true;
    const after = fakeHost(undefined, undefined, { recovery: recoveryAt(root, '2', { dead: () => ended }) });
    const visible = after.host.waiting();
    assert.equal(visible.length, 1);
    assert.equal(visible[0].session, 'session');
    const card = askCard(visible[0].ask, 'Claude');
    assert.equal(card.questions[0].legend, 'Which option?');
    assert.equal(card.questions[0].multiSelect, true);
    assert.equal(card.questions[0].choices[0].label, 'One');
    assert.match(card.detail, /continues the stopped session/);
    assert.equal(after.children.length, 0, 'restoration launched a provider');
    before.children[0].exit(0);
    before.host.dispose();
    after.host.dispose();
  },
);

test('failed capture leaves the live question answerable and never restores it', async () => {
  const root = tempDir('question-recovery-');
  const store = recoveryAt(root, '1', {
    write: () => {
      throw new Error('full disk');
    },
  });
  let failures = 0;
  const live = fakeHost(undefined, undefined, { recovery: store, onRecoveryFailure: () => failures++ });
  const opening = live.host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'session' }));
  live.children[0].answerHandshake();
  await opening;
  live.children[0].say(questionRequest());
  assert.equal(live.host.waiting().length, 1);
  assert.equal(
    live.host.answer('one', 'request', {
      decision: 'answer',
      answers: {
        'Which option?': { labels: ['One', 'Two'], written: '' },
      },
    }),
    true,
  );
  assert.deepEqual(live.children[0].sent().at(-1)?.response, {
    subtype: 'success',
    request_id: 'request',
    response: {
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            question: 'Which option?',
            header: 'Choice',
            options: [
              { label: 'One', description: 'First' },
              { label: 'Two', description: 'Second' },
            ],
            multiSelect: true,
          },
        ],
        answers: { 'Which option?': 'One, Two' },
      },
    },
  });
  live.host.dispose();
  assert.equal(failures, 1, 'answering the uncaptured question repeated its capture warning');
  assert.equal(recoveryAt(root, '2').entries().length, 0);
});

test.each(
  ['claude', 'codex-sync', 'codex-async'].flatMap((kind) =>
    ['none', 'terminal', 'begin and terminal'].flatMap((persistence) =>
      ['answer', 'decline', 'failed', 'cancelled'].map((outcome) => ({ kind, persistence, outcome })),
    ),
  ),
)(
  'a captured live $kind $outcome handles $persistence persistence failure across host replacement',
  async ({ kind, persistence, outcome }) => {
    const agent = kind === 'claude' ? 'claude' : 'codex';
    const root = tempDir('question-live-answer-');
    let writes = 0;
    const store = recoveryAt(root, '1', {
      write: (file, text) => {
        writes += 1;
        if ((persistence === 'terminal' && writes > 2) || (persistence === 'begin and terminal' && writes > 1))
          throw new Error('Saved questions cannot be written.');
        fs.writeFileSync(file, text);
      },
    });
    const live = fakeHost(undefined, undefined, { recovery: store });
    const key = agent === 'claude' ? 'one' : 'codex';
    let id = 'request';
    let question = 'Which option?';
    const plan =
      agent === 'claude'
        ? claudePlan(CLAUDE, { cwd: WS, sessionId: 'session' })
        : codexPlan(CODEX, { cwd: WS, resume: 'session', clientInfo: CODEX_CLIENT });
    if (outcome === 'cancelled') {
      const driver = plan.driver;
      // Exercise the host cancellation contract independently of provider cancellation triggers.
      // Clear persists predecessor closure before requesting a new native session.
      plan.driver = (send, emit) => ({
        ...driver(send, emit),
        answer: (request) => {
          emit({ kind: 'askResolved', id: request, outcome: 'cancelled' });
          return true;
        },
      });
    }
    const opening = live.host.session(key, plan);
    if (agent === 'claude') live.children[0].answerHandshake();
    else {
      await answerCodexHandshake(live.children[0]);
      live.children[0].reply({ thread: { id: 'session' } });
    }
    await opening;
    if (agent === 'claude') live.children[0].say(questionRequest());
    else {
      question = 'choice';
      live.children[0].say(
        JSON.stringify(
          kind === 'codex-async'
            ? {
                method: 'item/completed',
                params: {
                  threadId: 'session',
                  turnId: 'turn',
                  item: {
                    type: 'agentMessage',
                    id: 'question',
                    text: '',
                    phase: 'final_answer',
                    delivery: 'async',
                    questions: [{ title: 'Which option?', options: ['One'] }],
                  },
                },
              }
            : {
                id: 900,
                method: 'item/tool/requestUserInput',
                params: {
                  threadId: 'session',
                  turnId: 'turn',
                  itemId: 'question',
                  questions: [
                    {
                      id: 'choice',
                      header: 'Choice',
                      question: 'Which option?',
                      options: [{ label: 'One', description: 'First' }],
                    },
                  ],
                },
              },
        ) + '\n',
      );
      if (kind === 'codex-async') {
        question = asyncQuestionId('question', 0);
        live.children[0].say(
          JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'session', turn: { id: 'turn', status: 'completed', items: [] } },
          }) + '\n',
        );
      }
    }
    assert.equal(live.host.waiting().length, 1);
    assert.equal(writes, 1, 'the question must be saved before persistence failures begin');
    id = live.host.waiting()[0].ask.id;
    if (outcome === 'failed') failNextWrite(live.children[0], 'Native answer cannot be written.');
    assert.equal(
      live.host.answer(
        key,
        id,
        outcome === 'decline'
          ? { decision: 'deny', reason: 'No answer.' }
          : { decision: 'answer', answers: { [question]: { labels: ['One'], written: '' } } },
      ),
      outcome !== 'failed' || kind === 'codex-async',
      'recovery persistence changed ordinary live delivery',
    );
    if (kind === 'codex-async' && outcome === 'answer') {
      const sent = live.children[0].sent().at(-1);
      assert.ok(sent);
      assert.equal(sent.method, 'turn/start');
      assert.deepEqual((sent.params as { input: unknown }).input, [
        {
          type: 'text',
          text: buildQuestionReply([{ questionItemId: question, question: 'Which option?', answer: 'One' }]),
        },
      ]);
      live.children[0].reply({ turn: { id: 'answer-turn' } });
    }
    const terminal =
      outcome === 'answer'
        ? kind === 'codex-async'
          ? 'answered'
          : 'unknown'
        : outcome === 'decline'
          ? 'declined'
          : outcome;
    await vi.waitFor(() =>
      assert.ok(
        live.events.some(({ event }) => event.kind === 'askResolved' && event.id === id && event.outcome === terminal),
      ),
    );
    if (outcome === 'failed') {
      assert.equal(live.host.waiting().length, 1, 'a failed native answer removed its live question');
      assert.equal(live.host.waiting()[0].recovered, undefined);
      live.children[0].exit(1);
      assert.equal(live.host.waiting().length, 1, 'a failed native answer hid the saved question after child exit');
      assert.ok(live.host.waiting()[0].recovered);
    } else assert.equal(live.host.waiting().length, 0, 'the completed live answer reappeared as a recovery card');
    const settled =
      persistence === 'none' &&
      (outcome === 'decline' || outcome === 'cancelled' || (kind === 'codex-async' && outcome === 'answer'));
    const disposition =
      persistence === 'begin and terminal' || (outcome === 'failed' && persistence === 'none')
        ? 'unresolved'
        : 'unknown';
    if (settled) assert.deepEqual(store.entries(), []);
    else assert.equal(store.entries()[0].disposition, disposition, 'native delivery changed durable evidence');
    live.host.dispose();
    const after = fakeHost(undefined, undefined, { recovery: recoveryAt(root, '2') });
    assert.equal(after.host.waiting().length, settled ? 0 : 1);
    if (!settled) {
      assert.equal(after.host.waiting()[0].ask.kind, 'question');
      assert.equal(askCard(after.host.waiting()[0].ask, agent).answerBlocked, disposition === 'unknown');
    }
    after.host.dispose();
  },
);

test('two restored questions remain answerable without a current live request', async () => {
  const root = tempDir('question-multiple-restored-');
  const live = await recoveryHost(recoveryAt(root, '1'));
  live.children[0].say(questionRequest('first', 'first'));
  live.children[0].say(questionRequest('second', 'second'));
  live.host.dispose();
  const after = fakeHost(undefined, undefined, { recovery: recoveryAt(root, '2') });
  assert.equal(after.host.waiting().length, 2);
  assert.equal(
    after.host.waiting().some((entry) => askCard(entry.ask, 'Claude').answerBlocked),
    false,
  );
  after.host.dispose();
});

test.each([
  'text choice',
  'native structured answer',
  'shutdown interruption',
  'unrecognized result',
  'other session',
  'reader denial',
])('fresh-host Claude evidence handles %s without losing unresolved questions', async (kind) => {
  const root = tempDir('question-native-evidence-');
  const source = path.join(root, 'source.jsonl');
  const live = await recoveryHost(recoveryAt(root, '1'));
  const wire = JSON.parse(questionRequest());
  wire.request.input.questions[0].options[0].label = 'Blue';
  live.children[0].say(JSON.stringify(wire) + '\n');
  const entry = live.host.questionRecovery()!.entries()[0];
  live.host.questionRecovery()!.bindSource(entry.identity, source);
  live.host.dispose();
  const store = recoveryAt(root, '2');
  const after = fakeHost(undefined, undefined, { recovery: store });
  const answered = kind === 'text choice' || kind === 'native structured answer';
  fs.writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      sessionId: kind === 'other session' ? 'unrelated' : 'session',
      ...(kind === 'native structured answer'
        ? { toolUseResult: { questions: wire.request.input.questions, answers: { 'Which option?': 'Blue' } } }
        : {}),
      ...(kind === 'shutdown interruption' ? { interruptedByShutdown: true, toolDenialKind: 'user-rejected' } : {}),
      ...(kind === 'reader denial' ? { toolDenialKind: 'permission-rule' } : {}),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'question',
            content:
              kind === 'text choice' || kind === 'other session'
                ? 'Blue'
                : kind === 'native structured answer'
                  ? 'Your questions have been answered: "Which option?"="Blue".'
                  : 'Unknown result',
            ...(kind === 'shutdown interruption' || kind === 'reader denial' ? { is_error: true } : {}),
          },
        ],
      },
    }) + '\n',
  );
  new QuestionEvidenceReader().reconcile(store, () => source);
  assert.equal(after.host.waiting().length, answered || kind === 'reader denial' ? 0 : 1);
  after.host.dispose();
});

test('waiting publication checks ownership once and empty reconciliation creates no origin lease', async () => {
  const root = tempDir('question-publication-');
  const store = recoveryAt(root, '1');
  new QuestionEvidenceReader().reconcile(store, () => null);
  assert.equal(fs.existsSync(path.join(root, recoveryOrigin)), false);
  const emptyHost = fakeHost(undefined, undefined, { recovery: store });
  assert.equal(emptyHost.host.waiting().length, 0);
  emptyHost.host.dispose();
  assert.equal(fs.existsSync(path.join(root, recoveryOrigin)), false);
  const captured = recoveryAt(root, '3');
  const live = await recoveryHost(captured);
  live.children[0].say(questionRequest('first', 'first'));
  live.children[0].say(questionRequest('second', 'second'));
  live.host.dispose();
  const restored = recoveryAt(root, '2');
  const after = fakeHost(undefined, undefined, { recovery: restored });
  const owns = vi.spyOn(restored, 'owns');
  assert.equal(after.host.waiting().length, 2);
  assert.equal(owns.mock.calls.length, 1);
  owns.mockRestore();
  after.host.dispose();
});

// Run the production publication callback without activating VS Code.
function questionPublication(host: AgentHost, reader: QuestionEvidenceReader, panel: object): () => void {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const callback = statementFrom(source, source.indexOf('const updateAgentAffordance ='));
  const code = esbuild.transformSync(`${callback}; return updateAgentAffordance;`, { loader: 'ts' }).code;
  return runInNewContext(`(function() { ${code} })()`, { host, questionEvidence: reader, panel });
}

test('question publications refresh missing, ambiguous and replaced sources while separating raw provider identities', async () => {
  const root = tempDir('question-publication-sources-');
  const store = recoveryAt(root, '1');
  const before = await recoveryHost(store);
  before.children[0].say(questionRequest());
  const captured = before.host.waiting()[0].ask;
  assert.ok(captured.kind === 'question');
  store.settle(store.entries()[0].identity, 'declined');
  for (const agent of ['claude', 'codex'] as const)
    for (const session of ['session', 'session '])
      for (const tool of ['first', 'second'])
        assert.ok(store.capture(agent, session, WS, { ...captured, id: tool, toolUseId: tool }));
  before.host.dispose();
  const restored = recoveryAt(root, '2');
  const live = fakeHost(undefined, undefined, { recovery: restored });
  const panelSource = fs.readFileSync(path.join(__dirname, 'panelhost.ts'), 'utf8');
  const start = panelSource.indexOf('  public questionSource(');
  const method = panelSource.slice(start, panelSource.indexOf(String.fromCharCode(10) + '  private ', start));
  const Catalog = runInNewContext(esbuild.transformSync(`class Catalog { ${method} }; Catalog`, { loader: 'ts' }).code);
  let roots = [root];
  let scoped: { agent: string; sessionId: string; file: string }[] = [];
  const catalog = new Catalog();
  Object.assign(catalog, {
    repositoryScope: { snapshot: () => ({ roots }) },
    folders: () => roots,
    authoritativeCatalogScope: JSON.stringify(roots),
    authoritativeCatalog: {},
    sessionPageIndexFor: () => ({ scoped }),
  });
  let mode = 'missing';
  const calls: string[] = [];
  let visible: { session: string; ask: import('./agentwire').Ask }[] = [];
  const sourceFor = (agent: string, session: string) => {
    calls.push(JSON.stringify([agent, session]));
    return catalog.questionSource(agent, session);
  };
  const publish = questionPublication(live.host, new QuestionEvidenceReader(), {
    questionSource: sourceFor,
    setAsks: (asks: typeof visible) => {
      visible = asks;
    },
  });
  for (mode of ['missing', 'available', 'ambiguous', 'scope changed', 'replaced', 'available']) {
    roots = mode === 'scope changed' ? [path.join(root, 'other-scope')] : [root];
    scoped =
      mode === 'missing'
        ? []
        : ['claude', 'codex'].flatMap((agent) =>
            ['session', 'session '].flatMap((sessionId) => {
              const row = {
                agent,
                sessionId,
                file: path.join(
                  root,
                  `${agent}-${sessionId.length}-${mode === 'replaced' ? 'replacement' : 'source'}.jsonl`,
                ),
              };
              return mode === 'ambiguous' ? [row, { ...row, file: row.file + '.duplicate' }] : [row];
            }),
          );
    calls.length = 0;
    publish();
    assert.equal(visible.length, 8);
    assert.equal(
      visible.every(({ ask }) => ask.kind === 'question' && ask.recovery?.blocked === (mode !== 'available')),
      true,
      mode,
    );
    assert.equal(calls.length, 4, 'each provider and exact session identity resolves once per publication');
    assert.equal(new Set(calls).size, 4);
  }
  live.host.dispose();
});

test('question publication reads predecessor dispositions after ownership and evidence settlement', async () => {
  const root = tempDir('question-publication-freshness-');
  const source = path.join(root, 'source.jsonl');
  const predecessor = recoveryAt(root, '1');
  const live = await recoveryHost(predecessor);
  live.children[0].say(questionRequest('first', 'first'));
  live.children[0].say(questionRequest('second', 'second'));
  live.children[0].say(questionRequest('third', 'third'));
  for (const entry of predecessor.entries()) predecessor.bindSource(entry.identity, source);
  const restored = recoveryAt(root, '2');
  const after = fakeHost(undefined, undefined, { recovery: restored });
  predecessor.settle(predecessor.entries()[0].identity, 'declined');
  live.host.dispose();
  fs.writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      sessionId: 'session',
      message: { content: [{ type: 'tool_result', tool_use_id: 'second', content: 'One' }] },
    }) + String.fromCharCode(10),
  );
  let visible: { ask: import('./agentwire').Ask }[] = [];
  const publish = questionPublication(after.host, new QuestionEvidenceReader(), {
    questionSource: () => source,
    setAsks: (asks: typeof visible) => {
      visible = asks;
    },
  });
  publish();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].ask.kind === 'question' && visible[0].ask.toolUseId, 'third');
  assert.ok(visible[0].ask.kind === 'question');
  assert.equal(visible[0].ask.recovery?.blocked, false);
  after.host.dispose();
});

test.each(['answered', 'aborted'])(
  'fresh-host Codex synchronous %s evidence retains the exact question disposition',
  (kind) => {
    const root = tempDir('question-codex-evidence-');
    const source = path.join(root, 'source.jsonl');
    const before = recoveryAt(root, '1');
    before.capture(
      'codex',
      'session',
      WS,
      {
        kind: 'question',
        id: 'old',
        toolUseId: 'call',
        input: {},
        questions: [
          {
            id: 'colour',
            question: 'Which colour?',
            header: 'Colour',
            options: [{ label: 'Blue', description: '' }],
            multiSelect: false,
            secret: false,
          },
        ],
      },
      source,
    );
    before.release();
    const store = recoveryAt(root, '2');
    const after = fakeHost(undefined, undefined, { recovery: store });
    fs.writeFileSync(
      source,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call',
          output:
            kind === 'answered'
              ? JSON.stringify({ answers: { colour: { answers: ['Blue'] } } })
              : 'aborted by user after 0.1s',
        },
      }) + '\n',
    );
    new QuestionEvidenceReader().reconcile(store, () => source);
    assert.equal(after.host.waiting().length, kind === 'answered' ? 0 : 1);
    after.host.dispose();
  },
);

test('question admission retains every unresolved and unknown item while preserving the overflowing live card', async () => {
  const root = tempDir('question-recovery-');
  const store = recoveryAt(root, '1', { outstandingLimit: 1 });
  const live = await recoveryHost(store);
  live.children[0].say(questionRequest('first', 'first'));
  const saved = store.entries()[0];
  store.begin(saved.identity, null);
  live.children[0].say(questionRequest('second', 'second'));
  assert.equal(live.host.waiting().length, 2);
  assert.equal(store.entries().length, 1);
  assert.equal(store.entries()[0].disposition, 'unknown');
  assert.equal(live.host.answer('one', 'second', { decision: 'deny', reason: 'No' }), true);
  live.host.dispose();
  assert.equal(recoveryAt(root, '2').entries()[0].disposition, 'unknown');
});

test('a live recovery owner blocks two replacements and an unrelated origin', async () => {
  const root = tempDir('question-recovery-');
  let ended = false;
  const store = recoveryAt(root, '1', { pid: 123456, dead: () => ended });
  const live = await recoveryHost(store);
  live.children[0].say(questionRequest());
  const second = recoveryAt(root, '2', { pid: 123457, dead: () => ended });
  const third = recoveryAt(root, '3', { pid: 123458, dead: () => ended });
  assert.equal(second.owns(), false);
  assert.equal(third.owns(), false);
  const unrelated = recoveryAt(root, '4', { origin: 'b'.repeat(32), dead: () => ended });
  const ask = live.host.waiting()[0].ask;
  assert.equal(ask.kind, 'question');
  if (ask.kind !== 'question') throw new Error('Question fixture failed.');
  assert.equal(unrelated.capture('claude', 'session', WS, ask), false);
  ended = true;
  assert.equal(second.owns(), true);
  ended = false;
  assert.equal(third.owns(), false);
  assert.equal(unrelated.capture('claude', 'session', WS, ask), false);
  second.release();
  third.release();
  unrelated.release();
  live.host.dispose();
});

test('unknown delivery survives fresh hosts and local Decline releases capacity without a provider', async () => {
  const root = tempDir('question-recovery-');
  const store = recoveryAt(root, '1');
  const before = await recoveryHost(store);
  before.children[0].say(questionRequest());
  const entry = store.entries()[0];
  store.begin(entry.identity, 'Answer');
  before.host.dispose();
  const restored = recoveryAt(root, '2', { outstandingLimit: 1 });
  const after = fakeHost(undefined, undefined, { recovery: restored });
  const card = askCard(after.host.waiting()[0].ask, 'Claude');
  assert.equal(card.answerBlocked, true);
  assert.equal(card.actions[0].label, 'Decline');
  assert.throws(() => restored.begin(entry.identity, 'Answer'), /already been sent/);
  restored.settle(entry.identity, 'declined');
  assert.equal(after.host.waiting().length, 0);
  assert.equal(after.children.length, 0);
  assert.equal(restored.capture('claude', 'session', WS, entry.ask), true);
  assert.equal(restored.entries().length, 0, 'dismissal resurrected during capture');
  after.host.dispose();
  assert.equal(recoveryAt(root, '3').entries().length, 0);
});

test('repeated wording with a new source identity stays distinct and blocks contextual continuation', async () => {
  const root = tempDir('question-recovery-');
  const before = await recoveryHost(recoveryAt(root, '1'));
  before.children[0].say(questionRequest('old', 'old'));
  before.host.dispose();
  const after = await recoveryHost(recoveryAt(root, '2'));
  after.children[0].say(questionRequest('new', 'new'));
  const cards = after.host.waiting().map((entry) => askCard(entry.ask, 'Claude'));
  assert.equal(cards.length, 2);
  assert.equal(cards.filter((card) => card.answerBlocked).length, 1);
  assert.equal(after.host.answer('one', 'new', { decision: 'deny', reason: 'No' }), true);
  after.host.dispose();
});

test('a native request with the exact original tool identity uses its fresh transport request', async () => {
  const root = tempDir('question-recovery-');
  const before = await recoveryHost(recoveryAt(root, '1'));
  before.children[0].say(questionRequest('old', 'same'));
  before.host.dispose();
  const after = await recoveryHost(recoveryAt(root, '2'));
  after.children[0].say(questionRequest('fresh', 'same'));
  assert.equal(after.host.waiting().length, 1);
  assert.equal(after.host.waiting()[0].ask.id, 'fresh');
  assert.equal(
    after.host.answer(
      'one',
      'fresh',
      {
        decision: 'answer',
        answers: {
          'Which option?': { labels: [], written: 'Use the third option' },
        },
      },
      true,
    ),
    true,
  );
  const response = after.children[0].sent().at(-1)?.response as any;
  assert.equal(response.request_id, 'fresh');
  assert.equal(response.response.updatedInput.answers['Which option?'], 'Use the third option');
  after.host.dispose();
});

test('Codex partial async answers retain original indexes and exact source evidence settles another client answer', () => {
  const root = tempDir('question-recovery-');
  const source = path.join(root, 'source.jsonl');
  const store = recoveryAt(root, '1');
  const questions = [0, 1].map((index) => ({
    id: asyncQuestionId('item', index),
    question: 'Repeated wording',
    header: 'Choice',
    options: [{ label: 'One', description: '' }],
    multiSelect: false,
    secret: false,
  }));
  assert.equal(
    store.capture(
      'codex',
      'session',
      WS,
      { kind: 'question', id: 'item', toolUseId: 'item', input: {}, questions },
      source,
    ),
    true,
  );
  const first = buildQuestionReply([
    { questionItemId: questions[0].id, question: questions[0].question, answer: 'One' },
  ]);
  fs.writeFileSync(
    source,
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: first }] },
    }) + '\n',
  );
  const reader = new QuestionEvidenceReader();
  reader.reconcile(store, () => source);
  assert.deepEqual(
    store.entries()[0].ask.questions.map((q) => q.id),
    [asyncQuestionId('item', 1)],
  );
  const entry = store.entries()[0];
  const text = questionContinuation(entry, {
    decision: 'answer',
    answers: { [questions[1].id]: { labels: [], written: 'Another answer' } },
  });
  assert.equal(
    text,
    buildQuestionReply([
      { questionItemId: questions[1].id, question: questions[1].question, answer: 'Another answer' },
    ]),
  );
  fs.appendFileSync(
    source,
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }) + '\n',
  );
  reader.reconcile(store, () => source);
  assert.equal(store.entries().length, 0);
  store.release();
});

test('secret question recovery saves no answer and allows no contextual secret prompt', () => {
  const store = recoveryAt(tempDir('question-recovery-'), '1');
  const ask = {
    kind: 'question' as const,
    id: 'secret',
    toolUseId: 'secret',
    input: { answers: { key: 'do-not-save' } },
    questions: [
      {
        id: 'key',
        question: 'Enter the password',
        header: 'Password',
        options: [],
        multiSelect: false,
        secret: true,
      },
    ],
  };
  assert.equal(store.capture('codex', 'session', WS, ask), true);
  const entry = store.entries()[0];
  assert.equal(
    questionContinuation(entry, { decision: 'answer', answers: { key: { labels: [], written: 'do-not-save' } } }),
    null,
  );
  store.begin(entry.identity, null);
  const saved = fs.readFileSync(path.join(store.options.root, recoveryOrigin, 'questions.json'), 'utf8');
  assert.ok(!saved.includes('do-not-save'));
  store.release();
});

test('explicit predecessor closure persists independently of provider reset acceptance', async () => {
  const root = tempDir('question-recovery-');
  const store = recoveryAt(root, '1');
  const before = await recoveryHost(store);
  before.children[0].say(questionRequest());
  store.closeSession('session');
  before.host.dispose();
  assert.equal(recoveryAt(root, '2').entries().length, 0);
});

test('local dismissal survives pruning of readable question history', () => {
  vi.useFakeTimers();
  const root = tempDir('question-recovery-history-');
  const store = recoveryAt(root, '1');
  const ask = {
    kind: 'question' as const,
    id: 'original',
    toolUseId: 'original',
    input: {},
    questions: [
      {
        id: 'choice',
        question: 'Which option?',
        header: '',
        options: [],
        multiSelect: false,
        secret: false,
      },
    ],
  };
  for (let index = 0; index <= 512; index++) {
    vi.setSystemTime(index + 1);
    assert.equal(
      store.capture('claude', 'session', WS, { ...ask, toolUseId: index ? `item-${index}` : 'original' }),
      true,
    );
    store.settle(store.entries()[0].identity, 'declined');
  }
  store.release();
  const restored = recoveryAt(root, '2');
  assert.equal(restored.capture('claude', 'session', WS, ask), true);
  assert.equal(restored.entries().length, 0);
  restored.release();
});

test.each(['start', 'resume', 'fork'])(
  'read-only Codex %s keeps thread and turn permissions through clear and rejected setting changes',
  async (opening) => {
    const { host, children } = fakeHost();
    const options = {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      policy: launchPolicy('codex', true),
      ...(opening === 'start' ? {} : { [opening]: 'source' }),
    };
    const starting = host.session('review', codexPlan(CODEX, options));
    const child = children[0];
    child.reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
    child.reply({ data: [{ cwd: WS, skills: [] }] });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, `thread/${opening}`));
    const check = (message: any, turn = false) => {
      assert.equal(message.params.approvalPolicy, 'never');
      assert.equal(message.params.approvalsReviewer, 'user');
      assert.deepEqual(
        turn ? message.params.sandboxPolicy : message.params.sandbox,
        turn ? { type: 'readOnly' } : 'read-only',
      );
    };
    check(child.sent().at(-1));
    child.reply({ thread: { id: 'review' } });
    const session = await starting;
    await assert.rejects(session.setAskMode(defaultAskMode('codex')), /read-only/);
    for (let index = 0; index < 2; index++) {
      const delivery = session.prompt('read the repository');
      await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
      check(child.sent().at(-1), true);
      child.reply({ turn: { id: `turn-${index}` } });
      await delivery;
      child.say(
        JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'review', turn: { id: `turn-${index}`, status: 'completed' } },
        }) + '\n',
      );
    }
    const clearing = session.clear();
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/start'));
    check(child.sent().at(-1));
    child.reply({ thread: { id: 'review-cleared' } });
    await clearing;
    host.dispose();
  },
);

test('read-only Claude retains tool restrictions through permission refusal and continuation', async () => {
  const { host, children, commands } = fakeHost();
  const starting = host.session(
    'review',
    claudePlan(CLAUDE, { cwd: WS, sessionId: 'review', policy: launchPolicy('claude', true) }),
  );
  children[0].answerHandshake();
  const session = await starting;
  const args = commands[0];
  for (const rule of ['Write', 'Edit', 'Agent', 'PowerShell', 'Bash(git stash)', 'Bash(git -C * update-ref *)'])
    assert.ok(args.includes(rule));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  await assert.rejects(session.setAskMode(defaultAskMode('claude')), /read-only/);
  children[0].say(
    JSON.stringify({
      type: 'control_request',
      request_id: 'write',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: { file_path: 'forbidden' },
        tool_use_id: 'write-1',
      },
    }) + '\n',
  );
  assert.equal(session.answer('write', { decision: 'allow' }), false);
  assert.equal(session.answer('write', { decision: 'deny', reason: 'Read-only session.' }), true);
  await session.prompt('read this repository');
  children[0].say(COMPLETED_RESULT);
  await session.clear();
  children[0].say(COMPLETED_RESULT);
  await session.prompt('read again');
  assert.equal(commands.length, 1);
  host.dispose();
});

// Restore real timers after every test, including tests whose assertions throw.

afterEach(() => {
  vi.useRealTimers();
});

// Stop results use terminal_reason: aborted_streaming, or aborted_tools when a tool was running.
// The wire reads both outcomes as interrupted.

const ABORTED_RESULT =
  JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    result: '',
  }) + '\n';
const ABORTED_TOOLS_RESULT =
  JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    stop_reason: 'tool_use',
    terminal_reason: 'aborted_tools',
    result: '',
  }) + '\n';
const COMPLETED_RESULT =
  JSON.stringify({
    type: 'result',
    is_error: false,
    terminal_reason: 'completed',
    result: 'done',
  }) + '\n';

// The fake child records stdin writes and delivers stdout chunks, including chunks split within a line.

class FakeChild implements ChildLike {
  written: string[] = [];
  killed = false;
  ended = false;
  endCalls = 0;
  private outListener: ((chunk: string) => void) | null = null;
  private errListener: ((chunk: string) => void) | null = null;
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private closeListeners: (() => void)[] = [];
  private errorListener: ((error: Error) => void) | null = null;

  stdin = {
    write: (chunk: string) => {
      this.written.push(chunk);
    },
    end: () => {
      this.ended = true;
      this.endCalls += 1;
    },
  };

  stdout = {
    setEncoding: () => undefined,
    on: (_event: 'data', listener: (chunk: string | Buffer) => void) => {
      this.outListener = listener;
    },
  };

  stderr = {
    setEncoding: () => undefined,
    on: (_event: 'data', listener: (chunk: string | Buffer) => void) => {
      this.errListener = listener;
    },
  };

  kill(): void {
    this.killed = true;
  }

  on(event: 'exit' | 'close' | 'error', listener: never): void {
    if (event === 'exit') {
      this.exitListeners.push(listener);
    } else if (event === 'close') this.closeListeners.push(listener);
    else this.errorListener = listener;
  }

  say(chunk: string): void {
    this.outListener?.(chunk);
  }
  complain(chunk: string): void {
    this.errListener?.(chunk);
  }
  exit(code: number | null, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener(code, signal);
  }
  close(): void {
    for (const listener of this.closeListeners) listener();
  }
  fail(error: Error): void {
    this.errorListener?.(error);
  }

  // Parse each captured stdin write as JSON.

  sent(): Record<string, unknown>[] {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // Answers whichever JSON-RPC request went out last, so a test can walk a Codex
  // session through its opening chain.
  reply(result: unknown): void {
    const requests = this.sent().filter((m) => typeof m.id === 'number' && typeof m.method === 'string');
    const last = requests[requests.length - 1];
    if (!last) throw new Error('nothing to reply to');
    this.say(JSON.stringify({ id: last.id, result }) + '\n');
  }

  replyError(code: number, message: string): void {
    const requests = this.sent().filter((m) => typeof m.id === 'number' && typeof m.method === 'string');
    const last = requests[requests.length - 1];
    if (!last) throw new Error('nothing to reply to');
    this.say(JSON.stringify({ id: last.id, error: { code, message } }) + '\n');
  }

  // Answer the first JSON-RPC request for the named method, even when later requests have been sent.

  replyTo(method: string, result: unknown): void {
    const found = this.sent().find((m) => m.method === method && typeof m.id === 'number');
    if (!found) throw new Error(`nothing asked ${method}`);
    this.say(JSON.stringify({ id: found.id, result }) + '\n');
  }

  // Answers the handshake the session sends on start, so a test can get past it.
  answerHandshake(commands: { name: string; description: string; argumentHint: string }[] = []): void {
    const first = this.sent()[0];
    this.say(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: first.request_id, response: { commands } },
      }) + '\n',
    );
  }

  // Answer the first control request with the supplied subtype.
  answerControl(subtype: string, response: unknown): void {
    const found = this.sent().find((m) => (m.request as { subtype?: string } | undefined)?.subtype === subtype);
    if (!found) throw new Error(`nothing asked ${subtype}`);
    this.say(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: found.request_id, response },
      }) + '\n',
    );
  }

  rejectControl(subtype: string, message: string): void {
    const found = this.sent().find((m) => (m.request as { subtype?: string } | undefined)?.subtype === subtype);
    if (!found) throw new Error(`nothing asked ${subtype}`);
    this.say(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: found.request_id, error: message },
      }) + '\n',
    );
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Make the next stdin write throw once, then restore the original writer for subsequent requests.

function failNextWrite(child: FakeChild, message: string): void {
  const original = child.stdin.write;
  child.stdin.write = (_chunk: string) => {
    child.stdin.write = original;
    throw new Error(message);
  };
}

class FakeAgentHostTimer implements AgentHostTimer {
  readonly tasks: { callback: () => void; delayMs: number; cleared: boolean }[] = [];

  set(callback: () => void, delayMs: number): unknown {
    const task = { callback, delayMs, cleared: false };
    this.tasks.push(task);
    return task;
  }

  clear(timer: unknown): void {
    (timer as { cleared: boolean }).cleared = true;
  }

  activeCount(): number {
    return this.tasks.filter((task) => !task.cleared).length;
  }

  fire(index: number, includeCleared = false): void {
    const task = this.tasks[index];
    if (!task) {
      throw new Error(`timer ${index} was not scheduled`);
    }
    if (!task.cleared || includeCleared) {
      task.callback();
    }
  }
}

async function answerCodexHandshake(
  child: FakeChild,
  skills: Array<{ name: string; description: string }> = [],
): Promise<void> {
  child.reply({ userAgent: 'codex' });
  await tick();
  child.reply({ data: [{ cwd: WS, skills }] });
  await tick();
}

function fakeHost(
  openingDeadlineMs?: number,
  now?: () => number,
  lifecycle: {
    recovery?: QuestionRecovery;
    onRecoveryFailure?: () => void;
    idleDurationMs?: number;
    timer?: AgentHostTimer;
    exitGraceMs?: number;
    onEvent?: (event: SessionEvent) => void;
    onNativeObservation?: import('./agenthost').HostOptions['onNativeObservation'];
    onStateChange?: (state: SessionState) => void;
  } = {},
): {
  host: AgentHost;
  children: FakeChild[];
  events: SessionEvent[];
  states: SessionState[];
  commands: string[][];
  envs: Record<string, string>[];
} {
  const children: FakeChild[] = [];
  const events: SessionEvent[] = [];
  const states: SessionState[] = [];
  const commands: string[][] = [];
  const envs: Record<string, string>[] = [];
  const host = new AgentHost({
    openingDeadlineMs,
    now,
    recovery: lifecycle.recovery,
    onRecoveryFailure: lifecycle.onRecoveryFailure,
    onNativeObservation: lifecycle.onNativeObservation,
    idleDurationMs: lifecycle.idleDurationMs ?? 60_000,
    timer: lifecycle.timer,
    exitGraceMs: lifecycle.exitGraceMs,
    spawner: (_command, args, _cwd, env) => {
      commands.push(args);
      envs.push(env);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    onEvent: (event) => {
      events.push(event);
      lifecycle.onEvent?.(event);
    },
    onStateChange: (state) => {
      states.push(state);
      lifecycle.onStateChange?.(state);
    },
  });
  return { host, children, events, states, commands, envs };
}

function settle(host: AgentHost, key: string): void {
  host.settled(host.beginHousekeeping(key));
}

// Exercise the extension's policy callbacks with the host's native transport fixtures.
function policyCallbacks(host: AgentHost, policies: LaunchPolicyStore) {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const moves: string[][] = [];
  const modes: unknown[] = [];
  const errors: string[] = [];
  const panel: any = {
    initialNamesChanged() {},
    refresh() {},
    noteSessionMoved: (source: string, next: string) => moves.push([source, next]),
    setCodexEffectiveMode: (...args: unknown[]) => modes.push(args),
  };
  const at = source.indexOf("      if (event.kind === 'session') {\n        const policy =");
  const ownership = source.indexOf("if (event.kind === 'session' && event.previous", at);
  const eventCode =
    source.slice(at, source.indexOf('      // Publish busy children', at)) +
    source.slice(ownership, source.indexOf("      if (event.kind === 'permissionMode')", ownership));
  const stateAt = source.indexOf('    onStateChange: (state) => {');
  const stateCode = source.slice(
    stateAt + '    onStateChange: (state) => {'.length,
    source.indexOf('      if (commandStateChanges', stateAt),
  );
  const scope = {
    host,
    policies,
    panel,
    policyMoves: new Map(),
    compaction: null,
    vscode: { window: { showErrorMessage: (message: string) => errors.push(message) } },
    withExistingSessionActivity: async (agent: any, session: string, _cwd: string, work: any) => {
      const child = host.find(agent, session);
      assert.ok(child);
      return host.withActivity(child.key, work);
    },
    savePolicy: async (id: string, policy: any) => {
      if (policy) policies.write(id, policy);
    },
    failedClearDelivery: (_agent: string, error: Error) => ({ delivered: false, reason: error.message }),
    launchFor: () => CODEX,
    askModeFor: () => undefined,
    askValueFor: () => undefined,
    modelFor: () => '',
    effortFor: () => '',
    sessionSettingsForProfile,
    codexPlan,
    CLIENT_INFO: CODEX_CLIENT,
    ensureSession: async (key: string, plan: AgentPlan) => {
      const child = await host.session(key, plan);
      if (child.state().exited && child.state().lastError) throw new Error(child.state().lastError!);
      return child;
    },
    persistSessionSettings: async () => {},
    publishPicks() {},
  };
  const code = esbuild.transformSync(
    `${statementFrom(source, source.indexOf('panel.onClear ='))};
    let forkSequence = 0;
    ${statementFrom(source, source.indexOf('const forkCodexSession ='))};
    return {
      fork: forkCodexSession,
      event: ({key, event}) => { const agent = host.get(key)?.agent; ${eventCode} },
      state: (state) => { ${stateCode} },
    };`,
    { loader: 'ts' },
  ).code;
  const callbacks = runInNewContext(`(function() { ${code} })()`, scope);
  return { ...callbacks, panel, moves, modes, errors };
}

test.each(['clear', 'fork'])(
  'restricted Codex %s preserves durable refusal after one successor save failure and child replacement',
  async (operation) => {
    const root = tempDir('arc-policy-codex-successor-');
    let callbacks: ReturnType<typeof policyCallbacks>;
    const { host, children } = fakeHost(undefined, undefined, {
      onEvent: (event) => callbacks?.event(event),
      onStateChange: (state) => callbacks?.state(state),
    });
    try {
      const policies = new LaunchPolicyStore(root);
      callbacks = policyCallbacks(host, policies);
      const policy = launchPolicy('codex', true)!;
      policies.write('source', policy);
      const openSource = () =>
        host.session('owned', codexPlan(CODEX, { cwd: WS, resume: 'source', policy, clientInfo: CODEX_CLIENT }));
      const opening = openSource();
      let child = children[0];
      child.reply({ userAgent: 'codex' });
      await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
      child.reply({ data: [] });
      await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/resume'));
      child.reply({ thread: { id: 'source' } });
      const source = await opening;
      const save = vi.spyOn(policies, 'write').mockImplementation((id, value) => {
        if (id === 'successor') throw new Error('successor save failed');
        LaunchPolicyStore.prototype.write.call(policies, id, value);
      });
      const result =
        operation === 'clear'
          ? callbacks.panel.onClear('codex', 'source', WS)
          : callbacks.fork('source', WS).then(
              () => assert.fail('fork accepted'),
              (error: Error) => error,
            );
      if (operation === 'fork') {
        child = children.at(-1)!;
        child.reply({ userAgent: 'codex' });
        await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
        child.reply({ data: [] });
      }
      await vi.waitFor(() =>
        assert.equal(child.sent().at(-1)?.method, operation === 'clear' ? 'thread/start' : 'thread/fork'),
      );
      assert.throws(() => new LaunchPolicyStore(root).read('successor'), /cannot continue/);
      child.reply({ thread: { id: 'successor' } });
      const outcome = await result;
      assert.equal(save.mock.calls.filter(([id]) => id === 'successor').length, 1);
      assert.equal(policies.readSaved('successor'), undefined);
      assert.throws(() => new LaunchPolicyStore(root).read('successor'), /cannot continue/);
      assert.deepEqual(callbacks.moves, []);
      if (operation === 'clear') {
        assert.equal(outcome.delivered, false);
        assert.equal(source.state().exited, false);
        assert.equal(host.find('codex', 'successor'), source);
        const prompt = source.prompt('read only');
        await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
        assert.deepEqual((child.sent().at(-1)?.params as any)?.sandboxPolicy, { type: 'readOnly' });
        child.reply({ turn: { id: 'restricted-turn' } });
        await prompt;
      } else {
        assert.match(outcome.message, /successor save failed/);
        assert.equal(host.get('codex:fork:source:1')!.state().exited, true);
        assert.equal(
          child.sent().some((request) => request.method === 'turn/start'),
          false,
        );
      }
      save.mockRestore();
      child.exit(0);
      const key = operation === 'clear' ? 'owned' : 'codex:fork:source:1';
      const replacement = host.session(
        key,
        codexPlan(CODEX, { cwd: WS, resume: 'replacement', policy, clientInfo: CODEX_CLIENT }),
      );
      const next = children.at(-1)!;
      next.reply({ userAgent: 'codex' });
      await vi.waitFor(() => assert.equal(next.sent().at(-1)?.method, 'skills/list'));
      next.reply({ data: [] });
      await vi.waitFor(() => assert.equal(next.sent().at(-1)?.method, 'thread/resume'));
      next.reply({ thread: { id: 'replacement' } });
      await replacement;
      child.say(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'stale' } } }) + '\n');
      assert.equal(policies.readSaved('stale'), undefined);
      assert.deepEqual(policies.readSaved('replacement'), policy);
      assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
    } finally {
      vi.restoreAllMocks();
      host.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(
  ['clear', 'fork'].flatMap((operation) =>
    ['saved', 'reservation failure', 'RPC error', 'unknown write', 'timeout'].map((outcome) => [operation, outcome]),
  ),
)('restricted Codex %s preserves admission after %s', async (operation, outcome) => {
  const root = tempDir('arc-policy-codex-outcome-');
  let callbacks: ReturnType<typeof policyCallbacks>;
  const { host, children } = fakeHost(undefined, undefined, {
    onEvent: (event) => callbacks?.event(event),
    onStateChange: (state) => callbacks?.state(state),
  });
  try {
    const policies = new LaunchPolicyStore(root);
    callbacks = policyCallbacks(host, policies);
    const policy = launchPolicy('codex', true)!;
    policies.write('source', policy);
    const opening = host.session(
      'owned',
      codexPlan(CODEX, { cwd: WS, resume: 'source', policy, clientInfo: CODEX_CLIENT }),
    );
    let child = children[0];
    child.reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
    child.reply({ data: [] });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/resume'));
    child.reply({ thread: { id: 'source' } });
    await opening;
    if (outcome === 'reservation failure')
      vi.spyOn(policies, 'prepareClear').mockImplementation(() => {
        throw new Error('reservation failed');
      });
    if (operation === 'clear' && outcome === 'unknown write') failNextWrite(child, 'write uncertain');
    if (operation === 'clear' && outcome === 'timeout') vi.useFakeTimers();
    const before = child.written.length;
    const clearing =
      operation === 'clear'
        ? callbacks.panel.onClear('codex', 'source', WS)
        : callbacks.fork('source', WS).then(
            () => ({ delivered: true }),
            () => ({ delivered: false }),
          );
    let forkBefore = 0;
    if (operation === 'fork') {
      child = children.at(-1)!;
      child.reply({ userAgent: 'codex' });
      await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
      if (outcome === 'unknown write') failNextWrite(child, 'write uncertain');
      if (outcome === 'timeout') vi.useFakeTimers();
      forkBefore = child.written.length;
      child.reply({ data: [] });
    }
    if (outcome === 'saved' || outcome === 'RPC error') {
      await vi.waitFor(() =>
        assert.equal(child.sent().at(-1)?.method, operation === 'clear' ? 'thread/start' : 'thread/fork'),
      );
      assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
      if (outcome === 'saved') child.reply({ thread: { id: 'successor' } });
      else child.say(JSON.stringify({ id: child.sent().at(-1)?.id, error: { message: 'generic RPC failure' } }) + '\n');
    }
    if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(CODEX_DEADLINE_MS);
    assert.equal((await clearing).delivered, outcome === 'saved');
    if (outcome === 'reservation failure' || outcome === 'unknown write')
      assert.equal(child.written.length, operation === 'clear' ? before : forkBefore);
    if (outcome === 'saved') assert.deepEqual(new LaunchPolicyStore(root).read('successor'), policy);
    if (outcome === 'saved' || outcome === 'reservation failure')
      assert.equal(new LaunchPolicyStore(root).read('unknown'), undefined);
    else assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successor reservations reject replacement owners and ended confirmation tokens', () => {
  const root = tempDir('arc-policy-owner-');
  try {
    const policies = new LaunchPolicyStore(root);
    const policy = launchPolicy('codex', true)!;
    policies.write('source', policy);
    policies.write('successor', policy);
    const owner = {};
    const replacement = {};
    const token = policies.prepareClear('key', 'source', owner);
    policies.cancelClear('key', token, replacement);
    assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
    assert.equal(policies.confirmClear('key', 'successor', replacement), false);
    assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
    policies.forgetClear('key');
    policies.cancelClear('key', token, owner);
    assert.equal(policies.confirmClear('key', 'successor', owner), false);
    assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(['same chunk', 'separate chunks'])(
  'pending restricted clear preserves unrestricted Claude output in %s',
  async (chunks) => {
    const root = tempDir('arc-policy-output-');
    let callbacks: ReturnType<typeof policyCallbacks>;
    const fixture = fakeHost(undefined, undefined, {
      onEvent: (event) => callbacks?.event(event),
      onStateChange: (state) => callbacks?.state(state),
    });
    const { host, children, events } = fixture;
    try {
      const policies = new LaunchPolicyStore(root);
      callbacks = policyCallbacks(host, policies);
      const policy = launchPolicy('claude', true)!;
      policies.write('restricted', policy);
      for (const id of ['restricted', 'ordinary']) {
        const opening = host.session(
          id,
          claudePlan(CLAUDE, { cwd: WS, sessionId: id, ...(id === 'restricted' ? { policy } : {}) }),
        );
        children.at(-1)!.answerHandshake();
        await opening;
      }
      assert.equal((await callbacks.panel.onClear('claude', 'restricted', WS)).delivered, true);
      const ordinaryClear = await callbacks.panel.onClear('claude', 'ordinary', WS);
      const result =
        JSON.stringify({ type: 'result', session_id: 'ordinary-next', num_turns: 1, subtype: 'success' }) + '\n';
      const later = JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }) + '\n';
      if (chunks === 'same chunk') children[1].say(result + later);
      else {
        children[1].say(result);
        children[1].say(later);
      }
      assert.equal(ordinaryClear.delivered, true);
      assert.equal(host.get('ordinary')!.state().busy, false);
      assert.ok(events.some(({ key, event }) => key === 'ordinary' && event.kind === 'turnEnd'));
      assert.ok(
        events.some(({ key, event }) => key === 'ordinary' && event.kind === 'sessionState' && event.state === 'idle'),
      );
      assert.deepEqual(callbacks.moves, [['ordinary', 'ordinary-next']]);
      assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
    } finally {
      host.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('pending restricted Claude clear preserves unrestricted Codex clear and reader permission picks', async () => {
  const root = tempDir('arc-policy-codex-');
  let callbacks: ReturnType<typeof policyCallbacks>;
  const { host, children } = fakeHost(undefined, undefined, {
    onEvent: (event) => callbacks?.event(event),
    onStateChange: (state) => callbacks?.state(state),
  });
  try {
    const policies = new LaunchPolicyStore(root);
    callbacks = policyCallbacks(host, policies);
    policies.write('restricted', launchPolicy('claude', true)!);
    policies.prepareClear('other-window', 'restricted');
    const opening = host.session('ordinary', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
    const child = children[0];
    child.reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
    child.reply({ data: [{ cwd: WS, skills: [] }] });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/start'));
    child.reply({
      thread: { id: 'ordinary' },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
    });
    const live = await opening;
    const clearing = callbacks.panel.onClear('codex', 'ordinary', WS);
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/start'));
    child.reply({
      thread: { id: 'ordinary-next' },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
    });
    assert.equal((await clearing).delivered, true);
    assert.equal(live.state().sessionId, 'ordinary-next');
    assert.equal(live.state().busy, false);
    assert.deepEqual(callbacks.moves, [['ordinary', 'ordinary-next']]);
    assert.equal(callbacks.modes.length, 2);
    const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
    let writes = 0;
    const scope = {
      host,
      policies,
      refusePolicyChange: () => assert.fail('unrestricted permission refused'),
      compaction: null,
      guardedSends: { invalidate() {} },
      panel: { clearEffectiveModes() {} },
      settingBook: () => ({}),
      withSessionSettings,
      sessionSettings,
      persistSettingBook: async () => {
        writes++;
      },
      publishPicks() {},
      acceptedPermissionMode,
      context: {
        workspaceState: {
          update: async () => {
            writes++;
          },
        },
      },
      stored: () => ({}),
      ASK_MODE_KEY: 'ask',
    };
    const pick = runInNewContext(
      `(function() { ${
        esbuild.transformSync(
          `${statementFrom(source, source.indexOf('const setAskModeFor ='))}; return setAskModeFor;`,
          { loader: 'ts' },
        ).code
      } })()`,
      scope,
    );
    await pick(
      'codex',
      { value: 'workspace-write', codex: { approvalPolicy: 'on-request', sandbox: 'workspace-write' } },
      'ordinary-next',
    );
    const end = child.stdin.end;
    child.stdin.end = () => {
      end();
      child.exit(0);
    };
    await pick('codex', { value: '' }, 'ordinary-next');
    await pick('codex', { value: '' });
    assert.ok(writes >= 2);
    assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
  } finally {
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(['closed wire', 'pre-write refusal', 'unknown write', 'preparation failure', 'other reservation'])(
  'restricted clear preserves outcome ownership after %s',
  async (failure) => {
    const root = tempDir('arc-policy-write-');
    let callbacks: ReturnType<typeof policyCallbacks>;
    let refusing = false;
    const { host, children } = fakeHost(undefined, undefined, {
      onEvent: (event) => {
        callbacks?.event(event);
        if (refusing && event.event.kind === 'native' && event.event.event.kind === 'submission')
          throw new Error('positive refusal before input write');
      },
      onStateChange: (state) => callbacks?.state(state),
    });
    try {
      const policies = new LaunchPolicyStore(root);
      callbacks = policyCallbacks(host, policies);
      const policy = launchPolicy('claude', true)!;
      policies.write('restricted', policy);
      const opening = host.session('owned', claudePlan(CLAUDE, { cwd: WS, sessionId: 'restricted', policy }));
      const child = children[0];
      child.answerHandshake();
      const live = await opening;
      const before = child.written.length;
      if (failure === 'closed wire') live.driver.close('closed before clear');
      if (failure === 'pre-write refusal') refusing = true;
      if (failure === 'unknown write') failNextWrite(child, 'write outcome unknown');
      let previous: Buffer | undefined;
      if (failure === 'other reservation') {
        policies.prepareClear('other-child', 'restricted');
        previous = fs.readFileSync(path.join(root, 'pending-clear.json'));
      }
      if (failure === 'preparation failure') {
        const nativeFs = (await import('node:fs')).default;
        const write = nativeFs.writeFileSync;
        vi.spyOn(nativeFs, 'writeFileSync').mockImplementation(((file: any, ...args: any[]) => {
          if (typeof file === 'number') throw new Error('reservation write refused');
          return (write as any)(file, ...args);
        }) as typeof fs.writeFileSync);
      }
      assert.equal((await callbacks.panel.onClear('claude', 'restricted', WS)).delivered, false);
      assert.equal(child.written.length, before);
      refusing = false;
      vi.restoreAllMocks();
      assert.deepEqual(new LaunchPolicyStore(root).read('restricted'), policy);
      if (failure === 'other reservation') {
        assert.deepEqual(fs.readFileSync(path.join(root, 'pending-clear.json')), previous);
      } else if (failure === 'unknown write') {
        assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
        child.exit(0);
        const reopening = host.session('owned', claudePlan(CLAUDE, { cwd: WS, sessionId: 'restricted', policy }));
        children[1].answerHandshake();
        await reopening;
        child.say(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stale-successor', tools: [] }) + '\n');
        assert.equal(policies.readSaved('stale-successor'), undefined);
        children[1].say(
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'new-successor', tools: [] }) + '\n',
        );
        assert.deepEqual(policies.readSaved('new-successor'), policy);
        assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
      } else {
        assert.equal(new LaunchPolicyStore(root).read('unknown'), undefined);
        if (failure === 'pre-write refusal' || failure === 'preparation failure') {
          assert.equal((await callbacks.panel.onClear('claude', 'restricted', WS)).delivered, true);
          assert.throws(() => new LaunchPolicyStore(root).read('unknown'), /cannot continue/);
        }
      }
    } finally {
      vi.restoreAllMocks();
      host.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('Claude response speed follows the shared owner established at response start', async () => {
  const SESSION = 'speed-session';
  const { host, children, events } = fakeHost();
  const opening = host.session('speed', claudePlan(CLAUDE, { cwd: WS, sessionId: SESSION }));
  children[0].answerHandshake([]);
  const session = await opening;
  const id = await session.prompt('first');
  const handle = (event: WireEvent) => (session as unknown as { handle(event: WireEvent): void }).handle(event);
  const rate: WireEvent = {
    kind: 'responseRate',
    sourceId: 'response',
    rate: { sessionId: SESSION, responseId: 'response', model: 'claude-opus-5', output: 84, milliseconds: 1000 },
  };
  handle(rate);
  assert.equal(events.filter((entry) => entry.event.kind === 'responseRate').length, 0);
  handle({ kind: 'responseStarted', sourceId: 'response' });
  handle(rate);
  assert.equal(events.find((entry) => entry.event.kind === 'responseRate')?.turnId, id);
  handle(rate);
  assert.equal(events.filter((entry) => entry.event.kind === 'responseRate').length, 1);
  handle({ kind: 'responseStarted', sourceId: 'steered' });
  await session.prompt('second');
  handle({ ...rate, sourceId: 'steered' });
  assert.equal(events.filter((entry) => entry.event.kind === 'responseRate').length, 2);
  assert.equal(events.filter((entry) => entry.event.kind === 'responseRate').at(-1)?.turnId, id);
});

test('LineReader keeps a line whole across the chunks it arrives in', () => {
  const lines: string[] = [];
  const reader = new LineReader((line) => lines.push(line));
  reader.push('{"a":1}\n{"b":');
  assert.deepEqual(lines, ['{"a":1}'], 'the half line is held, not handed on');
  reader.push('2}\n{"c":3}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('identified split context frames discard only overflow and preserve following traffic and EOF', () => {
  const lines: string[] = [];
  const rejected: string[] = [];
  const reader = new LineReader((line) => lines.push(line), {
    identify: (text) => (contextFrameId(text) === 'ctx' ? 'ctx' : null),
    overflow: (id) => rejected.push(id),
  });
  reader.push('{ "ty');
  reader.push('pe": "control_response", "response": { "subtype":"success", "request_');
  reader.push('id":"c\\u0074x", "response":{"large":"');
  reader.push('x'.repeat(CONTEXT_FRAME_BYTES));
  reader.push('"}}}\n{"type":"assistant","message":{}}\n{"type":"result"}');
  reader.flush();
  assert.deepEqual(rejected, ['ctx']);
  assert.ok(!lines.some((line) => line.includes('large')));
  assert.equal(lines.at(-2), '{"type":"assistant","message":{}}');
  assert.equal(lines.at(-1), '{"type":"result"}');
  const unrelated = '{"type":"assistant","text":"' + 'x'.repeat(CONTEXT_FRAME_BYTES + 1) + '"}';
  reader.push(unrelated);
  reader.flush();
  assert.equal(lines.at(-1), unrelated);
});

test('LineReader drops the carriage return a Windows pipe adds', () => {
  const lines: string[] = [];
  new LineReader((line) => lines.push(line)).push('{"a":1}\r\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

test('LineReader hands on a last line the CLI never terminated', () => {
  const lines: string[] = [];
  const reader = new LineReader((line) => lines.push(line));
  reader.push('{"a":1}');
  assert.deepEqual(lines, []);
  reader.flush();
  assert.deepEqual(lines, ['{"a":1}']);
});

test('a session sends the handshake before anything else and keeps the command list', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  assert.equal(child.sent()[0].type, 'control_request');
  child.answerHandshake([{ name: 'compact', description: 'Compact', argumentHint: '' }]);
  const session = await starting;
  assert.deepEqual(
    session.state().commands.map((c) => c.name),
    ['compact'],
  );
});

test('a listener told a session is ready can read its commands off it there and then', async () => {
  // A ready listener must read the command list immediately. Publish handshake commands before emitting ready.

  const children: FakeChild[] = [];
  const seen: string[][] = [];
  let host: AgentHost | null = null;
  host = new AgentHost({
    idleDurationMs: 60_000,
    spawner: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    onEvent: ({ key, event }) => {
      if (event.kind !== 'ready') {
        return;
      }
      seen.push((host?.get(key)?.state().commands ?? []).map((c) => c.name));
    },
    onStateChange: () => undefined,
  });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake([{ name: 'compact', description: 'Compact', argumentHint: '' }]);
  await starting;
  assert.deepEqual(
    seen,
    [['compact']],
    'the session carried no commands at the moment it reported being ready, so everything ' +
      'reading the list off that event is handed an empty one',
  );
});

test('a session resuming a session says which one before its child speaks', async () => {
  // A resumed session retains its launch ID before the child emits session output.

  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, resume: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  assert.equal(
    session.state().sessionId,
    'sess-1',
    'a child whose session is unknown is left out of the running set, so no turn is ' +
      'drawn in flight and the press card comes down the moment the handoff answers',
  );
});

test('the same key reuses its child rather than starting a second one', async () => {
  const { host, children } = fakeHost();
  const first = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  await first;
  const second = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  await second;
  assert.equal(children.length, 1, 'a second child would mean two agents answering one session');
});

test('a key whose child has exited starts a fresh one', async () => {
  const { host, children } = fakeHost();
  const first = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  await first;
  children[0].exit(0);
  const second = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[1].answerHandshake();
  await second;
  assert.equal(children.length, 2);
});

test('a resumed session passes its id to the CLI', async () => {
  const { host, children, commands } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, resume: 'abc-123' }));
  children[0].answerHandshake();
  await starting;
  assert.equal(commands[0][commands[0].indexOf('--resume') + 1], 'abc-123');
});

test('a session is busy from the prompt until the turn ends', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  assert.equal(session.state().busy, false);
  const delivery = session.prompt('hello');
  assert.equal(session.state().busy, true);
  await delivery;
  children[0].say(
    JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', result: 'hi' }) + '\n',
  );
  assert.equal(session.state().busy, false);
});

test('a Claude effort change waits for the running turn and never ends it', async () => {
  const { host, children, events, states } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  const promptTurn = await session.prompt('hello');
  const lines = children[0].sent().length;
  await session.setEffort('low');
  assert.equal(
    children[0].sent().length,
    lines,
    'the change went out mid-turn, where nothing has sampled what the CLI does with it',
  );
  assert.equal(session.state().busy, true);

  // The reader's turn ends on its own result, and the held pick goes out after it.
  const published = states.length;
  children[0].say(COMPLETED_RESULT);
  assert.equal(
    events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId,
    promptTurn,
    'the effort command closed the turn the reader was waiting on',
  );
  assert.deepEqual(effortSends(children[0]), ['/effort low']);
  assert.equal(session.state().busy, true, 'the command owes a result, so the session is not idle yet');
  assert.ok(
    states.slice(published).every((state) => state.busy),
    'the panel was told the session was idle in the moment between the two turns',
  );

  // The command books its turn one step after the write, and its result must wait for that.
  const written = states.length;
  await vi.waitFor(() => assert.ok(states.length > written, 'the effort command booked no turn'));
  children[0].say(COMPLETED_RESULT);
  assert.equal(session.state().busy, false);
  assert.equal(
    events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId,
    promptTurn + 1,
    "the command result ended a turn of its own rather than the reader's",
  );
});

const A_MODEL_LIST: ModelList = {
  models: [
    {
      value: 'opus',
      label: 'Opus',
      description: 'The one that thinks hardest',
      efforts: [{ value: 'high', label: 'high', description: '' }],
    },
  ],
  readAt: 0,
};

// Return every /effort send in order, so assertions detect duplicate or empty commands.

function effortSends(child: FakeChild): string[] {
  return sentTexts(child).filter((text) => text.startsWith('/effort'));
}

// The text of every user message written to a child, in the order it was written.
function sentTexts(child: FakeChild): string[] {
  return child
    .sent()
    .map((line) => (line.message as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? '')
    .filter((text) => text !== '');
}

test('a prompt sent while a Claude effort pick waits runs at the picked level', async () => {
  const { host, children, events } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;
  const lastEnded = () => events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId;

  const firstTurn = await session.prompt('hello');
  await session.setEffort('low');
  const second = session.prompt('again');
  child.say(COMPLETED_RESULT);
  assert.equal(lastEnded(), firstTurn);
  const secondTurn = await second;

  // Written ahead of the command, the prompt queues in the child and runs at the old level.
  assert.deepEqual(
    sentTexts(child).slice(-2),
    ['/effort low', 'again'],
    'the prompt reached the child before the level the reader picked for it',
  );
  child.say(COMPLETED_RESULT);
  assert.notEqual(lastEnded(), secondTurn, "the command result closed the prompt's turn");
  assert.equal(session.state().busy, true);
  child.say(COMPLETED_RESULT);
  assert.equal(lastEnded(), secondTurn);
  assert.equal(session.state().busy, false);
});

test('a Claude effort pick sent after a turn failed keeps the failure on the session', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('hello');
  await session.setEffort('low');
  child.say('not json\n');
  assert.match(session.state().lastError ?? '', /unreadable line/);
  child.say(COMPLETED_RESULT);

  assert.deepEqual(effortSends(child), ['/effort low']);
  assert.match(
    session.state().lastError ?? '',
    /unreadable line/,
    'the held pick went out and erased the diagnostic the failed turn left',
  );
});

test('a second Claude effort pick replaces the one waiting rather than queueing behind it', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  await session.prompt('hello');
  await session.setEffort('low');
  await session.setEffort('high');
  children[0].say(COMPLETED_RESULT);

  assert.deepEqual(
    effortSends(children[0]),
    ['/effort high'],
    'a reader who picks twice paid a turn to pass through the level they replaced',
  );
});

test('a Claude effort pick waiting through a Stop reaches the child', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('hello');
  await session.setEffort('low');
  // An accepted Stop must release the effort pick waiting behind the interrupted work.

  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  await stopping;

  assert.deepEqual(effortSends(child), ['/effort low']);
  assert.equal(session.state().busy, true, 'the command owes a result, so the session is not idle yet');
});

test('a Claude effort pick waiting when the child exits reaches nothing', async () => {
  const { host, children, states } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  await session.prompt('hello');
  await session.setEffort('low');
  children[0].exit(1);
  await vi.waitFor(() => assert.equal(session.state().exited, true));

  assert.deepEqual(effortSends(children[0]), [], 'the level was written to the stdin of a child that had already gone');
  // Exiting clears the pending effort pick. An empty pick after exit must not publish another state change.

  const published = states.length;
  await session.setEffort('');
  assert.equal(states.length, published, 'the session still held a pick for a child that had gone');
  // The refusal carries the exit's own reason. A session that kept that diagnostic is the
  // only thing able to say why the level never went.
  await assert.rejects(session.setEffort('high'), /the agent stopped with code 1/);
});

test('a model change keeps a level the new model offers and drops one it does not', () => {
  const kept = modelChange('claude', 'opus', 'high', A_MODEL_LIST, true);
  assert.equal(kept.effort, 'high');
  assert.equal(kept.tellChild, false, 'the child already runs at the level that survived');
  assert.deepEqual(
    kept.settings,
    {
      selectedModel: 'opus',
      selectedEffort: 'high',
      effortModel: 'opus',
      pendingModel: null,
    },
    'a level the change did not move was stored with a standing it had not earned',
  );

  const dropped = modelChange('claude', 'opus', 'low', A_MODEL_LIST, true);
  assert.equal(dropped.effort, '', 'the new model offers no low level');
  assert.equal(dropped.tellChild, true, 'the child kept a pick waiting under a level the new model has no name for');
  assert.deepEqual(dropped.settings, {
    selectedModel: 'opus',
    selectedEffort: '',
    effortModel: '',
    pendingModel: null,
    pendingEffort: null,
  });

  const noChild = modelChange('claude', 'opus', 'low', A_MODEL_LIST, false);
  assert.equal(noChild.tellChild, false, 'there is no child to tell');
  assert.equal(
    noChild.settings.pendingModel,
    'opus',
    'a session with no child has its model recorded by the turn that runs on it',
  );

  const codex = modelChange('codex', 'opus', 'high', A_MODEL_LIST, true);
  assert.equal(codex.tellChild, false);
  assert.equal(codex.settings.pendingModel, 'opus', 'Codex applies the model to the next turn');
  assert.equal(
    'pendingEffort' in codex.settings,
    false,
    'a surviving level was marked pending again, which draws a settled level as unsettled',
  );
});

test('a model change carries the effort level the new model offers and drops the one it does not', async () => {
  const { host, children, states } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  await session.prompt('hello');
  await session.setEffort('high');
  const changing = session.setModel('opus');
  children[0].answerControl('set_model', {});
  await changing;

  // `pickedEffort` is the rule the panel applies to the stored level on a model change. The
  // session is told the same answer, so the level it holds cannot drift from the stored one.
  assert.equal(pickedEffort('high', A_MODEL_LIST, 'opus'), 'high');
  await session.setEffort('high');
  children[0].say(COMPLETED_RESULT);
  assert.deepEqual(effortSends(children[0]), ['/effort high']);
  // The command books its turn one step after the write. Its own result cannot reach a
  // session that has not booked it, so the test waits for the booking to be published.
  const written = states.length;
  await vi.waitFor(() => assert.ok(states.length > written, 'the effort command booked no turn'));
  children[0].say(COMPLETED_RESULT);
  assert.equal(session.state().busy, false);

  await session.prompt('again');
  await session.setEffort('low');
  assert.equal(
    pickedEffort('low', A_MODEL_LIST, 'opus'),
    '',
    'the model offers no low level, so the panel stores none and has none to ask for',
  );
  await session.setEffort('');
  children[0].say(COMPLETED_RESULT);
  await vi.waitFor(() => assert.equal(session.state().busy, false));

  assert.deepEqual(
    effortSends(children[0]),
    ['/effort high'],
    'a dropped level went out anyway, as itself or as a bare `/effort`',
  );
  assert.equal(
    session.state().lastError,
    null,
    'the dropped level was sent and refused, which puts a failure on a card over a pick the panel handled',
  );
});

test('Claude compaction sends only its command and stays busy until the command ends', async () => {
  const { host, children, events } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  const turnId = await session.compact();
  const sent = children[0].sent().at(-1);
  assert.deepEqual(sent?.message, {
    role: 'user',
    content: [{ type: 'text', text: '/compact' }],
  });
  assert.equal(session.state().busy, true);

  children[0].say(
    JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      result: '',
    }) + '\n',
  );
  assert.equal(session.state().busy, false);
  assert.equal(events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId, turnId);
});

test('Claude clear sends only its command and stays busy until the command ends', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  await session.clear();
  assert.deepEqual(children[0].sent().at(-1)?.message, {
    role: 'user',
    content: [{ type: 'text', text: '/clear' }],
  });
  assert.equal(session.state().busy, true);
});

test('a refused Claude clear still drains a held effort pick and lets its prompt through', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('hello');
  await session.setEffort('low');
  const second = session.prompt('again');

  failNextWrite(child, 'the pipe closed while the session was clearing');
  const clearing = session.clear();
  // The turn the pick was waiting on ends while the clear is still in flight.
  // Only the clear's own bookkeeping stands between the held pick and the child.
  child.say(COMPLETED_RESULT);
  assert.deepEqual(
    effortSends(child),
    [],
    'the pick went out before the clear standing in front of it had even failed',
  );

  await assert.rejects(clearing, /the pipe closed while the session was clearing/);
  await second;

  assert.match(
    session.state().lastError ?? '',
    /the pipe closed while the session was clearing/,
    'the clear refusal lost its diagnostic once the drain behind it ran',
  );
  assert.deepEqual(effortSends(child), ['/effort low'], 'the pick reached the child once, not zero or twice');
  assert.deepEqual(
    sentTexts(child).slice(-2),
    ['/effort low', 'again'],
    'a refused clear left the pick and the prompt waiting behind it stuck for good',
  );
  child.say(COMPLETED_RESULT);
  assert.equal(session.state().busy, true, "the queued prompt's own turn is still open");
  child.say(COMPLETED_RESULT);
  assert.equal(session.state().busy, false);
});

test('a Claude prompt refusal keeps its diagnostic through a held-pick drain', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  failNextWrite(child, 'the pipe closed before the prompt reached the agent');
  const delivery = session.prompt('hello');
  // Held in the same tick the prompt starts, so the drain the refusal below triggers finds
  // a pick already waiting rather than racing it into place.
  void session.setEffort('low');
  await assert.rejects(delivery, /would not take the prompt/);

  assert.match(
    session.state().lastError ?? '',
    /would not take the prompt/,
    'the pick that drained behind the refusal overwrote the reason the prompt gave',
  );
  assert.deepEqual(effortSends(child), ['/effort low'], 'the refusal never drained the pick it owed a release to');
  assert.equal(session.state().busy, true, 'the drained pick still owes its own result');
});

test('a Claude command refusal keeps its diagnostic through a held-pick drain', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  failNextWrite(child, 'the pipe closed before the command reached the agent');
  const compacting = session.compact();
  void session.setEffort('low');
  await assert.rejects(compacting, /the pipe closed before the command reached the agent/);

  assert.match(
    session.state().lastError ?? '',
    /would not compact the session/,
    'the pick that drained behind the refusal overwrote the reason the compaction gave',
  );
  assert.deepEqual(effortSends(child), ['/effort low'], 'the refusal never drained the pick it owed a release to');
  assert.equal(session.state().busy, true, 'the drained pick still owes its own result');
});

test('a busy Claude session accepts another prompt and stays busy through both turns', async () => {
  const { host, children, events } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;

  const firstTurnId = await session.prompt('first');
  const secondTurnId = await session.prompt('second');
  assert.equal(
    children[0].sent().filter((message) => message.type === 'user').length,
    2,
    'the second prompt never reached the busy Claude child',
  );
  children[0].say(
    JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', result: 'first' }) + '\n',
  );
  assert.equal(session.state().busy, true, 'the first result hid the second queued Claude turn');
  assert.equal(events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId, firstTurnId);
  children[0].say(
    JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', result: 'second' }) + '\n',
  );
  assert.equal(session.state().busy, false);
  assert.equal(events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId, secondTurnId);
});

// Claude's session state report, as the CLI writes it with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`.
const sessionState = (state: string) =>
  JSON.stringify({ type: 'system', subtype: 'session_state_changed', state }) + '\n';

async function claudeSessionOpen() {
  const fake = fakeHost();
  const starting = fake.host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = fake.children[0];
  child.answerHandshake();
  return { ...fake, child, session: await starting };
}

function idleReports(events: SessionEvent[]): (readonly number[] | undefined)[] {
  return events.flatMap((entry) =>
    entry.event.kind === 'sessionState' && entry.event.state === 'idle' ? [entry.event.settledTurnIds] : [],
  );
}

test('a prompt that joins a running Claude turn ends when Claude reports idle', async () => {
  const { child, session, events } = await claudeSessionOpen();
  const firstTurnId = await session.prompt('first');
  child.say(sessionState('running'));
  const joinedTurnId = await session.prompt('joined');
  void session.setEffort('low');
  child.say(COMPLETED_RESULT);
  assert.equal(events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId, firstTurnId);
  assert.equal(session.state().busy, true, 'the session read idle before Claude said so');
  assert.deepEqual(effortSends(child), [], 'the held pick went out before Claude finished');

  child.say(sessionState('idle'));
  assert.deepEqual(idleReports(events), [[joinedTurnId]], 'the idle report did not name the joined prompt it ended');
  assert.deepEqual(effortSends(child), ['/effort low'], 'the held pick never went out once the session was idle');
  await tick();
  child.say(COMPLETED_RESULT);
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false, 'the joined prompt kept the session busy after Claude went idle');
  assert.deepEqual(idleReports(events).at(-1), [], 'a repeated idle report ended a turn again');

  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  assert.deepEqual(await stopping, [], 'Stop still names a joined prompt the idle report ended');
  await session.compact();
  assert.equal(sentTexts(child).at(-1), '/compact');
  assert.equal(session.state().busy, true);
  child.say(sessionState('running'));
  child.say(COMPLETED_RESULT);
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false);
});

test('a turn Claude starts by itself keeps the session busy until Claude reports idle', async () => {
  const { child, session } = await claudeSessionOpen();
  child.say(sessionState('running'));
  assert.equal(session.state().busy, true, 'a background task notification turn read as idle');
  child.say(COMPLETED_RESULT);
  assert.equal(session.state().busy, true);
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false);
});

test('a Claude idle report leaves a prompt that is still being prepared open', async () => {
  let accept: (() => void) | undefined;
  let emit: ((event: WireEvent) => void) | undefined;
  const plan: AgentPlan = {
    agent: 'claude',
    sessionId: 'session',
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: (_send, emitted) => {
      emit = emitted;
      return {
        receive: () => undefined,
        open: () => Promise.resolve([]),
        prompt: () =>
          new Promise<void>((resolve) => {
            accept = resolve;
          }),
        compact: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        answer: () => false,
        interrupt: () => Promise.resolve(),
        sessionId: () => 'session',
        close: () => undefined,
        interruptClearsOpenTurns: true,
      };
    },
  };
  const child = new FakeChild();
  const reported: Array<{ event: WireEvent; turnId?: number }> = [];
  const session = new AgentSession(
    'preparing-idle',
    plan,
    () => child,
    (event, turnId) => reported.push({ event, turnId }),
    () => undefined,
  );
  await session.start();
  const prompt = session.prompt('attachment prompt');
  emit?.({ kind: 'sessionState', state: 'idle' });
  assert.equal(session.state().busy, true, 'an idle report for earlier work ended a prompt still being prepared');
  accept?.();
  await prompt;
  assert.equal(session.state().busy, true);
  emit?.({ kind: 'sessionState', state: 'idle' });
  assert.equal(session.state().busy, true, 'an idle report written before the CLI took the prompt ended it');
  assert.deepEqual(
    reported.map((entry) => entry.event),
    [
      { kind: 'sessionState', state: 'idle', settledTurnIds: [] },
      { kind: 'sessionState', state: 'idle', settledTurnIds: [] },
    ],
  );
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

test('a prompt that reaches Claude between its result and its idle report keeps its own turn', async () => {
  const { child, session, events } = await claudeSessionOpen();
  const delta = (text: string) =>
    child.say(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      }) + '\n',
    );
  const lastTurn = (kind: string) => events.filter((entry) => entry.event.kind === kind).at(-1)?.turnId;
  await session.prompt('first');
  child.say(sessionState('running'));
  child.say(COMPLETED_RESULT);
  const newer = await session.prompt('newer');
  // The idle report for the first prompt was already on its way when the newer prompt went out.
  child.say(sessionState('idle'));
  assert.deepEqual(idleReports(events), [[]], 'the idle report for the first prompt settled the newer one');
  assert.equal(session.state().busy, true, 'the newer prompt read idle before Claude took it');
  child.say(sessionState('running'));
  delta('Newer');
  assert.equal(lastTurn('delta'), newer, 'the newer reply streamed to no turn');
  child.say(COMPLETED_RESULT);
  assert.equal(lastTurn('turnEnd'), newer, 'the newer prompt never got its own ending');
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false);

  await session.prompt('third');
  child.say(sessionState('running'));
  child.say(COMPLETED_RESULT);
  const late = await session.prompt('late');
  child.say(sessionState('idle'));
  child.say(sessionState('running'));
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  assert.deepEqual(await stopping, [late], 'Stop did not name the prompt it stopped');
});

test('a Claude effort pick held across an accepted Stop keeps its own turn', async () => {
  const endings = (events: SessionEvent[]) =>
    events.filter((entry) => entry.event.kind === 'turnEnd').map((entry) => entry.turnId);
  const holdAndStop = async () => {
    const opened = await claudeSessionOpen();
    await opened.session.prompt('first');
    opened.child.say(sessionState('running'));
    void opened.session.setEffort('low');
    const stopping = opened.session.interrupt();
    opened.child.answerControl('interrupt', {});
    await stopping;
    assert.deepEqual(effortSends(opened.child), ['/effort low'], 'the held pick did not go out once Stop was accepted');
    await tick();
    return opened;
  };

  // Claude takes the effort command after the aborted result, and reports idle only after the command's result.
  const queued = await holdAndStop();
  queued.child.say(ABORTED_TOOLS_RESULT);
  assert.equal(queued.session.state().busy, true, 'the Stop ending was taken for the effort command');
  queued.child.say(COMPLETED_RESULT);
  queued.child.say(sessionState('idle'));
  const [stopped, effort] = endings(queued.events);
  assert.equal(stopped, undefined, 'the Stop ending was taken for the effort command');
  assert.notEqual(effort, undefined, 'the effort command never got its own ending');
  assert.deepEqual(idleReports(queued.events), [[]]);
  assert.equal(queued.session.state().busy, false);

  // Claude wrote the aborted result and its idle report before it read the effort command.
  const early = await holdAndStop();
  early.child.say(ABORTED_RESULT);
  early.child.say(sessionState('idle'));
  assert.deepEqual(idleReports(early.events), [[]], 'the idle report for the stopped work settled the effort command');
  assert.equal(early.session.state().busy, true, 'the session read idle while the effort command was on its way');
  const compaction = await early.session.compact();
  early.child.say(sessionState('running'));
  early.child.say(COMPLETED_RESULT);
  early.child.say(COMPLETED_RESULT);
  assert.equal(endings(early.events).at(-1), compaction, 'the effort result was taken for the compaction');
  early.child.say(sessionState('idle'));
  assert.equal(early.session.state().busy, false);
});

const turnEnds = (events: SessionEvent[]) =>
  events.filter((entry) => entry.event.kind === 'turnEnd').map((entry) => entry.turnId);

// A task notification starts a Claude turn with no open turn behind it. The reader stops it.
async function stopNotificationTurn(opened: Awaited<ReturnType<typeof claudeSessionOpen>>) {
  const stopping = opened.session.interrupt();
  opened.child.answerControl('interrupt', {});
  assert.deepEqual(await stopping, [], 'Stop named a turn the reader never sent');
}

test('an effort pick held through a Stop of a turn Claude started by itself keeps its own turn', async () => {
  const held = await claudeSessionOpen();
  held.child.say(sessionState('running'));
  void held.session.setEffort('low');
  assert.deepEqual(effortSends(held.child), [], 'the pick went out while the notification turn ran');
  await stopNotificationTurn(held);
  assert.deepEqual(effortSends(held.child), ['/effort low'], 'the held pick did not go out once Stop was accepted');
  await tick();
  held.child.say(ABORTED_RESULT);
  assert.equal(
    held.session.state().busy,
    true,
    'the aborted notification turn ended the effort command, so a queued compaction would go out early',
  );
  held.child.say(COMPLETED_RESULT);
  const [stopped, effort] = turnEnds(held.events);
  assert.equal(stopped, undefined, 'the Stop ending was taken for the effort command');
  assert.notEqual(effort, undefined, 'the effort command never got its own ending');
  held.child.say(sessionState('idle'));
  assert.equal(held.session.state().busy, false);
});

test('a prompt sent after a Stop of a turn Claude started by itself keeps its reply and its ending', async () => {
  const plain = await claudeSessionOpen();
  plain.child.say(sessionState('running'));
  await stopNotificationTurn(plain);
  const after = await plain.session.prompt('after stop');
  plain.child.say(ABORTED_RESULT);
  assert.equal(plain.session.state().busy, true, 'the aborted notification turn ended a prompt sent after the Stop');
  plain.child.say(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'After' } },
    }) + '\n',
  );
  assert.equal(
    plain.events.filter((entry) => entry.event.kind === 'delta').at(-1)?.turnId,
    after,
    'the reply to a prompt sent after the Stop streamed to no turn',
  );
  plain.child.say(COMPLETED_RESULT);
  assert.equal(turnEnds(plain.events).at(-1), after, 'the prompt sent after the Stop never got its own ending');
  plain.child.say(sessionState('idle'));
  assert.equal(plain.session.state().busy, false);
});

test('Claude Stop, accepted or refused, settles joined prompts with the idle report after it', async () => {
  const accepted = await claudeSessionOpen();
  await accepted.session.prompt('first');
  accepted.child.say(sessionState('running'));
  await accepted.session.prompt('joined');
  const stopping = accepted.session.interrupt();
  accepted.child.answerControl('interrupt', {});
  await stopping;
  assert.equal(accepted.session.state().busy, false, 'an accepted Stop waited for the CLI to say it was idle');
  accepted.child.say(ABORTED_RESULT);
  accepted.child.say(sessionState('idle'));
  const after = await accepted.session.prompt('after stop');
  accepted.child.say(sessionState('running'));
  accepted.child.say(ABORTED_RESULT);
  assert.equal(
    accepted.events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId,
    after,
    'the ending the idle report settled was owed again to a prompt sent after it',
  );
  accepted.child.say(sessionState('idle'));
  assert.equal(accepted.session.state().busy, false);

  const refused = await claudeSessionOpen();
  await refused.session.prompt('first');
  refused.child.say(sessionState('running'));
  await refused.session.prompt('joined');
  const refusing = refused.session.interrupt();
  refused.child.rejectControl('interrupt', 'not now');
  await assert.rejects(refusing, /not now/);
  assert.equal(refused.session.state().busy, true, 'a refused Stop cleared work that is still running');
  refused.child.say(
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failed' }) + '\n',
  );
  assert.equal(refused.session.state().busy, true);
  refused.child.say(sessionState('idle'));
  assert.equal(refused.session.state().busy, false, 'a turn that ended in an error kept its joined prompt busy');
});

test('a Claude child that exits while running leaves a restarted session idle', async () => {
  const { host, children, child, session } = await claudeSessionOpen();
  await session.prompt('first');
  child.say(sessionState('running'));
  await session.prompt('joined');
  child.exit(1);
  assert.equal(session.state().busy, false);
  const restarting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[1].answerHandshake();
  const restarted = await restarting;
  assert.notEqual(restarted, session);
  assert.equal(restarted.state().busy, false);
  children[1].say(sessionState('idle'));
  assert.equal(restarted.state().busy, false);
});

test('a Claude clear and a failed compaction after joined prompts end with the idle report', async () => {
  const { child, session } = await claudeSessionOpen();
  await session.prompt('first');
  child.say(sessionState('running'));
  await session.prompt('joined');
  await session.clear();
  child.say(COMPLETED_RESULT);
  child.say(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'successor' }) + '\n');
  child.say(COMPLETED_RESULT);
  assert.equal(session.state().busy, true, 'the clear ending was taken for the joined prompt');
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false, 'the session replaced by clear stayed busy');
  assert.equal(session.state().sessionId, 'successor');

  await session.compact();
  child.say(sessionState('running'));
  child.say(
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'too short' }) + '\n',
  );
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false, 'a failed compaction left the session busy');
});

test('Claude turn identity follows wire acceptance when a later prompt is accepted first', async () => {
  const accepts: (() => void)[] = [];
  let emit: (event: WireEvent) => void = () => undefined;
  const plan: AgentPlan = {
    agent: 'claude',
    sessionId: 'session',
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: (_send, report) => {
      emit = report;
      return {
        receive: () => undefined,
        open: () => Promise.resolve([]),
        prompt: () => new Promise<void>((resolve) => accepts.push(resolve)),
        compact: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        answer: () => false,
        interrupt: () => Promise.resolve(),
        sessionId: () => 'session',
        close: () => undefined,
      };
    },
  };
  const ended: number[] = [];
  const child = new FakeChild();
  const session = new AgentSession(
    'ordered',
    plan,
    () => child,
    (event, turnId) => {
      if (event.kind === 'turnEnd' && turnId !== undefined) {
        ended.push(turnId);
      }
    },
    () => undefined,
  );
  await session.start();

  const first = session.prompt('attachment prompt');
  const second = session.prompt('text prompt');
  accepts[1]();
  const secondTurnId = await second;
  emit({
    kind: 'turnEnd',
    outcome: {
      status: 'ok',
      text: '',
      costUsd: null,
      turns: null,
      deniedTools: [],
    },
  });
  assert.deepEqual(ended, [secondTurnId]);
  assert.equal(session.state().busy, true, 'the earlier prompt is still preparing');

  accepts[0]();
  const firstTurnId = await first;
  emit({
    kind: 'turnEnd',
    outcome: {
      status: 'ok',
      text: '',
      costUsd: null,
      turns: null,
      deniedTools: [],
    },
  });
  assert.deepEqual(ended, [secondTurnId, firstTurnId]);
  assert.equal(session.state().busy, false);
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

test('stopping Claude clears prompts canceled from its queue', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('first');
  await session.prompt('second');
  const stopping = session.interrupt();
  const interrupt = child.sent().find((message) => (message.request as { subtype?: string })?.subtype === 'interrupt');
  assert.deepEqual(interrupt?.request, { subtype: 'interrupt', cancel_queued: true });
  child.answerControl('interrupt', {});
  await stopping;

  assert.equal(
    session.state().busy,
    false,
    'prompts canceled without their own result left the session permanently busy',
  );
  child.say(ABORTED_RESULT);
  assert.equal(session.state().busy, false, 'the active prompt ending reopened a cleared queue');
});

test('stopping Claude keeps a preparing prompt from becoming an open turn afterward', async () => {
  let accept: (() => void) | undefined;
  const plan: AgentPlan = {
    agent: 'claude',
    sessionId: 'session',
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: () => ({
      receive: () => undefined,
      open: () => Promise.resolve([]),
      prompt: () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
      compact: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      answer: () => false,
      interrupt: () => Promise.resolve(),
      sessionId: () => 'session',
      close: () => undefined,
      interruptClearsOpenTurns: true,
    }),
  };
  const child = new FakeChild();
  const session = new AgentSession(
    'preparing-stop',
    plan,
    () => child,
    () => undefined,
    () => undefined,
  );
  await session.start();

  const prompt = session.prompt('attachment prompt');
  const refused = assert.rejects(prompt, /stopped before it reached the agent/);
  assert.equal(session.state().busy, true);
  await session.interrupt();
  assert.equal(session.state().busy, false);
  accept?.();
  await refused;
  assert.equal(session.state().busy, false, 'the canceled preparation reopened the turn');
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

test('a late ending from Claude Stop does not clear a prompt sent afterward', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('first');
  await session.prompt('second');
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  await stopping;
  await session.prompt('after stop');
  assert.equal(session.state().busy, true);

  child.say(ABORTED_RESULT);
  assert.equal(session.state().busy, true, 'the interrupted prompt ending consumed the prompt sent after Stop');
  child.say(
    JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }) + '\n',
  );
  assert.equal(session.state().busy, false);
});

test('accepted response ownership survives Stop and a late interrupted ending', async () => {
  const { host, children, events } = fakeHost();
  const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await opening;
  const first = await session.prompt('first');
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  assert.deepEqual(await stopping, [first]);
  const second = await session.prompt('second');
  const delta = (text: string) =>
    child.say(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      }) + String.fromCharCode(10),
    );
  delta('Second');
  child.say(ABORTED_RESULT);
  delta(' continues');
  assert.deepEqual(
    events.filter(({ event }) => event.kind === 'delta').map(({ turnId }) => turnId),
    [second, second],
  );
  assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').at(-1)?.turnId, undefined);
  assert.equal(session.state().busy, true);
});

test('the extension forwards stopped dispatch ownership separately from panel ownership', () => {
  const activate = declarationSource(fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8'), 'activate');
  const host = statementFrom(activate, activate.indexOf('const host = new AgentHost('));
  sourceMatch(
    host,
    /onEvent: \(\{ key, event, turnId, dispatchTurnId \}\) => \{\s*panel\.onDispatchEvent\?\.\(key, event, dispatchTurnId \?\? turnId\);/,
    'the stopped dispatch owner must reach the panel dispatch observer',
  );
});

test.each(['none', 'later', 'expired', 'idle', 'failed'] as const)(
  'Claude Stop retains dispatch ownership: %s',
  async (mode) => {
    const later = mode !== 'none';
    let clock = 1000;
    const home = tempDir('arc-stopped-dispatch-');
    const origin = 'a'.repeat(24);
    const nativeSession = 'aaaaaaaa-1111-2222-3333-444444444444';
    const receipts = new DispatchReceipts(home);
    const launch = receipts.reserve({
      origin,
      requester: null,
      policy: null,
      promptSha256: payloadSha256('review'),
      completion: 'wait',
      alias: null,
    });
    let saved: SavedDispatchResponse | null = null;
    const dispatch = new HostedDispatch(receipts, () => saved);
    const { host, children, events } = fakeHost(undefined, () => clock, {
      onEvent: ({ key, event, turnId, dispatchTurnId }) => {
        const child = host.get(key);
        if (child) dispatch.observe(child, event, dispatchTurnId ?? turnId);
      },
    });
    const abort = new AbortController();
    try {
      const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: nativeSession }));
      const child = children[0];
      child.answerHandshake();
      const session = await opening;
      dispatch.register(launch.launchId, session);
      const first = await session.prompt('review', (id) => dispatch.submitted(launch.launchId, id));
      dispatch.accepted(launch.launchId, session.nativeTurnIdentity(first));
      child.say(
        JSON.stringify({
          type: 'assistant',
          session_id: nativeSession,
          message: {
            id: 'response-first',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Partial' }],
          },
        }) + '\n',
      );
      const stopping = session.interrupt();
      child.answerControl('interrupt', {});
      await stopping;
      assert.equal(receipts.latest(launch.launchId), null, 'Stop acceptance is not a native ending');
      if (mode === 'expired') clock += STOP_ENDING_GRACE_MS + 1;
      if (mode === 'idle')
        child.say(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }) + '\n');
      const second = later ? await session.prompt('second') : undefined;
      if (mode === 'failed') {
        child.say(
          JSON.stringify({
            type: 'result',
            session_id: nativeSession,
            uuid: 'later-failed-result',
            result_index: 1,
            num_turns: 1,
            parent_tool_use_id: null,
            is_error: true,
            terminal_reason: 'error',
            result: '',
          }) + '\n',
        );
        assert.equal(
          receipts.latest(launch.launchId),
          null,
          'an unrelated later failure cannot end the stopped dispatch',
        );
        assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').at(-1)?.turnId, second);
        assert.equal(session.state().busy, false);
        return;
      }
      const waiting = dispatch.request(
        origin,
        { dispatchAction: 'wait', launchId: launch.launchId, deadlineMs: 1000 },
        abort.signal,
      );
      child.say(
        JSON.stringify({
          ...JSON.parse(ABORTED_RESULT),
          session_id: nativeSession,
          uuid: 'stopped-result',
          result_index: 1,
          num_turns: 1,
          parent_tool_use_id: null,
        }) + '\n',
      );
      const interrupted = receipts.latest(launch.launchId);
      if (mode === 'expired' || mode === 'idle') {
        assert.equal(interrupted, null, 'expired or settled Stop ownership cannot be reused');
        assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').at(-1)?.turnId, second);
        assert.equal(session.state().busy, false);
        return;
      }
      assert.ok(interrupted, 'the actual Claude producer must publish the stopped dispatch ending');
      assert.equal(interrupted.outcome, 'interrupted');
      assert.equal(
        interrupted.availability,
        'pending',
        'native interruption does not establish saved report availability',
      );
      assert.equal((interrupted.nativeEnding as { generation: number } | null)?.generation, 1);
      assert.equal(session.state().busy, later);
      const nativeEnding = events
        .filter(({ event }) => event.kind === 'native' && event.event.kind === 'rootEnd')
        .at(-1);
      assert.equal(nativeEnding?.turnId, undefined, 'the stopped native ending must not own the later panel turn');
      assert.equal(nativeEnding?.dispatchTurnId, first, 'the stopped native ending must retain its dispatch owner');
      assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').at(-1)?.turnId, undefined);
      saved = {
        text: 'Partial',
        prompt: 'review',
        promptId: 'prompt-first',
        responseIds: ['response-first'],
        finished: false,
        failed: false,
        interrupted: true,
      };
      dispatch.reconcileAll();
      assert.deepEqual(await waiting, {
        launchId: launch.launchId,
        state: 'observed',
        eventId: receipts.latest(launch.launchId)!.eventId,
        outcome: 'interrupted',
      });
      if (later) {
        child.say(
          JSON.stringify({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Second' } },
          }) + '\n',
        );
        assert.equal(events.filter(({ event }) => event.kind === 'delta').at(-1)?.turnId, second);
        child.say(COMPLETED_RESULT);
        assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').at(-1)?.turnId, second);
        assert.equal(session.state().busy, false);
        assert.equal(receipts.latest(launch.launchId)!.outcome, 'interrupted');
      }
    } finally {
      abort.abort();
      host.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test.each(['live', 'settled', 'reader-acted'] as const)(
  'Codex rejected prompt drains an early native command with %s evidence in arrival order',
  async (mode) => {
    const h = compactionThroughHost();
    let emit!: (event: WireEvent) => void;
    let reject!: (error: Error) => void;
    let accept!: (turn: string) => void;
    const plan: AgentPlan = {
      agent: 'codex',
      sessionId: 'session',
      command: 'c',
      args: [],
      cwd: WS,
      env: {},
      driver: (_send, report) => {
        emit = report;
        return {
          receive() {},
          open: async () => [],
          prompt: () =>
            new Promise<string>((resolve, refuse) => {
              accept = resolve;
              reject = refuse;
            }),
          compact: async () => {},
          clear: async () => {},
          answer: () => false,
          interrupt: async () => {},
          sessionId: () => 'session',
          close() {},
          hasOpenTurns: () => false,
        };
      },
    };
    const session = await h.host.session('deferred-native', plan);
    h.setCurrent(session);
    onTestFinished(() => {
      h.compaction.dispose();
      h.children[0].exit(0);
    });
    const pending = session.prompt('Competing input.');
    const refused = assert.rejects(pending, /competing start refused/);
    const native = {
      provider: 'codex' as const,
      sessionId: 'session',
      turnId: 'native-command',
      generation: null,
      evidence: {},
    };
    emit({
      kind: 'native',
      event: {
        ...native,
        kind: 'toolStart',
        toolId: 'request-call',
        initiating: true,
        command: `arc compact request --self --after-turn --request-id ${h.window}:${h.ids[0]} --window ${h.window} --json`,
      },
    });
    const end = () => {
      emit({ kind: 'native', event: { ...native, kind: 'toolEnd', toolId: 'request-call', success: true } });
      emit({ kind: 'text', nativeTurnId: native.turnId, sourceId: 'native-final', text: 'Saved.' });
      emit({ kind: 'native', event: { ...native, kind: 'rootEnd', success: true } });
    };
    if (mode === 'settled') end();
    if (mode === 'reader-acted') h.compaction.readerAction('session');
    reject(new Error('competing start refused'));
    await refused;
    assert.equal(h.owners.length, 1, 'rejection resolves the native owner without another prompt');
    const request = h.payload(h.ids[0]);
    const admitted = h.compaction.handle({ method: 'compact-request', params: request }) as { state: string };
    assert.equal(admitted.state, mode === 'live' ? 'queued' : 'refused');
    if (mode === 'live') end();
    h.replies.settle(
      'session',
      [{ promptId: native.turnId, finalResponse: { sourceId: 'native-final', text: 'Saved.' } }],
      'codex',
    );
    assert.equal(h.compaction.requests.deliverable('session').length, mode === 'live' ? 1 : 0);
    h.compaction.readerAction('session');
    const next = session.prompt('New directing input.');
    accept('reader-next');
    await next;
    assert.equal(h.owners.length, 1, 'a later accepted start never replays a settled command');
    assert.equal(h.compaction.requests.deliverable('session').length, 0);
  },
);

test('Codex native turn identity binds early and obsolete response events to accepted submissions', async () => {
  let emit!: (event: WireEvent) => void;
  let accept!: (id: string) => void;
  const plan: AgentPlan = {
    agent: 'codex',
    sessionId: 'session',
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: (_send, report) => {
      emit = report;
      return {
        receive: () => undefined,
        open: () => Promise.resolve([]),
        prompt: () =>
          new Promise<string>((resolve) => {
            accept = resolve;
          }),
        compact: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        answer: () => false,
        interrupt: () => Promise.resolve(),
        sessionId: () => 'session',
        close: () => undefined,
        hasOpenTurns: () => true,
      };
    },
  };
  const child = new FakeChild();
  const reported: Array<{ event: WireEvent; turnId?: number }> = [];
  const session = new AgentSession(
    'native-owned',
    plan,
    () => child,
    (event, turnId) => reported.push({ event, turnId }),
    () => undefined,
  );
  await session.start();
  let submitted: number | undefined;
  const pending = session.prompt('first', (turnId) => {
    submitted = turnId;
  });
  assert.equal(typeof submitted, 'number');
  emit({ kind: 'text', text: 'Early completed response', sourceId: 'first-response', nativeTurnId: 'native-first' });
  // A root tool can start before the turn start answer names the turn.
  emit({
    kind: 'native',
    event: {
      provider: 'codex',
      sessionId: 'session',
      turnId: 'native-first',
      generation: null,
      evidence: {},
      kind: 'toolStart',
      toolId: 'call',
      command: 'arc',
      initiating: true,
    },
  });
  accept('native-first');
  const first = await pending;
  assert.equal(submitted, first);
  assert.equal(reported.at(-1)?.turnId, first);
  assert.equal(reported.find(({ event }) => event.kind === 'native')?.turnId, first);
  const next = session.prompt('second');
  emit({
    kind: 'native',
    event: {
      provider: 'codex',
      sessionId: 'session',
      turnId: 'early-notice',
      generation: null,
      evidence: {},
      kind: 'toolStart',
      toolId: 'notice-call',
      command: 'arc',
      initiating: true,
    },
  });
  accept('native-second');
  const second = await next;
  const notice = reported.find(({ event }) => event.kind === 'native' && event.event.turnId === 'early-notice');
  assert.equal(typeof notice?.turnId, 'number');
  assert.notEqual(notice!.turnId, second);
  assert.equal(
    session.startedByAgent(notice!.turnId!),
    true,
    'an early unrelated native turn retains its own response owner',
  );
  emit({ kind: 'delta', text: 'Second', nativeTurnId: 'native-second' });
  emit({
    kind: 'turnEnd',
    outcome: { status: 'interrupted', text: '', costUsd: null, turns: null, deniedTools: [] },
    nativeTurnId: 'native-first',
  });
  emit({ kind: 'text', text: 'Late first response', sourceId: 'first-response', nativeTurnId: 'native-first' });
  emit({ kind: 'delta', text: ' continues', nativeTurnId: 'native-second' });
  assert.deepEqual(
    reported.slice(-4).map(({ turnId }) => turnId),
    [second, first, first, second],
  );
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

// Preparation cannot grant ownership. Joined submissions retain the first live turn's owner.
test('Claude native events follow the shared owner after prompt preparation ends', async () => {
  let emit!: (event: WireEvent) => void;
  let accept!: () => void;
  let received: (() => void) | undefined;
  const plan: AgentPlan = {
    agent: 'claude',
    sessionId: 'session',
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: (_send, report) => {
      emit = report;
      return {
        receive: () => undefined,
        open: () => Promise.resolve([]),
        prompt: (_input, _guard, onReceived) =>
          new Promise<void>((resolve) => {
            accept = resolve;
            received = onReceived;
          }),
        compact: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        answer: () => false,
        interrupt: () => Promise.resolve(),
        sessionId: () => 'session',
        close: () => undefined,
      };
    },
  };
  const child = new FakeChild();
  const reported: Array<{ event: WireEvent; turnId?: number }> = [];
  const session = new AgentSession(
    'claude-native',
    plan,
    () => child,
    (event, turnId) => reported.push({ event, turnId }),
    () => undefined,
  );
  await session.start();
  const native: WireEvent = {
    kind: 'native',
    event: {
      provider: 'claude',
      sessionId: 'session',
      turnId: null,
      generation: 1,
      evidence: {},
      kind: 'toolStart',
      toolId: 'call',
      command: 'arc',
      initiating: true,
    },
  };
  const receiptOwners: (number | undefined)[] = [];
  const opening = session.prompt('first', undefined, undefined, (id) =>
    receiptOwners.push(session.readerTurnOwner(id)),
  );
  received!();
  accept();
  const first = await opening;
  assert.deepEqual(receiptOwners, [first]);
  emit(native);
  assert.equal(reported.at(-1)?.turnId, first);
  const joining = session.prompt('second', undefined, undefined, (id) =>
    receiptOwners.push(session.readerTurnOwner(id)),
  );
  received!();
  assert.deepEqual(receiptOwners, [first, first]);
  emit(native);
  assert.equal(reported.at(-1)?.turnId, undefined, 'a preparing prompt leaves the owner unknown');
  accept();
  await joining;
  emit(native);
  assert.equal(reported.at(-1)?.turnId, first, 'joined prompts share the first live owner');
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

test('a shared guarded Codex receipt leaves the native turn with the reader submission that owns it', async () => {
  let emit!: (event: WireEvent) => void;
  const accepts: ((id: string) => void)[] = [];
  const guards: (GuardedAttempt | undefined)[] = [];
  const plan: AgentPlan = {
    agent: 'codex',
    sessionId: 'session',
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: (_send, report) => {
      emit = report;
      return {
        receive: () => undefined,
        open: () => Promise.resolve([]),
        prompt: (_prompt, guard) =>
          new Promise<string>((resolve) => {
            guard?.markWritten();
            guards.push(guard);
            accepts.push(resolve);
          }),
        compact: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        answer: () => false,
        interrupt: () => Promise.resolve(),
        sessionId: () => 'session',
        close: () => undefined,
        hasOpenTurns: () => true,
      };
    },
  };
  const child = new FakeChild();
  const reported: Array<{ event: WireEvent; turnId?: number }> = [];
  const session = new AgentSession(
    'shared-turn',
    plan,
    () => child,
    (event, turnId) => reported.push({ event, turnId }),
    () => undefined,
  );
  await session.start();
  const reader = session.prompt('reader prompt');
  const guarded = new GuardedAttempt('uuid-shared');
  const delivery = session.prompt('guarded prompt', undefined, guarded);
  await vi.waitFor(() => assert.equal(accepts.length, 2));
  accepts[0]('native-shared');
  const readerTurn = await reader;
  guards[1]!.settle({ outcome: 'unknown', nativeTurnId: 'native-shared', reason: 'Joined.', sharedTurn: true });
  accepts[1]('native-shared');
  const guardedTurn = await delivery;
  assert.notEqual(guardedTurn, readerTurn);
  emit({ kind: 'delta', text: 'Reply', nativeTurnId: 'native-shared' });
  assert.equal(reported.at(-1)?.turnId, readerTurn);
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

test('repeated Claude Stops share the ending still owed by the active turn', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('first');
  await session.prompt('second');
  const firstStop = session.interrupt();
  child.answerControl('interrupt', {});
  await firstStop;
  await session.prompt('third');

  const secondStop = session.interrupt();
  const interrupts = child
    .sent()
    .filter((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'interrupt');
  const secondRequest = interrupts[1];
  child.say(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: secondRequest.request_id, response: {} },
    }) + '\n',
  );
  await secondStop;

  child.say(ABORTED_RESULT);
  await session.prompt('fourth');
  child.say(
    JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }) + '\n',
  );
  assert.equal(session.state().busy, false, 'two Stops charged two endings to the one active turn');
});

test('an ending a Stop never produced stops being owed', async () => {
  // Expire an unanswered Stop ending so it cannot consume a later prompt's completion.

  let clock = 1_000;
  const { host, children } = fakeHost(undefined, () => clock);
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('first');
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  await stopping;
  assert.equal(session.state().busy, false);

  clock += STOP_ENDING_GRACE_MS + 1;
  await session.prompt('second');
  child.say(
    JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }) + '\n',
  );
  assert.equal(
    session.state().busy,
    false,
    'the second prompt paid for a Stop a minute earlier and its own turn stayed open',
  );
});

test('a prompt that finishes seconds after a silent Stop keeps its own ending', async () => {
  // A prompt can complete within the Stop grace period. Its completion reason must distinguish it from the interrupted turn.

  let clock = 1_000;
  const { host, children } = fakeHost(undefined, () => clock);
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('first');
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  await stopping;
  assert.equal(session.state().busy, false);

  clock += 2_000;
  await session.prompt('second');
  child.say(
    JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }) + '\n',
  );
  assert.equal(
    session.state().busy,
    false,
    'the correction paid for a Stop seconds earlier and its own turn stayed open',
  );
});

test('a turn the reader is waiting on is never charged for a silent Stop', async () => {
  // An interrupted result arriving after a new prompt must not complete that prompt's turn.

  let clock = 1_000;
  const { host, children } = fakeHost(undefined, () => clock);
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  const child = children[0];
  child.answerHandshake();
  const session = await starting;

  await session.prompt('first');
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  await stopping;

  clock += 2_000;
  await session.prompt('second');
  clock += 2_000;
  child.say(ABORTED_RESULT);
  assert.equal(session.state().busy, true, 'the abandoned turn ending closed the correction the reader is waiting on');

  child.say(
    JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      result: 'done',
    }) + '\n',
  );
  assert.equal(session.state().busy, false);
});

test('an ask is held on the session until it is answered', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  children[0].say(
    JSON.stringify({
      type: 'control_request',
      request_id: 'ask-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' },
    }) + '\n',
  );
  assert.equal(session.state().asks.length, 1);
  assert.deepEqual(
    host.waiting().map((w) => w.key),
    ['one'],
  );
  assert.equal(session.answer('ask-1', { decision: 'allow' }), true);
  assert.equal(session.state().asks.length, 0);
  assert.deepEqual(host.waiting(), []);
});

test('a child that dies badly leaves its reason on the session', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  children[0].complain('Not logged in.\n');
  children[0].exit(1);
  const state = session.state();
  assert.equal(state.exited, true);
  assert.match(state.lastError ?? '', /code 1/);
  assert.match(state.lastError ?? '', /Not logged in/, 'the CLI said why on stderr, so the panel says it too');
});

test('a child that exits cleanly is not reported as an error', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  children[0].exit(0);
  assert.equal(session.state().lastError, null);
  assert.equal(session.state().exited, true);
});

test('a child that never started says so instead of hanging the handshake', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].fail(new Error('spawn ENOENT'));
  const session = await starting;
  assert.match(session.state().lastError ?? '', /could not start/);
});

test('a failed spawn closes without an exit event and settles disposal', async () => {
  const { host, children } = fakeHost(undefined, undefined, { exitGraceMs: 20 });
  const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].fail(new Error('spawn ENOENT'));
  const session = await opening;
  let disposed = false;
  const disposal = session.dispose().then(() => {
    disposed = true;
  });
  await tick();
  assert.equal(disposed, false, 'an error alone released a child that had not reported terminal closure');
  children[0].close();
  const outcome = await Promise.race([
    disposal.then(() => 'disposed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 10)),
  ]);
  assert.equal(outcome, 'disposed', 'the failed-spawn close left disposal waiting for an exit that never comes');
  assert.equal(disposed, true);
});

test('a busy session stops being busy when its child dies mid-turn', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  await session.prompt('hello');
  children[0].exit(1);
  assert.equal(session.state().busy, false, 'a dead agent shown as working would never clear');
});

test('disposing the host ends every child it started', async () => {
  const { host, children } = fakeHost();
  const a = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  await a;
  const b = host.session('two', claudePlan(CLAUDE, { cwd: WS }));
  children[1].answerHandshake();
  await b;
  host.dispose();
  // Disposal closes child input first and kills only children that remain running. This gives the CLI time to save settings.

  assert.deepEqual(
    children.map((c) => c.ended),
    [true, true],
  );
  assert.deepEqual(host.states(), []);
});

test('archive, idle and targeted retirement react to final background completion without another turn', async () => {
  for (const mode of ['archive', 'idle', 'targeted', 'unarchive']) {
    vi.useFakeTimers();
    const timer = new FakeAgentHostTimer();
    const { host, children } = fakeHost(undefined, Date.now, { timer });
    const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
    children[0].answerHandshake();
    const session = await opening;
    const say = (record: object) =>
      children[0].say(JSON.stringify({ session_id: 'sess-1', parent_tool_use_id: null, ...record }) + '\n');
    await session.prompt('start both tasks');
    say({
      type: 'assistant',
      message: {
        content: [
          null,
          false,
          7,
          'text',
          [],
          { type: 'tool_use', name: 'Bash', id: 'command', input: { command: 'npm test', run_in_background: true } },
          { type: 'tool_use', name: 'Agent', id: 'agent', input: { run_in_background: true } },
        ],
      },
    });
    say({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'task' },
      message: { content: [null, false, 7, 'text', [], { type: 'tool_result', tool_use_id: 'command' }] },
    });
    say({
      type: 'user',
      tool_use_result: { status: 'async_launched', agentId: 'child' },
      message: { content: [null, false, 7, 'text', [], { type: 'tool_result', tool_use_id: 'agent' }] },
    });
    children[0].say(COMPLETED_RESULT);
    settle(host, 'one');
    let retirement: Promise<void> | undefined;
    if (mode === 'targeted') retirement = host.retireSession('one');
    else if (mode !== 'idle') host.setArchived(['sess-1']);
    assert.strictEqual(host.get('one'), session, 'archive closed an idle child whose background tasks still run');
    vi.setSystemTime(Date.now() + 48 * 60 * 60 * 1000);
    host.setIdleDuration(1);
    for (let index = 0; index < timer.tasks.length; index++) timer.fire(index);
    const notice = (tool: string, task: string, status: string, extra: object = {}) =>
      say({
        type: 'user',
        origin: { kind: 'task-notification' },
        message: {
          content: `<task-notification><task-id>${task}</task-id><tool-use-id>${tool}</tool-use-id><status>${status}</status></task-notification>`,
        },
        ...extra,
      });
    notice('command', 'task', 'running');
    notice('command', 'task', 'unknown');
    notice('command', 'unrelated-task', 'completed');
    for (const field of ['status', 'tool-use-id', 'task-id']) {
      for (const extra of [
        `<${field}></${field}>`,
        `<${field}/>`,
        `<${field} value="x"></${field}>`,
        `<${field}>`,
        `</${field}>`,
        `<${field}><nested>x</nested></${field}>`,
      ]) {
        say({
          type: 'user',
          origin: { kind: 'task-notification' },
          message: {
            content: `<task-notification><task-id>task</task-id><tool-use-id>command</tool-use-id><status>completed</status>${extra}</task-notification>`,
          },
        });
        assert.equal(session.state().backgroundPending, true);
      }
    }
    notice('command', 'task', 'completed', { session_id: 'foreign' });
    say({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TaskStop', id: 'stop', input: { task_id: 'task' } }] },
    });
    assert.strictEqual(host.get('one'), session);
    assert.equal(children[0].ended, false);
    await session.prompt('another turn');
    children[0].say(COMPLETED_RESULT);
    settle(host, 'one');
    notice('command', 'task', 'completed');
    assert.strictEqual(host.get('one'), session, 'one task completion released the other task');
    if (mode === 'unarchive') host.setArchived([]);
    notice('agent', 'child', 'completed');
    if (mode === 'unarchive') {
      assert.strictEqual(host.get('one'), session, 'completion ignored unarchive');
      host.setArchived(['sess-1']);
    } else if (mode === 'idle') {
      assert.strictEqual(host.get('one'), session);
      assert.equal(timer.tasks.at(-1)?.delayMs, 1, 'completion did not restart idle retirement');
      timer.fire(timer.tasks.length - 1);
    }
    assert.equal(host.get('one'), null);
    assert.equal(children[0].ended, true);
    children[0].exit(0);
    await retirement;
    vi.useRealTimers();
  }
});

test('unrelated and malformed background completions cannot retire an archived live child', async () => {
  const qualified = '<task-id>actual-task</task-id><tool-use-id>command</tool-use-id><status>completed</status>';
  const invalid = [qualified.replace('actual-task', 'unrelated-task')];
  for (const field of ['status', 'tool-use-id', 'task-id']) {
    invalid.push(
      qualified + `<${field}></${field}>`,
      qualified + `<${field}/>`,
      qualified + `<${field}<nested>>`,
      qualified + `<${field}=broken>`,
      qualified + `<${field} value="x"></${field}>`,
      qualified + `<${field}>`,
      qualified + `</${field}>`,
      qualified.replace(new RegExp(`<${field}>[^<]+</${field}>`), `<${field}><nested>x</nested></${field}>`),
    );
  }
  for (const content of invalid) {
    const { host, children } = fakeHost();
    const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
    children[0].answerHandshake();
    const session = await opening;
    const say = (record: object) =>
      children[0].say(JSON.stringify({ session_id: 'sess-1', parent_tool_use_id: null, ...record }) + '\n');
    await session.prompt('start both tasks');
    say({
      type: 'assistant',
      message: {
        content: ['command', 'second'].map((id) => ({
          type: 'tool_use',
          name: 'Bash',
          id,
          input: { run_in_background: true },
        })),
      },
    });
    say({
      type: 'user',
      tool_use_result: { backgroundTaskId: 'actual-task' },
      message: { content: [null, false, 7, 'text', [], { type: 'tool_result', tool_use_id: 'command' }] },
    });
    children[0].say(COMPLETED_RESULT);
    settle(host, 'one');
    host.setArchived(['sess-1']);
    const notice = (body: string) =>
      say({
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { content: `<task-notification>${body}</task-notification>` },
      });
    notice('<task-id>second-task</task-id><tool-use-id>second</tool-use-id><status>completed</status>');
    notice(content);
    assert.strictEqual(host.get('one'), session, `invalid completion retired the child: ${content}`);
    assert.equal(children[0].ended, false);
    notice(qualified);
    assert.equal(host.get('one'), null);
    assert.equal(children[0].ended, true);
    children[0].exit(0);
  }
});

test('accepted background metadata survives missing later reads and protects a resumed child', async () => {
  const { host, children } = fakeHost();
  host.retainBackgroundWork('claude', 'sess-1', [{ id: 'command', startedAt: 1 }], ['child']);
  const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await opening;
  host.retainBackgroundWork('claude', 'sess-1', [], []);
  host.setArchived(['sess-1']);
  assert.strictEqual(host.get('one'), session);
  assert.equal(children[0].ended, false);
  host.setArchived([]);
  host.dispose();
});

test('a settled idle session retires when its timer fires', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { idleDurationMs: 120, timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  await session.prompt('finish this');
  children[0].say(COMPLETED_RESULT);

  settle(host, 'one');
  assert.equal(timer.tasks.at(-1)?.delayMs, 120);
  timer.fire(timer.tasks.length - 1);
  assert.equal(host.get('one'), null);
  assert.equal(children[0].ended, true);
});

test('an older turn cannot settle a newer turn housekeeping batch', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  await starting;

  let finishAUsage: () => void = () => undefined;
  let finishAMcp: () => void = () => undefined;
  const aUsage = new Promise<void>((resolve) => {
    finishAUsage = resolve;
  });
  const aMcp = new Promise<void>((resolve) => {
    finishAMcp = resolve;
  });
  const a = host.beginHousekeeping('one');
  const aCompletion = Promise.allSettled([aUsage, aMcp]).then(() => host.settled(a));

  let finishBUsage: () => void = () => undefined;
  let finishBMcp: () => void = () => undefined;
  const bUsage = new Promise<void>((resolve) => {
    finishBUsage = resolve;
  });
  const bMcp = new Promise<void>((resolve) => {
    finishBMcp = resolve;
  });
  const b = host.beginHousekeeping('one');
  const bCompletion = Promise.allSettled([bUsage, bMcp]).then(() => host.settled(b));

  finishAUsage();
  finishAMcp();
  await aCompletion;
  assert.equal(timer.activeCount(), 0);
  finishBUsage();
  await tick();
  assert.equal(timer.activeCount(), 0);
  finishBMcp();
  await bCompletion;
  assert.equal(timer.activeCount(), 1);
});

test('canceling prompt selection starts a fresh idle window', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const plan = claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' });
  const starting = host.session('one', plan);
  children[0].answerHandshake();
  const session = await starting;

  let cancelPrompt: () => void = () => undefined;
  const selection = host.withActivity('one', (live) => {
    assert.strictEqual(live, session);
    return new Promise<void>((resolve) => {
      cancelPrompt = resolve;
    });
  });
  assert.equal(timer.tasks[0].cleared, true);
  timer.fire(0, true);
  assert.strictEqual(host.get('one'), session);
  cancelPrompt();
  await selection;
  assert.equal(timer.tasks[1].delayMs, 60_000);
  timer.fire(1);
  assert.equal(host.get('one'), null);
});

test('a pending agent usage read holds the child until both controls settle', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { idleDurationMs: 80, timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;

  const usage = host.withActivity('one', (live) => live.usage());
  timer.fire(0, true);
  assert.strictEqual(host.get('one'), session);
  assert.equal(children[0].ended, false);
  children[0].answerControl('get_usage', { five_hour: { utilization: 1 } });
  children[0].answerControl('get_context_usage', { used_percentage: 10 });
  await usage;
  assert.equal(timer.tasks[1].delayMs, 80);
  timer.fire(1);
  assert.equal(host.get('one'), null);
});

test('archiving during an MCP change keeps every target through the final status read', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const firstOpening = host.session('first', claudePlan(CLAUDE, { cwd: WS, sessionId: 'first-session' }));
  children[0].answerHandshake();
  await firstOpening;
  const secondOpening = host.session('second', claudePlan(CLAUDE, { cwd: WS, sessionId: 'second-session' }));
  children[1].answerHandshake();
  await secondOpening;

  const changing = host.changeMcp(['first', 'second'], [{ serverName: 'docs', enabled: false }]);
  host.setArchived(['first-session', 'second-session']);
  assert.ok(
    children[0]
      .sent()
      .some((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'mcp_toggle'),
  );
  const secondHeld = host.get('second')?.state().sessionId;

  children[0].answerControl('mcp_toggle', {});
  await tick();
  const secondChanged = children[1]
    .sent()
    .some((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'mcp_toggle');
  if (secondChanged) {
    children[1].answerControl('mcp_toggle', {});
  }
  await tick();
  const statusRead = children[0]
    .sent()
    .some((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'mcp_status');
  if (statusRead) {
    children[0].answerControl('mcp_status', { mcpServers: [] });
  }

  const result = await changing;
  assert.equal(
    secondHeld,
    'second-session',
    'archiving retired the later target while the first toggle response was delayed',
  );
  assert.equal(secondChanged, true, 'the later target never received the MCP change');
  assert.equal(statusRead, true, 'retirement skipped the final MCP status read');
  assert.deepEqual(result, { failures: [], servers: [] });
  assert.equal(host.get('first'), null);
  assert.equal(host.get('second'), null);
});

test('a delayed permission target cannot let a later target retire before its control starts', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const firstOpening = host.session('first', claudePlan(CLAUDE, { cwd: WS, sessionId: 'first-session' }));
  children[0].answerHandshake();
  const first = await firstOpening;
  const secondOpening = host.session('second', claudePlan(CLAUDE, { cwd: WS, sessionId: 'second-session' }));
  children[1].answerHandshake();
  const second = await secondOpening;
  let book = {};

  const changing = host.withActivities(['first', 'second'], async (sessions) => {
    await acceptedPermissionMode(
      () => book,
      async (updated) => {
        book = updated;
      },
      [
        { session: 'first-session', accept: () => sessions.get('first')!.setAskMode(CLAUDE_ASK_MODES[2]) },
        { session: 'second-session', accept: () => sessions.get('second')!.setAskMode(CLAUDE_ASK_MODES[2]) },
      ],
      'plan',
    );
    return true;
  });
  timer.fire(1, true);
  assert.strictEqual(
    host.get('second'),
    second,
    'the second child retired while the first child still held the permission request',
  );
  children[0].answerControl('set_permission_mode', {});
  await tick();
  assert.strictEqual(host.get('first'), first);
  assert.ok(
    children[1]
      .sent()
      .some((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'set_permission_mode'),
    'the second permission control never started after the first one completed',
  );
  children[1].answerControl('set_permission_mode', {});
  assert.equal(await changing, true);
  assert.equal(sessionSettings(book, 'first-session').permissionMode, 'plan');
  assert.equal(sessionSettings(book, 'second-session').permissionMode, 'plan');
});

test('a stale timer cannot retire a session that became busy', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  settle(host, 'one');

  await session.prompt('new work');
  timer.fire(timer.tasks.length - 1);
  assert.strictEqual(host.get('one'), session);
  assert.equal(children[0].ended, false);
});

test('an open ask blocks retirement when an idle timer fires', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  settle(host, 'one');
  children[0].say(
    JSON.stringify({
      type: 'control_request',
      request_id: 'ask-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'dir' }, tool_use_id: 'tu1' },
    }) + '\n',
  );

  timer.fire(timer.tasks.length - 1);
  assert.equal(session.state().asks.length, 1);
  assert.strictEqual(host.get('one'), session);
  assert.equal(children[0].ended, false);
});

test('archiving an eligible idle session retires it immediately', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  await starting;

  host.setArchived(['sess-1']);
  assert.equal(host.get('one'), null);
  assert.equal(children[0].ended, true);
  assert.equal(timer.tasks[0].cleared, true);
});

test('a prompt can open an archived session before retirement follows its release', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  host.setArchived(['sess-1']);
  const delivery = host.withSessionActivity('one', claudePlan(CLAUDE, { cwd: WS, resume: 'sess-1' }), (session) =>
    session.prompt('continue'),
  );
  children[0].answerHandshake();
  const turnId = await delivery;
  assert.equal(typeof turnId, 'number');
  assert.strictEqual(
    host.get('one')?.state().sessionId,
    'sess-1',
    'opening retirement removed the child before the prompt acquired its activity lease',
  );
  children[0].say(COMPLETED_RESULT);
  settle(host, 'one');
  assert.equal(host.get('one'), null, 'the archived child stayed open after the prompt and housekeeping released it');
});

test('compaction can open an archived session before retirement follows its release', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  host.setArchived(['sess-1']);
  const delivery = host.withSessionActivity('one', claudePlan(CLAUDE, { cwd: WS, resume: 'sess-1' }), (session) =>
    session.compact(),
  );
  children[0].answerHandshake();
  const turnId = await delivery;
  assert.equal(typeof turnId, 'number');
  assert.strictEqual(
    host.get('one')?.state().sessionId,
    'sess-1',
    'opening retirement removed the child before compaction acquired its activity lease',
  );
  children[0].say(COMPLETED_RESULT);
  settle(host, 'one');
  assert.equal(host.get('one'), null, 'the archived child stayed open after compaction and housekeeping released it');
});

test('an archived busy session retires only after housekeeping settles', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  await session.prompt('finish this');

  host.setArchived(['sess-1']);
  assert.strictEqual(host.get('one'), session);
  children[0].say(COMPLETED_RESULT);
  assert.strictEqual(host.get('one'), session);
  settle(host, 'one');
  assert.equal(host.get('one'), null);
  assert.equal(children[0].ended, true);
});

test('an archived session with an open ask keeps the question and retires only after it is answered', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  settle(host, 'one');
  children[0].say(
    JSON.stringify({
      type: 'control_request',
      request_id: 'ask-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'dir' }, tool_use_id: 'tu1' },
    }) + '\n',
  );

  host.setArchived(['sess-1']);
  assert.strictEqual(host.get('one'), session, 'archive retired a session that waits on a question');
  assert.equal(children[0].ended, false);
  assert.equal(session.state().asks.length, 1);
  assert.equal(session.answer('ask-1', { decision: 'allow' }), true);
  settle(host, 'one');
  assert.equal(host.get('one'), null);
  assert.equal(children[0].ended, true);
});

test('archiving after turn end still waits for its control reads to settle', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  await session.prompt('finish this');
  children[0].say(COMPLETED_RESULT);
  const housekeeping = host.beginHousekeeping('one');

  host.setArchived(['sess-1']);
  assert.strictEqual(host.get('one'), session);
  host.settled(housekeeping);
  assert.equal(host.get('one'), null);
  assert.equal(children[0].ended, true);
});

test('unarchiving cancels deferred archive retirement', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  await session.prompt('finish this');
  host.setArchived(['sess-1']);

  host.setArchived([]);
  children[0].say(COMPLETED_RESULT);
  settle(host, 'one');
  assert.strictEqual(host.get('one'), session);
  assert.equal(children[0].ended, false);
  assert.equal(timer.activeCount(), 1);
});

test('retirement removes the host entry and disposes its child once', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  await starting;

  timer.fire(0);
  timer.fire(0, true);
  host.dispose();
  assert.deepEqual(host.states(), []);
  assert.equal(children[0].endCalls, 1);
});

test('a prompt after retirement starts one child with the stored resume identifier', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children, commands } = fakeHost(undefined, undefined, { timer });
  const firstStart = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const first = await firstStart;
  const stored = first.state().sessionId;
  assert.equal(stored, 'sess-1');
  timer.fire(0);

  const resumed = host.session('one', claudePlan(CLAUDE, { cwd: WS, resume: stored ?? undefined }));
  assert.equal(children.length, 1);
  children[0].exit(0);
  await tick();
  assert.equal(children.length, 2);
  assert.equal(commands[1][commands[1].indexOf('--resume') + 1], 'sess-1');
  children[1].answerHandshake();
  await resumed;
  assert.equal(children.length, 2);
});

test('a permission accepted while replacement waits for shutdown reaches the new child', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children, commands } = fakeHost(undefined, undefined, { timer });
  const first = host.session(
    'fresh',
    claudePlan(CLAUDE, {
      cwd: WS,
      sessionId: 'sess-1',
      permissionMode: 'acceptEdits',
    }),
  );
  children[0].answerHandshake();
  await first;
  timer.fire(0);

  let permissionMode: PermissionMode = 'acceptEdits';
  const delivery = host.withSessionActivity(
    'existing',
    () => claudePlan(CLAUDE, { cwd: WS, resume: 'sess-1', permissionMode }),
    (session) => session.prompt('continue'),
  );
  assert.equal(children.length, 1);
  permissionMode = 'plan';
  children[0].exit(0);
  await tick();

  const launchedMode = commands[1][commands[1].indexOf('--permission-mode') + 1];
  children[1].answerHandshake();
  assert.equal(typeof (await delivery), 'number');
  assert.equal(launchedMode, 'plan', 'the replacement launched with the permission captured before shutdown');
});

test('a retired Claude session resumes with its accepted draft setup', async () => {
  const profile: SessionProfile = {
    agent: 'claude',
    model: 'sonnet',
    effort: 'low',
    permissionMode: 'plan',
    source: 'custom',
  };
  const accepted = sessionSettings(
    withSessionSettings({}, 'sess-plan', sessionSettingsForProfile(profile)),
    'sess-plan',
  );
  const timer = new FakeAgentHostTimer();
  const { host, children, commands } = fakeHost(undefined, undefined, { timer });
  const first = host.session(
    'fresh',
    claudePlan(CLAUDE, {
      cwd: WS,
      sessionId: 'sess-plan',
      permissionMode: claudeAskMode(askMode('claude', profile.permissionMode)),
      model: profile.model,
      effort: profile.effort,
    }),
  );
  children[0].answerHandshake();
  await first;
  timer.fire(0);

  const replacement = host.session(
    'existing',
    claudePlan(CLAUDE, {
      cwd: WS,
      resume: 'sess-plan',
      permissionMode: claudeAskMode(askMode('claude', accepted.permissionMode) ?? defaultAskMode('claude')),
      model: accepted.selectedModel,
      effort: accepted.selectedEffort,
    }),
  );
  children[0].exit(0);
  await tick();
  children[1].answerHandshake();
  await replacement;

  const launchSettings = (args: string[]) =>
    Object.fromEntries(
      ['--model', '--effort', '--permission-mode'].map((flag) => [flag, args[args.indexOf(flag) + 1]]),
    );
  assert.deepEqual(launchSettings(commands[1]), launchSettings(commands[0]));
  assert.deepEqual(launchSettings(commands[1]), {
    '--model': 'sonnet',
    '--effort': 'low',
    '--permission-mode': 'plan',
  });
});

test('a resumed Codex writer waits for the retired fresh-key child to exit', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const firstStart = host.session(
    freshHostKey('codex', 'draft-1'),
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
    }),
  );
  await answerCodexHandshake(children[0]);
  children[0].reply({ thread: { id: 'thread-7' } });
  await firstStart;
  timer.fire(0);

  const resumed = host.session(
    existingHostKey('codex', 'thread-7'),
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      resume: 'thread-7',
    }),
  );
  assert.equal(children.length, 1);
  children[0].exit(0);
  await tick();
  assert.equal(children.length, 2);
  await answerCodexHandshake(children[1]);
  children[1].reply({ thread: { id: 'thread-7' } });
  await resumed;
});

test('a retired Codex session resumes with its accepted draft setup', async () => {
  const profile: SessionProfile = {
    agent: 'codex',
    model: 'gpt-5-codex',
    effort: 'xhigh',
    permissionMode: 'untrusted',
    source: 'custom',
  };
  const accepted = sessionSettings(withSessionSettings({}, 'thread-7', sessionSettingsForProfile(profile)), 'thread-7');
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const pickedMode = askMode('codex', profile.permissionMode);
  assert.ok(pickedMode);
  const firstMode = codexAskMode(pickedMode);
  const first = host.session(
    freshHostKey('codex', 'draft-1'),
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      ...firstMode,
      model: profile.model,
      effort: profile.effort,
    }),
  );
  await answerCodexHandshake(children[0]);
  children[0].reply({ thread: { id: 'thread-7' } });
  await first;
  timer.fire(0);

  const resumedMode = codexAskMode(askMode('codex', accepted.permissionMode) ?? defaultAskMode('codex'));
  const replacement = host.session(
    existingHostKey('codex', 'thread-7'),
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      resume: 'thread-7',
      ...resumedMode,
      model: accepted.selectedModel,
      effort: accepted.selectedEffort,
    }),
  );
  children[0].exit(0);
  await tick();
  await answerCodexHandshake(children[1]);
  children[1].reply({ thread: { id: 'thread-7' } });
  const session = await replacement;

  const delivery = session.prompt('continue');
  await tick();
  const turn = children[1].sent().find((message) => message.method === 'turn/start');
  const params = turn?.params as {
    approvalPolicy?: string;
    approvalsReviewer?: string;
    sandboxPolicy?: unknown;
    model?: string;
    effort?: string;
  };
  assert.deepEqual(params, {
    threadId: 'thread-7',
    input: [{ type: 'text', text: 'continue' }],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicy('workspace-write'),
    model: 'gpt-5-codex',
    effort: 'xhigh',
  });
  children[1].reply({ turn: { id: 'turn-1' } });
  await delivery;
});

test('a replacement writer waits for confirmed exit after the kill backstop', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, {
    timer,
    idleDurationMs: 20,
    exitGraceMs: 10,
  });
  const first = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  await first;
  vi.useFakeTimers();
  timer.fire(0);

  const replacement = host.session('one', claudePlan(CLAUDE, { cwd: WS, resume: 'sess-1' }));
  await vi.advanceTimersByTimeAsync(30);
  vi.useRealTimers();
  assert.equal(children[0].killed, true, 'the shutdown backstop never asked the old child to stop');
  assert.equal(children.length, 1, 'calling kill was treated as confirmed exit and started a second writer');

  children[0].exit(0);
  await tick();
  assert.equal(children.length, 2, 'confirmed exit did not release the replacement writer');
  children[1].answerHandshake();
  await replacement;
});

test('disposing the host prevents a replacement waiting on shutdown from starting', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const first = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  await first;
  timer.fire(0);

  const replacement = host.session('one', claudePlan(CLAUDE, { cwd: WS, resume: 'sess-1' }));
  const rejectedReplacement = assert.rejects(replacement, /host is no longer running/);
  host.dispose();
  children[0].exit(0);
  await tick();
  if (children[1]) {
    children[1].exit(0);
  }
  assert.equal(children.length, 1, 'a replacement spawned after host disposal released its shutdown wait');
  await rejectedReplacement;
  await assert.rejects(
    host.session('two', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-2' })),
    /host is no longer running/,
  );
  assert.equal(children.length, 1, 'host disposal allowed a pending or later child to spawn');
  assert.deepEqual(host.states(), []);
});

test('disposing the host prevents any later session from opening', async () => {
  const { host, children } = fakeHost();
  host.dispose();

  const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  if (children[0]) {
    children[0].exit(0);
  }
  await assert.rejects(opening, /host is no longer running/);
  assert.equal(children.length, 0, 'a disposed host opened another child');
});

test('an idle-duration change reschedules eligible sessions from the change time', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { idleDurationMs: 100, timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  await starting;
  assert.equal(timer.tasks[0].delayMs, 100);
  host.setIdleDuration(90);
  assert.equal(timer.tasks[0].cleared, true);
  assert.equal(timer.tasks[1].delayMs, 90);

  const housekeeping = host.beginHousekeeping('one');

  host.setIdleDuration(250);
  assert.equal(timer.activeCount(), 0, 'a duration change bypassed pending turn housekeeping');
  host.settled(housekeeping);
  assert.equal(timer.tasks[2].delayMs, 250);
  timer.fire(1, true);
  assert.notEqual(host.get('one'), null);
  timer.fire(2);
  assert.equal(host.get('one'), null);
});

test('an idle-duration change keeps archived retirement behind pending housekeeping', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { idleDurationMs: 100, timer });
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await starting;
  const housekeeping = host.beginHousekeeping('one');
  host.setArchived(['sess-1']);

  host.setIdleDuration(25);
  assert.strictEqual(host.get('one'), session);
  assert.equal(timer.activeCount(), 0);
  host.settled(housekeeping);
  assert.equal(host.get('one'), null);
});

test('host disposal clears timers and disposes remaining children once', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  for (const [key, id] of [
    ['one', 'sess-1'],
    ['two', 'sess-2'],
  ]) {
    const starting = host.session(key, claudePlan(CLAUDE, { cwd: WS, sessionId: id }));
    children[children.length - 1].answerHandshake();
    await starting;
  }

  host.dispose();
  assert.deepEqual(
    timer.tasks.map((task) => task.cleared),
    [true, true],
  );
  assert.deepEqual(
    children.map((child) => child.endCalls),
    [1, 1],
  );
  timer.fire(0, true);
  timer.fire(1, true);
  assert.deepEqual(
    children.map((child) => child.endCalls),
    [1, 1],
  );
});

test('the session id the CLI settled on is what the panel would resume by', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  children[0].say(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' }) + '\n');
  assert.equal(session.state().sessionId, 'sess-9');
});

test('a Codex session runs the package script under Node, with no shell', async () => {
  const { host, children, commands } = fakeHost();
  const starting = host.session(
    'cx',
    codexPlan(
      { command: 'node', leadingArgs: ['C:\\codex\\bin\\codex.js'], env: {} },
      {
        cwd: WS,
        clientInfo: CODEX_CLIENT,
      },
    ),
  );
  assert.deepEqual(commands[0], ['C:\\codex\\bin\\codex.js', 'app-server']);
  const child = children[0];
  // Handshake, skills, then the thread: each waits on the one before it.
  await answerCodexHandshake(child, [{ name: 'polish', description: 'Tidy the wording' }]);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  assert.equal(session.agent, 'codex');
  assert.equal(session.state().sessionId, 'thread-7');
  assert.deepEqual(
    session.state().commands.map((command) => command.name),
    ['compact', 'clear', 'new', 'rename', 'polish'],
  );
});

test('a partial Codex permission setup does not invent a reader pick', async () => {
  const { host, children } = fakeHost();
  const starting = host.session(
    'cx',
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      approvalPolicy: 'never',
    }),
  );
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const delivery = session.prompt('use the configured permissions');
  await tick();
  const turn = child.sent().find((message) => message.method === 'turn/start');
  const params = turn?.params as Record<string, unknown>;
  for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) {
    assert.equal(setting in params, false, `an incomplete pick invented ${setting}`);
  }
  child.reply({ turn: { id: 'turn-1' } });
  await delivery;
});

test('a Codex plan without a permission pick leaves the thread and turn unconfigured', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  const opening = child.sent().find((message) => message.method === 'thread/start');
  const openingParams = opening?.params as Record<string, unknown>;
  for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandbox']) {
    assert.equal(setting in openingParams, false, `an unpicked plan sent ${setting} at thread start`);
  }
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const delivery = session.prompt('use the configured permissions');
  await tick();
  const turn = child.sent().find((message) => message.method === 'turn/start');
  const turnParams = turn?.params as Record<string, unknown>;
  for (const setting of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy']) {
    assert.equal(setting in turnParams, false, `an unpicked plan sent ${setting} on its turn`);
  }
  child.reply({ turn: { id: 'turn-1' } });
  await delivery;
});

test('Stop cancels hosted Codex input awaiting a refreshed skill catalog', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  child.say(JSON.stringify({ method: 'skills/changed', params: {} }) + '\n');
  const delivery = session.prompt('/recap');
  let outcome: string | null = null;
  const settled = delivery.then(
    () => (outcome = 'accepted'),
    () => (outcome = 'stopped'),
  );
  assert.equal(session.state().busy, true);
  await session.interrupt();
  child.reply({ data: [] });
  await vi.waitFor(() => assert.ok(outcome || child.sent().some((m) => m.method === 'turn/start')));
  assert.equal(child.sent().filter((m) => m.method === 'turn/start').length, 0);
  assert.equal(await settled, 'stopped');
  assert.equal(session.state().busy, false);
  child.exit(0);
});

test('queued explicit skills use the cold or recreated destination child catalog', async () => {
  const { host, children } = fakeHost();
  const text = ' \n$recap does this work better? \n';
  const queued = normalizeQueuedSubmissions({
    cx: queueSubmissionAfter([], 'recap', text, [], [], 1, false, { agent: 'codex', owner: 'cx' }),
  }).cx[0];
  for (const [index, cwd] of [WS, '/Users/reader/project', '/home/reader/project'].entries()) {
    const starting = host.session('cx', codexPlan(CODEX, { cwd, resume: 'thread-7', clientInfo: CODEX_CLIENT }));
    const child = children[index];
    child.reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'skills/list'));
    assert.deepEqual(child.sent().at(-1)?.params, { cwds: [cwd] });
    assert.equal(
      child.sent().some((m) => m.method === 'turn/start'),
      false,
    );
    const path = index === 0 ? 'C:\\skills\\recap\\SKILL.md' : `${cwd}/skills/recap/SKILL.md`;
    child.reply({ data: [{ cwd, skills: [{ name: 'Recap', path, enabled: true }], errors: [] }] });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/resume'));
    child.reply({ thread: { id: 'thread-7' } });
    const session = await starting;
    if (index) children[index - 1].say(JSON.stringify({ method: 'skills/changed', params: {} }) + '\n');
    const delivery = session.prompt({ text: queued.text, assets: [] });
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
    assert.deepEqual(child.sent().at(-1)?.params, {
      threadId: 'thread-7',
      input: [
        { type: 'text', text },
        { type: 'skill', name: 'Recap', path },
      ],
    });
    child.reply({ turn: { id: `turn-${index}` } });
    await delivery;
    child.exit(0);
    assert.equal(session.state().exited, true);
  }
  assert.equal(children.length, 3);
});

test('a live Codex session replaces its commands after a skill change', async () => {
  const { host, children, events, states } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child, [{ name: 'polish', description: 'Tidy the wording' }]);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  child.say(JSON.stringify({ method: 'skills/changed', params: {} }) + '\n');
  assert.deepEqual(child.sent().at(-1), {
    id: 4,
    method: 'skills/list',
    params: { cwds: [WS], forceReload: true },
  });
  child.reply({
    data: [{ cwd: WS, skills: [{ name: 'summarize', description: 'Summarize the text' }] }],
  });
  await vi.waitFor(() => {
    assert.deepEqual(
      session.state().commands.map((command) => command.name),
      ['compact', 'clear', 'new', 'rename', 'summarize'],
    );
  });

  assert.strictEqual(host.get('cx'), session);
  assert.equal(children.length, 1);
  assert.equal(child.sent().filter((message) => message.method === 'thread/start').length, 1);
  assert.equal(events.at(-1)?.event.kind, 'commands');
  assert.deepEqual(
    states.at(-1)?.commands.map((command) => command.name),
    ['compact', 'clear', 'new', 'rename', 'summarize'],
  );
});

test('a Codex skill change during thread startup remains after opening completes', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child, [{ name: 'stale', description: 'Opening version' }]);
  const threadRequest = child.sent().find((message) => message.method === 'thread/start');
  assert.equal(typeof threadRequest?.id, 'number');

  child.say(JSON.stringify({ method: 'skills/changed', params: {} }) + '\n');
  const refreshRequest = child
    .sent()
    .filter((message) => message.method === 'skills/list')
    .at(-1);
  assert.equal(typeof refreshRequest?.id, 'number');
  child.say(
    JSON.stringify({
      id: refreshRequest?.id,
      result: { data: [{ cwd: WS, skills: [{ name: 'current', description: 'Current version' }] }] },
    }) + '\n',
  );
  await vi.waitFor(() => {
    assert.deepEqual(
      host
        .get('cx')
        ?.state()
        .commands.map((command) => command.name),
      ['compact', 'clear', 'new', 'rename', 'current'],
    );
  });

  child.say(JSON.stringify({ id: threadRequest?.id, result: { thread: { id: 'thread-7' } } }) + '\n');
  const session = await starting;
  assert.deepEqual(
    session.state().commands.map((command) => command.name),
    ['compact', 'clear', 'new', 'rename', 'current'],
  );
});

test('Codex compaction stays pending through its reported turn and sends no prompt turn', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const compacting = session.compact();
  assert.equal(session.state().busy, true);
  const request = child.sent().at(-1);
  assert.deepEqual(request?.params, { threadId: 'thread-7' });
  assert.equal(request?.method, 'thread/compact/start');
  assert.equal(
    child.sent().some((message) => message.method === 'turn/start'),
    false,
  );

  child.reply({});
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(session.state().busy, true, 'the request acknowledgement ended the compaction');
  child.say(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'thread-7', turn: { id: 'compact-turn', status: 'inProgress', items: [] } },
    }) + '\n',
  );
  assert.equal(session.state().busy, true);
  await vi.advanceTimersByTimeAsync(CODEX_DEADLINE_MS);
  assert.equal(session.state().busy, true, 'the reader lost the running state before native completion');
  const stopping = session.interrupt();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(child.sent().at(-1)?.method, 'turn/interrupt');
  assert.deepEqual(child.sent().at(-1)?.params, { threadId: 'thread-7', turnId: 'compact-turn' });
  child.reply({});
  await stopping;
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-7', turn: { id: 'compact-turn', status: 'completed', items: [] } },
    }) + '\n',
  );
  await compacting;
  assert.equal(session.state().busy, false);
});

test.each(['early timeout', 'early refusal', 'late timeout', 'unattributed timeout'])(
  'Codex native compaction retains reader busy state and Stop through %s',
  async (ending) => {
    const { host, children } = fakeHost();
    const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
    const child = children[0];
    await answerCodexHandshake(child);
    child.reply({ thread: { id: 'thread-7' } });
    const session = await starting;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const unanswered: number[] = [];
    if (ending === 'unattributed timeout') {
      const first = assert.rejects(session.compact(), /did not answer/);
      unanswered.push(child.sent().at(-1)!.id as number);
      await vi.advanceTimersByTimeAsync(CODEX_DEADLINE_MS);
      await first;
    }
    const compacting = assert.rejects(
      session.compact(),
      ending === 'early refusal' ? /not now/ : ending === 'unattributed timeout' ? /did not finish/ : /did not answer/,
    );
    if (ending === 'unattributed timeout') {
      unanswered.push(child.sent().at(-1)!.id as number);
      child.reply({});
    }
    const startTurn = () =>
      child.say(
        JSON.stringify({
          method: 'turn/started',
          params: { threadId: 'thread-7', turn: { id: 'compact-turn' } },
        }) + '\n',
      );
    if (ending !== 'late timeout') startTurn();
    if (ending === 'unattributed timeout')
      child.say(
        JSON.stringify({
          method: 'item/started',
          params: {
            threadId: 'thread-7',
            turnId: 'compact-turn',
            item: { id: 'compact-item', type: 'contextCompaction' },
          },
        }) + '\n',
      );
    if (ending === 'early refusal') child.replyError(-32600, 'not now');
    await vi.advanceTimersByTimeAsync(CODEX_DEADLINE_MS);
    await compacting;
    for (const id of unanswered) child.say(JSON.stringify({ id, error: { message: 'not now' } }) + '\n');
    if (ending === 'late timeout') {
      assert.equal(session.state().busy, false);
      startTurn();
    }
    assert.equal(session.state().busy, true, 'the exact native turn must remain visible as running');
    assert.equal(session.compactionUnresolved(), true);
    const stopping = session.interrupt();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(child.sent().at(-1)?.method, 'turn/interrupt');
    assert.deepEqual(child.sent().at(-1)?.params, { threadId: 'thread-7', turnId: 'compact-turn' });
    child.reply({});
    await stopping;
    child.say(
      JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-7', turn: { id: 'compact-turn', status: 'completed', items: [] } },
      }) + '\n',
    );
    assert.equal(session.state().busy, false);
    assert.equal(session.compactionUnresolved(), false);
  },
);

test('Codex clear starts a replacement thread and reports the previous session', async () => {
  const { host, children, events } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const clearing = session.clear();
  const request = child.sent().at(-1);
  assert.equal(request?.method, 'thread/start');
  assert.equal(
    child.sent().some((message) => message.method === 'turn/start'),
    false,
  );
  child.reply({ thread: { id: 'thread-8' } });
  await clearing;
  assert.equal(session.state().sessionId, 'thread-8');
  assert.deepEqual(events.filter((entry) => entry.event.kind === 'session').at(-1)?.event, {
    kind: 'session',
    sessionId: 'thread-8',
    previous: 'thread-7',
  });
});

test('Codex new names its replacement thread without starting a model turn', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const replacing = session.clear('follow-up');
  assert.equal(child.sent().at(-1)?.method, 'thread/start');
  child.reply({ thread: { id: 'thread-8' } });
  await tick();
  assert.deepEqual(child.sent().at(-1), {
    id: child.sent().at(-1)?.id,
    method: 'thread/name/set',
    params: { threadId: 'thread-8', name: 'follow-up' },
  });
  assert.equal(
    child.sent().some((message) => message.method === 'turn/start'),
    false,
  );
  child.reply({});
  await replacing;
  assert.equal(session.state().sessionId, 'thread-8');
});

test('a refused Codex new name keeps the adopted replacement usable', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const replacing = session.clear('follow-up');
  child.reply({ thread: { id: 'thread-8' } });
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/name/set'));
  child.replyError(-32000, 'name refused');
  await replacing;
  assert.equal(session.state().sessionId, 'thread-8');
  assert.match(session.state().lastError ?? '', /new session opened.*name was not saved.*name refused/);

  const following = session.prompt('continue');
  const request = child.sent().at(-1);
  assert.equal(request?.method, 'turn/start');
  assert.equal((request?.params as { threadId?: string } | undefined)?.threadId, 'thread-8');
  child.reply({ turn: { id: 'turn-9' } });
  await following;
});

test('a Codex clear keeps the current Default model for its replacement thread', async () => {
  const { host, children } = fakeHost();
  const starting = host.session(
    'cx',
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      model: 'gpt-5.6-sol',
    }),
  );
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  await session.setModel('');
  const clearing = session.clear();
  const clear = child.sent().at(-1);
  assert.equal(clear?.method, 'thread/start');
  assert.equal(
    (clear?.params as { model?: string } | undefined)?.model,
    undefined,
    'the replacement thread restored the explicit launch model after the reader selected Default',
  );
  child.reply({ thread: { id: 'thread-8' } });
  await clearing;

  void session.prompt('continue');
  await tick();
  const prompt = child.sent().at(-1);
  assert.equal(prompt?.method, 'turn/start');
  assert.equal(
    (prompt?.params as { model?: string } | undefined)?.model,
    undefined,
    'the first prompt after clear overrides the replacement thread with the retired model',
  );
});

test('a rejected native compaction clears the running state and keeps the reason', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const compacting = session.compact();
  await tick();
  child.replyError(-32600, 'compaction is unavailable while a turn is running');
  // The rejected promise retains the server error unchanged. Session diagnostics also identify the failed compaction.

  await assert.rejects(compacting, (error: Error) => {
    assert.equal(error.message, 'compaction is unavailable while a turn is running');
    return true;
  });
  assert.equal(session.state().busy, false);
  assert.match(session.state().lastError ?? '', /compaction is unavailable/);
  assert.match(
    session.state().lastError ?? '',
    /would not compact the session/,
    'the session diagnostic names the operation, because nothing reading it later can tell',
  );
});

test('a compaction the agent gave no reason for leaves no dangling colon behind', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const compacting = session.compact();
  await tick();
  child.reply({});
  await tick();
  child.say(
    JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'thread-7', turn: { id: 'compact-turn' } },
    }) + '\n',
  );
  await tick();
  child.say(
    JSON.stringify({
      method: 'turn/failed',
      params: { threadId: 'thread-7', turnId: 'compact-turn' },
    }) + '\n',
  );
  await assert.rejects(compacting, (error: Error) => {
    assert.equal(error.message, '', 'an empty message is how the panel knows to say so itself');
    return true;
  });
  assert.equal(session.state().lastError, 'the agent would not compact the session and gave no reason');
});

test('a rejected Codex skill list does not stop the session from opening', async () => {
  const { host, children } = fakeHost();
  const opening = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  child.reply({ userAgent: 'codex' });
  await tick();
  child.replyError(-32601, 'Method not found');
  await tick();
  assert.equal(child.sent()[3].method, 'thread/start');
  child.reply({ thread: { id: 'thread-7' } });
  const session = await opening;
  assert.deepEqual(
    session.state().commands.map((command) => command.name),
    ['compact', 'clear', 'new', 'rename'],
  );
  assert.equal(session.state().sessionId, 'thread-7');
});

test('a resumed Codex session keeps Approve for me without and with a stored choice', async () => {
  for (const stored of [undefined, 'on-request']) {
    const { host, children } = fakeHost();
    const approval = codexAskMode(askMode('codex', stored) ?? defaultAskMode('codex'));
    const starting = host.session(
      'cx',
      codexPlan(CODEX, {
        cwd: WS,
        clientInfo: CODEX_CLIENT,
        resume: 'thread-7',
        ...approval,
      }),
    );
    const child = children[0];
    await answerCodexHandshake(child);
    const asked = child
      .sent()
      .filter((m) => typeof m.method === 'string')
      .map((m) => m.method);
    assert.ok(asked.includes('thread/resume'), 'starting a new thread would abandon the session');
    assert.ok(!asked.includes('thread/start'));
    child.reply({ thread: { id: 'thread-7' } });
    const session = await starting;

    const delivery = session.prompt('carry on');
    await tick();
    const turn = child.sent().find((m) => m.method === 'turn/start');
    const params = turn?.params as {
      approvalPolicy?: string;
      approvalsReviewer?: string;
      sandboxPolicy?: unknown;
      sandbox?: string;
    };
    assert.equal(params.approvalPolicy, 'on-request');
    assert.equal(params.approvalsReviewer, 'auto_review');
    assert.deepEqual(params.sandboxPolicy, sandboxPolicy(approval.sandbox));
    assert.equal(params.sandbox, undefined);
    child.reply({ turn: { id: 'turn-1' } });
    await delivery;
  }
});

test('a Codex continuation keeps its accepted setup through retirement and reopening', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  const profile: SessionProfile = {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    permissionMode: 'untrusted',
    source: 'custom',
  };
  let book = withSessionSettings({}, 'source', sessionSettingsForProfile(profile));
  const approval = codexAskMode(
    askMode('codex', sessionSettings(book, 'source').permissionMode) ?? defaultAskMode('codex'),
  );
  const starting = host.session(
    'codex:fork:source:1',
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      fork: 'source',
      ...approval,
      model: profile.model,
      effort: profile.effort,
    }),
  );
  const child = children[0];
  await answerCodexHandshake(child);
  const methods = child
    .sent()
    .filter((m) => typeof m.method === 'string')
    .map((m) => m.method);
  assert.ok(methods.includes('thread/fork'));
  assert.ok(!methods.includes('thread/resume'));
  assert.ok(!methods.includes('thread/start'));
  const fork = child.sent().find((m) => m.method === 'thread/fork');
  const forkParams = fork?.params as {
    approvalPolicy?: string;
    approvalsReviewer?: string;
    sandbox?: string;
    sandboxPolicy?: unknown;
  };
  assert.equal(forkParams.approvalPolicy, approval.approvalPolicy);
  assert.equal(forkParams.approvalsReviewer, approval.approvalsReviewer);
  assert.equal(forkParams.sandbox, approval.sandbox);
  assert.equal(forkParams.sandboxPolicy, undefined);
  child.reply({ thread: { id: 'continued' } });
  const session = await starting;
  book = withSessionSettings(book, 'continued', sessionSettingsForProfile(profile));
  assert.equal(host.find('codex', 'continued'), session, 'a later send by the fork id would start a second writer');
  assert.deepEqual(
    sessionSettings(book, 'source'),
    sessionSettingsForProfile(profile),
    'saving the fork setup removed the resumable source setup',
  );

  const delivery = session.prompt('carry on');
  await tick();
  const turn = child.sent().find((m) => m.method === 'turn/start');
  const turnParams = turn?.params as {
    threadId?: string;
    approvalPolicy?: string;
    approvalsReviewer?: string;
    sandboxPolicy?: unknown;
    sandbox?: string;
    model?: string;
    effort?: string;
  };
  assert.equal(turnParams.threadId, 'continued');
  assert.equal(turnParams.approvalPolicy, approval.approvalPolicy);
  assert.equal(turnParams.approvalsReviewer, approval.approvalsReviewer);
  assert.deepEqual(turnParams.sandboxPolicy, sandboxPolicy(approval.sandbox));
  assert.equal(turnParams.sandbox, undefined);
  assert.equal(turnParams.model, profile.model);
  assert.equal(turnParams.effort, profile.effort);
  child.reply({ turn: { id: 'turn-1' } });
  await delivery;
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'continued', turn: { id: 'turn-1', status: 'completed', items: [] } },
    }) + '\n',
  );
  timer.fire(0);
  assert.equal(host.get('codex:fork:source:1'), null);

  const stored = sessionSettings(book, 'continued');
  const reopened = host.session(
    existingHostKey('codex', 'continued'),
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      resume: 'continued',
      ...codexAskMode(askMode('codex', stored.permissionMode) ?? defaultAskMode('codex')),
      model: stored.selectedModel,
      effort: stored.selectedEffort,
    }),
  );
  child.exit(0);
  await tick();
  await answerCodexHandshake(children[1]);
  children[1].reply({ thread: { id: 'continued' } });
  const replacement = await reopened;
  const next = replacement.prompt('next turn');
  await tick();
  const resumedTurn = children[1].sent().find((message) => message.method === 'turn/start');
  assert.deepEqual(
    resumedTurn?.params,
    {
      threadId: 'continued',
      input: [{ type: 'text', text: 'next turn' }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: sandboxPolicy('workspace-write'),
      model: profile.model,
      effort: profile.effort,
    },
    'the retired fork reopened with different workspace approval settings',
  );
  children[1].reply({ turn: { id: 'turn-2' } });
  await next;
});

test('a Codex approval reaches the panel as the same kind of ask a Claude one does', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  child.say(
    JSON.stringify({
      id: 0,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'exec-1', command: 'echo hi', cwd: WS },
    }) + '\n',
  );
  assert.equal(session.state().asks.length, 1);
  assert.equal(session.state().asks[0].kind, 'permission');
  assert.equal(session.answer('exec-1', { decision: 'allow' }), true);
  const answered = child.sent().find((m) => m.id === 0 && m.result);
  assert.deepEqual(answered?.result, { decision: 'accept' });
  assert.equal(session.state().asks.length, 0);
});

test('a Codex async question stays open after its turn ends, and answering it starts a new turn', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  const prompting = session.prompt('check the rail');
  child.reply({ turn: { id: 'turn-1' } });
  await prompting;
  const item = {
    type: 'agentMessage',
    id: 'call-ask',
    text: 'Does it work?\n- Yes',
    phase: 'final_answer',
    delivery: 'async',
    questions: [{ title: 'Does it work?', options: ['Yes', 'No'] }],
  };
  child.say(
    JSON.stringify({ method: 'item/completed', params: { item, threadId: 'thread-7', turnId: 'turn-1' } }) + '\n',
  );
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-7', turn: { id: 'turn-1', status: 'completed', items: [] } },
    }) + '\n',
  );
  assert.deepEqual(
    session.state().asks.map((ask) => ask.id),
    ['call-ask'],
    'the question waits on no request, so its turn ending leaves it for the reader to answer',
  );
  assert.equal(session.state().busy, false);

  const questionId = JSON.stringify(['request_user_input_async', 'call-ask', 0]);
  assert.equal(
    session.answer('call-ask', { decision: 'answer', answers: { [questionId]: { labels: ['Yes'], written: '' } } }),
    true,
  );
  assert.equal(session.state().asks.length, 0);
  assert.equal(
    session.state().busy,
    true,
    'with the ask gone and the prompt not yet accepted, an idle session could retire mid-delivery',
  );
  const start = child.sent().at(-1);
  assert.equal(start?.method, 'turn/start');
  assert.match(JSON.stringify(start?.params), /send_user_message_question_reply/);
  child.reply({ turn: { id: 'turn-2' } });
  await vi.waitFor(() =>
    assert.equal(session.state().busy, true, 'the answer started a turn, so the session is working'),
  );
});

test('a Codex async answer whose steer and prompt are both refused leaves the session idle', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  const prompting = session.prompt('check the rail');
  child.reply({ turn: { id: 'turn-1' } });
  await prompting;
  const item = {
    type: 'agentMessage',
    id: 'call-ask',
    text: 'Does it work?',
    phase: 'final_answer',
    delivery: 'async',
    questions: [{ title: 'Does it work?', options: ['Yes', 'No'] }],
  };
  child.say(
    JSON.stringify({
      method: 'item/completed',
      params: { item, threadId: 'thread-7', turnId: 'turn-1' },
    }) + '\n',
  );
  const questionId = JSON.stringify(['request_user_input_async', 'call-ask', 0]);
  session.answer('call-ask', {
    decision: 'answer',
    answers: { [questionId]: { labels: ['Yes'], written: '' } },
  });
  assert.equal(child.sent().at(-1)?.method, 'turn/steer');
  child.replyError(-32600, 'expected turn is not active');
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
  // The asking turn ends while the fallback prompt waits to be accepted.
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-7',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      },
    }) + '\n',
  );
  child.replyError(-32600, 'thread is busy');
  await vi.waitFor(() =>
    assert.deepEqual(
      session.state().asks.map((ask) => ask.id),
      ['call-ask'],
    ),
  );
  assert.equal(session.state().busy, false, 'no turn is open, so the session must not stay busy');
  assert.match(session.state().lastError ?? '', /thread is busy/);
});

test('a prompt the agent will not take clears the running state and says why', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  const delivery = session.prompt('hello');
  await tick();
  child.replyError(-32600, 'the server refused this turn');
  await assert.rejects(
    delivery,
    /would not take the prompt/,
    'the composer must not be told delivery succeeded when Codex rejected the turn',
  );
  assert.equal(session.state().busy, false, 'a prompt that never went out must not leave the panel saying it did');
  assert.match(session.state().lastError ?? '', /would not take the prompt/);
});

test('a Codex resume refusal closes the unusable child and keeps the refusal', async () => {
  const { host, children } = fakeHost();
  const opening = host.session(
    'cx',
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      resume: 'thread-7',
    }),
  );
  const child = children[0];
  await answerCodexHandshake(child);
  child.replyError(-32600, 'thread thread-7 already has an active writer');

  const session = await opening;
  assert.equal(session.state().exited, true, 'a child that adopted no session is kept as though it can take a prompt');
  assert.equal(child.ended, true, 'the refused child stdin is left open');
  assert.equal(child.ended, true, 'the refused child process is left running');
  assert.match(
    session.state().lastError ?? '',
    /already has an active writer/,
    'the reason Codex gave is replaced by a later no-session error',
  );

  const sentBefore = child.sent().length;
  await assert.rejects(
    session.prompt('hello'),
    /active writer/,
    'prompting the refused session loses the opening reason',
  );
  assert.equal(child.sent().length, sentBefore, 'a turn was sent to a child that adopted no session');
});

test('a Codex prompt is not reported delivered before the app server accepts the turn', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const delivery = session.prompt('hello');
  let delivered = false;
  void delivery.then(() => {
    delivered = true;
  });
  await tick();
  assert.equal(delivered, false, 'the turn/start request has not been answered yet');

  child.reply({ turn: { id: 'turn-8' } });
  await delivery;
  assert.equal(delivered, true);
});

test('Codex prompts accepted into one server turn share its Stop and completion', async () => {
  const { host, children, events } = fakeHost();
  const starting = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;

  const delivery = session.prompt('first');
  await tick();
  child.reply({ turn: { id: 'turn-8' } });
  await delivery;
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-7', turn: { id: 'turn-old', status: 'completed', items: [] } },
    }) + '\n',
  );
  assert.equal(session.state().busy, true, 'a stale ending took the Stop control away from the active turn');
  assert.equal(
    events.some((entry) => entry.event.kind === 'turnEnd'),
    false,
    'the stale ending escaped the wire as the active turn ending',
  );

  const queued = session.prompt('second');
  await tick();
  const starts = child.sent().filter((message) => message.method === 'turn/start');
  assert.equal(starts.length, 2, 'the second prompt never reached the busy Codex child');
  child.reply({ turn: { id: 'turn-8' } });
  await queued;
  const stopping = session.interrupt();
  await tick();
  const interrupt = child.sent().find((message) => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, { threadId: 'thread-7', turnId: 'turn-8' });
  child.reply({});
  await stopping;

  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-7', turn: { id: 'turn-8', status: 'completed', items: [] } },
    }) + '\n',
  );
  assert.equal(session.state().busy, false);
  assert.equal(
    events.filter((entry) => entry.event.kind === 'turnEnd').length,
    1,
    'one server turn emitted an ending for each accepted prompt',
  );
  const interruptsBefore = child.sent().filter((message) => message.method === 'turn/interrupt').length;
  await session.interrupt();
  assert.equal(
    child.sent().filter((message) => message.method === 'turn/interrupt').length,
    interruptsBefore,
    'Stop reused the id after its server turn completed',
  );
});

test('a prompt sent to a Claude session whose child has died is reported, not shown as running', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  children[0].exit(1);
  await assert.rejects(
    session.prompt('are you there'),
    /stopped with code 1/,
    'prompting a dead child replaces the reason it died with a generic stopped message',
  );
  const state = session.state();
  assert.equal(state.busy, false, 'a turn shown as running on a dead child never clears and cannot be stopped');
  assert.match(state.lastError ?? '', /stopped with code 1/);
});

test('two callers racing for one session wait on the same opening, not on two', async () => {
  const { host, children } = fakeHost();
  const first = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  let secondSettled = false;
  const second = host.session('one', claudePlan(CLAUDE, { cwd: WS })).then((s) => {
    secondSettled = true;
    return s;
  });
  assert.equal(children.length, 1, 'the second caller must not start a second child');

  // Both callers wait for the same handshake before receiving a usable session and command list.

  await tick();
  assert.equal(secondSettled, false, 'the second caller was handed a session mid-handshake');

  children[0].answerHandshake([{ name: 'compact', description: 'Compact', argumentHint: '' }]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(
    b.state().commands.map((c) => c.name),
    ['compact'],
  );
});

test('a batch shim is refused with a message, not with a throw from inside a constructor', () => {
  // Windows batch shims need a shell. Reject them before starting a child through Node's direct process API.

  assert.match(unstartable('C:\\Users\\g\\AppData\\Roaming\\npm\\claude.cmd', 'win32') ?? '', /batch shim/);
  assert.match(unstartable('C:\\tools\\claude.BAT', 'win32') ?? '', /batch shim/);
  assert.equal(unstartable('C:\\Users\\g\\.local\\bin\\claude.exe', 'win32'), null);
  assert.equal(unstartable('claude', 'win32'), null);
  assert.equal(
    unstartable('/home/g/.local/bin/claude.cmd', 'linux'),
    null,
    'nothing outside Windows runs batch shims, and refusing one there would be nonsense',
  );
});

test('an opening that never answers gives up, rather than waiting for ever', async () => {
  const never = new Promise<string[]>(() => undefined);
  await assert.rejects(withDeadline(never, 20), /within/);
});

test('a child that starts and then says nothing does not hold the send button for ever', async () => {
  // The case a dead child does not cover: an unauthenticated CLI comes up and waits on a
  // terminal it does not have, so it never answers the handshake and never exits either.
  const { host, children } = fakeHost(20);
  const session = await host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  assert.equal(children.length, 1);
  assert.match(
    session.state().lastError ?? '',
    /opening/,
    'without a deadline this call never returns and the reader is told nothing',
  );
});

test('an opening that answers in time keeps its answer, and its deadline is dropped', async () => {
  assert.deepEqual(await withDeadline(Promise.resolve(['a']), 10_000), ['a']);
});

test('an ask left open when the turn ends is dropped, not left waiting on the reader', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  const session = await starting;
  await session.prompt('do something');
  children[0].say(
    JSON.stringify({
      type: 'control_request',
      request_id: 'ask-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' },
    }) + '\n',
  );
  assert.equal(session.state().asks.length, 1);

  // The reader stops the turn instead of answering it.
  children[0].say(
    JSON.stringify({
      type: 'result',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      permission_denials: [],
    }) + '\n',
  );
  assert.deepEqual(
    session.state().asks,
    [],
    'the agent has stopped waiting, so an ask left here would remain on the request card',
  );
  assert.deepEqual(host.waiting(), []);
});

// Start an idle child for usage and model reads without sending a model prompt.

function idleProbe(plan: AgentPlan): { children: FakeChild[]; answers: Promise<IdleAnswers> } {
  const children: FakeChild[] = [];
  const answers = askIdle(plan, () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return { children, answers };
}

// The fake plan lets usage and model reads reject independently. The production adapters normalize their own unavailable responses.

function answeringPlan(answers: {
  usage(refreshAuthentication?: boolean): Promise<UsageReading | null>;
  models(): Promise<ModelList | null>;
}): AgentPlan {
  return {
    agent: 'claude',
    sessionId: null,
    command: 'c',
    args: [],
    cwd: WS,
    env: {},
    driver: () => ({
      receive: () => undefined,
      open: () => Promise.resolve([]),
      prompt: () => Promise.resolve(),
      compact: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      answer: () => false,
      interrupt: () => Promise.resolve(),
      sessionId: () => null,
      close: () => undefined,
      rateLimits: answers.usage,
      models: answers.models,
    }),
  };
}

test('an explicit limits refresh reaches the running agent driver', async () => {
  let refreshAuthentication = false;
  const reading: UsageReading = {
    plan: 'pro',
    limits: [],
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt: 7,
  };
  const child = new FakeChild();
  const session = new AgentSession(
    'one',
    answeringPlan({
      usage: (refresh) => {
        refreshAuthentication = refresh ?? false;
        return Promise.resolve(reading);
      },
      models: () => Promise.resolve(A_MODEL_LIST),
    }),
    () => child,
    () => {},
    () => {},
  );
  await session.start();
  assert.deepEqual(await session.rateLimits(true), reading);
  assert.equal(refreshAuthentication, true);
  const disposing = session.dispose();
  child.exit(0);
  await disposing;
});

test('the environment a launch asks for is added to what the child would have inherited', () => {
  const merged = childEnv({ PATH: '/bin', HOME: '/home/g' }, { CODEX_MANAGED_BY_NPM: '1' });
  assert.equal(merged.PATH, '/bin', 'a child started with only the extra variables loses its PATH');
  assert.equal(merged.HOME, '/home/g');
  assert.equal(merged.CODEX_MANAGED_BY_NPM, '1');
  assert.equal(merged.ELECTRON_RUN_AS_NODE, '1', 'the script the panel starts runs under a binary that needs this');
});

test('a launch that asks for no environment of its own adds nothing to the child', () => {
  assert.deepEqual(childEnv({ PATH: '/bin' }, {}), { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
});

test('child launches remove inherited requester identities without inventing a native identity', () => {
  const codexClient = { cwd: WS, clientInfo: CODEX_CLIENT };
  const plans = [
    claudePlan(CLAUDE, { cwd: WS }),
    claudeRenamePlan(CLAUDE, { cwd: WS, resume: 'session-1', title: 'Named' }),
    claudeIdlePlan(CLAUDE, WS),
    codexPlan(CODEX, codexClient),
    codexIdlePlan(CODEX, codexClient),
    codexRenamePlan(CODEX, { ...codexClient, threadId: 'thread-1', title: 'Named' }),
  ];
  for (const inherited of [
    { CLAUDE_CODE_SESSION_ID: 'parent-claude', CODEX_THREAD_ID: 'parent-codex' },
    { Claude_Code_Session_Id: 'parent-claude', Codex_Thread_Id: 'parent-codex' },
  ]) {
    for (const plan of plans) {
      const env = childEnv({ PATH: '/bin', ...inherited }, plan.env);
      assert.deepEqual(requesterIdentity(env), { requester: null, provider: null, ambiguous: false });
      assert.equal(
        Object.keys(env).some((key) => ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'].includes(key.toUpperCase())),
        false,
      );
      assert.equal(env.PATH, '/bin');
      for (const [key, value] of Object.entries(plan.env)) assert.equal(env[key], value);
      for (const [key, provider] of [
        ['CLAUDE_CODE_SESSION_ID', 'claude'],
        ['CODEX_THREAD_ID', 'codex'],
      ]) {
        assert.deepEqual(requesterIdentity({ ...env, [key]: 'native-session' }), {
          requester: 'native-session',
          provider,
          ambiguous: false,
        });
        assert.equal(childEnv(inherited, { ...plan.env, [key]: 'intentional-session' })[key], 'intentional-session');
      }
    }
  }
});

test('what a launch asks for in the environment reaches the child it starts', async () => {
  const { host, children, envs } = fakeHost();
  const managed = { command: 'node', leadingArgs: ['codex.js'], env: { CODEX_MANAGED_BY_NPM: '1' } };
  const first = host.session('one', claudePlan(managed, { cwd: WS }));
  children[0].answerHandshake();
  await first;
  assert.deepEqual(
    envs[0],
    { CODEX_MANAGED_BY_NPM: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    'the agent is otherwise told nothing about how it was installed, and Claude is asked to report when it goes idle',
  );

  const second = host.session('two', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  await answerCodexHandshake(children[1]);
  children[1].reply({ thread: { id: 'thread-env' } });
  await second;
  assert.deepEqual(envs[1], {}, 'a launch that asks for nothing must not have a variable invented for it');
});

test('without an opt-in no child of any plan carries an inherited entrypoint', () => {
  const codexClient = { cwd: WS, clientInfo: CODEX_CLIENT };
  const plans: [string, AgentPlan][] = [
    ['claudePlan', claudePlan(CLAUDE, { cwd: WS })],
    ['claudeRenamePlan', claudeRenamePlan(CLAUDE, { cwd: WS, resume: 'session-1', title: 'Named' })],
    ['claudeIdlePlan', claudeIdlePlan(CLAUDE, WS)],
    ['codexPlan', codexPlan(CODEX, codexClient)],
    ['codexIdlePlan', codexIdlePlan(CODEX, codexClient)],
    ['codexRenamePlan', codexRenamePlan(CODEX, { ...codexClient, threadId: 'thread-1', title: 'Named' })],
  ];
  // An editor started from a Claude session carries `cli`, and one running Anthropic's own
  // extension carries `claude-vscode`. spawnCli hands the child exactly this merge, and
  // childEnv removes the inherited value before any plan's own environment is added.
  for (const editorEntrypoint of [undefined, 'cli', 'claude-vscode']) {
    for (const [name, plan] of plans) {
      const env = childEnv({ PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: editorEntrypoint }, plan.env);
      assert.equal(
        'CLAUDE_CODE_ENTRYPOINT' in env,
        false,
        `${name} under an editor entrypoint of ${editorEntrypoint} started its child with CLAUDE_CODE_ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT}`,
      );
    }
  }

  // Windows environment names are case-insensitive, so an inherited name that differs only
  // in case from CLAUDE_CODE_ENTRYPOINT must be removed too.
  for (const [name, plan] of plans) {
    const env = childEnv({ PATH: '/bin', Claude_Code_Entrypoint: 'cli' }, plan.env);
    assert.equal(
      'CLAUDE_CODE_ENTRYPOINT' in env,
      false,
      `${name} under a mixed-case inherited entrypoint started its child with CLAUDE_CODE_ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT}`,
    );
    assert.equal(
      'Claude_Code_Entrypoint' in env,
      false,
      `${name} under a mixed-case inherited entrypoint kept the inherited name Claude_Code_Entrypoint=${env.Claude_Code_Entrypoint}`,
    );
  }

  // `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDE_CODE_REMOTE_SESSION_ID`,
  // `CLAUDE_CODE_CHILD_SESSION`, and `CLAUDE_CODE_CONTAINER_ID` name another Claude client, tie
  // a child to a session running elsewhere, or mark the child itself as a spawned subagent.
  // childEnv removes them the same way it removes CLAUDE_CODE_ENTRYPOINT.
  const removedIdentityNames = [
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_AGENT_SDK_CLIENT_APP',
    'CLAUDE_CODE_REMOTE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_CONTAINER_ID',
  ];
  for (const [name, plan] of plans) {
    const env = childEnv(
      {
        PATH: '/bin',
        CLAUDE_AGENT_SDK_VERSION: '1.2.3',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'other-client',
        CLAUDE_CODE_REMOTE_SESSION_ID: 'session-9',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_CONTAINER_ID: 'container-9',
      },
      plan.env,
    );
    for (const removed of removedIdentityNames) {
      assert.equal(removed in env, false, `${name} started its child with ${removed}=${env[removed]}`);
    }
  }

  // Windows environment names are case-insensitive, so an inherited name that differs only in
  // case from one of these names must be removed too.
  for (const [name, plan] of plans) {
    const env = childEnv(
      {
        PATH: '/bin',
        Claude_Agent_Sdk_Version: '1.2.3',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'other-client',
        CLAUDE_CODE_REMOTE_SESSION_ID: 'session-9',
        Claude_Code_Child_Session: '1',
        CLAUDE_CODE_CONTAINER_ID: 'container-9',
      },
      plan.env,
    );
    assert.equal(
      'Claude_Agent_Sdk_Version' in env,
      false,
      `${name} under a mixed-case inherited name kept Claude_Agent_Sdk_Version=${env.Claude_Agent_Sdk_Version}`,
    );
    assert.equal(
      'Claude_Code_Child_Session' in env,
      false,
      `${name} under a mixed-case inherited name kept Claude_Code_Child_Session=${env.Claude_Code_Child_Session}`,
    );
    for (const removed of [
      'CLAUDE_AGENT_SDK_CLIENT_APP',
      'CLAUDE_CODE_REMOTE_SESSION_ID',
      'CLAUDE_CODE_CONTAINER_ID',
    ]) {
      assert.equal(removed in env, false, `${name} under a mixed-case inherited name kept ${removed}=${env[removed]}`);
    }
  }
});

test('Arc CLI environments preserve PATH casing and replace inherited window targeting on each platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const windows = platform === 'win32';
    for (const key of ['PATH', 'Path', 'pAtH']) {
      const inherited = {
        [key]: 'inherited',
        Arc_Window: 'other-window',
        ARC_WINDOW: 'stale',
        Arc_Editor_Executable: 'stale',
      };
      const env = childEnv(inherited, {}, undefined, undefined, {
        directory: 'launcher directory',
        editorExecutable: 'C:\\Editor Files\\Code.exe',
        windowId: 'own-window',
        platform,
      });
      assert.equal(
        env[windows ? key : 'PATH'],
        'launcher directory' + (windows ? ';inherited' : key === 'PATH' ? ':inherited' : ''),
      );
      if (windows)
        assert.deepEqual(
          Object.keys(env).filter((name) => name.toUpperCase() === 'PATH'),
          [key],
        );
      else if (key !== 'PATH') assert.equal(env[key], 'inherited');
      assert.equal(env.ARC_WINDOW, 'own-window');
      assert.equal('Arc_Window' in env, false);
      assert.equal('Arc_Editor_Executable' in env, false);
      assert.equal(env.ARC_EDITOR_EXECUTABLE, windows ? 'C:/Editor Files/Code.exe' : 'C:\\Editor Files\\Code.exe');
    }
    const env = childEnv(
      { Path: 'old', PATH: 'node-selected', ARC_WINDOW: 'stale' },
      { pAtH: 'new' },
      undefined,
      undefined,
      {
        directory: 'bin',
        editorExecutable: '/editor',
        windowId: null,
        platform,
      },
    );
    assert.equal(env.PATH, windows ? 'bin;new' : 'bin:node-selected');
    assert.equal('ARC_WINDOW' in env, false);
    assert.equal(
      childEnv({}, {}, undefined, undefined, {
        directory: 'bin',
        editorExecutable: '/editor',
        windowId: null,
        platform,
      }).PATH,
      'bin',
    );
  }
});

test('the extension binds its packaged CLI and current window to every child entry point', () => {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  sourceMatch(
    source,
    /const spawner = arcCliSpawner\(\(\) => privateTools\.current\(channel\?\.windowId \?\? null\)\)/,
  );
  sourceMatch(source, /const host = new AgentHost\(\{[\s\S]*?spawner,/);
  for (const helper of ['askIdle', 'askIdleMcp', 'askIdleMcpChange', 'askIdleDefaults'])
    sourceMatch(source, new RegExp(helper + '\\(plan, spawner(?:[,\\)])'));
});

test('activate wires the guarded send policy into reader callbacks, draft starts, the channel, and the panel ports', () => {
  const activate = declarationSource(fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8'), 'activate');
  sourceMatch(
    activate,
    /Object\.assign\(panel, guardedPanelPorts\(guardedSends\)\);\s*panel\.installGuardedFacts\?\.\(\s*guardedFactsWithCompaction\(\s*\(sessionId\) => panel\.guardedTargetFacts\(sessionId\),\s*\(sessionId\) => compaction\?\.requests\.waitingSessions\(\)\.includes\(sessionId\) \?\? false,\s*\),\s*\);/,
  );
  sourceMatch(
    activate,
    /guardedDeliveryPort\(guardedSends, host, activeWriterFailure, randomUUID, \(child, turnId\) =>\s*compaction\?\.submitted\(child, turnId, 'followup'\),?\s*\)/,
  );
  sourceMatch(
    activate,
    /new GuardedSends<AgentSession>\(channel\?\.hostId \?\? '', \(owner\) =>\s*host\.find\(owner\.child\.agent, owner\.worker\),?\s*\)/,
    'guarded observations require the exact child retained by the host',
  );
  const intervention = activate.indexOf('interveneOnReaderInput(panel, guardedSends);');
  sourceMatch(
    activate,
    /panel\.onArchivedSessionsChange = \(sessions\) => \{\s*compaction\?\.archived\(sessions\);\s*host\.setArchived\(sessions\);/,
  );
  assert.ok(intervention >= 0, 'activate wraps the directing reader callbacks');
  for (const name of ['onSendPrompt', 'onCompact', 'onClear', 'onStopTurn', 'onAnswerAsk']) {
    const assigned = activate.lastIndexOf(`panel.${name} =`);
    assert.ok(assigned >= 0 && assigned < intervention, `the wrapper runs after the last panel.${name} assignment`);
  }
  const draft = statementFrom(activate, activate.indexOf('panel.onSendDraftPrompt ='));
  sourceMatch(draft, /recordGuardedStart\(guardedSends, start, liveSession, prompted\)/);
  const askMode = statementFrom(activate, activate.indexOf('const setAskModeFor ='));
  sourceMatch(askMode, /for \(const state of liveTargets\)[\s\S]*?guardedSends\.invalidate\(state\.sessionId\)/);
  const [handler] = callSources(activate, 'channel?.setGuardedSendHandler');
  assert.ok(handler, 'activate installs the channel guarded send handler');
  sourceMatch(handler, /guardedChannelSend\(guardedSends, request,[\s\S]*panel\.onSendPrompt/);
});

test('Arc CLI targeting reaches fresh, resumed, draft, idle, and rename children for both agents', async () => {
  const cwd = tempDir('arc-child-env-');
  const launch = { ...CLAUDE, env: { Arc_Window: 'foreign', PACKAGE_VALUE: 'kept' } };
  const client = { cwd, clientInfo: CODEX_CLIENT };
  const plans = [
    claudePlan(launch, { cwd }),
    claudePlan(launch, { cwd, resume: 'resumed' }),
    claudePlan(launch, { cwd, sessionId: 'draft' }),
    claudeIdlePlan(launch, cwd),
    codexPlan(launch, client),
    codexPlan(launch, { ...client, resume: 'resumed' }),
    codexIdlePlan(launch, client),
  ];
  const seen: Record<string, string>[] = [];
  const host = new AgentHost({
    idleDurationMs: 60_000,
    spawner: arcCliSpawner(
      () => ({ directory: 'Arc bin', editorExecutable: '/editor', windowId: 'own-window' }),
      (_command, _args, _cwd, env, agent, cli) => {
        assert.ok(cli);
        seen.push(childEnv(process.env, env, agent, cwd, cli) as Record<string, string>);
        throw new Error('captured environment');
      },
    ),
    onEvent: () => {},
    onStateChange: () => {},
  });
  try {
    for (const [index, plan] of plans.entries())
      await assert.rejects(host.session(`env-${index}`, plan), /captured environment/);
    for (const [agent, plan] of [
      ['claude', claudeRenamePlan(launch, { cwd, resume: 'renamed', title: 'Named' })],
      ['codex', codexRenamePlan(launch, { ...client, threadId: 'renamed', title: 'Named' })],
    ] as const)
      await assert.rejects(
        host.renameSession(agent, 'renamed', 'Named', () => plan),
        /captured environment/,
      );
    assert.equal(seen.length, plans.length + 2);
    for (const env of seen) {
      assert.equal(env.ARC_WINDOW, 'own-window');
      assert.equal('Arc_Window' in env, false);
      assert.equal(env.ARC_EDITOR_EXECUTABLE, '/editor');
      assert.equal(env.PACKAGE_VALUE, 'kept');
      const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')!;
      assert.ok(env[key].startsWith('Arc bin' + path.delimiter));
    }
  } finally {
    host.dispose();
  }
});

test('all idle helper entry points replace foreign window targets with the current activation environment', async () => {
  vi.stubEnv('ARC_WINDOW', 'foreign-window');
  const cwd = tempDir('arc-idle-env-');
  const seen: Record<string, string | undefined>[] = [];
  let windowId: string | null = 'own-window';
  const spawner = arcCliSpawner(
    () => ({ directory: 'Arc bin', editorExecutable: '/editor', windowId }),
    (_command, _args, directory, env, agent, cli) => {
      assert.ok(cli);
      seen.push(childEnv(process.env, env, agent, directory, cli));
      throw new Error('captured environment');
    },
  );
  try {
    for (const target of ['own-window', null]) {
      windowId = target;
      for (const plan of [claudeIdlePlan(CLAUDE, cwd), codexIdlePlan(CODEX, { cwd, clientInfo: CODEX_CLIENT })]) {
        await assert.rejects(askIdle(plan, spawner), /captured environment/);
        await assert.rejects(askIdleMcp(plan, spawner), /captured environment/);
        await assert.rejects(askIdleMcpChange(plan, spawner, []), /captured environment/);
        assert.deepEqual(await askIdleDefaults(plan, spawner), {
          status: 'unavailable',
          model: null,
          effort: null,
          reason: 'The agent could not report its settings.',
        });
      }
    }
    assert.equal(seen.length, 16);
    for (const [index, env] of seen.entries()) {
      assert.equal(env.ARC_WINDOW, index < 8 ? 'own-window' : undefined);
      assert.equal(env.ARC_EDITOR_EXECUTABLE, '/editor');
      const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')!;
      assert.ok(env[key]?.startsWith('Arc bin' + path.delimiter));
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

test('idle defaults contain constructor failure for both providers without disposing an absent session', async () => {
  const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
  try {
    for (const plan of [claudeIdlePlan(CLAUDE, WS), codexIdlePlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT })]) {
      assert.deepEqual(
        await askIdleDefaults(plan, () => {
          throw new Error('commands unavailable');
        }),
        {
          status: 'unavailable',
          model: null,
          effort: null,
          reason: 'The agent could not report its settings.',
        },
      );
    }
    assert.equal(dispose.mock.calls.length, 0);
  } finally {
    dispose.mockRestore();
  }
});

test(
  'a spawned child receives no inherited window target when this activation has no channel',
  { tags: ['subprocess'] },
  async () => {
    vi.stubEnv('ARC_WINDOW', 'another-window');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const child = spawnCli(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({window:process.env.ARC_WINDOW ?? null,path:process.env.PATH,editor:process.env.ARC_EDITOR_EXECUTABLE}));',
      ],
      tempDir('arc-spawn-env-'),
      {},
      'codex',
      {
        directory: 'Arc bin',
        editorExecutable: process.execPath,
        windowId: null,
      },
    );
    let closed = false;
    const completion = new Promise<void>((resolve) => {
      child.on('close', () => {
        closed = true;
        resolve();
      });
    });
    onTestFinished(async () => {
      if (!closed) child.kill();
      await completion;
    });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let code: number | null = null;
    let signal: string | null = null;
    await new Promise<void>((resolve, reject) => {
      child.on('error', (error) => {
        reject(new Error(`Child launch failed: ${error.message}\nstderr: ${stderr}`, { cause: error }));
      });
      child.on('exit', (value, stoppedBy) => {
        code = value;
        signal = stoppedBy;
      });
      child.on('close', resolve);
    });
    const diagnostics = `stdout: ${output}\nstderr: ${stderr}`;
    assert.equal(signal, null, diagnostics);
    assert.equal(code, 0, diagnostics);
    assert.ok(output.includes('\n'), diagnostics);
    const env = JSON.parse(output);
    assert.equal(env.window, null);
    assert.ok(env.path.startsWith('Arc bin' + path.delimiter));
    assert.equal(env.editor, process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath);
  },
);

test('absent, empty and invalid billing labels omit Claude attribution and preserve Codex launch variables', () => {
  for (const label of [undefined, '', '   ', 'cli', 'sdk-ts', 'CLAUDE-VSCODE', 'unknown']) {
    const inherited = {
      ARC_CLAUDE_BILLING_LABEL: label,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      Claude_Code_Entrypoint: 'claude-vscode',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '1',
      Claude_Code_Attribution_Header: '1',
      PATH: '/bin',
    };
    for (const agent of ['claude', 'codex'] as const) {
      const wanted = { CLAUDE_CODE_ENTRYPOINT: 'package-label', ARC_CLAUDE_BILLING_LABEL: 'claude-vscode' };
      assert.deepEqual(
        childEnv(inherited, wanted, agent),
        {
          PATH: '/bin',
          ...wanted,
          ELECTRON_RUN_AS_NODE: '1',
          ...(agent === 'claude'
            ? { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' }
            : { CLAUDE_CODE_ATTRIBUTION_HEADER: '1', Claude_Code_Attribution_Header: '1' }),
        },
        `${agent}: ${String(label)}`,
      );
    }
  }
});

test('billing defaults and recognized labels reach every Claude child and preserve Codex environments', () => {
  const launch = {
    ...CLAUDE,
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'package-label',
      Claude_Code_Entrypoint: 'package-other-label',
      CLAUDE_CODE_ATTRIBUTION_HEADER: 'package-attribution',
      Claude_Code_Attribution_Header: 'package-other-attribution',
      PACKAGE_VALUE: 'kept',
    },
  };
  const codexClient = { cwd: WS, clientInfo: CODEX_CLIENT };
  const plans = [
    claudePlan(launch, { cwd: WS, permissionMode: 'manual' }),
    claudePlan(launch, { cwd: WS, resume: 'resumed', permissionMode: 'manual' }),
    claudePlan(launch, { cwd: WS, sessionId: 'draft', permissionMode: 'manual' }),
    claudeRenamePlan(launch, { cwd: WS, resume: 'renamed', title: 'Named', permissionMode: 'manual' }),
    claudeIdlePlan(launch, WS),
    claudeIdlePlan(launch, WS, 'haiku'),
    codexPlan(launch, codexClient),
    codexIdlePlan(launch, codexClient),
    codexRenamePlan(launch, { ...codexClient, threadId: 'thread', title: 'Named' }),
  ];
  for (const label of [undefined, '', '   ', 'unknown', 'sdk-cli', 'claude-vscode', 'omit']) {
    for (const selectorKey of ['ARC_CLAUDE_BILLING_LABEL', 'Arc_Claude_Billing_Label']) {
      const inherited = {
        [selectorKey]: label === undefined ? undefined : ` ${label} `,
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        Claude_Code_Entrypoint: 'inherited-other-label',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '1',
        Claude_Code_Attribution_Header: 'inherited-other-attribution',
        Claude_Agent_Sdk_Version: 'other-version',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'other-client',
        Claude_Code_Remote_Session_Id: 'other-session',
        CLAUDE_CODE_CHILD_SESSION: '1',
        Claude_Code_Container_Id: 'other-container',
        PATH: '/bin',
      };
      for (const plan of plans) {
        let finalEnv: ReturnType<typeof childEnv> = {};
        const session = new AgentSession(
          'env',
          plan,
          (command, args, cwd, env, agent) => {
            assert.equal(command, launch.command);
            assert.deepEqual(args, plan.args);
            assert.equal(cwd, WS);
            assert.equal(agent, plan.agent);
            finalEnv = childEnv(inherited, env, agent);
            return new FakeChild();
          },
          () => {},
          () => {},
        );
        assert.equal(session.agent, plan.agent);
        assert.equal(finalEnv.PATH, '/bin');
        assert.equal(finalEnv.PACKAGE_VALUE, 'kept');
        assert.equal(finalEnv.ELECTRON_RUN_AS_NODE, '1');
        for (const key of Object.keys(finalEnv)) {
          assert.ok(!/^CLAUDE_(AGENT_SDK|CODE_(REMOTE_SESSION_ID|CHILD_SESSION|CONTAINER_ID))/i.test(key));
        }
        if (plan.agent === 'codex') {
          assert.deepEqual(finalEnv, childEnv(inherited, launch.env));
          continue;
        }
        assert.equal(finalEnv.CLAUDE_CODE_ENTRYPOINT, label === 'claude-vscode' ? label : 'sdk-cli');
        assert.equal(
          finalEnv.CLAUDE_CODE_ATTRIBUTION_HEADER,
          label === 'sdk-cli' || label === 'claude-vscode' ? '1' : '0',
        );
        assert.equal('Claude_Code_Entrypoint' in finalEnv, false);
        assert.equal('Claude_Code_Attribution_Header' in finalEnv, false);
        assert.ok(plan.args.includes('-p'));
        assert.ok(plan.args.includes('--permission-prompt-tool'));
        if (plan.args.includes('--permission-mode')) {
          assert.equal(plan.args[plan.args.indexOf('--permission-mode') + 1], 'manual');
        }
      }
    }
  }
});

test('Claude billing selection reads only the local selector and preserves editor precedence', () => {
  const cwd = tempDir('billing-file-');
  const file = path.join(cwd, '.env');
  const inherited = { PATH: '/bin', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' };
  const baseline = childEnv(inherited, {}, 'claude');
  assert.deepEqual(childEnv(inherited, {}, 'claude', cwd), baseline);
  for (const label of ['sdk-cli', 'claude-vscode', 'omit', '', 'unknown']) {
    fs.writeFileSync(
      file,
      `# Local billing selection\r\nexport Arc_Claude_Billing_Label=" ${label} " # selection\r\nPATH=secret\r\nCLAUDE_CODE_ENTRYPOINT=secret\r\n`,
    );
    const env = childEnv(inherited, {}, 'claude', cwd);
    assert.equal(env.PATH, '/bin');
    assert.equal(env.Arc_Claude_Billing_Label, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, label === 'claude-vscode' ? label : 'sdk-cli');
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, label === 'sdk-cli' || label === 'claude-vscode' ? '1' : '0');
    assert.deepEqual(childEnv(inherited, {}, 'codex', cwd), childEnv(inherited, {}, 'codex'));
    for (const editorLabel of ['omit', '', 'unknown']) {
      const editor = { ...inherited, Arc_Claude_Billing_Label: editorLabel };
      assert.deepEqual(childEnv(editor, {}, 'claude', cwd), childEnv(editor, {}, 'claude'));
    }
  }
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => childEnv(inherited, {}, 'claude', cwd));
  assert.deepEqual(childEnv(inherited, {}, 'codex', cwd), childEnv(inherited, {}, 'codex'));
});

test(
  'spawnCli reads changed billing files for fresh Claude children without loading other variables',
  { tags: ['subprocess'] },
  async () => {
    const cwd = tempDir('billing-spawn-file-');
    const file = path.join(cwd, '.env');
    try {
      vi.stubEnv('ARC_CLAUDE_BILLING_LABEL', undefined);
      vi.stubEnv('CLAUDE_CODE_ATTRIBUTION_HEADER', '1');
      for (const [label, agent] of [
        [undefined, 'claude'],
        ['claude-vscode', 'claude'],
        ['omit', 'claude'],
        ['claude-vscode', 'codex'],
      ] as const) {
        if (label !== undefined)
          fs.writeFileSync(file, `ARC_CLAUDE_BILLING_LABEL=${label}\nARC_ENV_FILE_ONLY=secret\n`);
        if (agent === 'codex') {
          const env = childEnv(process.env, {}, agent, cwd);
          assert.deepEqual(
            [env.CLAUDE_CODE_ENTRYPOINT, env.CLAUDE_CODE_ATTRIBUTION_HEADER, env.ARC_ENV_FILE_ONLY],
            [undefined, '1', undefined],
          );
          continue;
        }
        const script =
          'process.stdout.write(JSON.stringify([process.env.CLAUDE_CODE_ENTRYPOINT, process.env.CLAUDE_CODE_ATTRIBUTION_HEADER, process.env.ARC_ENV_FILE_ONLY]))';
        const child = spawnCli(process.execPath, ['-e', script], cwd, {}, agent);
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        let code: number | null = null;
        await new Promise<void>((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (value) => {
            code = value;
          });
          child.on('close', resolve);
        });
        assert.equal(code, 0);
        assert.deepEqual(
          JSON.parse(output),
          agent === 'claude'
            ? [label === 'claude-vscode' ? label : 'sdk-cli', label === 'claude-vscode' ? '1' : '0', null]
            : [null, '1', null],
        );
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test(
  'spawnCli applies the host billing label to the actual Claude child environment',
  { tags: ['subprocess'] },
  async () => {
    try {
      vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
      vi.stubEnv('CLAUDE_CODE_ATTRIBUTION_HEADER', '1');
      for (const label of [undefined, 'sdk-cli', 'claude-vscode', 'omit']) {
        vi.stubEnv('ARC_CLAUDE_BILLING_LABEL', label);
        for (const agent of ['claude', 'codex'] as const) {
          const cwd = tempDir('billing-env-');
          const env = childEnv(process.env, {}, agent, cwd);
          const expected =
            agent === 'claude'
              ? [
                  label === 'claude-vscode' ? label : 'sdk-cli',
                  label === 'sdk-cli' || label === 'claude-vscode' ? '1' : '0',
                ]
              : [undefined, '1'];
          assert.deepEqual([env.CLAUDE_CODE_ENTRYPOINT, env.CLAUDE_CODE_ATTRIBUTION_HEADER], expected);
          if (label === 'omit' || (agent === 'codex' && label === 'sdk-cli')) continue;
          const script =
            'process.stdout.write(JSON.stringify([process.env.CLAUDE_CODE_ENTRYPOINT, process.env.CLAUDE_CODE_ATTRIBUTION_HEADER]))';
          const child = spawnCli(process.execPath, ['-e', script], cwd, {}, agent);
          let output = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          let code: number | null = null;
          await new Promise<void>((resolve, reject) => {
            child.on('error', reject);
            child.on('exit', (value) => {
              code = value;
            });
            child.on('close', resolve);
          });
          assert.equal(code, 0);
          assert.deepEqual(
            JSON.parse(output),
            expected.map((value) => value ?? null),
          );
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test('a reused Claude child keeps its billing label after the host environment changes', async () => {
  const children: FakeChild[] = [];
  const envs: ReturnType<typeof childEnv>[] = [];
  const host = new AgentHost({
    idleDurationMs: 0,
    spawner: (_command, _args, _cwd, env, agent) => {
      envs.push(childEnv(process.env, env, agent));
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    onEvent: () => {},
    onStateChange: () => {},
  });
  try {
    vi.stubEnv('ARC_CLAUDE_BILLING_LABEL', 'claude-vscode');
    const plan = claudePlan(CLAUDE, { cwd: WS, sessionId: 'draft' });
    const opening = host.session('draft', plan);
    children[0].answerHandshake();
    const first = await opening;
    vi.stubEnv('ARC_CLAUDE_BILLING_LABEL', 'omit');
    assert.equal(await host.session('draft', plan), first);
    assert.equal(children.length, 1);
    assert.equal(children[0].ended, false);
    assert.equal(children[0].killed, false);
    assert.equal(envs[0].CLAUDE_CODE_ENTRYPOINT, 'claude-vscode');
    assert.equal(envs[0].CLAUDE_CODE_ATTRIBUTION_HEADER, '1');
  } finally {
    vi.unstubAllEnvs();
    host.dispose();
    for (const child of children) child.exit(0);
  }
});

test('a mode meant for the other agent is refused rather than turned into a default', () => {
  assert.equal(claudeAskMode(CLAUDE_ASK_MODES[1]), CLAUDE_ASK_MODES[1].claude);
  assert.deepEqual(codexAskMode(CODEX_ASK_MODES[2]), CODEX_ASK_MODES[2].codex);
  // Sending a default in its place would put the child in a state nobody picked, while the
  // panel went on drawing the one that was.
  assert.throws(() => claudeAskMode(CODEX_ASK_MODES[0]), /Claude Code/);
  assert.throws(() => codexAskMode(CLAUDE_ASK_MODES[0]), /Codex/);
});

test('Claude launch plans omit the permission flag only for the agent default', () => {
  const inherited = claudePlan(CLAUDE, { cwd: WS }).args;
  const explicit = claudePlan(CLAUDE, { cwd: WS, permissionMode: 'manual' }).args;
  assert.equal(inherited.includes('--permission-mode'), false);
  assert.equal(explicit[explicit.indexOf('--permission-mode') + 1], 'manual');
});

test('how much an agent asks reaches each CLI the way that CLI takes it', { timeout: 5000 }, async () => {
  const h = fakeHost();
  const opening = h.host.session('claude:ws', claudePlan(CLAUDE, { cwd: WS }));
  const claudeChild = h.children[0];
  claudeChild.answerHandshake();
  const claude = await opening;
  // A Claude permission change settles only after its control response arrives.

  const changed = claude.setAskMode(CLAUDE_ASK_MODES[2]);
  // Claude takes it at once, as its own control request, so a turn already running feels
  // the change.
  const asked = claudeChild.sent().find((m) => (m.request as { subtype: string }).subtype === 'set_permission_mode');
  assert.equal((asked?.request as { mode?: string } | undefined)?.mode, CLAUDE_ASK_MODES[2].claude);
  claudeChild.answerControl('set_permission_mode', {});
  await changed;

  const openingCodex = h.host.session('codex:ws', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = h.children[1];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-1' } });
  const codex = await openingCodex;
  await codex.setAskMode(CODEX_ASK_MODES[3]);
  // Codex sends permission settings on the next turn rather than as a separate approval request.

  assert.equal(
    child.sent().some((m) => String(m.method).includes('approval')),
    false,
  );
  void codex.prompt('go');
  await tick();
  const turn = child.sent().find((m) => m.method === 'turn/start');
  const params = turn?.params as {
    approvalPolicy?: string;
    approvalsReviewer?: string;
    sandboxPolicy?: unknown;
    sandbox?: string;
  };
  assert.equal(params.approvalPolicy, CODEX_ASK_MODES[3].codex?.approvalPolicy);
  assert.equal(params.approvalsReviewer, CODEX_ASK_MODES[3].codex?.approvalsReviewer);
  // The turn carries sandboxPolicy with the approval policy. Thread setup uses a different sandbox field.

  assert.deepEqual(params.sandboxPolicy, sandboxPolicy(CODEX_ASK_MODES[3].codex!.sandbox));
  assert.equal(params.sandbox, undefined);
});

test('an untouched Codex draft opens and sends with Approve for me', async () => {
  const draft = newSessionDraft('draft-codex', WS, null, 0, {
    agent: 'codex',
    model: 'gpt-5',
    effort: '',
    permissionMode: defaultAskMode('codex').value,
    source: 'inherited',
  });
  const mode = askMode(draft.profile.agent, draft.profile.permissionMode);
  assert.ok(mode);
  assert.equal(mode.label, 'Approve for me');
  const { host, children } = fakeHost();
  const starting = host.session(
    'cx',
    codexPlan(CODEX, {
      cwd: draft.cwd,
      clientInfo: CODEX_CLIENT,
      model: draft.profile.model,
      ...codexAskMode(mode),
    }),
  );
  const child = children[0];
  await answerCodexHandshake(child);
  const start = child.sent().find((m) => m.method === 'thread/start');
  const params = start?.params as {
    approvalPolicy?: string;
    approvalsReviewer?: string;
    sandbox?: string;
    model?: string;
  };
  assert.equal(params.approvalPolicy, 'on-request');
  assert.equal(params.approvalsReviewer, 'auto_review');
  assert.equal(params.sandbox, 'workspace-write');
  assert.equal(params.model, 'gpt-5', 'a session has to open the way the reader left it');
  child.reply({ thread: { id: 'thread-7' } });
  const session = await starting;
  void session.prompt('go');
  await tick();
  const turn = child.sent().find((m) => m.method === 'turn/start');
  const turnParams = turn?.params as { approvalPolicy?: string; approvalsReviewer?: string };
  assert.equal(turnParams.approvalPolicy, 'on-request');
  assert.equal(turnParams.approvalsReviewer, 'auto_review');
});

test(
  'a model pick reaches a live Claude child, and a Codex one waits for the next session',
  { timeout: 5000 },
  async () => {
    const h = fakeHost();
    const opening = h.host.session('claude:ws', claudePlan(CLAUDE, { cwd: WS }));
    h.children[0].answerHandshake();
    const claude = await opening;
    const changed = claude.setModel('opus');
    const asked = h.children[0].sent().find((m) => (m.request as { subtype: string }).subtype === 'set_model');
    assert.equal((asked?.request as { model?: string } | undefined)?.model, 'opus');
    h.children[0].answerControl('set_model', {});
    await changed;

    const openingCodex = h.host.session('codex:ws', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
    const child = h.children[1];
    await answerCodexHandshake(child);
    child.reply({ thread: { id: 'thread-1' } });
    const codex = await openingCodex;
    const before = child.sent().length;
    await codex.setModel('gpt-5');
    // A Codex model change sends no immediate request. The next turn/start carries the selected model.

    assert.equal(child.sent().length, before);
    void codex.prompt('go');
    await tick();
    const turn = child.sent().find((m) => m.method === 'turn/start');
    assert.equal((turn?.params as { model?: string } | undefined)?.model, 'gpt-5');
  },
);

test('a model pick in one live Codex session leaves its sibling unchanged', { timeout: 5000 }, async () => {
  const h = fakeHost();
  const firstOpening = h.host.session('codex:first', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  await answerCodexHandshake(h.children[0]);
  h.children[0].reply({ thread: { id: 'thread-1' } });
  const first = await firstOpening;

  const siblingOpening = h.host.session('codex:sibling', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  await answerCodexHandshake(h.children[1]);
  h.children[1].reply({ thread: { id: 'thread-2' } });
  const sibling = await siblingOpening;

  await first.setModel('gpt-5.6-sol');
  void first.prompt('first');
  void sibling.prompt('sibling');
  await tick();
  const firstTurn = h.children[0].sent().find((m) => m.method === 'turn/start');
  const siblingTurn = h.children[1].sent().find((m) => m.method === 'turn/start');
  assert.equal((firstTurn?.params as { model?: string } | undefined)?.model, 'gpt-5.6-sol');
  assert.equal(
    (siblingTurn?.params as { model?: string } | undefined)?.model,
    undefined,
    'changing one session changed another live child of the same agent',
  );
});

test('a failed Claude model control rejects the setting change', async () => {
  const h = fakeHost();
  const opening = h.host.session('claude:session', claudePlan(CLAUDE, { cwd: WS }));
  h.children[0].answerHandshake();
  const claude = await opening;
  const changed = claude.setModel('sonnet');
  h.children[0].rejectControl('set_model', 'model unavailable');
  await assert.rejects(changed, /model unavailable/);
});

test('an effort pick reaches each agent by the only door that agent has', { timeout: 5000 }, async () => {
  // Claude takes a level when its child is started, and changes it afterwards through the
  // CLI's own command on the same input a prompt uses, because the control channel has no
  // subtype for one. Codex takes it on the turn.
  assert.equal(claudePlan(CLAUDE, { cwd: WS }).args.includes('--effort'), false);
  const started = claudePlan(CLAUDE, { cwd: WS, model: 'opus', effort: 'xhigh' }).args;
  assert.equal(started[started.indexOf('--effort') + 1], 'xhigh');

  const h = fakeHost();
  const opening = h.host.session('claude:ws', claudePlan(CLAUDE, { cwd: WS }));
  h.children[0].answerHandshake();
  const claude = await opening;
  const controls = () => h.children[0].sent().filter((message) => message.type === 'control_request').length;
  const asked = controls();
  await claude.setEffort('high');
  assert.deepEqual(
    h.children[0].sent().at(-1)?.message,
    {
      role: 'user',
      content: [{ type: 'text', text: '/effort high' }],
    },
    'the level change reached the live child as something other than its own command',
  );
  assert.equal(
    controls(),
    asked,
    'the CLI answers no control request for an effort level, so one sent would hang or be refused',
  );
  assert.equal(claude.state().busy, true, 'the command ends with a result, so it owes the session a turn');
  h.children[0].say(
    JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', result: '' }) + '\n',
  );
  assert.equal(claude.state().busy, false);

  const openingCodex = h.host.session(
    'codex:ws',
    codexPlan(CODEX, {
      cwd: WS,
      clientInfo: CODEX_CLIENT,
      model: 'gpt-5',
      effort: 'medium',
    }),
  );
  const child = h.children[1];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-1' } });
  const codex = await openingCodex;
  const openingPrompt = codex.prompt('opening');
  await tick();
  const opened = child.sent().find((m) => m.method === 'turn/start');
  assert.deepEqual(
    opened?.params,
    {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'opening' }],
      model: 'gpt-5',
      effort: 'medium',
    },
    'a thread carries no effort field at all, so the pick has nowhere to go but the turn',
  );
  child.reply({ turn: { id: 'turn-opening' } });
  await openingPrompt;
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-opening', status: 'completed', items: [] } },
    }) + '\n',
  );

  await codex.setEffort('xhigh');
  void codex.prompt('after');
  await tick();
  const after = child.sent().filter((m) => m.method === 'turn/start')[1];
  assert.equal((after?.params as { effort?: string } | undefined)?.effort, 'xhigh');
});

test(
  'an effort pick reaches a resumed Codex thread, which was opened by somebody else',
  { timeout: 5000 },
  async () => {
    const h = fakeHost();
    const opening = h.host.session(
      'codex:ws',
      codexPlan(CODEX, {
        cwd: WS,
        clientInfo: CODEX_CLIENT,
        resume: 'thread-7',
        effort: 'high',
      }),
    );
    const child = h.children[0];
    await answerCodexHandshake(child);
    child.reply({ thread: { id: 'thread-7' } });
    const codex = await opening;
    void codex.prompt('go');
    await tick();
    const turn = child.sent().find((m) => m.method === 'turn/start');
    assert.equal(
      (turn?.params as { effort?: string } | undefined)?.effort,
      'high',
      'a thread asked for by id is told nothing about the level the reader picked',
    );
  },
);

test('one idle child answers both the figures and the model list', { timeout: 5000 }, async () => {
  const plan = claudeIdlePlan(CLAUDE, WS);
  // The one difference from a plan that will be prompted, and the reason a read costs
  // nothing on disk: the CLI is told not to keep the session it would otherwise write.
  assert.ok(plan.args.includes('--no-session-persistence'));
  assert.equal(plan.args.includes('--resume'), false);

  const probe = idleProbe(plan);
  await tick();
  const child = probe.children[0];
  child.answerHandshake();
  await tick();
  // The idle child sends initialize, get_usage, and list_models without a prompt. MCP status uses a separate read.

  const asked = child.sent().map((m) => (m.request as { subtype: string }).subtype);
  // MCP status can wait for server startup. Keep it separate so it cannot delay usage and model figures.

  assert.deepEqual(asked, ['initialize', 'get_usage', 'list_models']);
  child.answerControl('get_usage', {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 24, resets_at: '2026-08-28T08:59:59.500Z' } },
  });
  child.answerControl('list_models', {
    models: [{ value: 'opus', displayName: 'Opus', description: 'Thinks hardest' }],
  });
  const answers = await probe.answers;
  assert.ok(answers.usage !== 'unavailable');
  assert.equal(answers.usage?.plan, 'max');
  assert.equal(answers.usage?.limits[0].utilization, 0.24);
  assert.deepEqual(
    answers.models?.models.map((m) => m.label),
    ['Opus'],
  );
  assert.equal(child.ended, true, 'the read left its child running');
});

for (const hosted of [false, true]) {
  test(`Claude ${hosted ? 'hosted' : 'fresh idle'} reads preserve explicit unavailable limits`, async () => {
    const children: FakeChild[] = [];
    const plan = claudeIdlePlan(CLAUDE, WS);
    const spawner = () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    const published: unknown[] = [];
    const session = hosted
      ? new AgentSession(
          'one',
          plan,
          spawner,
          () => {},
          () => {},
        )
      : null;
    const answer = session
      ? session.start().then(() => session.rateLimits(true))
      : askIdle(
          plan,
          spawner,
          undefined,
          (reading, failure) => published.push({ reading, failure }),
          undefined,
          undefined,
          true,
        );
    await vi.waitFor(() => assert.equal(children.length, 1));
    const child = children[0];
    child.answerHandshake();
    await vi.waitFor(() =>
      assert.ok(child.sent().some((m) => (m.request as { subtype: string }).subtype === 'get_usage')),
    );
    child.answerControl('get_usage', { subscription_type: 'max', rate_limits_available: false, rate_limits: {} });
    if (!hosted) child.answerControl('list_models', { models: [] });
    try {
      if (hosted) assert.equal(await answer, 'unavailable');
      else {
        const answers = (await answer) as IdleAnswers;
        assert.equal(answers.usage, 'unavailable');
        assert.equal(answers.usageFailure, '');
        assert.deepEqual(published, [{ reading: 'unavailable', failure: '' }]);
      }
    } finally {
      const disposing = session?.dispose();
      child.exit(0);
      await disposing;
    }
  });
}

test('the idle child brings back the command list, which is the only way a quiet panel gets one', async () => {
  // The idle handshake returns command completions before a session receives its first prompt. Retain that catalog in the idle answer.

  const probe = idleProbe(claudeIdlePlan(CLAUDE, WS));
  await tick();
  const child = probe.children[0];
  child.answerHandshake([
    { name: 'compact', description: 'Compact the session', argumentHint: '' },
    { name: 'commit', description: 'Write a commit', argumentHint: '<message>' },
  ]);
  await tick();
  child.answerControl('get_usage', { subscription_type: 'max', rate_limits_available: false, rate_limits: {} });
  child.answerControl('list_models', { models: [] });
  const answers = await probe.answers;
  assert.deepEqual(
    answers.commands.map((c) => c.name),
    ['compact', 'commit'],
    'the child answered the handshake with a command list and the read did not carry it back',
  );
  // The argument hint rides with it. The menu draws it, so a list that arrived stripped of it
  // would look right and say less than the agent did.
  assert.deepEqual(
    answers.commands.map((c) => c.argumentHint),
    ['', '<message>'],
  );
});

test('an agent that publishes no commands answers with none rather than failing the read', async () => {
  const probe = idleProbe(claudeIdlePlan(CLAUDE, WS));
  await tick();
  const child = probe.children[0];
  child.answerHandshake();
  await tick();
  child.answerControl('get_usage', { subscription_type: 'max', rate_limits_available: false, rate_limits: {} });
  child.answerControl('list_models', { models: [] });
  const answers = await probe.answers;
  assert.deepEqual(answers.commands, [], 'an agent with no commands is not an agent that failed');
});

test('mixed Claude and Bedrock idle reads exclude Codex before limits and release refresh before catalogs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const book = new UsageBook();
  const reading: UsageReading = {
    plan: 'max',
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt: Date.now(),
    limits: [{ window: 'five_hour', group: 'session', scope: '', utilization: 0.2, resetsAtSeconds: null, status: '' }],
  };
  book.note('claude', reading);
  book.note('codex', { ...reading, plan: 'plus' });
  const states: import('./view/usage').UsageRefresh[] = [];
  const bars: ReturnType<typeof usageBar>[] = [];
  const publish = () => bars.push(usageBar(book.usages(), Date.now(), states.at(-1)));
  const queue = new UsageReadQueue((state) => {
    states.push(state);
    publish();
  });
  const children: FakeChild[] = [];
  const held: Promise<void>[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const id = queue.begin(['claude', 'codex'])!;
    assert.ok(id);
    queue.result('claude', id, 'success');
    const run = queue.run(
      'codex',
      true,
      async (_force, operation) => {
        let revision = 0;
        await askIdle(
          codexIdlePlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }),
          () => {
            const child = new FakeChild();
            children.push(child);
            return child;
          },
          undefined,
          () => assert.fail('Bedrock published a subscription result'),
          () => queue.current('codex', id),
          (supported, source) => {
            if (supported === null) {
              revision = book.beginDiscovery('codex', source);
              return true;
            }
            assert.equal(book.resolveDiscovery('codex', source, revision, supported), true);
            if (!supported) {
              publish();
              queue.result('codex', id, 'excluded', '', operation);
              return false;
            }
            return queue.reading('codex', id, operation);
          },
          true,
        );
      },
      '',
      id,
    );
    held.push(run);
    await vi.advanceTimersByTimeAsync(0);
    const child = children[pass];
    child.reply({ userAgent: 'codex' });
    await vi.advanceTimersByTimeAsync(0);
    child.reply({ data: [{ cwd: WS, skills: [] }] });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(
      child
        .sent()
        .filter((m) => m.method === 'account/read')
        .map((m) => m.params),
      [{ refreshToken: false }],
    );
    child.replyTo('account/read', { account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(states.at(-1)?.agents.codex.phase, 'excluded');
    assert.equal(vi.getTimerCount(), pass + 1, 'only the outstanding catalog wire deadlines remain');
    assert.deepEqual(
      book.usages().map((u) => u.agent),
      ['claude'],
    );
    const bar = bars.at(-1)!;
    assert.deepEqual(
      bar.groups.map((g) => g.agent),
      ['claude'],
    );
    assert.doesNotMatch(bar.name + bar.refresh!.name + bar.refresh!.announcement, /Codex/);
    assert.equal(bar.refresh!.busy, false);
    assert.equal(
      child.sent().some((m) => m.method === 'account/rateLimits/read'),
      false,
    );
    assert.equal(
      child.sent().some((m) => typeof m.method === 'string' && /thread|turn|mcp/.test(m.method)),
      false,
    );
    assert.equal(child.ended, false, 'catalog is still held');
  }
  for (const bar of bars) {
    assert.doesNotMatch(bar?.refresh?.name ?? '', /Codex/);
    assert.doesNotMatch(bar?.refresh?.announcement ?? '', /Codex/);
    assert.equal(bar?.groups.find((g) => g.agent === 'codex')?.status ?? '', '');
  }
  for (const child of children) child.replyTo('model/list', { data: [] });
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(held);
  for (const child of children) child.exit(0, null);
  await vi.advanceTimersByTimeAsync(0);
  queue.dispose();
  assert.equal(vi.getTimerCount(), 0);
});

test('a Codex idle child answers both questions and still starts no thread', { timeout: 5000 }, async () => {
  const probe = idleProbe(codexIdlePlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  await tick();
  const child = probe.children[0];
  await answerCodexHandshake(child, [{ name: 'polish', description: 'Clean the writing' }]);
  // The skills list, but no thread: autocomplete needs the first and the second would leave
  // a session on disk the reader never asked for.
  const methods = child.sent().map((m) => m.method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'skills/list', 'account/read', 'model/list']);
  child.replyTo('account/read', { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.ok(child.sent().some((m) => m.method === 'account/rateLimits/read')));
  child.replyTo('account/rateLimits/read', {
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1787924682 },
      secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1788470887 },
    },
  });
  child.replyTo('model/list', {
    data: [
      {
        id: 'gpt-5',
        displayName: 'GPT-5',
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thinks for longer' }],
      },
    ],
  });
  const answers = await probe.answers;
  assert.ok(answers.usage !== 'unavailable');
  assert.deepEqual(
    answers.commands.map((command) => command.name),
    ['compact', 'clear', 'new', 'rename', 'polish'],
  );
  assert.equal(answers.usage?.plan, 'plus');
  assert.deepEqual(
    answers.usage?.limits.map((l) => l.window),
    ['five_hour', 'seven_day'],
  );
  assert.deepEqual(
    answers.models?.models.map((m) => m.value),
    ['gpt-5'],
  );
  assert.deepEqual(
    answers.models?.models[0].efforts.map((e) => e.description),
    ['Thinks for longer'],
  );
  assert.equal(child.ended, true, 'the read left its child running');
});

test('a rejected Codex skill list leaves the idle usage and models available', { timeout: 5000 }, async () => {
  const probe = idleProbe(codexIdlePlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  await tick();
  const child = probe.children[0];
  child.reply({ userAgent: 'codex' });
  await tick();
  child.replyError(-32601, 'Method not found');
  await tick();
  assert.deepEqual(
    child.sent().map((message) => message.method),
    ['initialize', 'initialized', 'skills/list', 'account/read', 'model/list'],
  );
  child.replyTo('account/read', { account: { type: 'chatgpt' } });
  await vi.waitFor(() => assert.ok(child.sent().some((m) => m.method === 'account/rateLimits/read')));
  child.replyTo('account/rateLimits/read', {
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1787924682 },
      secondary: null,
    },
  });
  child.replyTo('model/list', {
    data: [{ id: 'gpt-5', displayName: 'GPT-5', supportedReasoningEfforts: [] }],
  });
  const answers = await probe.answers;
  assert.ok(answers.usage !== 'unavailable');
  assert.deepEqual(
    answers.commands.map((command) => command.name),
    ['compact', 'clear', 'new', 'rename'],
  );
  assert.equal(answers.usage?.plan, 'plus');
  assert.deepEqual(
    answers.models?.models.map((model) => model.value),
    ['gpt-5'],
  );
});

test('a model list that will not come back leaves the figures alone', async () => {
  const reading: UsageReading = {
    plan: 'max',
    limits: [],
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt: 7,
  };
  const answers = await askIdle(
    answeringPlan({
      usage: () => Promise.resolve(reading),
      models: () => Promise.reject(new Error('the CLI does not know list_models')),
    }),
    () => new FakeChild(),
  );
  assert.deepEqual(answers.usage, reading, 'the process start was paid for and its answer thrown away');
  assert.equal(answers.models, null);
});

test('figures that will not come back leave the model list alone', async () => {
  const answers = await askIdle(
    answeringPlan({
      usage: () => Promise.reject(new Error('rate limits are not available')),
      models: () => Promise.resolve(A_MODEL_LIST),
    }),
    () => new FakeChild(),
  );
  assert.equal(answers.usage, null);
  assert.equal(answers.usageFailure, 'rate limits are not available');
  assert.deepEqual(answers.models, A_MODEL_LIST);
});

test('an explicit usage read waits behind an automatic read without losing its force', async () => {
  const queue = new UsageReadQueue();
  const calls: boolean[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const automatic = queue.run('codex', false, async (force) => {
    calls.push(force);
    await gate;
  });
  await tick();
  const explicit = queue.run('codex', true, async (force) => {
    calls.push(force);
  });
  assert.deepEqual(calls, [false]);
  release();
  await Promise.all([automatic, explicit]);
  assert.deepEqual(calls, [false, true]);
});

test('same-agent usage reads share only when they target the same MCP owner', async () => {
  const queue = new UsageReadQueue();
  const calls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(
    'claude',
    false,
    async () => {
      calls.push('session-1');
      await gate;
    },
    'session-1',
  );
  await tick();
  const second = queue.run(
    'claude',
    false,
    async () => {
      calls.push('session-2');
    },
    'session-2',
  );
  const shared = queue.run(
    'claude',
    false,
    async () => {
      calls.push('duplicate session-2');
    },
    'session-2',
  );

  assert.deepEqual(calls, ['session-1']);
  release();
  await Promise.all([first, second, shared]);
  assert.deepEqual(calls, ['session-1', 'session-2']);
});

test('same-owner usage reads do not share across an MCP profile generation', async () => {
  const queue = new UsageReadQueue();
  const calls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const older = queue.run(
    'claude',
    false,
    async () => {
      calls.push('claude profile');
      await gate;
    },
    'draft-1:0',
  );
  await tick();
  const replacement = queue.run(
    'claude',
    false,
    async () => {
      calls.push('codex replacement');
    },
    'draft-1:2',
  );

  release();
  await Promise.all([older, replacement]);
  assert.deepEqual(
    calls,
    ['claude profile', 'codex replacement'],
    'the replacement profile shared the stale owner request and received no discovery',
  );
});

test('an explicit usage read remains pending until a busy agent is idle', async () => {
  const queue = new UsageReadQueue();
  assert.equal(queue.waitUntilIdle('codex', false), null);
  let read = false;
  const explicit = queue.run('codex', true, async (force) => {
    const waiting = queue.waitUntilIdle('codex', force);
    if (waiting) {
      await waiting;
    }
  });
  await tick();
  const resumed = queue.resumeDeferred('codex', async () => {
    read = true;
  });
  assert.notEqual(resumed, null);
  await resumed;
  await explicit;
  assert.equal(read, true);
  assert.equal(
    queue.resumeDeferred('codex', async () => {}),
    null,
  );
});

test('a busy agent that exits rejects its deferred explicit usage read', async () => {
  const queue = new UsageReadQueue();
  const explicit = queue.run('codex', true, async (force) => {
    const waiting = queue.waitUntilIdle('codex', force);
    if (waiting) {
      await waiting;
    }
  });
  await tick();
  assert.equal(queue.failDeferred('codex', new Error('the agent stopped')), true);
  await assert.rejects(explicit, /the agent stopped/);
});

test('a manual usage deadline cancels queued work and a retry reads once after the automatic answer', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  let release = () => {};
  const automatic = queue.run(
    'codex',
    false,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const calls: number[] = [];
  const expired = queue.begin(['codex'])!;
  const old = queue.run(
    'codex',
    true,
    async () => {
      calls.push(expired);
    },
    '',
    expired,
  );
  assert.equal(queue.begin(['codex']), null);
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_DEADLINE_MS);
  assert.equal(states.at(-1)?.agents.codex.phase, 'failed');
  const retry = queue.begin(['codex'])!;
  const next = queue.run(
    'codex',
    true,
    async () => {
      calls.push(retry);
      queue.result('codex', retry, 'success');
    },
    '',
    retry,
  );
  release();
  await Promise.all([automatic, old, next]);
  assert.deepEqual(calls, [retry]);
  assert.equal(states.at(-1)?.agents.codex.phase, 'success');
  assert.equal(vi.getTimerCount(), 0);
  queue.dispose();
});

test('unsupported completion releases joined attempts and deferred waits while catalogs remain held', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  let finishCatalog = () => {};
  let operation = 0;
  const automatic = queue.run('codex', true, async (_force, current) => {
    operation = current;
    queue.reading('codex', undefined, current);
    await new Promise<void>((resolve) => {
      finishCatalog = resolve;
    });
  });
  await vi.advanceTimersByTimeAsync(0);
  const id = queue.begin(['codex'])!;
  const joined = queue.run('codex', true, async () => assert.fail('joined read dispatched'), '', id);
  const deferred = queue.waitUntilIdle('codex', true, id, operation)!;
  queue.result('codex', undefined, 'excluded', '', operation);
  await Promise.all([joined, deferred]);
  assert.equal(states.at(-1)?.agents.codex.phase, 'excluded');
  assert.equal(vi.getTimerCount(), 0);
  const retryId = queue.begin(['codex'])!;
  await queue.run(
    'codex',
    true,
    async (_force, next) => {
      queue.result('codex', retryId, 'excluded', '', next);
    },
    '',
    retryId,
  );
  finishCatalog();
  await automatic;
  assert.equal(states.at(-1)?.id, retryId);
  assert.equal(states.at(-1)?.agents.codex.phase, 'excluded');
  queue.dispose();
});

test('late Bedrock classification removes expired failure feedback and leaves the next retry available', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  let answer = () => {};
  const id = queue.begin(['codex'])!;
  const read = queue.run(
    'codex',
    true,
    async (_force, operation) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      queue.result('codex', id, 'excluded', '', operation);
    },
    '',
    id,
  );
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_DEADLINE_MS);
  assert.equal(states.at(-1)?.agents.codex.phase, 'failed');
  answer();
  await read;
  assert.equal(states.at(-1)?.agents.codex.phase, 'excluded');
  assert.ok(queue.begin(['codex']));
  queue.dispose();
});

test('both busy agents finish visibly at the accepted-press deadline and can retry', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  const id = queue.begin(['claude', 'codex'])!;
  const work = ['claude', 'codex'].map((agent) =>
    queue.run(
      agent,
      true,
      async () => {
        await queue.waitUntilIdle(agent, true, id);
      },
      '',
      id,
    ),
  );
  const settled = Promise.allSettled(work);
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_DEADLINE_MS - 1);
  assert.equal(states.at(-1)?.agents.claude.phase, 'waiting');
  assert.equal(states.at(-1)?.agents.codex.phase, 'discovering');
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  assert.equal(states.at(-1)?.agents.claude.phase, 'failed');
  assert.equal(states.at(-1)?.agents.codex.phase, 'failed');
  assert.equal(
    queue.resumeDeferred('codex', async () => assert.fail('expired read dispatched')),
    null,
  );
  assert.ok(queue.begin(['claude', 'codex']));
  queue.dispose();
  assert.equal(vi.getTimerCount(), 0);
});

test('an accepted manual read stops waiting after 120 seconds even when no turn ends', async () => {
  vi.useFakeTimers();
  const queue = new UsageReadQueue();
  const id = queue.begin?.(['codex']) ?? undefined;
  let settled = false;
  const work = queue.run(
    'codex',
    true,
    async (force) => {
      await queue.waitUntilIdle('codex', force, id);
    },
    '',
    id,
  );
  const completed = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(120_000);
  assert.equal(settled, true, 'the manual read remains pending after its 120-second limit without a turn ending');
  await completed;
  queue.dispose();
});

test('a delayed deadline callback cannot admit an expired usage read', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const queue = new UsageReadQueue();
  const id = queue.begin(['codex'])!;
  vi.setSystemTime(120_000);
  let dispatched = false;
  await queue.run(
    'codex',
    true,
    async () => {
      dispatched = true;
    },
    '',
    id,
  );
  assert.equal(dispatched, false);
  assert.equal(queue.reading('codex', id), false);
  queue.dispose();
  assert.equal(vi.getTimerCount(), 0);
});

test('a retry joins a resumed usage read after its deadline without a second authentication renewal', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  const id = queue.begin(['codex'])!;
  const original = queue.run(
    'codex',
    true,
    async () => {
      await queue.waitUntilIdle('codex', true, id);
    },
    '',
    id,
  );
  await vi.advanceTimersByTimeAsync(0);
  let release = () => {};
  let renewals = 0;
  const resumed = queue.resumeDeferred('codex', async (attempt) => {
    assert.equal(queue.reading('codex', attempt), true);
    renewals++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.result('codex', attempt, 'success');
  });
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_DEADLINE_MS);
  const deadline = states.at(-1)!;
  assert.equal(deadline.agents.codex.phase, 'failed');
  const retry = queue.begin(['codex'])!;
  const joined = queue.run(
    'codex',
    true,
    async () => {
      renewals++;
    },
    '',
    retry,
  );
  assert.equal(states.at(-1)?.agents.codex.phase, 'reading');
  release();
  await Promise.all([original, resumed, joined]);
  assert.equal(renewals, 1);
  assert.equal(states.at(-1)?.id, retry);
  assert.equal(states.at(-1)?.agents.codex.phase, 'success');
  assert.equal(deadline.agents.codex.phase, 'failed');
  assert.equal(vi.getTimerCount(), 0);
  queue.dispose();
});

test('usage failures, exit, stale completions, and disposal clear attempt clocks without false success', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  const first = queue.begin(['claude', 'codex'])!;
  queue.result('claude', first, 'success');
  assert.equal(states.at(-1)?.agents.codex.phase, 'discovering');
  const failed = queue.run(
    'codex',
    true,
    async () => {
      await queue.waitUntilIdle('codex', true, first);
    },
    '',
    first,
  );
  const rejected = assert.rejects(failed, /agent stopped/);
  await vi.advanceTimersByTimeAsync(0);
  queue.failDeferred('codex', new Error('agent stopped'));
  await rejected;
  assert.equal(states.at(-1)?.agents.codex.phase, 'failed');
  assert.equal(vi.getTimerCount(), 0);
  const retry = queue.begin(['claude', 'codex'])!;
  queue.result('claude', first, 'success');
  assert.equal(states.at(-1)?.agents.claude.phase, 'queued');
  queue.result('claude', retry, 'empty');
  queue.dispose();
  assert.equal(states.at(-1)?.agents.codex.phase, 'failed');
  assert.equal(vi.getTimerCount(), 0);
});

test('automatic account completion admits a queued manual press while its catalog remains held', async () => {
  const queue = new UsageReadQueue();
  let answerAutomatic = () => {};
  let finishCatalog = () => {};
  let answerManual = () => {};
  const account = new Promise<void>((resolve) => {
    answerAutomatic = resolve;
  });
  const catalog = new Promise<void>((resolve) => {
    finishCatalog = resolve;
  });
  const manualAccount = new Promise<void>((resolve) => {
    answerManual = resolve;
  });
  let reads = 0;
  const automatic = queue.run('codex', false, async (_force, operation) => {
    reads++;
    queue.reading('codex', undefined, operation);
    await account;
    queue.result('codex', undefined, 'success', '', operation);
    await catalog;
  });
  await vi.waitFor(() => assert.equal(reads, 1));
  const id = queue.begin(['codex'])!;
  const manual = queue.run(
    'codex',
    true,
    async (_force, operation) => {
      reads++;
      queue.reading('codex', id, operation);
      await manualAccount;
      queue.result('codex', id, 'success', '', operation);
    },
    '',
    id,
  );
  answerAutomatic();
  await vi.waitFor(() => assert.equal(reads, 2));
  finishCatalog();
  await automatic;
  const joined = queue.run(
    'codex',
    true,
    async () => {
      reads++;
    },
    '',
    id,
  );
  await Promise.resolve();
  assert.equal(reads, 2, 'old catalog completion released the newer account read');
  answerManual();
  await Promise.all([manual, joined]);
  queue.dispose();
});

test('an old automatic catalog completion cannot release a newer automatic account read', async () => {
  vi.useFakeTimers();
  const queue = new UsageReadQueue();
  let finishCatalog = () => {};
  let answer = () => {};
  const catalog = new Promise<void>((resolve) => {
    finishCatalog = resolve;
  });
  const account = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let oldOperation = 0;
  const old = queue.run('codex', false, async (_force, operation) => {
    oldOperation = operation;
    queue.result('codex', undefined, 'success', '', operation);
    await catalog;
  });
  await Promise.resolve();
  let automaticReading = false;
  const newer = queue.run('codex', false, async (_force, operation) => {
    automaticReading = true;
    await account;
    queue.result('codex', undefined, 'success', '', operation);
  });
  await vi.waitFor(() => assert.equal(automaticReading, true));
  const id = queue.begin(['codex'])!;
  let manualReading = false;
  const manual = queue.run(
    'codex',
    true,
    async () => {
      manualReading = true;
    },
    '',
    id,
  );
  finishCatalog();
  await old;
  let staleSettled = false;
  const stale = queue
    .run('codex', false, async () => assert.fail('obsolete account operation dispatched'), '', undefined, oldOperation)
    .then(() => {
      staleSettled = true;
    });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(staleSettled, true, 'obsolete account operation joined the newer account read');
  assert.equal(manualReading, false, 'old catalog completion released the newer automatic read');
  answer();
  await Promise.all([newer, manual, stale]);
  assert.equal(manualReading, true);
  queue.dispose();
});

test('an admitted late reading retires expired feedback without changing terminal identity or newer ownership', async () => {
  vi.useFakeTimers();
  const states: import('./view/usage').UsageRefresh[] = [];
  const queue = new UsageReadQueue((state) => states.push(state));
  const id = queue.begin(['claude', 'codex'])!;
  queue.result('codex', id, 'failed', 'The agent could not start to read usage.');
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_DEADLINE_MS);
  const expired = states.at(-1)!;
  const book = new UsageBook();
  book.note('claude', {
    plan: 'max',
    limits: [{ window: 'five_hour', group: 'session', scope: '', utilization: 0.1, resetsAtSeconds: null, status: '' }],
    complete: true,
    spend: null,
    creditResetsAtSeconds: null,
    readAt: Date.now(),
  });
  queue.admitted('claude');
  queue.result('claude', id, 'success');
  const retained = states.at(-1)!;
  assert.equal(retained.id, id);
  assert.equal(retained.agents.claude.phase, 'failed');
  assert.equal(expired.agents.claude.superseded, undefined);
  const bar = usageBar(book.usages(), Date.now(), retained)!;
  assert.doesNotMatch(bar.name, /Claude: Usage reading failed/);
  assert.deepEqual(
    bar.groups.map((group) => group.agent),
    ['claude', 'codex'],
  );
  assert.equal(bar.read, 'updated just now · press to read again');
  assert.equal(bar.groups[0].status, '');
  assert.match(bar.groups[1].status, /could not start/);
  const retry = queue.begin(['claude', 'codex'])!;
  queue.reading('claude', retry);
  queue.admitted('claude');
  queue.result('claude', id, 'success');
  assert.equal(states.at(-1)?.id, retry);
  assert.equal(states.at(-1)?.agents.claude.phase, 'reading');
  assert.equal(states.at(-1)?.agents.claude.superseded, undefined);
  queue.dispose();
});

test('idle account usage publishes before a held model catalog settles', async () => {
  let release = () => {};
  const catalog = new Promise<ModelList>((resolve) => {
    release = () => resolve(A_MODEL_LIST);
  });
  let published = false;
  const answers = askIdle(
    answeringPlan({ usage: async () => null, models: () => catalog }),
    () => new FakeChild(),
    undefined,
    () => {
      published = true;
    },
  );
  await vi.waitFor(() => assert.equal(published, true));
  release();
  await answers;
});

test('an idle child that never comes up is reported, not left hanging', { timeout: 5000 }, async () => {
  const probe = idleProbe(claudeIdlePlan(CLAUDE, WS));
  await tick();
  probe.children[0].exit(1, null);
  await assert.rejects(probe.answers, /stopped with code 1/);
});

test('an agent that could not answer for its models is not asked again until the reader asks', () => {
  const book = new ModelBook();
  assert.deepEqual(book.toAsk(['claude', 'codex'], 0, false), ['claude', 'codex']);
  book.noteSilent('codex');
  assert.deepEqual(
    book.toAsk(['claude', 'codex'], 0, false),
    ['claude'],
    'a machine with one CLI installed would pay a failed start every time a picker opened',
  );
  assert.deepEqual(book.toAsk(['claude', 'codex'], 0, true), ['claude', 'codex']);
  assert.deepEqual(
    book.toAsk(['claude', 'codex'], 0, false),
    ['claude', 'codex'],
    'the reader asking outright is somebody saying to try again',
  );
});

test('catalogs stay pending only before their first answer or failure', () => {
  const book = new ModelBook();
  assert.equal(book.pending('claude'), true);
  assert.equal(book.pending('codex'), true);
  book.note('claude', A_MODEL_LIST);
  assert.equal(book.pending('claude'), false);
  assert.equal(book.pending('codex'), true);
  book.noteSilent('codex');
  assert.equal(book.pending('codex'), false);
  book.toAsk(['codex'], 0, true);
  assert.equal(book.pending('codex'), true);
  book.note('codex', { ...A_MODEL_LIST, models: [] });
  assert.equal(book.pending('codex'), false);
  book.noteSilent('claude');
  assert.equal(book.pending('claude'), false);
});

// A saved-state fake with the calls `globalState` supplies.
function memoryState(): SavedStateStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key) => values.get(key),
    update: (key, value) => {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
      return Promise.resolve();
    },
    keys: () => [...values.keys()],
  };
}

test('a carried catalog draws its rows but rejects no pick until a fresh catalog arrives', () => {
  const stored = { agent: 'claude' as const, model: 'retired', effort: 'max', permissionMode: 'default' };
  const agents = (book: ModelBook) => [
    {
      value: 'claude',
      modelsPending: book.pending('claude'),
      models: (book.lists().claude ?? []).map((item) => ({ value: item.value, efforts: item.efforts })),
      permissions: [{ value: 'default' }],
    },
  ];
  const book = new ModelBook({ claude: A_MODEL_LIST });
  assert.deepEqual(book.lists(), { claude: A_MODEL_LIST.models }, 'a carried catalog offers its rows at once');
  assert.equal(pickedModel('retired', book.get('claude')), 'retired', 'a carried catalog dropped a stored pick');
  assert.equal(pickedEffort('max', book.get('claude'), 'retired'), 'max');
  assert.deepEqual(missingSetupValues(stored, agents(book)), [], 'a carried catalog made a saved setup unstartable');
  book.noteSilent('claude');
  assert.equal(book.pending('claude'), true, 'a failed fresh read let a carried catalog reject picks');
  assert.deepEqual(missingSetupValues(stored, agents(book)), []);
  book.note('claude', { ...A_MODEL_LIST, readAt: 1 });
  assert.equal(pickedModel('retired', book.get('claude')), '');
  assert.deepEqual(missingSetupValues(stored, agents(book)), ['model', 'effort']);
});

test('the first catalog request of a run reads the CLI even with a saved catalog, and a changed CLI path drops it', async () => {
  const storage = memoryState();
  const saved: unknown[] = [];
  const first = new ModelBook({}, (agent, list) => saved.push(agent, list));
  first.note('claude', { ...A_MODEL_LIST, readAt: 5 });
  assert.deepEqual(saved, ['claude', { ...A_MODEL_LIST, readAt: 5 }]);
  await saveCatalog(storage, 'claude', 'C:/Tools/claude.exe', 'C:/Tools/claude.exe', { ...A_MODEL_LIST, readAt: 5 });
  const seed = savedCatalogs(storage, () => 'C:/Tools/claude.exe', ['claude', 'codex']);
  assert.deepEqual(Object.keys(seed), ['claude']);
  const next = new ModelBook(seed);
  assert.deepEqual(
    next.toAsk(['claude'], 6, false),
    ['claude'],
    'a saved catalog stood in for the first read of this run',
  );
  assert.deepEqual(
    savedCatalogs(storage, () => 'C:/Other/claude.exe', ['claude']),
    {},
  );
  next.dropCarried('claude');
  assert.deepEqual(next.lists(), {});
});

test('a catalog answer that arrives after a CLI path change is not saved under the new path', async () => {
  const storage = memoryState();
  let configured = 'C:/Old/claude.exe';
  const saves: Promise<void>[] = [];
  const book = new ModelBook({}, (agent, list, readPath) =>
    saves.push(saveCatalog(storage, agent, readPath, configured, list)),
  );
  const startedUnder = configured;
  configured = 'C:/New/claude.exe';
  book.note('claude', { ...A_MODEL_LIST, readAt: 5 }, startedUnder);
  await Promise.all(saves);
  assert.deepEqual(
    savedCatalogs(storage, () => configured, ['claude']),
    {},
    "the old executable's catalog was saved under the new path",
  );
  book.note('claude', { ...A_MODEL_LIST, readAt: 6 }, configured);
  await Promise.all(saves);
  assert.deepEqual(
    savedCatalogs(storage, () => configured, ['claude']),
    { claude: { ...A_MODEL_LIST, readAt: 6 } },
  );
  // Every catalog answer carries the path its read started under, and the save compares it with the configured path.
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const notes = [...source.matchAll(/models\.note\(([^)]*)\)/g)];
  assert.ok(notes.length > 0);
  for (const [call, args] of notes)
    assert.equal(
      args.split(',').length,
      3,
      `a catalog answer is noted without the path its read started under: ${call}`,
    );
  assert.match(source, /saveCatalog\(context\.globalState, agent, readPath, cliPath\(agent\), list\)/);
});

test('a rejected saved-state write is logged, never rejects, and leaves the fresh catalog drawn', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const storage = { ...memoryState(), update: () => Promise.reject(new Error('disk full')) };
    const saves: Promise<void>[] = [];
    const book = new ModelBook({}, (agent, list, readPath) =>
      saves.push(saveCatalog(storage, agent, readPath, 'claude', list)),
    );
    book.note('claude', A_MODEL_LIST, 'claude');
    await Promise.all(saves);
    assert.deepEqual(book.lists(), { claude: A_MODEL_LIST.models });
    await new SavedDefaults(storage, path.posix).save('claude', '/Work', '', {
      status: 'ready',
      model: 'claude-haiku-5-5',
      effort: 'medium',
      reason: '',
    });
    assert.equal(warn.mock.calls.length, 2);
  } finally {
    warn.mockRestore();
  }
});

test('saved defaults from two windows keep both readings and evict to the newest', async () => {
  const storage = memoryState();
  let now = 0;
  const one = new SavedDefaults(storage, path.posix, () => ++now);
  const two = new SavedDefaults(storage, path.posix, () => ++now);
  const ready = (model: string) => ({ status: 'ready' as const, model, effort: 'high', reason: '' });
  await Promise.all([one.save('claude', '/Work/A', '', ready('a')), two.save('claude', '/Work/B', '', ready('b'))]);
  assert.deepEqual(one.get('claude', '/Work/B', ''), ready('b'));
  assert.deepEqual(two.get('claude', '/Work/A', ''), ready('a'));
  assert.equal(one.get('claude', '/work/a', ''), undefined, 'Linux path rules matched a folder that differs in case');
  assert.equal(one.get('codex', '/Work/A', ''), undefined);
  assert.equal(one.get('claude', '/Work/A', 'opus'), undefined);
  for (let index = 0; index < SAVED_DEFAULTS_LIMIT; index++)
    await (index % 2 ? one : two).save('claude', `/Work/${index}`, '', ready(String(index)));
  assert.equal(storage.keys().length, SAVED_DEFAULTS_LIMIT);
  assert.equal(one.get('claude', '/Work/A', ''), undefined);
  assert.equal(one.get('claude', '/Work/B', ''), undefined);
  assert.deepEqual(two.get('claude', '/Work/0', ''), ready('0'));
  assert.deepEqual(two.get('claude', `/Work/${SAVED_DEFAULTS_LIMIT - 1}`, ''), ready(String(SAVED_DEFAULTS_LIMIT - 1)));
  const windows = new SavedDefaults(storage, path.win32, () => ++now);
  await windows.save('claude', 'C:\\Work\\Repo', '', ready('w'));
  assert.deepEqual(
    windows.get('claude', 'c:\\work\\REPO', ''),
    ready('w'),
    'Windows path rules compared folders with case',
  );
});

test('a launch whose model the CLI rejects shows the CLI message', async () => {
  const { host, children } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS, model: 'retired-model' }));
  children[0].complain('There is an issue with the selected model (retired-model). It may not exist.\n');
  children[0].exit(1);
  const session = await starting.catch((error: Error) => error);
  const shown = session instanceof Error ? session.message : (session.state().lastError ?? '');
  assert.match(shown, /issue with the selected model \(retired-model\)/);
});

test('a model list is kept far longer than a usage figure, because it turns over on a release', () => {
  const book = new ModelBook();
  book.note('claude', A_MODEL_LIST);
  assert.ok(MODELS_FRESH_MS > USAGE_FRESH_MS * 10);
  assert.deepEqual(
    book.toAsk(['claude'], USAGE_FRESH_MS * 10, false),
    [],
    'a list read this morning names the same models this afternoon',
  );
  assert.deepEqual(book.toAsk(['claude'], MODELS_FRESH_MS + 1, false), ['claude']);
  assert.deepEqual(book.lists(), { claude: A_MODEL_LIST.models });
});

const SOME_SERVERS: McpServer[] = [
  {
    name: 'probeGood',
    status: 'connected',
    error: '',
    tools: ['probe_echo'],
    scope: 'dynamic',
    title: 'probe-server',
  },
];

function idleMcpDiscovery(agent: 'claude' | 'codex', cwd: string) {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const mcp = new McpBook();
  const usageReads = new UsageReadQueue();
  const children: FakeChild[] = [];
  const directories: string[] = [];
  const publications: string[] = [];
  const models = new ModelBook();
  let releaseModels!: (models: ModelList) => void;
  const catalog = new Promise<ModelList>((resolve) => {
    releaseModels = resolve;
  });
  let releaseServers!: (servers: McpServer[] | null) => void;
  let serverAnswer: Promise<McpServer[] | null> = Promise.resolve(SOME_SERVERS);
  const scope = {
    mcp,
    usageReads,
    models,
    askIdle,
    askIdleMcp,
    liveMcpTarget,
    usage: new UsageBook(),
    commandsAsked: new Set<string>(),
    commandLists: { revision: () => 0 },
    workspaceCwd: () => cwd,
    cliPath: () => '',
    publishUsage: () => publications.push('usage'),
    publishPicks: () => publications.push('models'),
    publishCommands: () => publications.push('commands'),
    publishMcp: () => publications.push('MCP'),
    host: { states: () => [], retireSession: () => Promise.resolve() },
    draftMcpKeys: new Map<string, string>(),
    acceptedDrafts: new Set<string>(),
    mcpRefreshes: new McpPendingRefreshes(),
    USAGE_AGENT_ORDER: ['claude', 'codex'],
    freshHostKey,
    retireDraftProfile,
    idlePlanFor: (_agent: string, directory: string) => {
      const plan = answeringPlan({
        usage: async () => ({
          plan: 'pro',
          limits: [],
          complete: true,
          spend: null,
          creditResetsAtSeconds: null,
          readAt: Date.now(),
        }),
        models: () => catalog,
      });
      const driver = plan.driver;
      return {
        ...plan,
        agent,
        cwd: directory,
        driver: (...args: Parameters<typeof driver>) => ({
          ...driver(...args),
          usageSupported: async () => true,
          mcpStatus: () => serverAnswer,
        }),
      };
    },
    spawner: (_command: string, _args: string[], directory: string) => {
      directories.push(directory);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    readMcpFrom: async () => {},
    readFrom: async () => {},
    refreshUsage: vi.fn<(agent: string, force: boolean, owner: string, ownerAgent: string, cwd: string) => void>(),
    panel: {} as Record<string, (...args: unknown[]) => void>,
  };
  const statements = [
    'const noteMcp =',
    'const readIdleMcp =',
    'const askAgent =',
    'panel.onSelectionChanged =',
    'panel.onDraftRemoved =',
    'panel.onDraftProfileChanged =',
    'panel.onDraftAdopted =',
    'panel.onPanelsClosed =',
  ].map((needle) => statementFrom(source, source.indexOf(needle)));
  const code = esbuild.transformSync(
    `let mcpSurfaceGeneration = 0; let activeMcpOwner = 'owner-a';
    ${statements.join('\n')}
    return { askAgent, readIdleMcp };`,
    { loader: 'ts' },
  ).code;
  const compiled = runInNewContext(`(() => { ${code} })()`, scope) as {
    askAgent(agent: string, force: boolean, owner: string, cwd: string): Promise<void>;
    readIdleMcp(agent: string, cwd: string, owner: string, revision: number, generation: number): Promise<boolean>;
  };
  onTestFinished(() => {
    usageReads.dispose();
    scope.mcpRefreshes.dispose();
    for (const child of children) child.exit(0);
  });
  return {
    ...scope,
    ...compiled,
    children,
    directories,
    publications,
    releaseModels: () => releaseModels(A_MODEL_LIST),
    holdServers: () => {
      serverAnswer = new Promise((resolve) => {
        releaseServers = resolve;
      });
    },
    releaseServers: (servers: McpServer[] | null) => releaseServers(servers),
  };
}

for (const agent of ['claude', 'codex'] as const) {
  for (const next of ['owner-b', 'draft-new']) {
    test(`${agent} selection to ${next} skips obsolete initial MCP startup after catalogs settle`, async () => {
      const fixture = idleMcpDiscovery(agent, 'D:/Work/Owner-A');
      const older = fixture.askAgent(agent, false, 'owner-a', 'D:/Work/Owner-A');
      await vi.waitFor(() => assert.ok(fixture.publications.includes('usage')));
      assert.deepEqual(fixture.directories, ['D:/Work/Owner-A']);
      fixture.panel.onSelectionChanged(next, agent, '/work/owner-b');
      assert.deepEqual(fixture.refreshUsage.mock.calls, [[agent, false, next, agent, '/work/owner-b']]);
      fixture.releaseModels();
      await older;
      assert.deepEqual(fixture.directories, ['D:/Work/Owner-A'], 'obsolete discovery started another child');
      assert.ok(fixture.publications.includes('commands'));
      assert.ok(fixture.publications.includes('models'));
      assert.equal(fixture.mcp.get('owner-a'), null);
      assert.equal(fixture.mcp.needsInitialRead('owner-a'), true);
      const finalOwner = next === 'owner-b' ? 'owner-a' : next;
      const finalCwd = next === 'owner-b' ? 'D:/Work/Owner-A' : '/work/owner-b';
      fixture.panel.onSelectionChanged(finalOwner, agent, finalCwd);
      await fixture.askAgent(agent, false, finalOwner, finalCwd);
      await vi.waitFor(() => assert.deepEqual(fixture.mcp.get(finalOwner), SOME_SERVERS));
      assert.equal(fixture.directories.at(-1), finalCwd);
    });
  }

  test(`${agent} idle MCP admission preserves refresh and retry across owner and panel replacement`, async () => {
    const fixture = idleMcpDiscovery(agent, '/Users/reader/Work');
    fixture.releaseModels();
    for (const invalidate of [
      () => fixture.mcp.change('owner-a'),
      () => fixture.panel.onDraftRemoved({ draftId: 'owner-a' }),
      () => fixture.panel.onDraftProfileChanged({ draftId: 'owner-a', profile: { agent } }),
      () => fixture.panel.onDraftAdopted('owner-a', 'actual'),
      () => fixture.panel.onPanelsClosed(),
    ]) {
      const revision = fixture.mcp.change('owner-a');
      invalidate();
      assert.equal(await fixture.readIdleMcp(agent, '/Users/reader/Work', 'owner-a', revision, 0), false);
    }
    assert.equal(fixture.children.length, 0, 'invalidated work started an MCP child');
    // A new panel has its own generation after the close above.
    fixture.holdServers();
    const current = fixture.mcp.beginInitialRead('owner-b')!;
    const pending = fixture.readIdleMcp(agent, '/Users/reader/Work', 'owner-b', current, 1);
    await vi.waitFor(() => assert.equal(fixture.children.length, 1));
    const newer = fixture.mcp.change('owner-b');
    fixture.releaseServers(SOME_SERVERS);
    assert.equal(await pending, false, 'an in-flight stale answer replaced current state');
    fixture.mcp.finishInitialRead('owner-b', current, false);
    assert.equal(fixture.mcp.get('owner-b'), null);
    fixture.holdServers();
    const refresh = fixture.readIdleMcp(agent, '/Users/reader/Work', 'owner-b', newer, 1);
    await vi.waitFor(() => assert.equal(fixture.children.length, 2));
    fixture.releaseServers(null);
    assert.equal(await refresh, false);
    assert.equal(fixture.mcp.needsInitialRead('owner-b'), true);
    fixture.holdServers();
    const retryRevision = fixture.mcp.beginInitialRead('owner-b')!;
    const retry = fixture.readIdleMcp(agent, '/Users/reader/Work', 'owner-b', retryRevision, 1);
    await vi.waitFor(() => assert.equal(fixture.children.length, 3));
    fixture.releaseServers([]);
    assert.equal(await retry, true);
    assert.deepEqual(fixture.mcp.get('owner-b'), []);
    assert.equal(fixture.mcp.needsInitialRead('owner-b'), false);
    assert.deepEqual(fixture.directories, Array(3).fill('/Users/reader/Work'));
  });
}

test('the MCP servers kept for an agent are whatever it last said, and none for one nobody asked', () => {
  const book = new McpBook();
  assert.equal(
    book.get('claude'),
    null,
    'an agent nobody has read reads as an agent with no servers, which is a different answer',
  );
  book.note('claude', SOME_SERVERS);
  assert.deepEqual(book.get('claude'), SOME_SERVERS);
  // Each MCP reading replaces the previous list immediately, including an empty list.

  book.note('claude', []);
  assert.deepEqual(book.get('claude'), [], 'a reading that found nothing is still an answer');
  book.note('codex', SOME_SERVERS);
  assert.deepEqual(book.lists(), { claude: [], codex: SOME_SERVERS });
});

test('an unanswered initial MCP read is retried, while an answer or launch failure settles it', () => {
  const book = new McpBook();
  const first = book.beginInitialRead('claude');
  assert.notEqual(first, null);
  assert.equal(book.beginInitialRead('claude'), null, 'a read in flight allowed a duplicate process start');

  book.finishInitialRead('claude', first!, false);
  assert.equal(book.needsInitialRead('claude'), true, 'a missing answer prevented the next view from retrying');
  const second = book.beginInitialRead('claude');
  assert.notEqual(second, null);
  book.note('claude', [], second!);
  assert.equal(book.needsInitialRead('claude'), false, 'an empty server list was not treated as an answer');

  const codex = book.beginInitialRead('codex');
  book.noteSilent('codex', codex!);
  assert.equal(book.needsInitialRead('codex'), false, 'a launch failure would retry on every view');
});

test('an older initial MCP completion cannot release its replacement request', () => {
  const book = new McpBook();
  const older = book.beginInitialRead('draft-1')!;
  book.forget('draft-1');
  const replacement = book.beginInitialRead('draft-1')!;

  book.finishInitialRead('draft-1', older, false);

  assert.equal(
    book.beginInitialRead('draft-1'),
    null,
    'the older completion released the replacement request and allowed duplicate traffic',
  );
  book.finishInitialRead('draft-1', replacement, false);
  assert.notEqual(
    book.beginInitialRead('draft-1'),
    null,
    'the replacement completion did not release its own unanswered request',
  );
});

test('closing MCP surfaces lets reopened discovery replace an unfinished read', () => {
  const book = new McpBook();
  const closedSurfaceRead = book.beginInitialRead('session-1')!;

  book.invalidateInitialReads();
  const reopenedSurfaceRead = book.beginInitialRead('session-1');
  assert.notEqual(
    reopenedSurfaceRead,
    null,
    'reopening Servers could not replace the read invalidated when every panel closed',
  );

  book.finishInitialRead('session-1', closedSurfaceRead, false);
  assert.equal(
    book.beginInitialRead('session-1'),
    null,
    'the closed surface read released the reopened surface request',
  );
  book.finishInitialRead('session-1', reopenedSurfaceRead!, false);
  assert.notEqual(
    book.beginInitialRead('session-1'),
    null,
    'the reopened surface request did not release its own unanswered read',
  );
});

test('a later MCP status request wins when an earlier request answers last', () => {
  const book = new McpBook();
  const earlier = book.change('session-1');
  const later = book.change('session-1');
  const connected = [{ ...SOME_SERVERS[0], status: 'connected' }];
  const failed = [{ ...SOME_SERVERS[0], status: 'failed' }];

  assert.equal(book.note('session-1', connected, later), true);
  assert.equal(book.note('session-1', failed, earlier), false, 'a slower earlier request replaced the newer status');
  assert.deepEqual(book.get('session-1'), connected);
});

test('an MCP reading begun before a server change cannot replace the result of that change', async () => {
  const book = new McpBook();
  const staleRevision = book.revision('claude');
  let finishRead!: (servers: McpServer[]) => void;
  const staleAnswer = new Promise<McpServer[]>((resolve) => {
    finishRead = resolve;
  });
  const staleRead = staleAnswer.then((servers) => book.note('claude', servers, staleRevision));

  const changedRevision = book.change('claude');
  const changed = [{ ...SOME_SERVERS[0], status: 'disabled' }];
  assert.equal(book.note('claude', changed, changedRevision), true);
  finishRead(SOME_SERVERS);

  assert.equal(await staleRead, false, 'the older reading was allowed to publish after the switch');
  assert.deepEqual(book.get('claude'), changed);
});

test('draft MCP state moves to the actual session owner and rejects the provisional in-flight read', () => {
  const book = new McpBook();
  const revision = book.revision('draft-1');
  assert.equal(book.note('draft-1', SOME_SERVERS, revision), true);

  book.adopt('draft-1', 'session-1');

  assert.equal(book.get('draft-1'), null);
  assert.deepEqual(book.get('session-1'), SOME_SERVERS);
  assert.equal(
    book.note('draft-1', [], revision),
    false,
    'a read owned by the provisional id published after adoption',
  );
  assert.deepEqual(book.lists(), { 'session-1': SOME_SERVERS });
});

test('an MCP live target belongs to the requested owner and ownerless discovery excludes drafts', () => {
  const states = [
    {
      key: 'claude:fresh:draft-1',
      agent: 'claude',
      sessionId: 'provisional-session',
      busy: false,
      ready: true,
      exited: false,
    },
    { key: 'claude:existing-1', agent: 'claude', sessionId: 'existing-1', busy: false, ready: true, exited: false },
    { key: 'claude:existing-2', agent: 'claude', sessionId: 'existing-2', busy: false, ready: true, exited: false },
  ] as SessionState[];
  const drafts = new Map([['draft-1', 'claude:fresh:draft-1']]);

  assert.equal(liveMcpTarget(states, 'existing-2', drafts)?.state.key, 'claude:existing-2');
  assert.equal(
    liveMcpTarget(states, 'missing', drafts),
    null,
    'another Claude session was allowed to answer for the requested owner',
  );
  assert.deepEqual(liveMcpTarget(states, undefined, drafts), {
    state: states[1],
    owner: 'existing-1',
  });
});

test('the production draft MCP factory rebuilds one captured random session identity', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const planAt = source.indexOf('const freshPlanForDraft =');
  const planSource = statementFrom(source, planAt);
  assert.match(
    planSource,
    /const sessionId = [^;]*randomUUID\(\)[\s\S]*return \(\) =>/,
    'the production draft factory creates a new session identity each time AgentHost asks for a plan',
  );
  const draft = newSessionDraft('draft-1', WS, null, 1, {
    agent: 'claude',
    model: '',
    effort: '',
    permissionMode: '',
    source: 'recent',
  });
  const sessionId = `session-${Math.random()}`;
  let built = 0;
  const factory = () => {
    built++;
    return claudePlan(CLAUDE, { cwd: draft.cwd, sessionId });
  };
  assert.notEqual(factory(), factory(), 'the production-shaped factory does not build a new plan');
  const callbackAt = source.indexOf('panel.onPanelCommand =');
  const callback = statementFrom(source, callbackAt);
  assert.match(
    callback,
    /const plan = freshPlanForDraft\(draft\);[\s\S]*openDraftMcp\(host, key, plan,/,
    'the production boundary can evaluate the random plan again while AgentHost waits',
  );

  const { host, children } = fakeHost();
  built = 0;
  const opening = host.withSessionActivity(freshHostKey('claude', draft.draftId), factory, (session) =>
    session.mcpStatus(),
  );
  children[0].answerHandshake();
  await tick();
  children[0].answerControl('mcp_status', { mcpServers: [] });
  assert.deepEqual(await opening, []);
  assert.equal(built, 2, 'AgentHost did not exercise the production factory rebuild boundary');
});

test('a new Claude draft keeps one child while pending MCP servers settle and through its first prompt', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer, idleDurationMs: 60_000 });
  const key = freshHostKey('claude', 'draft-1');
  const plan = claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1' });
  const published: McpServer[][] = [];
  const refreshes = new McpPendingRefreshes({
    timer,
    now: () => 0,
    delayMs: 25,
    deadlineMs: 100,
  });
  const opening = openDraftMcp(host, key, plan, refreshes, 'draft-1', (servers) => {
    published.push(servers);
    return true;
  });
  children[0].answerHandshake();
  await tick();
  children[0].answerControl('mcp_status', {
    mcpServers: [{ name: 'notes', status: 'pending', tools: [] }],
  });
  assert.equal(await opening, true);
  assert.equal(children[0].ended, false, 'the initial server reading disposed the draft child');

  timer.fire(timer.tasks.length - 1);
  await tick();
  const status = children[0]
    .sent()
    .filter((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'mcp_status')
    .at(-1)!;
  children[0].say(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: status.request_id,
        response: { mcpServers: [{ name: 'notes', status: 'connected', tools: [] }] },
      },
    }) + '\n',
  );
  await tick();

  assert.deepEqual(
    published.map((servers) => servers[0]?.status),
    ['pending', 'connected'],
  );
  const same = await host.session(key, plan);
  await same.prompt('use notes');
  assert.equal(children.length, 1, 'the first prompt started a second child after MCP startup');
  assert.equal(timer.activeCount(), 1, 'settled servers left a pending refresh timer');
});

test('an MCP change waits for an opening child and reuses it after the handshake', async () => {
  const { host, children } = fakeHost();
  const key = freshHostKey('claude', 'draft-1');
  const opening = host.session(key, claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1' }));
  assert.equal(host.states()[0]?.ready, false);
  const target = liveMcpTarget(host.states(), 'draft-1', new Map([['draft-1', key]]));
  assert.equal(target?.state.key, key);
  const changed = host.changeMcp([key], [{ serverName: 'notes', enabled: true }]);
  assert.equal(
    children[0]
      .sent()
      .some((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'mcp_toggle'),
    false,
    'an opening child received a server control before its handshake completed',
  );

  children[0].answerHandshake();
  await opening;
  assert.equal(host.states()[0]?.ready, true);
  await tick();
  children[0].answerControl('mcp_toggle', {});
  await tick();
  children[0].answerControl('mcp_status', { mcpServers: [] });
  assert.deepEqual(await changed, { failures: [], servers: [] });
  assert.equal(children.length, 1, 'the server change started another child instead of reusing the opening one');
});

test('targeted retirement waits for a draft MCP read and closes its child once', async () => {
  const { host, children } = fakeHost();
  const key = freshHostKey('claude', 'draft-1');
  const plan = claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1' });
  const reading = host.withSessionActivity(key, plan, (session) => session.mcpStatus());
  children[0].answerHandshake();
  await tick();
  const firstRetirement = host.retireSession(key);
  const secondRetirement = host.retireSession(key);
  assert.equal(children[0].ended, false, 'retirement closed the child during its server read');
  children[0].answerControl('mcp_status', { mcpServers: [] });
  await reading;
  await tick();
  assert.equal(children[0].endCalls, 1);
  assert.equal(host.get(key), null);
  children[0].exit(0);
  await Promise.all([firstRetirement, secondRetirement]);
});

test('a permission transition blocks a concurrent prompt and rebuilds its launch plan', async () => {
  const { host, children, commands } = fakeHost();
  let permissionMode: PermissionMode = 'acceptEdits';
  const plan = () =>
    claudePlan(CLAUDE, {
      cwd: WS,
      resume: 'session-1',
      permissionMode,
    });
  const opening = host.session('one', plan);
  children[0].answerHandshake();
  await opening;

  let releasePersistence: () => void = () => undefined;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const changing = host.withRetiringActivities(['one'], async () => {
    permissionMode = 'manual';
    await persistence;
    return true;
  });
  const delivery = (async () => {
    const existing = host.find('claude', 'session-1');
    if (existing) {
      const delivered = await host.withActivity(existing.key, (session) => session.prompt('after change'));
      if (delivered !== null) {
        return delivered;
      }
    }
    return await host.withSessionActivity('one', plan, (session) => session.prompt('after change'));
  })();
  await tick();
  assert.equal(
    children[0].sent().filter((message) => message.type === 'user').length,
    0,
    'the prompt reached the child with the old permission override',
  );

  releasePersistence();
  await vi.waitFor(() => assert.equal(children[0].ended, true));
  assert.equal(children.length, 1, 'the replacement started before the old child closed');
  children[0].exit(0);
  await vi.waitFor(() => assert.equal(children.length, 2));
  children[1].answerHandshake();
  assert.equal(typeof (await delivery), 'number');
  assert.equal(await changing, true);
  assert.equal(commands[1][commands[1].indexOf('--permission-mode') + 1], 'manual');
  assert.equal(commands[1].includes('acceptEdits'), false, 'the replacement kept the old permission override');
  assert.equal(children[1].sent().filter((message) => message.type === 'user').length, 1);
});

test('a permission transition waits for an earlier prompt lease before retiring its child', async () => {
  const { host, children } = fakeHost();
  const opening = host.session(
    'one',
    claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1', permissionMode: 'acceptEdits' }),
  );
  children[0].answerHandshake();
  await opening;

  let releasePrompt: () => void = () => undefined;
  const promptLease = host.withActivity('one', async () => {
    await new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
  });
  let transitionStarted = false;
  const changing = host.withRetiringActivities(['one'], async () => {
    transitionStarted = true;
    return true;
  });
  host.cancelSessionRetirement('one');
  await vi.waitFor(() => assert.equal(transitionStarted, false));
  assert.equal(children[0].ended, false, 'the transition closed a child whose earlier prompt still held a lease');

  releasePrompt();
  await promptLease;
  await vi.waitFor(() => assert.equal(transitionStarted, true));
  await vi.waitFor(() => assert.equal(children[0].ended, true));
  children[0].exit(0);
  assert.equal(await changing, true);
});

test('a busy permission transition retires when the turn ends before housekeeping settles', async () => {
  const { host, children } = fakeHost();
  const opening = host.session(
    'one',
    claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1', permissionMode: 'acceptEdits' }),
  );
  children[0].answerHandshake();
  const session = await opening;
  await session.prompt('finish this');

  let transitionWorkFinished = false;
  const changing = host.withRetiringActivities(['one'], async () => {
    transitionWorkFinished = true;
    return true;
  });
  await vi.waitFor(() => assert.equal(transitionWorkFinished, true));
  await Promise.resolve();
  assert.equal(children[0].ended, false, 'the transition closed the child while its turn was running');
  children[0].say(COMPLETED_RESULT);

  await vi.waitFor(() => assert.equal(children[0].ended, true));
  children[0].exit(0);
  assert.equal(await changing, true);
});

test('a rejected permission transition keeps queued delivery on the old child', async () => {
  const { host, children } = fakeHost();
  const plan = () =>
    claudePlan(CLAUDE, {
      cwd: WS,
      resume: 'session-1',
      permissionMode: 'acceptEdits',
    });
  const opening = host.session('one', plan);
  children[0].answerHandshake();
  await opening;

  let rejectPersistence: (error: Error) => void = () => undefined;
  const persistence = new Promise<never>((_resolve, reject) => {
    rejectPersistence = reject;
  });
  const changing = host.withRetiringActivities(['one'], async () => await persistence);
  const rejected = assert.rejects(changing, /settings write failed/);
  const delivery = (async () => {
    const existing = host.find('claude', 'session-1');
    if (existing) {
      const delivered = await host.withActivity(existing.key, (session) => session.prompt('after failure'));
      if (delivered !== null) {
        return delivered;
      }
    }
    return await host.withSessionActivity('one', plan, (session) => session.prompt('after failure'));
  })();

  rejectPersistence(new Error('settings write failed'));
  await rejected;
  await vi.waitFor(() => {
    assert.equal(children.length, 1, 'the failed transition opened a replacement child');
    assert.equal(children[0].sent().filter((message) => message.type === 'user').length, 1);
  });
  assert.equal(children[0].ended, false, 'the failed transition retired the old child');
  assert.equal(typeof (await delivery), 'number');
});

test('a permission transition bars an opening child before its handshake settles', async () => {
  const { host, children } = fakeHost();
  const plan = claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1', permissionMode: 'acceptEdits' });
  const opening = host.session('one', plan);
  const changing = host.withRetiringActivities(['one'], async () => true);
  const activity = host.withActivity('one', async () => 'old child');
  await tick();
  assert.equal(await Promise.race([activity, Promise.resolve('blocked')]), 'blocked');
  assert.equal(children[0].ended, false, 'the transition closed the child before its handshake settled');

  children[0].answerHandshake();
  await opening;
  await vi.waitFor(() => assert.equal(children[0].ended, true));
  children[0].exit(0);
  assert.equal(await changing, true);
  assert.equal(await activity, null);
});

test('targeted retirement blocks reuse as soon as an opening child is abandoned', async () => {
  const { host, children } = fakeHost();
  const key = freshHostKey('claude', 'draft-1');
  const opening = host.session(key, claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1', model: 'old-model' }));
  const retirement = host.retireSession(key);
  const replacement = host.session(key, claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-2', model: 'new-model' }));
  await tick();
  assert.equal(children.length, 1, 'a prompt joined or replaced the opening child after retirement was requested');

  children[0].answerHandshake();
  await opening;
  await tick();
  assert.equal(children[0].endCalls, 1, 'the abandoned opening child remained alive after its handshake');
  children[0].exit(0);
  await retirement;
  await tick();
  assert.equal(children.length, 2, 'the replacement did not open after the abandoned child exited');
  children[1].answerHandshake();
  assert.equal((await replacement).state().sessionId, 'session-2');
});

test('a replacement draft plan waits for the provisional child to retire', async () => {
  const { host, children, commands } = fakeHost();
  const key = freshHostKey('claude', 'draft-1');
  const oldPlan = claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-1', model: 'old-model' });
  const reading = host.withSessionActivity(key, oldPlan, (session) => session.mcpStatus());
  children[0].answerHandshake();
  await tick();

  const retirement = host.retireSession(key);
  const replacement = host.session(key, claudePlan(CLAUDE, { cwd: WS, sessionId: 'session-2', model: 'new-model' }));
  await tick();
  assert.equal(children.length, 1, 'the changed profile opened another child before the old read settled');

  children[0].answerControl('mcp_status', { mcpServers: [] });
  await reading;
  await tick();
  children[0].exit(0);
  await retirement;
  await tick();
  assert.equal(children.length, 2, 'the first prompt reused the child built from the previous profile');
  children[1].answerHandshake();
  await replacement;
  assert.ok(commands[1].includes('new-model'));
});

test('a pending MCP deadline cancels an in-flight refresh before it can publish', async () => {
  const timer = new FakeAgentHostTimer();
  let resolveRead!: (servers: McpServer[]) => void;
  const read = new Promise<McpServer[]>((resolve) => {
    resolveRead = resolve;
  });
  const published: McpServer[][] = [];
  const refreshes = new McpPendingRefreshes({ timer, delayMs: 25, deadlineMs: 100 });
  refreshes.follow(
    'draft-1',
    [{ ...SOME_SERVERS[0], status: 'pending' }],
    () => read,
    (servers) => published.push(servers),
  );

  timer.fire(1);
  await tick();
  timer.fire(0);
  resolveRead([{ ...SOME_SERVERS[0], status: 'connected' }]);
  await tick();

  assert.deepEqual(published, []);
  assert.equal(timer.activeCount(), 0);
});

test('an older rejected MCP refresh cannot cancel its replacement', async () => {
  const timer = new FakeAgentHostTimer();
  let rejectOlder!: (reason: Error) => void;
  const older = new Promise<McpServer[]>((_resolve, reject) => {
    rejectOlder = reject;
  });
  const connected = [{ ...SOME_SERVERS[0], status: 'connected' }];
  const published: McpServer[][] = [];
  const refreshes = new McpPendingRefreshes({ timer, delayMs: 25, deadlineMs: 100 });

  refreshes.follow(
    'draft-1',
    [{ ...SOME_SERVERS[0], status: 'pending' }],
    () => older,
    () => undefined,
  );
  timer.fire(1);
  await tick();
  refreshes.follow(
    'draft-1',
    [{ ...SOME_SERVERS[0], status: 'pending' }],
    async () => connected,
    (servers) => published.push(servers),
  );

  rejectOlder(new Error('older refresh failed'));
  await tick();
  timer.fire(3);
  await tick();

  assert.deepEqual(
    published,
    [connected],
    'the older rejected refresh canceled the replacement request for the same owner',
  );
  assert.equal(timer.activeCount(), 0);
});

test(
  'a press on an MCP server reaches the Claude child, and its reading comes back in the panel words',
  { timeout: 5000 },
  async () => {
    const h = fakeHost();
    const opening = h.host.session('claude:ws', claudePlan(CLAUDE, { cwd: WS }));
    h.children[0].answerHandshake();
    const claude = await opening;

    const reading = claude.mcpStatus();
    h.children[0].answerControl('mcp_status', {
      mcpServers: [
        {
          name: 'probeGood',
          status: 'connected',
          scope: 'dynamic',
          serverInfo: { name: 'probe-server', version: '0.0.1' },
          tools: [{ name: 'probe_echo', annotations: {} }],
        },
      ],
    });
    assert.deepEqual(await reading, SOME_SERVERS);

    const switching = claude.mcpToggle('probeGood', true);
    const asked = h.children[0]
      .sent()
      .find((m) => (m.request as { subtype?: string } | undefined)?.subtype === 'mcp_toggle');
    assert.deepEqual(
      asked?.request,
      { subtype: 'mcp_toggle', serverName: 'probeGood', enabled: true },
      'the CLI answers success whatever the fields are called, so a wrong one moves nothing and says nothing',
    );
    h.children[0].answerControl('mcp_toggle', {});
    await switching;

    const retrying = claude.mcpReconnect('probeBad');
    const retried = h.children[0]
      .sent()
      .find((m) => (m.request as { subtype?: string } | undefined)?.subtype === 'mcp_reconnect');
    assert.deepEqual(retried?.request, { subtype: 'mcp_reconnect', serverName: 'probeBad' });
    h.children[0].answerControl('mcp_reconnect', {});
    await retrying;
  },
);

test('an agent with no MCP servers to report answers none, and a press on one does nothing', async () => {
  // A plan without MCP operations returns no server reading and performs no toggle or reconnect.

  const { host } = fakeHost();
  const session = await host.session(
    'bare',
    answeringPlan({
      usage: () => Promise.resolve(null),
      models: () => Promise.resolve(null),
    }),
  );
  assert.equal(await session.mcpStatus(), null);
  await assert.doesNotReject(session.mcpToggle('probeGood', false));
  await assert.doesNotReject(session.mcpReconnect('probeGood'));
});

test('Claude can change MCP servers while Codex reports status only', () => {
  const claude = claudePlan(CLAUDE, { cwd: WS }).driver(
    () => undefined,
    () => undefined,
  );
  assert.deepEqual(
    [typeof claude.mcpStatus, typeof claude.mcpToggle, typeof claude.mcpReconnect],
    ['function', 'function', 'function'],
  );
  const codex = codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }).driver(
    () => undefined,
    () => undefined,
  );
  assert.deepEqual(
    [typeof codex.mcpStatus, codex.mcpToggle, codex.mcpReconnect],
    ['function', undefined, undefined],
    'the Codex app server reports its servers but does not expose Claude-style switches',
  );
});

test('a pick the agent has dropped is not passed to a child, and one made before any list is read is kept', () => {
  assert.equal(pickedModel('opus', A_MODEL_LIST), 'opus');
  assert.equal(
    pickedModel('sonnet-2', A_MODEL_LIST),
    '',
    'a child started on a model the CLI no longer has does not run at all',
  );
  assert.equal(
    pickedModel('sonnet-2', null),
    'sonnet-2',
    'nothing has answered yet, so the pick stands rather than falling back to a default nobody chose',
  );

  assert.equal(pickedEffort('high', A_MODEL_LIST, 'opus'), 'high');
  assert.equal(
    pickedEffort('low', A_MODEL_LIST, 'opus'),
    '',
    'effort belongs to a model, so a level this one does not offer is not sent with it',
  );
  assert.equal(pickedEffort('low', null, 'opus'), 'low');
  assert.equal(pickedEffort('high', A_MODEL_LIST, ''), 'high');
  assert.equal(pickedEffort('retired', A_MODEL_LIST, ''), '');
});

test('a streamed chunk of the reply is passed on and wakes nothing else', async () => {
  // Reply chunks publish delta events without changing session state.

  const { host, children, events, states } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  await starting;
  const before = states.length;
  for (const text of ['one, ', 'two, ', 'three']) {
    children[0].say(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      }) + '\n',
    );
  }
  assert.deepEqual(
    events.filter((e) => e.event.kind === 'delta').map((e) => [e.key, e.event]),
    [
      ['one', { kind: 'delta', text: 'one, ' }],
      ['one', { kind: 'delta', text: 'two, ' }],
      ['one', { kind: 'delta', text: 'three' }],
    ],
    'the chunks never reach the panel, so the card has nothing to draw',
  );
  assert.equal(states.length, before, 'every chunk redraws the status bar and writes the session id back');

  // The turn ending is a state change, and stays one.
  children[0].say(
    JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', result: 'hi' }) + '\n',
  );
  assert.ok(states.length > before, 'a turn that ended is reported no more loudly than a chunk of it');
});

test('live activity is passed on without waking session state', async () => {
  const { host, children, events, states } = fakeHost();
  const starting = host.session('one', claudePlan(CLAUDE, { cwd: WS }));
  children[0].answerHandshake();
  await starting;
  const before = states.length;
  children[0].say(
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_fast',
            name: 'Bash',
            input: { command: 'npm test', description: 'Run tests' },
          },
        ],
      },
    }) + '\n',
  );
  assert.deepEqual(
    events.filter((entry) => entry.event.kind === 'activity').map((entry) => entry.key),
    ['one'],
  );
  assert.equal(states.length, before, 'activity redraws shared session state instead of only updating the live card');
});

test('a child that ends when its input closes is never killed, and one that does not is', async () => {
  // Close child input before killing a process. Allow shutdown to save settings, then kill children that ignore the close.

  const wellBehaved = new FakeChild();
  vi.useFakeTimers();
  const polite = new AgentSession(
    'a',
    claudeIdlePlan(CLAUDE, WS),
    () => wellBehaved,
    () => {},
    () => {},
    1000,
    20,
  );
  const politeDisposal = polite.dispose();
  assert.equal(wellBehaved.ended, true, 'the child was never asked to stop');
  // Ending on its own is what a real CLI does when its input closes.
  wellBehaved.exit(0);
  await politeDisposal;
  await vi.advanceTimersByTimeAsync(60);
  vi.useRealTimers();
  assert.equal(wellBehaved.killed, false, 'a child that had already gone was killed anyway');

  // The backstop. A child that ignores the close is still taken away, so nothing is left
  // running behind a panel the reader has closed.
  const stubborn = new FakeChild();
  vi.useFakeTimers();
  const rude = new AgentSession(
    'b',
    claudeIdlePlan(CLAUDE, WS),
    () => stubborn,
    () => {},
    () => {},
    1000,
    20,
  );
  const rudeDisposal = rude.dispose();
  assert.equal(stubborn.killed, false, 'the child was killed before it had a chance to stop');
  await vi.advanceTimersByTimeAsync(60);
  vi.useRealTimers();
  assert.equal(stubborn.killed, true, 'a child that would not stop was left running');
  stubborn.exit(null, 'SIGTERM');
  await rudeDisposal;
});

test('disposing an exited child completes without another grace period', async () => {
  const child = new FakeChild();
  const session = new AgentSession(
    'gone',
    claudeIdlePlan(CLAUDE, WS),
    () => child,
    () => {},
    () => {},
  );
  child.exit(1);

  const first = session.dispose();
  assert.strictEqual(session.dispose(), first, 'repeated disposal started another shutdown wait');
  await first;
  assert.equal(child.killed, false, 'an exited child was killed again');
});

test('a child whose input cannot be closed is still killed after the grace period', async () => {
  const child = new FakeChild();
  child.stdin.end = () => {
    throw new Error('pipe refused to close');
  };
  const session = new AgentSession(
    'blocked-pipe',
    claudeIdlePlan(CLAUDE, WS),
    () => child,
    () => {},
    () => {},
    1000,
    20,
  );

  vi.useFakeTimers();
  const disposing = session.dispose();
  await vi.advanceTimersByTimeAsync(60);
  vi.useRealTimers();
  assert.equal(child.killed, true, 'a failed input close disabled the shutdown backstop');
  child.exit(null, 'SIGTERM');
  await disposing;
});

test('a press on the servers switch works with no session running', async () => {
  // MCP changes before the first prompt use a separate idle child. Apply the change, then read the resulting server state.

  const children: FakeChild[] = [];
  const done = askIdleMcpChange(
    claudeIdlePlan(CLAUDE, WS),
    () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    [{ serverName: 'notes', enabled: false }],
  );
  await tick();
  const child = children[0];
  child.answerHandshake();
  await tick();
  const read = () => child.sent().map((m) => m.request as { subtype: string; serverName?: string; enabled?: boolean });
  // mcp_toggle carries the server name and an explicit enabled value for either toggle direction.

  assert.equal(read()[1].serverName, 'notes');
  assert.equal(read()[1].enabled, false);
  child.answerControl('mcp_toggle', {});
  await tick();
  // The reading is taken after the change and not worked out from it. A toggle answers with
  // an empty body, so what the servers are now is knowable only by asking.
  assert.deepEqual(
    read().map((r) => r.subtype),
    ['initialize', 'mcp_toggle', 'mcp_status'],
  );
  child.answerControl('mcp_status', { mcpServers: [{ name: 'notes', status: 'disabled', tools: [] }] });
  await tick();
  assert.equal(child.ended, true, 'the press left its child running');
  child.exit(0);
  const result = await done;
  assert.deepEqual(result.failures, []);
  assert.deepEqual(
    result.servers?.map((s) => s.status),
    ['disabled'],
  );
  // The child exits without being killed, allowing normal shutdown.
  assert.equal(child.killed, false, 'the child was killed instead of allowed to close');
});

test('a press that could not start a child says so rather than doing nothing quietly', async () => {
  // A failed child launch must report a failure for the requested MCP change.

  const children: FakeChild[] = [];
  const done = askIdleMcpChange(
    claudeIdlePlan(CLAUDE, WS),
    () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    [{ serverName: 'notes', enabled: true }],
  );
  await tick();
  children[0].exit(1);
  const result = await done;
  assert.equal(result.servers, null);
  assert.deepEqual(result.failures, []);
  assert.ok(result.refusal, 'a child that never came up was reported as nothing at all');
});

test('a change waits for its child to go, because that is when the change is written', async () => {
  // Wait for the idle child to exit before returning the change, so the next child can read saved settings.

  const children: FakeChild[] = [];
  let settled = false;
  const done = askIdleMcpChange(
    claudeIdlePlan(CLAUDE, WS),
    () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    [{ serverName: 'notes', enabled: true }],
    1000,
  ).then((r) => {
    settled = true;
    return r;
  });
  await tick();
  const child = children[0];
  child.answerHandshake();
  await tick();
  child.answerControl('mcp_toggle', {});
  await tick();
  child.answerControl('mcp_status', { mcpServers: [{ name: 'notes', status: 'connected', tools: [] }] });
  await tick();
  await tick();
  assert.equal(settled, false, 'the change was reported done while its child was still writing');
  assert.equal(child.ended, true, 'the child was never asked to stop');
  child.exit(0);
  const result = await done;
  assert.equal(settled, true);
  assert.deepEqual(
    result.servers?.map((s) => s.name),
    ['notes'],
  );
});

test('an existing session host key is stable and names its actual id', () => {
  assert.equal(existingHostKey('claude', 'session-1'), 'claude:session-1');
  assert.equal(existingHostKey('codex', 'thread-7'), 'codex:thread-7');
});

test('a rejected first Codex prompt uses the changed effort on its next send', async () => {
  const { host, children } = fakeHost();
  const draft = newSessionDraft('retry', WS, null, 0, {
    agent: 'codex',
    model: 'gpt-5-codex',
    effort: 'retired-effort',
    permissionMode: '',
    source: 'recent',
  });
  const key = freshHostKey('codex', draft.draftId);
  const plan = (effort: string) =>
    codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT, model: draft.profile.model, effort });
  const opening = host.session(key, plan(draft.profile.effort));
  await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'initialize'));
  children[0].reply({ userAgent: 'codex' });
  await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'skills/list'));
  children[0].reply({ data: [] });
  await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'thread/start'));
  children[0].reply({ thread: { id: 'first' } });
  const first = await opening;
  const rejected = assert.rejects(first.prompt('go'), /unsupported effort/);
  await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'turn/start'));
  children[0].replyError(-32602, 'unsupported effort');
  await rejected;
  retireDraftProfile(host, draft, new McpBook(), new McpPendingRefreshes(), new Map(), new Set());
  const next = host.session(key, plan('high'));
  let reused = false;
  void next.then(() => {
    reused = true;
  });
  await vi.waitFor(() => assert.ok(children[0].ended || reused));
  if (children[0].ended) {
    children[0].exit(0);
    await vi.waitFor(() => assert.equal(children.length, 2));
    children[1].reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(children[1].sent().at(-1)?.method, 'skills/list'));
    children[1].reply({ data: [] });
    await vi.waitFor(() => assert.equal(children[1].sent().at(-1)?.method, 'thread/start'));
    children[1].reply({ thread: { id: 'second' } });
  }
  const second = await next;
  const child = children.at(-1)!;
  const sent = second.prompt('go');
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
  const turn = child.sent().at(-1);
  assert.ok(turn);
  assert.equal((turn.params as { effort: string }).effort, 'high');
  child.reply({ turn: { id: 'accepted' } });
  await sent;
  child.exit(0);
});

test('an accepted Claude prompt leaves a rejected Codex child free to retry with changed effort', async () => {
  const { host, children } = fakeHost();
  const draft = newSessionDraft('cross-agent', WS, null, 0, {
    agent: 'claude',
    model: '',
    effort: '',
    permissionMode: '',
    source: 'recent',
  });
  const claudeKey = freshHostKey('claude', draft.draftId);
  const claudePlanSource = claudePlan(CLAUDE, { cwd: WS, sessionId: 'accepted' });
  const openingClaude = host.session(claudeKey, claudePlanSource);
  children[0].answerHandshake();
  const claude = await openingClaude;
  const accepted = new Set<string>();
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const acceptance = statementFrom(source, source.indexOf('acceptedDrafts.add('));
  const delivery = claude.prompt('go').then(() => {
    runInNewContext(acceptance, { acceptedDrafts: accepted, draft, live: claude });
    throw new Error('recent-profile save failed');
  });
  await assert.rejects(delivery, /recent-profile save failed/);
  children[0].say(COMPLETED_RESULT);
  await vi.waitFor(() => assert.equal(claude.state().busy, false));
  const mcpKeys = new Map([[draft.draftId, claudeKey]]);
  retireDraftProfile(host, draft, new McpBook(), new McpPendingRefreshes(), mcpKeys, accepted);
  assert.equal(await host.session(claudeKey, claudePlanSource), claude);
  assert.equal(children[0].ended, false);

  const codexDraft = { ...draft, profile: { ...draft.profile, agent: 'codex' as const, effort: 'low' } };
  const codexKey = freshHostKey('codex', draft.draftId);
  const plan = (effort: string) => codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT, effort });
  const openingCodex = host.session(codexKey, plan('low'));
  await vi.waitFor(() => assert.equal(children[1].sent().at(-1)?.method, 'initialize'));
  children[1].reply({ userAgent: 'codex' });
  await vi.waitFor(() => assert.equal(children[1].sent().at(-1)?.method, 'skills/list'));
  children[1].reply({ data: [] });
  await vi.waitFor(() => assert.equal(children[1].sent().at(-1)?.method, 'thread/start'));
  children[1].reply({ thread: { id: 'rejected' } });
  const first = await openingCodex;
  const rejected = assert.rejects(first.prompt('go'), /unsupported effort/);
  await vi.waitFor(() => assert.equal(children[1].sent().at(-1)?.method, 'turn/start'));
  const rejectedTurn = children[1].sent().at(-1);
  assert.ok(rejectedTurn);
  assert.equal((rejectedTurn.params as { effort: string }).effort, 'low');
  children[1].replyError(-32602, 'unsupported effort');
  await rejected;
  retireDraftProfile(host, codexDraft, new McpBook(), new McpPendingRefreshes(), mcpKeys, accepted);
  const next = host.session(codexKey, plan('high'));
  let reused = false;
  void next.then(() => {
    reused = true;
  });
  await vi.waitFor(() => assert.ok(children[1].ended || reused));
  if (children[1].ended) {
    children[1].exit(0);
    await vi.waitFor(() => assert.equal(children.length, 3));
    children[2].reply({ userAgent: 'codex' });
    await vi.waitFor(() => assert.equal(children[2].sent().at(-1)?.method, 'skills/list'));
    children[2].reply({ data: [] });
    await vi.waitFor(() => assert.equal(children[2].sent().at(-1)?.method, 'thread/start'));
    children[2].reply({ thread: { id: 'retry' } });
  }
  const second = await next;
  const child = children.at(-1)!;
  const sent = second.prompt('go');
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
  const retriedTurn = child.sent().at(-1);
  assert.ok(retriedTurn);
  const effort = (retriedTurn.params as { effort: string }).effort;
  child.reply({ turn: { id: 'accepted' } });
  await sent;
  const claudeEnded = children[0].ended;
  const claudeKept = host.get(claudeKey) === claude;
  for (const child of children) child.exit(0);
  assert.equal(effort, 'high');
  assert.equal(claudeEnded, false);
  assert.equal(claudeKept, true);
});

test('an accepted first prompt keeps its child when later delivery work fails', async () => {
  for (const agent of ['claude', 'codex'] as const) {
    const { host, children } = fakeHost();
    const draft = newSessionDraft('accepted', WS, null, 0, {
      agent,
      model: '',
      effort: '',
      permissionMode: '',
      source: 'recent',
    });
    const key = freshHostKey(agent, draft.draftId);
    const opening = host.session(
      key,
      agent === 'claude'
        ? claudePlan(CLAUDE, { cwd: WS, sessionId: 'accepted' })
        : codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }),
    );
    if (agent === 'claude') children[0].answerHandshake();
    else {
      children[0].reply({ userAgent: 'codex' });
      await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'skills/list'));
      children[0].reply({ data: [] });
      await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'thread/start'));
      children[0].reply({ thread: { id: 'accepted' } });
    }
    const session = await opening;
    const prompt = session.prompt('go');
    if (agent === 'codex') {
      await vi.waitFor(() => assert.equal(children[0].sent().at(-1)?.method, 'turn/start'));
      children[0].reply({ turn: { id: 'accepted' } });
    }
    await prompt;
    if (agent === 'claude') children[0].say(COMPLETED_RESULT);
    else
      children[0].say(
        JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'accepted', turn: { id: 'accepted', status: 'completed' } },
        }) + '\n',
      );
    await vi.waitFor(() => assert.equal(session.state().busy, false));
    const keys = new Map([[draft.draftId, key]]);
    retireDraftProfile(host, draft, new McpBook(), new McpPendingRefreshes(), keys, new Set([key]));
    let kept = false;
    void host
      .session(
        key,
        agent === 'claude'
          ? claudePlan(CLAUDE, { cwd: WS, sessionId: 'accepted' })
          : codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }),
      )
      .then((next) => {
        kept = next === session;
      });
    await vi.waitFor(() => assert.ok(kept || children[0].ended));
    assert.equal(children[0].ended, false);
    assert.equal(children[0].killed, false);
    assert.equal(host.get(key), session);
    assert.equal(keys.size, 0);
    children[0].exit(0);
  }
});

test('a draft profile change retires each distinct fresh and MCP child once', () => {
  for (const agent of ['claude', 'codex'] as const) {
    const draft = { draftId: 'changed', profile: { agent } };
    const fresh = freshHostKey(agent, draft.draftId);
    for (const mcpKey of [fresh, 'another-child']) {
      const keys = new Map([[draft.draftId, mcpKey]]);
      const retired: string[] = [];
      const host = {
        retireSession: async (key: string) => {
          retired.push(key);
        },
      } as unknown as AgentHost;
      const mcp = new McpBook();
      mcp.note(draft.draftId, SOME_SERVERS);
      retireDraftProfile(host, draft, mcp, new McpPendingRefreshes(), keys, new Set());
      assert.deepEqual(retired.sort(), [...new Set([fresh, mcpKey])].sort());
      assert.equal(keys.size, 0);
      assert.equal(mcp.get(draft.draftId), null);
    }
  }
});

test('fresh host keys are unique when the draft ids differ', () => {
  assert.equal(freshHostKey('claude', 'draft-a'), 'claude:fresh:draft-a');
  assert.notEqual(freshHostKey('codex', 'draft-a'), freshHostKey('codex', 'draft-b'));
});

test('a fresh host key cannot collide with an existing session key', () => {
  assert.notEqual(freshHostKey('codex', 'thread-7'), existingHostKey('codex', 'thread-7'));
});

// What each agent published, cut to what a draft's pickers need: the model the setup was
// copied on, and a second one the reader can move to with an effort level of its own.
const DRAFT_MODELS = {
  claude: [
    { value: 'opus', label: 'Opus 5', description: '', efforts: [{ value: 'high', label: 'high', description: '' }] },
    {
      value: 'sonnet',
      label: 'Sonnet 4.5',
      description: '',
      efforts: [
        { value: 'low', label: 'low', description: '' },
        { value: 'high', label: 'high', description: '' },
      ],
    },
  ],
  codex: [
    {
      value: 'gpt-5',
      label: 'GPT-5',
      description: '',
      efforts: [{ value: 'medium', label: 'medium', description: '' }],
    },
    {
      value: 'gpt-5-codex',
      label: 'GPT-5 Codex',
      description: '',
      efforts: [{ value: 'xhigh', label: 'xhigh', description: '' }],
    },
  ],
};

// Build a frozen draft after model, effort, and permission picks. Claude launch flags and Codex thread settings must retain that draft's values.

function draftAfterPicks(agent: 'claude' | 'codex', model: string, effort: string, permission: string) {
  const catalog = DRAFT_MODELS[agent];
  const inherited: SessionProfile = {
    agent,
    model: catalog[0].value,
    effort: catalog[0].efforts[0].value,
    permissionMode: defaultAskMode(agent).value,
    source: 'inherited',
  };
  const onModel = draftProfileAfterPick(inherited, 'model', model, DRAFT_MODELS);
  assert.ok(onModel, `the model menu refused ${model}, so the press this test is about never happened`);
  const onEffort = draftProfileAfterPick(onModel, 'effort', effort, DRAFT_MODELS);
  assert.ok(onEffort, `the effort menu refused ${effort}, so the press this test is about never happened`);
  // Use a permission pick different from the inherited value so the fixture requires a changed draft.

  assert.notEqual(
    permission,
    inherited.permissionMode,
    `${permission} is what this draft already asks for, so the press this test is about changes nothing`,
  );
  const onPermission = draftProfileAfterPick(onEffort, 'askmode', permission, DRAFT_MODELS);
  assert.ok(onPermission, `the permission menu refused ${permission}, so the press this test is about never happened`);
  // The edited draft records the picked profile as reader-owned. That ownership field does not become a launch argument.

  return newSessionDraft(`draft-${agent}`, WS, 's1', 0, onPermission, null, true);
}

test('a draft the reader changed starts its child on the setup it now holds', { timeout: 5000 }, async () => {
  // Build both agents' launch plans from the frozen draft and check each selected value.

  const claude = draftAfterPicks('claude', 'sonnet', 'low', 'plan');
  const claudeMode = askMode(claude.profile.agent, claude.profile.permissionMode);
  assert.ok(claudeMode);
  const args = claudePlan(CLAUDE, {
    cwd: claude.cwd,
    sessionId: 'c0ffee',
    permissionMode: claudeAskMode(claudeMode),
    model: claude.profile.model,
    effort: claude.profile.effort,
  }).args;
  assert.equal(
    args[args.indexOf('--model') + 1],
    'sonnet',
    'the Claude child is started on a model the reader moved away from',
  );
  assert.equal(
    args[args.indexOf('--effort') + 1],
    'low',
    'the Claude child is started at a level the reader moved away from',
  );
  // The permission pick remains independent of model and effort picks.

  assert.equal(
    args[args.indexOf('--permission-mode') + 1],
    'plan',
    'the Claude child is started on a permission the reader moved away from',
  );

  const codex = draftAfterPicks('codex', 'gpt-5-codex', 'xhigh', 'never');
  const codexMode = askMode(codex.profile.agent, codex.profile.permissionMode);
  assert.ok(codexMode);
  const h = fakeHost();
  const opening = h.host.session(
    freshHostKey('codex', codex.draftId),
    codexPlan(CODEX, {
      cwd: codex.cwd,
      clientInfo: CODEX_CLIENT,
      ...codexAskMode(codexMode),
      model: codex.profile.model,
      effort: codex.profile.effort,
    }),
  );
  const child = h.children[0];
  await answerCodexHandshake(child);
  // Codex thread/start carries both the approval policy and the selected sandbox.

  const start = child.sent().find((m) => m.method === 'thread/start');
  assert.deepEqual(
    {
      approvalPolicy: (start?.params as { approvalPolicy?: string })?.approvalPolicy,
      sandbox: (start?.params as { sandbox?: string })?.sandbox,
    },
    { approvalPolicy: 'never', sandbox: 'danger-full-access' },
    'the Codex thread opens on a permission the reader moved away from',
  );
  child.reply({ thread: { id: 'thread-1' } });
  const session = await opening;
  // Inspect the sent turn request without waiting for a server response.

  void session.prompt('go');
  await tick();
  const turn = child.sent().find((m) => m.method === 'turn/start');
  assert.deepEqual(
    { model: (turn?.params as { model?: string })?.model, effort: (turn?.params as { effort?: string })?.effort },
    { model: 'gpt-5-codex', effort: 'xhigh' },
    'a Codex thread carries no effort field, so a level the reader changed rides the turn or reaches nothing',
  );
});

// What Arc sends a Claude child for a rename. Claude Code answers it on the control channel
// and writes no `result`, so the turn the reader is watching is untouched either way.
const RENAME_REQUEST = { subtype: 'rename_session', title: 'Complete name', source: 'host', session_id: 'session-7' };
const renameRequests = (child: FakeChild) =>
  child.sent().filter((message) => (message.request as { subtype?: string } | undefined)?.subtype === 'rename_session');

// Answers one rename by its place in the line, because a session can send a second rename
// while the first is still waiting, and `answerControl` always finds the first.
function answerRename(child: FakeChild, index = 0, error?: string): void {
  const found = renameRequests(child)[index];
  if (!found) {
    throw new Error('no rename to answer');
  }
  child.say(
    JSON.stringify({
      type: 'control_response',
      response: error
        ? { subtype: 'error', request_id: found.request_id, error }
        : { subtype: 'success', request_id: found.request_id, response: {} },
    }) + '\n',
  );
}
const MODEL_TURN = (message: Record<string, unknown>) =>
  message.method === 'turn/start' || message.method === 'thread/start' || message.method === 'thread/resume';
const NO_IDLE_PLAN = (): AgentPlan => {
  throw new Error('a live rename started a rename-only child');
};
const claudeRenameChild = () => claudeRenamePlan(CLAUDE, { cwd: WS, resume: 'session-7', title: 'Complete name' });
const codexRenameChild = () =>
  codexRenamePlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT, threadId: 'thread-7', title: 'Complete name' });

async function liveClaude(
  host: AgentHost,
  children: FakeChild[],
): Promise<{ session: AgentSession; child: FakeChild }> {
  const opening = host.session('claude', claudePlan(CLAUDE, { cwd: WS, resume: 'session-7' }));
  const child = children.at(-1)!;
  child.answerHandshake();
  return { session: await opening, child };
}

test('a live Claude session renames through its child with no model turn and no timeline event', async () => {
  const { host, children, events } = fakeHost();
  const { session, child } = await liveClaude(host, children);
  const before = events.length;
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', NO_IDLE_PLAN);
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  assert.deepEqual(renameRequests(child)[0].request, RENAME_REQUEST);
  assert.deepEqual(
    child.sent().filter((message) => message.type === 'user'),
    [],
    'the rename went out as a typed command',
  );
  assert.equal(session.state().busy, false, 'a rename drew the session as working');
  answerRename(child);
  await renamed;
  assert.deepEqual(
    events
      .slice(before)
      .map(({ event }) => event.kind)
      .filter((kind) => kind !== 'session'),
    [],
    'the command reply reached the timeline',
  );
  assert.equal(children.length, 1, 'a live rename started another child');
});

test('a second rename of one live Claude session waits for the first to settle', async () => {
  const { host, children } = fakeHost();
  const { child } = await liveClaude(host, children);
  const first = host.renameSession('claude', 'session-7', 'Complete name', NO_IDLE_PLAN);
  const second = host.renameSession('claude', 'session-7', 'Second name', NO_IDLE_PLAN);
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  // Serialize renames so each reads the transcript after the preceding rename settles.

  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
  assert.equal(renameRequests(child).length, 1, 'the second rename went out beside the first');
  answerRename(child, 0);
  await first;
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 2));
  assert.equal((renameRequests(child)[1].request as { title?: string }).title, 'Second name');
  answerRename(child, 1);
  await second;
});

test('a Claude rename goes out while a turn runs, and a refusal leaves that turn alone', async () => {
  const { host, children, events } = fakeHost();
  const { session, child } = await liveClaude(host, children);
  await session.prompt('working');
  assert.equal(session.state().busy, true);
  const refused = session.rename('session-7', 'Complete name');
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  answerRename(child, 0, 'title must be non-empty');
  await assert.rejects(refused, /title must be non-empty/);
  assert.equal(session.state().busy, true, 'a refused rename ended the running turn');
  const renamed = session.rename('session-7', 'Complete name');
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 2));
  answerRename(child, 1);
  await renamed;
  assert.equal(session.state().busy, true, 'the rename ended the running turn');
  child.say(COMPLETED_RESULT);
  assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').length, 1);
  assert.equal(session.state().busy, false);
});

test('a live rename carries the session id the host resolved, not the one its child moved to', async () => {
  const { host, children } = fakeHost();
  // Keep the session ID resolved by the host in the rename request. A changed child ID must not redirect it.

  const ordinary = claudePlan(CLAUDE, { cwd: WS, resume: 'session-7' });
  let watching = false;
  let lookedUp = false;
  const plan: AgentPlan = {
    ...ordinary,
    driver(send, emit) {
      const child = ordinary.driver(send, emit);
      return {
        ...child,
        sessionId: () => {
          if (!watching) {
            return child.sessionId();
          }
          if (!lookedUp) {
            lookedUp = true;
            return child.sessionId();
          }
          return 'session-9';
        },
      };
    },
  };
  const opening = host.session('claude', plan);
  const child = children.at(-1)!;
  child.answerHandshake();
  await opening;
  watching = true;
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', NO_IDLE_PLAN);
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  assert.deepEqual(renameRequests(child)[0].request, RENAME_REQUEST);
  answerRename(child);
  await renamed;
});

test('a rename right after Stop goes out at once and never takes the stopped turn ending', async () => {
  const { host, children, events } = fakeHost();
  const { session, child } = await liveClaude(host, children);
  await session.prompt('first');
  const stopping = session.interrupt();
  child.answerControl('interrupt', {});
  await stopping;
  assert.equal(session.state().busy, false);
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', NO_IDLE_PLAN);
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  answerRename(child);
  await renamed;
  assert.deepEqual(
    events.filter(({ event }) => event.kind === 'turnEnd'),
    [],
    'the rename was read as the stopped turn ending',
  );
  child.say(ABORTED_RESULT);
  assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').length, 1);
  assert.equal(session.state().busy, false);
});

test('a live Claude rename with no answer fails and leaves the session and its child running', async () => {
  const { host, children, events } = fakeHost();
  const plan: AgentPlan = {
    ...claudePlan(CLAUDE, { cwd: WS, resume: 'session-7' }),
    driver(send, emit) {
      const wire = new ClaudeWire({ send, emit, sessionId: 'session-7', deadlineMs: 1 });
      return {
        receive: (line) => wire.receive(line),
        open: () => wire.initialize(),
        prompt: (input) => wire.prompt(input),
        compact: () => Promise.reject(new Error('not used')),
        clear: () => Promise.reject(new Error('not used')),
        answer: (id, answer) => wire.answer(id, answer),
        interrupt: () => wire.interrupt(true),
        sessionId: () => wire.sessionId(),
        close: (reason) => wire.close(reason),
        rename: (sessionId, title) => wire.renameSession(sessionId, title),
      };
    },
  };
  const opening = host.session('claude', plan);
  const child = children[0];
  child.answerHandshake();
  const session = await opening;
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(host.renameSession('claude', 'session-7', 'Complete name', NO_IDLE_PLAN), /did not answer/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(session.state().exited, false, 'a rename that went unanswered took the session down');
  assert.equal(child.ended, false, 'a rename that went unanswered ended the child');
  assert.equal(host.find('claude', 'session-7'), session);
  await session.prompt('a real prompt');
  child.say(COMPLETED_RESULT);
  assert.equal(events.filter(({ event }) => event.kind === 'turnEnd').length, 1);
});

test('an idle Claude session renames through a rename-only child that sends no prompt and lists no session', async () => {
  const { host, children, commands } = fakeHost();
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', claudeRenameChild);
  const child = children[0];
  child.answerHandshake();
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  assert.deepEqual(renameRequests(child)[0].request, RENAME_REQUEST);
  assert.ok(
    commands[0].includes('--resume') && commands[0].includes('session-7'),
    'the child did not resume the session it renames',
  );
  assert.deepEqual(host.states(), [], 'the rename-only child drew as a running session');
  answerRename(child);
  await vi.waitFor(() => assert.equal(child.ended, true));
  child.exit(0);
  await renamed;
  assert.deepEqual(
    child.sent().filter((message) => message.type === 'user'),
    [],
    'the rename child sent a user message',
  );
});

test('an idle Claude rename rejects with the refusal Claude Code reported', async () => {
  const { host, children } = fakeHost();
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', claudeRenameChild);
  const child = children[0];
  child.answerHandshake();
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  answerRename(child, 0, 'rename denied');
  await vi.waitFor(() => assert.equal(child.ended, true));
  child.exit(0);
  await assert.rejects(renamed, /rename denied/);
});

test('a rename during the session opening renames through the opened child', async () => {
  const { host, children } = fakeHost();
  const opening = host.session('claude', claudePlan(CLAUDE, { cwd: WS, resume: 'session-7' }));
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', NO_IDLE_PLAN);
  await tick();
  assert.equal(children.length, 1, 'a rename started a second writer beside the opening one');
  children[0].answerHandshake();
  await opening;
  await vi.waitFor(() => assert.equal(renameRequests(children[0]).length, 1));
  answerRename(children[0]);
  await renamed;
  assert.equal(children.length, 1);
});

test('a session opening waits for a rename-only child to exit before it starts its writer', async () => {
  const { host, children } = fakeHost();
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', claudeRenameChild);
  children[0].answerHandshake();
  await vi.waitFor(() => assert.equal(renameRequests(children[0]).length, 1));
  const opening = host.session('claude', claudePlan(CLAUDE, { cwd: WS, resume: 'session-7' }));
  answerRename(children[0]);
  await vi.waitFor(() => assert.equal(children[0].ended, true));
  await tick();
  assert.equal(children.length, 1, 'the writer started while the rename-only child was still running');
  children[0].exit(0);
  await renamed;
  await vi.waitFor(() => assert.equal(children.length, 2));
  children[1].answerHandshake();
  await opening;
});

test('a rename waits for a retiring writer to exit before its rename-only child starts', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, children } = fakeHost(undefined, undefined, { timer });
  await liveClaude(host, children);
  settle(host, 'claude');
  timer.fire(timer.tasks.length - 1);
  assert.equal(children[0].ended, true, 'the idle child did not retire');
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', claudeRenameChild);
  await tick();
  assert.equal(children.length, 1, 'the rename-only child started beside a writer that had not exited');
  children[0].exit(0);
  await vi.waitFor(() => assert.equal(children.length, 2));
  children[1].answerHandshake();
  await vi.waitFor(() => assert.equal(renameRequests(children[1]).length, 1));
  answerRename(children[1]);
  await vi.waitFor(() => assert.equal(children[1].ended, true));
  children[1].exit(0);
  await renamed;
});

test('host disposal ends a rename-only child and fails its rename', async () => {
  const { host, children } = fakeHost();
  const renamed = host.renameSession('claude', 'session-7', 'Complete name', claudeRenameChild);
  const refused = assert.rejects(renamed);
  host.dispose();
  assert.equal(children[0].ended, true, 'host disposal left the rename-only child running');
  children[0].exit(0);
  await refused;
  await assert.rejects(
    host.renameSession('claude', 'session-7', 'Complete name', claudeRenameChild),
    /no longer running/,
  );
});

// The saved title file Claude Code writes beside a transcript, for the confirmation to read.
function renamedTranscript(saved: string | null): string {
  const dir = tempDir('rename-');
  const file = path.join(dir, 'session-7.jsonl');
  fs.writeFileSync(file, '');
  if (saved !== null) {
    fs.mkdirSync(path.join(dir, 'session-7'));
    fs.writeFileSync(path.join(dir, 'session-7', 'custom-title.json'), JSON.stringify({ customTitle: saved }));
  }
  return file;
}

async function renameAndConfirm(saved: string | null, title = 'Complete name'): Promise<void> {
  const { host, children } = fakeHost();
  const { child } = await liveClaude(host, children);
  const renamed = renameAgentSession(
    host,
    {
      agent: 'claude',
      sessionId: 'session-7',
      title,
      file: renamedTranscript(saved),
      idlePlan: NO_IDLE_PLAN,
    },
    { attempts: 2, pause: async () => undefined },
  );
  await vi.waitFor(() => assert.equal(renameRequests(child).length, 1));
  answerRename(child);
  await renamed;
}

test('a Claude rename counts only when the saved title file holds the whole requested name', async () => {
  await renameAndConfirm('Complete name');
  await assert.rejects(renameAndConfirm('Old name'), /did not save/);
  await assert.rejects(renameAndConfirm(null), /did not save/);
  const long = 'x'.repeat(200);
  await assert.rejects(
    renameAndConfirm(`${long}y`, long),
    /did not save/,
    'an unchanged saved title that starts with the requested name confirmed it',
  );
});

test('a live Codex session renames through thread/name/set while its turn runs, with no model turn of its own', async () => {
  const { host, children } = fakeHost();
  const opening = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT, resume: 'thread-7' }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  await tick();
  const session = await opening;
  // The server names a thread while it is working on it, so the rename rides the open turn.
  // Nothing answers the turn, so this promise settles when the host takes the child down
  // after the test. Its failure is caught here, where it cannot be read as another test's.
  const working = session.prompt('working');
  working.catch(() => undefined);
  await tick();
  assert.equal(session.state().busy, true);
  const before = child.sent().length;
  const renamed = renameAgentSession(host, {
    agent: 'codex',
    sessionId: 'thread-7',
    title: 'Complete name',
    file: 'unused.jsonl',
    idlePlan: NO_IDLE_PLAN,
  });
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/name/set'));
  const request = child.sent().at(-1);
  assert.deepEqual(request, {
    id: request?.id,
    method: 'thread/name/set',
    params: { threadId: 'thread-7', name: 'Complete name' },
  });
  child.reply({});
  await renamed;
  assert.equal(child.sent().slice(before).some(MODEL_TURN), false);
  assert.equal(session.state().busy, true, 'the rename ended the running turn');
});

test('an idle Codex session renames through a handshake-only child and never opens the thread', async () => {
  const { host, children } = fakeHost();
  const renamed = host.renameSession('codex', 'thread-7', 'Complete name', codexRenameChild);
  const child = children[0];
  child.reply({ userAgent: 'codex' });
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/name/set'));
  assert.deepEqual(child.sent().at(-1)?.params, { threadId: 'thread-7', name: 'Complete name' });
  child.reply({});
  await vi.waitFor(() => assert.equal(child.ended, true));
  child.exit(0);
  await renamed;
  assert.equal(child.sent().some(MODEL_TURN), false);
});

test.each(['reader-first', 'initial-first'] as const)(
  'a reader rename wins across the host rename queue with %s',
  async (order) => {
    const { host, children } = fakeHost();
    const opening = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT, resume: 'thread-7' }));
    const child = children[0];
    await answerCodexHandshake(child);
    child.reply({ thread: { id: 'thread-7' } });
    await opening;
    const openedFrames = child.sent().length;
    let current = true;
    const first = host.renameSession(
      'codex',
      'thread-7',
      order === 'reader-first' ? 'Reader name' : 'Initial name',
      NO_IDLE_PLAN,
    );
    await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/name/set'));
    const before = child.sent().filter((frame) => frame.method === 'thread/name/set').length;
    const second = host.renameSession(
      'codex',
      'thread-7',
      order === 'reader-first' ? 'Initial name' : 'Reader name',
      NO_IDLE_PLAN,
      order === 'reader-first' ? () => current : undefined,
    );
    const outcome = second.catch((error) => error);
    current = false;
    child.reply({});
    await first;
    if (order === 'reader-first') {
      assert.match((await outcome).message, /cancelled/);
      assert.equal(child.sent().filter((frame) => frame.method === 'thread/name/set').length, before);
    } else {
      await vi.waitFor(() => assert.equal((child.sent().at(-1)?.params as any)?.name, 'Reader name'));
      child.reply({});
      await second;
      assert.equal(
        (
          child
            .sent()
            .filter((frame) => frame.method === 'thread/name/set')
            .at(-1)?.params as any
        )?.name,
        'Reader name',
      );
    }
    assert.equal(children.length, 1);
    assert.equal(child.sent().slice(openedFrames).some(MODEL_TURN), false);
  },
);

test('an idle Codex rename rejects with the server refusal', async () => {
  const { host, children } = fakeHost();
  const renamed = host.renameSession('codex', 'thread-7', 'Complete name', codexRenameChild);
  const child = children[0];
  child.reply({ userAgent: 'codex' });
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/name/set'));
  child.replyError(-32000, 'name refused');
  await vi.waitFor(() => assert.equal(child.ended, true));
  child.exit(0);
  await assert.rejects(renamed, /name refused/);
  assert.equal(child.sent().some(MODEL_TURN), false);
});

test('initial-name validity is checked after the child activity wait immediately before writing', async () => {
  const { host, children } = fakeHost();
  const opening = host.session('cx', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT, resume: 'thread-7' }));
  const child = children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-7' } });
  await opening;
  const activity = host.withActivity.bind(host);
  let release = () => {};
  let entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = vi.spyOn(host, 'withActivity').mockImplementation(async (key, work) => {
    entered = true;
    await held;
    return activity(key, work);
  });
  let current = true;
  const renamed = host.renameSession('codex', 'thread-7', 'Initial name', NO_IDLE_PLAN, () => current);
  const refused = assert.rejects(renamed, /cancelled/);
  try {
    await vi.waitFor(() => assert.equal(entered, true));
    current = false;
    release();
    await refused;
    assert.equal(
      child.sent().some((frame) => frame.method === 'thread/name/set'),
      false,
    );
  } finally {
    release();
    wait.mockRestore();
  }
});

test('Codex live input preserves dispatch root ownership and adds no completion', async () => {
  const f = fakeHost();
  const opening = f.host.session('steer-root', codexPlan(CODEX, { cwd: WS, clientInfo: CODEX_CLIENT }));
  const child = f.children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: 'thread-live' } });
  const session = await opening;
  const prompting = session.prompt('original work');
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'turn/start'));
  child.reply({ turn: { id: 'root-live' } });
  child.say(
    JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-live', turn: { id: 'root-live' } } }) + '\n',
  );
  const owner = await prompting;
  assert.equal(session.guardedLiveReason(), null);
  const attempt = session.guardedLive('reader correction', 'uuid-steer', () =>
    assert.fail('steer created another submission'),
  );
  assert.equal(child.sent().at(-1)?.method, 'turn/steer');
  child.reply({ turnId: 'root-live' });
  assert.equal((await attempt.receipt).outcome, 'accepted');
  assert.equal(session.nativeTurnIdentity(owner), 'root-live');
  assert.equal(session.dispatchRootActive(owner), true);
  child.say(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-live', turn: { id: 'root-live', status: 'completed', items: [] } },
    }) + '\n',
  );
  assert.equal(session.state().busy, false);
  assert.equal(session.guardedTurnEnds(), 1);
  f.host.dispose();
});

test('Claude live input retains native generations through joined completion and the turn-end replay race', async () => {
  const f = fakeHost();
  const opening = f.host.session('live-claude', claudePlan(CLAUDE, { cwd: WS, sessionId: 'live-claude' }));
  const child = f.children[0];
  child.answerHandshake();
  const session = await opening;
  await session.prompt('original work');
  child.say(sessionState('running'));
  assert.equal(session.guardedLiveReason(), null);
  let submission: number | undefined;
  const live = session.guardedLive('reader correction', 'uuid-live', (id) => {
    submission = id;
  });
  await live.written;
  assert.ok(submission);
  await vi.waitFor(() => assert.equal(session.guardedLiveReason(), null));
  child.say(
    JSON.stringify({ type: 'result', subtype: 'success', result: 'original finished', session_id: 'live-claude' }) +
      '\n',
  );
  assert.equal(live.settled, null);
  child.say(
    JSON.stringify({
      type: 'user',
      isReplay: true,
      uuid: 'uuid-live',
      session_id: 'live-claude',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'reader correction' }] },
    }) + '\n',
  );
  assert.equal((await live.receipt).outcome, 'accepted');
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false);
  assert.equal(session.guardedTurnEnds(), 1);
  f.host.dispose();
});

test('an ordinary Claude child acknowledges guarded continuation, requires idle evidence, and never reopens after retirement', async () => {
  const fake = fakeHost();
  const starting = fake.host.session('guarded', claudePlan(CLAUDE, { cwd: WS, sessionId: 'worker-session' }));
  const child = fake.children[0];
  child.answerHandshake();
  const session = await starting;
  assert.ok(fake.commands[0].includes('--replay-user-messages'));
  assert.equal(session.guardedIdle(), 'unconfirmed', 'initial busy false alone is not idle evidence');
  await session.prompt('initial assignment');
  assert.equal(session.guardedIdle(), 'busy');
  child.say(sessionState('running'));
  child.say(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\n');
  child.say(sessionState('idle'));
  assert.equal(session.guardedIdle(), null);

  let receiptSettled = false;
  let boundaryChecked = false;
  const attempt = await fake.host.withActivity('guarded', async (live) => {
    const written = live.guardedPrompt('Apply the accepted corrections.', 'uuid-guarded', undefined, () => {
      assert.equal(
        child.sent().some((line) => line.uuid === 'uuid-guarded'),
        false,
      );
      boundaryChecked = true;
    });
    void written.receipt.then(() => (receiptSettled = true));
    await written.written;
    return written;
  });
  assert.ok(attempt);
  assert.equal(boundaryChecked, true);
  assert.equal(receiptSettled, false, 'the activity lease ends at the write, before any receipt');
  assert.equal(session.guardedIdle(), 'busy');
  const line = child.sent().at(-1)!;
  assert.equal(line.uuid, 'uuid-guarded');
  child.say(
    JSON.stringify({
      type: 'user',
      isReplay: true,
      uuid: 'uuid-guarded',
      session_id: 'worker-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Apply the accepted corrections.' }] },
    }) + '\n',
  );
  assert.equal((await attempt.receipt).outcome, 'accepted');

  const pending = session.guardedPrompt('Uncertain follow-up.', 'uuid-exit');
  await pending.written;
  child.exit(1);
  assert.equal((await pending.receipt).outcome, 'unknown');
  assert.equal(session.guardedIdle(), 'unavailable');
  assert.equal(await fake.host.withActivity('guarded', async () => 'reopened'), null);
  assert.equal(fake.host.find('claude', 'worker-session'), null);
  assert.equal(fake.children.length, 1, 'no second writer starts');
});

// Replays recorded Claude Code stream-json: the reader turn launches a background command and a
// background subagent, then Claude starts two turns by itself as their task notices arrive.
function agentStartedTurns(window: string, ids: readonly string[]) {
  const lines = fs
    .readFileSync(path.join(__dirname, '../test/fixtures/claude-agent-started-turns-2.1.302.jsonl'), 'utf8')
    .trim()
    .split('\n');
  let index = 0;
  return lines.map((line) => {
    const literal = (id: string) =>
      `arc compact request --self --after-turn --request-id ${window}:${id} --window ${window} --json`;
    const command = line.includes('{{compact}}')
      ? line.replace('{{compact}}', literal(ids[index++]))
      : line.includes('"echo noticed"') && index < ids.length
        ? line.replace('echo noticed', literal(ids[index++]))
        : line;
    return command;
  });
}

function compactionThroughHost(
  options: {
    holder?: ReplyHolder & {
      noteResponseEnded?: (session: string, outcome: unknown, turnId?: number) => void;
      flushQueue?: (session: string) => void;
    };
    readerWork?: (session: string) => 'none' | 'pending' | 'absent' | 'unknown';
    now?: () => number;
    automatic?: boolean;
    authority?: (provider: 'claude' | 'codex', session: string) => string | null;
    source?: (provider: 'claude' | 'codex', session: string) => string | null;
  } = {},
) {
  const window = 'c'.repeat(24);
  const ids = ['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444'];
  const payload = (id: string) => ({
    requestId: `${window}:${id}`,
    window,
    self: true as const,
    afterTurn: true as const,
  });
  const owners: (number | undefined)[] = [];
  const events: { kind: string; turnId: number | undefined }[] = [];
  const replies = new RecordedReplies();
  const holder = options.holder ?? {
    noteRecordedReply: (
      session: string,
      sourceId: string,
      text: string,
      saved: () => void,
      wanted: () => boolean,
      identity?: { provider: 'claude' | 'codex'; nativeTurnId?: string; ownerTurnId?: number },
    ) => replies.note(session, { sourceId, text, saved, wanted, ...identity }),
    noteCompletedReply: () => {},
    settleRecordedReplies: () => {},
  };
  let current: CompactChild | null = null;
  const compaction = new CompactHost<CompactChild>(
    window,
    {
      find: (_provider, sessionId) => (current?.state().sessionId === sessionId ? current : null),
      withActivity: (child, work) => host.withActivity(child.key, work),
      readerWork: options.readerWork ?? (() => 'none'),
      authority: options.authority,
      source: options.source,
    },
    options.now,
  );
  const { host, children } = fakeHost(undefined, options.now, {
    onNativeObservation: (key, event) => {
      const child = host.get(key);
      if (child) compaction.observeNative(child, event);
    },
    onEvent: ({ key, event, turnId }) => {
      const child = host.get(key) as unknown as (CompactChild & { startedByAgent?: (id: number) => boolean }) | null;
      if (!child) return;
      events.push({ kind: event.kind === 'native' ? event.event.kind : event.kind, turnId });
      if (event.kind === 'native' && event.event.kind === 'toolStart') owners.push(turnId);
      if (event.kind === 'turnEnd')
        options.holder?.noteResponseEnded?.(child.state().sessionId!, event.outcome, turnId);
      // The window's own routing, with a panel that holds recorded replies.
      routeCompactionEvent(compaction, holder, child, event, turnId);
      if (event.kind === 'turnEnd') {
        if (options.automatic) options.holder?.flushQueue?.(child.state().sessionId!);
        compaction.turnEnded(child);
      }
      if (options.automatic && (event.kind === 'turnEnd' || (event.kind === 'sessionState' && event.state === 'idle')))
        void compaction.drain(child.state().sessionId!);
    },
    onStateChange: (state) => {
      if (options.automatic && !state.busy && !state.exited && state.sessionId) void compaction.drain(state.sessionId);
    },
  });
  return {
    window,
    ids,
    payload,
    owners,
    events,
    replies,
    compaction,
    host,
    children,
    setCurrent: (c: CompactChild) => (current = c),
  };
}

// Replays a real joined reader receipt through the same host and compaction routing as a window.
async function joinedCompaction(options: Parameters<typeof compactionThroughHost>[0] = {}, knownSession = true) {
  const through = compactionThroughHost(options);
  const opening = through.host.session(
    'one',
    claudePlan(CLAUDE, { cwd: WS, ...(knownSession ? { sessionId: 'sess-1' } : {}) }),
  );
  through.children[0].answerHandshake();
  const session = await opening;
  through.setCurrent(session);
  const frames = fs
    .readFileSync(path.join(__dirname, '../test/fixtures/claude-joined-case-b-2.1.304.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const receipt = frames.find((entry) => entry.index === 34).frame;
  const replay = (
    prompt = through.children[0]
      .sent()
      .filter((line) => line.type === 'user')
      .at(-1)!,
  ) => {
    through.children[0].say(
      JSON.stringify({ ...receipt, uuid: prompt.uuid, session_id: 'sess-1', message: prompt.message }) + '\n',
    );
  };
  const send = (text: string) => {
    if (session.state().sessionId) through.compaction.readerAction('sess-1');
    return promptAsReader(through.compaction, session, (submitted, received) =>
      session.prompt(text, submitted, undefined, received),
    );
  };
  const tool = (id: string, command: string, input?: unknown) =>
    through.children[0].say(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: `uuid-${id}`,
        user_message_uuid: input,
        user_message_uuids: input ? [input] : undefined,
        session_id: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', id, caller: { type: 'direct' }, input: { command } }],
        },
      }) + '\n',
    );
  const literal = (id: string) =>
    `arc compact request --self --after-turn --request-id ${through.window}:${id} --window ${through.window} --json`;
  const admission = (id: string) => {
    const ready = through.compaction.handle({ method: 'compact-ready', params: through.payload(id) }) as {
      code?: string;
    };
    const request = through.compaction.handle({ method: 'compact-request', params: through.payload(id) }) as {
      state: string;
    };
    return [ready.code, request.state];
  };
  return { ...through, session, replay, send, tool, literal, admission };
}

test.each(['effort', 'compact', 'clear', 'typed effort', 'typed compact'] as const)(
  'a reader prompt after a local %s result retains compaction and response ownership',
  async (command) => {
    const responses: { text: string; sourceId?: string; turnId?: number }[] = [];
    const h = await joinedCompaction({
      holder: {
        noteRecordedReply: () => assert.fail('the reader response has an ordinary turn card'),
        noteCompletedReply: (_session, text, sourceId, turnId, saved) => {
          responses.push({ text, sourceId, turnId });
          saved?.();
        },
        settleRecordedReplies: () => {},
      },
    });
    const child = h.children[0];
    const first = await h.send('Finish the first task.');
    h.replay();
    const ending = JSON.parse(agentStartedTurns(h.window, h.ids).find((line) => line.includes('"type":"result"'))!);
    let resultIndex = 0;
    const result = (uuid: string, local?: string) =>
      child.say(
        JSON.stringify({
          ...ending,
          uuid,
          result_index: resultIndex++,
          ...(local ? { local_command: local, num_turns: 0 } : {}),
        }) + '\n',
      );
    let following: Promise<number>;
    if (command === 'effort') {
      await h.session.setEffort('low');
      following = h.send('Do the next task, then compact yourself.');
      result('first-result');
    } else {
      result('first-result');
      if (command.startsWith('typed '))
        await h.send(command === 'typed effort' ? '/effort low' : '/compact Keep the handoff.');
      else if (command === 'compact') await h.session.compact();
      else await h.session.clear();
      following = h.send('Do the next task, then compact yourself.');
    }
    const reader = await following;
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, first);
    assert.deepEqual(sentTexts(child).slice(-2), [
      command === 'effort' || command === 'typed effort'
        ? '/effort low'
        : command === 'typed compact'
          ? '/compact Keep the handoff.'
          : command === 'compact'
            ? '/compact'
            : '/clear',
      'Do the next task, then compact yourself.',
    ]);
    h.replay();
    result('command-result', command.replace('typed ', ''));
    assert.notEqual(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, reader);
    assert.equal(h.session.state().busy, true);
    h.tool('compact-after-command', h.literal(h.ids[0]));
    assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
    assert.equal(h.owners.at(-1), reader);
    assert.equal(h.session.startedByAgent(reader), false);
    child.say(
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        tool_use_result: { interrupted: false },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'compact-after-command', content: 'queued', is_error: false }],
        },
      }) + '\n',
    );
    child.say(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        uuid: 'reader-final',
        message: {
          id: 'reader-final',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Next task complete.' }],
        },
      }) + '\n',
    );
    result('reader-result');
    assert.equal(h.events.filter((event) => event.kind === 'rootEnd').at(-1)?.turnId, reader);
    assert.deepEqual(responses.at(-1), { text: 'Next task complete.', sourceId: 'reader-final', turnId: reader });
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, reader);
    assert.equal(h.compaction.requests.deliverable('sess-1').length, 1);
    assert.equal(h.session.state().busy, false);
    child.say(sessionState('idle'));
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).at(-1), '/compact');
  },
);

test('a typed local command preserves concurrent model work and its native owner', async () => {
  const h = await joinedCompaction();
  const model = await h.send('/handoff Finish the work.');
  h.replay();
  h.tool('model-work', 'echo working');
  const command = await h.send('/effort low');
  h.replay();
  const ending = JSON.parse(agentStartedTurns(h.window, h.ids).find((line) => line.includes('"type":"result"'))!);
  h.children[0].say(JSON.stringify({ ...ending, local_command: 'effort', num_turns: 0 }) + '\n');
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, command);
  h.children[0].say(sessionState('idle'));
  assert.equal(h.session.state().busy, true);
  h.tool('still-model-work', 'echo continuing');
  assert.equal(h.owners.at(-1), model);
  h.children[0].say(JSON.stringify({ ...ending, uuid: 'model-ending', result_index: 1 }) + '\n');
  assert.equal(h.events.filter((event) => event.kind === 'rootEnd').at(-1)?.turnId, model);
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, model);
  assert.equal(h.session.state().busy, false);
});

test.each([
  'acknowledged slash skill',
  'correlated slash skill',
  'ordinary reader input',
  'failed slash preparation',
] as const)('background-woken model ownership follows %s', async (input) => {
  const h = await joinedCompaction();
  await h.send('Start work.');
  h.replay();
  h.children[0].say(COMPLETED_RESULT);
  h.children[0].say(sessionState('idle'));
  h.children[0].say(sessionState('running'));
  h.tool('agent-work', 'echo working');
  const model = h.owners.at(-1)!;
  assert.equal(h.session.startedByAgent(model), true);
  let expected = model;
  if (input === 'correlated slash skill') {
    await h.send('/effort low');
    h.replay();
  }
  if (input === 'failed slash preparation') {
    await assert.rejects(
      h.session.prompt({
        text: '/handoff Finish work.',
        assets: [
          {
            id: 'missing-image',
            size: 1,
            digest: 'missing',
            path: path.join(WS, 'missing-slash-image.png'),
            name: 'missing.png',
            mime: 'image/png',
          },
        ],
      }),
    );
  } else {
    expected = await h.send(input.includes('slash skill') ? '/handoff Finish work.' : 'Finish work.');
    h.replay();
  }
  h.tool(
    'following-work',
    'echo continuing',
    h.children[0]
      .sent()
      .filter((line) => line.type === 'user')
      .at(-1)?.uuid,
  );
  assert.equal(h.owners.at(-1), expected);
  if (input === 'correlated slash skill') {
    h.children[0].say(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        local_command: 'effort',
        num_turns: 0,
        subtype: 'success',
      }) + '\n',
    );
    h.tool('skill-after-local', 'echo skill');
    assert.equal(h.owners.at(-1), expected);
  }
  h.children[0].say(COMPLETED_RESULT);
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, expected);
  h.children[0].say(sessionState('idle'));
  assert.equal(h.session.state().busy, false);
});

test.each([true, false])('negative input settles with overlapping preparation, known session %s', async (known) => {
  const h = fakeHost();
  const opening = h.host.session('one', claudePlan(CLAUDE, { cwd: WS, ...(known ? { sessionId: 'sess-1' } : {}) }));
  const child = h.children[0];
  child.answerHandshake();
  const session = await opening;
  const first = session.prompt('Continue the model work.');
  let submitted = 0;
  let receiptOwner: number | undefined;
  const second = session.prompt(
    '/effort low',
    (id) => {
      submitted = id;
    },
    undefined,
    () => {
      receiptOwner = session.readerTurnOwner(submitted);
    },
  );
  const frame = child
    .sent()
    .filter((line) => line.type === 'user')
    .at(-1)!;
  child.say(
    JSON.stringify({
      type: 'result',
      session_id: 'sess-1',
      num_turns: 0,
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      user_message_uuid: frame.uuid,
      user_message_uuids: [frame.uuid],
    }) + '\n',
  );
  child.say(JSON.stringify({ ...frame, isReplay: true, parent_tool_use_id: null, session_id: 'sess-1' }) + '\n');
  assert.equal(receiptOwner, undefined);
  const firstOwner = await first;
  const secondOwner = await second;
  assert.equal(h.events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId, secondOwner);
  assert.equal(session.readerTurnOwner(secondOwner), undefined);
  assert.equal(session.state().busy, true);
  child.say(COMPLETED_RESULT);
  assert.equal(h.events.filter((entry) => entry.event.kind === 'turnEnd').at(-1)?.turnId, firstOwner);
  child.say(sessionState('idle'));
  assert.equal(session.state().busy, false);
});

test.each(['before idle', 'after idle'] as const)(
  'rejecting one ordinary input preserves the following reader replay %s',
  async (ordering) => {
    const replies: { text: string; turnId?: number }[] = [];
    const h = await joinedCompaction({
      holder: {
        noteRecordedReply: () => assert.fail('the reader reply retains its turn card'),
        noteCompletedReply: (_session, text, _source, turnId, saved) => {
          replies.push({ text, turnId });
          saved?.();
        },
        settleRecordedReplies: () => {},
      },
    });
    const child = h.children[0];
    const rejected = await h.send('Check this input.');
    const first = child
      .sent()
      .filter((line) => line.type === 'user')
      .at(-1)!;
    const reader = await h.send('Finish the work, then compact yourself.');
    child.say(questionRequest());
    child.say(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        num_turns: 0,
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        user_message_uuid: first.uuid,
        user_message_uuids: [first.uuid],
      }) + '\n',
    );
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, rejected);
    if (ordering === 'before idle') h.replay();
    child.say(sessionState('idle'));
    if (ordering === 'after idle') h.replay();
    assert.equal(h.session.state().asks.length, 1);
    assert.equal(
      h.host.answer('one', 'request', {
        decision: 'answer',
        answers: { 'Which option?': { labels: ['One'], written: '' } },
      }),
      true,
    );
    await vi.waitFor(() => assert.equal(h.session.state().asks.length, 0));
    h.tool('following-compact', h.literal(h.ids[0]));
    assert.equal(h.owners.at(-1), reader);
    assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
    child.say(
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        tool_use_result: { interrupted: false },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'following-compact', content: 'queued', is_error: false }],
        },
      }) + '\n',
    );
    child.say(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        uuid: 'following-final',
        message: {
          id: 'following-final',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Work complete.' }],
        },
      }) + '\n',
    );
    assert.deepEqual(replies.at(-1), { text: 'Work complete.', turnId: reader });
    child.say(agentStartedTurns(h.window, h.ids).find((line) => line.includes('"type":"result"'))! + '\n');
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, reader);
    child.say(sessionState('idle'));
    assert.equal(h.session.state().busy, false);
    assert.equal(h.compaction.requests.deliverable('sess-1').length, 1);
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).at(-1), '/compact');
  },
);

test.each([
  ['negative', true, 'retained'],
  ['negative', false, 'retained'],
  ['negative', true, 'later'],
  ['negative', false, 'later'],
  ['received first', true, 'retained'],
  ['local result first', true, 'retained'],
  ['valid unbound', false, 'retained'],
] as const)('native compaction after %s replay, known session %s, launch %s', async (ordering, known, launch) => {
  const h = await joinedCompaction({}, known);
  const child = h.children[0];
  // A launch can be observed before a reader submission or a settled session identity.
  h.compaction.native(
    h.session,
    {
      provider: 'claude',
      sessionId: 'sess-1',
      turnId: null,
      generation: null,
      evidence: {},
      kind: 'launch',
      toolId: 'retained-launch',
      agentId: null,
    },
    undefined,
  );
  const overlapping = h.send('Continue the earlier work.');
  const pending = h.send(ordering === 'local result first' ? '/effort low' : 'Compact after the background work.');
  const frame = child
    .sent()
    .filter((line) => line.type === 'user')
    .at(-1)!;
  if (ordering === 'received first' || ordering === 'valid unbound') h.replay(frame);
  if (ordering !== 'valid unbound')
    child.say(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        num_turns: 0,
        subtype: ordering === 'local result first' ? 'success' : 'error_during_execution',
        is_error: ordering !== 'local result first',
        ...(ordering === 'local result first'
          ? { local_command: 'effort' }
          : {
              terminal_reason: 'aborted_streaming',
              user_message_uuid: frame.uuid,
              user_message_uuids: [frame.uuid],
            }),
      }) + '\n',
    );
  h.replay(frame);
  await Promise.all([overlapping, pending]);
  child.say(COMPLETED_RESULT);
  child.say(sessionState('idle'));
  const wake = (tool: string, run: string) =>
    child.say(
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'sess-1',
        tool_use_id: tool,
        task_id: run,
        status: 'completed',
      }) + '\n',
    );
  if (launch === 'retained') {
    wake('retained-launch', 'retained-run');
    h.tool('retained-request', h.literal(h.ids[0]));
    assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
    child.say(COMPLETED_RESULT);
    child.say(sessionState('idle'));
  }
  // A later launch needs no retained reader submission.
  const preparing = h.session.prompt('Continue without a new reader instruction.');
  child.say(
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-1',
      tool_use_result: { status: 'async_launched', agentId: 'later-agent' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'later-launch', content: '' }] },
    }) + '\n',
  );
  assert.equal(h.events.filter((event) => event.kind === 'launch').at(-1)?.turnId, undefined);
  await preparing;
  child.say(COMPLETED_RESULT);
  child.say(sessionState('idle'));
  wake('later-launch', 'later-run');
  h.tool('later-request', h.literal(h.ids[1]));
  assert.deepEqual(h.admission(h.ids[1]), [undefined, 'queued']);
});

test('a correlated zero-turn result completes its owning ordinary input', async () => {
  const h = await joinedCompaction();
  const owner = await h.send('Check this input.');
  h.replay();
  const frame = h.children[0]
    .sent()
    .filter((line) => line.type === 'user')
    .at(-1)!;
  h.children[0].say(
    JSON.stringify({
      type: 'result',
      session_id: 'sess-1',
      num_turns: 0,
      subtype: 'success',
      user_message_uuid: frame.uuid,
      user_message_uuids: [frame.uuid],
    }) + '\n',
  );
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, owner);
  h.children[0].say(sessionState('idle'));
  assert.equal(h.session.state().busy, false);
  h.tool('next-background-work', 'echo awake');
  assert.equal(h.session.startedByAgent(h.owners.at(-1)!), true);
});

test.each([
  'two pending local commands',
  'model completion before local settlement',
  'acknowledged pending command',
  'zero-model rejection',
  'zero-model nonquery',
] as const)('background-woken ownership survives %s', async (ordering) => {
  const h = await joinedCompaction({
    holder: {
      noteRecordedReply: () => {},
      noteCompletedReply: (_session, _text, _sourceId, _turnId, saved) => saved?.(),
      settleRecordedReplies: () => {},
    },
  });
  const child = h.children[0];
  await h.send('Start the background work, then end the turn.');
  h.replay();
  const backgroundInput = child
    .sent()
    .filter((line) => line.type === 'user')
    .at(-1)!.uuid;
  const lines = agentStartedTurns(h.window, h.ids);
  const result = lines.findIndex((line) => line.includes('"type":"result"'));
  const notice = lines.findIndex(
    (line, index) => index > result && line.includes('task_notification') && line.includes('"tool_use_id":"tool-8"'),
  );
  for (const line of lines.slice(0, result + 1)) child.say(line + '\n');
  child.say(sessionState('idle'));
  for (const line of lines.slice(result + 1, notice + 1)) child.say(line + '\n');
  child.say(sessionState('running'));
  h.tool('woken-work', 'echo awake');
  const owner = h.owners.at(-1)!;
  assert.equal(h.session.startedByAgent(owner), true);
  const command = await h.send('/effort low');
  const ending = JSON.parse(lines[result]);
  const commandFrame = child
    .sent()
    .filter((line) => line.type === 'user')
    .at(-1)!;
  if (ordering === 'acknowledged pending command' || ordering.startsWith('zero-model')) {
    child.say(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        local_command_source: '<local-command-stdout>Changed.</local-command-stdout>',
        local_command_run: { command: 'effort', args: 'low' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'Changed.' }] },
      }) + '\n',
    );
    h.replay(commandFrame);
    if (ordering.startsWith('zero-model')) {
      child.say(
        JSON.stringify({
          ...ending,
          uuid: 'negative-input',
          result_index: 1,
          num_turns: 0,
          user_message_uuid: commandFrame.uuid,
          user_message_uuids: [commandFrame.uuid],
          subtype: ordering === 'zero-model rejection' ? 'error_during_execution' : 'success',
          is_error: ordering === 'zero-model rejection',
          terminal_reason: ordering === 'zero-model rejection' ? 'aborted_streaming' : undefined,
          errors:
            ordering === 'zero-model rejection'
              ? ['prompt_check: the turn was stopped before its prompt was checked']
              : undefined,
        }) + '\n',
      );
      assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, command);
    }
  }
  const localResult = (uuid: string, index: number) =>
    child.say(JSON.stringify({ ...ending, uuid, result_index: index, local_command: 'effort', num_turns: 0 }) + '\n');
  const second = ordering === 'two pending local commands' ? await h.send('/effort high') : undefined;
  if (second !== undefined) {
    const firstCommand = child
      .sent()
      .filter((line) => line.type === 'user')
      .at(-2)!;
    h.replay(firstCommand);
    localResult('local-effort-one', 1);
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, command);
    child.say(sessionState('idle'));
  }
  assert.equal(h.session.state().busy, true, 'pending local input cannot end the background-woken model work');
  h.tool('continued-woken-work', h.literal(h.ids[0]), backgroundInput);
  assert.equal(h.owners.at(-1), owner, 'pending slash inputs cannot replace the active model owner');
  assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
  child.say(
    JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      uuid: 'woken-final',
      user_message_uuid: backgroundInput,
      user_message_uuids: [backgroundInput],
      message: {
        id: 'woken-final',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Work complete.' }],
      },
    }) + '\n',
  );
  assert.equal(h.events.filter((event) => event.kind === 'text').at(-1)?.turnId, owner);
  if (second !== undefined) {
    localResult('local-effort-two', 2);
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, second);
    h.replay();
  }
  const wokenEnding = JSON.parse(lines.find((line) => line.includes('"runId":"run-11"'))!);
  child.say(JSON.stringify({ ...wokenEnding, result_index: 3 }) + '\n');
  assert.equal(h.events.filter((event) => event.kind === 'rootEnd').at(-1)?.turnId, owner);
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, owner);
  if (second === undefined && !ordering.startsWith('zero-model')) {
    localResult('late-local-effort', 4);
    assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, command);
    h.replay();
  }
  child.say(sessionState('idle'));
  assert.equal(h.session.state().busy, false);

  const reader = await h.send('Compact yourself after confirming the work.');
  h.replay();
  h.tool('authorized-compact', h.literal(h.ids[1]));
  assert.deepEqual(h.admission(h.ids[1]), [undefined, 'queued']);
  assert.equal(h.owners.at(-1), reader);
  child.say(
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-1',
      tool_use_result: { interrupted: false },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'authorized-compact', content: 'queued', is_error: false }],
      },
    }) + '\n',
  );
  child.say(
    JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      uuid: 'authorized-final',
      message: {
        id: 'authorized-final',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Confirmed.' }],
      },
    }) + '\n',
  );
  child.say(JSON.stringify({ ...ending, uuid: 'authorized-ending', result_index: 5 }) + '\n');
  child.say(sessionState('idle'));
  assert.equal(h.compaction.requests.deliverable('sess-1').length, 1);
  await h.compaction.drain('sess-1');
  assert.equal(sentTexts(child).at(-1), '/compact');
});

// Admission protects the reader's authority. Readiness alone does not prove the request was queued.
test.each([true, false])('joined reader compaction in the shared running turn, acknowledged %s', async (read) => {
  const h = await joinedCompaction();
  const first = await h.send('Finish the work.');
  h.replay();
  h.tool('foreground', 'echo working');
  await h.send('then compact yourself');
  if (read) h.replay();
  h.tool('compact', h.literal(h.ids[0]));
  assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
  assert.equal(h.owners.at(-1), first, 'the running work keeps its shared owner');
  h.children[0].say(
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-1',
      tool_use_result: { interrupted: false },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'compact', content: 'queued', is_error: false }],
      },
    }) + '\n',
  );
  if (read) h.compaction.replyRetained(h.session, first);
  const result = agentStartedTurns(h.window, h.ids).find((line) => line.includes('"type":"result"'))!;
  h.children[0].say(result + '\n');
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, first);
  if (read) {
    assert.equal(
      h.compaction.requests.deliverable('sess-1').length,
      1,
      'the request follows its successful shared ending',
    );
    h.children[0].say(sessionState('idle'));
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(h.children[0]).at(-1), '/compact');
  }
});

test.each([
  ['before notice', true],
  ['after notice', true],
  ['after wake', true],
  ['after notice', false],
] as const)('joined reader compaction after background work, idle %s, acknowledged %s', async (idle, read) => {
  const h = await joinedCompaction();
  const first = await h.send('Start the background work, then end the turn.');
  h.replay();
  const lines = agentStartedTurns(h.window, h.ids);
  const result = lines.findIndex((line) => line.includes('"type":"result"'));
  const notice = lines.findIndex(
    (line, index) => index > result && line.includes('task_notification') && line.includes('"tool_use_id":"tool-8"'),
  );
  for (const line of lines.slice(0, result)) h.children[0].say(line + '\n');
  await h.send('then compact yourself');
  if (read) h.replay();
  h.children[0].say(lines[result] + '\n');
  if (idle === 'before notice') h.children[0].say(sessionState('idle'));
  for (const line of lines.slice(result + 1, notice + 1)) h.children[0].say(line + '\n');
  if (idle === 'after notice') h.children[0].say(sessionState('idle'));
  h.children[0].say(sessionState('running'));
  h.tool('compact', h.literal(h.ids[1]));
  const owner = h.owners.at(-1)!;
  if (idle === 'after wake') h.children[0].say(sessionState('idle'));
  assert.deepEqual(h.admission(h.ids[1]), [undefined, 'queued']);
  if (!read) return;
  assert.equal(h.session.startedByAgent(owner), true);
  assert.equal(
    h.events.filter((event) => event.kind === 'wake').at(-1)?.turnId,
    undefined,
    'the completed joined submission cannot absorb the notice',
  );
  h.children[0].say(
    JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: {
        id: 'msg-20',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'launched' }],
      },
    }) + '\n',
  );
  assert.equal(
    h.events.filter((event) => event.kind === 'text').at(-1)?.turnId,
    first,
    'an established response ID retains its original owner',
  );
  h.children[0].say(
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-1',
      tool_use_result: { interrupted: false },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'compact', content: 'queued', is_error: false }],
      },
    }) + '\n',
  );
  h.children[0].say(
    JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      uuid: 'final',
      message: {
        id: 'joined-final',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Work complete.' }],
      },
    }) + '\n',
  );
  assert.equal(
    h.events.filter((event) => event.kind === 'text').at(-1)?.turnId,
    owner,
    'the final response belongs to the woken turn',
  );
  const ending = JSON.parse(lines.find((line) => line.includes('"runId":"run-11"'))!);
  h.children[0].say(JSON.stringify(ending) + '\n');
  assert.equal(h.events.filter((event) => event.kind === 'turnEnd').at(-1)?.turnId, owner);
  assert.equal(h.compaction.requests.deliverable('sess-1').length, 0, 'the final response must be retained first');
  h.replies.settle('sess-1', [{ finalResponse: { text: 'Work complete.', sourceId: 'joined-final' } }]);
  assert.equal(h.compaction.requests.deliverable('sess-1').length, 1);
  h.children[0].say(sessionState('idle'));
  await h.compaction.drain('sess-1');
  assert.equal(sentTexts(h.children[0]).at(-1), '/compact');
});

test.each(['Stop', 'queue', 'setting', 'unread send', 'answer'] as const)(
  'joined reader compaction accepts a command observed after %s',
  async (action) => {
    const h = await joinedCompaction();
    await h.send('Finish the work.');
    h.replay();
    await h.send('then compact yourself');
    h.replay();
    h.compaction.readerAction('sess-1', action === 'answer');
    if (action === 'unread send') await h.send('New work.');
    h.tool('compact', h.literal(h.ids[0]));
    assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
  },
);

test('joined reader compaction keeps one pending request across a receipt', async () => {
  const h = await joinedCompaction();
  await h.send('Finish the work.');
  h.replay();
  await h.send('then compact yourself');
  h.tool('before-read', h.literal(h.ids[0]));
  h.replay();
  assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
  h.tool('after-read', h.literal(h.ids[1]));
  assert.deepEqual(
    h.admission(h.ids[1]),
    [undefined, 'refused'],
    'one exact turn still permits only one pending operation',
  );
});

test('a stale joined reader receipt cannot rebind a newer reader turn or an agent-started turn', async () => {
  const h = await joinedCompaction();
  const first = await h.send('Finish the work.');
  h.replay();
  const joined = await h.send('then compact yourself');
  const oldPrompt = h.children[0]
    .sent()
    .filter((line) => line.type === 'user')
    .at(-1)!;
  assert.equal(h.session.readerTurnOwner(joined), first);
  h.children[0].say(COMPLETED_RESULT);
  assert.equal(h.session.readerTurnOwner(joined), undefined);
  h.tool('agent-started', 'echo awake');
  const agentOwner = h.owners.at(-1)!;
  h.replay(oldPrompt);
  assert.equal(h.session.readerTurnOwner(joined), undefined);
  assert.equal(h.session.startedByAgent(agentOwner), true);
  h.children[0].say(COMPLETED_RESULT);
  h.children[0].say(sessionState('idle'));
  const newer = await h.send('New work.');
  h.replay(oldPrompt);
  assert.equal(h.session.readerTurnOwner(joined), undefined);
  assert.equal(h.session.readerTurnOwner(newer), newer);
  h.tool('compact', h.literal(h.ids[0]));
  assert.deepEqual(h.admission(h.ids[0]), [undefined, 'queued']);
  const stopping = h.session.interrupt();
  h.children[0].answerControl('interrupt', {});
  await stopping;
  assert.equal(h.session.readerTurnOwner(newer), undefined);
});

async function readerCompactionAfterScopeRecovery(queuedReaderInput: boolean) {
  vi.stubGlobal('PANEL_CSS', '');
  vi.stubGlobal('PANEL_JS', '');
  vi.stubGlobal('PANEL_DEV_SERVER_URL', null);
  const { PanelProvider } = await import('./panelhost.ts');
  let now = 1_000;
  const root = tempDir('compact-reader-scope-');
  const cwd = path.join(root, 'project');
  const extra = path.join(root, 'extra');
  fs.mkdirSync(cwd);
  fs.mkdirSync(extra);
  const source = path.join(root, 'sess-1.jsonl');
  fs.writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      uuid: 'reader',
      sessionId: 'sess-1',
      cwd,
      message: { role: 'user', content: 'Save the handoff, then compact this session.' },
    }) + '\n',
  );
  const row = {
    file: source,
    cwd,
    sessionId: 'sess-1',
    agent: 'claude' as const,
    ...fileRevisionOf(fs.statSync(source, { bigint: true })),
  };
  let folders = [cwd];
  const pendingGit: (() => void)[] = [];
  let holdGit = false;
  const listeners = vi.spyOn(PanelProvider.prototype as any, 'wireEditorListeners').mockImplementation(() => {});
  const holder: any = new PanelProvider(root, { fsPath: root } as any);
  onTestFinished(() => {
    for (const resolve of pendingGit.splice(0)) resolve();
    holder.dispose();
  });
  listeners.mockRestore();
  Object.assign(holder, {
    folders: () => folders,
    anyVisible: () => false,
    live: {},
    queues: { 'sess-1': [] },
    showing: 'sess-1',
    windowStateHandler() {},
    onSendPrompt() {},
    stateFor() {
      return {
        sessionId: 'sess-1',
        agent: 'claude',
        settings: {},
        queued: this.queues['sess-1'],
        clearing: false,
        running: session.state().busy,
        askMode: 'bypass',
        effectiveMode: 'bypass',
        effectivePermissionMode: 'bypassPermissions',
      };
    },
    postReply() {},
  });
  holder.repositoryScope.dispose();
  holder.repositoryScope = new RepositoryScope(
    {
      run: async () => {
        if (holdGit) await new Promise<void>((resolve) => pendingGit.push(resolve));
        return null;
      },
    },
    () => holder.repositoryScopeChanged(),
    () => now,
  );
  holder.repositoryScope.snapshot(folders);
  await vi.waitFor(() => assert.equal(holder.repositoryScope.snapshot(folders).ready, true));
  function acceptCatalog() {
    const scope = holder.repositoryScope.snapshot(folders);
    holder.catalog = { folders: folders.join('\n') + '\0' + scope.revision, sessions: [row] };
    holder.authoritativeCatalog = [row];
    holder.sourceEnumerations = {
      claude: { status: 'complete', root, files: [source], directories: [root], uncertain: [] },
      codex: { status: 'complete', files: [], uncertain: [] },
    };
    holder.enumeratedAdmissionComplete = true;
    holder.enumeratedMembers = new Set([sessionCoverageMember(row)]);
    holder.claudeChildrenDiscovered = true;
    holder.authoritativeCatalogScope = JSON.stringify(scope.roots);
    holder.membershipCoverage = {
      domain: 'admitted',
      scope: JSON.stringify(scope.roots),
      revision: String(holder.coverageRevision),
      status: 'complete',
      files: [source],
      uncertain: [],
      members: new Set([sessionCoverageMember(row)]),
    };
  }
  acceptCatalog();
  const through = compactionThroughHost({
    holder,
    now: () => now,
    automatic: true,
    readerWork: (id) => holder.readerWork(id),
    authority: (agent, id) => holder.continuationAuthority(agent, id),
    source: (agent, id) => holder.continuationSource(agent, id),
  });
  onTestFinished(() => {
    through.compaction.dispose();
    for (const child of through.children) child.exit(0);
  });
  holder.onScopeChange = (removed?: ReadonlySet<string>) => through.compaction.scopeChanged(removed);
  holder.onSessionRowsRefreshed = () => through.compaction.sessionsRefreshed();
  const opening = through.host.session('one', claudePlan(CLAUDE, { cwd, sessionId: 'sess-1' }));
  through.children[0].answerHandshake();
  const session = await opening;
  through.setCurrent(session);
  const request = through.payload(through.ids[0]);
  const completion = fs.readFileSync(
    path.join(__dirname, '../test/fixtures/claude-reader-completion-2.1.303.jsonl'),
    'utf8',
  );
  const authority = holder.continuationAuthority('claude', 'sess-1');
  assert.ok(authority, 'the accepted request has physical source authority');
  let prompts = 0;
  for (const line of completion.trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'session_state_changed' && event.state === 'running') {
      now++;
      await session.prompt('Save the handoff, then compact this session.', (turnId) => {
        through.compaction.submitted(session, turnId);
        holder.live['sess-1'] = [
          { ...livePress({ sessionId: 'sess-1', agent: 'claude' }), at: now, ran: true, turnId },
        ];
      });
      prompts++;
    }
    const requesting =
      event.type === 'assistant' && event.message.content.some((block: { type: string }) => block.type === 'tool_use');
    if (requesting) {
      const tool = event.message.content.find((block: { type: string }) => block.type === 'tool_use');
      tool.input.command = `arc compact request --self --after-turn --request-id ${request.requestId} --window ${through.window} --json`;
    }
    through.children[0].say(JSON.stringify(event) + '\n');
    if (requesting) {
      const admitted = through.compaction.handle({ method: 'compact-request', params: request }) as {
        state: string;
        turn: string;
      };
      assert.equal(admitted.state, 'queued');
      assert.equal(admitted.turn, '3');
      if (queuedReaderInput) {
        holder.queues['sess-1'] = queueSubmissionAfter(
          [],
          'reader-next',
          'Continue after the handoff.',
          [],
          [],
          now,
          false,
          { agent: 'claude', owner: 'sess-1' },
        );
        holder.queuedEditReservations.add('reader-next');
      }
      holdGit = true;
      folders = [cwd, extra];
      holder.workspaceFoldersChanged();
      folders = [cwd];
      holder.workspaceFoldersChanged();
      assert.equal(holder.repositoryScopeReady, false);
    }
  }
  assert.equal(prompts, 3);
  assert.equal(holder.live['sess-1'][0].reply, 'OK', 'the actual response holder retains the final reply');
  assert.equal(holder.live['sess-1'][0].completed, true);
  for (const resolve of pendingGit.splice(0)) resolve();
  await vi.waitFor(() => assert.equal(holder.repositoryScope.snapshot(folders).ready, true));
  acceptCatalog();
  assert.equal(
    holder.continuationAuthority('claude', 'sess-1'),
    authority,
    'the physical target and full authority recover unchanged',
  );
  Object.assign(holder, {
    anyVisible: () => true,
    prepareHumanPrompts: async (rows: unknown[]) => rows,
    prepareMetadata: async () => true,
    prepareClaudeChildren: async () => true,
    collect: () => [],
    completeSelectedWindow: async () => {},
    prepareRailEnrichment: async () => ({ changed: false, progress: false }),
  });
  const pendingBeforeRows = holder.pendingQueueDrains.has('sess-1');
  const queuedBeforeRows = structuredClone(holder.queues['sess-1']);
  if (queuedReaderInput) {
    assert.equal(pendingBeforeRows, true, 'unsettled scope retains the nonempty reader queue marker');
    assert.equal(holder.readerWork('sess-1'), 'pending');
  }
  await holder.refresh(true, true);
  assert.equal(
    holder.continuationAuthority('claude', 'sess-1'),
    authority,
    'the full rows refresh keeps the admitted authority',
  );
  if (queuedReaderInput) {
    assert.deepEqual(
      holder.queues['sess-1'],
      queuedBeforeRows,
      'scope recovery retains the reader prompt being edited',
    );
    assert.equal(holder.readerWork('sess-1'), 'pending');
    await through.compaction.drain('sess-1');
    const status = through.compaction.handle({
      method: 'compact-status',
      params: { requestId: request.requestId },
    }) as { state: string };
    return {
      state: status.state,
      reason: '',
      compactWrites: sentTexts(through.children[0]).filter((text) => text === '/compact').length,
    };
  }
  assert.equal(holder.readerWork('sess-1'), 'none');
  await vi.waitFor(() => assert.equal(sentTexts(through.children[0]).filter((text) => text === '/compact').length, 1));
  now += 91 * 60_000;
  const status = through.compaction.handle({
    method: 'compact-status',
    params: { requestId: request.requestId },
  }) as { state: string; reason: string };
  console.log(
    JSON.stringify({
      status,
      pendingBeforeRows,
      authorityMatches: authority === holder.continuationAuthority('claude', 'sess-1'),
      physicalSource: holder.continuationSource('claude', 'sess-1'),
      compactWrites: sentTexts(through.children[0]).filter((text) => text === '/compact').length,
    }),
  );
  return {
    state: status.state,
    reason: status.reason,
    compactWrites: sentTexts(through.children[0]).filter((text) => text === '/compact').length,
  };
}

test('a queued reader self-compaction starts after restored workspace scope and captured completion', async () => {
  const result = await readerCompactionAfterScopeRecovery(false);
  assert.notEqual(result.state, 'cancelled', result.reason);
  assert.equal(result.compactWrites, 1);
});

test('a queued reader prompt remains pending through workspace scope recovery and blocks self-compaction', async () => {
  const result = await readerCompactionAfterScopeRecovery(true);
  assert.equal(result.state, 'queued');
  assert.equal(result.compactWrites, 0);
});

// Opens a Claude session, sends the reader prompt, and replays the fixture through the first
// request line, which runs inside the first turn Claude starts by itself.
async function insideAgentStartedTurn() {
  const through = compactionThroughHost();
  const opening = through.host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  through.children[0].answerHandshake();
  const session = await opening;
  through.setCurrent(session);
  await session.prompt('Start the background work, then end the turn.', (turnId) =>
    through.compaction.submitted(session, turnId),
  );
  const lines = agentStartedTurns(through.window, through.ids);
  const request = lines.findIndex((line) => line.includes(through.ids[0]));
  for (const line of lines.slice(0, request + 1)) through.children[0].say(line + '\n');
  const ending = lines.findIndex((line, index) => index > request && line.includes('"type":"result"'));
  return { ...through, session, rest: lines.slice(request + 1, ending + 1) };
}

// Catches a reader prompt that joins a turn Claude started by itself losing its live reply and ending.
test('a reader prompt that joins a turn Claude started by itself owns the later events of that turn', async () => {
  const { session, events, children, rest, compaction } = await insideAgentStartedTurn();
  let joined: number | undefined;
  await session.prompt('A joined reader prompt.', (turnId) => {
    joined = turnId;
    compaction.submitted(session, turnId);
  });
  const before = events.length;
  for (const line of rest) children[0].say(line + '\n');
  const later = events.slice(before).filter((one) => ['toolEnd', 'text', 'rootEnd', 'turnEnd'].includes(one.kind));
  assert.deepEqual([...new Set(later.map((one) => one.kind))].sort(), ['rootEnd', 'text', 'toolEnd', 'turnEnd']);
  assert.ok(joined !== undefined && later.every((one) => one.turnId === joined), JSON.stringify(later));
});

// Catches Stop leaving the owner of a turn Claude started by itself attached to the next reader turn.
test('Stop during a turn Claude started by itself leaves the next reader prompt its own events', async () => {
  const { session, events, children, rest, compaction } = await insideAgentStartedTurn();
  const stopping = session.interrupt();
  children[0].answerControl('interrupt', {});
  await stopping;
  // A late event of the stopped turn belongs to no turn.
  const stray = events.length;
  children[0].say(rest[0] + '\n');
  assert.deepEqual(
    events.slice(stray).map((one) => one.turnId),
    [undefined],
  );
  let next: number | undefined;
  await session.prompt('The next reader prompt.', (turnId) => {
    next = turnId;
    compaction.submitted(session, turnId);
  });
  const before = events.length;
  for (const line of rest.slice(1)) children[0].say(line + '\n');
  const later = events.slice(before).filter((one) => ['text', 'rootEnd'].includes(one.kind));
  assert.ok(later.length >= 2);
  assert.ok(next !== undefined && later.every((one) => one.turnId === next), JSON.stringify(later));
});

test('provider notification turns admit later compaction requests under the same reader task', async () => {
  const { window, ids, payload, owners, replies, compaction, host, children, setCurrent } = compactionThroughHost();
  const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await opening;
  setCurrent(session);
  await session.prompt('Start the background work, then end the turn.', (turnId) =>
    compaction.submitted(session, turnId),
  );
  const lines = agentStartedTurns(window, ids);
  const firstRequest = lines.findIndex((line) => line.includes(ids[0]));
  for (const line of lines.slice(0, firstRequest + 1)) children[0].say(line + '\n');
  assert.deepEqual(compaction.handle({ method: 'compact-ready', params: payload(ids[0]) }), { ready: true });
  assert.equal(
    (compaction.handle({ method: 'compact-request', params: payload(ids[0]) }) as { state: string }).state,
    'queued',
  );
  const secondRequest = lines.findIndex((line) => line.includes(ids[1]));
  const firstEnd = lines.findIndex((line, index) => index > firstRequest && line.includes('"type":"result"'));
  for (const line of lines.slice(firstRequest + 1, firstEnd + 1)) children[0].say(line + '\n');
  // An earlier recorded turn with the same text does not hold this turn's response.
  replies.settle('sess-1', [{ finalResponse: { text: 'noted', sourceId: 'msg-earlier' } }]);
  assert.equal(compaction.requests.deliverable('sess-1').length, 0, 'the response is not recorded yet');
  replies.settle('sess-1', [{ finalResponse: { text: 'noted', sourceId: 'msg-35' } }]);
  assert.equal(compaction.requests.deliverable('sess-1').length, 1, 'the turn ended with a recorded final response');
  for (const line of lines.slice(firstEnd + 1, secondRequest)) children[0].say(line + '\n');
  children[0].say(lines[secondRequest] + '\n');
  assert.deepEqual(compaction.handle({ method: 'compact-ready', params: payload(ids[1]) }), {
    ready: true,
  });
  for (const line of lines.slice(secondRequest + 1)) children[0].say(line + '\n');
  assert.equal(new Set(owners).size, 3, 'each turn Claude started by itself has its own owner');
  assert.ok(!owners.includes(undefined));
  // The provider receives the compaction once the session is idle.
  await compaction.drain('sess-1');
  assert.equal(sentTexts(children[0]).at(-1), '/compact');
  assert.equal(compaction.requests.deliverable('sess-1').length, 0);
});

// Opens a Claude session, sends the reader prompt that starts background work, and replays its
// turn up to its `result`. Arc has not read that `result` yet.
async function beforeBackgroundResult() {
  const through = compactionThroughHost();
  const opening = through.host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  through.children[0].answerHandshake();
  const session = await opening;
  through.setCurrent(session);
  await promptAsReader(through.compaction, session, (submitted, received) =>
    session.prompt('Start the background work, then end the turn.', submitted, undefined, received),
  );
  const lines = agentStartedTurns(through.window, through.ids);
  const launched = lines.findIndex((line) => line.includes('"type":"result"'));
  for (const line of lines.slice(0, launched)) through.children[0].say(line + '\n');
  const request = lines.findIndex((line) => line.includes(through.ids[0]));
  // Claude's replay of the last prompt Arc wrote, which it writes when it reads that prompt.
  const replay = () => {
    const prompt = through.children[0]
      .sent()
      .filter((line) => line.type === 'user')
      .at(-1)!;
    assert.equal(typeof prompt.uuid, 'string', 'a reader prompt carries a client UUID');
    through.children[0].say(
      JSON.stringify({
        type: 'user',
        isReplay: true,
        uuid: prompt.uuid,
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: prompt.message,
      }) + '\n',
    );
  };
  const idle = () => through.children[0].say(sessionState('idle'));
  return { ...through, session, lines, launched, request, replay, idle };
}

// Catches a reader instruction sent while background work runs never admitting the compaction that
// the turn this work wakes requests, and a reader send that never reached Claude admitting it.
test.each(['read', 'refused'] as const)('a turn that background work wakes after a %s reader prompt', async (send) => {
  const { session, lines, launched, request, compaction, children, payload, ids, replay } =
    await beforeBackgroundResult();
  children[0].say(lines[launched] + '\n');
  compaction.readerAction('sess-1');
  const text = 'After this is done, self compact.';
  const missing = {
    id: 'a',
    name: 'missing.png',
    mime: 'image/png',
    size: 1,
    digest: 'd',
    path: path.join(WS, 'missing.png'),
  };
  const instruction = promptAsReader(compaction, session, (submitted, received) =>
    session.prompt(send === 'read' ? text : { text, assets: [missing] }, submitted, undefined, received),
  );
  if (send === 'refused') await assert.rejects(instruction);
  else {
    await instruction;
    replay();
    children[0].say(COMPLETED_RESULT);
  }
  for (const line of lines.slice(launched + 1, request + 1)) children[0].say(line + '\n');
  assert.equal(
    (compaction.handle({ method: 'compact-ready', params: payload(ids[0]) }) as { code?: string }).code,
    undefined,
  );
});

// Native command admission does not depend on acknowledgment of a pending prompt.
test.each([
  ['before', 'an ordinary'],
  ['after', 'an ordinary'],
  ['after', 'a guarded'],
] as const)('a woken turn admits compaction %s the replay of %s send', async (when, send) => {
  const { session, lines, launched, request, compaction, children, payload, ids, replay, idle } =
    await beforeBackgroundResult();
  compaction.readerAction('sess-1');
  const guard = send === 'a guarded' ? new GuardedAttempt('6f1c2a1e-0000-4000-8000-000000000003') : undefined;
  await promptAsReader(compaction, session, (submitted, received) =>
    session.prompt('After this is done, self compact.', submitted, guard, received),
  );
  children[0].say(lines[launched] + '\n');
  idle();
  if (when === 'after') {
    replay();
    children[0].say(COMPLETED_RESULT);
    idle();
  }
  for (const line of lines.slice(launched + 1, request + 1)) children[0].say(line + '\n');
  const ready = compaction.handle({ method: 'compact-ready', params: payload(ids[0]) }) as { code?: string };
  const ack = compaction.handle({ method: 'compact-request', params: payload(ids[0]) }) as { state: string };
  assert.deepEqual([ready.code, ack.state], [undefined, 'queued']);
});

// Later native turns retain their own command intent after earlier notices settle.
test('a provider turn needs no preceding task notice to request compaction', async () => {
  const { window, ids, payload, compaction, host, children, setCurrent } = compactionThroughHost();
  const opening = host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  children[0].answerHandshake();
  const session = await opening;
  setCurrent(session);
  await session.prompt('Start the background work, then end the turn.', (turnId) =>
    compaction.submitted(session, turnId),
  );
  const lines = fs
    .readFileSync(path.join(__dirname, '../test/fixtures/claude-back-to-back-notices-2.1.303.jsonl'), 'utf8')
    .trim()
    .split('\n');
  for (const line of lines) children[0].say(line + '\n');
  const command = `arc compact request --self --after-turn --request-id ${window}:${ids[0]} --window ${window} --json`;
  for (const line of [
    { type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'uuid-50', session_id: 'sess-1' },
    { type: 'system', subtype: 'init', uuid: 'uuid-51', session_id: 'sess-1', permissionMode: 'default' },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'uuid-52',
      session_id: 'sess-1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', id: 'tool-53', caller: { type: 'direct' }, input: { command } }],
      },
    },
  ])
    children[0].say(JSON.stringify(line) + '\n');
  assert.equal(
    (compaction.handle({ method: 'compact-ready', params: payload(ids[0]) }) as { code?: string }).code,
    undefined,
  );
});

test('Codex provider-originated compaction retains its exact recorded native response without a reader submission', async () => {
  vi.stubGlobal('PANEL_CSS', '');
  vi.stubGlobal('PANEL_JS', '');
  vi.stubGlobal('PANEL_DEV_SERVER_URL', null);
  const { PanelProvider } = await import('./panelhost.ts');
  const root = tempDir('compact-codex-native-');
  const file = path.join(root, 'rollout.jsonl');
  const sessionId = 'native-codex';
  const nativeTurnId = 'notice-turn';
  fs.writeFileSync(file, '');
  const holder: any = Object.assign(Object.create(PanelProvider.prototype), {
    disposed: false,
    showing: 'other',
    hostSessions: new Map(),
    newestBySession: new Map(),
    catalog: { folders: '', sessions: [{ agent: 'codex', sessionId, file }] },
    recordedReplies: new RecordedReplies(),
    noteResponseEnded: () => {},
  });
  const h = compactionThroughHost({ holder });
  const opening = h.host.session('codex-native', codexPlan(CODEX, { cwd: root, clientInfo: CODEX_CLIENT }));
  const child = h.children[0];
  await answerCodexHandshake(child);
  child.reply({ thread: { id: sessionId } });
  const session = await opening;
  h.setCurrent(session);
  onTestFinished(() => {
    holder.disposed = true;
    if (holder.recordedReplyRetry) clearTimeout(holder.recordedReplyRetry);
    h.compaction.dispose();
    child.exit(0);
  });
  const send = (method: string, params: object) => child.say(JSON.stringify({ method, params }) + '\n');
  send('turn/started', { threadId: sessionId, turn: { id: nativeTurnId } });
  const item = {
    type: 'commandExecution',
    id: 'request-call',
    command: `arc compact request --self --after-turn --request-id ${h.window}:${h.ids[0]} --window ${h.window} --json`,
    status: 'inProgress',
    source: 'unifiedExecStartup',
    processId: '425',
  };
  send('item/started', { threadId: sessionId, turnId: nativeTurnId, item });
  assert.equal(typeof h.owners.at(-1), 'number');
  assert.equal(session.startedByAgent(h.owners.at(-1)!), true);
  const request = h.payload(h.ids[0]);
  assert.equal(
    (h.compaction.handle({ method: 'compact-request', params: request }) as { state: string }).state,
    'queued',
  );
  send('item/completed', {
    threadId: sessionId,
    turnId: nativeTurnId,
    item: { ...item, status: 'completed', exitCode: 0 },
  });
  send('item/completed', {
    threadId: sessionId,
    turnId: nativeTurnId,
    item: { type: 'agentMessage', id: 'native-final', phase: 'final_answer', text: 'Saved the handoff.' },
  });
  send('turn/completed', { threadId: sessionId, turn: { id: nativeTurnId, status: 'completed' } });
  assert.equal(h.compaction.requests.deliverable(sessionId).length, 0);
  const records = (turn: string) =>
    [
      { type: 'session_meta', payload: { id: sessionId, cwd: root, originator: 'codex_vscode', source: 'vscode' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'native-final',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Saved the handoff.' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'Saved the handoff.' },
      },
    ].map((record, index) => ({ ...record, timestamp: new Date(Date.UTC(2026, 9, 22, 0, 0, index)).toISOString() }));
  const record = (turn: string) =>
    fs.writeFileSync(
      file,
      records(turn)
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
  record('foreign-turn');
  holder.settleRecordedReplies();
  assert.equal(
    h.compaction.requests.deliverable(sessionId).length,
    0,
    'the same response ID in another native turn cannot retain this response',
  );
  record(nativeTurnId);
  holder.settleRecordedReplies();
  assert.equal(h.compaction.requests.deliverable(sessionId).length, 1);
  const drain = h.compaction.drain(sessionId);
  await vi.waitFor(() => assert.equal(child.sent().at(-1)?.method, 'thread/compact/start'));
  child.reply({});
  send('turn/started', { threadId: sessionId, turn: { id: 'native-compact' } });
  send('item/started', {
    threadId: sessionId,
    turnId: 'native-compact',
    item: { type: 'contextCompaction', id: 'compact-item' },
  });
  send('item/completed', {
    threadId: sessionId,
    turnId: 'native-compact',
    item: { type: 'contextCompaction', id: 'compact-item' },
  });
  send('turn/completed', { threadId: sessionId, turn: { id: 'native-compact', status: 'completed' } });
  await drain;
  assert.equal(
    (h.compaction.handle({ method: 'compact-status', params: { requestId: request.requestId } }) as { state: string })
      .state,
    'completed',
  );
});

test('Claude provider-originated root background commands compact without a reader submission', async () => {
  const h = compactionThroughHost();
  const opening = h.host.session('claude-native', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
  const child = h.children[0];
  child.answerHandshake();
  const session = await opening;
  h.setCurrent(session);
  onTestFinished(() => {
    h.compaction.dispose();
    child.exit(0);
  });
  child.say(sessionState('running'));
  child.say(
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 'sess-1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'native-request',
            name: 'Bash',
            caller: { type: 'direct' },
            input: {
              command: `arc compact request --self --after-turn --request-id ${h.window}:${h.ids[0]} --window ${h.window} --json`,
              run_in_background: true,
            },
          },
        ],
      },
    }) + '\n',
  );
  const request = h.payload(h.ids[0]);
  assert.equal(typeof h.owners.at(-1), 'number');
  assert.equal(
    (h.compaction.handle({ method: 'compact-request', params: request }) as { state: string }).state,
    'queued',
  );
});

test.each([
  ['system', true, 'completed'],
  ['user', true, 'completed'],
  ['system', false, 'completed'],
  ['user', false, 'completed'],
  ['system', false, 'failed'],
  ['user', false, 'failed'],
] as const)(
  'Claude %s background compaction with flag %s and terminal %s retains its original owner',
  async (form, flagged, terminal) => {
    const h = compactionThroughHost();
    const opening = h.host.session('claude-background', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1' }));
    const child = h.children[0];
    child.answerHandshake();
    const session = await opening;
    h.setCurrent(session);
    onTestFinished(() => {
      h.compaction.dispose();
      child.exit(0);
    });
    const send = (record: object) => child.say(JSON.stringify({ session_id: 'sess-1', ...record }) + '\n');
    child.say(sessionState('running'));
    send({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'background-request',
            name: 'Bash',
            caller: { type: 'direct' },
            input: {
              command: `arc compact request --self --after-turn --request-id ${h.window}:${h.ids[0]} --window ${h.window} --json`,
              ...(flagged ? { run_in_background: true } : {}),
            },
          },
        ],
      },
    });
    const originalOwner = h.owners.at(-1)!;
    send({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'background-request', is_error: false }] },
      tool_use_result: { backgroundTaskId: 'exact-job', interrupted: false },
    });
    assert.equal(
      h.events.filter((event) => event.kind === 'toolEnd').length,
      0,
      'launch acknowledgment cannot settle the command',
    );
    send({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'background-final',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Saved the handoff.' }],
      },
    });
    send({
      type: 'result',
      uuid: 'background-root-end',
      result_index: 0,
      num_turns: 1,
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
    });
    child.say(sessionState('idle'));
    h.replies.settle('sess-1', [{ finalResponse: { sourceId: 'background-final', text: 'Saved the handoff.' } }]);
    const request = h.payload(h.ids[0]);
    assert.equal(
      (h.compaction.handle({ method: 'compact-request', params: request }) as { state: string }).state,
      'queued',
    );
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).includes('/compact'), false);
    const notice = (task: string, extra: object = {}, suffix = '') =>
      send(
        form === 'user'
          ? {
              type: 'user',
              parent_tool_use_id: null,
              origin: { kind: 'task-notification' },
              message: {
                content: `<task-notification><tool-use-id>background-request</tool-use-id><task-id>${task}</task-id><status>completed</status>${suffix}</task-notification>`,
              },
              ...extra,
            }
          : {
              type: 'system',
              subtype: 'task_notification',
              tool_use_id: 'background-request',
              task_id: task,
              status: 'completed',
              ...extra,
            },
      );
    notice('unrelated-job');
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).includes('/compact'), false, 'an unrelated completion supplies no tool success');
    notice('exact-job', { parent_tool_use_id: 'subagent' });
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).includes('/compact'), false, 'subagent envelopes cannot settle the root command');
    notice('exact-job', { session_id: 'foreign-session' });
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).includes('/compact'), false, 'foreign sessions cannot settle the root command');
    if (form === 'user') {
      for (const field of ['status', 'tool-use-id', 'task-id']) {
        for (const suffix of [`<${field}/>`, `<${field}>duplicate</${field}>`, `<${field} invalid="yes"></${field}>`]) {
          notice('exact-job', {}, suffix);
          await h.compaction.drain('sess-1');
          assert.equal(sentTexts(child).includes('/compact'), false, 'malformed tags cannot settle the root command');
        }
      }
      notice('exact-job', { parent_tool_use_id: undefined });
      notice('exact-job', { origin: { kind: 'peer' } });
      await h.compaction.drain('sess-1');
      assert.equal(
        sentTexts(child).includes('/compact'),
        false,
        'user notices require an exact root notification envelope',
      );
    }
    await session.prompt('A later owner turn.');
    send({
      type: 'result',
      uuid: 'later-end',
      result_index: 1,
      num_turns: 1,
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
    });
    child.say(sessionState('idle'));
    notice(
      'exact-job',
      form === 'system'
        ? { status: terminal }
        : {
            message: {
              content: `<task-notification><tool-use-id>background-request</tool-use-id><task-id>exact-job</task-id><status>${terminal}</status></task-notification>`,
            },
          },
    );
    assert.equal(h.events.filter((event) => event.kind === 'toolEnd').at(-1)?.turnId, originalOwner);
    await h.compaction.drain('sess-1');
    assert.equal(sentTexts(child).at(-1) === '/compact', terminal === 'completed');
    if (terminal === 'failed')
      assert.equal(
        (
          h.compaction.handle({ method: 'compact-status', params: { requestId: request.requestId } }) as {
            state: string;
          }
        ).state,
        'failed',
      );
  },
);

// Crosses active retention limits through the host route and bounded recorded-response reads.
test('recorded compaction responses survive 33 sessions and five native turns with fair bounded recovery', async () => {
  const h = compactionThroughHost();
  const root = tempDir('compact-recorded-capacity-');
  const sessions: Array<{ session: AgentSession; emit: (event: WireEvent) => void; file: string; sessionId: string }> =
    [];
  let deliveries = 0;
  onTestFinished(() => {
    h.compaction.dispose();
    for (const child of h.children) child.exit(0);
  });
  for (let index = 0; index < 33; index++) {
    const sessionId = `capacity-${index}`;
    let emit!: (event: WireEvent) => void;
    const plan: AgentPlan = {
      agent: 'codex',
      sessionId,
      command: 'c',
      args: [],
      cwd: root,
      env: {},
      driver: (_send, report) => {
        emit = report;
        return {
          receive() {},
          open: async () => [],
          prompt: async () => 'reader',
          compact: async (beforeWrite) => {
            beforeWrite?.();
            deliveries++;
          },
          clear: async () => {},
          answer: () => false,
          interrupt: async () => {},
          sessionId: () => sessionId,
          close() {},
          hasOpenTurns: () => false,
        };
      },
    };
    const session = await h.host.session(sessionId, plan);
    const file = path.join(root, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd: root, source: 'vscode', originator: 'codex_vscode' },
      }) + '\n',
    );
    sessions.push({ session, emit, file, sessionId });
  }
  let operation = 0;
  for (const [index, row] of sessions.entries()) {
    h.setCurrent(row.session);
    for (let turn = 0; turn < (index === 0 ? 5 : 1); turn++) {
      const id = `00000000-0000-4000-8000-${String(++operation).padStart(12, '0')}`;
      const nativeTurnId = `turn-${turn}`;
      const sourceId = `response-${operation}`;
      const base = {
        provider: 'codex' as const,
        sessionId: row.sessionId,
        turnId: nativeTurnId,
        generation: null,
        evidence: {},
      };
      row.emit({
        kind: 'native',
        event: {
          ...base,
          kind: 'toolStart',
          toolId: id,
          initiating: true,
          command: `arc compact request --self --after-turn --request-id ${h.window}:${id} --window ${h.window} --json`,
        },
      });
      assert.equal(
        (h.compaction.handle({ method: 'compact-request', params: h.payload(id) }) as { state: string }).state,
        'queued',
      );
      row.emit({ kind: 'native', event: { ...base, kind: 'toolEnd', toolId: id, success: true } });
      row.emit({ kind: 'text', text: 'Saved.', sourceId, nativeTurnId });
      row.emit({ kind: 'native', event: { ...base, kind: 'rootEnd', success: true } });
      row.emit({
        kind: 'turnEnd',
        nativeTurnId,
        outcome: { status: 'ok', text: '', costUsd: null, turns: null, deniedTools: [] },
      });
      const records = [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: nativeTurnId } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            id: sourceId,
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Saved.' }],
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: nativeTurnId, last_agent_message: 'Saved.' } },
      ];
      fs.appendFileSync(
        row.file,
        records
          .map((record, offset) =>
            JSON.stringify({ ...record, timestamp: new Date(Date.UTC(2026, 9, 22, 0, turn, offset)).toISOString() }),
          )
          .join('\n') + '\n',
      );
      if (index === 0 && turn === 0)
        fs.appendFileSync(row.file, (JSON.stringify({ type: 'unrelated', text: 'x'.repeat(4096) }) + '\n').repeat(270));
    }
  }
  assert.equal(h.replies.sessions().length, 33);
  const first = h.replies.pollingSessions();
  const second = h.replies.pollingSessions();
  assert.equal(first.length, 32);
  assert.ok(new Set([...first, ...second]).size === 33, 'polling reaches every retained session');
  for (let pass = 0; pass < 12 && h.replies.sessions().length; pass++) {
    for (const sessionId of h.replies.pollingSessions()) {
      const row = sessions.find((one) => one.sessionId === sessionId)!;
      h.replies.read({ agent: 'codex', sessionId, file: row.file } as any);
    }
  }
  assert.deepEqual(h.replies.sessions(), [], 'the first response remains recoverable beyond the bounded tail');
  for (const row of sessions) {
    h.setCurrent(row.session);
    await h.compaction.drain(row.sessionId);
  }
  assert.equal(deliveries, 37, 'every admitted operation reaches its original child');
});

const remoteControlRequests = (child: FakeChild) =>
  child.sent().filter((m) => (m.request as { subtype?: string } | undefined)?.subtype === 'remote_control');

// Answers the child's newest Remote Control request once it has `count` of them. `after` rides in the same output chunk.
async function answerRemoteControl(
  child: FakeChild,
  count: number,
  response: Record<string, unknown> = {},
  after = '',
): Promise<void> {
  await vi.waitFor(() => assert.equal(remoteControlRequests(child).length, count));
  child.say(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: remoteControlRequests(child).at(-1)!.request_id, response },
    }) +
      '\n' +
      after,
  );
}

async function openRemoteControlChild(fixture: ReturnType<typeof fakeHost>, key: string, sessionId: string) {
  const starting = fixture.host.session(key, claudePlan(CLAUDE, { cwd: WS, sessionId }));
  fixture.children.at(-1)!.answerControl('initialize', { commands: [], remote_control_available: true });
  await starting;
  return fixture.children.at(-1)!;
}

async function remoteControlChild(timer: FakeAgentHostTimer, policy?: LaunchPolicy) {
  const fixture = fakeHost(undefined, undefined, { idleDurationMs: 120, timer });
  const starting = fixture.host.session('one', claudePlan(CLAUDE, { cwd: WS, sessionId: 'sess-1', policy }));
  fixture.children[0].answerControl('initialize', { commands: [], remote_control_available: true });
  await starting;
  const child = fixture.children[0];
  const requests = () => remoteControlRequests(child);
  const toggle = async (response: Record<string, unknown> = {}) => {
    const count = requests().length + 1;
    const result = fixture.host.remoteControl('one', () => {});
    await answerRemoteControl(child, count, response);
    return await result;
  };
  return { ...fixture, child, requests, toggle };
}

// The extension's Remote Control callback, run against this host.
function extensionRemoteControl(host: AgentHost) {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
  const at = source.indexOf('  panel.onRemoteControl = async (session, observer) => {');
  assert.notEqual(at, -1, 'extension.ts no longer wires Remote Control where this test reads it');
  const end = source.indexOf('\n  };\n', at) + '\n  };\n'.length;
  const panel: { onRemoteControl?: (session: string, observer: () => void) => Promise<unknown> } = {};
  runInNewContext(source.slice(at, end), { host, panel });
  return panel.onRemoteControl!;
}

function fireActiveTimers(timer: FakeAgentHostTimer): void {
  for (const [index, task] of timer.tasks.entries()) if (!task.cleared) timer.fire(index);
}

test('connected Remote Control holds a child past its idle window until it disconnects', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, child, toggle } = await remoteControlChild(timer);
  assert.equal((await toggle({ session_url: 'https://example.test/s', bridge_epoch: 1 }))?.outcome, 'connected');
  settle(host, 'one');
  assert.equal(timer.activeCount(), 0, 'a connected child received an ordinary idle deadline');
  assert.equal((await toggle())?.outcome, 'disconnected');
  await tick();
  assert.equal(timer.activeCount(), 1);
  timer.fire(timer.tasks.length - 1);
  assert.equal(host.get('one'), null);
  assert.equal(child.ended, true);
});

test('a Remote Control failure releases the idle hold', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, child, toggle } = await remoteControlChild(timer);
  await toggle({ session_url: 'https://example.test/s', bridge_epoch: 1 });
  settle(host, 'one');
  assert.equal(timer.activeCount(), 0);
  child.say(JSON.stringify({ type: 'system', subtype: 'bridge_state', state: 'failed', bridge_epoch: 1 }) + '\n');
  await tick();
  assert.equal(timer.activeCount(), 1, 'a failed connection kept the child from idle retirement');
});

test('archive retires a connected Remote Control child', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, child, toggle } = await remoteControlChild(timer);
  await toggle({ session_url: 'https://example.test/s', bridge_epoch: 1 });
  settle(host, 'one');
  host.setArchived(['sess-1']);
  assert.equal(host.get('one'), null);
  assert.equal(child.ended, true);
});

test('a read-only launch policy refuses Remote Control without a request', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, requests } = await remoteControlChild(timer, launchPolicy('claude', true));
  assert.deepEqual(await host.remoteControl('one', () => {}), { outcome: 'policy' });
  assert.equal(requests().length, 0);
  assert.equal(await host.remoteControl('missing', () => {}), null, 'a missing child must not start a process');
});

test('a Remote Control failure in the same output chunk as the enable reply ends the connection', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, child } = await remoteControlChild(timer);
  const later: unknown[] = [];
  const pending = host.remoteControl('one', (result) => later.push(result));
  const failure = {
    type: 'system',
    subtype: 'bridge_state',
    state: 'failed',
    bridge_epoch: 1,
    detail: 'Network lost.',
  };
  await answerRemoteControl(
    child,
    1,
    { session_url: 'https://example.test/s', bridge_epoch: 1 },
    JSON.stringify(failure) + '\n',
  );
  assert.deepEqual(await pending, { outcome: 'ended', reason: 'Network lost.' }, 'the failure was dropped');
  assert.deepEqual(later, []);
  settle(host, 'one');
  await tick();
  assert.equal(timer.activeCount(), 1, 'a failed connection kept the child from idle retirement');
});

test('Remote Control holds a child past its idle deadline while connecting and while uncertain', async () => {
  const timer = new FakeAgentHostTimer();
  const { host, child, requests } = await remoteControlChild(timer);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = host.remoteControl('one', () => {});
    await vi.waitFor(() => assert.equal(requests().length, 1));
    settle(host, 'one');
    fireActiveTimers(timer);
    assert.notEqual(host.get('one'), null, 'a connecting child was retired');
    await vi.advanceTimersByTimeAsync(CONTROL_DEADLINE_MS);
    assert.deepEqual(await pending, { outcome: 'uncertain' });
    settle(host, 'one');
    await vi.advanceTimersByTimeAsync(0);
    fireActiveTimers(timer);
    assert.notEqual(host.get('one'), null, 'an uncertain child was retired');
    assert.equal(child.ended, false);
  } finally {
    vi.useRealTimers();
  }
});

test('Remote Control reaches only the live child of its own session, before and after a Claude clear', async () => {
  const timer = new FakeAgentHostTimer();
  const fixture = fakeHost(undefined, undefined, { idleDurationMs: 120, timer });
  const { host, children } = fixture;
  const first = await openRemoteControlChild(fixture, 'one', 'sess-1');
  const second = await openRemoteControlChild(fixture, 'two', 'sess-2');
  const toggle = extensionRemoteControl(host);
  const on = toggle('sess-2', () => {});
  await answerRemoteControl(second, 1, { session_url: 'https://example.test/two', bridge_epoch: 2 });
  assert.deepEqual(await on, { outcome: 'connected', url: 'https://example.test/two', late: false });
  assert.equal(remoteControlRequests(first).length, 0, "another session's child received the toggle");
  const firstOn = toggle('sess-1', () => {});
  await answerRemoteControl(first, 1, { bridge_epoch: 1 });
  assert.deepEqual(await firstOn, { outcome: 'connected', url: null, late: false });
  const firstOff = toggle('sess-1', () => {});
  await answerRemoteControl(first, 2);
  assert.deepEqual(await firstOff, { outcome: 'disconnected', late: false });
  assert.equal(remoteControlRequests(second).length, 1, "another session's child received the toggle");
  // Claude /clear gives the connected child a new local session id.
  second.say(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2b' }) + '\n');
  assert.deepEqual(await toggle('sess-2', () => {}), { outcome: 'stopped' });
  settle(host, 'one');
  settle(host, 'two');
  await tick();
  fireActiveTimers(timer);
  assert.equal(host.get('one'), null);
  assert.notEqual(host.get('two'), null, 'the session id change lost the connection hold');
  const off = toggle('sess-2b', () => {});
  await answerRemoteControl(second, 2);
  assert.deepEqual(await off, { outcome: 'disconnected', late: false });
  assert.deepEqual(await toggle('sess-1', () => {}), { outcome: 'stopped' });
  assert.deepEqual(await toggle('missing', () => {}), { outcome: 'stopped' });
  assert.equal(children.length, 2, 'a Remote Control toggle started a process');
});
