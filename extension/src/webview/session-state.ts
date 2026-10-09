import type { RailSort } from '../domain/rail-sort.ts';
import { migrateStoredRailLens, type RailLens } from '../domain/rail-filters.ts';
import type { TurnComment } from '../view/comments.ts';
import { SESSION_MENU_SECTIONS } from '../view/card-menu.ts';
import {
  normalizeRailDensity,
  normalizeRailGroupBy,
  normalizeRailShowArchived,
  normalizeRailShowRuns,
  normalizeRailQuickFilters,
  type RailDensity,
  type RailGroupBy,
} from '../view/rail.ts';
import type { PanelSessionAdoption, PanelToHost } from './protocol.ts';
import type { ReadStateSnapshot } from './read-state.ts';
import type { RailSnapshot } from './rail.ts';
import type { SavedStateService } from './state.ts';
import { clampPromptFloor } from '../view/composer-size.ts';

export interface InitialRailState {
  filter: string;
  filterId: string;
  sort?: unknown;
  defaultSort?: unknown;
  density: RailDensity;
  groupBy: RailGroupBy;
  showArchived: boolean;
  showRuns: boolean;
  headLenses: RailLens[];
  width: number;
  folds: Record<string, unknown>;
  composerHidden: boolean;
}

interface SessionStateOptions {
  readOnly?: boolean;
  savedState: SavedStateService;
  sendToHost(message: PanelToHost): void;
  rail(): RailSnapshot | null;
  reading(): ReadStateSnapshot | null;
  comments(): readonly TurnComment[] | null;
  promptFloor(): number | null;
  composerHidden(): boolean;
  refreshContext(session: string): void;
  // Refresh contexts in a batch and draw each affected surface once.
  refreshContexts(sessions: readonly string[]): void;
}

export interface PanelSessionState {
  readonly open: Set<string>;
  readonly hidden: Set<string>;
  readonly pinnedTop: Set<string>;
  readonly initialRail: InitialRailState;
  readonly initialPromptFloor: number;
  readonly initialComposerHidden: boolean;
  readonly initialComments: TurnComment[];
  showing(): string;
  save(): void;
  hide(session: string): void;
  unarchive(session: string): void;
  setPinned(session: string, pinned: boolean, openPinned?: boolean): void;
  clearHidden(): void;
  adopt(
    hidden: readonly string[],
    pinnedTop: readonly string[],
    showing: string | null,
    adoptions?: readonly PanelSessionAdoption[],
  ): void;
  reset(): void;
  context(session: string, persisted: boolean, extra?: SessionContextExtra): string;
}

