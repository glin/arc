import { RAIL_FILTER_QUERY_LIMIT } from '../domain/rail-filters.ts';
import { sessionQueryError, type SessionQueryContext } from '../domain/session-query.ts';
import type { FileCitationDestination } from '../domain/file-citation.ts';
import {
  contextIdentity,
  contextNumber,
  contextString,
  unavailableContext,
  validContextDetail,
  type ContextDetail,
} from '../domain/context-detail.ts';
// Host and panel messages use discriminated unions. Each parser returns a message variant or null.
// Parsers reject malformed fields and normalize supported omissions before dispatch.
import type {
  ComposerAnnotations,
  ComposerDraftTag,
  ComposerFile,
  ComposerLive,
  ComposerNextTurn,
  ComposerOrigin,
  ComposerView,
  Menu,
  NextTurnFace,
  NextTurnWords,
  PathEntry,
  PromptEntryView,
  QueuedPrompt,
} from '../composerview.ts';
import { mergeSubmittedPrompts, type SubmittedPrompt } from './state.ts';
import type { LauncherRequest } from '../view/launcher.ts';
import type { PinSetupRequest } from '../view/launcher.ts';
import type { SessionLauncherView } from '../view/launcher.ts';
import { normalizeSetupValues, SETUP_ID_LIMIT } from '../domain/session-setups.ts';
import type { SavedView } from '../domain/views.ts';
import { isStoredRailLens, type SavedRailFilter } from '../domain/rail-filters.ts';
import type { TurnComment } from '../view/comments.ts';
import { rowDeltaHeaderValid, type RowDeltaHeader } from './row-deltas.ts';
import type { UsageBar } from '../view/usage.ts';
import type { ProjectSpend } from '../view/projectspend.ts';
import { RAIL_SORTS, type RailSort } from '../domain/rail-sort.ts';
import {
  isCardLayout,
  isPromptPosition,
  type CardLayout,
  type TimelineLayout,
  type PromptPosition,
} from '../view/timeline-layout.ts';
import type { CardView, RailCardView } from './payload-contracts.ts';
import { READ_LIMIT, type ReaderReadEvent } from '../domain/read.ts';

export interface ReadSynchronization {
  revision: number;
  read: string[];
  readTo: Record<string, number>;
  since: number;
  agentRead: [string, string][];
}

export function parseReadSynchronization(value: unknown): ReadSynchronization | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as ReadSynchronization;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isFinite(state.since) || state.since < 0)
    return null;
  if (!Array.isArray(state.read) || state.read.length > READ_LIMIT || state.read.some((key) => typeof key !== 'string'))
    return null;
  if (
    !state.readTo ||
    typeof state.readTo !== 'object' ||
    Array.isArray(state.readTo) ||
    Object.values(state.readTo).some((at) => !Number.isFinite(at) || at < 0)
  )
    return null;
  if (
    !Array.isArray(state.agentRead) ||
    state.agentRead.length > READ_LIMIT ||
    state.agentRead.some(
      (pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((text) => typeof text !== 'string' || !text),
    )
  )
    return null;
  return {
    revision: state.revision,
    read: [...state.read],
    readTo: { ...state.readTo },
    since: state.since,
    agentRead: state.agentRead.map(([key, promptId]) => [key, promptId]),
  };
}

// Browser operations exclude agent acknowledgments and source invalidation.
export function parseReaderOperation(value: unknown): ReaderReadEvent | null {
  if (!value || typeof value !== 'object') return null;
  const operation = value as ReaderReadEvent;
  if (
    typeof operation.id !== 'string' ||
    !operation.id ||
    operation.id.length > 128 ||
    !Number.isSafeInteger(operation.observedRevision) ||
    operation.observedRevision < 0
  )
    return null;
  if (operation.action === 'reset')
    return Number.isFinite(operation.since) && operation.since >= 0
      ? { id: operation.id, observedRevision: operation.observedRevision, action: 'reset', since: operation.since }
      : null;
  if (operation.action !== 'turn' && operation.action !== 'session') return null;
  const target = operation.target;
  if (
    !target ||
    typeof target.sessionId !== 'string' ||
    !target.sessionId ||
    !Number.isFinite(target.startedAt) ||
    target.startedAt < 0 ||
    (target.promptId !== undefined && (typeof target.promptId !== 'string' || !target.promptId)) ||
    typeof operation.read !== 'boolean'
  )
    return null;
  if (
    operation.action === 'session' &&
    (!Number.isFinite(operation.newestAt) || operation.newestAt < operation.target.startedAt)
  )
    return null;
  return structuredClone(operation);
}

export interface AskQuestionAnswer {
  labels: string[];
  written: string;
}

export type AskAnswer =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'answer'; answers: Record<string, AskQuestionAnswer> };

export type {
  ComposerAnnotations,
  ComposerDraftTag,
  ComposerFile,
  ComposerLive,
  ComposerNextTurn,
  ComposerOrigin,
  ComposerView,
  Menu,
  NextTurnFace,
  NextTurnWords,
  PathEntry,
  PromptEntryView,
  QueuedPrompt,
};

export interface PanelUsage {
  bar: UsageBar | null;
  composer: ComposerView | null;
  menus: Record<string, Menu>;
  launcher: SessionLauncherView | null;
}

export interface PanelHistoryControl {
  kind: 'load' | 'busy' | 'retry' | 'beginning' | 'failed';
  label: string;
  name?: string;
  auto?: boolean;
  token?: string;
  session?: string;
}

export type PanelOlderHistory = PanelHistoryControl | null;

// Turn cards and session list rows share their renderers' complete payload contracts.
export type PanelCard = CardView;

export interface PanelSessionRow {
  id: string;
  label: string;
  fullLabel?: string;
  persisted?: boolean;
  agent: string;
  // The agent key and session id determine the resume command wording.
  agentKey: string;
  at: number;
  relative: string;
  when: string;
  // The reader-started or delegated parent. Present only on the shown session's row,
  // and only when the host has a row for the parent.
  parent?: { id: string; label: string; relation: 'dispatched' | 'subagent' | 'reader' };
}

export type PanelRailCard = RailCardView;

export interface PanelStat extends Record<string, unknown> {
  kind: string;
  label: string;
}

export interface PanelDiagnosis {
  message: string;
}

export interface SearchHit {
  key: string;
  sessionId: string;
  sessionTitle: string;
  agent: string;
  when: string;
  where: 'prompt' | 'summary';
  snippet: string;
  ranges?: readonly (readonly [number, number])[];
}

interface LabelRow {
  name: string;
  count: number;
  countName: string;
}

type LabelEditorRow = LabelRow & { applied: boolean };

// The parser preserves this complete payload, including fields owned by card, session list, and prompt box modules.
// The panel retains and updates the same object.
export interface RenderMessage extends Record<string, unknown> {
  type: 'render';
  queryContext?: SessionQueryContext;
  cards: PanelCard[];
  sessions: PanelSessionRow[];
  rail: PanelRailCard[];
  stats: Record<string, PanelStat[]>;
  hidden: string[];
  pinnedTop: string[];
  comments: TurnComment[];
  labels: LabelRow[];
  views: SavedView[];
  railFilters: SavedRailFilter[];
  iconFonts: string[];
  showing: string | null;
  sessionAdoptions: PanelSessionAdoption[];
  maxSessions: number;
  olderHistory: PanelOlderHistory;
  projectSpend: ProjectSpend | null;
  diagnosis: PanelDiagnosis | null;
  usage: PanelUsage | null;
  startup: PanelStartup | null;
  // The initial render carries Timeline layout settings. Configuration changes arrive as layout messages.
  timelineLayout: TimelineLayout;
  // The row delta header. A message without it carries complete `sessions`, `rail` and `stats`.
  rows?: RowDeltaHeader;
}

