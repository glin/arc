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
  type DefaultContext,
} from './view/model-picks';
// What the composer shows and what the reader's answer means.
//
// The prompt box, the picker that answers an agent's question and the words on the
// interrupt affordance all need decisions made: which executable to start, which
// session a prompt belongs to, what a permission ask reads as, and what the reader
// choosing "Deny" turns into on the wire. Those decisions live here because this file
// imports no `vscode`, so they are the part of the composer the tests can reach.
//
// `extension.ts` and the webview draw what this file decides. Neither of them decides
// anything: both are exempt from testing, and this repo's two shipped regressions were
// both in code that drew and decided at once.

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
import { PermissionMode } from './claudewire';
// The servers control is written whole in `mcpview.ts`, words and all, and this file places
// it on the row. The two are imported as values here and only as types there, which is what
// keeps the pair from needing each other at load time.
import { mcpMenu, mcpPick } from './mcpview';
import {
  WINDOW_SUFFIX,
  modelWindowOf,
  normalizeModelIdentity,
  sameModelIdentity,
  snapshotDateOf,
} from './domain/model-identity';
import { AgentKind, Turn, cleanPrompt } from './transcript';
import { LINE_BREAK, matchCommandNames, renameRequest } from './domain/composer-editing';
import { isLocalLinkPath } from './domain/link-path';
import { completedQuestionAnswer } from './domain/ask-answer';
export { historyPress, matchCommandNames, pathToken, promptToken, renameRequest } from './domain/composer-editing';
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
} from './pricing';
import { CACHE_SPAN_MINIMUM_SECONDS } from './view/time';
import { looksLikeComments } from './turncomments';
// The line that says what a tool wants to do, from whichever field the tool put it in.
// It lives in `transcript.ts` because the step rows on a card read the same rule, and
// this module is downstream of that one. Re-exported because the ask is what a reader
// looking for the words on a permission dialog opens.
import { describeToolInput, firstLine } from './transcript';
export { describeToolInput };
import { activityDetail } from './activitydetail';
import { USAGE_AGENT_NAMES } from './usageview';
import type { PendingAskPosition } from './turncard';
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

