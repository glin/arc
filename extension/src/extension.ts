import { type LaunchPolicy, refusePolicyChange } from './launchpolicy';
import { LaunchPolicyStore } from './launchpolicystore';
import { DispatchReceipts } from './dispatchreceipts';
import { HostedDispatch } from './dispatchhost';
import { savedDispatchResponse } from './sessionreads';
import { payloadSha256, requesterOf } from './sessionwrites';
import { MEASUREMENT_ENVIRONMENT } from './identity';
import { askIdleDefaults } from './agenthost';
import type { HostedSessionObservation } from './sessionreads';
import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { QuestionRecovery, questionContinuation, questionIdentity } from './questionrecovery';
import { GuardedAttempt, type AgentPrompt } from './agentwire';
import { QuestionEvidenceReader } from './questionrecords';
import {
  arcHome,
  cacheRoot,
  WorkspaceCachePartition,
  normalizedWorkspaceIdentity,
  storeRoot,
  sweepOldSessions,
} from './store';
import { SCHEME } from './uris';
import { relativePath, nativePath, linkTarget, resolveLink, projectsRoot, sessionFileFor } from './transcript';
import { nativeCitationPath } from './domain/file-citation';
import { sessionRenameTitle } from './sessionrename';
import { watchInitialCodexName } from './codex';
import { registerPanel, PanelProvider } from './panelhost';
import { readSetting } from './config';
import { STORED_STATE_KEYS } from './identity';
import { nodeGitRunner } from './gitcommits';
import { ProjectSetupStore, SetupProjects } from './projectsetups';
import { settingName } from './settings';
import { uriStringsFromCommand } from './droppeduris';
import {
  AgentHost,
  AgentSession,
  AgentName,
  AgentPlan,
  AgentPlanSource,
  McpBook,
  McpChange,
  McpPendingRefreshes,
  ModelBook,
  SavedDefaults,
  saveCatalog,
  savedCatalogs,
  UsageReadQueue,
  askIdle,
  askIdleMcp,
  askIdleMcpChange,
  claudeAskMode,
  claudeIdlePlan,
  claudePlan,
  claudeRenamePlan,
  codexAskMode,
  codexIdlePlan,
  codexPlan,
  codexRenamePlan,
  ModelChange,
  modelChange,
  renameAgentSession,
  pickedEffort,
  pickedModel,
  arcCliSpawner,
  existingHostKey,
  freshHostKey,
  retireDraftProfile,
  liveMcpTarget,
  openDraftMcp,
} from './agenthost';
import { McpServer } from './agentwire';
import { CommandCatalogs, CommandCatalogUpdate } from './commandcatalog';
import { validateResolvedPromptAssets } from './promptassets';
import {
  claudeLaunch,
  codexLaunch,
  Machine,
  acceptedAskAnswer,
  acceptedAskModePick,
  activeWriterFailure,
  agentChoices,
  AskMode,
  askMode,
  savedAskMode,
  storedAskValue,
  runningKey,
  busyInSession,
  failedPromptDelivery,
  type PromptDelivery,
  failedCompactionDelivery,
  failedClearDelivery,
  acceptedSessionSettings,
  acceptedPermissionMode,
  SessionSettingBook,
  sessionSettings,
  sessionSettingsForProfile,
  withSessionSettings,
  NewSessionDraft,
  turnEndCompletesEveryPrompt,
} from './composerview';
import { MCP_RECONNECT, failedServers, mcpToggleWanted } from './mcpview';
import { AgentUsage, UsageBook, UsageResetTimer, UsageWriteQueue, USAGE_AGENT_ORDER } from './usageview';
import { UsageRecorder, USAGE_STORE_DIRECTORY } from './usagerecord';
import { sameSkillList, withDirectorySkills } from './domain/claude-skills';
import { normalizeWorkspace } from './projectspend';
import { comparableFolder, ConfigWatches, defaultsKey, defaultsKeyParts } from './configwatch';
import { WindowChannel } from './sessionrequests';
import { terminalOwnership, localTerminalPlacement } from './terminalownership';
import { reportWindowTransport, windowTransportErrorCode, type WindowTransportSink } from './windowpipe';
import { CompactHost, promptAsReader, readerPrompt, routeCompactionEvent } from './compactrequest';
import { CompactStore } from './compactstore';
import {
  GuardedSends,
  guardedChannelSend,
  agentMessageBinding,
  guardedDeliveryPort,
  guardedFactsWithCompaction,
  guardedPanelPorts,
  interveneOnReaderInput,
  recordGuardedStart,
  runGuardedSend,
  type GuardedDelivery,
  type GuardedSendResult,
  type GuardedStartContext,
} from './sessionwrites';
import { claudeConfigHome } from './agentpaths';
import { ClaudePluginOffer, ClaudePluginSetup, pluginTarget } from './claudeplugin';
import {
  BundledTools,
  readToolPackage,
  scheduleReleaseCollection,
  toolRoot,
  prepareEditorCommands,
} from './bundledtools';
import { TerminalTools } from './toolpath';