// Session loading status. A pending status repeats the last relationship source count when the host holds one. A held status
// is pending work after the session list completed, which keeps the loading line hidden.
export interface PanelStartup {
  generation: number;
  complete: boolean;
  failed?: boolean;
  held?: boolean;
  completed?: number;
  known?: number;
}

export interface SelectionMessage {
  type: 'selection';
  // Session identities affected by this replacement. An absent row removes an abandoned draft from the retained lists.
  replaces: string[];
  cards: PanelCard[];
  sessions: PanelSessionRow[];
  rail: PanelRailCard[];
  stats: Record<string, PanelStat[]>;
  showing: string | null;
  olderHistory: PanelOlderHistory;
  diagnosis: PanelDiagnosis | null;
  usage: PanelUsage | null;
  startup: PanelStartup | null;
}

export interface PanelSessionAdoption {
  provisional: string;
  durable: string;
}

export type HostToPanel =
  | { type: 'readerDocument'; readerPageId: string; documentId: string; challenge: string }
  | { type: 'readerReadAdmission'; id: string; admitted: boolean }
  | { type: 'readState'; state: ReadSynchronization }
  | { type: 'applySessionFilter'; request: string; query: string; deadline: number }
  | { type: 'health'; sequence: number }
  | { type: 'visibility'; visible: boolean; revision: number }
  | {
      type: 'startupProgress';
      queryOnly?: boolean;
      queryContext?: SessionQueryContext;
      generation: number;
      epoch: string;
      sequence: number;
      completed: number;
      known: number;
      complete?: boolean;
      failed?: boolean;
      held?: boolean;
    }
  | { type: 'contextDetail'; detail: ContextDetail }
  | { type: 'focusProjectSpend' }
  | { type: 'openLauncher'; custom: boolean }
  | { type: 'labelEditor'; session: string; heading: string; rows: LabelEditorRow[] }
  | { type: 'labelsChanged'; session: string }
  | { type: 'openLabelEditor'; session: string }
  | { type: 'showSessionDetails'; session: string }
  | { type: 'openViewEditor'; view: string; mode: 'rename' | 'delete' }
  | { type: 'openSessionRename'; session: string; title: string }
  // `request` is the id the panel sent with the rename it answers.
  | { type: 'sessionRenameResult'; session: string; request: number; title: string; error: string }
  | { type: 'focusComposer'; session: string }
  | { type: 'pathCompletion'; session: string; request: number; token: string; caret: number; rows: PathEntry[] }
  | { type: 'insertPrompt'; session: string; text: string }
  | { type: 'fileStaging'; session: string; token: string; pending: boolean; count?: number }
  | { type: 'fileStagingRejected'; session: string; token: string }
  | { type: 'usage'; usage: PanelUsage | null }
  | { type: 'askRejected'; session: string; id: string }
  | { type: 'projectSpend'; projectSpend: ProjectSpend | null }
  | { type: 'layout'; layout: TimelineLayout }
  | { type: 'live'; session: string; live: ComposerLive[] }
  | ({ type: 'activity' } & ({ session: string; card: PanelCard } | { cards: PanelCard[] }))
  | SelectionMessage
  | {
      type: 'rail';
      queryContext?: SessionQueryContext;
      rail: PanelRailCard[];
      stats: Record<string, PanelStat[]>;
      labels: LabelRow[];
      views: SavedView[];
      railFilters: SavedRailFilter[];
      sessionAdoptions: PanelSessionAdoption[];
      hidden: string[];
      pinnedTop: string[];
      rows?: RowDeltaHeader;
    }
  | { type: 'openPick'; control: string }
  | { type: 'takeDraft'; session: string; text: string }
  | { type: 'takeQueuedDraft'; session: string; text: string; revision: number; value: string }
  | { type: 'promptRecovery'; submittedPrompts: SubmittedPrompt[] }
  | { type: 'requestPromptRecovery'; request: string }
  | { type: 'restoreDraft'; session: string; text: string; revision: number }
  | { type: 'notes'; comments: TurnComment[] }
  | { type: 'openComment'; key: string }
  | { type: 'sendSelectedText'; key: string; copyLabels: boolean }
  | { type: 'setRead'; key: string; read: boolean }
  | { type: 'forgetState'; since: number }
  | { type: 'setSessionRead'; session: string; read: boolean }
  | { type: 'setSessionArchived'; session: string; archived: boolean }
  | { type: 'setSessionPinned'; session: string; pinned: boolean }
  | { type: 'setComposerHidden'; hidden: boolean }
  | { type: 'results'; query: string; hits: SearchHit[]; scope: string }
  | RenderMessage;

const HOST_TO_PANEL_KINDS: Record<HostToPanel['type'], true> = {
  readerDocument: true,
  readerReadAdmission: true,
  readState: true,
  applySessionFilter: true,
  health: true,
  visibility: true,
  startupProgress: true,
  contextDetail: true,
  focusProjectSpend: true,
  openLauncher: true,
  labelEditor: true,
  labelsChanged: true,
  openLabelEditor: true,
  showSessionDetails: true,
  openViewEditor: true,
  openSessionRename: true,
  sessionRenameResult: true,
  focusComposer: true,
  pathCompletion: true,
  insertPrompt: true,
  fileStaging: true,
  fileStagingRejected: true,
  usage: true,
  askRejected: true,
  projectSpend: true,
  layout: true,
  live: true,
  activity: true,
  selection: true,
  rail: true,
  openPick: true,
  takeDraft: true,
  takeQueuedDraft: true,
  promptRecovery: true,
  requestPromptRecovery: true,
  restoreDraft: true,
  notes: true,
  openComment: true,
  sendSelectedText: true,
  setRead: true,
  forgetState: true,
  setSessionRead: true,
  setSessionArchived: true,
  setSessionPinned: true,
  setComposerHidden: true,
  results: true,
  render: true,
};