// A lookup on a table written as an object literal. Never a bare index: `toString` and
// `constructor` are keys every object literal answers to, and an agent name arriving from
// stored state is text, so a bare lookup can hand back a function where a table row was
// expected.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// How much the agent asks before it acts. One control per agent, in that agent's own words.
//
// Neither CLI publishes words for its permission values: Claude's `--help` lists the names
// alone, and Codex's generated schema carries `untrusted | on-request | never | {granular}`
// with no labels against them. So whatever this panel draws is a copy, and both label sets
// below are copied from each agent's own official VS Code extension rather than written
// here. Those words are a published product surface the reader has already seen, and each
// one stands for exactly one CLI value. The cost is that both sets have to be read again
// whenever either extension ships a new version, and a value one of them drops has to be
// dropped here too.
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type ApprovalsReviewer = 'user' | 'auto_review';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface AskMode {
  // What workspace state keeps, which is the agent's own CLI value. A stored answer is then
  // read back through one table rather than translated through two.
  value: string;
  label: string;
  // The agent's own sentence under the label, and empty for an agent that publishes none.
  // A sentence written here would be this panel's claim about what another product's
  // setting does.
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

// Four of Claude's seven `--permission-mode` values. The labels are the Claude Code
// extension's own words for these four (`default` is named Manual across the CLI, the
// extensions and the desktop app); Arc orders the four itself. Each description states
// what that mode runs without asking, drawn from Claude Code's permission-modes
// documentation rather than copied from any one surface.
//
// `bypassPermissions` runs everything with no check, and `dontAsk` denies anything that
// would prompt, so Arc offers neither.
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

// Codex's four permission presets, in the order and words the Codex CLI uses.
//
// One choice covers what may run, which requests need review, and who performs that review.
// `approvalPolicy` on its own does not answer it: `on-request` with the default `user`
// reviewer still stops for the reader, while "Approve for me" promises automatic review.
//
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

// The line the menu opens with, per agent. The two questions are not the same question:
// Claude's control says how much it asks before acting, and Codex's says how the actions it
// takes get approved, so neither head can be written once for both.
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

// The modes on offer for one agent. An agent this version has no table for is given the
// first agent's, because a control drawn with nothing in it is worse than one showing a
// setting the reader can see is not theirs.
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

// The permission value the composer state carries. It resolves like `savedAskMode`, but
// keeps an explicit agent default apart from no stored pick: the empty value is the reader's
// choice of the agent default, and undefined means nothing stored names a permission.
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

// What the composer draws above the prompt box: which session is being typed into, how
// full its context window is, and the three settings the next turn will run under.
//
// The context figure lives here rather than on the status bar because a window belongs to
// the session while a plan belongs to the account, and the two get full at different
// times. The status bar carries the account's figures on the panel's bottom edge.

// One control on the row. Every word is written here, so the webview inserts strings and
// decides nothing: the label the eye reads, the name a reader who cannot see it hears, and
// the hover.
export interface ComposerPick {
  // What a repaint finds the control again by.
  control: string;
  label: string;
  // The button's accessible name, carrying both halves always: what the control is, and
  // what it is set to. A reader who cannot see the row gets this and nothing else, and a
  // name saying only "Auto" names no question.
  name: string;
  // The button's hover.
  detail: string;
  // Drawn, but not pressable. A model that takes no effort setting is the ordinary case,
  // and hiding the control would move the row's three positions around under the reader.
  disabled: boolean;
  // Drawn in the caution tone, which stands for something the reader is losing rather than
  // something they chose. Only the servers control sets it, where it means a server is down
  // and the tools behind it cannot be called.
  //
  // It rides the pick rather than being worked out where the row is drawn. The panel tones
  // the button from this and reads none of the words on it, so the one place that knows a
  // server has failed is the one place that says so; a rule that matched on the label would
  // be a second copy of a sentence written here, and the tone would go the moment the wording
  // changed.
  caution: boolean;
}

// One row of the menu a control opens. The menu is drawn in the panel rather than by the
// editor, so every word in it is written here for the same reason the controls are: the
// popover inserts strings and decides nothing.
export interface MenuItem {
  // What the row is, which decides how it is announced and how many of its neighbours can be
  // on at once. A setting is one of several and exactly one is chosen, so it is a radio. A
  // server is on or off on its own and any number of them can be on, so it is a toggle. An
  // action is neither: it has no state to announce, and pressing it does a thing rather than
  // choosing one. Announced wrongly, a list of toggles read as radios tells a listening
  // reader that turning one server on turned another off.
  kind: 'radio' | 'toggle' | 'action' | 'status';
  // What goes back on the wire when the reader picks this row.
  value: string;
  label: string;
  // The agent's own sentence for this choice, and empty where it publishes none.
  description: string;
  // Drawn with a tick, and announced as the current setting.
  checked: boolean;
  // Drawn in the caution tone. True only for a server row that has failed, which is set in
  // `mcpview.ts`. No radio row built here is ever a caution: every setting on those menus is
  // one the reader chose, not one they are losing.
  caution: boolean;
  // The row's accessible name. A reader who cannot see the menu gets this and nothing else.
  name: string;
}

export interface Menu {
  revision?: number;
  // Which control this menu belongs to.
  control: string;
  agent: string;
  // The session the menu was opened for. A reader can change the visible row while a
  // menu is open, so the choice carries its original target rather than being applied to
  // whichever session happens to be visible when the message returns.
  session?: string;
  // The settled model an effort menu was built from. It travels with the choice so the
  // extension validates the same model whose legal efforts the reader saw.
  model?: string;
  // The question at the top of the menu, in the agent's own terms.
  head: string;
  items: MenuItem[];
  // What the menu says in place of rows when it has none, and empty when it has some. A menu
  // with nothing in it says why rather than opening as a blank box.
  empty: string;
}

// Settings selected for one session. The selected values are what the reader asked
// for, while the pending values say which of those requests still wait for a turn to prove
// them. Confirmed values are kept out of this stored shape because they come from the
// transcript and change whenever a newer turn is recorded.
export interface SessionSettingSelection {
  selectedModel: string;
  selectedEffort: string;
  // A fresh draft can choose a mode different from the agent-wide launch default. Keep it
  // with that session so a replacement child resumes the setup the first child used.
  permissionMode?: string;
  // The model whose menu supplied `selectedEffort`. This can come from the transcript when
  // no model was explicitly selected, and preserves a legal effort without turning that
  // recorded model into a model choice of its own.
  effortModel: string;
  pendingModel: string | null;
  pendingEffort: string | null;
}

export interface AppliedSessionSettings extends SessionSettingSelection {
  // The API id the last reply ran under, which never names its window.
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

// One immutable update, keyed by session. The copy is what prevents a setting chosen
// in one Codex session from changing a sibling that happens to use the same agent.
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

// Commit a setting only after the protocol path accepted it. A rejected Claude `set_model`
// therefore leaves the book handed in untouched and the composer keeps its prior value.
export async function acceptedSessionSettings(
  read: () => SessionSettingBook,
  write: (book: SessionSettingBook) => Promise<void>,
  session: string,
  // Fields, or a reading of them taken after the agent answers. A model change needs the
  // later reading: the effort level belongs to the model, and a reader can pick a level
  // while the model request is in flight, so fields worked out before the request would
  // store the level that pick replaced.
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
  // Rounded to nearest by `wholePercent`, which holds 100 back for a window with nothing
  // left in it.
  percent: number;
  // The bar's width, which is the share held inside the track however full the window is
  // reported to be.
  fill: number;
  level: ContextLevel | null;
  // The figure's hover, and the whole of what the bar beside it would have said. The bar
  // carries nothing the percentage does not, so it is hidden from a screen reader and this
  // sentence is what is left.
  name: string;
  // Whether the figure is pressable, which is whether the panel knows how this agent compacts.
  // The command itself never travels from the figure: the extension asks the live agent
  // session to compact, so a compaction reaches each protocol through its own control.
  // The figure is the control because the window filling up is the reason to compact, and a
  // reader watching it fill should not have to look elsewhere for the answer. Both agents
  // that this panel drives put compaction on the same figure in their own interfaces.
  compact: string;
  // The press's accessible name, which says the figure and the action in one line, and empty
  // where the figure is not pressable.
  compactName: string;
}

type ComposerPromptEntry = PromptEntry | (Omit<PromptEntry, 'kind'> & { kind?: 'command' });

export interface ComposerState {
  // Present only while this session is still a local draft. The profile is the whole of
  // what the draft will start on, so every control the composer draws for it reads from here
  // and a press changes this alone. Nothing on a draft's row reaches the live session
  // the setup was copied from.
  profile?: SessionProfile | null;
  // The agent's own key, never its drawn name. Everything the composer looks up is filed
  // under the key: the model list, the reader's picks, how much the agent asks, and which
  // CLI a prompt is handed to. Typed rather than left a string because the panel holds both
  // spellings a few lines apart, and a display name read as a key is silent: the tables all
  // miss, the pickers fall back to their defaults, and a prompt goes to the wrong agent.
  agent: AgentKind;
  session: string;
  // Empty until the agent has been asked what it runs.
  models: readonly ModelChoice[];
  defaults?: DefaultContext;
  // Every command this session's agent publishes, in the agent's own order. Empty
  // until the agent has been asked, and empty for good on one that publishes none. Claude
  // answers it on `initialize`; Codex has no slash menu to mirror, so its skills are what
  // the composer offers there.
  commands: readonly ComposerPromptEntry[];
  // The Claude skill list for this session's working directory, for the Composer's inline
  // highlight. Null until that directory has reported one at all, which is the fallback that
  // highlights every command; an empty list is a real answer and highlights none. Codex
  // ignores this, because a Codex entry already carries its own skill flag on `kind`.
  claudeSkills: readonly string[] | null;
  // What the agent last said about the servers it can call tools on. Filed under the agent's
  // key like the model list, and for the same reason: the servers belong to the agent rather
  // than to the session. Two sessions of one agent are two views of one set of
  // servers, so a server switched off in one is switched off in the other, and a list kept
  // per session would show the reader two answers to a single question.
  //
  // Empty for an agent nobody has asked yet, and empty again for one that was asked and has
  // no servers. Both draw nothing, which is the honest answer to each: until an agent has
  // answered there is nothing to say about its servers, and once it has answered with none
  // there is a control that would count to zero and open on an empty box.
  mcpServers: readonly McpServer[];
  // What the reader selected for this session, what still waits for the next turn, and
  // what the newest transcript turn confirmed. These are separate facts: a Codex choice is
  // pending until `turn/start` runs, while a recorded value says what actually happened.
  settings: AppliedSessionSettings;
  // A stored permission value, the empty value for an explicit agent default, or undefined
  // when nothing stored names one. Both of the last two run the agent's own default.
  askMode: string | undefined;
  // Codex resolves this state when it opens a thread. It remains separate from the Arc pick.
  effectiveMode?: CodexEffectiveMode | null;
  // Claude reports the mode that settings and launch flags resolved after its first prompt.
  effectivePermissionMode?: string | null;
  // Null for a session with no turn in it yet, which has no window to be a share of.
  // `max` is the model's window and not a constant: the same build of one model answers
  // with 1,000,000 where another answers with 200,000, so the figure is divided here and
  // never assumed.
  context: { used: number; max: number } | null;
  // Everything the next turn's floor price is worked out from, or null where the panel has
  // no context figure or no priced model to work it out with.
  nextTurn?: NextTurnBasis | null;
  // What the reader has typed into the box, exactly as they typed it.
  draft: string;
  // The submissions waiting for the running turn to end, oldest first. A comments-only
  // submission keeps no copied prompt text because its comments remain on their turns.
  queued: readonly QueuedSubmission[];
  // Comment ids reserved for the queued prompt currently back in the box for editing.
  draftCommentIds?: readonly string[];
  // Queue entries currently crossing the agent acceptance boundary. They remain persisted
  // owners until acceptance, but their live card replaces the waiting card on screen.
  queueHandoffs?: ReadonlySet<string>;
  // The prompts this session has already sent, newest first, which the Up arrow walks
  // back through. Built by `promptHistory` from the transcript and from what this panel has
  // handed over since the window opened.
  history: readonly string[];
  // What the box on screen holds, when that is not the draft. The two differ only while the
  // reader walks back through earlier prompts. Whether the control sends, stops or refuses
  // is read off this one, because the reader is looking at it. The draft is what the box
  // keeps and what a queue edit swaps with, because those are the words they wrote.
  onScreen: string;
  // Files staged for the next prompt in this session.
  assets?: readonly PromptAsset[];
  // Webview-local addresses for image previews. The same staged path gets a different safe
  // address in each webview, so this is prepared at the host boundary.
  assetPreviews?: Readonly<Record<string, string>>;
  // A short attachment refusal shown beside the composer. It stays in memory only.
  notice?: string | null;
  // Whether a turn is running in this session now.
  running: boolean;
  // A clear waits for both agent acceptance and the successor session. It stays outside
  // `live` because the command produces no turn card.
  clearing?: boolean;
  // Every comment the panel holds, across every session. The composer takes the lot
  // and picks its own out through `commentsFor`, for the reason that function gives: a set
  // gathered across sessions would send one agent's review to another.
  comments: readonly TurnComment[];
  // Which session the composer is aimed at, which is what picks those comments out.
  sessionId: string;
  // The turn whose content opened this draft. This is UI metadata rather than prompt text,
  // so normal prompt assembly never sees it.
  origin?: DraftOrigin | null;
  // The presses this session is still waiting on, oldest first, and empty between
  // presses. See `LivePress`: it is what the panel says it is doing between the press and
  // the reply. A list rather than one press, because a compaction and a prompt sent during
  // it are two pieces of work the agent does one after the other, and each has to say so.
  live: readonly LivePress[];
  // Requests the agent is holding open for this session. They arrive already
  // normalized by the wire, and remain here until the host accepts an answer or the turn
  // ends. Keeping them with the composer state puts the action beside the session it
  // blocks without making the transcript pretend the request was a recorded turn.
  asks?: readonly Ask[];
}

// The chip above the box, saying what rides out with the prompt.
//
// The comments a reader left on turns go with the prompt as attachments rather than as text
// pasted into the draft. The reader keeps their own words in the box, and the notes are
// carried under them, counted here so the count can be checked before anything is sent.
export interface ComposerAnnotations {
  count: number;
  // '3 comments', '1 comment'. A session with none attached draws no chip at
  // all, so this never counts nothing.
  label: string;
  // The chip's accessible name. It carries the count and what becomes of the attachments,
  // because neither is anywhere else for a reader who cannot see the chip.
  name: string;
  // The chip's hover, naming what is attached.
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
  // The prompt, cut to one line. What the row draws while it is shut.
  label: string;
  // The whole prompt, drawn when the row is opened. A queued prompt is the reader's own
  // writing and they cannot see it anywhere else: the box was cleared when it went into the
  // queue, so a row that only ever shows its first line hides the thing the reader most
  // needs to check before it goes.
  text: string;
  // Whether opening the row shows anything the shut row does not. A prompt that already fits
  // on one line is drawn as text with no disclosure, because a control that opens onto the
  // same words is a press that answers nothing.
  long: boolean;
  // The disclosure's accessible name in each state, and empty on a row that does not open.
  openName: string;
  shutName: string;
  // What a repaint finds the disclosure again by, and empty on a row that does not open.
  control: string;
  // The control that takes the prompt out of the queue, which is its own button rather than
  // the whole row: a reader opening a long prompt to read it must not drop it by doing so.
  dropName: string;
  dropControl: string;
  // Puts the prompt back in the box and takes it out of the queue. There is no second editor
  // anywhere: the box already has the caret, the selection, the undo history and the growth,
  // and a reader who wants to change a queued prompt wants all four.
  editName: string;
  editControl: string;
  // The word on each control. Written here with the rest of the composer's words, so the
  // panel inserts strings and decides nothing, and words rather than glyphs because that is
  // what the rest of the panel's controls use.
  editLabel: string;
  dropLabel: string;
  // The whole prompt on the clipboard. The reader wrote it and a queued one is the only copy
  // on screen, so taking it somewhere else must not mean retyping it.
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

// The card the composer draws between the press and the reply: what the panel is doing, and
// the reader's own words, until the transcript poll draws the real turn over the top of it.
export interface ComposerLive {
  // Which press this card is for. Two can be on screen at once, a compaction and the prompt
  // waiting behind it, and the panel tells them apart by this: it is what keeps a reply
  // being written into the card it belongs to rather than into whichever one is on top.
  kind: LiveKind;
  // Which of the three states the card is in. The panel tones the card by it and reads none
  // of it: every word on the card is decided here.
  state: LiveState;
  // Which turn status the card is drawn as, so the panel picks neither its tone nor its
  // glyph. A press has three states and a turn card has five, and the panel was collapsing
  // one onto the other itself, which is a rule living in the file nothing tests.
  tone: 'running' | 'failed';
  // The head row, worded the way a turn card's head row is worded, because it is drawn as
  // one. A press is a turn that has not been recorded yet, so the card that stands for it
  // wears the same frame, the same time, the same elapsed figure and the same agent and
  // model as the card that will replace it. What the reader saw before was a strip of a
  // different shape being swapped for a card, twice, in the first few seconds of a prompt.
  relative: string;
  absolute: string;
  agent: string;
  // Empty where the reader has picked nothing and no turn has run to say what the agent
  // uses, which is a session's first prompt.
  model: string;
  // The head row's spoken name, which carries what the eye reads off the row.
  label: string;
  // What the card leads with, in the same slot a turn card leads with its headline, and the
  // same words: the first line of what the reader typed, which is what the turn itself leads
  // with until the agent has written something. Empty for a compaction, which carries none
  // of the reader's words.
  headline: string;
  // The line under the headline, where a turn card says what the agent is doing now. Here it
  // says what the panel is doing, in the agent's own name.
  status: string;
  // The reply so far, as one line, and empty until the agent has written something. Drawn
  // under the headline rather than in place of it: the card is the one place the question
  // and the answer are on screen together, which is the whole of what it is for.
  //
  // It is drawn anchored to its end, so what a narrow panel clips is the start. A line that
  // clipped its end would stop moving after the first few words, which is the opposite of
  // what a reader watching a reply arrive is looking at it for.
  reply: string;
  // When the press was, for the one-second ticker that rewrites every other card's relative
  // time. A failed card carries it too: the notice stands until the reader dismisses it, and
  // a moment that still reads "now" ten minutes later is the card lying about its own age.
  at: number;
  // What the elapsed figure counts up from, and null on a failed card, which counts up no
  // further: a figure growing beside a notice that nothing happened reads as work still
  // being done. This is why it is not `at` under another name.
  since: number | null;
  // The control that takes a failed card away, and empty on a card the poll will remove
  // itself. A card the reader must clear is exactly the card that says a press did not go.
  dismissLabel: string;
  dismissName: string;
  dismissControl: string;
  // The primary way out of a failed prompt. It returns the complete text to the matching
  // session's box; the headline above is only the first line and cannot do that job.
  // Empty for a compaction, which carries no reader text to restore.
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
  // How to send and how to make a new line. It sat on a line of its own under the box, which
  // spent a row of a narrow panel on something a reader learns once. It rides the send
  // control's hover and its spoken name instead, where somebody who has not learnt it yet is
  // the one who finds it.
  hint: string;
  heightName: string;
  heightHint: string;
  heightHintDetail: string;
  // The one button at the end of the controls row. It is Send when nothing is running and
  // Stop while a turn is, and the two are one control because they never both apply.
  actionLabel: string;
  actionName: string;
  actionControl: string;
  // The same word as the control, so the panel can tone the button without reading the
  // label it was given.
  actionKind: string;
  // False when there is nothing to send or the current operation cannot accept it. A Stop
  // remains enabled because stopping a turn needs no draft.
  actionEnabled: boolean;
}

// The chip above a draft's controls, saying that this session has not started yet.
//
// It says nothing about the setup. The four controls under it draw every value already, and
// a second copy of them in words adds no fact. What stood here named the session the
// setup was copied from, which builds a sentence out of a session title and reads as
// one.
export interface ComposerDraftTag {
  // What the draft is. The same word whatever the setup, because it names the state and not
  // the setup.
  word: string;
  // The hover, carrying the four facts the controls draw. It is what a reader checks the
  // whole setup with in one look, and the controls carry the same words one at a time.
  detail: string;
}

export interface ComposerView {
  agent: string;
  // The session the box is aimed at. It rides the view because the panel files the
  // draft under it and names it on every message about the box: without it the panel aimed
  // at `undefined`, so every session shared one draft slot and a prompt was filed
  // against whichever session was newest when the message arrived.
  sessionId: string;
  // What the reader had typed into the box and not sent, so a panel drawn from nothing can
  // put it back. The box holds its own copy while the window lives, and this is the only way
  // into it after a reload, when the panel is new and the extension holds what was typed.
  //
  // The panel takes this once per session and never again. The answer arrives a round
  // trip behind the keystroke, so a box that adopted it on every draw would put stale text
  // back under the caret of a reader still typing.
  draft: string;
  // Which session the prompt goes to, said rather than drawn. The rail already names it
  // at the top of the panel, so a second copy over the box spent a line on what the reader
  // was already looking at. It stays as the box's accessible name, where the only reader who
  // cannot see the rail's answer is the one who needs it.
  targetName: string;
  origin: ComposerOrigin | null;
  // Null for a live session, which is every session with a child behind it.
  draftTag: ComposerDraftTag | null;
  context: ComposerContext | null;
  // The line directly above the box, saying what the next turn costs before the reader types
  // a word. Null where the session has no context figure or no priced model, which is a
  // line that is not drawn rather than a line that says it does not know.
  nextTurn: ComposerNextTurn | null;
  // Model, effort and how much the agent asks, in that order, and then the agent's MCP
  // servers where it has any. The first three are always here and the last is not, which is
  // why it is last: the row's settled positions stay where they are.
  picks: ComposerPick[];
  // Every command the agent published, already worded. The panel narrows this to what the
  // reader has typed rather than being sent a narrowed list, because the narrowing has to
  // answer the keystroke that is in the box now: a list worked out here arrives a round
  // trip later, and an Enter pressed inside that gap completes a command the reader never
  // saw. It changes when the agent answers rather than when the reader types, so the foot
  // is not rebuilt around it.
  commands: PromptEntryView[];
  // The Claude skill list for this session's working directory, carried through for the
  // Composer's inline highlight. Null when that directory has never reported one. Codex
  // ignores this field.
  claudeSkills: readonly string[] | null;
  // The menu's own accessible name, for commands and local paths alike. A listbox with no
  // name is announced as a list of nothing in particular.
  completionName: string;
  box: ComposerBox;
  // Null when nothing is attached, which is when no chip is drawn at all.
  annotations: ComposerAnnotations | null;
  files: ComposerFile[];
  notice: string | null;
  filePendingName: string;
  // Oldest first, which is the order they will be sent in.
  queue: QueuedPrompt[];
  // The earlier prompts the box offers, newest first. They ride the view because the panel
  // has to answer the press with them: a list asked for on Up would arrive a round trip
  // after the key, which is the reason the command menu keeps its own copy of matching too.
  history: string[];
  // What the panel is doing between the press and the reply, newest first, and empty
  // between presses. More than one only while a prompt is waiting behind a compaction.
  live: ComposerLive[];
  // Requests waiting for the reader, oldest first. They sit above the prompt box at the
  // foot of this session, where a reply can be given without leaving the panel.
  asks: AskCard[];
  // The sentence beside Send while a request is waiting, saying that the press will answer
  // the request before it sends what is typed. Empty when nothing is waiting, and empty
  // whenever the press would not send: the control is Stop while a turn runs over an empty
  // box, and a Send with nothing to send is refused, and neither one answers a request.
  //
  // It joins the send control's own name as well, because a request that arrives while the
  // reader is typing changes what Send does with no other signal.
  sendOverAsk: string;
}

export interface AskCardChoice {
  label: string;
  detail: string;
  name: string;
  // The last choice on every question, which opens a box for an answer the agent did not
  // offer. It sends no label of its own: what the reader types is the answer.
  written: boolean;
}

export interface AskCardQuestion {
  id: string;
  legend: string;
  // The agent's own short label for this question, drawn as a chip before the legend. Claude
  // documents `header` as a chip label, so the card draws it as one. Empty for a question
  // that carries none, and the chip is then left out.
  key: string;
  // How many choices the reader may take. It is the one thing the controls themselves do not
  // say: a set of checkboxes and a set of radios look alike until one is pressed.
  hint: string;
  multiSelect: boolean;
  // A secret answer goes into a password box, and its tab reports that it is answered
  // without reporting what it says.
  secret: boolean;
  choices: AskCardChoice[];
  // The word on this question's tab. It is the agent's short label where it sent one and the
  // question's number where it did not, because a strip of tabs called nothing tells the
  // reader only how many questions there are.
  tab: string;
  // The tab's spoken name while the question has no answer.
  tabName: string;
  // The first half of the tab's spoken name once the question has one. The panel adds the
  // reader's own answer after it, whole, however far the strip cut the visible value. A
  // secret question keeps this half alone.
  tabAnsweredName: string;
  // The box that takes an answer the agent did not offer, and what it says while it is empty.
  writtenName: string;
  writtenPlaceholder: string;
}

const REFUSED_ASK: AskAnswer = {
  decision: 'deny',
  reason: 'The reader refused this from the panel.',
};

// The reader answered in the message that follows rather than on the card. It is worded for
// a permission as well as a question, because a permission left open holds a prompt behind it
// exactly as a question does, and neither one was refused.
export const ANSWERED_IN_PROMPT: AskAnswer = {
  decision: 'deny',
  reason: 'The reader did not answer this here and replied in their next message instead.',
};

// A denial this file wrote, matched by its reason, or nothing for a denial it did not.
//
// `acceptedAskAnswer` narrows every denial it takes to `REFUSED_ASK`, because the reason
// reaches the model as this panel's own words and the webview is an input boundary. The
// answer the send path gives comes back through the same door, so a denial that is one of
// this file's own has to survive it: told the reader refused, a model tries something else,
// and the reader who typed over the request said no such thing.
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

// One blocking request in the session foot. Every visible and spoken word is settled
// here so the browser only builds controls and returns the values they carry.
export interface AskCard {
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
  // Which question the reader is on, one line per question, in question order. The panel
  // draws the line for the question on screen, so the count is worded here with every other
  // word on the card.
  steps: string[];
  // How many questions are answered, one line per possible count, from none through all of
  // them. The shut head row draws the line for the count reached, so a reader who folded the
  // card can still see how far they got. Empty for a permission, which has nothing to count.
  answeredWords: string[];
  // What the fold press will do, the way a session heading names its own press rather than
  // its state. Each is named for what it does, so `openName` is worn while the card is shut
  // and `shutName` while it is open. That is the queued prompt's rule at `openName` above,
  // and the panel reads both through the same `open ? shutName : openName`.
  openName: string;
  shutName: string;
  // The state on the head row, and what it becomes once the reader's answer is on its way.
  // The waiting phrase is the rail's, so a session marked `needs you` on the rail and
  // the card at its foot say one thing and point at each other.
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

// What a reader types to compact each agent's session. Claude publishes `compact` in
// its initialize response. Codex has the same composer command but no native command list,
// so `codexwire.ts` keeps it beside the discovered skills. The command is recognized before
// prompt assembly and handed to the live session's compaction control. An agent with no
// entry here draws the figure and no control.
const COMPACT_COMMANDS: Record<string, string> = { claude: '/compact', codex: '/compact' };

const CLEAR_COMMANDS: Record<string, string> = { claude: '/clear', codex: '/clear' };

export interface ClearRequest {
  command: 'clear' | 'new';
  name: string;
}

// The composer command for one agent's compaction control, or nothing for an agent with none.
export function compactCommand(agent: string): string {
  return own(COMPACT_COMMANDS, agent) ?? '';
}

// Whether the whole submission asks for compaction. Exact means the command can never take
// a sentence mentioning `/compact`, an argument intended for an agent, or a similarly named
// skill. Whitespace and case are presentation details, as they are for panel-owned commands.
export function compactSubmission(agent: string, text: string): boolean {
  const command = compactCommand(agent);
  return Boolean(command) && text.trim().toLowerCase() === command.toLowerCase();
}

// Where an exact compaction submission goes. A running session cannot take a second
// control turn yet, so the command waits in the same queue as a prompt and is recognized
// again when that queue drains.
export function compactAction(agent: string, text: string, running: boolean): 'compact' | 'queue' | null {
  if (!compactSubmission(agent, text)) {
    return null;
  }
  return running ? 'queue' : 'compact';
}

export function clearCommand(agent: string): string {
  return own(CLEAR_COMMANDS, agent) ?? '';
}

// Codex accepts `/new` with an optional name for the chat it opens. The name is the
// complete remainder of the line. Quotes and internal spacing are part of that name.
// A line break ends the native command grammar, so a prompt that starts with `/new`
// but continues on another line still reaches the model as ordinary text.
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

// What the model control says while nothing has been picked and nothing is known to pick.
const DEFAULT_EFFORT_LABEL = 'Effort not reported';

// What the effort control says when there is no effort to set. It says that rather than
// going blank, because a blank control that cannot be pressed is a question the reader is
// left holding.
const NO_EFFORT_LABEL = 'No effort setting';

// The model the session will run on, or null for the agent's own default and for a
// stored pick this version of the agent no longer lists.
export function chosenModel(models: readonly ModelChoice[], model: string | undefined): ModelChoice | null {
  return (
    models.find((m) => m.value === model) ?? (model ? models.find((m) => m.resolvedModel === model) : undefined) ?? null
  );
}

// The listed model a recorded model id names, when exactly one names it.
//
// The two vocabularies are not the same one. `list_models` answers with the CLI's own
// aliases, `opus`, `sonnet`, `opus[1m]`, and a transcript records the resolved API id the
// reply came back under, `claude-opus-4-5-20251101`, so the two never compare equal. When
// the agent's reply carries a resolvedModel, that id is the exact link between the pick and
// what ran. This alias search is the fallback for a reply with no resolvedModel.
//
// Taken only when one alias matches. Two would be a guess about which, and a guess here
// names the wrong model on screen and offers the wrong effort levels behind it. `default` is
// never a match: it is the CLI's word for making no choice and it names no model.
export function modelRan(models: readonly ModelChoice[], ran: string | null): ModelChoice | null {
  if (!ran) {
    return null;
  }
  const id = ran.toLowerCase();
  const named = models.filter((m) => {
    const alias = m.value.toLowerCase().replace(WINDOW_SUFFIX, '').trim();
    return alias !== '' && alias !== 'default' && id.includes(alias);
  });
  return named.length === 1 ? named[0] : null;
}

// The listed model a `model` attachment names, when exactly one names it.
//
// An attachment names the window, as in `claude-opus-5-5[1m]`, where a reply's API id never
// does. So a listed model matches only with the same window. An exact resolvedModel comes
// first, then an exact value, then the alias search for a choice that lists no resolvedModel.
// Two matches at one step leave the model unresolved, because list order is no evidence.
// `default` is never a match, even when it resolves to the same model.
export function modelAttached(models: readonly ModelChoice[], attached: string | null): ModelChoice | null {
  if (!attached) {
    return null;
  }
  const id = attached.trim().toLowerCase();
  const window = modelWindowOf(id);
  const explicit = models.filter((m) => m.value !== '' && m.value.toLowerCase() !== 'default');
  const one = (found: readonly ModelChoice[]): ModelChoice | null | undefined =>
    found.length === 1 ? found[0] : found.length ? null : undefined;
  const resolved = one(
    explicit.filter(
      (m) => m.resolvedModel && modelWindowOf(m.resolvedModel) === window && sameModelIdentity(m.resolvedModel, id),
    ),
  );
  if (resolved !== undefined) {
    return resolved;
  }
  const exact = one(explicit.filter((m) => m.value.toLowerCase() === id));
  if (exact !== undefined) {
    return exact;
  }
  const bare = id.replace(WINDOW_SUFFIX, '');
  const named = explicit.filter((m) => {
    const value = m.value.toLowerCase();
    const alias = value.replace(WINDOW_SUFFIX, '').trim();
    return (
      !m.resolvedModel &&
      alias !== '' &&
      modelWindowOf(value) === window &&
      (alias.startsWith('claude-') ? sameModelIdentity(alias, bare) : bare.includes(alias))
    );
  });
  return named.length === 1 ? named[0] : null;
}

// The listed model the transcript says the last turn ran on. A recorded attachment is the
// only evidence for it when there is one. The API id cannot rule out a larger window, so
// falling back to it could name a smaller window than the session ran with.
function recordedModel(state: ComposerState): ModelChoice | null {
  const attached = state.settings.confirmedModelAttachment;
  return attached ? modelAttached(state.models, attached) : modelRan(state.models, state.settings.confirmedModel);
}

// The model this session's next turn will run on, and the one its controls describe:
// the reader's pick where they made one, and otherwise the model the transcript says the
// last turn actually ran on.
//
// The fallback is a reading, not a pick. It is what makes the effort control usable at all,
// since effort belongs to a model and a reader who has chosen no model still has one running.
export function settledModel(state: ComposerState): ModelChoice | null {
  return chosenModel(state.models, state.settings.selectedModel) ?? recordedModel(state);
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

// The efforts that model offers, which is none for a model that takes no effort setting and
// none again while no model is settled on. Nothing is offered for a model nobody has
// chosen: the effort a turn would run at is the chosen model's business, and a list pooled
// from every model would offer settings the running one does not take.
export function effortChoices(models: readonly ModelChoice[], model: string | undefined): readonly EffortChoice[] {
  return chosenModel(models, model)?.efforts ?? [];
}

function agentName(agent: string): string {
  return own(USAGE_AGENT_NAMES, agent) ?? agent;
}

// The answer to one prompt handoff. A boolean could say only that nothing went; the card
// also needs enough to tell the reader what to fix before they try again.
export interface PromptDelivery {
  delivered: boolean;
  reason: string;
  // The accepted submission in the agent session. Claude uses it to match an
  // ending event to the staged files owned by that exact prompt.
  turnId?: number;
  // Set when delivery continued in a new session because the named one was owned by
  // another client.
  session?: string;
}

const LAUNCH_AGENTS: readonly AgentKind[] = ['claude', 'codex'];
// The inherited row is the one row outside a titled section, so its detail names its source.
const INHERITED_SOURCE_NAME = 'Inherited';
const PINNED_HEADING = 'Pinned setups';
const RECENT_HEADING = 'Recent setups';
// Why a pinned setup cannot start a session, by the value the catalog no longer offers.
const MISSING_SETUP_REASONS: Record<SetupValueName, string> = {
  agent: 'Agent not available',
  model: 'Model not available',
  effort: 'Effort not available',
  permission: 'Permissions not available',
};
// The setup value each launcher fact shows, in fact order.
const SETUP_FACT_FIELDS: readonly SetupValueName[] = ['agent', 'model', 'effort', 'permission'];

function launchValue(value: string, label: string, detail: string = ''): LauncherValue {
  return { value, label, detail, name: [label, detail].filter(Boolean).join('. ') };
}

function launchAgents(
  models: Readonly<Record<string, readonly ModelChoice[]>>,
  defaults: Readonly<Record<string, DefaultContext>> = {},
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

// What separates one fact from the next wherever a setup is said in a line.
const PROFILE_FACT_SEPARATOR = ' · ';

// The four facts a setup runs under, in the order every surface names them.
//
// Each falls back to what is known: the catalog's word for a value, then the value itself
// for one this version of the agent no longer lists, and only then the word for making no
// choice. Written once because a launcher row, a draft's tag and a draft's controls all say
// the same setup, and three copies of the fallbacks would drift into three answers.
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

// The inherited row says its own label and every fact, then its source. A pinned or recent
// row sits under a heading that names its section, so only its accessible name repeats the
// heading. Its label is the agent and model, and its detail spells the whole setup the way the
// Composer's model picker does, so the detail still reads alone under a label that names no
// value. The section comes from the list the row is built for, because a pinned row's profile
// says recent.
// A missing value shows as stored, because the catalog's fallback for it names another value.
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

// A session with no stored permission offers the permission a new setup preselects, while
// an explicit agent default stays the empty value. An effort the inherited model does not
// offer becomes the Default effort, since the launcher refuses a setup that names one. The
// omitted model accepts any effort the catalog offers.
function inheritedProfile(state: ComposerState): SessionProfile {
  const stored = state.askMode;
  const model = state.profile ? state.profile.model : (settledModel(state)?.value ?? state.settings.selectedModel);
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

// The complete launch surface, including every word the browser draws. The panel only
// chooses a row and posts its key; profile meaning and accessible names stay testable here.
export function sessionLauncherView(
  current: ComposerState | null,
  recent: readonly SessionProfile[],
  models: Readonly<Record<string, readonly ModelChoice[]>>,
  pinned: readonly PinnedSetup[] = [],
  defaults: Readonly<Record<string, DefaultContext>> = {},
): SessionLauncherView {
  const agents = launchAgents(models, defaults);
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
  // Each entry keeps its index into the stored history, so hiding a duplicate or a row past
  // the display cap never renumbers the key of a row the reader sees.
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
  // Quick New takes the latest valid setup before any pin hides it from the list, so pinning
  // the latest setup never changes what New starts.
  const latest = recent.findIndex((profile) => launcherProfileAvailable(profile, agents));
  const primary = inherited ?? (latest >= 0 ? recentRow(recent[latest], latest) : null);
  return {
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
      pinnedEmpty: 'No pinned setups yet. Pin a recent setup to keep it here.',
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

// Resolve only choices that the posted view offered. A stale or altered browser message
// cannot start an agent with a model, effort, or permission value that was never shown.
export function launcherProfile(view: SessionLauncherView, request: LauncherRequest): SessionProfile | null {
  if (request.kind === 'row') {
    // The primary row can be a recent setup that a pin hides from the menu, so it resolves on its own.
    const rows = [view.inherited, view.primary, ...view.pinned.filter((row) => row.available), ...view.recent].filter(
      (row): row is LauncherProfileRow => Boolean(row),
    );
    const found = rows.find((row) => row.key === request.key);
    return found && launcherProfileAvailable(found.profile, view.agents) ? { ...found.profile } : null;
  }
  const agent = view.agents.find((one) => one.value === request.agent);
  const model = (agent?.supportedModels ?? agent?.models)?.find((one) => one.value === request.model);
  const effort = model?.efforts.find((one) => one.value === request.effort);
  const permission = agent?.permissions.find((one) => one.value === request.permissionMode);
  if (!agent || !model || !effort || !permission) {
    return null;
  }
  return {
    agent: agent.value as AgentKind,
    model: model.value,
    effort: effort.value,
    permissionMode: permission.value,
    source: 'custom',
  };
}

// Why a handoff made no draft. The reader fixes each cause a different way.
export type HandoffRefusal = 'turn' | 'source' | 'setup' | 'folder';

// What the reader sees when a handoff makes no draft. `sending` is true when the handoff
// carries text from a turn, and false for an empty draft.
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

export interface NewSessionDraft {
  draftId: string;
  cwd: string;
  sourceSession: string | null;
  createdAt: number;
  profile: SessionProfile;
  origin: DraftOrigin | null;
  // Whether the reader changed this setup on one of the draft's own controls.
  //
  // The profile's source cannot answer that question. The launcher's own form stamps a
  // custom source on a setup chosen before any draft exists, so a draft made through it
  // would count as the reader's work the moment it appeared.
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

// Text redirected from a turn starts an editable draft with one blank line after it. Links
// and selected text share the same size boundary without sharing link validation.
export function handoffDraftText(value: string): string | null {
  const text = value.replace(/\r\n?/g, '\n');
  const draft = text.trim() ? `${text}\n\n` : null;
  return draft && draft.length <= DRAFT_TEXT_LIMIT ? draft : null;
}

export function responseLinkDraftText(link: string): string | null {
  return isLocalLinkPath(link) ? handoffDraftText(link) : null;
}

// A draft's setup as the session settings book keeps it.
//
// The book is what the composer reads a live session's model and effort from, and a
// draft is filed in it under its own provisional id so the panel has one shape to read. The
// effort's model is recorded only where an effort was chosen, because an effort belongs to
// a model and naming one under no effort would claim a choice nobody made.
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
    // Nothing is pending on a draft. There is no turn to confirm a value, and the child is
    // started on whatever the profile holds when the first prompt goes.
    pendingModel: null,
    pendingEffort: null,
  };
}

// The setup a draft has after the reader picks one row of one of its menus, or nothing at
// all for a value no menu offered.
//
// It resolves only what the menus draw, the guarantee `launcherProfile` gives for the
// launcher: a stale or altered browser message cannot start an agent on a model, effort or
// permission value the reader was never shown.
//
// Re-picking the value already set leaves the setup exactly as it was, source included. The
// source is what the tag says, and a reader pressing the row that is already ticked has
// changed nothing to call custom.
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
    // The other three belong to the agent that was left. A model is one agent's own name for
    // one of its own models, an effort is a level of that model, and a permission value is
    // one agent's CLI vocabulary, so carrying any of them across would start the new agent on
    // a setting it has never heard of. The permission takes the new agent's preselected mode,
    // as the launcher form does.
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
  // What the panel has submitted in each session, which the Up arrow walks back
  // through. It moves with the rest or the first prompt of a new session is offered by
  // nothing: the transcript has not recorded it, and this is where it lives until then.
  sent?: Record<string, string[]>;
  // What the box on screen holds in each session, which the send control follows. It
  // moves with the rest, or the control reads a session that no longer exists.
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

// A first prompt gives a provisional draft its real session id. All state that was
// filed under the provisional id moves together, or none of it does. A real id with local
// state is a collision, not an invitation to combine two sessions.
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

// One session continuing as another, both of them real.
//
// This is what `/clear` does. The agent keeps its child and starts a new session inside
// it, and the transcript it was writing stays on disk complete and resumable. So this is not
// the rename above it. Adoption exists because a provisional id never existed and has to stop
// existing; here the source keeps every turn it has, keeps its place in the rail, and can be
// opened again tomorrow.
//
// What follows the reader forward is what the old session can no longer answer for. A
// press was sent to a session the child has left, so it moves. Unsent text, queued work
// and attachments in flight belong to the person rather than the transcript, so they move
// too. The model pick is copied instead, because the source still exists and reopening it
// must not find its settings gone.
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
  // Beside the session it came from rather than at the head of the rail. The two are one
  // piece of work, and a successor filed anywhere else reads as an unrelated session
  // that happens to have started at the same moment.
  const at = state.railOrder.indexOf(source);
  const railOrder = state.railOrder.includes(successor)
    ? [...state.railOrder]
    : at < 0
      ? [successor, ...state.railOrder]
      : [...state.railOrder.slice(0, at), successor, ...state.railOrder.slice(at)];
  return {
    drafts: { ...state.drafts },
    assets: move(state.assets ?? {}),
    queues: move(state.queues),
    live: move(state.live, (presses) => presses.map((press) => ({ ...press, sessionId: successor }))),
    settings: copy(state.settings),
    profiles: copy(state.profiles),
    railOrder,
    showing: state.showing === source ? successor : state.showing,
    ...(state.origins ? { origins: copy(state.origins) } : {}),
    ...(state.sent ? { sent: { ...state.sent } } : {}),
    ...(state.boxText ? { boxText: move(state.boxText) } : {}),
  };
}

// An untouched draft leaves without starting anything. Once it holds text, queued work, a
// live press, or a setup the reader changed by hand, it is not abandoned: all four are the
// reader's own work, and pressing another row in the rail must not throw any of them away
// without a word.
//
// The caller says whether the reader changed the setup, because the profile cannot. The
// launcher's own form writes a custom source onto a setup chosen before any draft exists, so
// a rule reading that source here leaves every draft made through Create draft on the rail
// for the life of the window, with no typed text and no press to explain it.
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

// Protocol failures translated into the stable words a failed-send card carries. The full
// server error is still shown by the editor for diagnosis, while the card says what the
// reader can do without exposing JSON-RPC terms or version-specific enum names.
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

// The same translation for a compaction, which fails differently and recovers differently.
//
// It says only why. The card above it already says that the session was not compacted,
// and every layer under it used to say so again: the extension, the session and the wire each
// added a sentence of its own, and together they left no room for the cause. A reader whose
// provider sign-in had expired was told over and over that nothing had happened, and never
// once that they were signed out.
//
// So the agent's own sentence is passed through rather than replaced. A refused prompt can be
// mapped to stable words because the reader's move is always the same, which is to restore it
// and send it again. A compaction has nothing to restore and one move only, which is to fix
// what the agent named and press again, so the naming is the whole value.
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

// A sentence that leads rather than follows. `sentence` gives agent text a full stop for a
// line it shares with other words. This one is for text standing alone at the head of its
// own line, where a lower-case opening reads as a fragment torn out of a log.
function opened(said: string): string {
  return said.charAt(0).toUpperCase() + said.slice(1);
}

// The floor price of the next turn, and every word that explains it.
//
// Every turn re-presents the whole session, so a turn has a price fixed before the
// reader types. Which of the two prices it is depends on whether the cache the last request
// bought is still alive, and that answer moves with the clock rather than with anything the
// panel draws. So all three faces travel together with the moment the lifetime runs out, and
// the browser picks one from its own clock. Nothing here reads the time.
export type NextTurnState = 'warm' | 'cold' | 'range';

// One line of the disclosed working. Plain text where nothing in it moves, and the split form
// where an age sits inside it. The panel rewords ages from a ticker of its own, so the age
// goes in where the line is drawn and the words stay here.
export type NextTurnLine = string | { lead: string; at: number; title?: string; trail: string; remaining?: boolean };

export interface NextTurnEntry {
  label: string;
  value?: NextTurnLine;
  lines?: NextTurnLine[];
  separateBefore?: boolean;
}

// The tail of a sentence with a length of time inside it. The panel prints the figure off its
// own clock and rewords it in place every second, so the words are held here and the
// arithmetic is done there, the way a popover line carrying an age already works.
export interface NextTurnSpan {
  lead: string;
  // Which way the panel counts from the moment the lifetime ends: what is left of it, or how
  // long ago it ran out.
  count: 'left' | 'since';
  // The whole lifetime the figure is measured against, as a native tooltip on the figure. The
  // total is a detail, and what is left of it is the headline.
  title: string;
  // The same sentence at the uncertain boundary, split around the wording that replaces the
  // duration. The panel swaps these values into the existing nodes without choosing words.
  near: { lead: string; value: string; trail: string };
  trail: string;
}

export type NextTurnWords = string | NextTurnSpan;

export interface NextTurnFace {
  state: NextTurnState;
  // The words before the price, which are ordinary text. Only the price is pressable, so the
  // line reads as a sentence and not as a second Send.
  lead: string;
  // The figure the reader presses. This is always one conservative starting price.
  price: string;
  // The words after it, split wherever a length of time sits inside them.
  trail: NextTurnWords;
  // The model cache lifetime behind the cache status, if the pricing row records one.
  statusTitle: string | null;
  // This working is intentionally read in one column. Other stat popovers retain their
  // compact label-and-value grid.
  layout: 'stacked';
  entries: NextTurnEntry[];
  footer: string[];
}

export interface ComposerNextTurn {
  // The word saying that a press discloses the working.
  disclosure: string;
  // When the cache is treated as cold. The panel calls it cold before the nominal lifetime
  // ends, so the visible price stays conservative.
  coldAt: number | null;
  // Whether a compaction replaced the session after the last request. Nothing has cached
  // the replacement, so the next request writes it again whatever the clock says. It is a
  // separate fact from the boundary because there is no boundary here: no lifetime ran out.
  afterCompaction: boolean;
  // How early the panel calls a cache cold to cover the recorded request clock error.
  tolerance: number;
  // The span either side of the boundary where the compact formatter would only say two
  // minutes. The line names that uncertainty instead of presenting it as a duration.
  nearBoundary: number;
  warm: NextTurnFace | null;
  cold: NextTurnFace | null;
}

const TIER_WORDS: Record<CacheTier, { bought: string; noun: string; window: string }> = {
  '1h': { bought: '1 hour', noun: 'hour', window: 'the last hour' },
  '30m': { bought: '30 minutes', noun: '30 minutes', window: 'the last 30 minutes' },
  '5m': { bought: '5 minutes', noun: '5 minutes', window: 'the last 5 minutes' },
};

// The word saying a press shows the working. It rides the accessible name as well as the line,
// because a reader who cannot see it is otherwise told the figure and never told it can be
// opened.
const NEXT_TURN_DISCLOSURE = 'Details';

// The words that open every face. The price follows them and the state follows the price,
// because the price is the answer and the state is the reason for it.
const NEXT_TURN_LEAD = 'Next turn starts at ';

const NEXT_TURN_FOOTER = ['Conservative API list-price estimates. Actual charges can differ.'];

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
      footer: NEXT_TURN_FOOTER,
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
        footer: NEXT_TURN_FOOTER,
      },
    };
  }
  const lifetime = `${shortModel(basis.model) ?? 'Model'} cache lifetime: ${tier.bought}`;
  const warm: NextTurnFace = {
    state: 'warm',
    lead: NEXT_TURN_LEAD,
    price: warmMoney,
    statusTitle,
    // Each request starts the lifetime again at no cost, so what is left of it is the one
    // thing the reader is deciding against: how long they can leave the session before
    // answering it costs the write rate instead of the read rate.
    trail: {
      lead: ', cached for another ',
      count: 'left',
      title: lifetime,
      near: { lead: ', cached for under ', value: '2m', trail: '' },
      trail: '',
    },
    layout: 'stacked',
    entries: [...(warmMoney === coldMoney ? [] : [{ label: 'Cost if cache were cold', value: coldMoney }])],
    footer: NEXT_TURN_FOOTER,
  };
  const cold: NextTurnFace = {
    state: 'cold',
    lead: NEXT_TURN_LEAD,
    price: coldMoney,
    trail: ', uncached',
    statusTitle,
    layout: 'stacked',
    entries: [...(warmMoney === coldMoney ? [] : [{ label: 'Cost if cache were warm', value: warmMoney }])],
    footer: NEXT_TURN_FOOTER,
  };
  return { warm, cold };
}

interface ProspectiveNextTurn {
  basis: NextTurnBasis;
  coldOnly: 'model-change' | null;
}

// The recorded context remains the evidence for the next request. A selected model changes
// only the facts that belong to that model: its exact pricing identity, advertised window,
// and cache state. The previous model's cache cannot make the selected model warm.
export function prospectiveNextTurn(state: ComposerState): ProspectiveNextTurn | null {
  const basis = state.nextTurn;
  if (!basis) {
    return null;
  }
  const selected = chosenModel(state.models, state.settings.selectedModel);
  if (!selected) {
    return { basis, coldOnly: null };
  }
  if (selected.resolvedModel) {
    // A resolved model id names the exact priced model the pick runs, so it is compared
    // against what the last request ran instead of going through the alias search below.
    // That search fails a pick like `default` (`modelRan` never returns it) and a pick
    // whose alias text is a substring of more than one listed alias inside the recorded id,
    // for example `opus`, `claude-opus-5`, and `opus[1m]` all occurring inside
    // `claude-opus-5-5`. The comparison is an exact match on the normalized id, never a
    // substring check: `claude-opus-5` must not read as unchanged after a `claude-opus-5-5`
    // request, and `gpt-5.6` must not read as unchanged after `gpt-5.6-luna`, because those
    // are distinct priced models. Two dated snapshots of one model must also carry the same
    // date: `claude-sonnet-4-5-20250929` and `claude-sonnet-4-5-20251201` normalize to the
    // same base id, but they are still two different snapshots, so a real snapshot switch
    // reads cold. A dated id still matches an undated alias of the same model, since a live
    // CLI alias resolves to a dated id that a recorded transcript may carry no date for. The
    // transcript never records the CLI's `[1m]` window suffix, so a `[1m]` pick that resolves
    // to the same base model and snapshot date as the last request reads warm here, same as
    // any other pick of that model would.
    const pickedId = normalizeModelIdentity(selected.resolvedModel);
    const recordedId = normalizeModelIdentity(basis.model);
    const pickedDate = snapshotDateOf(selected.resolvedModel);
    const recordedDate = snapshotDateOf(basis.model);
    const sameSnapshot = pickedDate === null || recordedDate === null || pickedDate === recordedDate;
    if (pickedId !== '' && pickedId === recordedId && sameSnapshot) {
      return { basis, coldOnly: null };
    }
  } else {
    const recorded = modelRan(state.models, basis.model);
    if (recorded?.value === selected.value) {
      return { basis, coldOnly: null };
    }
  }
  const model = selected.resolvedModel ?? selected.value;
  return {
    basis: {
      ...basis,
      model,
      window: contextWindowFor(model, basis.provider),
      tier: null,
      readBack: false,
    },
    coldOnly: 'model-change',
  };
}

// Nothing at all where the session has no context figure or no priced model. An absent
// line is the right answer there, and a line reading `unknown` is not.
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
    tier: basis.afterCompaction || coldOnly !== null ? null : basis.tier,
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

// Which face the clock says. The cold face starts before the nominal lifetime ends, because the
// transcript clock can trail the actual request by ninety seconds.
//
// A compaction is the exception the clock cannot answer. Nothing has cached the session
// it wrote, so the next request writes it again from the moment the compaction lands, and the
// state is cold at every clock rather than at one after a boundary.
//
// `webview/composer-presentation.ts` keeps a copy of this. The face has to move on the second the clock does, from a
// clock only the browser holds, and asking the extension would arrive a round trip late once a
// minute for as long as the panel is open. `panel.webview.test.ts` runs the two together.
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
  // The bands are the context chip's, taken off `bandForPercent` rather than written again.
  // The panel keeps one vocabulary for a window getting full, and a scale of its own here
  // would be a second thing to learn for the same warning.
  const band = bandForPercent(percent);
  const compact = compactCommand(agent);
  const said = `${percent}% of the context window used${band ? `, ${band.word}` : ''}`;
  return {
    percent,
    fill: Math.max(0, Math.min(100, percent)),
    level: band ? band.level : null,
    // The hover says both halves when the figure is pressable, because the eye sees a
    // percentage and nothing about it says it can be pressed.
    name: compact ? `${said}. Press to compact this session.` : said,
    compact,
    compactName: compact ? `Compact this session. ${said}.` : '',
  };
}

// Text that has to sit beside other text in one spoken line, so a sentence that came without
// a full stop is given one and a sentence that came with one is left alone.
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// What one row says to a reader who cannot see it. It carries every part the row shows: the
// label, the agent's own sentence under it, and whether this is what the session is set to
// now.
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

// One row, from whichever of the three tables it came out of. A mode, a model and an effort
// level all carry the same three words, so a row is assembled once rather than per control.
function menuItem(choice: { value: string; label: string; description: string }, checked: boolean): MenuItem {
  // Every row this builder makes is one of a set the reader picks exactly one of, and none of
  // them is a caution: the server rows are the only toggles that carry that tone, and they are
  // built in `mcpview.ts`, which is where the other kind is set.
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

// Why the model menu has nothing to offer. The reader is told who has not answered rather
// than shown a box with nothing in it.
function modelEmpty(name: string): string {
  return `${name} has not said yet which models it runs.`;
}

// Why the effort menu has nothing to offer, which is two different reasons: the model takes
// no effort setting, or there is no model yet for it to be the setting of.
function effortEmpty(model: ModelChoice | null, name: string): string {
  return model
    ? `${model.label} takes no effort setting.`
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
    // No row here is a caution: which model answers is a different question from how much it
    // asks before it acts, and none of these widens anything.
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
  // Ticked by what the next turn will run at: the reader's level where they set one, and
  // otherwise the level the last turn recorded itself running at. A menu that ticked nothing
  // over a session visibly running at high says the setting is unset when it is not.
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
    // The question is about the model, so it names the model. A menu opened with none settled
    // on has no name to use and asks about the model the reader has yet to pick.
    head: `How much should ${model ? model.label : 'the model'} work on a turn?`,
    items: efforts.map((effort) => menuItem(effort, effort === chosen)),
    empty: efforts.length === 0 ? effortEmpty(model, name) : '',
  };
}

// Built from an agent and a stored value rather than from the state, because a draft asks
// this question about the agent in its profile while a live session asks it about the
// agent it is running.
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
    // No row here is a caution: every mode is a setting the reader chose, not a warning.
    items: permissionModes(agent).map((mode) => menuItem(mode, mode === chosen)),
    // Every agent has a table and an unknown one is lent Claude's, so this menu never opens
    // on nothing and has no line to say when it does.
    empty: '',
  };
}

