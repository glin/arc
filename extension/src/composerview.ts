import {
  modelPicks,
  selectedModelPick,
  resolvedChoice,
  effortPicks,
  modelLabel,
  effortLabel,
  defaultsForModel,
  modelAfterPick,
  effortAfterPick,
  recordedChoice,
  windowedChoice,
  type DefaultContext,
} from './view/model-picks';
import { CARD_ACTIONS } from './view/card-words';
// Prepares Prompt box state, permission requests, and answers without importing `vscode`.
// The host and webview consume these decisions.

import {
  AgentPrompt,
  Ask,
  AskAnswer,
  CodexEffectiveMode,
  EffortChoice,
  McpServer,
  ModelChoice,
  PromptAsset,
  PromptEntry,
} from './agentwire';
import {
  assetKindWord,
  splitAssetName,
  StoredPromptAsset,
  MAX_PROMPT_ASSETS,
  MAX_PROMPT_ASSET_BYTES,
  MAX_PROMPT_ASSET_TOTAL_BYTES,
} from './promptassets';
import { formatMegabytes } from './turnformat';
import { PermissionMode, type RemoteControlResult } from './claudewire';
// `mcpview.ts` prepares the Servers control and menu. This module places the control
// on the row. Type-only imports there prevent a runtime dependency cycle.
import { mcpMenu, mcpPick } from './mcpview';
import { WINDOW_SUFFIX, modelWindowOf, sameModelIdentity } from './domain/model-identity';
import { AgentKind, Turn, cleanPrompt } from './transcript';
import { LINE_BREAK, matchCommandNames, remoteControlRequest, renameRequest } from './domain/composer-editing';
import { isLocalLinkPath } from './domain/link-path';
import { completedQuestionAnswer } from './domain/ask-answer';
import { escapeHtml, renderRichMarkdown, renderInlineMarkdown, visibleTextOf } from './richtext';
export {
  historyPress,
  matchCommandNames,
  pathToken,
  promptToken,
  remoteControlRequest,
  renameRequest,
} from './domain/composer-editing';
export type { HistoryPress, PathToken, PromptToken } from './domain/composer-editing';
export { HISTORY_SAID_CHARS, historySaid } from './view/composer-editing';
import {
  bandForPercent,
  commentsFor,
  ContextLevel,
  emitComments,
  formatRelative,
  formatWhen,
  headLabel,
  DRAFT_TEXT_LIMIT,
  QUEUED_TEXT_CHARS,
  NEEDS_INPUT,
  NextTurnBasis,
  noteName,
  normalizeSentPrompts,
  PROMPT_HISTORY_ENTRY_CHARS,
  QUEUED_SUBMISSION_LIMIT,
  QueuedSubmission,
  shortModel,
  STATUS_WORDS,
  TurnComment,
  wholePercent,
} from './turnview';
import {
  CACHE_LIFETIME_MS,
  CacheTier,
  cacheLifetimeFor,
  CONSERVATIVE_CACHE_BOUNDARY_MS,
  contextWindowFor,
  formatConservativeCost,
  nextTurnFloor,
  effortChangeKeepsCache,
} from './pricing';
import { CACHE_SPAN_MINIMUM_SECONDS } from './view/time';
import { looksLikeComments } from './turncomments';
// `transcript.ts` describes tool input for both turn cards and permission requests.
// Re-export the shared description for request presentation.
import { describeToolInput, firstLine } from './transcript';
export { describeToolInput };
import { activityDetail } from './activitydetail';
import { USAGE_AGENT_NAMES } from './usageview';
import type { PendingAskPosition } from './turncard';
import { launcherCustomRequest } from './view/launcher';
import type {
  SessionLauncherView,
  SessionProfile,
  LauncherAgent,
  LauncherModel,
  LauncherProfileRow,
  LauncherPinnedRow,
  LauncherRequest,
  LauncherValue,
} from './view/launcher';
export {
  customProfileName,
  type SessionLauncherView,
  type SessionProfile,
  type LauncherAgent,
  type LauncherModel,
  type LauncherProfileRow,
  type LauncherPinnedRow,
  type LauncherRequest,
  type LauncherValue,
} from './view/launcher';
import {
  missingSetupValue,
  RECENT_SETUP_LIMIT,
  visibleRecents,
  type PinnedSetup,
  type SetupValueName,
} from './domain/session-setups';

// Read only the table's own keys. Inherited keys such as `toString` and `constructor`
// must not return functions in place of rows for stored agent names.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// Each agent has its own permission control and labels. Claude choices use permission modes.
// Codex presets combine approval policy, reviewer, and sandbox access.
// Keep these tables aligned with the presets each agent offers.
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type ApprovalsReviewer = 'user' | 'auto_review';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface AskMode {
  // The preset key stored in workspace state.
  value: string;
  label: string;
  // The permission description under the label.
  description: string;
  // Claude takes this at spawn as `--permission-mode`, and again while the child runs as a
  // `set_permission_mode` control request.
  claude?: PermissionMode;
  // Codex takes these at `thread/start`, and again on any `turn/start`, which overrides them
  // for that turn and the ones after it.
  codex?: {
    approvalPolicy: ApprovalPolicy;
    approvalsReviewer: ApprovalsReviewer;
    sandbox: SandboxMode;
  };
}

// Arc offers Auto, Manual, Edit automatically, and Plan for Claude. Each description
// states what the mode runs without approval. Arc omits `bypassPermissions`, which
// skips permission checks, and `dontAsk`, which denies actions requiring approval.
export const CLAUDE_ASK_MODES: readonly AskMode[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Claude acts without routine prompts, and a separate model reviews actions before they run',
    claude: 'auto',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Claude asks before it edits a file, runs a command, or reaches the network',
    claude: 'manual',
  },
  {
    value: 'acceptEdits',
    label: 'Edit automatically',
    description: 'Claude edits files and runs common file commands without asking, and prompts for everything else',
    claude: 'acceptEdits',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Claude researches and proposes changes without making them',
    claude: 'plan',
  },
];

// Codex permission presets combine access, approval policy, and reviewer.
// `on-request` with the `user` reviewer asks the reader. The same policy with
// `auto_review` sends eligible actions to automatic review.
export const CODEX_ASK_MODES: readonly AskMode[] = [
  {
    value: 'read-only',
    label: 'Read Only',
    description:
      'Codex can read files in the current workspace. Approval is required to edit files or access the internet.',
    codex: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' },
  },
  {
    value: 'untrusted',
    label: 'Ask for approval',
    description:
      'Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.',
    codex: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' },
  },
  {
    value: 'on-request',
    label: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe.',
    codex: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' },
  },
  {
    value: 'never',
    label: 'Full Access',
    description:
      'Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.',
    codex: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' },
  },
];

// Each menu heading names its agent's permission choice. Claude asks how often
// to request approval. Codex asks how actions receive approval.
export const ASK_MODE_HEADS: Record<string, string> = {
  claude: 'How much should Claude ask before it acts?',
  codex: 'How should Codex actions be approved?',
};

const ASK_MODE_TABLES: Record<string, readonly AskMode[]> = {
  claude: CLAUDE_ASK_MODES,
  codex: CODEX_ASK_MODES,
};

// The explicit mode a new setup preselects, and the mode a legacy or unknown value presents.
const DEFAULT_ASK_VALUES: Record<string, string> = { claude: 'auto', codex: 'on-request' };

// Return the named agent's modes. Unknown agents use Claude's modes.
export function askModes(agent: string): readonly AskMode[] {
  return own(ASK_MODE_TABLES, agent) ?? CLAUDE_ASK_MODES;
}

export function defaultAskMode(agent: string): AskMode {
  const modes = askModes(agent);
  const value = own(DEFAULT_ASK_VALUES, agent);
  return modes.find((m) => m.value === value) ?? modes[0];
}

// The mode a stored value names, or the agent's default when it has one. Codex falls back to
// no mode, so a session with no stored pick lets Codex apply the user's configuration.
export function askMode(agent: 'claude', value: string | undefined): AskMode;
export function askMode(agent: string, value: string | undefined): AskMode | undefined;
export function askMode(agent: string, value: string | undefined): AskMode | undefined {
  const chosen = askModes(agent).find((m) => m.value === value);
  return chosen ?? (agent === 'codex' ? undefined : defaultAskMode(agent));
}

// A session setting overrides the saved choice only while it still names a row. The empty
// value is an explicit agent default, while a retired value falls back to the saved choice.
export function savedAskMode(
  agent: string,
  sessionValue: string | undefined,
  savedValue: string | undefined,
): AskMode | undefined {
  if (sessionValue === '') {
    return undefined;
  }
  return (
    askModes(agent).find((mode) => mode.value === sessionValue) ?? (savedValue ? askMode(agent, savedValue) : undefined)
  );
}

// The stored permission value preserves an explicit agent default as an empty
// string. Undefined means no stored pick resolves to a permission value.
export function storedAskValue(
  agent: string,
  sessionValue: string | undefined,
  savedValue: string | undefined,
): string | undefined {
  if (sessionValue === '') {
    return '';
  }
  const mode = savedAskMode(agent, sessionValue, savedValue);
  if (mode) {
    return mode.value;
  }
  return savedValue === '' ? '' : undefined;
}

const CODEX_SANDBOX_TYPES: Record<SandboxMode, string> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
};

// The CLI marks a preset only when its approval policy, reviewer, and sandbox all match.
export function effectiveCodexAskMode(effective: CodexEffectiveMode | null | undefined): AskMode | undefined {
  if (!effective || typeof effective.approvalPolicy !== 'string') {
    return undefined;
  }
  return CODEX_ASK_MODES.find(
    (mode) =>
      mode.codex &&
      mode.codex.approvalPolicy === effective.approvalPolicy &&
      mode.codex.approvalsReviewer === effective.approvalsReviewer &&
      CODEX_SANDBOX_TYPES[mode.codex.sandbox] === effective.sandbox,
  );
}

function codexApprovalDisplay(effective: CodexEffectiveMode): { label: string; description: string } {
  if (effective.approvalPolicy === 'never') {
    return { label: 'No approvals', description: 'Codex does not stop for approval.' };
  }
  if (effective.approvalPolicy === 'on-request' && effective.approvalsReviewer === 'auto_review') {
    return { label: 'Approve for me', description: 'Codex sends eligible actions to automatic review.' };
  }
  if (effective.approvalPolicy === 'on-request') {
    return { label: 'Ask for approval', description: 'Codex asks you to approve eligible actions.' };
  }
  if (effective.approvalPolicy === 'untrusted') {
    return {
      label: 'Ask for approval',
      description: 'Codex asks before commands it does not classify as safe.',
    };
  }
  return { label: 'Custom approvals', description: 'Codex uses custom approval rules.' };
}

function codexSandboxDisplay(sandbox: string): { label: string; description: string } {
  if (sandbox === 'readOnly') {
    return { label: 'Read only', description: 'Commands run inside a read-only sandbox.' };
  }
  if (sandbox === 'workspaceWrite') {
    return { label: 'Workspace access', description: 'Commands can write inside the workspace sandbox.' };
  }
  if (sandbox === 'dangerFullAccess') {
    return {
      label: 'Full system access',
      description: 'Commands run without filesystem or network sandbox restrictions.',
    };
  }
  if (sandbox === 'externalSandbox') {
    return {
      label: 'External sandbox',
      description: 'An external sandbox controls filesystem and network access.',
    };
  }
  return { label: 'Custom access', description: 'Codex uses a custom access boundary.' };
}

// A custom combination still has concrete approval and access behavior. Name both parts
// instead of hiding them behind a reference to the configuration file.
export function effectiveCodexDisplayMode(effective: CodexEffectiveMode | null | undefined): AskMode | undefined {
  if (!effective) {
    return undefined;
  }
  const preset = effectiveCodexAskMode(effective);
  if (preset) {
    return preset;
  }
  const approval = codexApprovalDisplay(effective);
  const sandbox = codexSandboxDisplay(effective.sandbox);
  return {
    value: '',
    label: `${approval.label} · ${sandbox.label}`,
    description: `${approval.description} ${sandbox.description}`,
  };
}

// A live pick can outlast the menu that offered it or arrive with altered text. Apply only a
// value the named agent still offers, so callers never receive a missing mode as a selection.
export async function acceptedAskModePick(
  agent: string,
  value: string,
  accept: (mode: AskMode) => Promise<void>,
): Promise<boolean> {
  const mode = permissionModes(agent).find((one) => one.value === value);
  if (!mode) {
    return false;
  }
  await accept(mode);
  return true;
}

// An empty stored value means Arc sends no permission override. The explicit preset tables
// stay protocol-only because neither agent accepts this row as a protocol value.
const AGENT_DEFAULT_MODES: Record<string, AskMode> = {
  claude: {
    value: '',
    label: 'Claude default',
    description: 'Claude resolves the permission level when this session starts.',
  },
  codex: {
    value: '',
    label: 'Codex default',
    description: 'Codex resolves the permission level when this session starts.',
  },
};

function agentDefaultMode(agent: string): AskMode {
  return (
    own(AGENT_DEFAULT_MODES, agent) ?? {
      value: '',
      label: `${agentName(agent)} default`,
      description: `${agentName(agent)} resolves the permission level when this session starts.`,
    }
  );
}

function permissionModes(agent: string): readonly AskMode[] {
  return [agentDefaultMode(agent), ...askModes(agent)];
}

function displayedAskMode(agent: string, value: string | undefined): AskMode {
  return askMode(agent, value) ?? defaultAskMode(agent);
}

function profileAskMode(agent: string, value: string | undefined): AskMode {
  return !value ? agentDefaultMode(agent) : displayedAskMode(agent, value);
}

const CLAUDE_REPORTED_ONLY_MODES: Partial<Record<PermissionMode, AskMode>> = {
  bypassPermissions: {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Claude runs everything without permission checks.',
  },
  dontAsk: {
    value: 'dontAsk',
    label: "Don't ask",
    description: 'Claude denies anything that would ask for permission.',
  },
};

function effectiveClaudeDisplayMode(effective: string | null | undefined): AskMode | undefined {
  if (!effective) {
    return undefined;
  }
  return (
    CLAUDE_ASK_MODES.find((mode) => mode.claude === effective) ??
    (effective === 'default'
      ? CLAUDE_ASK_MODES.find((mode) => mode.value === 'manual')
      : own(CLAUDE_REPORTED_ONLY_MODES, effective))
  );
}

function liveAskMode(
  agent: string,
  value: string | undefined,
  effective?: CodexEffectiveMode | null,
  effectiveClaude?: string | null,
): AskMode {
  const selected = value ? askModes(agent).find((mode) => mode.value === value) : undefined;
  if (selected) {
    return selected;
  }
  if (agent === 'codex') {
    return effectiveCodexDisplayMode(effective) ?? agentDefaultMode(agent);
  }
  return effectiveClaudeDisplayMode(effectiveClaude) ?? agentDefaultMode(agent);
}

// Prompt box controls describe the selected session, its context window, and its
// next-turn settings. Context belongs to the session. Account usage belongs to
// the status bar.

// A control's visible label, accessible name, and hint.
export interface ComposerPick {
  // Identifies the control across renders.
  control: string;
  label: string;
  // The accessible name includes the control's purpose and selected value.
  name: string;
  // The button's hint.
  detail: string;
  // Keep the control visible but disable it. Models without effort settings retain
  // the effort control's position.
  disabled: boolean;
  // A failed server gives its control the caution tone because its tools are unavailable.
  // The panel reads this flag rather than matching the visible label.
  caution: boolean;
}

// A panel menu row with its visible and accessible wording.
export interface MenuItem {
  // The kind sets the row's accessible role and selection behavior. Radio choices
  // share one selection. Toggles have independent states. Actions have no selected
  // state. Status rows report a value.
  kind: 'radio' | 'toggle' | 'action' | 'status';
  // The value returned when the reader chooses this row.
  value: string;
  label: string;
  // The description displayed under the menu choice. Empty when the row has no description.
  description: string;
  // Drawn with a tick, and announced as the current setting.
  checked: boolean;
  // `mcpview.ts` marks failed server rows with the caution tone. Setting rows built
  // here never set this flag.
  caution: boolean;
  // The row's accessible name.
  name: string;
}

export interface Menu {
  revision?: number;
  // Which control this menu belongs to.
  control: string;
  agent: string;
  // The session that opened the menu remains the choice's target after selection changes.
  session?: string;
  // The effort menu's model travels with the choice so the host validates its
  // available effort levels against that model.
  model?: string;
  // The question at the top of the menu, in the agent's own terms.
  head: string;
  items: MenuItem[];
  // The message displayed instead of rows in an empty menu. Empty when rows exist.
  empty: string;
}

// Selected settings belong to one session. Pending values wait for a turn to
// confirm them. Confirmed values come from the transcript and remain outside
// this stored shape.
export interface SessionSettingSelection {
  selectedModel: string;
  selectedEffort: string;
  // Retain a draft's permission choice for a replacement child.
  permissionMode?: string;
  // The model whose menu supplied `selectedEffort`. A recorded model preserves
  // that effort's validity without becoming an explicit model pick.
  effortModel: string;
  pendingModel: string | null;
  pendingEffort: string | null;
}

export interface AppliedSessionSettings extends SessionSettingSelection {
  // The API model id used by the last reply.
  confirmedModel: string | null;
  // The model attachment that names the same model with its window, when the transcript has one.
  confirmedModelAttachment?: string | null;
  confirmedEffort: string | null;
}

export type SessionSettingBook = Record<string, SessionSettingSelection>;

export const EMPTY_SESSION_SETTINGS: SessionSettingSelection = {
  selectedModel: '',
  selectedEffort: '',
  effortModel: '',
  pendingModel: null,
  pendingEffort: null,
};

// Copy the book and this session's settings. Updating one session never changes
// a sibling session's settings.
export function withSessionSettings(
  book: SessionSettingBook,
  session: string,
  settings: SessionSettingSelection,
): SessionSettingBook {
  return { ...book, [session]: { ...settings } };
}

export function sessionSettings(book: SessionSettingBook, session: string): SessionSettingSelection {
  const stored = book[session];
  return stored ? { ...EMPTY_SESSION_SETTINGS, ...stored } : { ...EMPTY_SESSION_SETTINGS };
}

// Store settings only after the agent accepts the change. Rejection leaves the
// settings book and displayed value unchanged.
export async function acceptedSessionSettings(
  read: () => SessionSettingBook,
  write: (book: SessionSettingBook) => Promise<void>,
  session: string,
  // Read fields after acceptance when they depend on the agent's answer. An effort
  // pick made during a model request must survive that request's completion.
  update: Partial<SessionSettingSelection> | (() => Partial<SessionSettingSelection>),
  accept: () => Promise<void>,
): Promise<void> {
  await accept();
  const fields = typeof update === 'function' ? update() : update;
  const latest = read();
  await write(
    withSessionSettings(latest, session, {
      ...sessionSettings(latest, session),
      ...fields,
    }),
  );
}

export interface PermissionModeTarget {
  session: string | null;
  accept(): Promise<void>;
}

// Applies an agent-wide permission change to each child in order. Each accepted child is
// stored before the next can reject, and its field is merged into the latest settings book.
export async function acceptedPermissionMode(
  read: () => SessionSettingBook,
  write: (book: SessionSettingBook) => Promise<void>,
  targets: readonly PermissionModeTarget[],
  permissionMode: string,
): Promise<void> {
  for (const target of targets) {
    await target.accept();
    if (!target.session) {
      continue;
    }
    const latest = read();
    await write(
      withSessionSettings(latest, target.session, {
        ...sessionSettings(latest, target.session),
        permissionMode,
      }),
    );
  }
}

export interface ComposerContext {
  used: number;
  capacity: number;
  generation: number;
  // `wholePercent` rounds to the nearest percentage and reserves 100 for a full window.
  percent: number;
  // The reported usage share clamped to the bar's track.
  fill: number;
  level: ContextLevel | null;
  // The figure's tooltip and accessible name describe the percentage. The redundant
  // bar is hidden from screen readers.
  name: string;
  // The command available to the Compact button in Context detail.
  compact: string;
}

type ComposerPromptEntry = PromptEntry | (Omit<PromptEntry, 'kind'> & { kind?: 'command' });