export type PanelToHost =
  | { type: 'readerRead'; operation: ReaderReadEvent }
  | { type: 'sessionFilterApplied'; request: string; state: unknown }
  | { type: 'health'; sequence: number }
  | { type: 'contextDetail'; session: string; request: number; generation: number }
  | { type: 'ready'; readerPageId?: string; readerDocumentId?: string; readerChallenge?: string }
  // The panel could not apply a session row delta and needs a snapshot.
  | { type: 'rowsGap' }
  | { type: 'painted'; generation: number; stage: 'railReady' | 'firstCard' | 'completeRender'; usableRows?: true }
  | { type: 'initialize' }
  | { type: 'developmentReload' }
  | { type: 'refresh' }
  | { type: 'perf'; kind: string; ms: number }
  | { type: 'goBack' }
  | { type: 'goForward' }
  | { type: 'newSession'; request?: LauncherRequest; owner?: string }
  | { type: 'pinSetup'; request: PinSetupRequest; owner?: string }
  | { type: 'unpinSetup'; id: string; owner?: string }
  | { type: 'refreshUsage'; agent: string | null; force: boolean }
  | { type: 'openControl'; control: string; session: string }
  | { type: 'requestDefaults'; agent: 'claude' | 'codex'; model: string }
  | { type: 'pick'; control: string; agent: string; session: string; model: string; value: string }
  | { type: 'draft'; text: string; keep: string; session: string; revision?: number }
  | { type: 'pathCompletion'; session: string; request: number; token: string; caret: number }
  | { type: 'answerAsk'; session: string; id: string; answer: AskAnswer }
  | { type: 'dropUris'; session: string; types: string[]; values: Array<{ type: string; data: string }> }
  | { type: 'beginFileStaging'; session: string; token: string }
  | { type: 'attachFiles'; session: string; token: string; clipboard: boolean; files: unknown }
  | { type: 'fileReadError'; session: string; token: string; name: string }
  | { type: 'fileRejected'; session: string; code: string; name: string; size: number; rejected: number }
  | { type: 'removeFile'; session: string; value: string }
  | { type: 'sendPrompt'; text: string; session: string; revision: number; attempt?: SubmittedPrompt }
  | { type: 'importPromptRecovery'; submittedPrompts: unknown; request?: string }
  | { type: 'compact'; session: string }
  | { type: 'dismissLive'; session: string; kind: string }
  | { type: 'restoreLive'; session: string; kind: string }
  | { type: 'stopTurn'; session: string }
  | { type: 'dequeue'; value: string; session: string }
  | { type: 'editQueued'; value: string; session: string; revision: number }
  | {
      type: 'acceptQueuedEdit';
      value: string;
      session: string;
      revision: number;
      currentRevision: number;
      accepted: boolean;
    }
  | { type: 'copy'; text: string }
  | { type: 'note'; note: unknown }
  | { type: 'armSelectedText'; session: string; key: string }
  | { type: 'selectedTextHandoff'; session: string; key: string; text: string; copyLabels: boolean }
  | { type: 'armSessionDetails'; session: string }
  | { type: 'armComposer' }
  | { type: 'showReaderParent'; session: string }
  | { type: 'showSession'; session: string; parent?: true; responseLink?: true }
  | { type: 'labelEditor'; session: string }
  | { type: 'setLabels'; session: string; names: string[] }
  | { type: 'setViews'; views: SavedView[] }
  // `request` names this rename, so the panel can tell its answer from an earlier one's.
  | { type: 'renameSession'; session: string; request: number; title: string }
  | { type: 'setRailFilters'; railFilters: SavedRailFilter[] }
  | { type: 'sessionMembership'; action: 'archive' | 'unarchive' | 'unpin'; session: string }
  | { type: 'sessionMembership'; action: 'pin'; session: string; openPinned?: boolean }
  | { type: 'setLayout'; key: 'cardLayout'; value: CardLayout }
  | { type: 'setLayout'; key: 'promptPosition'; value: PromptPosition }
  | { type: 'exportSession'; session: string }
  | { type: 'saveState'; state: unknown }
  | { type: 'search'; text: string; retained?: boolean }
  | { type: 'loadOlder'; session: string; token: string }
  | { type: 'openLink'; href: string; beside: boolean }
  | { type: 'openLink'; destination: FileCitationDestination; beside: boolean }
  | { type: 'openVisualization'; path: string }
  | { type: 'openImage'; path: string; beside: boolean }
  | { type: 'openTurnDiff'; key: string; beside: boolean }
  | { type: 'openCommit'; key: string; sha: string; dir: string | null; beside: boolean }
  | { type: 'openFile'; key: string; path: string; beside: boolean; sourceSessionId?: string }
  | { type: 'openSkill'; key: string; path: string; beside: boolean };