// Optional native-menu context fields. Session list sections encode read state and need explicit archived state.
// Session heading sections encode archived state. Callers supply read state from their cards and read marks.
export interface SessionContextExtra {
  menuSection?: string;
  preventDefaultContextMenuItems?: boolean;
  // Use words for read state. VS Code matches absent keys when a when clause compares against false.
  sessionRead?: 'read' | 'unread';
  // Set only when the session has labels for New session with the same labels to copy.
  sessionLabeled?: boolean;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function comments(value: unknown): TurnComment[] {
  return Array.isArray(value) ? value.filter((item): item is TurnComment => !!item && typeof item === 'object') : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function createPanelSessionState(options: SessionStateOptions): PanelSessionState {
  const initial = options.savedState.initial;
  const open = new Set(strings(initial.open));
  const hidden = new Set(strings(initial.hidden));
  const pinnedTop = new Set(strings(initial.pinnedTop));
  const initialRead = new Set(strings(initial.read));
  const initialReadTo = new Map(Object.entries(record(initial.readTo)));
  const initialSince = typeof initial.since === 'number' ? initial.since : 0;
  let showing = typeof initial.showing === 'string' ? initial.showing : '';
  // Browser state bypasses host normalization. Convert stored lens fields and Warm query terms here.
  const storedRail = migrateStoredRailLens({
    filterId: initial.railFilterId,
    query: typeof initial.railFilter === 'string' ? initial.railFilter : '',
    lens: initial.railLens,
  });
  const initialRail: InitialRailState = {
    filter: storedRail.query,
    filterId: typeof storedRail.filterId === 'string' ? storedRail.filterId : '',
    sort: initial.railSort,
    defaultSort: initial.railDefaultSort,
    density: normalizeRailDensity(initial.railDensity),
    groupBy: normalizeRailGroupBy(initial.railGroupBy),
    showArchived: normalizeRailShowArchived(initial.railShowArchived),
    showRuns: normalizeRailShowRuns(initial.railShowRuns),
    headLenses: normalizeRailQuickFilters(initial.railQuickFilters, initial.railHeadLenses),
    width: typeof initial.railWidth === 'number' ? initial.railWidth : 0,
    folds: record(initial.railFolds),
    composerHidden: initial.composerHidden === true,
  };
  const initialComments = comments(initial.comments);
  const initialPromptFloor = clampPromptFloor(initial.promptFloor, Number.POSITIVE_INFINITY);

  const owner: PanelSessionState = {
    open,
    hidden,
    pinnedTop,
    initialRail,
    initialPromptFloor,
    initialComposerHidden: initialRail.composerHidden,
    initialComments,
    showing: () => showing,
    save() {
      const rail = options.rail() ?? {
        filter: initialRail.filter,
        filterId: initialRail.filterId,
        sort: initialRail.sort as RailSort | undefined,
        defaultSort: initialRail.defaultSort as RailSort | undefined,
        width: initialRail.width,
        folds: new Map(Object.entries(initialRail.folds).map(([key, value]) => [key, value === true])),
        showArchived: initialRail.showArchived,
        showRuns: initialRail.showRuns,
        headLenses: initialRail.headLenses,
        groupBy: initialRail.groupBy,
        density: initialRail.density,
      };
      const reading = options.reading() ?? { read: initialRead, readTo: initialReadTo, since: initialSince };
      options.savedState.save({
        open,
        showing,
        railFilter: rail.filter,
        railFilterId: rail.filterId,
        railSort: rail.sort,
        railDefaultSort: rail.defaultSort,
        railDensity: rail.density,
        railGroupBy: rail.groupBy,
        railShowArchived: rail.showArchived,
        railShowRuns: rail.showRuns,
        railQuickFilters: rail.headLenses,
        railWidth: rail.width,
        composerHidden: options.composerHidden(),
        promptFloor: options.promptFloor() ?? initialPromptFloor,
        railFolds: rail.folds,
        hidden,
        pinnedTop,
        read: reading.read,
        readTo: reading.readTo,
        since: reading.since,
        comments: [...(options.comments() ?? initialComments)],
      });
    },
    hide(session) {
      if (options.readOnly) return;
      const hiddenChanged = !hidden.has(session);
      const pinnedChanged = pinnedTop.delete(session);
      if (!hiddenChanged && !pinnedChanged) {
        return;
      }
      hidden.add(session);
      options.refreshContext(session);
      options.sendToHost({ type: 'sessionMembership', action: 'archive', session });
    },
    unarchive(session) {
      if (options.readOnly) return;
      if (!hidden.delete(session)) {
        return;
      }
      options.refreshContext(session);
      options.sendToHost({ type: 'sessionMembership', action: 'unarchive', session });
    },
    setPinned(session, pinned, openPinned = false) {
      if (options.readOnly) return;
      const changed = pinned ? !pinnedTop.has(session) && !hidden.has(session) : pinnedTop.has(session);
      if (!changed) {
        return;
      }
      if (pinned) {
        pinnedTop.add(session);
      } else {
        pinnedTop.delete(session);
      }
      options.refreshContext(session);
      options.sendToHost(
        pinned
          ? { type: 'sessionMembership', action: 'pin', session, ...(openPinned ? { openPinned: true } : {}) }
          : { type: 'sessionMembership', action: 'unpin', session },
      );
    },
    clearHidden() {
      if (options.readOnly) return;
      if (!hidden.size) {
        return;
      }
      const shown = [...hidden];
      hidden.clear();
      options.refreshContexts(shown);
      options.sendToHost({ type: 'sessionMembership', action: 'unarchiveAll' });
    },
    adopt(nextHidden, nextPinnedTop, nextShowing, adoptions = []) {
      const identities = new Map(adoptions.map(({ provisional, durable }) => [provisional, durable]));
      const displayed = adoptions.find(({ provisional }) => provisional === nextShowing);
      const adopted = (session: string): string => {
        if (displayed && (session === displayed.provisional || session === displayed.durable)) {
          return displayed.provisional;
        }
        return identities.get(session) ?? session;
      };
      hidden.clear();
      nextHidden.forEach((session) => hidden.add(adopted(session)));
      pinnedTop.clear();
      nextPinnedTop.forEach((session) => pinnedTop.add(adopted(session)));
      hidden.forEach((session) => pinnedTop.delete(session));
      const next = adopted(nextShowing ?? '');
      if (showing !== next) {
        showing = next;
        owner.save();
      }
    },
    reset() {
      open.clear();
      hidden.clear();
      pinnedTop.clear();
      showing = '';
    },
    context(session, persisted, extra) {
      const archived = hidden.has(session);
      const out: Record<string, unknown> = {
        webviewSection: extra?.menuSection ?? (archived ? SESSION_MENU_SECTIONS.archived : SESSION_MENU_SECTIONS.live),
        session,
        sessionPinned: pinnedTop.has(session),
        sessionPersisted: persisted,
      };
      // Session list sections encode read state, so they need a separate archived key.
      if (extra?.menuSection) {
        out.sessionArchived = archived;
      }
      if (extra?.preventDefaultContextMenuItems) {
        out.preventDefaultContextMenuItems = true;
      }
      if (extra?.sessionRead !== undefined) {
        out.sessionRead = extra.sessionRead;
      }
      if (extra?.sessionLabeled) {
        out.sessionLabeled = true;
      }
      return JSON.stringify(out);
    },
  };

  hidden.forEach((session) => pinnedTop.delete(session));
  return owner;
}