export interface ComposerState {
  submittedRecoveryId?: string;
  submittedComments?: readonly TurnComment[];
  submittedDraftRevision?: number;
  // A local draft's complete launch setup. Draft controls read and update this
  // profile without changing the session that supplied it.
  profile?: SessionProfile | null;
  // The agent key selects catalogs, settings, and the destination CLI. Display names
  // must not replace keys because their table lookups fail.
  agent: AgentKind;
  session: string;
  // Empty until the agent has been asked what it runs.
  models: readonly ModelChoice[];
  defaults?: DefaultContext;
  // The agent's reported prompt entries in catalog order. Empty before the catalog
  // arrives or when the agent publishes none.
  commands: readonly ComposerPromptEntry[];
  // The Claude skill list for the session's working directory controls inline
  // highlighting. Null highlights all eligible commands. An empty list highlights
  // none. Codex entries carry their own `kind`.
  claudeSkills: readonly string[] | null;
  // The servers last reported for this session or draft. An unanswered catalog
  // and a catalog with no servers both omit the Servers control.
  mcpServers: readonly McpServer[];
  // Selected settings, pending requests, and the newest turn's confirmed settings
  // remain separate. Codex selections wait for a turn to confirm what ran.
  settings: AppliedSessionSettings;
  // A stored permission value, the empty value for an explicit agent default, or undefined
  // when nothing stored names one. Both of the last two run the agent's own default.
  askMode: string | undefined;
  // Codex resolves this state when it opens a thread. It remains separate from the Arc pick.
  effectiveMode?: CodexEffectiveMode | null;
  // Claude reports the mode that settings and launch flags resolved after its first prompt.
  effectivePermissionMode?: string | null;
  // Reported context usage and capacity. Null when unavailable. Capacity comes
  // from the model's window rather than a fixed value.
  context: { used: number; max: number } | null;
  contextGeneration?: number;
  // Inputs for the next-turn cost estimate. Null when context or pricing is unavailable.
  nextTurn?: NextTurnBasis | null;
  // What the reader has typed into the box, exactly as they typed it.
  draft: string;
  // Queued submissions in delivery order. Comment ids refer to comments on their
  // turns rather than copying those comments into prompt text.
  queued: readonly QueuedSubmission[];
  // Comment ids reserved for the queued prompt currently back in the box for editing.
  draftCommentIds?: readonly string[];
  // Queue entries currently crossing the agent acceptance boundary. They remain persisted
  // owners until acceptance, but their live card replaces the waiting card on screen.
  queueHandoffs?: ReadonlySet<string>;
  // Submitted prompts, newest first. `promptHistory` combines recorded
  // prompts with submissions from this panel.
  history: readonly string[];
  // The visible prompt text can differ from the retained draft during history recall.
  // Visible text determines Send or Stop. The retained draft survives recall and
  // participates in queue editing.
  onScreen: string;
  // Files staged for the next prompt in this session.
  assets?: readonly PromptAsset[];
  // Webview-local addresses for image previews. The same staged path gets a different safe
  // address in each webview, so this is prepared at the host boundary.
  assetPreviews?: Readonly<Record<string, string>>;
  // An attachment refusal beside the Prompt box. Retained only in memory.
  notice?: string | null;
  // Whether a turn is running in this session now.
  running: boolean;
  // A clear waits for both agent acceptance and the successor session. It stays outside
  // `live` because the command produces no turn card.
  clearing?: boolean;
  // All stored comments. `commentsFor` selects this session's comments so another
  // session's comments never reach its agent.
  comments: readonly TurnComment[];
  // The session whose comments this Prompt box selects.
  sessionId: string;
  // The turn whose content opened this draft. This is UI metadata rather than prompt text,
  // so normal prompt assembly never sees it.
  origin?: DraftOrigin | null;
  // Pending presses, oldest first. A compaction and a prompt queued behind it
  // remain separate operations.
  live: readonly LivePress[];
  // Open requests for this session. The wire normalizes them. The host removes
  // them after an accepted answer or the turn ends.
  asks?: readonly Ask[];
}

// The comments figure above the Prompt box counts comments attached to the prompt.
// Prompt assembly places those comments below the reader's text without changing
// the retained draft.
export interface ComposerAnnotations {
  count: number;
  // The comment count, such as '3 comments' or '1 comment'. Zero comments omit the figure.
  label: string;
  // The accessible name includes the count and how the prompt includes the comments.
  name: string;
  // The figure's hint names the attached comments.
  detail: string;
  control: string;
}

export interface ComposerFile {
  id: string;
  label: string;
  name: string;
  size: number;
  preview: string | null;
  kind: string;
  stem: string;
  ext: string;
  sizeLabel: string;
  removeLabel?: string;
  removeName?: string;
  removeControl?: string;
}

// One prompt waiting for the running turn to end.
export interface QueuedPrompt {
  // Stable across repaints and reloads. It is the submission id, not a hash of visible text,
  // because an attachment-only prompt and equal text with different files still differ.
  id: string;
  // The collapsed preview flattens whitespace and caps the display text's length.
  label: string;
  // The complete prompt displayed when the card expands. Retain its text so the
  // reader can review it after queueing clears the Prompt box.
  text: string;
  // Expand only when the complete prompt adds text beyond the collapsed preview.
  long: boolean;
  // The disclosure's accessible name in each state, and empty on a row that does not open.
  openName: string;
  shutName: string;
  // Identifies the disclosure across renders. Empty when the card has no disclosure.
  control: string;
  // Drop has its own button. Expanding a prompt must not remove it from the queue.
  dropName: string;
  dropControl: string;
  // Edit exchanges the queued submission with the active draft in the Prompt box.
  // The reader edits it with the same caret, selection, history, and resizing behavior.
  editName: string;
  editControl: string;
  // Visible action labels supplied with the rest of the Prompt box wording.
  editLabel: string;
  dropLabel: string;
  // Copy the complete queued prompt to the clipboard.
  copyText: string;
  copyName: string;
  copyControl: string;
  copyLabel: string;
  at: number;
  relative: string;
  absolute: string;
  agent: string;
  headName: string;
  // Concise visible state. The complete delivery explanation stays in `headName`, where a
  // screen reader gets it without forcing the card header to carry a paragraph.
  status: string;
  reason: string;
  files: ComposerFile[];
}

// A live card displays a pending press and the reader's prompt until the recorded
// turn replaces it.
export interface ComposerLive {
  // Identifies the operation so responses update the matching card. A compaction
  // and the prompt queued behind it can both appear.
  kind: LiveKind;
  // The operation's state. Card wording and response tone are supplied separately.
  state: LiveState;
  // The response state supplies the card's tone and glyph.
  tone: 'running' | 'failed' | 'done' | 'interrupted';
  // The header uses the turn card's time, elapsed duration, agent, and model fields
  // so its recorded replacement keeps the same presentation.
  relative: string;
  absolute: string;
  agent: string;
  // Empty until a model pick or recorded turn identifies the model.
  model: string;
  // The head row's spoken name, which carries what the eye reads off the row.
  label: string;
  // The first line of the submitted prompt occupies the turn card's headline slot.
  // Empty for compaction, which submits no reader text.
  headline: string;
  // The line under the headline, where a turn card says what the agent is doing now. Here it
  // says what the panel is doing, in the agent's own name.
  status: string;
  // The complete streamed response, including whitespace. The browser bounds its collapsed preview.
  reply: string;
  // The press time supplies the card's relative age, including while a failed card
  // waits for dismissal.
  at: number;
  // The elapsed duration's start time. Null when the card stops counting elapsed
  // time, including after failure.
  since: number | null;
  // Dismiss removes a failed card. Empty when transcript refresh will remove the card.
  dismissLabel: string;
  dismissName: string;
  dismissControl: string;
  // Restore returns the complete failed prompt to its session's Prompt box. The
  // headline contains only its first line. Empty for compaction.
  restoreLabel: string;
  restoreName: string;
  restoreControl: string;
  // Why the handoff failed, in stable reader-facing words. The extension maps protocol
  // errors before they reach this card, so a server's JSON-RPC vocabulary is not UI text.
  reason: string;
  files: ComposerFile[];
}

// The box the reader types into, and the one button at the end of the controls row.
export interface ComposerBox {
  // What the empty box says, in the agent's own vocabulary.
  placeholder: string;
  dropPlaceholder: string;
  // The send and newline shortcuts appear in the Send hint and accessible name.
  hint: string;
  heightName: string;
  heightHint: string;
  heightHintDetail: string;
  // Send submits available prompt content. During active work with no prompt text
  // or files, the same control becomes Stop.
  actionLabel: string;
  actionName: string;
  actionControl: string;
  // The action kind selects the button's tone without matching its label.
  actionKind: string;
  // False when there is nothing to send or the current operation cannot accept it. A Stop
  // remains enabled because stopping a turn needs no draft.
  actionEnabled: boolean;
}

// A local draft's status figure. Visible text names the draft state rather than
// repeating the setup controls.
export interface ComposerDraftTag {
  // The draft state label, independent of its launch setup.
  word: string;
  // The hint summarizes the four values displayed by the setup controls.
  detail: string;
}

export interface ComposerView {
  recoverySetup?: SessionProfile;
  agent: string;
  // The target session keys the stored draft and every Prompt box message. Keeping
  // it on the view prevents prompts from sharing an undefined draft slot.
  sessionId: string;
  // The retained unsent draft restores the Prompt box after reload. The panel
  // adopts it once per session. Repeated adoption during typing would replace
  // current text with a delayed host value.
  draft: string;
  // The Prompt box's accessible name includes its target session. The session list
  // already displays that session's name.
  targetName: string;
  origin: ComposerOrigin | null;
  // Null when the session has no local draft profile.
  draftTag: ComposerDraftTag | null;
  context: ComposerContext | null;
  // The next-turn cost estimate above the Prompt box. Null omits the line when
  // context or pricing is unavailable.
  nextTurn: ComposerNextTurn | null;
  // Model, effort, and permission controls in that order, followed by Servers
  // when the session reports configured servers.
  picks: ComposerPick[];
  // Prepared prompt entries. The browser matches current text locally so completion
  // uses the latest keystroke without a host round trip. Catalog changes update
  // the entries independently of typing.
  commands: PromptEntryView[];
  // The working directory's Claude skill list for inline highlighting. Null before
  // its first report. Codex ignores this field.
  claudeSkills: readonly string[] | null;
  // The accessible name shared by command and local-path completion lists.
  completionName: string;
  box: ComposerBox;
  // Null when no comments are available to attach to this prompt.
  annotations: ComposerAnnotations | null;
  files: ComposerFile[];
  notice: string | null;
  filePendingName: string;
  // Oldest first, which is the order they will be sent in.
  queue: QueuedPrompt[];
  // Earlier prompts, newest first. Keeping them in the view lets the browser
  // answer history keys without waiting for the host.
  history: string[];
  // Live cards, newest first. A prompt can wait behind a compaction as a separate card.
  live: ComposerLive[];
  // Requests waiting for the reader, oldest first. They sit above the prompt box at the
  // foot of this session, where a reply can be given without leaving the panel.
  asks: AskCard[];
  // The line beside Send states that it answers pending requests before sending.
  // Empty when no request waits or Send will not submit. The same line joins
  // Send's accessible name because a new request changes the action during typing.
  sendOverAsk: string;
}

export interface AskCardChoice {
  label: string;
  labelHtml: string;
  detail: string;
  detailHtml: string;
  name: string;
  // The last choice on every question, which opens a box for an answer the agent did not
  // offer. It sends no label of its own: what the reader types is the answer.
  written: boolean;
}

export interface AskCardQuestion {
  id: string;
  legend: string;
  legendHtml: string;
  legendText: string;
  // The agent's short question label appears before its legend. Empty labels omit
  // the figure.
  key: string;
  // Describes whether the question accepts one choice or several.
  hint: string;
  multiSelect: boolean;
  // A secret answer goes into a password box, and its tab reports that it is answered
  // without reporting what it says.
  secret: boolean;
  choices: AskCardChoice[];
  // The tab uses the agent's short label, or the question number when no label exists.
  tab: string;
  // The tab's spoken name while the question has no answer.
  tabName: string;
  // The answered tab's accessible-name prefix. The browser appends the complete
  // answer even when visible text is shortened. Secret answers keep the prefix alone.
  tabAnsweredName: string;
  // The box that takes an answer the agent did not offer, and what it says while it is empty.
  writtenName: string;
  writtenPlaceholder: string;
}

const REFUSED_ASK: AskAnswer = {
  decision: 'deny',
  reason: 'The reader refused this from the panel.',
};

// The reader answers a request in the next prompt instead of on its card. Use
// the same explanation for questions and permissions without reporting refusal.
export const ANSWERED_IN_PROMPT: AskAnswer = {
  decision: 'deny',
  reason: 'The reader did not answer this here and replied in their next message instead.',
};

// Match panel-authored denial reasons. `acceptedAskAnswer` preserves these reasons
// and normalizes other submitted denials. Answering in the next prompt must
// remain distinct from refusing the request.
function panelDenial(reason: unknown): AskAnswer | null {
  for (const denial of [REFUSED_ASK, ANSWERED_IN_PROMPT]) {
    if (denial.decision === 'deny' && denial.reason === reason) {
      return denial;
    }
  }
  return null;
}

export interface AskCardAction {
  label: string;
  name: string;
  answer: AskAnswer;
}

// A blocking request with its visible and accessible wording. The browser builds
// controls and returns their values.
export interface AskCard {
  answerBlocked?: boolean;
  id: string;
  kind: Ask['kind'];
  title: string;
  detail: string;
  detailFormat: 'prose' | 'code';
  name: string;
  questions: AskCardQuestion[];
  actions: AskCardAction[];
  answerLabel: string;
  answerName: string;
  incompleteName: string;
  // The action button before every question has an answer. Pressing it goes to the next
  // question the reader has not answered, and sends nothing.
  nextLabel: string;
  nextName: string;
  // One progress line per question, in question order. The browser selects the
  // line for the visible question.
  steps: string[];
  // One answered-count line for each count from zero through all questions. The
  // collapsed header displays the current count. Permission requests have no count.
  answeredWords: string[];
  // The fold control names its action. A collapsed card uses `openName`. An expanded
  // card uses `shutName`, matching queued prompt disclosures.
  openName: string;
  shutName: string;
  // The header's waiting phrase shares `NEEDS_INPUT` with the session list.
  // The sending phrase reports answer delivery.
  stateWord: string;
  sendingWord: string;
}

export interface DraftOrigin {
  sessionId: string;
  turnKey: string;
}

export interface ComposerOrigin extends DraftOrigin {
  label: string;
  name: string;
}

// Compaction commands for supported agents. An unlisted agent has no compaction control.
const COMPACT_COMMANDS: Record<string, string> = { claude: '/compact', codex: '/compact' };

const CLEAR_COMMANDS: Record<string, string> = { claude: '/clear', codex: '/clear' };

export interface ClearRequest {
  command: 'clear' | 'new';
  name: string;
}

// Return the agent's prompt box compaction command, or an empty string.
export function compactCommand(agent: string): string {
  return own(COMPACT_COMMANDS, agent) ?? '';
}

// Match the entire compaction command, ignoring surrounding whitespace and case. Arguments and other command names do not match.
export function compactSubmission(agent: string, text: string): boolean {
  const command = compactCommand(agent);
  return Boolean(command) && text.trim().toLowerCase() === command.toLowerCase();
}

// Queue an exact compaction command while the session runs. Otherwise, compact immediately.
export function compactAction(agent: string, text: string, running: boolean): 'compact' | 'queue' | null {
  if (!compactSubmission(agent, text)) {
    return null;
  }
  return running ? 'queue' : 'compact';
}

export function clearCommand(agent: string): string {
  return own(CLEAR_COMMANDS, agent) ?? '';
}

// Codex accepts `/new` with an optional session name on the same line. Preserve internal spacing and quotes in that name.
export function clearRequest(agent: string, text: string): ClearRequest | null {
  const trimmed = text.trim();
  const command = clearCommand(agent);
  if (command && trimmed.toLowerCase() === command.toLowerCase()) {
    return { command: 'clear', name: '' };
  }
  if (agent !== 'codex' || LINE_BREAK.test(trimmed)) {
    return null;
  }
  const matched = /^\/new(?:[ \t]+(.*))?$/i.exec(trimmed);
  if (!matched) {
    return null;
  }
  return { command: 'new', name: (matched[1] ?? '').trim() };
}

export function clearSubmission(agent: string, text: string): boolean {
  return clearRequest(agent, text) !== null;
}

export function clearAction(agent: string, text: string, running: boolean): 'clear' | 'queue' | null {
  if (!clearSubmission(agent, text)) {
    return null;
  }
  return running ? 'queue' : 'clear';
}

// Effort label when neither a selection nor a reported level supplies one.
const DEFAULT_EFFORT_LABEL = 'Effort not reported';

// Effort label when the menu has no supported setting.
const NO_EFFORT_LABEL = 'No effort setting';

// Find the selected catalog value, its resolved model, then the value without an added window. Return null when none matches.
export function chosenModel(models: readonly ModelChoice[], model: string | undefined): ModelChoice | null {
  return (
    models.find((m) => m.value === model) ??
    (model ? models.find((m) => m.resolvedModel === model) : undefined) ??
    windowedChoice(models, model)
  );
}

// Resolve a reply's API model id, which never names its window.
export function modelRan(models: readonly ModelChoice[], ran: string | null): ModelChoice | null {
  return recordedChoice(models, ran, false);
}

// Resolve a model attachment, which names its window.
export function modelAttached(models: readonly ModelChoice[], attached: string | null): ModelChoice | null {
  return recordedChoice(models, attached, true);
}

// Use a recorded model attachment when present. Only an absent attachment permits fallback to the recorded API model id.
function recordedModel(state: ComposerState): ModelChoice | null {
  const attached = state.settings.confirmedModelAttachment;
  return attached ? modelAttached(state.models, attached) : modelRan(state.models, state.settings.confirmedModel);
}

// Use the selected catalog model, then the recorded model. The recorded fallback supplies effort choices without creating a selection.
export function settledModel(state: ComposerState): ModelChoice | null {
  return chosenModel(state.models, state.settings.selectedModel) ?? recordedModel(state);
}

// The launch value of the settled model. A recorded window survives a row listed in another window, so a 1M session inherits `opus[1m]` from `opus`.
function settledValue(state: ComposerState): string | undefined {
  const selected = state.settings.selectedModel;
  const chosen = chosenModel(state.models, selected);
  if (chosen) {
    return chosen.value === selected || chosen.resolvedModel === selected ? chosen.value : selected;
  }
  const row = recordedModel(state);
  const attached = state.settings.confirmedModelAttachment;
  if (!row || !attached) {
    return row?.value;
  }
  const window = modelWindowOf(attached);
  return modelWindowOf(row.resolvedModel || row.value) === window
    ? row.value
    : `${row.value.replace(WINDOW_SUFFIX, '')}${window}`;
}

function modelPending(state: ComposerState): boolean {
  const pending = state.settings.pendingModel;
  if (!pending) {
    return false;
  }
  return recordedModel(state)?.value !== pending;
}

function effortPending(state: ComposerState): boolean {
  const pending = state.settings.pendingEffort;
  return Boolean(pending && state.settings.confirmedEffort !== pending);
}

// Return the selected catalog model's effort choices. Return no choices for an unresolved model or a model without effort settings.
export function effortChoices(models: readonly ModelChoice[], model: string | undefined): readonly EffortChoice[] {
  return chosenModel(models, model)?.efforts ?? [];
}

function agentName(agent: string): string {
  return own(USAGE_AGENT_NAMES, agent) ?? agent;
}

// Report whether prompt delivery succeeded and explain a failure.
export interface PromptDelivery {
  delivered: boolean;
  reason: string;
  // Accepted submission identifier for matching completion to its staged files.
  turnId?: number;
  // Successor session used when another client owns the requested session.
  session?: string;
}

const LAUNCH_AGENTS: readonly AgentKind[] = ['claude', 'codex'];
// The inherited row names its source because it sits outside the titled sections.
const INHERITED_SOURCE_NAME = 'Inherited';
const PINNED_HEADING = 'Pinned setups';
const RECENT_HEADING = 'Recent setups';
// Refusal text for each setup value missing from the catalog.
const MISSING_SETUP_REASONS: Record<SetupValueName, string> = {
  agent: 'Agent not available',
  model: 'Model not available',
  effort: 'Effort not available',
  permission: 'Permissions not available',
};
// Setup fields in the order their facts appear.
const SETUP_FACT_FIELDS: readonly SetupValueName[] = ['agent', 'model', 'effort', 'permission'];

function launchValue(value: string, label: string, detail: string = ''): LauncherValue {
  return { value, label, detail, name: [label, detail].filter(Boolean).join('. ') };
}

function launchAgents(
  models: Readonly<Record<string, readonly ModelChoice[]>>,
  defaults: Readonly<Record<string, DefaultContext>> = {},
  pending: readonly string[] = [],
): LauncherAgent[] {
  return LAUNCH_AGENTS.map((agent) => {
    const name = agentName(agent);
    const catalog = models[agent] ?? [];
    const context = defaults[agent] ?? {};
    const modelRows: LauncherModel[] = modelPicks(catalog, context).map((model) => ({
      ...launchValue(model.value, model.label, model.description),
      identity: model.identity,
      aliases: model.aliases,
      configuredDefault: model.configuredDefault,
      efforts: effortPicks(catalog, model.value, context).map((effort) => ({
        ...launchValue(effort.value, effort.label, effort.description),
        configuredDefault: effort.configuredDefault,
      })),
    }));
    return {
      ...launchValue(agent, name, `Start a new ${name} session`),
      modelsPending: pending.includes(agent),
      models: modelRows,
      catalog,
      defaults: context,
      supportedModels: [
        { value: '', efforts: [{ value: '' }, ...catalog.flatMap((model) => model.efforts)] },
        ...catalog.flatMap((model) =>
          [...new Set([model.value, model.resolvedModel].filter((value): value is string => Boolean(value)))].map(
            (value) => ({ value, efforts: [{ value: '' }, ...model.efforts] }),
          ),
        ),
      ],
      permissions: permissionModes(agent).map((mode) => launchValue(mode.value, mode.label, mode.description)),
      defaultPermission: defaultAskMode(agent).value,
    };
  });
}

function launcherProfileAvailable(profile: SessionProfile, agents: readonly LauncherAgent[]): boolean {
  return missingSetupValue(profile, agents) === null;
}

// Separator between setup facts.
const PROFILE_FACT_SEPARATOR = ' · ';

// Describe agent, model, effort, and permissions in the shared setup order.
function profileFacts(
  profile: SessionProfile,
  catalog: readonly ModelChoice[],
  defaults: DefaultContext = {},
): string[] {
  const permission = profileAskMode(profile.agent, profile.permissionMode);
  return [
    agentName(profile.agent),
    modelLabel(catalog, profile.model, defaults),
    effortLabel(catalog, profile.model, profile.effort, defaults),
    permission.label,
  ];
}