// A draft's menus are built from its profile and from nothing else.
//
// The reader's live picks and the agent's stored ask level both belong to a session with a
// child behind it. Read here, each one would answer with the source session's setup, and
// picking a row would change that session rather than the draft in front of the reader.

// Which agent starts the draft. The choice exists on a draft alone: a session with a
// child behind it is that agent's session and cannot become another agent's.
function draftAgentMenu(state: ComposerState, profile: SessionProfile): Menu {
  return {
    control: 'agent',
    agent: profile.agent,
    session: state.sessionId,
    head: 'Which agent should start this draft?',
    // No sentence under either name. Neither CLI publishes one about itself, and a line
    // written here would be this panel's claim about another product.
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
    // Ticked by value rather than by identity, because the default row is written here and
    // is in no agent's catalog to be identical to.
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
    // The same question a live session asks, and asked of the draft's own model. The rows
    // come from the profile rather than from the state beside it, whose model and levels
    // belong to a child this draft has not started.
    head: `How much should ${model ? model.label : 'the model'} work on a turn?`,
    items: rows.map((effort) => menuItem(effort, effort.value === at)),
    empty: rows.length === 0 ? effortEmpty(model, name) : '',
  };
}

// The menu one control opens, or nothing at all for a control this version does not draw and
// for a window with no session to open it from. The popover is handed a finished menu
// the same way the row is handed finished picks.
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
  // The servers menu is built whole in `mcpview.ts`, rows and head and all. It answers with
  // nothing for an agent that has no servers, which is the same answer this function gives
  // for a control it does not draw, so the two arrive at the popover as one case.
  if (control === 'mcp') {
    const menu = mcpMenu(state.mcpServers, state.agent, name);
    return menu ? { ...menu, session: state.sessionId } : null;
  }
  return null;
}

