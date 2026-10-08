import { MEASUREMENT_ENVIRONMENT } from './identity';
import { ContextDemand, unavailableContext, validContextDetail, type ContextIdentity } from './domain/context-detail';
import { createPanelVisibility } from './panelvisibility';
import type { WindowState } from './sessionrequests';
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
  claudeChildFileFor,
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
import { RepositoryCommits, nodeGitRunner, type GitRunner } from './gitcommits';
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
import { ClaudeChildWorkCache, liveTimelineChildren, outcomesFor, timelineRailState } from './timelinestate';
import {
  agentRunAnswer,
  sessionParentEdgeSet,
  sessionParentIndex,
  sessionParentOf,
  type SessionParent,
  type SessionParentEdge,
  type SessionParentEdgeSet,
  liveBackgroundCommands,
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
  dispatchedCostPrint,
  movedDispatchedCards,
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
  METADATA_EXHAUSTED_RULE,
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
import { SessionLoadingLine, type SessionLoadingBlocker, type SessionLoadingPath } from './sessionloadingline';
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

// The panel presents the session list and timeline. File views read recorded edits
// and first-touch snapshots. The webview supports variable-height turn cards.

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

// An early selected source with the repository scope, destination and working folder a delivery to it started under.
interface EarlyDelivery {
  source: SelectedSource;
  scope: string;
  destination: string;
  cwd: string | null;
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

// Each source adapter owns the cursor for its next older page. The provider passes
// it back to that adapter and drops it when the source revision changes.
type HistoryCursor = ClaudeHistoryCursor | CodexHistoryCursor;

// Turns and compactions share the timeline. Both render their summary as Markdown.
type RenderCard = (TurnCard | CompactionCard) & { summaryHtml: string };

// Escape less-than signs in JSON embedded in a script element. An unescaped
// closing script tag ends the element even when it occurs inside a JSON string.
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

// Retained diff text budget across the window. keepSides preserves every side of
// the current diff, so a single diff can exceed this budget.
const PATCH_BUDGET_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_WAKE_MAX_MS = 1_000;
const DERIVED_CACHE_CHECKPOINT_MS = 5 * 60 * 1000;

// Read the editor's mouse-navigation setting for the webview. The workbench's
// mouse listener does not receive events inside this frame.
function mouseNavigates(): boolean {
  return vscode.workspace.getConfiguration('workbench.editor').get<boolean>('mouseBackForwardToNavigate', true);
}

// Batch direct activity updates received within this interval into one post.
const LIVE_ACTIVITY_POST_MS = 150;
const LIVE_ACTIVITY_LIMIT = 60;
const LIVE_ACTIVITY_STALE_MS = 30 * 60 * 1000;

// Bound the session list's displayed name because every row travels in each
// render and session list post. Other surfaces retain their separate labels.
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

// Open a summary URL or workspace path with an optional line range. The supplied
// column keeps file navigation in the selected editor group.
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
  // Resolve each path before checking open-folder containment. Unresolved parent
  // segments can pass a prefix check while naming a file outside the folder.
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
      // Open images in the editor's image viewer because showTextDocument rejects them.
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
      /* Try the next workspace folder when this candidate cannot open. */
    }
  }
  void vscode.window.showInformationMessage(`Arc: no file at ${target} in this workspace.`);
}

// Open a response image in the editor's viewer. imagePathFor checks the path
// against open folders again and preserves literal percent signs in filenames.
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
      /* Skip extensions whose manifests cannot be read. */
    }
  }
  return contributions;
}

// Resolve the configured icon theme through its installed extension contribution.
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

// Cache the configured icon theme until it changes. Unavailable themes, invalid
// JSON, and missing fonts leave files with their lettered badges.
class IconThemeSource {
  private read = false;
  private theme: IconTheme | null = null;
  private themeDir: vscode.Uri | null = null;
  private themeRoot: vscode.Uri | null = null;
  // Cache installed language contributions separately from the selected icon theme.
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
      // Remove a byte-order mark before parsing the theme JSON.
      const text = fs.readFileSync(found.file.fsPath, 'utf8').replace(/^\uFEFF/, '');
      const theme = parseIconTheme(JSON.parse(text));
      if (!theme) {
        return;
      }
      // Exclude missing font sources so unresolved glyphs retain the lettered badge.
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