// An inherited row includes its source in the detail. Pinned and recent rows include their section in the accessible name. Preserve a missing value's stored text instead of its catalog fallback.
function launchProfileRow(
  key: string,
  section: 'inherited' | 'pinned' | 'recent',
  profile: SessionProfile,
  models: Readonly<Record<string, readonly ModelChoice[]>>,
  missing: SetupValueName | null = null,
  defaults: DefaultContext = {},
): LauncherProfileRow {
  const stored = missing ? profile[missing === 'permission' ? 'permissionMode' : missing] : '';
  const facts = profileFacts(profile, models[profile.agent] ?? [], defaults).map((fact, index) =>
    stored && SETUP_FACT_FIELDS[index] === missing ? stored : fact,
  );
  const reason = missing ? MISSING_SETUP_REASONS[missing] : '';
  if (section === 'inherited') {
    const label = 'Same setup as current';
    const detail = [...facts, INHERITED_SOURCE_NAME].join(PROFILE_FACT_SEPARATOR);
    return { key, label, detail, name: `${label}. ${detail}`, profile: { ...profile } };
  }
  const heading = section === 'pinned' ? PINNED_HEADING : RECENT_HEADING;
  const label = facts.slice(0, 2).join(PROFILE_FACT_SEPARATOR);
  const detail = [...facts, ...(reason ? [reason] : [])].join(PROFILE_FACT_SEPARATOR);
  const name = `${heading}: ${facts.join(PROFILE_FACT_SEPARATOR)}${reason ? `. ${reason}` : ''}`;
  return { key, label, detail, name, profile: { ...profile } };
}

// Inherit the model and supported effort. Use the agent's preselected permission when none is stored. Preserve an explicit default as an empty value.
function inheritedProfile(state: ComposerState): SessionProfile {
  const stored = state.askMode;
  const model = state.profile ? state.profile.model : (settledValue(state) ?? state.settings.selectedModel);
  const effort = state.settings.selectedEffort || state.settings.confirmedEffort || '';
  return {
    agent: state.agent,
    model,
    effort:
      !model && !state.profile && !state.settings.selectedEffort
        ? ''
        : pickedProfileEffort(state.models, model, effort, state.defaults),
    permissionMode:
      stored === undefined
        ? defaultAskMode(state.agent).value
        : askModes(state.agent).some((mode) => mode.value === stored)
          ? stored
          : '',
    source: 'inherited',
  };
}

// Build launcher rows, setup choices, and accessible wording for the panel.
export function sessionLauncherView(
  current: ComposerState | null,
  recent: readonly SessionProfile[],
  models: Readonly<Record<string, readonly ModelChoice[]>>,
  pinned: readonly PinnedSetup[] = [],
  defaults: Readonly<Record<string, DefaultContext>> = {},
  pending: readonly string[] = [],
  owner?: string,
): SessionLauncherView {
  const agents = launchAgents(models, defaults, pending);
  const inherited = current
    ? launchProfileRow('current', 'inherited', inheritedProfile(current), models, null, current.defaults)
    : null;
  const recentRow = (profile: SessionProfile, index: number) =>
    launchProfileRow(
      `recent:${index}`,
      'recent',
      { ...profile, source: 'recent' },
      models,
      null,
      defaults[profile.agent],
    );
  // Keep original history indexes in row keys after filtering and display limits.
  const shown = visibleRecents(
    recent.map((profile, index) => ({ ...profile, index })),
    pinned,
    inherited?.profile ?? null,
    agents,
  );
  const recentRows = shown.map(({ index, ...profile }) => recentRow(profile, index));
  const pinnedRows: LauncherPinnedRow[] = pinned.map((setup) => {
    const profile: SessionProfile = {
      agent: setup.agent,
      model: setup.model,
      effort: setup.effort,
      permissionMode: setup.permissionMode,
      source: 'recent',
    };
    const missingValue = missingSetupValue(setup, agents);
    const row = launchProfileRow(`pin:${setup.id}`, 'pinned', profile, models, missingValue, defaults[profile.agent]);
    return { ...row, id: setup.id, available: missingValue === null, missingValue };
  });
  // Quick New uses the latest valid setup before pin filtering.
  const latest = recent.findIndex((profile) => launcherProfileAvailable(profile, agents));
  const primary = inherited ?? (latest >= 0 ? recentRow(recent[latest], latest) : null);
  return {
    ...(owner === undefined ? {} : { owner }),
    primary,
    inherited,
    pinned: pinnedRows,
    recent: recentRows,
    agents,
    words: {
      railLabel: 'Sessions',
      primaryLabel: 'New',
      primaryName: inherited
        ? 'New session with the current setup'
        : primary
          ? 'New session with the most recent setup'
          : 'New session. Choose a setup',
      primaryDetail: primary
        ? profileFacts(
            primary.profile,
            models[primary.profile.agent] ?? [],
            inherited ? current?.defaults : defaults[primary.profile.agent],
          ).join(PROFILE_FACT_SEPARATOR)
        : 'Agent, model, effort, and permissions',
      menuName: 'Choose a setup for a new session',
      menuHeading: 'New session',
      pinnedHeading: PINNED_HEADING,
      pinnedEmpty: 'No pinned setups yet.',
      recentHeading: RECENT_HEADING,
      pinName: 'Pin setup',
      pinHint: 'Pin setup',
      pinDetail: 'Keep this setup in Pinned setups',
      unpinHint: 'Unpin setup',
      unpinDetail: 'Remove this setup from Pinned setups',
      editName: 'Edit setup',
      editHint: 'Edit setup',
      editDetail: 'Load this setup into the fields below',
      missingReasons: { ...MISSING_SETUP_REASONS },
      customHeading: 'Choose a setup',
      agentLabel: 'Agent',
      modelLabel: 'Model',
      effortLabel: 'Effort',
      permissionLabel: 'Permissions',
      createLabel: 'Create draft',
    },
  };
}

// Validate launch requests against the available agent choices.
export function launcherProfile(view: SessionLauncherView, request: LauncherRequest): SessionProfile | null {
  if (request.kind === 'row') {
    // Resolve the primary row separately because pin filtering can hide it from the menu.
    const rows = [view.inherited, view.primary, ...view.pinned.filter((row) => row.available), ...view.recent].filter(
      (row): row is LauncherProfileRow => Boolean(row),
    );
    const found = rows.find((row) => row.key === request.key);
    return found && launcherProfileAvailable(found.profile, view.agents) ? { ...found.profile } : null;
  }
  const choice = launcherCustomRequest(view, request);
  if (!choice) {
    return null;
  }
  return {
    agent: choice.agent as AgentKind,
    model: choice.model,
    effort: choice.effort,
    permissionMode: choice.permissionMode,
    source: 'custom',
  };
}

// Reasons a session handoff cannot create a draft.
export type HandoffRefusal = 'turn' | 'source' | 'setup' | 'folder';

// Describe a refused handoff. `sending` distinguishes transferred text from an empty draft.
export function handoffRefusalMessage(refusal: HandoffRefusal, sending: boolean): string {
  const action = sending ? 'send this to a new session' : 'start a new session from it';
  const messages: Record<HandoffRefusal, string> = {
    turn: 'Arc: the response this came from is no longer available, so Arc cannot send this to a new session.',
    source: `Arc: this session is not in this window's session list, so Arc cannot ${action}.`,
    setup: "Arc: Arc cannot reuse this session's setup. Use New with... to choose a setup.",
    folder: `Arc: this session has no recorded folder, so Arc cannot ${action}.`,
  };
  return messages[refusal];
}

import type { LaunchPolicy, RequestedCacheLifetime } from './launchpolicy';

export interface NewSessionDraft {
  policy?: LaunchPolicy;
  agentRun?: boolean;
  // A lifetime requested by a window start. Claude launches of this draft set it.
  cacheLifetime?: RequestedCacheLifetime;
  draftId: string;
  cwd: string;
  sourceSession: string | null;
  createdAt: number;
  profile: SessionProfile;
  origin: DraftOrigin | null;
  // Track setup changes made through the draft's controls. The profile source also describes choices made before the draft existed.
  handChanged: boolean;
}

export function newSessionDraft(
  draftId: string,
  cwd: string,
  sourceSession: string | null,
  createdAt: number,
  profile: SessionProfile,
  origin: DraftOrigin | null = null,
  handChanged: boolean = false,
): NewSessionDraft {
  return Object.freeze({
    draftId,
    cwd,
    sourceSession,
    createdAt,
    profile: Object.freeze({ ...profile }),
    origin: origin ? Object.freeze({ ...origin }) : null,
    handChanged,
  });
}

// Normalize line endings and add a blank line to nonempty handoff text within the draft size limit.
export function handoffDraftText(value: string): string | null {
  const text = value.replace(/\r\n?/g, '\n');
  const draft = text.trim() ? `${text}\n\n` : null;
  return draft && draft.length <= DRAFT_TEXT_LIMIT ? draft : null;
}

export function responseLinkDraftText(link: string): string | null {
  return isLocalLinkPath(link) ? handoffDraftText(link) : null;
}

// Choose a supported effort for the profile. An omitted model permits levels from any catalog model.
function pickedProfileEffort(
  models: readonly ModelChoice[],
  model: string,
  effort: string,
  defaults: DefaultContext = {},
): string {
  const chosen = resolvedChoice(models, model, defaults);
  const choices = model ? (chosen?.efforts ?? []) : models.flatMap((item) => item.efforts);
  return choices.some((item) => item.value === effort) ? effort : '';
}

export function sessionSettingsForProfile(
  profile: SessionProfile,
  models: readonly ModelChoice[] = [],
  defaults: DefaultContext = {},
): SessionSettingSelection {
  const chosen = resolvedChoice(models, profile.model, defaults);
  const supporting =
    (chosen?.efforts.some((one) => one.value === profile.effort) ? chosen : null) ??
    (!profile.model ? models.find((item) => item.efforts.some((one) => one.value === profile.effort)) : null);
  return {
    selectedModel: profile.model,
    selectedEffort: profile.effort,
    permissionMode: profile.permissionMode,
    effortModel: profile.effort ? profile.model || supporting?.value || '' : '',
    // A draft has no pending turn to confirm these settings.
    pendingModel: null,
    pendingEffort: null,
  };
}

// Apply supported draft menu choices. Reject unknown controls or values. Repeated choices preserve the profile source.
export function draftProfileAfterPick(
  profile: SessionProfile,
  control: string,
  value: string,
  models: Readonly<Record<string, readonly ModelChoice[]>>,
  defaults: DefaultContext = {},
): SessionProfile | null {
  const catalog = models[profile.agent] ?? [];
  if (control === 'agent') {
    const agent = LAUNCH_AGENTS.find((one) => one === value);
    if (!agent) {
      return null;
    }
    if (agent === profile.agent) {
      return { ...profile };
    }
    // Changing agents clears model and effort selections and uses the new agent's preselected permissions.
    return {
      agent,
      model: '',
      effort: '',
      permissionMode: defaultAskMode(agent).value,
      source: 'custom',
    };
  }
  if (control === 'model') {
    const next = modelAfterPick(catalog, profile.model, profile.effort, value, defaults);
    if (!next) return null;
    return {
      ...profile,
      ...next,
      source: next.model === profile.model && next.effort === profile.effort ? profile.source : 'custom',
    };
  }
  if (control === 'effort') {
    const effort = effortAfterPick(catalog, profile.model, profile.effort, value, defaults);
    if (effort === null) return null;
    return { ...profile, effort, source: effort === profile.effort ? profile.source : 'custom' };
  }
  if (control === 'askmode') {
    const mode = permissionModes(profile.agent).find((one) => one.value === value);
    if (!mode) {
      return null;
    }
    if (mode.value === profile.permissionMode) {
      return { ...profile };
    }
    return { ...profile, permissionMode: mode.value, source: 'custom' };
  }
  return null;
}

export function recentProfiles(profiles: readonly SessionProfile[], accepted: SessionProfile): SessionProfile[] {
  const same = (one: SessionProfile) =>
    one.agent === accepted.agent &&
    one.model === accepted.model &&
    one.effort === accepted.effort &&
    one.permissionMode === accepted.permissionMode;
  return [{ ...accepted }, ...profiles.filter((one) => !same(one)).map((one) => ({ ...one }))].slice(
    0,
    RECENT_SETUP_LIMIT,
  );
}

export interface SessionIdentityState {
  drafts: Record<string, string>;
  queues: Record<string, QueuedSubmission[]>;
  assets?: Record<string, StoredPromptAsset[]>;
  live: Record<string, LivePress[]>;
  settings: SessionSettingBook;
  profiles: Record<string, SessionProfile>;
  railOrder: string[];
  showing: string | null;
  origins?: Record<string, DraftOrigin>;
  // Locally submitted prompts available to prompt history before the transcript records them.
  sent?: Record<string, string[]>;
  // On-screen prompt text for each session's send control.
  boxText?: Record<string, string>;
  pinned?: string[];
  archived?: string[];
}

export interface SessionAlias {
  actual: string;
  expiresAt: number;
}

export const SESSION_ALIAS_LIMIT = 64;
export const SESSION_ALIAS_LIFETIME_MS = 10 * 60_000;

export function rememberSessionAlias(
  aliases: Map<string, SessionAlias>,
  provisional: string,
  actual: string,
  now: number = Date.now(),
): void {
  aliases.delete(provisional);
  aliases.set(provisional, { actual, expiresAt: now + SESSION_ALIAS_LIFETIME_MS });
  while (aliases.size > SESSION_ALIAS_LIMIT) {
    const oldest = aliases.keys().next().value;
    if (!oldest) {
      break;
    }
    aliases.delete(oldest);
  }
}

export function resolveSessionAlias(
  aliases: Map<string, SessionAlias>,
  session: string,
  now: number = Date.now(),
): string {
  const alias = aliases.get(session);
  if (!alias) {
    return session;
  }
  if (alias.expiresAt < now) {
    aliases.delete(session);
    return session;
  }
  return alias.actual;
}

export function sessionAdoptions(
  aliases: Map<string, SessionAlias>,
  now: number = Date.now(),
): Array<{ provisional: string; durable: string }> {
  const adoptions: Array<{ provisional: string; durable: string }> = [];
  for (const provisional of [...aliases.keys()]) {
    const durable = resolveSessionAlias(aliases, provisional, now);
    if (durable !== provisional) {
      adoptions.push({ provisional, durable });
    }
  }
  return adoptions;
}

export function sessionAdoptionFor(
  aliases: Map<string, SessionAlias>,
  durable: string | null,
  now: number = Date.now(),
): { provisional: string; durable: string } | null {
  if (!durable) {
    return null;
  }
  return sessionAdoptions(aliases, now).find((adoption) => adoption.durable === durable) ?? null;
}

// Move a provisional draft's state to its actual session id. Reject an actual id that already holds local state.
export function adoptSessionIdentity(
  state: SessionIdentityState,
  provisional: string,
  actual: string,
): SessionIdentityState {
  if (!provisional || !actual || provisional === actual) {
    throw new Error('session identity must change');
  }
  const occupied = [
    state.drafts,
    state.queues,
    state.live,
    state.settings,
    state.profiles,
    state.assets ?? {},
    state.sent ?? {},
    state.boxText ?? {},
  ].some((book) => Object.prototype.hasOwnProperty.call(book, actual));
  if (occupied) {
    throw new Error(`session ${actual} already has local state`);
  }
  const move = <T>(book: Record<string, T>, rewrite?: (value: T) => T): Record<string, T> => {
    if (!Object.prototype.hasOwnProperty.call(book, provisional)) {
      return { ...book };
    }
    const { [provisional]: value, ...rest } = book;
    return { ...rest, [actual]: rewrite ? rewrite(value) : value };
  };
  const { [provisional]: _profile, ...profiles } = state.profiles;
  const origins = state.origins ? move(state.origins) : undefined;
  const moveMembership = (values: readonly string[] | undefined): string[] | undefined => {
    if (!values) {
      return undefined;
    }
    return [...new Set(values.map((id) => (id === provisional ? actual : id)))];
  };
  return {
    drafts: move(state.drafts),
    assets: move(state.assets ?? {}),
    queues: move(state.queues),
    live: move(state.live, (presses) => presses.map((press) => ({ ...press, sessionId: actual }))),
    settings: move(state.settings),
    profiles,
    railOrder: state.railOrder.map((id) => (id === provisional ? actual : id)),
    showing: state.showing === provisional ? actual : state.showing,
    ...(origins ? { origins } : {}),
    ...(state.sent ? { sent: move(state.sent) } : {}),
    ...(state.boxText ? { boxText: move(state.boxText) } : {}),
    ...(state.pinned ? { pinned: moveMembership(state.pinned) } : {}),
    ...(state.archived ? { archived: moveMembership(state.archived) } : {}),
  };
}

// Transfer pending work to a successor session while retaining the source session. Copy settings, profiles, and origins. Retain source drafts and sent history. Move attachments, queued submissions, on-screen text, and unfinished live presses.
export function succeedSession(state: SessionIdentityState, source: string, successor: string): SessionIdentityState {
  if (!source || !successor || source === successor) {
    throw new Error('session identity must change');
  }
  const move = <T>(book: Record<string, T>, rewrite?: (value: T) => T): Record<string, T> => {
    if (!Object.prototype.hasOwnProperty.call(book, source)) {
      return { ...book };
    }
    const { [source]: value, ...rest } = book;
    return { ...rest, [successor]: rewrite ? rewrite(value) : value };
  };
  const copy = <T>(book: Record<string, T>): Record<string, T> =>
    Object.prototype.hasOwnProperty.call(book, source) ? { ...book, [successor]: book[source] } : { ...book };
  // Insert a new successor immediately before its source. Keep an existing successor's position.
  const at = state.railOrder.indexOf(source);
  const railOrder = state.railOrder.includes(successor)
    ? [...state.railOrder]
    : at < 0
      ? [successor, ...state.railOrder]
      : [...state.railOrder.slice(0, at), successor, ...state.railOrder.slice(at)];
  const live = { ...state.live };
  if (state.live[source]) {
    const retained = state.live[source].filter((press) => press.completed);
    const moved = state.live[source]
      .filter((press) => !press.completed)
      .map((press) => ({ ...press, sessionId: successor }));
    if (retained.length) live[source] = retained;
    else delete live[source];
    if (moved.length) live[successor] = [...(live[successor] ?? []), ...moved];
  }
  return {
    drafts: { ...state.drafts },
    assets: move(state.assets ?? {}),
    queues: {
      ...move(state.queues),
      ...(state.queues[source]?.some((entry) => entry.origin === 'agent')
        ? {
            [source]: state.queues[source]
              .filter((entry) => entry.origin === 'agent')
              .map((entry) => ({
                ...entry,
                delivery: {
                  phase: 'recovery' as const,
                  owner: source,
                  reason: 'The session was reset before this message was delivered.',
                },
              })),
            [successor]: (state.queues[source] ?? []).filter((entry) => entry.origin !== 'agent'),
          }
        : {}),
    },
    live,
    settings: copy(state.settings),
    profiles: copy(state.profiles),
    railOrder,
    showing: state.showing === source ? successor : state.showing,
    ...(state.origins ? { origins: copy(state.origins) } : {}),
    ...(state.sent ? { sent: { ...state.sent } } : {}),
    ...(state.boxText ? { boxText: move(state.boxText) } : {}),
  };
}

// Remove an untouched provisional draft. Retain text, attachments, queued work, live presses, hand-changed setup, and staging. The caller supplies handChanged because a custom profile source also describes launcher choices.
export function abandonSessionDraft(
  state: SessionIdentityState,
  provisional: string,
  handChanged: boolean,
  staging: boolean = false,
): SessionIdentityState | null {
  if (!Object.prototype.hasOwnProperty.call(state.profiles, provisional)) {
    return null;
  }
  if (
    (state.drafts[provisional] ?? '').trim() ||
    (state.assets?.[provisional]?.length ?? 0) > 0 ||
    (state.queues[provisional]?.length ?? 0) > 0 ||
    (state.live[provisional]?.length ?? 0) > 0 ||
    handChanged ||
    staging
  ) {
    return null;
  }
  const drop = <T>(book: Record<string, T>): Record<string, T> => {
    const { [provisional]: _value, ...rest } = book;
    return rest;
  };
  return {
    drafts: drop(state.drafts),
    assets: drop(state.assets ?? {}),
    queues: drop(state.queues),
    live: drop(state.live),
    settings: drop(state.settings),
    profiles: drop(state.profiles),
    railOrder: state.railOrder.filter((id) => id !== provisional),
    showing: state.showing === provisional ? null : state.showing,
    ...(state.origins ? { origins: drop(state.origins) } : {}),
    ...(state.sent ? { sent: drop(state.sent) } : {}),
    ...(state.boxText ? { boxText: drop(state.boxText) } : {}),
  };
}

export function activeWriterFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /already has an active writer/i.test(message);
}

// Translate prompt-delivery errors into recovery instructions for the failed-send card.
export function failedPromptDelivery(agent: string, error: unknown): PromptDelivery {
  const name = agentName(agent);
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (activeWriterFailure(error)) {
    return {
      delivered: false,
      reason: `${name} already has this session open in another client. Close it there, restore this prompt, and try again.`,
    };
  }
  if (/unknown variant .*expected one of/i.test(message)) {
    return {
      delivered: false,
      reason: `${name} could not reopen this session because its saved history is not compatible with this version.`,
    };
  }
  return {
    delivered: false,
    reason: `${name} refused this prompt. Restore it and try again after resolving the error shown by the editor.`,
  };
}