// Codex children share this client identity. The build supplies `EXTENSION_VERSION` from the extension manifest.
declare const EXTENSION_VERSION: string;
const CLIENT_INFO = { name: 'arc', title: 'Arc', version: EXTENSION_VERSION };
const usageWrites = new UsageWriteQueue();
const sessionSettingsWrites = new UsageWriteQueue();
let usageRecorder: UsageRecorder | null = null;
let windowChannel: WindowChannel | null = null;
let snapshotSetup: ClaudePluginOffer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationAt = performance.now();
  let channel: WindowChannel | null = null;
  let channelConstructionError: string | undefined;
  try {
    channel = new WindowChannel();
    channel.setTerminalOwnership(
      terminalOwnership({
        terminals: () => vscode.window.terminals,
        allowed: () => vscode.workspace.isTrusted && !vscode.env.remoteName && localTerminalPlacement(),
      }),
    );
  } catch (error) {
    channelConstructionError = windowTransportErrorCode(error);
    /* Window discovery failure leaves panel activation available. */
  }
  windowChannel = channel;
  const privateTools = new TerminalTools(
    context.environmentVariableCollection,
    () => {
      if (!vscode.workspace.isTrusted) return null;
      return {
        root: toolRoot(),
        identity: JSON.stringify([
          context.extensionPath,
          vscode.workspace.workspaceFile?.toString() ?? null,
          (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()),
          os.hostname(),
        ]),
      };
    },
    (admission, signal) =>
      prepareEditorCommands(
        path.join(context.extensionPath, 'dist'),
        admission.root,
        signal,
        context.extensionMode === vscode.ExtensionMode.Development,
      ),
    process.execPath,
  );
  context.subscriptions.push(privateTools);
  const releaseCollection = scheduleReleaseCollection(() => privateTools.selectedDirectory());
  context.subscriptions.push(releaseCollection);
  let privatePreparation = privateTools.refresh();
  void privatePreparation.then(releaseCollection.collect);
  const sessionSkillSelection = {
    admitted: () => vscode.workspace.isTrusted && !vscode.env.remoteName,
    current: () => (vscode.workspace.isTrusted && !vscode.env.remoteName ? privateTools.sessionSkills() : undefined),
  };
  let invalidatePreparedDefaults: (() => void) | undefined;
  const spawner = arcCliSpawner(() => privateTools.current(channel?.windowId ?? null));
  if (channel)
    context.subscriptions.push({
      dispose: () => {
        void channel?.dispose();
      },
    });
  const root = storeRoot();
  const policies = new LaunchPolicyStore(path.join(arcHome(), 'launch-policies'));
  const policyMoves = new Map<string, { source: string; successor: string }>();
  const savePolicy = async (id: string, policy?: LaunchPolicy) => {
    if (policy) policies.write(id, policy);
  };
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const workspaceIdentity = normalizedWorkspaceIdentity(
    workspaceFolders,
    vscode.workspace.workspaceFile?.fsPath ?? null,
  );
  const workspaceCache = new WorkspaceCachePartition(cacheRoot(), workspaceIdentity);
  fs.mkdirSync(root, { recursive: true });

  // The baseline provider reads the snapshot filename from the `s` query parameter. The URI path names the real file for diff headers.
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri) {
      const snapshot = new URLSearchParams(uri.query).get('s');
      if (!snapshot) {
        return '';
      }
      try {
        return fs.readFileSync(snapshot, 'utf8');
      } catch {
        return '';
      }
    },
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));

  // Watch every session's trigger file (which lives outside the workspace).
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(root), '*/trigger'),
  );
  context.subscriptions.push(watcher);

  // Register the panel that displays recorded turns.
  let snapshotOffer: ClaudePluginOffer | undefined;
  const panel = registerPanel(context, root, workspaceCache, activationAt, (diagnostics) => {
    const sink: WindowTransportSink = (event, record) => diagnostics.warn(event, record);
    channel?.setDiagnostics(sink);
    if (channelConstructionError)
      reportWindowTransport(sink, 'channelConstructionRejected', { errorCode: channelConstructionError });
  });
  const questionEvidence = new QuestionEvidenceReader();
  channel?.setRequestHandler((request) => panel.handleSessionRequest(request));
  panel.setWindowStateHandler((state) => {
    void channel?.update(state).catch(() => {
      void channel?.dispose();
    });
  });
  if (process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1' && process.env[MEASUREMENT_ENVIRONMENT.state])
    panel.openInEditor();

  // Defer snapshot cleanup until activation returns. It stats every session folder on the event loop shared by the host's extensions.
  const firstSweep = setTimeout(() => {
    try {
      sweepOldSessions(root);
    } catch {
      /* best-effort */
    }
  }, 0);
  context.subscriptions.push({ dispose: () => clearTimeout(firstSweep) });

  // Trigger changes request a refresh. Polling also discovers completed turns when a trigger event is missed.
  const onTrigger = () => {
    panel.refreshFrom('trigger');
  };
  context.subscriptions.push(watcher.onDidChange(onTrigger), watcher.onDidCreate(onTrigger));

  const reg = (id: string, fn: (...a: unknown[]) => void) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Path commands accept the context object attached to a file row or summary link.
  reg('arc.copyPath', (arg) => void copyPath(arg, false));
  reg('arc.copyLink', (arg) => void copyLink(arg));
  // Explorer and editor tab menus pass the clicked resource, then the Explorer's multi-selection.
  reg('arc.addToArc', (resource, selection) => panel.addToComposer(uriStringsFromCommand(resource, selection)));
  reg('arc.sendResponseLinkWithLabels', (arg) => sendResponseLink(panel, arg, true));
  reg('arc.sendResponseLink', (arg) => sendResponseLink(panel, arg, false));
  reg('arc.sendSelectedTextWithLabels', (arg) => sendSelectedText(panel, arg, true));
  reg('arc.sendSelectedText', (arg) => sendSelectedText(panel, arg, false));
  reg('arc.newSessionWithLabels', (arg) => newSessionWithLabels(panel, arg));
  reg('arc.copyRelativePath', (arg) => void copyPath(arg, true));
  // Forward turn read-state changes to the webview, which owns that state.
  reg('arc.markTurnRead', (arg) => setTurnRead(panel, arg, true));
  reg('arc.markTurnUnread', (arg) => setTurnRead(panel, arg, false));
  // Forward session read-state changes to the webview, which owns each session's read position.
  reg('arc.markSessionRead', (arg) => setSessionRead(panel, arg, true));
  reg('arc.markSessionUnread', (arg) => setSessionRead(panel, arg, false));
  // The host saves archive changes from the session heading menu. The session list also provides an archive control.
  reg('arc.archiveSession', (arg) => setSessionArchived(panel, arg, true));
  reg('arc.unarchiveSession', (arg) => setSessionArchived(panel, arg, false));
  // Forward pin changes from the session heading menu. This menu remains available when the session list is hidden.
  reg('arc.pinSession', (arg) => setSessionPinned(panel, arg, true));
  reg('arc.unpinSession', (arg) => setSessionPinned(panel, arg, false));
  // Forward the session heading menu's bulk turn entries to the webview, which owns open turns.
  reg('arc.expandShownTurns', (arg) => setSessionTurnsOpen(panel, arg, true));
  reg('arc.collapseShownTurns', (arg) => setSessionTurnsOpen(panel, arg, false));
  reg('arc.copySessionId', (arg) => copySessionId(panel, arg));
  reg('arc.showSessionDetails', (arg) => showSessionDetails(panel, arg));
  reg('arc.exportSession', (arg) => {
    const session = sessionIdFrom(arg);
    if (session) void panel.exportSession(session);
  });
  reg('arc.hideComposer', () => panel.setComposerHidden(true));
  reg('arc.showComposer', () => panel.setComposerHidden(false));
  // Copy the turn's rendered Markdown through the panel, without reading screen text.
  reg('arc.copyTurnSummary', (arg) => copyTurnSummary(panel, arg));
  reg('arc.commentOnTurn', (arg) => commentOnTurn(panel, arg));
  // Open the panel's label editor for the session named by the context menu.
  reg('arc.labelSession', (arg) => labelSession(panel, arg));
  // Open the panel's rename editor for the session named by the context menu.
  reg('arc.renameSession', (arg) => renameSession(panel, arg));
  // Open the panel's saved-view editor with the view ID and requested action.
  reg('arc.renameView', (arg) => editView(panel, arg, 'rename'));
  reg('arc.deleteView', (arg) => editView(panel, arg, 'delete'));
  // Copy the reader's turn comments as Markdown from the turn card menu.
  reg('arc.copyTurnComments', (arg) => copyTurnComments(panel, arg));
  // Use the panel's session history before the editor's Go Back history.
  reg('arc.goBack', () => panel.goBack());
  reg('arc.goForward', () => panel.goForward());
  // `composerview.ts` decides prompt routing, reader choices, and delivery results. This host starts children and displays errors.
  // Usage arrives through live events, end-of-turn requests, and idle children. These control reads consume no model tokens.
  const USAGE_KEY = STORED_STATE_KEYS.usage;
  const recorder = new UsageRecorder(path.join(arcHome(), 'usage', USAGE_STORE_DIRECTORY));
  usageRecorder = recorder;
  context.subscriptions.push({
    dispose: () => {
      void recorder.dispose();
    },
  });
  const usage = new UsageBook(context.workspaceState.get<AgentUsage[]>(USAGE_KEY) ?? [], (agent, reading) =>
    recorder.record(agent, reading),
  );
  const usageReads = new UsageReadQueue(
    (state) => panel.setUsageRefresh(state),
    (agent) => usage.excluded(agent),
  );
  context.subscriptions.push(usageReads);
  // Retain each agent's reported model catalog. Its freshness window controls when another catalog is requested.
  // The catalog saved by an earlier run for the same CLI path draws the fields until this run's first read answers.
  const cliPath = (agent: string): string => readSetting(agent === 'claude' ? 'claudePath' : 'codexPath');
  // Each answer is saved under the CLI path that started its read, and only while that path is still configured.
  const models = new ModelBook(
    savedCatalogs(context.globalState, cliPath, USAGE_AGENT_ORDER),
    (agent, list, readPath) => {
      void saveCatalog(context.globalState, agent, readPath, cliPath(agent), list);
    },
  );
  // Retain the latest MCP server list for each draft or recorded session, without a freshness clock.
  const mcp = new McpBook();
  const mcpRefreshes = new McpPendingRefreshes();
  const draftMcpKeys = new Map<string, string>();
  let mcpSurfaceGeneration = 0;
  const usageResetTimer = new UsageResetTimer();
  const scheduleUsageReset = () => {
    const next = usage.nextReset(Date.now());
    usageResetTimer.schedule(next, Date.now(), () => {
      panel.setUsage(usage.usages());
      scheduleUsageReset();
    });
  };
  const publishUsage = () => {
    const snapshot = usage.usages();
    panel.setUsage(snapshot);
    scheduleUsageReset();
    void usageWrites.write(() => context.workspaceState.update(USAGE_KEY, snapshot));
  };
  panel.setUsage(usage.usages());
  scheduleUsageReset();
  context.subscriptions.push(usageResetTimer);
  // Clear retained usage after the panel clears its own saved state.
  reg(
    'arc.resetPanelState',
    () =>
      void (async () => {
        await panel.forgetState();
        usage.clear();
        usageResetTimer.dispose();
        panel.setUsage([]);
        void usageWrites.write(() => context.workspaceState.update(USAGE_KEY, undefined));
        await usageWrites.drain();
      })(),
  );
  const publishMcp = () => panel.setMcpServers(mcp.lists());
  const noteMcp = (owner: string, servers: McpServer[], revision: number, generation: number): boolean =>
    generation === mcpSurfaceGeneration && mcp.note(owner, servers, revision);

  // The commands event publishes the complete catalog. Skip the following state callback's redundant panel update.
  const commandStateChanges = new Set<string>();
  const dispatch = new HostedDispatch(new DispatchReceipts(), (provider, session, turn) =>
    savedDispatchResponse(panel.dispatchSource(provider, session), turn),
  );
  panel.onReserveDispatch = (request, draft) =>
    dispatch.receipts.reserve({
      origin: channel!.hostId,
      requester: requesterOf(request),
      policy: draft.policy ?? null,
      promptSha256: payloadSha256(request.params.prompt!),
      completion: request.params.completion ?? 'manual',
      alias: request.params.reportPath ?? null,
    }).launchId;
  channel?.setDispatchHandler((request) =>
    dispatch.request(channel.hostId, request.params, request.filterContext!.signal),
  );
  const sessionTokens = new WeakMap<AgentSession, number>();
  let nextSessionToken = 1;
  const publishHostedSessions = () => {
    const states = host.states();
    const observations = new Map<string, HostedSessionObservation>();
    for (const state of states) {
      const instance = host.get(state.key);
      const current = instance?.state();
      if (!instance || current?.agent !== state.agent || current.sessionId !== state.sessionId) continue;
      let token = sessionTokens.get(instance);
      if (token === undefined) {
        token = nextSessionToken++;
        sessionTokens.set(instance, token);
      }
      if (!state.sessionId) continue;
      const key = runningKey(state.agent, state.sessionId);
      const held = observations.get(key);
      if (!held || (held.exited && (!state.exited || token > held.token))) {
        observations.set(key, { key, token, busy: state.busy, exited: state.exited });
      }
    }
    const hosted = [...observations.values()];
    panel.setRunning(
      hosted.filter((one) => one.busy && !one.exited).map((one) => one.key),
      hosted,
    );
    panel.setExited(
      hosted.filter((one) => one.exited).map((one) => one.key),
      hosted,
    );
  };
  // One deferred self-compaction owner per window activation. It never opens a missing child.
  let compaction: CompactHost<AgentSession> | null = null;
  const recoveryPrompts = new WeakMap<AgentPrompt, GuardedAttempt>();
  const recoveryFailure = () => {
    void vscode.window.showWarningMessage(
      'Arc: this question or its answer status cannot be saved. You can still answer the current question. Check the session before answering a saved question again.',
    );
  };
  const recoveryFor = (origin: string): QuestionRecovery | undefined => {
    try {
      return new QuestionRecovery({
        root: path.join(workspaceCache.root, 'question-recovery'),
        origin,
        activation: channel?.hostId ?? randomUUID(),
      });
    } catch {
      recoveryFailure();
      return undefined;
    }
  };
  const host = new AgentHost({
    recovery: recoveryFor(panel.recoveryOrigin),
    recoverySource: (agent, session) => panel.questionSource(agent, session),
    onRecoveryFailure: recoveryFailure,
    spawner,
    idleDurationMs: readSetting('agentIdleMinutes') * 60_000,
    onNativeObservation: (key, event) => {
      const child = host.get(key);
      if (child) compaction?.observeNative(child, event);
    },
    onEvent: ({ key, event, turnId, dispatchTurnId, usageSource }) => {
      panel.onDispatchEvent?.(key, event, dispatchTurnId ?? turnId);
      if (event.kind === 'responseRate') {
        const where = host.get(key)?.state().sessionId;
        if (where === event.rate.sessionId) panel.noteResponseRate(where, event.rate, turnId);
        return;
      }
      if (event.kind === 'activity') {
        const where = host.get(key)?.state().sessionId;
        if (where) {
          panel.noteActivity(where, event.activity);
        }
        return;
      }
      // Stream reply fragments to the live card for the child's session. They do not change recorded turns or start a refresh.
      if (event.kind === 'delta') {
        const where = host.get(key)?.state().sessionId;
        if (where) {
          panel.noteReply(where, event.text, turnId);
        }
        return;
      }
      if (event.kind === 'turnEnd') {
        const where = host.get(key)?.state().sessionId;
        if (where) panel.noteResponseEnded(where, event.outcome, turnId);
      }
      if (routeCompactionEvent(compaction, panel, host.get(key) ?? null, event, turnId)) return;
      const agent = host.get(key)?.agent;
      if (event.kind === 'commands') {
        commandStateChanges.add(key);
        if (agent) {
          publishCommands({
            agent,
            key,
            usageSource,
            commands: event.commands,
            complete: true,
            optionalOnly: event.optionalOnly,
          });
        }
        return;
      }
      // Request servers when the child reports readiness, before the reader opens Servers. Exclude provisional draft children from this automatic request.
      if (event.kind === 'ready' && ![...draftMcpKeys.values()].includes(key)) {
        void readMcpFrom(key);
      }
      if (agent && event.kind === 'rateLimit') {
        const source = host.get(key)?.usageSource;
        if (!usage.accepts(agent, source)) return;
        usage.noteLimit(agent, event.limit, Date.now(), event.creditResetsAtSeconds, source);
        if (event.limit && !event.limit.scope) usageReads.admitted(agent);
        publishUsage();
      }
      // Invalidate context readings when a child ends a turn, acquires a session, or reports readiness.
      if (['turnEnd', 'session', 'ready'].includes(event.kind)) {
        const affected = host.get(key)?.state().sessionId;
        if (affected) panel.invalidateContext(affected);
        if (event.kind === 'session' && event.previous && event.previous !== affected)
          panel.invalidateContext(event.previous);
        // A Claude `/clear` keeps a Remote Control connection, so its prompt box item follows the new id.
        if (event.kind === 'session' && event.previous && event.previous !== event.sessionId)
          panel.moveRemoteControl(event.previous, event.sessionId);
      }
      if (event.kind === 'turnEnd') {
        const housekeeping = host.beginHousekeeping(key);
        const usageRead = agent
          ? (usageReads.resumeDeferred(agent, (attempt, operation) => readFrom(key, true, attempt, operation)) ??
            usageReads.run(agent, false, (_force, operation) => readFrom(key, false, undefined, operation)))
          : Promise.resolve();
        void Promise.allSettled([usageRead, readMcpFrom(key)]).then(() => host.settled(housekeeping));
      }
      // Ordinary catalogs retain provider fallback. Supplied commands belong to this child generation.
      if (agent && event.kind === 'ready') {
        publishCommands({
          agent,
          key,
          usageSource,
          commands: event.commands,
          complete: false,
        });
      }
      // Persist Claude's reported skills under its working directory. Sessions in that directory share the list, and identical lists cause no state write.
      if (event.kind === 'skills') {
        const cwd = host.get(key)?.cwd;
        const directory = cwd ? normalizeWorkspace(cwd) : null;
        if (directory && !sameSkillList(skillLists[directory], event.skills)) {
          skillLists = withDirectorySkills(skillLists, directory, event.skills);
          void context.workspaceState.update(SKILLS_KEY, skillLists);
          panel.setSkills(skillLists);
        }
      }
      if (event.kind === 'session') {
        const policy = host.get(key)?.policy ?? (event.previous ? policies.readSaved(event.previous) : undefined);
        const moved = policyMoves.get(key);
        if (moved?.successor === event.previous) policyMoves.set(key, { ...moved, successor: event.sessionId });
        if (policy) {
          try {
            policies.write(event.sessionId, policy);
            const child = host.get(key);
            if (agent === 'codex' && child && !child.state().exited) policies.confirmClear(key, event.sessionId, child);
          } catch (error) {
            if (agent !== 'claude') throw error;
            if (event.previous)
              policyMoves.set(key, {
                source: moved?.successor === event.previous ? moved.source : event.previous,
                successor: event.sessionId,
              });
            void vscode.window.showErrorMessage(
              `Arc: Session ${event.sessionId} did not save its read-only permissions. ${(error as Error).message}`,
            );
            return;
          }
        }
      }
      if (event.kind === 'sessionInitialized') {
        const policy = host.get(key)?.policy;
        if (policy) {
          try {
            if (!event.changed) policies.write(event.sessionId, policy);
            const child = host.get(key);
            if (child && !child.state().exited && policies.confirmClear(key, event.sessionId, child)) {
              const moved = policyMoves.get(key);
              policyMoves.delete(key);
              if (moved?.successor === event.sessionId) {
                compaction?.sessionMoved(moved.source);
                panel.noteSessionMoved(
                  moved.source,
                  event.sessionId,
                  agent ?? 'claude',
                  host.get(key)?.state().cwd ?? null,
                );
              }
            }
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Arc: Session ${event.sessionId} did not save its read-only permissions. ${(error as Error).message}`,
            );
            return;
          }
        }
      }
      // Publish busy children by session ID. Exclude unnamed children so Stop never targets an unidentified session.
      publishHostedSessions();
      // Move panel ownership when the child reports a successor session. `/clear` leaves the previous transcript on disk.
      // Use the session event's ID. The earlier reset message names a different ID from the successor transcript.
      if (event.kind === 'session' && event.previous && event.previous !== event.sessionId && !policyMoves.has(key)) {
        compaction?.sessionMoved(event.previous);
        panel.noteSessionMoved(event.previous, event.sessionId, agent ?? 'claude', host.get(key)?.state().cwd ?? null);
      }
      if (event.kind === 'session' && event.effectiveMode) {
        panel.setCodexEffectiveMode(event.sessionId, event.effectiveMode);
      }
      if (event.kind === 'permissionMode') {
        panel.setClaudeEffectiveMode(event.sessionId, event.mode);
      }
      if (event.kind === 'turnEnd') {
        const ended = host.get(key)?.state().sessionId;
        if (ended) {
          // A zero-turn outcome is a locally answered command. Remove its pending card.
          if (event.outcome.turns === 0) {
            const clearFailure =
              event.outcome.status === 'ok'
                ? null
                : failedClearDelivery(agent ?? '', new Error(event.outcome.text)).reason;
            panel.noteLocalAnswer(ended, clearFailure, turnId);
          }
          panel.releaseDeliveredPromptAssets(ended, turnEndCompletesEveryPrompt(agent ?? ''), turnId);
          panel.flushQueue(ended);
          void compaction?.drain(ended);
        }
      }
      // Claude's idle report ends the prompts that joined a running turn. The running set above
      // already reflects the report, and the queue drains only once that set shows the session idle.
      // That set refreshes the panel when it changes, and a repeated report changes nothing.
      if (event.kind === 'sessionState') {
        const idle = host.get(key)?.state().sessionId;
        if (idle && event.state === 'idle') {
          panel.releaseDeliveredPromptAssets(idle, false, event.settledTurnIds);
          panel.flushQueue(idle);
          void compaction?.drain(idle);
        }
        return;
      }
      panel.refreshFromChild(event.kind, host.get(key)?.state().sessionId ?? null);
    },
    onStateChange: (state) => {
      panel.initialNamesChanged();
      if (state.exited) panel.onDispatchExit?.(state.key);
      if (state.exited) {
        policyMoves.delete(state.key);
        policies.forgetClear(state.key);
      }
      // Exit, retirement, archive retirement, and shutdown all end the child and its Remote Control.
      if (state.exited && state.sessionId) panel.noteRemoteControlOff(state.sessionId);
      if (state.exited) compaction?.childGone(state.key);
      else if (!state.busy && state.sessionId) void compaction?.drain(state.sessionId);
      if (commandStateChanges.delete(state.key)) {
        return;
      }
      updateAgentAffordance();
      if (!state.busy && !state.exited) {
        void usageReads
          .resumeDeferred(state.agent, (attempt, operation) => readFrom(state.key, true, attempt, operation))
          ?.catch(() => {});
      }
      publishHostedSessions();
      if (state.exited || state.sessionId) publishCommands();
      if (state.exited) {
        if (state.sessionId) panel.invalidateContext(state.sessionId);
        if (state.sessionId) {
          panel.releaseDeliveredPromptAssets(state.sessionId, true);
        }
        usageReads.failDeferred(
          state.agent,
          new Error(`${state.agent} usage refresh failed: the agent stopped before it could read usage`),
        );
      }
      if ((!state.busy || state.exited) && state.sessionId) panel.flushAgentQueue(state.sessionId);
    },
  });
  panel.onDispatchEvent = (key, event, submission) => {
    const child = host.get(key);
    if (child) dispatch.observe(child, event, submission);
  };
  panel.onDispatchExit = (key) => {
    const child = host.get(key);
    if (child) dispatch.exited(child);
  };
  panel.onDispatchEvidence = () => dispatch.reconcileAll();
  const activation = channel?.windowId;
  if (channel && activation) {
    const owner = new CompactHost<AgentSession>(
      activation,
      {
        find: (provider, sessionId) => host.find(provider, sessionId),
        findToken: (token) => host.findByToken(token),
        withActivity: (child, work) => host.withActivity(child.key, work),
        readerWork: (sessionId) => panel.readerWork(sessionId),
        continuationWork: (sessionId) => panel.continuationWork(sessionId),
        authority: (provider, sessionId) => panel.continuationAuthority(provider, sessionId),
        source: (provider, sessionId) => panel.continuationSource(provider, sessionId),
        compacting: (provider, sessionId) => panel.noteAgentCompaction(provider, sessionId),
      },
      Date.now,
      context.storageUri
        ? new CompactStore(path.join(context.storageUri.fsPath, 'continuations'), activation)
        : undefined,
    );
    compaction = owner;
    panel.onReaderAction = (session, answer, carry) => owner.readerAction(session, answer, carry);
    panel.onReaderUnsent = (session) => owner.unsent(session);
    panel.onSessionRowsRefreshed = () => owner.sessionsRefreshed();
    channel.setCompactRequestHandler((request) => owner.handle(request));
    context.subscriptions.push({ dispose: () => owner.dispose() });
  }
  panel.onBackgroundWorkDetected = (session, commands, children) =>
    host.retainBackgroundWork(session.agent, session.sessionId, commands, children);
  panel.onArchivedSessionsChange = (sessions) => {
    compaction?.archived(sessions);
    host.setArchived(sessions);
  };

  host.setArchived(panel.archivedSessions());
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((change) => {
      if (!change.affectsConfiguration('arc.agentIdleMinutes')) {
        return;
      }
      host.setIdleDuration(readSetting('agentIdleMinutes') * 60_000);
    }),
  );
  context.subscriptions.push({ dispose: () => host.dispose() });
  context.subscriptions.push({
    dispose: () => {
      mcpSurfaceGeneration++;
      mcpRefreshes.dispose();
    },
  });

  const updateAgentAffordance = () => {
    const sources = new Map<string, string | null>();
    const sourceFor = (agent: string, session: string): string | null => {
      const key = JSON.stringify([agent, session]);
      if (!sources.has(key)) sources.set(key, panel.questionSource(agent, session));
      return sources.get(key)!;
    };
    const recovery = host.questionRecovery();
    for (const entry of recovery?.entries() ?? []) {
      const source = sourceFor(entry.agent, entry.session);
      if (source && !entry.source) {
        try {
          recovery?.bindSource(entry.identity, source);
        } catch {
          /* Unknown ownership leaves the question readable. */
        }
      }
    }
    if (recovery) questionEvidence.reconcile(recovery, sourceFor);
    const waiting = host.waiting(sourceFor);
    panel.setAsks(
      waiting.flatMap((entry) => {
        const session = entry.session;
        return session ? [{ session, ask: entry.ask }] : [];
      }),
    );
  };
  panel.onRecoveryOrigin = (origin) => {
    const recovery = recoveryFor(origin);
    if (recovery) host.setRecovery(recovery);
    updateAgentAffordance();
  };
  const rowsRefreshed = panel.onSessionRowsRefreshed;
  panel.onSessionRowsRefreshed = () => {
    rowsRefreshed?.();
    updateAgentAffordance();
  };

  const workspaceCwd = (): string | null => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  // Describe the machine used by launch rules. `spawnCli` sets `ELECTRON_RUN_AS_NODE` so the editor binary runs the child as Node.
  const thisMachine = (): Machine => ({
    homeDir: os.homedir(),
    appData: process.env.APPDATA ?? '',
    pathEnv: process.env.PATH ?? process.env.Path ?? '',
    claudeExtensionDir: vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath ?? '',
    codexExtensionDir: vscode.extensions.getExtension('openai.chatgpt')?.extensionPath ?? '',
    platform: process.platform,
    arch: process.arch,
    node: process.execPath,
    exists: (p: string) => fs.existsSync(p),
    canExecute: (p: string) => {
      try {
        if (!fs.statSync(p).isFile()) {
          return false;
        }
        if (process.platform !== 'win32') {
          fs.accessSync(p, fs.constants.X_OK);
        }
        return true;
      } catch {
        return false;
      }
    },
  });

  let bundledTools: BundledTools | undefined;
  let toolProblem = '';
  try {
    if (vscode.env.remoteName)
      throw new Error(
        'Arc tool setup is unavailable in remote windows. Run setup in a local window on the execution host.',
      );
    bundledTools = new BundledTools(readToolPackage(path.join(context.extensionPath, 'dist')), toolRoot());
  } catch (error) {
    toolProblem = error instanceof Error ? error.message : String(error);
  }
  snapshotOffer = new ClaudePluginOffer(
    {
      target: () => {
        if (
          !bundledTools ||
          vscode.env.remoteName ||
          !vscode.workspace.isTrusted ||
          process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1'
        )
          return null;
        const cwd = workspaceCwd();
        if (!cwd) return null;
        const launch = claudeLaunch(readSetting('claudePath'), thisMachine());
        if (launch.problem) return null;
        try {
          return pluginTarget(cwd, claudeConfigHome(), launch, `${vscode.env.remoteName ?? 'local'}:${os.hostname()}`);
        } catch {
          return null;
        }
      },
      dismissed: (key) => context.globalState.get<boolean>(key) === true,
      dismiss: async (key) => {
        await context.globalState.update(key, true);
      },
      offer: async () =>
        vscode.window.showInformationMessage(
          'Install Claude hooks globally to capture file diffs for sessions started outside Arc?',
          'Install',
          'Not now',
        ),
      report: (message, error) => {
        if (error) void vscode.window.showErrorMessage(`Arc: ${message}`);
        else void vscode.window.showInformationMessage(`Arc: ${message}`);
      },
    },
    new ClaudePluginSetup(undefined, undefined, undefined, bundledTools),
  );
  snapshotSetup = snapshotOffer;
  const refreshSnapshots = () => {
    const preparation = (privatePreparation = privateTools.refresh());
    void preparation.then(() => {
      if (preparation === privatePreparation) invalidatePreparedDefaults?.();
      releaseCollection.collect();
    });
    snapshotOffer?.invalidate();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('arc.setupClaudeSnapshots', () => {
      if (toolProblem) return vscode.window.showErrorMessage(`Arc: ${toolProblem}`);
      return snapshotOffer?.check(true);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(refreshSnapshots),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshSnapshots),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(settingName('claudePath'))) refreshSnapshots();
    }),
    {
      dispose: () => {
        void snapshotOffer?.dispose();
      },
    },
  );

  // Permission mode keeps an agent-wide launch default and an accepted value per session.
  // Model and effort choices name one session and must not alter a sibling.
  const ASK_MODE_KEY = STORED_STATE_KEYS.askModes;
  // The palette command uses these agent-wide defaults. Session controls store their choices in the session settings book.
  const MODEL_KEY = STORED_STATE_KEYS.models;
  const EFFORT_KEY = STORED_STATE_KEYS.efforts;
  const SESSION_SETTINGS_KEY = STORED_STATE_KEYS.sessionSettings;
  const SKILLS_KEY = STORED_STATE_KEYS.claudeSkills;
  const stored = (key: string): Record<string, string> => context.workspaceState.get<Record<string, string>>(key) ?? {};
  let currentSettingBook: SessionSettingBook = {
    ...(context.workspaceState.get<SessionSettingBook>(SESSION_SETTINGS_KEY) ?? {}),
  };
  const settingBook = (): SessionSettingBook => currentSettingBook;
  const persistSettingBook = (book: SessionSettingBook): Promise<void> => {
    currentSettingBook = book;
    return sessionSettingsWrites.write(() => context.workspaceState.update(SESSION_SETTINGS_KEY, book));
  };
  const persistSessionSettings = (session: string, settings: ReturnType<typeof sessionSettings>): Promise<void> =>
    persistSettingBook(withSessionSettings(settingBook(), session, settings));
  function askModeFor(agent: string, session?: string): AskMode | undefined {
    const selected = session ? sessionSettings(settingBook(), session).permissionMode : undefined;
    return savedAskMode(agent, selected, stored(ASK_MODE_KEY)[agent]);
  }
  // An empty stored permission selects the agent default. Undefined means no stored permission names this session.
  function askValueFor(agent: string, session: string): string | undefined {
    const selected = sessionSettings(settingBook(), session).permissionMode;
    return storedAskValue(agent, selected, stored(ASK_MODE_KEY)[agent]);
  }
  const modelFor = (agent: string, session?: string): string => {
    const selected = session ? sessionSettings(settingBook(), session).selectedModel : (stored(MODEL_KEY)[agent] ?? '');
    return pickedModel(selected, models.get(agent));
  };
  const effortFor = (agent: string, session?: string): string => {
    if (!session) {
      return pickedEffort(stored(EFFORT_KEY)[agent] ?? '', models.get(agent), modelFor(agent));
    }
    const selected = sessionSettings(settingBook(), session);
    return pickedEffort(selected.selectedEffort, models.get(agent), selected.effortModel || selected.selectedModel);
  };

  // Publish next-turn session settings separately from the per-agent model catalogs.
  const publishPicks = () => {
    panel.setAskLevels(stored(ASK_MODE_KEY));
    panel.setModels(
      models.lists(),
      USAGE_AGENT_ORDER.filter((agent) => models.pending(agent)),
    );
    panel.setPicks(settingBook());
  };
  panel.onSessionSettingsAdopted = async (session, settings) => {
    await persistSessionSettings(session, settings);
    publishPicks();
  };
  // A carried catalog belongs to the CLI path that answered it.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      const changed = USAGE_AGENT_ORDER.filter((agent) =>
        event.affectsConfiguration(settingName(agent === 'claude' ? 'claudePath' : 'codexPath')),
      );
      for (const agent of changed) models.dropCarried(agent);
      if (changed.length) publishPicks();
    }),
  );
  const setupProjects = new SetupProjects(nodeGitRunner());
  const setupStore = new ProjectSetupStore(context.globalState);
  let setupGeneration = 0;
  let setupRefresh: { folder: string | null; pending: Promise<void> } | null = null;
  const refreshSetups = (): Promise<void> => {
    const folder = workspaceCwd();
    if (setupRefresh?.folder === folder) return setupRefresh.pending;
    const generation = ++setupGeneration;
    panel.setSetupProject(null, `loading:${generation}`);
    const pending = (async () => {
      const project = await setupProjects.resolve(folder);
      try {
        const entry = await setupStore.read(project);
        if (generation !== setupGeneration) return;
        panel.setSetupProject(project, `project:${generation}`, entry);
      } catch (error) {
        if (generation !== setupGeneration) return;
        void vscode.window.showErrorMessage(
          `Arc: saved setups are unavailable. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    setupRefresh = { folder, pending };
    void pending.then(() => {
      if (setupRefresh?.pending === pending) setupRefresh = null;
    });
    return pending;
  };
  panel.readPinnedSetups = async (project) => (await setupStore.read(project ?? null)).pins;
  panel.onSetupRefresh = () => void refreshSetups();
  panel.persistPinnedSetups = (setups, project) => setupStore.pins(project ?? null, setups);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshSetups()));
  void refreshSetups();

  // What each agent published for its slash menu, once one of its children has answered.
  //
  // Merged rather than rebuilt, and never emptied. A child that has stopped is dropped from
  // `host.states()`, and a menu that emptied with it would go quiet exactly when the reader
  // wants it: the command they are about to type is what starts the next child.
  const commandLists = new CommandCatalogs();
  // Restore each directory's persisted Claude skills at activation. A session's `init` message replaces the list for its directory.
  let skillLists: Record<string, readonly string[]> =
    context.workspaceState.get<Record<string, readonly string[]>>(SKILLS_KEY) ?? {};
  panel.setSkills(skillLists);
  // Track agents already asked for commands, including unavailable agents and empty answers. Avoid starting another catalog child on every panel view.
  const commandsAsked = new Set<string>();
  const publishCommands = (said?: CommandCatalogUpdate, expectedRevision?: number) => {
    const next = commandLists.publish(host.states(), said, expectedRevision);
    if (next) {
      panel.setCommands(next, commandLists.childCommands(host.states(), draftMcpKeys));
    }
  };

  // An explicit permission pick reaches every live child because it changes the agent configuration.
  // Removing Arc's override retires those children before the stored default becomes visible.
  // Store each accepted value so a retired session resumes with the same configuration.
  const setAskModeFor = async (agent: AgentName, mode: AskMode, session?: string): Promise<void> => {
    const liveTargets = host.states().filter((state) => state.agent === agent && !state.exited);
    const checkPolicies = () => {
      if (session && policies.readSaved(session)) refusePolicyChange(session);
      for (const state of host.states().filter((state) => state.agent === agent && !state.exited))
        if (host.get(state.key)?.policy || (state.sessionId && policies.readSaved(state.sessionId)))
          refusePolicyChange(state.sessionId ?? state.key);
    };
    checkPolicies();
    const invalidateTargets = () => {
      for (const state of liveTargets)
        if (state.sessionId) {
          compaction?.readerAction(state.sessionId);
          guardedSends.invalidate(state.sessionId);
        }
    };
    const applyMode = async (sessions: ReadonlyMap<string, AgentSession>): Promise<boolean> => {
      const targets = liveTargets.map((state) => ({
        session: state.sessionId,
        accept: async () => {
          const session = sessions.get(state.key);
          if (!session) {
            throw new Error('the agent session closed before the permission changed');
          }
          await session.setAskMode(mode);
        },
      }));
      if (session && !targets.some((target) => target.session === session)) {
        targets.push({ session, accept: async () => undefined });
      }
      await acceptedPermissionMode(
        settingBook,
        async (book) => {
          await persistSettingBook(book);
          publishPicks();
        },
        targets,
        mode.value,
      );
      return true;
    };
    const removingOverride = !mode.claude && !mode.codex;
    let accepted: boolean | null;
    if (removingOverride) {
      accepted = await host.withRetiringActivities(
        liveTargets.map((state) => state.key),
        async () => {
          checkPolicies();
          invalidateTargets();
          const sessionIds = new Set(liveTargets.map((state) => state.sessionId).filter((id) => id !== null));
          if (session) {
            sessionIds.add(session);
          }
          panel.clearEffectiveModes(agent, [...sessionIds]);
          let book = settingBook();
          for (const sessionId of sessionIds) {
            book = withSessionSettings(book, sessionId, {
              ...sessionSettings(book, sessionId),
              permissionMode: mode.value,
            });
          }
          await persistSettingBook(book);
          await context.workspaceState.update(ASK_MODE_KEY, { ...stored(ASK_MODE_KEY), [agent]: mode.value });
          publishPicks();
          return true;
        },
      );
    } else {
      accepted = await host.withActivities(
        liveTargets.map((state) => state.key),
        async (sessions) => {
          checkPolicies();
          invalidateTargets();
          await context.workspaceState.update(ASK_MODE_KEY, { ...stored(ASK_MODE_KEY), [agent]: mode.value });
          return await applyMode(sessions);
        },
      );
    }
    if (accepted === null) {
      throw new Error('an agent session closed before the permission changed');
    }
  };

  const setModelFor = async (agent: AgentName, session: string, model: string): Promise<void> => {
    panel.invalidateContext(session);
    const value = pickedModel(model, models.get(agent));
    const live = host.find(agent, session);
    // Read the current effort choice after the model request settles, so a choice made during that request remains current.
    // Persist the model only after live controls accept it. A refusal retains the last confirmed settings.
    let change: ModelChange | null = null;
    await acceptedSessionSettings(
      settingBook,
      persistSettingBook,
      session,
      () => change!.settings,
      async () => {
        if (live) {
          await host.withActivity(live.key, (child) => child.setModel(value));
        }
        const held = sessionSettings(settingBook(), session).selectedEffort;
        const decided = modelChange(agent, value, held, models.get(agent), Boolean(live));
        change = decided;
        if (live && decided.tellChild) {
          await host.withActivity(live.key, (child) => child.setEffort(decided.effort));
        }
      },
    );
    publishPicks();
  };

  const setEffortFor = async (
    agent: AgentName,
    session: string,
    effort: string,
    settledModel: string,
  ): Promise<void> => {
    const value = pickedEffort(effort, models.get(agent), settledModel);
    const live = host.find(agent, session);
    const update = {
      selectedEffort: value,
      effortModel: settledModel,
      pendingEffort: value || null,
    };
    await acceptedSessionSettings(settingBook, persistSettingBook, session, update, async () => {
      if (live) {
        await host.withActivity(live.key, (session) => session.setEffort(value));
      }
    });
    publishPicks();
  };

  // Apply MCP changes to every live child of the agent. The CLI owns persisted server settings.
  // Read status after each change. Toggle and reconnect acknowledgments do not establish whether a server connected.
  const setMcpFor = async (agent: AgentName, owner: string, cwd: string | null, value: string): Promise<void> => {
    // Resolve changes from the host's newest retained server list before starting a child.
    // Toggle direction follows retained status even if the displayed list awaits repaint.
    // Ignore a toggle for a server absent from the retained list.
    // `mcpview.ts` defines toggle direction and the failed servers eligible for reconnect.
    const changes: McpChange[] = [];
    if (value === MCP_RECONNECT) {
      for (const server of failedServers(mcp.get(owner) ?? [])) {
        changes.push({ serverName: server.name, enabled: null });
      }
    } else {
      const wanted = mcpToggleWanted(mcp.get(owner) ?? [], value);
      if (wanted === null) {
        return;
      }
      changes.push({ serverName: value, enabled: wanted });
    }
    if (!changes.length) {
      return;
    }
    const revision = mcp.change(owner);

    // Collect per-server failures while continuing the other changes.
    const failures: string[] = [];
    const live = host.states().filter((state) => state.agent === agent && !state.exited);
    const target = liveMcpTarget(live, owner, draftMcpKeys);
    if (target) {
      const keys = [target.state.key, ...live.filter((state) => state !== target.state).map((state) => state.key)];
      const generation = mcpSurfaceGeneration;
      const result = await host.changeMcp(keys, changes);
      if (!result) {
        throw new Error('an agent session closed before its servers changed');
      }
      failures.push(...result.failures);
      if (result.servers && noteMcp(owner, result.servers, revision, generation)) {
        publishMcp();
      }
    } else {
      // Use a separate child when no live MCP target exists. Its shutdown persists the CLI's server settings.
      const plan = cwd ? idlePlanFor(agent, cwd) : null;
      if (!plan) {
        const named = agentChoices().find((choice) => choice.agent === agent)?.label ?? agent;
        throw new Error(`${named} cannot be started in this folder, so its servers cannot be changed.`);
      }
      const generation = mcpSurfaceGeneration;
      const done = await askIdleMcpChange(plan, spawner, changes);
      if (done.servers && noteMcp(owner, done.servers, revision, generation)) {
        publishMcp();
      }
      failures.push(...done.failures);
      // Report a child-start refusal separately from individual server failures.
      if (done.refusal) {
        const named = agentChoices().find((choice) => choice.agent === agent)?.label ?? agent;
        throw new Error(`${named} could not be started, so its servers were not changed. ${done.refusal}`);
      }
    }
    // Deduplicate failure descriptions reported by multiple children.
    const said = [...new Set(failures)];
    if (said.length) {
      throw new Error(`these servers did not answer: ${said.join(', ')}`);
    }
  };

  // What to start to ask one agent the two questions that cost no model tokens: the same
  // launch rule every other child goes through, and a plan that opens no session.
  const idlePlanFor = (agent: AgentName, cwd: string): AgentPlan | null => {
    const launch =
      agent === 'claude'
        ? { ...claudeLaunch(readSetting('claudePath'), thisMachine()), sessionSkills: sessionSkillSelection }
        : { ...codexLaunch(readSetting('codexPath'), thisMachine()), sessionSkills: sessionSkillSelection };
    if (launch.problem) {
      return null;
    }
    return agent === 'claude' ? claudeIdlePlan(launch, cwd) : codexIdlePlan(launch, { cwd, clientInfo: CLIENT_INFO });
  };

  let defaultsRevision = 0;
  const defaultRequests = new Map<string, Promise<AppliedDefaults>>();
  // Applied defaults readings saved across runs. The panel draws a saved reading until the fresh read answers.
  const savedDefaults = new SavedDefaults(context.globalState, path);
  panel.savedDefaults = savedDefaults;
  let defaultsDisposed = false;
  const configWatches = new ConfigWatches({
    watch: (base, pattern, listener) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      const disposables = [
        watcher,
        watcher.onDidCreate((uri) => listener('create', uri.fsPath)),
        watcher.onDidChange((uri) => listener('change', uri.fsPath)),
        watcher.onDidDelete((uri) => listener('delete', uri.fsPath)),
      ];
      return {
        dispose() {
          for (const disposable of disposables) disposable.dispose();
        },
      };
    },
    isDirectory: (target) => fs.promises.stat(target).then((stats) => stats.isDirectory()),
    invalidate: () => invalidateDefaults(),
    path,
    ignoreCase: process.platform === 'win32' || process.platform === 'darwin',
  });
  panel.onWatchDefaults = (cwds) => {
    if (defaultsDisposed) return;
    const roots = new Set(cwds.map((cwd) => comparableFolder(cwd, path)));
    for (const key of defaultRequests.keys()) {
      const [defaults] = JSON.parse(key) as string[];
      if (!roots.has(defaultsKeyParts(defaults).folder)) defaultRequests.delete(key);
    }
    configWatches.update(cwds);
  };
  context.subscriptions.push({
    dispose() {
      defaultsDisposed = true;
      defaultsRevision++;
      defaultRequests.clear();
      configWatches.dispose();
      panel.onWatchDefaults = null;
    },
  });
  panel.onReadDefaults = (agent, cwd, model) => {
    if (defaultsDisposed) return;
    const revision = defaultsRevision;
    const key = JSON.stringify([defaultsKey(agent, cwd, model, path), revision]);
    let request = defaultRequests.get(key);
    if (!request) {
      request = (async () => {
        let preparation: Promise<void>;
        do {
          preparation = privatePreparation;
          await preparation;
        } while (preparation !== privatePreparation);
        if (defaultsDisposed || revision !== defaultsRevision || defaultRequests.get(key) !== request)
          return unavailableDefaults('The agent could not report its settings.');
        const launch =
          agent === 'claude'
            ? { ...claudeLaunch(readSetting('claudePath'), thisMachine()), sessionSkills: sessionSkillSelection }
            : { ...codexLaunch(readSetting('codexPath'), thisMachine()), sessionSkills: sessionSkillSelection };
        const plan =
          agent === 'claude'
            ? claudeIdlePlan(launch, cwd, model)
            : codexIdlePlan(launch, { cwd, model, clientInfo: CLIENT_INFO });
        return launch.problem
          ? Promise.resolve(unavailableDefaults('The agent could not report its settings.'))
          : askIdleDefaults(plan, spawner);
      })().catch(() => unavailableDefaults('The agent could not report its settings.'));
      defaultRequests.set(key, request);
    }
    void request.then((defaults) => {
      if (!defaultsDisposed && revision === defaultsRevision && defaultRequests.get(key) === request) {
        void savedDefaults.save(agent, cwd, model, defaults);
        panel.setAppliedDefaults(agent, cwd, model, defaults);
      }
    });
  };
  const invalidateDefaults = () => {
    defaultsRevision++;
    defaultRequests.clear();
    panel.clearAppliedDefaults();
  };
  invalidatePreparedDefaults = () => {
    if (!defaultsDisposed) invalidateDefaults();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(settingName('claudePath')) || event.affectsConfiguration(settingName('codexPath')))
        invalidateDefaults();
    }),
  );
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(invalidateDefaults));
  const patterns = [
    new vscode.RelativePattern(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings*.json'),
    new vscode.RelativePattern(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
  ];
  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(invalidateDefaults),
      watcher.onDidCreate(invalidateDefaults),
      watcher.onDidDelete(invalidateDefaults),
    );
  }

  // Read account usage and the model catalog after a live child ends a turn. These controls consume no model tokens.
  //
  // Automatic failures retain readings without adding explicit refresh feedback.
  const readFrom = async (key: string, force: boolean, attempt?: number, operation?: number): Promise<void> => {
    await host.withActivity(key, async (session) => {
      if (force && session.state().busy) {
        await usageReads.waitUntilIdle(session.agent, true, attempt, operation);
        return;
      }
      if (!usageReads.current(session.agent, attempt)) return;
      const source = session.usageSource;
      const liveSources = host
        .states()
        .filter((state) => state.agent === session.agent && !state.exited)
        .map((state) => host.get(state.key)!.usageSource);
      const revision = usage.beginDiscovery(session.agent, source, liveSources);
      let usageFailure = '';
      if (!revision && force && operation !== undefined) {
        await askAgent(session.agent, true, undefined, session.cwd, attempt, operation);
        return;
      }
      if (!revision)
        usageReads.result(session.agent, attempt, usage.excluded(session.agent) ? 'excluded' : 'empty', '', operation);
      else {
        let discovered = false;
        try {
          const supported = await session.usageSupported(force);
          discovered = true;
          if (!usage.resolveDiscovery(session.agent, source, revision, supported)) {
            usageReads.result(
              session.agent,
              attempt,
              usage.excluded(session.agent) ? 'excluded' : 'empty',
              '',
              operation,
            );
          } else if (!supported) {
            publishUsage();
            usageReads.result(session.agent, attempt, 'excluded', '', operation);
          } else if (usageReads.reading(session.agent, attempt, operation)) {
            const reading = await session.rateLimits(force);
            if (!usage.accepts(session.agent, source)) {
              usageReads.result(
                session.agent,
                attempt,
                usage.excluded(session.agent) ? 'excluded' : 'empty',
                '',
                operation,
              );
            } else {
              if (reading === 'unavailable') {
                usage.noteSilent(session.agent);
              } else if (reading) {
                usage.note(session.agent, reading, source);
                usageReads.admitted(session.agent);
                publishUsage();
              }
              usageReads.result(
                session.agent,
                attempt,
                reading === 'unavailable' ? 'unavailable' : reading ? 'success' : 'empty',
                reading ? '' : 'No usable usage reading was returned.',
                operation,
              );
            }
          } else {
            usageReads.result(session.agent, attempt, 'empty', 'No usable usage reading was returned.', operation);
          }
        } catch (error) {
          if (!discovered) usage.resolveDiscovery(session.agent, source, revision, true);
          if (!usage.accepts(session.agent, source)) {
            usageReads.result(
              session.agent,
              attempt,
              usage.excluded(session.agent) ? 'excluded' : 'empty',
              '',
              operation,
            );
          } else {
            usage.noteSilent(session.agent);
            usageFailure = (error as Error).message;
            usageReads.result(session.agent, attempt, 'failed', usageFailure, operation);
          }
        }
      }
      // Pass the explicit refresh flag to the model catalog. It clears a previous silent failure so the reader can retry.
      if (models.toAsk([session.agent], Date.now(), force).length > 0) {
        const readPath = cliPath(session.agent);
        try {
          const list = await session.models();
          if (list) {
            models.note(session.agent, list, readPath);
            publishPicks();
          } else {
            models.noteSilent(session.agent);
            publishPicks();
          }
        } catch {
          models.noteSilent(session.agent);
          publishPicks();
        }
      }
      if (force && usageFailure && attempt === undefined) {
        throw new Error(`${session.agent} usage refresh failed: ${usageFailure}`);
      }
    });
  };

  // Request MCP status afresh, including while startup is still settling its fields.
  // Turn-end requests refresh server status because server failures emit no unsolicited status event.
  // A null answer leaves the retained list unchanged. An empty array reports no configured servers.
  // Keep automatic failures silent and retain the previous server list.
  const readMcpFrom = async (key: string, owner?: string): Promise<void> => {
    const generation = mcpSurfaceGeneration;
    const state = host.get(key)?.state();
    const identity = owner ?? state?.sessionId;
    if (!identity || !state) {
      return;
    }
    const revision = mcp.change(identity);
    await host.withActivity(key, async (session) => {
      try {
        const servers = await session.mcpStatus();
        if (servers && noteMcp(identity, servers, revision, generation)) {
          publishMcp();
        }
      } catch {
        // Retain the previous server list on failure.
      }
    });
  };

  // Read idle MCP status in a separate child so slow servers cannot delay usage, model catalogs, or commands.
  // A missing answer leaves retained server state unchanged.
  const readIdleMcp = async (
    agent: AgentName,
    cwd: string,
    owner: string,
    revision: number,
    generation: number,
  ): Promise<boolean> => {
    if (generation !== mcpSurfaceGeneration || revision !== mcp.revision(owner)) {
      return false;
    }
    const plan = idlePlanFor(agent, cwd);
    if (!plan) {
      return false;
    }
    const servers = await askIdleMcp(plan, spawner);
    if (!servers) {
      return false;
    }
    const accepted = noteMcp(owner, servers, revision, generation);
    if (accepted) {
      publishMcp();
    }
    return accepted;
  };

  // Refresh usage and model catalogs through a live child or an idle child. Explicit requests override freshness and silent failures.
  const askAgent = (
    agent: AgentName,
    force: boolean,
    mcpOwner?: string,
    mcpCwd?: string,
    attempt?: number,
    ownedOperation?: number,
  ): Promise<void> => {
    const requestedMcpRevision = mcpOwner ? mcp.revision(mcpOwner) : 0;
    const requestedMcpGeneration = mcpSurfaceGeneration;
    const requestOwner = mcpOwner ? `${mcpOwner}:${requestedMcpRevision}` : '';
    return usageReads.run(
      agent,
      force,
      async (force, operation) => {
        const cwd = mcpCwd ?? workspaceCwd();
        if (!cwd) {
          usageReads.result(agent, attempt, 'failed', 'Open a workspace folder before reading usage.', operation);
          return;
        }
        const now = Date.now();
        // Evaluate both freshness checks. Each clears its silent mark on an explicit refresh, so short-circuiting would leave one marked silent.
        const wantUsage = usage.toAsk([agent], now, force).length > 0;
        const wantModels = models.toAsk([agent], now, force).length > 0;
        // Request commands once per agent per window, even before any prompt starts a child.
        const wantCommands = !commandsAsked.has(agent);
        // Request initial server status independently of usage and catalogs. Missing answers remain eligible for retry. The initial-read gate prevents duplicate requests.
        const live = host.states().filter((s) => s.agent === agent && !s.exited);
        const mcpTarget = liveMcpTarget(live, mcpOwner, draftMcpKeys);
        const mcpLive = mcpTarget?.state;
        const resolvedMcpOwner = mcpOwner ?? mcpTarget?.owner;
        const wantMcp = Boolean(resolvedMcpOwner && mcp.needsInitialRead(resolvedMcpOwner));
        if (!wantUsage && !wantModels && !wantCommands && !wantMcp) {
          return;
        }
        const liveSources = live.map((state) => host.get(state.key)!.usageSource);
        const eligibleIdle = live
          .filter((state) => !state.busy && usage.canDiscover(agent, host.get(state.key)!.usageSource, liveSources))
          .sort((left, right) =>
            agent === 'codex' ? host.get(right.key)!.usageSource - host.get(left.key)!.usageSource : 0,
          );
        const idleLive = mcpOwner
          ? mcpLive?.busy
            ? undefined
            : mcpLive && eligibleIdle.includes(mcpLive)
              ? mcpLive
              : eligibleIdle[0]
          : eligibleIdle[0];
        // Account reads use an idle child. All-busy requests wait without changing active authentication.
        if (live.length && !idleLive && (live.every((state) => state.busy) || (mcpOwner && mcpLive?.busy))) {
          const waiting = usageReads.waitUntilIdle(agent, force, attempt, operation);
          if (waiting) {
            await waiting;
          }
          return;
        }
        let refreshFailure: Error | null = null;
        let initialMcpRevision: number | null = null;
        try {
          if (idleLive) {
            // Reuse a live child's command catalog. MCP status still requires a request, and a missing answer keeps the initial-read gate open.
            publishCommands();
            commandsAsked.add(agent);
            if (wantMcp && resolvedMcpOwner) {
              if (mcpLive) {
                void readMcpFrom(mcpLive.key, resolvedMcpOwner);
              } else {
                const revision = mcp.beginInitialRead(resolvedMcpOwner, requestedMcpRevision);
                if (revision !== null) {
                  void readIdleMcp(agent, mcpCwd ?? cwd, resolvedMcpOwner, revision, requestedMcpGeneration).then(
                    (answered) => mcp.finishInitialRead(resolvedMcpOwner, revision, answered),
                  );
                }
              }
            }
            if (idleLive) {
              await readFrom(idleLive.key, force, attempt, operation);
            }
            return;
          }
          if (!wantUsage && !wantModels && !wantCommands && wantMcp && resolvedMcpOwner) {
            const revision = mcp.beginInitialRead(resolvedMcpOwner, requestedMcpRevision);
            if (revision !== null) {
              void readIdleMcp(agent, mcpCwd ?? cwd, resolvedMcpOwner, revision, requestedMcpGeneration).then(
                (answered) => mcp.finishInitialRead(resolvedMcpOwner, revision, answered),
              );
            }
            return;
          }
          const readPath = cliPath(agent);
          const plan = idlePlanFor(agent, cwd);
          if (!plan) {
            usageReads.result(
              agent,
              attempt,
              'failed',
              'The agent could not start to read usage. Check its executable setting.',
              operation,
            );
            commandsAsked.add(agent);
            if (resolvedMcpOwner) {
              const revision = mcp.beginInitialRead(resolvedMcpOwner, requestedMcpRevision);
              if (revision !== null) {
                mcp.noteSilent(resolvedMcpOwner, revision);
              }
            }
            usage.noteSilent(agent);
            models.noteSilent(agent);
            publishPicks();
            return;
          }
          initialMcpRevision =
            wantMcp && resolvedMcpOwner ? mcp.beginInitialRead(resolvedMcpOwner, requestedMcpRevision) : null;
          const commandRevision = commandLists.revision(agent);
          if (!usageReads.current(agent, attempt)) return;
          let source = 0;
          let revision = 0;
          const answers = await askIdle(
            plan,
            spawner,
            undefined,
            (reading, failure) => {
              if (!usage.accepts(agent, source)) {
                usageReads.result(agent, attempt, 'excluded', '', operation);
                return;
              }
              if (reading === 'unavailable') {
                usage.noteSilent(agent);
              } else if (reading) {
                usage.note(agent, reading, source);
                usageReads.admitted(agent);
                publishUsage();
              } else usage.noteSilent(agent);
              usageReads.result(
                agent,
                attempt,
                failure ? 'failed' : reading === 'unavailable' ? 'unavailable' : reading ? 'success' : 'empty',
                failure || (reading ? '' : 'No usable usage reading was returned.'),
                operation,
              );
            },
            () => usageReads.current(agent, attempt),
            (supported, discoveredSource) => {
              source = discoveredSource;
              if (supported === null) {
                revision = usage.beginDiscovery(agent, source);
                if (!revision) usageReads.result(agent, attempt, 'excluded', '', operation);
                return revision !== 0;
              }
              if (!usage.resolveDiscovery(agent, source, revision, supported)) {
                usageReads.result(agent, attempt, 'excluded', '', operation);
                return false;
              }
              if (!supported) {
                publishUsage();
                usageReads.result(agent, attempt, 'excluded', '', operation);
                return false;
              }
              const reading = usageReads.reading(agent, attempt, operation);
              if (!reading)
                usageReads.result(agent, attempt, 'empty', 'No usable usage reading was returned.', operation);
              return reading;
            },
            force,
          );
          // Publish the idle child's commands when its remaining controls settle.
          commandsAsked.add(agent);
          publishCommands({ agent, ...answers.child, commands: answers.commands, complete: false }, commandRevision);
          if (answers.models) {
            models.note(agent, answers.models, readPath);
            publishPicks();
          } else {
            models.noteSilent(agent);
            publishPicks();
          }
          if (force && answers.usageFailure && attempt === undefined) {
            refreshFailure = new Error(`${agent} usage refresh failed: ${answers.usageFailure}`);
          }
          // Start MCP status separately without delaying publication of the other control answers.
          if (resolvedMcpOwner && initialMcpRevision !== null) {
            const revision = initialMcpRevision;
            void readIdleMcp(agent, mcpCwd ?? cwd, resolvedMcpOwner, revision, requestedMcpGeneration).then(
              (answered) => mcp.finishInitialRead(resolvedMcpOwner, revision, answered),
            );
          }
        } catch (error) {
          usageReads.result(agent, attempt, 'failed', (error as Error).message, operation);
          // Mark failed control reads silent to avoid repeated automatic process starts. Explicit refresh requests clear usage and model silent marks.
          commandsAsked.add(agent);
          if (resolvedMcpOwner && initialMcpRevision !== null) {
            mcp.noteSilent(resolvedMcpOwner, initialMcpRevision);
          }
          usage.noteSilent(agent);
          models.noteSilent(agent);
          publishPicks();
          if (force && attempt === undefined) {
            refreshFailure = error as Error;
          }
        }
        if (refreshFailure) {
          throw refreshFailure;
        }
      },
      requestOwner,
      attempt,
      ownedOperation,
    );
  };

  const refreshUsage = (
    only: string | null,
    force: boolean,
    mcpOwner?: string,
    mcpAgent?: string,
    mcpCwd?: string,
  ): void => {
    const agents = only ? [only] : USAGE_AGENT_ORDER;
    const attempt = force ? usageReads.begin(agents) : undefined;
    if (attempt === null) return;
    for (const agent of agents) {
      const ownsMcp = only === agent || (!only && mcpAgent === agent);
      const read = () =>
        askAgent(agent as AgentName, force, ownsMcp ? mcpOwner : undefined, ownsMcp ? mcpCwd : undefined, attempt);
      if (force) {
        void read().catch((error: Error) => usageReads.result(agent, attempt, 'failed', error.message));
      } else {
        void read();
      }
    }
  };

  // Guarded follow-up ownership for this activation. The panel host reaches the same policy through its
  // read facts and reader intervention ports, which are assigned beside its other callbacks.
  const guardedSends = new GuardedSends<AgentSession>(channel?.hostId ?? '', (owner) =>
    host.find(owner.child.agent, owner.worker),
  );
  Object.assign(panel, guardedPanelPorts(guardedSends));
  panel.installGuardedFacts?.(
    guardedFactsWithCompaction(
      (sessionId) => panel.guardedTargetFacts(sessionId),
      (sessionId) => compaction?.requests.waitingSessions().includes(sessionId) ?? false,
    ),
  );
  // A guarded write registers its submission like ordinary delivery, so a deferred compaction its turn requests binds.
  const guardedPort = guardedDeliveryPort(guardedSends, host, activeWriterFailure, randomUUID, (child, turnId) =>
    compaction?.submitted(child, turnId, 'followup'),
  );
  // Read Codex context from the panel's source. Read Claude context only through the current live child for this session.
  panel.contextSource = (agent, sessionId) => {
    if (agent === 'codex') return panel.codexContextSource(sessionId);
    if (agent !== 'claude') return null;
    const child = host.find(agent, sessionId);
    if (!child) return null;
    return {
      id: child.key,
      current: () => host.find(agent, sessionId) === child && !child.state().exited,
      read: () =>
        host.withActivity(child.key, (live) => (live === child ? live.contextUsage() : Promise.resolve(null))),
    };
  };
  panel.onSendPrompt = async (
    agent,
    sessionId,
    cwd,
    prompt,
    onSubmitted,
    guarded?: GuardedDelivery,
  ): Promise<PromptDelivery & { guarded?: GuardedSendResult }> => {
    if (guarded) {
      // Guarded delivery mode. It requires the recorded child and never reopens, resumes, forks, or shows a dialog.
      // It writes only the requested text, with no attachments, comments, or prompt history.
      // Structured results replace failure classification and recovery dialogs after attempted input.
      const result = await runGuardedSend(guardedSends, { ...guarded, prompt: prompt.text }, guardedPort).finally(() =>
        panel.refreshFrom('guarded-send'),
      );
      return { delivered: result.status === 'accepted', reason: result.reason, guarded: result };
    }
    try {
      const turnId = await withExistingSessionActivity(agent as AgentName, sessionId, cwd, async (session) => {
        validateResolvedPromptAssets(prompt.assets);
        // Retain prompt text until the child accepts the turn. The returned promise reports protocol refusals to the retained card.
        return await promptAsReader(
          compaction,
          session,
          (submitted, received) =>
            session.prompt(
              readerPrompt(compaction, sessionId, prompt),
              submitted,
              recoveryPrompts.get(prompt),
              received,
            ),
          (turnId) => onSubmitted?.(session.state().sessionId ?? sessionId, turnId),
        );
      });
      if (turnId === null) {
        return failedPromptDelivery(agent, new Error('no agent session could be opened'));
      }
      panel.refreshFrom('prompt-sent');
      return { delivered: true, reason: '', turnId };
    } catch (error) {
      if (activeWriterFailure(error)) guardedSends.noteWriterConflict(sessionId);
      if (agent === 'codex' && activeWriterFailure(error)) {
        const action = 'Fork and continue in Arc';
        const picked = await vscode.window.showWarningMessage(
          'Codex is still open in another client. Arc cannot write to the same ' +
            'session while that client owns it. Fork its saved history into a new ' +
            'Arc session and send this prompt there?',
          action,
        );
        if (picked === action) {
          try {
            const forkedSession = await forkCodexSession(sessionId, cwd);
            if (!forkedSession) {
              return failedPromptDelivery(agent, new Error('no continuation session could be opened'));
            }
            validateResolvedPromptAssets(prompt.assets);
            const continued = forkedSession.state().sessionId;
            if (!continued) {
              return failedPromptDelivery(agent, new Error('Codex did not name the continuation session'));
            }
            const turnId = await withStartedSessionActivity(
              forkedSession,
              (live) =>
                promptAsReader(
                  compaction,
                  live,
                  (submitted, received) => live.prompt(prompt, submitted, recoveryPrompts.get(prompt), received),
                  (turnId) => onSubmitted?.(continued, turnId),
                ),
              existingSessionPlan('codex', continued, cwd!),
            );
            panel.refreshFrom('fork-sent');
            return { delivered: true, reason: '', session: continued, turnId };
          } catch (forkError) {
            void vscode.window.showErrorMessage(`Arc: ${(forkError as Error).message}`);
            return failedPromptDelivery(agent, forkError);
          }
        }
      }
      void vscode.window.showErrorMessage(`Arc: ${(error as Error).message}`);
      return failedPromptDelivery(agent, error);
    }
  };
  // Claude sends its compact command through the prompt transport. Codex uses a native control request.
  // Neither action attaches prompt box text or reader comments.
  panel.onCompact = async (agent, session, cwd) => {
    try {
      const turnId = await withExistingSessionActivity(agent as AgentName, session, cwd, (session) =>
        session.compact(),
      );
      if (turnId === null) {
        return { delivered: false, reason: 'No agent session could be opened for compaction.' };
      }
      panel.refreshFrom('compact');
      return { delivered: true, reason: '', turnId };
    } catch (error) {
      // Use the same delivery reason in the retained card and the editor error notice.
      const delivery = failedCompactionDelivery(agent, error);
      void vscode.window.showErrorMessage(`Arc: ${delivery.reason}`);
      return delivery;
    }
  };
  panel.onClear = async (agent, session, cwd, name) => {
    try {
      host.questionRecovery()?.closeSession(session);
      const result = await withExistingSessionActivity(agent as AgentName, session, cwd, async (live) => {
        const policy = live.policy ?? policies.readSaved(session);
        let token: string | undefined;
        let attempted = false;
        try {
          const turnId = await live.clear(
            name,
            policy
              ? () => {
                  if (host.get(live.key) !== live || live.state().exited)
                    throw new Error('The session is no longer running.');
                  token = policies.prepareClear(live.key, session, live);
                }
              : undefined,
            () => {
              attempted = true;
            },
          );
          return { turnId, session: live.state().sessionId, policy };
        } catch (error) {
          if (token && !attempted && host.get(live.key) === live && !live.state().exited)
            policies.cancelClear(live.key, token, live);
          throw error;
        }
      });
      if (!result || !result.session) {
        return { delivered: false, reason: 'No agent session could be opened for clearing.' };
      }
      await savePolicy(result.session, result.policy);
      panel.refreshFrom('clear');
      return { delivered: true, reason: '', turnId: result.turnId, session: result.session };
    } catch (error) {
      const delivery = failedClearDelivery(agent, error);
      void vscode.window.showErrorMessage(`Arc: ${delivery.reason}`);
      return delivery;
    }
  };
  const acceptedDrafts = new Set<string>();
  panel.onSendDraftPrompt = async (draft, prompt, onSubmitted, start?: GuardedStartContext) => {
    const acceptedProject = setupProjects.resolve(draft.cwd);
    let accepted: { session: string; turnId: number } | null = null;
    try {
      // Only a start that carries a requester echoes user messages, because guarded follow-ups use the echo as a receipt.
      const liveSession = await startFreshSession(draft, !!start?.requester);
      if (start?.launchId) dispatch.register(start.launchId, liveSession);
      validateResolvedPromptAssets(prompt.assets);
      let prompted: AgentSession | null = null;
      const turnId = await withStartedSessionActivity(
        liveSession,
        async (live) => {
          prompted = live;
          const knownId = live.state().sessionId;
          if (knownId) await savePolicy(knownId, draft.policy);
          const turnId = await promptAsReader(
            compaction,
            live,
            (submitted, received) => live.prompt(prompt, submitted, undefined, received),
            (turnId) => {
              if (start?.launchId) dispatch.submitted(start.launchId, turnId);
              const session = live.state().sessionId;
              onSubmitted?.(session ?? '', turnId);
            },
          );
          const session = live.state().sessionId;
          if (session) accepted = { session, turnId };
          if (start?.launchId) dispatch.accepted(start.launchId, live.nativeTurnIdentity(turnId));
          acceptedDrafts.add(live.key);
          return turnId;
        },
        resumePlanForDraft(draft, () => liveSession.state().sessionId),
      );
      host.cancelSessionRetirement(liveSession.key);
      // The association is recorded with the actual child before any asynchronous metadata save.
      if (start) recordGuardedStart(guardedSends, start, liveSession, prompted);
      draftMcpKeys.delete(draft.draftId);
      mcpRefreshes.cancel(draft.draftId);
      const sessionId = liveSession.state().sessionId;
      if (!sessionId) {
        return failedPromptDelivery(draft.profile.agent, new Error('the agent did not name its new session'));
      }
      await savePolicy(sessionId, draft.policy);
      accepted = { session: sessionId, turnId };
      const project = await acceptedProject;
      const entry = await setupStore.accept(project, draft.profile);
      if (project === panel.setupProject) panel.setRecentProfiles(entry.recents);
      panel.refreshFrom('session-started');
      return { delivered: true, reason: '', session: sessionId, turnId };
    } catch (error) {
      if (accepted)
        return {
          delivered: true,
          reason: `The session accepted its prompt, but its setup was not saved. ${(error as Error).message}`,
          ...accepted,
        };
      if (start?.launchId) dispatch.unavailable(start.launchId);
      void vscode.window.showErrorMessage(`Arc: ${(error as Error).message}`);
      return failedPromptDelivery(draft.profile.agent, error);
    }
  };
  // The turn in the session the composer is aimed at, and no other. Stopping every
  // busy child would stop work the reader was not looking at and did not ask to stop.
  panel.onStopTurn = (agent, sessionId) =>
    reportFailures(async () => {
      const mine = busyInSession(host.states(), agent, sessionId);
      for (const state of mine) {
        const liveSession = host.get(state.key);
        if (!liveSession) {
          continue;
        }
        const stopped = await liveSession.interrupt();
        for (const turnId of stopped)
          panel.noteResponseEnded(
            sessionId,
            { status: 'interrupted', text: '', costUsd: null, turns: null, deniedTools: [] },
            turnId,
          );
        panel.releaseDeliveredPromptAssets(sessionId, true);
      }
    });
  panel.setRefreshUsageHandler((agent, force, owner, ownerAgent, ownerCwd) =>
    refreshUsage(agent, force, owner, ownerAgent, ownerCwd),
  );
  panel.onTurnsFinished = (agents) => {
    for (const agent of agents) {
      refreshUsage(agent, false);
    }
  };

  // Track the owner of the open Servers control. The callback requests status for that owner without waiting for unrelated usage reads.
  let activeMcpOwner: string | null = null;
  panel.onPanelCommand = (owner, agent, control, draft, cwd) =>
    reportFailures(async () => {
      if (control !== 'mcp') {
        return;
      }
      const which = agent as AgentName;
      if (draft && which === 'claude') {
        const key = freshHostKey('claude', draft.draftId);
        draftMcpKeys.set(draft.draftId, key);
        const revision = mcp.change(owner);
        const generation = mcpSurfaceGeneration;
        const plan = freshPlanForDraft(draft);
        await openDraftMcp(host, key, plan, mcpRefreshes, owner, (servers) => {
          const accepted = noteMcp(owner, servers, revision, generation);
          if (accepted) {
            publishMcp();
          }
          return accepted;
        });
        return;
      }
      if (draft) {
        return;
      }
      const live = host
        .states()
        .find((state) => state.agent === which && !state.exited && !state.busy && state.sessionId === owner);
      if (live) {
        await readMcpFrom(live.key, owner);
        return;
      }
      const directory = cwd ?? workspaceCwd();
      if (directory) {
        const revision = mcp.change(owner);
        await readIdleMcp(which, directory, owner, revision, mcpSurfaceGeneration);
      }
    });
  // Remote Control acts only on this window's running Claude process for the session. It starts no child.
  panel.onRemoteControl = async (session, observer) => {
    const live = host.find('claude', session);
    if (!live) return { result: { outcome: 'stopped' }, session: null };
    // Name the session the child holds when each result arrives, because a Claude `/clear` changes it.
    // A child that exited or lost its key names none: its exit already took the connection away.
    const holder = () => (host.get(live.key) === live && !live.state().exited ? live.state().sessionId : null);
    const settled = await host.remoteControl(live.key, (result) => observer(result, holder()));
    return { result: settled ?? { outcome: 'stopped' }, session: holder() };
  };
  const openPanelControl = panel.onPanelCommand;
  panel.onPanelCommand = (owner, agent, control, draft, cwd) => {
    if (control === 'mcp') {
      if (activeMcpOwner && activeMcpOwner !== owner) {
        mcpRefreshes.cancel(activeMcpOwner);
      }
      activeMcpOwner = owner;
    }
    openPanelControl?.(owner, agent, control, draft, cwd);
  };
  panel.onSelectionChanged = (session, agent, cwd) => {
    if (activeMcpOwner && activeMcpOwner !== session) {
      mcp.change(activeMcpOwner);
      mcpRefreshes.cancel(activeMcpOwner);
      activeMcpOwner = null;
    }
    if (session && agent) {
      refreshUsage(agent, false, session, agent, cwd ?? undefined);
    }
  };
  panel.onDraftRemoved = (draft) => {
    for (const agent of USAGE_AGENT_ORDER) {
      acceptedDrafts.delete(freshHostKey(agent as AgentName, draft.draftId));
    }
    mcp.forget(draft.draftId);
    mcpRefreshes.cancel(draft.draftId);
    const key = draftMcpKeys.get(draft.draftId);
    draftMcpKeys.delete(draft.draftId);
    if (key) {
      void host.retireSession(key);
    }
  };
  panel.onDraftProfileChanged = (draft) => {
    retireDraftProfile(host, draft, mcp, mcpRefreshes, draftMcpKeys, acceptedDrafts);
    publishMcp();
  };
  panel.onDraftAdopted = (provisional, actual) => {
    for (const agent of USAGE_AGENT_ORDER) {
      acceptedDrafts.delete(freshHostKey(agent as AgentName, provisional));
    }
    mcpRefreshes.cancel(provisional);
    mcp.adopt(provisional, actual);
    if (activeMcpOwner === provisional) {
      activeMcpOwner = actual;
    }
    publishMcp();
  };
  panel.onPanelsClosed = () => {
    mcpSurfaceGeneration++;
    mcp.invalidateInitialReads();
    mcpRefreshes.dispose();
    for (const key of draftMcpKeys.values()) {
      void host.retireSession(key);
    }
    draftMcpKeys.clear();
    activeMcpOwner = null;
  };

  panel.onPicked = (agent, session, control, value, settledModel, cwd) =>
    reportFailures(async () => {
      const which = agent as AgentName;
      if (control === 'askmode') {
        await acceptedAskModePick(which, value, (mode) => setAskModeFor(which, mode, session));
      } else if (control === 'model') {
        await setModelFor(which, session, value);
      } else if (control === 'effort') {
        await setEffortFor(which, session, value, settledModel);
      } else if (control === 'mcp') {
        await setMcpFor(which, session, cwd, value);
      }
    });

  // Drawn from the start, before any agent has been driven.
  publishPicks();
  // Publish the initially empty server lists. The prompt box shows Servers only after a request reports configured servers.
  publishMcp();

  // Display rejected command work as an editor error. Async callbacks also convert synchronous child-start exceptions into rejected promises.
  const reportFailures = (work: () => Promise<void>) =>
    void work().catch((error: Error) => {
      void vscode.window.showErrorMessage(`Arc: ${error.message}`);
    });

  // Keep resume, fork, and fresh launch paths separate because each carries different session identity.
  let forkSequence = 0;
  const launchFor = (which: AgentName) =>
    which === 'claude'
      ? { ...claudeLaunch(readSetting('claudePath'), thisMachine()), sessionSkills: sessionSkillSelection }
      : { ...codexLaunch(readSetting('codexPath'), thisMachine()), sessionSkills: sessionSkillSelection };
  const ensureSession = async (key: string, plan: AgentPlanSource) => {
    const session = await host.session(key, plan);
    const failure = session.state().lastError;
    if (failure && session.state().exited) {
      throw new Error(failure);
    }
    return session;
  };
  // Rename through a live child when available. Otherwise start a control-only child. Claude needs the original working directory to locate its transcript.
  panel.onRenameSession = (agent, session, cwd, title, file) =>
    renameAgentSession(host, {
      agent,
      sessionId: session,
      title,
      file,
      idlePlan: () => {
        const launch = launchFor(agent);
        if (launch.problem) {
          throw new Error(launch.problem);
        }
        if (agent === 'claude') {
          if (!cwd) {
            throw new Error('Arc cannot tell which folder this session ran in.');
          }
          const mode = askModeFor(agent, session);
          return claudeRenamePlan(launch, {
            cwd,
            resume: session,
            policy: policies.read(session),
            title,
            agentRun: panel.isAgentRunLaunch?.(session) ?? false,
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            model: modelFor(agent, session),
            effort: effortFor(agent, session),
          });
        }
        // The Codex child sends one request after its handshake, so any existing folder serves.
        return codexRenamePlan(launch, {
          cwd: cwd ?? path.dirname(file),
          clientInfo: CLIENT_INFO,
          threadId: session,
          title,
        });
      },
    });
  panel.onRenameStartedSession = async (agent, sessionId, cwd, rawTitle, current) => {
    const title = sessionRenameTitle(rawTitle);
    if (!title) throw new Error('Enter a session name.');
    await renameAgentSession(host, {
      agent,
      sessionId,
      title,
      file: '',
      initial: true,
      current,
      sourceFile: () => sessionFileFor(projectsRoot(), [cwd], sessionId) ?? '',
      idlePlan: () => {
        throw new Error('The new session is no longer connected.');
      },
    });
  };
  panel.onInitialNameReadiness = (session, cwd, wake) => {
    const child = host.find('codex', session);
    const subscription = watchInitialCodexName(session, cwd, wake);
    return {
      current: () => {
        const ready = subscription.current();
        return { ...ready, current: ready.current && child !== null && host.find('codex', session) === child };
      },
      dispose: () => subscription.dispose(),
    };
  };
  const withStartedSessionActivity = async <T>(
    session: AgentSession,
    work: (session: AgentSession) => Promise<T>,
    replacementPlan: AgentPlanSource,
  ): Promise<T> => {
    const result = await host.withActivity(session.key, work);
    return result ?? (await host.withSessionActivity(session.key, replacementPlan, work));
  };
  const existingSessionPlan =
    (which: AgentName, session: string, cwd: string): AgentPlanSource =>
    () => {
      const launch = launchFor(which);
      if (launch.problem) {
        throw new Error(launch.problem);
      }
      const mode = askModeFor(which, session);
      const model = modelFor(which, session);
      const effort = effortFor(which, session);
      return which === 'claude'
        ? claudePlan(launch, {
            cwd,
            resume: session,
            replayUserMessages: true,
            policy: policies.read(session),
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            agentRun: panel.isAgentRunLaunch?.(session) ?? false,
            model,
            effort,
          })
        : codexPlan(launch, {
            cwd,
            resume: session,
            policy: policies.read(session),
            clientInfo: CLIENT_INFO,
            ...(mode ? codexAskMode(mode) : {}),
            model,
            effort,
          });
    };
  const withExistingSessionActivity = async <T>(
    which: AgentName,
    session: string,
    cwd: string | null,
    work: (session: AgentSession) => Promise<T>,
  ): Promise<T | null> => {
    if (!cwd) {
      void vscode.window.showWarningMessage('Arc: open a folder first. The agent runs in it.');
      return null;
    }
    const existing = host.find(which, session);
    if (existing) {
      const result = await host.withActivity(existing.key, work);
      if (result !== null) {
        return result;
      }
    }
    const launch = launchFor(which);
    if (launch.problem) {
      void vscode.window.showErrorMessage(`Arc: ${launch.problem}`);
      return null;
    }
    return await host.withSessionActivity(
      existingHostKey(which, session),
      () => {
        const mode = askModeFor(which, session);
        const model = modelFor(which, session);
        const effort = effortFor(which, session);
        return which === 'claude'
          ? claudePlan(launch, {
              cwd,
              resume: session,
              policy: policies.read(session),
              ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
              agentRun: panel.isAgentRunLaunch?.(session) ?? false,
              model,
              effort,
            })
          : codexPlan(launch, {
              cwd,
              resume: session,
              policy: policies.read(session),
              clientInfo: CLIENT_INFO,
              ...(mode ? codexAskMode(mode) : {}),
              model,
              effort,
            });
      },
      work,
    );
  };
  const forkCodexSession = async (sessionId: string, cwd: string | null) => {
    if (!cwd) {
      return null;
    }
    const launch = launchFor('codex');
    if (launch.problem) {
      void vscode.window.showErrorMessage(`Arc: ${launch.problem}`);
      return null;
    }
    const mode = askModeFor('codex', sessionId);
    const picked = askValueFor('codex', sessionId);
    const model = modelFor('codex', sessionId);
    const effort = effortFor('codex', sessionId);
    const settings = sessionSettingsForProfile({
      agent: 'codex',
      model,
      effort,
      permissionMode: picked ?? '',
      source: 'custom',
    });
    // Leave a fork's permission unset when its source has no stored permission. An empty string explicitly selects the Codex default.
    if (picked === undefined) {
      delete settings.permissionMode;
    }
    const key = `codex:fork:${sessionId}:${++forkSequence}`;
    const policy = policies.read(sessionId);
    let token: string | undefined;
    let owner: AgentSession | undefined;
    let attempted = false;
    let session: AgentSession;
    try {
      session = await ensureSession(
        key,
        codexPlan(launch, {
          cwd,
          fork: sessionId,
          policy,
          beforeForkWrite: policy
            ? () => {
                owner = host.get(key) ?? undefined;
                if (!owner || owner.state().exited) throw new Error('The session is no longer running.');
                token = policies.prepareClear(key, sessionId, owner);
              }
            : undefined,
          forkWriteAttempted: () => {
            attempted = true;
          },
          clientInfo: CLIENT_INFO,
          ...(mode ? codexAskMode(mode) : {}),
          model,
          effort,
        }),
      );
    } catch (error) {
      if (token && !attempted && owner && host.get(key) === owner && !owner.state().exited)
        policies.cancelClear(key, token, owner);
      throw error;
    }
    const continued = session.state().sessionId;
    if (!continued) {
      throw new Error('Codex did not name the continuation session');
    }
    await savePolicy(continued, session.policy ?? policies.readSaved(sessionId));
    await persistSessionSettings(continued, settings);
    publishPicks();
    return session;
  };
  const freshPlanForDraft = (draft: NewSessionDraft, replayUserMessages = false): AgentPlanSource => {
    const launch = launchFor(draft.profile.agent);
    if (launch.problem) {
      throw new Error(launch.problem);
    }
    const mode = draft.profile.permissionMode ? askMode(draft.profile.agent, draft.profile.permissionMode) : undefined;
    if (!mode && draft.profile.permissionMode) {
      throw new Error('The selected permission is no longer available.');
    }
    const sessionId = draft.profile.agent === 'claude' ? randomUUID() : null;
    return () =>
      draft.profile.agent === 'claude'
        ? claudePlan(launch, {
            cwd: draft.cwd,
            policy: draft.policy,
            agentRun: draft.agentRun,
            cacheLifetime: draft.cacheLifetime,
            sessionId: sessionId!,
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            model: draft.profile.model,
            effort: draft.profile.effort,
            ...(replayUserMessages ? { replayUserMessages } : {}),
          })
        : codexPlan(launch, {
            cwd: draft.cwd,
            policy: draft.policy,
            clientInfo: CLIENT_INFO,
            ...(mode ? codexAskMode(mode) : {}),
            model: draft.profile.model,
            effort: draft.profile.effort,
          });
  };
  const resumePlanForDraft =
    (draft: NewSessionDraft, readSessionId: () => string | null): AgentPlanSource =>
    () => {
      const sessionId = readSessionId();
      if (!sessionId) {
        throw new Error('the agent did not name its new session');
      }
      const launch = launchFor(draft.profile.agent);
      if (launch.problem) {
        throw new Error(launch.problem);
      }
      const mode = askModeFor(draft.profile.agent, sessionId);
      return draft.profile.agent === 'claude'
        ? claudePlan(launch, {
            cwd: draft.cwd,
            resume: sessionId,
            policy: draft.policy ?? policies.read(sessionId),
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            agentRun: draft.agentRun ?? panel.isAgentRunLaunch?.(sessionId) ?? false,
            cacheLifetime: draft.cacheLifetime,
            model: draft.profile.model,
            effort: draft.profile.effort,
          })
        : codexPlan(launch, {
            cwd: draft.cwd,
            resume: sessionId,
            policy: draft.policy ?? policies.read(sessionId),
            clientInfo: CLIENT_INFO,
            ...(mode ? codexAskMode(mode) : {}),
            model: draft.profile.model,
            effort: draft.profile.effort,
          });
    };
  const startFreshSession = async (draft: NewSessionDraft, replayUserMessages = false) => {
    return await ensureSession(
      freshHostKey(draft.profile.agent, draft.draftId),
      freshPlanForDraft(draft, replayUserMessages),
    );
  };

  // Warn when the child stops waiting before the reader sends an answer.
  const reportAnswer = (answered: boolean) => {
    if (!answered) {
      void vscode.window.showWarningMessage(
        'Arc: the agent had already stopped waiting for that answer, so it was not sent.',
      );
    }
  };

  panel.onAnswerAsk = async (session, id, candidate) => {
    const waiting = host.waiting().find((entry) => {
      return entry.session === session && entry.ask.id === id;
    });
    if (!waiting) {
      reportAnswer(false);
      updateAgentAffordance();
      return false;
    }
    const answer = acceptedAskAnswer(waiting.ask, candidate);
    if (!answer) {
      void vscode.window.showWarningMessage('Arc: that answer no longer matches what the agent asked.');
      updateAgentAffordance();
      return false;
    }
    if (waiting.recovered) {
      const entry = waiting.recovered;
      const recovery = host.questionRecovery();
      try {
        if (!recovery?.owns()) throw new Error('Another window owns this saved question.');
        if (answer.decision === 'deny') {
          recovery.settle(entry.identity, 'declined');
          updateAgentAffordance();
          return true;
        }
        const eligible = () => {
          if (!recovery.owns() || panel.questionSource(entry.agent, entry.session) !== entry.source || !entry.source)
            throw new Error('The saved question cannot continue in this window.');
          if (host.waiting().some((open) => open.session === entry.session && !open.recovered))
            throw new Error('Answer the current agent request before continuing this saved question.');
        };
        eligible();
        const text = questionContinuation(entry, answer);
        if (!text || entry.disposition === 'unknown')
          throw new Error(
            waiting.ask.kind === 'question' ? waiting.ask.recovery?.detail : 'This question cannot be answered.',
          );
        const prompt: AgentPrompt = { text, assets: [] };
        try {
          const answeredNative = await withExistingSessionActivity(
            entry.agent,
            entry.session,
            entry.cwd,
            async (live) => {
              const state = live.state();
              const fresh = state.asks.find(
                (ask) =>
                  ask.kind === 'question' &&
                  questionIdentity(state.agent, state.sessionId ?? '', state.cwd, ask) === entry.identity,
              );
              if (!fresh) return false;
              if (!recovery.owns()) throw new Error('Another window owns this saved question.');
              if (!host.answer(live.key, fresh.id, answer, true))
                throw new Error('The agent is no longer waiting for this answer.');
              return true;
            },
          );
          if (answeredNative) {
            updateAgentAffordance();
            return true;
          }
        } catch (error) {
          if (!activeWriterFailure(error)) throw error;
        }
        let began = false;
        const guard = new GuardedAttempt(randomUUID(), () => {
          eligible();
          recovery.begin(entry.identity, text, guard.clientUuid);
          began = true;
        });
        recoveryPrompts.set(prompt, guard);
        const delivered = await panel.onSendPrompt?.(entry.agent, entry.session, entry.cwd, prompt);
        recoveryPrompts.delete(prompt);
        if (began) {
          const receipt = guard.settled ?? (delivered?.delivered ? await guard.receipt : null);
          recovery.settle(
            entry.identity,
            receipt?.outcome === 'accepted' ? 'answered' : receipt?.outcome === 'refused' ? 'unresolved' : 'unknown',
            delivered?.session ?? entry.session,
          );
        }
        updateAgentAffordance();
        return Boolean(delivered?.delivered);
      } catch (error) {
        void vscode.window.showWarningMessage(`Arc: ${(error as Error).message}`);
        updateAgentAffordance();
        return false;
      }
    }
    const answered = host.answer(waiting.key, id, answer);
    reportAnswer(answered);
    return answered;
  };
  // Reader input makes observations of the session it directs stale before the provider sees it.
  // The wrapper never clears the block an unknown delivery left. The panel host's `onReaderDirected` port does.
  interveneOnReaderInput(panel, guardedSends);
  // The channel's send reaches the guarded mode of the wrapped `onSendPrompt`, which skips reader intervention.
  channel?.setGuardedReadHandler((request) => panel.guardedReadRequest(request));
  channel?.setGuardedSendHandler((request) =>
    Object.prototype.hasOwnProperty.call(request.params, 'observation')
      ? guardedChannelSend(
          guardedSends,
          request,
          (...args) => panel.onSendPrompt?.(...args) ?? Promise.resolve({}),
        ).finally(() => panel.flushAgentQueue(request.params.sessionId ?? ''))
      : (() => {
          const sessionId = request.params.sessionId ?? '';
          const source = panel.guardedTargetFacts(sessionId);
          const claude = host.find('claude', sessionId);
          const codex = host.find('codex', sessionId);
          const child = source?.current && !(claude && codex) ? (claude ?? codex) : null;
          return panel.sendAgentMessage(
            request,
            child
              ? agentMessageBinding(guardedSends, child, host, activeWriterFailure, randomUUID, (live, turnId) =>
                  compaction?.submitted(live, turnId, 'followup'),
                )
              : null,
          );
        })(),
  );
  updateAgentAffordance();
}