// A control is drawn unpressable exactly when the menu behind it has no rows, and every pick
// below reads that off the menu itself rather than working the same condition out a second
// time. A button that opens on nothing and a button that refuses a menu it has choices for
// are both worse than either alone, and both are what two copies of one condition drift into.
function modelPick(state: ComposerState, name: string): ComposerPick {
  const selected = state.settings.selectedModel;
  const chosen = chosenModel(state.models, selected);
  // What the session is on, in order of what the panel actually knows: the reader's
  // pick; then the model the last turn recorded, named by the list where the list names it
  // and by its own shortened id where it does not; then a stored pick no list can name; and
  // only then the word "default".
  //
  // Reading the transcript is what stops the row saying "Default model" over a session
  // the reader can see running Opus. It is a reading rather than a pick, and both the name
  // and the hover say so, because the two are not the same claim.
  //
  // Written with `||` rather than `??` because a pick nobody has made arrives as the empty
  // string, not as nothing: `pickedModel` answers '' for a reader who has never opened the
  // menu. `??` steps over the empty string and the control is drawn with no words in it.
  const pending = modelPending(state);
  const confirmedChoice = recordedModel(state);
  const readConfirmed = !selected || (!pending && state.settings.pendingModel !== null);
  const running = readConfirmed ? confirmedChoice : null;
  const recorded = readConfirmed ? (shortModel(state.settings.confirmedModel) ?? '') : '';
  // The reader's own pick comes before anything read off a transcript. A pick outlives a
  // reload while the model list does not, so a stored pick with no list to name it was being
  // drawn over by whatever the last turn happened to run on.
  const baseLabel =
    (readConfirmed ? running?.label || recorded : chosen?.label || selected) ||
    modelLabel(state.models, selected, state.defaults);
  const projected = modelPicks(state.models, state.defaults, true).find(
    (item) => item.aliases.includes(selected) || item.identity === (running?.resolvedModel || running?.value),
  );
  const label = projected?.configuredDefault ? projected.label : baseLabel;
  const menu = modelMenu(state, name);
  const waiting = menu.items.length === 0;
  // Read off the last turn only where nothing has been picked. Said over a stored pick, the
  // hover told the reader nothing was chosen while naming a model the next turn will not run
  // on, and both halves were false.
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
    // Which model answers is not a question that can go wrong in the way a fallen-over
    // server can, so no model control is ever toned.
    caution: false,
  };
}

function effortPick(state: ComposerState, name: string): ComposerPick {
  const model = settledModel(state);
  const menu = effortMenu(state, name);
  if (!model || menu.items.length === 0) {
    return {
      control: 'effort',
      label: NO_EFFORT_LABEL,
      name: `Effort: none to set. ${menu.empty}`,
      detail: menu.empty,
      disabled: true,
      caution: false,
    };
  }
  const chosen = menu.items.find((item) => item.checked);
  // `||` for the same reason the model control uses it: an unset effort arrives as ''.
  const pending = effortPending(state);
  const read =
    (!state.settings.selectedEffort || (!pending && state.settings.pendingEffort !== null)) &&
    Boolean(state.settings.confirmedEffort);
  const label = read
    ? menu.items.find((item) => item.value === state.settings.confirmedEffort)?.label ||
      state.settings.confirmedEffort ||
      DEFAULT_EFFORT_LABEL
    : chosen?.label || state.settings.selectedEffort || DEFAULT_EFFORT_LABEL;
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
  // The head is the question, the label is what the control is set to, and the mode's own
  // sentence sits with that setting so a reader who cannot see the hover still hears what
  // the mode runs without asking.
  const description = mode.description ? ` ${sentence(mode.description)}` : '';
  return {
    control: 'askmode',
    label: mode.label,
    name: `${menu.head} ${mode.label}.${description} Press to change it.`,
    detail: mode.description || menu.head,
    disabled: menu.items.length === 0,
    // No row of the menu behind this control is a caution: every ask mode is a setting the
    // reader chose, not a warning, so the button that shows the current one is never toned.
    caution: false,
  };
}