  // Build font-face rules with webview URIs after resolving the theme's font files.
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

// Focus commands for the editor's first eight groups. vscode.changes has no
// column option, so the target group must receive focus before it opens.
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
// Delay before an unsent prompt is saved to workspace storage.
const DRAFT_SAVE_MS = 1000;
const PANEL_TITLE = ARC_IDENTITY.productName;
const PANEL_OPTIONS = {
  retainContextWhenHidden: true,
  enableFindWidget: true,
} satisfies vscode.WebviewPanelOptions;

// Identify a newly created tab, a restored tab, or a replacement for a restored
// tab with stale panel options. Startup diagnostics retain this origin.
type PanelOrigin = 'created' | 'serializer' | 'serializer-replaced';

// The provider accesses its webview tab through this interface. WebviewPanel
// supports tabs in the editor area and the editor's side and bottom panes.
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

// Hold lifetime figures for the session list and heading separately from dispatched
// contributions used by turn cards. Either set can be absent independently.
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
  // Attached panel hosts, including tabs restored while another panel is open.
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
  // Native sources of selected sessions that the published catalog does not list. The selection path adds a source only while a
  // catalog is published, so while the catalog is null every reader finds none.
  private earlySelectedSources = new Map<string, SelectedSource>();
  private selectionFailure: { sessionId: string; generation: number; revision: FileRevision } | null = null;
  // The newest session menu's host. Native commands carry no webview identity.
  private detailsMenuArm: { host: PanelHost; session: string; browserSession: string; at: number } | null = null;
  private composerMenuArm: { host: PanelHost; at: number } | null = null;
  // Native selected-text commands carry no host identity. The armed host supplies the selected text.
  private selectedTextMenuArm: {
    host: PanelHost;
    session: string;
    key: string;
    at: number;
    copyLabels?: boolean;
  } | null = null;
  // The editor tab that the open command reveals on subsequent presses.
  private editorPanel: vscode.WebviewPanel | null = null;
  // The tab's adoption origin. Revealing the tab preserves this value.
  private editorPanelOrigin: PanelOrigin | null = null;
  // The column used by the last beside-opened diff. `besideColumn` checks whether it remains usable.
  private lastBeside: number | null = null;
  // Cache commit-viewer command availability on the first commit-opening request.
  private canOpenCommit: boolean | null = null;
  private cache = new Map<string, CacheEntry>();
  // Background commit reads refresh affected turns without delaying the initial render.
  private repositoryCommits = new RepositoryCommits(nodeGitRunner(), () => void this.refresh(true));
  private readonly repositoryScope: RepositoryScope;
  private repositoryScopeReady = false;
  private repositoryScopeRoots: string[] = [];
  // Codex child links from discovery. Cached child usage survives parent transcript growth.
  private codexSubagents: CodexSubagentFile[] = [];
  private claudeSpendSources: SessionSpendSource[] = [];
  private codexSpendSources: { file: string }[] = [];
  private sessionSpendSources: readonly SessionSpendSource[] = [];
  private readonly sessionSpendSourceIndex = new SessionSpendSourceIndex();
  private readonly subagentDirectories = new SubagentDirectoryCache();
  private readonly codexStats = new CodexStatCache();
  // Recorded working directories, keyed by transcript path. Missing values retry after the file revision changes.
  private cwds = new Map<string, { cwd: string | null; mtimeMs: number; size: number }>();
  // Cached Codex opening metadata, including each rollout's working directory.
  private codexMetas = new CodexMetaCache();
  // Saves `codexMetas` into the machine's shared opening records.
  private codexOpenings: CodexOpeningsWriter | null = null;
  // The first catalog refresh primes opening metadata before listing sessions. Refresh and search requests wait for this pass.
  private codexColdReads: (() => Promise<ColdOpeningPass>) | null = () =>
    coldOpeningPass(this.codexMetas, codexSessionsRoot());
  private codexPriming: Promise<ColdOpeningPass> | null = null;
  // The cold pass's rollout paths, consumed by the next `allSessions` call.
  private codexWalk: string[] | null = null;
  // The latest search query that arrived during the cold pass. Only it is answered after.
  private waitingSearch: string | null = null;
  // Titles and activity times share a revisioned read. Size or mtime changes invalidate the entry.
  private titles = new Map<string, DerivedTitleEntry>();
  private metadataRevision = 0;
  private drawnMetadataRevision = 0;
  // Names retained after cache invalidation until metadata supplies replacements. Only `sessionLabel` reads these fallback names.
  private carriedNames = new Map<string, CarriedName>();
  // Retain short and full Claude names from parsed tails, including titles outside the metadata window.
  private sessionNames = new SessionNames();
  // Defer the first metadata checkpoint until after rendering. Later checkpoints use a bounded rate, with a final write during disposal.
  private derivedCacheCheckpointTick: ReturnType<typeof setTimeout> | null = null;
  private derivedCacheCheckpointState = new DerivedCacheCheckpointState(Date.now());
  private metadataRecoverySession: string | null = null;
  private metadataRecoveryQueue: string[] = [];
  // Codex session names have a separate index. Renaming a quiet session does not change its rollout revision.
  private threadNames: ThreadNames = { stamp: '', names: new Map(), fullNames: new Map() };
  // Incremental human-prompt scan cursors for peer-wake filtering. A found prompt remains cached.
  private humanScans = new Map<string, HumanPromptScan>();
  // All listed Claude transcripts before peer-wake filtering. Cache trimming uses this list to retain filtered sessions' scan state.
  private walkedClaude: string[] = [];
  private claudeParents: SessionFile[] = [];
  private dispatchDiscoveryPending = false;
  // The repository scope of a complete discovery reply whose catalog is not yet published, and the session files of the catalog it
  // answered. An incomplete reply or a scope change clears it. The next catalog publication under that scope turns it into the
  // completion stamp only when the reply answered every published session.
  private discoveryComplete?: { scope: string; files: ReadonlySet<string> };
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
  // Parent relationships rebuilt when dispatch references or Claude or Codex children change. Selection reuses the index.
  private sessionParents: {
    references: readonly ClaudeChildSessionReference[];
    children: readonly ClaudeChildSessionFile[];
    codex: readonly CodexSubagentFile[];
    parents: ReadonlyMap<string, SessionParentEdge>;
  } | null = null;
  // Parent edges whose endpoints have catalog rows. Rebuilt when the parent index or catalog IDs change.
  private sessionParentEdgeSet: SessionParentEdgeSet | null = null;
  private dispatchFacts = new Map<string, DispatchSessionFacts>();
  private dispatchFiguresRevision = 0;
  private drawnDispatchFiguresRevision = 0;
  private claudeChildReferenceEntries = new Map<string, ClaudeChildReferenceCacheEntry>();
  private claudeChildren: ClaudeChildSessionFile[] = [];
  // Defer child-sensitive cache pruning until the first Claude child discovery completes.
  private claudeChildrenDiscovered = false;
  // The selected session ID, restored from panel state and reconciled by `pickShowing`.
  private showing: string | null = null;
  // Archived session IDs filter host reads. Panel state persists the set without deleting session data.
  private hidden = new Set<string>();
  // Pinned session ids control rail placement independently from selected turn reads.
  private pinnedTop = new Set<string>();
  // Retained older pages and their next cursors. Only the selected session reads pages, within the `historypages.ts` budget.
  private history = new Map<string, SessionHistory<HistoryCursor>>();
  // Child-only changes leave the parent transcript revision untouched. This stamp decides
  // when retained Codex pages need their child rows and spend projected again.
  private historyStructuralKeys = new Map<string, string>();
  // The one page read allowed to be in flight, and the generation that discards a result
  // whose session, transcript or provider moved while it ran.
  private historyRequest: { sessionId: string; controller: AbortController; generation: number } | null = null;
  private historyGeneration = 0;
  // The navigation trail shared by this provider's hosts. A window reload starts a new trail.
  private trail: Trail = emptyTrail();
  // Account usage and permission readings supplied by `extension.ts`. Rendering computes each reading's age.
  private usage: AgentUsage[] = [];
  private askLevels: Record<string, string> = {};
  private codexEffectiveModes: Record<string, CodexEffectiveMode> = {};
  private claudeEffectiveModes: Record<string, string> = {};
  // Live agent requests by session. Composer payloads retain them until the host accepts an answer.
  private asks: { session: string; ask: Ask }[] = [];
  // Model catalogs by agent and prompt settings by session.
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
  // Published prompt commands by agent. Sessions using one agent share its catalog in this folder.
  private commandLists: Record<string, PromptEntry[]> = {};
  // The last-seen Claude skill list for each working directory, as a normalized path key.
  // `extension.ts` owns loading, persisting, and replacing it.
  private skillLists: Record<string, readonly string[]> = {};
  // Claude skill paths by working directory and command name. The first lookup, including a missing path, remains cached for this provider.
  private claudeSkillPaths = new Map<string, string | null>();
  // MCP server readings by draft or session. `extension.ts` owns their agent processes.
  private mcpServers: Record<string, McpServer[]> = {};
  // Requests account usage through `extension.ts`. An explicit refresh carries `force` to retry an agent marked silent.
  private refreshUsageHandler:
    | ((agent: string | null, force: boolean, owner?: string, ownerAgent?: string, ownerCwd?: string) => void)
    | null = null;
  private initialCatalogRefreshPending = false;
  private initialCatalogRefreshRequested = false;
  // Requests data for a control the panel command already opened.
  public onPanelCommand:
    | ((owner: string, agent: string, control: string, draft: NewSessionDraft | null, cwd: string | null) => void)
    | null = null;
  public onDraftRemoved: ((draft: NewSessionDraft) => void) | null = null;
  public onDraftProfileChanged: ((draft: NewSessionDraft) => void) | null = null;
  public onDraftAdopted: ((provisional: string, actual: string) => void) | null = null;
  public onSelectionChanged: ((session: string | null, agent?: AgentKind | null, cwd?: string | null) => void) | null =
    null;
  public onPanelsClosed: (() => void) | null = null;
  // Delivers a prompt-settings menu choice with its agent, session, control, and selected value.
  public onPicked:
    | ((agent: string, session: string, control: string, value: string, model: string, cwd: string | null) => void)
    | null = null;
  // Sends to the named session and returns delivery status. Successful delivery removes submitted comments, while failure retains them for retry.
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
  // Renames through the session's agent. Resolution confirms the saved name, while rejection supplies the failure reason.
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
  // Unsent text by session, persisted in panel state. Host composer decisions read this copy.
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
  // Started sessions without discoverable records retain a row under their actual ID. Later sends resume the existing child.
  private awaitingSessionRecords: Record<string, AwaitingSessionRecord> = {};
  // Persisted IDs of sessions the reader started here. `agentRunFor` uses them to distinguish reader-started sessions from agent runs.
  private startedHere = new Set<string>();
  private draftProfiles: Record<string, SessionProfile> = {};
  private sessionOrigins: Record<string, DraftOrigin> = {};
  private recentProfiles: SessionProfile[] = [];
  private pinnedSetups: PinnedSetup[] = [];
  private pinnedSetupWrites: Promise<unknown> = Promise.resolve();
  // Draft saves begin on the first keystroke of a burst. Later keystrokes do not reset the timer.
  private draftSave: ReturnType<typeof setTimeout> | null = null;
  private queues: Record<string, QueuedSubmission[]> = {};
  private draftCommentIds: Record<string, string[]> = {};
  private queueHandoffs = new Set<string>();
  // Queues restored from storage or paused while their session is outside repository
  // scope. Each gets one drain attempt after its row and handoff callback are available.
  private pendingQueueDrains = new Set<string>();
  // Recently submitted prompts not yet available in the parsed record. This temporary history is not persisted.
  private sentPrompts: Record<string, string[]> = {};
  // Current prompt text by session. History navigation changes this copy without replacing the saved draft.
  private boxText: Record<string, string> = {};
  // Pending typed rename revisions. A failed rename restores text only while that revision still owns the draft.
  private typedRenames = new Map<string, number>();
  // Pending prompt and compaction activity by session, ordered oldest first. `pressesAfter` reconciles it with recorded turns.
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
  // Batches streamed reply chunks before posting them to the panel.
  private replyPost: ReturnType<typeof setTimeout> | null = null;
  // One watcher per directory a transcript is written to, so an append wakes the panel in
  // step with the agent rather than at the next poll.
  private watchers = new Map<string, fs.FSWatcher>();
  private readonly pendingWatch = new PendingWatcherWake();
  private readonly watchScheduler: BoundedTrailingScheduler;
  private refreshReason = 'direct';
  private targetedRefreshPaths: string[] | null = null;
  private watching = false;
  // Sessions running in children owned by `extension.ts`, keyed by `runningKey`.
  private running = new Set<string>();
  // Running start times bound live status claims against recorded completion. See `sessionStatusOf`.
  private runningSinceKeys = new Map<string, number>();
  // Latest child exit times by running key. Status checks apply each exit only to turns that began before it.
  private exitedSinceKeys = new Map<string, number>();
  private exitedNow = new Set<string>();
  // Claude child transcript write times used to determine live child status. Discovery trims unreferenced files.
  private claudeChildStatWrites = new Map<string, number>();
  private claudeChildWork = new ClaudeChildWorkCache();
  // Live child state used by the last card render. Clock-driven expiry can change it without a file revision.
  private drawnOpenChildren = '';
  // Reports agents whose parsed turns finished, including sessions started outside this window.
  public onTurnsFinished: ((agents: string[]) => void) | null = null;
  // Parsed turn completion markers and IDs already reported. Unfinished turns remain eligible for later completion.
  private turnMarks: TurnMark[] = [];
  private seenTurns: ReadonlySet<string> = new Set<string>();
  // The newest turn owns timeline outcome even when it has no usable composer figures.
  private newestBySession = new Map<string, Turn>();
  // The latest usable runtime fact for each Composer field. These are projected from the
  // accepted window without replacing the newest turn used by every timeline consumer.
  private composerRuntime = new Map<string, ComposerRuntimeFacts>();
  // Bounded recorded prompt history by session. `promptsAcross` includes prompts submitted outside the panel.
  private promptsBySession = new Map<string, string[]>();
  // The clock the cards were last built against. A turn's status can move on the clock alone,
  // so the refresh compares that reading with this one; see `statusMoved` below.
  private collectedAt = 0;
  // The newest compaction in each session, by session id. Its timestamp takes a live
  // card down, while its resulting context decides whether the composer has a current level.
  private newestCompactionBySession = new Map<string, Compaction>();
  private cards: RenderCard[] = [];
  // Selected-window byte coverage and turn limits. The history sentinel counts the tail and retained older pages together.
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
  // Cached turn references by card key. Diff views use their recorded patches.
  private turnsByKey = new Map<string, Turn>();
  // Session figures computed from parsed turns by `turnview.ts`.
  private statsBySession: Record<string, SessionStatChip[]> = {};
  // Immutable figures from bounded metadata reads supply session-list rows without selected-window reads.
  private metadataStatsBySession: Readonly<Record<string, readonly Readonly<SessionStatChip>[]>> = {};
  // Cache figures and cache marks against immutable session metadata facts.
  private readonly metadataStatFigures = new SessionFactFigures<HeldStatFacts, readonly Readonly<SessionStatChip>[]>();
  private readonly metadataCacheFigures = new SessionFactFigures<HeldStatFacts, ReturnType<typeof railCacheMarkOf>>();
  private parsedRailCaches: Record<string, RevisionedRailCacheMark> = {};
  private metadataRailCaches: Readonly<Record<string, ReturnType<typeof railCacheMarkOf>>> = {};
  private railSourceRevisions: Record<string, Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>> = {};
  // Immutable rows from the last catalog render. Replace the list to update an identity-cached session-list payload.
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
  // Session-list placement order, separate from activity-sorted catalog rows. Reconciliation preserves placement and appends newly discovered sessions.
  private railOrder: string[] = [];
  // The latest delivery that carried the rail, and its largest serialized message across
  // ready hosts. Complete renders can differ by host, while rail-only updates reuse one string.
  private lastRailMessageType: 'render' | 'rail' | null = null;
  private lastRailMessageSerializedBytes: number | null = null;
  private lastRailAdoptionsJson = '';
  // Session-list state increments this revision. An unchanged settled revision skips payload collection.
  private railRevision = 0;
  private lastRailRevision = -1;
  private lastRailDay = '';
  private lastRailCountsJson = '';
  // Inputs for the last session-list payload, including the local day. Matching inputs skip rebuilding it.
  private lastRailKey: RailInputKey | null = null;
  // Pending-source state used by the last session-list payload. A selection render can advance the figure cache independently.
  private railPendingAnswers: SpendPendingAnswers | null = null;
  // Selection render that owes a session-list update. A skipped save update is posted when that render settles without supplying it.
  private railSeedOwedFor: number | null = null;
  private railSeedSkipped = false;
  private sessionOutcomes = new Map<string, TurnOutcome | null>();
  // Selection-independent turn starts, projected from accepted metadata and lifetime facts.
  private windows = new Map<string, TurnStarts>();
  // Search entries by session file revision. Entries contain prompts and summaries without tool-result bodies.
  private corpus = new Map<string, { mtimeMs: number; size: number; entries: SearchEntry[] }>();
  private disposables: vscode.Disposable[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastSignature = '';
  private lastSpendSourceSignature = '';
  // Catalog and folder identity retained for selection refreshes. Filesystem refreshes replace this snapshot.
  private catalog: { folders: string; sessions: SessionFile[] } | null = null;
  // The existing-session list from the last payload that completed discovery and required
  // metadata. A working catalog can move while that work is still in flight. Local drafts
  // compose with this accepted list, or with no existing rows before the first publication.
  private authoritativeCatalog: SessionFile[] | null = null;
  // The repository scope roots the authoritative catalog was listed under. Only a list complete under these roots holds the loading line.
  private authoritativeCatalogScope?: string;
  // The repository scope roots under which the published catalog was built from a complete discovery reply. A catalog reused after an
  // incomplete pass keeps the stamp it had, and a scope change clears it. The session list is complete when it equals the current roots.
  private completeCatalogScope?: string;
  // The file and kind of each failed session read that is logged. A failed metadata, turn start, enrichment, or recovery read is logged
  // once per file and kind until that kind of read succeeds, and it never keeps the session list loading.
  private sessionReadFailures = new Set<string>();
  // Whether the latest catalog refresh read filesystem revisions. Project cost reuses those revisions only after a filesystem walk.
  private catalogWalked = true;
  // Diff sides by URI, in insertion order. The byte budget evicts the oldest entries.
  readonly patches = new Map<string, string>();
  private patchBytes = 0;
  // File icon theme cached until the editor reports a theme change.
  private icons = new IconThemeSource();
  private projectSpendWorkspace: string | null = null;
  // The workspace identity is available for the first render. Its persisted ledger is not
  // restored until that render has reached every ready host.
  private projectSpendHydrated = false;
  private projectSpendHydrationReady = false;
  private projectSpendHydrationTick: ReturnType<typeof setTimeout> | null = null;
  // Periodic spend-source checks supplement watcher events. Changed listings offer their sources immediately.
  private projectSpendLastOfferAt = 0;
  private projectSpendRevision = 0;
  private lifetimeFigures = new SessionFiguresCache<SessionHeldFigures, LifetimeFigures>();
  private dispatchedCardPrints = new Map<string, string>();
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
  // Performance counters share measurements with diagnostics. Disabled logging skips record construction.
  private readonly performanceCounters = new PanelPerformanceCounters(Date.now(), this.performanceSink());
  private readonly startupThresholds = new StartupThresholdWatch();
  // Panel loading's start time on the `performance.now()` clock. Startup thresholds measure elapsed time from this value.
  private panelStartedAt: number | null = null;
  private startupHistory?: StartupHistory;
  private startupCache: Record<string, unknown> = {};
  private startupArtifact: unknown = { unavailable: true };
  private startupProgressAt = 0;
  private startupProgressSequence = 0;
  private startupFailureGeneration = -1;
  private startupLoadingSent = '';
  // What the session-list loading line publishes. It holds the line hidden for the scope roots that completed the list, and it writes
  // each change of the line and each repository scope decision to the diagnostics log. The first use creates it.
  private loadingLineState?: SessionLoadingLine;
  private get loadingLine(): SessionLoadingLine {
    return (this.loadingLineState ??= new SessionLoadingLine((event, record) => this.diagnostics?.warn(event, record)));
  }
  // The latest accepted discovery checkpoint and the scope roots it belongs to. Pending loading statuses repeat its source count, so
  // a render or loading post that has no count of its own never replaces the counter the panel is showing. A scope change makes it stale.
  private startupSourceCheckpoint: {
    scope: string;
    checkpoint: import('./progressiveworker').DiscoveryCheckpoint;
  } | null = null;
  // The count last derived from a checkpoint, so a status post does not walk the catalog again while the checkpoint is unchanged.
  private startupSourceCounted: {
    checkpoint: object;
    key: string;
    count: { completed: number; known: number };
  } | null = null;
  private readonly warnedMessageBudgets = new Set<string>();
  private performanceOutput: vscode.OutputChannel | null = null;

  // Live panel state shared by attached hosts and persisted through the memento.
  private saved: PanelState = normalizePanelState(null);
  private windowStateHandler: ((state: WindowState) => void) | null = null;

  public setWindowStateHandler(handler: (state: WindowState) => void): void {
    this.windowStateHandler = handler;
    const scope = this.repositoryScope.snapshot(this.folders());
    this.repositoryScopeReady = scope.ready;
    this.repositoryScopeRoots = scope.ready ? scope.roots : [];
    this.publishWindowState();
  }

  private publishWindowState(): void {
    if (!this.windowStateHandler || this.disposed) return;
    this.windowStateHandler({
      folders: this.folders(),
      scopeReady: this.repositoryScopeReady,
      panelReady: this.readyHosts.size > 0,
      panelVisible: this.anyVisible(),
    });
  }

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
    this.repositoryScope = this.createRepositoryScope(nodeGitRunner());
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
      // Save seeded opening records even when the first walk finds no new entries.
      if (openings.seeded) {
        this.derivedCacheCheckpointState.markChanged(true);
      }
    }
    const stored =
      process.env[MEASUREMENT_ENVIRONMENT.blockAgents] === '1' && process.env[MEASUREMENT_ENVIRONMENT.state]
        ? JSON.parse(fs.readFileSync(process.env[MEASUREMENT_ENVIRONMENT.state]!, 'utf8'))
        : this.memento?.get(STATE_KEY);
    // Remove abandoned provisional-session labels before normalization.
    // Normalization also runs during writes, when active drafts must retain their labels.
    this.saved = normalizePanelState(withSweptDraftLabels(stored));
    // Initialize the unread floor only when the workspace has no saved state. Existing work then starts as read.
    // Save the floor immediately so reopening the window does not mark intervening turns as read.
    if (stored === undefined) {
      this.saved.since = Date.now();
      void this.memento?.update(STATE_KEY, this.saved);
    }
    // Restore rail visibility before the first payload. The panel also posts its saved state on load.
    this.hidden = new Set(this.saved.hidden);
    this.pinnedTop = new Set(this.saved.pinnedTop);
    // Restore the selected session before a ready host requests its first window.
    this.showing = this.saved.showing || null;
    // Copy restored drafts so typing does not mutate saved state before rememberDrafts runs.
    this.drafts = { ...this.saved.drafts };
    // Restore submitted prompts that the transcript has not recorded yet.
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
    this.windowStateHandler = null;
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
    // Abort the page read before its result updates a disposed provider.
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
    // Save pending draft text when disposal cancels its timer.
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