// Extract a nonempty path from the command's context object. Invalid arguments copy nothing.
function pathFrom(arg: unknown): string | null {
  const row = arg as { path?: string } | undefined;
  if (!row) {
    return null;
  }
  return typeof row.path === 'string' && row.path ? row.path : null;
}

// Extract a nonempty turn key from the command's context object.
function turnKeyFrom(arg: unknown): string | null {
  const key = (arg as { key?: string } | undefined)?.key;
  return typeof key === 'string' && key ? key : null;
}

function setTurnRead(panel: PanelProvider, arg: unknown, read: boolean): void {
  const key = turnKeyFrom(arg);
  if (!key) {
    return;
  }
  panel.setRead(key, read);
}

// Extract a nonempty session ID from the command's context object.
function sessionIdFrom(arg: unknown): string | null {
  const session = (arg as { session?: string } | undefined)?.session;
  return typeof session === 'string' && session ? session : null;
}

function setSessionRead(panel: PanelProvider, arg: unknown, read: boolean): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.setSessionRead(session, read);
}

function setSessionArchived(panel: PanelProvider, arg: unknown, archived: boolean): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.setSessionArchived(session, archived);
}

function setSessionPinned(panel: PanelProvider, arg: unknown, pinned: boolean): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.setSessionPinned(session, pinned);
}