function record(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hostToPanelKind(value: unknown): value is HostToPanel['type'] {
  return isString(value) && Object.prototype.hasOwnProperty.call(HOST_TO_PANEL_KINDS, value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function records(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => record(entry) !== null);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function labelCount(value: unknown): value is LabelRow {
  const row = record(value);
  return !!row && isString(row.name) && isFiniteNumber(row.count) && isString(row.countName);
}

function labelEditorRow(value: unknown): value is LabelEditorRow {
  const row = record(value);
  return labelCount(value) && typeof row?.applied === 'boolean';
}

// Check saved-view fields here. The extension normalizes the accepted list.
function savedViewRow(value: unknown): value is SavedView {
  const row = record(value);
  return (
    !!row &&
    isString(row.id) &&
    row.id !== '' &&
    isString(row.name) &&
    isString(row.query) &&
    typeof row.archived === 'boolean'
  );
}

function savedViews(value: unknown): value is SavedView[] {
  return Array.isArray(value) && value.every(savedViewRow);
}

function savedRailFilterRow(value: unknown): value is SavedRailFilter {
  const row = record(value);
  return (
    !!row &&
    isString(row.id) &&
    row.id !== '' &&
    isString(row.name) &&
    isString(row.query) &&
    RAIL_SORTS.includes(row.sort as RailSort) &&
    (row.lens === undefined || row.lens === null || isStoredRailLens(row.lens))
  );
}

function savedRailFilters(value: unknown): value is SavedRailFilter[] {
  return Array.isArray(value) && value.every(savedRailFilterRow);
}

function sessionAdoption(value: unknown): value is PanelSessionAdoption {
  const adoption = record(value);
  return !!adoption && isString(adoption.provisional) && isString(adoption.durable);
}

function composerFile(value: unknown): value is ComposerFile {
  const file = record(value);
  return (
    !!file &&
    isString(file.id) &&
    isString(file.label) &&
    isString(file.name) &&
    isFiniteNumber(file.size) &&
    (file.preview === null || isString(file.preview)) &&
    isString(file.kind) &&
    isString(file.stem) &&
    isString(file.ext) &&
    isString(file.sizeLabel) &&
    isOptionalString(file.removeLabel) &&
    isOptionalString(file.removeName) &&
    isOptionalString(file.removeControl)
  );
}

function pathEntry(value: unknown): value is PathEntry {
  const entry = record(value);
  return (
    !!entry &&
    isString(entry.name) &&
    typeof entry.directory === 'boolean' &&
    isString(entry.label) &&
    isString(entry.accessibleName) &&
    isString(entry.completion)
  );
}

function composerLive(value: unknown): value is ComposerLive {
  const live = record(value);
  return (
    !!live &&
    (live.kind === 'prompt' || live.kind === 'compact') &&
    (live.state === 'sent' ||
      live.state === 'running' ||
      live.state === 'failed' ||
      live.state === 'done' ||
      live.state === 'interrupted') &&
    (live.tone === 'running' || live.tone === 'failed' || live.tone === 'done' || live.tone === 'interrupted') &&
    isString(live.relative) &&
    isString(live.absolute) &&
    isString(live.agent) &&
    isString(live.model) &&
    isString(live.label) &&
    isString(live.headline) &&
    isString(live.status) &&
    isString(live.reply) &&
    isFiniteNumber(live.at) &&
    (live.since === null || isFiniteNumber(live.since)) &&
    isString(live.dismissLabel) &&
    isString(live.dismissName) &&
    isString(live.dismissControl) &&
    isString(live.restoreLabel) &&
    isString(live.restoreName) &&
    isString(live.restoreControl) &&
    isString(live.reason) &&
    Array.isArray(live.files) &&
    live.files.every(composerFile)
  );
}

/** Return the string value, or the fallback for a missing or non-string field. */
function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// A drop carries a few short type names and URI text. The host bounds both before it reads them.
const DROP_TYPES_LIMIT = 24;
const DROP_VALUES_LIMIT = 8;
const DROP_DATA_LIMIT = 1_000_000;

function dropPayload(m: Record<string, unknown>): {
  types: string[];
  values: Array<{ type: string; data: string }>;
} {
  const types = Array.isArray(m.types)
    ? m.types
        .filter(isString)
        .slice(0, DROP_TYPES_LIMIT)
        .map((type) => type.slice(0, 120))
    : [];
  const values = Array.isArray(m.values)
    ? m.values
        .flatMap((value) => {
          const held = record(value);
          return held && isString(held.type) && isString(held.data) && held.data.length <= DROP_DATA_LIMIT
            ? [{ type: held.type.slice(0, 120), data: held.data }]
            : [];
        })
        .slice(0, DROP_VALUES_LIMIT)
    : [];
  return { types, values };
}

// The launcher request names a row the host offered or a setup made of values the host
// offered. The host checks the choice against its current view.
function launcherRequest(raw: unknown): LauncherRequest | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  if (m.kind === 'row' && isString(m.key)) {
    return { kind: 'row', key: m.key };
  }
  if (
    m.kind === 'custom' &&
    isString(m.agent) &&
    isString(m.model) &&
    isString(m.effort) &&
    isString(m.permissionMode)
  ) {
    return {
      kind: 'custom',
      agent: m.agent,
      model: m.model,
      effort: m.effort,
      permissionMode: m.permissionMode,
    };
  }
  return null;
}

// Question answers contain chosen labels and written text. Check both parts of every value.
function askAnswer(raw: unknown): AskAnswer | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  if (m.decision === 'allow') {
    return { decision: 'allow' };
  }
  if (m.decision === 'deny' && isString(m.reason)) {
    return { decision: 'deny', reason: m.reason };
  }
  if (m.decision === 'answer') {
    const answers = record(m.answers);
    if (!answers) {
      return null;
    }
    const picked: Record<string, AskQuestionAnswer> = {};
    for (const [id, value] of Object.entries(answers)) {
      const given = record(value);
      if (!given || !Array.isArray(given.labels) || !given.labels.every(isString)) {
        return null;
      }
      if (!isString(given.written)) {
        return null;
      }
      picked[id] = { labels: [...given.labels], written: given.written };
    }
    return { decision: 'answer', answers: picked };
  }
  return null;
}

export function parseHostToPanel(raw: unknown): HostToPanel | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  switch (m.type) {
    case 'applySessionFilter':
      return Object.keys(m).sort().join(',') === 'deadline,query,request,type' &&
        isString(m.request) &&
        m.request.length > 0 &&
        m.request.length <= 128 &&
        isString(m.query) &&
        m.query.length <= RAIL_FILTER_QUERY_LIMIT &&
        !sessionQueryError(m.query) &&
        isFiniteNumber(m.deadline)
        ? { type: 'applySessionFilter', request: m.request, query: m.query, deadline: m.deadline }
        : null;
    case 'health':
      return Number.isSafeInteger(m.sequence) && (m.sequence as number) > 0
        ? { type: 'health', sequence: m.sequence as number }
        : null;
    case 'visibility':
      return typeof m.visible === 'boolean' && Number.isSafeInteger(m.revision) && (m.revision as number) >= 0
        ? { type: 'visibility', visible: m.visible, revision: m.revision as number }
        : null;
    case 'startupProgress':
      return validQueryContext(m.queryContext) &&
        (m.queryOnly === undefined || typeof m.queryOnly === 'boolean') &&
        (m.complete === undefined || typeof m.complete === 'boolean') &&
        (m.failed === undefined || typeof m.failed === 'boolean') &&
        (m.held === undefined || typeof m.held === 'boolean') &&
        Number.isSafeInteger(m.generation) &&
        Number.isSafeInteger(m.sequence) &&
        isString(m.epoch) &&
        Number.isSafeInteger(m.completed) &&
        Number.isSafeInteger(m.known) &&
        (m.generation as number) >= 0 &&
        (m.sequence as number) >= 0 &&
        (m.completed as number) >= 0 &&
        (m.known as number) >= (m.completed as number)
        ? (m as Extract<HostToPanel, { type: 'startupProgress' }>)
        : null;
    case 'focusProjectSpend':
      return { type: 'focusProjectSpend' };
    case 'openLauncher':
      return { type: 'openLauncher', custom: m.custom === true };
    case 'labelEditor':
      return isString(m.session) && isString(m.heading) && Array.isArray(m.rows) && m.rows.every(labelEditorRow)
        ? {
            type: 'labelEditor',
            session: m.session,
            heading: m.heading,
            rows: m.rows,
          }
        : null;
    case 'labelsChanged':
      return isString(m.session) ? { type: 'labelsChanged', session: m.session } : null;
    case 'openLabelEditor':
      return isString(m.session) ? { type: 'openLabelEditor', session: m.session } : null;
    case 'showSessionDetails':
      return isString(m.session) && m.session.length > 0 ? { type: 'showSessionDetails', session: m.session } : null;
    case 'openViewEditor':
      return isString(m.view) && (m.mode === 'rename' || m.mode === 'delete')
        ? { type: 'openViewEditor', view: m.view, mode: m.mode }
        : null;
    case 'openSessionRename':
      return isString(m.session) && m.session.length > 0 && isString(m.title)
        ? { type: 'openSessionRename', session: m.session, title: m.title }
        : null;
    case 'sessionRenameResult':
      return isString(m.session) &&
        m.session.length > 0 &&
        Number.isSafeInteger(m.request) &&
        isString(m.title) &&
        isString(m.error)
        ? {
            type: 'sessionRenameResult',
            session: m.session,
            request: m.request as number,
            title: m.title,
            error: m.error,
          }
        : null;
    case 'focusComposer':
      return isString(m.session) ? { type: 'focusComposer', session: m.session } : null;
    case 'contextDetail':
      if (m.detail && typeof m.detail === 'object' && 'messageBreakdown' in m.detail && !validContextDetail(m.detail)) {
        const { messageBreakdown: _messageBreakdown, ...categories } = m.detail;
        if (validContextDetail(categories)) return { type: 'contextDetail', detail: categories };
      }
      return validContextDetail(m.detail)
        ? { type: 'contextDetail', detail: m.detail }
        : contextIdentity(m.detail)
          ? {
              type: 'contextDetail',
              detail: unavailableContext({
                session: m.detail.session,
                provider: m.detail.provider,
                model: m.detail.model,
                source: m.detail.source,
                generation: m.detail.generation,
                request: m.detail.request,
              }),
            }
          : null;
    case 'pathCompletion':
      return isString(m.session) &&
        isFiniteNumber(m.request) &&
        isString(m.token) &&
        isFiniteNumber(m.caret) &&
        Array.isArray(m.rows) &&
        m.rows.every(pathEntry)
        ? {
            type: 'pathCompletion',
            session: m.session,
            request: m.request,
            token: m.token,
            caret: m.caret,
            rows: m.rows,
          }
        : null;
    case 'insertPrompt':
      return isString(m.session) && isString(m.text)
        ? { type: 'insertPrompt', session: m.session, text: m.text }
        : null;
    case 'fileStaging':
      return isString(m.session)
        ? {
            type: 'fileStaging',
            session: m.session,
            token: textOr(m.token, ''),
            pending: m.pending === true,
            ...(typeof m.count === 'number' && Number.isInteger(m.count) && m.count > 0 ? { count: m.count } : {}),
          }
        : null;
    case 'fileStagingRejected':
      return isString(m.session) && isString(m.token)
        ? { type: 'fileStagingRejected', session: m.session, token: m.token }
        : null;
    case 'usage':
      return { type: 'usage', usage: m.usage as PanelUsage | null };
    case 'askRejected':
      return isString(m.session) && isString(m.id) ? { type: 'askRejected', session: m.session, id: m.id } : null;
    case 'projectSpend':
      return { type: 'projectSpend', projectSpend: m.projectSpend as ProjectSpend | null };
    case 'layout': {
      const layout = record(m.layout);
      return layout && isCardLayout(layout.cardLayout) && isPromptPosition(layout.promptPosition)
        ? { type: 'layout', layout: { cardLayout: layout.cardLayout, promptPosition: layout.promptPosition } }
        : null;
    }
    case 'live':
      return isString(m.session) && Array.isArray(m.live) && m.live.every(composerLive)
        ? { type: 'live', session: m.session, live: m.live }
        : null;
    case 'activity':
      return records(m.cards)
        ? { type: 'activity', cards: m.cards as unknown as PanelCard[] }
        : isString(m.session)
          ? { type: 'activity', session: m.session, card: m.card as PanelCard }
          : null;
    case 'selection':
      return validQueryContext(m.queryContext) &&
        records(m.cards) &&
        records(m.sessions) &&
        records(m.rail) &&
        record(m.stats) !== null &&
        strings(m.replaces)
        ? (m as unknown as SelectionMessage)
        : null;
    case 'rail': {
      const stats = record(m.stats);
      const sessionAdoptions = m.sessionAdoptions === undefined ? [] : m.sessionAdoptions;
      return validQueryContext(m.queryContext) &&
        records(m.rail) &&
        stats !== null &&
        Array.isArray(m.labels) &&
        m.labels.every(labelCount) &&
        savedViews(m.views) &&
        savedRailFilters(m.railFilters) &&
        Array.isArray(sessionAdoptions) &&
        sessionAdoptions.every(sessionAdoption) &&
        strings(m.hidden) &&
        strings(m.pinnedTop) &&
        rowDeltaHeaderValid(m.rows)
        ? {
            type: 'rail',
            ...(m.queryContext === undefined ? {} : { queryContext: m.queryContext as SessionQueryContext }),
            rail: m.rail as PanelRailCard[],
            stats: stats as Record<string, PanelStat[]>,
            labels: m.labels,
            views: m.views,
            railFilters: m.railFilters,
            sessionAdoptions,
            hidden: m.hidden,
            pinnedTop: m.pinnedTop,
            ...(m.rows === undefined ? {} : { rows: m.rows as RowDeltaHeader }),
          }
        : null;
    }
    case 'openPick':
      return isString(m.control) ? { type: 'openPick', control: m.control } : null;
    case 'takeDraft':
      return isString(m.session) && isString(m.text) ? { type: 'takeDraft', session: m.session, text: m.text } : null;
    case 'takeQueuedDraft':
      return isString(m.session) &&
        isString(m.text) &&
        Number.isSafeInteger(m.revision) &&
        (m.revision as number) >= 0 &&
        isString(m.value)
        ? {
            type: 'takeQueuedDraft',
            session: m.session,
            text: m.text,
            revision: m.revision as number,
            value: m.value,
          }
        : null;
    case 'promptRecovery':
      try {
        return { type: 'promptRecovery', submittedPrompts: mergeSubmittedPrompts(m.submittedPrompts) };
      } catch {
        return null;
      }
    case 'requestPromptRecovery':
      return isString(m.request) ? { type: 'requestPromptRecovery', request: m.request } : null;
    case 'restoreDraft':
      return isString(m.session) && isString(m.text) && typeof m.revision === 'number'
        ? {
            type: 'restoreDraft',
            session: m.session,
            text: m.text,
            revision: m.revision,
          }
        : null;
    case 'notes':
      return { type: 'notes', comments: m.comments as TurnComment[] };
    case 'openComment':
      return isString(m.key) ? { type: 'openComment', key: m.key } : null;
    case 'sendSelectedText':
      return isString(m.key) && m.key.length > 0 && typeof m.copyLabels === 'boolean'
        ? { type: 'sendSelectedText', key: m.key, copyLabels: m.copyLabels }
        : null;
    case 'readerDocument':
      return [m.readerPageId, m.documentId, m.challenge].every(
        (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value),
      )
        ? (m as Extract<HostToPanel, { type: 'readerDocument' }>)
        : null;
    case 'readerReadAdmission':
      return isString(m.id) && m.id.length <= 128 && typeof m.admitted === 'boolean'
        ? { type: 'readerReadAdmission', id: m.id, admitted: m.admitted }
        : null;
    case 'readState': {
      const state = parseReadSynchronization(m.state);
      return state ? { type: 'readState', state } : null;
    }
    case 'setRead':
      return isString(m.key) ? { type: 'setRead', key: m.key, read: m.read === true } : null;
    case 'forgetState':
      return typeof m.since === 'number' ? { type: 'forgetState', since: m.since } : null;
    case 'setSessionRead':
      return isString(m.session) ? { type: 'setSessionRead', session: m.session, read: m.read === true } : null;
    case 'setSessionArchived':
      return isString(m.session)
        ? { type: 'setSessionArchived', session: m.session, archived: m.archived === true }
        : null;
    case 'setSessionPinned':
      return isString(m.session) ? { type: 'setSessionPinned', session: m.session, pinned: m.pinned === true } : null;
    case 'setComposerHidden':
      return { type: 'setComposerHidden', hidden: m.hidden === true };
    case 'results':
      return isString(m.query) && isString(m.scope)
        ? { type: 'results', query: m.query, hits: m.hits as SearchHit[], scope: m.scope }
        : null;
    case 'render': {
      // Preserve the complete render object described by RenderMessage.
      const adoptions = m.sessionAdoptions;
      return validQueryContext(m.queryContext) &&
        records(m.cards) &&
        records(m.sessions) &&
        records(m.rail) &&
        record(m.stats) !== null &&
        strings(m.hidden) &&
        strings(m.pinnedTop) &&
        records(m.comments) &&
        Array.isArray(m.labels) &&
        m.labels.every(labelCount) &&
        savedViews(m.views) &&
        savedRailFilters(m.railFilters) &&
        Array.isArray(m.iconFonts) &&
        m.iconFonts.every(isString) &&
        Array.isArray(adoptions) &&
        adoptions.every(sessionAdoption) &&
        rowDeltaHeaderValid(m.rows)
        ? (m as RenderMessage)
        : null;
    }
    default:
      return null;
  }
}