  // Poll while the panel is visible to detect transcript changes without a watcher event.
  private startPolling(): void {
    this.watching = true;
    if (this.poll) {
      return;
    }
    this.poll = setInterval(() => this.refreshFrom('poll'), POLL_INTERVAL_MILLISECONDS);
  }

  // Clear held rollout stats when polling stops. The next read must obtain fresh file revisions.
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

  // Watch the listed transcript directories and close watchers outside that list.
  // Polling also detects writes without watcher events, including network and synchronized files.
  // Idle Codex rollouts retain cached stats until CODEX_STAT_REVALIDATE_MS.
  // Clear held rollout stats when closing a watcher because it will report no further writes.
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
        // Remove a failed watcher and request a broad refresh. Windows can report an error when its directory disappears.
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

  // Schedule watcher refreshes in batches to avoid parsing the same file for each append.
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

  // Reveal the existing editor tab, or create and adopt one when none is held.
  openInEditor(column: vscode.ViewColumn = vscode.ViewColumn.Active, origin: PanelOrigin = 'created'): void {
    if (this.editorPanel) {
      // Log the revealed panel's original adoption source. This call does not adopt a panel.
      this.diagnostics.log('panelRevealed', { origin: this.editorPanelOrigin });
      this.editorPanel.reveal(column);
      return;
    }
    // A restored tab can arrive after this call creates a panel. adoptPanel handles the competing tabs.
    const panel = vscode.window.createWebviewPanel(
      // Enable the editor's find widget through PANEL_OPTIONS. Session filters and transcript search do not search the displayed text.
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

  // Retain the first panel-open time for this provider's startup milestones.
  private notePanelStart(): void {
    this.panelStartedAt ??= performance.now();
    this.startupHistory?.stage('panelOpened', this.panelStartedAt);
  }

  // Supply the diagnostics setting and event handler to the performance counters.
  private performanceSink(): PerformanceEventSink {
    return {
      enabled: () => this.diagnostics.enabled(),
      emit: (event, record) => this.routePerformanceEvent(event, record),
    };
  }

  // Route counted operations to diagnostics and startup history.
  // Report startup threshold breaches even when diagnostic logging is disabled.
  private routePerformanceEvent(event: string, record: Record<string, unknown>): void {
    if (event === 'startup' && typeof record.milestone === 'string' && typeof record.elapsedMs === 'number') {
      this.startupHistory?.stage(record.milestone, record.elapsedMs);
    }
    if (event !== 'startup' || typeof record.elapsedMs !== 'number') {
      this.diagnostics.log(event, record);
      return;
    }
    // Convert the host-relative milestone time to time since the panel opened.
    // Preserve elapsedMs for saved diagnostics and include panelElapsedMs when logging is enabled.
    const startedAt = this.panelStartedAt;
    if (startedAt === null) {
      // Skip thresholds without a panel-open time. The host-relative clock does not measure the panel's wait.
      if (this.diagnostics.enabled()) {
        this.diagnostics.log(event, record);
      }
      return;
    }
    const panelElapsedMs = Math.round(record.elapsedMs - startedAt);
    if (this.diagnostics.enabled()) {
      this.diagnostics.log(event, { ...record, panelElapsedMs });
    }
    // Ignore milestones without a configured startup threshold.
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

  // Return the saved snapshot path so callers can read the capture without watching its directory.
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
      // Log capture failures regardless of the diagnostics setting so unattended callers can identify a failed write.
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

  // Restore tabs whose saved options match PANEL_OPTIONS. Replace other tabs to apply the current options.
  // Retain submitted prompts in workspace storage before disposing the restored browser.
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
    // Identify the new tab as a serializer replacement in diagnostics.
    this.openInEditor(column, 'serializer-replaced');
  }

  // Adopt a created or restored editor tab and log its source for startup diagnostics.
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
    // Clear the editor-tab reference only when the disposed panel still owns it.
    panel.onDidDispose(() => {
      if (this.editorPanel === panel) {
        this.editorPanel = null;
        this.editorPanelOrigin = null;
      }
    });
    this.attach(panelHost(panel));
  }

  // Register editor listeners once per provider. Each listener operates on the current hosts.
  private wireEditorListeners(): void {
    // Apply configuration changes to the current hosts. Icon-theme changes also replace their allowed theme files.
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
    // Refresh icon variants when the editor switches between light and dark themes.
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => void this.refresh(true)));
    // Update permitted webview resource roots when workspace folders change.
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.workspaceFoldersChanged()));
  }

  // Builds the repository scope over a Git runner. A change of its roots runs repositoryScopeChanged, and each decision it makes about a
  // Git answer reaches the diagnostics log beside the loading line's records.
  private createRepositoryScope(runner: GitRunner): RepositoryScope {
    return new RepositoryScope(
      runner,
      () => this.repositoryScopeChanged(),
      Date.now,
      (decision) => this.loadingLine.scopeDecision(decision),
    );
  }

  // Runs on first scope readiness and whenever the repository scope roots change.
  private repositoryScopeChanged(): void {
    // A catalog listed under the previous roots cannot render the current scope.
    this.earlySelectedSources.clear();
    for (const work of this.selectionWorks.values()) work.controller.abort();
    this.selectionWorks.clear();
    this.selectionWork?.controller.abort();
    this.selectionWork = null;
    // A catalog completed under the previous roots never completes the new ones, even when the roots later return to it.
    this.discoveryComplete = undefined;
    this.completeCatalogScope = undefined;
    // Removing roots needs no new loading, so the hold stays unless the new roots add one outside the held scope.
    const scope = this.repositoryScope.snapshot(this.folders());
    if (this.windowStateHandler) {
      this.repositoryScopeReady = scope.ready;
      this.repositoryScopeRoots = scope.ready ? scope.roots : [];
      this.publishWindowState();
    }
    this.loadingLine.rescope(scope.ready ? JSON.stringify(scope.roots) : null, 'repository scope');
    this.abandonCatalogRefresh();
    this.refreshFrom('repository-scope', true);
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
    this.authoritativeCatalogScope = undefined;
    this.completeCatalogScope = undefined;
    this.sessionReadFailures?.clear();
    this.startupSourceCheckpoint = null;
    this.loadingLine.release('workspace folders');
    this.discoveryCheckpoint = undefined;
    this.discoveryCompleted = undefined;
    this.discoveryAcknowledgment = undefined;
    this.discoveryComplete = undefined;
    this.claudeChildReferenceEntries = new Map();
    this.enumeratedSpendSources = undefined;
    // Cancel catalog work started for different workspace folders.
    this.abandonCatalogRefresh();
    const scope = this.repositoryScope.snapshot(this.folders());
    if (this.windowStateHandler) {
      this.repositoryScopeReady = scope.ready;
      this.repositoryScopeRoots = scope.ready ? scope.roots : [];
    }
    this.publishWindowState();
    for (const open of this.hosts) {
      this.allowThemeFiles(open.webview);
    }
    void this.refresh(true);
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Register a panel host, its listeners, and its initial document.
  private attach(host: PanelHost): void {
    this.notePanelStart();
    this.hosts.push(host);
    if (this.showing) {
      this.hostSessions?.set(host, this.showing);
      this.hostPreviousSessions?.set(host, this.showing);
    }
    this.performanceCounters.registerPanel(host);
    this.allowThemeFiles(host.webview);
    // Dispose these listeners with their host instead of retaining them until provider shutdown.
    const mine: vscode.Disposable[] = [
      host.webview.onDidReceiveMessage((msg) => void this.onMessage(msg, host)),
      host.onDidChangeVisibility(() => {
        if (!this.readyHosts.has(host)) {
          return;
        }
        this.publishWindowState();
        void this.sendToHost(host, this.panelVisibility.current(host, host.visible()));
        // Keep polling while any ready host remains visible. Stop polling when no ready host is visible.
        if (this.anyVisible()) {
          void this.refresh(true);
          this.startPolling();
          // Request account and catalog updates when a ready host becomes visible.
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
        this.publishWindowState();
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
        // Discard temporary prompt history selections when the last host closes. Stored drafts remain available.
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
    this.publishWindowState();
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

  // Start delivery to every host before awaiting completion to preserve message call order.
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
    // Post before measuring the message. Serialize only message kinds with a byte budget.
    // Count other message kinds without byte measurements.
    const posted = host.webview.postMessage(message);
    const budget = messageByteBudget(kind);
    const serializedBytes = budget === null ? null : serializedMessageBytes(message);
    this.performanceCounters.recordMessage(kind, serializedBytes, host);
    measured?.(serializedBytes);
    if (serializedBytes !== null && budget !== null && serializedBytes > budget) {
      // Log each budget breach when diagnostics are enabled. Warn once per message kind with its largest field sizes.
      if (this.diagnostics.enabled()) {
        this.diagnostics.log('budgetBreach', { kind, bytes: serializedBytes, budgetBytes: budget });
      }
      if (!this.warnedMessageBudgets.has(kind)) {
        this.warnedMessageBudgets.add(kind);
        this.performanceOutput ??= vscode.window.createOutputChannel('Arc');
        // Exclude session list fields because render and session list measurements already serialize them.
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

  // Build the usage status bar with the current clock so reading ages and reset times stay current.
  private usagePayload(webview?: vscode.Webview): unknown {
    const state = this.composerState(webview);
    return this.usagePayloadFromState(state);
  }

  private usagePayloadForSession(session: string | null, webview?: vscode.Webview): unknown {
    const state = this.composerStateFor(session, webview);
    return this.usagePayloadFromState(state);
  }

  private usagePayloadFromState(state: ComposerState | null): unknown {
    // Build menus from the same prompt box state as their controls and include them in the payload.
    // Only provisional drafts receive an agent menu.
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

  // Build prompt box state for the selected session, or the first shown row when no session is selected.
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

  // Build prompt box state for a specified session, including sessions outside the current view.
  // A published catalog that omits an early selected source rejects it, except for locally started sessions.
  private stateFor(session: string): ComposerState | null {
    if (!this.repositoryScopeReady) {
      return null;
    }
    if (
      this.authoritativeCatalog &&
      this.earlySelectedSources?.has(session) &&
      !this.authoritativeCatalog.some((source) => source.sessionId === session) &&
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

  // Resolve the session's working directory without a workspace-folder fallback.
  // Claude skill lists use this directory to avoid displaying another project's skills.
  private ownCwdForSession(agent: string, sessionId: string): string | null {
    const session = this.catalog?.sessions.find(
      (candidate) => candidate.agent === agent && candidate.sessionId === sessionId,
    );
    const early = this.earlySelectedSources?.get(sessionId);
    return (
      session?.cwd ??
      (early?.agent === agent ? early.cwd : undefined) ??
      this.newDrafts[sessionId]?.cwd ??
      this.awaitingSessionRecords[sessionId]?.cwd ??
      null
    );
  }

  // The early selected source of a session the catalog does not list yet. Delivery to it validates the source first.
  private unlistedEarlySource(session: string): SelectedSource | undefined {
    const early = this.earlySelectedSources?.get(session);
    if (!early || this.authoritativeCatalog?.some((source) => source.sessionId === session)) return undefined;
    return early;
  }

  // Captures an unlisted early selected source with the repository scope, destination and working folder its delivery
  // starts under. Delivery captures it before the prompt is saved, so a change during the save cannot skip validation.
  private captureEarlyDelivery(session: string, agent: string, destination: () => string): EarlyDelivery | undefined {
    const source = this.unlistedEarlySource(session);
    if (!source) return undefined;
    return {
      source,
      scope: JSON.stringify(this.repositoryScopeRoots),
      destination: destination(),
      cwd: this.cwdForSession(agent, session),
    };
  }

  // Validates a captured early delivery after the prompt is saved. It fails when the source no longer validates, or when the
  // repository scope, the destination session or the working folder moved, or the early source left without the catalog
  // listing the session.
  private async earlyDeliveryStillValid(
    session: string,
    agent: string,
    early: EarlyDelivery,
    destination: () => string,
  ): Promise<boolean> {
    const unchanged = () =>
      this.repositoryScopeReady &&
      JSON.stringify(this.repositoryScopeRoots) === early.scope &&
      destination() === early.destination &&
      (this.earlySelectedSources.get(session) === early.source ||
        this.authoritativeCatalog?.some((source) => source.sessionId === session) === true) &&
      this.cwdForSession(agent, session) === early.cwd;
    if (!unchanged()) return false;
    const valid = await validateSelectedSource(early.source, this.repositoryScopeRoots, new AbortController().signal);
    return valid !== null && unchanged();
  }

  private recordedCwdForSession(agent: string, sessionId: string): string | null {
    const session = this.catalog?.sessions.find(
      (candidate) => candidate.agent === agent && candidate.sessionId === sessionId,
    );
    return session?.cwd ?? null;
  }

  // Preserve published command paths and add available Claude skill definition paths.
  // Search project skills before Claude's configured home when a command has no published path.
  // Cache lookup results by session directory and command name, including missing definitions.
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
    // Render the frozen draft profile that `send` supplies to the child-launch callback.
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
      // Claude commands include skill paths resolved for this working directory. Codex supplies paths in its catalog.
      commands: row.agentKey === 'claude' ? this.claudeCommandsFor(claudeCwd) : (this.commandLists[row.agentKey] ?? []),
      // Null means no Claude skill list has arrived. A reported empty list remains distinct from that fallback.
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
      // Draw context only when the accepted runtime includes a model window size.
      contextGeneration: this.contextGenerations?.get(row.id) ?? 0,
      context: runtime?.context?.window ? { used: runtime.context.tokens, max: runtime.context.window } : null,
      // The accepted runtime supplies estimated next-turn cost, retaining compaction precedence.
      nextTurn: runtime?.nextTurn ?? null,
      // Pending live activity for this session, projected into cards by `composerview.ts`.
      live: this.live[row.id] ?? [],
      asks: this.asks.filter((entry) => entry.session === row.id).map((entry) => entry.ask),
    };
  }

  // Update account figures without reading transcripts.
  public setUsage(usage: AgentUsage[]): void {
    this.usage = usage;
    void this.post({ type: 'usage', usage: this.usagePayload() });
    this.postProjectSpend();
  }

  // Update permission levels through the account and composer payload.
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

  // Update request forms and affected session-list statuses without reading transcripts.
  public setAsks(asks: readonly { session: string; ask: Ask }[]): void {
    const next = asks.map((entry) => ({ session: entry.session, ask: entry.ask }));
    if (JSON.stringify(next) === JSON.stringify(this.asks)) {
      return;
    }
    this.asks = next;
    void this.post({ type: 'usage', usage: this.usagePayload() });
    this.postRail(true);
  }

  // Replace model catalogs and their pending state, then refresh the panel.
  public setModels(models: Record<string, ModelChoice[]>, pending: readonly string[] = []): void {
    this.models = models;
    this.pendingModels = pending;
    void this.refresh();
  }

  // Update MCP server readings for each draft or session.
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

  // A chosen setup creates a local draft and focuses the prompt box. Without a usable setup, open the setup menu.
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

  // Open a labelled draft in the host that armed the native session menu.
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

  // Create local draft state from the launcher's ID and captured profile.
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
    // Retry eligible account and server reads for the draft's agent.
    this.refreshUsageHandler?.(profile.agent, false, draftId, profile.agent, draft.cwd);
    void this.refresh(true, true, true, true);
    return draft;
  }

  public abandonDraft(draftId: string, repaint: boolean = true): boolean {
    const removed = this.newDrafts[draftId];
    if (!removed) {
      return false;
    }
    // `handChanged` records reader changes. A custom launch profile alone does not retain an untouched draft.
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
    // Remove labels for the abandoned draft so they occupy no stored session slot.
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
    // Replace the provisional ID in navigation before catalog reconciliation removes it.
    this.trail = renamePlace(this.trail, provisional, actual);
    this.awaitingSessionRecords[actual] = {
      sessionId: actual,
      createdAt: draft.createdAt,
      agent: draft.profile.agent,
      cwd: draft.cwd,
    };
    // Persist reader-started ownership after the temporary awaiting-record row disappears.
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
    // Move labels to the actual session ID before persisting draft adoption.
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

  // Rebuild the frozen draft with its changed profile. Child launch reads this same profile.
  private pickOnDraft(session: string, control: string, value: string): void {
    const profile = this.draftProfiles[session];
    const draft = this.newDrafts[session];
    if (!profile || !draft) {
      return;
    }
    // Reject setup changes after the first prompt starts delivery. The launch callback already holds its profile.
    if (draftStarted(this.live[session] ?? [])) {
      return;
    }
    // `draftProfileAfterPick` validates values against the available prompt settings.
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
    // Retain a draft after an actual setup change. Selecting the current value leaves `handChanged` unchanged.
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
    // Agent changes require a new session-list row. Other setup changes update only the composer payload.
    if (next.agent !== profile.agent) {
      void this.refresh(true);
      return;
    }
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Replace published prompt commands for the slash menu.
  public setCommands(commands: Record<string, PromptEntry[]>): void {
    this.commandLists = commands;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Replace per-directory Claude skill lists used by prompt highlighting.
  public setSkills(skills: Record<string, readonly string[]>): void {
    this.skillLists = skills;
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Update running sessions by `runningKey`. An agent can run several sessions simultaneously.
  public setRunning(keys: readonly string[]): void {
    const next = new Set(keys);
    const moved = next.size !== this.running.size || [...next].some((key) => !this.running.has(key));
    // New running keys receive a start time. Removed keys discard it before a later run.
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
    // Running status does not confirm prompt delivery. Reconcile live activity before removing completed entries.
    this.markStartedPresses();
    this.dropSpentPresses();
    void this.post({ type: 'usage', usage: this.usagePayload() });
    // Refresh cards and the session list only when running membership changes.
    if (moved) {
      void this.refresh(true);
    }
  }

  // Record exited hosted sessions by `runningKey` and refresh their status.
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

  // Apply `pressesAfterRunning` to live activity using each session's current running state.
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

  // Remove live activity completed by recorded turns, compactions, or running-state changes.
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

  // Remove locally answered commands through `pressesAfterLocalAnswer`. Their reply appears as a temporary composer notice without a transcript card.
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

  // Transfer unfinished state to the session created by `/clear`. Completed responses remain with the source, while the successor receives an awaiting-record row.
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
    // Copy labels to the successor. Refresh the source's insertion order first so capacity eviction does not remove it.
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
    // Refresh the filesystem catalog so the new successor can be discovered.
    void this.refresh(true);
  }

  // Create live activity before delivery. Its timestamp identifies the submission when asynchronous answers arrive.
  private noteLive(state: ComposerState, kind: LiveKind, text: string, assets: StoredPromptAsset[] = []): number {
    // Classify the new prompt against existing activity before replacing it.
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

  // Append reply text to the submitting session's live prompt. Delivery ownership retains early responses and rejects unowned events.
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

  // Post live cards without redrawing the prompt box or its controls.
  private postReply(): void {
    for (const host of this.hosts) {
      const state = this.composerStateFor(this.hostSessions?.get(host) ?? this.showing, host.webview);
      if (!state) {
        continue;
      }
      // Each host receives live cards for its selected session.
      const view = composerView(state);
      if (!view?.live.length) {
        continue;
      }
      void this.sendToHost(host, { type: 'live', session: state.sessionId, live: view.live });
    }
  }

  // Update an existing card with live activity. A missing recorded card requires a full refresh.
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
    // Ignore answers for a submission that no longer has a matching live timestamp.
    if (!held?.some((press) => press.at === at)) {
      if (delivery.turnId !== undefined) this.forgetPendingResponses(delivery.turnId);
      // Confirmed delivery still selects its destination after the temporary card disappears.
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

  // Dismiss only failed live activity of the requested kind. Pending deliveries remain visible.
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

  // Restore a failed prompt to its saved draft and focus the prompt box. Compactions have no prompt text to restore.
  private restoreLive(session: string, kind: string): void {
    const held = this.live[session];
    const press = held?.find((one) => one.kind === kind && one.kind === 'prompt' && one.failed);
    if (!press) {
      return;
    }
    // Persist recovered text before removing the failed card.
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

  // Deliver the session's oldest eligible queued submission when it is idle.
  public flushQueue(session: string): void {
    // Drain the caller's session, independent of the session displayed in the prompt box.
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
    // The membership test keeps a queue without early sources off the capture.
    const destination = () => this.panelSession(state.sessionId);
    const early = this.earlySelectedSources?.has(state.sessionId)
      ? this.captureEarlyDelivery(state.sessionId, state.agent, destination)
      : undefined;
    void this.writeDrafts()
      .then(() => {
        const handOff = (deliverable: boolean): Promise<void> | undefined => {
          // A refused early source keeps the prompt waiting for the next drain.
          if (!deliverable) {
            this.queueHandoffs.delete(next.id);
            this.pendingQueueDrains.add(state.sessionId);
            this.queues[state.sessionId] = (this.queues[state.sessionId] ?? []).map((entry) =>
              entry.id === next.id ? { ...entry, delivery: { phase: 'queued', owner: state.sessionId } } : entry,
            );
            return this.writeDrafts();
          }
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
        };
        // An early selected source that the catalog did not list when the drain began validates again after the save.
        return early
          ? this.earlyDeliveryStillValid(state.sessionId, state.agent, early, destination).then(handOff)
          : handOff(true);
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

  // Use the session named by the typing message. `keep` is the saved draft, while `text` includes prompt-history navigation.
  private setDraft(text: string, keep: string, session: string): void {
    // Check row membership without assembling the complete composer state on each keystroke.
    if (!this.rowForSession(session)) {
      return;
    }
    this.typedRenames.delete(session);
    const shown = hasUnsentPrompt(this.boxText[session] ?? '') !== hasUnsentPrompt(text);
    // Set displayed text after `holdDraft`, which initially writes both text copies.
    const railMoved = this.holdDraft(session, keep);
    this.boxText[session] = text;
    this.clearAttachmentNotice(session);
    if (shown || railMoved) {
      void this.post({ type: 'usage', usage: this.usagePayload() });
    }
  }

  // Persist ordinary typing later and recovered text immediately. Session-list updates follow changes in meaningful draft content.
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
    // Reset displayed text with the saved draft. `setDraft` overrides this copy during history navigation.
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

  // Batch ordinary draft persistence. Provider disposal writes remaining text.
  private rememberDrafts(): void {
    if (this.draftSave) {
      return;
    }
    this.draftSave = setTimeout(() => {
      this.draftSave = null;
      void this.writeDrafts();
    }, DRAFT_SAVE_MS);
  }

  // Persist reader-started ownership immediately, bounded by `SESSION_LIMIT`.
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
    const early = state
      ? this.captureEarlyDelivery(session, state.agent, () => this.panelSession(source, host))
      : undefined;
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
        captured &&
        early &&
        !(await this.earlyDeliveryStillValid(session, captured.agent, early, () => this.panelSession(source, host)))
      ) {
        restore();
        return;
      }
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

  // Route Send through the send-or-queue rules in `composerview.ts`.
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
    // Handle typed Codex `/rename` outside prompt delivery. Leave attachments, comments, and queued recovery available for the next prompt.
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
    // Open panel-owned commands locally and clear their typed text.
    const opens = panelCommand(text);
    if (opens) {
      this.holdDraft(state.sessionId, '');
      void this.post({ type: 'openPick', control: opens });
      void this.post({ type: 'usage', usage: this.usagePayload() });
      // Open the control before asking its agent process for the contents.
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
      // Restore the browser's cleared text with its exact submission revision when host state refuses Send.
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

  // Answer this session's blocking requests when `asksAnsweredBySend` permits it. The prompt that follows carries the reader's answer.
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
    // Recognize control commands before assembling ordinary prompt text and comments.
    if (compactSubmission(state.agent, text) && !queued) {
      this.startCompaction(state, queued);
      return;
    }
    if (clearSubmission(state.agent, text) && !queued) {
      this.startClear(state, queued);
      return;
    }
    // Add ordinary outgoing prompts to recall history after local-command and queue handling.
    this.sentPrompts[state.sessionId] = sentAfter(this.sentPrompts[state.sessionId] ?? [], text);
    // Capture submitted comments before delivery. Later comments remain available for another prompt.
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
    // Live cards use the assembled prompt, including comment-only and attachment-only submissions.
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
    // Delivery status controls live-card settlement and removal of submitted comments.
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

  // Remove only the comments carried by a delivered prompt.
  private dropCarriedComments(carried: readonly TurnComment[], delivered: boolean): void {
    const left = commentsAfterSend(this.saved.comments, carried, delivered);
    if (left.length === this.saved.comments.length) {
      return;
    }
    this.saved.comments = left;
    void this.memento?.update(STATE_KEY, this.saved);
    // Update every attached host's comment copy.
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

  // `ended` names one turn a result closed, or every turn an idle report settled.
  public releaseDeliveredPromptAssets(session: string, all: boolean = false, ended?: number | readonly number[]): void {
    if (all) {
      this.assetCompletions.complete(session);
    }
    const batches = this.deferredAssetDeletes[session] ?? [];
    const batchTurnIds = batches.map((batch) => batch.turnId);
    const release = promptAssetReleaseIndexes(batchTurnIds, all, ended);
    // A turn whose batch is not booked yet releases that batch when it arrives.
    const endedTurnIds = ended === undefined ? [] : typeof ended === 'number' ? [ended] : ended;
    if (!release.length || !all) {
      for (const id of endedTurnIds) {
        if (!batchTurnIds.includes(id)) this.completedAssetTurns.add(id);
      }
    }
    if (!release.length) {
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

  // Request compaction without submitting or clearing the draft, attachments, or comments.
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
    // Create an empty live compaction card before agent delivery.
    const pressed = this.noteLive(state, 'compact', '');
    // Settle the compaction card from delivery status, retaining failures for the reader.
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

  // Reserve a queued submission for editing in the prompt box. Transfer it only after the browser accepts the offer.
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
    // Exchange the queued submission with active draft content so neither prompt is overwritten.
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
    // The browser accepted the prompt text before this composer update.
    void this.post({ type: 'usage', usage: this.usagePayload() });
  }

  // Broadcast turn read-state changes to all attached hosts.
  public setRead(key: string, read: boolean): void {
    void this.post({ type: 'setRead', key, read });
  }

  // Broadcast the comment-editor request. Only the host with a matching context-menu selection opens it.
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

  // Broadcast the label-editor request to the host with the matching context-menu selection.
  public openLabelEditor(session: string): void {
    void this.post({ type: 'openLabelEditor', session });
  }

  // Broadcast the view-editor request and mode. The host with the matching context-menu selection opens it.
  public openViewEditor(view: string, mode: 'rename' | 'delete'): void {
    void this.post({ type: 'openViewEditor', view, mode });
  }

  // Open renaming for a catalog session using its full name.
  public openSessionRename(sessionId: string): void {
    const session = this.catalog?.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) {
      return;
    }
    void this.post(sessionRenameOpening(sessionId, this.sessionLabel(session)));
  }

  // Publish a renamed session only after the agent confirms success. Its ID remains unchanged.
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

  // Restore a failed typed rename only while its submission revision still owns the draft.
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

  // Observe confirmed Claude names at the final byte so later rename records supersede them. Codex names reload from the session index.
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

  // Build label-editor rows from provider-owned labels and catalog sessions.
  private labelEditorReply(session: string, browserSession: string = session): unknown {
    return labelEditorReply(this.saved.labels, this.sessionRows, session, CARD_ACTIONS.labelHeading, browserSession);
  }

  // Copy one turn's comments through `emitTurnComments`. An empty result leaves the clipboard unchanged.
  public async copyComments(turnKey: string, session: string): Promise<void> {
    const notes = emitTurnComments(this.saved.comments, turnKey, session);
    if (!notes) {
      return;
    }
    await vscode.env.clipboard.writeText(notes);
    void vscode.window.setStatusBarMessage('Arc: copied.', 1500);
  }

  // Broadcast session read-state changes to all attached hosts.
  public setSessionRead(session: string, read: boolean): void {
    void this.post({ type: 'setSessionRead', session: this.panelSession(session), read });
  }

  // Update durable archive membership through the provider, including actions targeting a provisional session ID.
  public setSessionArchived(session: string, archived: boolean): void {
    this.updateSessionMembership(archived ? 'archive' : 'unarchive', session);
  }

  // Update durable pin membership through the provider.
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

  // Copy the card summary when its key and summary are available.
  public async copySummary(key: string): Promise<void> {
    const card = this.cards.find((c) => c.key === key);
    if (!card || !card.summary) {
      return;
    }
    await this.copyText(card.summary);
  }

  // Reset panel preferences after confirmation. Clear host state before instructing browsers to save their reset copies.
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
    // Existing activity predates the reset unread baseline.
    this.saved.since = Date.now();
    // Preserve unsent prompt text across preference resets.
    this.saved.drafts = normalizeDrafts(this.drafts);
    // Preserve submitted prompt recall until the record contains it.
    this.saved.sentPrompts = normalizeSentPrompts(this.sentPrompts);
    // Preserve reader-started session ownership across preference resets.
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
    // Let the next refresh select the newest available session.
    this.showing = null;
    this.hostSessions.clear();
    this.hostPreviousSessions.clear();
    // Clear navigation history with the selection.
    this.trail = emptyTrail();
    await this.memento?.update(STATE_KEY, this.saved);
    // Invalidate the previous session-list payload before reset state is posted.
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

  // Walk the panel's navigation trail first. At its boundary, delegate to the editor's navigation command.
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

  // Select a reader-chosen session after abandoning any untouched draft being left.
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
    // Selection refreshes reuse the catalog because navigation changes no transcript.
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

  // Post any session-list update deferred for a selection render that did not settle it.
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

  // Choose the editor column through `editorColumn` using current editor and panel locations.
  private column(): vscode.ViewColumn {
    return editorColumn({
      active: vscode.window.activeTextEditor?.viewColumn ?? null,
      visible: vscode.window.visibleTextEditors
        .map((e) => e.viewColumn)
        .filter((c): c is vscode.ViewColumn => c !== undefined),
      panel: this.editorPanel?.viewColumn ?? null,
    });
  }

  // Permit extension, icon-theme, workspace, and staged-attachment resources. Assign webview options without replacing the page.
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

  // Forced refreshes repaint unchanged content. Catalog reuse skips discovery for selection and accepted worker updates.
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
    // Merge concurrent catalog refresh triggers into one pending request so active reads can finish.
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
          // Mark cold-pass metadata for persistence because its reads precede the catalog's revision comparison.
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
      // Wait for repository scope before changing selection or creating a draft from an incomplete catalog.
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
        const catalogScope = JSON.stringify(this.repositoryScopeRoots);
        this.authoritativeCatalog = all;
        this.authoritativeCatalogScope = catalogScope;
        const answered = this.discoveryComplete?.scope === catalogScope ? this.discoveryComplete.files : undefined;
        if (answered && all.every((session) => answered.has(session.file))) {
          this.completeCatalogScope = catalogScope;
        } else if (answered) {
          // The catalog was listed again with a session the complete reply never answered. Discovery runs again before the list
          // completes, and the follow-up refresh this schedules lets the line clear.
          const discoveryWaiting = this.dispatchedDiscoveryWaiting();
          this.dispatchDiscoveryPending = true;
          if (this.dispatchedDiscoveryWaiting() !== discoveryWaiting) this.postDispatchedCostsIfMoved();
        }
        this.discoveryComplete = undefined;
      }
      const recorded = new Set(all.map((session) => session.sessionId));
      for (const session of Object.keys(this.awaitingSessionRecords)) {
        if (!selectedOnly && recorded.has(session)) {
          delete this.awaitingSessionRecords[session];
        }
      }
      // Publish early selected sources in every render. Selected revalidation returns the catalog without them.
      all = [
        ...all,
        ...[...(this.earlySelectedSources?.values() ?? [])].filter((source) => !recorded.has(source.sessionId)),
      ];
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
      // Update watched directories when discovery finds new sessions.
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
      // Reconcile navigation with reachable sessions and record the settled selection.
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
      // Read the Codex name index before computing the listing signature. Renames do not change rollout revisions.
      this.threadNames = readThreadNames(codexSessionIndexPath(), this.threadNames);
      const children = this.agentListingStamp(sessions);
      // Listing signatures include selection. Spend-source signatures exclude selection so navigation alone starts no source integrity pass.
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
      // Reconcile expired compaction activity before deciding whether to render. Removed activity requires an update.
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
          this.postSessionLoading(generation, controller.signal);
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
      // Build rows for the full catalog, independent of selected transcript reads.
      const counts = this.unreadCounts();
      const fullLabels = new Map<string, string>();
      this.pruneExits(all);
      this.sessionRows = all.map((f) => {
        // Use recorded activity time, with mtime only when metadata has no timestamp.
        const at = this.activityFor(f);
        const named = this.sessionLabel(f);
        const label = named.label;
        fullLabels.set(f.sessionId, named.fullLabel);
        // Bound session-list names by `RAIL_NAME_LIMIT`. Other session surfaces retain the short label.
        const railName = shortenTo(named.fullLabel, RAIL_NAME_LIMIT, '...');
        return {
          id: f.sessionId,
          persisted: true,
          label,
          ...(railName === label ? {} : { railName }),
          // Use the shared calendar formatter for session activity.
          when: formatWhen(at),
          // `agent` is the displayed name. `agentKey` identifies catalogs, prompt settings, and agent callbacks.
          agent: AGENT_NAMES[f.agent],
          agentKey: f.agent,
          shown: sessions.some((s) => s.sessionId === f.sessionId),
          // The browser's age ticker reads `at`. Unread counts remain independent session-list facts.
          at,
          relative: formatRelative(at),
          // Classify agent runs from accepted metadata and parent ownership.
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
      // Recompute expired cache marks so the cached value becomes null.
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
      // Resource URIs and icon fonts are resolved separately for each host.
      const light = isLightColourTheme();
      if (!selectedOnly) {
        this.performanceCounters.recordRefreshStage('rendered');
      }
      let largestRenderBytes: number | null = null;
      // The session list decides when the source count ends and when the loading line starts its hold, once for every panel.
      // The walk that names the list's first blocker also decides its state, so a withheld render reads its reason without a second walk.
      const listBlocker = this.sessionLoadingBlocker(generation);
      const listLoading = this.sessionLoadingState(generation, listBlocker);
      const loadingScope = JSON.stringify(this.repositoryScopeRoots);
      this.settleSourceCount(listLoading);
      if (listLoading.complete && this.authoritativeCatalogScope === loadingScope)
        this.loadingLine.hold(loadingScope, generation, selectedOnly ? 'selection' : 'render');
      const metadataAcceptedHosts = new Set<PanelHost>();
      for (const host of this.hosts) {
        const hostSession = this.hostSessions?.get(host) ?? this.showing;
        const hostPreviousSession = this.hostPreviousSessions?.get(host) ?? previousSelection;
        const hostDrawn = drawnSessionCards(this.cards, hostSession);
        // Only the selected row carries its full name and parent relationship.
        const hostParent = this.parentOfShown(hostSession);
        // Omit `railName` from general session rows. Session-list cards read it through the separate session-list payload.
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
        this.startupLoadingSent = JSON.stringify(
          this.loadingLine.held(loadingScope) && !listLoading.complete ? { ...listLoading, held: true } : listLoading,
        );
        void this.sendToHost(
          host,
          {
            ...payload,
            // A held line marks a pending stamp held. A newest-turn read then keeps the stamp incomplete, so the panel's completion
            // acknowledgement waits for it, but the line stays hidden and the read reaches only the log.
            startup:
              selectedOnly && this.authoritativeCatalog === null
                ? undefined
                : this.loadingLine.present(
                    selectedOnly ? 'selection' : 'render',
                    this.withSourceCount({ ...listLoading, complete: !loadingNewest && listLoading.complete }),
                    loadingScope,
                    () => listBlocker ?? { reason: 'newest turn loading' },
                  ),
            usage:
              typeof this.usagePayloadForSession === 'function'
                ? this.usagePayloadForSession(hostSession, host.webview)
                : this.usagePayload(host.webview),
            cards: this.themedFor(hostDrawn, host.webview, light),
            // Heading figures are keyed by session. Cost and turn count cover its lifetime, while context describes the current window.
            ...(selectedOnly ? {} : { stats: hostRail.stats }),
            // Resolve icon-font rules for this webview. Image-only themes supply no font rules.
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
        this.postSessionLoading(generation, controller.signal);
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
      // Run triggers retained during opening reads even when refresh ended before acquiring its controller.
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

  // Cancel catalog refresh and pending triggers. Hiding a host stops polling without calling this cancellation path.
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

  // Return false when either cache needs another save. A busy shared-opening lock also schedules its own retry.
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

  // Project running session IDs from catalog rows and native running keys.
  private runningSessions(): Set<string> {
    return runningSessions(this.sessionRows, [...this.running]);
  }

  // Project running start times used to bound session status claims.
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
    return timelineRailState(
      this.sessionOutcomes,
      this.liveOpenChildren(now),
      this.runningSessions(),
      this.waitingSessions(),
      this.runningSince(),
      this.liveBackgroundCommands(now),
      now,
    );
  }

  // Derive background command counts from held outcomes, exit times, and the supplied clock.
  private liveBackgroundCommands(now: number): Map<string, number> {
    return liveBackgroundCommands(
      this.sessionOutcomes,
      runningSessionsSince(this.sessionRows, this.exitedSinceKeys),
      now,
    );
  }

  // Closed children read work timestamps once per changed file version. Open children use held write times.
  private liveOpenChildren(now: number): Map<string, string[]> {
    return liveTimelineChildren(
      this.sessionOutcomes,
      this.claudeChildren,
      this.claudeChildReferences,
      this.claudeChildStatWrites,
      runningSessionsSince(this.sessionRows, this.exitedSinceKeys),
      now,
      (file) => (this.claudeChildWork ??= new ClaudeChildWorkCache()).read(file, this.claudeChildVersion(file)),
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

  // Preserve session-list placement within running and inactive groups. Catalog consumers retain newest-activity order.
  private railRows(statuses: ReturnType<typeof sessionStatusOf>): typeof this.sessionRows {
    const ordered = stableRailOrder(this.sessionRows, this.railOrder, statuses);
    this.railOrder = ordered.map((row) => row.id);
    return ordered;
  }

  // Compare both explicit read markers and session watermarks.
  private readPrint(): string {
    return JSON.stringify([this.saved.read, this.saved.readTo]);
  }

  // During indexing, retain the last settled record for sources whose new reads remain incomplete.
  private lifetimeDisplayFiles(): readonly SpendFileIndex[] {
    return sessionLifetimeDisplayFiles(this.projectSpendBusy(), this.projectSpendFiles, this.projectSpendVisibleFiles);
  }

  private lifetimeFiguresBySession(): LifetimeFigures {
    // Cache lifetime figures by session sources, displayed records, and pending-source state.
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
          // Cache-expiry counts remain unknown without available complete primary-source cache facts.
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

  // Project dispatched costs from cached lifetime contributions. Pending source reads withhold the settled-turn timestamp.
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

  private postDispatchedCostsIfMoved(): void {
    if (!this.cards?.length || !this.dispatchedCardPrints?.size) return;
    const drawnKeys = new Set(this.cards.map((card) => card.key));
    for (const key of this.dispatchedCardPrints.keys()) {
      if (!drawnKeys.has(key)) this.dispatchedCardPrints.delete(key);
    }
    const costs = this.dispatchedTurnCosts();
    const current = new Map<string, string>();
    const turns = new Map<string, Turn>();
    for (const card of this.cards) {
      if (card.kind !== 'turn' || !this.dispatchedCardPrints.has(card.key)) continue;
      const newest = this.newestBySession.get(card.sessionId);
      const recorded = newest && turnKey(newest) === card.key ? newest : this.turnsByKey.get(card.key);
      if (!recorded) continue;
      const turn = newest === recorded ? this.withActivity(recorded) : recorded;
      const counted = this.dispatchedCostsForTurn(turn, () => costs);
      current.set(card.key, dispatchedCostPrint(counted, this.projectSpendHydrated, this.dispatchedDiscoveryWaiting()));
      turns.set(card.key, recorded);
    }
    const moved = new Set(movedDispatchedCards(this.dispatchedCardPrints, current));
    if (!moved.size) return;
    const now = Date.now();
    const folders = this.folders();
    const running = this.runningSessions();
    const children = this.liveOpenChildren(now);
    const statuses = this.railStatuses(now).statuses;
    const changed: RenderCard[] = [];
    for (let index = 0; index < this.cards.length; index++) {
      const previous = this.cards[index];
      if (!moved.has(previous.key)) continue;
      const turn = turns.get(previous.key)!;
      const latest = this.newestBySession.get(turn.sessionId) === turn;
      const title =
        (turn.agent === 'claude' ? this.sessionNames.get(turn.sessionId)?.label : null) ||
        previous.sessionTitle ||
        'Session';
      const card = this.renderTurnCard(turn, latest, title, now, folders, running, children, statuses, () => costs);
      this.cards[index] = card;
      changed.push(card);
    }
    const light = isLightColourTheme();
    for (const host of this.hosts) {
      void this.sendToHost(host, { type: 'activity', cards: this.themedFor(changed, host.webview, light) });
    }
  }

  private dispatchedDiscoveryWaiting(): boolean {
    return this.dispatchDiscoveryPending || this.authoritativeCatalog === null;
  }

  private dispatchedCostsForTurn(
    turn: Turn,
    costs: () => Readonly<Record<string, Readonly<Record<string, DispatchedSessionCost>>>>,
  ) {
    return countedDispatchedCosts(
      turn,
      this.claudeChildReferences ?? [],
      new Set([
        ...(turn.dispatchToolUseIds ?? []),
        ...turn.steps.map((step) => step.sourceId).filter((id): id is string => !!id),
      ]),
      () => costs()[turn.sessionId],
      !this.projectSpendHydrated || this.dispatchedDiscoveryWaiting(),
      this.codexSubagents ?? [],
    );
  }

  // Whether the ledger still holds a dispatched source, by `spendSourceHeld` against the
  // ledger's queue and the history limit now.
  private projectSpendHolds(file: string, record: SpendFileIndex | undefined): boolean {
    return spendSourceHeld(record, this.projectSpendQueued.has(file), this.projectSpendHistoryCutoff());
  }

  // Refresh session-list figures when dispatched-source pending state changes, including changes since the last list payload.
  private postRailIfSpendPendingMoved(): void {
    const holds: SpendSourcePending = (file, record) => this.projectSpendHolds(file, record);
    if (
      this.lifetimeFigures.pendingMoved(holds) ||
      (this.railPendingAnswers !== null && this.lifetimeFigures.pendingMoved(holds, this.railPendingAnswers))
    ) {
      this.postRail(true);
    }
    this.postDispatchedCostsIfMoved();
  }

  // Supply statuses and child counts from one clock reading so their displayed states agree.
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

  // Update session-list content from retained facts without parsing transcripts. Unchanged revisions and payload inputs skip the update.
  private postRail(
    inputsChanged: boolean,
    knownCounts?: ReadonlyMap<string, NewCount>,
    refreshCatalogFacts = true,
  ): void {
    // Stop before deriving order when no host remains. The next host initializes order from its own catalog.
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
    // Flush the previous workspace before replacing its lists. Do not retry its failed save with the new workspace's state.
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
    // Hydration adds lifetime figures without replacing catalog-derived order or status.
    this.postRail(true, undefined, false);
    this.postDispatchedCostsIfMoved();
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

  // Retry failed saves within a bounded budget. A new change restarts scheduling, while exhausted retries wait for another change or flush.
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
    // Defer the owed session-list update until indexing completes so it publishes settled lifetime figures.
    if (this.projectSpendRailOwed && !this.projectSpendIndexing) {
      this.projectSpendRailOwed = false;
      this.postRail(true);
      this.postDispatchedCostsIfMoved();
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

  // Defer spend-source checks until after the render, keeping filesystem work outside the immediate rendering path.
  private scheduleProjectSpendIndex(
    listedRevisions: ReadonlyMap<string, { size: number; mtimeMs: number }>,
    onlyFiles: ReadonlySet<string> | null,
  ): void {
    // Capture workspace, sources, and revisions before deferral so later workspace changes cannot mix ledger inputs.
    const workspace = this.projectSpendWorkspace;
    const sources = this.projectSpendSources();
    const tick = setTimeout(() => {
      this.projectSpendOffers.delete(tick);
      if (this.projectSpendWorkspace === workspace) {
        this.queueProjectSpendIndex(listedRevisions, onlyFiles, sources);
      }
      // Publish settled Project cost when an offer queues no work.
      if (!this.projectSpendBusy()) {
        this.postProjectSpend();
        this.postDispatchedCostsIfMoved();
      }
    }, 0);
    this.projectSpendOffers.add(tick);
  }

  // Hydration, active indexing, and deferred offers each keep Project cost unsettled.
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

  // Cancel deferred source offers when their workspace or panel lifetime ends.
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

  // Re-offer queued sources under the changed history cutoff.
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
      // Requeue this file if it grew during indexing instead of waiting for the next integrity pass.
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
    // Advance the ledger revision when displayed files change. Schedule persistence so repeated appends still share bounded saves.
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
      this.postDispatchedCostsIfMoved();
      // Publish Project cost, session-list, and card updates without a catalog refresh that would offer sources again.
    }
  }

  // Enumerate Claude and Codex sessions in repository scope. Accepted metadata supplies the catalog's recorded-activity order.
  private allSessions(reuseCatalog = false): SessionFile[] {
    const codexWalk = this.codexWalk ?? undefined;
    this.codexWalk = null;
    const workspaceFolders = this.folders();
    const scope = this.repositoryScope.snapshot(workspaceFolders);
    this.repositoryScopeReady = scope.ready;
    this.repositoryScopeRoots = scope.ready ? scope.roots : [];
    this.publishWindowState();
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
      // Reorder reused catalog rows after updating file revisions.
      if (held) {
        const sorted = orderSessionCatalog(held, (session) => this.activityFor(session));
        // Retain the updated rows so later selections reuse their current revisions.
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
    // Trim opening metadata against every walked rollout, including files excluded from the session list.
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
    // Filter Claude peer-wake transcripts before catalog publication. Sessions enter this list after a human prompt is found.
    const listed = claude.filter((s) => this.hasHumanPrompt(s));
    this.subagentDirectories.sweep();
    // Order the catalog by recorded activity before initializing stable session-list placement.
    const walked = new Set([
      ...listing.walked,
      ...claude.map((session) => session.file),
      ...this.claudeChildren.map((session) => session.file),
    ]);
    // Defer title pruning until discovery supplies Claude child transcripts. Earlier walks cannot establish their absence.
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

  // Catalog membership selects dispatch edges consistently for headings, spend sources, and refresh keys.
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
      this.postDispatchedCostsIfMoved();
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
      if (!signal.aborted && result.generation === this.refreshGeneration && checkpoint) {
        // Every accepted checkpoint is kept, so a post the throttle skips cannot leave an older count on screen.
        this.startupSourceCheckpoint = { scope: JSON.stringify(this.repositoryScopeRoots), checkpoint };
      }
      if (
        !signal.aborted &&
        result.generation === this.refreshGeneration &&
        Date.now() - (this.startupProgressAt ?? 0) >= 250 &&
        checkpoint
      ) {
        this.startupProgressAt = Date.now();
        const scope = JSON.stringify(this.repositoryScopeRoots);
        const failed = this.unresolvedLoadingFailure(result.generation);
        // A complete reply that asks for no further pass leaves the list to the render, so its post names the reply, not a pending pass.
        const settled = progress.kind === 'claude-children' && !progress.continuation;
        const blocker = (): SessionLoadingBlocker => ({
          reason: failed ? 'failure' : settled ? 'discovery complete' : 'discovery pending',
        });
        if (this.loadingLine.held(scope)) {
          // A held line posts no discovery progress. The source count is read only for a log line.
          this.loadingLine.withhold(
            'discovery progress',
            () => ({ generation: result.generation, complete: false, ...this.sourceCountOf(checkpoint) }),
            scope,
            blocker,
          );
        } else {
          const { completed, known } = this.sourceCountOf(checkpoint);
          this.loadingLine.present(
            'discovery progress',
            { generation: result.generation, complete: false, completed, known, ...(failed ? { failed: true } : {}) },
            scope,
            blocker,
          );
          void this.post({
            type: 'startupProgress',
            generation: result.generation,
            epoch: String(generation),
            sequence: (this.startupProgressSequence = (this.startupProgressSequence ?? 0) + 1),
            completed,
            known,
            ...(failed ? { failed: true } : {}),
          }).catch(() => {});
        }
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
    this.performanceCounters?.recordDiscovery?.(progress.charges, {
      complete: progress.kind === 'claude-children',
      continuation: progress.continuation,
    });
    if (signal.aborted || result.generation !== this.refreshGeneration) return false;
    const discoveryWaiting = this.dispatchedDiscoveryWaiting();
    if (progress.kind !== 'claude-children' || !progress.complete) {
      this.dispatchDiscoveryPending = true;
      this.discoveryComplete = undefined;
      this.checkpointDerivedCache();
      if (this.catalog) this.catalog = { ...this.catalog, sessions: this.authoritativeCatalog ?? [] };
      if (this.dispatchedDiscoveryWaiting() !== discoveryWaiting) this.postDispatchedCostsIfMoved();
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
    this.claudeChildWork?.retain(referenced);
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
    this.discoveryComplete = {
      scope: JSON.stringify(this.repositoryScopeRoots),
      files: new Set(sessions.map((session) => session.file)),
    };
    this.updateSessionSpendSources(codex, sessions);
    if (this.catalog) {
      this.catalog = { ...this.catalog, sessions };
    }
    if (this.dispatchedDiscoveryWaiting() !== discoveryWaiting) this.postDispatchedCostsIfMoved();
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

  // Reuse a successful human-prompt scan. Otherwise resume scanning from the retained cursor.
  private hasHumanPrompt(session: SessionFile): boolean {
    const prev = this.humanScans.get(session.file);
    if (prev?.found) {
      return true;
    }
    const next = scanForHumanPrompt(session.file, session.size, prev);
    this.humanScans.set(session.file, next);
    return next.found;
  }

  // Selected sessions supply turn cards. Session-list facts come from metadata.
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
      this.noteSessionRead(session, 'metadata', result !== null, generation, signal);
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
      // Return unused title-head budget after a metadata read so the next session can use it.
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
        const result = await this.progressiveWorker
          .run({ kind: 'starts', session, agentRunScan: previous.agentRunScan }, generation, signal)
          .catch(() => null);
        this.noteSessionRead(session, 'starts', result !== null, generation, signal);
        if (!result || signal.aborted) {
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
        this.noteSessionRead(session, 'enrichment', result !== null, generation, signal);
        if (!result || signal.aborted) {
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
      this.noteSessionRead(active, 'recovery', result !== null, generation, signal);
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
                    exhaustedRule: METADATA_EXHAUSTED_RULE,
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
        this.metadataRecoverySession = null;
        this.metadataRecoveryQueue.push(active.sessionId);
        if (result && result.generation === generation && result.value.kind === 'stale') catalogCurrent = false;
      }
    }
    return { changed, catalogCurrent, progress };
  }

  // Only a discovery or catalog refresh failure marks the generation failed. A caller that already holds the list's blocker passes it.
  private sessionLoadingState(
    generation: number,
    blocker: SessionLoadingBlocker | null = this.sessionLoadingBlocker(generation),
  ) {
    const failed = this.startupFailureGeneration === generation;
    return {
      generation,
      complete: !failed && blocker === null,
      ...(failed ? { failed: true } : {}),
    };
  }

  // Names the check that keeps the session list loading, or returns null when the list is complete. The list is complete once the
  // published catalog was built from a complete discovery reply under the current roots. Names, metadata, turn starts, and recovery
  // reads keep running after that and never keep the list loading, so a session an agent keeps writing cannot hold the line up.
  private sessionLoadingBlocker(generation: number): SessionLoadingBlocker | null {
    if (this.startupFailureGeneration === generation) return { reason: 'failure' };
    if (this.authoritativeCatalog === null) return { reason: 'catalog missing' };
    if (this.completeCatalogScope !== JSON.stringify(this.repositoryScopeRoots)) return { reason: 'discovery pending' };
    return null;
  }

  // Logs a failed session read once per file and kind, and forgets the failure when that kind of read succeeds. The session keeps its
  // prior facts. A cancelled read resolves without a result too, so a read of an aborted or replaced refresh logs nothing.
  private noteSessionRead(
    session: SessionFile,
    read: 'metadata' | 'starts' | 'enrichment' | 'recovery',
    succeeded: boolean,
    generation: number,
    signal: AbortSignal,
  ): void {
    this.sessionReadFailures ??= new Set();
    const key = `${session.file}\0${read}`;
    if (succeeded) {
      this.sessionReadFailures.delete(key);
      return;
    }
    if (signal.aborted || generation !== this.refreshGeneration || this.sessionReadFailures.has(key)) return;
    this.sessionReadFailures.add(key);
    this.diagnostics?.warn('sessionReadFailed', { read, file: session.file });
  }

  private postSessionLoading(generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.refreshGeneration) return;
    const found = this.sessionLoadingBlocker(generation);
    this.sendSessionLoading(
      this.sessionLoadingState(generation, found),
      'session loading',
      () => found ?? { reason: 'failure' },
    );
  }

  // Posts the session-list state to every panel. A held line marks a pending state held, and a post equal to the last one is skipped.
  // Only a list complete under the roots its catalog was built for starts the hold, so an earlier scope's catalog cannot complete new roots.
  private sendSessionLoading(
    state: { generation: number; complete: boolean; failed?: boolean },
    path: SessionLoadingPath,
    blocker: () => SessionLoadingBlocker,
  ): void {
    this.settleSourceCount(state);
    const scope = JSON.stringify(this.repositoryScopeRoots);
    if (state.complete && this.authoritativeCatalogScope === scope)
      this.loadingLine.hold(scope, state.generation, path);
    const held = this.loadingLine.held(scope);
    const key = JSON.stringify(held && !state.complete ? { ...state, held: true } : state);
    if (key === this.startupLoadingSent) {
      if (held && !state.complete) this.loadingLine.withhold(path, state, scope, blocker);
      return;
    }
    this.startupLoadingSent = key;
    const published = this.loadingLine.present(path, state, scope, blocker);
    void this.post({
      type: 'startupProgress',
      ...published,
      epoch: String(state.generation),
      sequence: (this.startupProgressSequence = (this.startupProgressSequence ?? 0) + 1),
      completed: 0,
      known: 0,
      ...this.withSourceCount(published),
    }).catch(() => {});
  }

  // Drops the retained checkpoint once the session list completes. Panel statuses never call it, because one panel can be complete
  // while another still reads its newest turns.
  private settleSourceCount(list: { complete: boolean }): void {
    if (list.complete) this.startupSourceCheckpoint = null;
  }

  // Counts the known and checked sources of a checkpoint. The result is reused until the checkpoint changes.
  private sourceCountOf(checkpoint: import('./progressiveworker').DiscoveryCheckpoint): {
    completed: number;
    known: number;
  } {
    const key = [
      checkpoint.sequence,
      checkpoint.parents.length,
      checkpoint.catalog.length,
      checkpoint.completed.length,
    ].join(':');
    const held = this.startupSourceCounted;
    if (held && held.checkpoint === checkpoint && held.key === key) return held.count;
    const known = new Set([...checkpoint.parents, ...checkpoint.catalog].map((row) => normalizeFsPath(row.file)));
    const completed = new Set(checkpoint.completed.map(normalizeFsPath).filter((file) => known.has(file))).size;
    const count = { completed, known: known.size };
    this.startupSourceCounted = { checkpoint, key, count };
    return count;
  }

  // Adds the retained source count to a pending, unfailed status. It adds nothing for a count kept under another scope, and a failure
  // shows its own message. It never changes the retained count.
  private withSourceCount<T extends { complete: boolean; failed?: boolean }>(
    state: T,
  ): T | (T & { completed: number; known: number }) {
    const held = this.startupSourceCheckpoint;
    if (!held || state.complete || state.failed || held.scope !== JSON.stringify(this.repositoryScopeRoots))
      return state;
    return { ...state, ...this.sourceCountOf(held.checkpoint) };
  }

  // Reports the current generation's work failure.
  private unresolvedLoadingFailure(generation: number): boolean {
    return this.startupFailureGeneration === generation;
  }

  private failSessionLoading(generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.refreshGeneration) return;
    this.startupFailureGeneration = generation;
    // A work failure decides the state alone, so this walks no sessions.
    this.sendSessionLoading({ generation, complete: false, failed: true }, 'failure', () => ({ reason: 'failure' }));
  }

  // Use accepted agent-specific names, then carried cache names, then an ID placeholder.
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

  // Cache parent relationships until reference or child collections change.
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

  // Retain parent edges whose endpoints have catalog rows. Dispatched edges supply separate ownership and spend relationships.
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

  // Observe stored Claude names and write any higher-priority held name back into the entry.
  private observeStoredName(session: SessionFile, entry: DerivedTitleEntry): DerivedTitleEntry {
    if (session.agent !== 'claude') {
      return entry;
    }
    // Use the worker-measured entry size and catalog inode without another file read.
    this.sessionNames.observe(
      session.sessionId,
      storedSessionName(entry),
      transcriptIdentity({ size: entry.size, ino: session.ino }, entry.headKey),
    );
    const held = this.sessionNames.get(session.sessionId);
    return held ? withSessionName(entry, held) : entry;
  }

  // Observe the stored name and retain any entry updated by held naming state.
  private observeStoredEntry(session: SessionFile, entry: DerivedTitleEntry): void {
    const next = this.observeStoredName(session, entry);
    if (next === entry) {
      return;
    }
    this.storeTitleEntry(session.file, next);
    this.derivedCacheCheckpointState.markChanged();
  }

  // Observe parsed Claude names with catalog inode identity. Omit catalog size because an older listing can misrepresent transcript shrinkage.
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

  // Prefer Codex index names over names found in parsed turns when naming card and session headings.
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

  // Persist changed held names in existing derived entries for subsequent startup.
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

  // Use recorded activity time, falling back to mtime when metadata has no timestamp.
  private activityFor(session: SessionFile): number {
    return this.metaFor(session).activityMs ?? session.mtimeMs;
  }

  // Apply reader-started and parent ownership to cached agent-run classification without changing the shared metadata fact.
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
    return outcomesFor(
      sessions,
      this.lifetimeRailFacts(),
      (file) => this.cache.get(file)?.read,
      (session) => this.metaFor(session),
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

  // `spendNow` binds worker child-spend classification to the clock used by the host's dependency key.
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

  // Check child-spend keys independently of parent revisions. Stale child figures refresh without the selected-window loading row.
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

  // Refresh cached child spend without rereading the parent. Store the attempted dependency key even when the worker returns no accepted answer.
  private async refreshAgentFacts(
    session: SessionFile,
    entry: CacheEntry,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Capture child revisions and one clock before the worker request. Changes during the request leave the answer eligible for another refresh.
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
    // Recompute the key over stored turns using the same captured child revisions and clock.
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
    // Track worker requests so an unchanged cached result does not trigger another render.
    let roundTrip = false;
    try {
      // Before the catalog is published, a selected session waits for it, and the render that publishes the catalog completes the
      // window. A published catalog can miss a session created after its snapshot, such as a new subagent, so that session resolves
      // from its opening records, becomes an early source, and opens at once. A catalog cleared during the resolve adds no source.
      let session = this.currentSelectedSession(work);
      if (
        !session &&
        this.authoritativeCatalog !== null &&
        (work.host || (this.showing === sessionId && this.selectionGeneration === generation))
      ) {
        const scope = this.repositoryScope?.snapshot(this.folders());
        if (!scope?.ready) return;
        this.repositoryScopeReady = true;
        this.repositoryScopeRoots = scope.roots;
        this.publishWindowState();
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
        if (!session || this.authoritativeCatalog === null) return;
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
          // Key the accepted pages with the captured child revisions, rather than the pages sent to the worker.
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
          // Recheck the parent after child-spend refresh. A parent append requires a new selected window.
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
        // Refresh a current retained window only when worker work or a displayed failure changed its presentation.
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

  // Load one older history page at a time. Bounded repeated reads skip initial pages containing only turns already present in the tail.
  private async loadOlderHistory(sessionId: string): Promise<void> {
    if (this.historyRequest) {
      return;
    }
    const selected = () =>
      new Set([this.showing, ...this.hostSessions.values()].filter((held): held is string => held !== null));
    // Hold the request while cold opening reads finish. Publish loading through a selected-only refresh without starting a competing catalog walk.
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
    // Publish loading before the page read, reusing the catalog.
    void this.refresh(true, true, true, true);
    const before = this.history.get(sessionId) ?? startSessionHistory<HistoryCursor>(session, Date.now());
    let metadataReadAccepted = false;
    try {
      const reads = historyPageReads(window.loadedTurns);
      for (let attempt = 0; attempt < reads; attempt++) {
        if (this.historyRequest?.generation !== generation) {
          return;
        }
        // Read retained history anew after each await because a refresh can replace its pages or cursor.
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
      // Convert read failures to settled history state so loading does not remain active.
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

  // Read current file identity and revision for stale-result and cursor checks.
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

  // Request one page through the worker, retaining the source adapter's opaque cursor.
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

  private agentFile(session: SessionFile, agent: AgentSpendRef, metas: ClaudeSubagentMetaReader): string | null {
    if (session.agent === 'claude') {
      return claudeChildFileFor(this.claudeChildReferences, session, agent, metas);
    }
    return codexSubagentFor(this.codexSubagents, session.sessionId, agent)?.file ?? null;
  }

  private codexStructuralChildren(session: SessionFile): CodexSubagentFile[] {
    return session.agent === 'codex'
      ? this.codexSubagents.filter((child) => child.parentThreadId === session.sessionId)
      : [];
  }

  // Key Codex child relationships without file revisions. `agentSpendKey` refreshes changed child figures without rereading the parent.
  private codexStructuralKey(session: SessionFile): string {
    return this.codexStructuralChildren(session)
      .map(
        (child) =>
          `${child.threadId}:${child.openedAt ?? ''}:${child.threadSource ?? ''}:${child.backgroundReview}:${child.file}`,
      )
      .sort()
      .join('\n');
  }

  // Cache child spend versions in the supplied map so related comparisons use one revision per file.
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

  // Key Claude child relationships without file revisions. Separate spend keys track completed children and active spend bands.
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
    // The worker records each window's dependency key. The host recomputes it from current child revisions and the supplied clock.
    const metas = claudeSubagentMetaReader();
    return agentSpendDependencyKey(
      read.turns,
      (ref) => this.agentFile(session, ref, metas),
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

  // Evict absent parsed windows and apply the retained-history budget. Trim small discovery caches against all present files.
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
    // Per-source facts are pruned only while the catalog is authoritative. Before the first one, or after a workspace folder
    // change clears it, a selected-only refresh lists at most the selected sessions. A refresh that renders before metadata
    // lists a catalog that is not yet authoritative. Neither list shows that any other source is gone.
    if (this.authoritativeCatalog !== null) {
      // Include filtered Claude peer-wake files when retaining working-directory and human-prompt scan caches.
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
    // Cancel an older-page request when its session is no longer selected in any host.
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
    // Rebuild card-to-turn references from the current selected windows.
    this.turnsByKey.clear();
    const ordinary = { maxTurns: TRANSCRIPT_TURN_LIMIT, tailBytes: TRANSCRIPT_TAIL_BYTES };
    const turns: Turn[] = [];
    const compactions: Compaction[] = [];
    const parsedCacheRevisions = new Map<string, Pick<RevisionedRailCacheMark, 'mtimeMs' | 'size'>>();
    let listedMaxTurns = 0;
    this.readWindows.clear();
    // Update retained-page recency and apply the shared budget before collecting selected windows.
    this.trimOlderHistory(sessions);
    for (const session of sessions) {
      const window = this.readFor(session, ordinary.maxTurns, ordinary.tailBytes);
      const read = window.read;
      parsedCacheRevisions.set(session.sessionId, window.revision);
      // Include retained pages for each selected session. Unselected sessions retain pages without drawing them.
      const older = historyRecordsOutside(this.history.get(session.sessionId)?.pages ?? [], read);
      // The budget admits the tail and retained pages for every session visible in a host.
      // Without their combined size, navigating one panel would cut a peer panel to one card.
      listedMaxTurns += Math.max(window.maxTurns, read.turns.length + older.turns.length);
      this.readWindows.set(session.sessionId, {
        readBytes: read.readBytes,
        turnLimitReached: read.turnLimitReached,
        // Count the tail and retained pages together for the history sentinel.
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
    // Derive completion markers and each session's newest records from the accepted turns.
    this.turnMarks = turns.map((t) => ({ id: turnKey(t), agent: t.agent, finished: t.finished }));
    const currentRecords = currentRecordsBySession(turns, compactions);
    this.newestBySession = currentRecords.newestTurns;
    this.composerRuntime = composerRuntimeBySession(turns, currentRecords.newestCompactions);
    // Build recorded prompt recall in newest-first order, including messages submitted during a turn.
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
    // Prune recorded submissions from persisted recall. Keep the in-memory submitted text for this provider's remaining lifetime.
    if (Object.keys(this.sentPrompts).length) {
      const prunedSent = prunedSentPrompts(this.sentPrompts, this.promptsBySession);
      if (JSON.stringify(prunedSent) !== JSON.stringify(this.sentPrompts)) {
        void this.writeDrafts();
      }
    }
    this.newestCompactionBySession = currentRecords.newestCompactions;
    // Apply the display budget while preserving selected-session priority and each session's newest turn.
    const listed = turnBudget(turns, listedMaxTurns, this.showing);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    // Resolve session names consistently for turn and compaction cards.
    this.observeParsedNames(listed, byId);
    const codexTitles = new Map<string, string>();
    for (const turn of listed) {
      if (turn.agent !== 'claude' && turn.sessionTitle) {
        codexTitles.set(turn.sessionId, turn.sessionTitle);
      }
    }
    const titleOf = (sessionId: string): string => this.headingTitle(sessionId, byId, codexTitles);

    // Derive current-window figures from budgeted turns and compactions. The heading receives lifetime cost and turn count separately.
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
    // Retain the rendering clock for later status-change comparisons.
    this.collectedAt = now;
    // Use filenames for workspace files and full paths for files outside the open folders.
    const folders = this.folders();
    const cards = this.drawTurnCards(listed, titleOf, now, folders);
    // Omit compactions older than every displayed turn. Find the minimum timestamp because the budgeted list is not globally sorted.
    const oldest = listed.length ? listed.reduce((low, t) => Math.min(low, t.startedAt), Infinity) : 0;
    for (const c of compactions) {
      if (c.at < oldest) {
        continue;
      }
      const card = toCompactionCard(c, now);
      // Compaction cards also carry the session title used by grouping.
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
    // Include live background children on launching cards and carried children on each session's newest card.
    const runningSessions = this.runningSessions();
    const liveChildren = this.liveOpenChildren(now);
    // Dispatched rows share session-list status, including work still running in subagents or background commands.
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
    // Activity redraws retain dispatched costs through the same contribution lookup as complete card renders.
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
    const counted = this.dispatchedCostsForTurn(turn, dispatchedCosts);
    if (counted.length || this.dispatchedCardPrints?.has(turnKey(recordedTurn))) {
      (this.dispatchedCardPrints ??= new Map()).set(
        turnKey(recordedTurn),
        dispatchedCostPrint(counted, this.projectSpendHydrated, this.dispatchedDiscoveryWaiting()),
      );
    }
    // Only prompt activity supplies text under You asked. Compaction activity carries no prompt text.
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
      // Render earlier answers as markdown before sending their HTML to the panel.
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

  // Resolve response image URIs for each webview's resource access.
  private imagesFor(webview: vscode.Webview): ImageResolver {
    const folders = this.folders();
    return (target) => {
      const file = imageFileFor(target, folders);
      return file ? { src: webview.asWebviewUri(vscode.Uri.file(file)).toString(), path: file } : null;
    };
  }

  // Resolve response images and file icons per host. Preserve existing badges and rerender markdown only when it contains image references.
  private themedFor(cards: RenderCard[], webview: vscode.Webview, light: boolean): RenderCard[] {
    const resolveImage = this.imagesFor(webview);
    return cards.map((card) => {
      const drawn = this.picturedFor(card, resolveImage);
      if (drawn.kind !== 'turn' || !drawn.files.length) {
        return drawn;
      }
      const files = drawn.files.map((file) => {
        const themed = this.icons.iconFor(file.path, webview, light);
        // Apply theme values to a copy because file-type icons are shared table entries.
        return themed ? { ...file, icon: { ...file.icon, ...themed } } : file;
      });
      return { ...drawn, files };
    });
  }

  // Resolve images in summaries, earlier answers, and mid-turn messages for this host. Other text retains its host-independent rendered HTML.
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

  // Focus the target editor group before opening a multi-file diff.
  private async focusColumn(beside = false): Promise<void> {
    // Reuse a valid previous beside column. Otherwise split once and remember the new active group.
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
    // Limit source reads before applying the selected-session search scope.
    const scope = searchScope(this.searchCorpus(this.showing), this.showing);
    // Apply current labels, archive state, and agent-run classification at search time. Transcript revisions do not track reader state.
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

  // Populate the bounded search corpus only for an explicit content search, outside polling and rendering.
  private searchCorpus(only: string | null = null): SearchEntry[] {
    const all = this.allSessions();
    // Refresh Codex names before filing search results.
    this.threadNames = readThreadNames(codexSessionIndexPath(), this.threadNames);
    const live = new Set(all.map((f) => f.file));
    for (const file of [...this.corpus.keys()]) {
      if (!live.has(file)) {
        this.corpus.delete(file);
      }
    }
    const out: SearchEntry[] = [];
    for (const session of all) {
      // Skip unselected files before reading their text. Cache trimming still uses the whole catalog.
      if (only && session.sessionId !== only) {
        continue;
      }
      const held = this.corpus.get(session.file);
      // Compare size and mtime so appends within one timestamp tick invalidate cached entries.
      if (held && held.mtimeMs === session.mtimeMs && held.size === session.size) {
        // Refresh cached entries' names without rereading unchanged transcript text.
        const named = this.sessionLabel(session).label;
        for (const entry of held.entries) {
          entry.sessionTitle = named;
        }
        out.push(...held.entries);
        continue;
      }
      // Search has a separate read window and cache so it does not replace selected-session reads.
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
        // Include initial and later prompts, plus earlier and final responses, in searchable text.
        prompt: searchablePrompt(turn),
        summary: searchableSummary(turn),
        // Report whether this search read reached the transcript's beginning, independently of retained timeline pages.
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

  // Include a content digest in diff-side URIs so VS Code caches distinct text as distinct virtual documents.
  private sideUri(filePath: string, side: 'before' | 'after', text: string): vscode.Uri {
    const version = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    return turnFileUri(filePath, side, version);
  }

  // Retain all sides of this diff before trimming older entries. The current diff can exceed the byte budget without evicting itself.
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

  // Open a multi-file diff using pending snapshots, recorded whole-file content, or recorded edit regions. The title identifies less exact sources.
  private async openTurnDiff(sessionId: string, turn: Turn, headline: string, beside = false): Promise<void> {
    if (!turn.files.length) {
      return;
    }
    // Read the manifest once for the complete multi-file diff.
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
        // Use the snapshot entry's canonical file path for resource labels and both diff sides.
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
    // `vscode.changes` opens in the focused group and accepts no column option. Focus the destination first.
    await this.focusColumn(beside);
    // Each multi-file diff opens a new editor because its document identity is generated by VS Code.
    await vscode.commands.executeCommand('vscode.changes', diffTitle(headline, againstBaseline, asHunks), resources);
  }

  // Parse messages before dispatch. Exhaustive variant handlers keep the host aligned with the panel protocol.
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
    // Resolve current cards by key. Missing cards cannot supply action targets.
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
          this.publishWindowState();
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
      // Honor the editor's mouse-navigation setting because workbench listeners do not receive webview button events.
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
      // Forward account-refresh requests to the callback that owns agent processes.
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
      // Apply the choice already made by the panel menu.
      pick: (msg) => {
        if (msg.control === 'model') this.invalidateContext(msg.session);
        // Resolve the target through current session state. Reject missing rows and inherited object keys before applying settings.
        const aimed = this.stateFor(msg.session);
        if (!aimed) {
          return;
        }
        // Apply draft setup choices locally. MCP choices reach the agent-process callback.
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
      // Update draft text for the session named by the typing message.
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
        // Stop the session named by the message, independent of the current panel selection.
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
      // Apply one comment change to provider state and broadcast the resulting list, preserving peer-host edits.
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
      // Select the named session. Refresh reconciles unavailable IDs with the newest reachable session.
      showReaderParent: (msg) => {
        this.show(msg.session || null, host);
      },
      showSession: (msg) => {
        this.show(msg.session || null, host);
      },
      // Build label-editor rows from current provider state on each opening.
      labelEditor: (msg) => {
        void this.post(this.labelEditorReply(msg.session, browserSession ?? msg.session));
      },
      // Return rename success or failure to the host that opened the editor.
      renameSession: async (msg) => {
        await answerSessionRename(
          msg,
          () => this.renameSession(msg.session, msg.title),
          (answer) => this.sendToHost(host, answer),
        );
      },
      // Normalize and replace one session's labels, then publish the stored result.
      setLabels: (msg) => {
        this.saved.labels = setSessionLabels(this.saved.labels, msg.session, msg.names);
        void this.memento?.update(STATE_KEY, this.saved);
        this.postRail(true);
        void this.post(this.labelEditorReply(msg.session, browserSession ?? msg.session));
        // Notify peer editors so their label counts and available names refresh.
        void this.post({ type: 'labelsChanged', session: browserSession ?? msg.session });
      },
      // Normalize and persist the complete saved-view list. The session-list update publishes it to every host.
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
      // Classify typed queries through `isSearch` before reading session content.
      search: (msg) => {
        const query = msg.text;
        this.waitingSearch = null;
        if (!isSearch(query)) {
          void this.post({ type: 'results', query, hits: null, scope: 'workspace' });
          return;
        }
        // Wait for cold opening reads before building the corpus. Answer only the latest waiting query.
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
        // Reject older-history requests that no longer match this host's selected session.
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
          // Register the resolved repository before `git.viewCommit`, which uses repositories known to the built-in Git extension.
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
        // Open in the chosen editor column. The beside modifier requests a separate group.
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
        // Accept only skill paths published by this card.
        if (!found.card.activitySkills.some((skill) => skill.path === msg.path)) {
          return;
        }
        // Silently ignore missing or non-file skill targets.
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(msg.path, { throwIfNoEntry: false });
        } catch {
          return;
        }
        if (!stat?.isFile()) {
          return;
        }
        // Use the same editor-column rule as file rows.
        const column = msg.beside ? vscode.ViewColumn.Beside : this.column();
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), { viewColumn: column });
      },
    });
  }

  // Persist normalized panel preferences beyond the lifetime of an individual webview.
  private saveState(state: unknown): void {
    const readBefore = this.readPrint();
    const stateBefore: ReadState = { read: this.saved.read, readTo: this.saved.readTo };
    // Preserve provider-owned draft text. Browser preference saves do not carry current typing.
    const drafts = this.saved.drafts;
    // Preserve sent prompt recall while its recorded copy remains unavailable.
    const sentPrompts = this.saved.sentPrompts;
    const submittedPrompts = this.saved.submittedPrompts;
    const draftCommentIds = this.saved.draftCommentIds;
    // Browser saves can arrive after a provisional draft has adopted its durable id. The
    // provider-owned membership sets already made that move, so an older browser copy must
    // not replace them.
    const hidden = [...this.hidden];
    const pinnedTop = [...this.pinnedTop];
    // Preserve provider-owned attachments and queues during browser preference saves.
    const assets = this.saved.assets;
    const queues = this.saved.queues;
    // Preserve provider-owned comments so a stale browser state save cannot remove peer-host changes.
    const notes = this.saved.comments;
    // Preserve the workspace unread baseline. A browser without it cannot reset older activity to unread.
    const since = this.saved.since;
    // Preserve reader-started ownership, which browsers do not supply in preference saves.
    const started = this.saved.started;
    // Preserve labels updated through their dedicated messages, independent of browser preference saves.
    const labels = this.saved.labels;
    const readerParents = this.saved.readerParents;
    // Preserve provider-owned views and saved filters. Normalize browser filter selection against the retained catalog.
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
    // Update unread counts after read-state saves. Defer selection-only changes to the pending render, with a fallback when it settles.
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
  // Supply diagnostics settings, storage location, workspace, and process identity from the editor host.
  const diagnostics = createDiagnosticsLog({
    enabled: readSetting('diagnostics.log'),
    directory: path.join(arcHome(), DIAGNOSTICS_LOG_DIRECTORY),
    workspace: vscode.workspace.name ?? 'no folder',
    pid: process.pid,
    // Name diagnostics with process start time, independent of later extension activation.
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
    // Accept an optional output path. Non-string command arguments use the default destination.
    vscode.commands.registerCommand('arc.savePerformanceDiagnostics', (target?: unknown) =>
      provider.savePerformanceDiagnostics(typeof target === 'string' ? target : undefined),
    ),
    vscode.commands.registerCommand('arc.openDiagnosticsLog', () => provider.openDiagnosticsLog()),
    vscode.commands.registerCommand('arc.showProjectSpend', () => provider.showProjectSpend()),
    vscode.commands.registerCommand('arc.newSession', () => provider.newSession()),
    // Register commands that create the editor panel and its beside variant.
    vscode.commands.registerCommand('arc.openInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('arc.openBeside', () => provider.openInEditor(vscode.ViewColumn.Beside)),
    // Reattach editor-restored webview tabs after a window reload.
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        await provider.revivePanel(panel, state);
      },
    }),
  );
  return provider;
}

// The build embeds the panel stylesheet and browser bundle. Rebuild after changing their source files.
declare const PANEL_CSS: string;
declare const PANEL_JS: string;
declare const PANEL_DEV_SERVER_URL: string | null;

// `paneltext.ts` expands named tokens using the shared value table for production and browser fixtures.
const STYLE = fillPanelText(PANEL_CSS, panelValues());
const SCRIPT = fillPanelText(PANEL_JS, panelValues());