function setSessionTurnsOpen(panel: PanelProvider, arg: unknown, open: boolean): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.setSessionTurnsOpen(session, open);
}

function copySessionId(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  void panel.copySessionId(session);
}

function showSessionDetails(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.showSessionDetails(session);
}

function copyTurnSummary(panel: PanelProvider, arg: unknown): void {
  const key = turnKeyFrom(arg);
  if (!key) {
    return;
  }
  void panel.copySummary(key);
}

// Open the comment editor for the named turn. The webview reads the selection and menu location.
function commentOnTurn(panel: PanelProvider, arg: unknown): void {
  const key = turnKeyFrom(arg);
  if (!key) {
    return;
  }
  panel.openComment(key);
}

// Read the turn key and session ID separately from the context object, without decoding the turn key.
function copyTurnComments(panel: PanelProvider, arg: unknown): void {
  const key = turnKeyFrom(arg);
  const session = sessionIdFrom(arg);
  if (!key || !session) {
    return;
  }
  void panel.copyComments(key, session);
}

function responseLinkContextFrom(arg: unknown): { link: string; session: string; key: string } | null {
  const context = arg as { link?: unknown; session?: unknown; key?: unknown } | undefined;
  return typeof context?.link === 'string' &&
    context.link &&
    typeof context.session === 'string' &&
    context.session &&
    typeof context.key === 'string' &&
    context.key
    ? { link: context.link, session: context.session, key: context.key }
    : null;
}