// The servers control, or nothing at all for an agent with no servers to show. Both answers
// come from `mcpPick`, which writes every word of it, and this only carries them onto the row
// in the shape the other three controls arrive in.
//
// Never drawn unpressable, unlike the model and effort controls. Those two are always on the
// row and go grey when there is nothing behind them, because a row whose positions moved
// about would move the settings the reader was reaching for. This one is on the row only when
// there is something behind it, so there is no state in which it is drawn with an empty menu.
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

// What the box says while it is empty.
//
// While a turn runs it says what will happen to the prompt, because that is the one moment
// the answer is not obvious: the reader is watching the agent work and the button beside
// them says Stop. Whether the agent takes it now or the panel holds it is the whole of the
// difference, and it is said in the agent's own name rather than in the panel's terms.
//
// The idle box names the slash key, because a menu nothing points at is one the reader has
// to already know about. It says it only where a command is available, whether the agent
// published it or the panel implements it through an equivalent protocol call.
// The walk back through earlier prompts is not named here. A second clause runs past what a
// narrow sidebar draws, and an empty box has nothing to scroll, so the reader cannot reach
// the rest of the line. Up is the key every shell and both agent CLIs already use for it.
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

// How the box is sent and how a new line is made. Written once here, because a panel that
// wrote its own copy would be the second place this key press is described.
const SEND_HINT = 'Enter sends, Shift and Enter for a new line';

const SEND_LABEL = 'Send';
const STOP_LABEL = 'Stop';

// A prompt, or a note, cut to the one line a control's name can carry. This is `noteName`'s
// rule exactly: the reader's own words run together and shortened. It is called rather than
// copied because the cut is the part that goes wrong, and `shortenTo` inside it is the one
// place that keeps half a character out of a spoken name.
function oneLine(text: string): string {
  return noteName({ note: text });
}

// Which agents hold a prompt of their own that arrives during a turn.
//
// Both do, and both were measured against a real child rather than read. A prompt sent well
// into a running turn drew no error from either, and both answered the running turn first
// and the new one after it, in order. So the panel holding that prompt back was a second
// queue in front of a queue that already works, and every fault in the panel's own was a
// prompt the agent would have taken.
//
// The two report it differently, and only one of them ends a turn per answer. Claude sends a
// `turnEnd` after each: two prompts, two ends. Codex sends one after the last answer, so a
// second prompt keeps the session busy through both rather than closing and reopening.
// Nothing here reads that, and it is written down because a reader counting ends against
// answers will find them equal on one agent and not on the other.
//
// An agent not listed here keeps the panel's queue, which is the answer that cannot lose a
// prompt to a server that refuses it. Measure before adding one.
const TAKES_MIDTURN_PROMPT: Record<string, boolean> = { claude: true, codex: true };

export function takesMidTurnPrompt(agent: string): boolean {
  return own(TAKES_MIDTURN_PROMPT, agent) === true;
}

export function turnEndCompletesEveryPrompt(agent: string): boolean {
  return agent === 'codex';
}

// What a press on Send, or an Enter, actually means.
//
// A blank draft with nothing waiting to go with it sends nothing, a running turn included.
// Without that an Enter hit by accident while a turn runs puts an empty prompt in the queue,
// and the reader finds out when the turn ends and the agent is asked nothing. A blank draft
// with comments on the session's cards is a prompt, and the branch below says why.
export type SendMeaning = 'send' | 'queue' | 'nothing';

export function sendAction(state: ComposerState): SendMeaning {
  const typed = state.onScreen.trim();
  // Codex accepts another prompt during a model turn, but its manual compaction turn is not
  // steerable. The live press distinguishes those two kinds of running work.
  const compacting =
    state.agent === 'codex' &&
    state.live.some((press) => (press.kind === 'compact' || press.kind === 'clear') && !press.failed);
  const takesNow =
    !state.clearing &&
    ((!state.running && !state.queued.length) ||
      (state.running &&
        takesMidTurnPrompt(state.agent) &&
        !compacting &&
        (state.agent !== 'codex' || !state.queued.length)));
  // Comments on their own are a prompt. The reader marked the lines they want answered, and
  // `promptToSend` has always built a prompt out of those alone, so refusing an empty box left
  // the one thing the marks are for unreachable from the control that sends them.
  //
  // A comments-only submission behind Codex compaction is represented in the queue without
  // copying the comments. They remain visible and attached until the queue drains.
  const files = state.assets?.length ?? 0;
  if (!typed) {
    if (!commentsForActiveSubmission(state).length && !files) {
      return 'nothing';
    }
    return takesNow ? 'send' : 'queue';
  }
  return takesNow ? 'send' : 'queue';
}

// What one press on the composer's action button does with what the box holds. `sendAction`
// answers the first three and `compactAction` the fourth, and the button is the same button.
export type PressMeaning = SendMeaning | 'compact' | 'clear';

// Which of a session's waiting requests one press on that button answers.
//
// A prompt that goes now, a prompt that joins the local queue, and a compaction all free the
// child. A request holds every one of them behind it: the queue drains when the running turn
// ends, a turn blocked on a request never ends, and a compaction is a control turn the child
// cannot reach while it waits to be answered. Left open, each one waits for ever behind the
// request it was meant to replace, with nothing on screen saying why.
//
// A press that leaves what was typed in the box answers nothing, because nothing went.
export function asksAnsweredBySend<T>(meant: PressMeaning, waiting: readonly T[]): readonly T[] {
  return meant === 'nothing' ? [] : waiting;
}

// The comments that ride out with the next prompt, so the caller knows what to take away
// once it has gone. One session's, through `commentsFor`, which is the only way into the
// notes for the reason it states.
//
// A comment that has gone out is gone. It was said and the agent has it, and a card still
// drawing it would leave the reader working out which of their own marks are outstanding. So
// sending takes them, and nothing has to remember which were sent.
export function attachedComments(state: ComposerState): TurnComment[] {
  return commentsFor(state.comments, state.sessionId);
}

// Comments available to the active box. Waiting records keep their claims while Claude
// accepts a later prompt through its own mid-turn queue.
export function commentsForActiveSubmission(state: ComposerState): TurnComment[] {
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

// What is left of the reader's comments once a prompt has been handed to an agent.
//
// A comment goes only when the prompt carrying it went. The handoff ends without sending
// anything at all on three ordinary paths: no folder is open, the agent's path is wrong, or
// the session it would have resumed has exited. On each of those the reader still needs
// what they wrote, and taking it would destroy the one thing on this panel typed by hand.
//
// The set that went is passed in rather than read again here. A comment written while the
// prompt was on its way was not in it, and re-reading would take that one too.
export function commentsAfterSend(
  comments: readonly TurnComment[],
  carried: readonly TurnComment[],
  delivered: boolean,
): TurnComment[] {
  if (!delivered) {
    return [...comments];
  }
  const gone = new Set(carried.map((c) => c.id));
  return comments.filter((c) => !gone.has(c.id));
}

// The text that goes to the agent: the reader's prompt, with the attached comments under it.
//
// `emitComments` builds the notes, rather than a second assembler here. This one assembler
// builds the send, the queued row's copy and the live card, so all three read the same to the
// agent and the ordering rules live in one place.
//
// A prompt with nothing attached is handed back exactly as it was typed: no heading, no
// separator and no empty section, because the agent reads all three as something the reader
// meant.
export function promptToSend(state: ComposerState, now?: number): string {
  const prompt = state.draft.trim();
  // `emitComments` takes the whole set and picks the session out of it, so one assembler
  // builds both the paste and the prompt.
  const notes = emitComments(commentsForActiveSubmission(state), state.sessionId, now);
  if (!notes) {
    return prompt;
  }
  return prompt ? `${prompt}\n\n${notes}` : notes;
}

// How many earlier prompts one session offers, and how much text they add up to.
//
// Both caps are on the message rather than on the walk. The list rides the composer view,
// which is posted whenever anything around the box changes, so a session whose prompts
// are whole documents would otherwise send every one of them on every repaint. A reader who
// wants something older than this walks past what an arrow key is for.
export const PROMPT_HISTORY_LIMIT = 20;
export const PROMPT_HISTORY_CHARS = 20_000;
// And how much of one the walk reads out. Long enough to tell two prompts apart, short
// enough that a reader hears where they are rather than the prompt itself.
// The prompts one session has already sent, newest first, kept in the order this panel
// sent them.
//
// The newest is dropped rather than repeated. A reader who sends the same words twice wants
// one entry to walk back to, not two presses that land on the same line.
export function sentAfter(held: readonly string[], text: string, limit: number = PROMPT_HISTORY_LIMIT): string[] {
  const one = text.trim();
  const key = cleanPrompt(one);
  if (!one || !key) {
    return [...held];
  }
  // The same words sent again keep one place, and it is the newest. Two entries cost the
  // reader a press that lands where they already are. They also part this list from the
  // record, which drops a repeat the same way, and the two are matched against each other
  // in order: one list holding a prompt twice while the other holds it once pairs every
  // prompt behind it with the wrong record.
  //
  // Told apart by the cleaned key, which is the rule the record drops its own repeat by. Two
  // texts differing only in spacing or in a tag-shaped word are one prompt to the record.
  return [one, ...held.filter((word) => cleanPrompt(word) !== key)].slice(0, limit);
}

// Whether a recorded prompt carries a generated comments block under a sent prompt: the sent
// prompt, a blank line, and a block whose first line looks like a turn heading.
function carriesComments(key: string, own: string): boolean {
  return key.startsWith(`${own}\n\n`) && looksLikeComments(key.slice(own.length + 2));
}

// Whether one recorded prompt is a send this panel made. Either the prompt alone, or the
// prompt with a comments block under it. Nothing looser: an opening line that matches a
// short prompt such as `continue` belongs to a different prompt, and a looser rule takes that
// prompt out of the walk with nothing on screen to say why. `promptHistory` and
// `prunedSentPrompts` both compare through this, so the two agree on which recorded prompt is
// which send.
function sameSend(key: string, own: { key: string }): boolean {
  return key === own.key || carriesComments(key, own.key);
}

// The saved sent prompts with every one the transcript has now recorded taken out.
//
// A prompt joins `sentPrompts` before any process has written it down, and stays there until
// the transcript catches up. Once a session's own transcript-read prompts hold the same
// prompt, the transcript is the durable copy, so the saved entry is redundant. Matched
// through `sameSend`, the same rule `promptHistory` pairs a send with its record by, so a
// prompt sent with comments attached is recognized as recorded here too. A session left with
// nothing kept takes no place in the answer, the way a session with nothing sent takes none
// in the input.
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

// The sent prompts as they belong in storage: normalized, and with every one the transcript
// has now recorded pruned out. `writeDrafts` and the transcript catch-up site in
// `panelhost.ts` both save through this, so the saved copy never holds a prompt the
// transcript can supply on its own.
export function sentPromptsToSave(
  sent: Readonly<Record<string, readonly string[]>>,
  recorded: ReadonlyMap<string, readonly string[]>,
): Record<string, string[]> {
  return normalizeSentPrompts(prunedSentPrompts(sent, recorded));
}

// What the reader typed in one recorded turn, newest first.
//
// Ordered by when each was typed rather than by which list it came from. `prompts` is a list
// because a turn that got no response of its own is carried into the next one, whose recorded
// prompt then holds both. That carried turn contributes its own mid-turn prompts as well, and
// those are older than the prompt that carried it, so a rule putting one list wholly ahead of
// the other hands back the prompt before the newest one.
export function askedInTurn(
  prompts: readonly { text: string; at: number }[],
  laterPrompts: readonly { text: string; at: number }[],
): string[] {
  return [...prompts, ...laterPrompts]
    .map((one, order) => ({ one, order }))
    .sort((a, b) => b.one.at - a.one.at || b.order - a.order)
    .map(({ one }) => one.text);
}

// The prompts one session offers the Up arrow, newest first.
//
// Two sources. `sent` is what this panel handed over and the transcript does not hold yet.
// Claude Code writes a queued prompt to the file when the agent picks it up, up to a minute
// after it goes, and recalling the prompt just sent is the commonest press there is.
// `recorded` is what the transcript holds, which outlives the window and carries work
// started in a terminal.
//
// The two are compared through `cleanPrompt`, which is what wrote the recorded copy. It
// collapses runs of spaces and strips tag-shaped words, so the recorded text of a prompt is
// rarely the text that was sent. Compared raw, the same prompt appears twice.
//
// A prompt sent with comments attached is recorded as the typed text with the comments on
// the lines beneath it. That record is offered as its sent original, so the box gets back
// the reader's own words rather than the assembled prompt.
//
// The record decides the order wherever it holds the send at all, so a prompt typed in a
// terminal after one sent from this panel is still offered first. Only a send the record has
// not caught up with goes in front of everything, which is where it belongs: it is the newest
// thing this session has.
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
  // Which recorded prompt each send is. Matched oldest first up both lists at once, because
  // the record catches up in the order the prompts went. So the sends it has not reached yet
  // are the newest ones, and a prompt sent twice takes the older record for its first send.
  //
  // Matching on the text alone put the second send at the first send's place, and the press
  // that asks for the prompt just sent walked past it into the middle of the list.
  //
  // A send the record does not hold is passed over rather than stopped at. The record holds
  // only its own newest, and drops a prompt too big to offer, so the oldest sends of a long
  // window are missing from it. Stopping there put every send in front of work started in a
  // terminal since. Only the sends newer than every one the record does hold are ahead of it.
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
    // A submission with an empty box sends the reader's comments alone, and the transcript
    // records that assembled document as the prompt. The reader typed none of it, so the
    // walk does not offer it back.
    if (looksLikeComments(key)) {
      return;
    }
    // Nor the assembled form of a prompt this panel sent. One send with comments attached is
    // matched above and offered as the words the reader typed. A second send of the same
    // words leaves the first record with nothing to pair with, and offered raw it puts the
    // reader's own notes markup in the box.
    if (mine.some((own) => carriesComments(key, own.key))) {
      return;
    }
    older.push({ text, key });
  });
  const kept: string[] = [];
  const seen = new Set<string>();
  let spent = 0;
  // The sends the record has not caught up with, newest first, then everything the record
  // holds in the order it holds it.
  for (const one of [...mine.slice(0, ahead), ...older]) {
    if (seen.has(one.key)) {
      continue;
    }
    if (kept.length >= limit) {
      break;
    }
    // A prompt too big to share the message is left out of the walk altogether. The reader
    // pasted a document and still has what they pasted from, and one of these admitted first
    // spends the whole budget and puts every prompt behind it out of reach.
    if (one.text.length > entry) {
      continue;
    }
    // Passed over rather than stopped at, for the same reason.
    if (spent + one.text.length > chars) {
      continue;
    }
    seen.add(one.key);
    kept.push(one.text);
    spent += one.text.length;
  }
  return kept;
}

// One session's recorded prompts as the reader walks over the turns, newest first.
//
// Stopped once there are enough of them, because the caller reads every turn in the
// workspace and a long-running session offers far more than an arrow key reaches.
// Blanks and repeats are dropped here rather than left to `promptHistory`. A session
// spends this limit on the turns it has, so a reader who sends `continue` over and over would
// give one word every place in it while older prompts fell outside. Codex records a turn with
// no prompt at all when the reader only pressed a control.
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
    // The size test is here as well as in `promptHistory`, or a session of pasted
    // documents fills every place with prompts the walk then throws away. The reader presses
    // Up on a full session and is told there is no earlier prompt.
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

// How many attached comments the chip's hover names one by one.
//
// The hover is there so a reader can tell before sending whether these are the three they
// meant. It is not a second reading of the comments, and one that runs longer than the panel
// is tall covers the box it hangs off. A reader with forty is checking the count rather than
// the list, so everything past this many is summed into a last line.
export const ATTACHED_DETAIL_ROWS = 5;

