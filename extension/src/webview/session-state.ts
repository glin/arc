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
  savedState: SavedStateService;
  sendToHost(message: PanelToHost): void;
  rail(): RailSnapshot | null;
  reading(): ReadStateSnapshot | null;
  comments(): readonly TurnComment[] | null;
  promptFloor(): number | null;
  composerHidden(): boolean;
  refreshContext(session: string): void;
  // The same rewrite for many sessions at once, drawing each surface once for the batch.
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

// What a caller adds to a row's context beyond the archived state, the pin state and the
// saved fact every row carries.
//
// A rail card names its own section, which already carries the read state the session
// heading has no room for, and it names its own archived state directly because the rail's
// three sections carry read state instead. A session heading carries neither: it always
// answers archived from its own two sections, and a caller merges in what it knows about
// read state itself, since the cards and the read marks both live outside this module.
export interface SessionContextExtra {
  menuSection?: string;
  preventDefaultContextMenuItems?: boolean;
  // A word rather than a boolean, so the manifest's when clause can single out the case an
  // entry applies to without the special case VS Code gives a context key compared against a
  // literal `false`, which also matches the key being absent.
  sessionRead?: 'read' | 'unread';
  // Present only on a session with at least one label, which is when New session with the
  // same labels has anything to copy.
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
  // A browser copy never passed through the host's normalizer, so a lens an older build stored
  // as a filter id, as rail state or as the old Warm words joins the query here as well.
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
      if (!hidden.delete(session)) {
        return;
      }
      options.refreshContext(session);
      options.sendToHost({ type: 'sessionMembership', action: 'unarchive', session });
    },
    setPinned(session, pinned, openPinned = false) {
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
      // A rail card names its section for read state already, so it needs archived spelled
      // out on its own. A session heading's two sections already say it, and a third key
      // repeating the same fact would be one more place for the two to disagree.
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