// Report compaction failures through the shared session-control error formatter. Preserve the agent's error text and add a retry instruction.
export function failedCompactionDelivery(agent: string, error: unknown): PromptDelivery {
  return failedSessionControlDelivery(agent, error, 'compacting');
}

export function failedClearDelivery(agent: string, error: unknown): PromptDelivery {
  return failedSessionControlDelivery(agent, error, 'clearing');
}

function failedSessionControlDelivery(
  agent: string,
  error: unknown,
  action: 'compacting' | 'clearing',
): PromptDelivery {
  const name = agentName(agent);
  if (activeWriterFailure(error)) {
    return {
      delivered: false,
      reason: `${name} already has this session open in another client. Close it there and try again.`,
    };
  }
  const said = sentence(error instanceof Error ? error.message : String(error ?? ''));
  const retry = action === 'compacting' ? 'Try compacting again' : 'Try clearing the session again';
  return {
    delivered: false,
    reason: said ? `${opened(said)} ${retry} once that is resolved.` : `No reason came back. ${retry}.`,
  };
}

// Capitalize the opening character of a standalone sentence.
function opened(said: string): string {
  return said.charAt(0).toUpperCase() + said.slice(1);
}

// Cache states for the next-turn starting estimate. The browser selects a face from its clock and the supplied cache boundary.
export type NextTurnState = 'warm' | 'cold' | 'range';

// A detail line contains plain text or text split around a timestamp for the panel's age ticker.
export type NextTurnLine = string | { lead: string; at: number; title?: string; trail: string; remaining?: boolean };

export interface NextTurnEntry {
  label: string;
  value?: NextTurnLine;
  lines?: NextTurnLine[];
  separateBefore?: boolean;
}

// Split text around a duration that the panel updates from its clock.
export interface NextTurnSpan {
  lead: string;
  // Count time remaining or time since the boundary.
  count: 'left' | 'since';
  // Native tooltip describing the full cache lifetime.
  title: string;
  // Text that replaces the duration near the uncertain cache boundary.
  near: { lead: string; value: string; trail: string };
  trail: string;
}

export type NextTurnWords = string | NextTurnSpan;

export interface NextTurnFace {
  state: NextTurnState;
  // Plain text before the pressable price.
  lead: string;
  // Conservative starting price displayed as the control.
  price: string;
  // Text after the price, split around any duration.
  trail: NextTurnWords;
  // The model cache lifetime behind the cache status, if the pricing row records one.
  statusTitle: string | null;
  // Display estimate details in one column.
  layout: 'stacked';
  entries: NextTurnEntry[];
  // Standing explanations under the popover's notes disclosure.
  notes: string[];
}

export interface ComposerNextTurn {
  // Disclosure label for the estimate details.
  disclosure: string;
  // Conservative cache-expiry boundary, earlier than the nominal lifetime.
  coldAt: number | null;
  // Mark estimates after compaction so the panel selects the cold face regardless of the clock.
  afterCompaction: boolean;
  // Allowance for recorded request-clock error.
  tolerance: number;
  // Duration range around the boundary that uses uncertainty wording.
  nearBoundary: number;
  warm: NextTurnFace | null;
  cold: NextTurnFace | null;
}

const TIER_WORDS: Record<CacheTier, { bought: string; noun: string; window: string }> = {
  '1h': { bought: '1 hour', noun: 'hour', window: 'the last hour' },
  '30m': { bought: '30 minutes', noun: '30 minutes', window: 'the last 30 minutes' },
  '5m': { bought: '5 minutes', noun: '5 minutes', window: 'the last 5 minutes' },
};

// Disclosure wording for the visible estimate and its accessible name.
const NEXT_TURN_DISCLOSURE = 'Details';

// Shared text before the price on every estimate face.
const NEXT_TURN_LEAD = 'Next turn starts at ';

const NEXT_TURN_NOTES = ['Conservative API list-price estimates. Actual charges can differ.'];

function nextTurnFaces(
  basis: NextTurnBasis,
  lifetimeTier: CacheTier | null,
  coldAt: number | null,
  warmMoney: string,
  coldMoney: string,
  coldOnly: boolean,
): Pick<ComposerNextTurn, 'warm' | 'cold'> {
  const tier = lifetimeTier ? TIER_WORDS[lifetimeTier] : null;
  const modelTier = lifetimeTier ?? cacheLifetimeFor(basis.model, basis.provider);
  const statusTitle = modelTier
    ? `${shortModel(basis.model) ?? 'Model'} cache lifetime: ${TIER_WORDS[modelTier].bought}`
    : null;
  if (!tier && (basis.afterCompaction || coldOnly)) {
    const compacted: NextTurnFace = {
      state: 'cold',
      lead: NEXT_TURN_LEAD,
      price: coldMoney,
      trail: ', uncached',
      statusTitle,
      layout: 'stacked',
      entries: [...(warmMoney === coldMoney ? [] : [{ label: 'Cost if cache were warm', value: warmMoney }])],
      notes: NEXT_TURN_NOTES,
    };
    return { warm: null, cold: compacted };
  }
  if (!tier) {
    return {
      warm: null,
      cold: {
        state: 'cold',
        lead: NEXT_TURN_LEAD,
        price: coldMoney,
        trail: ', uncached',
        statusTitle,
        layout: 'stacked',
        entries: [...(warmMoney === coldMoney ? [] : [{ label: 'Cost if cache were warm', value: warmMoney }])],
        notes: NEXT_TURN_NOTES,
      },
    };
  }
  const lifetime = `${shortModel(basis.model) ?? 'Model'} cache lifetime: ${tier.bought}`;
  const warm: NextTurnFace = {
    state: 'warm',
    lead: NEXT_TURN_LEAD,
    price: warmMoney,
    statusTitle,
    // Show remaining cache time on the warm face.
    trail: {
      lead: ', cached for another ',
      count: 'left',
      title: lifetime,
      near: { lead: ', cached for under ', value: '2m', trail: '' },
      trail: '',
    },
    layout: 'stacked',
    entries: [...(warmMoney === coldMoney ? [] : [{ label: 'Cost if cache were cold', value: coldMoney }])],
    notes: NEXT_TURN_NOTES,
  };
  const cold: NextTurnFace = {
    state: 'cold',
    lead: NEXT_TURN_LEAD,
    price: coldMoney,
    trail: ', uncached',
    statusTitle,
    layout: 'stacked',
    entries: [...(warmMoney === coldMoney ? [] : [{ label: 'Cost if cache were warm', value: warmMoney }])],
    notes: NEXT_TURN_NOTES,
  };
  return { warm, cold };
}

interface ProspectiveNextTurn {
  basis: NextTurnBasis;
  coldOnly: 'model-change' | 'effort-change' | null;
}

// A changed model replaces pricing identity and clears cache state. Effort changes retain the recorded model and write tier.
export function prospectiveNextTurn(state: ComposerState): ProspectiveNextTurn | null {
  const basis = state.nextTurn;
  if (!basis) return null;
  const selected = chosenModel(state.models, state.settings.selectedModel);
  const unchanged =
    !selected ||
    (selected.resolvedModel
      ? sameModelIdentity(selected.resolvedModel, basis.model)
      : modelRan(state.models, basis.model)?.value === selected.value);
  if (selected && !unchanged) {
    const model = selected.resolvedModel ?? selected.value;
    return {
      basis: { ...basis, model, window: contextWindowFor(model, basis.provider), tier: null, readBack: false },
      coldOnly: 'model-change',
    };
  }
  if (state.agent === 'claude' && basis.effort) {
    const pending = state.settings.pendingEffort;
    const effort = pending ?? (state.settings.selectedEffort || state.settings.confirmedEffort);
    if (
      effort &&
      effort !== basis.effort &&
      !effortChangeKeepsCache(basis.model, basis.provider, basis.inferenceClass, basis.bedrock)
    ) {
      return { basis: { ...basis, readBack: false }, coldOnly: 'effort-change' };
    }
  }
  return { basis, coldOnly: null };
}

// Omit the next-turn figure without a request basis or a usable formatted price.
function nextTurnFigure(prospective: ProspectiveNextTurn | null): ComposerNextTurn | null {
  if (!prospective) {
    return null;
  }
  const { basis, coldOnly } = prospective;
  const lifetimeTier =
    basis.afterCompaction || coldOnly !== null ? null : (basis.tier ?? cacheLifetimeFor(basis.model, basis.provider));
  const floor = nextTurnFloor({
    contextTokens: basis.tokens,
    freshTokens: basis.outputTokens,
    model: basis.model,
    provider: basis.provider,
    contextWindow: basis.window,
    tier: basis.afterCompaction || coldOnly === 'model-change' ? null : basis.tier,
    inferenceClass: basis.inferenceClass,
    serviceTier: basis.serviceTier,
  });
  if (!floor) {
    return null;
  }
  const warmMoney = formatConservativeCost(floor.warm);
  const coldMoney = formatConservativeCost(floor.cold);
  if (!warmMoney || !coldMoney) {
    return null;
  }
  const coldAt = lifetimeTier
    ? basis.lastRequestAt + CACHE_LIFETIME_MS[lifetimeTier] - CONSERVATIVE_CACHE_BOUNDARY_MS
    : null;
  return {
    disclosure: NEXT_TURN_DISCLOSURE,
    coldAt,
    afterCompaction: basis.afterCompaction,
    tolerance: CONSERVATIVE_CACHE_BOUNDARY_MS,
    nearBoundary: Math.max(CONSERVATIVE_CACHE_BOUNDARY_MS, CACHE_SPAN_MINIMUM_SECONDS * 1000),
    ...nextTurnFaces(basis, lifetimeTier, coldAt, warmMoney, coldMoney, coldOnly !== null),
  };
}

// Select the estimate face from the supplied cache boundary and clock. After compaction, select the cold face when available. `webview/composer-presentation.ts` also evaluates this state in the browser.
export function nextTurnStateAt(figure: ComposerNextTurn | null, now: number): NextTurnState {
  if (!figure) {
    return 'range';
  }
  if (figure.afterCompaction && figure.cold) {
    return 'cold';
  }
  if (figure.coldAt === null || !figure.warm || !figure.cold) {
    return 'cold';
  }
  return now < figure.coldAt ? 'warm' : 'cold';
}

function contextFigure(
  context: { used: number; max: number } | null,
  agent: string,
  _name: string,
): ComposerContext | null {
  if (!context) {
    return null;
  }
  const { used, max } = context;
  if (!Number.isFinite(used) || !(max > 0)) {
    return null;
  }
  const share = used / max;
  const percent = wholePercent(share);
  // Use the context chip's shared percentage bands.
  const band = bandForPercent(percent);
  const compact = compactCommand(agent);
  const said = `${percent}% of the context window used${band ? `, ${band.word}` : ''}`;
  return {
    used,
    capacity: max,
    generation: 0,
    percent,
    fill: Math.max(0, Math.min(100, percent)),
    level: band ? band.level : null,
    name: `Context details. ${said}.`,
    compact,
  };
}

// Trim text and append a full stop unless it already ends in sentence punctuation.
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// Include the visible label, description, and selected state in the row's accessible name.
function rowName(item: Omit<MenuItem, 'name'>): string {
  const parts = [sentence(item.label)];
  if (item.description) {
    parts.push(sentence(item.description));
  }
  if (item.checked) {
    parts.push('Current setting.');
  }
  return parts.join(' ');
}

// Build model, effort, and permission menu rows with shared accessible names.
function menuItem(choice: { value: string; label: string; description: string }, checked: boolean): MenuItem {
  // Each row selects one setting and uses no caution styling.
  const row = {
    value: choice.value,
    label: choice.label,
    description: choice.description,
    checked,
    caution: false,
    kind: 'radio' as const,
  };
  return { ...row, name: rowName(row) };
}

// Explain an empty model menu.
function modelEmpty(name: string): string {
  return `${name} has not said yet which models it runs.`;
}

// Distinguish an unresolved model from a model without effort settings. A named effort keeps an unlisted model from reading as no model.
function effortEmpty(model: ModelChoice | null, name: string, named = false): string {
  return model
    ? `${model.label} takes no effort setting.`
    : named
      ? `The effort cannot change until ${name} lists the model this session runs on.`
      : `The effort is the model's, and ${name} has no model settled on yet.`;
}

function modelMenu(state: ComposerState, name: string): Menu {
  const chosen = selectedModelPick(
    state.models,
    settledModel(state)?.value || state.settings.selectedModel,
    state.defaults,
    true,
  );
  return {
    revision: state.defaults?.revision,
    control: 'model',
    agent: state.agent,
    session: state.sessionId,
    head: `Which model should ${name} run this session on?`,
    // Model rows use no caution styling.
    items: modelPicks(state.models, state.defaults, true).map((model) =>
      menuItem(
        model,
        model.identity === chosen?.identity ||
          model.aliases.includes(settledModel(state)?.value || state.settings.selectedModel),
      ),
    ),
    empty: state.models.length === 0 ? modelEmpty(name) : '',
  };
}

function effortMenu(state: ComposerState, name: string): Menu {
  const model = settledModel(state);
  const efforts = model ? effortPicks(state.models, model.value, state.defaults) : [];
  // Select the effort from the reader's choice, recorded level, then applied default.
  const at =
    state.settings.selectedEffort ||
    state.settings.confirmedEffort ||
    defaultsForModel(state.models, model?.value ?? '', state.defaults)?.effort ||
    '';
  const chosen = efforts.find((effort) => effort.value === at) ?? null;
  return {
    revision: state.defaults?.revision,
    control: 'effort',
    agent: state.agent,
    session: state.sessionId,
    model: model?.value ?? '',
    // Name the settled model in the question, or use the generic model label.
    head: `How much should ${model ? model.label : 'the model'} work on a turn?`,
    items: efforts.map((effort) => menuItem(effort, effort === chosen)),
    empty:
      efforts.length === 0
        ? effortEmpty(model, name, Boolean(state.settings.selectedEffort || state.settings.confirmedEffort))
        : '',
  };
}

// Build permission choices from the supplied agent and stored value for either a draft or a live session.
function askModeMenu(
  agent: string,
  value: string | undefined,
  session: string,
  _effective?: CodexEffectiveMode | null,
  _useEffective = false,
): Menu {
  const chosen = (value ? askModes(agent).find((mode) => mode.value === value) : undefined) ?? agentDefaultMode(agent);
  return {
    control: 'askmode',
    agent,
    session,
    head: own(ASK_MODE_HEADS, agent) ?? ASK_MODE_HEADS.claude,
    // Permission rows use no caution styling.
    items: permissionModes(agent).map((mode) => menuItem(mode, mode === chosen)),
    // Every supported agent has permission choices. Unknown agents use the Claude choices.
    empty: '',
  };
}

// Draft menus read their setup choices from the draft profile.

// Only drafts offer an agent choice.
function draftAgentMenu(state: ComposerState, profile: SessionProfile): Menu {
  return {
    control: 'agent',
    agent: profile.agent,
    session: state.sessionId,
    head: 'Which agent should start this draft?',
    // Agent rows show their names without descriptions.
    items: LAUNCH_AGENTS.map((agent) =>
      menuItem({ value: agent, label: agentName(agent), description: '' }, agent === profile.agent),
    ),
    empty: '',
  };
}

function draftModelMenu(state: ComposerState, profile: SessionProfile, name: string): Menu {
  const rows = modelPicks(state.models, state.defaults);
  const chosen = selectedModelPick(state.models, profile.model, state.defaults);
  return {
    revision: state.defaults?.revision,
    control: 'model',
    agent: profile.agent,
    session: state.sessionId,
    head: `Which model should ${name} run this draft on?`,
    // The applied default can select a catalog row or a synthesized row by identity.
    items: rows.map((model) => menuItem(model, model.identity === chosen?.identity)),
    empty: rows.length === 0 ? modelEmpty(name) : '',
  };
}

function draftEffortMenu(state: ComposerState, profile: SessionProfile, name: string): Menu {
  const model = selectedModelPick(state.models, profile.model, state.defaults);
  const rows = effortPicks(state.models, profile.model, state.defaults);
  const at = profile.effort || defaultsForModel(state.models, profile.model, state.defaults)?.effort;
  return {
    revision: state.defaults?.revision,
    control: 'effort',
    agent: profile.agent,
    session: state.sessionId,
    model: model?.value ?? '',
    // Use the draft's model in the question and its effort choices in the rows.
    head: `How much should ${model ? model.readingLabel : 'the model'} work on a turn?`,
    items: rows.map((effort) => menuItem(effort, effort.value === at)),
    empty: rows.length === 0 ? effortEmpty(model ? { ...model, label: model.readingLabel } : null, name) : '',
  };
}

// Return the selected control's menu, or null for an absent session or unsupported control.
export function pickMenu(control: string, state: ComposerState | null): Menu | null {
  if (!state) {
    return null;
  }
  const profile = state.profile;
  if (profile) {
    const drafted = agentName(profile.agent);
    if (control === 'agent') {
      return draftAgentMenu(state, profile);
    }
    if (control === 'model') {
      return draftModelMenu(state, profile, drafted);
    }
    if (control === 'effort') {
      return draftEffortMenu(state, profile, drafted);
    }
    if (control === 'askmode') {
      return askModeMenu(profile.agent, profile.permissionMode, state.sessionId);
    }
    if (control === 'mcp') {
      const menu = mcpMenu(state.mcpServers, profile.agent, drafted);
      return menu ? { ...menu, session: state.sessionId } : null;
    }
    return null;
  }
  const name = agentName(state.agent);
  if (control === 'model') {
    return modelMenu(state, name);
  }
  if (control === 'effort') {
    return effortMenu(state, name);
  }
  if (control === 'askmode') {
    return askModeMenu(state.agent, state.askMode, state.sessionId, state.effectiveMode, true);
  }
  // Use the shared server menu, omitting it when the agent reports no servers.
  if (control === 'mcp') {
    const menu = mcpMenu(state.mcpServers, state.agent, name);
    return menu ? { ...menu, session: state.sessionId } : null;
  }
  return null;
}

// Disable the model control when its menu has no rows.
function modelPick(state: ComposerState, name: string): ComposerPick {
  const selected = state.settings.selectedModel;
  const chosen = chosenModel(state.models, selected);
  // Resolve the label from the selected or recorded model, then the catalog fallback. Empty selections need `||` to reach a nonempty label.
  const pending = modelPending(state);
  const confirmedChoice = recordedModel(state);
  const readConfirmed = !selected || (!pending && state.settings.pendingModel !== null);
  const running = readConfirmed ? confirmedChoice : null;
  const recorded = readConfirmed ? (shortModel(state.settings.confirmedModel) ?? '') : '';
  // An unconfirmed selection keeps its own label, including a stored value absent from the catalog.
  const baseLabel =
    (readConfirmed ? running?.label || recorded : chosen?.label || selected) ||
    modelLabel(state.models, selected, state.defaults);
  const projected = modelPicks(state.models, state.defaults, true).find(
    (item) => item.aliases.includes(selected) || item.identity === (running?.resolvedModel || running?.value),
  );
  const label = projected?.configuredDefault ? projected.readingLabel : baseLabel;
  const menu = modelMenu(state, name);
  const waiting = menu.items.length === 0;
  // Describe a recorded model only when the label uses confirmed state.
  const read = readConfirmed && (running !== null || recorded !== '');
  const application = pending ? ', selected for the next turn' : read ? ', which is what the last turn ran on' : '';
  return {
    control: 'model',
    label,
    name: waiting
      ? `Model: ${label}. ${menu.empty}`
      : `Model: ${label}${application}. ` + 'Press to run this session on another model.',
    detail:
      !pending && read
        ? 'What the last turn in this session ran on. Nothing has been picked for it yet.'
        : chosen?.description || `Which model ${name} runs this session on`,
    disabled: waiting,
    // Model controls use no caution styling.
    caution: false,
  };
}

function effortPick(state: ComposerState, name: string): ComposerPick {
  const model = settledModel(state);
  const menu = effortMenu(state, name);
  if (!model || menu.items.length === 0) {
    // An effort stays readable when its model matches no catalog row. The menu stays closed.
    const pending = effortPending(state);
    const read =
      (!state.settings.selectedEffort || (!pending && state.settings.pendingEffort !== null)) &&
      Boolean(state.settings.confirmedEffort);
    const named = model ? '' : read ? state.settings.confirmedEffort : state.settings.selectedEffort;
    const application = pending ? ', selected for the next turn' : read ? ', which is what the last turn ran at' : '';
    return {
      control: 'effort',
      label: named || NO_EFFORT_LABEL,
      name: named ? `Effort: ${named}${application}. ${menu.empty}` : `Effort: none to set. ${menu.empty}`,
      detail: menu.empty,
      disabled: true,
      caution: false,
    };
  }
  const rows = effortPicks(state.models, model.value, state.defaults);
  const selected = menu.items.find((option) => option.checked)?.value;
  const chosen = rows.find((item) => item.value === selected);
  // Unset effort values are empty strings, so label fallbacks use `||`.
  const pending = effortPending(state);
  const read =
    (!state.settings.selectedEffort || (!pending && state.settings.pendingEffort !== null)) &&
    Boolean(state.settings.confirmedEffort);
  const label = read
    ? rows.find((item) => item.value === state.settings.confirmedEffort)?.readingLabel ||
      state.settings.confirmedEffort ||
      DEFAULT_EFFORT_LABEL
    : chosen?.readingLabel || state.settings.selectedEffort || DEFAULT_EFFORT_LABEL;
  const application = pending ? ', selected for the next turn' : read ? ', which is what the last turn ran at' : '';
  return {
    control: 'effort',
    label,
    name: `Effort: ${label}${application}. ` + `Press to change how much ${model.label} works on a turn.`,
    detail:
      !pending && read
        ? 'What the last turn in this session ran at. Nothing has been picked for it yet.'
        : chosen?.description || `How much ${model.label} works on a turn`,
    disabled: false,
    caution: false,
  };
}