function sendResponseLink(panel: PanelProvider, arg: unknown, copyLabels: boolean): void {
  const context = responseLinkContextFrom(arg);
  if (!context) {
    void vscode.window.showInformationMessage('Arc: this link can no longer be sent.');
    return;
  }
  panel.handoffResponseLink(context.link, context.session, context.key, copyLabels);
}

function sendSelectedText(panel: PanelProvider, arg: unknown, copyLabels: boolean): void {
  const key = turnKeyFrom(arg);
  const session = sessionIdFrom(arg);
  if (!key || !session) {
    return;
  }
  panel.requestSelectedTextHandoff(session, key, copyLabels);
}

// Open a new draft with the named session's setup, folder, and labels.
function newSessionWithLabels(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.newSessionWithLabels(session);
}

// Open the webview's label editor for the named session.
function labelSession(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.openLabelEditor(session);
}

// Open the webview's rename editor for the named session.
function renameSession(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.openSessionRename(session);
}

// Extract a nonempty saved-view ID from the context object. All sessions has an empty ID and is not an editable saved view.
function viewIdFrom(arg: unknown): string | null {
  const view = (arg as { view?: string } | undefined)?.view;
  return typeof view === 'string' && view ? view : null;
}

// Open the saved-view editor with its ID and the requested rename or delete action.
function editView(panel: PanelProvider, arg: unknown, mode: 'rename' | 'delete'): void {
  const view = viewIdFrom(arg);
  if (!view) {
    return;
  }
  panel.openViewEditor(view, mode);
}