// What the chip counts, in the words the reader sees.
function attachedLabel(count: number): string {
  return `${count} ${count === 1 ? 'comment' : 'comments'}`;
}

// The chip, or nothing at all when the session has no comments on it. Nothing is drawn
// rather than a chip reading zero: a control saying that nothing is attached is a control
// about nothing.
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
    // A reader who cannot see the chip is told what a reader who can see it works out by
    // watching: the comments go out and the marks on the cards go with them.
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
  return `${name || 'The file'} could not be read.`;
}

export function attachmentFailureNotice(error: unknown, name: string = ''): string {
  const busy = attachmentRefusal('busy');
  return error instanceof Error && error.message === busy ? busy : attachmentRefusal('read', name);
}

// The three words on a waiting card's controls. Words rather than glyphs, which is what the
// rest of the panel's controls use: a glyph needs a legend and these three do not.
const QUEUE_EDIT = 'Edit';
const QUEUE_COPY = 'Copy';
const QUEUE_DROP = 'Drop';

// Queue one explicit submission and bind the comments that press owns. Comments already
// claimed by an earlier waiting submission stay there, while an empty press with no new
// comments adds nothing.
export function queueSubmissionAfter(
  queued: readonly QueuedSubmission[],
  id: string,
  text: string,
  commentIds: readonly string[],
  assets: readonly StoredPromptAsset[],
  at: number,
  heldForClear = false,
  ownership?: { agent: string; owner: string },
): QueuedSubmission[] {
  if (queued.length >= QUEUED_SUBMISSION_LIMIT || text.trim().length > DRAFT_TEXT_LIMIT) {
    return [...queued];
  }
  const claimed = new Set(queued.flatMap((entry) => entry.commentIds));
  const own = commentIds.filter((id) => !claimed.has(id));
  const one = text.trim();
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
  return one || own.length || assets.length
    ? [
        ...queued,
        {
          id,
          text: one,
          commentIds: own,
          assets: assets.map((asset) => ({ ...asset })),
          at,
          delivery,
        },
      ]
    : [...queued];
}