function askModePick(state: ComposerState): ComposerPick {
  const menu = askModeMenu(state.agent, state.askMode, state.sessionId, state.effectiveMode, true);
  const mode = liveAskMode(state.agent, state.askMode, state.effectiveMode, state.effectivePermissionMode);
  // The accessible name includes the question, selected mode, and mode description.
  const description = mode.description ? ` ${sentence(mode.description)}` : '';
  return {
    control: 'askmode',
    label: mode.label,
    name: `${menu.head} ${mode.label}.${description} Press to change it.`,
    detail: mode.description || menu.head,
    disabled: menu.items.length === 0,
    // Permission controls use no caution styling.
    caution: false,
  };
}

// Convert the shared servers pick into a prompt box control. Omit it when no pick exists. A displayed servers control is enabled.
function mcpControl(state: ComposerState, name: string): ComposerPick | null {
  const pick = mcpPick(state.mcpServers, name);
  if (!pick) {
    return null;
  }
  return {
    control: 'mcp',
    label: pick.label,
    name: pick.name,
    detail: pick.detail,
    disabled: false,
    caution: pick.caution,
  };
}

// Running placeholders describe prompt delivery for the agent. Idle placeholders name available command and skill prefixes.
function placeholderFor(agent: string, name: string, running: boolean, commands: boolean, skills: boolean): string {
  if (running) {
    return takesMidTurnPrompt(agent)
      ? `Ask ${name} anything. It answers after this turn`
      : `Ask ${name} anything. It waits until this turn ends`;
  }
  if (!commands) {
    return `Ask ${name} anything`;
  }
  return agent === 'codex' && skills
    ? `Ask ${name} anything, or type / for commands or $ for skills`
    : `Ask ${name} anything, or type / for its commands`;
}

// Shared wording for sending and inserting a new line.
const SEND_HINT = 'Enter sends, Shift and Enter for a new line';

const SEND_LABEL = 'Send';
const STOP_LABEL = 'Stop';

// Use the shared comment-name formatter to normalize and shorten prompt text.
function oneLine(text: string): string {
  return noteName({ note: text });
}

// Agents listed here accept prompts during a running turn. Unknown agents retain the panel queue.
const TAKES_MIDTURN_PROMPT: Record<string, boolean> = { claude: true, codex: true };

export function takesMidTurnPrompt(agent: string): boolean {
  return own(TAKES_MIDTURN_PROMPT, agent) === true;
}

export function turnEndCompletesEveryPrompt(agent: string): boolean {
  return agent === 'codex';
}

// A submission sends immediately, enters the queue, or does nothing.
export type SendMeaning = 'send' | 'queue' | 'nothing';

export function sendAction(state: ComposerState): SendMeaning {
  const typed = state.onScreen.trim();
  // The host runs a Remote Control toggle at once, beside running work and the queue.
  if (remoteControlRequest(state.agent, typed) !== null) return 'send';
  // Codex compaction and clear controls hold new submissions in the panel queue.
  const compacting =
    state.agent === 'codex' &&
    state.live.some((press) => (press.kind === 'compact' || press.kind === 'clear') && !press.failed);
  // A running agent takes a prompt mid-turn only when the local queue is empty, so the queue stays first in, first out.
  // A Claude answer to an open request joins the running turn, which comes before any queued record.
  const answersOpenRequest =
    state.agent === 'claude' && Boolean(state.asks?.some((ask) => ask.kind !== 'question' || !ask.recovery));
  const takesNow =
    !state.clearing &&
    ((!state.running && !state.queued.length) ||
      (state.running &&
        takesMidTurnPrompt(state.agent) &&
        !compacting &&
        (!state.queued.length || answersOpenRequest)));
  // Comments or files permit a submission without typed text. Queued comments retain their attachments until delivery.
  const files = state.assets?.length ?? 0;
  if (!typed) {
    if (!commentsForActiveSubmission(state).length && !files) {
      return 'nothing';
    }
    return takesNow ? 'send' : 'queue';
  }
  return takesNow ? 'send' : 'queue';
}

// Actions available to the prompt box's main button.
export type PressMeaning = SendMeaning | 'compact' | 'clear';

// Any submission action answers the waiting requests. A press that sends nothing leaves them unanswered.
export function asksAnsweredBySend<T>(meant: PressMeaning, waiting: readonly T[]): readonly T[] {
  return meant === 'nothing' ? [] : waiting;
}

// Return comments attached to this session.
export function attachedComments(state: ComposerState): TurnComment[] {
  return commentsFor(state.comments, state.sessionId);
}

// Use the captured submission comments when supplied. Otherwise, exclude comments claimed by queued submissions and include explicit draft claims.
export function commentsForActiveSubmission(state: ComposerState): TurnComment[] {
  if (state.submittedComments) return [...state.submittedComments];
  const queued = new Set(state.queued.flatMap((entry) => entry.commentIds));
  const draft = new Set(state.draftCommentIds ?? []);
  return state.comments
    .filter((comment) => draft.has(comment.id) || (comment.sessionId === state.sessionId && !queued.has(comment.id)))
    .map((comment) =>
      draft.has(comment.id) && comment.sessionId !== state.sessionId
        ? { ...comment, sessionId: state.sessionId }
        : comment,
    );
}

// Remove delivered comments only when their content still matches the captured submission. Failed delivery preserves every comment.
export function commentsAfterSend(
  comments: readonly TurnComment[],
  carried: readonly TurnComment[],
  delivered: boolean,
): TurnComment[] {
  if (!delivered) {
    return [...comments];
  }
  const gone = new Map(carried.map((comment) => [comment.id, comment]));
  return comments.filter((comment) => {
    const sent = gone.get(comment.id);
    if (!sent) return true;
    // Delivery copies can name a successor session without changing the reader's comment.
    return (
      comment.note !== sent.note ||
      comment.at !== sent.at ||
      comment.turnKey !== sent.turnKey ||
      comment.part !== sent.part ||
      comment.quote !== sent.quote ||
      comment.offset !== sent.offset ||
      comment.headline !== sent.headline ||
      comment.sessionTitle !== sent.sessionTitle ||
      comment.turnAt !== sent.turnAt
    );
  });
}

// Append generated comments to the draft. Claude receives trimmed text.
export function promptToSend(state: ComposerState, now?: number): string {
  const prompt = state.agent === 'codex' ? state.draft : state.draft.trim();
  // Assemble comments with the shared formatter.
  const notes = emitComments(commentsForActiveSubmission(state), state.sessionId, now);
  if (!notes) {
    return prompt;
  }
  return prompt ? `${prompt}\n\n${notes}` : notes;
}

// Bound the count and total size of prompt history sent to the panel.
export const PROMPT_HISTORY_LIMIT = 20;
export const PROMPT_HISTORY_CHARS = 20_000;
// Keep submitted prompts newest first. Repeated cleaned text replaces its older entry.
export function sentAfter(held: readonly string[], text: string, limit: number = PROMPT_HISTORY_LIMIT): string[] {
  const one = text.trim();
  const key = cleanPrompt(one);
  if (!one || !key) {
    return [...held];
  }
  // Deduplicate by the same cleaned key used for recorded prompts.
  return [one, ...held.filter((word) => cleanPrompt(word) !== key)].slice(0, limit);
}

// Recognize a sent prompt followed by a blank line and a generated comments block.
function carriesComments(key: string, own: string): boolean {
  return key.startsWith(`${own}\n\n`) && looksLikeComments(key.slice(own.length + 2));
}

// Match the complete sent prompt or its assembled comments form. A shared opening line alone does not identify a submission.
function sameSend(key: string, own: { key: string }): boolean {
  return key === own.key || carriesComments(key, own.key);
}

// Remove saved submissions once the recorded prompts contain their plain or comments-appended form. Omit sessions without remaining submissions.
export function prunedSentPrompts(
  sent: Readonly<Record<string, readonly string[]>>,
  recorded: ReadonlyMap<string, readonly string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [session, prompts] of Object.entries(sent)) {
    const keys = (recorded.get(session) ?? []).map((raw) => cleanPrompt(raw.trim()));
    const kept = prompts.filter((one) => {
      const key = cleanPrompt(one);
      return !keys.some((recordedKey) => sameSend(recordedKey, { key }));
    });
    if (kept.length) {
      out[session] = kept;
    }
  }
  return out;
}

// Prune recorded submissions, then normalize the remaining prompts for storage.
export function sentPromptsToSave(
  sent: Readonly<Record<string, readonly string[]>>,
  recorded: ReadonlyMap<string, readonly string[]>,
): Record<string, string[]> {
  return normalizeSentPrompts(prunedSentPrompts(sent, recorded));
}

// Order all prompts by descending timestamp, using reverse input order to break ties.
export function askedInTurn(
  prompts: readonly { text: string; at: number }[],
  laterPrompts: readonly { text: string; at: number }[],
): string[] {
  return [...prompts, ...laterPrompts]
    .map((one, order) => ({ one, order }))
    .sort((a, b) => b.one.at - a.one.at || b.order - a.order)
    .map(({ one }) => one.text);
}

// Combine locally sent and recorded prompts, newest first. Cleaned keys identify duplicates. Use the original sent text for recorded submissions with appended comments. Put unmatched newer submissions before the recorded sequence.
export function promptHistory(
  recorded: readonly string[],
  sent: readonly string[],
  limit: number = PROMPT_HISTORY_LIMIT,
  chars: number = PROMPT_HISTORY_CHARS,
  entry: number = PROMPT_HISTORY_ENTRY_CHARS,
): string[] {
  const mine = sent
    .map((one) => one.trim())
    .map((text) => ({ text, key: cleanPrompt(text) }))
    .filter((one) => one.key);
  // Match both lists oldest first, preserving recorded order. Skip unmatched sends because recorded history omits older or oversized entries. Only sends newer than the newest match precede the recorded sequence.
  const keys = recorded.map((raw) => cleanPrompt(raw.trim()));
  const stands = new Map<number, { text: string; key: string }>();
  let ahead = mine.length;
  let at = recorded.length - 1;
  for (let p = mine.length - 1; p >= 0; p -= 1) {
    let i = at;
    while (i >= 0 && !sameSend(keys[i], mine[p])) {
      i -= 1;
    }
    if (i < 0) {
      continue;
    }
    stands.set(i, mine[p]);
    ahead = p;
    at = i - 1;
  }
  const older: { text: string; key: string }[] = [];
  recorded.forEach((raw, i) => {
    const own = stands.get(i);
    if (own) {
      older.push(own);
      return;
    }
    const text = raw.trim();
    const key = cleanPrompt(text);
    if (!key) {
      return;
    }
    // Exclude generated comments-only prompts from history.
    if (looksLikeComments(key)) {
      return;
    }
    // Exclude unmatched assembled copies of submissions already represented by their typed text.
    if (mine.some((own) => carriesComments(key, own.key))) {
      return;
    }
    older.push({ text, key });
  });
  const kept: string[] = [];
  const seen = new Set<string>();
  let spent = 0;
  // Offer unmatched newer sends first, then recorded prompts in their existing order.
  for (const one of [...mine.slice(0, ahead), ...older]) {
    if (seen.has(one.key)) {
      continue;
    }
    if (kept.length >= limit) {
      break;
    }
    // Skip entries beyond the individual size limit without excluding smaller prompts that follow.
    if (one.text.length > entry) {
      continue;
    }
    // Skip an entry that exceeds the remaining total text budget.
    if (spent + one.text.length > chars) {
      continue;
    }
    seen.add(one.key);
    kept.push(one.text);
    spent += one.text.length;
  }
  return kept;
}

// Add a turn's prompts to recorded history until the limit is reached. Exclude oversized, blank, and repeated cleaned prompts.
export function promptsAcross(
  held: readonly string[],
  prompts: readonly { text: string; at: number }[],
  laterPrompts: readonly { text: string; at: number }[],
  limit: number = PROMPT_HISTORY_LIMIT,
  entry: number = PROMPT_HISTORY_ENTRY_CHARS,
): string[] {
  if (held.length >= limit) {
    return [...held];
  }
  const seen = new Set(held.map((one) => cleanPrompt(one)));
  const kept = [...held];
  for (const one of askedInTurn(prompts, laterPrompts)) {
    // Exclude oversized prompts before they consume a history slot.
    if (one.length > entry) {
      continue;
    }
    const key = cleanPrompt(one.trim());
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(one);
    if (kept.length >= limit) {
      break;
    }
  }
  return kept;
}

export function agentPromptToSend(state: ComposerState, now?: number): AgentPrompt {
  return { text: promptToSend(state, now), assets: [...(state.assets ?? [])] };
}

// Maximum comments listed individually in the attachment detail. Summarize the remaining count on one line.
export const ATTACHED_DETAIL_ROWS = 5;

// Visible label for the attached comment count.
function attachedLabel(count: number): string {
  return `${count} ${count === 1 ? 'comment' : 'comments'}`;
}

// Omit the comments chip when the active submission has no comments.
function annotationChip(state: ComposerState): ComposerAnnotations | null {
  const mine = commentsForActiveSubmission(state);
  if (!mine.length) {
    return null;
  }
  const label = attachedLabel(mine.length);
  const lines = mine.slice(0, ATTACHED_DETAIL_ROWS).map((comment) => oneLine(comment.note));
  if (mine.length > ATTACHED_DETAIL_ROWS) {
    lines.push(`and ${mine.length - ATTACHED_DETAIL_ROWS} more`);
  }
  const one = mine.length === 1;
  return {
    count: mine.length,
    label,
    // The accessible name explains that sending clears the attached comments from their turns.
    name: `${label} ${one ? 'goes' : 'go'} out with this prompt and ${one ? 'is' : 'are'} cleared from the turns afterwards`,
    detail: lines.join('\n'),
    control: 'attachments',
  };
}

function composerFile(
  asset: Pick<StoredPromptAsset, 'id' | 'name' | 'mime' | 'size'>,
  preview: string | null,
): ComposerFile {
  const { stem, ext } = splitAssetName(asset.name);
  const kind = assetKindWord(asset.mime);
  const sizeLabel = formatMegabytes(asset.size);
  return {
    id: asset.id,
    label: asset.name,
    name: `${asset.name}, ${kind}, ${sizeLabel}`,
    size: asset.size,
    preview,
    kind,
    stem,
    ext,
    sizeLabel,
    removeLabel: 'Remove',
    removeName: `Remove attached file ${asset.name}`,
    removeControl: `removeFile:${asset.id}`,
  };
}

function composerFiles(state: ComposerState): ComposerFile[] {
  return (state.assets ?? []).map((asset) =>
    composerFile(asset, asset.mime.startsWith('image/') ? (state.assetPreviews?.[asset.id] ?? null) : null),
  );
}

export function attachmentRefusal(code: string, name: string = '', size: number = 0, rejected: number = 0): string {
  if (code === 'file-size') {
    return `${name} is ${formatMegabytes(size)}. Each file must be under ${formatMegabytes(MAX_PROMPT_ASSET_BYTES)}.`;
  }
  if (code === 'count') {
    return `Only ${MAX_PROMPT_ASSETS} files can go with one prompt. ${rejected} ${rejected === 1 ? 'was' : 'were'} not attached.`;
  }
  if (code === 'total-size') {
    return `The files together are ${formatMegabytes(size)}. One prompt can carry ${formatMegabytes(MAX_PROMPT_ASSET_TOTAL_BYTES)}.`;
  }
  if (code === 'unsupported') {
    return `Claude cannot read ${name}. It takes images, PDFs and text files.`;
  }
  if (code === 'busy') {
    return 'Wait for the attached files to finish staging.';
  }
  if (code === 'uri') {
    return `${rejected} dropped ${rejected === 1 ? 'item was' : 'items were'} not added. Arc adds only files and folders on this computer.`;
  }
  return `${name || 'The file'} could not be read.`;
}

export function attachmentFailureNotice(error: unknown, name: string = ''): string {
  const busy = attachmentRefusal('busy');
  return error instanceof Error && error.message === busy ? busy : attachmentRefusal('read', name);
}

// Text labels for waiting-card actions.
const QUEUE_EDIT = 'Edit';
const QUEUE_COPY = 'Copy';
const QUEUE_DROP = 'Drop';

// Queue a bounded submission and claim comments not already owned by earlier entries. Empty submissions with no comments or files add nothing.
export function queueSubmissionAfter(
  queued: readonly QueuedSubmission[],
  id: string,
  text: string,
  commentIds: readonly string[],
  assets: readonly StoredPromptAsset[],
  at: number,
  heldForClear = false,
  ownership?: { agent: string; owner: string; origin?: 'agent' },
): QueuedSubmission[] {
  const one = ownership?.origin === 'agent' || ownership?.agent === 'codex' ? text : text.trim();
  if (
    queued.length >= QUEUED_SUBMISSION_LIMIT ||
    one.length > DRAFT_TEXT_LIMIT ||
    queued.reduce((sum, entry) => sum + entry.text.length, 0) + one.length > QUEUED_TEXT_CHARS
  ) {
    return [...queued];
  }
  const claimed = new Set(queued.flatMap((entry) => entry.commentIds));
  const own = commentIds.filter((id) => !claimed.has(id));
  const owner = ownership?.owner ?? queued[0]?.delivery.owner ?? '';
  const reset = [...queued].reverse().find((entry) => {
    const route = entry.delivery;
    return (
      (route.phase === 'queued' && route.resetId && !route.barrier) ||
      route.phase === 'reset-in-flight' ||
      route.phase === 'unknown' ||
      route.phase === 'source-recovery' ||
      route.phase === 'source-owned' ||
      route.phase === 'source-delivery'
    );
  });
  const barrier = reset && 'resetId' in reset.delivery ? reset.delivery.resetId : '';
  const resetRequest = ownership?.agent === 'codex' ? clearRequest('codex', one) : null;
  const delivery: QueuedSubmission['delivery'] = {
    phase: 'queued',
    owner,
    ...(resetRequest?.command === 'new' ? { resetId: id } : {}),
    ...(barrier || heldForClear ? { barrier: barrier || `clear:${owner}` } : {}),
  };
  return one.trim() || own.length || assets.length
    ? [
        ...queued,
        {
          id,
          ...(ownership?.origin === 'agent' ? { origin: 'agent' as const } : {}),
          text: one,
          commentIds: own,
          assets: assets.map((asset) => ({ ...asset })),
          at,
          delivery,
        },
      ]
    : [...queued];
}

// Include this entry's explicit comment claims and this session's unclaimed comments. Exclude later and draft claims from the unclaimed set. Rebind explicit claims to the delivery session without changing stored comments.
export function commentsForQueuedSubmission(
  state: ComposerState,
  next: QueuedSubmission,
  later: readonly QueuedSubmission[],
): TurnComment[] {
  if (next.origin === 'agent') return [];
  const own = new Set(next.commentIds);
  const laterIds = new Set(later.flatMap((entry) => entry.commentIds));
  const draftIds = new Set(state.draftCommentIds ?? []);
  return state.comments
    .filter(
      (comment) =>
        own.has(comment.id) ||
        (comment.sessionId === state.sessionId && !laterIds.has(comment.id) && !draftIds.has(comment.id)),
    )
    .map((comment) =>
      own.has(comment.id) && comment.sessionId !== state.sessionId
        ? { ...comment, sessionId: state.sessionId }
        : comment,
    );
}

// Build a waiting row with abbreviated text and a full copy of its prompt. Long text gets an expansion control.
function queuedPrompt(state: ComposerState, entry: QueuedSubmission, name: string, now: number): QueuedPrompt {
  const text = state.agent === 'codex' ? entry.text : entry.text.trim();
  const ownedComments = new Set(entry.commentIds);
  const copyText = promptToSend(
    {
      ...state,
      draft: text,
      queued: [],
      draftCommentIds: entry.commentIds,
      comments: state.comments.filter((comment) => ownedComments.has(comment.id)),
    },
    now,
  );
  const display =
    (text.trim() ? text : '') ||
    (entry.assets.length
      ? `Attached: ${entry.assets.map((asset) => asset.name).join(', ')}`
      : 'Comments attached to turns');
  const label = oneLine(display);
  const long = label !== display;
  const absolute = entry.at ? formatWhen(entry.at, now) : '';
  const uncertain =
    entry.delivery.phase === 'unknown' ||
    entry.delivery.phase === 'recovery' ||
    entry.delivery.phase === 'source-recovery' ||
    entry.delivery.phase === 'successor-recovery';
  const status = entry.reason ? 'Send failed' : uncertain ? 'Delivery uncertain' : 'Waiting to send';
  const statusName = entry.reason
    ? `Send to ${name} failed. This prompt is still waiting.`
    : uncertain
      ? `Delivery status is unknown after reload. ${name} might have received this prompt, so it will not be sent again automatically.`
      : `Waiting to send to ${name}.`;
  return {
    id: entry.id,
    label,
    text: display,
    long,
    openName: long ? `Waiting to be sent: ${label}. Press to read the whole prompt.` : '',
    shutName: long ? `Waiting to be sent: ${label}. Press to shut it again.` : '',
    control: long ? `queued:${entry.id}` : '',
    dropName: `Take this prompt out of the queue: ${label}.`,
    dropControl: `drop:${entry.id}`,
    editName: `Put this prompt back in the box to change it: ${label}.`,
    editControl: `edit:${entry.id}`,
    editLabel: QUEUE_EDIT,
    dropLabel: QUEUE_DROP,
    copyText: copyText || display,
    copyName: `Copy this prompt: ${label}.`,
    copyControl: `copy:${entry.id}`,
    copyLabel: QUEUE_COPY,
    at: entry.at,
    relative: entry.at ? formatRelative(entry.at, now) : 'Earlier',
    absolute,
    agent: name,
    headName: `${statusName} ${label}.${absolute ? ` ${absolute}.` : ''}`,
    status,
    reason: entry.reason ?? '',
    files: entry.assets.map((asset) => {
      const {
        removeLabel: _removeLabel,
        removeName: _removeName,
        removeControl: _removeControl,
        ...file
      } = composerFile(asset, asset.mime.startsWith('image/') ? (state.assetPreviews?.[asset.id] ?? null) : null);
      return file;
    }),
  };
}