function validQueryContext(value: unknown): boolean {
  if (value === undefined) return true;
  const context = record(value);
  return (
    !!context &&
    ['complete', 'incomplete', 'unavailable'].includes(String(context.coverage)) &&
    isString(context.scope) &&
    isString(context.revision) &&
    Array.isArray(context.identities) &&
    context.identities.every((value) => {
      const identity = record(value);
      return !!identity && isString(identity.sessionId) && isString(identity.agent);
    })
  );
}

export function parsePanelToHost(raw: unknown): PanelToHost | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  switch (m.type) {
    case 'readerRead': {
      const operation = parseReaderOperation(m.operation);
      return operation ? { type: 'readerRead', operation } : null;
    }
    case 'sessionFilterApplied':
      return Object.keys(m).sort().join(',') === 'request,state,type' &&
        isString(m.request) &&
        m.request.length > 0 &&
        m.request.length <= 128 &&
        record(m.state)
        ? { type: 'sessionFilterApplied', request: m.request, state: m.state }
        : null;
    case 'health':
      return Number.isSafeInteger(m.sequence) && (m.sequence as number) > 0
        ? { type: 'health', sequence: m.sequence as number }
        : null;
    case 'ready': {
      const names = ['readerPageId', 'readerDocumentId', 'readerChallenge'] as const;
      if (names.some((key) => m[key] !== undefined && (typeof m[key] !== 'string' || !/^[a-f0-9]{32}$/.test(m[key]))))
        return null;
      if (m.readerChallenge !== undefined && (m.readerPageId === undefined || m.readerDocumentId === undefined))
        return null;
      return {
        type: 'ready',
        ...Object.fromEntries(names.filter((key) => m[key] !== undefined).map((key) => [key, m[key]])),
      };
    }
    case 'painted':
      return Number.isSafeInteger(m.generation) &&
        (m.generation as number) >= 0 &&
        (m.stage === 'railReady' || m.stage === 'firstCard' || m.stage === 'completeRender')
        ? {
            type: 'painted',
            generation: m.generation as number,
            stage: m.stage,
            ...(m.usableRows === true ? { usableRows: true as const } : {}),
          }
        : null;
    case 'rowsGap':
      return { type: 'rowsGap' };
    case 'initialize':
      return { type: 'initialize' };
    case 'developmentReload':
      return { type: 'developmentReload' };
    case 'refresh':
      return { type: 'refresh' };
    case 'perf':
      return hostToPanelKind(m.kind) && isFiniteNumber(m.ms) && m.ms >= 0
        ? { type: 'perf', kind: m.kind, ms: m.ms }
        : null;
    case 'goBack':
      return { type: 'goBack' };
    case 'goForward':
      return { type: 'goForward' };
    case 'newSession': {
      if (m.owner !== undefined && !isString(m.owner)) return null;
      const ownership = m.owner === undefined ? {} : { owner: m.owner };
      // An omitted request starts the default setup. Reject a malformed request rather than starting a setup the reader did not choose.
      if (m.request === undefined) {
        return { type: 'newSession', ...ownership };
      }
      const request = launcherRequest(m.request);
      return request ? { type: 'newSession', request, ...ownership } : null;
    }
    case 'pinSetup': {
      if (m.owner !== undefined && !isString(m.owner)) return null;
      const ownership = m.owner === undefined ? {} : { owner: m.owner };
      const request = launcherRequest(m.request);
      if (!request) return null;
      if (request.kind === 'custom') return { type: 'pinSetup', request, ...ownership };
      const values = normalizeSetupValues(record(m.request)?.values);
      return values ? { type: 'pinSetup', request: { ...request, values }, ...ownership } : null;
    }
    case 'unpinSetup':
      return (m.owner === undefined || isString(m.owner)) &&
        isString(m.id) &&
        m.id.trim().length > 0 &&
        m.id.length <= SETUP_ID_LIMIT
        ? { type: 'unpinSetup', id: m.id, ...(m.owner === undefined ? {} : { owner: m.owner }) }
        : null;
    case 'refreshUsage':
      return {
        type: 'refreshUsage',
        agent: isString(m.agent) ? m.agent : null,
        force: m.force === true,
      };
    case 'requestDefaults':
      return (m.agent === 'claude' || m.agent === 'codex') && isString(m.model) && m.model.length <= 200
        ? { type: 'requestDefaults', agent: m.agent, model: m.model }
        : null;
    case 'openControl':
      return isString(m.control) && isString(m.session)
        ? { type: 'openControl', control: m.control, session: m.session }
        : null;
    case 'pick':
      return isString(m.agent) && isString(m.value) && isString(m.session)
        ? {
            type: 'pick',
            control: String(m.control),
            agent: m.agent,
            session: m.session,
            model: textOr(m.model, ''),
            value: m.value,
          }
        : null;
    case 'draft':
      return isString(m.text) && isString(m.session)
        ? {
            type: 'draft',
            text: m.text,
            keep: textOr(m.keep, m.text),
            session: m.session,
            ...(Number.isSafeInteger(m.revision) ? { revision: m.revision as number } : {}),
          }
        : null;
    case 'contextDetail':
      return contextString(m.session) && !!m.session && contextNumber(m.request) && contextNumber(m.generation)
        ? { type: 'contextDetail', session: m.session, request: m.request, generation: m.generation }
        : null;
    case 'pathCompletion':
      return isString(m.session) && isFiniteNumber(m.request) && isString(m.token) && isFiniteNumber(m.caret)
        ? { type: 'pathCompletion', session: m.session, request: m.request, token: m.token, caret: m.caret }
        : null;
    case 'answerAsk': {
      if (!isString(m.session) || !isString(m.id)) {
        return null;
      }
      const answer = askAnswer(m.answer);
      return answer ? { type: 'answerAsk', session: m.session, id: m.id, answer } : null;
    }
    case 'dropUris':
      return isString(m.session) ? { type: 'dropUris', session: m.session, ...dropPayload(m) } : null;
    case 'beginFileStaging':
      return isString(m.session) ? { type: 'beginFileStaging', session: m.session, token: textOr(m.token, '') } : null;
    case 'attachFiles':
      // Pass files through for host validation. The host reports malformed batches to the reader.
      return isString(m.session)
        ? {
            type: 'attachFiles',
            session: m.session,
            token: textOr(m.token, ''),
            clipboard: m.clipboard === true,
            files: m.files,
          }
        : null;
    case 'fileReadError':
      return isString(m.session)
        ? {
            type: 'fileReadError',
            session: m.session,
            token: textOr(m.token, ''),
            name: textOr(m.name, ''),
          }
        : null;
    case 'fileRejected':
      return isString(m.session)
        ? {
            type: 'fileRejected',
            session: m.session,
            code: textOr(m.code, 'read'),
            name: textOr(m.name, ''),
            size: numberOr(m.size, 0),
            rejected: numberOr(m.rejected, 0),
          }
        : null;
    case 'removeFile':
      return isString(m.session) && isString(m.value)
        ? { type: 'removeFile', session: m.session, value: m.value }
        : null;
    case 'importPromptRecovery':
      return {
        type: 'importPromptRecovery',
        submittedPrompts: m.submittedPrompts,
        ...(isString(m.request) ? { request: m.request } : {}),
      };
    case 'sendPrompt':
      // Invalid or missing revisions normalize to zero.
      return isString(m.text) && isString(m.session)
        ? {
            type: 'sendPrompt',
            text: m.text,
            session: m.session,
            ...(m.attempt && typeof m.attempt === 'object' ? { attempt: m.attempt as SubmittedPrompt } : {}),
            revision:
              typeof m.revision === 'number' && Number.isSafeInteger(m.revision) && m.revision >= 0 ? m.revision : 0,
          }
        : null;
    case 'compact':
      return isString(m.session) ? { type: 'compact', session: m.session } : null;
    case 'dismissLive':
      return isString(m.session) ? { type: 'dismissLive', session: m.session, kind: textOr(m.kind, '') } : null;
    case 'restoreLive':
      return isString(m.session) ? { type: 'restoreLive', session: m.session, kind: textOr(m.kind, '') } : null;
    case 'stopTurn':
      return isString(m.session) ? { type: 'stopTurn', session: m.session } : null;
    case 'dequeue':
      return isString(m.value) && isString(m.session) ? { type: 'dequeue', value: m.value, session: m.session } : null;
    case 'editQueued':
      return isString(m.value) && isString(m.session) && Number.isSafeInteger(m.revision) && (m.revision as number) >= 0
        ? { type: 'editQueued', value: m.value, session: m.session, revision: m.revision as number }
        : null;
    case 'acceptQueuedEdit':
      return isString(m.value) &&
        isString(m.session) &&
        Number.isSafeInteger(m.revision) &&
        (m.revision as number) >= 0 &&
        Number.isSafeInteger(m.currentRevision) &&
        (m.currentRevision as number) >= 0 &&
        typeof m.accepted === 'boolean'
        ? {
            type: 'acceptQueuedEdit',
            value: m.value,
            session: m.session,
            revision: m.revision as number,
            currentRevision: m.currentRevision as number,
            accepted: m.accepted,
          }
        : null;
    case 'copy':
      return isString(m.text) ? { type: 'copy', text: m.text } : null;
    case 'note':
      return { type: 'note', note: m.note };
    case 'armSelectedText':
      return isString(m.session) && m.session.length > 0 && isString(m.key) && m.key.length > 0
        ? { type: 'armSelectedText', session: m.session, key: m.key }
        : null;
    case 'selectedTextHandoff':
      return isString(m.session) &&
        m.session.length > 0 &&
        isString(m.key) &&
        m.key.length > 0 &&
        isString(m.text) &&
        m.text.trim().length > 0 &&
        typeof m.copyLabels === 'boolean'
        ? {
            type: 'selectedTextHandoff',
            session: m.session,
            key: m.key,
            text: m.text,
            copyLabels: m.copyLabels,
          }
        : null;
    case 'armSessionDetails':
      return isString(m.session) && m.session.length > 0 ? { type: 'armSessionDetails', session: m.session } : null;
    case 'armComposer':
      return { type: 'armComposer' };
    case 'showReaderParent':
      return isString(m.session) && m.session.length > 0 ? { type: 'showReaderParent', session: m.session } : null;
    case 'showSession':
      return isString(m.session) && (m.responseLink === undefined || m.responseLink === true)
        ? {
            type: 'showSession',
            session: m.session,
            ...(m.parent === true ? { parent: true as const } : {}),
            ...(m.responseLink === true ? { responseLink: true as const } : {}),
          }
        : null;
    case 'labelEditor':
      return isString(m.session) ? { type: 'labelEditor', session: m.session } : null;
    case 'setLabels':
      // Drop non-string names and pass the remaining complete label list to the host.
      return isString(m.session) && Array.isArray(m.names)
        ? { type: 'setLabels', session: m.session, names: m.names.filter(isString) }
        : null;
    case 'setViews':
      // Reject the whole list if any view is malformed. Dropping an entry would delete a view still visible in the panel.
      return savedViews(m.views) ? { type: 'setViews', views: m.views } : null;
    case 'renameSession':
      return isString(m.session) && m.session.length > 0 && Number.isSafeInteger(m.request) && isString(m.title)
        ? { type: 'renameSession', session: m.session, request: m.request as number, title: m.title }
        : null;
    case 'setRailFilters':
      return savedRailFilters(m.railFilters) ? { type: 'setRailFilters', railFilters: m.railFilters } : null;
    case 'sessionMembership':
      if (!isString(m.session)) {
        return null;
      }
      if (m.action === 'pin') {
        if (m.openPinned !== undefined && typeof m.openPinned !== 'boolean') {
          return null;
        }
        return {
          type: 'sessionMembership',
          action: m.action,
          session: m.session,
          ...(m.openPinned === true ? { openPinned: true } : {}),
        };
      }
      return m.action === 'archive' || m.action === 'unarchive' || m.action === 'unpin'
        ? { type: 'sessionMembership', action: m.action, session: m.session }
        : null;
    case 'setLayout':
      if (m.key === 'cardLayout' && isCardLayout(m.value)) {
        return { type: 'setLayout', key: 'cardLayout', value: m.value };
      }
      if (m.key === 'promptPosition' && isPromptPosition(m.value)) {
        return { type: 'setLayout', key: 'promptPosition', value: m.value };
      }
      return null;
    case 'exportSession':
      return isString(m.session) && m.session.length > 0 ? { type: 'exportSession', session: m.session } : null;
    case 'saveState':
      // normalizePanelState accepts unknown state values.
      return { type: 'saveState', state: m.state };
    case 'search':
      return { type: 'search', text: textOr(m.text, ''), ...(m.retained === true ? { retained: true } : {}) };
    case 'loadOlder':
      return isString(m.session) ? { type: 'loadOlder', session: m.session, token: textOr(m.token, '') } : null;
    case 'openLink':
      if (m.destination !== undefined) {
        const destination = record(m.destination);
        return destination && destination.kind === 'fileCitation' && isString(destination.path) && m.href === undefined
          ? {
              type: 'openLink',
              destination: { kind: 'fileCitation', path: destination.path },
              beside: m.beside === true,
            }
          : null;
      }
      return isString(m.href) ? { type: 'openLink', href: m.href, beside: m.beside === true } : null;
    case 'openVisualization':
      return isString(m.path) ? { type: 'openVisualization', path: m.path } : null;
    case 'openImage':
      return isString(m.path) ? { type: 'openImage', path: m.path, beside: m.beside === true } : null;
    case 'openTurnDiff':
      return isString(m.key) ? { type: 'openTurnDiff', key: m.key, beside: m.beside === true } : null;
    case 'openCommit':
      // Preserve a missing directory as null. The host reports commits whose directory is unavailable.
      return isString(m.key) && isString(m.sha)
        ? {
            type: 'openCommit',
            key: m.key,
            sha: m.sha,
            dir: isString(m.dir) ? m.dir : null,
            beside: m.beside === true,
          }
        : null;
    case 'openFile':
      return isString(m.key) && isString(m.path)
        ? {
            type: 'openFile',
            key: m.key,
            path: m.path,
            beside: m.beside === true,
            ...(isString(m.sourceSessionId) ? { sourceSessionId: m.sourceSessionId } : {}),
          }
        : null;
    case 'openSkill':
      return isString(m.key) && isString(m.path)
        ? { type: 'openSkill', key: m.key, path: m.path, beside: m.beside === true }
        : null;
    default:
      return null;
  }
}