async function copyPath(arg: unknown, relative: boolean): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  // Citation filenames keep literal suffixes. Ordinary summary links remove line anchors before path resolution.
  const link = (arg as { link?: string } | undefined)?.link;
  const destination = (arg as { destination?: { kind?: unknown; path?: unknown } } | undefined)?.destination;
  const literal =
    destination?.kind === 'fileCitation' && typeof destination.path === 'string'
      ? nativeCitationPath(destination.path, process.platform)
      : null;
  const named = typeof link === 'string' ? linkTarget(link) : null;
  const target = pathFrom(arg) ?? literal ?? (named ? resolveLink(named, folders, fs.existsSync) : null);
  if (!target) {
    return;
  }
  // Convert either path form to native spelling. A file outside all workspace folders retains its absolute path when relative copying is requested.
  const text = nativePath(relative ? relativePath(target, folders) : target);
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(`Copied ${text}`, 2000);
}

async function copyLink(arg: unknown): Promise<void> {
  const link = (arg as { link?: unknown } | undefined)?.link;
  if (typeof link !== 'string' || !link) {
    return;
  }
  await vscode.env.clipboard.writeText(link);
}

export function deactivate(): Thenable<void> {
  const recording = usageRecorder?.dispose();
  return Promise.all([
    recording,
    snapshotSetup?.dispose(),
    windowChannel?.dispose(),
    usageWrites.drain(),
    sessionSettingsWrites.drain(),
  ]).then(() => undefined);
}