// Append a prompt through the shared submission builder. Whitespace alone adds nothing. Codex retains its original text.
export function queueAfter(
  queued: readonly QueuedSubmission[],
  id: string,
  text: string,
  at: number,
  heldForClear = false,
  ownership?: { agent: string; owner: string },
): QueuedSubmission[] {
  return queueSubmissionAfter(queued, id, text, [], [], at, heldForClear, ownership);
}

// Find a queued prompt by its stable submission id. Return null when that entry no longer exists.
export function queuedText(queued: readonly QueuedSubmission[], id: string): string | null {
  const found = queued.find((entry) => entry.id === id);
  return found === undefined ? null : found.text;
}

export function queuedSubmission(queued: readonly QueuedSubmission[], id: string): QueuedSubmission | null {
  return queued.find((entry) => entry.id === id) ?? null;
}

// Remove the queued submission with the given id.
export function queueWithout(queued: readonly QueuedSubmission[], id: string): QueuedSubmission[] {
  return queued.filter((entry) => entry.id !== id);
}

// A queued or successor-owned submission drains only without a reset barrier. A source-owned submission drains directly.
export function queueCanDrain(entry: QueuedSubmission): boolean {
  if (!entry.delivery) {
    const legacy = entry as QueuedSubmission & { attempted?: boolean; heldForClear?: boolean };
    return !legacy.attempted && !legacy.heldForClear;
  }
  return (
    (entry.delivery.phase === 'successor-owned' && !entry.delivery.barrier) ||
    entry.delivery.phase === 'source-owned' ||
    (entry.delivery.phase === 'queued' && !entry.delivery.barrier)
  );
}

export function queueResetInFlight(
  queued: readonly QueuedSubmission[],
  entryId: string,
  source: string,
  commentIds: readonly string[],
  resetId = entryId,
): QueuedSubmission[] {
  const claimed = new Set(commentIds);
  let afterReset = false;
  return queued.map((entry) => {
    if (entry.id === entryId) {
      afterReset = true;
      return {
        ...entry,
        commentIds: [...new Set([...entry.commentIds, ...claimed])],
        reason: undefined,
        delivery: { phase: 'reset-in-flight', owner: source, source, resetId },
      };
    }
    if (!afterReset) {
      return entry;
    }
    return { ...entry, delivery: { phase: 'queued', owner: source, barrier: resetId } };
  });
}

export function queueResetSucceeded(
  queued: readonly QueuedSubmission[],
  entryId: string,
  source: string,
  successor: string,
  resetId = entryId,
): QueuedSubmission[] {
  let afterReset = false;
  return queued.map((entry) => {
    if (entry.id === entryId) {
      afterReset = true;
    }
    if (!afterReset && !(entry.delivery.phase === 'queued' && entry.delivery.barrier === resetId)) {
      return entry;
    }
    return {
      ...entry,
      ...(entry.id === entryId ? { text: '' } : {}),
      reason: undefined,
      delivery: {
        phase: 'successor-owned',
        owner: successor,
        source,
        successor,
        resetId,
        ...(entry.id === entryId ? {} : { barrier: resetId }),
      },
    };
  });
}

export function queueResetFailed(
  queued: readonly QueuedSubmission[],
  entryId: string,
  source: string,
  reason: string,
  resetId = entryId,
): QueuedSubmission[] {
  return queued.map((entry) =>
    entry.id === entryId
      ? {
          ...entry,
          reason,
          delivery: { phase: 'source-recovery', owner: source, source, resetId, reason },
        }
      : entry,
  );
}

export function queueSourceDelivery(queued: readonly QueuedSubmission[], id: string): QueuedSubmission[] {
  return queued.map((entry) =>
    entry.id === id && entry.delivery.phase === 'source-owned'
      ? { ...entry, delivery: { ...entry.delivery, phase: 'source-delivery' } }
      : entry,
  );
}

export function queueSourceFailed(queued: readonly QueuedSubmission[], id: string, reason: string): QueuedSubmission[] {
  return queued.map((entry) =>
    entry.id === id && entry.delivery.phase === 'source-delivery'
      ? {
          ...entry,
          reason,
          delivery: { ...entry.delivery, phase: 'source-recovery', reason },
        }
      : entry,
  );
}

export function queueSuccessorDelivery(queued: readonly QueuedSubmission[], id: string): QueuedSubmission[] {
  return queued.map((entry) =>
    entry.id === id && entry.delivery.phase === 'successor-owned'
      ? {
          ...entry,
          delivery: { ...entry.delivery, phase: 'successor-delivery' },
        }
      : entry,
  );
}

export function queueSuccessorFailed(
  queued: readonly QueuedSubmission[],
  id: string,
  reason: string,
): QueuedSubmission[] {
  return queued.map((entry) =>
    entry.id === id && entry.delivery.phase === 'successor-delivery'
      ? {
          ...entry,
          reason,
          delivery: { ...entry.delivery, phase: 'successor-recovery', reason },
        }
      : entry,
  );
}

export function queueAfterClearRecovery(
  _agent: string,
  queued: readonly QueuedSubmission[],
  removed: QueuedSubmission,
): QueuedSubmission[] {
  const route = removed.delivery;
  if (!route) {
    const legacyRemoved = removed as QueuedSubmission & { heldForClear?: boolean };
    if (!clearSubmission(_agent, legacyRemoved.text)) {
      return [...queued];
    }
    return queued.map((entry) => {
      const legacyEntry = entry as QueuedSubmission & { heldForClear?: boolean };
      return legacyEntry.heldForClear ? { ...legacyEntry, heldForClear: undefined } : entry;
    });
  }
  if (route.phase !== 'source-recovery' && route.phase !== 'unknown' && route.phase !== 'successor-recovery') {
    return [...queued];
  }
  const restoredClear = route.phase === 'unknown' && clearRequest(_agent, removed.text)?.command === 'clear';
  return queued.map((entry) => {
    if (!entry.delivery || !('barrier' in entry.delivery) || entry.delivery.barrier !== route.resetId) {
      return entry;
    }
    if (route.phase === 'unknown' && !restoredClear) {
      const reason = 'The reset outcome is unknown. Edit or Drop this waiting prompt.';
      return {
        ...entry,
        reason,
        delivery: {
          phase: 'source-recovery',
          owner: route.owner,
          source: route.source,
          resetId: route.resetId,
          reason,
        },
      };
    }
    return route.phase === 'source-recovery' || restoredClear
      ? { ...entry, delivery: { phase: 'queued', owner: route.owner } }
      : route.phase === 'successor-recovery' && entry.delivery.phase === 'successor-owned'
        ? { ...entry, delivery: { ...entry.delivery, barrier: undefined } }
        : entry;
  });
}

export function queueAfterAcceptedRecovery(
  queued: readonly QueuedSubmission[],
  accepted?: QueuedSubmission,
): QueuedSubmission[] {
  const ids = new Set(queued.map((entry) => entry.id));
  const resolved =
    accepted &&
    'resetId' in accepted.delivery &&
    (accepted.id === accepted.delivery.resetId ||
      accepted.delivery.phase === 'source-delivery' ||
      accepted.delivery.phase === 'successor-delivery')
      ? new Set([accepted.delivery.resetId])
      : new Set(
          queued.flatMap((entry) =>
            'barrier' in entry.delivery && entry.delivery.barrier && !ids.has(entry.delivery.barrier)
              ? [entry.delivery.barrier]
              : [],
          ),
        );
  return queued.map((entry) => {
    if (!('barrier' in entry.delivery) || !entry.delivery.barrier || !resolved.has(entry.delivery.barrier)) {
      return entry;
    }
    return entry.delivery.phase === 'successor-owned'
      ? { ...entry, delivery: { ...entry.delivery, barrier: undefined } }
      : { ...entry, delivery: { phase: 'queued', owner: entry.delivery.owner } };
  });
}

// Return the named submission for editing and put its replacement at the same queue position. Reset recovery retains a delivery marker and barrier.
export function queueEdit(
  queued: readonly QueuedSubmission[],
  id: string,
  replacement: QueuedSubmission | null,
): { queued: QueuedSubmission[]; submission: QueuedSubmission } | null {
  const wanted = queuedSubmission(queued, id);
  if (!wanted) {
    return null;
  }
  const route = wanted.delivery;
  const resetRecovery =
    route && (route.phase === 'source-recovery' || route.phase === 'unknown' || route.phase === 'successor-recovery');
  const next: QueuedSubmission[] = [];
  for (const entry of queued) {
    if (entry.id !== id) {
      next.push(entry);
      continue;
    }
    if (resetRecovery && route) {
      next.push({
        ...wanted,
        text: '',
        commentIds: [],
        assets: [],
        reason: undefined,
        delivery: {
          phase: 'draft-recovery',
          owner: route.owner,
          source: route.source,
          resetId: route.resetId,
          ...(route.phase === 'successor-recovery' ? { successor: route.successor } : {}),
        },
      });
      if (replacement) {
        next.push({
          ...replacement,
          delivery:
            route.phase === 'successor-recovery'
              ? {
                  phase: 'successor-owned',
                  owner: route.owner,
                  source: route.source,
                  successor: route.successor,
                  resetId: route.resetId,
                  barrier: route.resetId,
                }
              : { phase: 'queued', owner: route.owner, barrier: route.resetId },
        });
      }
    } else if (replacement) {
      next.push(replacement);
    }
  }
  return { queued: next, submission: wanted };
}

export function queueRecoverySubmission(
  marker: QueuedSubmission,
  text: string,
  commentIds: readonly string[],
  assets: readonly StoredPromptAsset[],
  at: number,
  agent: string,
): QueuedSubmission | null {
  const route = marker.delivery;
  if (route.phase !== 'draft-recovery') {
    return null;
  }
  const request = clearRequest(agent, text);
  return {
    id: marker.id,
    ...(marker.recoveryId ? { recoveryId: marker.recoveryId } : {}),
    text: agent === 'codex' ? text : text.trim(),
    commentIds: [...commentIds],
    assets: assets.map((asset) => ({ ...asset })),
    at,
    delivery: route.successor
      ? {
          phase: 'successor-owned',
          owner: route.owner,
          source: route.source,
          successor: route.successor,
          resetId: route.resetId,
        }
      : request?.command === 'new'
        ? { phase: 'queued', owner: route.owner, resetId: route.resetId }
        : { phase: 'source-owned', owner: route.owner, source: route.source, resetId: route.resetId },
  };
}

// Temporary state for a submitted prompt or session control before its recorded replacement arrives.
export interface LivePress extends PendingAskPosition {
  // The session that owns this submission.
  sessionId: string;
  agent: AgentKind;
  kind: LiveKind;
  // The assembled prompt text, or attachment names for a prompt without text. Session controls use an empty string.
  text: string;
  assets?: StoredPromptAsset[];
  // The submission time used for elapsed duration and recorded-turn matching.
  at: number;
  // The full response remains available until its recorded turn replaces the temporary card.
  reply: string;
  completed?: boolean;
  outcome?: 'ok' | 'interrupted' | 'error';
  turnId?: number;
  // Whether this prompt belongs to a turn already running when it was submitted.
  midTurn: boolean;
  // Whether the delivery receipt confirms acceptance. A busy signal alone does not confirm delivery.
  ran: boolean;
  // Whether accepted work has begun. A prompt accepted during compaction waits before starting.
  started: boolean;
  // Whether delivery failed.
  failed: boolean;
  // The reader-facing delivery failure reason, or an empty string before failure.
  reason: string;
}

// The submitted prompt or session control.
export type LiveKind = 'prompt' | 'compact' | 'clear';

// The response state before its recorded turn replaces the temporary card.
export type LiveState = 'sent' | 'running' | 'failed' | 'done' | 'interrupted';

// Only prompts submitted during a running turn qualify. An unfinished compaction or clear prevents classification as a mid-turn prompt.
export function pressIsMidTurn(
  kind: LiveKind,
  running: boolean,
  inFlight: readonly Pick<LivePress, 'kind' | 'failed'>[],
): boolean {
  if (kind !== 'prompt' || !running) {
    return false;
  }
  // Failed session controls do not block classification. Their notices remain until the reader dismisses them.
  return !inFlight.some((held) => (held.kind === 'compact' || held.kind === 'clear') && !held.failed);
}

// Replace unfinished submissions of the same kind. Retain completed responses until their recorded turns replace them.
export function pressesAfter(held: readonly LivePress[], next: LivePress): LivePress[] {
  return [...held.filter((one) => one.kind !== next.kind || one.completed), next];
}

// Mark the oldest accepted, unfinished submission as started when the session runs. Failed submissions do not qualify.
export function pressesAfterRunning(held: readonly LivePress[], running: boolean): LivePress[] {
  if (!running) {
    return [...held];
  }
  if (held.some((press) => press.started && !press.failed && !press.completed)) {
    return [...held];
  }
  const begun = held.find((press) => press.ran && !press.started && !press.failed && !press.completed);
  if (!begun) {
    return [...held];
  }
  return held.map((press) => (press === begun ? { ...press, started: true } : press));
}

// Remove the unfinished submission the CLI answered locally. The answer's turn names it, even after it started, because a command the CLI answers by itself never becomes a recorded turn. Without a match, remove the oldest submission that has not started and belongs to no other turn. Other started submissions retain their recorded-turn replacement requirement.
export function pressesAfterLocalAnswer(held: readonly LivePress[], turnId?: number): LivePress[] {
  const unfinished = held.filter((press) => !press.failed && !press.completed);
  const ended =
    (turnId === undefined ? undefined : unfinished.find((press) => press.turnId === turnId)) ??
    unfinished.find(
      (press) => !press.started && (turnId === undefined || press.turnId === undefined || press.turnId === turnId),
    );
  if (!ended) {
    return [...held];
  }
  return held.filter((press) => !(press === ended && livePressOver(press, null, false, 0, false, true)));
}

// Apply the delivery receipt to the submission with the matching timestamp. Busy state does not confirm acceptance.
export function pressesAfterHandoff(held: readonly LivePress[], at: number, delivery: PromptDelivery): LivePress[] {
  return held.map((press) => {
    if (press.at !== at) {
      return press;
    }
    return delivery.delivered
      ? {
          ...press,
          ran: true,
          failed: false,
          reason: '',
          ...(delivery.turnId === undefined ? {} : { turnId: delivery.turnId }),
        }
      : { ...press, ran: false, failed: true, reason: delivery.reason };
  });
}

// Move the accepted press when its prompt lands in a continuation session.
// Completed responses in both sessions retain their recorded replacement requirement.
export function pressesAfterSessionHandoff(
  source: readonly LivePress[],
  target: readonly LivePress[],
  at: number,
  delivery: PromptDelivery,
): { source: LivePress[]; target: LivePress[] } {
  const settled = pressesAfterHandoff(source, at, delivery);
  const moved = settled.find((press) => press.at === at);
  if (!delivery.delivered || !delivery.session || !moved) {
    return { source: settled, target: [...target] };
  }
  return {
    source: settled.filter((press) => press.at !== at),
    target: pressesAfter(target, { ...moved, sessionId: delivery.session }),
  };
}

// The unfinished press of one kind that still accepts live updates.
export function pressOfKind(held: readonly LivePress[], kind: LiveKind): LivePress | null {
  return held.find((one) => one.kind === kind && !one.completed) ?? null;
}

// The newest submission that has neither failed nor completed receives the reply.
export function pressForReply(held: readonly LivePress[]): LivePress | null {
  for (let i = held.length - 1; i >= 0; i--) {
    if (!held[i].failed && !held[i].completed) {
      return held[i];
    }
  }
  return null;
}

// The expiry interval for an idle session-control card.
export const LIVE_PRESS_LIMIT_MS = 5 * 60_000;

// Whether the selected accepted window contains the turn that replaces this prompt card.
// A catalog fact or a retained window from another session cannot answer this question.
export function selectedWindowContainsRecordedTurn(
  selectedSession: string | null,
  press: Pick<LivePress, 'kind' | 'sessionId' | 'at' | 'text'>,
  newestTurn: Pick<Turn, 'sessionId' | 'startedAt' | 'laterPrompts'> | null,
): boolean {
  if (press.kind !== 'prompt' || selectedSession !== press.sessionId || newestTurn?.sessionId !== press.sessionId) {
    return false;
  }
  return (
    newestTurn.startedAt >= press.at ||
    newestTurn.laterPrompts.some((prompt) => prompt.text === press.text && prompt.at >= press.at)
  );
}

// Failed deliveries retain their notices. Prompts end after a local CLI answer or an accepted recorded replacement. Session controls also expire when idle.
export function livePressOver(
  press: LivePress,
  transcriptAt: number | null,
  running: boolean,
  now: number,
  acceptedRecordedTurn: boolean,
  localAnswer = false,
): boolean {
  if (press.failed) {
    return false;
  }
  if (localAnswer) {
    return true;
  }
  if (press.kind === 'prompt') {
    return acceptedRecordedTurn;
  }
  if (transcriptAt !== null && transcriptAt >= press.at) {
    return true;
  }
  // Started work ends when the session stops running. Acceptance alone does not establish that work started.
  if (press.started && !running) {
    return true;
  }
  // Running session controls retain their cards past the expiry interval.
  if (running) {
    return false;
  }
  return now - press.at >= LIVE_PRESS_LIMIT_MS;
}

// The interval for batching streamed reply updates across the webview message channel.
export const LIVE_REPLY_POST_MS = 125;

// Keep every chunk until the recorded turn replaces the temporary card.
export function appendReply(reply: string, chunk: string): string {
  return reply + chunk;
}

// Remove a completed commentary message from the reply suffix. The Activity list displays that message separately.
export function replyAfterCommentary(reply: string, commentary: string): string {
  if (!reply || !commentary) {
    return reply;
  }
  return reply.endsWith(commentary) ? reply.slice(0, -commentary.length) : reply;
}

// Delivery failure and completion take priority. Session activity or a nonempty reply marks an unfinished submission as running.
export function liveState(press: LivePress, running: boolean): LiveState {
  if (press.failed) {
    return 'failed';
  }
  if (press.completed)
    return press.outcome === 'error' ? 'failed' : press.outcome === 'interrupted' ? 'interrupted' : 'done';
  return running || press.reply !== '' ? 'running' : 'sent';
}

// Failed prompts offer Restore and Dismiss. Failed session controls offer only Dismiss.
const LIVE_RESTORE = 'Restore';
const LIVE_DISMISS = 'Dismiss';

// The live-card status line, using the agent's display name.
function liveStatus(kind: LiveKind, state: LiveState, name: string, waiting: boolean): string {
  // An accepted prompt waiting behind other work is not yet running.
  if (waiting) {
    return `${name} has this and is finishing something else first`;
  }
  if (kind === 'compact') {
    // A failed compaction uses the same status whether failure occurred before or after work started.
    if (state === 'failed') {
      return `${name} did not compact this session`;
    }
    if (state === 'running') {
      return `${name} is compacting this session`;
    }
    return `Asking ${name} to compact this session`;
  }
  if (kind === 'clear') {
    if (state === 'failed') {
      return `${name} did not clear this session`;
    }
    if (state === 'running') {
      return `${name} is clearing this session`;
    }
    return `Asking ${name} to clear this session`;
  }
  if (state === 'failed') {
    return `This prompt did not reach ${name}`;
  }
  if (state === 'done') return `${name} answered this prompt`;
  if (state === 'interrupted') return `${name} stopped before finishing this response`;
  if (state === 'running') {
    return `${name} is working on this`;
  }
  return `Sending this to ${name}`;
}