// Every message variant requires a named handler. Missing handlers fail the typecheck.
type Handlers<M extends { type: string }, R> = {
  [K in M['type']]: (message: Extract<M, { type: K }>) => R;
};

export type HostToPanelHandlers = Handlers<HostToPanel, void>;
export type PanelToHostHandlers<R> = Handlers<PanelToHost, R>;

// The default branch assigns to never, so unhandled variants fail the typecheck.
export function dispatchHostToPanel(message: HostToPanel, handlers: HostToPanelHandlers): void {
  switch (message.type) {
    case 'readerDocument':
      return handlers.readerDocument(message);
    case 'readerReadAdmission':
      return handlers.readerReadAdmission(message);
    case 'readState':
      return handlers.readState(message);
    case 'applySessionFilter':
      return handlers.applySessionFilter(message);
    case 'health':
      return handlers.health(message);
    case 'visibility':
      return handlers.visibility(message);
    case 'startupProgress':
      return handlers.startupProgress(message);
    case 'focusProjectSpend':
      return handlers.focusProjectSpend(message);
    case 'openLauncher':
      return handlers.openLauncher(message);
    case 'labelEditor':
      return handlers.labelEditor(message);
    case 'labelsChanged':
      return handlers.labelsChanged(message);
    case 'openLabelEditor':
      return handlers.openLabelEditor(message);
    case 'showSessionDetails':
      return handlers.showSessionDetails(message);
    case 'openViewEditor':
      return handlers.openViewEditor(message);
    case 'openSessionRename':
      return handlers.openSessionRename(message);
    case 'sessionRenameResult':
      return handlers.sessionRenameResult(message);
    case 'focusComposer':
      return handlers.focusComposer(message);
    case 'contextDetail':
      return handlers.contextDetail(message);
    case 'pathCompletion':
      return handlers.pathCompletion(message);
    case 'insertPrompt':
      return handlers.insertPrompt(message);
    case 'fileStaging':
      return handlers.fileStaging(message);
    case 'fileStagingRejected':
      return handlers.fileStagingRejected(message);
    case 'usage':
      return handlers.usage(message);
    case 'askRejected':
      return handlers.askRejected(message);
    case 'projectSpend':
      return handlers.projectSpend(message);
    case 'layout':
      return handlers.layout(message);
    case 'live':
      return handlers.live(message);
    case 'activity':
      return handlers.activity(message);
    case 'rail':
      return handlers.rail(message);
    case 'openPick':
      return handlers.openPick(message);
    case 'takeDraft':
      return handlers.takeDraft(message);
    case 'takeQueuedDraft':
      return handlers.takeQueuedDraft(message);
    case 'promptRecovery':
      return handlers.promptRecovery(message);
    case 'requestPromptRecovery':
      return handlers.requestPromptRecovery(message);
    case 'restoreDraft':
      return handlers.restoreDraft(message);
    case 'notes':
      return handlers.notes(message);
    case 'openComment':
      return handlers.openComment(message);
    case 'sendSelectedText':
      return handlers.sendSelectedText(message);
    case 'setRead':
      return handlers.setRead(message);
    case 'forgetState':
      return handlers.forgetState(message);
    case 'setSessionRead':
      return handlers.setSessionRead(message);
    case 'setSessionArchived':
      return handlers.setSessionArchived(message);
    case 'setSessionPinned':
      return handlers.setSessionPinned(message);
    case 'setComposerHidden':
      return handlers.setComposerHidden(message);
    case 'results':
      return handlers.results(message);
    case 'selection':
      return handlers.selection(message);
    case 'render':
      return handlers.render(message);
    default: {
      const missing: never = message;
      return missing;
    }
  }
}

