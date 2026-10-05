import type { BrowserStatePort, PanelHost } from './host.ts';
import type { SessionProfile } from '../view/launcher.ts';
import type { QueryMatch } from '../domain/session-query.ts';

export interface SubmittedPrompt {
  id: string;
  order: number;
  source: string;
  revision: number;
  text: string;
  setup?: SessionProfile;
  owner?: string;
  ownerRevision?: number;
  accepted?: boolean;
}

export const SUBMITTED_PROMPT_LIMIT = 5;
export const SUBMITTED_PROMPT_CHARS = 20_000;

export function mergeSubmittedPrompts(...snapshots: unknown[]): SubmittedPrompt[] {
  const entries = new Map<string, SubmittedPrompt>();
  for (const snapshot of snapshots) {
    if (!Array.isArray(snapshot)) continue;
    for (const value of snapshot) {
      if (!value || typeof value !== 'object') continue;
      const p = value as SubmittedPrompt;
      if (
        typeof p.id !== 'string' ||
        !p.id ||
        p.id.length > 200 ||
        typeof p.source !== 'string' ||
        p.source.length > 200 ||
        typeof p.text !== 'string' ||
        p.text.length > SUBMITTED_PROMPT_CHARS ||
        !Number.isSafeInteger(p.order) ||
        p.order < 1 ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 0
      )
        continue;
      const next: SubmittedPrompt = { id: p.id, order: p.order, source: p.source, revision: p.revision, text: p.text };
      if (
        typeof p.owner === 'string' &&
        p.owner.length <= 200 &&
        Number.isSafeInteger(p.ownerRevision) &&
        p.ownerRevision! > 0
      ) {
        next.owner = p.owner;
        next.ownerRevision = p.ownerRevision;
        if (p.accepted === true) next.accepted = true;
      }
      if (
        p.setup &&
        (p.setup.agent === 'claude' || p.setup.agent === 'codex') &&
        ['model', 'effort', 'permissionMode'].every(
          (key) => typeof p.setup![key as 'model'] === 'string' && p.setup![key as 'model'].length <= 200,
        )
      )
        next.setup = {
          agent: p.setup.agent,
          model: p.setup.model,
          effort: p.setup.effort,
          permissionMode: p.setup.permissionMode,
          source: p.setup.source === 'inherited' || p.setup.source === 'recent' ? p.setup.source : 'custom',
        };
      const prior = entries.get(p.id);
      if (
        prior &&
        (prior.order !== next.order ||
          prior.source !== next.source ||
          prior.revision !== next.revision ||
          prior.text !== next.text ||
          (prior.setup &&
            next.setup &&
            (['agent', 'model', 'effort', 'permissionMode', 'source'] as const).some(
              (key) => prior.setup![key] !== next.setup![key],
            )))
      ) {
        throw new Error('The saved prompt conflicts with another copy.');
      }
      if (!prior || (next.ownerRevision ?? 0) > (prior.ownerRevision ?? 0)) entries.set(p.id, next);
    }
  }
  return [...entries.values()]
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-SUBMITTED_PROMPT_LIMIT);
}

export interface SavedPanelState {
  submittedPrompts?: SubmittedPrompt[];
  open: unknown[];
  showing: string;
  railFilter: string;
  railMatch: QueryMatch;
  railFilterId: string;
  railSort?: unknown;
  railDefaultSort?: unknown;
  railDensity?: unknown;
  railGroupBy?: unknown;
  railShowArchived?: unknown;
  railShowRuns?: unknown;
  // The Quick filters a build without the Running lens stored. The panel reads it while
  // `railQuickFilters` is absent and never writes it.
  railHeadLenses?: unknown;
  railQuickFilters?: unknown;
  railWidth: number;
  composerHidden: boolean;
  promptFloor: number;
  railFolds: Record<string, unknown>;
  hidden: unknown[];
  pinnedTop: unknown[];
  read: unknown[];
  readTo: Record<string, unknown>;
  since: number;
  comments: unknown[];
  assets: Record<string, never>;
}

export interface SavedStateValues {
  open: Iterable<unknown>;
  showing: string;
  railFilter: string;
  railMatch: QueryMatch;
  railFilterId: string;
  railSort?: unknown;
  railDefaultSort?: unknown;
  railDensity?: unknown;
  railGroupBy?: unknown;
  railShowArchived?: unknown;
  railShowRuns?: unknown;
  railQuickFilters?: unknown;
  railWidth: number;
  composerHidden: boolean;
  promptFloor: number;
  railFolds: Iterable<readonly [string, unknown]>;
  hidden: Iterable<unknown>;
  pinnedTop: Iterable<unknown>;
  read: Iterable<unknown>;
  readTo: Iterable<readonly [string, unknown]>;
  since: number;
  comments: unknown[];
}

