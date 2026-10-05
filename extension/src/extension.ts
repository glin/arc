import { MEASUREMENT_ENVIRONMENT } from './identity';
import { askIdleDefaults } from './agenthost';
import { unavailableDefaults, type AppliedDefaults } from './view/model-picks';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  arcHome,
  cacheRoot,
  WorkspaceCachePartition,
  normalizedWorkspaceIdentity,
  storeRoot,
  sweepOldSessions,
} from './store';
import { SCHEME } from './uris';
import { relativePath, nativePath, linkTarget, resolveLink } from './transcript';
import { registerPanel, PanelProvider } from './panelhost';
import { readSetting } from './config';
import { STORED_STATE_KEYS } from './identity';
import { nodeGitRunner } from './gitcommits';
import { ProjectSetupStore, SetupProjects } from './projectsetups';
import { settingName } from './settings';
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
  spawnCli,
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

// What this panel calls itself to the Codex server, which echoes the name back inside the
// user agent it reports. One copy, because every child started here carries it: the one
// driving a session and the short-lived one started to be asked a question. The build sets
// `EXTENSION_VERSION` from the extension manifest.
declare const EXTENSION_VERSION: string;
const CLIENT_INFO = { name: 'arc', title: 'Arc', version: EXTENSION_VERSION };
const usageWrites = new UsageWriteQueue();
const sessionSettingsWrites = new UsageWriteQueue();
let usageRecorder: UsageRecorder | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationAt = performance.now();
  const root = storeRoot();
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const workspaceIdentity = normalizedWorkspaceIdentity(
    workspaceFolders,
    vscode.workspace.workspaceFile?.fsPath ?? null,
  );
  const workspaceCache = new WorkspaceCachePartition(cacheRoot(), workspaceIdentity);
  fs.mkdirSync(root, { recursive: true });

  // Read-only provider for baseline content. The URI's path mirrors the real file
  // (so the diff header shows the real filename, not the snapshot hash); the snapshot
  // file to read is carried in the `s` query param.
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

  // Read-only view of what each turn did, built from the session transcript.
  const panel = registerPanel(context, root, workspaceCache, activationAt);
  if (process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1' && process.env[MEASUREMENT_ENVIRONMENT.state])
    panel.openInEditor();

  // Dropping old snapshots stays off the activation path: it stats every session folder
  // under the root, and this event loop is shared by every extension in the host.
  // Activation only registers what the reader sees; the sweep runs once it has returned.
  const firstSweep = setTimeout(() => {
    try {
      sweepOldSessions(root);
    } catch {
      /* best-effort */
    }
  }, 0);
  context.subscriptions.push({ dispose: () => clearTimeout(firstSweep) });

  // The trigger file is bumped once per turn end, which is when the panel gains a row.
  // The panel also polls, so losing this costs a few seconds of latency, not a row.
  const onTrigger = () => {
    void panel.refresh();
  };
  context.subscriptions.push(watcher.onDidChange(onTrigger), watcher.onDidCreate(onTrigger));

  const reg = (id: string, fn: (...a: unknown[]) => void) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Copy a path, from a file row or from a link inside a summary. The panel hands over the
  // object it put in `data-vscode-context`, so one pair of commands serves both.
  reg('arc.copyPath', (arg) => void copyPath(arg, false));
  reg('arc.copyLink', (arg) => void copyLink(arg));
  reg('arc.sendResponseLinkWithLabels', (arg) => sendResponseLink(panel, arg, true));
  reg('arc.sendResponseLink', (arg) => sendResponseLink(panel, arg, false));
  reg('arc.sendSelectedTextWithLabels', (arg) => sendSelectedText(panel, arg, true));
  reg('arc.sendSelectedText', (arg) => sendSelectedText(panel, arg, false));
  reg('arc.newSessionWithLabels', (arg) => newSessionWithLabels(panel, arg));
  reg('arc.copyRelativePath', (arg) => void copyPath(arg, true));
  // Set a turn's read state, from the context menu over its card in the Timeline. Which
  // turns have been read is the webview's own, so these carry the turn back to it rather
  // than changing anything here.
  reg('arc.markTurnRead', (arg) => setTurnRead(panel, arg, true));
  reg('arc.markTurnUnread', (arg) => setTurnRead(panel, arg, false));
  // The same pair for a whole session, from the context menu over its rail card. Which
  // turns have been read and how far each session is marked are both the webview's own,
  // so these carry the session back to it and change nothing here.
  reg('arc.markSessionRead', (arg) => setSessionRead(panel, arg, true));
  reg('arc.markSessionUnread', (arg) => setSessionRead(panel, arg, false));
  // Archiving a session, from the context menu over its session heading. The heading
  // used to carry a cross of its own; the rail card's control is where archiving is done
  // now, and this is the way in for a reader below the rail's width. The hidden set is the
  // webview's, so these carry the session back to it.
  reg('arc.archiveSession', (arg) => setSessionArchived(panel, arg, true));
  reg('arc.unarchiveSession', (arg) => setSessionArchived(panel, arg, false));
  // Pinning a session, from the context menu over its session heading. The rail card's
  // own control is the other way in, and this answers a reader below the rail's width, where
  // no rail is drawn.
  reg('arc.pinSession', (arg) => setSessionPinned(panel, arg, true));
  reg('arc.unpinSession', (arg) => setSessionPinned(panel, arg, false));
  reg('arc.copySessionId', (arg) => copySessionId(panel, arg));
  reg('arc.showSessionDetails', (arg) => showSessionDetails(panel, arg));
  reg('arc.hideComposer', () => panel.setComposerHidden(true));
  reg('arc.showComposer', () => panel.setComposerHidden(false));
  // Copy what a turn closed with, from the same menu over the same card. The summary is the
  // markdown the panel rendered, so the copy is read here rather than off the screen.
  reg('arc.copyTurnSummary', (arg) => copyTurnSummary(panel, arg));
  reg('arc.commentOnTurn', (arg) => commentOnTurn(panel, arg));
  // The labels on one session, from the context menu over its rail card or its session
  // heading. The record lives on this side, and the panel draws the editor, so this says only
  // which session the menu was drawn over.
  reg('arc.labelSession', (arg) => labelSession(panel, arg));
  // Rename one session, from the context menu over its rail row. The panel draws the editor,
  // so this says only which session the menu was drawn over.
  reg('arc.renameSession', (arg) => renameSession(panel, arg));
  // Rename or delete the saved view the rail's views row is showing. The list lives on this
  // side and the panel draws the editor, so each of these says only which view the menu was
  // drawn over and which press it was.
  reg('arc.renameView', (arg) => editView(panel, arg, 'rename'));
  reg('arc.deleteView', (arg) => editView(panel, arg, 'delete'));
  // The comments the reader left on one turn, as markdown, on the clipboard. Offered over the
  // card they were left on, which is where a reader who has just written one goes looking for
  // the way to send it.
  reg('arc.copyTurnComments', (arg) => copyTurnComments(panel, arg));
  // Back and forward over the sessions the reader has opened. The panel's own trail
  // answers first, and the editor's Go Back answers when that trail runs out.
  reg('arc.goBack', () => panel.goBack());
  reg('arc.goForward', () => panel.goForward());
  // Driving the agents, rather than only reading what they did.
  //
  // Everything below is wiring: which session a prompt goes to, what the reader is
  // shown, and what their answer means are all decided in `composerview.ts`, which the
  // tests can reach. This file starts the child, opens the boxes and reports failures.
  // What each agent last said about the reader's own rate limits. Fed three ways, cheapest
  // first: the events both CLIs volunteer mid-turn, which cost nothing at all; one request
  // at the end of each turn, while a child is alive; and a child started to be asked and
  // closed again, for a panel nobody is running a turn for. None of the three costs model
  // tokens, which is what lets the panel show a live figure rather than an estimate.
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
  const usageReads = new UsageReadQueue();
  // What models each agent says it will run, read off the same children and kept far
  // longer, because a list turns over on a release rather than on a turn.
  const models = new ModelBook();
  // What MCP servers each draft or recorded session last reported. Kept with no window on it, unlike the
  // model list above: a server list turns over the moment a server falls down, so the only
  // reading worth holding is the newest one, and it is taken again after every press that
  // could have moved it.
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
  // The way out of everything the panel remembers. Usage lives outside the webview state,
  // so this command clears it after the panel clears its own state.
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

  // A catalog event changes only the session's retained command list. Its explicit payload
  // already carries that complete list, so the following state callback has no panel work.
  const commandStateChanges = new Set<string>();
  const host = new AgentHost({
    idleDurationMs: readSetting('agentIdleMinutes') * 60_000,
    onEvent: ({ key, event, turnId }) => {
      if (event.kind === 'activity') {
        const where = host.get(key)?.state().sessionId;
        if (where) {
          panel.noteActivity(where, event.activity);
        }
        return;
      }
      // A chunk of the reply goes to the live card and stops there. Everything below is work
      // a turn does a handful of times, and this arrives many times a second: a chunk starts
      // no turn, ends none, and changes nothing the transcript holds. Named by the
      // session the child is in, so the words land on the card that is waiting for them
      // rather than on whichever session the reader is looking at.
      if (event.kind === 'delta') {
        const where = host.get(key)?.state().sessionId;
        if (where) {
          panel.noteReply(where, event.text, turnId);
        }
        return;
      }
      if (event.kind === 'text') {
        const where = host.get(key)?.state().sessionId;
        if (where) panel.noteCompletedReply(where, event.text, event.sourceId, turnId);
        return;
      }
      const agent = host.get(key)?.agent;
      if (event.kind === 'turnEnd') {
        const where = host.get(key)?.state().sessionId;
        if (where) panel.noteResponseEnded(where, event.outcome, turnId);
      }
      if (event.kind === 'commands') {
        commandStateChanges.add(key);
        if (agent) {
          publishCommands({ agent, commands: event.commands, complete: true });
        }
        return;
      }
      // A child saying it is ready is the first moment its servers can be asked about, and
      // the answer decides whether the composer draws a control for them at all. So it is
      // asked here rather than when the reader reaches for the control, which would be a
      // control that is not on the row until after it has been pressed.
      if (event.kind === 'ready' && ![...draftMcpKeys.values()].includes(key)) {
        void readMcpFrom(key);
      }
      if (agent && event.kind === 'rateLimit') {
        usage.noteLimit(agent, event.limit, Date.now(), event.creditResetsAtSeconds);
        publishUsage();
      }
      // The end of a turn is the one moment a child is certainly alive and certainly not
      // busy, so it is where the free figures are topped up with a full reading.
      if (['turnEnd', 'session', 'ready'].includes(event.kind)) {
        const affected = host.get(key)?.state().sessionId;
        if (affected) panel.invalidateContext(affected);
        if (event.kind === 'session' && event.previous && event.previous !== affected)
          panel.invalidateContext(event.previous);
      }
      if (event.kind === 'turnEnd') {
        const housekeeping = host.beginHousekeeping(key);
        const usageRead = agent
          ? (usageReads.resumeDeferred(agent, () => readFrom(key, true)) ?? readFrom(key, false))
          : Promise.resolve();
        void Promise.allSettled([usageRead, readMcpFrom(key)]).then(() => host.settled(housekeeping));
      }
      // A complete command catalog from one child replaces older catalogs from sibling
      // children of that agent. Catalogs from other agents remain available.
      if (agent && event.kind === 'ready') {
        publishCommands({ agent, commands: event.commands, complete: false });
      }
      // Claude's skill list, from the `init` message its session sent after taking a first
      // prompt. Filed under the session's own working directory and persisted, so a
      // worktree session reports its own project skills, and a session that has not sent its
      // own list yet still draws the highlight an earlier session in that directory
      // established. Skipped when the reported list matches what is already stored, so a
      // session that says nothing new writes no state and posts no payload.
      if (event.kind === 'skills') {
        const cwd = host.get(key)?.cwd;
        const directory = cwd ? normalizeWorkspace(cwd) : null;
        if (directory && !sameSkillList(skillLists[directory], event.skills)) {
          skillLists = withDirectorySkills(skillLists, directory, event.skills);
          void context.workspaceState.update(SKILLS_KEY, skillLists);
          panel.setSkills(skillLists);
        }
      }
      // The servers are read again there too, and this is what makes the control worth
      // having. Nothing is pushed when a server falls over, so a list taken once when the
      // child came up says `connected` about a server that died an hour ago, and the reader
      // finds out from a turn that could not do what it was asked. Read at the end of every
      // turn instead, the answer is at most one turn old whenever they look, and a server
      // that was still starting when the child came up has stopped being drawn as pending.
      // It costs one control request per turn, which buys nothing else and no model tokens.
      // What the composer draws depends on whether a turn is in flight, and a queued prompt
      // waits for exactly this moment. Told after every event, because a turn can end
      // through any of them.
      // Named by the session each child is in rather than by the agent behind it. A
      // child that has not been told its session yet names none: the panel cannot say
      // which of an agent's sessions it is, and guessing would draw Stop over the wrong
      // one, which is the fault this replaced.
      panel.setRunning(
        host
          .states()
          .filter((one) => one.busy && !one.exited && one.sessionId)
          .map((one) => runningKey(one.agent, one.sessionId ?? '')),
      );
      // Named by the session the child is in, so a queue drains the moment its own turn
      // ends rather than waiting for the reader to look back at it.
      // The child kept its process and moved to a new session. `/clear` is what does
      // this: the transcript it was writing stays on disk, and everything after this moment
      // is written somewhere else. The panel has to move with it or it watches a file nobody
      // writes to again, and the next prompt matches no child and starts a second one on the
      // session the reader had just cleared.
      //
      // The successor id is read here rather than from the reset message the CLI sends first.
      // That message carries a session id of its own which is not the id the transcript
      // is named after, so following it would point the panel at a file that never exists.
      if (event.kind === 'session' && event.previous && event.previous !== event.sessionId) {
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
          // A turn with no turn in it is a command the agent ran by itself. This explicit
          // local-answer exit removes its pending card and shows its reply.
          if (event.outcome.turns === 0) {
            const clearFailure =
              event.outcome.status === 'ok'
                ? null
                : failedClearDelivery(agent ?? '', new Error(event.outcome.text)).reason;
            panel.noteLocalAnswer(ended, clearFailure, event.outcome.text);
          }
          panel.releaseDeliveredPromptAssets(ended, turnEndCompletesEveryPrompt(agent ?? ''), turnId);
          panel.flushQueue(ended);
        }
      }
      void panel.refresh();
    },
    onStateChange: (state) => {
      if (commandStateChanges.delete(state.key)) {
        return;
      }
      updateAgentAffordance();
      panel.setRunning(
        host
          .states()
          .filter((one) => one.busy && !one.exited && one.sessionId)
          .map((one) => runningKey(one.agent, one.sessionId ?? '')),
      );
      panel.setExited(
        host
          .states()
          .filter((one) => one.exited && one.sessionId)
          .map((one) => runningKey(one.agent, one.sessionId ?? '')),
      );
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
    },
  });
  panel.onArchivedSessionsChange = (sessions) => host.setArchived(sessions);
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
    const waiting = host.waiting();
    panel.setAsks(
      waiting.flatMap((entry) => {
        const session = host.get(entry.key)?.state().sessionId;
        return session ? [{ session, ask: entry.ask }] : [];
      }),
    );
  };

  const workspaceCwd = (): string | null => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  // What the launch rule needs to know about this machine. `process.execPath` in the
  // extension host is VS Code's own binary, which runs as Node once `ELECTRON_RUN_AS_NODE`
  // is set; `spawnCli` sets it.
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

  // Permission mode keeps an agent-wide launch default and an accepted value per session.
  // Model and effort choices name one session and must not alter a sibling.
  const ASK_MODE_KEY = STORED_STATE_KEYS.askModes;
  // Retained for the palette command until recent launch profiles replace it. A visible
  // session never writes these keys.
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
  // The stored permission value: the empty value for an explicit agent default, or undefined
  // when nothing stored names a permission.
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

  // Everything the composer draws about each session's next-turn settings. The model
  // catalogs remain per agent and travel through `setModels` instead.
  const publishPicks = () => {
    panel.setAskLevels(stored(ASK_MODE_KEY));
    panel.setModels(
      models.lists(),
      USAGE_AGENT_ORDER.filter((agent) => models.pending(agent)),
    );
    panel.setPicks(settingBook());
  };
  panel.onSessionSettingsAdopted = (session, settings) => {
    void persistSessionSettings(session, settings);
    publishPicks();
  };
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
  // The last-seen Claude skill list for each working directory, persisted so a session that
  // has not yet sent its own list draws the same highlight an earlier session in that
  // directory already established. Loaded once at activation, then replaced for one
  // directory whenever a session's own `init` message names one.
  let skillLists: Record<string, readonly string[]> =
    context.workspaceState.get<Record<string, readonly string[]>>(SKILLS_KEY) ?? {};
  panel.setSkills(skillLists);
  // Which agents have been asked at all, which is not the same as which answered. An agent
  // that publishes none, and one that could not be started, are both asked once and then left
  // alone: without this the panel would start a child for them on every look.
  const commandsAsked = new Set<string>();
  const publishCommands = (said?: CommandCatalogUpdate, expectedRevision?: number) => {
    const next = commandLists.publish(host.states(), said, expectedRevision);
    if (next) {
      panel.setCommands(next);
    }
  };

  // An explicit permission pick reaches every live child because it changes the agent configuration.
  // Removing Arc's override retires those children before the stored default becomes visible.
  // Store each accepted value so a retired session resumes with the same configuration.
  const setAskModeFor = async (agent: AgentName, mode: AskMode, session?: string): Promise<void> => {
    const liveTargets = host.states().filter((state) => state.agent === agent && !state.exited);
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
    // `modelChange` owns the level, the send and the stored fields. It runs after the model
    // answers, because the reader can pick a level while that request is in flight and the
    // later pick is the one that counts.
    //
    // Claude confirms a live model request on the control channel. Store the choice only
    // after that answer, so a refusal leaves the last confirmed value on screen.
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

  // A press on the servers control, which is not the same kind of press as the three beside
  // it.
  //
  // Composer settings are stored by the panel, whether under an agent or a session. A
  // server is not. It is switched on the children that are alive, and there is nothing to
  // keep here because a later child reads the agent's own configuration and reports whatever
  // it finds there. A pick recorded here would duplicate state the agent already owns.
  //
  // Every live child of the agent hears it, on the same rule the ask mode follows. The servers
  // belong to the agent rather than to one session, so a server switched off in the
  // session on screen and left on in the one behind it would be two answers to a
  // question the reader asked once.
  //
  // The reading is taken again at the end rather than worked out. A toggle comes back with an
  // empty body and a reconnect says only that it was tried, so what the servers are now is
  // knowable only by asking, and a control that drew what the press asked for would say
  // connected over a server that never came back.
  const setMcpFor = async (agent: AgentName, owner: string, cwd: string | null, value: string): Promise<void> => {
    // Which servers the press was about, worked out before anything is started, because it
    // decides whether a child is needed at all.
    //
    // Which way a toggle is asking is decided in `mcpview.ts` off the same list the row was
    // drawn from, so the direction is the one the reader saw rather than one read back a
    // moment later. A server that has gone from that list since is sent nothing at all: there
    // is no state to set it to, and the row the reader pressed is already off screen.
    //
    // A reconnect asks for every server the last reading called failed, picked out by the same
    // rule that draws the rows. Which state counts as broken is the agent's word and a
    // decision with it, and this file is the one place a decision cannot be tested, so it is
    // asked of `mcpview.ts` rather than spelled again here.
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

    // What would not answer, gathered rather than thrown at the first one. The reader pressed
    // one control that stands for several servers, and a server that will not come back must
    // not take the ones that would with it: half of them mended and a message naming the rest
    // is worth more than the first failure stopping the work.
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
      // Nothing is running, and the press still has to work. `McpBook` is never emptied, on
      // purpose: which servers this folder has is worth showing whether or not a child happens
      // to be up, and the panel now counts them as it comes into view, so the control is on
      // the row before any session exists. A press that answered "send it a prompt first"
      // would be a control that draws itself and then refuses.
      //
      // The change is made on a child of its own and outlives it, because the CLI writes the
      // setting out as it shuts down. `askIdleMcpChange` carries the measurement.
      const plan = cwd ? idlePlanFor(agent, cwd) : null;
      if (!plan) {
        const named = agentChoices().find((choice) => choice.agent === agent)?.label ?? agent;
        throw new Error(`${named} cannot be started in this folder, so its servers cannot be changed.`);
      }
      const generation = mcpSurfaceGeneration;
      const done = await askIdleMcpChange(plan, spawnCli, changes);
      if (done.servers && noteMcp(owner, done.servers, revision, generation)) {
        publishMcp();
      }
      failures.push(...done.failures);
      // Said before the per-server list below, and on its own, because it answers a different
      // question. A refusal means nothing was asked at all, and a press that changed nothing
      // and said nothing is the one outcome this file refuses everywhere else.
      if (done.refusal) {
        const named = agentChoices().find((choice) => choice.agent === agent)?.label ?? agent;
        throw new Error(`${named} could not be started, so its servers were not changed. ${done.refusal}`);
      }
    }
    // One line per server, however many children the same server failed on. The reader has
    // one server on screen and would read the same name twice as two separate faults.
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
        ? claudeLaunch(readSetting('claudePath'), thisMachine())
        : codexLaunch(readSetting('codexPath'), thisMachine());
    if (launch.problem) {
      return null;
    }
    return agent === 'claude' ? claudeIdlePlan(launch, cwd) : codexIdlePlan(launch, { cwd, clientInfo: CLIENT_INFO });
  };

  let defaultsRevision = 0;
  const defaultRequests = new Map<string, Promise<AppliedDefaults>>();
  const defaultWatchers = new Map<string, vscode.Disposable[]>();
  let defaultsDisposed = false;
  const releaseDefaultWatchers = () => {
    for (const disposables of defaultWatchers.values()) for (const disposable of disposables) disposable.dispose();
    defaultWatchers.clear();
  };
  panel.onWatchDefaults = (cwds) => {
    if (defaultsDisposed) return;
    const roots = new Set(cwds.map((cwd) => path.resolve(cwd)));
    for (const key of defaultRequests.keys()) {
      const [, cwd] = JSON.parse(key) as string[];
      if (!roots.has(path.resolve(cwd))) defaultRequests.delete(key);
    }
    const folders = new Set<string>();
    for (const cwd of cwds) {
      let folder = path.resolve(cwd);
      for (;;) {
        folders.add(folder);
        const parent = path.dirname(folder);
        if (parent === folder) break;
        folder = parent;
      }
    }
    for (const [folder, disposables] of defaultWatchers) {
      if (!folders.has(folder)) {
        for (const disposable of disposables) disposable.dispose();
        defaultWatchers.delete(folder);
      }
    }
    for (const folder of folders) {
      if (defaultWatchers.has(folder)) continue;
      const disposables: vscode.Disposable[] = [];
      for (const pattern of ['.claude/settings*.json', '.codex/config.toml']) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
        disposables.push(
          watcher,
          watcher.onDidChange(invalidateDefaults),
          watcher.onDidCreate(invalidateDefaults),
          watcher.onDidDelete(invalidateDefaults),
        );
      }
      defaultWatchers.set(folder, disposables);
    }
  };
  context.subscriptions.push({
    dispose() {
      defaultsDisposed = true;
      defaultsRevision++;
      defaultRequests.clear();
      releaseDefaultWatchers();
      panel.onWatchDefaults = null;
    },
  });
  panel.onReadDefaults = (agent, cwd, model) => {
    const revision = defaultsRevision;
    const catalog = models.get(agent)?.models ?? [];
    const concrete = catalog.find((item) => item.value === model)?.resolvedModel || model;
    const key = JSON.stringify([agent, cwd, concrete, revision]);
    let request = defaultRequests.get(key);
    if (!request) {
      const launch =
        agent === 'claude'
          ? claudeLaunch(readSetting('claudePath'), thisMachine())
          : codexLaunch(readSetting('codexPath'), thisMachine());
      const plan =
        agent === 'claude'
          ? claudeIdlePlan(launch, cwd, model)
          : codexIdlePlan(launch, { cwd, model, clientInfo: CLIENT_INFO });
      request = launch.problem
        ? Promise.resolve(unavailableDefaults('The agent could not report its settings.'))
        : askIdleDefaults(plan, spawnCli);
      defaultRequests.set(key, request);
    }
    void request.then((defaults) => {
      if (!defaultsDisposed && revision === defaultsRevision && defaultRequests.get(key) === request)
        panel.setAppliedDefaults(agent, cwd, model, defaults);
    });
  };
  const invalidateDefaults = () => {
    defaultsRevision++;
    defaultRequests.clear();
    panel.clearAppliedDefaults();
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

  // One session's own agent, asked while its child is alive. Costs no model tokens, so
  // it runs at the end of every turn.
  //
  // A failure is kept rather than shown. The bar already says how old its figure is, and an
  // error box over a percentage the reader did not ask for would interrupt them at the one
  // moment they are reading what the turn did.
  const readFrom = async (key: string, force: boolean): Promise<void> => {
    await host.withActivity(key, async (session) => {
      let usageFailure = '';
      try {
        const reading = await session.rateLimits(force);
        if (reading) {
          usage.note(session.agent, reading);
          publishUsage();
        }
      } catch (error) {
        usage.noteSilent(session.agent);
        usageFailure = (error as Error).message;
      }
      // The reader's own press carries through to here. `noteSilent` is kept for the life of
      // the window, so a read that asked with `false` after one early failure would refuse
      // the model list for ever and leave the picker empty with no way to fill it.
      if (models.toAsk([session.agent], Date.now(), force).length > 0) {
        try {
          const list = await session.models();
          if (list) {
            models.note(session.agent, list);
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
      if (force && usageFailure) {
        throw new Error(`${session.agent} usage refresh failed: ${usageFailure}`);
      }
    });
  };

  // What one agent's MCP servers are doing, asked of a child of that agent.
  //
  // Asked through a fresh request every time, and never read off anything the session settled
  // while it was starting. A child reports itself ready from inside the call that opens it, so
  // at the moment this first runs the session is still part way through that call and the
  // fields it assigns there are not all in place. A request is not affected by that.
  //
  // An agent that answers with nothing is not written down at all. Nothing means the agent has
  // no way to be asked, which is a different thing from an agent with no servers configured,
  // and an empty list noted here would turn the first into the second. With no entry, the
  // composer is handed an empty list and draws no control, which is what an agent that does
  // not do MCP should look like.
  //
  // A failure is kept rather than shown, on the same rule the figures above follow. Nobody
  // asked for this reading, it happens while the reader is starting a session, and an
  // error box over a control they have not opened would interrupt them for nothing. Whatever
  // the book already holds stays: an agent that would not answer this time has not said its
  // servers have gone.
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
        // Kept, for the reason above.
      }
    });
  };

  // The same reading taken off a child of its own, for an agent this window is not driving.
  //
  // It is a second short-lived process rather than one more answer on the child `askIdle`
  // already starts, and that is the point. The CLI replies to `mcp_status` only once it has
  // tried every server, and a server that is down is one it waits out, so an idle read that
  // gathered the servers with the rest would hold the models, the commands and the figures
  // behind the slowest server on the machine. Asked separately, nothing waits on it.
  //
  // Failure is silence, the way `readMcpFrom` above is silent and for the same reason: the
  // reader did not ask, and an agent that would not answer has not said its servers are gone.
  const readIdleMcp = async (
    agent: AgentName,
    cwd: string,
    owner: string,
    revision: number,
    generation: number,
  ): Promise<boolean> => {
    const plan = idlePlanFor(agent, cwd);
    if (!plan) {
      return false;
    }
    const servers = await askIdleMcp(plan, spawnCli);
    if (!servers) {
      return false;
    }
    const accepted = noteMcp(owner, servers, revision, generation);
    if (accepted) {
      publishMcp();
    }
    return accepted;
  };

  // Read one agent's figures and model list again: from a live child where there is one,
  // and from a child started to be asked and closed where there is not. `force` is the
  // reader asking outright, which asks whatever the age of what is on screen; everything
  // else asks only for what has gone stale, because the panel coming back into view and a
  // turn finishing are both common and a process start is not free even when the answer is.
  const askAgent = (agent: AgentName, force: boolean, mcpOwner?: string, mcpCwd?: string): Promise<void> => {
    const requestedMcpRevision = mcpOwner ? mcp.revision(mcpOwner) : 0;
    const requestedMcpGeneration = mcpSurfaceGeneration;
    const requestOwner = mcpOwner ? `${mcpOwner}:${requestedMcpRevision}` : '';
    return usageReads.run(
      agent,
      force,
      async (force) => {
        const cwd = mcpCwd ?? workspaceCwd();
        if (!cwd) {
          return;
        }
        const now = Date.now();
        // Both are asked, and neither is skipped. `toAsk` clears the agent's silent mark when
        // the reader asks outright, so the two calls have to happen whatever the first one
        // answers: written as one `||` expression, a usage read that wants asking short
        // circuits the model book and leaves it marked silent for the life of the window.
        const wantUsage = usage.toAsk([agent], now, force).length > 0;
        const wantModels = models.toAsk([agent], now, force).length > 0;
        // The command list is a reason to ask in its own right, and the composer is unusable
        // without it: the menu it opens on a slash has nothing to offer until some child has
        // answered the handshake, and until the reader sends a prompt no child ever does. Asked
        // once per agent per window, because a list turns over on a release rather than on a
        // turn and the answer costs a process start.
        const wantCommands = !commandsAsked.has(agent);
        // The servers are a reason of their own. The composer draws no control until a child
        // counts them. No child starts until the reader sends a prompt. A missing answer is
        // retried on the next view. A request in flight prevents a duplicate process.
        const live = host.states().filter((s) => s.agent === agent && !s.exited);
        const mcpTarget = liveMcpTarget(live, mcpOwner, draftMcpKeys);
        const mcpLive = mcpTarget?.state;
        const resolvedMcpOwner = mcpOwner ?? mcpTarget?.owner;
        const wantMcp = Boolean(resolvedMcpOwner && mcp.needsInitialRead(resolvedMcpOwner));
        if (!wantUsage && !wantModels && !wantCommands && !wantMcp) {
          return;
        }
        // A turn already in flight is feeding the bar for free, through the events both CLIs
        // volunteer mid-turn. An automatic read can stop there; an explicit one is remembered
        // and runs when the turn ends.
        if (mcpOwner ? mcpLive?.busy : live.some((s) => s.busy)) {
          const waiting = usageReads.waitUntilIdle(agent, force);
          if (waiting) {
            await waiting;
          }
          return;
        }
        let refreshFailure: Error | null = null;
        let initialMcpRevision: number | null = null;
        try {
          if (live[0]) {
            // A child of this agent is already up, and it answered the handshake when it
            // started, so its command list is on it and needs no second process. Its MCP
            // status still needs a request. A missing answer keeps the initial gate open.
            publishCommands();
            commandsAsked.add(agent);
            if (wantMcp && resolvedMcpOwner) {
              if (mcpLive) {
                await readMcpFrom(mcpLive.key, resolvedMcpOwner);
              } else {
                const revision = mcp.beginInitialRead(resolvedMcpOwner, requestedMcpRevision);
                if (revision !== null) {
                  void readIdleMcp(agent, mcpCwd ?? cwd, resolvedMcpOwner, revision, requestedMcpGeneration).then(
                    (answered) => mcp.finishInitialRead(resolvedMcpOwner, revision, answered),
                  );
                }
              }
            }
            const idleLive = mcpLive ?? live.find((state) => !state.busy);
            if (idleLive) {
              await readFrom(idleLive.key, force);
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
          const plan = idlePlanFor(agent, cwd);
          if (!plan) {
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
          const answers = await askIdle(plan, spawnCli);
          // Before the other two, because this is the one the composer cannot draw without and
          // the child that answered it has already been closed.
          commandsAsked.add(agent);
          publishCommands({ agent, commands: answers.commands, complete: false }, commandRevision);
          if (answers.usage) {
            usage.note(agent, answers.usage);
            publishUsage();
          } else usage.noteSilent(agent);
          if (answers.models) {
            models.note(agent, answers.models);
            publishPicks();
          } else {
            models.noteSilent(agent);
            publishPicks();
          }
          if (force && answers.usageFailure) {
            refreshFailure = new Error(`${agent} usage refresh failed: ${answers.usageFailure}`);
          }
          // Asked for behind all of the above, and awaited by none of it. See `readIdleMcp`
          // for why the servers are not one more answer on the child that just closed.
          if (resolvedMcpOwner && initialMcpRevision !== null) {
            const revision = initialMcpRevision;
            void readIdleMcp(agent, mcpCwd ?? cwd, resolvedMcpOwner, revision, requestedMcpGeneration).then(
              (answered) => mcp.finishInitialRead(resolvedMcpOwner, revision, answered),
            );
          }
        } catch (error) {
          // An agent that is not installed, or one not logged in. Marked silent so the panel
          // does not pay a failed process start every time it comes back into view; the
          // reader asking outright clears that and tries again.
          commandsAsked.add(agent);
          if (resolvedMcpOwner && initialMcpRevision !== null) {
            mcp.noteSilent(resolvedMcpOwner, initialMcpRevision);
          }
          usage.noteSilent(agent);
          models.noteSilent(agent);
          publishPicks();
          if (force) {
            refreshFailure = error as Error;
          }
        }
        if (refreshFailure) {
          throw refreshFailure;
        }
      },
      requestOwner,
    );
  };

  const refreshUsage = (
    only: string | null,
    force: boolean,
    mcpOwner?: string,
    mcpAgent?: string,
    mcpCwd?: string,
  ): void => {
    for (const agent of only ? [only] : USAGE_AGENT_ORDER) {
      const ownsMcp = only === agent || (!only && mcpAgent === agent);
      const read = () =>
        askAgent(agent as AgentName, force, ownsMcp ? mcpOwner : undefined, ownsMcp ? mcpCwd : undefined);
      if (force) {
        reportFailures(read);
      } else {
        void read();
      }
    }
  };

  // The reader pressing the bar asks whatever the age of what is on screen. The panel
  // coming back into view does not, and neither does a turn finishing: a burst of turns
  // arrives as several parses, and the floor in `UsageBook.toAsk` is what keeps that from
  // becoming a process start apiece.
  // The composer's own send, which is the panel's rather than the palette's: the reader has
  // already typed the prompt and chosen nothing else, so no box is opened over them.
  // It answers, rather than going through `reportFailures`, because the panel takes the
  // comments the prompt carried away the moment it hears that the prompt went. The named
  // existing-session operation
  // ends at three ordinary refusals, and every one of them has already told the reader why.
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
  panel.onSendPrompt = async (agent, sessionId, cwd, prompt, onSubmitted) => {
    try {
      const turnId = await withExistingSessionActivity(agent as AgentName, sessionId, cwd, async (session) => {
        validateResolvedPromptAssets(prompt.assets);
        // Do not let the composer discard its text until the child accepts the turn.
        // The returned promise still reports a protocol refusal to the retained card.
        return await session.prompt(prompt, (turnId) => onSubmitted?.(session.state().sessionId ?? sessionId, turnId));
      });
      if (turnId === null) {
        return failedPromptDelivery(agent, new Error('no agent session could be opened'));
      }
      void panel.refresh();
      return { delivered: true, reason: '', turnId };
    } catch (error) {
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
              (live) => live.prompt(prompt, (turnId) => onSubmitted?.(continued, turnId)),
              existingSessionPlan('codex', continued, cwd!),
            );
            void panel.refresh();
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
  // Compaction is a control on the live session, separate from prompt submission.
  // Codex maps it to `thread/compact/start`; Claude maps it to the command its stream
  // protocol publishes. Keeping this callback text-free prevents a slash command from
  // reaching Codex as model input or carrying the reader's comments with it.
  panel.onCompact = async (agent, session, cwd) => {
    try {
      const turnId = await withExistingSessionActivity(agent as AgentName, session, cwd, (session) =>
        session.compact(),
      );
      if (turnId === null) {
        return { delivered: false, reason: 'No agent session could be opened for compaction.' };
      }
      void panel.refresh();
      return { delivered: true, reason: '', turnId };
    } catch (error) {
      // The card and the editor notice say the same thing, once, in the words the composer
      // owns. Composing a second sentence here is what stacked the restatements: the notice
      // read back the session's wrapper and the card added a prefix on top of it.
      const delivery = failedCompactionDelivery(agent, error);
      void vscode.window.showErrorMessage(`Arc: ${delivery.reason}`);
      return delivery;
    }
  };
  panel.onClear = async (agent, session, cwd, name) => {
    try {
      const result = await withExistingSessionActivity(agent as AgentName, session, cwd, async (live) => ({
        turnId: await live.clear(name),
        session: live.state().sessionId,
      }));
      if (!result || !result.session) {
        return { delivered: false, reason: 'No agent session could be opened for clearing.' };
      }
      void panel.refresh();
      return { delivered: true, reason: '', turnId: result.turnId, session: result.session };
    } catch (error) {
      const delivery = failedClearDelivery(agent, error);
      void vscode.window.showErrorMessage(`Arc: ${delivery.reason}`);
      return delivery;
    }
  };
  const acceptedDrafts = new Set<string>();
  panel.onSendDraftPrompt = async (draft, prompt, onSubmitted) => {
    const acceptedProject = setupProjects.resolve(draft.cwd);
    try {
      const liveSession = await startFreshSession(draft);
      validateResolvedPromptAssets(prompt.assets);
      const turnId = await withStartedSessionActivity(
        liveSession,
        async (live) => {
          const turnId = await live.prompt(prompt, (turnId) => onSubmitted?.(live.state().sessionId ?? '', turnId));
          acceptedDrafts.add(live.key);
          return turnId;
        },
        resumePlanForDraft(draft, () => liveSession.state().sessionId),
      );
      host.cancelSessionRetirement(liveSession.key);
      draftMcpKeys.delete(draft.draftId);
      mcpRefreshes.cancel(draft.draftId);
      const sessionId = liveSession.state().sessionId;
      if (!sessionId) {
        return failedPromptDelivery(draft.profile.agent, new Error('the agent did not name its new session'));
      }
      const project = await acceptedProject;
      const entry = await setupStore.accept(project, draft.profile);
      if (project === panel.setupProject) panel.setRecentProfiles(entry.recents);
      void panel.refresh();
      return { delivered: true, reason: '', session: sessionId, turnId };
    } catch (error) {
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

  // One press, already decided. The panel draws each of the three menus itself, from what
  // travelled with the last render, so nothing is asked for here and nothing is fetched: the
  // value that arrives is the one the reader chose.
  //
  // A value the agent no longer offers is dropped rather than stored, by the same rule the
  // stored picks are read back through. An ask mode falls back to the agent's own default, a
  // model or an effort level to no pick at all, which is the agent's default too.
  // A command the panel answered by opening one of its own controls. The control is already
  // on screen; this fills it.
  //
  // The servers are read here rather than with the figures on the idle child, because the CLI
  // answers `mcp_status` only once it has tried every server and a server that is down is one
  // it waits out. A reader who typed `/mcp` asked for that wait. A panel merely coming into
  // view did not.
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
  // The servers start empty for every agent, so the composer draws no control for them until
  // an answer has come back. `readIdleMcp` asks for one as the panel comes into view, so the
  // gap is a process start rather than a whole session. Until it closes, an agent nobody
  // has asked and an agent with nothing configured look the same on the row, which is the
  // honest answer to both.
  publishMcp();

  // The session this window drives, started or resumed on first use. Any failure is
  // shown once, here, so no caller has to repeat the message.
  // Every composer command runs through this, so a failure anywhere in one reaches the
  // reader as a message rather than as nothing happening. Starting a child can throw
  // outright, not only reject: on Windows a batch shim given arguments throws before the
  // process exists, and without this the command would do nothing at all and say nothing.
  const reportFailures = (work: () => Promise<void>) =>
    void work().catch((error: Error) => {
      void vscode.window.showErrorMessage(`Arc: ${error.message}`);
    });

  // The four operations are named because resuming, continuing the workspace, forking, and
  // starting empty carry different identity rules. A boolean here once made a fresh path
  // capable of reading a saved resume id.
  let forkSequence = 0;
  const launchFor = (which: AgentName) =>
    which === 'claude'
      ? claudeLaunch(readSetting('claudePath'), thisMachine())
      : codexLaunch(readSetting('codexPath'), thisMachine());
  const ensureSession = async (key: string, plan: AgentPlanSource) => {
    const session = await host.session(key, plan);
    const failure = session.state().lastError;
    if (failure && session.state().exited) {
      throw new Error(failure);
    }
    return session;
  };
  // A session with a running child renames through that child. Any other session starts a
  // rename-only child that runs no model turn and closes. The Claude child resumes the
  // session, and Claude Code finds its transcript by the folder the session ran in.
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
            title,
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
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            model,
            effort,
          })
        : codexPlan(launch, {
            cwd,
            resume: session,
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
              ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
              model,
              effort,
            })
          : codexPlan(launch, {
              cwd,
              resume: session,
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
    // A source with no stored permission gives a fork with none. The empty value would be a
    // pick of the Codex default, and the fork's new-session picker would offer it.
    if (picked === undefined) {
      delete settings.permissionMode;
    }
    const session = await ensureSession(
      `codex:fork:${sessionId}:${++forkSequence}`,
      codexPlan(launch, {
        cwd,
        fork: sessionId,
        clientInfo: CLIENT_INFO,
        ...(mode ? codexAskMode(mode) : {}),
        model,
        effort,
      }),
    );
    const continued = session.state().sessionId;
    if (!continued) {
      throw new Error('Codex did not name the continuation session');
    }
    await persistSessionSettings(continued, settings);
    publishPicks();
    return session;
  };
  const freshPlanForDraft = (draft: NewSessionDraft): AgentPlanSource => {
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
            sessionId: sessionId!,
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            model: draft.profile.model,
            effort: draft.profile.effort,
          })
        : codexPlan(launch, {
            cwd: draft.cwd,
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
            ...(mode ? { permissionMode: claudeAskMode(mode) } : {}),
            model: draft.profile.model,
            effort: draft.profile.effort,
          })
        : codexPlan(launch, {
            cwd: draft.cwd,
            resume: sessionId,
            clientInfo: CLIENT_INFO,
            ...(mode ? codexAskMode(mode) : {}),
            model: draft.profile.model,
            effort: draft.profile.effort,
          });
    };
  const startFreshSession = async (draft: NewSessionDraft) => {
    return await ensureSession(freshHostKey(draft.profile.agent, draft.draftId), freshPlanForDraft(draft));
  };

  // An answer the agent is no longer waiting for. It happens when a turn ended, or the
  // child died, while the reader had the picker open. Saying so is the point of the boolean:
  // an answer that quietly goes nowhere looks exactly like the agent having hung, which is
  // the one failure this whole channel exists to prevent.
  const reportAnswer = (answered: boolean) => {
    if (!answered) {
      void vscode.window.showWarningMessage(
        'Arc: the agent had already stopped waiting for that answer, so it was not sent.',
      );
    }
  };

  panel.onAnswerAsk = (session, id, candidate) => {
    const waiting = host.waiting().find((entry) => {
      const state = host.get(entry.key)?.state();
      return state?.sessionId === session && entry.ask.id === id;
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
    const answered = host.get(waiting.key)?.answer(id, answer) ?? false;
    reportAnswer(answered);
    return answered;
  };
}

// The path a copy command was invoked on. It arrives as the context object the panel
// attached to the row, and nothing about that shape is guaranteed, so anything that does not
// carry a path copies nothing rather than copying "undefined".
function pathFrom(arg: unknown): string | null {
  const row = arg as { path?: string } | undefined;
  if (!row) {
    return null;
  }
  return typeof row.path === 'string' && row.path ? row.path : null;
}

// The turn a read command was invoked on. It arrives as the context object the panel
// attached to the card, and nothing about that shape is guaranteed, so a message is sent
// only for an argument that actually names a turn.
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

// The session a rail command was invoked on, read off its argument the way a turn key
// is: the panel attached the object to the card, and nothing about that shape is guaranteed.
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

// The comment box, opened over the turn the menu was drawn on. The words the reader had
// selected, or the line they opened the menu on, are read in the panel: this side never saw
// either, and it says only which turn.
function commentOnTurn(panel: PanelProvider, arg: unknown): void {
  const key = turnKeyFrom(arg);
  if (!key) {
    return;
  }
  panel.openComment(key);
}

// The turn whose comments to copy. Both halves are read, because a turn key carries its own
// session and reading it back out of the key would be a second copy of that shape.
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

// The session whose setup, folder, and labels a new empty draft takes, from the menu over a
// turn card, a session heading, or a rail card.
function newSessionWithLabels(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.newSessionWithLabels(session);
}

// The session whose labels to edit. The popover is drawn in the panel, which is where
// the reader types, so this hands the session over and nothing else.
function labelSession(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.openLabelEditor(session);
}

// The session to rename. The editor is drawn in the panel, which is where the reader types,
// so this hands the session over and nothing else.
function renameSession(panel: PanelProvider, arg: unknown): void {
  const session = sessionIdFrom(arg);
  if (!session) {
    return;
  }
  panel.openSessionRename(session);
}

// The saved view a rail command was invoked on, read off its argument the way a session
// is: the panel attached the object to the views row, and nothing about that shape is
// guaranteed. An empty id is All sessions, which is the absence of a view rather than a
// view of its own, so the empty string answers nothing here and the menu acts on nothing.
function viewIdFrom(arg: unknown): string | null {
  const view = (arg as { view?: string } | undefined)?.view;
  return typeof view === 'string' && view ? view : null;
}

// The view editor, opened over the view the menu was drawn on. The reader types the new name,
// or answers the delete, inside the panel, so this hands over the id and the press and nothing
// else.
function editView(panel: PanelProvider, arg: unknown, mode: 'rename' | 'delete'): void {
  const view = viewIdFrom(arg);
  if (!view) {
    return;
  }
  panel.openViewEditor(view, mode);
}

async function copyPath(arg: unknown, relative: boolean): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  // A file row carries its path outright; a link inside a summary carries the link, which
  // still holds its line anchor and may be relative, so it goes through the tested rules
  // that strip the one and resolve the other. What is copied is the file the link names,
  // never the anchor, because a path with `#L42` on it names nothing to any other tool.
  const link = (arg as { link?: string } | undefined)?.link;
  const named = typeof link === 'string' ? linkTarget(link) : null;
  const target = pathFrom(arg) ?? (named ? resolveLink(named, folders, fs.existsSync) : null);
  if (!target) {
    return;
  }
  // Relative the way the explorer writes it, from the tested rule; absolute the way Windows
  // itself spells it rather than the way the transcript happened to, because that is what a
  // terminal or another tool will need and the recorded spelling varies from turn to turn.
  // `nativePath` covers both branches: a file outside every folder has no relative form, so
  // the relative branch hands back an absolute path too, and it needs the same spelling.
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
  return Promise.all([recording, usageWrites.drain(), sessionSettingsWrites.drain()]).then(() => undefined);
}