export function dispatchPanelToHost<R>(message: PanelToHost, handlers: PanelToHostHandlers<R>): R {
  switch (message.type) {
    case 'readerRead':
      return handlers.readerRead(message);
    case 'sessionFilterApplied':
      return handlers.sessionFilterApplied(message);
    case 'health':
      return handlers.health(message);
    case 'ready':
      return handlers.ready(message);
    case 'painted':
      return handlers.painted(message);
    case 'rowsGap':
      return handlers.rowsGap(message);
    case 'initialize':
      return handlers.initialize(message);
    case 'developmentReload':
      return handlers.developmentReload(message);
    case 'refresh':
      return handlers.refresh(message);
    case 'perf':
      return handlers.perf(message);
    case 'goBack':
      return handlers.goBack(message);
    case 'goForward':
      return handlers.goForward(message);
    case 'newSession':
      return handlers.newSession(message);
    case 'pinSetup':
      return handlers.pinSetup(message);
    case 'unpinSetup':
      return handlers.unpinSetup(message);
    case 'refreshUsage':
      return handlers.refreshUsage(message);
    case 'requestDefaults':
      return handlers.requestDefaults(message);
    case 'openControl':
      return handlers.openControl(message);
    case 'pick':
      return handlers.pick(message);
    case 'draft':
      return handlers.draft(message);
    case 'contextDetail':
      return handlers.contextDetail(message);
    case 'pathCompletion':
      return handlers.pathCompletion(message);
    case 'answerAsk':
      return handlers.answerAsk(message);
    case 'dropUris':
      return handlers.dropUris(message);
    case 'beginFileStaging':
      return handlers.beginFileStaging(message);
    case 'attachFiles':
      return handlers.attachFiles(message);
    case 'fileReadError':
      return handlers.fileReadError(message);
    case 'fileRejected':
      return handlers.fileRejected(message);
    case 'removeFile':
      return handlers.removeFile(message);
    case 'importPromptRecovery':
      return handlers.importPromptRecovery(message);
    case 'sendPrompt':
      return handlers.sendPrompt(message);
    case 'compact':
      return handlers.compact(message);
    case 'dismissLive':
      return handlers.dismissLive(message);
    case 'restoreLive':
      return handlers.restoreLive(message);
    case 'stopTurn':
      return handlers.stopTurn(message);
    case 'dequeue':
      return handlers.dequeue(message);
    case 'editQueued':
      return handlers.editQueued(message);
    case 'acceptQueuedEdit':
      return handlers.acceptQueuedEdit(message);
    case 'copy':
      return handlers.copy(message);
    case 'note':
      return handlers.note(message);
    case 'armSelectedText':
      return handlers.armSelectedText(message);
    case 'selectedTextHandoff':
      return handlers.selectedTextHandoff(message);
    case 'armSessionDetails':
      return handlers.armSessionDetails(message);
    case 'armComposer':
      return handlers.armComposer(message);
    case 'showReaderParent':
      return handlers.showReaderParent(message);
    case 'showSession':
      return handlers.showSession(message);
    case 'labelEditor':
      return handlers.labelEditor(message);
    case 'setLabels':
      return handlers.setLabels(message);
    case 'setViews':
      return handlers.setViews(message);
    case 'renameSession':
      return handlers.renameSession(message);
    case 'setRailFilters':
      return handlers.setRailFilters(message);
    case 'sessionMembership':
      return handlers.sessionMembership(message);
    case 'setLayout':
      return handlers.setLayout(message);
    case 'exportSession':
      return handlers.exportSession(message);
    case 'saveState':
      return handlers.saveState(message);
    case 'search':
      return handlers.search(message);
    case 'loadOlder':
      return handlers.loadOlder(message);
    case 'openLink':
      return handlers.openLink(message);
    case 'openVisualization':
      return handlers.openVisualization(message);
    case 'openImage':
      return handlers.openImage(message);
    case 'openTurnDiff':
      return handlers.openTurnDiff(message);
    case 'openCommit':
      return handlers.openCommit(message);
    case 'openFile':
      return handlers.openFile(message);
    case 'openSkill':
      return handlers.openSkill(message);
    default: {
      const missing: never = message;
      return missing;
    }
  }
}