export interface SavedStateService {
  readonly initial: Record<string, unknown>;
  recovery(): SubmittedPrompt[];
  submit(source: string, revision: number, text: string, setup?: SessionProfile): SubmittedPrompt;
  importRecovery(snapshot: unknown): void;
  publishRecovery(): void;
  onRecovery(callback: () => void): void;
  save(values: SavedStateValues): SavedPanelState;
}

function stateObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function savedPanelState(values: SavedStateValues): SavedPanelState {
  return {
    open: [...values.open],
    showing: values.showing,
    railFilter: values.railFilter,
    railMatch: values.railMatch,
    railFilterId: values.railFilterId,
    ...(values.railSort === undefined ? {} : { railSort: values.railSort }),
    ...(values.railDefaultSort === undefined ? {} : { railDefaultSort: values.railDefaultSort }),
    ...(values.railDensity === undefined ? {} : { railDensity: values.railDensity }),
    ...(values.railGroupBy === undefined ? {} : { railGroupBy: values.railGroupBy }),
    ...(values.railShowArchived === undefined ? {} : { railShowArchived: values.railShowArchived }),
    ...(values.railShowRuns === undefined ? {} : { railShowRuns: values.railShowRuns }),
    ...(values.railQuickFilters === undefined ? {} : { railQuickFilters: values.railQuickFilters }),
    railWidth: values.railWidth,
    composerHidden: values.composerHidden,
    promptFloor: values.promptFloor,
    railFolds: Object.fromEntries(values.railFolds),
    hidden: [...values.hidden],
    pinnedTop: [...values.pinnedTop],
    read: [...values.read],
    readTo: Object.fromEntries(values.readTo),
    since: values.since,
    comments: values.comments.slice(),
    assets: {},
  };
}

// Reader layout uses the host copy. Submitted text joins both lifetimes by attempt identity.
export function createSavedState(
  sharedState: unknown,
  browserState: BrowserStatePort,
  host: PanelHost,
): SavedStateService {
  const browser = stateObject(browserState.read());
  const shared = stateObject(sharedState);
  const initial = { ...(shared ?? browser ?? {}) };
  let recovery = mergeSubmittedPrompts(browser?.submittedPrompts, shared?.submittedPrompts);
  if (recovery.length) initial.submittedPrompts = recovery;
  let latest: Record<string, unknown> = initial;
  const listeners: (() => void)[] = [];
  const writeRecovery = (next: SubmittedPrompt[]) => {
    const state = { ...latest, submittedPrompts: next };
    browserState.write(state);
    latest = state;
    recovery = next;
    if (unsent) unsent.submittedPrompts = next;
    for (const callback of listeners) callback();
  };
  // The newest state not yet sent to the extension. Every saved state is whole, so the newest
  // one carries everything the ones before it did.
  let unsent: SavedPanelState | null = null;
  const sendNewest = () => {
    const state = unsent;
    unsent = null;
    if (state) {
      host.send({ type: 'saveState', state });
    }
  };
  return {
    initial,
    recovery: () => recovery.slice(),
    submit(source, revision, text, setup) {
      if (text.length > SUBMITTED_PROMPT_CHARS)
        throw new Error('This prompt exceeds the 20,000-character recovery limit. Shorten it before sending.');
      const order = (recovery.at(-1)?.order ?? 0) + 1;
      if (!Number.isSafeInteger(order)) throw new Error('This prompt could not be saved. Copy it before trying again.');
      const attempt = {
        id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join(
          '',
        ),
        source,
        revision,
        text,
        order,
        ...(setup ? { setup: { ...setup } } : {}),
      };
      writeRecovery(mergeSubmittedPrompts(recovery, [attempt]));
      return attempt;
    },
    importRecovery(snapshot) {
      writeRecovery(mergeSubmittedPrompts(recovery, snapshot));
    },
    publishRecovery() {
      host.send({ type: 'importPromptRecovery', submittedPrompts: recovery });
    },
    onRecovery(callback) {
      listeners.push(callback);
    },
    save(values) {
      const state = savedPanelState(values);
      if (recovery.length) state.submittedPrompts = recovery;
      // These writes have different lifetimes. Neither replaces the other. The browser copy is
      // written at once. The extension copy goes once the current task ends, so one render that
      // marks several cards read sends one state, and the extension words the rail for it once.
      // A task always runs its microtasks before the page can unload, so no state is lost.
      browserState.write(state);
      latest = state as unknown as Record<string, unknown>;
      if (unsent === null) {
        queueMicrotask(sendNewest);
      }
      unsent = state;
      return state;
    },
  };
}
