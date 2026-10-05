import { MEASUREMENT_ENVIRONMENT } from './identity';
import { ContextDemand, unavailableContext, validContextDetail, type ContextIdentity } from './domain/context-detail';
import { createPanelVisibility } from './panelvisibility';
import {
  resolveSelectedSource,
  validateSelectedSource,
  selectedDependencies,
  type SelectedSource,
} from './selectedsource';
import { LOADING_DEFAULTS, type AppliedDefaults, type DefaultContext } from './view/model-picks';
import type { ClaudeForwardCheckpoint } from './claudehistory';
import * as vscode from 'vscode';
import { costStateDependency, costStateIdentity, reconcileClaudeCostState } from './claudecoststate';
import { claudeCostStateDependencies, invalidateClaudeCostSupplements } from './projectspend';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  readManifest,
  Manifest,
  ManifestEntry,
  fileDiffersOnDisk,
  projectSpendDirectory,
  arcHome,
  cacheRoot,
  WorkspaceCachePartition,
} from './store';
import { codexOpeningsAtStartup, CodexOpeningsWriter } from './codexopenings';
import { baselineUri, turnFileUri, PATCH_SCHEME } from './uris';
import { readSetting, writeSetting } from './config';
import { saveTimelineLayout } from './view/timeline-layout';
import { RAIL_FOLDS } from './view/rail';
import { settingName } from './settings';
import { ARC_IDENTITY, MULTI_ROOT_SPEND_WORKSPACE_PREFIX } from './identity';
import { sidesFor } from './patchview';
import {
  Turn,
  Compaction,
  SessionRead,
  SessionFile,
  HumanPromptScan,
  AgentKind,
  FileRevision,
  projectsRoot,
  sessionFilesFor,
  readSession,
  readSessionCwd,
  TurnOutcome,
  TurnStarts,
  normalizeFsPath,
  watchDirs,
  TRANSCRIPT_WAKE_MS,
  sameSessionRevision,
  revalidatedCatalog,
  trustedListedRevisions,
  revalidatedCatalogPaths,
  scanForHumanPrompt,
  createClaudeUsageLineReducer,
  type ClaudeUsageReducerState,
  isInside,
  linkTargetIsHtml,
  linkTargetIsMarkdown,
  agentSpendDependencyKey,
  childSpendVersion,
  claudeChildReferenceFor,
  claudeSubagentMetaReader,
  type ClaudeChildSessionFile,
  type ClaudeChildSessionReference,
  type ClaudeSubagentMetaReader,
  type SessionStatCompactionFacts,
  type SessionStatTurnFacts,
  normalizeSessionTitle,
  sameCommitSha,
  sessionOutcomeOf,
  sessionStatFactsOf,
  shortenTo,
} from './transcript';
import {
  CodexMetaCache,
  CodexStatCache,
  CodexSubagentFile,
  ThreadNames,
  codexSessionFiles,
  coldOpeningPass,
  type ColdOpeningPass,
  codexSessionIndexPath,
  codexSessionsRoot,
  codexSubagentFor,
  codexAgentSpendVersion,
  codexSpendIndex,
  codexTitleFor,
  readCodexSession,
  readRolloutStat,
  readThreadNames,
  staleMetas,
  createCodexUsageLineReducer,
} from './codex';
import { AgentSpendRef, spendFileVersion, type AgentSpend } from './agentspend';
import { RepositoryCommits, nodeGitRunner } from './gitcommits';
import { CommitRepositoryReservations, commitRepositorySourceKey } from './progressiveworker';
import {
  COMMIT_REPOSITORY_PARSER_VERSION,
  commitRepositoryOccurrence,
  type CommitRepositoryReply,
  type CommitRepositoryRequest,
  type CommitRepositorySource,
} from './codexhistory';
import { RepositoryScope } from './repositoryscope';
import {
  CARD_ACTIONS,
  TurnCard,
  CompactionCard,
  RowIcon,
  PanelState,
  normalizePanelState,
  normalizeQueuedSubmissions,
  normalizeDraftCommentIds,
  queuedSubmissionBookFits,
  QueuedSubmission,
  SESSION_LIMIT,
  normalizeDrafts,
  normalizeSentPrompts,
  restoredSentPrompts,
  toCard,
  toCompactionCard,
  groupBySession,
  newestPerSession,
  currentRecordsBySession,
  turnBudget,
  pickShowing,
  orderSessionCatalog,
  turnKey,
  formatWhen,
  formatRelative,
  diffTitle,
  emptyTimeline,
  newestTurnLoading,
  AGENT_NAMES,
  statsBySession,
  editorColumn,
  besideColumn,
  searchTurns,
  isSearch,
  SearchEntry,
  searchScope,
  searchScopeName,
  newCounts,
  NewCount,
  newestTurnStarts,
  listingSignature,
  spendSourceSignature,
  ListingFacts,
  refreshWanted,
  sessionStatusOf,
  searchablePrompt,
  searchableSummary,
  emitTurnComments,
  applyComment,
  TurnComment,
  hasUnsentPrompt,
  unsentBySession,
  webviewPanelState,
  withSweptDraftLabels,
  remapReaderParents,
  abandonReaderParents,
} from './turnview';
import { DRAFT_SESSION_PREFIX, adoptLabelSession, labelEditorReply, labelsOf, setSessionLabels } from './turnlabels';
import { normalizeSavedViews } from './domain/views.ts';
import { normalizeSavedRailFilters } from './domain/rail-filters.ts';
import { readMovedOnlyFor, type ReadState } from './domain/read.ts';
import {
  Trail,
  emptyTrail,
  prunePlaces,
  renamePlace,
  stepBack,
  stepForward,
  trailPlace,
  visitPlace,
} from './turnplaces';
import type { DraftOrigin } from './composerview';
import {
  agentRunAnswer,
  childWriteKey,
  claudeChildWriteIndex,
  sessionParentEdgeSet,
  sessionParentIndex,
  sessionParentOf,
  type SessionParent,
  type SessionParentEdge,
  type SessionParentEdgeSet,
  liveBackgroundCommands,
  liveOpenChildren,
  openChildCounts,
  openChildrenKey,
  outcomeWithWiderChildren,
  railCacheMarkOf,
  recordExits,
  writeTimeOfVersion,
  railCachesOf,
  sessionRunningSince,
  stableRailOrder,
  syntheticDraftRows,
  type RevisionedRailCacheMark,
} from './turnrail';
import {
  SessionStatChip,
  cacheExpiryReturnCount,
  composerRuntimeBySession,
  countedDispatchedCosts,
  dispatchedAgentCard,
  dispatchedChip,
  dispatchedState,
  priceDispatchedParts,
  pendingAskPosition,
  sessionCacheExpiryStats,
  sessionCompactionContextDetail,
  sessionCostProjection,
  sessionCostUsageOf,
  sessionStatsFromFacts,
  sessionTurnStats,
  statusMoved,
  TimedWireActivity,
  withLiveActivity,
  type CacheExpiryCountFact,
  type ComposerRuntimeFacts,
  type DispatchedCostUsage,
  type DispatchedSessionCost,
  type SessionContextDetail,
  type SessionCostTotal,
} from './turncard';
import { transcriptReadCacheKey } from './turnread';
import { AgentUsage, usageBar, agentsWithNewTurns, TurnMark } from './usageview';
import {
  ANSWERED_IN_PROMPT,
  asksAnsweredBySend,
  PressMeaning,
  composerView,
  pathEntries,
  pickMenu,
  panelCommand,
  renameRequest,
  sendAction,
  agentPromptToSend,
  commentsForActiveSubmission,
  commentsAfterSend,
  clearAction,
  clearRequest,
  clearSubmission,
  compactCommand,
  compactSubmission,
  compactAction,
  queueAfter,
  queueSubmissionAfter,
  queuedSubmission,
  promptHistory,
  sentAfter,
  promptsAcross,
  prunedSentPrompts,
  sentPromptsToSave,
  commentsForQueuedSubmission,
  queueWithout,
  queueAfterClearRecovery,
  queueAfterAcceptedRecovery,
  queueCanDrain,
  queueEdit,
  queueRecoverySubmission,
  queueResetInFlight,
  queueResetSucceeded,
  queueResetFailed,
  queueSourceDelivery,
  queueSourceFailed,
  queueSuccessorDelivery,
  queueSuccessorFailed,
  sessionRunning,
  runningKey,
  runningSessions,
  runningSessionsSince,
  livePressOver,
  selectedWindowContainsRecordedTurn,
  pressIsMidTurn,
  pressesAfter,
  pressesAfterRunning,
  pressesAfterLocalAnswer,
  succeedSession,
  pressesAfterSessionHandoff,
  pressesAfterHandoff,
  pressForReply,
  pressOfKind,
  appendReply,
  replyAfterCommentary,
  LIVE_REPLY_POST_MS,
  LIVE_PRESS_LIMIT_MS,
  ComposerState,
  SessionSettingBook,
  SessionSettingSelection,
  sessionSettings,
  withSessionSettings,
  LiveKind,
  LivePress,
  PromptDelivery,
  NewSessionDraft,
  SessionProfile,
  newSessionDraft,
  handoffDraftText,
  responseLinkDraftText,
  sessionSettingsForProfile,
  draftProfileAfterPick,
  draftStarted,
  adoptSessionIdentity,
  abandonSessionDraft,
  sessionLauncherView,
  handoffRefusalMessage,
  type HandoffRefusal,
  launcherProfile,
  LauncherRequest,
  attachmentRefusal,
  attachmentFailureNotice,
  localAnswerNotice,
  rememberSessionAlias,
  resolveSessionAlias,
  sessionAdoptions,
  storedAskValue,
  type SessionAlias,
} from './composerview';
import { completePath } from './pathcompletion';
import {
  normalizePinnedSetups,
  normalizeSetupValues,
  pinValues,
  sameValues,
  unpinId,
  type CompleteSetupValues,
  type PinnedSetup,
} from './domain/session-setups';
import type { PinSetupRequest } from './view/launcher';
import { claudeSkillPath } from './claudeskillpath';
import {
  AgentPrompt,
  Ask,
  AskAnswer,
  CodexEffectiveMode,
  McpServer,
  ModelChoice,
  PromptEntry,
  WireActivity,
} from './agentwire';
import {
  MAX_PROMPT_ASSETS,
  MAX_PROMPT_ASSET_BYTES,
  MAX_PROMPT_ASSET_TOTAL_BYTES,
  PromptAssetCompletionBook,
  StoredPromptAsset,
  PromptAssetInput,
  PromptAssetStagingOperation,
  adoptPromptAssetOperationTarget,
  agentTakesAsset,
  browserAssetMime,
  deleteStagedPromptAssets,
  mergePromptAssets,
  normalizePromptAssetBook,
  pastedAssetName,
  promptAssetReleaseIndexes,
  promptAssetsFromStored,
  promptAssetsSafeToDelete,
  resolvePromptAssets,
  stagePromptAssets,
  storedAssetsForPrompt,
  unsupportedPromptAsset,
  validatePromptAssetBatch,
} from './promptassets';
import { fillPanelText, panelValues } from './paneltext';
import { dispatchPanelToHost, parsePanelToHost } from './webview/protocol.ts';
import { withRecoveredCommits } from './childartifacts.ts';
import {
  hasImageReference,
  imageFileFor,
  imagePathFor,
  ImageResolver,
  linkTargetIsImage,
  renderRichMarkdown,
  VISUALIZATION_SCHEME,
  visualizationPath,
} from './richtext';
import {
  SessionSpendSource,
  SessionSpendSourceIndex,
  SpendFileIndex,
  type SpendPendingAnswers,
  type SpendSourcePending,
  SessionFiguresCache,
  type SessionRailFacts,
  SubagentDirectoryCache,
  discoverClaudeSessionSpendSources,
  spendFileIsClaudeChild,
  spendRecordAgent,
  discoverCodexSpendSources,
  indexSpendFile,
  invalidateSpendFileNormalization,
  loadSpendLedger,
  normalizeSpendFile,
  normalizeWorkspace,
  prepareProjectSpendView,
  projectSpendDisplayFiles,
  pruneSpendFilesWithResult,
  projectSpendHistoryCutoff,
  projectSpendOfferDecision,
  projectSpendWindows,
  type SpendSourceRevision,
  projectSpendSourceOfferDue,
  publicProjectSpendPrice,
  saveSpendLedger,
  sessionSpendPartsBySession,
  type SessionSpendCoverage,
  dispatchedSpendPartsBySession,
  spendSourceHeld,
  sessionLifetimeDisplayFiles,
  sessionTurnStatsBySession,
  spendRecordChangesRail,
  sessionCacheFactsBySession,
  sessionRailFactsBySession,
  projectSpendWorkspace,
  PROJECT_SPEND_SAVE_MAX_MS,
  PROJECT_SPEND_SAVE_MS,
  projectSpendSaveRetryDelay,
} from './projectspend';
import {
  IconTheme,
  LanguageTable,
  LanguageContribution,
  buildLanguageTable,
  parseIconTheme,
  resolveIcon,
  fontFor,
  usableFonts,
  familyFor,
  fontFaceRules,
} from './icontheme';
import { SessionNames, sessionLabelOf, storedSessionName, transcriptIdentity, type SessionName } from './sessionnames';
import {
  answerSessionRename,
  requestSessionRename,
  sessionRenameOpening,
  type SessionRenameResult,
} from './sessionrename';
import {
  CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
  VERSION as DERIVED_CACHE_VERSION,
  DerivedCacheCheckpointState,
  DerivedTitleEntry,
  agentRunScanUnread,
  carryDerivedTitleFacts,
  derivedTitleCacheStats,
  derivedTitleStats,
  loadDerivedCache,
  onlyGrew,
  railEnrichmentNeeds,
  withMetadataCoverage,
  saveDerivedCache,
  scanForRailEnrichment,
  SessionFactFigures,
  withAgentRunScanProgress,
  withRailEnrichment,
  withSessionName,
  type CarriedName,
  type ClaudeChildReferenceCacheEntry,
} from './derivedcache';
import { drawnSessionCards } from './sessiondetails';
import {
  SessionHistory,
  HistoryPageOutcome,
  afterHistoryPage,
  afterHistoryRequest,
  historyBudgetBytes,
  historyBytes,
  historyEvictions,
  historyPageReads,
  historyRecordsOutside,
  historyRequestContinues,
  retainDisplacedWindow,
  olderHistoryControl,
  olderHistoryPossible,
  historyStateAfterRevision,
  staleCursorIsStuck,
  startSessionHistory,
} from './historypages';
import { ClaudeHistoryCursor } from './claudehistory';
import { CodexHistoryCursor } from './codexhistory';
import {
  BoundedTrailingScheduler,
  CATALOG_REFRESH_DEADLINE_MS,
  mergeRefreshRequests,
  PendingWatcherWake,
  RefreshRequest,
  ScheduledRun,
  watcherRefreshDecision,
} from './scheduler';
import {
  PanelPerformanceCounters,
  messageByteBudget,
  projectPerformanceDiagnostics,
  savePerformanceDiagnosticsSnapshot,
  serializedMessageBytes,
  type LedgerSaveOperation,
  type PerformanceEventSink,
  type StartupMilestone,
} from './performancediagnostics';
import {
  DIAGNOSTICS_LOG_DIRECTORY,
  DiagnosticsLog,
  StartupThresholdWatch,
  StartupHistory,
  createDiagnosticsLog,
  readStartupArtifact,
  silentDiagnosticsLog,
} from './diagnosticslog';
import {
  RailPayloadInput,
  messageFieldBytes,
  railInputKey,
  railPayload,
  railWordingDay,
  renderPayload,
  sameRailInputs,
  selectionPayload,
  type RailInputKey,
} from './payload';
import {
  ProgressiveWorker,
  acceptsProgressiveResult,
  metadataReadBudget,
  preservesLoadedHistory,
  sameProgressiveRevision,
  unreadHeadBytes,
  INITIAL_RAIL_READ_BYTES,
  RAIL_ENRICHMENT_READ_BYTES,
  type DispatchSessionFacts,
  type ProgressiveCheckpoint,
  type ProgressiveInput,
  type ProgressiveResult,
} from './progressiveworker';
import { panelShell } from './paneldevelopment';

// A read-only panel showing what each agent turn did, newest first, so the session
// never has to be scrolled to find out where the work stands. Everything shown comes from
// the session transcript and the snapshot store; nothing is written back to either.
//
// This is a webview rather than a TreeView because a tree row is one line of fixed height.
// The panel is narrow, and the figures worth seeing (files, lines, tokens, tool mix,
// subagents, commits) do not fit on one line at that width.

interface CacheEntry {
  key: string;
  agentKey: string;
  structuralKey: string;
  // The agent rows the Codex reader attached from a child's own opening record. A structured
  // clone drops the mark those rows carry, so a later refresh needs them named.
  structuralAgentIds?: readonly string[];
  revision: FileRevision;
  read: SessionRead;
  checkpoint?: ProgressiveCheckpoint;
  usedAt?: number;
  bytes?: number;
  checkpointBytes?: number;
}
interface AwaitingSessionRecord {
  sessionId: string;
  createdAt: number;
  agent: AgentKind;
  cwd: string | null;
}
interface WindowRead {
  read: SessionRead;
  maxTurns: number;
  revision: Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>;
}
const TRANSCRIPT_TURN_LIMIT = 40;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const SEARCH_TAIL_BYTES = 16 * 1024 * 1024;
const POLL_INTERVAL_MILLISECONDS = 5 * 1000;

// Where the next older page starts. Each source adapter owns its own state inside the
// cursor, and the provider never reads it: it holds one, hands it back to the adapter that
// made it, and drops it when the adapter says the revision moved.
type HistoryCursor = ClaudeHistoryCursor | CodexHistoryCursor;

// The panel draws two kinds of item in one stream: a turn, and the compaction that wiped
// the session before it. Both carry a summary, so both render the same markdown.
type RenderCard = (TurnCard | CompactionCard) & { summaryHtml: string };

// JSON on its way into a `<script>` block in the page.
//
// `JSON.stringify` escapes what JSON needs escaped, and HTML is not JSON: a string holding
// `</script>` closes the tag early and everything after it is parsed as markup. Nothing on
// this path can carry one today, since the values are session ids and turn keys, and the
// content policy would refuse to run anything injected. Both of those are arguments about the
// values, and this is an argument about the shape, which is the half that stays true when
// somebody sends a different value through.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function messageBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

// How much recorded diff text the panel keeps for the diffs it has opened, across the
// window's lifetime. One diff is a small fraction of it, so the budget is only reached by
// opening many turns in one window.
const PATCH_BUDGET_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_WAKE_MAX_MS = 1_000;
const DERIVED_CACHE_CHECKPOINT_MS = 5 * 60 * 1000;

// Whether the editor is set to navigate on the mouse's fourth and fifth buttons. The editor
// answers for its own surfaces and cannot answer for the panel, which draws in a frame its
// listener never reaches, so the panel asks the same question of the same setting.
function mouseNavigates(): boolean {
  return vscode.workspace.getConfiguration('workbench.editor').get<boolean>('mouseBackForwardToNavigate', true);
}

// Direct activity arrives in bursts while an agent streams a message. Rebuilding a card for
// every text fragment makes the panel fight the reader's scroll and selection, so fragments
// received close together share one refresh.
const LIVE_ACTIVITY_POST_MS = 150;
const LIVE_ACTIVITY_LIMIT = 60;
const LIVE_ACTIVITY_STALE_MS = 30 * 60 * 1000;

// The rail card's own drawn name. `clampRailWidth` in view/rail.ts bounds only how narrow
// the reader can drag the rail, not how wide, so the rail has no maximum width to size this
// from. 200 characters fills a rail of about 1,300px at the panel's own type size (an
// estimate from the font size, not a measured width), which is far wider than a normal
// rail, so a longer name still fills the row and ends in an ellipsis rather than growing
// what every render and every rail post carries.
const RAIL_NAME_LIMIT = 200;

interface HeldActivity extends TimedWireActivity {
  seenAt: number;
}

// The store entry for one file, out of a manifest already read. Path shapes differ between
// the transcript and the store, so both sides are normalized. Kept apart from the read so a
// diff of many files parses the manifest once rather than once per file.
function pendingIn(manifest: Manifest | null, filePath: string): ManifestEntry | null {
  if (!manifest) {
    return null;
  }
  const wanted = normalizeFsPath(filePath);
  const entry = manifest.files.find((f) => normalizeFsPath(f.path) === wanted);
  if (!entry || !fileDiffersOnDisk(entry)) {
    return null;
  }
  return entry;
}

// A link target from a summary: a URL, or a workspace path that may name a line.
// `column` is the editor group the file should land in, decided by the same rule every other
// thing the panel opens goes through. Without one, `showTextDocument` opens wherever focus
// happens to be, and once the panel is an editor tab of its own that is the panel's own
// group: the reader's editor splits in two and the file lands where the panel was.
async function openLink(href: string, column: vscode.ViewColumn): Promise<void> {
  if (/^https?:\/\//i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  // "src/store.ts#L42-L51" and "src/store.ts:42" both name a line to land on.
  const anchor = /#L(\d+)(?:-L?(\d+))?$/.exec(href) || /:(\d+)(?::\d+)?$/.exec(href);
  const target = anchor ? href.slice(0, anchor.index) : href;
  const from = anchor ? Number(anchor[1]) - 1 : -1;
  const to = anchor && anchor[2] ? Number(anchor[2]) - 1 : from;
  if (!target) {
    return;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  // A summary is written by the agent and quotes what it read, so a path in one is not
  // trusted to point anywhere it likes. A path is followed only when it lands inside an
  // open folder, and it is resolved before that is decided: a target that keeps its `..`
  // segments passes a prefix test on the unresolved string, and the filesystem then walks
  // out of the folder when it opens the file. Relative targets are checked after joining,
  // for the same reason.
  const inWorkspace = (p: string) =>
    folders.some((f) => {
      const base = normalizeFsPath(f.uri.fsPath).replace(/\/$/, '');
      const t = normalizeFsPath(path.resolve(p));
      return t === base || t.startsWith(base + '/');
    });
  if (path.isAbsolute(target) && !inWorkspace(target)) {
    void vscode.window.showInformationMessage(`Arc: ${target} is outside this workspace.`);
    return;
  }
  const candidates = (
    path.isAbsolute(target)
      ? [vscode.Uri.file(path.resolve(target))]
      : folders.map((f) => vscode.Uri.joinPath(f.uri, target))
  ).filter((uri) => inWorkspace(uri.fsPath));
  if (!candidates.length) {
    void vscode.window.showInformationMessage(`Arc: ${target} is outside this workspace.`);
    return;
  }
  for (const uri of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
      }
      // A picture goes to the editor's own viewer. The text editor refuses one, and that
      // refusal is thrown from the same call a missing file throws from, so a link to a
      // picture that is there told the reader there was no file at all.
      if (uri.scheme === 'file' && linkTargetIsImage(uri.fsPath)) {
        await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: column });
        return;
      }
      if (uri.scheme === 'file' && linkTargetIsHtml(uri.fsPath)) {
        try {
          await vscode.commands.executeCommand('workbench.action.browser.open', uri.toString(true));
        } catch {
          void vscode.window.showInformationMessage(
            `Arc: VS Code did not open ${uri.fsPath} in the integrated browser.`,
          );
        }
        return;
      }
      if (uri.scheme === 'file' && linkTargetIsMarkdown(uri.fsPath)) {
        try {
          await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', column);
        } catch {
          void vscode.window.showInformationMessage(`Arc: VS Code did not open ${uri.fsPath} in Markdown Preview.`);
        }
        return;
      }
      const selection = from >= 0 ? new vscode.Range(from, 0, to, 0) : undefined;
      await vscode.window.showTextDocument(uri, { selection, preview: true, viewColumn: column });
      return;
    } catch {
      /* not this folder; try the next */
    }
  }
  void vscode.window.showInformationMessage(`Arc: no file at ${target} in this workspace.`);
}

// A picture the reader pressed in a response, opened full size in the editor's own viewer.
// The panel draws no viewer of its own.
//
// The path is tested again here. The card carried a path this rule already accepted, and a
// message is still only a message: a second reading costs nothing and keeps the one rule
// that decides which file the panel opens in one place.
//
// `imagePathFor` reads a path and not a Markdown target, so a per-cent sign in a file name
// stays part of the name.
async function openImage(target: string, column: vscode.ViewColumn): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const file = imagePathFor(target, folders);
  if (!file) {
    void vscode.window.showInformationMessage(`Arc: ${target} is outside this workspace.`);
    return;
  }
  try {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: column });
  } catch {
    void vscode.window.showInformationMessage(`Arc: no image at ${file}.`);
  }
}

// A visualization reference is local HTML produced for an interactive response. It is
// opened only after the reader presses its named button, and never injected into the panel.
async function openVisualization(target: string): Promise<void> {
  const file = visualizationPath(`${VISUALIZATION_SCHEME}${encodeURIComponent(target)}`);
  if (!file) {
    void vscode.window.showInformationMessage('Arc: This visualization reference is invalid.');
    return;
  }
  const uri = vscode.Uri.file(file);
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
      throw new Error('not a file');
    }
    await vscode.env.openExternal(uri);
  } catch {
    void vscode.window.showInformationMessage('Arc: This visualization is no longer available.');
  }
}

// The icon theme a reader who has never chosen one is looking at.
const DEFAULT_ICON_THEME = 'vs-seti';

// A finished `@font-face` rule for the panel, and the family name a glyph asks for it by.
// The rule is built here because only the extension knows where the font file is and can
// turn it into a URI the webview may fetch.
type FontFaceRule = string;

// The theme's icon for one file, in the shape the card carries it.
type ThemedIcon = Pick<RowIcon, 'glyph' | 'image'>;

// The reader's colour theme, which decides whether the icon theme's `light` block applies.
// The same file resolves to two different icons across that switch, which is why the panel
// listens for it.
function isLightColourTheme(): boolean {
  const kind = vscode.window.activeColorTheme?.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

// Every language every installed extension declares. `packageJSON` is already parsed and in
// memory, so this costs no disk reads.
function languageContributions(): LanguageContribution[] {
  const contributions: LanguageContribution[] = [];
  for (const extension of vscode.extensions.all) {
    try {
      const languages = extension.packageJSON?.contributes?.languages;
      if (Array.isArray(languages)) {
        contributions.push(...languages);
      }
    } catch {
      /* an extension with an unreadable manifest simply contributes nothing */
    }
  }
  return contributions;
}

// Where the icon theme the reader is using keeps its files. Found through `vscode.extensions`
// rather than by path, because the editor keeps each of its versions in a directory named
// after a hash.
function locateIconTheme(): { file: vscode.Uri; dir: vscode.Uri; root: vscode.Uri } | null {
  const configured = vscode.workspace.getConfiguration().get<string | null>('workbench.iconTheme');
  // Unset means the default. Set to nothing means the reader turned file icons off, and the
  // panel follows the explorer rather than drawing icons it has stopped showing.
  const wanted = configured === undefined ? DEFAULT_ICON_THEME : configured;
  if (!wanted) {
    return null;
  }
  for (const extension of vscode.extensions.all) {
    let themes: unknown;
    try {
      themes = extension.packageJSON?.contributes?.iconThemes;
    } catch {
      continue;
    }
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const theme of themes) {
      if (!theme || theme.id !== wanted || typeof theme.path !== 'string') {
        continue;
      }
      const file = vscode.Uri.joinPath(extension.extensionUri, theme.path);
      return { file, dir: vscode.Uri.joinPath(file, '..'), root: extension.extensionUri };
    }
  }
  return null;
}

// The icon theme the reader's explorer is drawing, read once and kept until it changes.
//
// Every step of this can come up empty: the theme may name an extension that is not
// installed, its JSON may not parse, it may declare a font whose file is missing, or the
// reader may have turned file icons off. Each of those leaves `iconFor` returning nothing,
// and the row keeps the lettered badge `fileicons.ts` works out from the filename. Nothing
// here throws, and no path through it leaves a row with an empty icon column.
class IconThemeSource {
  private read = false;
  private theme: IconTheme | null = null;
  private themeDir: vscode.Uri | null = null;
  private themeRoot: vscode.Uri | null = null;
  // Built from every installed extension's manifest, which does not move while the window
  // is open, so this outlives a change of icon theme.
  private languages: LanguageTable | null = null;

  // Called when the reader picks a different icon theme. The language table is left alone.
  forget(): void {
    this.read = false;
    this.theme = null;
    this.themeDir = null;
    this.themeRoot = null;
  }

  private load(): void {
    if (this.read) {
      return;
    }
    this.read = true;
    try {
      if (!this.languages) {
        this.languages = buildLanguageTable(languageContributions());
      }
      const found = locateIconTheme();
      if (!found) {
        return;
      }
      // A theme file written with a byte-order mark parses as nothing without this.
      const text = fs.readFileSync(found.file.fsPath, 'utf8').replace(/^\uFEFF/, '');
      const theme = parseIconTheme(JSON.parse(text));
      if (!theme) {
        return;
      }
      // A theme names its font files and nothing else checks them. One stat per declared
      // file, here, is what keeps the promise that a font whose file has gone falls back to
      // the badge instead of emptying the whole column.
      const dir = found.dir.fsPath;
      this.theme = {
        ...theme,
        fonts: usableFonts(theme.fonts, (p) => fs.existsSync(path.join(dir, p))),
      };
      this.themeDir = found.dir;
      this.themeRoot = found.root;
    } catch {
      /* a theme that cannot be read leaves every row on its lettered badge */
    }
  }

  // The folders the panel may load a font or an image out of. The theme lives in someone
  // else's extension, so the webview has to be told where that is by name.
  roots(): vscode.Uri[] {
    this.load();
    return this.themeRoot ? [this.themeRoot] : [];
  }

  // The `@font-face` rules the panel needs. Where the font lives is only known once the
  // theme has been found, so this cannot be part of the baked stylesheet. The rules
  // themselves are built in `icontheme.ts`, which is where they can be tested: everything
  // the editor has to answer is the one line below that turns a path into an address.
  fontFaces(webview: vscode.Webview): FontFaceRule[] {
    this.load();
    const dir = this.themeDir;
    if (!this.theme || !dir) {
      return [];
    }
    return fontFaceRules(this.theme, (p) => webview.asWebviewUri(vscode.Uri.joinPath(dir, p)).toString());
  }

  // The theme's answer for one file, or nothing when it has none.
  iconFor(filePath: string, webview: vscode.Webview, light: boolean): ThemedIcon | null {
    this.load();
    if (!this.theme) {
      return null;
    }
    const icon = resolveIcon(this.theme, this.languages, filePath, light);
    if (!icon) {
      return null;
    }
    if (icon.kind === 'image') {
      if (!this.themeDir) {
        return null;
      }
      try {
        return { image: webview.asWebviewUri(vscode.Uri.joinPath(this.themeDir, icon.path)).toString() };
      } catch {
        return null;
      }
    }
    const font = fontFor(this.theme, icon);
    // A glyph with no font behind it draws as an empty box, which is worse than the badge.
    if (!font) {
      return null;
    }
    return {
      glyph: {
        character: icon.character,
        font: familyFor(this.theme, font),
        size: font.size,
        colour: icon.colour,
      },
    };
  }
}

// The editor tab's own type and title. The type is what the editor writes into its layout
// so a restored tab can be handed back to the serializer, so it is as fixed as a view id:
// changing it orphans whatever tab a reader had open.
// How to put focus in each editor group, by index. `vscode.changes` has no options argument,
// so focusing first is the only way to say where its editor should open. The editor offers
// these for the first eight groups and no more, which is far past what anyone splits into.
const FOCUS_GROUP = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

const PANEL_TYPE = ARC_IDENTITY.panelType;
// Where the panel's remembered state is kept. Workspace scope, not global: session ids, turn
// keys and folds all name things in this workspace, and a global copy would carry one
// project's folded sessions into another's list.
const STATE_KEY = ARC_IDENTITY.panelStateKey;
// How long the panel waits before an unsent prompt reaches storage. One write a second while
// a reader types, rather than one a letter, and short enough that the gap between the last
// keystroke and a window closing is almost always longer than it.
const DRAFT_SAVE_MS = 1000;
const PANEL_TITLE = ARC_IDENTITY.productName;
const PANEL_OPTIONS = {
  retainContextWhenHidden: true,
  enableFindWidget: true,
} satisfies vscode.WebviewPanelOptions;

// Where a panel tab came from. `created` is one this extension opened with `createWebviewPanel`.
// `serializer` is one the editor restored after a window reload and handed back.
// `serializer-replaced` is a reload whose restored tab carried stale options: the serializer did
// fire, the restored tab went, and the panel in front of the reader is a fresh one. Without the
// third value that reload reads as a plain open, and a startup measured across it names the wrong
// panel.
type PanelOrigin = 'created' | 'serializer' | 'serializer-replaced';

// Where the panel can be drawn, behind one shape.
//
// The editor area takes a `WebviewPanel` and nothing else, and a panel goes anywhere the
// reader drags it, the editor column and the side panes alike. That is why the tab is the
// only host: a `WebviewView` reaches the sidebars and the bottom panel and no further.
//
// The interface stays even with one implementation. Everything below `attach()` is written
// against it, so it is the line between a host and the list of turns, and a second host
// would arrive here rather than throughout the class.
interface PanelHost {
  readonly webview: vscode.Webview;
  active(): boolean;
  visible(): boolean;
  onDidChangeVisibility(listener: () => void): vscode.Disposable;
  onDidDispose(listener: () => void): vscode.Disposable;
}

interface QueuedEditOffer {
  id: string;
  session: string;
  browserSession: string;
  revision: number;
}

function panelHost(panel: vscode.WebviewPanel): PanelHost {
  // Focus changes also emit view-state events. Only visibility transitions notify the page.
  let was = panel.visible;
  return {
    webview: panel.webview,
    active: () => panel.active,
    visible: () => panel.visible,
    onDidChangeVisibility: (l) =>
      panel.onDidChangeViewState(() => {
        if (panel.visible === was) {
          return;
        }
        was = panel.visible;
        l();
      }),
    onDidDispose: (l) => panel.onDidDispose(l),
  };
}

// The lifetime figures a rail post holds by identity. Read-only, so a figure is replaced and
// never edited in place.
type LifetimeFigures = Readonly<{
  stats: Readonly<Record<string, readonly Readonly<SessionStatChip>[]>>;
  costs: Readonly<Record<string, Readonly<SessionCostTotal>>>;
  contextDetails: Readonly<Record<string, Readonly<SessionContextDetail>>>;
  cacheExpiryCounts: Readonly<Record<string, Readonly<CacheExpiryCountFact> | null>>;
  // What each dispatched session adds to each session above it, by receiving session and then by
  // dispatched session. Only turn cards read it. The rail and the heading never do.
  dispatched: Readonly<Record<string, Readonly<Record<string, HeldDispatchedCost>>>>;
}>;

// A dispatched session's contribution as the figures cache holds it: priced parts, whether it
// is short, and its own transcript with the record that the ledger queue is asked about when a
// card draws.
interface HeldDispatchedCost {
  costs: DispatchedSessionCost['costs'];
  short: boolean;
  own?: { file: string; record: SpendFileIndex | undefined };
}

// A session's stat facts as the metadata figure caches hold them. Read-only, so the facts are
// replaced and never edited in place.
type HeldStatFacts = {
  readonly turns: readonly Readonly<SessionStatTurnFacts>[];
  readonly compactions: readonly Readonly<SessionStatCompactionFacts>[];
} | null;

// One session's share of the lifetime figures.
// A session's held figures: its lifetime figures, which the rail and the heading read, and the
// contributions of the dispatched sessions it started, which only turn cards read. Either can be
// absent, because a session whose own sources are not whole still has contributions.
interface SessionHeldFigures {
  lifetime?: SessionLifetimeFigures;
  dispatched?: Record<string, HeldDispatchedCost>;
}

interface SessionLifetimeFigures {
  stats: SessionStatChip[];
  cost: SessionCostTotal;
  contextDetail: SessionContextDetail | null;
  // The exact cache-expiry return count `cache-expiry:` matches on, and whether it is a floor.
  // Null where the session's primary source is not yet a complete, fully scanned single source.
  cacheExpiryCount: CacheExpiryCountFact | null;
}

interface ClearSettlement {
  source: string;
  session: string;
  state: ComposerState;
  queued: QueuedSubmission | null;
  request: 'clear' | 'new';
  resetId: string;
  preservePayload: boolean;
  recoveryId?: string;
  delivery: PromptDelivery | null;
}

interface ClearRoute {
  successor: string;
  hosts: Map<PanelHost, number | null>;
}

import { mergeSubmittedPrompts, type SubmittedPrompt } from './webview/state';

interface SelectionWork {
  sessionId: string;
  generation: number;
  controller: AbortController;
  host?: PanelHost;
  scope?: string;
  source?: SelectedSource;
}

export class PanelProvider implements vscode.Disposable {
  private submissionWrites: Promise<void> = Promise.resolve();
  private submissionsInFlight = new Set<string>();
  private submittingDrafts = new Map<
    string,
    { revision: number; commentIds: readonly string[]; assets: readonly StoredPromptAsset[] }
  >();
  private draftRevisions = new Map<string, number>();
  private clearingDraftRevision: { session: string; revision: number } | null = null;
  private panelRecoveryWaiters = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  private disposed = false;
  private attachmentHandoffs = new Set<AbortController>();
  // Every host the panel is currently drawn in. A list rather than one: a tab restored
  // after a window reload can arrive while another is already up, and everything from
  // `attach()` down is written to work over whatever is there.
  private hosts: PanelHost[] = [];
  private readonly hostSessions = new Map<PanelHost, string>();
  private readonly hostPreviousSessions = new Map<PanelHost, string>();
  // Set only while a panel message runs. `send` captures it before delivery becomes async,
  // so a continuation can move the panel that submitted the prompt and no peer.
  private promptOriginHost: PanelHost | null = null;
  private readonly livePressHosts = new Map<string, PanelHost>();
  private readonly readyHosts = new Set<PanelHost>();
  private readonly panelVisibility = createPanelVisibility<PanelHost>();
  private readonly progressiveWorker = new ProgressiveWorker(undefined, () => this.diagnostics.enabled());
  private readonly commitRepositoryReservations = new CommitRepositoryReservations();
  private readonly commitRepositoryReplies = new Map<string, { key: string; reply: CommitRepositoryReply }>();
  private readonly lifetimeRail = new SessionFiguresCache<
    SessionRailFacts,
    Readonly<Record<string, SessionRailFacts>>
  >();
  private refreshGeneration = 0;
  private refreshController: AbortController | null = null;
  private pendingRefresh: RefreshRequest | null = null;
  private refreshDeadline: ReturnType<typeof setTimeout> | null = null;
  private refreshOverdue = false;
  private selectionGeneration = 0;
  private metadataReadIntent: { sessionId: string; generation: number } | null = null;
  private previousSelection: string | null = null;
  private selectionWork: SelectionWork | null = null;
  private selectionWorks = new Map<string, SelectionWork>();
  private earlySelectedSources = new Map<string, SelectedSource>();
  private selectionFailure: { sessionId: string; generation: number; revision: FileRevision } | null = null;
  // The native session menu belongs to the host that reported opening it. Keep one recent
  // arm because a command has no webview identity, and a newer menu supersedes an older one.
  private detailsMenuArm: { host: PanelHost; session: string; browserSession: string; at: number } | null = null;
  private composerMenuArm: { host: PanelHost; at: number } | null = null;
  // The selected-text menu has the same missing host identity. Its arm advances from the
  // host that opened the menu to the exact host that can answer the selected command.
  private selectedTextMenuArm: {
    host: PanelHost;
    session: string;
    key: string;
    at: number;
    copyLabels?: boolean;
  } | null = null;
  // The editor tab, while one is open. Kept apart from `hosts` because it is the one that
  // can be asked for again: a second press of the command brings this one forward rather
  // than opening another copy of the same list.
  private editorPanel: vscode.WebviewPanel | null = null;
  // Where the tab above came from, written down when it is adopted. A reveal adopts nothing, so
  // this is the only place the origin of the panel in front of the reader survives.
  private editorPanelOrigin: PanelOrigin | null = null;
  // The column the last ctrl-opened diff split off, so a repeat press lands in the same
  // group instead of splitting again. A position, not an identity: besideColumn in
  // turnview.ts decides when it still answers.
  private lastBeside: number | null = null;
  // The built-in commit viewer is newer than the extension's minimum VS Code version, so
  // its presence is checked once before the first commit link is opened.
  private canOpenCommit: boolean | null = null;
  private cache = new Map<string, CacheEntry>();
  // Commits the agent made quietly, which its output never printed. The reads run in the
  // background and a filled turn refreshes the panel, so the first render never waits for
  // git.
  private repositoryCommits = new RepositoryCommits(nodeGitRunner(), () => void this.refresh(true));
  private readonly repositoryScope: RepositoryScope;
  private repositoryScopeReady = false;
  private repositoryScopeRoots: string[] = [];
  // Child transcripts are read only when a parsed parent names them. Their compact usage
  // totals survive later parent turns, so an old child is not read again whenever its parent
  // grows. Codex discovery fills the structural links without statting the child files.
  private codexSubagents: CodexSubagentFile[] = [];
  private claudeSpendSources: SessionSpendSource[] = [];
  private codexSpendSources: { file: string }[] = [];
  private sessionSpendSources: readonly SessionSpendSource[] = [];
  private readonly sessionSpendSourceIndex = new SessionSpendSourceIndex();
  private readonly subagentDirectories = new SubagentDirectoryCache();
  private readonly codexStats = new CodexStatCache();
  // Which folder each session ran in, by transcript path. A recorded cwd is immutable
  // and remains cached. A missing cwd may mean the opening record was incomplete, so it
  // is retried when that file's revision changes rather than on every poll.
  private cwds = new Map<string, { cwd: string | null; mtimeMs: number; size: number }>();
  // The same answer for a Codex rollout, which carries its cwd in an opening record tens of
  // kilobytes long. It is read once per file for the same reason, and it costs more to read,
  // so this map is what keeps a listing of every rollout on the machine affordable.
  private codexMetas = new CodexMetaCache();
  // Saves `codexMetas` into the machine's shared opening records.
  private codexOpenings: CodexOpeningsWriter | null = null;
  // The opening records the first catalog refresh reads before it walks, so `allSessions` finds
  // each one in `codexMetas` and never reads a cold rollout on the main thread. The refresh
  // takes this once. Refresh triggers that arrive during the reads wait behind them in
  // `pendingRefresh`, and a search waits in `waitingSearch`, so the first catalog is still one
  // complete walk.
  private codexColdReads: (() => Promise<ColdOpeningPass>) | null = () =>
    coldOpeningPass(this.codexMetas, codexSessionsRoot());
  private codexPriming: Promise<ColdOpeningPass> | null = null;
  // The rollout list the cold pass walked, held only for the `allSessions` call right after it,
  // so the first catalog walks the tree once.
  private codexWalk: string[] | null = null;
  // The latest search query that arrived during the cold pass. Only it is answered after.
  private waitingSearch: string | null = null;
  // Naming a session means reading a slice of it, and so does asking when it was last
  // active, so both come off one read and are kept together against the file revision.
  // Either its mtime or its size moving invalidates this. `activityMs` is null for a file
  // whose window carries no recorded time.
  private titles = new Map<string, DerivedTitleEntry>();
  private metadataRevision = 0;
  private drawnMetadataRevision = 0;
  // The last name of each session whose entry a derived cache version bump dropped, until a
  // metadata read stores a new entry for it. Only `sessionLabel` reads it. It never reaches
  // `titles` or the held names, so no fresh read weighs it and no stored turn copies it.
  private carriedNames = new Map<string, CarriedName>();
  // A parsed Claude tail can hold a generated title outside metadata's smaller window.
  // Keep its short and full values together until the same refresh builds the session rows.
  // The one name each Claude session draws on every surface.
  private sessionNames = new SessionNames();
  // The first complete metadata pass is useful on the next reload even when VS Code ends
  // the extension host without disposing this provider. Yield before the checkpoint so the
  // render reaches the webview first. Later revisions are checkpointed at a bounded rate,
  // and shutdown writes any remaining state when it gets the chance.
  private derivedCacheCheckpointTick: ReturnType<typeof setTimeout> | null = null;
  private derivedCacheCheckpointState = new DerivedCacheCheckpointState(Date.now());
  private metadataRecoverySession: string | null = null;
  private metadataRecoveryQueue: string[] = [];
  // The names Codex has given its threads, for every session on the machine at once. Kept
  // apart from `titles` because it cannot be keyed the same way: `titles` is invalidated by
  // the rollout's mtime, and a thread is named after its rollout has gone quiet, so a name
  // cached against the rollout would never be looked for again.
  private threadNames: ThreadNames = { stamp: '', names: new Map(), fullNames: new Map() };
  // The human-prompt scan's cursor per transcript, for the peer-wake cut. Found is
  // sticky and the cursor makes the scan incremental, so a quiet file costs no read at
  // all and a growing one costs only its new bytes.
  private humanScans = new Map<string, HumanPromptScan>();
  // Every Claude transcript the last listing walked, before the peer-wake cut. The
  // caches above are trimmed against this rather than against the filtered list, or the
  // cut would evict the very entries that keep it cheap and every poll would read every
  // wake file's head again.
  private walkedClaude: string[] = [];
  private claudeParents: SessionFile[] = [];
  private dispatchDiscoveryPending = false;
  private discoveryRequestSequence = 0;
  private discoveryAcknowledgment?: {
    scope: string;
    epoch?: string;
    sequence: number;
    generation: number;
    request: number;
  };
  private enumeratedSpendSources?: {
    claude: SessionSpendSource[];
    codex: { file: string }[];
    children: CodexSubagentFile[];
  };
  private discoveryCheckpoint?: import('./progressiveworker').DiscoveryCheckpoint;
  private discoveryCompleted?: Set<string>;
  private claudeChildReferences: ClaudeChildSessionReference[] = [];
  // Child id to the session that started it and how, built from the dispatch references, the
  // resolved Claude subagent files and the Codex subagent listing when one of them is
  // replaced. A selection never rebuilds it.
  private sessionParents: {
    references: readonly ClaudeChildSessionReference[];
    children: readonly ClaudeChildSessionFile[];
    codex: readonly CodexSubagentFile[];
    parents: ReadonlyMap<string, SessionParentEdge>;
  } | null = null;
  // The index above cut to the edges whose ends both have a session row, with its dispatched
  // part and its refresh key. Rebuilt when the index or the catalog's ids move, so a
  // selection reuses it.
  private sessionParentEdgeSet: SessionParentEdgeSet | null = null;
  private dispatchFacts = new Map<string, DispatchSessionFacts>();
  private dispatchFiguresRevision = 0;
  private drawnDispatchFiguresRevision = 0;
  private claudeChildReferenceEntries = new Map<string, ClaudeChildReferenceCacheEntry>();
  private claudeChildren: ClaudeChildSessionFile[] = [];
  // Whether a child discovery has answered since the provider started. Until then a catalog
  // walk holds no Claude child transcript.
  private claudeChildrenDiscovered = false;
  // Which session is on screen, by id. The panel draws one at a time, so this is the
  // whole of what the reader is looking at, and `pickShowing` keeps it standing on a live
  // session: it is null only in a workspace that has none. Restored below, so a reload
  // opens on the session the reader left.
  private showing: string | null = null;
  // Which sessions the reader has hidden, by id. Held here rather than only in the
  // panel because hiding has to happen before the list is cut to the few sessions that get
  // parsed, and that cut is made here. The panel keeps its own copy so a reload can hand it
  // back, and hiding deletes nothing: a hidden session keeps its pending changes, its
  // baselines and its manifest.
  private hidden = new Set<string>();
  // Pinned session ids control rail placement independently from selected turn reads.
  private pinnedTop = new Set<string>();
  // The older pages each session has loaded past its ordinary tail, and the cursor the
  // next page starts from. Only the selected session reads a page. A session the
  // reader moved away from keeps its pages under the budget in `historypages.ts`, so
  // stepping back to it restores what was on screen without another read.
  private history = new Map<string, SessionHistory<HistoryCursor>>();
  // Child-only changes leave the parent transcript revision untouched. This stamp decides
  // when retained Codex pages need their child rows and spend projected again.
  private historyStructuralKeys = new Map<string, string>();
  // The one page read allowed to be in flight, and the generation that discards a result
  // whose session, transcript or provider moved while it ran.
  private historyRequest: { sessionId: string; controller: AbortController; generation: number } | null = null;
  private historyGeneration = 0;
  // Where the reader has been. Held here rather than in the panel because the extension is
  // the authority on which session is open, so the trail outlives the tab that made it and
  // a second panel opened beside the first walks the same one. A window reload ends the host
  // and starts a new trail from whatever session the panel opens on.
  private trail: Trail = emptyTrail();
  // What each agent last reported about the reader's own rate limits, and how much each
  // one asks before it acts. Both are handed in from `extension.ts`, which owns the
  // children that answer for them; this only draws them. Held as the readings rather than
  // as the rows, because a row carries how old its figure is and that has to be worked out
  // at the moment it is drawn.
  private usage: AgentUsage[] = [];
  private askLevels: Record<string, string> = {};
  private codexEffectiveModes: Record<string, CodexEffectiveMode> = {};
  private claudeEffectiveModes: Record<string, string> = {};
  // Blocking requests held by live children, filed by the session they belong to.
  // They are host state rather than transcript state, so they travel with the composer's
  // control payload and disappear as soon as the host accepts an answer.
  private asks: { session: string; ask: Ask }[] = [];
  // What each agent said about the models it will run, and which model and effort the
  // reader picked for each session. The catalog belongs to the installation; a pick
  // belongs to the session whose composer made it.
  private models: Record<string, ModelChoice[]> = {};
  private pendingModels: readonly string[] = [];
  private appliedDefaults = new Map<string, AppliedDefaults>();
  private appliedDefaultsRevision = 0;
  public onReadDefaults: ((agent: 'claude' | 'codex', cwd: string, model: string) => void) | null = null;
  public onWatchDefaults: ((cwds: readonly string[]) => void) | null = null;

  public setAppliedDefaults(agent: string, cwd: string, model: string, defaults: AppliedDefaults): void {
    this.appliedDefaults.set(JSON.stringify([agent, cwd, model]), defaults);
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public clearAppliedDefaults(): void {
    this.appliedDefaults.clear();
    this.appliedDefaultsRevision++;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private defaultContext(agent: string, cwd: string | null, model = ''): DefaultContext {
    if (cwd && this.onWatchDefaults) {
      const folders = new Set<string | undefined>([
        cwd,
        this.folders()[0],
        ...Object.values(this.newDrafts ?? {}).map((draft) => draft.cwd),
      ]);
      for (const session of new Set([this.showing, ...(this.hostSessions?.values() ?? [])])) {
        const row = session ? this.rowForSession(session) : null;
        if (row) folders.add(this.cwdForSession(row.agentKey, row.id) ?? undefined);
      }
      const cwds = [...folders].filter((folder): folder is string => Boolean(folder));
      for (const key of this.appliedDefaults?.keys() ?? []) {
        const [, folder] = JSON.parse(key) as string[];
        if (!cwds.includes(folder)) this.appliedDefaults.delete(key);
      }
      this.onWatchDefaults(cwds);
    }
    if (!cwd || !this.onReadDefaults || (agent !== 'claude' && agent !== 'codex')) return {};
    this.appliedDefaults ??= new Map();
    for (const value of new Set(['', model])) {
      const key = JSON.stringify([agent, cwd, value]);
      if (!this.appliedDefaults.has(key)) {
        this.appliedDefaults.set(key, LOADING_DEFAULTS);
        this.onReadDefaults?.(agent, cwd, value);
      }
    }
    const rows: Record<string, AppliedDefaults> = {};
    for (const [key, defaults] of this.appliedDefaults) {
      const [owner, folder, value] = JSON.parse(key) as string[];
      if (owner === agent && folder === cwd && value) rows[value] = defaults;
    }
    return {
      revision: this.appliedDefaultsRevision,
      base: this.appliedDefaults.get(JSON.stringify([agent, cwd, ''])),
      models: rows,
    };
  }

  private launcherDefaults(): Record<string, DefaultContext> {
    const cwd = this.folders()[0] ?? null;
    const primary = sessionLauncherView(null, this.recentProfiles ?? [], this.models ?? {}, [], {}, this.pendingModels)
      .primary?.profile;
    return {
      claude: this.defaultContext('claude', cwd, primary?.agent === 'claude' ? primary.model : ''),
      codex: this.defaultContext('codex', cwd, primary?.agent === 'codex' ? primary.model : ''),
    };
  }
  private picks: SessionSettingBook = {};
  // The commands each agent published, filed under the agent's key. Per agent rather than
  // per session: the list is what the CLI found in this folder, so every session
  // one agent holds here offers the same one, and the two agents in a folder do not.
  private commandLists: Record<string, PromptEntry[]> = {};
  // The last-seen Claude skill list for each working directory, as a normalized path key.
  // `extension.ts` owns loading, persisting, and replacing it.
  private skillLists: Record<string, readonly string[]> = {};
  // Where a Claude skill's `SKILL.md` was found on disk, keyed by the session directory a
  // command list is drawn for and the command name. Claude's own catalog carries no path, so
  // this is filled by a disk lookup the first time a name is drawn for a directory, and never
  // invalidated within a run: a `SKILL.md` a session already found does not move while the
  // panel is open, the same assumption a Codex-reported path already carries.
  private claudeSkillPaths = new Map<string, string | null>();
  // What each draft or recorded session last said about the MCP servers it can call tools on.
  // `extension.ts` owns the children that answer and files each reading by its owner.
  private mcpServers: Record<string, McpServer[]> = {};
  // What the foot's presses do. Set by `extension.ts`, because every one of them needs a
  // child and this file has none: the panel says which agent, and the caller does the rest.
  // `force` is the reader asking outright, which asks whatever the age of what is on screen
  // and clears an agent marked silent. Carried from the press rather than worked out from
  // the agent: with it inferred, no path ever set it, and a silenced agent could not be
  // asked again for the life of the window.
  private refreshUsageHandler:
    | ((agent: string | null, force: boolean, owner?: string, ownerAgent?: string, ownerCwd?: string) => void)
    | null = null;
  private initialCatalogRefreshPending = false;
  private initialCatalogRefreshRequested = false;
  // A command the panel answered itself, and the control it opened. The control is already
  // open by the time this runs. It exists so that whatever fills the control can be asked
  // for, which always needs a child this file does not own.
  public onPanelCommand:
    | ((owner: string, agent: string, control: string, draft: NewSessionDraft | null, cwd: string | null) => void)
    | null = null;
  public onDraftRemoved: ((draft: NewSessionDraft) => void) | null = null;
  public onDraftProfileChanged: ((draft: NewSessionDraft) => void) | null = null;
  public onDraftAdopted: ((provisional: string, actual: string) => void) | null = null;
  public onSelectionChanged: ((session: string | null, agent?: AgentKind | null, cwd?: string | null) => void) | null =
    null;
  public onPanelsClosed: (() => void) | null = null;
  // What the reader picked, from the panel's own menu: which agent, which control, and the
  // value the menu carried on that row.
  public onPicked:
    | ((agent: string, session: string, control: string, value: string, model: string, cwd: string | null) => void)
    | null = null;
  // What the composer does. Sending needs a child and stopping needs the one that is
  // running, so both are passed straight out; this file only decides which of the two a
  // press means, and it asks `composerview.ts` even that.
  // The session goes with the prompt, and it is not optional. Without it the folder
  // holds one session per agent, so a prompt reaches whatever that agent last resumed
  // rather than the session the composer names above the box.
  // It answers whether the prompt reached an agent and why not, because the comments it
  // carried are taken away only on delivery and a failed card must tell the reader what to
  // resolve before a retry.
  public onSendPrompt:
    | ((
        agent: string,
        session: string,
        cwd: string | null,
        prompt: AgentPrompt,
        onSubmitted?: (session: string, turnId: number) => void,
      ) => Promise<PromptDelivery>)
    | null = null;
  private contextGenerations = new Map<string, number>();
  private contextDemands = new WeakMap<PanelHost, ContextDemand>();
  private contextRequests = new WeakMap<PanelHost, number>();
  private contextReadControllers = new Map<string, Set<AbortController>>();
  public contextSource:
    | ((agent: AgentKind, session: string) => { id: string; read(): Promise<unknown>; current(): boolean } | null)
    | null = null;
  public codexContextSource(sessionId: string): { id: string; read(): Promise<unknown>; current(): boolean } | null {
    const listed = this.catalog?.sessions.find(
      (session) => session.agent === 'codex' && session.sessionId === sessionId,
    );
    if (!listed) return null;
    const revision = () => {
      try {
        const stat = fs.statSync(listed.file);
        return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
      } catch {
        return null;
      }
    };
    const captured = revision();
    if (!captured) return null;
    const key = JSON.stringify(captured);
    return {
      id: crypto.createHash('sha256').update(listed.file).update(key).digest('hex'),
      current: () => JSON.stringify(revision()) === key,
      read: async () => {
        this.contextReadControllers ??= new Map();
        const controller = new AbortController();
        let controllers = this.contextReadControllers.get(sessionId);
        if (!controllers) {
          controllers = new Set();
          this.contextReadControllers.set(sessionId, controllers);
        }
        controllers.add(controller);
        const deadline = setTimeout(() => controller.abort(), 5000);
        try {
          const result = await this.progressiveWorker.run(
            { kind: 'codex-context', session: { ...listed, ...captured } },
            0,
            controller.signal,
          );
          return result?.value.kind === 'codex-context' ? result.value.estimate : null;
        } finally {
          clearTimeout(deadline);
          controllers.delete(controller);
          if (!controllers.size && this.contextReadControllers.get(sessionId) === controllers)
            this.contextReadControllers.delete(sessionId);
        }
      },
    };
  }
  public invalidateContext(session: string): void {
    for (const controller of this.contextReadControllers?.get(session) ?? []) controller.abort();
    this.contextGenerations ??= new Map();
    this.contextGenerations.set(session, (this.contextGenerations.get(session) ?? 0) + 1);
  }
  private async requestContext(host: PanelHost, session: string, request: number, generation: number): Promise<void> {
    if (
      (this.hostSessions.get(host) ?? this.showing) !== session ||
      generation !== (this.contextGenerations?.get(session) ?? 0)
    )
      return;
    const state = this.stateFor(session);
    if (!state) return;
    this.contextRequests.set(host, request);
    const aggregate = JSON.stringify(state.context);
    const model = state.settings.selectedModel || state.settings.confirmedModel || '';
    const source = this.contextSource?.(state.agent, session) ?? null;
    const identity: ContextIdentity = {
      session,
      request,
      generation,
      model,
      provider: state.agent,
      source: source?.id ?? '',
    };
    let demand = this.contextDemands.get(host);
    if (!demand) {
      demand = new ContextDemand();
      this.contextDemands.set(host, demand);
    }
    const current = () => {
      const now = this.stateFor(session);
      return (
        generation === (this.contextGenerations?.get(session) ?? 0) &&
        (this.hostSessions.get(host) ?? this.showing) === session &&
        !!now &&
        JSON.stringify(now.context) === aggregate &&
        (now.settings.selectedModel || now.settings.confirmedModel || '') === model &&
        (!source || source.current())
      );
    };
    const detail = source
      ? await demand.read(
          identity,
          JSON.stringify({ ...identity, request: 0, aggregate }),
          () => source.read(),
          current,
        )
      : unavailableContext(identity);
    if (!current() || detail.status === 'stale' || this.contextRequests.get(host) !== request) return;
    const reply = { ...detail, request };
    await this.sendToHost(host, {
      type: 'contextDetail',
      detail: validContextDetail(reply) ? reply : unavailableContext({ ...identity, model: '', source: '' }),
    });
  }
  public onCompact: ((agent: string, session: string, cwd: string | null) => Promise<PromptDelivery>) | null = null;
  // Renames a session through its agent. It resolves only once the agent confirmed the
  // saved name, and it rejects with the reason the reader reads otherwise. The folder is the
  // one the session recorded, or null.
  public onRenameSession:
    | ((agent: AgentKind, session: string, cwd: string | null, title: string, file: string) => Promise<void>)
    | null = null;
  public onClear:
    | ((agent: string, session: string, cwd: string | null, name: string) => Promise<PromptDelivery>)
    | null = null;
  public onSendDraftPrompt:
    | ((
        draft: NewSessionDraft,
        prompt: AgentPrompt,
        onSubmitted?: (session: string, turnId: number) => void,
      ) => Promise<PromptDelivery>)
    | null = null;
  public setupProject: string | null = null;
  public onSetupRefresh: (() => void) | null = null;
  private setupOwner?: string;
  public readPinnedSetups: ((project?: string | null) => unknown | Promise<unknown>) | null = null;
  public persistPinnedSetups: ((setups: readonly PinnedSetup[], project?: string | null) => Promise<void>) | null =
    null;
  public onSessionSettingsAdopted: ((session: string, settings: SessionSettingSelection) => void) | null = null;
  public onStopTurn: ((agent: string, session: string) => void) | null = null;
  public onAnswerAsk: ((session: string, id: string, answer: AskAnswer) => boolean) | null = null;
  public onArchivedSessionsChange: ((sessions: ReadonlySet<string>) => void) | null = null;
  public archivedSessions(): ReadonlySet<string> {
    return new Set(this.hidden);
  }
  // What the reader has typed and what they have queued, per session, so switching
  // sessions never carries a half-written prompt into the wrong one. The draft is held
  // here rather than in the panel because whether the send control is pressable is decided
  // in `composerview.ts`, and a decision cannot be made from a value only the panel has.
  // It survives a reload as well as a change of session. The prompts ride in the
  // panel's stored state, seeded from there in the constructor and written back through
  // `rememberDrafts`, because a half-written prompt is words the reader typed and closing a
  // window is not always a choice.
  private drafts: Record<string, string> = {};
  private assets: Record<string, StoredPromptAsset[]> = {};
  private attachmentNotices: Record<string, string> = {};
  private staging = new Set<string>();
  private stagingTokens = new Map<string, string>();
  private stagingOperations = new Map<string, PromptAssetStagingOperation>();
  private browserStagingOwners = new Map<string, PanelHost>();
  private assetHandoffs = new Set<string>();
  private assetIdsInHandoff = new Set<string>();
  private assetCompletions = new PromptAssetCompletionBook();
  private sessionAliases = new Map<string, SessionAlias>();
  private queuedEditOffers = new Map<PanelHost, QueuedEditOffer>();
  private queuedEditReservations = new Set<string>();
  private deferredAssetDeletes: Record<string, { turnId: number | null; assets: StoredPromptAsset[] }[]> = {};
  private completedAssetTurns = new Set<number>();
  // A draft exists only in this window until its first accepted prompt gives it an actual id.
  // Opening Servers can start its provisional Claude child without creating a transcript.
  private newDrafts: Record<string, NewSessionDraft> = {};
  // The CLI can name a started session before its transcript or rollout is discoverable.
  // Keep a synthetic row under the actual id through that gap so refresh cannot discard the
  // selected session. This is separate from newDrafts because another send must resume
  // the started child rather than start a second fresh session.
  private awaitingSessionRecords: Record<string, AwaitingSessionRecord> = {};
  // The sessions this workspace started from the panel, by the ids the CLIs gave them.
  // A fresh session reads exactly like a run another agent shelled out for, so this is
  // the positive fact `agentRunFor` answers with. It is stored beside the notes and the
  // unsent prompts, because the transcript it argues with does not become any more readable
  // with age, and a reload would file the reader's own session under Run by agents.
  private startedHere = new Set<string>();
  private draftProfiles: Record<string, SessionProfile> = {};
  private sessionOrigins: Record<string, DraftOrigin> = {};
  private recentProfiles: SessionProfile[] = [];
  private pinnedSetups: PinnedSetup[] = [];
  private pinnedSetupWrites: Promise<unknown> = Promise.resolve();
  // The wait before the drafts reach storage. Set on the first keystroke of a burst and
  // never reset by the ones after it, so a reader holding a key down writes once a second
  // rather than once a letter, and the letter they stopped on is still what gets written.
  private draftSave: ReturnType<typeof setTimeout> | null = null;
  private queues: Record<string, QueuedSubmission[]> = {};
  private draftCommentIds: Record<string, string[]> = {};
  private queueHandoffs = new Set<string>();
  // Queues restored from storage or paused while their session is outside repository
  // scope. Each gets one drain attempt after its row and handoff callback are available.
  private pendingQueueDrains = new Set<string>();
  // What this panel has submitted in each session, newest first, so the Up arrow can
  // offer the prompt just sent. Claude Code writes a queued prompt to the file when the
  // agent picks it up rather than when it is sent, so the transcript answer arrives up to a
  // minute late, and that gap covers the commonest recall there is.
  //
  // Not stored, and not the whole history either. The transcript is the record and `collect`
  // reads it back. This holds only what the record does not have yet.
  private sentPrompts: Record<string, string[]> = {};
  // What the box on screen holds for each session, which is the copy the send control
  // reads. It differs from the stored draft only while the reader walks back through earlier
  // prompts, and it is not written to storage: a reload starts from the stored draft.
  private boxText: Record<string, string> = {};
  // The Send revision of each typed Codex `/rename` still waiting on its answer, while the
  // box has stayed as that Send left it. A refused rename puts its line back only then.
  private typedRenames = new Map<string, number>();
  // The presses each session is still waiting on, oldest first, kept from the press
  // until the transcript catches up. Per session for the reason `LivePress` gives: one
  // agent runs several at once, and a press filed under the agent draws its card over the
  // wrong one. More than one only while a prompt waits behind a compaction; `pressesAfter`
  // is the rule for what the list becomes.
  private live: Record<string, LivePress[]> = {};
  // A clear is complete only after the agent accepts it and names its successor. Claude
  // reports those in separate events. Codex names the successor before its request resolves.
  // Keeping this outside `live` prevents a command-only operation from drawing a turn card.
  private clearSettlements = new Map<string, ClearSettlement>();
  // A browser can submit with the source id until it paints the successor. Route only that
  // browser during the gap, then release the source so the reader can reopen it normally.
  private clearRoutes = new Map<string, ClearRoute>();
  // Activity received directly from children, held until the transcript records the same
  // source ids. This is separate from `live`, which holds the reader's outgoing prompts and
  // streamed final response.
  private liveActivity: Record<string, HeldActivity[]> = {};
  private activityPost: ReturnType<typeof setTimeout> | null = null;
  private activitySessions = new Set<string>();
  // The wait before a streamed reply is sent on, so a turn's chunks reach the panel as a
  // handful of messages a second rather than as one per word.
  private replyPost: ReturnType<typeof setTimeout> | null = null;
  // One watcher per directory a transcript is written to, so an append wakes the panel in
  // step with the agent rather than at the next poll.
  private watchers = new Map<string, fs.FSWatcher>();
  private readonly pendingWatch = new PendingWatcherWake();
  private readonly watchScheduler: BoundedTrailingScheduler;
  private refreshReason = 'direct';
  private targetedRefreshPaths: string[] | null = null;
  private watching = false;
  // The sessions with a turn in flight, told by `extension.ts`, which owns the children.
  // Named by session rather than by agent, as `runningKey` spells it.
  private running = new Set<string>();
  // When each of those sessions became busy, under the same keys. The rail bounds a busy
  // claim against it, so a child that keeps calling itself busy after its work is recorded as
  // over stops answering for the card. See `sessionStatusOf`.
  private runningSinceKeys = new Map<string, number>();
  // When each hosted session's process last exited, under the same keys. A key stays after
  // the host forgets the process until its session leaves the listing. The rail reads it only
  // against a turn that began before the exit, so a session resumed later is not held by an
  // old exit. `exitedNow` holds the keys the host last reported exited, so a second exit
  // after a resume replaces the first.
  private exitedSinceKeys = new Map<string, number>();
  private exitedNow = new Set<string>();
  // The write time of each Claude child transcript, by file, as `claudeChildRevisions`
  // last read it. The rail reads it to tell a live open child from a dead one. A file leaves
  // it when child discovery no longer references it.
  private claudeChildStatWrites = new Map<string, number>();
  // The live open children the cards were last built against, as `openChildrenKey` spells
  // them. A child that goes quiet moves this with no file change, so the refresh compares it.
  private drawnOpenChildren = '';
  // Which agents gained a finished turn, told once per parse.
  //
  // The status bar is otherwise fed only by a child this window started, and the turns the
  // reader watches mostly come from a terminal. So the figure would move on the press and
  // at no other time. The parse is the one moment the panel knows a turn has ended for an
  // agent it has no child for, which is exactly when the figure has changed.
  public onTurnsFinished: ((agents: string[]) => void) | null = null;
  // Every turn the last parse produced, as the little the refresh rule needs of one, and
  // the ids already counted. The set is what makes a turn count once: an unfinished turn
  // is left out of both, so it counts on the parse that finds it finished.
  private turnMarks: TurnMark[] = [];
  private seenTurns: ReadonlySet<string> = new Set<string>();
  // The newest turn in each session, by session id. What the composer's window figure
  // is kept apart from, because an empty failed turn still owns the newest card and outcome.
  private newestBySession = new Map<string, Turn>();
  // The latest usable runtime fact for each Composer field. These are projected from the
  // accepted window without replacing the newest turn used by every timeline consumer.
  private composerRuntime = new Map<string, ComposerRuntimeFacts>();
  // What the reader typed in each session, newest first, taken from the turns the last
  // parse produced. It is what the Up arrow walks back through, so it survives a reload and
  // carries prompts written in a terminal. `promptsAcross` bounds it as it is built, since
  // a parse can produce far more turns than an arrow key reaches.
  private promptsBySession = new Map<string, string[]>();
  // The clock the cards were last built against. A turn's status can move on the clock alone,
  // so the refresh compares that reading with this one; see `statusMoved` below.
  private collectedAt = 0;
  // The newest compaction in each session, by session id. Its timestamp takes a live
  // card down, while its resulting context decides whether the composer has a current level.
  private newestCompactionBySession = new Map<string, Compaction>();
  private cards: RenderCard[] = [];
  // The selected read's actual reach and whether its parser discarded an older turn. The
  // sentinel must answer for the one session on screen, not other retained windows.
  // `loadedTurns` counts the ordinary tail and every retained older page together, which is
  // the scope the sentinel reports and the reader can see.
  private readWindows = new Map<
    string,
    {
      readBytes: number;
      turnLimitReached: boolean;
      loadedTurns: number;
    }
  >();
  // Turn references from the selected window, before the card budget limits its payload.
  // Performance diagnostics use these references. Rail unread counts use independent turn starts.
  private parsedRefs: { key: string; sessionId: string; startedAt: number; kind: string }[] = [];
  // The turn behind each card, by the card's own key. A card carries only what it draws,
  // and a turn's diff needs the recorded patches. These are references into `cache`, so
  // the map itself costs nothing.
  private turnsByKey = new Map<string, Turn>();
  // What each session came to, by session id. Worked out in `turnview.ts` over the
  // turns that were read, so the panel draws figures rather than working them out: a sum
  // written inside `SCRIPT` is the one kind of code in this repo nothing can check.
  private statsBySession: Record<string, SessionStatChip[]> = {};
  // Figures recovered from each file's bounded metadata tail. Accepted window facts replace
  // these where available. Other rail rows need no selected-window read.
  // Read-only for the session rows' reason.
  private metadataStatsBySession: Readonly<Record<string, readonly Readonly<SessionStatChip>[]>> = {};
  // The figures and cache marks above, held against each session's metadata facts, so a refresh
  // derives them again only for the sessions whose facts changed. The facts are read-only for the
  // session rows' reason.
  private readonly metadataStatFigures = new SessionFactFigures<HeldStatFacts, readonly Readonly<SessionStatChip>[]>();
  private readonly metadataCacheFigures = new SessionFactFigures<HeldStatFacts, ReturnType<typeof railCacheMarkOf>>();
  private parsedRailCaches: Record<string, RevisionedRailCacheMark> = {};
  private metadataRailCaches: Readonly<Record<string, ReturnType<typeof railCacheMarkOf>>> = {};
  private railSourceRevisions: Record<string, Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>> = {};
  // The sessions the last render listed, in the shape the rail reads. Kept so a change of
  // the read set can reword it without listing anything again. `at` and `relative` are the
  // session's last activity for the heading; the unread count is the rail's own, read off
  // `counts` fresh rather than carried on this row.
  // Read-only, because a rail post holds the rows by identity: a row edited in place would
  // leave the panel on a stale rail. Replace the list to change it.
  private sessionRows: readonly Readonly<{
    id: string;
    persisted: boolean;
    label: string;
    railName?: string;
    agent: string;
    agentKey: AgentKind;
    when: string;
    shown: boolean;
    at: number;
    relative: string;
    agentRun: boolean;
  }>[] = [];
  // The order the current set of hosts first drew the rail in. Kept apart from sessionRows,
  // whose newest-activity order decides the default session and
  // the picker. Each refresh reconciles this list against those rows, so activity changes
  // update a card in place and newly found sessions join at the foot of their bucket.
  private railOrder: string[] = [];
  // The latest delivery that carried the rail, and its largest serialized message across
  // ready hosts. Complete renders can differ by host, while rail-only updates reuse one string.
  private lastRailMessageType: 'render' | 'rail' | null = null;
  private lastRailMessageSerializedBytes: number | null = null;
  private lastRailAdoptionsJson = '';
  // Rail-owned state advances this value before it asks for a post. The last settled value
  // lets a repeat request leave before it gathers the remaining payload inputs.
  private railRevision = 0;
  private lastRailRevision = -1;
  private lastRailDay = '';
  private lastRailCountsJson = '';
  // What that rail was worded from, the clock's day included. A rail post whose inputs match
  // it leaves before wording the rail.
  private lastRailKey: RailInputKey | null = null;
  // The dispatched-source answers the figures in that rail were read with. A selection render
  // reads the figures too, so the cache's own last answers can move past what the rail drew.
  private railPendingAnswers: SpendPendingAnswers | null = null;
  // The selection whose render still owes the rail, and whether a read save has chosen to
  // ride on it. A save skips its own rail only while that render is still coming, and the
  // settle below posts one if the render never did.
  private railSeedOwedFor: number | null = null;
  private railSeedSkipped = false;
  private sessionOutcomes = new Map<string, TurnOutcome | null>();
  // Selection-independent turn starts, projected from accepted metadata and lifetime facts.
  private windows = new Map<string, TurnStarts>();
  // Every turn in the workspace, reduced to what a reader would search: an id, where it came
  // from, when, and the prompt and the summary. Held per session and keyed on the file's
  // mtime, so a second search re-reads only what has moved, which while a turn is running is
  // one file.
  //
  // Small on purpose. Measured on this machine: 32 MB of transcript in this workspace comes to
  // 308 KB here, and the largest project, 642 MB across 107 files, comes to 4.5 MB. A
  // transcript is almost entirely tool results and none of them are in this.
  private corpus = new Map<string, { mtimeMs: number; size: number; entries: SearchEntry[] }>();
  private disposables: vscode.Disposable[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastSignature = '';
  private lastSpendSourceSignature = '';
  // The held catalog and the folders it was walked for. Read only by a refresh that says a
  // selection drove it, and overwritten by every refresh that walks, so the newest it can
  // ever be is one refresh old. The poll and the transcript watchers both walk, which bounds
  // how stale a click can find it without anything having to invalidate it.
  private catalog: { folders: string; sessions: SessionFile[] } | null = null;
  // The existing-session list from the last payload that completed discovery and required
  // metadata. A working catalog can move while that work is still in flight. Local drafts
  // compose with this accepted list, or with no existing rows before the first publication.
  private authoritativeCatalog: SessionFile[] | null = null;
  // Whether the last listing walked the filesystem or reused the held catalog. The
  // Project cost offer needs the answer, because it trusts a listed revision in place of
  // stating the file and only a walk read every one of them.
  private catalogWalked = true;
  // One side of one file's turn diff, keyed by the URI it opens under. In the order it was
  // written, so the panel can drop what it wrote longest ago once it is over budget.
  readonly patches = new Map<string, string>();
  private patchBytes = 0;
  // The reader's own file icons. Read on first use and kept, because a file row is drawn
  // every few seconds and the theme changes about once a year.
  private icons = new IconThemeSource();
  private projectSpendWorkspace: string | null = null;
  // The workspace identity is available for the first render. Its persisted ledger is not
  // restored until that render has reached every ready host.
  private projectSpendHydrated = false;
  private projectSpendHydrationReady = false;
  private projectSpendHydrationTick: ReturnType<typeof setTimeout> | null = null;
  // The broad source check is an integrity pass, not a poll. A moved listing offers its
  // sources immediately; this clock catches child files and missed watcher events without
  // statting every spend source every few seconds while the workspace is quiet.
  private projectSpendLastOfferAt = 0;
  private projectSpendRevision = 0;
  private lifetimeFigures = new SessionFiguresCache<SessionHeldFigures, LifetimeFigures>();
  private projectSpendFiles: SpendFileIndex[] = [];
  private projectSpendVisibleFiles: SpendFileIndex[] = [];
  private projectSpendQueue: { file: string; agent: AgentKind; primary?: boolean }[] = [];
  private projectSpendQueued = new Set<string>();
  private projectSpendTick: ReturnType<typeof setTimeout> | null = null;
  private readonly projectSpendOffers = new Set<ReturnType<typeof setTimeout>>();
  private projectSpendMidnight: ReturnType<typeof setTimeout> | null = null;
  private readonly projectSpendSaveScheduler: BoundedTrailingScheduler;
  private projectSpendSaveOwed = false;
  // When the oldest change the saved ledger lacks was made, kept across failed saves.
  private projectSpendSaveOwedSince: number | null = null;
  private projectSpendSaveRetry: ReturnType<typeof setTimeout> | null = null;
  private projectSpendSaveRetries = 0;
  private projectSpendRailOwed = false;
  private projectSpendIndexing = false;
  private projectSpendCostQueue: string[] | null = null;
  // Every counted operation goes to the diagnostics log as well as to the counters, so the
  // log reports what the snapshot reports without a second measurement. The counters ask the
  // log whether it reads anything before they build a record.
  private readonly performanceCounters = new PanelPerformanceCounters(Date.now(), this.performanceSink());
  private readonly startupThresholds = new StartupThresholdWatch();
  // When the panel began loading, on the clock the startup milestones read. A milestone
  // carries `performance.now()`, which counts from the extension host process and is as old
  // as the editor window, so the startup threshold subtracts this.
  private panelStartedAt: number | null = null;
  private startupHistory?: StartupHistory;
  private startupCache: Record<string, unknown> = {};
  private startupArtifact: unknown = { unavailable: true };
  private startupProgressAt = 0;
  private startupProgressSequence = 0;
  private startupFailureGeneration = -1;
  private startupLoadingSent = '';
  private readonly warnedMessageBudgets = new Set<string>();
  private performanceOutput: vscode.OutputChannel | null = null;

  // What the panel last remembered, shared by every host. Held here as well as written to
  // the memento so a host attaching mid-session gets the live answer rather than the one on
  // disk, which is the same reason the hidden set is held here.
  private saved: PanelState = normalizePanelState(null);

  constructor(
    private storeRootDir: string,
    private extensionUri: vscode.Uri,
    private memento?: vscode.Memento,
    private projectSpendStorageDir?: string,
    private derivedCacheFile?: string,
    private codexOpeningsFile?: string,
    private attachmentStorageDir?: string,
    performanceOutput?: vscode.OutputChannel,
    private readonly diagnostics: DiagnosticsLog = silentDiagnosticsLog(),
    private readonly workspaceCache?: WorkspaceCachePartition,
    activationAt = performance.now(),
    startupDirectory?: string,
  ) {
    this.performanceOutput = performanceOutput ?? null;
    this.repositoryScope = new RepositoryScope(nodeGitRunner(), () => {
      // A catalog listed under the previous roots cannot render the current scope.
      this.earlySelectedSources.clear();
      for (const work of this.selectionWorks.values()) work.controller.abort();
      this.selectionWorks.clear();
      this.selectionWork?.controller.abort();
      this.selectionWork = null;
      this.abandonCatalogRefresh();
      this.refreshFrom('repository-scope', true);
    });
    this.watchScheduler = new BoundedTrailingScheduler(TRANSCRIPT_WAKE_MS, TRANSCRIPT_WAKE_MAX_MS, (event) =>
      this.runPendingWatch(event),
    );
    this.projectSpendSaveScheduler = this.newProjectSpendSaveScheduler();
    const cached = this.derivedCacheFile ? loadDerivedCache(this.derivedCacheFile) : null;
    if (cached) {
      this.titles = cached.titles;
      this.claudeChildReferenceEntries = cached.claudeChildReferences;
      this.discoveryCheckpoint = cached.discovery;
      this.carriedNames = cached.carriedNames;
    }
    this.startupCache = {
      file: this.derivedCacheFile ?? null,
      generation: DERIVED_CACHE_VERSION,
      relationshipGeneration: CLAUDE_CHILD_REFERENCE_PARSER_VERSION,
      reuse: cached?.reuse ?? { reason: 'unconfigured' },
      loadedTitles: cached?.titles.size ?? 0,
      loadedRelationships: cached?.claudeChildReferences.size ?? 0,
    };
    if (startupDirectory)
      this.startupHistory = new StartupHistory(
        startupDirectory,
        () => ({
          workspaceRoots: this.repositoryScopeRoots,
          selectedSession: this.showing,
          cache: this.startupCache,
          artifact: this.startupArtifact,
          counters: this.performanceCounters.snapshot(),
          workerTransport: {
            ...this.progressiveWorker.transport,
            byteScope: this.diagnostics.enabled() ? 'JSON content proxy, not native transport bytes' : 'not measured',
          },
          knownSources: this.claudeParents?.length ?? 0,
          representedSourceBytes: this.claudeParents?.reduce((sum, row) => sum + row.size, 0) ?? 0,
        }),
        undefined,
        activationAt,
      );
    if (startupDirectory && this.extensionUri.fsPath)
      void readStartupArtifact(path.join(this.extensionUri.fsPath, 'dist')).then((identity) => {
        this.startupArtifact = identity;
      });
    if (this.codexOpeningsFile) {
      const openings = codexOpeningsAtStartup(this.codexOpeningsFile, cached?.codexMetas);
      this.codexMetas.load(openings.rows);
      this.codexOpenings = new CodexOpeningsWriter(this.codexOpeningsFile, this.codexMetas, openings.seeded);
      // A seed owes the shared file a save even when the first walk reads nothing new.
      if (openings.seeded) {
        this.derivedCacheCheckpointState.markChanged(true);
      }
    }
    const stored =
      process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1' && process.env[MEASUREMENT_ENVIRONMENT.state]
        ? JSON.parse(fs.readFileSync(process.env[MEASUREMENT_ENVIRONMENT.state]!, 'utf8'))
        : this.memento?.get(STATE_KEY);
    // The labels of every session that never got an id of its own, dropped, and dropped
    // before the record is normalized.
    //
    // A session the panel starts is filed under a provisional id held in memory alone,
    // so every entry under one belongs to a window that has gone. Swept here, where the
    // stored record is first read, and nowhere else: normalization runs on every write, and a
    // draft the reader is looking at right now has to keep the label they just put on it.
    // `withSweptDraftLabels` carries why the sweep runs first.
    this.saved = normalizePanelState(withSweptDraftLabels(stored));
    // The first time this workspace draws the panel, everything already in it counts as
    // read. A reader opening a project is handed every turn every agent has ever run there
    // otherwise, all of it unread, and the panel's one job is saying what is new.
    //
    // Stamped from the absence of stored state rather than from the floor being zero, so a
    // reader who was here before the floor existed keeps the read state they built and is
    // not handed a floor that would hide turns they had left unread on purpose.
    //
    // Written at once rather than left for the first press. Every other save here rides one:
    // a reader who opens a project, looks, and presses nothing would leave the floor
    // unwritten, so the next window stamps a later one and every turn that ran in between
    // falls under it, counted read and never offered. That is this field's own harm, pointed
    // the other way.
    if (stored === undefined) {
      this.saved.since = Date.now();
      void this.memento?.update(STATE_KEY, this.saved);
    }
    // Restore rail visibility before the first payload. The panel also posts its saved state on load.
    this.hidden = new Set(this.saved.hidden);
    this.pinnedTop = new Set(this.saved.pinnedTop);
    // Restore the selected session before a ready host requests its first window.
    this.showing = this.saved.showing || null;
    // The prompts the reader had typed and not sent, back where they were typed. Copied
    // rather than aliased: the live record is written on every keystroke, and the stored one
    // must move only when `rememberDrafts` says so.
    this.drafts = { ...this.saved.drafts };
    // The prompts a reload could otherwise lose: sent from this panel, and not yet caught
    // up with by any transcript on disk. Copied for the reason the drafts are.
    this.sentPrompts = restoredSentPrompts(this.saved);
    // Restore sessions started here before metadata classifies their agent runs.
    this.startedHere = new Set(this.saved.started);
    this.assets = normalizePromptAssetBook(this.saved.assets);
    this.queues = normalizeQueuedSubmissions(this.saved.queues);
    this.draftCommentIds = normalizeDraftCommentIds(this.saved.draftCommentIds);
    this.pendingQueueDrains = new Set(Object.keys(this.queues));
    this.wireEditorListeners();
  }

  dispose(): void {
    if (this.disposed) return;
    const finish = () => {
      this.cacheShutdownFlushing = true;
      try {
        this.disposeOwned();
      } finally {
        this.cacheShutdownFlushing = false;
      }
    };
    if (this.workspaceCache) this.workspaceCache.close(finish);
    else finish();
  }

  private cacheShutdownFlushing = false;

  private disposeOwned(): void {
    this.startupHistory?.dispose();
    this.disposed = true;
    for (const controller of this.attachmentHandoffs) controller.abort();
    this.attachmentHandoffs.clear();
    this.onPanelsClosed?.();
    this.abandonCatalogRefresh();
    this.selectionWork?.controller.abort();
    this.selectionWork = null;
    this.metadataRecoverySession = null;
    for (const work of this.selectionWorks?.values() ?? []) work.controller.abort();
    this.selectionWorks?.clear();
    this.earlySelectedSources?.clear();
    this.responseSnapshots?.clear();
    this.pendingResponsePosts?.clear();
    for (const turnId of this.pendingResponseOwners?.keys() ?? []) this.forgetPendingResponses(turnId);
    this.metadataRecoveryQueue = [];
    this.progressiveWorker.stop();
    this.readyHosts.clear();
    this.panelVisibility?.clear();
    this.initialCatalogRefreshPending = false;
    this.stopPolling();
    this.repositoryScope.dispose();
    // A page read outlives the provider unless it is stopped, and its result would commit
    // state onto a disposed panel.
    this.historyRequest?.controller.abort();
    this.historyRequest = null;
    this.history.clear();
    if (this.replyPost) {
      clearTimeout(this.replyPost);
      this.replyPost = null;
    }
    if (this.activityPost) {
      clearTimeout(this.activityPost);
      this.activityPost = null;
    }
    this.activitySessions.clear();
    if (this.projectSpendTick) {
      clearTimeout(this.projectSpendTick);
      this.projectSpendTick = null;
    }
    if (this.projectSpendMidnight) {
      clearTimeout(this.projectSpendMidnight);
      this.projectSpendMidnight = null;
    }
    this.cancelProjectSpendHydration();
    this.cancelProjectSpendOffers();
    this.flushProjectSpendSave();
    this.cancelProjectSpendSaveRetry();
    // Whatever the wait was still holding. Without it the last second of typing before a
    // window closes is the second that never reaches storage, which is the one the reader
    // would miss.
    if (this.draftSave) {
      clearTimeout(this.draftSave);
      this.draftSave = null;
      void this.writeDrafts();
    }
    if (this.derivedCacheCheckpointTick) {
      clearTimeout(this.derivedCacheCheckpointTick);
      this.derivedCacheCheckpointTick = null;
    }
    if (this.derivedCacheCheckpointState.dirty && this.writeDerivedCache()) {
      this.derivedCacheCheckpointState.markSaved(Date.now());
    }
    this.codexOpenings?.dispose();
    this.performanceOutput?.dispose();
    this.performanceOutput = null;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // The store's trigger file fires once per turn end, which is not enough on its own: it
  // lives outside the workspace, and a turn that is still running never fires it at all.
  // While the panel is on screen it therefore also looks for itself. The check is a stat
  // per session file, and a render is posted only when one of them has actually moved.
  private startPolling(): void {
    this.watching = true;
    if (this.poll) {
      return;
    }
    this.poll = setInterval(() => this.refreshFrom('poll'), POLL_INTERVAL_MILLISECONDS);
  }

  // A hidden panel opens no watcher, so nothing reports a rollout write while it waits. The
  // held stats go with the poll, and the next reader stats each rollout itself.
  private stopPolling(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.watching = false;
    this.codexStats.clear();
    this.watchDirectories([]);
    this.watchScheduler.cancel();
    this.pendingWatch.clear();
    this.pendingWatch.clear();
  }

  // Watches exactly the directories named, and nothing else. Called after every listing, so
  // a session started in a directory nobody was watching is picked up on the next read.
  //
  // The poll stays. It covers what a watcher does not see: a file written across a network
  // share or by a sync client, and the stretch between the panel coming back on screen and
  // the first append after it. What the watcher adds is the wait: five seconds becomes a
  // fifth of one, which is the difference between a card that appears and a card that has
  // already appeared. A Codex rollout idle beyond `CODEX_STAT_ACTIVE_MS` reuses its held stat,
  // so the poll sees an unreported write to it only once that stat reaches
  // `CODEX_STAT_REVALIDATE_MS`.
  //
  // A closed watcher reports nothing more, so closing one clears the held rollout stats.
  private watchDirectories(dirs: string[]): void {
    for (const [dir, watcher] of this.watchers) {
      if (dirs.includes(dir)) {
        continue;
      }
      try {
        watcher.close();
      } catch {
        /* already gone with its directory */
      }
      this.watchers.delete(dir);
      this.codexStats.clear();
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) {
        continue;
      }
      try {
        const watcher = fs.watch(dir, { persistent: false }, (kind, name) => {
          this.wakeFromWatch(dir, kind, name);
        });
        // A watched directory can be removed underneath the handle, and on Windows the
        // handle then errors rather than closing. Left in the map it is a watcher that
        // has stopped reporting, which is worse than none: the panel would be back on the
        // poll with nothing saying so.
        watcher.on('error', () => {
          try {
            watcher.close();
          } catch {
            /* nothing left to close */
          }
          this.watchers.delete(dir);
          this.codexStats.clear();
          if (this.watching) {
            this.pendingWatch.requireBroad('transcript');
            this.watchScheduler.offer();
          }
        });
        this.watchers.set(dir, watcher);
      } catch {
        /* the directory went between the listing and here */
      }
    }
  }

  // One read per burst of appends. Both CLIs write a turn a message at a time, so the
  // events arrive in pairs and clusters, and reading on each one would parse the same file
  // several times to learn the same thing.
  private wakeFromWatch(directory: string, kind: string, filename: unknown): void {
    if (!this.watching) {
      return;
    }
    this.codexStats.markChanged(directory, filename);
    if (!this.pendingWatch.noteFileEvent(directory, filename, kind, normalizeFsPath)) {
      return;
    }
    this.watchScheduler.offer();
  }

  private wakeFromActivityFallback(): void {
    this.pendingWatch.requireBroad('activity-fallback');
    this.watchScheduler.offer();
  }

  private runPendingWatch(event: ScheduledRun): void {
    const batch = this.pendingWatch.take();
    const known = new Set((this.catalog?.sessions ?? []).map((session) => normalizeFsPath(session.file)));
    const decision = watcherRefreshDecision(batch, (file) => known.has(normalizeFsPath(file)));
    const reason = batch.reasons.length ? batch.reasons.join('+') : 'watcher';
    const started = performance.now();
    this.refreshFrom(
      reason,
      batch.reasons.includes('activity-fallback'),
      false,
      decision.kind === 'targeted' ? decision.changedPaths : null,
    );
    this.performanceCounters.recordWatcherOperation({
      reason,
      eventCount: batch.eventCount,
      distinctPathCount: batch.changedPaths.length,
      waitMs: Math.max(0, event.firedAt - event.firstAt),
      maximumWaitFired: event.cause === 'maximum',
      decision: this.catalogWalked ? 'broad' : decision.kind,
      durationMs: performance.now() - started,
    });
  }

  // Open the panel as a tab in the editor area, or bring the one that is already open
  // back to the front. One tab at most: a second copy of the same list is nothing to read
  // and everything to keep in step.
  openInEditor(column: vscode.ViewColumn = vscode.ViewColumn.Active, origin: PanelOrigin = 'created'): void {
    if (this.editorPanel) {
      // Nothing is adopted here, and the panel on screen keeps the origin it was adopted under.
      // `origin` names the panel this call would have made, so the line carries the origin of the
      // panel being revealed instead. A reveal of a restored panel recorded as `created` reads as
      // an open that never happened.
      this.diagnostics.log('panelRevealed', { origin: this.editorPanelOrigin });
      this.editorPanel.reveal(column);
      return;
    }
    // A tab restored after a window reload is not built until the reader looks at it, so this
    // can run while a restored one still waits in a background group. That is the one way a
    // second panel gets made, and the guards in `adoptPanel` are what stop the older of the
    // two from clearing the pointer to the newer one when it closes.
    const panel = vscode.window.createWebviewPanel(
      // The find widget is the editor's own, and it is the only way the reader can search
      // what is on screen: a webview takes Ctrl or Cmd with F for the editor before the page
      // sees it, so the browser's find never runs. The rail's box filters sessions and
      // `find:` searches transcripts, and neither one searches the words in front of the
      // reader.
      PANEL_TYPE,
      PANEL_TITLE,
      column,
      PANEL_OPTIONS,
    );
    this.adoptPanel(panel, origin);
  }

  showProjectSpend(): void {
    if (!this.anyVisible()) {
      this.openInEditor();
    }
    void this.post({ type: 'focusProjectSpend' });
  }

  // The first panel of this host process, on the milestone clock. A second panel opened later
  // joins the start the first one recorded, because the milestones are recorded once for the
  // whole host process.
  private notePanelStart(): void {
    this.panelStartedAt ??= performance.now();
    this.startupHistory?.stage('panelOpened', this.panelStartedAt);
  }

  // What the counters hand each counted operation to. They ask `enabled` before they build a
  // record, so a log that is off costs one call to a function that returns false.
  private performanceSink(): PerformanceEventSink {
    return {
      enabled: () => this.diagnostics.enabled(),
      emit: (event, record) => this.routePerformanceEvent(event, record),
    };
  }

  // Every counted operation, on its way to the log. The counters decide what each event is
  // called and what it carries, and the log decides whether anything reaches disk.
  //
  // A milestone the reader waited far too long for reaches them whatever the setting says. A
  // panel that took 89 seconds to draw its first card recorded every counter it has and told
  // nobody, which is the whole reason this line exists.
  private routePerformanceEvent(event: string, record: Record<string, unknown>): void {
    if (event === 'startup' && typeof record.milestone === 'string' && typeof record.elapsedMs === 'number') {
      this.startupHistory?.stage(record.milestone, record.elapsedMs);
    }
    if (event !== 'startup' || typeof record.elapsedMs !== 'number') {
      this.diagnostics.log(event, record);
      return;
    }
    // `elapsedMs` counts from the extension host process, so a panel opened an hour into an
    // editor window reports an hour. The threshold reads the time since the panel opened, and
    // the log carries both: the saved snapshot and the measurement harness read `elapsedMs`
    // as it stands.
    const startedAt = this.panelStartedAt;
    if (startedAt === null) {
      // Nothing recorded when the panel opened, so the wait the threshold reads is unknown.
      // The host-relative number is as old as the editor window, and reporting it is how the
      // reader hears that a panel opened an hour ago took an hour to draw. The milestone still
      // reaches the log, and no threshold runs against a number that means something else.
      if (this.diagnostics.enabled()) {
        this.diagnostics.log(event, record);
      }
      return;
    }
    const panelElapsedMs = Math.round(record.elapsedMs - startedAt);
    if (this.diagnostics.enabled()) {
      this.diagnostics.log(event, { ...record, panelElapsedMs });
    }
    // A milestone name the counters do not know carries no threshold, and the watch says so.
    const breach = this.startupThresholds.check(record.milestone as StartupMilestone, panelElapsedMs);
    if (!breach) {
      return;
    }
    this.diagnostics.warn('startupThreshold', {
      milestone: breach.milestone,
      elapsedMs: Math.round(breach.elapsedMs),
      hostElapsedMs: Math.round(record.elapsedMs),
      thresholdMs: breach.thresholdMs,
    });
    this.performanceOutput ??= vscode.window.createOutputChannel('Arc');
    this.performanceOutput.appendLine(breach.notice);
  }

  async openDiagnosticsLog(): Promise<void> {
    const file = this.diagnostics.file();
    if (!file) {
      void vscode.window.showInformationMessage(
        `Arc has written no diagnostics log in this window. Turn on ${settingName('diagnostics.log')} and reload the window.`,
      );
      return;
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), {
      preview: false,
      viewColumn: vscode.ViewColumn.Active,
    });
  }

  // The command answers with the file it wrote, so a caller that ran it can read the snapshot
  // back without watching a folder. `target` names that file, and the directory variable stands
  // in for it when nothing is passed.
  async savePerformanceDiagnostics(target?: string): Promise<string | null> {
    this.performanceCounters.recordCapture();
    const capturedAt = Date.now();
    const snapshot = this.performanceDiagnostics(capturedAt);
    const written = await savePerformanceDiagnosticsSnapshot({
      snapshot,
      target,
      environment: process.env,
      workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      capturedAt,
      ask: async (suggested) => {
        const picked = await vscode.window.showSaveDialog({
          title: 'Save Arc Performance Diagnostics',
          defaultUri: suggested ? vscode.Uri.file(suggested) : undefined,
          filters: { JSON: ['json'] },
          saveLabel: 'Save diagnostics',
        });
        return picked ? picked.fsPath : null;
      },
      write: (file, contents) =>
        Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(contents, 'utf8'))),
      // A run with no reader at the window reads the diagnostics log, so the reason goes there as
      // well. It goes through `warn`, which writes whatever the setting says: the setting is off
      // until a reader turns it on and reloads the window, and an automated capture cannot tell a
      // failed write from a closed dialog without this line.
      report: (failure) => {
        this.diagnostics.warn('performanceCaptureFailed', { file: failure.file, reason: failure.reason });
        void vscode.window.showErrorMessage(failure.message);
      },
      announce: (file) => {
        void vscode.window.showInformationMessage(`Arc saved performance diagnostics to ${file}.`);
      },
    });
    return written;
  }

  private performanceDiagnostics(capturedAt: number): unknown {
    const pendingWatch = this.pendingWatch.snapshot();
    let visibleHostCount = 0;
    let visibleHostCountAvailable = true;
    for (const host of this.hosts) {
      try {
        if (host.visible()) {
          visibleHostCount++;
        }
      } catch {
        visibleHostCountAvailable = false;
      }
    }
    return projectPerformanceDiagnostics(
      {
        panel: {
          hostCount: this.hosts.length,
          visibleHostCount: visibleHostCountAvailable
            ? visibleHostCount
            : { unavailable: 'A panel host could not report its visibility.' },
          editorPanelOpen: this.editorPanel !== null,
          polling: this.poll !== null,
          watching: this.watching,
          hasSelection: this.showing !== null,
          activeChildCount: this.running.size,
        },
        rail: {
          listedSessionCount: this.catalog
            ? this.catalog.sessions.length
            : { unavailable: 'No session catalog has been built.' },
          parsedSessionCount: new Set(this.parsedRefs.map((turn) => turn.sessionId)).size,
          rowCount: this.sessionRows.length,
          pinCount: this.pinnedTop.size,
          archiveCount: this.hidden.size,
          messageType: this.lastRailMessageType,
          messageSerializedBytes: this.lastRailMessageSerializedBytes,
        },
        cacheBytes: {
          parsedTails: [...this.cache.values()].reduce((sum, entry) => sum + entry.read.readBytes, 0),
          retainedTails: [...this.cache.values()].reduce((sum, entry) => sum + (entry.checkpointBytes ?? 0), 0),
          olderHistory: [...this.history.values()].reduce((sum, history) => sum + historyBytes(history.pages), 0),
          patches: this.patchBytes,
        },
        watcher: {
          pending: this.watchScheduler.pending,
          queuedEventCount: pendingWatch.eventCount,
          distinctPathCount: pendingWatch.changedPaths.length,
          broadRequired: pendingWatch.broadRequired,
          oldestPendingWakeAgeMs: this.watchScheduler.pendingAge(capturedAt),
        },
        ledger: {
          revision: this.projectSpendRevision,
          rebuilding: this.projectSpendIndexing,
          sourceCount: this.projectSpendFiles.length,
          completeDisplaySourceCount: this.projectSpendVisibleFiles.length,
          queuedSourceCount: this.projectSpendQueue.length,
          savePending: this.projectSpendSaveScheduler.pending || this.projectSpendSaveOwed,
          oldestPendingCheckpointAgeMs:
            this.projectSpendSaveOwedSince === null ? null : Math.max(0, capturedAt - this.projectSpendSaveOwedSince),
        },
        counters: this.performanceCounters.snapshot(),
      },
      capturedAt,
    );
  }

  // A tab handed back after a window reload, which is not always the tab this version would
  // have made.
  //
  // The editor stores the options a panel was created with and hands those same options back
  // for the life of that tab. It never asks the extension again, and the extension cannot set
  // them on a panel it did not create. So a tab opened before this version asked for the find
  // widget comes back without one, through every reload and every reinstall, and Ctrl or Cmd
  // with F answers with nothing on a panel that looks current in every other way. Measured on
  // this machine: the stored options carried `retainContextWhenHidden` and no
  // `enableFindWidget` at all.
  //
  // Replacing the tab applies the current options. Submitted text reaches workspace storage
  // before replacement removes the browser copy.
  async revivePanel(panel: vscode.WebviewPanel, state?: unknown): Promise<void> {
    if (state && typeof state === 'object' && 'submittedPrompts' in state) {
      try {
        await this.importPromptRecovery(state.submittedPrompts);
      } catch {
        void vscode.window.showInformationMessage(
          'Arc: the saved prompts could not be retained. Keep this tab open and copy them before closing it.',
        );
        this.adoptPanel(panel, 'serializer');
        return;
      }
    }
    const matches = (Object.keys(PANEL_OPTIONS) as (keyof typeof PANEL_OPTIONS)[]).every(
      (key) => panel.options[key] === PANEL_OPTIONS[key],
    );
    if (matches) {
      this.adoptPanel(panel, 'serializer');
      return;
    }
    const column = panel.viewColumn ?? vscode.ViewColumn.Active;
    panel.dispose();
    // The replacement carries the reload with it. A panel adopted as `created` here would tell a
    // reader that the serializer never fired on a window that had just restored a tab.
    this.openInEditor(column, 'serializer-replaced');
  }

  // Also the way a tab restored after a window reload rejoins, through the serializer.
  //
  // The origin is logged because a panel reaches this from more than one place. A restored tab is
  // built when the reader looks at it, and a created one is built when the command runs, so a
  // measured start means nothing until the log says which one it timed.
  adoptPanel(panel: vscode.WebviewPanel, origin: PanelOrigin): void {
    if (this.editorPanel && this.editorPanel !== panel) {
      const previous = this.editorPanel;
      const previousHost = this.hosts?.find((host) => host.webview === previous.webview);
      if (previousHost) {
        void this.capturePanelRecovery(previousHost)
          .then(() => {
            if (this.editorPanel !== previous) return;
            previous.dispose();
            if (this.editorPanel === previous) this.editorPanel = null;
            this.adoptPanel(panel, origin);
          })
          .catch(() => {
            this.attach(panelHost(panel));
            panel.reveal();
            void vscode.window.showInformationMessage(
              'Arc: the recent prompts could not be saved. Keep this tab open and copy them before closing it.',
            );
          });
        return;
      }
    }
    this.diagnostics.log('panelAdopted', { origin });
    if (this.editorPanel && this.editorPanel !== panel) {
      this.editorPanel.dispose();
    }
    this.editorPanel = panel;
    this.editorPanelOrigin = origin;
    // Only when this is still the tab being held. Closing an older panel must not clear the
    // pointer to a newer one, or the next press of the command opens a third.
    panel.onDidDispose(() => {
      if (this.editorPanel === panel) {
        this.editorPanel = null;
        this.editorPanelOrigin = null;
      }
    });
    this.attach(panelHost(panel));
  }

  // The two listeners that are about the editor rather than about a host. Registered once,
  // in the constructor, because an editor tab can be opened and closed as often as the reader
  // likes: registered per host they would pile up, one pair per open, released only when the
  // extension shuts down, and one theme change would then repaint the panel once per tab the
  // reader had ever opened. Both bodies already work over `hosts`, so one registration serves
  // every host there will ever be.
  private wireEditorListeners(): void {
    // A different icon theme means a different set of icons, a different font and a
    // different folder to load it out of. Applied to whichever hosts are current, never to
    // one captured here: a host that has gone throws as soon as its webview is assigned to,
    // and the throw lands before the repaint, so the survivors would keep every icon broken
    // until the window was reloaded.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((change) => {
        if (change.affectsConfiguration(settingName('projectCost.historyDays'))) {
          this.restartProjectSpendOffer();
        }
        const catalog = this.authoritativeCatalog;
        if (change.affectsConfiguration(settingName('sessionCacheMiB')) && catalog) {
          this.evictCache(catalog, catalog);
          this.evictOlderHistoryByBudget();
        }
        if (
          change.affectsConfiguration(settingName('timeline.cardLayout')) ||
          change.affectsConfiguration(settingName('timeline.promptPosition'))
        ) {
          void this.post({
            type: 'layout',
            layout: {
              cardLayout: readSetting('timeline.cardLayout'),
              promptPosition: readSetting('timeline.promptPosition'),
            },
          });
        }
        if (!change.affectsConfiguration('workbench.iconTheme')) {
          return;
        }
        this.icons.forget();
        for (const open of this.hosts) {
          this.allowThemeFiles(open.webview);
        }
        void this.refresh(true);
      }),
    );
    // A theme's `light` block only applies under a light colour theme, so the same file
    // resolves to a different icon on either side of this.
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => void this.refresh(true)));
    // The open folders decide which files the webview may read. A folder added after a host
    // opened is not in that list, so a picture under it draws nothing until this runs.
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.workspaceFoldersChanged()));
  }

  private workspaceFoldersChanged(): void {
    this.cancelProjectSpendHydration();
    this.projectSpendHydrationReady = false;
    this.repositoryScopeReady = false;
    this.repositoryScopeRoots = [];
    this.earlySelectedSources?.clear();
    for (const work of this.selectionWorks?.values() ?? []) work.controller.abort();
    this.selectionWorks?.clear();
    this.selectionWork?.controller.abort();
    this.selectionWork = null;
    this.authoritativeCatalog = null;
    this.discoveryCheckpoint = undefined;
    this.discoveryCompleted = undefined;
    this.discoveryAcknowledgment = undefined;
    this.claudeChildReferenceEntries = new Map();
    this.enumeratedSpendSources = undefined;
    // A catalog listed under the previous folders cannot render the current workspace.
    this.abandonCatalogRefresh();
    this.repositoryScope.snapshot(this.folders());
    for (const open of this.hosts) {
      this.allowThemeFiles(open.webview);
    }
    void this.refresh(true);
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Everything a host needs doing to it, whichever of the two it is. One function rather than
  // one per host: each half of this went wrong quietly when it was written twice.
  private attach(host: PanelHost): void {
    this.notePanelStart();
    this.hosts.push(host);
    if (this.showing) {
      this.hostSessions?.set(host, this.showing);
      this.hostPreviousSessions?.set(host, this.showing);
    }
    this.performanceCounters.registerPanel(host);
    this.allowThemeFiles(host.webview);
    // This host's own listeners, held together so they go when it does. An editor tab is
    // opened and closed at will, and anything of its own left in the provider's list would
    // outlive it until the extension shut down.
    const mine: vscode.Disposable[] = [
      host.webview.onDidReceiveMessage((msg) => void this.onMessage(msg, host)),
      host.onDidChangeVisibility(() => {
        if (!this.readyHosts.has(host)) {
          return;
        }
        void this.sendToHost(host, this.panelVisibility.current(host, host.visible()));
        // Polling runs while any host is on screen and stops when none is. Asked of the hosts
        // rather than of the one that just changed: a host going out of sight must not stop
        // the poll another one is still watching.
        if (this.anyVisible()) {
          void this.refresh(true);
          this.startPolling();
          // The strip's figures age while nobody is looking at them, and reading them again
          // costs no model tokens, so coming back into view is what keeps a stale reading
          // the rare case rather than the normal one.
          if (!this.requestInitialCatalogRefresh()) {
            this.refreshSelectedCatalogs();
          }
        } else {
          this.stopPolling();
        }
      }),
    ];
    mine.push(
      host.onDidDispose(() => {
        this.readyHosts.delete(host);
        this.panelVisibility?.release(host);
        this.performanceCounters.releasePanel(host);
        this.hostSessions?.delete(host);
        this.hostPreviousSessions?.delete(host);
        this.hosts = this.hosts.filter((open) => open !== host);
        for (const [source, route] of this.clearRoutes ?? []) {
          route.hosts.delete(host);
          if (!route.hosts.size) {
            this.clearRoutes.delete(source);
          }
        }
        this.releaseQueuedEditOffer(host);
        if (this.detailsMenuArm?.host === host) {
          this.detailsMenuArm = null;
        }
        if (this.composerMenuArm?.host === host) {
          this.composerMenuArm = null;
        }
        if (this.selectedTextMenuArm?.host === host) {
          this.selectedTextMenuArm = null;
        }
        this.closeBrowserStagingForHost(host);
        for (const gone of mine) {
          gone.dispose();
        }
        // The box goes with the view that held it. What it was showing lives only in this
        // window, and a view opened again builds its box from the stored draft.
        if (!this.hosts.length) {
          this.railOrder = [];
          this.boxText = {};
        }
        if (!this.hosts.length) {
          this.initialCatalogRefreshPending = false;
          this.initialCatalogRefreshRequested = false;
        }
        if (!this.hosts.length) {
          this.onPanelsClosed?.();
        }
        if (!this.anyVisible()) {
          this.stopPolling();
          this.abandonCatalogRefresh();
          this.metadataRecoverySession = null;
          this.metadataRecoveryQueue = [];
          this.progressiveWorker.stop();
        }
      }),
    );
    host.webview.html = this.shell(host.webview);
  }

  private browserReady(host: PanelHost): void {
    if (!this.hosts.includes(host) || this.readyHosts.has(host)) {
      return;
    }
    this.readyHosts.add(host);
    void this.sendToHost(host, this.panelVisibility.current(host, host.visible()));
    this.onSetupRefresh?.();
    if (!host.visible()) {
      return;
    }
    this.performanceCounters.recordStartup('shellReady', performance.now());
    void this.refresh(true);
    this.startPolling();
    this.requestInitialCatalogRefresh();
  }

  public setRefreshUsageHandler(
    handler: (agent: string | null, force: boolean, owner?: string, ownerAgent?: string, ownerCwd?: string) => void,
  ): void {
    this.refreshUsageHandler = handler;
    this.drainInitialCatalogRefresh();
  }

  private requestInitialCatalogRefresh(): boolean {
    if (this.initialCatalogRefreshRequested) {
      return false;
    }
    this.initialCatalogRefreshPending = true;
    return this.drainInitialCatalogRefresh();
  }

  private drainInitialCatalogRefresh(): boolean {
    if (!this.initialCatalogRefreshPending || !this.anyVisible() || !this.refreshUsageHandler) {
      return false;
    }
    const selected = this.showing ? (this.sessionRows.find((row) => row.id === this.showing) ?? null) : null;
    if (this.showing && !selected) {
      if (this.initialCatalogRefreshRequested) {
        return false;
      }
      this.initialCatalogRefreshRequested = true;
      this.refreshUsageHandler(null, false);
      return true;
    }
    this.initialCatalogRefreshPending = false;
    this.initialCatalogRefreshRequested = true;
    this.refreshSelectedCatalogs(selected);
    return true;
  }

  private refreshSelectedCatalogs(
    selected = this.showing ? (this.sessionRows.find((row) => row.id === this.showing) ?? null) : null,
  ): void {
    this.refreshUsageHandler?.(
      null,
      false,
      selected?.id,
      selected?.agentKey,
      selected ? (this.ownCwdForSession(selected.agentKey, selected.id) ?? undefined) : undefined,
    );
  }

  private browserPainted(
    host: PanelHost,
    generation: number,
    stage: 'railReady' | 'firstCard' | 'completeRender',
    usableRows = false,
  ): void {
    if (!this.readyHosts.has(host) || generation !== this.refreshGeneration) {
      return;
    }
    if (stage === 'railReady' && usableRows) this.startupHistory?.stage('firstUsableRow');
    if (stage === 'firstCard') this.startupHistory?.stage('selectedText');
    this.performanceCounters.recordStartup(stage, performance.now());
    if (stage !== 'railReady') {
      return;
    }
    for (const [source, route] of this.clearRoutes ?? []) {
      if (route.hosts.get(host) !== generation) {
        continue;
      }
      route.hosts.delete(host);
      if (!route.hosts.size) {
        this.clearRoutes.delete(source);
      }
    }
  }

  // One message to every host, so a search run in one is drawn in both. Contact every host
  // before waiting: two updates posted close together must reach each host in call order.
  private async post(message: unknown, measured?: (serializedBytes: number | null) => void): Promise<void> {
    await Promise.all(
      this.hosts.map((host) => {
        const item = message as { type?: unknown };
        return item.type === 'usage'
          ? this.sendToHost(
              host,
              {
                ...item,
                usage: this.usagePayloadForSession(this.hostSessions?.get(host) ?? this.showing, host.webview),
              },
              measured,
            )
          : this.sendToHost(host, message, measured);
      }),
    );
  }

  private sendToHost(
    host: PanelHost,
    message: unknown,
    measured?: (serializedBytes: number | null) => void,
  ): Thenable<boolean> {
    const type = (message as { type?: unknown })?.type;
    if (!this.readyHosts.has(host) && type !== 'requestPromptRecovery') {
      return Promise.resolve(false);
    }
    const kind = typeof type === 'string' ? type : 'unknown';
    // The post first, then the count. Only budgeted messages carry a byte measurement.
    // Other messages retain their count without paying for a second serialization.
    const posted = host.webview.postMessage(message);
    const budget = messageByteBudget(kind);
    const serializedBytes = budget === null ? null : serializedMessageBytes(message);
    this.performanceCounters.recordMessage(kind, serializedBytes, host);
    measured?.(serializedBytes);
    if (serializedBytes !== null && budget !== null && serializedBytes > budget) {
      // Every breach reaches the log, because a message that goes over budget on every
      // refresh is the shape a reader needs to see. The output channel keeps one line for
      // each kind, and that line carries the field breakdown.
      if (this.diagnostics.enabled()) {
        this.diagnostics.log('budgetBreach', { kind, bytes: serializedBytes, budgetBytes: budget });
      }
      if (!this.warnedMessageBudgets.has(kind)) {
        this.warnedMessageBudgets.add(kind);
        this.performanceOutput ??= vscode.window.createOutputChannel('Arc');
        // Render and rail measurements above already serialize their rail data. Inspecting that
        // field again would repeat the largest part of the work that this warning reports.
        const excludesRail = kind === 'render' || kind === 'rail';
        const excludes = excludesRail ? new Set(['rail']) : undefined;
        const fields = messageFieldBytes(message, excludes)
          .slice(0, 3)
          .map((field) => `${field.field} ${field.bytes} bytes`)
          .join(', ');
        const fieldLabel = excludesRail ? 'Largest non-rail fields' : 'Largest fields';
        this.performanceOutput.appendLine(
          `${kind} message is ${serializedBytes} bytes, above its ${budget}-byte budget. ${fieldLabel}: ${fields}.`,
        );
      }
    }
    return posted;
  }

  // What the foot draws, worked out at the moment it is asked for. The age on a figure
  // moves with the clock and nothing else does, so the bar is never stored: keeping it
  // would mean a repaint to make a figure grow old.
  private usagePayload(webview?: vscode.Webview): unknown {
    const state = this.composerState(webview);
    return this.usagePayloadFromState(state);
  }

  private usagePayloadForSession(session: string | null, webview?: vscode.Webview): unknown {
    const state = this.composerStateFor(session, webview);
    return this.usagePayloadFromState(state);
  }

  private usagePayloadFromState(state: ComposerState | null): unknown {
    // The menus travel with the composer rather than being asked for on the press. Every
    // word in one is decided from the same state the controls are drawn from, so a menu
    // that disagrees with the control that opens it is not a thing that can happen, and
    // the press costs no round trip.
    //
    // Agent is a draft's control alone. `pickMenu` answers nothing for it on a live
    // session, so the loop asks for all five and a live render carries four.
    const menus: Record<string, unknown> = {};
    if (state) {
      for (const control of ['agent', 'model', 'effort', 'askmode', 'mcp']) {
        const menu = pickMenu(control, state);
        if (menu) {
          menus[control] = menu;
        }
      }
    }
    return {
      bar: usageBar(this.usage, Date.now()),
      composer: composerView(state),
      menus,
      launcher: sessionLauncherView(
        state,
        this.recentProfiles,
        this.models,
        this.pinnedSetups,
        this.launcherDefaults?.(),
        this.pendingModels,
        this.setupOwner,
      ),
    };
  }

  // The session the composer is aimed at, and everything known about typing into it.
  // The session on screen, because that is the only one drawn, and the newest listed
  // where a render has not yet named one. Every word the composer draws is decided from this
  // in `composerview.ts`; nothing here writes one.
  private composerState(webview?: vscode.Webview): ComposerState | null {
    if (!this.repositoryScopeReady) {
      return null;
    }
    const row = this.showing ? this.rowForSession(this.showing) : this.sessionRows.find((s) => s.shown);
    return row ? this.stateForRow(row, webview) : null;
  }

  private composerStateFor(session: string | null, webview?: vscode.Webview): ComposerState | null {
    if (!this.repositoryScopeReady) {
      return null;
    }
    const row = session ? this.rowForSession(session) : this.sessionRows.find((s) => s.shown);
    return row ? this.stateForRow(row, webview) : null;
  }

  // The same, for a session named outright rather than the one the box is aimed at. A
  // turn ending is about the session it ended in, and that is often not the session
  // on screen: a queue drained through `composerState` alone waited for the reader to look
  // back at it, which is exactly when they are not looking.
  private stateFor(session: string): ComposerState | null {
    if (!this.repositoryScopeReady) {
      return null;
    }
    if (
      this.earlySelectedSources?.has(session) &&
      !this.authoritativeCatalog?.some((source) => source.sessionId === session) &&
      !this.newDrafts[session] &&
      !this.awaitingSessionRecords[session]
    )
      return null;
    const row = this.rowForSession(session);
    return row ? this.stateForRow(row) : null;
  }

  private rowForSession(session: string): { id: string; label: string; agentKey: AgentKind } | null {
    const recorded = this.sessionRows.find((row) => row.id === session);
    if (recorded) {
      return recorded;
    }
    const draft = Object.prototype.hasOwnProperty.call(this.newDrafts, session) ? this.newDrafts[session] : undefined;
    if (draft && isInside(draft.cwd, this.repositoryScopeRoots)) {
      return (
        syntheticDraftRows([
          {
            draftId: draft.draftId,
            createdAt: draft.createdAt,
            agent: AGENT_NAMES[draft.profile.agent],
            agentKey: draft.profile.agent,
          },
        ])[0] ?? null
      );
    }
    const awaiting = Object.prototype.hasOwnProperty.call(this.awaitingSessionRecords, session)
      ? this.awaitingSessionRecords[session]
      : undefined;
    if (!awaiting || awaiting.cwd === null || !isInside(awaiting.cwd, this.repositoryScopeRoots)) {
      return null;
    }
    return (
      syntheticDraftRows([
        {
          draftId: awaiting.sessionId,
          createdAt: awaiting.createdAt,
          agent: AGENT_NAMES[awaiting.agent],
          agentKey: awaiting.agent,
        },
      ])[0] ?? null
    );
  }

  private panelSession(session: string, host?: PanelHost): string {
    const resolved = resolveSessionAlias(this.sessionAliases, session);
    const route = host ? this.clearRoutes?.get(resolved) : null;
    return route && host && route.hosts.has(host) ? route.successor : resolved;
  }

  private cwdForSession(agent: string, sessionId: string): string | null {
    return this.ownCwdForSession(agent, sessionId) ?? this.folders()[0] ?? null;
  }

  // The same, without the default-folder fallback. A per-directory skill list is keyed by a
  // session's own recorded directory, so a row that has not reported one must draw no list
  // rather than the first workspace folder's list.
  private ownCwdForSession(agent: string, sessionId: string): string | null {
    const session = this.catalog?.sessions.find(
      (candidate) => candidate.agent === agent && candidate.sessionId === sessionId,
    );
    return session?.cwd ?? this.newDrafts[sessionId]?.cwd ?? this.awaitingSessionRecords[sessionId]?.cwd ?? null;
  }

  private recordedCwdForSession(agent: string, sessionId: string): string | null {
    const session = this.catalog?.sessions.find(
      (candidate) => candidate.agent === agent && candidate.sessionId === sessionId,
    );
    return session?.cwd ?? null;
  }

  // Claude's published commands, each carrying a `SKILL.md` path where a project or the
  // reader's own Claude installation has one. Codex marks its own catalog entries with a path
  // before Arc ever sees them; Claude's `init` message never does, so this looks one up for
  // every entry a command list carries, the same lookup composer.ts's slash match would
  // otherwise have to trigger from inside the webview, which never touches disk.
  private claudeCommandsFor(cwd: string | null): PromptEntry[] {
    const commands = this.commandLists.claude ?? [];
    if (commands.length === 0) {
      return commands;
    }
    return commands.map((command) => {
      if (command.path) {
        return command;
      }
      const key = JSON.stringify([cwd, command.name]);
      let found = this.claudeSkillPaths.get(key);
      if (found === undefined) {
        found = claudeSkillPath(command.name, cwd);
        this.claudeSkillPaths.set(key, found);
      }
      return found ? { ...command, path: found } : command;
    });
  }

  private stateForRow(
    row: { id: string; label: string; agentKey: AgentKind },
    webview?: vscode.Webview,
  ): ComposerState {
    const runtime = this.composerRuntime?.get(row.id) ?? null;
    const pick = sessionSettings(this.picks, row.id);
    const newDraft = this.newDrafts[row.id] ?? null;
    // The composer draws the profile off the frozen draft, because that copy is the one
    // `send` hands to the callback that starts the child. `draftProfiles` carries the same
    // values, and a write that reached one book and not the other would draw one setup here
    // and start the child on another.
    const profile = newDraft?.profile ?? null;
    const permissionMode = storedAskValue(
      row.agentKey,
      profile?.permissionMode ?? pick.permissionMode,
      this.askLevels[row.agentKey],
    );
    const claudeCwd = row.agentKey === 'claude' ? this.ownCwdForSession(row.agentKey, row.id) : null;
    return {
      agent: row.agentKey,
      profile,
      sessionId: row.id,
      origin: this.sessionOrigins[row.id] ?? null,
      draft: this.drafts[row.id] ?? '',
      onScreen: this.boxText[row.id] ?? this.drafts[row.id] ?? '',
      assets: this.promptAssets(row.id),
      assetPreviews: webview ? this.assetPreviews(row.id, webview) : {},
      notice: this.attachmentNotices[row.id] ?? null,
      queued: this.queues[row.id] ?? [],
      draftCommentIds: this.draftCommentIds[row.id] ?? [],
      queueHandoffs: this.queueHandoffs,
      history: promptHistory(this.promptsBySession.get(row.id) ?? [], this.sentPrompts[row.id] ?? []),
      running: sessionRunning([...this.running], row.agentKey, row.id),
      clearing: this.clearSettlements?.has(row.id) ?? false,
      comments: this.saved.comments,
      session: row.label,
      models: this.models[row.agentKey] ?? [],
      defaults: this.defaultContext?.(
        row.agentKey,
        this.cwdForSession(row.agentKey, row.id),
        profile?.model ?? pick.selectedModel,
      ),
      // A Claude row carries a path on every command whose `SKILL.md` this session's directory
      // or the reader's own Claude installation has, looked up fresh per row because a
      // worktree session and its parent report different project folders. A Codex row keeps
      // the list the CLI answered, since Codex already marked its own skills with a path.
      commands: row.agentKey === 'claude' ? this.claudeCommandsFor(claudeCwd) : (this.commandLists[row.agentKey] ?? []),
      // Null when this row's working directory has never reported a list, which is the
      // fallback state. `??` rather than a default array, because a reported empty list is a
      // real answer and must not read the same as one that never arrived. A Codex row never
      // draws a Claude skill list, because Codex flags its own skills on its catalog entries.
      claudeSkills:
        row.agentKey === 'claude'
          ? claudeCwd
            ? (this.skillLists[normalizeWorkspace(claudeCwd)] ?? null)
            : null
          : null,
      mcpServers: this.mcpServers[row.id] ?? [],
      settings: {
        ...pick,
        confirmedModel: runtime?.confirmedModel ?? null,
        confirmedModelAttachment: runtime?.confirmedModelAttachment ?? null,
        confirmedEffort: runtime?.confirmedEffort ?? null,
      },
      askMode: permissionMode,
      effectiveMode: this.codexEffectiveModes?.[row.id] ?? null,
      effectivePermissionMode: this.claudeEffectiveModes?.[row.id] ?? null,
      // A session with no recorded window figure gets none drawn. The window is the
      // model's rather than a constant, so it is read off the turn and never assumed.
      contextGeneration: this.contextGenerations?.get(row.id) ?? 0,
      context: runtime?.context?.window ? { used: runtime.context.tokens, max: runtime.context.window } : null,
      // What the next turn costs before the reader types. The accepted window supplies it,
      // and the shared projection retains compaction precedence.
      nextTurn: runtime?.nextTurn ?? null,
      // What this session is still waiting on, and empty between presses. Every word
      // the cards say is decided from it in `composerview.ts`.
      live: this.live[row.id] ?? [],
      asks: this.asks.filter((entry) => entry.session === row.id).map((entry) => entry.ask),
    };
  }

  // What the agents last said about the reader's account. Posted on its own rather than
  // through a render, because nothing else on screen has changed and a render reads
  // transcripts.
  public setUsage(usage: AgentUsage[]): void {
    this.usage = usage;
    void this.post({ type: 'usage', usage: this.usagePayload() });
    this.postProjectSpend();
  }

  // How much each agent asks before it acts. Travels the same way and for the same reason.
  public setAskLevels(levels: Record<string, string>): void {
    this.askLevels = levels;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public setCodexEffectiveMode(session: string, mode: CodexEffectiveMode): void {
    this.codexEffectiveModes[session] = mode;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public setClaudeEffectiveMode(session: string, mode: string): void {
    this.claudeEffectiveModes[session] = mode;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public clearEffectiveModes(agent: AgentKind, sessions: readonly string[]): void {
    const modes = agent === 'codex' ? this.codexEffectiveModes : this.claudeEffectiveModes;
    for (const session of sessions) {
      delete modes[session];
    }
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // The requests every live child is waiting on. One update redraws the selected
  // session's forms and rewords every affected rail card without parsing transcripts.
  public setAsks(asks: readonly { session: string; ask: Ask }[]): void {
    const next = asks.map((entry) => ({ session: entry.session, ask: entry.ask }));
    if (JSON.stringify(next) === JSON.stringify(this.asks)) {
      return;
    }
    this.asks = next;
    void this.post({ type: 'usage', usage: this.usagePayload() });
    this.postRail(true);
  }

  // The models each agent will run, read once from an idle child and cached, since the
  // list changes on a release rather than on a turn.
  public setModels(models: Record<string, ModelChoice[]>, pending: readonly string[] = []): void {
    this.models = models;
    this.pendingModels = pending;
    void this.refresh();
  }

  // The MCP servers each draft or recorded session last reported. A server can fall over on
  // its own, so the owner receives another reading whenever its answer can have moved.
  public setMcpServers(servers: Record<string, McpServer[]>): void {
    this.mcpServers = servers;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Which model and effort the reader picked for each session.
  public setPicks(picks: SessionSettingBook): void {
    const drafts = Object.fromEntries(
      Object.keys(this.newDrafts).flatMap((session) => (this.picks[session] ? [[session, this.picks[session]]] : [])),
    );
    this.picks = { ...picks, ...drafts };
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public setRecentProfiles(profiles: readonly SessionProfile[]): void {
    this.recentProfiles = profiles.map((profile) => ({ ...profile }));
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public setSetupProject(
    project: string | null,
    owner: string,
    entry?: { pins: PinnedSetup[]; recents: SessionProfile[] },
  ): void {
    this.setupProject = project;
    this.setupOwner = owner;
    this.pinnedSetups = entry?.pins ?? [];
    this.recentProfiles = entry?.recents ?? [];
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public setPinnedSetups(stored: unknown): void {
    this.pinnedSetups = normalizePinnedSetups(stored);
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  public pinSetup(request: PinSetupRequest, host?: PanelHost): Promise<boolean> {
    return this.changePinnedSetups({ kind: 'pin', request, host });
  }

  public unpinSetup(id: string): Promise<boolean> {
    return this.changePinnedSetups({ kind: 'unpin', id });
  }

  private changePinnedSetups(
    change: { kind: 'pin'; request: PinSetupRequest; host?: PanelHost } | { kind: 'unpin'; id: string },
  ): Promise<boolean> {
    const project = this.setupProject;
    const owner = this.setupOwner;
    const run = async (): Promise<boolean> => {
      if (owner !== this.setupOwner) return false;
      let latest: PinnedSetup[];
      try {
        latest = this.readPinnedSetups
          ? normalizePinnedSetups(await this.readPinnedSetups(project))
          : this.pinnedSetups;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Arc: pinned setups did not change. ${reason}`);
        return false;
      }
      if (owner !== this.setupOwner) return false;
      let values: CompleteSetupValues | null = null;
      if (change.kind === 'pin') {
        const { view } = this.launcherFor(change.host, undefined, latest);
        const profile = launcherProfile(view, change.request);
        const normalized = normalizeSetupValues(profile);
        if (!normalized || (change.request.kind === 'row' && !sameValues(normalized, change.request.values))) {
          this.pinnedSetups = latest;
          void this.post({ type: 'usage', usage: this.usagePayload() });
          return false;
        }
        values = normalized;
      }
      const next = change.kind === 'pin' ? pinValues(latest, values!, crypto.randomUUID()) : unpinId(latest, change.id);
      if (!this.persistPinnedSetups) {
        this.pinnedSetups = latest;
        void this.post({ type: 'usage', usage: this.usagePayload() });
        void vscode.window.showErrorMessage('Arc: pinned setups did not change. Saving is unavailable.');
        return false;
      }
      try {
        await this.persistPinnedSetups(next, project);
      } catch (error) {
        if (owner === this.setupOwner) {
          this.pinnedSetups = latest;
          void this.post({ type: 'usage', usage: this.usagePayload() });
        }
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Arc: pinned setups did not change. ${reason}`);
        return false;
      }
      if (owner === this.setupOwner) {
        this.pinnedSetups = next;
        void this.post({ type: 'usage', usage: this.usagePayload() });
      }
      return true;
    };
    const next = this.pinnedSetupWrites.then(run, run);
    this.pinnedSetupWrites = next;
    return next;
  }

  private launcherFor(host?: PanelHost): {
    owner: PanelHost | undefined;
    state: ComposerState | null;
    view: ReturnType<typeof sessionLauncherView>;
  };
  private launcherFor(
    host: PanelHost | undefined,
    sourceSession: undefined,
    pinnedSetups: readonly PinnedSetup[],
  ): { owner: PanelHost | undefined; state: ComposerState | null; view: ReturnType<typeof sessionLauncherView> };
  private launcherFor(
    host: PanelHost | undefined,
    sourceSession: string,
  ): { owner: PanelHost | undefined; state: ComposerState | null; view: ReturnType<typeof sessionLauncherView> | null };
  private launcherFor(
    host?: PanelHost,
    sourceSession?: string,
    pinnedSetups: readonly PinnedSetup[] = this.pinnedSetups,
  ) {
    const owner = host ?? this.hosts.find((open) => open.active());
    const session = owner ? (this.hostSessions.get(owner) ?? this.showing) : this.showing;
    const state =
      sourceSession === undefined
        ? owner
          ? this.composerStateFor(session, owner.webview)
          : this.composerState()
        : this.stateFor(sourceSession);
    const view =
      sourceSession !== undefined && !state
        ? null
        : sessionLauncherView(
            state,
            this.recentProfiles,
            this.models,
            pinnedSetups,
            this.launcherDefaults?.(),
            this.pendingModels,
            this.setupOwner,
          );
    return { owner, state, view };
  }

  // The command, the rail's primary button, and every setup row end here. With no current
  // session, the primary command opens the setup menu because there is nothing honest
  // to inherit. A chosen setup creates only local draft state and asks the existing box for
  // focus; the agent still starts on the first accepted prompt.
  public newSession(request?: LauncherRequest, host?: PanelHost, ownership?: { owner?: string }): boolean {
    if (ownership && ownership.owner !== this.setupOwner) return false;
    const { owner, state, view } = this.launcherFor(host);
    const primary = view.primary;
    const inheritsCurrent = request ? request.kind === 'row' && request.key === 'current' : primary?.key === 'current';
    if (
      inheritsCurrent &&
      state &&
      !state.settings?.selectedModel &&
      this.attachmentRecoveryPending?.(state.sessionId)
    ) {
      void this.finishHandoffRecovery(state.sessionId, null, '', false, owner, { request, owner: this.setupOwner });
      return true;
    }
    const profile = request
      ? launcherProfile(view, request)
      : primary
        ? launcherProfile(view, { kind: 'row', key: primary.key })
        : null;
    if (!profile) {
      const message = { type: 'openLauncher', custom: true };
      void (owner ? this.sendToHost(owner, message) : this.post(message));
      return false;
    }
    const cwd = this.folders()[0];
    if (!cwd) {
      void vscode.window.showInformationMessage('Arc: open a folder before starting a session.');
      return false;
    }
    const source = state?.sessionId ?? null;
    if (source) {
      this.abandonDraft(source, false);
    }
    const id = `${DRAFT_SESSION_PREFIX}${crypto.randomUUID()}`;
    if (owner) {
      this.hostPreviousSessions?.set(owner, this.hostSessions.get(owner) ?? this.showing ?? id);
      this.hostSessions.set(owner, id);
    }
    this.createDraft(id, cwd, source, Date.now(), profile);
    const message = { type: 'focusComposer', session: id };
    void (owner ? this.sendToHost(owner, message) : this.post(message));
    return true;
  }

  // A null key starts an empty draft from the session alone, with no source turn to return to.
  private createHandoffDraft(
    session: string,
    key: string | null,
    text: string,
    copyLabels: boolean,
    host?: PanelHost,
    readerParent: boolean = false,
  ): HandoffRefusal | null {
    const turn = key === null ? null : this.turnsByKey.get(key);
    if (key !== null && (!turn || turn.sessionId !== session)) {
      return 'turn';
    }
    const { owner, state: source, view } = this.launcherFor(host, session);
    if (!source || !view) {
      return 'source';
    }
    if (!source.settings?.selectedModel && this.attachmentRecoveryPending?.(session)) {
      void this.finishHandoffRecovery(session, key, text, copyLabels, owner, undefined, readerParent);
      return null;
    }
    const profile = launcherProfile(view, { kind: 'row', key: 'current' });
    if (!profile) {
      return 'setup';
    }
    // A draft has no recorded folder, so an empty draft started from one takes the draft's own.
    const cwd =
      this.recordedCwdForSession(source.agent, source.sessionId) ??
      (key === null ? this.ownCwdForSession(source.agent, source.sessionId) : null);
    if (!cwd) {
      return 'folder';
    }
    const id = `${DRAFT_SESSION_PREFIX}${crypto.randomUUID()}`;
    const labels = copyLabels ? labelsOf(this.saved.labels, session) : [];
    if (labels.length) {
      this.saved.labels = setSessionLabels(this.saved.labels, session, labels);
      this.saved.labels = setSessionLabels(this.saved.labels, id, labels);
    }
    if (owner) {
      this.hostPreviousSessions?.set(owner, this.hostSessions.get(owner) ?? this.showing ?? id);
      this.hostSessions.set(owner, id);
    }
    const origin = key === null ? null : { sessionId: session, turnKey: key };
    this.createDraft(id, cwd, source.sessionId, Date.now(), profile, origin, text, readerParent);
    void this.writeDrafts();
    if (labels.length) {
      void this.post({ type: 'labelsChanged', session: id });
    }
    const message = { type: 'focusComposer', session: id };
    void (owner ? this.sendToHost(owner, message) : this.post(message));
    return null;
  }

  private attachmentRecoveryPending(session: string): boolean {
    const file = this.authoritativeCatalog?.find((entry) => entry.sessionId === session)?.file;
    const checkpoint = file ? (this.cache.get(file)?.checkpoint as ClaudeForwardCheckpoint | undefined) : undefined;
    return checkpoint?.attachmentRecovery?.status === 'pending';
  }

  private async finishHandoffRecovery(
    sessionId: string,
    key: string | null,
    text: string,
    copyLabels: boolean,
    owner?: PanelHost,
    launch?: { request?: LauncherRequest; owner?: string },
    readerParent: boolean = false,
  ): Promise<void> {
    const generation = this.selectionGeneration;
    const initiatingSession = owner ? this.hostSessions.get(owner) : this.showing;
    const controller = new AbortController();
    this.attachmentHandoffs.add(controller);
    const current = () =>
      !this.disposed &&
      !controller.signal.aborted &&
      this.selectionGeneration === generation &&
      (owner
        ? this.hosts.includes(owner) && this.hostSessions.get(owner) === initiatingSession
        : this.showing === initiatingSession);
    try {
      while (current()) {
        const source = this.authoritativeCatalog?.find((entry) => entry.sessionId === sessionId);
        if (!source) {
          void vscode.window.showInformationMessage(handoffRefusalMessage('source', key !== null));
          return;
        }
        const session = { ...source, ...this.revisionOf(source) };
        const held = this.cache.get(session.file);
        const result = await this.progressiveWorker.run(
          { kind: 'window', input: this.progressiveInput(session), checkpoint: held?.checkpoint },
          generation,
          controller.signal,
        );
        if (!current()) return;
        if (!result) {
          void vscode.window.showInformationMessage(handoffRefusalMessage('source', key !== null));
          return;
        }
        const revision = this.revisionOf(session);
        if (result.value.kind !== 'window' || !acceptsProgressiveResult(result, generation, revision)) {
          if (revision.size > session.size && onlyGrew(session, revision)) continue;
          void vscode.window.showInformationMessage(handoffRefusalMessage('source', key !== null));
          return;
        }
        const value = result.value;
        this.updateHistoryAfterAcceptedWindow(sessionId, held, result, sessionId === this.showing);
        this.cache.set(session.file, {
          key: transcriptReadCacheKey(session, TRANSCRIPT_TURN_LIMIT, TRANSCRIPT_TAIL_BYTES, this.folders()),
          agentKey: value.agentKey,
          structuralKey: value.structuralKey,
          structuralAgentIds: value.structuralAgentIds,
          revision: result.revision!,
          read: value.read,
          checkpoint: value.checkpoint,
          usedAt: Date.now(),
          bytes: value.retainedBytes,
          checkpointBytes: value.checkpointBytes,
        });
        const runtime = composerRuntimeBySession(
          value.read.turns,
          currentRecordsBySession(value.read.turns, value.read.compactions).newestCompactions,
        ).get(sessionId);
        if (runtime) this.composerRuntime.set(sessionId, runtime);
        if (!value.recoveryPending) {
          if (launch) {
            this.newSession(launch.request, owner, launch);
            return;
          }
          const refusal = this.createHandoffDraft(sessionId, key, text, copyLabels, owner, readerParent);
          if (refusal) void vscode.window.showInformationMessage(handoffRefusalMessage(refusal, key !== null));
          return;
        }
      }
    } catch {
      if (current()) void vscode.window.showInformationMessage(handoffRefusalMessage('source', key !== null));
    } finally {
      controller.abort();
      this.attachmentHandoffs.delete(controller);
    }
  }

  public handoffResponseLink(link: string, session: string, key: string, copyLabels: boolean): void {
    const text = responseLinkDraftText(link);
    if (!text) {
      void vscode.window.showInformationMessage('Arc: this link can no longer be sent.');
      return;
    }
    const refusal = this.createHandoffDraft(session, key, text, copyLabels);
    if (refusal) {
      void vscode.window.showInformationMessage(handoffRefusalMessage(refusal, true));
    }
  }

  // The empty draft asked for from the native menu over a turn card, a session heading, or a
  // rail card. Each of those right-clicks arms the same record Show session details reads, so
  // the draft opens only in the panel that drew the menu.
  public newSessionWithLabels(session: string): void {
    const arm = this.detailsMenuArm;
    this.detailsMenuArm = null;
    session = this.panelSession(session, arm?.host);
    if (!arm || arm.session !== session || Date.now() - arm.at > 30_000 || !this.hosts.includes(arm.host)) {
      return;
    }
    const refusal = this.createHandoffDraft(session, null, '', true, arm.host, true);
    if (refusal) {
      void vscode.window.showInformationMessage(handoffRefusalMessage(refusal, false));
    }
  }

  private handoffSelectedText(text: string, session: string, key: string, copyLabels: boolean, host?: PanelHost): void {
    const draft = handoffDraftText(text);
    if (!draft) {
      void vscode.window.showInformationMessage('Arc: this selected text can no longer be sent.');
      return;
    }
    const refusal = this.createHandoffDraft(session, key, draft, copyLabels, host);
    if (refusal) {
      void vscode.window.showInformationMessage(handoffRefusalMessage(refusal, true));
    }
  }

  // The launcher supplies the id and the snapshotted profile. Keeping creation here makes an
  // untouched draft a local view state change: no extension callback, child, transcript, or
  // thread exists until `send` calls the fresh-delivery callback.
  public createDraft(
    draftId: string,
    cwd: string,
    sourceSession: string | null,
    createdAt: number,
    profile: SessionProfile,
    origin: DraftOrigin | null = null,
    draftText: string = '',
    readerParent: boolean = false,
  ): NewSessionDraft {
    const draft = newSessionDraft(draftId, cwd, sourceSession, createdAt, profile, origin);
    this.newDrafts[draftId] = draft;
    if (readerParent && sourceSession) {
      this.saved.readerParents = { ...this.saved.readerParents, [draftId]: sourceSession };
    }
    this.draftProfiles[draftId] = { ...profile };
    if (origin) {
      this.sessionOrigins[draftId] = { ...origin };
    }
    if (draftText) {
      this.drafts[draftId] = draftText;
    }
    this.picks = withSessionSettings(
      this.picks,
      draftId,
      sessionSettingsForProfile(
        profile,
        this.models?.[profile.agent],
        this.defaultContext?.(profile.agent, cwd, profile.model),
      ),
    );
    this.selectionGeneration++;
    this.selectionWork?.controller.abort();
    this.selectionWork = null;
    this.selectionFailure = null;
    this.previousSelection = this.showing;
    this.showing = draftId;
    this.onSelectionChanged?.(draftId, profile.agent, draft.cwd);
    // Opening a draft is another chance to fill its agent's server control. A missing
    // initial MCP answer leaves that read eligible, while settled books make this free.
    this.refreshUsageHandler?.(profile.agent, false, draftId, profile.agent, draft.cwd);
    void this.refresh(true, true, true, true);
    return draft;
  }

  public abandonDraft(draftId: string, repaint: boolean = true): boolean {
    const removed = this.newDrafts[draftId];
    if (!removed) {
      return false;
    }
    // Only the draft itself knows whether the reader worked on its setup. Its profile reads
    // custom the moment the launcher's own form makes it, before anyone has pressed one of
    // its controls, so a rule reading the profile keeps that draft on the rail for good.
    const next = abandonSessionDraft(
      {
        drafts: this.drafts,
        assets: this.assets,
        queues: this.queues,
        live: this.live,
        settings: this.picks,
        profiles: this.draftProfiles,
        origins: this.sessionOrigins,
        sent: this.sentPrompts,
        boxText: this.boxText,
        railOrder: this.railOrder,
        showing: this.showing,
      },
      draftId,
      this.newDrafts[draftId]?.handChanged,
      this.staging.has(draftId),
    );
    if (!next) {
      return false;
    }
    this.drafts = next.drafts;
    this.assets = next.assets ?? {};
    this.queues = next.queues;
    this.live = next.live;
    this.picks = next.settings;
    this.draftProfiles = next.profiles;
    this.sessionOrigins = next.origins ?? {};
    this.sentPrompts = next.sent ?? {};
    this.boxText = next.boxText ?? {};
    this.railOrder = next.railOrder;
    this.showing = next.showing;
    delete this.draftCommentIds[draftId];
    delete this.newDrafts[draftId];
    this.saved.readerParents = abandonReaderParents(this.saved.readerParents ?? {}, draftId);
    delete this.mcpServers[draftId];
    this.onDraftRemoved?.(removed);
    // The labels go with the draft. A session that never started has no card to draw
    // them on and no id any control can reach, so an entry left behind is filing that exists
    // only in storage: it would hold a slot under the record's ceiling, and the label itself
    // would be offered by every list built from the record while matching nothing.
    if (labelsOf(this.saved.labels, draftId).length) {
      this.saved.labels = setSessionLabels(this.saved.labels, draftId, []);
      void this.post({ type: 'labelsChanged', session: draftId });
    }
    void this.writeDrafts();
    if (repaint) {
      void this.refresh(true);
    }
    return true;
  }

  private adoptDraft(
    provisional: string,
    actual: string,
    submitted?: NewSessionDraft,
    submittedSettings?: ComposerState['settings'],
  ): void {
    const draft = submitted ?? this.newDrafts[provisional];
    if (!draft) {
      throw new Error(`session ${provisional} is not a fresh draft`);
    }
    if (this.awaitingSessionRecords[actual]) {
      throw new Error(`session ${actual} is already waiting for its record`);
    }
    const archivedIdentityMoved = this.hidden.has(provisional);
    this.saved.readerParents = remapReaderParents(this.saved.readerParents ?? {}, provisional, actual);
    const next = adoptSessionIdentity(
      {
        drafts: this.drafts,
        assets: this.assets,
        queues: this.queues,
        live: this.live,
        settings: submittedSettings ? { ...this.picks, [provisional]: submittedSettings } : this.picks,
        profiles: submitted ? { ...this.draftProfiles, [provisional]: submitted.profile } : this.draftProfiles,
        origins: this.sessionOrigins,
        sent: this.sentPrompts,
        boxText: this.boxText,
        railOrder: this.railOrder,
        showing: this.showing,
        pinned: [...this.pinnedTop],
        archived: [...this.hidden],
      },
      provisional,
      actual,
    );
    this.drafts = next.drafts;
    this.assets = next.assets ?? {};
    this.queues = next.queues;
    this.live = next.live;
    this.picks = next.settings;
    this.draftProfiles = next.profiles;
    this.sessionOrigins = next.origins ?? {};
    this.sentPrompts = next.sent ?? {};
    this.boxText = next.boxText ?? {};
    this.railOrder = next.railOrder;
    this.showing = next.showing;
    for (const [host, session] of this.hostSessions ?? []) {
      if (session === provisional) {
        this.hostSessions.set(host, actual);
      }
    }
    for (const [host, session] of this.hostPreviousSessions ?? []) {
      if (session === provisional) {
        this.hostPreviousSessions.set(host, actual);
      }
    }
    this.sessionRows = this.sessionRows.map((row) =>
      row.id === provisional
        ? { ...row, id: actual, agentKey: draft.profile.agent, agent: AGENT_NAMES[draft.profile.agent] }
        : row,
    );
    this.pinnedTop = new Set(next.pinned ?? []);
    this.hidden = new Set(next.archived ?? []);
    this.saved.pinnedTop = [...this.pinnedTop];
    this.saved.hidden = [...this.hidden];
    const draftMcp = this.mcpServers[provisional];
    if (draftMcp) {
      this.mcpServers[actual] = draftMcp;
    }
    delete this.mcpServers[provisional];
    this.onDraftAdopted?.(provisional, actual);
    if (this.detailsMenuArm?.session === provisional) {
      this.detailsMenuArm = { ...this.detailsMenuArm, session: actual };
    }
    if (this.selectedTextMenuArm?.session === provisional) {
      this.selectedTextMenuArm = { ...this.selectedTextMenuArm, session: actual };
    }
    if (archivedIdentityMoved) {
      this.onArchivedSessionsChange?.(this.hidden);
    }
    const draftCommentIds = this.draftCommentIds[provisional];
    if (draftCommentIds?.length) {
      this.draftCommentIds[actual] = draftCommentIds;
    }
    delete this.draftCommentIds[provisional];
    // The invented id stops existing here. A place still holding it would be pruned on the
    // next refresh, and the reader would lose the session they had just started.
    this.trail = renamePlace(this.trail, provisional, actual);
    this.awaitingSessionRecords[actual] = {
      sessionId: actual,
      createdAt: draft.createdAt,
      agent: draft.profile.agent,
      cwd: draft.cwd,
    };
    // The awaiting record above goes as soon as the disk record arrives, and this one does
    // not. It answers a different question, and the transcript that ends the wait is the
    // very thing that would file this session under Run by agents.
    this.rememberStarted(actual);
    rememberSessionAlias(this.sessionAliases, provisional, actual);
    const notice = this.attachmentNotices[provisional];
    if (notice !== undefined) {
      delete this.attachmentNotices[provisional];
      this.attachmentNotices[actual] = notice;
    }
    if (this.staging.delete(provisional)) {
      const token = this.stagingTokens.get(provisional) ?? '';
      this.stagingTokens.delete(provisional);
      this.staging.add(actual);
      this.stagingTokens.set(actual, token);
      const operation = this.stagingOperations.get(token);
      if (operation) {
        adoptPromptAssetOperationTarget(operation, provisional, actual);
      }
      void this.post({ type: 'fileStaging', session: actual, pending: true, token });
      void this.post({ type: 'fileStaging', session: provisional, pending: false, token });
    }
    if (this.draftRevisions?.has(provisional)) {
      this.draftRevisions.set(actual, this.draftRevisions.get(provisional) ?? 0);
      this.draftRevisions.delete(provisional);
    }
    delete this.newDrafts[provisional];
    // The labels follow the session onto the id it actually gets. A reader who files a
    // session while it is starting puts the label on the draft's own id, and the agent
    // hands back an id of its choosing a moment later. A label left on the old id belongs to
    // nothing, so it would disappear off a card the reader had labelled seconds earlier.
    //
    // Written before `writeDrafts` below, which is what puts this state on disk. The draft's
    // id is gone by the end of this method, so the move cannot wait for the next save.
    if (labelsOf(this.saved.labels, provisional).length) {
      this.saved.labels = adoptLabelSession(this.saved.labels, provisional, actual);
      void this.post({ type: 'labelsChanged', session: actual });
    }
    void this.writeDrafts();
    const settings = this.picks[actual];
    if (settings) {
      this.onSessionSettingsAdopted?.(actual, { ...settings });
    }
  }

  // A press on one of a draft's own controls. It changes that draft and reaches nothing else.
  //
  // The frozen draft is rebuilt beside the profile. `send` hands that value to the callback
  // that starts a fresh session, and the spawn plan is built from the profile inside
  // it, so a draft left holding the old profile starts its child on the setup the reader
  // replaced.
  private pickOnDraft(session: string, control: string, value: string): void {
    const profile = this.draftProfiles[session];
    const draft = this.newDrafts[session];
    if (!profile || !draft) {
      return;
    }
    // A draft whose first prompt has gone is starting its child, and the spawn plan is built
    // from the copy `send` already handed over. A press taken after that leaves the panel
    // naming a setup the running child never had. The rule is `draftStarted` in
    // `composerview.ts`, where it is tested, and it catches a press that raced the redraw.
    if (draftStarted(this.live[session] ?? [])) {
      return;
    }
    // A value no menu offered is refused. The rule is `draftProfileAfterPick` in
    // `composerview.ts`, where it is tested, so nothing here decides what a press means.
    const next = draftProfileAfterPick(
      profile,
      control,
      value,
      this.models,
      this.defaultContext?.(profile.agent, draft.cwd, profile.model),
    );
    if (!next) {
      return;
    }
    const unsupported =
      next.agent !== profile.agent ? unsupportedPromptAsset(next.agent, this.assets[session] ?? []) : null;
    if (unsupported) {
      this.setAttachmentNotice(session, attachmentRefusal('unsupported', unsupported.name));
      return;
    }
    this.draftProfiles[session] = next;
    // Only a press that moved a value is the reader's own work, and the rebuilt draft carries
    // that fact so the rail keeps the draft when they look at another session. Pressing
    // the row already ticked resolves and changes nothing, and a draft marked by that press
    // would refuse to leave over a setup the reader never chose. An earlier change stands.
    const changed =
      profile.agent !== next.agent ||
      profile.model !== next.model ||
      profile.effort !== next.effort ||
      profile.permissionMode !== next.permissionMode;
    this.newDrafts[session] = newSessionDraft(
      draft.draftId,
      draft.cwd,
      draft.sourceSession,
      draft.createdAt,
      next,
      draft.origin,
      draft.handChanged || changed,
    );
    this.picks = withSessionSettings(
      this.picks,
      session,
      sessionSettingsForProfile(
        next,
        this.models[next.agent],
        this.defaultContext?.(next.agent, draft.cwd, next.model),
      ),
    );
    if (changed) {
      this.onDraftProfileChanged?.(draft);
      delete this.mcpServers[session];
      this.refreshUsageHandler?.(next.agent, false, session, next.agent, draft.cwd);
    }
    // The rail row takes its name and its agent key from the draft, and that agent key
    // chooses the model catalog, so an agent change needs the rail rebuilt. Every other
    // press changes the composer alone, and the composer, its tag, its labels and its menus
    // all come back through the usage payload. A full refresh for one of those lists
    // sessions, refreshes metadata and parses transcripts to redraw a row that has not moved.
    if (next.agent !== profile.agent) {
      void this.refresh(true);
      return;
    }
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // The commands each agent published, for the menu the composer opens on a slash. Travels
  // the same way the model list does, and for the same reason: it is read off a child this
  // file does not own.
  public setCommands(commands: Record<string, PromptEntry[]>): void {
    this.commandLists = commands;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // The per-directory Claude skill list, for the Composer highlight. Travels the same way the
  // command list does, and for the same reason: it is read off a child this file does not own.
  public setSkills(skills: Record<string, readonly string[]>): void {
    this.skillLists = skills;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Which sessions have a turn in flight, as `runningKey` spells them. Sessions
  // rather than agents: one agent runs several at once, and a set of agent names drew Stop
  // over every session of a busy agent, including the quiet one the box was aimed at.
  public setRunning(keys: readonly string[]): void {
    const next = new Set(keys);
    const moved = next.size !== this.running.size || [...next].some((key) => !this.running.has(key));
    // When each session became busy, kept as the set moves: the moment a key arrives is
    // the press it arrived for, and a key that leaves takes its time with it, so the next
    // press is timed from its own arrival rather than from an older one.
    const now = Date.now();
    for (const key of next) {
      if (!this.runningSinceKeys.has(key)) {
        this.runningSinceKeys.set(key, now);
      }
    }
    for (const key of [...this.runningSinceKeys.keys()]) {
      if (!next.has(key)) {
        this.runningSinceKeys.delete(key);
      }
    }
    this.running = next;
    // Busy changes what the card says and whether Stop is available, but it does not prove
    // delivery. AgentSession reports busy before the CLI answers the handoff, so only that
    // answer records that this press started a turn. Marked before anything is swept: a press
    // the agent has taken and not begun is not one that stopped when the session went
    // quiet, and sweeping it took the reader's own prompt off the screen with the compaction.
    this.markStartedPresses();
    this.dropSpentPresses();
    void this.post({ type: 'usage', usage: this.usagePayload() });
    // The rail and cards wear the same answer, so rebuild both when the set moves and not
    // otherwise. This runs on every event a turn produces, and rebuilding on each one is
    // hundreds of reads to say what the panel already said.
    if (moved) {
      void this.refresh(true);
    }
  }

  // Which hosted sessions' processes have exited, as `runningKey` spells them. A dead host
  // process ends every background child it held, so the rail stops counting them.
  public setExited(keys: readonly string[]): void {
    const { exited, moved } = recordExits(this.exitedSinceKeys, this.exitedNow, keys, Date.now());
    this.exitedNow = exited;
    for (const settlement of [...(this.clearSettlements?.values() ?? [])]) {
      const agent = settlement.state.agent;
      if (keys.includes(runningKey(agent, settlement.source)) || keys.includes(runningKey(agent, settlement.session))) {
        this.cancelClearSettlement(settlement.session, 'The agent session closed before a new session opened.');
      }
    }
    if (moved) {
      void this.refresh(true);
    }
  }

  // Resume locally accepted work after an extension-host reload. The queue is restored in
  // the constructor, while its transcript row and the send callback arrive later. A failed
  // first attempt stays visible with its reason and is not retried on every refresh.
  private drainPendingQueues(): void {
    if (!this.onSendPrompt) {
      return;
    }
    for (const session of [...this.pendingQueueDrains]) {
      const state = this.stateFor(session);
      if (!state) {
        continue;
      }
      this.pendingQueueDrains.delete(session);
      if (!state.running) {
        this.flushQueue(session);
      }
    }
  }

  // Which press the agent is working on now, marked as its work begins.
  //
  // The rule is `pressesAfterRunning` in composerview.ts, where it is tested. This gathers
  // what that rule asks about and nothing else.
  private markStartedPresses(): void {
    const keys = [...this.running];
    for (const [session, held] of Object.entries(this.live)) {
      const agent = held[0]?.agent;
      if (!agent) {
        continue;
      }
      this.live[session] = pressesAfterRunning(held, sessionRunning(keys, agent, session));
    }
  }

  // Every press the panel has stopped waiting on, taken away. Run wherever an accepted
  // window, a compaction boundary, or running state can have moved.
  //
  // Which press is over is decided in `composerview.ts`, where it is tested. This gathers
  // what that rule asks about and nothing else.
  private dropSpentPresses(): boolean {
    const now = Date.now();
    const keys = [...this.running];
    let swept = false;
    for (const [session, held] of Object.entries(this.live)) {
      const left = held.filter((press) => {
        // A compaction is not a turn, so the two are matched against different records.
        const seen =
          press.kind === 'compact'
            ? (this.newestCompactionBySession.get(session)?.at ?? null)
            : (this.newestBySession.get(session)?.startedAt ?? null);
        const running = sessionRunning(keys, press.agent, session);
        const acceptedRecordedTurn = selectedWindowContainsRecordedTurn(
          this.showing,
          press,
          this.newestBySession.get(session) ?? null,
        );
        return !livePressOver(press, seen, running, now, acceptedRecordedTurn);
      });
      if (left.length === held.length) {
        continue;
      }
      swept = true;
      if (left.length) {
        this.live[session] = left;
      } else {
        delete this.live[session];
        this.responseSnapshots?.delete(session);
      }
    }
    return swept;
  }

  // A command the CLI answers locally is taken away at once because no record will replace it.
  // The first line of its reply shows once as the Composer's message, because the transcript
  // keeps no card for it either. A restored session therefore shows no reply.
  //
  // Named by the session the child is in when it answers, which is not always the one
  // the press was filed under: `/clear` renames the session before it reports the end,
  // and `noteSessionMoved` has already carried the press across by then.
  //
  // The rule is `pressesAfterLocalAnswer` in composerview.ts, where it is tested.
  public noteLocalAnswer(session: string, clearFailure: string | null = null, reply = ''): void {
    if (clearFailure) {
      this.cancelClearSettlement(session, clearFailure);
    } else {
      const notice = localAnswerNotice(reply);
      if (notice) {
        this.setAttachmentNotice(session, notice);
      }
    }
    const held = this.live[session];
    if (!held?.length) {
      return;
    }
    const left = pressesAfterLocalAnswer(held);
    if (left.length === held.length) {
      return;
    }
    if (left.length) {
      this.live[session] = left;
    } else {
      delete this.live[session];
    }
    void this.refresh(true);
  }

  // The child kept its process and started a new session inside it.
  //
  // `/clear` does this. Everything the reader was waiting on was sent to a session the
  // child has left, so unfinished work travels to the successor. Terminal responses stay
  // with the source. The panel looks at the successor
  // because that is where the next thing they type will go. The source keeps its turns, its
  // place in the rail, its file on disk and its own labels. The labels are copied onto the
  // successor rather than moved, since a reader who filed the source under a label still
  // wants that label there after the clear.
  //
  // The successor is registered as a session with no records yet, the same way a fresh
  // draft is once the agent names it. Without that it is reachable from nowhere: its file
  // holds no typed prompt, so the listing filters it out, and `pickShowing` cannot settle on
  // an id the walk never produced.
  //
  // The rule is `succeedSession` in composerview.ts, where it is tested.
  public noteSessionMoved(source: string, successor: string, agent: AgentKind, cwd: string | null): void {
    if (!source || !successor || source === successor) {
      return;
    }
    const snapshot = this.responseSnapshots?.get(source);
    if (snapshot) {
      const retained = new Set((this.live[source] ?? []).filter((press) => press.completed).map((press) => press.at));
      const staying = new Map([...snapshot.owners].filter(([, at]) => retained.has(at)));
      const moving = new Map([...snapshot.owners].filter(([, at]) => !retained.has(at)));
      const blocksStay = retained.has(snapshot.at);
      if (staying.size || blocksStay)
        this.responseSnapshots.set(source, {
          ...snapshot,
          owners: staying,
          blocks: blocksStay ? snapshot.blocks : new Map(),
        });
      else this.responseSnapshots.delete(source);
      if (moving.size || !blocksStay)
        this.responseSnapshots.set(successor, {
          ...snapshot,
          owners: moving,
          blocks: blocksStay ? new Map() : snapshot.blocks,
        });
    }
    const clearing = this.clearSettlements.get(source) ?? null;
    if (clearing) {
      this.clearSettlements.delete(source);
      clearing.session = successor;
      this.clearSettlements.set(successor, clearing);
      const hosts = new Map([...(this.readyHosts ?? [])].map((host) => [host, null]));
      if (hosts.size) {
        this.clearRoutes ??= new Map();
        this.clearRoutes.set(source, { successor, hosts });
      }
    }
    if (this.awaitingSessionRecords[successor] || this.newDrafts[successor]) {
      if (clearing?.delivery?.delivered) {
        this.finishClearSettlement(clearing);
      }
      if (clearing) {
        void this.refresh(true);
      }
      return;
    }
    const next = succeedSession(
      {
        drafts: this.drafts,
        assets: this.assets,
        queues: this.queues,
        live: this.live,
        settings: this.picks,
        profiles: this.draftProfiles,
        origins: this.sessionOrigins,
        sent: this.sentPrompts,
        boxText: this.boxText,
        railOrder: this.railOrder,
        showing: this.showing,
      },
      source,
      successor,
    );
    this.drafts = next.drafts;
    this.assets = next.assets ?? {};
    this.queues = next.queues;
    if (clearing?.preservePayload && clearing.queued) {
      this.queues[successor] = queueResetSucceeded(
        this.queues[successor] ?? [],
        clearing.queued.id,
        source,
        successor,
        clearing.resetId,
      );
    }
    this.live = next.live;
    this.picks = next.settings;
    this.draftProfiles = next.profiles;
    this.sessionOrigins = next.origins ?? {};
    this.sentPrompts = next.sent ?? {};
    this.boxText = next.boxText ?? {};
    this.railOrder = next.railOrder;
    this.showing = next.showing;
    for (const [host, session] of this.hostSessions ?? []) {
      if (session === source) {
        this.hostSessions.set(host, successor);
      }
    }
    for (const [host, session] of this.hostPreviousSessions ?? []) {
      if (session === source) {
        this.hostPreviousSessions.set(host, successor);
      }
    }
    for (const entry of this.queues[successor] ?? [])
      if (entry.recoveryId) this.confirmPromptOwner(entry.recoveryId, successor);
    this.awaitingSessionRecords[successor] = {
      sessionId: successor,
      createdAt: Date.now(),
      agent,
      cwd,
    };
    this.rememberStarted(successor);
    // The source keeps its own labels: this is a copy, not a move, matching the source
    // keeping its turns, its rail row and its file on disk. `setSessionLabels` evicts the
    // oldest labelled session when the record is at capacity, so the source is re-written
    // first to move it to the newest end before the successor is added. Otherwise a source
    // that is the oldest labelled session would be evicted by its own copy.
    const labels = labelsOf(this.saved.labels, source);
    if (labels.length) {
      this.saved.labels = setSessionLabels(this.saved.labels, source, labels);
      this.saved.labels = setSessionLabels(this.saved.labels, successor, labels);
    }
    void this.writeDrafts();
    if (labels.length) {
      void this.post({ type: 'labelsChanged', session: successor });
    }
    const settings = this.picks[successor];
    if (settings) {
      this.onSessionSettingsAdopted?.(successor, { ...settings });
    }
    if (clearing?.delivery?.delivered) {
      this.finishClearSettlement(clearing);
    }
    // The catalog is walked again rather than reused. The successor is a file that did not
    // exist a moment ago, and a refresh reading the held catalog cannot see it.
    void this.refresh(true);
  }

  // What the panel draws until the transcript catches up, recorded at the press.
  //
  // Before the handoff rather than after it, which is the whole point: the handoff reaches an
  // agent through two awaits, and a card built on the way back arrives a round trip behind the
  // keystroke. The time it answers with names this press, so an answer landing after a second
  // press cannot mark the wrong one.
  private noteLive(state: ComposerState, kind: LiveKind, text: string, assets: StoredPromptAsset[] = []): number {
    // Read before the slot is written, because what is already in flight is half the answer:
    // a prompt sent while a compaction runs is not a mid-turn prompt. The rule itself is
    // `pressIsMidTurn` in composerview.ts, where it is tested.
    const inFlight = this.live[state.sessionId] ?? [];
    const at = Math.max(Date.now(), ...inFlight.map((press) => press.at + 1));
    const recorded = this.newestBySession.get(state.sessionId);
    const activity = (this.liveActivity[state.sessionId] ?? []).filter(
      (one) => at - one.seenAt < LIVE_ACTIVITY_STALE_MS,
    );
    let next = {
      sessionId: state.sessionId,
      agent: state.agent,
      kind,
      text,
      assets,
      reply: '',
      at,
      midTurn: pressIsMidTurn(kind, state.running, inFlight),
      ...pendingAskPosition(recorded, activity, this.runningSince().get(state.sessionId)),
      ran: false,
      started: false,
      failed: false,
      reason: '',
    };
    const replaced = inFlight.find((press) => press.kind === kind);
    if (
      next.kind === 'prompt' &&
      next.midTurn &&
      replaced &&
      !livePressOver(
        replaced,
        null,
        state.running,
        at,
        selectedWindowContainsRecordedTurn(this.showing, replaced, recorded ?? null),
      )
    ) {
      next = { ...next, midTurn: false };
    }
    this.live[state.sessionId] = pressesAfter(inFlight, next);
    return at;
  }

  // A chunk of the reply, as the agent writes it.
  //
  // Named by the session the chunk came from, which is the session the child is
  // in and not the one the box happens to be aimed at. A chunk for a session with no
  // card waits for its submitting press's delivery receipt. Events without that ownership
  // are dropped because the recorded turn has replaced the temporary card.
  public noteReply(session: string, chunk: string, turnId?: number): void {
    const held = this.live[session];
    const press = this.responsePress(session, turnId, () => this.noteReply(session, chunk, turnId));
    if (!press) {
      return;
    }
    this.live[session] = held.map((one) => (one === press ? { ...one, reply: appendReply(one.reply, chunk) } : one));
    if (this.replyPost) {
      return;
    }
    this.replyPost = setTimeout(() => {
      this.replyPost = null;
      this.postReply();
    }, LIVE_REPLY_POST_MS);
  }

  private responseSnapshots = new Map<
    string,
    { at: number; blocks: Map<string, string>; owners: Map<string, number> }
  >();
  private pendingResponsePosts = new Map<number, Array<() => void>>();
  private pendingResponseOwners = new Map<
    number,
    { session: string; source: string; at: number; timer: ReturnType<typeof setTimeout> }
  >();

  private forgetPendingResponses(turnId: number): void {
    const owner = this.pendingResponseOwners.get(turnId);
    if (owner) clearTimeout(owner.timer);
    this.pendingResponseOwners.delete(turnId);
    this.pendingResponsePosts.delete(turnId);
  }

  private responsePress(session: string, turnId: number | undefined, retry: () => void): LivePress | null {
    if (this.disposed || turnId === undefined) return null;
    const held = this.live[session] ?? [];
    const press = held.find((one) => one.turnId === turnId && !one.failed && !one.completed);
    if (press) return press;
    const owner = this.pendingResponseOwners.get(turnId);
    if (
      owner &&
      !(this.live[owner.source] ?? []).some((one) => one.at === owner.at && !one.ran && !one.failed && !one.completed)
    ) {
      this.forgetPendingResponses(turnId);
      return null;
    }
    if (owner?.session === session) {
      const pending = this.pendingResponsePosts.get(turnId) ?? [];
      pending.push(retry);
      this.pendingResponsePosts.set(turnId, pending);
    }
    return null;
  }

  private postAcceptedResponses(delivery: PromptDelivery): void {
    if (delivery.turnId === undefined) return;
    const pending = this.pendingResponsePosts.get(delivery.turnId) ?? [];
    this.forgetPendingResponses(delivery.turnId);
    if (delivery.delivered) for (const post of pending) post();
  }

  public noteCompletedReply(session: string, text: string, sourceId?: string, turnId?: number): void {
    const held = this.live[session];
    const press = this.responsePress(session, turnId, () => this.noteCompletedReply(session, text, sourceId, turnId));
    if (!press) return;
    let snapshot = this.responseSnapshots.get(session);
    const owner = sourceId ? snapshot?.owners.get(sourceId) : undefined;
    if (owner !== undefined && owner !== press.at) return;
    if (!snapshot || snapshot.at !== press.at) {
      snapshot = { at: press.at, blocks: new Map(), owners: snapshot?.owners ?? new Map() };
      this.responseSnapshots.set(session, snapshot);
    }
    if (sourceId) snapshot.owners.set(sourceId, press.at);
    snapshot.blocks.set(sourceId ?? 'response', text);
    const reply = [...snapshot.blocks.values()].join('\n\n');
    this.live[session] = held.map((one) => (one === press ? { ...one, reply } : one));
    this.postReply();
    if (this.showing === session || [...this.hostSessions.values()].includes(session))
      void this.completeSelectedWindow(session, this.selectionGeneration);
  }

  public noteResponseEnded(session: string, outcome: import('./agentwire').TurnOutcome, turnId?: number): void {
    if (outcome.turns === 0) return;
    const held = this.live[session];
    const press = this.responsePress(session, turnId, () => this.noteResponseEnded(session, outcome, turnId));
    if (press?.kind === 'prompt') {
      this.live[session] = held.map((one) =>
        one === press ? { ...one, completed: true, outcome: outcome.status } : one,
      );
      this.postReply();
    }
  }

  // Visible work reported by a child before the transcript catches up. Starts and finishes
  // replace one another by source id, while preserving the first arrival time so their order
  // does not jump when a call completes.
  public noteActivity(session: string, activity: WireActivity): void {
    const now = Date.now();
    if (activity.kind === 'commentary') {
      const presses = this.live[session];
      const press = presses ? pressForReply(presses) : null;
      if (press) {
        const reply = replyAfterCommentary(press.reply, activity.detail);
        if (reply !== press.reply) {
          this.live[session] = presses.map((one) => (one === press ? { ...one, reply } : one));
        }
      }
    }
    const held = this.liveActivity[session] ?? [];
    const index = held.findIndex((one) => one.sourceId === activity.sourceId);
    if (index >= 0) {
      held[index] = { ...activity, at: held[index].at, seenAt: now };
    } else {
      held.push({ ...activity, at: now, seenAt: now });
      if (held.length > LIVE_ACTIVITY_LIMIT) {
        held.splice(0, held.length - LIVE_ACTIVITY_LIMIT);
      }
    }
    this.liveActivity[session] = held;
    this.activitySessions.add(session);
    if (this.activityPost) {
      return;
    }
    this.activityPost = setTimeout(() => {
      this.activityPost = null;
      const sessions = [...this.activitySessions];
      this.activitySessions.clear();
      if (!sessions.every((heldSession) => this.postActivity(heldSession))) {
        this.wakeFromActivityFallback();
      }
    }, LIVE_ACTIVITY_POST_MS);
  }

  // The direct stream belongs only to the newest turn in its session. Recorded rows
  // replace their live copies, and activity from an earlier turn is discarded when the next
  // turn appears.
  private withActivity(turn: Turn): Turn {
    const held = this.liveActivity[turn.sessionId];
    if (!held?.length) {
      return turn;
    }
    const recorded = new Set<string>();
    for (const step of turn.steps) {
      if (step.sourceId) {
        recorded.add(step.sourceId);
      }
    }
    for (const update of turn.updates ?? []) {
      recorded.add(update.sourceId);
    }
    const now = Date.now();
    const remaining = held.filter(
      (one) => one.at >= turn.startedAt && now - one.seenAt < LIVE_ACTIVITY_STALE_MS && !recorded.has(one.sourceId),
    );
    if (remaining.length) {
      this.liveActivity[turn.sessionId] = remaining;
    } else {
      delete this.liveActivity[turn.sessionId];
    }
    return withLiveActivity(turn, remaining);
  }

  // The card on its own, so a reply arriving does not rebuild the foot around it.
  //
  // Its own message rather than the usage payload the rest of the composer travels in. That
  // payload redraws every control under the card, the box included, and the box is the one
  // the reader may be typing their next prompt into while this arrives eight times a second.
  private postReply(): void {
    for (const host of this.hosts) {
      const state = this.composerStateFor(this.hostSessions?.get(host) ?? this.showing, host.webview);
      if (!state) {
        continue;
      }
      // The chunk was for whatever session the child is in, and the box may be aimed
      // somewhere else entirely by now. That card is drawn when the reader looks back at it.
      const view = composerView(state);
      if (!view?.live.length) {
        continue;
      }
      void this.sendToHost(host, { type: 'live', session: state.sessionId, live: view.live });
    }
  }

  // One recorded card with its temporary child activity applied. The transcript has not
  // moved, so listing and parsing every session would only rediscover the same turns.
  // If the session has no card in the drawn set yet, a render is still needed to make
  // one and remains the fallback.
  private postActivity(session: string): boolean {
    const recorded = this.newestBySession.get(session);
    const index = recorded
      ? this.cards.findIndex((card) => card.kind === 'turn' && card.key === turnKey(recorded))
      : -1;
    if (!recorded || index < 0) {
      return false;
    }
    const previous = this.cards[index];
    const title =
      (recorded.agent === 'claude' ? this.sessionNames.get(session)?.label : null) ||
      previous.sessionTitle ||
      'Session';
    // The newest card draws its live open children as running, and counts its carried
    // subagents on its agents figure.
    const now = Date.now();
    const card = this.renderTurnCard(
      recorded,
      true,
      title,
      now,
      this.folders(),
      this.runningSessions(),
      this.liveOpenChildren(now),
    );
    this.cards[index] = card;
    const light = isLightColourTheme();
    for (const host of this.hosts) {
      void this.sendToHost(host, {
        type: 'activity',
        session: session,
        card: this.themedFor([card], host.webview, light)[0],
      });
    }
    return true;
  }

  // Record whether the child accepted one press. A rejection stays for the reader to clear.
  // An accepted prompt stays until its record arrives.
  private livePressAnswered(session: string, at: number, delivery: PromptDelivery): void {
    const held = this.live[session];
    const originKey = session + '\0' + at;
    const host = this.livePressHosts.get(originKey);
    // Delivery can finish after the submitting panel closes. Only an attached host still owns
    // a selection that delivery can move.
    const attachedHost = host && this.hosts.includes(host) ? host : undefined;
    this.livePressHosts.delete(originKey);
    const destination = delivery.delivered && delivery.session !== session ? delivery.session : undefined;
    // A second press has already replaced this one, and applying this answer to that press
    // would describe a different prompt.
    if (!held?.some((press) => press.at === at)) {
      if (delivery.turnId !== undefined) this.forgetPendingResponses(delivery.turnId);
      // The consent window can outlive the temporary card. A prompt that did reach a fork
      // must still take the reader to the session that received it.
      if (destination) {
        this.showing = destination;
        if (attachedHost) {
          this.hostSessions.set(attachedHost, destination);
        }
        void this.refresh(true);
      }
      return;
    }
    if (destination) {
      const moved = pressesAfterSessionHandoff(held, this.live[destination] ?? [], at, delivery);
      if (moved.source.length) {
        this.live[session] = moved.source;
      } else {
        delete this.live[session];
      }
      this.live[destination] = moved.target;
      this.postAcceptedResponses(delivery);
      this.markStartedPresses();
      this.showing = destination;
      if (attachedHost) {
        this.hostSessions.set(attachedHost, destination);
      }
      void this.refresh(true);
      return;
    }
    this.live[session] = pressesAfterHandoff(held, at, delivery);
    this.postAcceptedResponses(delivery);
    this.markStartedPresses();
    this.dropSpentPresses();
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private forgetLivePress(session: string, at: number): void {
    const held = this.live[session] ?? [];
    const left = held.filter((press) => press.at !== at);
    if (left.length) {
      this.live[session] = left;
    } else {
      delete this.live[session];
    }
  }

  // A failed card, taken away by the reader. Nothing else removes one: it is the single card
  // that says something they have to act on, and a notice that clears itself is one they miss.
  //
  // A failed one and no other. A press made between the message going out and its arriving has
  // already replaced this one, and taking that card away would clear a prompt still on its way.
  private dismissLive(session: string, kind: string): void {
    const held = this.live[session];
    if (!held?.some((press) => press.kind === kind && press.failed)) {
      return;
    }
    const left = held.filter((press) => !(press.kind === kind && press.failed));
    if (left.length) {
      this.live[session] = left;
    } else {
      delete this.live[session];
    }
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // The safe way out of a failed prompt. The complete text goes back to the session's
  // stored draft before the notice is removed, then the existing takeDraft path switches the
  // composer, updates its undo steps, and focuses the box. A compaction carries no text and
  // cannot reach this path.
  private restoreLive(session: string, kind: string): void {
    const held = this.live[session];
    const press = held?.find((one) => one.kind === kind && one.kind === 'prompt' && one.failed);
    if (!press) {
      return;
    }
    // An explicit recovery is written at once. Removing the card before a delayed write
    // would leave a window close between the two with no retained copy of the prompt.
    const revision =
      Math.max(this.draftRevisions?.get(session) ?? 0, this.submittingDrafts?.get(session)?.revision ?? 0) + 1;
    this.holdDraft(session, press.text, true, revision);
    void this.post({ type: 'takeDraft', session: session, text: press.text });
    const left = held.filter((one) => one !== press);
    if (left.length) {
      this.live[session] = left;
    } else {
      delete this.live[session];
    }
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // A queued record remains in this book while its agent handoff is opening and awaiting
  // acceptance. The child has not necessarily reported a running turn during that interval,
  // but a control request must still wait behind the record already crossing the boundary.
  private queueHandoffInProgress(state: ComposerState): boolean {
    return state.queued.some((entry) => this.queueHandoffs.has(entry.id));
  }

  // A turn ended, so the session's oldest waiting prompt goes. One at a time: the next
  // is sent when this one ends, by the same path.
  public flushQueue(session: string): void {
    // The session whose turn ended, named by the caller, and never the one the box is
    // aimed at. A drain that read the aim waited for the reader to look back at the
    // session before it would send, which is exactly when they are not looking.
    if (!this.repositoryScopeReady) {
      this.pendingQueueDrains.add(session);
      return;
    }
    const state = this.stateFor(session);
    if (!state) {
      if (this.queues[session]?.length) {
        this.pendingQueueDrains.add(session);
      }
      return;
    }
    if (state.running || state.clearing || !state.queued.length) {
      return;
    }
    const [next, ...rest] = state.queued;
    if (!queueCanDrain(next) || this.queueHandoffs.has(next.id) || this.queuedEditReservations.has(next.id)) {
      return;
    }
    const carried = commentsForQueuedSubmission(state, next, rest);
    let assets = [];
    try {
      assets = this.attachmentStorageDir ? promptAssetsFromStored(this.attachmentStorageDir, next.assets) : [];
    } catch (error) {
      this.queues[state.sessionId] = state.queued.map((entry) =>
        entry.id === next.id
          ? { ...entry, reason: error instanceof Error ? error.message : attachmentRefusal('read') }
          : entry,
      );
      void this.writeDrafts();
      void this.post({ type: 'usage', usage: this.usagePayload() });
      return;
    }
    const ready = { ...state, queued: [], assets, comments: carried };
    const text = next.text;
    if (!text && !carried.length && !assets.length) {
      // The reader removed the comments while they waited. Do not turn that cancellation
      // into an empty prompt, and continue to the next real submission if there is one.
      this.queues[state.sessionId] = queueAfterAcceptedRecovery(rest, next);
      void this.writeDrafts();
      this.flushQueue(session);
      return;
    }
    // Record the attempt before crossing the protocol boundary. If this process stops after
    // the agent accepts but before its answer is stored, the next process must not submit the
    // same prompt again. The waiting card then asks the reader to decide whether to retry.
    if (this.contextSource) this.invalidateContext(state.sessionId);
    const request = clearRequest(state.agent, text);
    if (request && (request.command === 'new' || carried.length > 0 || assets.length > 0)) {
      const resetId =
        'resetId' in next.delivery
          ? next.delivery.resetId
          : request.command === 'new'
            ? next.id
            : `clear:${state.sessionId}`;
      this.queues[state.sessionId] = queueResetInFlight(
        state.queued,
        next.id,
        state.sessionId,
        carried.map((comment) => comment.id),
        resetId,
      );
    } else if (next.delivery?.phase === 'source-owned') {
      this.queues[state.sessionId] = queueSourceDelivery(state.queued, next.id);
    } else if (next.delivery?.phase === 'successor-owned') {
      this.queues[state.sessionId] = queueSuccessorDelivery(state.queued, next.id);
    } else {
      this.queues[state.sessionId] = state.queued.map((entry) =>
        entry.id === next.id ? { ...entry, delivery: { phase: 'delivery', owner: state.sessionId } } : entry,
      );
    }
    const attempted = this.queues[state.sessionId].find((entry) => entry.id === next.id) ?? next;
    this.queueHandoffs.add(next.id);
    void this.writeDrafts()
      .then(() => {
        if (!this.stateFor(state.sessionId)) {
          this.queueHandoffs.delete(next.id);
          this.pendingQueueDrains.add(state.sessionId);
          this.queues[state.sessionId] = (this.queues[state.sessionId] ?? []).map((entry) =>
            entry.id === next.id ? { ...entry, delivery: { phase: 'queued', owner: state.sessionId } } : entry,
          );
          return this.writeDrafts().then(() => this.flushQueue(state.sessionId));
        }
        if (compactSubmission(state.agent, text) && !carried.length && !assets.length) {
          this.startCompaction(ready, attempted);
        } else if (clearSubmission(state.agent, text)) {
          this.startClear(ready, attempted, text);
        } else {
          this.send(ready, text, attempted);
        }
        return undefined;
      })
      .catch((error) => {
        this.queueHandoffs.delete(next.id);
        this.queues[state.sessionId] = (this.queues[state.sessionId] ?? []).map((entry) =>
          entry.id === next.id
            ? {
                ...entry,
                reason:
                  error instanceof Error ? error.message : 'The waiting prompt could not be saved before delivery.',
                delivery: {
                  phase: 'recovery',
                  owner: state.sessionId,
                  reason:
                    error instanceof Error ? error.message : 'The waiting prompt could not be saved before delivery.',
                },
              }
            : entry,
        );
        void this.post({ type: 'usage', usage: this.usagePayload() });
      });
  }

  private promptAssets(session: string) {
    if (!this.attachmentStorageDir) {
      return [];
    }
    try {
      return promptAssetsFromStored(this.attachmentStorageDir, this.assets[session] ?? []);
    } catch {
      return [];
    }
  }

  private assetPreviews(session: string, webview: vscode.Webview): Record<string, string> {
    if (!this.attachmentStorageDir) {
      return {};
    }
    const previews: Record<string, string> = {};
    const stored = [
      ...(this.assets[session] ?? []),
      ...(this.queues[session] ?? []).flatMap((submission) => submission.assets),
      ...(this.live[session] ?? []).flatMap((press) => press.assets ?? []),
    ];
    for (const asset of stored) {
      if (!asset.mime.startsWith('image/')) {
        continue;
      }
      try {
        const staged = promptAssetsFromStored(this.attachmentStorageDir, [asset])[0];
        previews[asset.id] = webview.asWebviewUri(vscode.Uri.file(staged.path)).toString();
      } catch {
        /* The descriptor remains visible without a preview. */
      }
    }
    return previews;
  }

  private promptAssetReferences(): Record<string, StoredPromptAsset[]> {
    const references: Record<string, StoredPromptAsset[]> = {};
    for (const [session, assets] of Object.entries(this.assets)) {
      references[session] = [...assets];
    }
    for (const [session, submissions] of Object.entries(this.queues)) {
      references[session] = [...(references[session] ?? []), ...submissions.flatMap((submission) => submission.assets)];
    }
    return references;
  }

  private setAttachmentNotice(session: string, notice: string): void {
    const target = this.attachmentTarget(session) ?? session;
    this.attachmentNotices[target] = notice;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private clearAttachmentNotice(session: string): void {
    const target = this.attachmentTarget(session) ?? session;
    if (!(target in this.attachmentNotices)) {
      return;
    }
    delete this.attachmentNotices[target];
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private writeAssets(): void {
    this.saved.assets = normalizePromptAssetBook(this.assets);
    this.saved.queues = normalizeQueuedSubmissions(this.queues);
    this.saved.draftCommentIds = normalizeDraftCommentIds(this.draftCommentIds);
    void this.memento?.update(STATE_KEY, this.saved);
    void this.post({ type: 'usage', usage: this.usagePayload() });
    this.postRail(true);
  }

  private attachmentTarget(session: string): string | null {
    const target = this.panelSession(session);
    return this.stateFor(target) ? target : null;
  }

  private claimStaging(session: string, token: string): boolean {
    if (this.staging.has(session)) {
      return false;
    }
    this.staging.add(session);
    this.stagingTokens.set(session, token);
    return true;
  }

  private releaseStaging(session: string, token: string): void {
    if (this.stagingTokens.get(session) !== token) {
      return;
    }
    this.stagingTokens.delete(session);
    this.staging.delete(session);
  }

  private openStagingOperation(
    browserSession: string,
    token: string,
    owner: PanelHost | null,
  ): PromptAssetStagingOperation {
    if (!token) {
      throw new Error('The attachment operation has no identity.');
    }
    const existing = this.stagingOperations.get(token);
    if (existing) {
      if (existing.browserSession !== browserSession) {
        throw new Error('The attachment operation does not match this session.');
      }
      if (owner ? this.browserStagingOwners.get(token) !== owner : this.browserStagingOwners.has(token)) {
        throw new Error('The attachment operation belongs to another panel.');
      }
      return existing;
    }
    const target = this.attachmentTarget(browserSession);
    if (!target) {
      throw new Error('The prompt is no longer available for attachments.');
    }
    if (!this.claimStaging(target, token)) {
      throw new Error('Wait for the attached files to finish staging.');
    }
    const operation = { browserSession, target };
    this.stagingOperations.set(token, operation);
    if (owner) {
      this.browserStagingOwners.set(token, owner);
    }
    void this.post({ type: 'fileStaging', session: browserSession, pending: true, token });
    if (target !== browserSession) {
      void this.post({ type: 'fileStaging', session: target, pending: true, token });
    }
    return operation;
  }

  private closeStagingOperation(token: string, owner: PanelHost | null): boolean {
    const operation = this.stagingOperations.get(token);
    if (!operation) {
      return false;
    }
    if (owner ? this.browserStagingOwners.get(token) !== owner : this.browserStagingOwners.has(token)) {
      return false;
    }
    this.stagingOperations.delete(token);
    this.browserStagingOwners.delete(token);
    this.releaseStaging(operation.target, token);
    void this.post({
      type: 'fileStaging',
      session: operation.browserSession,
      pending: false,
      token,
    });
    if (operation.target !== operation.browserSession) {
      void this.post({ type: 'fileStaging', session: operation.target, pending: false, token });
    }
    return true;
  }

  private closeBrowserStagingForHost(host: PanelHost): void {
    const tokens = [...this.browserStagingOwners].filter(([, owner]) => owner === host).map(([token]) => token);
    for (const token of tokens) {
      this.closeStagingOperation(token, host);
    }
  }

  private settleBrowserStagingOperation(browserSession: string, token: string, host: PanelHost): void {
    const operation = this.stagingOperations.get(token);
    if (!operation || operation.browserSession !== browserSession || !this.closeStagingOperation(token, host)) {
      void this.post({ type: 'fileStaging', session: browserSession, pending: false, token });
    }
  }

  private acceptedBrowserStagingOperation(
    browserSession: string,
    token: string,
    host: PanelHost,
  ): PromptAssetStagingOperation {
    const operation = this.stagingOperations.get(token);
    if (!operation || this.browserStagingOwners.get(token) !== host || operation.browserSession !== browserSession) {
      throw new Error('The attachment operation is no longer active.');
    }
    return operation;
  }

  private async stageFiles(
    browserSession: string,
    inputs: readonly PromptAssetInput[],
    token: string,
    host: PanelHost,
  ): Promise<void> {
    let operation: PromptAssetStagingOperation | null = null;
    try {
      operation = this.acceptedBrowserStagingOperation(browserSession, token, host);
      if (!inputs.length) {
        this.setAttachmentNotice(operation.target, attachmentRefusal('read'));
        return;
      }
      if (!this.attachmentStorageDir) {
        throw new Error('Attachment storage is unavailable.');
      }
      const state = this.stateFor(operation.target);
      if (!state) {
        throw new Error('The prompt is no longer available for attachments.');
      }
      const existing = this.assets[operation.target] ?? [];
      if (existing.length + inputs.length > MAX_PROMPT_ASSETS) {
        this.setAttachmentNotice(operation.target, attachmentRefusal('count', '', 0, inputs.length));
        return;
      }
      const tooLarge = inputs.find((input) => input.bytes.byteLength > MAX_PROMPT_ASSET_BYTES);
      if (tooLarge) {
        this.setAttachmentNotice(
          operation.target,
          attachmentRefusal('file-size', tooLarge.name, tooLarge.bytes.byteLength),
        );
        return;
      }
      const total =
        existing.reduce((sum, asset) => sum + asset.size, 0) +
        inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
      if (total > MAX_PROMPT_ASSET_TOTAL_BYTES) {
        this.setAttachmentNotice(operation.target, attachmentRefusal('total-size', '', total));
        return;
      }
      const unsupported = inputs.find((input) => !agentTakesAsset(state.agent, input.mime));
      if (unsupported) {
        this.setAttachmentNotice(operation.target, attachmentRefusal('unsupported', unsupported.name));
        return;
      }
      validatePromptAssetBatch(
        this.assets[operation.target] ?? [],
        inputs.map((input) => ({
          name: input.name,
          mime: input.mime,
          size: input.bytes.byteLength,
        })),
      );
      const written = await stagePromptAssets(this.attachmentStorageDir, inputs);
      try {
        operation = this.acceptedBrowserStagingOperation(browserSession, token, host);
        const target = operation.target;
        const settled = this.stateFor(target);
        if (!settled) {
          throw new Error('The prompt is no longer available for attachments.');
        }
        const unsupportedNow = unsupportedPromptAsset(settled.agent, written);
        if (unsupportedNow) {
          await deleteStagedPromptAssets(this.attachmentStorageDir, written);
          this.setAttachmentNotice(target, attachmentRefusal('unsupported', unsupportedNow.name));
          return;
        }
        const current = this.assets[target] ?? [];
        this.assets[target] = mergePromptAssets(current, written);
      } catch (error) {
        await deleteStagedPromptAssets(this.attachmentStorageDir, written);
        throw error;
      }
      this.writeAssets();
      this.clearAttachmentNotice(operation.target);
    } catch {
      this.setAttachmentNotice(operation?.target ?? browserSession, attachmentRefusal('read', inputs[0]?.name));
    } finally {
      if (operation) {
        this.closeStagingOperation(token, host);
      } else {
        void this.post({ type: 'fileStaging', session: browserSession, pending: false, token });
      }
    }
  }

  private async removeFile(session: string, id: string): Promise<void> {
    const held = this.assets[session] ?? [];
    const removed = held.find((asset) => asset.id === id);
    if (!removed) {
      return;
    }
    const left = held.filter((asset) => asset.id !== id);
    if (left.length) {
      this.assets[session] = left;
    } else {
      delete this.assets[session];
    }
    this.writeAssets();
    this.clearAttachmentNotice(session);
    if (!this.assetIdsInHandoff.has(id) && this.attachmentStorageDir) {
      await deleteStagedPromptAssets(this.attachmentStorageDir, [removed]).catch((_error) => {
        this.setAttachmentNotice(session, attachmentRefusal('read', removed.name));
      });
    }
  }

  // What the reader typed, kept against the session they typed it into.
  // The session is the one the box was aimed at when the reader typed, named on the
  // message. Worked out here instead, through `composerState`, it was whichever session
  // was newest or pinned at the moment the message arrived, and `sessionRows` is rebuilt on
  // every poll: with several agents writing transcripts the aim moves under the reader
  // between the keystroke and the send, and the prompt lands somewhere they are not looking.
  // `keep` is what the reader typed and `text` is what the box shows. They differ only while
  // the reader walks back through earlier prompts. The send control has to follow the box, or
  // it reads Stop over a recalled prompt and the press that meant to send it kills the turn.
  // The store and the rail follow `keep`, or a reload finds a sent prompt where the reader
  // left a sentence they were writing.
  private setDraft(text: string, keep: string, session: string): void {
    // The row rather than the whole state. This runs on every letter typed, and building the
    // state merges and cleans every prompt the walk offers to answer a question about which
    // session the letter belongs to.
    if (!this.rowForSession(session)) {
      return;
    }
    this.typedRenames.delete(session);
    const shown = hasUnsentPrompt(this.boxText[session] ?? '') !== hasUnsentPrompt(text);
    // After `holdDraft`, which puts the same words in both for every other caller.
    const railMoved = this.holdDraft(session, keep);
    this.boxText[session] = text;
    this.clearAttachmentNotice(session);
    if (shown || railMoved) {
      void this.post({ type: 'usage', usage: this.usagePayload() });
    }
  }

  // One way to change the words held in a session's box. Persistence can wait for
  // ordinary typing, while an explicit recovery is written before its failed card leaves.
  // The rail moves only when meaningful text appears or disappears, never once per letter.
  private holdDraft(session: string, text: string, immediate: boolean = false, revision?: number): boolean {
    if (revision !== undefined) {
      this.draftRevisions ??= new Map();
      this.draftRevisions.set(session, Math.max(this.draftRevisions.get(session) ?? 0, revision));
      this.typedRenames?.delete(session);
    }
    const clearing = this.clearingDraftRevision;
    if (text === '' && clearing?.session === session && (this.draftRevisions?.get(session) ?? 0) > clearing.revision)
      return false;
    const moved = hasUnsentPrompt(this.drafts[session]) !== hasUnsentPrompt(text);
    this.drafts[session] = text;
    // Every caller but the reader's own keystrokes puts the same words in both, and this is
    // what keeps a cleared or recovered draft from leaving stale text on the send control.
    this.boxText[session] = text;
    if (immediate) {
      void this.writeDrafts();
    } else {
      this.rememberDrafts();
    }
    if (moved) {
      this.postRail(true);
    }
    return moved;
  }

  // The unsent prompts, on their way to storage that outlives the window.
  //
  // Waited on rather than written at once. This runs on every keystroke, and the store
  // behind it is a real one on disk. The wait is short enough that a reader who stops typing
  // and closes the window keeps what they typed, and `dispose` writes whatever it still
  // holds.
  private rememberDrafts(): void {
    if (this.draftSave) {
      return;
    }
    this.draftSave = setTimeout(() => {
      this.draftSave = null;
      void this.writeDrafts();
    }, DRAFT_SAVE_MS);
  }

  // Through the normalizer, so one rule decides what is stored and the same rule reads it
  // back. It is what drops the boxes the reader emptied: an empty draft and no draft are the
  // same thing to the box, and a session typed into once should not cost an entry
  // forever.
  // That this window started a session, kept for the next window as well as this one.
  // Written at once rather than on the next save that happens to pass: the press that starts
  // a session is the only moment this fact exists, and a window closed before the next
  // save would leave the session to be read as a run for ever. Cut to the ceiling on the
  // way out as well as on the way in, the way every stored list here is.
  private rememberStarted(session: string): void {
    this.startedHere.add(session);
    this.saved.started = [...this.startedHere].slice(-SESSION_LIMIT);
    void this.memento?.update(STATE_KEY, this.saved);
  }

  private importPromptRecovery(snapshot: unknown): Promise<void> {
    const merged = mergeSubmittedPrompts(this.saved.submittedPrompts, snapshot);
    this.saved.submittedPrompts = merged;
    void this.post({ type: 'promptRecovery', submittedPrompts: merged });
    const write = (this.submissionWrites ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.memento?.update(STATE_KEY, this.saved);
        await this.post({ type: 'promptRecovery', submittedPrompts: this.saved.submittedPrompts ?? [] });
      });
    this.submissionWrites = write;
    return write;
  }

  private capturePanelRecovery(host: PanelHost): Promise<void> {
    const request = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.panelRecoveryWaiters.delete(request);
        reject(new Error('The panel did not return its saved prompts.'));
      }, 10_000);
      this.panelRecoveryWaiters.set(request, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      void Promise.resolve(this.sendToHost(host, { type: 'requestPromptRecovery', request })).catch(reject);
    });
  }

  private confirmPromptOwner(id: string | undefined, owner: string, accepted = false): void {
    const attempt = this.saved.submittedPrompts?.find((entry) => entry.id === id);
    if (!attempt) return;
    void this.importPromptRecovery([
      { ...attempt, owner, accepted: attempt.accepted || accepted, ownerRevision: (attempt.ownerRevision ?? 0) + 1 },
    ]).catch(() => {
      void vscode.window.showInformationMessage(
        'Arc: the prompt remains available, but its destination could not be saved.',
      );
    });
  }

  private async acceptSubmission(
    text: string,
    session: string,
    revision: number,
    source: string,
    host: PanelHost,
    supplied?: SubmittedPrompt,
  ): Promise<void> {
    const state = this.stateFor(session);
    const draft = this.newDrafts[session];
    const cwd = state ? this.cwdForSession(state.agent, session) : null;
    const captured = state
      ? {
          ...state,
          comments: state.comments.slice(),
          submittedComments: commentsForActiveSubmission(state),
          submittedDraftRevision: revision,
          assets: state.assets?.slice(),
          draftCommentIds: state.draftCommentIds?.slice(),
          queued: state.queued.slice(),
          settings: { ...state.settings },
        }
      : null;
    const assets = (this.assets[session] ?? []).slice();
    const attempt = supplied ?? {
      id: crypto.randomUUID(),
      source,
      revision,
      text,
      order: (this.saved.submittedPrompts?.at(-1)?.order ?? 0) + 1,
    };
    const restore = () => {
      void this.post({ type: 'restoreDraft', session: source, text, revision });
    };
    this.submissionsInFlight ??= new Set();
    if (this.submissionsInFlight.has(session)) {
      restore();
      return;
    }
    this.submissionsInFlight.add(session);
    this.submittingDrafts ??= new Map();
    if (captured)
      this.submittingDrafts.set(session, {
        revision,
        commentIds: captured.submittedComments.map((comment) => comment.id),
        assets,
      });
    for (const asset of assets) this.assetIdsInHandoff.add(asset.id);
    try {
      const validated = mergeSubmittedPrompts([attempt]);
      if (validated.length !== 1 || attempt.text !== text || attempt.source !== source || attempt.revision !== revision)
        throw new Error('The prompt could not be retained.');
      await this.importPromptRecovery(validated);
      if (
        !captured ||
        !this.hosts.includes(host) ||
        this.panelSession(source, host) !== session ||
        !this.stateFor(session) ||
        this.cwdForSession(captured.agent, session) !== cwd
      ) {
        restore();
        return;
      }
      const previous = this.promptOriginHost;
      this.promptOriginHost = host;
      this.clearingDraftRevision = { session, revision };
      try {
        const current = this.stateFor(session);
        if (!current) {
          restore();
          return;
        }
        const ready = {
          ...captured,
          submittedRecoveryId: attempt.id,
          running: current.running,
          live: current.live,
          clearing: current.clearing,
          queued: current.queued,
          queueHandoffs: current.queueHandoffs,
        };
        this.sendPrompt(text, session, revision, source, ready, assets, draft, attempt.id);
      } finally {
        this.promptOriginHost = previous;
        this.clearingDraftRevision = null;
      }
    } catch {
      restore();
    } finally {
      this.submissionsInFlight.delete(session);
      this.submittingDrafts.delete(session);
      for (const asset of assets) if (!this.assetHandoffs.has(session)) this.assetIdsInHandoff.delete(asset.id);
    }
  }

  private writeDrafts(): Promise<void> {
    this.saved.drafts = normalizeDrafts(this.drafts);
    this.saved.sentPrompts = sentPromptsToSave(this.sentPrompts, this.promptsBySession);
    this.saved.assets = normalizePromptAssetBook(this.assets);
    this.saved.queues = normalizeQueuedSubmissions(this.queues);
    this.saved.draftCommentIds = normalizeDraftCommentIds(this.draftCommentIds);
    return Promise.resolve(this.memento?.update(STATE_KEY, this.saved));
  }

  // A press on Send, or an Enter. Whether that sends or queues is decided in
  // `composerview.ts`, because a rule this file made would be one no test could reach.
  private sendPrompt(
    text: string,
    session: string,
    revision: number,
    browserSession: string = session,
    captured?: ComposerState,
    capturedAssets?: StoredPromptAsset[],
    capturedDraft?: NewSessionDraft,
    recoveryId?: string,
  ): void {
    const state = captured ?? this.stateFor(session);
    if (!state) {
      void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
      return;
    }
    // A typed Codex `/rename` is the rail's rename, not a turn. It works beside a running
    // turn, so it never waits in the queue and answers no open request. It sends no files and
    // no comments, so staging files do not hold it back, and they stay for the next prompt
    // with the comments. An open draft recovery keeps its slot for the next prompt too.
    const renamed = renameRequest(state.agent, text);
    if (renamed !== null) {
      this.holdDraft(state.sessionId, '');
      void this.renameFromComposer(state.sessionId, renamed, text, browserSession, revision);
      return;
    }
    if (this.assetHandoffs.has(state.sessionId)) {
      void vscode.window.showInformationMessage('Arc: wait for the attached prompt to be accepted.');
      void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
      return;
    }
    if (this.staging.has(state.sessionId)) {
      void vscode.window.showInformationMessage('Arc: wait for the attached files to finish staging.');
      void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
      return;
    }
    const heldAssets = capturedAssets ?? this.assets[state.sessionId] ?? [];
    const unsupported = unsupportedPromptAsset(state.agent, heldAssets);
    if (unsupported) {
      this.setAttachmentNotice(state.sessionId, attachmentRefusal('unsupported', unsupported.name));
      void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
      return;
    }
    if (this.attachmentStorageDir && heldAssets.length > 0) {
      try {
        resolvePromptAssets(this.attachmentStorageDir, heldAssets);
      } catch (error) {
        this.setAttachmentNotice(
          state.sessionId,
          error instanceof Error && error.message ? error.message : attachmentRefusal('read'),
        );
        void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
        return;
      }
    }
    // A command the panel answers itself never leaves. `/mcp` draws a list of servers in the
    // agent's own terminal and the CLI answers a panel with nothing at all, so sent as a
    // prompt it went out and nothing came back. The panel draws that list already, and the
    // command opens it. The box is cleared the way a sent prompt clears it, because the
    // reader has finished with those words either way.
    const opens = panelCommand(text);
    if (opens) {
      this.holdDraft(state.sessionId, '');
      void this.post({ type: 'openPick', control: opens });
      void this.post({ type: 'usage', usage: this.usagePayload() });
      // The control is opened at once and its contents are asked for behind it, because the
      // asking needs a child and this file has none. A menu that waited for the answer would
      // sit on a press for as long as the slowest server takes to time out.
      this.onPanelCommand?.(
        state.sessionId,
        state.agent,
        opens,
        this.newDrafts[state.sessionId] ?? null,
        this.cwdForSession(state.agent, state.sessionId),
      );
      return;
    }
    const recovery = state.queued.find((entry) => entry.delivery.phase === 'draft-recovery');
    if (
      recovery?.delivery.phase === 'draft-recovery' &&
      (text.trim() || commentsForActiveSubmission(state).length || heldAssets.length)
    ) {
      const restored = queueRecoverySubmission(
        recovery,
        text,
        commentsForActiveSubmission(state).map((comment) => comment.id),
        heldAssets,
        Date.now(),
        state.agent,
      );
      if (!restored) {
        return;
      }
      if (recoveryId) restored.recoveryId = recoveryId;
      this.queues[state.sessionId] = state.queued.map((entry) => (entry === recovery ? restored : entry));
      this.holdDraft(state.sessionId, '');
      this.releaseSubmittedCommentClaims(state);
      if (heldAssets.length) {
        const carriedIds = new Set(heldAssets.map((asset) => asset.id));
        const remaining = (this.assets[state.sessionId] ?? []).filter((asset) => !carriedIds.has(asset.id));
        if (remaining.length) this.assets[state.sessionId] = remaining;
        else delete this.assets[state.sessionId];
      }
      this.answerOpenAsks(state.sessionId, 'queue');
      void this.writeDrafts().then(() => this.flushQueue(state.sessionId));
      void this.post({ type: 'usage', usage: this.usagePayload() });
      return;
    }
    // A control turn cannot overlap the session's active turn. Classify it before the
    // ordinary send decision because both supported agents accept a prompt while running.
    const compaction = compactAction(
      state.agent,
      text,
      state.running || state.clearing || this.queueHandoffInProgress(state),
    );
    if (compaction) {
      if (compaction === 'queue') {
        const queuedCommentIds = commentsForActiveSubmission(state).map((comment) => comment.id);
        const queuedAssets = heldAssets;
        const queued =
          queuedCommentIds.length || queuedAssets.length
            ? queueSubmissionAfter(
                state.queued,
                crypto.randomUUID(),
                text,
                queuedCommentIds,
                queuedAssets,
                Date.now(),
                state.clearing,
                { agent: state.agent, owner: state.sessionId },
              )
            : queueAfter(state.queued, crypto.randomUUID(), text, Date.now(), state.clearing, {
                agent: state.agent,
                owner: state.sessionId,
              });
        if (queued.length === state.queued.length || !queuedSubmissionBookFits(this.queues, state.sessionId, queued)) {
          void vscode.window.showInformationMessage(
            'Arc: the waiting queue cannot retain this prompt. Drop a waiting prompt or shorten this one.',
          );
          void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
          return;
        }
        this.holdDraft(state.sessionId, '');
        this.queues[state.sessionId] = recoveryId
          ? queued.map((entry, index) => (index === queued.length - 1 ? { ...entry, recoveryId } : entry))
          : queued;
        this.releaseSubmittedCommentClaims(state);
        if (queuedAssets.length) {
          const carriedIds = new Set(heldAssets.map((asset) => asset.id));
          const remaining = (this.assets[state.sessionId] ?? []).filter((asset) => !carriedIds.has(asset.id));
          if (remaining.length) this.assets[state.sessionId] = remaining;
          else delete this.assets[state.sessionId];
        }
        void this.writeDrafts();
        this.answerOpenAsks(state.sessionId, compaction);
        void this.post({ type: 'usage', usage: this.usagePayload() });
      } else {
        this.holdDraft(state.sessionId, '');
        this.answerOpenAsks(state.sessionId, compaction);
        this.startCompaction(state);
      }
      return;
    }
    const clear = clearAction(state.agent, text, state.running || state.clearing || this.queueHandoffInProgress(state));
    if (clear) {
      if (this.contextSource) this.invalidateContext(state.sessionId);
      const request = clearRequest(state.agent, text);
      if (clear === 'queue' || request?.command === 'new') {
        const queuedCommentIds = commentsForActiveSubmission(state).map((comment) => comment.id);
        const queuedAssets = heldAssets;
        const queued =
          queuedCommentIds.length || queuedAssets.length
            ? queueSubmissionAfter(
                state.queued,
                crypto.randomUUID(),
                text,
                queuedCommentIds,
                queuedAssets,
                Date.now(),
                state.clearing,
                { agent: state.agent, owner: state.sessionId },
              )
            : queueAfter(state.queued, crypto.randomUUID(), text, Date.now(), state.clearing, {
                agent: state.agent,
                owner: state.sessionId,
              });
        if (queued.length === state.queued.length || !queuedSubmissionBookFits(this.queues, state.sessionId, queued)) {
          void vscode.window.showInformationMessage(
            'Arc: the waiting queue cannot retain this prompt. Drop a waiting prompt or shorten this one.',
          );
          void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
          return;
        }
        this.holdDraft(state.sessionId, '');
        this.queues[state.sessionId] = recoveryId
          ? queued.map((entry, index) => (index === queued.length - 1 ? { ...entry, recoveryId } : entry))
          : queued;
        this.releaseSubmittedCommentClaims(state);
        if (queuedAssets.length) {
          const carriedIds = new Set(heldAssets.map((asset) => asset.id));
          const remaining = (this.assets[state.sessionId] ?? []).filter((asset) => !carriedIds.has(asset.id));
          if (remaining.length) this.assets[state.sessionId] = remaining;
          else delete this.assets[state.sessionId];
        }
        void this.writeDrafts();
        this.answerOpenAsks(state.sessionId, clear);
        void this.post({ type: 'usage', usage: this.usagePayload() });
        if (!state.running && !state.clearing) {
          this.flushQueue(state.sessionId);
        }
      } else {
        this.holdDraft(state.sessionId, '');
        this.answerOpenAsks(state.sessionId, clear);
        this.startClear(state, null, text);
      }
      return;
    }
    const meant = sendAction({ ...state, onScreen: text });
    if (meant === 'nothing') {
      // The browser clears optimistically. Its view can be one host message behind a newly
      // started compaction, so return the exact revision even when the current view would
      // already have disabled Send.
      void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
      return;
    }
    if (meant === 'queue') {
      const queuedAssets = heldAssets;
      const queued = queueSubmissionAfter(
        state.queued,
        crypto.randomUUID(),
        text,
        commentsForActiveSubmission(state).map((comment) => comment.id),
        queuedAssets,
        Date.now(),
        state.clearing,
        { agent: state.agent, owner: state.sessionId },
      );
      if (queued.length === state.queued.length || !queuedSubmissionBookFits(this.queues, state.sessionId, queued)) {
        void vscode.window.showInformationMessage(
          'Arc: the waiting queue cannot retain this prompt. Drop a waiting prompt or shorten this one.',
        );
        void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
        return;
      }
      this.holdDraft(state.sessionId, '');
      this.queues[state.sessionId] = recoveryId
        ? queued.map((entry, index) => (index === queued.length - 1 ? { ...entry, recoveryId } : entry))
        : queued;
      this.releaseSubmittedCommentClaims(state);
      if (queuedAssets.length) {
        const carriedIds = new Set(heldAssets.map((asset) => asset.id));
        const remaining = (this.assets[state.sessionId] ?? []).filter((asset) => !carriedIds.has(asset.id));
        if (remaining.length) this.assets[state.sessionId] = remaining;
        else delete this.assets[state.sessionId];
      }
      void this.writeDrafts();
      this.answerOpenAsks(state.sessionId, meant);
      void this.post({ type: 'usage', usage: this.usagePayload() });
      return;
    }
    this.holdDraft(state.sessionId, '');
    this.answerOpenAsks(state.sessionId, meant);
    this.send(state, text, null, capturedDraft, capturedAssets, recoveryId);
  }

  // Every request this session is waiting on, answered because the reader typed instead
  // of pressing a choice. The child is blocked on the question or the permission and reads
  // nothing else until one goes back, so this runs before the prompt is handed over, before
  // it joins the queue, and before a compaction starts. The agent is told that the reader
  // answered in the message that follows, which is a different thing from a refusal.
  //
  // `composerview.ts` decides which presses answer, because a press that leaves what was
  // typed in the box has sent nothing and must leave the requests where they are.
  private answerOpenAsks(session: string, meant: PressMeaning): void {
    const waiting = this.asks.filter((entry) => entry.session === session);
    for (const open of asksAnsweredBySend(meant, waiting)) {
      this.onAnswerAsk?.(session, open.ask.id, ANSWERED_IN_PROMPT);
    }
  }

  // The one place a prompt leaves for an agent. The reader's text goes with the comments
  // they left on this session's turns, assembled in `composerview.ts`, and those
  // comments then go.
  private send(
    state: ComposerState,
    text: string,
    queued: QueuedSubmission | null = null,
    capturedDraft?: NewSessionDraft,
    capturedAssets?: StoredPromptAsset[],
    recoveryId?: string,
  ): void {
    if (this.contextSource) this.invalidateContext(state.sessionId);
    // A queued command reaches this method after the turn ahead of it ends, so command
    // recognition belongs here as well as on the first press. It must happen before prompt
    // assembly, which would attach the reader's comments and hand the text to the model.
    if (compactSubmission(state.agent, text) && !queued) {
      this.startCompaction(state, queued);
      return;
    }
    if (clearSubmission(state.agent, text) && !queued) {
      this.startClear(state, queued);
      return;
    }
    // The prompts the Up arrow offers, filed where a prompt actually leaves for an agent.
    // Filed at the press instead, a command the panel answers itself, a compaction, and a
    // queued prompt the reader then removes all sat in front of every real prompt for the
    // life of the window, and the removed one had never gone anywhere at all.
    this.sentPrompts[state.sessionId] = sentAfter(this.sentPrompts[state.sessionId] ?? [], text);
    // Read before the handoff rather than after it. A comment written while the prompt is on
    // its way was not in that prompt, and gathering the set again on the way back would take
    // it out of the reader's hands unsent.
    const carried = commentsForActiveSubmission(state);
    const going = agentPromptToSend({ ...state, draft: text });
    const carriedAssets = storedAssetsForPrompt(
      queued?.assets ?? capturedAssets ?? this.assets[state.sessionId] ?? [],
      going.assets,
    );
    const assetHandoff = carriedAssets.length ? this.assetCompletions.begin() : null;
    if (carriedAssets.length) {
      this.assetHandoffs.add(state.sessionId);
    }
    for (const asset of carriedAssets) {
      this.assetIdsInHandoff.add(asset.id);
    }
    // What the panel draws while the prompt is on its way, and it is what actually goes rather
    // than what the box held: comments alone are a prompt, so a card built from the box would
    // draw nothing for the press that sends three comments and an empty box.
    const display = going.text || `Attached: ${going.assets.map((asset) => asset.name).join(', ')}`;
    const pressed = this.noteLive(state, 'prompt', display, carriedAssets);
    if (this.promptOriginHost) {
      this.livePressHosts.set(state.sessionId + '\0' + pressed, this.promptOriginHost);
    }
    this.clearAttachmentNotice(state.sessionId);
    const draft = capturedDraft ?? this.newDrafts[state.sessionId];
    let pendingTurnId: number | undefined;
    const onSubmitted = (session: string, turnId: number) => {
      if (this.disposed || !session || !(this.live[state.sessionId] ?? []).some((one) => one.at === pressed)) return;
      if (pendingTurnId !== undefined) this.forgetPendingResponses(pendingTurnId);
      pendingTurnId = turnId;
      const timer = setTimeout(() => this.forgetPendingResponses(turnId), LIVE_PRESS_LIMIT_MS);
      timer.unref?.();
      this.pendingResponseOwners.set(turnId, { session, source: state.sessionId, at: pressed, timer });
    };
    const went = draft
      ? this.onSendDraftPrompt?.(draft, going, onSubmitted)
      : this.onSendPrompt?.(
          state.agent,
          state.sessionId,
          this.cwdForSession(state.agent, state.sessionId),
          going,
          onSubmitted,
        );
    // Waited for. The handoff reaches an agent through two awaits, and taking the comments
    // before either one destroys them on every path that ends without sending: no folder
    // open, a wrong path to the agent, a session whose child has exited. The card reads
    // the same answer, so a prompt that reached nobody says so instead of sitting on Sending.
    void Promise.resolve(went)
      .then((answer) => {
        if (this.disposed) return;
        const delivery = answer ?? {
          delivered: false,
          reason: 'No agent handoff is available. Restore this prompt and try again.',
        };
        if (delivery.delivered && (recoveryId ?? queued?.recoveryId))
          this.confirmPromptOwner(recoveryId ?? queued?.recoveryId, delivery.session || state.sessionId, true);
        let adopted = false;
        let assetSession = state.sessionId;
        if (draft && delivery.delivered && delivery.session) {
          try {
            this.adoptDraft(draft.draftId, delivery.session, draft, state.settings);
          } catch (error) {
            delivery.delivered = false;
            delivery.reason = error instanceof Error ? error.message : 'The new session could not be adopted.';
          }
          adopted = delivery.delivered;
          if (adopted) {
            assetSession = delivery.session;
            const sourceHostKey = state.sessionId + '\0' + pressed;
            const originHost = this.livePressHosts.get(sourceHostKey);
            if (originHost) {
              this.livePressHosts.delete(sourceHostKey);
              this.livePressHosts.set(delivery.session + '\0' + pressed, originHost);
            }
          }
        }
        if (queued) {
          const held = this.queues[state.sessionId] ?? [];
          const reason = delivery.reason || 'The agent did not accept this prompt.';
          this.queues[state.sessionId] = delivery.delivered
            ? queueAfterAcceptedRecovery(queueWithout(held, queued.id), queued)
            : queued.delivery.phase === 'source-delivery'
              ? queueSourceFailed(held, queued.id, reason)
              : queued.delivery.phase === 'successor-delivery'
                ? queueSuccessorFailed(held, queued.id, reason)
                : held.map((entry) =>
                    entry.id === queued.id
                      ? { ...entry, reason, delivery: { phase: 'recovery', owner: state.sessionId, reason } }
                      : entry,
                  );
          if (!this.queues[state.sessionId].length) {
            delete this.queues[state.sessionId];
          }
          void this.writeDrafts();
        }
        if (!queued && delivery.delivered) {
          if (this.draftCommentIds[assetSession]?.length) this.releaseSubmittedCommentClaims(state, assetSession);
          this.queues[state.sessionId] = queueAfterAcceptedRecovery(this.queues[state.sessionId] ?? []);
          if (!this.queues[state.sessionId].length) {
            delete this.queues[state.sessionId];
          }
          void this.writeDrafts().then(() => this.flushQueue(state.sessionId));
        }
        this.dropCarriedComments(carried, delivery.delivered);
        this.dropCarriedAssets(
          assetSession,
          delivery.session || assetSession,
          carriedAssets,
          delivery.delivered,
          assetHandoff,
          delivery.turnId,
        );
        if (queued && !delivery.delivered) {
          this.forgetLivePress(state.sessionId, pressed);
          this.queueHandoffs.delete(queued.id);
          void this.post({ type: 'usage', usage: this.usagePayload() });
        } else {
          this.livePressAnswered(
            draft && delivery.delivered && delivery.session ? delivery.session : state.sessionId,
            pressed,
            delivery,
          );
        }
        if (adopted) {
          void this.refresh(true);
        }
      })
      .finally(() => {
        if (pendingTurnId !== undefined) this.forgetPendingResponses(pendingTurnId);
        this.assetHandoffs.delete(state.sessionId);
        if (queued) {
          this.queueHandoffs.delete(queued.id);
        }
      });
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private releaseSubmittedCommentClaims(state: ComposerState, session = state.sessionId): void {
    if (
      state.submittedDraftRevision !== undefined &&
      (this.draftRevisions?.get(session) ?? 0) > state.submittedDraftRevision
    )
      return;
    const submitted = new Set(state.draftCommentIds ?? []);
    const left = (this.draftCommentIds[session] ?? []).filter((id) => !submitted.has(id));
    if (left.length) this.draftCommentIds[session] = left;
    else delete this.draftCommentIds[session];
  }

  // What a delivered prompt takes with it. Taken away rather than marked: a comment that has
  // gone out was said and the agent has it, and a card still drawing it would leave the reader
  // working out which of their own marks are outstanding. The marks on the cards clear with
  // it, which is the whole sign on screen that the prompt carried them.
  private dropCarriedComments(carried: readonly TurnComment[], delivered: boolean): void {
    const left = commentsAfterSend(this.saved.comments, carried, delivered);
    if (left.length === this.saved.comments.length) {
      return;
    }
    this.saved.comments = left;
    void this.memento?.update(STATE_KEY, this.saved);
    // Every host, because both draw their own copy and neither saw this happen.
    void this.post({ type: 'notes', comments: this.saved.comments });
    this.postRail(true);
  }

  private dropCarriedAssets(
    descriptorSession: string,
    deliverySession: string,
    carried: readonly StoredPromptAsset[],
    delivered: boolean,
    handoff: number | null,
    turnId?: number,
  ): void {
    const completedDuringHandoff = handoff !== null && this.assetCompletions.finish(handoff, deliverySession);
    for (const asset of carried) {
      this.assetIdsInHandoff.delete(asset.id);
    }
    const carriedIds = new Set(carried.map((asset) => asset.id));
    if (delivered) {
      const left = (this.assets[descriptorSession] ?? []).filter((asset) => !carriedIds.has(asset.id));
      if (left.length) {
        this.assets[descriptorSession] = left;
      } else {
        delete this.assets[descriptorSession];
      }
      this.writeAssets();
    }
    if (!this.attachmentStorageDir) {
      return;
    }
    if (!delivered) {
      const disposable = promptAssetsSafeToDelete(this.promptAssetReferences(), this.assetIdsInHandoff, carried);
      if (disposable.length) {
        void deleteStagedPromptAssets(this.attachmentStorageDir, disposable).catch((error) => {
          void vscode.window.showErrorMessage(`Arc: ${(error as Error).message}`);
        });
      }
      return;
    }
    if (completedDuringHandoff || (turnId !== undefined && this.completedAssetTurns.delete(turnId))) {
      void deleteStagedPromptAssets(this.attachmentStorageDir, carried).catch((error) => {
        void vscode.window.showErrorMessage(`Arc: ${(error as Error).message}`);
      });
      return;
    }
    this.deferredAssetDeletes[deliverySession] = [
      ...(this.deferredAssetDeletes[deliverySession] ?? []),
      { turnId: turnId ?? null, assets: [...carried] },
    ];
  }

  public recordDeliveredPromptTurn(session: string, turnId: number): void {
    if (!this.attachmentStorageDir) {
      return;
    }
    if (this.completedAssetTurns.delete(turnId)) {
      return;
    }
    this.deferredAssetDeletes[session] = [...(this.deferredAssetDeletes[session] ?? []), { turnId, assets: [] }];
  }

  public releaseDeliveredPromptAssets(session: string, all: boolean = false, endedTurnId?: number): void {
    if (all) {
      this.assetCompletions.complete(session);
    }
    const batches = this.deferredAssetDeletes[session] ?? [];
    const release = promptAssetReleaseIndexes(
      batches.map((batch) => batch.turnId),
      all,
      endedTurnId,
    );
    if (!release.length) {
      if (endedTurnId !== undefined) {
        this.completedAssetTurns.add(endedTurnId);
      }
      return;
    }
    if (!this.attachmentStorageDir) {
      return;
    }
    const selected = new Set(release);
    const heldBatches = batches.filter((_, index) => selected.has(index));
    const held = heldBatches.flatMap((batch) => batch.assets);
    const left = batches.filter((_, index) => !selected.has(index));
    if (left.length) {
      this.deferredAssetDeletes[session] = left;
    } else {
      delete this.deferredAssetDeletes[session];
    }
    if (!held.length) {
      return;
    }
    void deleteStagedPromptAssets(this.attachmentStorageDir, held).catch((error) => {
      this.deferredAssetDeletes[session] = [...heldBatches, ...(this.deferredAssetDeletes[session] ?? [])];
      void vscode.window.showErrorMessage(`Arc: ${(error as Error).message}`);
    });
  }

  // A compaction, asked for by the meter and sent as the command and nothing else.
  //
  // It does not go through `sendPrompt`. That one assembles the reader's comments under the
  // text, hands the lot over and then takes the comments away, and it clears the stored
  // draft on the way past: one press mailed a whole review out inside a `/compact`, cleared
  // it off the cards, and left Send drawn unpressable over a box with the reader's prompt
  // still in it.
  private compact(session: string): void {
    const state = this.stateFor(session);
    const command = state ? compactCommand(state.agent) : '';
    if (!state || !command) {
      return;
    }
    if (compactAction(state.agent, command, state.running || this.queueHandoffInProgress(state)) === 'queue') {
      // The context figure is separate from the box, so queuing its command leaves the
      // reader's draft exactly where it was.
      const queued = queueAfter(state.queued, crypto.randomUUID(), command, Date.now(), false, {
        agent: state.agent,
        owner: state.sessionId,
      });
      if (queued.length === state.queued.length || !queuedSubmissionBookFits(this.queues, state.sessionId, queued)) {
        void vscode.window.showInformationMessage(
          'Arc: the waiting queue cannot retain this compaction request. Drop a waiting prompt and try again.',
        );
        return;
      }
      this.queues[state.sessionId] = queued;
      void this.writeDrafts();
      void this.post({ type: 'usage', usage: this.usagePayload() });
      return;
    }
    this.startCompaction(state);
  }

  private startCompaction(state: ComposerState, queued: QueuedSubmission | null = null): void {
    if (this.contextSource) this.invalidateContext(state.sessionId);
    // The press is recorded the way a prompt's is, and it carries none of the reader's words
    // because a compaction has none. This is the press the reader named first: it drew nothing
    // at any point until its card arrived off the transcript, which is a whole session's
    // work with no sign that anything was asked for.
    const pressed = this.noteLive(state, 'compact', '');
    // The answer is waited on for the card alone. Nothing is taken away here, so a compaction
    // that reached no child still has nothing to undo, but a card left saying that an agent is
    // compacting would be the panel claiming work that never started.
    const settle = (delivery: PromptDelivery): void => {
      if (queued) {
        const held = this.queues[state.sessionId] ?? [];
        this.queues[state.sessionId] = delivery.delivered
          ? queueWithout(held, queued.id)
          : held.map((entry) =>
              entry.id === queued.id
                ? { ...entry, reason: delivery.reason || 'The agent did not accept this compaction request.' }
                : entry,
            );
        if (!this.queues[state.sessionId].length) {
          delete this.queues[state.sessionId];
        }
        void this.writeDrafts();
      }
      if (delivery.delivered && delivery.turnId !== undefined) {
        this.recordDeliveredPromptTurn(state.sessionId, delivery.turnId);
      }
      if (queued && !delivery.delivered) {
        this.forgetLivePress(state.sessionId, pressed);
        this.queueHandoffs.delete(queued.id);
        void this.post({ type: 'usage', usage: this.usagePayload() });
      } else {
        this.livePressAnswered(state.sessionId, pressed, delivery);
      }
    };
    void Promise.resolve()
      .then(() => this.onCompact?.(state.agent, state.sessionId, this.cwdForSession(state.agent, state.sessionId)))
      .then(
        (answer) =>
          settle(
            answer ?? {
              delivered: false,
              reason: 'No agent handoff is available.',
            },
          ),
        (error) =>
          settle({
            delivered: false,
            reason: error instanceof Error ? error.message : 'The compaction request failed.',
          }),
      )
      .finally(() => {
        if (queued) {
          this.queueHandoffs.delete(queued.id);
        }
      });
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private finishClearSettlement(settlement: ClearSettlement): void {
    const delivery = settlement.delivery;
    if (!delivery || this.clearSettlements.get(settlement.session) !== settlement) {
      return;
    }
    if (delivery.delivered && settlement.session === settlement.source) {
      return;
    }
    if (delivery.delivered && settlement.recoveryId)
      this.confirmPromptOwner(settlement.recoveryId, settlement.session, true);
    this.clearSettlements.delete(settlement.session);
    const session = settlement.session;
    const held = this.queues[session] ?? [];
    if (settlement.preservePayload && settlement.queued) {
      if (!delivery.delivered) {
        const reason = delivery.reason || 'The agent did not open the new session.';
        this.queues[session] = queueResetFailed(
          held,
          settlement.queued.id,
          settlement.source,
          reason,
          settlement.resetId,
        );
      }
    } else {
      const withoutClear = settlement.queued ? queueWithout(held, settlement.queued.id) : held;
      this.queues[session] = withoutClear.map((entry) => {
        if (entry.delivery?.phase === 'queued' && entry.delivery.barrier === settlement.resetId) {
          return { ...entry, delivery: { phase: 'queued' as const, owner: session } };
        }
        const legacy = entry as QueuedSubmission & { heldForClear?: boolean };
        return legacy.heldForClear ? { ...legacy, heldForClear: undefined } : entry;
      });
    }
    if (!this.queues[session].length) {
      delete this.queues[session];
    }
    if (settlement.queued) {
      this.queueHandoffs.delete(settlement.queued.id);
    }
    if (!delivery.delivered) {
      const failedState = this.stateFor(session) ?? { ...settlement.state, sessionId: session };
      const pressed = this.noteLive(failedState, 'clear', '');
      this.livePressAnswered(session, pressed, delivery);
    }
    void this.writeDrafts().then(() => this.flushQueue(session));
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private cancelClearSettlement(session: string, reason: string): void {
    const settlement =
      this.clearSettlements.get(session) ??
      [...this.clearSettlements.values()].find((entry) => entry.source === session);
    if (!settlement) {
      return;
    }
    settlement.delivery = { delivered: false, reason };
    this.finishClearSettlement(settlement);
  }

  private startClear(state: ComposerState, queued: QueuedSubmission | null = null, text: string = '/clear'): void {
    if (this.contextSource) this.invalidateContext(state.sessionId);
    const request = clearRequest(state.agent, text);
    if (!request) {
      return;
    }
    const queuedResetId = queued?.delivery && 'resetId' in queued.delivery ? queued.delivery.resetId : undefined;
    const settlement: ClearSettlement = {
      source: state.sessionId,
      session: state.sessionId,
      state,
      queued,
      request: request.command,
      resetId: queuedResetId ?? (request.command === 'new' && queued ? queued.id : `clear:${state.sessionId}`),
      preservePayload:
        request.command === 'new' || Boolean(queued && (queued.commentIds.length || queued.assets.length)),
      delivery: null,
      ...((state.submittedRecoveryId ?? queued?.recoveryId)
        ? { recoveryId: state.submittedRecoveryId ?? queued?.recoveryId }
        : {}),
    };
    this.clearSettlements.set(state.sessionId, settlement);
    const settle = (delivery: PromptDelivery): void => {
      settlement.delivery = delivery;
      if (delivery.delivered && delivery.session && delivery.session !== settlement.session) {
        this.noteSessionMoved(
          settlement.session,
          delivery.session,
          state.agent,
          this.cwdForSession(state.agent, settlement.session),
        );
      }
      this.finishClearSettlement(settlement);
    };
    void Promise.resolve()
      .then(() =>
        this.onClear?.(state.agent, state.sessionId, this.cwdForSession(state.agent, state.sessionId), request.name),
      )
      .then(
        (answer) =>
          settle(
            answer ?? {
              delivered: false,
              reason: 'No agent handoff is available.',
            },
          ),
        (error) =>
          settle({
            delivered: false,
            reason: error instanceof Error ? error.message : 'The clear request failed.',
          }),
      )
      .finally(() => {
        if (queued) {
          this.queueHandoffs.delete(queued.id);
        }
      });
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  private dequeue(id: string, session: string): void {
    const state = this.stateFor(session);
    if (!state) {
      return;
    }
    const removed = queuedSubmission(state.queued, id);
    if (!removed || this.queueHandoffs.has(id) || this.queuedEditReservations.has(id)) {
      return;
    }
    this.queues[state.sessionId] = queueAfterClearRecovery(state.agent, queueWithout(state.queued, id), removed);
    if (!this.queues[state.sessionId].length) {
      delete this.queues[state.sessionId];
    }
    void this.writeDrafts().then(() => {
      this.flushQueue(state.sessionId);
      if (!this.attachmentStorageDir || !removed.assets.length) {
        return;
      }
      const disposable = promptAssetsSafeToDelete(this.promptAssetReferences(), this.assetIdsInHandoff, removed.assets);
      if (!disposable.length) {
        return;
      }
      void deleteStagedPromptAssets(this.attachmentStorageDir, disposable).catch(() => {
        this.setAttachmentNotice(state.sessionId, attachmentRefusal('read', disposable[0]?.name));
      });
    });
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // A waiting prompt taken back into the box to be changed. It leaves the queue at the same
  // moment: a prompt in the box and in the queue at once is one the reader would watch go
  // out twice, the old wording first.
  //
  // There is no second editor. The box already carries the caret, the selection, the undo
  // history and the growth, and every one of those is what changing a prompt needs.
  private requestQueuedEdit(
    id: string,
    session: string,
    revision: number,
    host: PanelHost,
    browserSession: string = session,
  ): void {
    const state = this.stateFor(session);
    if (
      !state ||
      this.queueHandoffs.has(id) ||
      this.queuedEditReservations.has(id) ||
      this.queuedEditOffers.has(host)
    ) {
      return;
    }
    const wanted = state.queued.find((queued) => queued.id === id);
    if (!wanted) {
      return;
    }
    const submitting = this.submittingDrafts?.get(state.sessionId);
    const activeText =
      submitting && (this.draftRevisions?.get(state.sessionId) ?? 0) <= submitting.revision ? '' : state.draft;
    const activeCommentIds = commentsForActiveSubmission(state)
      .map((comment) => comment.id)
      .filter((id) => !submitting?.commentIds.includes(id));
    const activeAssets = (this.assets[state.sessionId] ?? []).filter(
      (asset) => !submitting?.assets?.some((reserved) => reserved.id === asset.id),
    );
    const [replacement] = queueSubmissionAfter(
      [],
      crypto.randomUUID(),
      activeText,
      activeCommentIds,
      activeAssets,
      Date.now(),
      false,
      { agent: state.agent, owner: state.sessionId },
    );
    const activeHasContent = activeText.trim().length > 0 || activeCommentIds.length > 0 || activeAssets.length > 0;
    if (activeHasContent && !replacement) {
      void vscode.window.showInformationMessage(
        'Arc: the active draft cannot be retained while editing this waiting prompt. Shorten it and try again.',
      );
      return;
    }
    this.queuedEditReservations.add(id);
    this.queuedEditOffers.set(host, {
      id,
      session: state.sessionId,
      browserSession,
      revision,
    });
    void this.sendToHost(host, {
      type: 'takeQueuedDraft',
      session: browserSession,
      text: wanted.text,
      revision,
      value: id,
    }).then((posted) => {
      if (!posted) {
        this.releaseQueuedEditOffer(host);
      }
    });
  }

  private releaseQueuedEditOffer(host: PanelHost, resumeQueue = true): void {
    const offered = this.queuedEditOffers.get(host);
    if (!offered) {
      return;
    }
    this.queuedEditOffers.delete(host);
    this.queuedEditReservations.delete(offered.id);
    if (resumeQueue) {
      this.flushQueue(this.panelSession(offered.session));
    }
  }

  private acceptQueuedEdit(
    id: string,
    session: string,
    revision: number,
    currentRevision: number,
    accepted: boolean,
    host: PanelHost,
  ): void {
    const offered = this.queuedEditOffers.get(host);
    if (
      !offered ||
      offered.id !== id ||
      offered.revision !== revision ||
      this.panelSession(offered.session) !== this.panelSession(session)
    ) {
      return;
    }
    const queueSession = this.panelSession(offered.session);
    this.releaseQueuedEditOffer(host, false);
    if (!accepted) {
      this.flushQueue(queueSession);
      return;
    }
    const state = this.stateFor(queueSession);
    if (!state) {
      this.flushQueue(queueSession);
      return;
    }
    // The box and the row swap, decided in `composerview.ts`. What the box held goes back
    // into the queue in the place the edited prompt came out of, because overwriting the box
    // destroyed whatever was typed there: a reader editing a second waiting prompt lost the
    // first one outright, since it had already left the queue and the box was its only copy.
    const submitting = this.submittingDrafts?.get(state.sessionId);
    const activeText =
      submitting && (this.draftRevisions?.get(state.sessionId) ?? 0) <= submitting.revision ? '' : state.draft;
    const activeCommentIds = commentsForActiveSubmission(state)
      .map((comment) => comment.id)
      .filter((id) => !submitting?.commentIds.includes(id));
    const activeAssets = (this.assets[state.sessionId] ?? []).filter(
      (asset) => !submitting?.assets?.some((reserved) => reserved.id === asset.id),
    );
    const [replacement] = queueSubmissionAfter(
      [],
      crypto.randomUUID(),
      activeText,
      activeCommentIds,
      activeAssets,
      Date.now(),
      false,
      { agent: state.agent, owner: state.sessionId },
    );
    const activeHasContent = activeText.trim().length > 0 || activeCommentIds.length > 0 || activeAssets.length > 0;
    if (activeHasContent && !replacement) {
      void this.sendToHost(host, {
        type: 'restoreDraft',
        session: offered.browserSession,
        text: state.draft,
        revision: currentRevision,
      });
      this.flushQueue(queueSession);
      return;
    }
    const swap = queueEdit(state.queued, id, replacement ?? null);
    if (!swap) {
      this.flushQueue(queueSession);
      return;
    }
    const wanted = swap.submission;
    this.queues[state.sessionId] = swap.queued;
    if (!swap.queued.length) {
      delete this.queues[state.sessionId];
    }
    if (wanted.assets.length) {
      this.assets[state.sessionId] = wanted.assets.map((asset) => ({ ...asset }));
    } else {
      delete this.assets[state.sessionId];
    }
    if (wanted.commentIds.length) {
      this.draftCommentIds[state.sessionId] = [...wanted.commentIds];
    } else {
      delete this.draftCommentIds[state.sessionId];
    }
    this.holdDraft(state.sessionId, wanted.text, false, currentRevision);
    void this.writeDrafts().then(() => this.flushQueue(state.sessionId));
    // The box is a real element the panel owns and never rebuilds, so its value is set over
    // there rather than drawn from a payload.
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // A turn's read state, set from the editor's context menu over its card. The set itself
  // lives in the webview, so this says which turn and which way and the panel does the rest.
  // Told to every host, because both draw the same card and the state is one thing.
  public setRead(key: string, read: boolean): void {
    void this.post({ type: 'setRead', key, read });
  }

  // The comment box, asked for from the editor's context menu over a card. Sent to every
  // host, because this side cannot tell which one the menu was drawn over. Only the host
  // that saw the right-click has anything to open the box on, and it is the one that opens
  // it: the panel refuses a message it has no press behind.
  public openComment(key: string): void {
    void this.post({ type: 'openComment', key });
  }

  public requestSelectedTextHandoff(session: string, key: string, copyLabels: boolean): void {
    session = this.panelSession(session);
    const arm = this.selectedTextMenuArm;
    if (!arm || arm.copyLabels !== undefined) {
      return;
    }
    if (arm.session !== session || arm.key !== key || Date.now() - arm.at > 30_000 || !this.hosts.includes(arm.host)) {
      this.selectedTextMenuArm = null;
      return;
    }
    this.selectedTextMenuArm = { ...arm, at: Date.now(), copyLabels };
    void this.sendToHost(arm.host, { type: 'sendSelectedText', key, copyLabels });
  }

  private acceptSelectedTextHandoff(
    host: PanelHost,
    text: string,
    session: string,
    key: string,
    copyLabels: boolean,
  ): void {
    const arm = this.selectedTextMenuArm;
    if (!arm) {
      return;
    }
    if (Date.now() - arm.at > 30_000 || !this.hosts.includes(arm.host)) {
      this.selectedTextMenuArm = null;
      return;
    }
    if (
      arm.copyLabels === undefined ||
      arm.host !== host ||
      arm.session !== session ||
      arm.key !== key ||
      arm.copyLabels !== copyLabels
    ) {
      return;
    }
    this.selectedTextMenuArm = null;
    this.handoffSelectedText(text, session, key, copyLabels, host);
  }

  // The label editor, asked for from the editor's context menu over a rail card or a session
  // heading. Sent to every host for the reason the comment box is, and answered by the one
  // that saw the right-click.
  public openLabelEditor(session: string): void {
    void this.post({ type: 'openLabelEditor', session });
  }

  // The view editor, asked for from the editor's context menu over the rail's views row. Sent
  // to every host for the reason the label editor is, and answered by the one that saw the
  // right-click. The mode says which press it was, and the panel draws the box: every word the
  // reader types about a view stays inside the panel.
  public openViewEditor(view: string, mode: 'rename' | 'delete'): void {
    void this.post({ type: 'openViewEditor', view, mode });
  }

  // The session rename editor, asked for from the context menu over a rail row or a session
  // heading. Only a session with a saved record can be renamed. The editor starts from the
  // full name, not the shorter one the grouping heading over several sessions draws.
  public openSessionRename(sessionId: string): void {
    const session = this.catalog?.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) {
      return;
    }
    void this.post(sessionRenameOpening(sessionId, this.sessionLabel(session)));
  }

  // Renames one saved session. The shown name changes only after the agent confirmed the
  // save, so a failure leaves the rail and the heading on the old name. Nothing keyed by the
  // session id changes, because the id stays the same.
  private async renameSession(sessionId: string, rawTitle: string): Promise<SessionRenameResult> {
    const session = this.catalog?.sessions.find((candidate) => candidate.sessionId === sessionId) ?? null;
    const result = await requestSessionRename(rawTitle, session !== null, async (title) => {
      if (!session || !this.onRenameSession) {
        throw new Error('Arc cannot rename this session.');
      }
      await this.onRenameSession(
        session.agent,
        session.sessionId,
        this.ownCwdForSession(session.agent, session.sessionId),
        title,
        session.file,
      );
    });
    if (!result.error && session) {
      this.sessionRenamed(session, result.title);
    }
    return result;
  }

  // A rename typed in the Composer. Success clears the box the way a sent prompt does. A
  // failure puts the typed line back only when the box has not changed since the Send, and
  // says why in an editor message, because the Composer has no rename editor to hold it. A
  // box typed into and emptied again reads the same as an untouched one, so the Send's
  // revision stands for the untouched box until typing, recovery, queue editing, or a later rename replaces it.
  private async renameFromComposer(
    sessionId: string,
    name: string,
    text: string,
    browserSession: string,
    revision: number,
  ): Promise<void> {
    if ((this.draftRevisions?.get(sessionId) ?? 0) <= revision) this.typedRenames.set(sessionId, revision);
    let result: SessionRenameResult;
    try {
      result = await this.renameSession(sessionId, name);
    } catch (error) {
      result = { title: name, error: (error as Error).message || 'The session was not renamed.' };
    }
    const untouched = this.typedRenames.get(sessionId) === revision;
    if (untouched) {
      this.typedRenames.delete(sessionId);
    }
    if (!result.error) {
      return;
    }
    if (untouched) {
      this.holdDraft(sessionId, text);
      void this.post({ type: 'restoreDraft', session: browserSession, text, revision });
    }
    void vscode.window.showErrorMessage(`Arc: ${result.error}`);
  }

  // A confirmed rename. A Claude name reports to the held names as a custom name one byte
  // before the transcript's end after the rename. A same-rank name replaces a held one only
  // from further into the file. That offset is past the record the rename appended, so a
  // second rename replaces the first. A later record starts at the end or beyond, so a later
  // native rename still replaces this one. A Codex name lives in the thread-name index, which
  // is read again, and the session heading reads the index first.
  private sessionRenamed(session: SessionFile, title: string): void {
    if (session.agent === 'claude') {
      const size = Math.max(this.revisionOf(session).size, session.size);
      this.sessionNames.observe(
        session.sessionId,
        {
          label: normalizeSessionTitle(title) ?? title,
          fullLabel: title,
          source: 'custom',
          at: Math.max(0, size - 1),
        },
        { size },
      );
      this.storeSessionNames([session.sessionId], () => session);
    } else {
      this.threadNames = readThreadNames(codexSessionIndexPath(), this.threadNames);
    }
    this.refreshFrom('session-rename', true, false, [session.file]);
  }

  // What the label editor draws for one session. Built here on every ask and after every
  // write, because this side owns the record and the panel keeps no copy of it.
  private labelEditorReply(session: string, browserSession: string = session): unknown {
    return labelEditorReply(this.saved.labels, this.sessionRows, session, CARD_ACTIONS.labelHeading, browserSession);
  }

  // One turn's comments, as the markdown a person could have written, on the clipboard.
  //
  // Per turn and never per session. The reader sends one turn's comments back to the
  // agent that ran it, and a paste holding every turn they have written on is one they have to
  // edit down before it is usable.
  //
  // Built here rather than in the panel: `emitTurnComments` is turnview.ts's rule, the webview
  // cannot import that module, and a second copy of it over there would be the whole of it
  // again in the one file nothing tests. The comments reach this side on every save, so what
  // is read is the set the reader last wrote.
  //
  // Both halves name the turn. A turn key carries its own session, and reading it back
  // out of the key would be a second copy of `turnKey`'s shape.
  //
  // A turn nobody has written on copies nothing. The menu entry is absent on one, so this only
  // answers a press that crossed a comment being deleted, and the clipboard is better left as
  // the reader had it than emptied by a press that found nothing.
  public async copyComments(turnKey: string, session: string): Promise<void> {
    const notes = emitTurnComments(this.saved.comments, turnKey, session);
    if (!notes) {
      return;
    }
    await vscode.env.clipboard.writeText(notes);
    void vscode.window.setStatusBarMessage('Arc: copied.', 1500);
  }

  // A whole session's read state, set from the editor's context menu over its rail
  // card. The read set and the watermarks both live in the webview, so this says which
  // session and which way, exactly as the per-turn command does, and every host is
  // told because both draw the same rail.
  public setSessionRead(session: string, read: boolean): void {
    void this.post({ type: 'setSessionRead', session: this.panelSession(session), read });
  }

  // Archiving a whole session, set from the editor's context menu over its session
  // heading. The provider changes the durable set itself because the browser can still
  // name the provisional shell until the complete render arrives.
  public setSessionArchived(session: string, archived: boolean): void {
    this.updateSessionMembership(archived ? 'archive' : 'unarchive', session);
  }

  // Pinning a whole session to the top of the rail, set from the editor's context menu
  // over its session heading. The provider changes the durable set for the same reason
  // archive commands do.
  public setSessionPinned(session: string, pinned: boolean): void {
    this.updateSessionMembership(pinned ? 'pin' : 'unpin', session);
  }

  private updateSessionMembership(
    action: 'archive' | 'unarchive' | 'pin' | 'unpin' | 'unarchiveAll',
    session?: string,
    openPinned = false,
  ): void {
    const hidden = new Set(this.hidden);
    const pinnedTop = new Set(this.pinnedTop);
    const target = session === undefined ? '' : this.panelSession(session);
    if (action === 'archive') {
      hidden.add(target);
      pinnedTop.delete(target);
    } else if (action === 'unarchive') {
      hidden.delete(target);
    } else if (action === 'pin' && !hidden.has(target)) {
      pinnedTop.add(target);
    } else if (action === 'unpin') {
      pinnedTop.delete(target);
    } else if (action === 'unarchiveAll') {
      hidden.clear();
    }
    const same = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
      left.size === right.size && [...left].every((session) => right.has(session));
    const hiddenChanged = !same(this.hidden, hidden);
    const pinnedChanged = !same(this.pinnedTop, pinnedTop);
    const pinnedFoldChanged = openPinned && !this.saved.railFolds[RAIL_FOLDS.top];
    if (!hiddenChanged && !pinnedChanged && !pinnedFoldChanged) {
      return;
    }
    this.hidden = hidden;
    this.pinnedTop = pinnedTop;
    this.saved.hidden = [...hidden];
    this.saved.pinnedTop = [...this.pinnedTop];
    if (pinnedFoldChanged) {
      this.saved.railFolds = { ...this.saved.railFolds, [RAIL_FOLDS.top]: true };
    }
    void this.memento?.update(STATE_KEY, this.saved);
    if (hiddenChanged) {
      this.onArchivedSessionsChange?.(this.hidden);
    }
    if (hiddenChanged || pinnedChanged) {
      this.postRail(true);
    }
  }

  public setComposerHidden(hidden: boolean): void {
    const arm = this.composerMenuArm;
    this.composerMenuArm = null;
    if (!arm || Date.now() - arm.at > 30_000 || !this.hosts.includes(arm.host)) {
      return;
    }
    void this.sendToHost(arm.host, { type: 'setComposerHidden', hidden });
  }

  public showSessionDetails(session: string): void {
    session = this.panelSession(session);
    const arm = this.detailsMenuArm;
    this.detailsMenuArm = null;
    if (!arm || arm.session !== session || Date.now() - arm.at > 30_000 || !this.hosts.includes(arm.host)) {
      return;
    }
    void this.sendToHost(arm.host, { type: 'showSessionDetails', session: arm.browserSession });
  }

  public async copySessionId(session: string): Promise<void> {
    await this.copyText(session);
  }

  private async copyText(text: string): Promise<void> {
    if (!text) {
      return;
    }
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage('Arc: copied.', 1500);
  }

  // The summary a turn closed with, put on the clipboard from the entry on the card's own
  // context menu. The card is found by the key the menu handed over, the same way the turn
  // diff finds its own. A key naming no card, and a card with nothing to say, copy nothing:
  // the clipboard is better left as the reader had it than filled with the word undefined.
  public async copySummary(key: string): Promise<void> {
    const card = this.cards.find((c) => c.key === key);
    if (!card || !card.summary) {
      return;
    }
    await this.copyText(card.summary);
  }

  // Reset everything the panel remembers about this workspace.
  //
  // It asks first, and the question names what it will clear, because none of it can be got
  // back: a reader who has hidden ten sessions over a week has no record of which ten.
  //
  // Then the order, which matters. Emptying the stored copy is not enough on its own: each
  // webview keeps its own through `vscode.setState`, and a host left holding the old one
  // writes it straight back on its next save. So the stored copy and the sets held beside it
  // go first, and the hosts are told last; each empties its own sets and saves, and that
  // empty state is the last thing written. The refresh after it redraws both views with the
  // hidden set, the pinned set and the labels gone.
  public async forgetState(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Reset everything Arc remembers about this workspace?',
      {
        modal: true,
        detail:
          'This clears which sessions are pinned to the top, which are hidden,' +
          ' and the labels you have put on them,' +
          ' which turns you have read, which sessions are folded and which cards are open,' +
          ' the width of the list, the text in its filter box,' +
          ' and which session is on screen.' +
          ' There is no way back.',
      },
      'Reset',
    );
    if (answer !== 'Reset') {
      return;
    }
    const acceptedCommentIds = new Set([
      ...Object.values(this.queues).flatMap((queued) => queued.flatMap((entry) => entry.commentIds)),
      ...Object.values(this.draftCommentIds).flat(),
    ]);
    const acceptedComments = this.saved.comments.filter((comment) => acceptedCommentIds.has(comment.id));
    const readerParents = this.saved.readerParents;
    const submittedPrompts = this.saved.submittedPrompts;
    this.saved = normalizePanelState(null);
    this.saved.readerParents = readerParents;
    this.saved.submittedPrompts = submittedPrompts;
    // Forgetting is starting over, and starting over in a workspace means what opening one
    // for the first time means: what is already there is not new.
    this.saved.since = Date.now();
    // The box is the exception, and it is not listed in the question above. Everything else
    // here is a state the reader built by pressing something, and forgetting it costs them
    // presses. A half-written prompt is words, it is on screen in front of them, and the
    // press they aimed at their folds and filters would take it with no way back. So the
    // stored copy is written from what the boxes still hold rather than emptied.
    this.saved.drafts = normalizeDrafts(this.drafts);
    // The same reason keeps a sent prompt no transcript has recorded yet: it is the
    // reader's own words, standing in for a turn the forgotten workspace cannot rebuild.
    this.saved.sentPrompts = normalizeSentPrompts(this.sentPrompts);
    // Kept for a reason of its own, and it is not listed in the question above either.
    // Forgetting is about what the reader built by pressing something. This says which
    // sessions they started, and dropping it would file each one under Run by agents.
    this.saved.started = [...this.startedHere].slice(-SESSION_LIMIT);
    this.saved.assets = normalizePromptAssetBook(this.assets);
    // Waiting submissions are user-authored content, like the draft and its files above.
    // Forgetting panel preferences must not cancel work the reader already submitted.
    this.saved.queues = normalizeQueuedSubmissions(this.queues);
    this.saved.draftCommentIds = normalizeDraftCommentIds(this.draftCommentIds);
    this.saved.comments = acceptedComments;
    this.hidden.clear();
    this.onArchivedSessionsChange?.(this.hidden);
    this.pinnedTop.clear();
    // Starting over opens where opening this workspace for the first time opens. The refresh
    // at the foot picks the newest session again, so the panel is never left drawing none.
    this.showing = null;
    this.hostSessions.clear();
    this.hostPreviousSessions.clear();
    // Starting over means there is nowhere to go back to either.
    this.trail = emptyTrail();
    await this.memento?.update(STATE_KEY, this.saved);
    // The rail is posted only when its wording moved, and the counts are about to, so the
    // comparison must not answer with what was drawn before any of this.
    this.lastRailMessageType = null;
    this.lastRailMessageSerializedBytes = null;
    this.lastRailAdoptionsJson = '';
    this.lastRailKey = null;
    this.railPendingAnswers = null;
    this.lastRailRevision = -1;
    this.lastRailDay = '';
    this.lastRailCountsJson = '';
    await this.post({ type: 'forgetState', since: this.saved.since });
    void this.refresh(true);
  }

  // Back, and forward, over the sessions the reader has opened.
  //
  // The panel's own trail comes first. A trail with nowhere left to go hands the press to the
  // editor's Go Back, which takes the reader out of the panel and into what they were reading
  // before it. That command has its own end, and a window whose only editor is this panel
  // reaches both ends at once, so a press there does nothing.
  public goBack(host?: PanelHost): void {
    this.walk(stepBack(this.trail), 'workbench.action.navigateBack', host);
  }

  public goForward(host?: PanelHost): void {
    this.walk(stepForward(this.trail), 'workbench.action.navigateForward', host);
  }

  private walk(next: Trail | null, handOver: string, host?: PanelHost): void {
    if (!next) {
      void vscode.commands.executeCommand(handOver);
      return;
    }
    this.trail = next;
    this.show(trailPlace(next), host ?? this.hosts.find((open) => open.active()));
  }

  // Open the session the reader chose.
  //
  // A draft nobody sent does not survive the reader leaving it, and it has to go before the
  // move rather than after. The rail's press and the walk both go through here, so the next
  // rule about leaving a session cannot reach one of them and miss the other. Work that
  // opens a session the reader did not choose, such as starting a draft or following a
  // prompt to the session that took it, keeps its own path.
  private show(session: string | null, host?: PanelHost): void {
    const previousSelection = host ? (this.hostSessions.get(host) ?? this.showing) : this.showing;
    if (previousSelection && previousSelection !== session) {
      this.abandonDraft(previousSelection, false);
    }
    if (this.contextSource && previousSelection) this.invalidateContext(previousSelection);
    if (host && session) {
      this.hostPreviousSessions?.set(host, previousSelection ?? session);
      this.hostSessions.set(host, session);
    }
    this.previousSelection = previousSelection;
    this.showing = session;
    const selectedAgent = session
      ? (this.newDrafts?.[session]?.profile.agent ??
        this.sessionRows?.find((row) => row.id === session)?.agentKey ??
        null)
      : null;
    this.onSelectionChanged?.(
      session,
      selectedAgent,
      session && selectedAgent ? this.ownCwdForSession(selectedAgent, session) : null,
    );
    this.selectionGeneration++;
    this.metadataReadIntent = session ? { sessionId: session, generation: this.selectionGeneration } : null;
    for (const [id, work] of this.selectionWorks ?? []) {
      if (work.host && this.hostSessions.get(work.host) === id) continue;
      work.controller.abort();
      this.selectionWorks.delete(id);
    }
    if (!this.selectionWork?.host || this.hostSessions.get(this.selectionWork.host) !== this.selectionWork.sessionId) {
      this.selectionWork?.controller.abort();
      this.selectionWork = null;
    }
    for (const id of this.earlySelectedSources?.keys() ?? []) {
      if (id !== session && ![...(this.hostSessions?.values() ?? [])].includes(id))
        this.earlySelectedSources.delete(id);
    }
    this.selectionFailure = null;
    // A selection cannot add, remove or grow a transcript, and walking back to one is a
    // selection, so both routes through here skip the catalog walk.
    const seeded = this.selectionGeneration;
    this.railSeedOwedFor = seeded;
    this.railSeedSkipped = false;
    void this.refresh(true, true, true, true).then(
      () => this.settleRailSeed(seeded),
      () => this.settleRailSeed(seeded),
    );
    if (session) {
      void this.completeSelectedWindow(session, this.selectionGeneration);
    }
  }

  // The end of the refresh a selection asked for. A save that skipped its rail is owed one
  // still, because the render that was going to word it may have aborted or failed.
  private settleRailSeed(generation: number): void {
    if (this.railSeedOwedFor !== generation) {
      return;
    }
    this.railSeedOwedFor = null;
    if (!this.railSeedSkipped) {
      return;
    }
    this.railSeedSkipped = false;
    this.postRail(false);
  }

  private anyVisible(): boolean {
    return this.hosts.some((host) => this.readyHosts.has(host) && host.visible());
  }

  // The editor group a diff opened from the panel should land in. The rule is in turnview.ts
  // where it is tested; this only gathers what it asks about.
  private column(): vscode.ViewColumn {
    return editorColumn({
      active: vscode.window.activeTextEditor?.viewColumn ?? null,
      visible: vscode.window.visibleTextEditors
        .map((e) => e.viewColumn)
        .filter((c): c is vscode.ViewColumn => c !== undefined),
      panel: this.editorPanel?.viewColumn ?? null,
    });
  }

  // Where the webview may read a file from: this extension, the icon theme in somebody
  // else's extension, and the open folders, which is where a picture a response names lives.
  // Assigned rather than written into the page again: rebuilding the HTML drops the reader's
  // scroll position and every open card.
  //
  // These are webview options, not panel options, so an assignment reaches a tab that was
  // made before the option existed. A panel option cannot be changed that way, which is how
  // `enableFindWidget` answered nothing in every tab the reader already had open.
  private allowThemeFiles(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        ...this.icons.roots(),
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
        ...(this.attachmentStorageDir ? [vscode.Uri.file(this.attachmentStorageDir)] : []),
      ],
    };
  }

  // `force` repaints even when nothing moved, which is what the refresh button and a
  // freshly shown panel need. The polling path passes nothing, so an idle session costs
  // one stat per session file and no DOM work at all.
  // Selection changes and accepted worker results reuse the catalog. Other refreshes discover
  // added, removed, or changed transcripts through the catalog walk.
  refreshFrom(
    reason: string,
    force = false,
    reuseCatalog = false,
    changedPaths: string[] | null = null,
    metadataAfterRender = false,
  ): void {
    const previousReason = this.refreshReason;
    const previousPaths = this.targetedRefreshPaths;
    this.refreshReason = reason;
    this.targetedRefreshPaths = changedPaths;
    try {
      void this.refresh(force, reuseCatalog, metadataAfterRender);
    } finally {
      this.refreshReason = previousReason;
      this.targetedRefreshPaths = previousPaths;
    }
  }

  async refresh(force = false, reuseCatalog = false, metadataAfterRender = false, selectedOnly = false): Promise<void> {
    // One catalog refresh runs at a time. A trigger that arrives during it joins one merged
    // request that runs when it ends, so a steady trigger stream cannot restart the refresh
    // before it renders.
    if (!selectedOnly && (this.refreshController || this.codexPriming)) {
      this.pendingRefresh = mergeRefreshRequests(this.pendingRefresh, {
        reason: this.refreshReason,
        force,
        reuseCatalog,
        metadataAfterRender,
        changedPaths: this.targetedRefreshPaths,
      });
      this.performanceCounters.recordRefreshStage('coalesced');
      if (this.refreshOverdue) {
        this.runPendingRefresh();
      }
      return;
    }
    const refreshStarted = performance.now();
    const previousSelection = this.previousSelection;
    const refreshReason = this.refreshReason;
    const targetedRefreshPaths = this.targetedRefreshPaths;
    let controller: AbortController | null = null;
    let primed = false;
    let primedWalk: string[] | undefined;
    let generation = this.refreshGeneration;
    try {
      if (!this.anyVisible()) {
        return;
      }
      if (!selectedOnly) {
        for (const session of new Set([this.showing, ...(this.hostSessions?.values() ?? [])])) {
          if (session) void this.completeSelectedWindow(session, this.selectionGeneration);
        }
      }
      if (!selectedOnly) {
        this.performanceCounters.recordRefreshStage('started');
      }
      const coldReads = selectedOnly ? null : this.codexColdReads;
      if (coldReads) {
        this.codexColdReads = null;
        primed = true;
        this.codexPriming = coldReads();
        try {
          const pass = await this.codexPriming;
          primedWalk = pass.walked;
          // The pass reads rows before `allSessions` takes its baseline, so the walk never sees
          // them move the revision. They reach the checkpoint here.
          if (pass.read) {
            this.derivedCacheCheckpointState.markChanged(true);
          }
        } finally {
          this.codexPriming = null;
        }
        if (!this.anyVisible()) {
          return;
        }
      }
      const catalogStarted = performance.now();
      this.codexWalk = primedWalk ?? null;
      let all = selectedOnly
        ? [
            ...(this.authoritativeCatalog ?? []),
            ...[...(this.earlySelectedSources?.values() ?? [])].filter(
              (source) => !this.authoritativeCatalog?.some((held) => held.sessionId === source.sessionId),
            ),
          ]
        : this.allSessions(reuseCatalog);
      if (
        selectedOnly &&
        this.authoritativeCatalog &&
        this.showing &&
        !this.newDrafts[this.showing] &&
        !this.awaitingSessionRecords[this.showing]
      ) {
        all =
          revalidatedCatalog(this.authoritativeCatalog, this.showing, (file) => {
            try {
              const stat = fs.statSync(file);
              return { mtimeMs: stat.mtimeMs, size: stat.size };
            } catch {
              return null;
            }
          }) ?? this.authoritativeCatalog;
      }
      this.performanceCounters.recordRefresh('catalog-enumeration', performance.now() - catalogStarted);
      if (this.repositoryScopeReady) {
        this.startupHistory?.stage('openingsEnumerated');
      }
      generation = selectedOnly ? this.refreshGeneration : ++this.refreshGeneration;
      controller = new AbortController();
      if (!selectedOnly) {
        const inFlight = controller;
        this.refreshController = inFlight;
        this.refreshOverdue = false;
        if (this.refreshDeadline) {
          clearTimeout(this.refreshDeadline);
        }
        this.refreshDeadline = setTimeout(() => {
          this.refreshDeadline = null;
          if (this.refreshController !== inFlight) {
            return;
          }
          this.refreshOverdue = true;
          this.runPendingRefresh();
        }, CATALOG_REFRESH_DEADLINE_MS);
      }
      // Git resolves repository worktrees in the background. Until the first answer, an
      // empty literal-folder listing is incomplete and must not create a draft or discard a
      // restored selection. The completed lookup asks for another refresh.
      if (!this.repositoryScopeReady) {
        return;
      }
      const dispatchCatalog =
        !selectedOnly && this.claudeChildReferences?.length
          ? new Map(all.map((session) => [session.sessionId, session]))
          : new Map<string, SessionFile>();
      const dispatchChanged =
        !selectedOnly &&
        this.claudeChildReferences?.some((reference) => {
          if (reference.kind !== 'dispatch' || !reference.file) {
            return false;
          }
          const session = dispatchCatalog.get(reference.sessionId);
          const held = this.dispatchFacts?.get(reference.sessionId);
          return (
            !!session &&
            (!held ||
              !sameSessionRevision(held.revision, session) ||
              (held.refreshAt !== null && held.refreshAt <= Date.now()))
          );
        });
      if ((!reuseCatalog || dispatchChanged || this.dispatchDiscoveryPending) && !selectedOnly) {
        this.startupHistory?.stage('relationshipsStarted');
        const discovered = await this.prepareClaudeChildren(generation, controller.signal);
        if (!discovered || controller.signal.aborted || generation !== this.refreshGeneration) {
          return;
        }
        all = this.catalog?.sessions ?? all;
      }
      if (!selectedOnly) {
        this.performanceCounters.recordStartup('catalogReady', performance.now());
      }
      if (!metadataAfterRender && !(await this.prepareMetadata(all, generation, controller.signal))) {
        return;
      }
      if (controller.signal.aborted || generation !== this.refreshGeneration) {
        return;
      }
      all = orderSessionCatalog(all, (session) => this.activityFor(session));
      if (!selectedOnly && !metadataAfterRender) {
        this.authoritativeCatalog = all;
      }
      const recorded = new Set(all.map((session) => session.sessionId));
      for (const session of Object.keys(this.awaitingSessionRecords)) {
        if (!selectedOnly && recorded.has(session)) {
          delete this.awaitingSessionRecords[session];
        }
      }
      if (!selectedOnly) {
        all = [
          ...all,
          ...[...(this.earlySelectedSources?.values() ?? [])].filter((source) => !recorded.has(source.sessionId)),
        ];
      }
      const scopedDrafts = Object.values(this.newDrafts).filter((draft) =>
        isInside(draft.cwd, this.repositoryScopeRoots),
      );
      const scopedPendingRecords = Object.values(this.awaitingSessionRecords).filter(
        (pending) =>
          pending.cwd !== null &&
          isInside(pending.cwd, this.repositoryScopeRoots) &&
          !all.some((source) => source.sessionId === pending.sessionId),
      );
      this.ensureProjectSpendWorkspace();
      // Set from the listing, so a session started while the panel is open is watched
      // from the first read that finds it rather than from the next window.
      if (this.watching) {
        this.watchDirectories(watchDirs(all));
      }
      // Settle selection before requesting a window or building cards. The rail and payload use
      // the same selection. Newest activity selects the default session.
      const reachable = [
        ...scopedDrafts.map((draft) => draft.draftId),
        ...scopedPendingRecords.map((pending) => pending.sessionId),
        ...all.map((f) => f.sessionId),
      ];
      // A selected-only refresh can settle before the catalog includes a newly discovered
      // child. Keep its selection until the next catalog refresh answers whether it remains.
      if (selectedOnly) {
        reachable.unshift(...(this.hostSessions?.values() ?? []));
        if (this.showing) {
          reachable.unshift(this.showing);
        }
      }
      this.showing = pickShowing(reachable, this.showing);
      for (const host of this.hosts) {
        const previous = this.hostSessions?.get(host) ?? this.showing;
        const settled = pickShowing(reachable, previous);
        if (settled) {
          this.hostSessions?.set(host, settled);
          if (!selectedOnly || !this.hostPreviousSessions?.has(host)) {
            this.hostPreviousSessions?.set(host, settled);
          }
        } else {
          this.hostSessions?.delete(host);
          this.hostPreviousSessions?.delete(host);
        }
      }
      // Every path that moves the reader ends here, so the trail is written in one place rather
      // than beside each press. Stepping back is not a visit and needs no exception: the walk
      // has already put the trail on the session this line is about to see.
      this.trail = visitPlace(prunePlaces(this.trail, new Set(reachable)), this.showing ?? '');
      const sessions = this.shownSessions(all);
      if (
        this.showing &&
        sessions[0] &&
        (!this.progressiveCurrent(sessions[0]) || !this.agentFactsCurrent(sessions[0]))
      ) {
        void this.completeSelectedWindow(this.showing, this.selectionGeneration);
      }
      const now = Date.now();
      const outcomes = this.outcomesFor(all);
      this.sessionOutcomes = outcomes;
      // One stat, before the signature is built, because the signature carries the answer.
      // Renaming a Claude session writes a new title into its transcript and the file's mtime
      // says so; renaming a Codex thread writes into this index instead and touches no
      // transcript at all, so the index has to be looked at on its own to be noticed.
      this.threadNames = readThreadNames(codexSessionIndexPath(), this.threadNames);
      const children = this.agentListingStamp(sessions);
      // Two signatures, because they answer two questions. The listing signature says whether
      // the panel has anything new to draw, so it carries the shown session. The spend
      // source signature says whether a spend source can have moved, and selection is not one
      // of the things that moves one. The offer stats every ledger record the listing does not
      // carry, so gating it on the listing signature makes every click pay that walk.
      const parentEdges = this.sessionParentEdges(all);
      const listed: ListingFacts = {
        showing: this.showing,
        files: all,
        threadNames: this.threadNames.stamp,
        children,
        sessionParents: parentEdges.key,
      };
      const sourceSignature = spendSourceSignature(listed);
      const signature = listingSignature(listed);
      const sourcesMoved = sourceSignature !== this.lastSpendSourceSignature;
      this.lastSpendSourceSignature = sourceSignature;
      if (projectSpendSourceOfferDue(sourcesMoved, now, this.projectSpendLastOfferAt)) {
        this.projectSpendLastOfferAt = now;
        const targeted = targetedRefreshPaths ? new Set(targetedRefreshPaths.map(normalizeFsPath)) : null;
        const listedRevisions = targeted
          ? new Map(
              all
                .filter((session) => targeted.has(normalizeFsPath(session.file)))
                .map((session) => [session.file, { mtimeMs: session.mtimeMs, size: session.size }]),
            )
          : trustedListedRevisions(all, this.catalogWalked, this.showing);
        if (this.projectSpendHydrated) {
          this.scheduleProjectSpendIndex(listedRevisions, sourcesMoved ? targeted : null);
        }
      }
      // Newly enriched metadata can change unread answers without changing transcript revisions.
      const glanced = this.windows.size;
      this.windows = this.glanceAt(all, sessions);
      const statusFacts = [
        ...this.newestBySession.values(),
        ...[...outcomes]
          .filter(([id, outcome]) => !this.newestBySession.has(id) && outcome)
          .map(([, outcome]) => outcome as TurnOutcome),
      ];
      // Sweep before the gate because a compaction can reach its limit without a record moving.
      // A removal is its own reason to draw.
      const swept = this.dropSpentPresses();
      if (
        !swept &&
        !refreshWanted({
          force: force || (this.metadataRevision ?? 0) !== (this.drawnMetadataRevision ?? 0),
          signature,
          lastSignature: this.lastSignature,
          glancedBefore: glanced,
          glancedNow: this.windows.size,
          statusMoved: statusMoved(statusFacts, this.collectedAt, now),
          dispatchFiguresMoved: this.dispatchFiguresRevision !== this.drawnDispatchFiguresRevision,
          openChildren: {
            drawn: this.drawnOpenChildren,
            now: openChildrenKey(this.liveOpenChildren(now), this.liveBackgroundCommands(now)),
          },
        })
      ) {
        if (!selectedOnly) {
          this.performanceCounters.recordRefreshStage('unchanged');
        }
        if (!selectedOnly) {
          this.scheduleProjectSpendHydration(generation);
          const enrichment = await this.prepareRailEnrichment(all, generation, controller.signal);
          this.postSessionLoading(all, generation, controller.signal);
          if (
            (enrichment.changed || enrichment.progress) &&
            !controller.signal.aborted &&
            generation === this.refreshGeneration
          ) {
            void this.refresh(enrichment.changed, enrichment.catalogCurrent);
          }
        }
        return;
      }
      this.lastSignature = signature;
      const metadataRevision = this.metadataRevision ?? 0;
      const figuresRevision = this.dispatchFiguresRevision;
      this.evictCache(sessions, all);
      this.cards = this.collect(sessions.filter((session) => this.cache.has(session.file)));
      // An accepted selected window can replace a live prompt with its recorded turn here.
      this.dropSpentPresses();
      const gained = agentsWithNewTurns(this.seenTurns, this.turnMarks);
      this.seenTurns = gained.seen;
      if (gained.agents.length) {
        this.onTurnsFinished?.(gained.agents);
      }
      // Every session in this workspace, not only the ones read. A session that dropped
      // off the recent list is otherwise indistinguishable from one that never existed,
      // which is what makes turns look like they vanished when a few agents are started.
      // Kept on the provider as well, because the rail is reworded when the read set moves,
      // which is not a render, and listing everything again for that would stat every file.
      const counts = this.unreadCounts();
      const fullLabels = new Map<string, string>();
      this.pruneExits(all);
      this.sessionRows = all.map((f) => {
        // The heading's last activity: the newest time the session itself recorded, not the
        // newest drawn turn and not the file's mtime. Not the drawn turn, because the tail
        // can cut a session's turns without changing when it was last active; not the mtime,
        // because an agent writes bookkeeping to a finished transcript and that moved the
        // file without the session moving.
        const at = this.activityFor(f);
        const named = this.sessionLabel(f);
        const label = named.label;
        fullLabels.set(f.sessionId, named.fullLabel);
        // The rail card's own drawn name, cut to RAIL_NAME_LIMIT rather than left at its
        // complete length: every row's name rides every render and every rail post, not only
        // the shown session's, so an uncapped name from a large pasted first prompt would
        // scale the payload with the size of what the reader typed rather than with the
        // number of sessions. Sent apart from `label` so only the rail's own drawn name
        // carries it: the popover heading, the composer target and the rail's own action
        // buttons keep reading `label`, the shorter form they always have.
        const railName = shortenTo(named.fullLabel, RAIL_NAME_LIMIT, '...');
        return {
          id: f.sessionId,
          persisted: true,
          label,
          ...(railName === label ? {} : { railName }),
          // Formatted here, with the same helpers the cards use. The panel had its own copy
          // of the clock and the month names, and a second copy drifts from the tested one.
          when: formatWhen(at),
          // Named here for the same reason the card is: a Codex session's title is a
          // truncated first prompt and reads exactly like a Claude one, so a list holding
          // both says which is which or leaves the reader to guess.
          //
          // Two spellings, and they are not interchangeable. `agent` is what the rail draws.
          // `agentKey` is what everything else is filed under: the model list, the reader's
          // picks, how much the agent asks, and which CLI a prompt is handed to.
          agent: AGENT_NAMES[f.agent],
          agentKey: f.agent,
          shown: sessions.some((s) => s.sessionId === f.sessionId),
          // The relative wording is computed here and kept current in the panel by the
          // ticker, through data-at. The unread indicator is the rail's own wording, worded
          // fresh off `counts` where the rail card is built, so one session cannot show two
          // unread states.
          at,
          relative: formatRelative(at),
          // Whether another agent started this one. Read off the same tail the name and the
          // last activity come from, so it costs nothing beyond what the row already paid.
          agentRun: this.agentRunFor(f, parentEdges.edges),
        };
      });
      this.sessionRows = [
        ...syntheticDraftRows(
          scopedDrafts.map((draft) => ({
            draftId: draft.draftId,
            createdAt: draft.createdAt,
            agent: AGENT_NAMES[draft.profile.agent],
            agentKey: draft.profile.agent,
          })),
        ),
        ...syntheticDraftRows(
          scopedPendingRecords.map((pending) => ({
            draftId: pending.sessionId,
            createdAt: pending.createdAt,
            agent: AGENT_NAMES[pending.agent],
            agentKey: pending.agent,
          })),
        ),
        ...this.sessionRows,
      ];
      if (!selectedOnly && this.authoritativeCatalog !== null) {
        this.drainInitialCatalogRefresh();
        this.drainPendingQueues();
      }
      const metadata = all.map((session) => [session.sessionId, this.metaFor(session)] as const);
      this.metadataStatsBySession = this.metadataStatFigures.read(
        metadata.map(([sessionId, meta]) => [sessionId, derivedTitleStats(meta)] as const),
        sessionStatsFromFacts,
      );
      // A mark reads the clock, and it only ever turns null as time passes. A held mark that
      // has expired is derived again, which clears it.
      const markNow = Date.now();
      this.metadataRailCaches = this.metadataCacheFigures.read(
        metadata.map(([sessionId, meta]) => [sessionId, derivedTitleCacheStats(meta)] as const),
        (facts) => railCacheMarkOf(facts, markNow),
        (mark) => mark === null || mark.expiresAt > markNow,
      );
      this.railSourceRevisions = Object.fromEntries(
        all.map((session) => [session.sessionId, { mtimeMs: session.mtimeMs, size: session.size }]),
      );
      const railNow = Date.now();
      const { statuses, openChildren } = this.railStatuses(railNow);
      const railInput = this.railInputFor(counts, statuses, openChildren, railNow);
      const railKey = railInputKey(railInput);
      const railPending = this.lifetimeFigures.answers();
      const railAdoptions = sessionAdoptions(this.sessionAliases);
      // The two things that differ from one host to the next, and both for one reason: a
      // theme's font and a theme's image reach a webview as addresses that webview alone may
      // load.
      const light = isLightColourTheme();
      if (!selectedOnly) {
        this.performanceCounters.recordRefreshStage('rendered');
      }
      let largestRenderBytes: number | null = null;
      const metadataAcceptedHosts = new Set<PanelHost>();
      for (const host of this.hosts) {
        const hostSession = this.hostSessions?.get(host) ?? this.showing;
        const hostPreviousSession = this.hostPreviousSessions?.get(host) ?? previousSelection;
        const hostDrawn = drawnSessionCards(this.cards, hostSession);
        // The complete name answers the heading's hint and the Details dialog, and only the
        // chosen session has one that differs from its short label, so it rides that row
        // alone. The resume command rides no row: the panel words it from the agent key and
        // the id every row already carries. Sending a field per session in the workspace to
        // answer a question about one of them spent the payload on a copy of what it held.
        // The session that started the chosen one rides that row alone for the same reason: only
        // the chosen session's heading draws it.
        const hostParent = this.parentOfShown(hostSession);
        // `railName` is stripped here rather than sent on: it exists for `railSessions` to
        // read off `this.sessionRows` (through `railRows`/`railInputFor`) when it builds the
        // rail's own cards, and this `sessions` array answers the popover heading, the
        // composer target and the loading message instead, all of which keep the short label.
        const hostRows = this.sessionRows.map(({ railName: _railName, ...row }) => {
          const full = row.id === hostSession ? (fullLabels.get(row.id) ?? row.label) : row.label;
          return {
            ...row,
            ...(full === row.label ? {} : { fullLabel: full }),
            ...(row.id === hostSession && hostParent ? { parent: hostParent } : {}),
            shown: row.id === hostSession,
          };
        });
        const hostRail = railPayload(this.railInputFor(counts, statuses, openChildren, railNow, hostSession));
        const selectedSession = sessions.find((session) => session.sessionId === hostSession);
        const loadingNewest = selectedSession ? !this.progressiveCurrent(selectedSession) : false;
        const loadingLabel = loadingNewest
          ? (hostRows.find((row) => row.id === hostSession)?.label ?? hostSession)
          : null;
        const selectedFailure =
          selectedSession &&
          this.selectionFailure?.sessionId === selectedSession.sessionId &&
          this.selectionFailure.generation === this.selectionGeneration &&
          sameProgressiveRevision(this.selectionFailure.revision, this.revisionOf(selectedSession));
        const discoveryLoading = selectedFailure
          ? hostDrawn.length
            ? {
                diagnosis: null,
                history: { kind: 'failed' as const, label: 'Could not read this session. Select it to try again.' },
              }
            : { diagnosis: { message: 'Could not read this session. Select it to try again.' }, history: null }
          : newestTurnLoading(loadingLabel, hostDrawn.length > 0);
        const olderHistory = (() => {
          const window = selectedSession ? this.readWindows.get(selectedSession.sessionId) : undefined;
          if (!selectedSession || !window) {
            return null;
          }
          if (discoveryLoading.history) {
            return discoveryLoading.history;
          }
          const held = this.history.get(selectedSession.sessionId);
          const control = olderHistoryControl({
            sessionId: selectedSession.sessionId,
            possible: olderHistoryPossible({
              size: selectedSession.size,
              readBytes: window.readBytes,
              turnLimitReached: window.turnLimitReached,
            }),
            paged: held !== undefined && held.requests > 0,
            atBeginning: held?.atBeginning ?? false,
            busy: this.historyRequest?.sessionId === selectedSession.sessionId,
            failed: held?.failed ?? false,
            emptyRuns: held?.emptyRuns ?? 0,
            requests: held?.requests ?? 0,
            loadedTurns: window.loadedTurns,
          });
          return control ? { ...control, session: selectedSession.sessionId } : null;
        })();
        const diagnosis =
          discoveryLoading.diagnosis ??
          (hostDrawn.length
            ? null
            : emptyTimeline({
                folders: this.folders().length,
                session: hostSession !== null,
                draft: Boolean(hostSession && this.newDrafts[hostSession]),
              }));
        const payloadInput = {
          rail: hostRail,
          hidden: this.hidden,
          pinnedTop: this.pinnedTop,
          comments: this.saved.comments,
          sessions: hostRows,
          showing: hostSession,
          sessionAdoptions: railAdoptions,
          maxSessions: Math.max(1, readSetting('maxSessions')),
          timelineLayout: {
            cardLayout: readSetting('timeline.cardLayout'),
            promptPosition: readSetting('timeline.promptPosition'),
          },
          olderHistory,
          projectSpend: this.projectSpendPayload(),
          diagnosis,
        };
        const payload = selectedOnly
          ? selectionPayload({ ...payloadInput, previousShowing: hostPreviousSession })
          : renderPayload(payloadInput);
        if (!selectedOnly) {
          for (const route of this.clearRoutes?.values() ?? []) {
            if (route.hosts.has(host)) {
              route.hosts.set(host, generation);
            }
          }
        }
        this.startupLoadingSent = JSON.stringify(this.sessionLoadingState(all, generation));
        void this.sendToHost(
          host,
          {
            ...payload,
            startup:
              selectedOnly && this.authoritativeCatalog === null
                ? undefined
                : {
                    ...this.sessionLoadingState(all, generation),
                    complete: !loadingNewest && this.sessionLoadingState(all, generation).complete,
                  },
            usage:
              typeof this.usagePayloadForSession === 'function'
                ? this.usagePayloadForSession(hostSession, host.webview)
                : this.usagePayload(host.webview),
            cards: this.themedFor(hostDrawn, host.webview, light),
            // Keyed by session id, so a heading takes its own and nothing has to be matched up
            // in the panel. Cost and turn count cover the whole recorded session, while
            // context describes the current window.
            ...(selectedOnly ? {} : { stats: hostRail.stats }),
            // The icon theme's font, as a rule the panel can install. Where the file sits is only
            // known once the theme has been found, so it cannot be part of the baked stylesheet.
            // An empty list is the ordinary answer for a theme drawn with images, or for none.
            ...(selectedOnly ? {} : { iconFonts: this.icons.fontFaces(host.webview) }),
          },
          (serializedBytes) => {
            if (serializedBytes !== null) {
              largestRenderBytes = Math.max(largestRenderBytes ?? 0, serializedBytes);
            }
          },
        ).then(
          (accepted) => {
            if (accepted && !controller?.signal.aborted && generation === this.refreshGeneration) {
              this.drawnDispatchFiguresRevision = Math.max(
                this.drawnDispatchFiguresRevision ?? 0,
                figuresRevision ?? 0,
              );
              if (!selectedOnly) {
                metadataAcceptedHosts.add(host);
                // Hidden hosts receive a forced refresh when they become visible.
                if (
                  this.hosts.every(
                    (open) => !this.readyHosts.has(open) || !open.visible() || metadataAcceptedHosts.has(open),
                  )
                ) {
                  this.drawnMetadataRevision = Math.max(this.drawnMetadataRevision ?? 0, metadataRevision);
                }
              }
            }
          },
          () => {},
        );
        if (hostSession) {
          this.hostPreviousSessions?.set(host, hostSession);
        }
      }
      if (!selectedOnly) {
        this.projectSpendHydrationReady = true;
        this.scheduleProjectSpendHydration(generation);
      }
      // The payload just posted words the rail from the read state as it stands, which settles
      // the rail a save skipped. Marked here rather than where the rail was worded, because a
      // render that aborts before this point posts nothing.
      this.railSeedSkipped = false;
      if (!selectedOnly) {
        // A selection omits peer rows, labels and adoptions, so it cannot settle their keys.
        this.lastRailMessageType = largestRenderBytes === null ? null : 'render';
        this.lastRailMessageSerializedBytes = largestRenderBytes;
        this.lastRailAdoptionsJson = JSON.stringify(railAdoptions);
        this.lastRailKey = railKey;
        this.railPendingAnswers = railPending;
        this.lastRailRevision = this.railRevision;
        this.lastRailDay = railWordingDay(railInput.now);
        this.lastRailCountsJson = JSON.stringify([...counts]);
      }
      this.checkpointDerivedCache();
      if (selectedOnly) {
        return;
      }
      // Post an accepted selected window before the next bounded metadata batch.
      if (metadataAfterRender && !(await this.prepareMetadata(all, generation, controller.signal))) {
        return;
      }
      if (controller.signal.aborted || generation !== this.refreshGeneration) {
        return;
      }
      if (metadataAfterRender && this.metadataRevision > metadataRevision) {
        void this.refresh(false, true);
      }
      if (
        (await this.prepareProgressive(sessions, generation, controller.signal)) &&
        !controller.signal.aborted &&
        generation === this.refreshGeneration
      ) {
        void this.refresh(true, true, true);
      } else {
        const enrichment = await this.prepareRailEnrichment(all, generation, controller.signal);
        this.postSessionLoading(all, generation, controller.signal);
        if (
          (enrichment.changed || enrichment.progress) &&
          !controller.signal.aborted &&
          generation === this.refreshGeneration
        ) {
          void this.refresh(enrichment.changed, enrichment.catalogCurrent);
        }
      }
    } catch (error) {
      if (!selectedOnly && controller && this.refreshController === controller && !controller.signal.aborted) {
        this.failSessionLoading(generation, controller.signal);
      }
      console.warn('Arc: session reading failed.', error);
    } finally {
      const owned = !selectedOnly && controller !== null && this.refreshController === controller;
      if (owned) {
        this.refreshController = null;
        if (this.refreshDeadline) {
          clearTimeout(this.refreshDeadline);
          this.refreshDeadline = null;
        }
      }
      this.performanceCounters.recordRefresh(refreshReason, performance.now() - refreshStarted);
      // A refresh that ended before it took the controller still owes the triggers that
      // waited behind its opening reads.
      if (owned || (primed && !this.refreshController)) {
        this.runPendingRefresh();
        if (
          owned &&
          this.dispatchDiscoveryPending &&
          this.startupFailureGeneration !== this.refreshGeneration &&
          this.anyVisible()
        ) {
          setTimeout(() => void this.refresh(false, true), 0);
        }
      }
    }
  }

  // Runs the merged request that waits behind the catalog refresh. A refresh still in flight here
  // is past its deadline, and it is abandoned first.
  private runPendingRefresh(): void {
    const pending = this.pendingRefresh;
    if (!pending) {
      return;
    }
    if (this.refreshController) {
      this.abandonCatalogRefresh();
      this.performanceCounters.recordRefreshStage('abandoned');
    }
    this.pendingRefresh = null;
    this.refreshFrom(
      pending.reason,
      pending.force,
      pending.reuseCatalog,
      pending.changedPaths,
      pending.metadataAfterRender,
    );
  }

  // Disposing the last visible host, a workspace folder change, and a repository scope lookup that
  // answers for the first time, moves the roots, or fails call this. Each discards the catalog refresh in flight and every trigger that waits
  // behind it. A host that only becomes hidden stops the poll and leaves the refresh running.
  private abandonCatalogRefresh(): void {
    this.refreshGeneration++;
    this.refreshController?.abort();
    this.refreshController = null;
    this.pendingRefresh = null;
    this.refreshOverdue = false;
    if (this.refreshDeadline) {
      clearTimeout(this.refreshDeadline);
      this.refreshDeadline = null;
    }
  }

  private checkpointDerivedCache(): void {
    if (this.disposed) return;
    if (!this.derivedCacheFile && !this.codexOpeningsFile) {
      return;
    }
    const delay = this.derivedCacheCheckpointState.nextDelay(Date.now(), DERIVED_CACHE_CHECKPOINT_MS);
    if (delay === null) {
      return;
    }
    if (this.derivedCacheCheckpointTick) {
      if (delay !== 0) {
        return;
      }
      clearTimeout(this.derivedCacheCheckpointTick);
    }
    this.derivedCacheCheckpointTick = setTimeout(() => {
      this.derivedCacheCheckpointTick = null;
      if (this.writeDerivedCache()) {
        this.derivedCacheCheckpointState.markSaved(Date.now());
      }
    }, delay);
  }

  // False when either file still needs a save, so the checkpoint stays dirty and the next one
  // tries again. A shared-file save that found the lock busy also retries on its own timer.
  private writeDerivedCache(): boolean {
    if (this.disposed && !this.cacheShutdownFlushing) return true;
    const openings = this.codexOpenings?.write() ?? true;
    if (!this.derivedCacheFile) {
      return openings;
    }
    try {
      const file = this.derivedCacheFile;
      const write = () =>
        saveDerivedCache(
          file,
          this.titles,
          this.claudeChildReferenceEntries,
          this.carriedNames,
          undefined,
          this.discoveryCheckpoint,
        );
      if (this.workspaceCache) return this.workspaceCache.write(write, this.cacheShutdownFlushing, file) && openings;
      write();
      return openings;
    } catch {
      /* an optional cache must not affect the panel */
    }
    return false;
  }

  // A bounded metadata answer wins. Complete lifetime facts fill a missing newest start.
  private glanceAt(all: SessionFile[], _parsed: SessionFile[]): Map<string, TurnStarts> {
    const out = new Map<string, TurnStarts>();
    const lifetime = this.lifetimeRailFacts();
    for (const session of all) {
      const starts = this.metaFor(session).starts;
      const newest = lifetime[session.sessionId]?.newestTurnStartedAt;
      if (starts?.starts.length || starts?.whole) {
        out.set(session.sessionId, starts);
      } else if (newest !== null && newest !== undefined) {
        out.set(session.sessionId, { starts: [newest], whole: false });
      }
    }
    return out;
  }

  // Missing metadata stays unknown. Only a completed turn-start read can establish zero unread turns.
  private unreadCounts(): Map<string, NewCount> {
    return newCounts([], this.windows, this.saved.read, new Map(Object.entries(this.saved.readTo)), this.saved.since);
  }

  // Rail read watermarks use the same selection-independent starts as unread counts.
  private newestTurns(): Map<string, number> {
    return newestTurnStarts([], this.windows);
  }

  // The sessions an agent is working in now, for the rail. The rule is
  // `runningSessions` in composerview.ts, where the rows and the keys are joined and
  // where a test says which of a row's two agent fields does the matching.
  private runningSessions(): Set<string> {
    return runningSessions(this.sessionRows, [...this.running]);
  }

  // When each of those sessions became busy, for the bound `sessionStatusOf` puts on a
  // busy claim. The rule is `runningSessionsSince` in composerview.ts, beside the join
  // the set itself comes from.
  private runningSince(): Map<string, number> {
    return runningSessionsSince(this.sessionRows, this.runningSinceKeys);
  }

  private activeSessionIds(
    sessions: readonly SessionFile[],
    outcomes = this.sessionOutcomes,
    now = Date.now(),
  ): Set<string> {
    const running = [...this.running];
    const child = new Set(
      sessions
        .filter((session) => sessionRunning(running, session.agent, session.sessionId))
        .map((session) => session.sessionId),
    );
    const statuses = sessionStatusOf([], child, outcomes, now);
    return new Set(
      sessions.filter((session) => statuses.get(session.sessionId) === 'running').map((session) => session.sessionId),
    );
  }

  // Each session's rail status and live open child count, from one clock reading, so a card in
  // the `subagents` state always draws its count.
  private railStatuses(now: number): {
    statuses: ReturnType<typeof sessionStatusOf>;
    openChildren: Map<string, number>;
  } {
    const openChildren = openChildCounts(this.liveOpenChildren(now));
    const statuses = sessionStatusOf(
      [],
      this.runningSessions(),
      this.sessionOutcomes,
      now,
      this.waitingSessions(),
      this.runningSince(),
      openChildren,
      this.liveBackgroundCommands(now),
    );
    return { statuses, openChildren };
  }

  // The background commands each session still waits on, for the rail's `background` state.
  // It reads only the held outcomes and the clock, so two calls at one clock give one answer.
  private liveBackgroundCommands(now: number): Map<string, number> {
    return liveBackgroundCommands(
      this.sessionOutcomes,
      runningSessionsSince(this.sessionRows, this.exitedSinceKeys),
      now,
    );
  }

  // The live open background children of each session, for the rail's `subagents` state and
  // the cards' agent rows. The write times come from what child discovery and
  // `claudeChildRevisions` already read, so this adds no file read to the draw.
  private liveOpenChildren(now: number): Map<string, string[]> {
    let index: Map<string, number> | null = null;
    const writtenAt = (session: string, child: string): number | undefined => {
      index ??= claudeChildWriteIndex(
        this.claudeChildren,
        this.claudeChildReferences.flatMap((reference) => (reference.kind === 'dispatch' ? [] : [reference])),
        this.claudeChildStatWrites,
      );
      return index.get(childWriteKey(session, child));
    };
    return liveOpenChildren(
      this.sessionOutcomes,
      writtenAt,
      runningSessionsSince(this.sessionRows, this.exitedSinceKeys),
      now,
    );
  }

  // Forget the exit of a session that left the listing, since no rail card reads it again.
  private pruneExits(listed: readonly SessionFile[]): void {
    if (!this.exitedSinceKeys.size) {
      return;
    }
    const keys = new Set(listed.map((session) => runningKey(session.agent, session.sessionId)));
    for (const key of this.exitedSinceKeys.keys()) {
      if (!keys.has(key)) {
        this.exitedSinceKeys.delete(key);
      }
    }
  }

  private waitingSessions(): Set<string> {
    return new Set(this.asks.map((entry) => entry.session));
  }

  // The rail alone keeps its earlier order. Running sessions form a stable run above
  // the inactive ones, so beginning work moves a card once and transcript writes do not
  // keep moving it. Everything else continues to read sessionRows newest first.
  private railRows(statuses: ReturnType<typeof sessionStatusOf>): typeof this.sessionRows {
    const ordered = stableRailOrder(this.sessionRows, this.railOrder, statuses);
    this.railOrder = ordered.map((row) => row.id);
    return ordered;
  }

  // What the read state comes to, as one string to compare two of against each other. Both
  // halves are in it: a session marked read from the rail moves the watermarks without
  // touching the read list, and a comparison of the list alone would leave that session
  // wearing its badge until a transcript happened to move.
  private readPrint(): string {
    return JSON.stringify([this.saved.read, this.saved.readTo]);
  }

  // The files the lifetime figures are drawn from. A pass that is walking shows the files it
  // has already settled, so a file the pass has only half read keeps its settled record.
  private lifetimeDisplayFiles(): readonly SpendFileIndex[] {
    return sessionLifetimeDisplayFiles(this.projectSpendBusy(), this.projectSpendFiles, this.projectSpendVisibleFiles);
  }

  private lifetimeFiguresBySession(): LifetimeFigures {
    // Held per session against that session's sources and the records they resolve to, which
    // are all its figures read. A pass starting or ending, or a record changing that the display
    // does not draw yet, keeps them. A grown transcript moves only the sessions that read it. A
    // session with a dispatched source the ledger has not read whole also moves when the ledger
    // queues that source or lets it go.
    return this.lifetimeFigures.read(
      this.lifetimeDisplayFiles(),
      this.sessionSpendSources,
      (sessionId, files, sources, pending): SessionHeldFigures | undefined => {
        // The contributions are priced here, once per change, so a card draw only looks them up.
        const contributions = sources.some((source) => source.dispatchedVia !== undefined)
          ? dispatchedSpendPartsBySession(files, sources, pending)[sessionId]
          : undefined;
        const dispatched = contributions
          ? Object.fromEntries(
              Object.entries(contributions).map(([via, contribution]): [string, HeldDispatchedCost] => [
                via,
                {
                  costs: priceDispatchedParts(
                    Object.values(contribution.parts).flatMap((parts) =>
                      parts.map((part): DispatchedCostUsage => {
                        const usage = sessionCostUsageOf(part);
                        return contribution.own?.parts.includes(part) ? { ...usage, own: true } : usage;
                      }),
                    ),
                  ),
                  short: contribution.short,
                  ...(contribution.own
                    ? { own: { file: contribution.own.file, record: contribution.own.record } }
                    : {}),
                },
              ]),
            )
          : undefined;
        const coverage = new Map<string, SessionSpendCoverage>();
        const indexed = sessionSpendPartsBySession(files, sources, undefined, pending, coverage)[sessionId];
        const turns = sessionTurnStatsBySession(files, sources)[sessionId];
        const cache = sessionCacheFactsBySession(files, sources)[sessionId];
        if (!indexed && !turns && !cache) {
          return dispatched ? { dispatched } : undefined;
        }
        const cost = sessionCostProjection((indexed ?? []).map(sessionCostUsageOf), coverage.get(sessionId));
        const lifetime: SessionLifetimeFigures = {
          stats: [
            ...cost.stats,
            ...sessionTurnStats(turns),
            ...sessionCacheExpiryStats(
              cache?.expiry ?? {
                counts: { '5m': 0, '30m': 0, '1h': 0 },
                longestGapMs: null,
                returns: [],
                excluded: 0,
                unavailable: 0,
                truncated: false,
              },
            ),
          ],
          cost: cost.total,
          contextDetail: sessionCompactionContextDetail(cache?.compactions ?? []),
          // Only a session whose facts are available at all gets an exact count. `cache` is
          // undefined for the same reasons `sessionCacheFactsBySession` withholds it: no single
          // complete primary source, or that source carries no cache-expiry index yet.
          cacheExpiryCount: cache ? cacheExpiryReturnCount(cache.expiry) : null,
        };
        return { lifetime, ...(dispatched ? { dispatched } : {}) };
      },
      (held) => {
        const stats: Record<string, SessionStatChip[]> = {};
        const costs: Record<string, SessionCostTotal> = {};
        const contextDetails: Record<string, SessionContextDetail> = {};
        const cacheExpiryCounts: Record<string, CacheExpiryCountFact | null> = {};
        const dispatched: Record<string, Record<string, HeldDispatchedCost>> = {};
        for (const [sessionId, { lifetime: figure, dispatched: contributions }] of held) {
          if (contributions) {
            dispatched[sessionId] = contributions;
          }
          if (!figure) {
            continue;
          }
          stats[sessionId] = figure.stats;
          costs[sessionId] = figure.cost;
          cacheExpiryCounts[sessionId] = figure.cacheExpiryCount;
          if (figure.contextDetail) {
            contextDetails[sessionId] = figure.contextDetail;
          }
        }
        return { stats, costs, contextDetails, cacheExpiryCounts, dispatched };
      },
      (file, record) => this.projectSpendHolds(file, record),
    );
  }

  // What each dispatched session adds to the turn cards of each session above it. A card reads
  // only these held ledger records and never a transcript. The ledger queue is asked here, at
  // draw time, whether it still holds each dispatched session's own transcript, because a
  // `claude -p --resume` can write to a file that the ledger read whole and finished.
  private dispatchedTurnCosts(): Record<string, Record<string, DispatchedSessionCost>> {
    const out: Record<string, Record<string, DispatchedSessionCost>> = {};
    for (const [sessionId, contributions] of Object.entries(this.lifetimeFiguresBySession().dispatched)) {
      out[sessionId] = Object.fromEntries(
        Object.entries(contributions).map(([via, { costs, short, own }]) => [
          via,
          {
            costs,
            short,
            ownSettledAt:
              own?.record && !this.projectSpendHolds(own.file, own.record)
                ? (own.record.newestTurnStartedAt ?? null)
                : null,
          },
        ]),
      );
    }
    return out;
  }

  // Whether the ledger still holds a dispatched source, by `spendSourceHeld` against the
  // ledger's queue and the history limit now.
  private projectSpendHolds(file: string, record: SpendFileIndex | undefined): boolean {
    return spendSourceHeld(record, this.projectSpendQueued.has(file), this.projectSpendHistoryCutoff());
  }

  // A parent whose dispatched source the ledger has just queued, let go, or left outside the
  // history limit gains or loses its lower-bound mark with no record changing, so the rail and
  // the heading draw it again. The answers are compared with those the last rail drew, because a
  // selection render between the two reads the figures without drawing the rail.
  private postRailIfSpendPendingMoved(): void {
    const holds: SpendSourcePending = (file, record) => this.projectSpendHolds(file, record);
    if (
      this.lifetimeFigures.pendingMoved(holds) ||
      (this.railPendingAnswers !== null && this.lifetimeFigures.pendingMoved(holds, this.railPendingAnswers))
    ) {
      this.postRail(true);
    }
  }

  // `openChildren` and `now` are the reading `statuses` was built from, so a card that says
  // `subagents` always has its count. The background command counts are read again at the same
  // `now`, so a card that says `background` always has its count too.
  private railInputFor(
    counts: ReadonlyMap<string, NewCount>,
    statuses: ReturnType<typeof sessionStatusOf>,
    openChildren: ReadonlyMap<string, number>,
    now: number,
    showing = this.showing,
  ): RailPayloadInput {
    const lifetime = this.lifetimeFiguresBySession();
    return {
      sessions: this.railRows(statuses),
      counts,
      newest: this.newestTurns(),
      statuses,
      runningSince: sessionRunningSince(
        [],
        this.runningSessions(),
        this.sessionOutcomes,
        now,
        this.waitingSessions(),
        this.runningSince(),
      ),
      openChildren,
      backgroundCommands: this.liveBackgroundCommands(now),
      hidden: this.hidden,
      showing,
      pinnedTop: this.pinnedTop,
      unsent: unsentBySession(this.drafts, this.saved.comments),
      parsedStats: {},
      metadataStats: this.metadataStatsBySession,
      lifetimeStats: lifetime.stats,
      lifetimeContextDetails: lifetime.contextDetails,
      lifetimeCosts: lifetime.costs,
      lifetimeCacheExpiry: lifetime.cacheExpiryCounts,
      labels: this.saved.labels,
      caches: railCachesOf(this.parsedRailCaches, this.metadataRailCaches, this.railSourceRevisions),
      views: this.saved.views,
      railFilters: this.saved.railFilters,
      now,
    };
  }

  // Reword the rail after read state or an indexed figure moves. Opening a card is not a
  // render, and background indexing need not move a transcript, so the rail receives its
  // answer here. The cards are already in memory, so this costs no parse. A repeated
  // notification gathers nothing. A read save gathers unread counts first. A changed source
  // posts nothing when its assembled wording has not changed.
  private postRail(
    inputsChanged: boolean,
    knownCounts?: ReadonlyMap<string, NewCount>,
    refreshCatalogFacts = true,
  ): void {
    // A child can report a running-state change after the last panel host closes. Leaving
    // before railRows keeps that event from seeding a new order from stale session rows;
    // the next host then starts from the activity order its own refresh reads.
    if (!this.hosts.length) {
      return;
    }
    if (inputsChanged) {
      this.railRevision++;
    }
    const day = railWordingDay(Date.now());
    if (this.lastRailRevision === this.railRevision && this.lastRailDay === day) {
      return;
    }
    if (this.catalog && refreshCatalogFacts) {
      this.windows = this.glanceAt(this.catalog.sessions, []);
      this.sessionOutcomes = this.outcomesFor(this.catalog.sessions);
    }
    const counts = knownCounts ?? this.unreadCounts();
    const countsJson = JSON.stringify([...counts]);
    const railNow = Date.now();
    const { statuses, openChildren } = this.railStatuses(railNow);
    const input = this.railInputFor(counts, statuses, openChildren, railNow);
    const key = railInputKey(input);
    const pendingAnswers = this.lifetimeFigures.answers();
    const railAdoptions = sessionAdoptions(this.sessionAliases);
    const adoptionsJson = JSON.stringify(railAdoptions);
    if (sameRailInputs(this.lastRailKey, key) && adoptionsJson === this.lastRailAdoptionsJson) {
      this.railPendingAnswers = pendingAnswers;
      this.lastRailRevision = this.railRevision;
      this.lastRailDay = day;
      this.lastRailCountsJson = countsJson;
      return;
    }
    const sharedRail = railPayload(input);
    let largestRailBytes: number | null = null;
    for (const host of this.hosts) {
      const message = {
        type: 'rail' as const,
        ...((this.hostSessions?.get(host) ?? this.showing) === this.showing
          ? sharedRail
          : railPayload(
              this.railInputFor(counts, statuses, openChildren, railNow, this.hostSessions?.get(host) ?? this.showing),
            )),
        sessionAdoptions: railAdoptions,
        hidden: [...this.hidden],
        pinnedTop: [...this.pinnedTop],
      };
      void this.sendToHost(host, message, (serializedBytes) => {
        if (serializedBytes !== null) {
          largestRailBytes = Math.max(largestRailBytes ?? 0, serializedBytes);
        }
      });
    }
    this.lastRailKey = key;
    this.railPendingAnswers = pendingAnswers;
    this.lastRailMessageType = largestRailBytes === null ? null : 'rail';
    this.lastRailMessageSerializedBytes = largestRailBytes;
    this.lastRailAdoptionsJson = adoptionsJson;
    this.lastRailRevision = this.railRevision;
    this.lastRailDay = day;
    this.lastRailCountsJson = countsJson;
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  private ensureProjectSpendWorkspace(): void {
    const workspace = projectSpendWorkspace(this.folders(), MULTI_ROOT_SPEND_WORKSPACE_PREFIX);
    if (this.projectSpendWorkspace === workspace) {
      return;
    }
    // An owed save belongs to the workspace this replaces, and the lists below are cleared. A
    // save that fails here is dropped, because a later write would put the new workspace's
    // empty lists over its saved ledger before hydration restores them.
    this.flushProjectSpendSave();
    this.projectSpendSaveOwed = false;
    this.projectSpendSaveOwedSince = null;
    this.cancelProjectSpendSaveRetry();
    this.cancelProjectSpendOffers();
    this.cancelProjectSpendHydration();
    if (this.projectSpendTick) {
      clearTimeout(this.projectSpendTick);
      this.projectSpendTick = null;
    }
    if (this.projectSpendMidnight) {
      clearTimeout(this.projectSpendMidnight);
      this.projectSpendMidnight = null;
    }
    this.projectSpendWorkspace = workspace;
    this.projectSpendHydrated = !workspace || !this.projectSpendStorageDir;
    this.projectSpendHydrationReady = false;
    this.projectSpendLastOfferAt = 0;
    this.projectSpendRevision++;
    this.projectSpendQueue = [];
    this.projectSpendQueued.clear();
    this.projectSpendCostQueue = null;
    this.projectSpendIndexing = false;
    this.projectSpendFiles = [];
    this.projectSpendVisibleFiles = [];
    if (this.projectSpendHydrated) {
      this.scheduleProjectSpendMidnight();
    }
  }

  private cancelProjectSpendHydration(): void {
    if (!this.projectSpendHydrationTick) {
      return;
    }
    clearTimeout(this.projectSpendHydrationTick);
    this.projectSpendHydrationTick = null;
  }

  private scheduleProjectSpendHydration(generation: number): void {
    const workspace = this.projectSpendWorkspace;
    if (!this.projectSpendHydrationReady || this.projectSpendHydrated || !workspace || !this.projectSpendStorageDir) {
      return;
    }
    this.cancelProjectSpendHydration();
    const tick = setTimeout(() => this.hydrateProjectSpend(workspace, generation, tick), 0);
    this.projectSpendHydrationTick = tick;
  }

  private hydrateProjectSpend(workspace: string, generation: number, tick: ReturnType<typeof setTimeout>): void {
    if (this.projectSpendHydrationTick === tick) {
      this.projectSpendHydrationTick = null;
    }
    if (
      this.disposed ||
      generation !== this.refreshGeneration ||
      workspace !== this.projectSpendWorkspace ||
      this.projectSpendHydrated ||
      !this.projectSpendStorageDir
    ) {
      return;
    }
    const ledger = loadSpendLedger(this.projectSpendStorageDir, workspace);
    const resumable = pruneSpendFilesWithResult(ledger.files);
    const visible = pruneSpendFilesWithResult(ledger.completeFiles);
    this.projectSpendFiles = resumable.files;
    this.projectSpendVisibleFiles = visible.files;
    this.projectSpendHydrated = true;
    this.projectSpendRevision++;
    if (resumable.pruned || visible.pruned) {
      this.scheduleProjectSpendSave();
    }
    this.scheduleProjectSpendMidnight();
    const catalog = this.authoritativeCatalog ?? [];
    this.scheduleProjectSpendIndex(trustedListedRevisions(catalog, this.catalogWalked, this.showing), null);
    this.postProjectSpend();
    // The first render already settled catalog-derived order and status. Hydration adds
    // lifetime figures only, so an older ledger outcome must not move a session afterward.
    this.postRail(true, undefined, false);
  }

  private displayedProjectSpendFiles(): readonly SpendFileIndex[] {
    return projectSpendDisplayFiles(this.projectSpendBusy(), this.projectSpendFiles, this.projectSpendVisibleFiles);
  }

  private projectSpendPayload(): unknown {
    if (!this.projectSpendWorkspace) {
      return null;
    }
    if (!this.projectSpendHydrated) {
      return {
        name: 'Project cost',
        windows: projectSpendWindows(Date.now()).map((window) => ({
          id: window.id,
          label: window.label,
          dollars: null,
          display: 'Unknown',
          status: 'unknown',
          partial: false,
          pricedRequests: 0,
          unpricedRequests: 0,
        })),
        categories: [],
        earliestRecord: null,
        lastIndexedAt: null,
        rateSources: [],
        indexing: true,
        calculating: true,
        indexingStatus: 'Updating…',
      };
    }
    const view = prepareProjectSpendView(this.displayedProjectSpendFiles(), publicProjectSpendPrice, {
      name: 'Project cost',
      indexing: this.projectSpendBusy(),
      historyCutoff: this.projectSpendHistoryCutoff(),
    });
    return {
      ...view,
      calculating: this.projectSpendBusy() && this.projectSpendVisibleFiles.length === 0,
      indexingStatus: this.projectSpendBusy() ? 'Updating…' : null,
    };
  }

  private postProjectSpend(): void {
    void this.post({ type: 'projectSpend', projectSpend: this.projectSpendPayload() });
  }

  private newProjectSpendSaveScheduler(): BoundedTrailingScheduler {
    return new BoundedTrailingScheduler(PROJECT_SPEND_SAVE_MS, PROJECT_SPEND_SAVE_MAX_MS, (event) =>
      this.commitProjectSpendCheckpoint(event.cause),
    );
  }

  private scheduleProjectSpendSave(): void {
    if (this.disposed) return;
    // A change hands the owed save back to the scheduler with a fresh retry budget.
    this.cancelProjectSpendSaveRetry();
    this.projectSpendSaveOwedSince ??= Date.now();
    this.projectSpendSaveOwed = true;
    this.projectSpendSaveScheduler.offer();
  }

  // A failed save tries again on its own, because the last change before agents stop has no
  // later change to carry it. A change that arrives first cancels the try and offers the save
  // to the scheduler instead. After the last try the save waits for the next change or flush.
  private retryProjectSpendSave(): void {
    if (this.disposed) return;
    if (this.projectSpendSaveRetry || this.projectSpendSaveScheduler.pending) {
      return;
    }
    const delay = projectSpendSaveRetryDelay(this.projectSpendSaveRetries);
    if (delay === null) {
      return;
    }
    this.projectSpendSaveRetries++;
    this.projectSpendSaveRetry = setTimeout(() => {
      this.projectSpendSaveRetry = null;
      this.commitProjectSpendCheckpoint('retry');
    }, delay);
  }

  private cancelProjectSpendSaveRetry(): void {
    if (this.projectSpendSaveRetry) {
      clearTimeout(this.projectSpendSaveRetry);
      this.projectSpendSaveRetry = null;
    }
    this.projectSpendSaveRetries = 0;
  }

  private flushProjectSpendSave(): void {
    if (!this.projectSpendSaveScheduler.flush() && this.projectSpendSaveOwed) {
      this.commitProjectSpendCheckpoint('flush');
    }
  }

  private commitProjectSpendCheckpoint(reason: LedgerSaveOperation['reason']): void {
    if (this.disposed && !this.cacheShutdownFlushing) return;
    if (this.projectSpendSaveOwed) {
      this.projectSpendSaveOwed = false;
      if (this.projectSpendStorageDir && this.projectSpendWorkspace) {
        const started = performance.now();
        let succeeded = false;
        try {
          const directory = this.projectSpendStorageDir;
          const workspace = this.projectSpendWorkspace;
          const write = () =>
            saveSpendLedger(directory, workspace, this.projectSpendFiles, this.projectSpendVisibleFiles);
          if (this.workspaceCache) {
            if (!this.workspaceCache.write(write, this.cacheShutdownFlushing, directory)) return;
          } else write();
          succeeded = true;
        } catch (error) {
          // A failed save stays owed, and a bounded retry writes it again.
          this.projectSpendSaveOwed = true;
          const failure = error as NodeJS.ErrnoException;
          this.diagnostics.warn('projectSpendSaveFailed', {
            reason,
            retries: this.projectSpendSaveRetries,
            code: failure?.code ?? null,
            message: failure instanceof Error ? failure.message : String(error),
          });
        } finally {
          this.performanceCounters.recordLedgerSave({
            reason,
            durationMs: performance.now() - started,
            succeeded,
          });
        }
      }
      if (this.projectSpendSaveOwed) {
        this.retryProjectSpendSave();
      } else {
        this.projectSpendSaveOwedSince = null;
        this.cancelProjectSpendSaveRetry();
      }
    }
    // A save can land while a pass is still walking. The figures the rail draws are
    // whole-session totals, so a pass that is still walking has nothing final to say: the owed
    // rail waits for the end of the pass, which posts it once.
    if (this.projectSpendRailOwed && !this.projectSpendIndexing) {
      this.projectSpendRailOwed = false;
      this.postRail(true);
    }
  }

  private scheduleProjectSpendMidnight(): void {
    if (this.projectSpendMidnight) {
      clearTimeout(this.projectSpendMidnight);
    }
    if (!this.projectSpendWorkspace) {
      this.projectSpendMidnight = null;
      return;
    }
    const next = new Date();
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + 1);
    this.projectSpendMidnight = setTimeout(
      () => {
        this.projectSpendMidnight = null;
        this.postProjectSpend();
        this.scheduleProjectSpendMidnight();
      },
      Math.max(1, next.getTime() - Date.now()),
    );
  }

  // The offer stats every source a listing walk did not already describe, and a refresh runs
  // before it posts the render the panel paints from. Spend indexing is background work, so
  // the offer waits for a tick of its own and the paint does not wait on the filesystem.
  private scheduleProjectSpendIndex(
    listedRevisions: ReadonlyMap<string, { size: number; mtimeMs: number }>,
    onlyFiles: ReadonlySet<string> | null,
  ): void {
    // The workspace and the sources are taken here, with the revisions and the targeted set.
    // A listing for another workspace replaces those source lists before the workspace the
    // panel is on is settled, so an offer that read them on its own tick would write one
    // workspace's sources into another's ledger.
    const workspace = this.projectSpendWorkspace;
    const sources = this.projectSpendSources();
    const tick = setTimeout(() => {
      this.projectSpendOffers.delete(tick);
      if (this.projectSpendWorkspace === workspace) {
        this.queueProjectSpendIndex(listedRevisions, onlyFiles, sources);
      }
      // A waiting offer stands for the pass the ledger owes, so the face and the startup
      // milestone both call the ledger unsettled while one waits. An offer that queues
      // nothing has to say the ledger settled, because no pass will.
      if (!this.projectSpendBusy()) {
        this.postProjectSpend();
      }
    }, 0);
    this.projectSpendOffers.add(tick);
  }

  // Whether the ledger owes work. A pass that is running owes it, and so does an offer that
  // is waiting for its tick, because the offer is what decides whether a pass runs at all.
  private projectSpendBusy(): boolean {
    return !this.projectSpendHydrated || this.projectSpendIndexing || this.projectSpendOffers.size > 0;
  }

  // Every source a spend offer would read, taken from the lists the last listing wrote.
  private projectSpendSources(): { file: string; agent: AgentKind; primary?: boolean }[] {
    return [
      ...this.claudeSpendSources.map((source) => ({
        file: source.file,
        agent: 'claude' as const,
        primary: source.primary,
      })),
      ...discoverCodexSpendSources(this.codexSpendSources, this.codexSubagents).map((file) => ({
        file,
        agent: 'codex' as const,
        primary: undefined,
      })),
    ];
  }

  // Drop every offer that has not run. A closed panel and a changed workspace both leave the
  // files an earlier refresh listed with nothing to index them for.
  private cancelProjectSpendOffers(): void {
    for (const tick of this.projectSpendOffers) {
      clearTimeout(tick);
    }
    this.projectSpendOffers.clear();
  }

  private queueProjectSpendIndex(
    listedRevisions: ReadonlyMap<string, { size: number; mtimeMs: number }> = new Map(),
    onlyFiles: ReadonlySet<string> | null = null,
    listedSources: readonly { file: string; agent: AgentKind; primary?: boolean }[] = this.projectSpendSources(),
  ): void {
    const workspace = this.projectSpendWorkspace;
    if (!workspace || !this.projectSpendStorageDir) {
      return;
    }
    const sources = listedSources.filter((source) => !onlyFiles || onlyFiles.has(normalizeFsPath(source.file)));
    const found = new Set<string>();
    const existing = new Map(this.projectSpendFiles.map((file) => [file.file, file]));
    const cutoff = this.projectSpendHistoryCutoff();
    const offer = (file: string, agent: AgentKind, primary?: boolean): void => {
      const key = normalizeSpendFile(file);
      if (this.projectSpendQueued.has(key)) {
        return;
      }
      found.add(key);
      const previous = existing.get(key);
      // A new source needs file facts only when a history limit can skip it.
      let revision: SpendSourceRevision | null | undefined = listedRevisions.get(file);
      if (!revision && (previous || cutoff !== null)) {
        try {
          const stat = fs.statSync(file);
          revision = { size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          invalidateSpendFileNormalization(file);
          revision = null;
        }
      }
      if (projectSpendOfferDecision(previous, revision, cutoff) !== 'queue') {
        return;
      }
      this.projectSpendQueued.add(key);
      this.projectSpendQueue.push({ file, agent, primary });
    };
    for (const source of sources) {
      offer(source.file, source.agent, source.primary);
    }
    this.projectSpendCostQueue = null;
    if (!onlyFiles) {
      for (const record of this.projectSpendFiles) {
        if (found.has(record.file)) {
          continue;
        }
        offer(record.file, spendRecordAgent(record), !spendFileIsClaudeChild(record.file));
      }
    }
    this.postRailIfSpendPendingMoved();
    if (this.projectSpendTick) {
      return;
    }
    this.projectSpendIndexing = true;
    this.postProjectSpend();
    this.projectSpendTick = setTimeout(() => this.indexNextProjectSpendFile(), 0);
  }

  private projectSpendHistoryCutoff(now = Date.now()): number | null {
    return projectSpendHistoryCutoff(readSetting('projectCost.historyDays'), now);
  }

  // A new history limit drops every queued source and offers them all again under it, so a
  // lower limit leaves older unscanned sources out and a higher one brings them in.
  private restartProjectSpendOffer(): void {
    this.projectSpendQueue = [];
    this.projectSpendQueued.clear();
    this.projectSpendLastOfferAt = Date.now();
    this.queueProjectSpendIndex();
    this.postProjectSpend();
  }

  private indexNextProjectSpendFile(): void {
    this.projectSpendTick = null;
    const next = this.projectSpendQueue.shift();
    const workspace = this.projectSpendWorkspace;
    if (!workspace || !this.projectSpendStorageDir) {
      this.finishProjectSpendIndex();
      return;
    }
    if (!next) {
      if (this.indexNextClaudeCostState()) {
        this.projectSpendTick = setTimeout(() => this.indexNextProjectSpendFile(), 0);
      } else this.finishProjectSpendIndex();
      return;
    }
    const key = normalizeSpendFile(next.file);
    const at = this.projectSpendFiles.findIndex((record) => record.file === key);
    const previous = at >= 0 ? this.projectSpendFiles[at] : undefined;
    const makeReducer =
      next.agent === 'claude'
        ? (state: unknown) =>
            createClaudeUsageLineReducer(state as Parameters<typeof createClaudeUsageLineReducer>[0], {
              childTranscript: next.primary === false,
            })
        : (state: unknown) => createCodexUsageLineReducer(state as Parameters<typeof createCodexUsageLineReducer>[0]);
    const result = indexSpendFile(previous, next.file, workspace, makeReducer);
    if (at >= 0) {
      this.projectSpendFiles[at] = result.record;
    } else {
      this.projectSpendFiles.push(result.record);
    }
    if (result.record !== previous) {
      this.projectSpendRevision++;
    }
    if (result.stateChanged) {
      this.scheduleProjectSpendSave();
    }
    if (spendRecordChangesRail(previous, result.record)) {
      this.projectSpendRailOwed = true;
    }
    if (result.complete) {
      this.projectSpendQueued.delete(key);
      // One file can grow while its bounded read is in flight. Re-offer just that file
      // against the revision the reader completed, rather than waiting for the broad
      // integrity pass or walking every source again.
      try {
        const stat = fs.statSync(next.file);
        if (stat.size !== result.record.size || stat.mtimeMs !== result.record.mtimeMs) {
          this.projectSpendQueued.add(key);
          this.projectSpendQueue.push(next);
        }
      } catch {
        invalidateSpendFileNormalization(next.file);
        // The integrity pass marks the disappeared source in the ledger.
      }
    } else {
      this.projectSpendQueue.push(next);
    }
    this.projectSpendTick = setTimeout(() => this.indexNextProjectSpendFile(), 0);
  }

  private indexNextClaudeCostState(): boolean {
    if (!this.claudeChildrenDiscovered || this.dispatchDiscoveryPending) return false;
    const sources = this.sessionSpendSources ?? this.claudeSpendSources;
    if (this.projectSpendCostQueue === null) {
      this.projectSpendCostQueue = [];
      for (const owner of sources.filter((source) => !source.dispatchedFrom && !source.dispatchedVia)) {
        const key = normalizeSpendFile(owner.file);
        const at = this.projectSpendFiles.findIndex((file) => file.file === key);
        const record = this.projectSpendFiles[at];
        const capture = (record?.parserState as ClaudeUsageReducerState | undefined)?.costState;
        if (!record || !capture?.snapshots.length) continue;
        const dependencies = claudeCostStateDependencies(owner, sources, this.projectSpendFiles);
        const identity = dependencies ? costStateIdentity(dependencies.map(costStateDependency)) : null;
        if (record.costStateSupplement?.identity !== identity && record.costStateSupplement) {
          const { costStateSupplement: _supplement, ...baseline } = record;
          this.projectSpendFiles[at] = baseline;
          this.projectSpendRevision++;
          this.scheduleProjectSpendSave();
        }
        if (
          dependencies &&
          record.costStateSupplement?.identity !== identity &&
          !(record.costStateProgress?.identity === identity && record.costStateProgress.reason)
        )
          this.projectSpendCostQueue.push(key);
      }
      this.projectSpendCostQueue.sort((left, right) => {
        const length = (key: string) => {
          const owner = sources.find(
            (source) => !source.dispatchedFrom && !source.dispatchedVia && normalizeSpendFile(source.file) === key,
          );
          return owner ? (claudeCostStateDependencies(owner, sources, this.projectSpendFiles)?.length ?? 0) : 0;
        };
        return length(left) - length(right);
      });
    }
    const key = this.projectSpendCostQueue.shift();
    if (!key) return false;
    const owner = sources.find(
      (source) => !source.dispatchedFrom && !source.dispatchedVia && normalizeSpendFile(source.file) === key,
    );
    const at = this.projectSpendFiles.findIndex((file) => file.file === key);
    const record = this.projectSpendFiles[at];
    const dependencies = owner && claudeCostStateDependencies(owner, sources, this.projectSpendFiles);
    const capture = (record?.parserState as ClaudeUsageReducerState | undefined)?.costState;
    if (!dependencies || !capture) return this.projectSpendCostQueue.length > 0;
    const result = reconcileClaudeCostState(
      capture,
      dependencies,
      (state) =>
        createClaudeUsageLineReducer(state as ClaudeUsageReducerState | undefined, {
          childTranscript: true,
          retainAllRequests: true,
        }),
      record.costStateProgress,
    );
    if (result.invalidated) {
      this.projectSpendCostQueue = null;
      this.queueProjectSpendIndex();
      return true;
    }
    this.projectSpendFiles[at] = {
      ...record,
      costStateProgress: result.progress,
      ...(result.supplement ? { costStateSupplement: result.supplement } : {}),
    };
    this.projectSpendRevision++;
    this.scheduleProjectSpendSave();
    if (result.progress.reason)
      this.diagnostics.warn('claudeCostStateWithheld', { file: key, reason: result.progress.reason });
    if (!result.complete) this.projectSpendCostQueue.unshift(key);
    if (result.supplement) this.projectSpendCostQueue = null;
    return true;
  }

  private finishProjectSpendIndex(): void {
    this.projectSpendCostQueue = null;
    const pruned = pruneSpendFilesWithResult(this.projectSpendFiles);
    this.projectSpendFiles = pruned.files;
    const displayMoved =
      pruned.pruned ||
      this.projectSpendVisibleFiles.length !== this.projectSpendFiles.length ||
      this.projectSpendVisibleFiles.some((file, at) => file !== this.projectSpendFiles[at]);
    this.projectSpendVisibleFiles = this.projectSpendFiles.slice();
    // A pass ends on every idle tick of the queue, so only a pass that moved the displayed
    // files moves the ledger revision. The save writes the displayed files too, and a save the
    // scheduler ran during the pass wrote the list this replaces. The save stays with the
    // scheduler: while agents write, a pass ends on every append, and a save at each end would
    // write the whole ledger that often.
    if (displayMoved) {
      this.projectSpendRevision++;
      this.scheduleProjectSpendSave();
    }
    if (this.projectSpendIndexing) {
      this.projectSpendIndexing = false;
      this.postProjectSpend();
      const railOwed = this.projectSpendRailOwed || displayMoved;
      this.projectSpendRailOwed = false;
      if (railOwed) {
        this.postRail(true);
      } else {
        this.postRailIfSpendPendingMoved();
      }
      // The face and the rail carry every figure a pass moves, so a pass ends without a full
      // refresh. A refresh offers a source again whenever the listing moved it, so a pass that
      // ended in one would start the next pass for as long as an agent writes.
    }
  }

  // Every session belonging to this workspace, from either agent, newest activity first.
  //
  // Enumeration and source ownership stay here. The worker supplies transcript metadata
  // before refresh orders the catalog by recorded activity.
  //
  // The two lists are merged here rather than kept apart, because the reader wants one
  // session history: work moves between the two agents within an afternoon, and two
  // lists side by side would make the order between them something to work out by hand.
  private allSessions(reuseCatalog = false): SessionFile[] {
    const codexWalk = this.codexWalk ?? undefined;
    this.codexWalk = null;
    const workspaceFolders = this.folders();
    const scope = this.repositoryScope.snapshot(workspaceFolders);
    this.repositoryScopeReady = scope.ready;
    this.repositoryScopeRoots = scope.ready ? scope.roots : [];
    if (!scope.ready) {
      return [];
    }
    this.startupHistory?.stage('scopeResolved');
    const folderPrint = `${workspaceFolders.join('\n')}\0${scope.revision}`;
    if (this.targetedRefreshPaths?.length && this.catalog && this.catalog.folders === folderPrint) {
      const held = revalidatedCatalogPaths(this.catalog.sessions, this.targetedRefreshPaths, (file) => {
        try {
          const stat = fs.statSync(file);
          return { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      });
      if (held) {
        const sorted = orderSessionCatalog(held, (session) => this.activityFor(session));
        this.claudeParents = sorted.filter((session) => session.childTranscript !== true);
        this.catalog = { folders: folderPrint, sessions: sorted };
        this.catalogWalked = false;
        return sorted;
      }
    }
    if (reuseCatalog && this.catalog && this.catalog.folders === folderPrint) {
      const held = revalidatedCatalog(this.catalog.sessions, this.showing, (file) => {
        try {
          const stat = fs.statSync(file);
          return { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      });
      // Sorted again rather than handed back in the held order. The one session that
      // was re-read may have grown, and growing moves the activity the list is ranked by.
      if (held) {
        const sorted = orderSessionCatalog(held, (session) => this.activityFor(session));
        // Held again rather than left as it was walked. The one session that was read
        // again keeps its new revision, so a second selection does not hand the old size back
        // and make every derived fact about it be worked out a second time.
        this.catalog = { folders: folderPrint, sessions: sorted };
        this.catalogWalked = false;
        return sorted;
      }
    }
    const codexRevision = this.codexMetas.revision;
    const claude = sessionFilesFor(
      projectsRoot(),
      scope.roots,
      (file, session) => {
        const hit = this.cwds.get(file);
        if (hit?.cwd) {
          return hit.cwd;
        }
        if (hit && sameSessionRevision(hit, session)) {
          return hit.cwd;
        }
        const cwd = readSessionCwd(file);
        this.cwds.set(file, { cwd, mtimeMs: session.mtimeMs, size: session.size });
        return cwd;
      },
      workspaceFolders,
    );
    // A hidden panel ignores watcher events, so a walk then stats every rollout and holds none.
    const listing = codexSessionFiles(
      codexSessionsRoot(),
      scope.roots,
      (file) => {
        return this.codexMetas.get(file);
      },
      (file) => (this.watching ? this.codexStats.get(file) : readRolloutStat(file)),
      codexWalk,
    );
    for (const file of staleMetas(this.codexStats.keys(), listing.walked)) {
      this.codexStats.delete(file);
    }
    // Trimmed here rather than in `evictCache`, because this is the only place the walk's
    // own list exists and it is the only list this cache may be measured against.
    // `staleMetas` says why.
    for (const file of staleMetas(this.codexMetas.keys(), listing.walked)) {
      this.codexMetas.delete(file);
    }
    this.codexOpenings?.setWalk(listing.walked);
    if (this.codexMetas.revision !== codexRevision) {
      this.derivedCacheCheckpointState.markChanged(true);
    }
    this.enumeratedSpendSources = {
      claude: discoverClaudeSessionSpendSources(claude, this.subagentDirectories),
      codex: listing.sources,
      children: listing.subagents,
    };
    const codex = listing.sessions;
    this.claudeParents = [...claude, ...codex];
    this.walkedClaude = claude.map((s) => s.file);
    // The peer-wake cut, after membership and before anything else touches the files. A
    // cross-session message wakes a session whose transcript has no human prompt, no
    // title and no drawable turn, and it drew as a "Session <hash>" card; a session
    // joins the list only once a human has prompted it. Cut here, so the picker, rail,
    // search corpus, and selected-session empty state all agree. The Codex side
    // has its own rule for background review and dispatched children in `codex.ts`.
    const listed = claude.filter((s) => this.hasHumanPrompt(s));
    this.subagentDirectories.sweep();
    // Ordered by what each session recorded, not by what its file's mtime says. The picker
    // and read cut use this order directly, and it seeds the rail before the rail holds its
    // cards stable. An agent appending bookkeeping to a finished session therefore
    // cannot lift it above every session the reader had actually worked in.
    const walked = new Set([
      ...listing.walked,
      ...claude.map((session) => session.file),
      ...this.claudeChildren.map((session) => session.file),
    ]);
    // Before the first child discovery, this list lacks every Claude child transcript. A
    // prune then would drop each child's stored entry and carried name, and the child would
    // draw a placeholder until its reread. The discovery prunes against the complete list.
    if (this.claudeChildrenDiscovered && this.pruneDerivedTitles(walked)) {
      this.derivedCacheCheckpointState.markChanged();
    }
    const walkedSessions = orderSessionCatalog([...listed, ...this.claudeChildren, ...codex], (session) =>
      this.activityFor(session),
    );
    this.catalog = { folders: folderPrint, sessions: walkedSessions };
    this.catalogWalked = true;
    return walkedSessions;
  }

  // `sessions` is the catalog the sources are listed for. Its rows decide which dispatch edges
  // count, by the same rule the heading, the filing and the refresh key read.
  private updateSessionSpendSources(codex: SessionFile[], sessions: readonly SessionFile[]): void {
    const revision = this.sessionSpendSourceIndex.revision;
    this.sessionSpendSources = this.sessionSpendSourceIndex.update(
      this.claudeSpendSources,
      this.claudeChildren,
      codex,
      this.codexSubagents,
      this.subagentDirectories,
      this.dispatchEdges(sessions),
    );
    const invalidated = invalidateClaudeCostSupplements(this.projectSpendFiles, this.sessionSpendSources);
    const invalidatedVisible = invalidateClaudeCostSupplements(this.projectSpendVisibleFiles, this.sessionSpendSources);
    if (
      invalidated.some((file, at) => file !== this.projectSpendFiles[at]) ||
      invalidatedVisible.some((file, at) => file !== this.projectSpendVisibleFiles[at])
    ) {
      this.projectSpendFiles = invalidated;
      this.projectSpendVisibleFiles = invalidatedVisible;
      this.projectSpendCostQueue = null;
      this.projectSpendRevision++;
      this.scheduleProjectSpendSave();
    }
    if (this.sessionSpendSourceIndex.revision !== revision) {
      this.projectSpendRevision++;
    }
  }

  private async prepareClaudeChildren(generation: number, signal: AbortSignal): Promise<boolean> {
    const requestOrder = (this.discoveryRequestSequence = (this.discoveryRequestSequence ?? 0) + 1);
    const spendSources = this.discoveryCheckpoint?.spendSources ?? this.enumeratedSpendSources;
    const acknowledge = (result: import('./progressiveworker').ProgressiveResult): boolean => {
      const progress = result.value;
      if (
        progress.kind !== 'claude-children' &&
        progress.kind !== 'claude-children-progress' &&
        progress.kind !== 'claude-children-delta'
      )
        return false;
      const delta = progress.kind === 'claude-children-delta' ? progress : undefined;
      const heldCheckpoint = this.discoveryCheckpoint;
      const checkpoint = progress.checkpoint ?? (delta?.epoch === heldCheckpoint?.epoch ? heldCheckpoint : undefined);
      if (
        delta &&
        (!checkpoint ||
          checkpoint.epoch !== delta.epoch ||
          delta.parserVersion !== CLAUDE_CHILD_REFERENCE_PARSER_VERSION)
      )
        return false;
      const sequence = delta?.sequence ?? checkpoint?.sequence ?? 0;
      const scope = JSON.stringify(
        checkpoint?.repositoryRoots ??
          (progress.kind === 'claude-children' ? (progress.scope ?? this.repositoryScopeRoots) : []),
      );
      if (scope !== JSON.stringify(this.repositoryScopeRoots)) return false;
      if (checkpoint?.parserVersion !== undefined && checkpoint.parserVersion !== CLAUDE_CHILD_REFERENCE_PARSER_VERSION)
        return false;
      const previous = this.discoveryAcknowledgment;
      if (
        checkpoint &&
        heldCheckpoint &&
        JSON.stringify(heldCheckpoint.repositoryRoots) === scope &&
        checkpoint?.epoch === heldCheckpoint.epoch &&
        sequence < heldCheckpoint.sequence
      )
        return false;
      if (previous?.scope === scope) {
        if (checkpoint?.epoch === previous.epoch) {
          if (sequence < previous.sequence) return false;
        } else if (result.generation < previous.generation || requestOrder < previous.request) return false;
      }
      if (!checkpoint && (signal.aborted || result.generation !== this.refreshGeneration)) return false;
      const sameScope =
        (!previous || previous.scope === scope) &&
        (!heldCheckpoint || JSON.stringify(heldCheckpoint.repositoryRoots) === scope);
      const acknowledged = sameScope
        ? this.claudeChildReferenceEntries
        : new Map<string, ClaudeChildReferenceCacheEntry>();
      for (const [file, entry] of progress.referenceEntries) {
        if (entry.parserVersion !== CLAUDE_CHILD_REFERENCE_PARSER_VERSION) return false;
        const held = acknowledged.get(file);
        const sameSource =
          held?.parserVersion === entry.parserVersion &&
          held.sessionId === entry.sessionId &&
          held.source === entry.source &&
          held.childTranscript === entry.childTranscript;
        if (
          sameSource &&
          ((entry.sourceGeneration ?? 0) < (held.sourceGeneration ?? 0) ||
            ((entry.sourceGeneration ?? 0) === (held.sourceGeneration ?? 0) &&
              (entry.sequence ?? entry.claudeCursor?.sequence ?? 0) <
                (held.sequence ?? held.claudeCursor?.sequence ?? 0)))
        )
          return false;
      }
      for (const [file, entry] of progress.referenceEntries) acknowledged.set(file, entry);
      this.claudeChildReferenceEntries = acknowledged;
      this.discoveryAcknowledgment = {
        scope,
        request: requestOrder,
        epoch: checkpoint?.epoch,
        sequence,
        generation: Math.max(result.generation, previous?.scope === scope ? previous.generation : 0),
      };
      if (checkpoint && spendSources) checkpoint.spendSources = spendSources;
      if (delta && checkpoint) {
        const completed =
          checkpoint === heldCheckpoint && this.discoveryCompleted
            ? this.discoveryCompleted
            : new Set(checkpoint.completed);
        for (const [file, complete] of delta.completed) {
          if (complete && !completed.has(file)) {
            completed.add(file);
            checkpoint.completed.push(file);
          } else if (!complete && completed.delete(file)) {
            checkpoint.completed.splice(checkpoint.completed.indexOf(file), 1);
          }
        }
        checkpoint.sequence = sequence;
        checkpoint.position = delta.position;
        checkpoint.protectedFile = delta.protectedFile;
        this.discoveryCompleted = completed;
      } else this.discoveryCompleted = undefined;
      this.discoveryCheckpoint = progress.kind !== 'claude-children' ? checkpoint : undefined;
      this.derivedCacheCheckpointState.markChanged();
      if (
        !signal.aborted &&
        result.generation === this.refreshGeneration &&
        Date.now() - (this.startupProgressAt ?? 0) >= 250 &&
        checkpoint
      ) {
        this.startupProgressAt = Date.now();
        const known = new Set([...checkpoint.parents, ...checkpoint.catalog].map((row) => normalizeFsPath(row.file)));
        const completed = new Set(checkpoint.completed.map(normalizeFsPath).filter((file) => known.has(file))).size;
        void this.post({
          type: 'startupProgress',
          generation: result.generation,
          epoch: String(generation),
          sequence: (this.startupProgressSequence = (this.startupProgressSequence ?? 0) + 1),
          completed,
          known: known.size,
        }).catch(() => {});
      }
      return true;
    };
    const result = await this.progressiveWorker
      .run(
        {
          kind: 'claude-children',
          codexChildren: spendSources?.children ?? this.codexSubagents,
          parents: this.claudeParents,
          catalog: this.claudeParents,
          repositoryRoots: this.repositoryScopeRoots,
          referenceEntries: [...this.claudeChildReferenceEntries],
          discovery: this.discoveryCheckpoint,
        },
        generation,
        signal,
        acknowledge,
      )
      .catch(() => null);
    if (!result) {
      this.failSessionLoading(generation, signal);
      return false;
    }
    if (!acknowledge(result)) return false;
    const progress = result.value;
    if (
      progress.kind !== 'claude-children' &&
      progress.kind !== 'claude-children-progress' &&
      progress.kind !== 'claude-children-delta'
    )
      return false;
    this.performanceCounters?.recordDiscovery?.(progress.charges, progress.kind === 'claude-children');
    if (signal.aborted || result.generation !== this.refreshGeneration) return false;
    if (progress.kind !== 'claude-children' || !progress.complete) {
      this.dispatchDiscoveryPending = true;
      this.checkpointDerivedCache();
      if (this.catalog) this.catalog = { ...this.catalog, sessions: this.authoritativeCatalog ?? [] };
      return this.authoritativeCatalog !== null;
    }
    this.claudeChildReferences = progress.references;
    this.startupHistory?.stage('relationshipsComplete');
    this.dispatchDiscoveryPending = progress.continuation;
    const facts = new Map((progress.dispatchFacts ?? []).map((facts) => [facts.sessionId, facts]));
    const figures = (entries: Map<string, DispatchSessionFacts> | undefined) =>
      [...(entries?.values() ?? [])]
        .map(({ revision: _revision, refreshAt: _refreshAt, spend, ...rendered }) => {
          if (!spend.artifacts) return { ...rendered, spend };
          const { revision: _artifactRevision, ...artifacts } = spend.artifacts;
          return { ...rendered, spend: { ...spend, artifacts } };
        })
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    if (!isDeepStrictEqual(figures(this.dispatchFacts), figures(facts))) {
      this.dispatchFiguresRevision = (this.dispatchFiguresRevision ?? 0) + 1;
    }
    this.dispatchFacts = facts;
    this.claudeChildren = progress.children;
    this.claudeChildrenDiscovered = true;
    const currentFiles = new Set(progress.referenceEntries.map(([file]) => file));
    for (const file of this.claudeChildReferenceEntries.keys())
      if (!currentFiles.has(file)) this.claudeChildReferenceEntries.delete(file);
    const referenced = new Set(
      this.claudeChildReferences
        .filter((reference) => reference.kind !== 'dispatch')
        .map((reference) => reference.file),
    );
    for (const file of this.claudeChildStatWrites.keys()) {
      if (!referenced.has(file)) {
        this.claudeChildStatWrites.delete(file);
      }
    }
    const held = this.catalog?.sessions ?? [];
    const discoveryRoots =
      progress.roots ?? held.filter((session) => session.agent !== 'claude' || session.childTranscript !== true);
    const roots = discoveryRoots.filter((session) => session.agent !== 'claude' || this.hasHumanPrompt(session));
    if (spendSources) {
      this.claudeSpendSources = spendSources.claude;
      this.codexSpendSources = spendSources.codex;
      this.codexSubagents = spendSources.children;
    }
    const codex = roots.filter((session) => session.agent === 'codex');
    const sessions = orderSessionCatalog([...roots, ...this.claudeChildren], (session) => this.activityFor(session));
    this.updateSessionSpendSources(codex, sessions);
    if (this.catalog) {
      this.catalog = { ...this.catalog, sessions };
    }
    const walked = new Set(sessions.map((session) => session.file));
    if (this.pruneDerivedTitles(walked)) {
      this.derivedCacheCheckpointState.markChanged();
    }
    return true;
  }

  // Drops the stored entry and the carried name of every session file `listed` does not hold.
  // True when anything was dropped, so the caller marks the cache for its next save.
  private pruneDerivedTitles(listed: ReadonlySet<string>): boolean {
    let dropped = false;
    for (const held of [this.titles, this.carriedNames]) {
      for (const file of held.keys()) {
        if (!listed.has(file)) {
          held.delete(file);
          dropped = true;
        }
      }
    }
    return dropped;
  }

  // The scan is sticky through the cache: a file once known to hold a human prompt is
  // never read for one again, and a wake file is re-read only past where the last scan
  // stopped, which its size says without opening anything.
  private hasHumanPrompt(session: SessionFile): boolean {
    const prev = this.humanScans.get(session.file);
    if (prev?.found) {
      return true;
    }
    const next = scanForHumanPrompt(session.file, session.size, prev);
    this.humanScans.set(session.file, next);
    return next.found;
  }

  // Only the selected session needs turn cards. Rail facts come from metadata.
  private shownSessions(all: SessionFile[]): SessionFile[] {
    const showing = new Set(
      [this.showing, ...(this.hostSessions?.values() ?? [])].filter((session): session is string => session !== null),
    );
    return all.filter((session) => showing.has(session.sessionId));
  }

  // Return accepted rail metadata without reading the transcript. Unread files use neutral facts.
  private metaFor(session: SessionFile): DerivedTitleEntry {
    return (
      this.titles.get(session.file) ?? {
        size: -1,
        mtimeMs: -1,
        label: '',
        fullLabel: '',
        activityMs: null,
        agentRun: session.agentRun === true,
        outcome: null,
        stats: null,
      }
    );
  }

  private storeTitleEntry(file: string, entry: DerivedTitleEntry): void {
    const previous = this.titles.get(file);
    this.titles.set(file, entry);
    if ((previous?.label ?? '') !== entry.label || (previous?.fullLabel ?? '') !== entry.fullLabel) {
      this.metadataRevision = (this.metadataRevision ?? 0) + 1;
    }
  }

  private async prepareMetadata(sessions: SessionFile[], generation: number, signal: AbortSignal): Promise<boolean> {
    let remaining = INITIAL_RAIL_READ_BYTES;
    for (const session of sessions) {
      const previous = this.titles.get(session.file);
      if (previous && sameSessionRevision(previous, session) && previous.foldedLabel !== undefined) {
        this.observeStoredEntry(session, previous);
        continue;
      }
      const bytes = metadataReadBudget(session);
      if (bytes > remaining) {
        break;
      }
      remaining -= bytes;
      const result = await this.progressiveWorker
        .run(
          {
            kind: 'metadata',
            session,
            opening: session.agent === 'codex' ? this.codexMetas.get(session.file) : undefined,
          },
          generation,
          signal,
        )
        .catch(() => null);
      const currentRevision = this.revisionOf(session);
      if (!result) this.failSessionLoading(generation, signal);
      const grewAfterRead = Boolean(
        result?.revision &&
        result.value.kind === 'metadata' &&
        currentRevision.size > result.revision.size &&
        onlyGrew(result.revision, currentRevision),
      );
      if (
        !result ||
        signal.aborted ||
        generation !== this.refreshGeneration ||
        (!acceptsProgressiveResult(result, this.refreshGeneration, currentRevision) && !grewAfterRead)
      ) {
        if (signal.aborted || generation !== this.refreshGeneration) return false;
        continue;
      }
      if (result.value.kind !== 'metadata' || !result.value.coverage) {
        continue;
      }
      const entry = result.value.entry;
      // Given back before the next session is weighed, because the read is done and says
      // what it took. A titled session costs its tail and a 4 KiB fingerprint, not the whole
      // prompt head the budget held for it.
      remaining += unreadHeadBytes(session, entry);
      const carried = carryDerivedTitleFacts(previous, entry, session);
      this.storeTitleEntry(session.file, carried);
      // The read's own name replaces the one a version bump carried.
      this.carriedNames.delete(session.file);
      this.observeStoredEntry(session, carried);
      this.derivedCacheCheckpointState.markChanged(previous === undefined);
    }
    return true;
  }

  private async prepareRailEnrichment(
    sessions: SessionFile[],
    generation: number,
    signal: AbortSignal,
  ): Promise<{ changed: boolean; catalogCurrent: boolean; progress: boolean }> {
    let remaining = INITIAL_RAIL_READ_BYTES;
    let changed = false;
    let catalogCurrent = true;
    let progress = false;
    for (const session of sessions) {
      if (signal.aborted) {
        break;
      }
      const previous = this.titles.get(session.file);
      const needs = previous ? railEnrichmentNeeds(previous, session) : null;
      if (!previous || !needs) {
        continue;
      }
      const needsStarts = needs.starts;
      const needsMetadata = needs.metadata;
      const bytes =
        (needsStarts ? Math.min(session.size, RAIL_ENRICHMENT_READ_BYTES) : 0) +
        (needsStarts ? agentRunScanUnread(session, previous.agentRunScan) : 0);
      if (bytes > remaining && remaining < INITIAL_RAIL_READ_BYTES) {
        break;
      }
      remaining -= bytes;
      let next = previous;
      if (needsStarts) {
        const result = await this.progressiveWorker.run(
          { kind: 'starts', session, agentRunScan: previous.agentRunScan },
          generation,
          signal,
        );
        if (!result || signal.aborted) {
          if (!result) this.failSessionLoading(generation, signal);
          break;
        }
        if (!acceptsProgressiveResult(result, this.refreshGeneration, this.revisionOf(session))) {
          const current = this.titles.get(session.file);
          const kept =
            current &&
            result.value.kind === 'stale' &&
            result.value.agentRunScan &&
            onlyGrew(result.revision, this.revisionOf(session))
              ? withAgentRunScanProgress(current, result.value.agentRunScan)
              : null;
          if (kept) {
            this.storeTitleEntry(session.file, kept);
            this.derivedCacheCheckpointState.markChanged();
          }
          break;
        }
        if (result.value.kind !== 'starts') {
          continue;
        }
        next = withRailEnrichment(next, result.value.starts, result.value.agentRunScan);
        this.storeTitleEntry(session.file, next);
        this.derivedCacheCheckpointState.markChanged();
        changed = true;
      }
      if (needsMetadata) {
        const metadataBytes = metadataReadBudget(session, RAIL_ENRICHMENT_READ_BYTES);
        if (metadataBytes > remaining) continue;
        remaining -= metadataBytes;
        const result = await this.progressiveWorker
          .run(
            {
              kind: 'metadata',
              session,
              tailBytes: RAIL_ENRICHMENT_READ_BYTES,
              opening: session.agent === 'codex' ? this.codexMetas.get(session.file) : undefined,
            },
            generation,
            signal,
          )
          .catch(() => null);
        if (!result || signal.aborted) {
          if (!result) this.failSessionLoading(generation, signal);
          if (signal.aborted || generation !== this.refreshGeneration) break;
          continue;
        }
        if (!acceptsProgressiveResult(result, this.refreshGeneration, this.revisionOf(session))) {
          catalogCurrent = false;
          if (generation !== this.refreshGeneration) break;
          continue;
        }
        if (result.value.kind !== 'metadata' || !result.value.coverage) {
          continue;
        }
        const found = withRailEnrichment(
          result.value.entry,
          next.starts!,
          scanForRailEnrichment(session, next.agentRunScan),
        );
        next = carryDerivedTitleFacts(next, withMetadataCoverage(found, result.value.coverage), session);
        next = this.observeStoredName(session, next);
      }
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        this.storeTitleEntry(session.file, next);
        this.derivedCacheCheckpointState.markChanged();
        changed = true;
      }
    }
    const eligible = sessions.filter((session) => {
      const entry = this.titles.get(session.file);
      return entry && railEnrichmentNeeds(entry, session)?.recovery;
    });
    const eligibleIds = new Set(eligible.map((session) => session.sessionId));
    this.progressiveWorker.retainMetadataRecovery?.([...eligibleIds]);
    this.metadataRecoveryQueue = (this.metadataRecoveryQueue ?? []).filter((id) => eligibleIds.has(id));
    for (const session of eligible) {
      if (
        session.sessionId !== this.metadataRecoverySession &&
        !this.metadataRecoveryQueue.includes(session.sessionId)
      ) {
        this.metadataRecoveryQueue.push(session.sessionId);
      }
    }
    const protectedSession = eligible.find((session) => session.sessionId === this.metadataRecoverySession);
    const waitingId = protectedSession ? null : this.metadataRecoveryQueue.shift();
    const active = protectedSession ?? eligible.find((session) => session.sessionId === waitingId);
    this.metadataRecoverySession = active?.sessionId ?? null;
    if (active && remaining > 0 && !signal.aborted && generation === this.refreshGeneration) {
      const sliceBytes = Math.min(remaining, RAIL_ENRICHMENT_READ_BYTES);
      remaining -= sliceBytes;
      const result = await this.progressiveWorker
        .run(
          {
            kind: 'metadata-recovery',
            session: active,
            sliceBytes,
            eligible: eligible.map((session) => session.sessionId),
            opening: active.agent === 'codex' ? this.codexMetas.get(active.file) : undefined,
          },
          generation,
          signal,
        )
        .catch(() => null);
      if (
        result &&
        acceptsProgressiveResult(result, this.refreshGeneration, this.revisionOf(active)) &&
        result.value.kind === 'metadata-recovery' &&
        !signal.aborted
      ) {
        const value = result.value;
        progress = value.status === 'pending' && value.readBytes > 0;
        const previous = this.titles.get(active.file);
        if (previous && value.status !== 'pending') {
          this.metadataRecoverySession = null;
          const recovered = value.read ? sessionOutcomeOf(value.read) : null;
          const sameTurn = previous.outcome && recovered && previous.outcome.startedAt === recovered.startedAt;
          let next =
            value.status === 'complete' && value.read
              ? carryDerivedTitleFacts(
                  previous,
                  {
                    ...previous,
                    stats: sessionStatFactsOf(value.read),
                    outcome: outcomeWithWiderChildren(
                      sameTurn ? previous.outcome : recovered,
                      null,
                      recovered,
                      sameTurn ? previous.backgroundCommands : undefined,
                    ),
                    expandedStatsRead: true,
                    metadataWindow: {
                      whole: true,
                      windowBytes: previous.metadataWindow?.windowBytes ?? RAIL_ENRICHMENT_READ_BYTES,
                    },
                    sourceIdentity: result.revision
                      ? { dev: result.revision.dev, ino: result.revision.ino }
                      : previous.sourceIdentity,
                  },
                  active,
                )
              : {
                  ...previous,
                  metadataWindow: {
                    whole: false,
                    windowBytes: previous.metadataWindow?.windowBytes ?? RAIL_ENRICHMENT_READ_BYTES,
                    exhausted: true,
                  },
                };
          next = this.observeStoredName(active, next);
          if (JSON.stringify(previous) !== JSON.stringify(next)) {
            this.storeTitleEntry(active.file, next);
            this.derivedCacheCheckpointState.markChanged();
            changed = true;
          }
        }
      } else {
        if (!result) this.failSessionLoading(generation, signal);
        this.metadataRecoverySession = null;
        this.metadataRecoveryQueue.push(active.sessionId);
        if (result && result.generation === generation && result.value.kind === 'stale') catalogCurrent = false;
      }
    }
    return { changed, catalogCurrent, progress };
  }

  private sessionLoadingState(sessions: SessionFile[], generation: number) {
    const failed =
      this.startupFailureGeneration === generation ||
      sessions.some((session) => this.metaFor(session).metadataWindow?.exhausted === true);
    return {
      generation,
      complete:
        !failed &&
        this.authoritativeCatalog !== null &&
        !this.dispatchDiscoveryPending &&
        sessions.every((session) => {
          const entry = this.metaFor(session);
          return (
            sameSessionRevision(entry, session) &&
            entry.foldedLabel !== undefined &&
            entry.starts !== undefined &&
            !railEnrichmentNeeds(entry, session)
          );
        }),
      ...(failed ? { failed: true } : {}),
    };
  }

  private postSessionLoading(sessions: SessionFile[], generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.refreshGeneration) return;
    const state = this.sessionLoadingState(sessions, generation);
    const key = JSON.stringify(state);
    if (key === this.startupLoadingSent) return;
    this.startupLoadingSent = key;
    void this.post({
      type: 'startupProgress',
      ...state,
      epoch: String(generation),
      sequence: (this.startupProgressSequence = (this.startupProgressSequence ?? 0) + 1),
      completed: 0,
      known: 0,
    }).catch(() => {});
  }

  private failSessionLoading(generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.refreshGeneration) return;
    this.startupFailureGeneration = generation;
    this.postSessionLoading(this.authoritativeCatalog ?? [], generation, signal);
  }

  // The name the rail card, the session heading, and search draw for a session. A Claude session
  // reads the held name, else the name its stored metadata holds before that metadata has
  // reported. A Codex session is named by its thread-name file, else its metadata. Either
  // agent then falls back to the name a derived cache version bump carried, and only then to
  // a placeholder built from the id.
  private sessionLabel(session: SessionFile): { label: string; fullLabel: string } {
    const carried = this.carriedNames.get(session.file);
    if (session.agent === 'claude') {
      const name = this.claudeName(session);
      return !name?.label && carried
        ? { label: carried.label, fullLabel: carried.fullLabel || carried.label }
        : sessionLabelOf(name, session.sessionId);
    }
    const title = this.titleFor(session);
    if (!title && carried) {
      return { label: carried.label, fullLabel: carried.fullLabel || carried.label };
    }
    const label = title || `Session ${session.sessionId.slice(0, 8)}`;
    return { label, fullLabel: this.fullTitleFor(session) || label };
  }

  // Each session another session started, and that session, built once per worker hand-off of
  // references and child files, and once per Codex listing. The heading names the parent. A
  // dispatched child also counts in the parent's lifetime cost, and files under Run by agents
  // unless the reader owns it.
  private sessionParentsOf(): ReadonlyMap<string, SessionParentEdge> {
    const references = this.claudeChildReferences;
    const children = this.claudeChildren;
    const codex = this.codexSubagents;
    const held = this.sessionParents;
    if (held && held.references === references && held.children === children && held.codex === codex) {
      return held.parents;
    }
    const parents = sessionParentIndex(references ?? [], children ?? [], codex ?? []);
    this.sessionParents = { references, children, codex, parents };
    return parents;
  }

  // The parent edges whose child and parent both have a row among `sessions`, their dispatched
  // part, and their refresh key. The heading and the refresh key read the edges, so no edge
  // moves one without the other. The Run by agents filing and the parent's lifetime cost read
  // the dispatched edges, and never a subagent edge: a subagent's transcript already files it
  // as a run, and its file already counts in its parent's delegated work. A session a subagent
  // dispatched still reaches the subagent's own parent, through the Claude child list the spend
  // sources climb.
  private sessionParentEdges(sessions: readonly SessionFile[]): SessionParentEdgeSet {
    this.sessionParentEdgeSet = sessionParentEdgeSet(this.sessionParentEdgeSet, this.sessionParentsOf(), sessions);
    return this.sessionParentEdgeSet;
  }

  // The reader-started or delegated parent of `session`, from current catalog titles.
  private parentOfShown(session: string | null): SessionParent | undefined {
    const parentId = session ? this.saved.readerParents?.[session] : undefined;
    if (parentId) {
      const parent = this.sessionRows.find((row) => row.id === parentId);
      return parent ? { id: parent.id, label: parent.label, relation: 'reader' } : undefined;
    }
    const held = this.sessionParentEdgeSet;
    return held ? sessionParentOf(this.sessionRows, held.edges, session) : undefined;
  }

  // The dispatched edges among `sessions`, as child id to parent id.
  private dispatchEdges(sessions: readonly SessionFile[]): ReadonlyMap<string, string> {
    return this.sessionParentEdges(sessions).dispatched;
  }

  private claudeName(session: SessionFile): SessionName | null {
    return this.sessionNames.get(session.sessionId) ?? storedSessionName(this.metaFor(session));
  }

  // A metadata read of a Claude session arrived, or a stored one was kept for the current
  // revision. Its name reports to the held names once, with the file it came from. When the
  // panel already holds a higher name for this transcript, as when parsed turns raised it
  // before any entry existed, the answered entry stores that name so a restart draws it.
  private observeStoredName(session: SessionFile, entry: DerivedTitleEntry): DerivedTitleEntry {
    if (session.agent !== 'claude') {
      return entry;
    }
    // The size is the entry's own, which the worker measured when it read. The file number
    // rides on the catalog row, from the stat that listed it, so reporting a session the
    // cache already answered opens nothing on this thread.
    this.sessionNames.observe(
      session.sessionId,
      storedSessionName(entry),
      transcriptIdentity({ size: entry.size, ino: session.ino }, entry.headKey),
    );
    const held = this.sessionNames.get(session.sessionId);
    return held ? withSessionName(entry, held) : entry;
  }

  // Report a stored entry's name and keep the entry the held name leaves behind.
  private observeStoredEntry(session: SessionFile, entry: DerivedTitleEntry): void {
    const next = this.observeStoredName(session, entry);
    if (next === entry) {
      return;
    }
    this.storeTitleEntry(session.file, next);
    this.derivedCacheCheckpointState.markChanged();
  }

  // The parsed turns of one refresh report their Claude session names once, each with the
  // transcript it was read from. A parse names that transcript by the file number the catalog
  // walk already took, and reports no size. It read a window of records, not the end of the
  // file, and the size the walk listed is older than the one a metadata read measures for
  // itself, which would read as a transcript that shrank. A row with no number reports no
  // identity rather than a size that says nothing about which file it is.
  private observeParsedNames(turns: readonly Turn[], byId: ReadonlyMap<string, SessionFile>): void {
    this.storeSessionNames(
      this.sessionNames.observeTurns(
        turns.filter((turn) => turn.agent === 'claude'),
        (sessionId) => {
          const ino = byId.get(sessionId)?.ino;
          return ino ? transcriptIdentity({ ino }) : undefined;
        },
      ),
      (sessionId) => byId.get(sessionId),
    );
  }

  // The name a card and its session heading carry. A Codex name comes from the thread-name
  // index first, which a rename rereads, and otherwise from the name its turns' read was given.
  private headingTitle(
    sessionId: string,
    byId: ReadonlyMap<string, SessionFile>,
    codexTitles: ReadonlyMap<string, string>,
  ): string {
    const session = byId.get(sessionId);
    if (session?.agent === 'claude') {
      return this.sessionLabel(session).label;
    }
    return (
      this.threadNames.names.get(sessionId) ||
      codexTitles.get(sessionId) ||
      (session ? this.sessionLabel(session) : sessionLabelOf(this.sessionNames.get(sessionId), sessionId)).label
    );
  }

  // Parsed turns raised some held names. The derived cache stores each one, so a restart
  // starts from the name the panel last drew.
  private storeSessionNames(changed: Iterable<string>, fileOf: (sessionId: string) => SessionFile | undefined): void {
    for (const sessionId of changed) {
      const session = fileOf(sessionId);
      const name = this.sessionNames.get(sessionId);
      const entry = session && this.titles.get(session.file);
      if (!session || !name || !entry) {
        continue;
      }
      const next = withSessionName(entry, name);
      if (next === entry) {
        continue;
      }
      this.storeTitleEntry(session.file, next);
      this.derivedCacheCheckpointState.markChanged();
    }
  }

  private titleFor(session: SessionFile | undefined): string | null {
    if (!session) {
      return null;
    }
    const fromFile = this.metaFor(session).label || null;
    if (session.agent !== 'codex') {
      return fromFile;
    }
    return codexTitleFor(this.threadNames.names, session.sessionId, fromFile);
  }

  private fullTitleFor(session: SessionFile | undefined): string | null {
    if (!session) {
      return null;
    }
    const fromFile = this.metaFor(session).fullLabel || null;
    if (session.agent !== 'codex') {
      return fromFile;
    }
    return this.threadNames.fullNames.get(session.sessionId) || fromFile;
  }

  // When a session was last active, as it recorded it rather than as the filesystem
  // saw it. An agent appends bookkeeping after the session has stopped, and taking
  // the mtime made closing a session send it to the top of the rail reading `less than a
  // minute ago` with nothing in it changed.
  //
  // A session whose window records no time at all falls back to its mtime, which is what
  // every session did before. That can only rank such a session too high, never too low:
  // a touched file's mtime is at or after the last activity it holds.
  private activityFor(session: SessionFile): number {
    return this.metaFor(session).activityMs ?? session.mtimeMs;
  }

  // Whether a session was run by another agent rather than had by the reader. The
  // rule and its limits are `agentRunIn` in transcript.ts; this is where the answer is
  // cached alongside the name and the activity it was read with, and where this window's
  // own record of starting a session overrides it. `agentRunAnswer` in turnrail.ts
  // carries that rule, including the child-transcript case: the parent's `Agent` call
  // is the positive fact, and it outranks the cached reading and any stale scan on it.
  //
  // The override sits here rather than in `metaFor`, so the cached fact stays the reading
  // of the transcript and the derived cache keeps answering for every window.
  //
  // `edges` is the edge set of `sessionParentEdges` over the listed sessions, the set the
  // refresh key carries, so a reference the key leaves out cannot move a card. A dispatched
  // session is the reader's when its launch recorded that the reader asked for it, or when a
  // person spoke in its transcript, which the worker reads with the child's other figures.
  private agentRunFor(session: SessionFile, edges: ReadonlyMap<string, SessionParentEdge>): boolean {
    const edge = edges.get(session.sessionId);
    const dispatched = edge?.relation === 'dispatched';
    return agentRunAnswer(
      this.metaFor(session).agentRun,
      session.sessionId,
      this.startedHere,
      session.childTranscript === true,
      dispatched,
      dispatched && (edge.owned === true || this.dispatchFacts.get(session.sessionId)?.person === true),
    );
  }

  // The tail outcome with the open children the lifetime facts and the parsed window hold.
  // The parsed window is the read already in memory, so this reads no file.
  private outcomesFor(sessions: readonly SessionFile[]): Map<string, TurnOutcome | null> {
    const lifetime = this.lifetimeRailFacts();
    return new Map(
      sessions.map((session) => {
        const parsed = this.cache.get(session.file)?.read;
        const meta = this.metaFor(session);
        return [
          session.sessionId,
          outcomeWithWiderChildren(
            meta.outcome ?? null,
            lifetime[session.sessionId]?.outcome ?? null,
            parsed ? sessionOutcomeOf(parsed) : null,
            meta.backgroundCommands,
          ),
        ];
      }),
    );
  }

  // Held per session against the same key as the lifetime figures. A session's rail facts read
  // only its own primary record.
  private lifetimeRailFacts(): Readonly<Record<string, SessionRailFacts>> {
    return this.lifetimeRail.read(
      this.lifetimeDisplayFiles(),
      this.sessionSpendSources,
      (sessionId, files, sources) =>
        sessionRailFactsBySession(Object.fromEntries(files.map((record) => [record.file, record])), sources)[sessionId],
      (facts) => Object.fromEntries(facts),
    );
  }

  private readFor(session: SessionFile, maxTurns: number, _tailBytes: number): WindowRead {
    const hit = this.cache.get(session.file);
    if (!hit) {
      throw new Error('Session data is not ready.');
    }
    const turns = this.commitRepositoryTurns(session, hit.read.turns);
    this.applyCommitRepositoryEvidence(session, turns);
    this.repositoryCommits.apply(turns, this.folders());
    return { read: hit.read, maxTurns: Math.max(maxTurns, hit.read.turns.length), revision: hit.revision };
  }

  private commitRepositoryTurns(session: SessionFile, turns: Turn[]): Turn[] {
    return [
      ...turns,
      ...historyRecordsOutside(this.history?.get(session.sessionId)?.pages ?? [], { turns, compactions: [] }).turns,
    ];
  }

  private commitRepositoryContexts(
    session: SessionFile,
    turns: Turn[],
  ): Array<{
    parent: CommitRepositorySource;
    child: CommitRepositorySource;
    commits: import('./transcript').TurnCommit[];
    key: string;
    wanted: CommitRepositoryRequest['commits'];
  }> {
    turns = this.commitRepositoryTurns(session, turns);
    if (
      session.agent !== 'codex' ||
      !turns.some((turn) =>
        [...(turn.commits ?? []), ...(turn.agents ?? []).flatMap((agent) => agent.commits ?? [])].some(
          (commit) => commit.repositoryEvidence,
        ),
      )
    )
      return [];
    const owners: Array<{
      parent: SessionFile;
      child: CodexSubagentFile;
      commits: import('./transcript').TurnCommit[];
    }> = [];
    const own = this.codexSubagents.find((child) => child.threadId === session.sessionId);
    if (own?.parentThreadId) {
      const parent = this.allSessions(true).find((one) => one.sessionId === own.parentThreadId);
      if (parent) owners.push({ parent, child: own, commits: turns.flatMap((turn) => turn.commits) });
    }
    for (const turn of turns)
      for (const agent of turn.agents ?? []) {
        const child = codexSubagentFor(this.codexSubagents, session.sessionId, {
          id: agent.id,
          name: agent.description,
          path: agent.agentType,
          status: agent.status,
        });
        if (child?.parentThreadId === session.sessionId && agent.commits?.length)
          owners.push({ parent: session, child, commits: agent.commits });
      }
    const grouped = new Map<string, (typeof owners)[number]>();
    for (const owner of owners) {
      const held = grouped.get(owner.child.file);
      if (held) held.commits.push(...owner.commits);
      else grouped.set(owner.child.file, { ...owner, commits: [...owner.commits] });
    }
    const index = codexSpendIndex(this.codexSubagents);
    return [...grouped.values()].flatMap((owner) => {
      if (!index.verified(owner.child)) return [];
      const commits = owner.commits.filter((commit) => commit.repositoryEvidence?.complete && commit.printedSha);
      if (!commits.length) return [];
      const parent = {
        file: owner.parent.file,
        sessionId: owner.parent.sessionId,
        revision: this.revisionOf(owner.parent),
      };
      const child = {
        file: owner.child.file,
        sessionId: owner.child.threadId,
        revision: this.revisionOf({ ...session, file: owner.child.file }),
      };
      const wanted = commits.map((commit) => ({
        sha: commit.printedSha!,
        at: commit.at,
        evidenceAt: commit.repositoryEvidence!.at,
        dirs: commit.repositoryEvidence!.dirs,
        turnId: commit.repositoryEvidence!.turnId,
      }));
      const key = JSON.stringify([
        commitRepositorySourceKey(parent),
        commitRepositorySourceKey(child),
        owner.child.parentThreadId,
        COMMIT_REPOSITORY_PARSER_VERSION,
        wanted,
      ]);
      return [{ parent, child, commits, key, wanted }];
    });
  }

  private applyCommitRepositoryEvidence(session: SessionFile, turns: Turn[]): void {
    turns = this.commitRepositoryTurns(session, turns);
    for (const turn of turns)
      for (const commit of [...(turn.commits ?? []), ...(turn.agents ?? []).flatMap((agent) => agent.commits ?? [])]) {
        if (!commit.repositoryEvidence) continue;
        commit.candidates = { dirs: commit.repositoryEvidence.dirs, complete: false };
        commit.dir = null;
        commit.place = null;
        commit.repository = null;
      }
    for (const context of this.commitRepositoryContexts(session, turns)) {
      const held = this.commitRepositoryReplies.get(context.child.file);
      if (held?.key !== context.key || held.reply.status !== 'complete') continue;
      for (const [index, commit] of context.commits.entries()) {
        const target = held.reply.targets.find(
          (target) =>
            target.sha === commit.printedSha && target.occurrence === commitRepositoryOccurrence(context.wanted[index]),
        );
        if (target) commit.candidates = { dirs: target.dirs, complete: true };
      }
    }
  }

  private async hydrateCommitRepositories(
    session: SessionFile,
    turns: Turn[],
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const context of this.commitRepositoryContexts(session, turns)) {
      const held = this.commitRepositoryReplies.get(context.child.file);
      if (held?.key === context.key && held.reply.status !== 'pending') continue;
      const allowance = this.commitRepositoryReservations.reserve(context.parent, context.child);
      const request = {
        kind: 'commit-repositories' as const,
        parent: context.parent,
        child: context.child,
        commits: context.wanted,
        ...allowance,
        token: held?.key === context.key ? held.reply.token : null,
        parserVersion: COMMIT_REPOSITORY_PARSER_VERSION,
      };
      const result = await this.progressiveWorker.run(request, generation, signal);
      if (signal.aborted) return false;
      if (!result) return allowance.parentBytes > 0 && allowance.childBytes > 0;
      if (result.generation !== generation || result.value.kind !== 'commit-repositories') return false;
      const reply = result.value;
      const current = this.commitRepositoryContexts(session, turns).find(
        (one) => one.child.file === context.child.file,
      );
      if (
        current?.key !== context.key ||
        commitRepositorySourceKey(reply.parent) !== commitRepositorySourceKey(context.parent) ||
        commitRepositorySourceKey(reply.child) !== commitRepositorySourceKey(context.child) ||
        reply.parserVersion !== COMMIT_REPOSITORY_PARSER_VERSION ||
        reply.status === 'cancelled'
      )
        return false;
      if (
        reply.readBytes.parent < 0 ||
        reply.readBytes.parent > allowance.parentBytes ||
        reply.readBytes.child < 0 ||
        reply.readBytes.child > allowance.childBytes
      )
        return false;
      if (
        reply.status === 'complete' &&
        (reply.covered.parent[0] !== 0 ||
          reply.covered.parent[1] !== context.parent.revision.size ||
          reply.covered.child[0] !== 0 ||
          reply.covered.child[1] !== context.child.revision.size)
      )
        return false;
      this.commitRepositoryReplies.set(context.child.file, { key: context.key, reply });
      if (reply.status === 'pending') return true;
    }
    this.applyCommitRepositoryEvidence(session, turns);
    return false;
  }

  // `spendNow` is the clock reading of a key the host stores for this trip's child spend.
  private progressiveInput(session: SessionFile, spendNow?: number): ProgressiveInput {
    return {
      session,
      folders: this.folders(),
      ...selectedDependencies(
        session.sessionId,
        this.codexSubagents ?? [],
        this.claudeChildren ?? [],
        this.claudeChildReferences ?? [],
      ),
      maxTurns: TRANSCRIPT_TURN_LIMIT,
      tailBytes: TRANSCRIPT_TAIL_BYTES,
      ...(spendNow === undefined ? {} : { spendNow }),
    };
  }

  private progressiveCurrent(session: SessionFile): boolean {
    const entry = this.cache.get(session.file);
    return Boolean(
      entry &&
      entry.key === transcriptReadCacheKey(session, TRANSCRIPT_TURN_LIMIT, TRANSCRIPT_TAIL_BYTES, this.folders()) &&
      entry.structuralKey === this.structuralKey(session),
    );
  }

  // Cost figures come from child transcripts, which grow while the parent's turns stay the
  // same. A stale answer here starts a refresh of those figures and never shows the loading row.
  private agentFactsCurrent(session: SessionFile): boolean {
    const structuralKey = this.structuralKey(session);
    const entry = this.cache.get(session.file);
    if (entry && entry.agentKey !== this.agentSpendKey(session, entry.read, structuralKey)) {
      return false;
    }
    const pages = this.history.get(session.sessionId)?.pages;
    return (
      !pages?.length ||
      this.historyStructuralKeys.get(session.sessionId) === this.historyAgentKey(session, pages, structuralKey)
    );
  }

  private historyAgentKey(
    session: SessionFile,
    pages: readonly { turns: readonly Turn[] }[],
    structuralKey = this.structuralKey(session),
    versions?: Map<string, string>,
    now = Date.now(),
  ): string {
    return this.agentSpendKey(session, { turns: pages.flatMap((page) => page.turns) }, structuralKey, versions, now);
  }

  // Reapply child spend to the cached tail without reading the parent transcript again. The
  // key moves even when the worker gives no answer, so a failed refresh waits for the next
  // child write instead of repeating at once. A parent write makes the read stale on its own.
  private async refreshAgentFacts(
    session: SessionFile,
    entry: CacheEntry,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    // One reading of each child revision, taken before the round trip, for both keys below.
    // A child that writes while the trip runs leaves the key stale, so its cost figures move
    // on the next poll instead of waiting for the parent file.
    // One clock reading too, so the worker and both keys agree on which running child is quiet.
    const versions = new Map<string, string>();
    const now = Date.now();
    const agentKey = this.agentSpendKey(session, entry.read, undefined, versions, now);
    const updated = await this.progressiveWorker.run(
      {
        kind: 'retained',
        input: this.progressiveInput(session, now),
        pages: [{ turns: entry.read.turns, compactions: [], bytes: 0 }],
        structuralAgentIds: entry.structuralAgentIds,
      },
      generation,
      signal,
    );
    if (signal.aborted || this.cache.get(session.file) !== entry) {
      return false;
    }
    entry.agentKey = agentKey;
    if (
      !updated ||
      updated.value.kind !== 'retained' ||
      !updated.value.pages[0] ||
      !acceptsProgressiveResult(updated, generation, this.revisionOf(session))
    ) {
      return false;
    }
    entry.read = { ...entry.read, turns: updated.value.pages[0].turns };
    // The stored turns answer the key from here on. A child that finished during the round
    // trip changes what those turns name, and a key over the turns the trip replaced never
    // matches again, so every poll would enter this worker round trip a second time.
    entry.agentKey = this.agentSpendKey(session, entry.read, undefined, versions, now);
    return true;
  }

  private currentSelectedSession(work: {
    sessionId: string;
    generation: number;
    controller: AbortController;
    host?: PanelHost;
    scope?: string;
    source?: SelectedSource;
  }): SessionFile | null {
    if (
      work.controller.signal.aborted ||
      (this.selectionWorks?.get(work.sessionId) ?? this.selectionWork) !== work ||
      (!work.host && (this.selectionGeneration !== work.generation || this.showing !== work.sessionId)) ||
      (work.host !== undefined &&
        (!this.hosts.includes(work.host) || (this.hostSessions?.get(work.host) ?? this.showing) !== work.sessionId)) ||
      (work.scope !== undefined && work.scope !== JSON.stringify([this.folders(), this.repositoryScopeRoots])) ||
      !this.anyVisible()
    ) {
      return null;
    }
    const session =
      this.authoritativeCatalog?.find((candidate) => candidate.sessionId === work.sessionId) ?? work.source;
    if (!session) return null;
    let revision: FileRevision;
    try {
      revision = this.revisionOf(session);
    } catch {
      return null;
    }
    if (revision.size < 0 || (work.source && (work.source.ino !== revision.ino || work.source.dev !== revision.dev)))
      return null;
    return { ...session, ...revision };
  }

  private async completeSelectedWindow(sessionId: string, generation: number): Promise<void> {
    const held = this.selectionWorks?.get(sessionId) ?? this.selectionWork;
    if (held && held.sessionId === sessionId && held.generation === generation && !held.controller.signal.aborted) {
      return;
    }
    if (held?.sessionId === sessionId || !held?.host) held?.controller.abort();
    const controller = new AbortController();
    const host = this.hosts?.find((host) => (this.hostSessions?.get(host) ?? this.showing) === sessionId);
    const work: SelectionWork = {
      sessionId,
      generation,
      controller,
      host,
      scope: this.repositoryScopeRoots ? JSON.stringify([this.folders(), this.repositoryScopeRoots]) : undefined,
    };
    this.selectionWork = work;
    this.selectionWorks?.set(sessionId, work);
    let retryLatestRevision = false;
    const deadline = setTimeout(() => {
      if ((this.selectionWorks?.get(sessionId) ?? this.selectionWork) !== work) return;
      this.selectionWorks?.delete(sessionId);
      if (this.selectionWork === work) this.selectionWork = null;
      controller.abort();
      const owned = () =>
        (work.host || (this.selectionGeneration === generation && this.showing === sessionId)) &&
        this.anyVisible() &&
        (!work.host ||
          (this.hosts.includes(work.host) && (this.hostSessions?.get(work.host) ?? this.showing) === sessionId)) &&
        (work.scope === undefined || work.scope === JSON.stringify([this.folders(), this.repositoryScopeRoots]));
      if (owned()) {
        queueMicrotask(() => {
          if (owned()) void this.completeSelectedWindow(sessionId, generation);
        });
      }
    }, 5_000);
    // Set when a worker round trip below runs. Without a trip, a render already shows the window
    // the cached return finds. `show` draws just before its call, a catalog refresh draws just
    // after, and a retry finds a window that its store drew: the accepted read below and
    // `prepareProgressive` each refresh after they store. Only a trip can change that render.
    let roundTrip = false;
    try {
      let session = this.currentSelectedSession(work);
      if (!session && (work.host || (this.showing === sessionId && this.selectionGeneration === generation))) {
        const scope = this.repositoryScope?.snapshot(this.folders());
        if (!scope?.ready) return;
        this.repositoryScopeReady = true;
        this.repositoryScopeRoots = scope.roots;
        work.scope = JSON.stringify([this.folders(), this.repositoryScopeRoots]);
        const source = await resolveSelectedSource(
          sessionId,
          scope.roots,
          projectsRoot(),
          codexSessionsRoot(),
          controller.signal,
        );
        if (!source) return;
        work.source = source;
        session = this.currentSelectedSession(work);
        if (!session) return;
        this.earlySelectedSources.set(sessionId, source);
      }
      if (!session) return;
      const history = this.history.get(sessionId);
      const historyVersions = new Map<string, string>();
      const historyNow = Date.now();
      const historyKey = history?.pages.length
        ? this.historyAgentKey(session, history.pages, undefined, historyVersions, historyNow)
        : '';
      if (history?.pages.length && this.historyStructuralKeys.get(sessionId) !== historyKey) {
        const retainedRevision = this.revisionOf(session);
        roundTrip = true;
        const updated = await this.progressiveWorker.run(
          {
            kind: 'retained',
            input: this.progressiveInput(session, historyNow),
            pages: history.pages,
          },
          generation,
          controller.signal,
        );
        const current = this.currentSelectedSession(work);
        if (!current) {
          return;
        }
        const currentRevision = this.revisionOf(current);
        const grewDuringRetainedRead = Boolean(
          updated &&
          updated.generation === generation &&
          updated.value.kind === 'stale' &&
          currentRevision.size > retainedRevision.size &&
          onlyGrew(retainedRevision, currentRevision),
        );
        if (grewDuringRetainedRead) {
          retryLatestRevision = true;
        }
        if (
          !updated ||
          updated.value.kind !== 'retained' ||
          !acceptsProgressiveResult(updated, generation, currentRevision)
        ) {
          if (!grewDuringRetainedRead) {
            this.dropOlderHistory(sessionId);
          }
        } else if (this.history.get(sessionId) === history) {
          this.history.set(sessionId, { ...history, pages: updated.value.pages });
          // The refresh rewrites these turns, so a key over the pages sent never matches the
          // pages kept. Name the pages stored here, with the revisions read before the trip.
          this.historyStructuralKeys.set(
            sessionId,
            this.historyAgentKey(current, updated.value.pages, undefined, historyVersions, historyNow),
          );
        }
        session = current;
      }
      const cached = this.cache.get(session.file);
      if (cached && this.progressiveCurrent(session)) {
        cached.usedAt = Date.now();
        if (cached.agentKey !== this.agentSpendKey(session, cached.read)) {
          roundTrip = true;
          await this.refreshAgentFacts(session, cached, generation, controller.signal);
          // The parent can write while this round trip runs, and that write reaches the rail
          // through the metadata cache. Ask again, and read the window when the retained
          // answer is now behind the file, so both places say the same thing.
          const refreshed = this.currentSelectedSession(work);
          if (!refreshed) {
            return;
          }
          session = refreshed;
        }
      }
      const previous = this.cache.get(session.file);
      if (previous && this.progressiveCurrent(session)) {
        roundTrip ||= this.commitRepositoryContexts(session, previous.read.turns).some((context) => {
          const held = this.commitRepositoryReplies.get(context.child.file);
          return held?.key !== context.key || held.reply.status === 'pending';
        });
        retryLatestRevision ||= await this.hydrateCommitRepositories(
          session,
          previous.read.turns,
          generation,
          controller.signal,
        );
      }
      const requestedRevision = this.revisionOf(session);
      if (
        this.progressiveCurrent(session) &&
        (previous?.checkpoint as ClaudeForwardCheckpoint | undefined)?.attachmentRecovery?.status !== 'pending'
      ) {
        this.acceptSelectedMetadataRead(session, generation);
        // A render of this retained window exists already, as `roundTrip` says. Another
        // selected-only refresh would draw the same window again, so refresh only
        // for what a worker trip or a cleared failure changed. A stale failure that is no longer
        // on screen costs one refresh that draws nothing new.
        const failureDrawn = this.selectionFailure !== null;
        this.selectionFailure = null;
        if (roundTrip || failureDrawn) {
          void this.refresh(true, true, true, true);
        }
        return;
      }
      const checkpointCompatible =
        previous &&
        (sameProgressiveRevision(previous.revision, requestedRevision) ||
          (requestedRevision.size > previous.revision.size && onlyGrew(previous.revision, requestedRevision)));
      const result = await this.progressiveWorker.run(
        {
          kind: 'window',
          input: this.progressiveInput(session),
          checkpoint: checkpointCompatible ? previous.checkpoint : undefined,
        },
        generation,
        controller.signal,
      );
      if (work.source && !(await validateSelectedSource(work.source, this.repositoryScopeRoots, controller.signal))) {
        if (this.earlySelectedSources.get(sessionId) === work.source) this.earlySelectedSources.delete(sessionId);
        return;
      }
      const current = this.currentSelectedSession(work);
      if (!current) {
        return;
      }
      const currentRevision = this.revisionOf(current);
      if (
        !result ||
        result.value.kind !== 'window' ||
        !result.revision ||
        !acceptsProgressiveResult(result, generation, currentRevision)
      ) {
        retryLatestRevision = Boolean(
          result &&
          result.revision &&
          (result.value.kind === 'stale' || result.value.kind === 'window') &&
          result.generation === generation &&
          !controller.signal.aborted &&
          (!sameProgressiveRevision(result.revision, requestedRevision) ||
            !sameProgressiveRevision(result.revision, currentRevision)),
        );
        if (retryLatestRevision) {
          return;
        }
        this.selectionFailure = { sessionId, generation, revision: currentRevision };
        void this.refresh(true, true, true, true);
        return;
      }
      this.updateHistoryAfterAcceptedWindow(sessionId, previous, result, true);
      this.acceptSelectedMetadataRead(current, generation);
      this.cache.set(current.file, {
        key: transcriptReadCacheKey(current, TRANSCRIPT_TURN_LIMIT, TRANSCRIPT_TAIL_BYTES, this.folders()),
        agentKey: result.value.agentKey,
        structuralKey: result.value.structuralKey,
        structuralAgentIds: result.value.structuralAgentIds,
        revision: { ...result.revision },
        read: result.value.read,
        checkpoint: result.value.checkpoint,
        usedAt: Date.now(),
        bytes: result.value.retainedBytes,
        checkpointBytes: result.value.checkpointBytes,
      });
      this.selectionFailure = null;
      retryLatestRevision ||= result.value.recoveryPending === true;
      retryLatestRevision ||= await this.hydrateCommitRepositories(
        session,
        result.value.read.turns,
        generation,
        controller.signal,
      );
      void this.refresh(true, true, true, true);
    } catch {
      const current = this.currentSelectedSession(work);
      if (current) {
        this.selectionFailure = { sessionId, generation, revision: this.revisionOf(current) };
        void this.refresh(true, true, true, true);
      }
    } finally {
      clearTimeout(deadline);
      if (this.selectionWorks?.get(sessionId) === work) this.selectionWorks.delete(sessionId);
      if (this.selectionWork === work) {
        this.selectionWork = null;
      }
      if (
        retryLatestRevision &&
        !controller.signal.aborted &&
        (work.host
          ? this.hostSessions?.get(work.host) === sessionId
          : this.selectionGeneration === generation && this.showing === sessionId) &&
        this.anyVisible()
      ) {
        queueMicrotask(() => {
          if (
            (work.host
              ? this.hostSessions?.get(work.host) === sessionId
              : this.selectionGeneration === generation && this.showing === sessionId) &&
            this.anyVisible()
          ) {
            void this.completeSelectedWindow(sessionId, generation);
          }
        });
      }
    }
  }

  private async prepareProgressive(sessions: SessionFile[], generation: number, signal: AbortSignal): Promise<boolean> {
    let changed = false;
    const ordered = [...sessions].sort(
      (a, b) => Number(b.sessionId === this.showing) - Number(a.sessionId === this.showing),
    );
    for (const session of ordered) {
      if (
        this.earlySelectedSources?.has(session.sessionId) &&
        !this.authoritativeCatalog?.some((source) => source.sessionId === session.sessionId)
      )
        continue;
      if (signal.aborted) {
        return false;
      }
      const selectedFailure =
        this.selectionFailure?.sessionId === session.sessionId &&
        this.selectionFailure.generation === this.selectionGeneration &&
        sameProgressiveRevision(this.selectionFailure.revision, this.revisionOf(session));
      if (this.selectionFailure?.sessionId === session.sessionId && !selectedFailure) {
        this.selectionFailure = null;
      }
      if (session.sessionId === this.showing) {
        continue;
      }
      const history = this.history.get(session.sessionId);
      const historyNow = Date.now();
      const historyKey = history?.pages.length
        ? this.historyAgentKey(session, history.pages, undefined, undefined, historyNow)
        : '';
      if (history?.pages.length && this.historyStructuralKeys.get(session.sessionId) !== historyKey) {
        const updated = await this.progressiveWorker.run(
          {
            kind: 'retained',
            input: this.progressiveInput(session, historyNow),
            pages: history.pages,
          },
          generation,
          signal,
        );
        if (
          !updated ||
          signal.aborted ||
          !acceptsProgressiveResult(updated, this.refreshGeneration, this.revisionOf(session))
        ) {
          return false;
        }
        if (updated.value.kind === 'retained' && this.history.get(session.sessionId) === history) {
          this.history.set(session.sessionId, { ...history, pages: updated.value.pages });
          this.historyStructuralKeys.set(session.sessionId, historyKey);
          changed = true;
        }
      }
      if (this.progressiveCurrent(session)) {
        const held = this.cache.get(session.file);
        if (held && session.sessionId === this.showing) {
          held.usedAt = Date.now();
        }
        if (
          held &&
          held.agentKey !== this.agentSpendKey(session, held.read) &&
          (await this.refreshAgentFacts(session, held, generation, signal))
        ) {
          changed = true;
        }
        if (signal.aborted) {
          return false;
        }
        continue;
      }
      const previous = this.cache.get(session.file);
      const result = await this.progressiveWorker.run(
        {
          kind: 'window',
          input: this.progressiveInput(session),
          checkpoint: previous?.checkpoint,
        },
        generation,
        signal,
      );
      if (
        !result ||
        signal.aborted ||
        !acceptsProgressiveResult(result, this.refreshGeneration, this.revisionOf(session))
      ) {
        return false;
      }
      if (result.value.kind !== 'window') {
        continue;
      }
      const revision = result.revision;
      if (!revision) {
        return false;
      }
      this.updateHistoryAfterAcceptedWindow(session.sessionId, previous, result, false);
      this.cache.set(session.file, {
        key: transcriptReadCacheKey(session, TRANSCRIPT_TURN_LIMIT, TRANSCRIPT_TAIL_BYTES, this.folders()),
        agentKey: result.value.agentKey,
        structuralKey: result.value.structuralKey,
        structuralAgentIds: result.value.structuralAgentIds,
        revision: { ...revision },
        read: result.value.read,
        checkpoint: result.value.checkpoint,
        usedAt: Date.now(),
        bytes: result.value.retainedBytes,
        checkpointBytes: result.value.checkpointBytes,
      });
      changed = true;
      if (session.sessionId === this.showing) {
        break;
      }
    }
    return changed;
  }

  // Answer the sentinel at the end of the list with one older page.
  //
  // One request is in flight at a time, whether the reader pressed the button or the page
  // came into view. A second reader of the same file would read the same bytes twice and
  // merge the same turns twice, and the panel asks again as soon as a page lands.
  //
  // The first request starts at the end of the file, so its first pages hold turns the
  // ordinary tail already lists. It keeps reading until a page carries a turn that is new,
  // which `historyPageReads` bounds. Every later request chains from the stored cursor and
  // reaches new turns on its first read.
  private async loadOlderHistory(sessionId: string): Promise<void> {
    if (this.historyRequest) {
      return;
    }
    const selected = () =>
      new Set([this.showing, ...this.hostSessions.values()].filter((held): held is string => held !== null));
    // A catalog walk during the cold pass would read on the main thread every opening record
    // the pass has not reached yet, so the press waits for the pass. It holds the request while
    // it waits, so a second press starts nothing, and the sentinel says it is loading at once.
    // A catalog refresh waits for the pass too, so the status goes out in a selection-only render.
    const priming = this.codexPriming;
    if (priming) {
      if (!selected().has(sessionId) || !this.readWindows.has(sessionId) || this.history.get(sessionId)?.atBeginning) {
        return;
      }
      const waiting = { sessionId, controller: new AbortController(), generation: ++this.historyGeneration };
      this.historyRequest = waiting;
      void this.refresh(true, true, true, true);
      await priming.catch(() => undefined);
      if (this.historyRequest !== waiting) {
        return;
      }
      this.historyRequest = null;
    }
    const session = this.allSessions(true).find((candidate) => candidate.sessionId === sessionId);
    const visible = selected();
    const window = this.readWindows.get(sessionId);
    if (
      !session ||
      !visible.has(sessionId) ||
      !window ||
      (this.history.get(sessionId) ?? startSessionHistory(session, 0)).atBeginning
    ) {
      // A press that waited takes back the loading status it sent.
      if (priming) {
        void this.refresh(true, true, true, true);
      }
      return;
    }
    const controller = new AbortController();
    const generation = ++this.historyGeneration;
    this.historyRequest = { sessionId, controller, generation };
    // The loading status reaches the panel before the first read starts, so the sentinel
    // says what it is doing instead of standing still under the reader. The catalog is
    // reused because this press changed no file.
    void this.refresh(true, true, true, true);
    const before = this.history.get(sessionId) ?? startSessionHistory<HistoryCursor>(session, Date.now());
    let metadataReadAccepted = false;
    try {
      const reads = historyPageReads(window.loadedTurns);
      for (let attempt = 0; attempt < reads; attempt++) {
        if (this.historyRequest?.generation !== generation) {
          return;
        }
        // Read from the provider each round rather than from a value held across the await.
        // A refresh runs while a page is being read, and it can rebase this session's
        // cursor onto an appended file or throw its pages away entirely.
        const held = this.history.get(sessionId) ?? startSessionHistory<HistoryCursor>(session, Date.now());
        if (held.atBeginning) {
          break;
        }
        const tail = this.cache.get(session.file)?.read ?? { turns: [], compactions: [] };
        const outcome = await this.readOlderHistoryPage(session, held.cursor, controller.signal);
        if (this.historyRequest?.generation !== generation) {
          return;
        }
        const current = this.history.get(sessionId) ?? held;
        const applied = afterHistoryPage(current, outcome, tail, Date.now());
        this.history.set(sessionId, applied.history);
        // A child listing can move while the page reader is yielding. Reproject every
        // page after admission so a page parsed against the earlier listing cannot stay stale.
        if (outcome.kind === 'page') {
          this.historyStructuralKeys.delete(sessionId);
          if (!metadataReadAccepted) {
            this.acceptExplicitMetadataRead(session);
            metadataReadAccepted = true;
          }
        }
        if (outcome.kind === 'stale' && staleCursorIsStuck(applied.history, this.revisionOf(session))) {
          this.dropOlderHistory(sessionId);
          break;
        }
        if (!historyRequestContinues(outcome, applied)) {
          break;
        }
      }
      // A page read can throw, and a request that ended in one would leave the sentinel
      // saying it was loading until the next poll repainted it.
    } catch {
      const held = this.history.get(sessionId) ?? before;
      this.history.set(
        sessionId,
        afterHistoryPage(held, { kind: 'failed' }, { turns: [], compactions: [] }, Date.now()).history,
      );
    } finally {
      if (this.historyRequest?.generation === generation) {
        this.historyRequest = null;
      }
    }
    const settled = this.history.get(sessionId);
    if (settled) {
      this.history.set(sessionId, afterHistoryRequest(settled, before));
    }
    void this.completeSelectedWindow(sessionId, this.selectionGeneration);
    void this.refresh(true, true, true, true);
  }

  // The transcript's size and write time as they are now, so a stale answer can be told from
  // a cursor that names a generation the file no longer has.
  private revisionOf(session: SessionFile): FileRevision {
    try {
      const stat = fs.statSync(session.file);
      return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    } catch {
      return { size: -1, mtimeMs: -1, dev: -1, ino: -1 };
    }
  }

  private acceptSelectedMetadataRead(session: SessionFile, generation: number): void {
    const intent = this.metadataReadIntent;
    if (intent?.sessionId !== session.sessionId || intent.generation !== generation) return;
    this.metadataReadIntent = null;
    this.acceptExplicitMetadataRead(session);
  }

  private acceptExplicitMetadataRead(session: SessionFile): void {
    const previous = this.titles.get(session.file);
    if (!previous?.metadataWindow?.exhausted) return;
    this.storeTitleEntry(
      session.file,
      withMetadataCoverage(previous, {
        whole: previous.metadataWindow.whole,
        windowBytes: previous.metadataWindow.windowBytes,
      }),
    );
    this.derivedCacheCheckpointState.markChanged();
  }

  // One page, read through the adapter that owns this transcript. The provider chooses the
  // adapter and keeps its cursor; it never reads a record itself.
  private async readOlderHistoryPage(
    session: SessionFile,
    cursor: HistoryCursor | null,
    signal: AbortSignal,
  ): Promise<HistoryPageOutcome<HistoryCursor>> {
    const generation = this.historyGeneration;
    const result = await this.progressiveWorker.run(
      {
        kind: 'page',
        input: this.progressiveInput(session),
        cursor,
      },
      generation,
      signal,
    );
    if (
      !result ||
      signal.aborted ||
      !acceptsProgressiveResult(result, this.historyGeneration, this.revisionOf(session))
    ) {
      return { kind: 'stale' };
    }
    return result.value.kind === 'page' ? result.value.page : { kind: 'stale' };
  }

  private agentFile(session: SessionFile, agent: AgentSpendRef): string | null {
    if (session.agent === 'claude') {
      return claudeChildReferenceFor(this.claudeChildReferences, session.sessionId, agent)?.file ?? null;
    }
    return codexSubagentFor(this.codexSubagents, session.sessionId, agent)?.file ?? null;
  }

  private codexStructuralChildren(session: SessionFile): CodexSubagentFile[] {
    return session.agent === 'codex'
      ? this.codexSubagents.filter((child) => child.parentThreadId === session.sessionId)
      : [];
  }

  // Like the Claude key below, this names each child relationship and leaves out the child
  // file revision. A Codex child appends to its own rollout while it runs, and a revision
  // here makes the parent's read stale on every append. `agentSpendKey` carries those
  // revisions, so the cost figures move and the turn card stays.
  private codexStructuralKey(session: SessionFile): string {
    return this.codexStructuralChildren(session)
      .map(
        (child) =>
          `${child.threadId}:${child.openedAt ?? ''}:${child.threadSource ?? ''}:${child.backgroundReview}:${child.file}`,
      )
      .sort()
      .join('\n');
  }

  // The version of one child's spend figure. A caller that must compare two keys over the same
  // files passes a map, and every file it already named keeps the version read the first time.
  private spendVersion(
    session: SessionFile,
    file: string,
    versions?: Map<string, string>,
    metas?: ClaudeSubagentMetaReader,
  ): string {
    const held = versions?.get(file);
    if (held !== undefined) {
      return held;
    }
    const version =
      session.agent === 'codex'
        ? codexAgentSpendVersion(file, codexSpendIndex(this.codexSubagents), undefined, undefined, session.file)
        : childSpendVersion(session.agent, file, metas);
    versions?.set(file, version);
    return version;
  }

  // The key names each child relationship and leaves out the child file revision. A child
  // appends to its own transcript many times a minute, and a revision here makes the parent's
  // read stale on every append. The recorded part of `agentSpendKey` carries the revision of
  // each finished child that the tail or a retained older page shows, and of every nested
  // subagent whose spend that child's figure includes. It carries the shared spend band of a
  // running child or recently writing Codex descendants, so their cost moves once a band. `agentFactsCurrent`
  // refreshes those cost figures without another read of the parent. `agentListingStamp`
  // carries every child revision for the spend sources.
  private claudeStructuralKey(session: SessionFile): string {
    return session.agent === 'claude'
      ? this.claudeChildReferences
          .flatMap((child) => (child.kind === 'dispatch' ? [] : [child]))
          .filter((child) => child.parentSessionId === session.sessionId)
          .map((child) => `${child.sessionId}:${[...child.toolUseIds].sort().join(',')}:${child.file}`)
          .concat(
            this.claudeChildren
              .filter((child) => child.parentSessionId === session.sessionId)
              .map((child) => `target:${child.sessionId}:${child.file}`),
          )
          .sort()
          .join('\n')
      : '';
  }

  private structuralKey(session: SessionFile): string {
    return session.agent === 'codex' ? this.codexStructuralKey(session) : this.claudeStructuralKey(session);
  }

  private agentSpendKey(
    session: SessionFile,
    read: { turns: readonly Turn[] },
    structuralKey = this.structuralKey(session),
    versions?: Map<string, string>,
    now = Date.now(),
  ): string {
    // The worker files the same key with each window, so the two agree until a child writes.
    const metas = claudeSubagentMetaReader();
    return agentSpendDependencyKey(
      read.turns,
      (ref) => this.agentFile(session, ref),
      (file) => this.spendVersion(session, file, versions, metas),
      structuralKey,
      this.codexStructuralChildren(session).map((child) => child.file),
      now,
    );
  }

  private agentListingStamp(sessions: SessionFile[]): string {
    return sessions
      .map((session) => {
        const hit = this.cache.get(session.file);
        return hit
          ? `${session.file}:${this.agentSpendKey(session, hit.read)}${this.claudeChildRevisions(session)}`
          : '';
      })
      .join('|');
  }

  private claudeChildRevisions(session: SessionFile): string {
    return session.agent === 'claude'
      ? this.claudeChildReferences
          .flatMap((child) => (child.kind === 'dispatch' ? [] : [child]))
          .filter((child) => child.parentSessionId === session.sessionId)
          .map((child) => `\n${child.file}:${this.claudeChildVersion(child.file)}`)
          .sort()
          .join('')
      : '';
  }

  // One child's revision, keeping its write time for `liveOpenChildren`.
  private claudeChildVersion(file: string): string {
    const version = spendFileVersion(file);
    const at = writeTimeOfVersion(version);
    if (at === null) {
      this.claudeChildStatWrites.delete(file);
    } else {
      this.claudeChildStatWrites.set(file, at);
    }
    return version;
  }

  // Bytes the `sessionCacheMiB` setting allows retained history to use.
  private sessionCacheBudgetBytes(): number {
    return historyBudgetBytes(readSetting('sessionCacheMiB'));
  }

  private protectedHistorySessions(): ReadonlySet<string> {
    return new Set(this.hostSessions.values());
  }

  // A parsed tail is megabytes. Sessions rotate, and without this the map keeps every
  // transcript the window has ever shown, long after it dropped off the list. The name
  // and cwd maps are small but grow the same way, so they are trimmed to the sessions
  // that still exist rather than to the few being read.
  private evictCache(keep: SessionFile[], known: SessionFile[]): void {
    const live = new Set(known.map((s) => s.file));
    for (const file of [...this.cache.keys()]) {
      if (!live.has(file)) {
        this.cache.delete(file);
      }
    }
    const retained = [...this.cache].map(([file, entry]) => ({
      sessionId: known.find((session) => session.file === file)?.sessionId ?? '',
      bytes:
        (entry.bytes ?? 0) +
        historyBytes(this.history.get(known.find((session) => session.file === file)?.sessionId ?? '')?.pages ?? []),
      usedAt: entry.usedAt ?? 0,
    }));
    for (const sessionId of historyEvictions(
      retained,
      this.protectedHistorySessions(),
      this.sessionCacheBudgetBytes(),
    )) {
      const session = known.find((candidate) => candidate.sessionId === sessionId);
      if (session) {
        this.cache.delete(session.file);
      }
      this.dropOlderHistory(sessionId);
    }
    // The walked files join the known sessions here, because the peer-wake cut removes
    // its files from every list a caller holds: trimmed against those lists alone, a
    // wake file's cwd and scan cursor would be evicted on every refresh and read back
    // on every poll, which is the trap staleMetas documents for the Codex side.
    const present = new Set([...known.map((s) => s.file), ...this.walkedClaude]);
    if (this.pruneDerivedTitles(present)) {
      this.derivedCacheCheckpointState.markChanged();
    }
    for (const file of [...this.cwds.keys()]) {
      if (!present.has(file)) {
        this.cwds.delete(file);
      }
    }
    for (const file of [...this.humanScans.keys()]) {
      if (!present.has(file)) {
        this.humanScans.delete(file);
      }
    }
    const presentIds = new Set(known.map((session) => session.sessionId));
    for (const sessionId of [...this.history.keys()]) {
      if (!presentIds.has(sessionId)) {
        this.dropOlderHistory(sessionId);
      }
    }
  }

  // Rendering never changes the source revision retained pages describe. Catalog metadata
  // can arrive behind or ahead of the accepted window, so only worker admission moves that
  // revision. This pass updates recency and applies the shared budget.
  private trimOlderHistory(sessions: readonly SessionFile[]): void {
    const now = Date.now();
    const selectedSessions = new Set(sessions.map((session) => session.sessionId));
    // A page being read for a session the reader has left is work nobody will see, and
    // it holds the one request slot the newly selected session needs.
    if (this.historyRequest && !selectedSessions.has(this.historyRequest.sessionId)) {
      this.historyRequest.controller.abort();
      this.historyRequest = null;
    }
    for (const sessionId of selectedSessions) {
      const held = this.history.get(sessionId);
      if (held) {
        this.history.set(sessionId, { ...held, usedAt: now });
      }
    }
    const entries = [...this.history.values()].map((held) => ({
      sessionId: held.sessionId,
      bytes: historyBytes(held.pages),
      usedAt: held.usedAt,
    }));
    for (const sessionId of historyEvictions(
      entries,
      this.protectedHistorySessions(),
      this.sessionCacheBudgetBytes(),
    )) {
      this.dropOlderHistory(sessionId);
    }
  }

  // Admit the tail and retained pages as one revision. Metadata alone cannot prove an
  // append, and a proof for the cached tail cannot preserve pages from another revision.
  private updateHistoryAfterAcceptedWindow(
    sessionId: string,
    previous: CacheEntry | undefined,
    result: ProgressiveResult,
    selected: boolean,
  ): void {
    const held = this.history.get(sessionId);
    if (
      !previous ||
      result.revision === null ||
      result.value.kind !== 'window' ||
      (held && (held.size !== previous.revision.size || held.mtimeMs !== previous.revision.mtimeMs)) ||
      !preservesLoadedHistory(previous.revision, result)
    ) {
      if (held) {
        this.dropOlderHistory(sessionId);
      }
      return;
    }
    const now = Date.now();
    const current = { sessionId, size: result.revision.size, mtimeMs: result.revision.mtimeMs };
    let updated = historyStateAfterRevision(
      held ?? startSessionHistory<HistoryCursor>(current, now),
      current,
      true,
      result.value.read,
      selected ? now : (held?.usedAt ?? now),
    );
    if (!updated) {
      this.dropOlderHistory(sessionId);
      return;
    }
    if (selected && result.revision.size > previous.revision.size) {
      updated = retainDisplacedWindow(
        updated,
        previous.read,
        result.value.read,
        TRANSCRIPT_TURN_LIMIT,
        this.sessionCacheBudgetBytes(),
        now,
      );
    }
    if (held || updated.pages.length) {
      this.history.set(sessionId, updated);
      if (updated.pages !== held?.pages) {
        this.historyStructuralKeys.delete(sessionId);
      }
    }
  }

  // A budget change alone cannot move the revision retained pages describe. This runs only
  // the budget pass, so a setting change can never reset or trim pages by source revision.
  private evictOlderHistoryByBudget(): void {
    const entries = [...this.history.values()].map((held) => ({
      sessionId: held.sessionId,
      bytes: historyBytes(held.pages),
      usedAt: held.usedAt,
    }));
    for (const sessionId of historyEvictions(
      entries,
      this.protectedHistorySessions(),
      this.sessionCacheBudgetBytes(),
    )) {
      this.dropOlderHistory(sessionId);
    }
  }

  private dropOlderHistory(sessionId: string): void {
    this.history.delete(sessionId);
    this.historyStructuralKeys.delete(sessionId);
    if (this.historyRequest?.sessionId === sessionId) {
      this.historyRequest.controller.abort();
      this.historyRequest = null;
    }
  }

  private collect(sessions: SessionFile[]): RenderCard[] {
    // Cleared here rather than trimmed, so a session that drops off the list does not
    // linger in it.
    this.turnsByKey.clear();
    const ordinary = { maxTurns: TRANSCRIPT_TURN_LIMIT, tailBytes: TRANSCRIPT_TAIL_BYTES };
    const turns: Turn[] = [];
    const compactions: Compaction[] = [];
    const parsedCacheRevisions = new Map<string, Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>>();
    let listedMaxTurns = 0;
    this.readWindows.clear();
    // What each session's retained pages still describe, before anything reads a
    // transcript. A file that moved under its pages starts over here rather than merging
    // turns from bytes that now hold other records.
    this.trimOlderHistory(sessions);
    for (const session of sessions) {
      const window = this.readFor(session, ordinary.maxTurns, ordinary.tailBytes);
      const read = window.read;
      parsedCacheRevisions.set(session.sessionId, window.revision);
      // The older pages join the session on screen alone. A session the reader
      // moved away from keeps its pages for the return, and drawing them would widen a
      // session nobody asked to widen.
      const older = historyRecordsOutside(this.history.get(session.sessionId)?.pages ?? [], read);
      // The budget admits the tail and retained pages for every session visible in a host.
      // Without their combined size, navigating one panel would cut a peer panel to one card.
      listedMaxTurns += Math.max(window.maxTurns, read.turns.length + older.turns.length);
      this.readWindows.set(session.sessionId, {
        readBytes: read.readBytes,
        turnLimitReached: read.turnLimitReached,
        // Everything on the list for this session: the ordinary tail and the pages
        // the reader has loaded. The sentinel reports it, the next request sizes its walk
        // back from it, and the session figures cover the same set.
        loadedTurns: read.turns.length + older.turns.length,
      });
      turns.push(...read.turns, ...older.turns);
      compactions.push(...read.compactions, ...older.compactions);
    }
    turns.sort((a, b) => b.startedAt - a.startedAt);
    // Keep selected-window references for diagnostics before the card budget limits the payload.
    this.parsedRefs = turns.map((t) => ({
      key: turnKey(t),
      sessionId: t.sessionId,
      startedAt: t.startedAt,
      kind: 'turn',
    }));
    // Which agents gained a finished turn, and the newest turn in each session. Both
    // are read off the same sorted list, which is newest first, so the first turn seen for
    // a session is its newest. The agents are told to the caller after the render, since
    // the answer is about what to ask an agent rather than about what to draw.
    this.turnMarks = turns.map((t) => ({ id: turnKey(t), agent: t.agent, finished: t.finished }));
    const currentRecords = currentRecordsBySession(turns, compactions);
    this.newestBySession = currentRecords.newestTurns;
    this.composerRuntime = composerRuntimeBySession(turns, currentRecords.newestCompactions);
    // The prompts each session has already sent, read off the same newest-first list.
    // A turn's own prompt opened it and its later prompts were typed while it ran, so the
    // later ones are the newer of the two and are reversed into newest-first order with it.
    this.promptsBySession.clear();
    for (const t of turns) {
      if (!this.newestBySession.has(t.sessionId)) {
        this.newestBySession.set(t.sessionId, t);
      }
      this.promptsBySession.set(
        t.sessionId,
        promptsAcross(
          this.promptsBySession.get(t.sessionId) ?? [],
          t.promptParts ?? [{ text: t.prompt, at: t.startedAt }],
          t.laterPrompts,
        ),
      );
    }
    // A saved prompt the transcript has now recorded. The transcript is the durable copy
    // from here on, so the saved entry is redundant. Only the saved projection drops it,
    // through `writeDrafts`: `this.sentPrompts` itself is left as sent, so Up still returns
    // the words as they were typed for the rest of this window.
    if (Object.keys(this.sentPrompts).length) {
      const prunedSent = prunedSentPrompts(this.sentPrompts, this.promptsBySession);
      if (JSON.stringify(prunedSent) !== JSON.stringify(this.sentPrompts)) {
        void this.writeDrafts();
      }
    }
    this.newestCompactionBySession = currentRecords.newestCompactions;
    // Through the budget rule rather than a bare slice: the shown session fills
    // first, and every parsed session keeps at least its newest turn, so the rail's
    // statuses and counts stay knowable for everything that was paid for.
    const listed = turnBudget(turns, listedMaxTurns, this.showing);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    // Every card carries its session's name, compactions included. The panel groups by it
    // when more than one session is on screen, and ignores it when there is only one. A
    // Claude session's name comes from `sessionNames`, which this refresh's stored metadata
    // and parsed turns feed, so the session heading and the rail card draw the same held name. A
    // Codex turn carries the name its read was given.
    this.observeParsedNames(listed, byId);
    const codexTitles = new Map<string, string>();
    for (const turn of listed) {
      if (turn.agent !== 'claude' && turn.sessionTitle) {
        codexTitles.set(turn.sessionId, turn.sessionTitle);
      }
    }
    const titleOf = (sessionId: string): string => this.headingTitle(sessionId, byId, codexTitles);

    // Over the turns that were read, which is what the hover on each figure says. Not over
    // the cards drawn: those follow the display window, and a session's cost that fell when
    // fewer cards were retained would be a claim about the session that the session
    // never made. The heading receives the indexed lifetime cost and turn count later, while
    // the parsed figures continue to supply current context and change totals.
    //
    // Which turns feed which session is decided in turnview.ts, not here, for the same
    // reason the arithmetic is: this file has no tests.
    // The compactions go with them because the context hover describes the read window.
    this.statsBySession = statsBySession(listed, compactions);
    const parsedCacheFacts = new Map<string, { turns: Turn[]; compactions: Compaction[] }>();
    for (const turn of listed) {
      const held = parsedCacheFacts.get(turn.sessionId);
      if (held) {
        held.turns.push(turn);
      } else {
        parsedCacheFacts.set(turn.sessionId, { turns: [turn], compactions: [] });
      }
    }
    for (const compaction of compactions) {
      const held = parsedCacheFacts.get(compaction.sessionId);
      if (held) {
        held.compactions.push(compaction);
      }
    }
    this.parsedRailCaches = Object.fromEntries(
      [...parsedCacheFacts].flatMap(([sessionId, facts]) => {
        const revision = parsedCacheRevisions.get(sessionId);
        return revision
          ? [
              [
                sessionId,
                {
                  mark: railCacheMarkOf(facts),
                  ...revision,
                },
              ],
            ]
          : [];
      }),
    );

    const now = Date.now();
    // Kept, because a turn's status moves on the clock alone and the next poll has to compare
    // against the reading these cards were worded at rather than one of its own.
    this.collectedAt = now;
    // The open folders decide how a file row names itself: a file under one of them is
    // drawn by its basename, and a file under none of them by its whole path.
    const folders = this.folders();
    const cards = this.drawTurnCards(listed, titleOf, now, folders);
    // A compaction older than the oldest turn on screen marks a boundary to nothing, so
    // it is left out rather than drawn hanging off the end of the list. Found rather
    // than read off the end: the budget puts the shown session first and appends
    // the per-session floor, so listed is not newest-first end to end.
    const oldest = listed.length ? listed.reduce((low, t) => Math.min(low, t.startedAt), Infinity) : 0;
    for (const c of compactions) {
      if (c.at < oldest) {
        continue;
      }
      const card = toCompactionCard(c, now);
      // A compaction carries its session's name too. Without it a group whose newest card
      // is a compaction draws its heading with no name at all.
      card.sessionTitle = titleOf(c.sessionId);
      cards.push({ ...card, summaryHtml: renderRichMarkdown(c.summary), at: c.at });
    }
    cards.sort((a, b) => b.at - a.at);
    return groupBySession(cards);
  }

  // The turn cards of the listed turns. The newest turn of each session is its latest card.
  private drawTurnCards(
    listed: readonly Turn[],
    titleOf: (sessionId: string) => string,
    now: number,
    folders: string[],
  ): (RenderCard & { at: number })[] {
    const newestOf = newestPerSession(listed);
    // A session whose main agent is idle can still have live background children. Their rows
    // draw as running on whichever card launched them, the agents figure counts them, and the
    // newest card counts the carried subagents too.
    const runningSessions = this.runningSessions();
    const liveChildren = this.liveOpenChildren(now);
    // A dispatched session's row reads its rail status, background commands included, so a
    // session idle on its subagents or on a command still reads running.
    const dispatchStatuses = this.railStatuses(now).statuses;
    // Read at most once for the batch, and only when a card counts a dispatched session. Each
    // card looks up only its own session's contributions.
    let batchCosts: ReturnType<typeof this.dispatchedTurnCosts> | undefined;
    const dispatchedCosts = () => (batchCosts ??= this.dispatchedTurnCosts());
    this.drawnOpenChildren = openChildrenKey(liveChildren, this.liveBackgroundCommands(now));
    return listed.map((recordedTurn) => {
      const latest = newestOf.get(recordedTurn.sessionId) === recordedTurn.startedAt;
      const card = this.renderTurnCard(
        recordedTurn,
        latest,
        titleOf(recordedTurn.sessionId),
        now,
        folders,
        runningSessions,
        liveChildren,
        dispatchStatuses,
        dispatchedCosts,
      );
      return { ...card, at: recordedTurn.startedAt };
    });
  }

  private renderTurnCard(
    recordedTurn: Turn,
    latest: boolean,
    title: string,
    now: number,
    folders: string[] = this.folders(),
    runningSessions: ReadonlySet<string> = this.runningSessions(),
    liveChildren: ReadonlyMap<string, readonly string[]> = new Map(),
    dispatchStatuses: ReturnType<typeof sessionStatusOf> = this.railStatuses(now).statuses,
    // The contributions of dispatched sessions, from `dispatchedTurnCosts`. An activity redraw
    // reads them here, so the newest card keeps its dispatched cost.
    dispatchedCosts: () => Readonly<Record<string, Readonly<Record<string, DispatchedSessionCost>>>> = () =>
      this.dispatchedTurnCosts(),
  ): RenderCard {
    const turn = latest ? this.withActivity(recordedTurn) : recordedTurn;
    const callIds = new Set([
      ...(turn.dispatchToolUseIds ?? []),
      ...turn.steps.map((step) => step.sourceId).filter((id): id is string => !!id),
    ]);
    // The cost figure counts every dispatched session the turn started, directly or through one
    // of its subagents, on the card of its first receipt. A session with no contribution yet
    // marks the figure as a lower bound while the ledger or dispatch discovery catches up.
    const counted = countedDispatchedCosts(
      turn,
      this.claudeChildReferences ?? [],
      callIds,
      () => dispatchedCosts()[turn.sessionId],
      !this.projectSpendHydrated || this.dispatchDiscoveryPending || this.authoritativeCatalog === null,
      this.codexSubagents ?? [],
    );
    // The prompt press alone. A compaction carries none of the reader's words, so it has
    // nothing to draw under "You asked", and picking the newest press of either kind would
    // let a compaction pressed after a mid-turn prompt take that prompt off the card.
    const card = toCard(
      turn,
      latest,
      now,
      folders,
      pressOfKind(this.live[turn.sessionId] ?? [], 'prompt'),
      runningSessions.has(turn.sessionId),
      new Set(liveChildren.get(turn.sessionId)),
      counted,
    );
    const matches = (this.claudeChildReferences ?? []).filter(
      (reference) =>
        reference.kind === 'dispatch' &&
        reference.parentSessionId === turn.sessionId &&
        reference.toolUseIds.some((id) => callIds.has(id)),
    );
    const dispatched = [...new Map(matches.map((reference) => [reference.sessionId, reference])).values()].map(
      (reference) => {
        const facts = this.dispatchFacts?.get(reference.sessionId);
        let spend: AgentSpend = facts?.spend ?? { models: [], effort: null, found: false, partial: false };
        const state = dispatchedState(dispatchStatuses.get(reference.sessionId));
        if (state !== 'running' && (spend.commitIntents?.length || spend.commits?.length)) {
          const owner: Turn = {
            ...turn,
            commits: [...(spend.commits ?? [])],
            commitIntents: spend.commitIntents,
            agents: [],
            landingIntents: [],
            landings: [],
          };
          this.repositoryCommits.apply([owner], folders);
          spend = {
            ...spend,
            commits: owner.commits,
            artifacts: spend.artifacts
              ? withRecoveredCommits(spend.artifacts, owner.commits, sameCommitSha)
              : undefined,
          };
        }
        return dispatchedAgentCard(
          reference.sessionId,
          (reference.kind === 'dispatch' ? reference.name : null) || reference.sessionId,
          spend,
          state,
          facts?.startedAt ?? null,
          facts?.endedAt ?? null,
          facts?.toolUses ?? 0,
          folders,
          now,
        );
      },
    );
    if (dispatched.length) {
      card.dispatched = dispatched;
      card.chips.push(dispatchedChip(dispatched));
    }
    card.sessionTitle = title;
    this.turnsByKey.set(card.key, turn);
    return {
      ...card,
      // Each earlier answer is markdown the same way the summary is, and the panel draws
      // only rendered html, so the renderer runs here for both.
      earlierAnswers: card.earlierAnswers.map((answer) => ({
        ...answer,
        summaryHtml: renderRichMarkdown(answer.summary),
      })),
      // Every mid-turn message is markdown too, and the section draws only rendered html.
      saidMessages: card.saidMessages.map((said) => ({
        ...said,
        summaryHtml: renderRichMarkdown(said.text),
      })),
      activity: card.activity.map((row) =>
        row.kind === 'message' ? { ...row, summaryHtml: renderRichMarkdown(row.text!) } : row,
      ),
      summaryHtml: renderRichMarkdown(turn.summary),
    };
  }

  // Where this webview loads a picture a response named. A resource URI belongs to one
  // webview, so this is built per host, like the icon a file row draws.
  private imagesFor(webview: vscode.Webview): ImageResolver {
    const folders = this.folders();
    return (target) => {
      const file = imageFileFor(target, folders);
      return file ? { src: webview.asWebviewUri(vscode.Uri.file(file)).toString(), path: file } : null;
    };
  }

  // Put the reader's own icon on each of a turn's file rows, and the pictures a response
  // named into its rendered text, both addressed for one host.
  //
  // These are the parts of a card that are not the same from one host to the next: a theme's
  // icon and a response's picture each reach a webview as a URI that webview alone may load,
  // so a card built for one webview draws a broken picture in another. Everything else is
  // built once in `collect()` and these are redrawn here, per host, on a copy.
  //
  // A file the theme knows nothing about keeps the lettered badge the card already carries,
  // so the column is never empty.
  //
  // The summary is rendered again only when it names a picture, which almost none do. A post
  // of forty cards otherwise pays one string test each and no parse, and the poll runs every
  // few seconds.
  private themedFor(cards: RenderCard[], webview: vscode.Webview, light: boolean): RenderCard[] {
    const resolveImage = this.imagesFor(webview);
    return cards.map((card) => {
      const drawn = this.picturedFor(card, resolveImage);
      if (drawn.kind !== 'turn' || !drawn.files.length) {
        return drawn;
      }
      const files = drawn.files.map((file) => {
        const themed = this.icons.iconFor(file.path, webview, light);
        // `iconFor` in `fileicons.ts` hands back the shared entry out of its own table, so
        // the theme's answer goes onto a copy. Writing it into that object would give every
        // file of the same type whatever icon the last row resolved.
        return themed ? { ...file, icon: { ...file.icon, ...themed } } : file;
      });
      return { ...drawn, files };
    });
  }

  // One card's rendered text, with any picture it names addressed to this host. An earlier
  // answer is markdown the same way the response is, so it goes through the same rule.
  //
  // `collect` still renders the same summary once with no host. That first parse is thrown
  // away for a card holding a picture, and it is kept deliberately: it is the value any
  // future path that posts a card without coming through here would send, and words in place
  // of a picture is a better failure than an empty response.
  private picturedFor(card: RenderCard, resolveImage: ImageResolver): RenderCard {
    if (card.kind !== 'turn') {
      return hasImageReference(card.summary)
        ? { ...card, summaryHtml: renderRichMarkdown(card.summary, resolveImage) }
        : card;
    }
    const inSummary = hasImageReference(card.summary);
    const inAnswers = card.earlierAnswers.some((answer) => hasImageReference(answer.summary));
    const inSaid = card.saidMessages.some((said) => hasImageReference(said.text));
    if (!inSummary && !inAnswers && !inSaid) {
      return card;
    }
    return {
      ...card,
      summaryHtml: inSummary ? renderRichMarkdown(card.summary, resolveImage) : card.summaryHtml,
      earlierAnswers: inAnswers
        ? card.earlierAnswers.map((answer) =>
            hasImageReference(answer.summary)
              ? { ...answer, summaryHtml: renderRichMarkdown(answer.summary, resolveImage) }
              : answer,
          )
        : card.earlierAnswers,
      saidMessages: inSaid
        ? card.saidMessages.map((said) =>
            hasImageReference(said.text) ? { ...said, summaryHtml: renderRichMarkdown(said.text, resolveImage) } : said,
          )
        : card.saidMessages,
      activity: (card.activity ?? []).map((row) =>
        row.kind === 'message' && hasImageReference(row.text!)
          ? { ...row, summaryHtml: renderRichMarkdown(row.text!, resolveImage) }
          : row,
      ),
    };
  }

  // Put focus in the group a diff should open in, for the one command that cannot be told.
  // A group that is not there yet is not created: the command does nothing, focus stays where
  // it is, and the diff opens there, which is still not a split.
  private async focusColumn(beside = false): Promise<void> {
    // A group of its own is asked for by splitting first, since `vscode.changes` can only be
    // told where to open by what has focus when it runs. Splitting on every press opened a
    // new group per ctrl-click, so the column the last split landed in is remembered and a
    // repeat press focuses it instead. Whether the memory still answers is besideColumn's
    // rule in turnview.ts, where it is tested; this only gathers what it asks about.
    if (beside) {
      const reuse = besideColumn({
        last: this.lastBeside,
        groups: vscode.window.tabGroups.all.map((g) => g.viewColumn),
        panel: this.editorPanel?.viewColumn ?? null,
      });
      const focus = reuse === null ? undefined : FOCUS_GROUP[reuse - 1];
      if (focus) {
        await vscode.commands.executeCommand(focus);
        return;
      }
      await vscode.commands.executeCommand('workbench.action.splitEditorRight');
      // The split makes the new group active, which is the only record of where it went.
      this.lastBeside = vscode.window.tabGroups.activeTabGroup.viewColumn;
      return;
    }
    const group = FOCUS_GROUP[this.column() - 1];
    if (group) {
      await vscode.commands.executeCommand(group);
    }
  }

  // The results of one search query, posted to the panel.
  private answerSearch(query: string): void {
    // The session on screen scopes the search to itself. The corpus read is narrowed
    // by the same session before the per-file reads, so the expensive pass shrinks
    // with the scope; searchScope is the tested rule that says the narrowing is meant, and
    // its flag is what the panel words the scope from.
    const scope = searchScope(this.searchCorpus(this.showing), this.showing);
    // The labels are put on the entries here, at the moment the search runs, and never
    // held with them. The corpus is cached against each file's size and time, and labels
    // move when the reader ticks a box rather than when a transcript grows, so an entry
    // carrying them through that cache would answer with the labels its session had
    // when it was last parsed.
    // The archived and agent-run facts are put on here for the same reason. The reader
    // archives a session, and an agent starts one, while a transcript sits still, so
    // both are read now rather than held with the parsed text.
    const archived = this.archivedSessions();
    const sessions = this.allSessions(true);
    const parentEdges = this.sessionParentEdges(sessions).edges;
    const runs = new Set(
      sessions.filter((session) => this.agentRunFor(session, parentEdges)).map((session) => session.sessionId),
    );
    const labelled = scope.entries.map((e) => ({
      ...e,
      labels: labelsOf(this.saved.labels, e.sessionId),
      archived: archived.has(e.sessionId),
      runByAgent: runs.has(e.sessionId),
    }));
    const hits = searchTurns(labelled, query);
    void this.post({ type: 'results', query, hits, scope: searchScopeName(scope) });
  }

  // Every session in the workspace, read into the searchable corpus.
  //
  // This is the one expensive thing the panel does, and where it runs is the whole constraint:
  // 143 ms here, 1475 ms on the largest project on this machine. It is called from a search
  // and from nowhere else. Never on load, never on the poll, never as a side effect of drawing
  // anything, because a freeze the reader asked for and is watching is a different thing from
  // one that happens to them.
  private searchCorpus(only: string | null = null): SearchEntry[] {
    const all = this.allSessions();
    // A search can be the first thing a window does, before any poll has looked at the
    // index, and the names decide what every result is filed under.
    this.threadNames = readThreadNames(codexSessionIndexPath(), this.threadNames);
    const live = new Set(all.map((f) => f.file));
    for (const file of [...this.corpus.keys()]) {
      if (!live.has(file)) {
        this.corpus.delete(file);
      }
    }
    const out: SearchEntry[] = [];
    for (const session of all) {
      // A scoped search reads one session, and the cut is made here, before the
      // per-file reads, because the reads are the whole cost: searchScope over the full
      // corpus would filter the entries after every transcript had already been paid for.
      // The cache trim above still runs over everything, so scoped searches do not grow it.
      if (only && session.sessionId !== only) {
        continue;
      }
      const held = this.corpus.get(session.file);
      // Size as well as mtime, which is what `readFor` already decided: two appends inside one
      // mtime tick would otherwise leave the corpus holding the older of the two.
      if (held && held.mtimeMs === session.mtimeMs && held.size === session.size) {
        // Except for the name, which can have arrived since. Codex names a thread into a
        // file of its own, so a session being named leaves the transcript's size and mtime
        // where they were: what was read is still current and only what it is called has
        // moved. A Claude session's held name can rise from a read of another surface. A
        // metadata read replaces the name a derived cache version bump carried, even with no
        // name, and the session then draws its id placeholder. Restamped with the name a fresh
        // read files the session under, rather than re-read, because the read is the whole cost.
        const named = this.sessionLabel(session).label;
        for (const entry of held.entries) {
          entry.sessionTitle = named;
        }
        out.push(...held.entries);
        continue;
      }
      // Parsed here rather than through `readFor`, which keys its cache on the file alone: a
      // corpus read asks for every turn and a different number of bytes, so going through it
      // would overwrite the entry the render path just filled and make the next poll parse
      // those sessions again for nothing.
      const read =
        session.agent === 'codex'
          ? readCodexSession(session.file, session.sessionId, {
              maxTurns: Number.MAX_SAFE_INTEGER,
              tailBytes: SEARCH_TAIL_BYTES,
            })
          : readSession(session.file, session.sessionId, {
              maxTurns: Number.MAX_SAFE_INTEGER,
              tailBytes: SEARCH_TAIL_BYTES,
              childTranscript: session.childTranscript === true,
              turnsOnly: true,
            });
      if (session.agent === 'claude') {
        this.observeParsedNames(read.turns, new Map([[session.sessionId, session]]));
      }
      const title = this.sessionLabel(session).label;
      const entries: SearchEntry[] = read.turns.map((turn) => ({
        key: turnKey(turn),
        sessionId: turn.sessionId,
        sessionTitle: title,
        agent: AGENT_NAMES[turn.agent],
        startedAt: turn.startedAt,
        // Everything the reader typed and everything the turn answered, not only the
        // first of each: a search for words typed while the turn ran, or said in an
        // earlier answer, would otherwise find nothing. Both rules are tested where the
        // other search rules are.
        prompt: searchablePrompt(turn),
        summary: searchableSummary(turn),
        // Whether this read reached the first byte of the transcript. Search keeps its own
        // window, so a session the reader has paged back through can still be searched
        // over less than they can see, and the answer has to say which.
        whole: read.readBytes >= session.size,
      }));
      this.corpus.set(session.file, { mtimeMs: session.mtimeMs, size: session.size, entries });
      out.push(...entries);
    }
    return out;
  }

  private manifestFor(sessionId: string): Manifest | null {
    return readManifest(path.join(this.storeRootDir, sessionId, 'manifest.json'));
  }

  // The snapshot-store entry for a file, when that file is still awaiting review.
  private pendingEntry(sessionId: string, filePath: string): ManifestEntry | null {
    return pendingIn(this.manifestFor(sessionId), filePath);
  }

  // The URI one side of a turn's diff is served under. The version is a digest of the text
  // itself: VS Code caches a virtual document per URI, so two turns whose diffs differ must
  // not share one.
  private sideUri(filePath: string, side: 'before' | 'after', text: string): vscode.Uri {
    const version = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    return turnFileUri(filePath, side, version);
  }

  // Keep every side of one diff, then drop whatever is over budget, oldest first. Nothing
  // this call keeps is dropped by it: trimming file by file would let one large turn evict
  // its own earlier files before the editor ever opened, and an evicted side is served as an
  // empty document, which reads as "this file did not change" rather than as an error. So a
  // single diff can put the map over budget, and the next one trims it back.
  private keepSides(sides: { key: string; text: string }[]): void {
    const fresh = new Set<string>();
    for (const { key, text } of sides) {
      const already = this.patches.get(key);
      if (already !== undefined) {
        this.patchBytes -= Buffer.byteLength(already);
        this.patches.delete(key);
      }
      this.patches.set(key, text);
      this.patchBytes += Buffer.byteLength(text);
      fresh.add(key);
    }
    for (const key of [...this.patches.keys()]) {
      if (this.patchBytes <= PATCH_BUDGET_BYTES) {
        break;
      }
      if (fresh.has(key)) {
        continue;
      }
      const stale = this.patches.get(key);
      if (stale === undefined) {
        continue;
      }
      this.patchBytes -= Buffer.byteLength(stale);
      this.patches.delete(key);
    }
  }

  // Every file a turn changed, as one multi-file diff. Each file is shown from the best
  // source it has: the snapshot taken before the session's first edit to it, the whole files the edit
  // results recorded, or the changed regions alone. The title says how many files are not an
  // exact record of the turn.
  private async openTurnDiff(sessionId: string, turn: Turn, headline: string, beside = false): Promise<void> {
    if (!turn.files.length) {
      return;
    }
    // Read once, not once per file: the lookup that follows costs a stat and, when the
    // sizes match, a byte comparison, and re-parsing the manifest beside each of those puts
    // the whole cost on the shared extension-host event loop.
    const manifest = this.manifestFor(sessionId);
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    const sidesToKeep: { key: string; text: string }[] = [];
    let againstBaseline = 0;
    let asHunks = 0;
    for (const file of turn.files) {
      // A row the shell named without hunks has no recorded change to show: opening it would
      // put an empty diff in the list rather than the one this turn actually has none of.
      if (file.countsUnknown) {
        continue;
      }
      const pending = pendingIn(manifest, file.path);
      if (pending) {
        againstBaseline++;
        // The store's own path, for all three, because a transcript writes a path in a
        // different shape and the entry would then be labelled by a second URI for one file.
        const live = vscode.Uri.file(pending.path);
        resources.push([live, baselineUri(pending.snapshot, pending.path), live]);
        continue;
      }
      const sides = sidesFor(file.edits);
      if (sides.source === 'hunks') {
        asHunks++;
      }
      const before = this.sideUri(file.path, 'before', sides.before);
      const after = this.sideUri(file.path, 'after', sides.after);
      sidesToKeep.push({ key: before.toString(), text: sides.before });
      sidesToKeep.push({ key: after.toString(), text: sides.after });
      // The resource is the live file, so the entry is labelled with the real filename.
      resources.push([vscode.Uri.file(file.path), before, after]);
    }
    this.keepSides(sidesToKeep);
    // `vscode.changes` takes a title and its resources and nothing else: there is no options
    // argument, so the group it opens in cannot be named the way `vscode.diff`'s can. It opens
    // in whichever group has focus, and once the panel is an editor tab of its own that is
    // the panel's own group. So the group is focused first and the command follows it.
    await this.focusColumn(beside);
    // Opening this again gives a second editor rather than reusing the first: a multi-file
    // diff's identity is a random URI, so there is nothing to reuse and no API to update
    // one in place.
    await vscode.commands.executeCommand('vscode.changes', diffTitle(headline, againstBaseline, asHunks), resources);
  }

  // Everything the panel sends, read by `parsePanelToHost` before any of it runs. The parser
  // answers with one of the contract's variants or with nothing, and the handlers below are
  // named by the variant they answer. A message kind added to the contract and left out here
  // does not compile.
  private async onMessage(raw: unknown, host: PanelHost): Promise<void> {
    const parsed = parsePanelToHost(raw);
    const browserSession = parsed && 'session' in parsed ? parsed.session : null;
    const message =
      parsed && 'session' in parsed
        ? {
            ...parsed,
            session:
              parsed.type === 'showReaderParent'
                ? resolveSessionAlias(this.sessionAliases, parsed.session)
                : this.panelSession(parsed.session, host),
          }
        : parsed;
    if (!message) {
      const named = raw !== null && typeof raw === 'object' ? (raw as { type?: unknown }).type : raw;
      console.warn('Arc: a message from the panel was not understood, so nothing was done.', named);
      return;
    }
    if (message.type !== 'ready' && message.type !== 'importPromptRecovery' && !this.readyHosts.has(host)) {
      return;
    }
    // The three messages that name a card. A key the list no longer draws answers nothing,
    // and the card that is found carries the session the message works in.
    const cardFor = (key: string): { card: RenderCard; sessionId: string } | null => {
      const card = this.cards.find((c) => c.key === key);
      return card ? { card, sessionId: card.key.slice(0, card.key.indexOf(':')) } : null;
    };
    await dispatchPanelToHost<void | Promise<void>>(message, {
      ready: () => {
        this.browserReady(host);
      },
      painted: (msg) => {
        this.browserPainted(host, msg.generation, msg.stage, msg.usableRows);
      },
      initialize: () => {
        this.onSetupRefresh?.();
        void this.refresh(true);
      },
      developmentReload: () => {
        if (PANEL_DEV_SERVER_URL) {
          this.readyHosts.delete(host);
          this.releaseQueuedEditOffer(host);
          if (!this.anyVisible()) {
            this.stopPolling();
          }
          host.webview.html = this.shell(host.webview);
        }
      },
      refresh: () => {
        this.onSetupRefresh?.();
        void this.refresh();
      },
      perf: (msg) => {
        this.performanceCounters.recordPanelMessage(msg.kind, msg.ms, host);
      },
      // The mouse's own back and forward buttons. The panel sees them and the workbench does
      // not, because its listener sits outside the frame the panel draws in. That also means
      // the editor's own setting cannot turn them off in here, so this reads it: a reader who
      // switched the buttons off did so because their mouse presses them by accident.
      goBack: () => {
        if (mouseNavigates()) {
          this.goBack(host);
        }
      },
      goForward: () => {
        if (mouseNavigates()) {
          this.goForward(host);
        }
      },
      newSession: (msg) => {
        this.newSession(msg.request, host, msg);
      },
      pinSetup: (msg) => {
        if (msg.owner !== this.setupOwner) return;
        void this.pinSetup(msg.request, host);
      },
      unpinSetup: (msg) => {
        if (msg.owner !== this.setupOwner) return;
        void this.unpinSetup(msg.id);
      },
      // The presses on the panel's foot. Every one needs a child, which this file has none
      // of, so each is passed straight out to the caller that owns them.
      refreshUsage: (msg) => {
        this.refreshUsageHandler?.(msg.agent, msg.force);
      },
      requestDefaults: (msg) => {
        this.defaultContext(msg.agent, this.folders()[0] ?? null, msg.model);
      },
      openControl: (msg) => {
        const state = this.stateFor(msg.session);
        if (!state) {
          return;
        }
        this.onPanelCommand?.(
          state.sessionId,
          state.agent,
          msg.control,
          this.newDrafts[state.sessionId] ?? null,
          this.cwdForSession(state.agent, state.sessionId),
        );
      },
      // The panel draws its own menu, so a press arrives with the choice already made and
      // nothing here opens a picker.
      pick: (msg) => {
        if (msg.control === 'model') this.invalidateContext(msg.session);
        // The session the press names, resolved to a row the panel still draws, the way
        // the `stopTurn` handler below resolves its own. An id the panel draws no row for
        // reaches neither path. Without that, a press still in flight when a draft takes its
        // real id falls through to `onPicked`, which stores an ask-mode value against the
        // agent and pushes it to every child that agent is running.
        //
        // The resolved row also answers whether this is a draft. A bare index on a key the
        // browser supplied answers truthy for `constructor` and `toString`, so one crafted
        // message writes a draft whose every field is undefined.
        const aimed = this.stateFor(msg.session);
        if (!aimed) {
          return;
        }
        // A draft owns its setup picks. MCP actions belong to its agent, the same as they do
        // on a live session, so they must reach the callback that owns agent children.
        if (aimed.profile && msg.control !== 'mcp') {
          this.pickOnDraft(msg.session, msg.control, msg.value);
          return;
        }
        this.onPicked?.(
          aimed.agent,
          msg.session,
          msg.control,
          msg.value,
          msg.model,
          this.ownCwdForSession(aimed.agent, msg.session),
        );
      },
      // What the composer does. Each needs a child, which this file has none of.
      draft: (msg) => {
        this.draftRevisions ??= new Map();
        if (msg.revision !== undefined) this.draftRevisions.set(msg.session, msg.revision);
        this.setDraft(msg.text, msg.keep, msg.session);
      },
      contextDetail: (msg) => this.requestContext(host, msg.session, msg.request, msg.generation),
      pathCompletion: async (msg) => {
        const state = this.stateFor(msg.session);
        const workingDirectory = state ? this.cwdForSession(state.agent, msg.session) : null;
        if (!state || !workingDirectory) {
          return;
        }
        const platform = process.platform === 'win32' ? 'win32' : 'posix';
        const completed = await completePath({
          token: msg.token,
          workingDirectory,
          homeDirectory: os.homedir(),
          platform,
          reader: {
            readDirectory: async (directory) =>
              (await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory))).map(([name, type]) => ({
                name,
                directory: (type & vscode.FileType.Directory) !== 0,
                symbolicLink: (type & vscode.FileType.SymbolicLink) !== 0,
              })),
            stat: async (file) => ({
              directory:
                ((await vscode.workspace.fs.stat(vscode.Uri.file(file))).type & vscode.FileType.Directory) !== 0,
            }),
          },
        });
        await this.sendToHost(host, {
          type: 'pathCompletion',
          session: browserSession ?? msg.session,
          request: msg.request,
          token: msg.token,
          caret: msg.caret,
          rows: pathEntries(completed.entries, completed.prefix, completed.separator),
        });
      },
      answerAsk: (msg) => {
        const answered = this.onAnswerAsk?.(msg.session, msg.id, msg.answer) ?? false;
        if (!answered) {
          void this.post({ type: 'askRejected', session: browserSession ?? msg.session, id: msg.id });
        }
      },
      beginFileStaging: (msg) => {
        try {
          this.openStagingOperation(browserSession ?? msg.session, msg.token, host);
        } catch (error) {
          this.setAttachmentNotice(msg.session, attachmentFailureNotice(error));
          this.settleBrowserStagingOperation(browserSession ?? msg.session, msg.token, host);
          void this.sendToHost(host, {
            type: 'fileStagingRejected',
            session: browserSession ?? msg.session,
            token: msg.token,
          });
        }
      },
      fileReadError: (msg) => {
        this.setAttachmentNotice(msg.session, attachmentRefusal('read', msg.name));
        this.settleBrowserStagingOperation(browserSession ?? msg.session, msg.token, host);
      },
      fileRejected: (msg) => {
        this.setAttachmentNotice(msg.session, attachmentRefusal(msg.code, msg.name, msg.size, msg.rejected));
      },
      attachFiles: async (msg) => {
        if (!Array.isArray(msg.files)) {
          this.setAttachmentNotice(msg.session, attachmentRefusal('read'));
          this.settleBrowserStagingOperation(browserSession ?? msg.session, msg.token, host);
          return;
        }
        const inputs: PromptAssetInput[] = [];
        for (const value of msg.files) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
          }
          const file = value as Record<string, unknown>;
          const bytes = messageBytes(file.data);
          if (typeof file.name !== 'string' || typeof file.mime !== 'string' || !bytes) {
            continue;
          }
          inputs.push({
            name: msg.clipboard ? pastedAssetName(file.name) : file.name,
            mime: browserAssetMime(file.name, file.mime),
            bytes,
          });
        }
        await this.stageFiles(browserSession ?? msg.session, inputs, msg.token, host);
      },
      removeFile: async (msg) => {
        await this.removeFile(msg.session, msg.value);
      },
      importPromptRecovery: async (msg) => {
        try {
          await this.importPromptRecovery(msg.submittedPrompts);
          if (msg.request) {
            this.panelRecoveryWaiters.get(msg.request)?.resolve();
            this.panelRecoveryWaiters.delete(msg.request);
          }
        } catch (error) {
          if (msg.request) {
            this.panelRecoveryWaiters.get(msg.request)?.reject(error);
            this.panelRecoveryWaiters.delete(msg.request);
          }
        }
      },
      sendPrompt: (msg) =>
        this.acceptSubmission(msg.text, msg.session, msg.revision, browserSession ?? msg.session, host, msg.attempt),
      compact: (msg) => {
        this.compact(msg.session);
      },
      dismissLive: (msg) => {
        this.dismissLive(msg.session, msg.kind);
      },
      restoreLive: (msg) => {
        this.restoreLive(msg.session, msg.kind);
      },
      stopTurn: (msg) => {
        // The session whose Stop the reader pressed, named on the message. Worked out
        // here instead it was whichever session was on screen when the message
        // arrived, so a poll landing between the press and the message stopped the wrong turn
        // and left the one on screen running.
        const aimed = this.stateFor(msg.session);
        if (aimed) {
          this.cancelClearSettlement(aimed.sessionId, 'The clear request stopped before a new session opened.');
          this.onStopTurn?.(aimed.agent, aimed.sessionId);
        }
      },
      dequeue: (msg) => {
        this.dequeue(msg.value, msg.session);
      },
      editQueued: (msg) => {
        this.requestQueuedEdit(msg.value, msg.session, msg.revision, host, browserSession ?? msg.session);
      },
      acceptQueuedEdit: (msg) => {
        this.acceptQueuedEdit(msg.value, msg.session, msg.revision, msg.currentRevision, msg.accepted, host);
      },
      copy: async (msg) => {
        await this.copyText(msg.text);
      },
      // One change to the reader's notes: a note written, a note edited, or a note deleted.
      //
      // An operation rather than the whole array, which is the treatment `hidden` already gets
      // and for the same reason: a set posted by one host is a set that never knew what the
      // other host did. Applied by `applyComment` in turnview.ts, where the ceilings and the
      // cap live, and pushed back to every host so both draw the answer this side holds.
      note: (msg) => {
        this.saved.comments = applyComment(this.saved.comments, msg.note);
        void this.memento?.update(STATE_KEY, this.saved);
        void this.post({ type: 'notes', comments: this.saved.comments });
        // The composer derives its annotation chip and empty-prompt send state from the same
        // comments. They travel in the usage payload, so publish that view with the card marks.
        void this.post({ type: 'usage', usage: this.usagePayload() });
        this.postRail(true);
      },
      armSelectedText: (msg) => {
        this.selectedTextMenuArm = {
          host,
          session: msg.session,
          key: msg.key,
          at: Date.now(),
        };
      },
      selectedTextHandoff: (msg) => {
        this.acceptSelectedTextHandoff(host, msg.text, msg.session, msg.key, msg.copyLabels);
      },
      armSessionDetails: (msg) => {
        this.detailsMenuArm = {
          host,
          session: msg.session,
          browserSession: browserSession ?? msg.session,
          at: Date.now(),
        };
      },
      armComposer: () => {
        this.composerMenuArm = { host, at: Date.now() };
      },
      // Which session to show. An id the workspace no longer has, and the empty string,
      // both fall to the newest in `refresh` below: the panel never draws no session.
      showReaderParent: (msg) => {
        this.show(msg.session || null, host);
      },
      showSession: (msg) => {
        this.show(msg.session || null, host);
      },
      // The rows the label editor draws. The panel asks each time it opens, so a popover
      // opened in one host never shows what another host wrote before it.
      labelEditor: (msg) => {
        void this.post(this.labelEditorReply(msg.session, browserSession ?? msg.session));
      },
      // A session renamed from its rail card or its heading. The answer goes to the host that
      // asked, because its editor waits for it, and it goes even when the rename throws.
      renameSession: async (msg) => {
        await answerSessionRename(
          msg,
          () => this.renameSession(msg.session, msg.title),
          (answer) => this.sendToHost(host, answer),
        );
      },
      // One session's labels, replaced. The whole list arrives rather than one name, the
      // way the hidden and pinned sets do: a box ticked and a name created are the same
      // message.
      //
      // The rules that clean a name, fold two spellings into one and hold the record to its
      // ceiling all run here, so the panel's create row is an offer rather than a promise. The
      // rail is reworded from the same write, and the fresh rows go back to every host, so the
      // popover draws what was stored and not what was typed.
      setLabels: (msg) => {
        this.saved.labels = setSessionLabels(this.saved.labels, msg.session, msg.names);
        void this.memento?.update(STATE_KEY, this.saved);
        this.postRail(true);
        void this.post(this.labelEditorReply(msg.session, browserSession ?? msg.session));
        // And a word to the hosts that are looking at another session. A write moves the
        // counts every editor draws and can add a label none of them names, so a host with an
        // editor open on something else asks again for its own.
        void this.post({ type: 'labelsChanged', session: browserSession ?? msg.session });
      },
      // The saved views, replaced. The whole list arrives rather than one view, the way a
      // session's labels do: a view saved, a view renamed and a view deleted are one
      // message, and the panel posts back what it drew.
      //
      // The rules that clean a name, refuse a repeated one and hold the list to its ceiling
      // all run here, so the panel's editor is an offer rather than a promise. The rail post
      // carries the stored list back to every host, so a second window draws what was kept and
      // not what was typed.
      setViews: (msg) => {
        this.saved.views = normalizeSavedViews(msg.views);
        void this.memento?.update(STATE_KEY, this.saved);
        this.postRail(true);
      },
      setRailFilters: (msg) => {
        this.saved.railFilters = normalizeSavedRailFilters(msg.railFilters);
        void this.memento?.update(STATE_KEY, this.saved);
        this.postRail(true);
      },
      // Apply one operation to the provider-owned sets. A panel can act before it receives a
      // peer's update without replacing that peer's membership state with an older snapshot.
      sessionMembership: (msg) => {
        this.updateSessionMembership(
          msg.action,
          'session' in msg ? msg.session : undefined,
          'openPinned' in msg && msg.openPinned === true,
        );
      },
      // The Timeline layout dialog writes the reader's setting. The configuration listener
      // sends its new value to every host. A refused write reaches the reader as an error message.
      setLayout: (msg) => {
        void saveTimelineLayout(msg.key, msg.value, writeSetting, (message) => {
          void vscode.window.showErrorMessage(message);
        });
      },
      saveState: (msg) => {
        this.saveState(msg.state);
      },
      // The panel sends its query on every keystroke and this decides whether any of it is a
      // search. Doing it here rather than in the panel keeps one copy of the rule: the panel
      // draws results when it is sent some and the ordinary list when it is not.
      search: (msg) => {
        const query = msg.text;
        this.waitingSearch = null;
        if (!isSearch(query)) {
          void this.post({ type: 'results', query, hits: null, scope: 'workspace' });
          return;
        }
        // A corpus walk during the cold pass would read on the main thread every opening record
        // the pass has not reached yet. The search waits for the pass, and only the latest
        // query that waited is answered.
        const priming = this.codexPriming;
        if (priming) {
          this.waitingSearch = query;
          void priming
            .catch(() => undefined)
            .then(() => {
              if (this.waitingSearch === query) {
                this.waitingSearch = null;
                this.answerSearch(query);
              }
            });
          return;
        }
        this.answerSearch(query);
      },
      loadOlder: (msg) => {
        // The session is named by the message, because a sentinel drawn by another panel
        // host can arrive after the reader moved on. A request for a session that is no
        // longer on screen would widen the newly selected one instead.
        const showing = this.hostSessions.get(host) ?? this.showing;
        if (!showing || msg.session !== showing) {
          return;
        }
        void this.loadOlderHistory(showing);
      },
      openLink: async (msg) => {
        if (!msg.href) {
          return;
        }
        // Ctrl, or Cmd on a Mac, asks for a group of its own, the same press a file row takes.
        await openLink(msg.href, msg.beside ? vscode.ViewColumn.Beside : this.column());
      },
      openVisualization: async (msg) => {
        if (!msg.path) {
          return;
        }
        await openVisualization(msg.path);
      },
      openImage: async (msg) => {
        if (!msg.path) {
          return;
        }
        // Ctrl, or Cmd on a Mac, asks for a group of its own, the same press a file link takes.
        await openImage(msg.path, msg.beside ? vscode.ViewColumn.Beside : this.column());
      },
      openTurnDiff: async (msg) => {
        const found = cardFor(msg.key);
        if (!found) {
          return;
        }
        const turn = this.turnsByKey.get(found.card.key);
        if (turn) {
          await this.openTurnDiff(found.sessionId, turn, found.card.headline, msg.beside);
        }
      },
      openCommit: async (msg) => {
        if (!cardFor(msg.key) || !msg.sha) {
          return;
        }
        if (this.canOpenCommit === null) {
          try {
            this.canOpenCommit = (await vscode.commands.getCommands(true)).includes('git.viewCommit');
          } catch {
            this.canOpenCommit = false;
          }
        }
        if (!this.canOpenCommit) {
          void vscode.window.showInformationMessage('Arc: This version of VS Code cannot open commits.');
          return;
        }
        const folder = msg.dir;
        if (!folder) {
          void vscode.window.showInformationMessage('Arc: The repository for this commit could not be identified.');
          return;
        }
        try {
          // `git.viewCommit` resolves its first argument only against repositories already
          // known to the built-in Git extension. A recorded external repository is safe to
          // register on demand because the reader resolved this exact directory from the call.
          await vscode.commands.executeCommand('git.openRepository', folder);
          await vscode.commands.executeCommand('git.viewCommit', vscode.Uri.file(folder), msg.sha);
        } catch {
          void vscode.window.showInformationMessage('Arc: This commit is no longer in the repository.');
        }
      },
      openFile: async (msg) => {
        const found = cardFor(msg.key);
        if (!found || !msg.path) {
          return;
        }
        const sourceSessionId = msg.sourceSessionId;
        if (
          sourceSessionId &&
          (found.card.kind !== 'turn' ||
            !found.card.dispatched?.some(
              (child) => child.sessionId === sourceSessionId && child.files?.some((file) => file.path === msg.path),
            ))
        ) {
          return;
        }
        const pending = this.pendingEntry(sourceSessionId ?? found.sessionId, msg.path);
        // Named group, never the default. Without one the diff opens wherever focus happens to
        // be, and once the panel is an editor tab of its own that is the panel's own
        // group: the reader's editor splits in two and the diff lands where the panel was.
        // Ctrl or Cmd asks for a group of its own instead, which is what the editor's own lists
        // do with the same press.
        const column = msg.beside ? vscode.ViewColumn.Beside : this.column();
        if (pending) {
          await vscode.commands.executeCommand(
            'vscode.diff',
            baselineUri(pending.snapshot, pending.path),
            vscode.Uri.file(pending.path),
            path.basename(pending.path),
            { viewColumn: column, preserveFocus: false },
          );
        } else {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), { viewColumn: column });
        }
      },
      openSkill: async (msg) => {
        const found = cardFor(msg.key);
        if (!found || found.card.kind !== 'turn' || !msg.path) {
          return;
        }
        // Only a path this card published. `openFile` opens the path it is handed, because
        // every path on a card's file list came off the same turn. A skill row must not widen
        // that to any path a message names, since the reader never saw one that is not here.
        if (!found.card.activitySkills.some((skill) => skill.path === msg.path)) {
          return;
        }
        // And only a file. A recorded skill that has since become a directory, a link to
        // nothing, or nothing at all opens no editor and says nothing: where the reader keeps
        // their skills is a fact about their disk rather than a fault they must dismiss.
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(msg.path, { throwIfNoEntry: false });
        } catch {
          return;
        }
        if (!stat?.isFile()) {
          return;
        }
        // The same column rule a file row takes, so a skill opens where a reader who pressed
        // one of those expects it.
        const column = msg.beside ? vscode.ViewColumn.Beside : this.column();
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), { viewColumn: column });
      },
    });
  }

  // Everything the panel remembers, on its way to storage that outlives one webview. A
  // webview's own `vscode.setState` goes when that webview does, so without this a tab
  // opened after the last one was closed starts with every card shut, no folds and no
  // filters, which reads as a different panel rather than the same one back.
  private saveState(state: unknown): void {
    const readBefore = this.readPrint();
    const stateBefore: ReadState = { read: this.saved.read, readTo: this.saved.readTo };
    // The drafts never travel in this state at all: the box posts each keystroke on its
    // own, and this side is the only place the typing is gathered. Taken from the saving
    // side they would be empty every time, so a host saving its folds would wipe a prompt
    // left half-written in another. Words the reader typed, like the notes below, rather
    // than a set they can rebuild by pressing something again.
    const drafts = this.saved.drafts;
    // The sent-but-unrecorded prompts are held for the drafts' own reason: this side is the
    // only place a send is gathered, so a host saving its folds would wipe a prompt no
    // transcript has recorded yet.
    const sentPrompts = this.saved.sentPrompts;
    const submittedPrompts = this.saved.submittedPrompts;
    const draftCommentIds = this.saved.draftCommentIds;
    // Browser saves can arrive after a provisional draft has adopted its durable id. The
    // provider-owned membership sets already made that move, so an older browser copy must
    // not replace them.
    const hidden = [...this.hidden];
    const pinnedTop = [...this.pinnedTop];
    // The webview draws attachment and queue state but never owns or posts it. Preserve
    // both across a save for the same reason as the draft they came from.
    const assets = this.saved.assets;
    const queues = this.saved.queues;
    // The notes are the exception, and they are held here rather than taken from whoever
    // saved last. Two hosts are two copies of the array, each seeded when its webview
    // loaded, so a note written in one never reaches the other and the other's next save
    // posts a set that never knew about it. The reader would watch a note they had typed
    // disappear. Every other field in this state is a set the reader can rebuild by
    // pressing the control again; a note is not.
    const notes = this.saved.comments;
    // The floor is held here for the same reason the notes are, and for one of its own: it
    // is written once and a panel that never received it would post a zero over it, which
    // hands the reader every old turn in the workspace as unread.
    const since = this.saved.since;
    // Held here for the notes' reason. The panel neither reads this record nor writes it,
    // so a save that carried the panel's answer would drop every session this window
    // started and file each one under Run by agents.
    const started = this.saved.started;
    // The labels are held for the reason the notes are, and for one of their own: the
    // extension owns them and no webview ever posts them, so the state arriving here
    // carries none at all. Taken from the saving side they would be empty every time. A
    // second host, opened before the reader filed anything, would write that empty set
    // over every label the first host had put on.
    const labels = this.saved.labels;
    const readerParents = this.saved.readerParents;
    // The saved views are held for the labels' reason. The panel posts them through a message
    // of its own, so a state save carries back the copy that panel was served, and a second
    // host opened before the reader made a view would write an empty list over every one of
    // them. Saved filters use the same ownership rule through a separate message. Their active
    // id, query, match, and order come from the saving side because they describe one
    // panel, and they are checked against the held list, because the saving side sends none.
    const views = this.saved.views;
    const railFilters = this.saved.railFilters;
    const showing = this.showing;
    this.saved = normalizePanelState(state, railFilters);
    this.saved.hidden = hidden;
    this.saved.pinnedTop = pinnedTop;
    this.saved.comments = notes;
    this.saved.since = since;
    this.saved.drafts = drafts;
    this.saved.sentPrompts = sentPrompts;
    this.saved.submittedPrompts = submittedPrompts;
    this.saved.draftCommentIds = draftCommentIds;
    this.saved.started = started;
    this.saved.labels = labels;
    this.saved.readerParents = readerParents;
    this.saved.views = views;
    this.saved.railFilters = railFilters;
    this.saved.showing = showing ?? '';
    this.saved.assets = assets;
    this.saved.queues = queues;
    void this.memento?.update(STATE_KEY, this.saved);
    // The read state moves when a card is opened, and nothing repaints on that, so the
    // rail is reworded here or it keeps counting turns the reader has just read.
    //
    // A selection is the exception. The panel moves the watermark of the card it opened and
    // saves it before the render that selection asked for has run, and that render words the
    // rail from this same read state. Rewording it here builds the whole payload a second
    // time for a rail that is already on its way. The skip is recorded, so the end of that
    // refresh posts the rail if no render did.
    if (readBefore === this.readPrint()) {
      return;
    }
    const counts = this.unreadCounts();
    const countsChanged = JSON.stringify([...counts]) !== this.lastRailCountsJson;
    if (this.railSeedOwedFor === this.selectionGeneration && readMovedOnlyFor(this.showing, stateBefore, this.saved)) {
      if (countsChanged) {
        this.railRevision++;
      }
      this.railSeedSkipped = true;
      return;
    }
    this.postRail(countsChanged, counts);
  }

  private shell(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return panelShell({
      cspSource: webview.cspSource,
      nonce,
      savedStateJson: scriptJson(webviewPanelState(this.saved)),
      style: STYLE,
      script: SCRIPT,
      developmentServerUrl: PANEL_DEV_SERVER_URL,
    });
  }
}

export function registerPanel(
  context: vscode.ExtensionContext,
  storeRootDir: string,
  workspaceCache: WorkspaceCachePartition,
  activationAt = performance.now(),
): PanelProvider {
  const output = vscode.window.createOutputChannel('Arc');
  output.appendLine(
    `Arc reads Claude sessions from ${projectsRoot()}. Arc reads Codex sessions from ${codexSessionsRoot()}.`,
  );
  // The two lines of glue the log needs from the editor: where the home directory is, and
  // what the setting says. Everything the log then decides is in `diagnosticslog.ts`.
  const diagnostics = createDiagnosticsLog({
    enabled: readSetting('diagnostics.log'),
    directory: path.join(arcHome(), DIAGNOSTICS_LOG_DIRECTORY),
    workspace: vscode.workspace.name ?? 'no folder',
    pid: process.pid,
    // When the extension host process started, which is what names the file and the identity.
    // Arc activates whenever something first asks for it, which is later than the window.
    startedAt: Math.round(performance.timeOrigin),
    measurementRun: process.env[MEASUREMENT_ENVIRONMENT.run],
  });
  const provider = new PanelProvider(
    storeRootDir,
    context.extensionUri,
    context.workspaceState,
    projectSpendDirectory(workspaceCache.root),
    path.join(workspaceCache.root, 'derived-session-cache.json'),
    path.join(cacheRoot(), 'codex-openings.json'),
    path.join(context.globalStorageUri.fsPath, 'prompt-assets'),
    output,
    diagnostics,
    workspaceCache,
    activationAt,
    path.join(arcHome(), 'startup'),
  );
  context.subscriptions.push(
    provider,
    vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, {
      provideTextDocumentContent: (uri) => provider.patches.get(uri.toString()) ?? '',
    }),
    // A press in the Command Palette passes nothing. A caller passes the file to write, and
    // anything that is not a string is the same as nothing.
    vscode.commands.registerCommand('arc.savePerformanceDiagnostics', (target?: unknown) =>
      provider.savePerformanceDiagnostics(typeof target === 'string' ? target : undefined),
    ),
    vscode.commands.registerCommand('arc.openDiagnosticsLog', () => provider.openDiagnosticsLog()),
    vscode.commands.registerCommand('arc.showProjectSpend', () => provider.showProjectSpend()),
    vscode.commands.registerCommand('arc.newSession', () => provider.newSession()),
    // The editor area takes a panel and nothing else, and only extension code can make one,
    // so this command is the way the panel is opened at all. From the tab it can be
    // dragged wherever the reader wants it, the side panes included.
    vscode.commands.registerCommand('arc.openInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('arc.openBeside', () => provider.openInEditor(vscode.ViewColumn.Beside)),
    // Without this the tab is gone after a window reload, with no way back but the command.
    // The editor restores the tab itself and hands the webview back here to be wired up.
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        await provider.revivePanel(panel, state);
      },
    }),
  );
  return provider;
}

// The panel's stylesheet and its browser script, which are two real files under
// `webview/` rather than text held in here.
//
// They were template literals in this file until they were 73% of it: 6,181 lines the
// compiler never read, the editor never highlighted, and no rename, no lint and no
// go-to-definition could reach. `CLAUDE.md` had already recorded what that cost, that the
// two literals were the least-checked code in the repo and that every regression this panel
// shipped landed inside them.
//
// `esbuild.mjs` reads both files and substitutes their text here, so what ships is still one
// bundle with the page inline. Nothing about the page itself moved: `shell` writes the same
// nonce policy, `SAVED_STATE` still goes in a script tag of its own ahead of the panel's,
// and neither file is fetched at load. A change to either needs a build before the panel
// shows it, which is the one habit the split asks for.
declare const PANEL_CSS: string;
declare const PANEL_JS: string;
declare const PANEL_DEV_SERVER_URL: string | null;

// What the two files ask this side for arrives by name rather than through an
// interpolation, because a plain file has no template literal around it. `paneltext.ts`
// holds the token shape, the table of values and what an unnamed token does; the table is
// there rather than here because both test files fill these same two files the same way,
// and a copy written out in each would let a guard pass against a value the page never
// gets.
const STYLE = fillPanelText(PANEL_CSS, panelValues());
const SCRIPT = fillPanelText(PANEL_JS, panelValues());