// Build a temporary timeline card from the submission, current settings, and response state.
function liveCard(state: ComposerState, press: LivePress, name: string, now: number): ComposerLive | null {
  // Mid-turn prompts use the running turn's card. Failed deliveries retain a separate notice.
  if (press.midTurn && !press.failed) {
    return null;
  }
  const which = liveState(press, state.running);
  // A prompt waits when the session runs but it has neither started nor received reply text.
  const waiting = press.kind === 'prompt' && which === 'running' && !press.started && press.reply === '';
  const said =
    press.outcome === 'error' ? `${name} did not finish this response` : liveStatus(press.kind, which, name, waiting);
  const failed = press.failed;
  const tone = which === 'sent' ? 'running' : which;
  // Prefer the selected model, then the confirmed model. Without either, leave the model label empty.
  const model = shortModel(state.settings.selectedModel || state.settings.confirmedModel) ?? '';
  const relative = formatRelative(press.at, now);
  // Session controls have no prompt headline.
  const compaction = press.kind === 'compact' || press.kind === 'clear';
  return {
    kind: press.kind,
    state: which,
    // Use the live state as the card tone, with sent submissions shown as running.
    tone,
    status: said,
    relative,
    absolute: formatWhen(press.at, now),
    at: press.at,
    agent: name,
    model,
    label: headLabel('Turn', [STATUS_WORDS[tone], relative, [name, model].filter(Boolean).join(' ') || null], said),
    // Use the prompt's first line as the headline. Session controls leave it empty.
    headline: compaction ? '' : firstLine(press.text),
    reply: press.reply,
    // Terminal responses and failed deliveries have no running duration.
    since: failed || press.completed ? null : press.at,
    dismissLabel: failed ? LIVE_DISMISS : '',
    dismissName: failed
      ? `${compaction ? 'Take this notice away' : 'Discard this prompt and take this notice away'}. ${said}.`
      : '',
    // Include the submission kind in the dismissal control to distinguish simultaneous notices.
    dismissControl: failed ? `dismissLive:${press.kind}` : '',
    restoreLabel: failed && !compaction ? LIVE_RESTORE : '',
    restoreName:
      failed && !compaction
        ? `Restore this prompt to the prompt box. ${said}.${press.reason ? ` ${press.reason}` : ''}`
        : '',
    restoreControl: failed && !compaction ? `restoreLive:${press.kind}` : '',
    reason: failed ? press.reason : '',
    files: (press.assets ?? []).map((asset) => {
      const {
        removeLabel: _removeLabel,
        removeName: _removeName,
        removeControl: _removeControl,
        ...file
      } = composerFile(asset, asset.mime.startsWith('image/') ? (state.assetPreviews?.[asset.id] ?? null) : null);
      return file;
    }),
  };
}

// Draw visible temporary cards newest first. Different submission kinds retain separate cards.
function liveCards(state: ComposerState, name: string, now: number): ComposerLive[] {
  const cards: ComposerLive[] = [];
  for (const press of state.live) {
    const card = liveCard(state, press, name, now);
    if (card) {
      cards.unshift(card);
    }
  }
  return cards;
}

// The Send control names queued prompts when a Codex session control delays submission. A Remote Control command names the toggle. Otherwise, the control identifies comments and attached files when the prompt text field is empty.
function sendName(state: ComposerState, name: string, enabled: boolean): string {
  const compacting =
    state.agent === 'codex' &&
    state.live.some((press) => (press.kind === 'compact' || press.kind === 'clear') && !press.failed);
  // A Codex `/rename` runs at once beside the session control, so it waits in no queue.
  if (compacting && enabled && renameRequest(state.agent, state.onScreen) === null) {
    return `Queue this prompt for ${name}. Arc will send it after the session control. ${SEND_HINT}.`;
  }
  if (remoteControlRequest(state.agent, state.onScreen) === 'toggle') {
    return `Turn Claude Remote Control on or off for ${name}. ${SEND_HINT}.`;
  }
  const comments = state.onScreen.trim() ? 0 : commentsForActiveSubmission(state).length;
  const files = state.onScreen.trim() ? 0 : (state.assets?.length ?? 0);
  if (comments || files) {
    const parts = [];
    if (files) {
      parts.push(files === 1 ? '1 attached file' : `${files} attached files`);
    }
    if (comments) {
      parts.push(comments === 1 ? '1 comment' : `${comments} comments`);
    }
    return `Send ${parts.join(' and ')} to ${name}, with nothing typed in the box. ${SEND_HINT}.`;
  }
  return `Send this prompt to ${name}. ${SEND_HINT}.${enabled ? '' : ' Nothing has been typed to send yet.'}`;
}

// Share the Send or Stop decision between the control and its request-answer explanation.
function sendState(state: ComposerState): { stopping: boolean; enabled: boolean } {
  // Stop requires a running session, an empty prompt text field, and no attachments. Comments alone retain Stop.
  const stopping = state.running && !state.onScreen.trim() && !(state.assets?.length ?? 0);
  // Stop stays enabled. Send is enabled when sendAction accepts the submission.
  return { stopping, enabled: stopping || sendAction(state) !== 'nothing' };
}

// Explain how Send answers pending requests. Stop and disabled Send provide no request-answer explanation.
function sendOverAskLine(state: ComposerState): string {
  const waiting = (state.asks ?? []).length;
  if (!waiting) {
    return '';
  }
  const { stopping, enabled } = sendState(state);
  if (stopping || !enabled) {
    return '';
  }
  // Panel commands, Codex rename requests, and Remote Control toggles do not answer pending requests.
  if (
    panelCommand(state.onScreen) ||
    renameRequest(state.agent, state.onScreen) !== null ||
    remoteControlRequest(state.agent, state.onScreen) !== null
  ) {
    return '';
  }
  const subject = waiting === 1 ? 'the request above' : `the ${waiting} requests above`;
  // Compaction answers pending requests without sending a prompt.
  if (compactSubmission(state.agent, state.onScreen)) {
    return `Send answers ${subject} before it compacts.`;
  }
  if (clearSubmission(state.agent, state.onScreen)) {
    return `Send answers ${subject} before it clears the session.`;
  }
  return `Send answers ${subject} with this prompt.`;
}

// Build the prompt box's labels and Send or Stop control.
function composerBox(state: ComposerState, name: string): ComposerBox {
  const running = state.running;
  const { stopping, enabled } = sendState(state);
  // Include the request-answer explanation in the Send control's accessible name.
  const overAsk = sendOverAskLine(state);
  return {
    placeholder: placeholderFor(
      state.agent,
      name,
      running,
      availableCommands(state.commands).length > 0,
      state.commands.some((entry) => entry.kind === 'skill'),
    ),
    dropPlaceholder: 'Drop to attach',
    hint: SEND_HINT,
    heightName: CARD_ACTIONS.composerHeight,
    heightHint: 'Resize prompt box',
    heightHintDetail: 'Drag, or press Up and Down. Home and End go to the smallest and the largest.',
    actionLabel: stopping ? STOP_LABEL : SEND_LABEL,
    actionName: stopping
      ? `Stop the turn ${name} is running.`
      : `${sendName(state, name, enabled)}${overAsk ? ` ${overAsk}` : ''}`,
    actionControl: stopping ? 'stop' : 'send',
    actionKind: stopping ? 'stop' : 'send',
    actionEnabled: enabled,
  };
}

// Identify draft setup controls as applying to a session that has not started.
const DRAFT_SCOPE = ', for this draft.';

// Any submission without a delivery failure marks the draft as starting and disables setup changes.
export function draftStarted(presses: readonly LivePress[]): boolean {
  return presses.some((press) => !press.failed);
}

// Explain why setup controls are disabled after draft submission.
const DRAFT_STARTING = 'It is starting and its setup cannot change now.';

// Build the draft's agent, model, effort, and permission controls from its profile.
function draftProfilePicks(state: ComposerState, profile: SessionProfile): ComposerPick[] {
  const name = agentName(profile.agent);
  const model = selectedModelPick(state.models, profile.model, state.defaults);
  const effort = model?.efforts.find((one) => one.value === profile.effort);
  const mode = profileAskMode(profile.agent, profile.permissionMode);
  const agents = draftAgentMenu(state, profile);
  const models = draftModelMenu(state, profile, name);
  const efforts = draftEffortMenu(state, profile, name);
  const modes = askModeMenu(profile.agent, profile.permissionMode, state.sessionId);
  // Use shared profile labels so draft controls and setup summaries use the same fallbacks.
  const [, modelLabel, effortLabel] = profileFacts(profile, state.models, state.defaults);
  // Disable empty menus and all setup controls while the draft starts.
  const noModel = models.items.length === 0;
  const noEffort = efforts.items.length === 0;
  const starting = draftStarted(state.live);
  // The starting explanation takes priority over an empty-menu reason or action offer.
  const nameEnding = (offer: string, empty: string): string => {
    if (starting) {
      return DRAFT_STARTING;
    }
    return empty || offer;
  };
  // Distinguish a resolved model with no effort setting from an unresolved effort default.
  const applied = defaultsForModel(state.models, profile.model, state.defaults);
  const noEffortToSet =
    noEffort &&
    !!resolvedChoice(state.models, profile.model, state.defaults) &&
    (!applied || (applied.status === 'ready' && !applied.effortStatus && applied.effort === null));
  return [
    {
      control: 'agent',
      label: name,
      name: `Agent: ${name}${DRAFT_SCOPE} ${nameEnding('Press to start it with another agent.', agents.empty)}`,
      detail: 'Which agent this draft will start',
      disabled: starting || agents.items.length === 0,
      caution: false,
    },
    {
      control: 'model',
      label: modelLabel,
      name: `Model: ${modelLabel}${DRAFT_SCOPE} ${nameEnding('Press to start it on another model.', models.empty)}`,
      detail: state.defaults?.base?.reason || model?.description || `Which model ${name} runs this draft on`,
      disabled: starting || noModel,
      caution: false,
    },
    {
      control: 'effort',
      // Display an explicit label when the model has no effort setting.
      label: noEffortToSet ? NO_EFFORT_LABEL : effortLabel,
      name: `Effort: ${noEffortToSet ? 'none to set' : effortLabel}${DRAFT_SCOPE} ${nameEnding('Press to start it at another effort.', efforts.empty)}`,
      detail: noEffort
        ? defaultsForModel(state.models, profile.model, state.defaults)?.reason || efforts.empty
        : effort?.description || `How much ${model?.readingLabel ?? 'the model'} works on a turn`,
      disabled: starting || noEffort,
      caution: false,
    },
    {
      control: 'askmode',
      label: mode.label,
      // Include the permission menu heading, selected mode, and mode description in the accessible name.
      name: `${modes.head} ${mode.label}${DRAFT_SCOPE}${mode.description ? ` ${sentence(mode.description)}` : ''} ${nameEnding('Press to change it.', modes.empty)}`,
      detail: mode.description || modes.head,
      disabled: starting || modes.items.length === 0,
      caution: false,
    },
  ];
}

const DRAFT_TAG_WORD = 'New draft';

// The draft tag's tooltip lists all four setup values.
function draftTag(state: ComposerState, profile: SessionProfile): ComposerDraftTag {
  return {
    word: DRAFT_TAG_WORD,
    detail: profileFacts(profile, state.models, state.defaults).join(PROFILE_FACT_SEPARATOR),
  };
}

// Return no prompt box view when state or the session name is absent.
export function composerView(state: ComposerState | null, now: number = Date.now()): ComposerView | null {
  if (!state) {
    return null;
  }
  const session = state.session.trim();
  if (!session) {
    return null;
  }
  const name = agentName(state.agent);
  const picks = state.profile
    ? draftProfilePicks(state, state.profile)
    : [modelPick(state, name), effortPick(state, name), askModePick(state)];
  // Append the MCP control after the setup controls when server state is available.
  const servers = mcpControl(state, state.profile ? agentName(state.profile.agent) : name);
  if (servers) {
    picks.push(servers);
  }
  return {
    agent: state.agent,
    sessionId: state.sessionId,
    ...(state.profile ? { recoverySetup: state.profile } : {}),
    draft: state.draft,
    targetName: `The prompt goes to ${session}, a ${name} session`,
    origin: state.origin
      ? {
          sessionId: state.origin.sessionId,
          turnKey: state.origin.turnKey,
          label: 'From selected turn',
          name: 'Show the session where this draft began',
        }
      : null,
    draftTag: state.profile ? draftTag(state, state.profile) : null,
    // Drafts display no context figure from their source session.
    context: state.profile
      ? null
      : (() => {
          const figure = contextFigure(state.context, state.agent, name);
          return figure ? { ...figure, generation: state.contextGeneration ?? 0 } : null;
        })(),
    // Drafts display no next-turn estimate from their source session.
    nextTurn: state.profile ? null : nextTurnFigure(prospectiveNextTurn(state)),
    picks,
    commands: promptEntries(state.agent, availableCommands(state.commands)),
    claudeSkills: state.claudeSkills,
    completionName: `Completions available for ${name}`,
    box: composerBox(state, name),
    annotations: annotationChip(state),
    files: composerFiles(state),
    notice: state.notice ?? null,
    filePendingName: 'Files are still being attached. Wait before sending this prompt.',
    queue: state.queued
      .filter((entry) => !state.queueHandoffs?.has(entry.id))
      .filter(
        (entry) =>
          !(
            clearSubmission(state.agent, entry.text) &&
            !entry.assets.length &&
            !entry.commentIds.length &&
            entry.delivery.phase === 'queued' &&
            !entry.reason
          ),
      )
      .filter((entry) => entry.text.trim() || entry.assets.length || entry.commentIds.length)
      .map((entry) => queuedPrompt(state, entry, name, now)),
    history: [...state.history],
    live: liveCards(state, name, now),
    asks: (state.asks ?? []).map((ask) => askCard(ask, name)),
    sendOverAsk: sendOverAskLine(state),
  };
}

// A picker choice carries its displayed text and the answer returned when selected.
export interface Choice {
  label: string;
  detail: string;
  answer: AskAnswer;
}

export interface AskPrompt {
  title: string;
  placeholder: string;
  choices: Choice[];
  // Identify refusal by its answer rather than a label that also appears among offered choices.
  decline: Choice | null;
  // The question index for a question request, or null for permission requests.
  questionIndex: number | null;
  multiSelect: boolean;
}

// The program to launch and arguments preceding the agent's own flags. Package scripts run under Node.
export interface Launch {
  command: string;
  leadingArgs: string[];
  // A launch problem to display to the reader, or null.
  problem: string | null;
  // Environment values required by the launch, added to the child's environment.
  env: Record<string, string>;
}

// Machine paths and filesystem checks used to select an agent launch.
export interface Machine {
  homeDir: string;
  appData: string;
  pathEnv: string;
  // The installed official Anthropic extension directory, supplied by the editor host.
  claudeExtensionDir: string;
  // The installed official OpenAI extension directory, supplied by the editor host.
  codexExtensionDir: string;
  platform: string;
  // The process architecture used to select a platform package and binary directory.
  arch: string;
  // The Node that runs a package script. In the extension host this is VS Code's own
  // binary, which runs as Node when `ELECTRON_RUN_AS_NODE` is set.
  node: string;
  exists(path: string): boolean;
  canExecute(path: string): boolean;
}

function join(platform: string, parts: string[]): string {
  return parts.join(platform === 'win32' ? '\\' : '/');
}

// Find a package script under Windows' AppData npm directory. Other platforms return null because global package locations vary.
export function npmPackageScript(machine: Machine, parts: string[]): string | null {
  if (machine.platform !== 'win32') {
    return null;
  }
  const script = join(machine.platform, [machine.appData, 'npm', 'node_modules', ...parts]);
  return machine.exists(script) ? script : null;
}

// Resolve Windows batch shims to a package script launched under Node. Batch files cannot be spawned directly without a shell.
function throughNode(machine: Machine, path: string, parts: string[]): Launch | null {
  const lower = path.toLowerCase();
  if (machine.platform !== 'win32') {
    return null;
  }
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return null;
  }
  const separator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const directory = separator < 0 ? '' : path.slice(0, separator);
  const script = directory ? join(machine.platform, [directory, 'node_modules', ...parts]) : '';
  if (script && machine.exists(script)) {
    const native = parts === CODEX_PACKAGE ? codexBinary(machine, directory) : null;
    if (native) return native;
    return { command: machine.node, leadingArgs: [script], problem: null, env: {} };
  }
  return {
    command: path,
    leadingArgs: [],
    problem:
      `${path} is a batch shim, which cannot be started directly, and the package it ` +
      'points at was not found. Set the path to the real executable.',
    env: {},
  };
}

const CLAUDE_PACKAGE = ['@anthropic-ai', 'claude-code', 'cli.js'];
const CODEX_ROOT = ['@openai', 'codex'];
const CODEX_PACKAGE = [...CODEX_ROOT, 'bin', 'codex.js'];

// The supported Windows Codex package names and binary directory triples, keyed by architecture.
const CODEX_BUILDS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  arm64: { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

// Prefer the Windows npm package's native Codex binary to avoid a console window from its JavaScript launcher. Supply its package environment directly.
function codexBinary(machine: Machine, npmBin = join(machine.platform, [machine.appData, 'npm'])): Launch | null {
  if (machine.platform !== 'win32') {
    return null;
  }
  const build = own(CODEX_BUILDS, machine.arch);
  if (!build) {
    return null;
  }
  const packageRoot = join(machine.platform, [npmBin, 'node_modules', ...CODEX_ROOT]);
  const binary = join(machine.platform, [
    packageRoot,
    'node_modules',
    '@openai',
    build.pkg,
    'vendor',
    build.triple,
    'bin',
    'codex.exe',
  ]);
  if (!machine.exists(binary)) {
    return null;
  }
  return {
    command: binary,
    leadingArgs: [],
    problem: null,
    // Preserve the package-root and npm-install environment values normally supplied by the launcher.
    env: {
      CODEX_MANAGED_PACKAGE_ROOT: packageRoot,
      CODEX_MANAGED_BY_NPM: '1',
    },
  };
}

// A Windows npm command is a batch shim, so run the matching package without a shell.
// Other executable entries on PATH can be started at their resolved path.
function pathLaunch(machine: Machine, agent: 'claude' | 'codex'): Launch | null {
  const separator = machine.platform === 'win32' ? ';' : ':';
  for (const raw of machine.pathEnv.split(separator)) {
    const entry = raw.trim().replace(/^"|"$/g, '');
    const dir = entry === '/' ? '/' : entry.replace(/[\\/]+$/, '');
    if (!dir) {
      continue;
    }
    if (machine.platform !== 'win32') {
      if (!dir.startsWith('/')) {
        continue;
      }
      const command = dir === '/' ? `/${agent}` : join(machine.platform, [dir, agent]);
      if (machine.canExecute(command)) {
        return { command, leadingArgs: [], problem: null, env: {} };
      }
      continue;
    }
    for (const extension of ['.com', '.exe']) {
      const command = join(machine.platform, [dir, `${agent}${extension}`]);
      if (machine.canExecute(command)) {
        return { command, leadingArgs: [], problem: null, env: {} };
      }
    }
    if (
      !machine.exists(join(machine.platform, [dir, `${agent}.cmd`])) &&
      !machine.exists(join(machine.platform, [dir, `${agent}.bat`]))
    ) {
      continue;
    }
    if (agent === 'codex') {
      const binary = codexBinary(machine, dir);
      if (binary) {
        return binary;
      }
    }
    const parts = agent === 'codex' ? CODEX_PACKAGE : CLAUDE_PACKAGE;
    const script = join(machine.platform, [dir, 'node_modules', ...parts]);
    if (machine.exists(script)) {
      return { command: machine.node, leadingArgs: [script], problem: null, env: {} };
    }
  }
  return null;
}

// Find the Codex binary inside the official extension directory. Select its platform and architecture subdirectory, returning null if unsupported or absent.
function extensionCodexBinary(machine: Machine): Launch | null {
  if (!machine.codexExtensionDir) {
    return null;
  }
  const platform =
    machine.platform === 'win32'
      ? 'windows'
      : machine.platform === 'darwin'
        ? 'macos'
        : machine.platform === 'linux'
          ? 'linux'
          : '';
  const arch = machine.arch === 'x64' ? 'x86_64' : machine.arch === 'arm64' ? 'aarch64' : '';
  if (!platform || !arch) {
    return null;
  }
  const executable = machine.platform === 'win32' ? 'codex.exe' : 'codex';
  const binary = join(machine.platform, [machine.codexExtensionDir, 'bin', `${platform}-${arch}`, executable]);
  return machine.exists(binary) ? { command: binary, leadingArgs: [], problem: null, env: {} } : null;
}

// Find the Claude binary inside the official extension directory, including Linux musl and Windows ARM64 fallback paths.
function extensionClaudeBinary(machine: Machine): Launch | null {
  if (!machine.claudeExtensionDir) {
    return null;
  }
  const executable = machine.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [
    join(machine.platform, [
      machine.claudeExtensionDir,
      'resources',
      'native-binaries',
      `${machine.platform}-${machine.arch}`,
      executable,
    ]),
  ];
  if (machine.platform === 'linux') {
    candidates.push(
      join(machine.platform, [
        machine.claudeExtensionDir,
        'resources',
        'native-binaries',
        `linux-${machine.arch}-musl`,
        executable,
      ]),
    );
  }
  if (machine.platform === 'win32' && machine.arch === 'arm64') {
    candidates.push(
      join(machine.platform, [machine.claudeExtensionDir, 'resources', 'native-binaries', 'win32-x64', executable]),
    );
  }
  candidates.push(join(machine.platform, [machine.claudeExtensionDir, 'resources', 'native-binary', executable]));
  const binary = candidates.find((candidate) => machine.exists(candidate));
  return binary ? { command: binary, leadingArgs: [], problem: null, env: {} } : null;
}

// How to start Claude Code. The reader's setting wins, then the command on PATH, then
// the official extension's program and standard standalone installs.
export function claudeLaunch(configured: string, machine: Machine): Launch {
  const set = configured.trim();
  if (set) {
    return throughNode(machine, set, CLAUDE_PACKAGE) ?? { command: set, leadingArgs: [], problem: null, env: {} };
  }

  const onPath = pathLaunch(machine, 'claude');
  if (onPath) {
    return onPath;
  }

  const extension = extensionClaudeBinary(machine);
  if (extension) {
    return extension;
  }

  const native = join(machine.platform, [
    machine.homeDir,
    '.local',
    'bin',
    machine.platform === 'win32' ? 'claude.exe' : 'claude',
  ]);
  if (machine.exists(native)) {
    return { command: native, leadingArgs: [], problem: null, env: {} };
  }

  const script = npmPackageScript(machine, CLAUDE_PACKAGE);
  if (script) {
    return { command: machine.node, leadingArgs: [script], problem: null, env: {} };
  }

  return { command: 'claude', leadingArgs: [], problem: null, env: {} };
}

// How to start the Codex app-server. The reader's setting wins, then the command on PATH,
// then the official extension's program and standalone installs.
export function codexLaunch(configured: string, machine: Machine): Launch {
  const set = configured.trim();
  if (set) {
    return throughNode(machine, set, CODEX_PACKAGE) ?? { command: set, leadingArgs: [], problem: null, env: {} };
  }

  const onPath = pathLaunch(machine, 'codex');
  if (onPath) {
    return onPath;
  }

  const extension = extensionCodexBinary(machine);
  if (extension) {
    return extension;
  }

  const binary = codexBinary(machine);
  if (binary) {
    return binary;
  }

  const script = npmPackageScript(machine, CODEX_PACKAGE);
  if (script) {
    return { command: machine.node, leadingArgs: [script], problem: null, env: {} };
  }

  return { command: 'codex', leadingArgs: [], problem: null, env: {} };
}

// Key running work by agent and the child's recorded session id, independent of the launch key.
export function runningKey(agent: string, session: string): string {
  return `${agent}:${session}`;
}

// Check running state for the specified agent and session.
export function sessionRunning(running: readonly string[], agent: string, session: string): boolean {
  return running.includes(runningKey(agent, session));
}

// Return listed session ids with matching running keys. Use agentKey rather than the agent's display name.
export function runningSessions(
  rows: readonly { id: string; agentKey: string }[],
  running: readonly string[],
): Set<string> {
  return new Set(rows.filter((row) => sessionRunning(running, row.agentKey, row.id)).map((row) => row.id));
}

// Map listed sessions to start times using their agentKey and session id.
export function runningSessionsSince(
  rows: readonly { id: string; agentKey: string }[],
  since: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const at = since.get(runningKey(row.agentKey, row.id));
    if (at !== undefined) {
      out.set(row.id, at);
    }
  }
  return out;
}