// Comments carried by the next waiting submission. Its explicitly bound comments remain
// its own, comments bound later stay out, and newly added unclaimed comments retain the
// established behavior of riding with the next submission. A reset can move an explicit
// claim across sessions. Its delivery copy takes the successor identity so prompt assembly
// includes it without changing the comment stored on the source turn.
export function commentsForQueuedSubmission(
  state: ComposerState,
  next: QueuedSubmission,
  later: readonly QueuedSubmission[],
): TurnComment[] {
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

// One row of the queue: a reminder of what is waiting, and the whole prompt behind it.
//
// The row is shut to one line because a queue of several paragraphs would push the box off
// the panel. It opens because the reader cannot read the prompt anywhere else: sending it
// cleared the box, and until the turn ends this row is the only copy on screen.
function queuedPrompt(state: ComposerState, entry: QueuedSubmission, name: string, now: number): QueuedPrompt {
  const text = entry.text.trim();
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
    text ||
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

// The queue with one more prompt at the end, or the queue unchanged. Whitespace is dropped
// and an empty prompt is refused, so nothing the agent would be asked to answer is blank.
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

// The prompt one card names, or nothing where that card has gone. Named by the stable id the
// same rule `queueWithout` uses, so one answer decides which card is which and a
// press that arrives after a repaint cannot reach the prompt beside the one it meant.
export function queuedText(queued: readonly QueuedSubmission[], id: string): string | null {
  const found = queued.find((entry) => entry.id === id);
  return found === undefined ? null : found.text;
}

export function queuedSubmission(queued: readonly QueuedSubmission[], id: string): QueuedSubmission | null {
  return queued.find((entry) => entry.id === id) ?? null;
}

// The queue with one prompt taken out, named the way the row that draws it is named.
export function queueWithout(queued: readonly QueuedSubmission[], id: string): QueuedSubmission[] {
  return queued.filter((entry) => entry.id !== id);
}

// A prompt queued during a clear cannot return to the source session until the reader
// resolves that clear. Editing or dropping the clear is that decision.
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

// Taking a waiting prompt back into the box to change it, and what happens to the prompt the
// box was already holding.
//
// The two swap. The named prompt leaves the queue for the box, and what the box held takes
// the place it left, keeping its position so the order the reader queued things in survives.
// Overwriting the box instead destroyed whatever was typed there, with no undo and nothing
// on screen to say it had gone: a reader editing a second waiting prompt lost the first one
// outright, because it had already left the queue.
//
// A box with nothing in it puts nothing back, so the named prompt simply leaves.
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
    text: text.trim(),
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

// One press the panel has not seen the end of yet.
//
// Between the press and the reply the panel said nothing. The box emptied, the prompt went
// to a child, and the screen did not change until the transcript poll read the reader's own
// words back off disk seconds later. A compaction was worse: it drew nothing at any point
// until its card arrived off the transcript, which is a whole session's work with no
// sign that anything was asked for.
//
// This is what the panel holds in that gap. It is recorded at the press rather than at the
// round trip, so the card is on screen in the same frame as the keystroke.
export interface LivePress extends PendingAskPosition {
  // The session, and never the agent. One agent runs several sessions at once, so
  // a press filed under the agent draws its card over whichever of them the reader happens
  // to be looking at. This is the fault `runningKey` exists for.
  sessionId: string;
  agent: AgentKind;
  kind: LiveKind;
  // Exactly what went to the agent, which is what `promptToSend` built and never what the
  // box held. Comments alone are a prompt, so a card drawn from the box draws nothing at all
  // for the press that sends three comments and an empty box. Empty for a compaction, which
  // carries none of the reader's words.
  text: string;
  assets?: StoredPromptAsset[];
  // The panel's own clock at the press. The elapsed figure counts from it, and the real turn
  // is matched against it.
  at: number;
  // The tail of the reply as it is written, joined from the chunks both agents stream. Only
  // the tail: the card shows where the reply has got to, and a whole turn's output held to
  // draw one line of it is a transcript the panel already has a reader for.
  reply: string;
  // Whether a turn was already running in this session when the press was made. Such a
  // prompt starts no turn of its own: the agent answers it inside the one already going, and
  // that turn's card is where it belongs.
  midTurn: boolean;
  // Whether the agent took the press. The handoff answer sets it and a busy signal does not:
  // a child reports itself busy before it answers, so a press marked from busy would be erased
  // by the rejection that arrived a moment later.
  ran: boolean;
  // Whether the work this press opened has been seen running. Claude can take a prompt sent
  // during its compaction and answer it afterward, so a press can be taken before it begins,
  // and only the one that began carries this.
  started: boolean;
  // Whether the handoff came back without reaching an agent. Until this is set, a prompt
  // that never left looks exactly like one that did.
  failed: boolean;
  // Why it did not go, in words meant for the reader. Empty until a handoff fails.
  reason: string;
}

// What the press was. A prompt carries the reader's words and a compaction carries none, and
// the two are worded apart because a reader who presses the window figure is not sending a
// prompt and must not be told that they are.
export type LiveKind = 'prompt' | 'compact' | 'clear';

// Which of the three things the card says. `sent` is the gap the reader complained about:
// the press has gone and no child has reported itself busy yet.
export type LiveState = 'sent' | 'running' | 'failed';

// Whether the agent will answer this press inside work it is already doing, so the card for
// that work is where it belongs and this press opens none of its own.
//
// Read at the press and never after it, which is why it is settled here rather than at the
// draw: a turn starting a second later must not turn a fresh press into a mid-turn one.
//
// Only a prompt sent into a running turn is one. Two other presses were being called mid-turn
// and neither is:
//
// A prompt Claude accepts while its compaction is running has no card to be folded into. A
// compaction carries none of the reader's words, and the card it becomes carries no prompts.
//
// A compaction pressed while a turn is running is not a prompt at all. It is its own piece of
// work, it becomes a card of its own, and folding it into the running turn drew nothing for
// it either.
export function pressIsMidTurn(
  kind: LiveKind,
  running: boolean,
  inFlight: readonly Pick<LivePress, 'kind' | 'failed'>[],
): boolean {
  if (kind !== 'prompt' || !running) {
    return false;
  }
  // A failed press is not in flight, whatever the panel still holds for it. Nothing sweeps
  // one: `livePressOver` keeps it for the reader to dismiss, so a compaction that never
  // reached an agent sits there until they do. Read as work still going, it would call every
  // later prompt a compaction's neighbour, and each one would draw a card beside the running
  // turn's card that is already carrying it.
  return !inFlight.some((held) => (held.kind === 'compact' || held.kind === 'clear') && !held.failed);
}

// The presses a session is waiting on once a new one is made.
//
// One of each kind and no more. A Claude compaction and a prompt accepted during it are
// separate pieces of work: Claude compacts first and answers the prompt after, so both are
// waited on at once and each says so on a card of its own.
//
// Two prompts are not two pieces of work. The second is answered inside whatever the first
// one started, so it takes the first one's place rather than standing beside it.
export function pressesAfter(held: readonly LivePress[], next: LivePress): LivePress[] {
  return [...held.filter((one) => one.kind !== next.kind), next];
}

// The press whose work has begun, marked while the session is working.
//
// An agent works one thing at a time in a session, so the press that began is the oldest
// one it has taken and not finished. A prompt Claude accepts during compaction waits behind
// it, and marking that one as well retires its card before its own turn begins.
//
// A failed press is neither working nor in the way of the one that is.
export function pressesAfterRunning(held: readonly LivePress[], running: boolean): LivePress[] {
  if (!running) {
    return [...held];
  }
  if (held.some((press) => press.started && !press.failed)) {
    return [...held];
  }
  const begun = held.find((press) => press.ran && !press.started && !press.failed);
  if (!begun) {
    return [...held];
  }
  return held.map((press) => (press === begun ? { ...press, started: true } : press));
}

// The presses left once the agent answers something out of its own head.
//
// A harness control reports a turn with no turn in it: no model was called, no cost was spent,
// and nothing lands in the transcript for the poll to find. `/clear`,
// `/model` and `/context` all end this way, and so does a compaction the agent turns down.
//
// No command the CLI answers by itself leaves a turn for the selected window to accept. A
// harness control writes none, and the recorded answer to any other local command withdraws
// the turn its typed record opened. This explicit exit removes the matching unstarted press
// when the CLI reports that answer.
//
// The oldest press that has not begun is the one that ended, for the reason
// `pressesAfterRunning` gives: an agent works one thing at a time in a session. A press
// already marked as started keeps its card, because a real turn is behind it and the
// transcript owes that card its replacement. A prompt waiting behind a compaction is not the
// one that just ended, and taking its card would take the reader's own words off the screen
// before their turn had begun.
export function pressesAfterLocalAnswer(held: readonly LivePress[]): LivePress[] {
  const ended = held.find((press) => !press.failed && !press.started);
  if (!ended) {
    return [...held];
  }
  return held.filter((press) => !(press === ended && livePressOver(press, null, false, 0, false, true)));
}

// Terminal control sequences, such as the bold a model name is printed in.
const TERMINAL_CONTROL = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

// The Composer message for a command the CLI answered by itself: the first line of its reply,
// without terminal color codes and cut to `firstLine`'s length, because a report such as
// `/context` or `/usage` runs to many lines. Null when the reply is empty, so nothing shows.
export function localAnswerNotice(reply: string): string | null {
  const text = reply.replace(TERMINAL_CONTROL, '').replace(/\r\n?/g, '\n').trim();
  return text ? firstLine(text) : null;
}

// The presses left once the child answers the handoff for one of them.
//
// Busy is not this answer. AgentSession becomes busy before it waits for the CLI, so using
// that signal as acceptance lets an immediate rejection look like a turn that started and
// stopped. The exact press is named because another one can replace it while the answer is
// on its way back.
export function pressesAfterHandoff(held: readonly LivePress[], at: number, delivery: PromptDelivery): LivePress[] {
  return held.map((press) => {
    if (press.at !== at) {
      return press;
    }
    return delivery.delivered
      ? { ...press, ran: true, failed: false, reason: '' }
      : { ...press, ran: false, failed: true, reason: delivery.reason };
  });
}

// Move the accepted press when its prompt landed in a continuation session. Other live
// work in both sessions stays where it is, and the usual one-per-kind rule still decides
// what the target keeps.
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

// The press of one kind a session is waiting on, or nothing when it is waiting on none.
// `pressesAfter` keeps at most one of each, so there is never a second one to choose between.
export function pressOfKind(held: readonly LivePress[], kind: LiveKind): LivePress | null {
  return held.find((one) => one.kind === kind) ?? null;
}

// Which press a chunk of the reply belongs to, or nothing when there is none to write it on.
//
// The newest, which is the press the reader is waiting on. Only a prompt held behind a
// compaction makes this a choice at all, and the words arriving then are the answer the
// reader is watching for rather than a summary they never asked to read.
export function pressForReply(held: readonly LivePress[]): LivePress | null {
  for (let i = held.length - 1; i >= 0; i--) {
    if (!held[i].failed) {
      return held[i];
    }
  }
  return null;
}

// How long a compaction with nothing behind it is drawn for.
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

// Whether the press is finished with, so the card comes down.
//
// A prompt ends when the accepted selected window contains its recorded turn or the CLI answers
// locally. A compaction has its own exits.
//
// A failed press is the reader's to clear and nothing takes it away. It is the one card that
// says something they have to act on, and a notice that removes itself is one they can miss.
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
  // The work this press opened ran and stopped. The reader's own Stop lands here too, and its
  // card goes without a word: a press they cancelled needs no notice.
  //
  // It reads `started` and not `ran`. A compaction can be accepted before it begins.
  if (press.started && !running) {
    return true;
  }
  // A working compaction keeps its card past the limit. Removing it would also hide a prompt
  // sent behind it until the record catches up.
  if (running) {
    return false;
  }
  return now - press.at >= LIVE_PRESS_LIMIT_MS;
}

// How much of the reply is kept.
//
// The card draws one line and clips it against the panel's own edge, so what is held is a
// few lines' worth: enough that the line is full at any width the panel is dragged to, and
// far short of a turn, which runs to tens of thousands of characters.
export const LIVE_REPLY_KEEP = 400;

// How long chunks are gathered for before the card is sent on.
//
// Both agents write faster than anyone reads, and the panel is across a message channel from
// the extension. Sending each chunk as it lands is a message per word for the length of a
// turn, and every one of them redraws a card that is one line long. An eighth of a second is
// below what a reader sees as a pause and it turns a turn's thousands of messages into tens.
export const LIVE_REPLY_POST_MS = 125;

// The reply so far, with the newest chunk on the end and the oldest dropped.
//
// The join is here rather than at the wire because it is the panel's rule about how much of
// a reply a progress indicator is allowed to hold, not a fact about either protocol. Both
// agents stream a piece at a time: Claude a phrase, Codex a word.
export function appendReply(reply: string, chunk: string): string {
  return (reply + chunk).slice(-LIVE_REPLY_KEEP);
}

// Remove a completed commentary message from the provisional reply line. Claude cannot say
// whether streamed text is narration until the message ends, so those chunks initially use
// the reply path. Once the completed message identifies them as commentary, Activity owns
// the text and the temporary response copy must go.
export function replyAfterCommentary(reply: string, commentary: string): string {
  if (!reply || !commentary) {
    return reply;
  }
  const held = commentary.slice(-LIVE_REPLY_KEEP);
  if (commentary.endsWith(reply)) {
    return '';
  }
  return reply.endsWith(held) ? reply.slice(0, -held.length) : reply;
}

// The reply as one line. Whitespace is collapsed for the same reason the reader's own words
// are collapsed: the card is one line, and a reply arriving with its paragraph breaks in it
// would draw a line that is mostly empty space.
function liveReplyLine(reply: string): string {
  return reply.replace(/\s+/g, ' ').trim();
}

// Which state the card is in. `running` is this session's and never its agent's, for the
// reason `sessionRunning` gives.
//
// A reply that has started arriving is a turn running, whatever the child has reported. The
// two signals come by different routes and the streamed one is often first, and a card that
// said it was still sending while the answer was being written on it would be wrong on the
// screen the reader is looking at.
export function liveState(press: LivePress, running: boolean): LiveState {
  if (press.failed) {
    return 'failed';
  }
  return running || press.reply !== '' ? 'running' : 'sent';
}

// The controls on a failed card. Restore is the safe first action for a prompt; Dismiss is
// the explicit discard. A compaction has no reader text to restore and offers only Dismiss.
const LIVE_RESTORE = 'Restore';
const LIVE_DISMISS = 'Dismiss';

// The line the card leads with, in the agent's own name.
//
// Six sentences written out rather than assembled from parts. Each one is read at the moment
// the reader is wondering whether anything happened at all, and a sentence built out of
// fragments reads like one.
function liveStatus(kind: LiveKind, state: LiveState, name: string, waiting: boolean): string {
  // Taken, and not begun. Claude answers a prompt accepted during compaction afterward, and
  // until then a card saying it is working on that prompt claims work that has not started.
  if (waiting) {
    return `${name} has this and is finishing something else first`;
  }
  if (kind === 'compact') {
    // Said of a compaction refused before it left and of one that started and then failed,
    // because the card cannot tell them apart: for Codex the whole compaction is awaited
    // inside the one handoff, so a compaction that ran for a minute and died comes back
    // looking exactly like one the server turned down. The earlier wording claimed the agent
    // was never asked, which was wrong every time it had been.
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
  if (state === 'running') {
    return `${name} is working on this`;
  }
  return `Sending this to ${name}`;
}

// The card the press opens at the top of the timeline, or nothing at all between presses,
// which is most of the time.
//
// It stands where the turn's own card will stand, and it is drawn as that card: the same
// frame, the same head row, the reader's words in the headline slot and what the panel is
// doing in the slot where a turn card says what the agent is doing. The turn that the press
// becomes then leads with the same words, because a running turn with nothing said yet
// leads with its prompt too, so the transcript's card replacing this one changes what the
// card says rather than what it is.
//
// It carries no diffs, no tool output, no file list and nothing that opens: none of that
// exists yet. If it ever needs a second kind of content, make the poll faster rather than
// making this richer.
function liveCard(state: ComposerState, press: LivePress, name: string, now: number): ComposerLive | null {
  // A prompt sent into a turn that was already running gets no card. It starts no turn of its
  // own, so there is nothing for a card to become: the agent answers it inside the turn
  // already going, whose card is on screen and already carrying the reply, the log and, once
  // the transcript has the prompt a moment later, the prompt itself. A second card would be
  // one turn drawn twice, which is what the reader saw.
  //
  // A press that failed still draws one, wherever it was sent from. It is the one card that
  // says something the reader has to act on, and no turn card will ever carry that.
  if (press.midTurn && !press.failed) {
    return null;
  }
  const which = liveState(press, state.running);
  // Running because the session is, with nothing of this press's own begun. Words already
  // streaming say it began, whatever the session's flag reads.
  const waiting = press.kind === 'prompt' && which === 'running' && !press.started && press.reply === '';
  const said = liveStatus(press.kind, which, name, waiting);
  const failed = which === 'failed';
  const reply = liveReplyLine(press.reply);
  // What the reader picked, or what the last turn in this session ran on. The head row
  // has to say the same thing before and after the transcript catches up, and the only thing
  // it can say beforehand is the pick; a session whose first prompt this is has no pick
  // and no last turn, and the row says nothing rather than guessing.
  const model = shortModel(state.settings.selectedModel || state.settings.confirmedModel) ?? '';
  const relative = formatRelative(press.at, now);
  // A compaction carries none of the reader's words, so the card leads with nothing and the
  // line under the head row is the whole of what it says.
  const compaction = press.kind === 'compact' || press.kind === 'clear';
  return {
    kind: press.kind,
    state: which,
    // The turn status the card is drawn as. Decided here rather than in the panel, which had
    // been collapsing the three states onto two of its own and picking a glyph out of the
    // result: a rule spelt in the one file no test reads.
    tone: failed ? 'failed' : 'running',
    status: said,
    relative,
    absolute: formatWhen(press.at, now),
    at: press.at,
    agent: name,
    model,
    label: headLabel(
      'Turn',
      [failed ? STATUS_WORDS.failed : STATUS_WORDS.running, relative, [name, model].filter(Boolean).join(' ') || null],
      said,
    ),
    // The first line of what the reader typed, which is what the turn will lead with once
    // the transcript has it, wrapped and clamped by the stylesheet to the same few lines a
    // turn card clamps its headline to. Sending the whole prompt would draw the same words
    // as the card that replaces it and then a paragraph more of them, and the column below
    // would move when the poll caught up.
    headline: compaction ? '' : firstLine(press.text),
    reply,
    // A failed press stopped, so it counts up no further: a figure growing beside a notice
    // that nothing happened reads as work still being done.
    since: failed ? null : press.at,
    dismissLabel: failed ? LIVE_DISMISS : '',
    dismissName: failed
      ? `${compaction ? 'Take this notice away' : 'Discard this prompt and take this notice away'}. ${said}.`
      : '',
    // Named by the press it clears. Two notices can stand at once, a compaction that reached
    // no child and a prompt that did not either, and one word on both would put the focus on
    // whichever the panel found first when the other was pressed.
    dismissControl: failed ? `dismissLive:${press.kind}` : '',
    restoreLabel: failed && !compaction ? LIVE_RESTORE : '',
    restoreName:
      failed && !compaction
        ? `Restore this prompt to its composer. ${said}.${press.reason ? ` ${press.reason}` : ''}`
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

// Every card the presses in flight open, newest first, which is the order the column draws
// turns in: the press made last stands above the one it was sent behind.
//
// More than one only while a prompt is waiting behind a compaction. The two are separate
// pieces of work and the agent does them in order, so the compaction goes on saying it is
// compacting under the prompt's own card rather than being replaced by it.
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

// What the send control is called to a reader who cannot see the box or the chip.
//
// An empty box that will still send says what is going, because pressing it then sends words
// the reader wrote minutes ago on another part of the screen. A control announcing only "Send
// this prompt" would give no warning of that.
function sendName(state: ComposerState, name: string, enabled: boolean): string {
  const compacting =
    state.agent === 'codex' &&
    state.live.some((press) => (press.kind === 'compact' || press.kind === 'clear') && !press.failed);
  // A Codex `/rename` runs at once beside the session control, so it waits in no queue.
  if (compacting && enabled && renameRequest(state.agent, state.onScreen) === null) {
    return `Queue this prompt for ${name}. Arc will send it after the session control. ${SEND_HINT}.`;
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

// Which of the two the one button at the end of the row is, and whether it can be pressed.
// Two places read it: the box names the control from it, and the sentence beside the control
// is worded from the same answer, so the two can never describe different presses.
function sendState(state: ComposerState): { stopping: boolean; enabled: boolean } {
  // Stop while a turn runs and the box is empty, and Send the moment anything is typed.
  //
  // The reader who has started typing has said what they want, and it is not to stop. Both
  // agents take a prompt mid-turn, so the send is real rather than a queue, and the control
  // follows the box the way the reader's own agent extensions do. A button that stayed Stop
  // over a written prompt offered the one action they had just ruled out, and put the only
  // way to send it on a key the button was contradicting.
  //
  // Read off the box itself rather than off `sendAction`, because comments alone now make that
  // answer 'send'. Asked through `sendAction`, a reader with one comment written would lose the
  // Stop button for the whole of a running turn.
  const stopping = state.running && !state.onScreen.trim() && !(state.assets?.length ?? 0);
  // Stop remains available during any running turn. Send follows the tested action, including
  // a Codex compaction, where the panel accepts the complete submission into its own queue.
  return { stopping, enabled: stopping || sendAction(state) !== 'nothing' };
}

// What a press on Send does to the requests waiting above the box, and nothing when none are
// waiting. A request holds the prompt behind it, so the press answers it first and tells the
// agent that the reader replied in the message that follows.
//
// Nothing is said over a press that will not send. The control is Stop while a turn runs over
// an empty box, and a Send with nothing to send is refused, and a promise to answer the
// request beside either one is a promise the press does not keep.
function sendOverAskLine(state: ComposerState): string {
  const waiting = (state.asks ?? []).length;
  if (!waiting) {
    return '';
  }
  const { stopping, enabled } = sendState(state);
  if (stopping || !enabled) {
    return '';
  }
  // A command the panel answers itself never reaches the agent and never answers a request.
  // `/mcp` opens the server list and clears the box, and a Codex `/rename` renames the
  // session, so a sentence promising an answer would describe a press that leaves the child
  // blocked exactly where it was.
  if (panelCommand(state.onScreen) || renameRequest(state.agent, state.onScreen) !== null) {
    return '';
  }
  const subject = waiting === 1 ? 'the request above' : `the ${waiting} requests above`;
  // A compaction answers the request the same way and sends no prompt at all: the box holds a
  // command the agent never reads. Said to send a prompt, the sentence would name the one
  // thing this press does not do.
  if (compactSubmission(state.agent, state.onScreen)) {
    return `Send answers ${subject} before it compacts.`;
  }
  if (clearSubmission(state.agent, state.onScreen)) {
    return `Send answers ${subject} before it clears the session.`;
  }
  return `Send answers ${subject} with this prompt.`;
}

// The box and the one button at the end of the row. Every word of it is settled here, so the
// panel draws a finished box the same way it draws finished picks.
function composerBox(state: ComposerState, name: string): ComposerBox {
  const running = state.running;
  const { stopping, enabled } = sendState(state);
  // A request that arrives while the reader is typing changes what Send does with no other
  // signal, so the sentence beside the button joins its spoken name as well.
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
    heightName: 'Prompt box height',
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

// What a press on a draft's control changes, said in every one of their names.
//
// A draft sits in the same rail beside the session its setup came from, and the row
// looks like that session's row. A reader who cannot see the tag above it has nothing
// else to tell them that this model, this effort and this permission belong to a
// session nobody has started.
const DRAFT_SCOPE = ', for this draft.';

// Whether this draft's first prompt has gone and the child is being started on it.
//
// A press that changed the setup after this point would leave the panel naming a setup the
// running child never had: the spawn plan is built from the copy `send` already handed over.
// A failed press does not count. The prompt never left, so the reader must be able to change
// the setup and try again.
export function draftStarted(presses: readonly LivePress[]): boolean {
  return presses.some((press) => !press.failed);
}

// What every one of a draft's controls says once its first prompt has gone. The value stays
// on the control and in its name, and the sentence offering a press is replaced by the reason
// there is none to make.
const DRAFT_STARTING = 'It is starting and its setup cannot change now.';

// The four setup controls a draft wears, every one built from its profile.
//
// They stand where a live session's three stand and read the same way, because a draft
// is the same set of settings before anything has run on them. The agent is the fourth
// because a draft is the one state in which the answer can still change.
function draftProfilePicks(state: ComposerState, profile: SessionProfile): ComposerPick[] {
  const name = agentName(profile.agent);
  const model = selectedModelPick(state.models, profile.model, state.defaults);
  const effort = model?.efforts.find((one) => one.value === profile.effort);
  const mode = profileAskMode(profile.agent, profile.permissionMode);
  const agents = draftAgentMenu(state, profile);
  const models = draftModelMenu(state, profile, name);
  const efforts = draftEffortMenu(state, profile, name);
  const modes = askModeMenu(profile.agent, profile.permissionMode, state.sessionId);
  // The catalog's word for the value, then the value itself, then the word for the agent's
  // own default: the fallbacks the tag and the launcher rows use, which is why they are
  // taken off one builder rather than written again here.
  const [, modelLabel, effortLabel] = profileFacts(profile, state.models, state.defaults);
  // Unpressable exactly where the menu behind it has no rows, which is the live rule, and
  // everywhere once the draft has started.
  const noModel = models.items.length === 0;
  const noEffort = efforts.items.length === 0;
  const starting = draftStarted(state.live);
  // The sentence after the value in every name. A menu with no rows carries its own reason,
  // and a draft being started overrides all four: that is why the press is refused now, and a
  // reader who cannot press a control has to be told why somewhere.
  const nameEnding = (offer: string, empty: string): string => {
    if (starting) {
      return DRAFT_STARTING;
    }
    return empty || offer;
  };
  // An effort belongs to a model, so a menu with no rows has two different reasons and two
  // different values to name. A settled model that takes no effort setting has answered the
  // question and says so. A draft with no model settled has not reached it, and its effort is
  // the agent's own default, which is what the tag above the row already calls it.
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
      // A model that takes no effort setting says that rather than going blank, the same way
      // the live control does.
      label: noEffortToSet ? NO_EFFORT_LABEL : effortLabel,
      name: `Effort: ${noEffortToSet ? 'none to set' : effortLabel}${DRAFT_SCOPE} ${nameEnding('Press to start it at another effort.', efforts.empty)}`,
      detail: noEffort
        ? defaultsForModel(state.models, profile.model, state.defaults)?.reason || efforts.empty
        : effort?.description || `How much ${model?.label ?? 'the model'} works on a turn`,
      disabled: starting || noEffort,
      caution: false,
    },
    {
      control: 'askmode',
      label: mode.label,
      // The head is the question, so the name carries what the control is and the label
      // carries what it is set to. The mode's own sentence sits with that setting, the same
      // way the live control names it.
      name: `${modes.head} ${mode.label}${DRAFT_SCOPE}${mode.description ? ` ${sentence(mode.description)}` : ''} ${nameEnding('Press to change it.', modes.empty)}`,
      detail: mode.description || modes.head,
      disabled: starting || modes.items.length === 0,
      caution: false,
    },
  ];
}

const DRAFT_TAG_WORD = 'New draft';

// The tag above a draft's controls. One word for the state, and the four settings on the
// hover, for a reader who wants the whole setup in one look rather than one control at a
// time.
function draftTag(state: ComposerState, profile: SessionProfile): ComposerDraftTag {
  return {
    word: DRAFT_TAG_WORD,
    detail: profileFacts(profile, state.models, state.defaults).join(PROFILE_FACT_SEPARATOR),
  };
}

// The composer, or nothing at all. A window with no session to type into draws no
// composer rather than an empty one addressed to nobody, which is why a state of nothing is
// an answer this takes rather than one its caller has to hold back.
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
  // The servers go last, after the three settings the next turn runs under. Those three are
  // always there and this one often is not, so anywhere else on the row would shift the
  // settled controls sideways the moment an agent turned out to have servers, and the reader
  // would be reaching for a position rather than for a control.
  //
  // It is also the odd one out in what a press means. The settings before it say what the
  // next turn will do, and this one acts on the agent's server configuration now.
  const servers = mcpControl(state, state.profile ? agentName(state.profile.agent) : name);
  if (servers) {
    picks.push(servers);
  }
  return {
    agent: state.agent,
    sessionId: state.sessionId,
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
    // A draft has run no turn, so it has filled no window and has none of its own to be a
    // share of. Any figure reaching here belongs to the session the setup was copied
    // from, and drawing it over a draft would tell the reader that a session with
    // nothing in it is most of the way full.
    context: state.profile ? null : contextFigure(state.context, state.agent, name),
    // A draft has run no turn, so it has re-presented nothing and has no floor. It carries the
    // setup it was copied from and none of that session's figures.
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

// A choice to put in front of the reader. `answer` is what picking it means, so the glue
// hands back what it was given rather than working the meaning out a second time.
export interface Choice {
  label: string;
  detail: string;
  answer: AskAnswer;
}

export interface AskPrompt {
  title: string;
  placeholder: string;
  choices: Choice[];
  // Questions keep refusal separate from the model's choices. A multi-select picker may
  // return several rows, so the glue can recognize this action by its answer rather than
  // by a label that the model could also have used.
  decline: Choice | null;
  // A question with several answers is asked one question at a time; this is which one.
  // A permission ask has none.
  questionIndex: number | null;
  multiSelect: boolean;
}

// How an agent gets started: the program to run, and whatever has to come before the CLI's
// own flags. Most of the time the program is the agent itself and `leadingArgs` is empty.
// The exception is a package script, which has to be given to a Node to run.
export interface Launch {
  command: string;
  leadingArgs: string[];
  // Why this will not work, when it will not. The reader is told this instead of watching a
  // command do nothing.
  problem: string | null;
  // What the child has to be told that its own launcher would have told it. Empty for a
  // launch that needs nothing, which is most of them, and added to the environment the
  // child is started with rather than replacing it.
  env: Record<string, string>;
}

// What the panel needs to know about the machine to work out a launch. Passed in so the
// rule can be tested on any machine, and because the answer is about the machine the panel
// runs on rather than the one the tests run on.
export interface Machine {
  homeDir: string;
  appData: string;
  pathEnv: string;
  // The official Anthropic extension, when it is installed in this editor. Its bundled
  // program speaks the protocol version that extension currently expects.
  claudeExtensionDir: string;
  // The official OpenAI extension, when it is installed in this editor. Its bundled
  // program is the one that writes editor sessions, so it is the compatible reader
  // for those records as the rollout format changes between Codex releases.
  codexExtensionDir: string;
  platform: string;
  // `process.arch`. A package built per platform is named for it, and so is the directory
  // the binary inside it sits in.
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

// Where npm puts a globally installed package's own files on Windows. Only Windows is
// worked out here, and on purpose: npm's global prefix elsewhere is `/usr/local`, or an
// nvm-versioned directory, or whatever the reader set, and a guess that misses is worse
// than no guess. On those systems the name on PATH is a real link to the script and starts
// without help, which is the whole reason this exists only for Windows.
export function npmPackageScript(machine: Machine, parts: string[]): string | null {
  if (machine.platform !== 'win32') {
    return null;
  }
  const script = join(machine.platform, [machine.appData, 'npm', 'node_modules', ...parts]);
  return machine.exists(script) ? script : null;
}

// A batch shim cannot be started with arguments and no shell: Node throws EINVAL. Windows
// also resolves a bare name against `.com` and `.exe` only, so an agent installed by npm,
// whose only entry on PATH is a `.cmd` shim, is not found either. Both are answered the
// same way, by running the package's own script under Node, which is what the shim would
// have done.
function throughNode(machine: Machine, path: string, parts: string[]): Launch | null {
  const lower = path.toLowerCase();
  if (machine.platform !== 'win32') {
    return null;
  }
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return null;
  }
  const script = npmPackageScript(machine, parts);
  if (script) {
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

// The platform package a Codex install carries the real program in, and the directory the
// program sits in inside it. Both are named for the architecture, and an architecture not
// listed here is not guessed at: a path built from a guess names a file that is not there,
// which is the launcher's case anyway.
const CODEX_BUILDS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  arm64: { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

// The real Codex program inside an npm install, and the two things its launcher would have
// told it about how it was installed.
//
// `bin/codex.js` in the package is a launcher: it works out which platform package this
// machine needs and spawns the program in it with `stdio: "inherit"` and no `windowsHide`,
// so the program gets a console window of its own that flashes up on screen. The panel sets
// `windowsHide` on the child it starts, and that child is the launcher rather than the
// program, so the flash survives it. Starting the program directly is the only thing that
// answers it, and it answers it for every Codex child rather than for one of them.
//
// Windows only, for the same reason as `npmPackageScript`: elsewhere the install lives
// wherever npm's prefix is and the name on PATH starts the program on its own.
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
    // Both are the launcher's, and the program is told nothing about how it was installed
    // without them.
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

// The Codex program shipped with the official OpenAI editor extension.
//
// The extension directory is supplied by the editor host rather than guessed from the
// user's extensions folder. Targeted extension packages can move between installations,
// and `vscode.extensions` already knows which copy is active. The platform directories
// use the names in the bundled `codex-package.json`; a candidate that is not present falls
// through to the standalone install rules below.
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

// The Claude program shipped with the official Anthropic editor extension.
//
// The extension directory comes from the editor host. Every platform package keeps its
// executable under the same resource directory.
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

// Which session a running turn is in. One agent runs several sessions at once, so
// a name that says only which agent is busy cannot answer the question the composer asks.
//
// The session is the transcript's own session id rather than the key the child was
// started under. A child started from the box is keyed by its session and one started
// from the palette by its folder, and both end up in the same session once the CLI
// names it, so matching on the key would miss half of them.
export function runningKey(agent: string, session: string): string {
  return `${agent}:${session}`;
}

// Whether this session has a turn in flight. Asked of the session, because a box
// aimed at a quiet session drew Stop while a different one of the same agent was busy,
// and then stopped nothing: the press resolved a session that was not running.
export function sessionRunning(running: readonly string[], agent: string, session: string): boolean {
  return running.includes(runningKey(agent, session));
}

// The sessions an agent is working in now, out of the ones a view lists.
//
// The rows come from the rail and the keys come from the children, and the two are joined
// here rather than at the draw, because the join is where the mistake is. A row carries the
// agent twice: the name a reader sees, `Claude Code`, and the key everything is filed under,
// `claude`. A key built from the name matches nothing and says so to nobody, and the
// session the reader is watching quietly stops being drawn as running.
//
// Rows decide the answer. A busy child in a session no view lists is no answer to a
// question about what that view draws.
export function runningSessions(
  rows: readonly { id: string; agentKey: string }[],
  running: readonly string[],
): Set<string> {
  return new Set(rows.filter((row) => sessionRunning(running, row.agentKey, row.id)).map((row) => row.id));
}

// When each of those sessions started the work it is busy with. The same join as above,
// over the same keys, so the rail's bound on a busy claim is read against the rows the rail
// draws. `sessionStatusOf` says what the bound is for.
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

// The busy children in one session. Matched on the session the child is actually
// in, for the reason `runningKey` gives, so a child started from the palette is reached by
// the same rule as one started from the box.
export function busyInSession<T extends { agent: string; sessionId: string | null; busy: boolean; exited: boolean }>(
  states: readonly T[],
  agent: string,
  session: string,
): T[] {
  return states.filter((s) => s.busy && !s.exited && s.agent === agent && s.sessionId === session);
}

// The agents a reader can start, in the order they are offered. Claude leads because it is
// the one whose asks the panel can answer in full.
export function agentChoices(): { agent: 'claude' | 'codex'; label: string; detail: string }[] {
  return [
    { agent: 'claude', label: 'Claude Code', detail: 'Asks before it runs a tool, and answers its own questions here' },
    { agent: 'codex', label: 'Codex', detail: 'Asks before it runs a command or changes a file' },
  ];
}

// What an ask looks like in a picker. A permission ask is a yes or no about one tool call,
// so the tool and what it wants to do are the title and the reader picks a verdict. A
// question is the model's own, so its options are the choices and its text is the title.
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
      // The whole answer is assembled once every question has been picked, so a single
      // option carries only its own choice here.
      answer: { decision: 'answer', answers: { [question.id]: { labels: [option.label], written: '' } } },
    })),
    decline: { label: 'Decline', detail: 'The agent is told this was refused and carries on', answer: REFUSED_ASK },
    questionIndex,
    multiSelect: question.multiSelect,
  };
}

// The one answer that goes back for a whole question ask. `picked` holds the labels the
// reader chose for each question, and `written` the answer they typed for it instead, both
// in the order the questions arrived. A question left unanswered is not sent at all: the CLI
// is blocked either way, and a made-up answer is worse than the reader being asked again.
//
// A question takes one or the other. Both at once would say that the reader chose a listed
// answer and also refused the list, and neither agent has a way to read that.
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

// What the head row says once a press has been taken and the host is resolving it. The card
// stays on screen until the host removes it, so without this the reader has a form of dead
// controls and nothing saying why.
const ASK_SENDING = 'sending your answer';

// How many of a question's choices the reader may take. Nothing else on the card says it,
// and a reader who takes one of five checkboxes and presses Answer has told the agent less
// than they meant to.
const ASK_CHOOSE_ONE = 'Choose one.';
const ASK_CHOOSE_ANY = 'Choose any that apply.';

// The last choice on every question, and the box it opens. Neither agent offers it: Claude
// hands the whole tool input back to its tool, and Codex asks the client to add the free-form
// choice itself, so both read what the reader types as an ordinary answer.
const ASK_WRITTEN_LABEL = 'Other';
const ASK_WRITTEN_DETAIL = 'Answer in your own words';
const ASK_WRITTEN_PLACEHOLDER = 'Type your answer';

// What the fold press does, said rather than left to the twist. A reader who cannot see the
// glyph has only this to tell them which way the press goes.
const ASK_HIDE_PRESS = 'Press to hide it.';
const ASK_SHOW_PRESS = 'Press to show it.';

// The inline form for one request. A permission has two immediate actions. A question draws
// one question at a time and has one final action, because sending some answers while another
// question is blank would tell the agent something the reader did not say.
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
      // A permission is one decision, so there is no question to be on and nothing to count.
      steps: [],
      answeredWords: [],
      openName: `${prompt.title}. ${ASK_SHOW_PRESS}`,
      shutName: `${prompt.title}. ${ASK_HIDE_PRESS}`,
      stateWord: NEEDS_INPUT,
      sendingWord: ASK_SENDING,
    };
  }

  const count = ask.questions.length;
  const subject = count === 1 ? 'a question' : `${count} questions`;
  const title = `${agent} asked ${subject}`;
  return {
    id: ask.id,
    kind: ask.kind,
    title,
    // Nothing under the title. The sentence here said that the agent would continue after an
    // answer, which is what the state word on the head row already says in two words.
    detail: '',
    detailFormat: 'prose',
    name: `${agent} is waiting for you with ${subject}.`,
    questions: ask.questions.map((question, index) => {
      // What the tab is called. The agent's own short label where it sent one, and the
      // question's number where it did not: Claude always sends one and Codex may not.
      const spoken = question.header || `Question ${index + 1}`;
      return {
        id: question.id,
        legend: question.question,
        key: question.header,
        hint: question.multiSelect ? ASK_CHOOSE_ANY : ASK_CHOOSE_ONE,
        multiSelect: question.multiSelect,
        secret: question.secret,
        choices: [
          ...question.options.map((option) => ({
            label: option.label,
            detail: option.description,
            name: option.description ? `${option.label}. ${option.description}` : option.label,
            written: false,
          })),
          // Last, after everything the agent thought of, because it is the answer for a
          // reader none of those fit.
          {
            label: ASK_WRITTEN_LABEL,
            detail: ASK_WRITTEN_DETAIL,
            name: `${ASK_WRITTEN_LABEL}. ${ASK_WRITTEN_DETAIL}`,
            written: true,
          },
        ],
        tab: question.header || String(index + 1),
        tabName: `${spoken}, not answered`,
        tabAnsweredName: `${spoken}, answered`,
        writtenName: `Your own answer. ${question.question}`,
        writtenPlaceholder: ASK_WRITTEN_PLACEHOLDER,
      };
    }),
    // A reader who wants no part of a question still needs a way out, or the turn stays
    // blocked on a form they will not fill in.
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

// Accept only an answer the current request could have produced. The webview is isolated but
// still an input boundary, and a stale form can post after the agent has replaced a request.
// Normalizing here also puts question ids back in request order before the wire sees them.
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
    // The reader answered in their own words, so there is no offered label to check. The two
    // never arrive together: a question is answered from the list or off it.
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

// The prompt entries to offer for what the reader has typed. Matching is on the name only: a
// description match would put an entry under a name that does not contain what was typed,
// which reads as the list ignoring the reader.
//
// The host and browser import the same browser-safe matching rule. This wrapper keeps the
// host's command objects while the shared rule orders their names.
//
// `typed` is everything after the prefix. An empty one offers the lot, because a reader who
// has typed only the prefix is asking what there is.
export function matchCommands(commands: ComposerPromptEntry[], typed: string): ComposerPromptEntry[] {
  const byName = new Map(commands.map((command) => [command.name, command]));
  return matchCommandNames([...byName.keys()], typed)
    .map((name) => byName.get(name))
    .filter((command): command is ComposerPromptEntry => command !== undefined);
}

// The prompt entry the caret is standing in, and where it starts and ends.
//
// A prompt entry is a run with no spaces in it that opens on an agent-recognized prefix.
// A slash opens a
// word: the start of the box, or a space in front of it. So it is read wherever the reader
// is writing rather than only at the front of the box, which is how both agents' own boxes
// behave and how the reader asked for it. `Take a look at /rev` offers the review command
// under the caret and leaves the six words in front of it alone.
//
// A slash inside a word is not one. `a/b` and `src/main.ts` are a path or a fraction, and the
// rule that a slash opens a word is what tells them apart from a command without knowing any
// command's name. A run that does open a word and still names nothing, `/usr/local` being the
// one that turns up, is left to the matching: it offers no command, and a menu with no rows
// is not drawn.
// One command as the menu under the box draws it.
//
// Worded here rather than in the panel, so the row a screen reader hears is decided in a
// file a test can read. The panel narrows the list and draws it; every word on a row comes
// from here, and every one of those words is the agent's own.
export interface PromptEntryView {
  kind: 'command' | 'skill';
  // The agent's own name for the entry, with no prefix. This is what the panel narrows on
  // and what a press carries back, so a stale list can only ever complete an entry the
  // reader was looking at.
  command: string;
  prefix: '/' | '$';
  // The entry as the reader would type it.
  label: string;
  // What it takes after its name, in the agent's words, and empty for one that takes
  // nothing. Claude publishes this as `argumentHint`; Codex publishes none for a skill.
  hint: string;
  // The agent's sentence about it, and empty where it gives none.
  description: string;
  // The skill definition returned by a catalog that publishes one. It is detail text only.
  path?: string;
  // The panel control that owns this command. Agent-owned entries omit it.
  panelControl?: string;
  // The row's accessible name. An `aria-label` replaces what the row holds rather than
  // adding to it, so everything the eye reads is in here: the name, what it takes, and the
  // sentence under it.
  name: string;
  // What the run under the caret becomes when this row is taken. The words either side of it
  // are kept, so a command completed in the middle of a sentence leaves the sentence.
  //
  // The trailing space is not decoration: it is what ends the name, which shuts the menu and
  // lets the next Enter send the command rather than complete it again.
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

// The commands the panel answers itself, and the control each one opens.
//
// Some of an agent's commands are not questions for the agent at all. `/mcp` draws a list of
// servers in the agent's own terminal, so the CLI never answers it with anything a panel
// could show: sent as a prompt it goes out and nothing comes back, and the reader is left
// looking at a command that did nothing. The panel already draws that list, on the picker
// row, so the command opens that instead of travelling.
//
// The list is short and stays short. A command belongs here only when the panel has a control
// that does the same job, and every one that the agent can actually answer is left to the
// agent. `/compact` is the case that shows the difference: the CLI reads it and compacts, so
// it is not here.
const PANEL_COMMANDS: Record<string, { control: string; description: string }> = {
  mcp: { control: 'mcp', description: 'View MCP server status' },
};

// The agent's own list plus commands this panel implements through an equivalent protocol
// call. The panel command is appended and deduplicated so Claude can publish `/mcp` itself,
// while Codex, which publishes no slash-command list, still offers it.
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

// Which control a typed command opens, or nothing for a command that goes to the agent.
//
// The argument is dropped on purpose. `/mcp` takes none, and a reader who typed one has still
// asked for the servers.
export function panelCommand(text: string): string | null {
  const said = text.trim();
  if (!said.startsWith('/')) {
    return null;
  }
  const name = said.slice(1).split(/\s/)[0].toLowerCase();
  return own(PANEL_COMMANDS, name)?.control ?? null;
}

// Every available prompt entry, worded for the menu. The agent's order is kept and panel-owned
// commands follow it. Narrowing reorders them against what the reader typed.
export function promptEntries(agent: string, commands: readonly ComposerPromptEntry[]): PromptEntryView[] {
  return commands.flatMap((command) => {
    const prefixes: Array<'/' | '$'> = command.kind === 'skill' && agent === 'codex' ? ['$', '/'] : ['/'];
    return prefixes.map((prefix) => {
      const label = `${prefix}${command.name}`;
      const hint = command.argumentHint.trim();
      const description = command.description.trim();
      // Joined the way the row reads, so what is heard and what is seen are the same words in
      // the same order.
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