// Return busy, non-exited children matching the agent and recorded session id.
export function busyInSession<T extends { agent: string; sessionId: string | null; busy: boolean; exited: boolean }>(
  states: readonly T[],
  agent: string,
  session: string,
): T[] {
  return states.filter((s) => s.busy && !s.exited && s.agent === agent && s.sessionId === session);
}

// Offer Claude Code before Codex in the agent picker.
export function agentChoices(): { agent: 'claude' | 'codex'; label: string; detail: string }[] {
  return [
    { agent: 'claude', label: 'Claude Code', detail: 'Asks before it runs a tool, and answers its own questions here' },
    { agent: 'codex', label: 'Codex', detail: 'Asks before it runs a command or changes a file' },
  ];
}

// Build permission choices or the indexed question's choices and refusal action.
export function askPrompt(ask: Ask, questionIndex = 0): AskPrompt {
  if (ask.kind === 'permission') {
    const presentation = activityDetail(ask.toolName, ask.input);
    const detail = presentation.exact;
    return {
      title: `${ask.displayName} wants to run`,
      placeholder:
        detail || ask.description || (presentation.policy === 'required' ? 'Details unavailable' : 'Allow this?'),
      choices: [
        { label: 'Allow', detail: 'Let the agent run this once', answer: { decision: 'allow' } },
        {
          label: 'Deny',
          detail: 'The agent is told this was refused and carries on',
          answer: REFUSED_ASK,
        },
      ],
      decline: null,
      questionIndex: null,
      multiSelect: false,
    };
  }

  const question = ask.questions[questionIndex];
  if (!question) {
    return {
      title: 'The agent asked a question',
      placeholder: '',
      choices: [],
      decline: { label: 'Decline', detail: 'The agent is told this was refused and carries on', answer: REFUSED_ASK },
      questionIndex,
      multiSelect: false,
    };
  }
  return {
    title: question.question,
    placeholder: question.header || 'Pick an answer',
    choices: question.options.map((option) => ({
      label: option.label,
      detail: option.description,
      // Each option carries only its question's selected label. Completed answers combine all questions.
      answer: { decision: 'answer', answers: { [question.id]: { labels: [option.label], written: '' } } },
    })),
    decline: { label: 'Decline', detail: 'The agent is told this was refused and carries on', answer: REFUSED_ASK },
    questionIndex,
    multiSelect: question.multiSelect,
  };
}

// Combine selected labels or written answers for every question in request order. Incomplete answers return null.
export function questionAnswer(ask: Ask, picked: string[][], written: string[] = []): AskAnswer | null {
  if (ask.kind !== 'question') {
    return null;
  }
  const ids = ask.questions.map((question) => question.id);
  return completedQuestionAnswer(
    ids,
    Object.fromEntries(ids.map((id, index) => [id, picked[index] ?? []])),
    Object.fromEntries(ids.map((id, index) => [id, written[index]])),
  );
}

// The request status while the host processes a submitted answer.
const ASK_SENDING = 'sending your answer';

// Explain whether a question accepts one choice or multiple choices.
const ASK_CHOOSE_ONE = 'Choose one.';
const ASK_CHOOSE_ANY = 'Choose any that apply.';

// The panel adds Other after the agent's offered choices for a written answer.
const ASK_WRITTEN_LABEL = 'Other';
const ASK_WRITTEN_DETAIL = 'Answer in your own words';
const ASK_WRITTEN_PLACEHOLDER = 'Type your answer';

// Accessible instructions for expanding and collapsing a request.
const ASK_HIDE_PRESS = 'Press to hide it.';
const ASK_SHOW_PRESS = 'Press to show it.';

// Prepared Markdown for one question and its choices.
type RenderedQuestion = Pick<AskCardQuestion, 'legendHtml' | 'legendText'> & {
  headerText: string;
  choices: Pick<AskCardChoice, 'labelHtml' | 'detailHtml' | 'name'>[];
};
const questionMarkdownCache = new Map<string, { questions: RenderedQuestion[]; bytes: number }>();
let questionMarkdownBytes = 0;

function renderedQuestions(ask: Extract<Ask, { kind: 'question' }>): RenderedQuestion[] {
  const content = ask.questions.map((question) => [
    question.question,
    question.header,
    ...question.options.flatMap((option) => [option.label, option.description]),
  ]);
  const oversized =
    content.reduce((total, pieces) => total + pieces.reduce((bytes, piece) => bytes + Buffer.byteLength(piece), 0), 0) >
    64 * 1024;
  const key = oversized ? '' : JSON.stringify(content);
  const held = questionMarkdownCache.get(key);
  if (held) {
    questionMarkdownCache.delete(key);
    questionMarkdownCache.set(key, held);
    return held.questions;
  }
  const inline = oversized ? escapeHtml : renderInlineMarkdown;
  const plain = (html: string) => visibleTextOf(html).replace(/\s+/g, ' ').trim();
  const questions = ask.questions.map((question) => {
    const legendHtml = oversized
      ? `<pre>${escapeHtml(question.question)}</pre>`
      : renderRichMarkdown(question.question);
    return {
      legendHtml,
      legendText: oversized ? question.question : plain(legendHtml),
      headerText: oversized ? question.header : plain(inline(question.header)),
      choices: question.options.map((option) => {
        const labelHtml = inline(option.label);
        const detailHtml = inline(option.description);
        return {
          labelHtml,
          detailHtml,
          name: option.description ? `${plain(labelHtml)}. ${plain(detailHtml)}` : plain(labelHtml),
        };
      }),
    };
  });
  if (!oversized) {
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(questions));
    if (bytes <= 1024 * 1024) {
      while (questionMarkdownCache.size >= 16 || questionMarkdownBytes + bytes > 1024 * 1024) {
        const oldest = questionMarkdownCache.keys().next().value!;
        questionMarkdownBytes -= questionMarkdownCache.get(oldest)!.bytes;
        questionMarkdownCache.delete(oldest);
      }
      questionMarkdownCache.set(key, { questions, bytes });
      questionMarkdownBytes += bytes;
    }
  }
  return questions;
}

export function askCard(ask: Ask, agent: string): AskCard {
  if (ask.kind === 'permission') {
    const prompt = askPrompt(ask);
    const detail = prompt.placeholder;
    const presentation = activityDetail(ask.toolName, ask.input);
    return {
      id: ask.id,
      kind: ask.kind,
      title: prompt.title,
      detail,
      detailFormat: presentation.format === 'command' && presentation.exact === detail ? 'code' : 'prose',
      name: `${agent} is waiting for you. ${prompt.title}${detail ? `. ${detail}` : ''}`,
      questions: [],
      actions: prompt.choices.map((choice) => ({
        label: choice.label,
        name: `${choice.label}: ${prompt.title}`,
        answer: choice.answer,
      })),
      answerLabel: '',
      answerName: '',
      incompleteName: '',
      nextLabel: '',
      nextName: '',
      // Permission requests have no question progress indicators.
      steps: [],
      answeredWords: [],
      openName: `${prompt.title}. ${ASK_SHOW_PRESS}`,
      shutName: `${prompt.title}. ${ASK_HIDE_PRESS}`,
      stateWord: NEEDS_INPUT,
      sendingWord: ASK_SENDING,
    };
  }

  const count = ask.questions.length;
  const rendered = renderedQuestions(ask);
  const subject = count === 1 ? 'a question' : `${count} questions`;
  const title = `${agent} asked ${subject}`;
  return {
    id: ask.id,
    kind: ask.kind,
    title,
    // The request state supplies the waiting message.
    detail: ask.recovery?.detail ?? '',
    detailFormat: 'prose',
    name: ask.recovery ? `${title}. ${ask.recovery.detail}` : `${agent} is waiting for you with ${subject}.`,
    answerBlocked: ask.recovery?.blocked ?? false,
    questions: ask.questions.map((question, index) => {
      // Use the supplied short label, or the question number when it is absent.
      const formatted = rendered[index];
      const spoken = formatted.headerText || `Question ${index + 1}`;
      return {
        id: question.id,
        legend: question.question,
        legendHtml: formatted.legendHtml,
        legendText: formatted.legendText,
        key: formatted.headerText,
        hint: question.multiSelect ? ASK_CHOOSE_ANY : ASK_CHOOSE_ONE,
        multiSelect: question.multiSelect,
        secret: question.secret,
        choices: [
          ...question.options.map((option, optionIndex) => ({
            label: option.label,
            labelHtml: formatted.choices[optionIndex].labelHtml,
            detail: option.description,
            detailHtml: formatted.choices[optionIndex].detailHtml,
            name: formatted.choices[optionIndex].name,
            written: false,
          })),
          // Append the written-answer choice after the agent's offered choices.
          {
            label: ASK_WRITTEN_LABEL,
            labelHtml: escapeHtml(ASK_WRITTEN_LABEL),
            detail: ASK_WRITTEN_DETAIL,
            detailHtml: escapeHtml(ASK_WRITTEN_DETAIL),
            name: `${ASK_WRITTEN_LABEL}. ${ASK_WRITTEN_DETAIL}`,
            written: true,
          },
        ],
        tab: formatted.headerText || String(index + 1),
        tabName: `${spoken}, not answered`,
        tabAnsweredName: `${spoken}, answered`,
        writtenName: `Your own answer. ${formatted.legendText}`,
        writtenPlaceholder: ASK_WRITTEN_PLACEHOLDER,
      };
    }),
    // Decline lets the reader refuse a question request without filling its answers.
    actions: [{ label: 'Decline', name: 'Decline the agent question', answer: REFUSED_ASK }],
    answerLabel: 'Answer',
    answerName: count === 1 ? 'Answer the agent question' : `Answer all ${count} agent questions`,
    incompleteName: count === 1 ? 'Choose an answer first' : 'Answer every question first',
    nextLabel: 'Next',
    nextName: 'Go to the next question you have not answered. Nothing is sent yet.',
    steps: ask.questions.map((_, index) => `Question ${index + 1} of ${count}`),
    answeredWords: Array.from({ length: count + 1 }, (_, done) =>
      done === 0 ? (count === 1 ? 'No answer yet' : 'No answers yet') : `${done} of ${count} answered`,
    ),
    openName: `${title}. ${ASK_SHOW_PRESS}`,
    shutName: `${title}. ${ASK_HIDE_PRESS}`,
    stateWord: NEEDS_INPUT,
    sendingWord: ASK_SENDING,
  };
}

// Validate answers against the current request and restore question order before sending. Reject unknown labels, question ids, and incomplete answers.
export function acceptedAskAnswer(ask: Ask, candidate: unknown): AskAnswer | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const answer = candidate as Partial<AskAnswer> & { answers?: unknown; reason?: unknown };
  if (ask.kind === 'permission') {
    if (answer.decision === 'allow') {
      return { decision: 'allow' };
    }
    if (answer.decision === 'deny') {
      const denied = askPrompt(ask).choices.find((choice) => choice.answer.decision === 'deny');
      return panelDenial(answer.reason) ?? denied?.answer ?? null;
    }
    return null;
  }
  if (answer.decision === 'deny') {
    return panelDenial(answer.reason) ?? REFUSED_ASK;
  }
  if (answer.decision !== 'answer' || !answer.answers || typeof answer.answers !== 'object') {
    return null;
  }
  const sent = answer.answers as Record<string, unknown>;
  const picked: string[][] = [];
  const written: string[] = [];
  for (const question of ask.questions) {
    const value = sent[question.id];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const given = value as { labels?: unknown; written?: unknown };
    if (!Array.isArray(given.labels) || given.labels.some((one) => typeof one !== 'string')) {
      return null;
    }
    if (typeof given.written !== 'string') {
      return null;
    }
    const labels = given.labels as string[];
    // Accept a nonempty written answer only when no offered labels are selected.
    if (labels.length === 0) {
      if (!given.written.trim()) {
        return null;
      }
      picked.push([]);
      written.push(given.written);
      continue;
    }
    if (given.written.trim()) {
      return null;
    }
    if (!question.multiSelect && labels.length !== 1) {
      return null;
    }
    const offered = new Set(question.options.map((option) => option.label));
    if (new Set(labels).size !== labels.length || labels.some((label) => !offered.has(label))) {
      return null;
    }
    picked.push(labels);
    written.push('');
  }
  if (Object.keys(sent).some((id) => !ask.questions.some((question) => question.id === id))) {
    return null;
  }
  return questionAnswer(ask, picked, written);
}

// Match prompt-entry names with the shared browser-safe rule. Return the last host entry for each matched name. An empty query offers every distinct name.
export function matchCommands(commands: ComposerPromptEntry[], typed: string): ComposerPromptEntry[] {
  const byName = new Map(commands.map((command) => [command.name, command]));
  return matchCommandNames([...byName.keys()], typed)
    .map((name) => byName.get(name))
    .filter((command): command is ComposerPromptEntry => command !== undefined);
}

// The displayed text, accessible name, and completion for one prompt-entry menu row.
export interface PromptEntryView {
  kind: 'command' | 'skill';
  // The entry name without its prefix, used for matching and selection.
  command: string;
  prefix: '/' | '$';
  // The entry as the reader would type it.
  label: string;
  // The published argument hint, or an empty string.
  hint: string;
  // The agent's sentence about it, and empty where it gives none.
  description: string;
  // The skill definition returned by a catalog that publishes one. It is detail text only.
  path?: string;
  // The panel control that owns this command. Agent-owned entries omit it.
  panelControl?: string;
  // The accessible name includes the label, argument hint, and description in display order.
  name: string;
  // The replacement for the entry under the caret. A trailing space ends the completed name.
  completion: string;
}

export interface PathEntry {
  name: string;
  directory: boolean;
  label: string;
  accessibleName: string;
  completion: string;
}

export function pathEntries(
  entries: readonly { name: string; directory: boolean }[],
  prefix: string,
  separator: string,
): PathEntry[] {
  return entries.map((entry) => {
    const label = `${entry.name}${entry.directory ? separator : ''}`;
    return {
      name: entry.name,
      directory: entry.directory,
      label,
      accessibleName: `${entry.directory ? 'Directory' : 'File'} ${label}`,
      completion: `${prefix}${label}`,
    };
  });
}

// Commands handled by existing panel controls rather than sent to the agent. The MCP command opens the server list.
const PANEL_COMMANDS: Record<string, { control: string; description: string }> = {
  mcp: { control: 'mcp', description: 'View MCP server status' },
};

// Append missing panel commands to the agent catalog. Compare non-skill names without case to avoid duplicate commands.
export function availableCommands(commands: readonly ComposerPromptEntry[]): ComposerPromptEntry[] {
  const available = [...commands];
  const names = new Set(
    commands.filter((command) => command.kind !== 'skill').map((command) => command.name.toLowerCase()),
  );
  for (const [name, command] of Object.entries(PANEL_COMMANDS)) {
    if (!names.has(name)) {
      available.push({ kind: 'command', name, description: command.description, argumentHint: '' });
    }
  }
  return available;
}

// The reason a queued Remote Control command with arguments waits for the reader.
export const REMOTE_CONTROL_ARGUMENTS =
  'Send /remote-control or /rc by itself, with nothing after it. Edit or drop this prompt.';

// A Remote Control toggle's result, including the refusals the panel decides before it reaches a Claude process.
// `stopped` covers a session without a running Claude process in this window, including one that runs elsewhere.
export type RemoteControlOutcome =
  | RemoteControlResult
  | { outcome: 'arguments' }
  | { outcome: 'draft' }
  | { outcome: 'agentRun' }
  | { outcome: 'stopped' };

// The notification for a Remote Control result. The session link appears in the text.
// Arc opens no browser and leaves the clipboard unchanged.
export function remoteControlNotice(result: RemoteControlOutcome): { level: 'info' | 'warning'; text: string } {
  const again = 'Run /remote-control again to turn it off.';
  const reload =
    "To end the connection for certain, run Developer: Reload Window, which stops this window's Claude processes.";
  switch (result.outcome) {
    case 'connected':
      return {
        level: 'info',
        text: result.url
          ? `Arc: Claude Remote Control is on for this session. Open ${result.url} in a browser or the Claude app. ${again}`
          : `Arc: Claude Remote Control is on for this session, but Claude did not report its link. ${again}`,
      };
    case 'disconnected':
      return { level: 'info', text: 'Arc: Claude Remote Control is off for this session.' };
    case 'ended':
      return {
        level: 'warning',
        text: `Arc: Claude Remote Control ended for this session.${result.reason ? ` ${result.reason}` : ''}`,
      };
    case 'refused':
      return { level: 'warning', text: `Arc: Claude did not change Remote Control: ${result.reason}` };
    case 'busy':
      return {
        level: 'warning',
        text:
          result.state === 'uncertain'
            ? `Arc: Claude has not answered the last Remote Control request. Arc reports the result if Claude answers. ${reload}`
            : 'Arc: Claude Remote Control is still changing for this session. Wait for its result.',
      };
    case 'uncertain':
      return {
        level: 'warning',
        text: `Arc: Claude did not answer the Remote Control request in time. Arc reports the result if Claude answers. ${reload}`,
      };
    case 'unsupported':
      return {
        level: 'warning',
        text:
          result.available === false
            ? 'Arc: Claude Code reports that Remote Control is not available for this account or setup.'
            : 'Arc: this Claude Code version did not report Remote Control support. Update Claude Code to use /remote-control.',
      };
    case 'policy':
      return {
        level: 'warning',
        text: 'Arc: Remote Control is not available for a session that runs with fixed read-only permissions.',
      };
    case 'arguments':
      return { level: 'warning', text: 'Arc: send /remote-control or /rc by itself, with nothing after it.' };
    case 'draft':
      return {
        level: 'warning',
        text: 'Arc: Remote Control needs a running session. Send a first prompt, then run /remote-control again.',
      };
    case 'agentRun':
      return { level: 'warning', text: 'Arc: Remote Control is not available for a session that an agent started.' };
    // `stopped` and `closed`.
    default:
      return {
        level: 'warning',
        text: 'Arc: Remote Control needs this session to run in this window. No Claude process runs this session here.',
      };
  }
}

// Return the panel control for a slash command, ignoring its arguments. Agent commands return null.
export function panelCommand(text: string): string | null {
  const said = text.trim();
  if (!said.startsWith('/')) {
    return null;
  }
  const name = said.slice(1).split(/\s/)[0].toLowerCase();
  return own(PANEL_COMMANDS, name)?.control ?? null;
}

// Build menu rows in catalog order. Codex skills offer both dollar and slash prefixes.
export function promptEntries(agent: string, commands: readonly ComposerPromptEntry[]): PromptEntryView[] {
  return commands.flatMap((command) => {
    const prefixes: Array<'/' | '$'> = command.kind === 'skill' && agent === 'codex' ? ['$', '/'] : ['/'];
    return prefixes.map((prefix) => {
      const label = `${prefix}${command.name}`;
      const hint = command.argumentHint.trim();
      const description = command.description.trim();
      // Join the label, argument hint, and description in the displayed order for the accessible name.
      const said = [hint ? `${label} ${hint}` : label, description].filter(Boolean).join('. ');
      return {
        kind: command.kind ?? 'command',
        command: command.name,
        prefix,
        label,
        hint,
        description,
        path: command.path,
        panelControl: prefix === '/' ? (panelCommand(label) ?? undefined) : undefined,
        name: said,
        completion: `${label} `,
      };
    });
  });
}
