// The panel page owner. It runs in the webview with browser ports supplied by bootstrap.ts.
// The packaged entry bundles this module into the inline script served by panelhost.ts.
import { markdownOf, nextId, placeFloat as placeFloatInView } from './dom.ts';
import type { PanelDom } from './dom.ts';
import { createHints } from './hints.ts';
import { createNavigation } from './navigation.ts';
import { cardPrint, createCardRenderer, type CardRendererOptions } from './card.ts';
import { createChromeRenderer } from './chrome.ts';
import { createProjectSpendRenderer } from './projectspend.ts';
import { createRailRenderer } from './rail.ts';
import { createSessionDetails } from './sessiondetails.ts';
import { createTimelineRenderer } from './timeline-renderer.ts';
import { createLayoutDialog } from './layout-dialog.ts';
import { DEFAULT_TIMELINE_LAYOUT, timelineLayout, type TimelineLayout } from '../view/timeline-layout.ts';
import { createReadState } from './read-state.ts';
import { createCommentRenderer } from './comments.ts';
import { createComposerRenderer } from './composer.ts';
import { createComposerControlsRenderer } from './composer-controls.ts';
import { createRequestRenderer } from './requests.ts';
import { createQueueLiveRenderer } from './queue-live.ts';
import { createAttachmentRenderer } from './attachments.ts';
import { createStatDetailRenderer, type StatDetailRenderer } from './stat-detail.ts';
import { renderDetailRows } from './card-rows.ts';
import { createClock } from './clock.ts';
import { createSearchRenderer } from './search.ts';
import { createPanelSessionState } from './session-state.ts';
import { createHistoryOwner } from './history-control.ts';
import { createPageStyleOwner } from './page-style.ts';
import { mountRetainedVisibility } from './retained-visibility.ts';
import { createSessionLabelIndex } from '../view/rail.ts';
import {
  createComposerAction,
  createComposerPresentation,
  mountComposerPresentation,
} from './composer-presentation.ts';
import {
  dispatchHostToPanel,
  parseHostToPanel,
  type HostToPanel,
  type PanelOlderHistory,
  type PanelCard,
  type PanelDiagnosis,
  type PanelRailCard,
  type PanelStat,
  type PanelSessionAdoption,
  type PanelSessionRow,
  type PanelToHost,
  type PanelUsage,
  type RenderMessage,
} from './protocol.ts';
import { commentsFor } from '../view/comments.ts';
import { CARD_GLYPHS, contextClass } from '../view/card-presentation.ts';
import { archivedNote } from '../view/rail.ts';
import { MAX_PROMPT_ASSETS, MAX_PROMPT_ASSET_BYTES, MAX_PROMPT_ASSET_TOTAL_BYTES } from '../domain/prompt-assets.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import type { SavedStateService } from './state.ts';

export interface GlobalEventPort {
  document(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

export interface PanelKernel {
  dom: PanelDom;
  events: GlobalEventPort;
  savedState: SavedStateService;
  sendToHost(message: PanelToHost): void;
  afterPaint(callback: () => void): void;
}

export interface StartedPanel {
  receiveHostMessage(data: unknown): void;
  dispose(): void;
}

// A cost guard's only way in. A real VS Code webview never defines this, so the check and
// the call it guards cost one property read and nothing else. A browser test defines it
// before the panel starts, to count how many full draws each renderer performs.
declare global {
  interface Window {
    __arcOnDraw?: (renderer: 'timeline' | 'rail') => void;
  }
}
function drawCounter(renderer: 'timeline' | 'rail'): (() => void) | undefined {
  return typeof window === 'undefined' || !window.__arcOnDraw ? undefined : () => window.__arcOnDraw!(renderer);
}

// Importing this module has no side effects. The composition root starts one page lifetime.
export function startPanel(kernel: PanelKernel): StartedPanel {
  const list = kernel.dom.list;
  const startupStatus = list.querySelector<HTMLElement>('[data-startup-status]');
  const savedState = kernel.savedState;
  // Compatibility name for the narrow posting port while rendering remains in this file.
  // This is not the object returned by acquireVsCodeApi, which stays inside host.ts.
  const vscode = Object.freeze({ postMessage: kernel.sendToHost });
  const onDocument = kernel.events.document;
  const onWindow = kernel.events.window;
  // One clock for the whole panel. Every age, every duration and the next-turn face move on the
  // same second, so a figure and the working behind it can never disagree by one.
  const clock = createClock({ document });
  // The content search: its pending query, the reply it accepts, and the list it draws. Held
  // here only so the message handlers and the timeline can reach it.
  const searchRenderer = createSearchRenderer({
    document,
    sendToHost(message) {
      vscode.postMessage(message);
    },
  });
  let cardRenderer: ReturnType<typeof createCardRenderer>;
  let railRenderer: ReturnType<typeof createRailRenderer>;
  let timelineRenderer: ReturnType<typeof createTimelineRenderer>;
  let readState: ReturnType<typeof createReadState>;
  let commentsRenderer: ReturnType<typeof createCommentRenderer>;
  let composerRenderer: ReturnType<typeof createComposerRenderer>;
  let attachmentRenderer: ReturnType<typeof createAttachmentRenderer>;
  let composerControlsRenderer: ReturnType<typeof createComposerControlsRenderer>;
  let requestRenderer: ReturnType<typeof createRequestRenderer>;
  let composerPresentation: ReturnType<typeof createComposerPresentation>;
  let history: ReturnType<typeof createHistoryOwner>;
  let railShown: boolean | undefined;
  let labelsFilterable: boolean | undefined;
  let latest: RenderMessage | null = null;
  const activityCardIndexes = new Map<string, number>();
  let workspaceCatalogAvailable = false;
  let progressStamp: Extract<HostToPanel, { type: 'startupProgress' }> | null = null;
  let loadingGeneration = -1;
  let loadingTerminal = false;
  const acceptedHostMessageCounts = new Map<HostToPanel['type'], number>();
  let scheduledPaint: unknown = null;
  let paintedGeneration = -1;
  let paintedStages = new Set<Extract<PanelToHost, { type: 'painted' }>['stage']>();

  function acknowledgePaint() {
    const stamp = latest && latest.startup;
    if (!stamp || !Number.isSafeInteger(stamp.generation) || !kernel.afterPaint) return;
    if (scheduledPaint === stamp) return;
    scheduledPaint = stamp;
    kernel.afterPaint(function () {
      if (!latest || latest.startup !== stamp) return;
      scheduledPaint = null;
      if (paintedGeneration !== stamp.generation) {
        paintedGeneration = stamp.generation;
        paintedStages.clear();
      }
      const send = function (stage: Extract<PanelToHost, { type: 'painted' }>['stage']) {
        if (paintedStages.has(stage)) return;
        paintedStages.add(stage);
        const usableRows =
          stage === 'railReady' &&
          Array.from(document.querySelectorAll<HTMLElement>('#rail .railrow')).some((row) => !row.closest('[hidden]'));
        vscode.postMessage({
          type: 'painted',
          generation: stamp.generation,
          stage: stage,
          ...(usableRows ? { usableRows: true } : {}),
        });
      };
      send('railReady');
      if (!timelineRenderer.settled()) {
        acknowledgePaint();
        return;
      }
      if (list.querySelector('.timeline-owner:not([hidden]) article.turn')) send('firstCard');
      if (stamp.complete) send('completeRender');
    });
  }

  // The shared copy first, this webview's own second. They differ exactly once: a host
  // attaching for the first time has no state of its own, and the shared copy is how an editor
  // tab opens showing what the sidebar was showing rather than an unread list. Injected into
  // the page rather than posted, so it is there before the first render and there is no race.
  const saved = savedState.initial;
  let composerHidden = saved.composerHidden === true;
  const sessionState = createPanelSessionState({
    savedState,
    sendToHost: kernel.sendToHost,
    rail: () => railRenderer?.snapshot() ?? null,
    reading: () => readState?.snapshot() ?? null,
    comments: () => commentsRenderer?.snapshot() ?? null,
    promptFloor: () => composerPresentation?.floor() ?? null,
    composerHidden: () => composerHidden,
    refreshContext: (session) => {
      timelineRenderer?.drawRowContext(session);
      railRenderer?.drawRowContext(session);
    },
    refreshContexts: (sessions) => {
      timelineRenderer?.drawRowContexts(sessions);
      railRenderer?.drawRowContexts(sessions);
    },
  });
  const open = sessionState.open;
  const initialRailFilter = sessionState.initialRail.filter;
  const initialRailFilterId = sessionState.initialRail.filterId;
  const initialRailSort = sessionState.initialRail.sort;
  const initialRailDefaultSort = sessionState.initialRail.defaultSort;
  const initialRailWidth = sessionState.initialRail.width;
  const initialRailFolds = sessionState.initialRail.folds;
  const initialRailShowArchived = sessionState.initialRail.showArchived;
  const initialRailShowRuns = sessionState.initialRail.showRuns;
  const initialRailHeadLenses = sessionState.initialRail.headLenses;
  const initialRailGroupBy = sessionState.initialRail.groupBy;
  const initialRailDensity = sessionState.initialRail.density;
  // The cross this panel draws on a control that gets rid of something: the comment box's way
  // out, and the two boxes that clear a filter. The multiplication sign rather than the letter x,
  // which is narrower and sits off centre.
  //
  // Drawn for the eye alone. Every button wearing it carries its own word as its name, which is
  // what a screen reader announces, so nothing is lost to a reader who cannot see it.
  const CROSS = String.fromCharCode(215);
  const GLYPH = CARD_GLYPHS;
  const TWIST = { open: '\u25BE', shut: '\u25B8' };
  const ACTIONS = CARD_ACTIONS;
  const navigation = createNavigation({
    document,
    window,
    list,
    events: kernel.events,
    observe(target, callback, init) {
      const watcher = new MutationObserver(callback);
      watcher.observe(target, init);
      return watcher;
    },
    sendToHost: kernel.sendToHost,
    toTopLabel: ACTIONS.toTop,
  });
  const allControls = navigation.allControls;
  const rovingControls = navigation.rovingControls;
  const setRoving = navigation.setRoving;
  const placeFloat = (
    host: HTMLElement,
    target: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height'> | HTMLElement,
    bottomLimit?: number,
    topLimit?: number,
  ): void => {
    placeFloatInView(window, host, target, bottomLimit, topLimit);
  };

  // The state service writes this to the browser copy and the shared host copy. Neither copy
  // stands in for the other because their lifetimes differ.
  const saveOpen = () => sessionState.save();

  const hints = createHints({
    document,
    window,
    platform: navigator.platform,
    events: kernel.events,
    observe(target, callback, init) {
      new MutationObserver(callback).observe(target, init);
    },
    setDelay(callback, ms) {
      return setTimeout(callback, ms);
    },
    clearDelay(handle) {
      clearTimeout(handle);
    },
  });
  const pageStyle = createPageStyleOwner(document);

  // What the head row's hover says. The status is a glyph, the read state is a tint the
  // stylesheet paints, and the marks are drawn nowhere on the card at all, so not one of the
  // three can carry a hover of its own and all three ride here. The marks come last and in
  // the order the card carries them, which is the order turnview.ts decided and tested.
  // What the context menu's two entries do. Marking read is the same call opening the card makes.
  //
  // Marking unread has a step before it: paint records any open card as read, so unmarking
  // one whose body is open would be undone by the repaint on the very next line, and the
  // press would look like it did nothing. So the body is shut first, which is also what the
  // reader means by putting a turn back: they are done looking at it for now.
  // What a note is called on the two controls that act on it: its own words, run together and
  // cut to a line. A card draws a pair of controls per note, so a bare "Delete this note" is
  // the same name several times over and a reader who cannot see the strip has no way to tell
  // which one they are on.
  function syncCompactControls(sessions: PanelSessionRow[], showing: string | null, railUp?: boolean) {
    const shown = railUp === undefined ? railRenderer.visible() : railUp;
    chrome.updateResponsive(sessions || [], showing, shown, latest?.rail ?? [], railRenderer.snapshot().sort);
  }

  // The typed renderer keeps timeline parents and controls alive. This final pass only updates
  // page-wide layout state and assigns the initial roving stop when none exists yet.
  function finishTimelineRender() {
    timelineRenderer.refreshLayout();
    queueLiveRenderer.update(usageState && usageState.composer);
    navigation.refreshBackToTop();
    const controls = allControls();
    const roving = rovingControls(controls);
    const existing = roving.find(function (control) {
      return control.tabIndex === 0;
    });
    setRoving(existing || roving[0], controls);
  }

  function transientSessionOf(usage: PanelUsage | null) {
    const composer = usage && usage.composer;
    return composer && ((composer.live && composer.live.length) || (composer.queue && composer.queue.length))
      ? { id: composer.sessionId, title: composer.targetName }
      : null;
  }

  function usageAcrossSessionAdoption(previous: PanelUsage | null, next: PanelUsage | null): PanelUsage | null {
    const transient = transientSessionOf(previous);
    if (transient && latest?.showing === transient.id && next?.composer?.sessionId !== transient.id) {
      return next ? { ...next, composer: previous?.composer ?? null } : previous;
    }
    return next;
  }

  function railAcrossSessionAdoption(
    rail: PanelRailCard[],
    stats: Record<string, PanelStat[]>,
    adoptions: PanelSessionAdoption[],
  ): { rail: PanelRailCard[]; stats: Record<string, PanelStat[]> } {
    const transient = transientSessionOf(usageState);
    const provisional = latest?.showing;
    if (!transient || transient.id !== provisional || rail.some((row) => row.id === provisional)) {
      return { rail, stats };
    }
    const adoption = adoptions.find((candidate) => candidate.provisional === provisional);
    const durable = adoption && rail.find((row) => row.id === adoption.durable);
    if (!durable) {
      return { rail: latest?.rail ?? rail, stats: latest?.stats ?? stats };
    }
    const projectedStats = { ...stats };
    if (Object.prototype.hasOwnProperty.call(projectedStats, durable.id)) {
      projectedStats[provisional] = projectedStats[durable.id];
      delete projectedStats[durable.id];
    }
    return {
      // The projected row keeps the provisional id the host has no saved record under, so it
      // offers no rename until the rail names the durable id.
      rail: rail.map((row) => (row === durable ? { ...row, id: provisional, persisted: false } : row)),
      stats: projectedStats,
    };
  }

  function render(
    cards: RenderMessage['cards'],
    diagnosis: PanelDiagnosis | null,
    sessions: PanelSessionRow[],
    showing: string | null,
    olderHistory: PanelOlderHistory,
  ) {
    const drawn = cards;
    activityCardIndexes.clear();
    cards.forEach((card, index) => activityCardIndexes.set(card.key, index));
    const transient = transientSessionOf(usageState);
    const retained = transient ? { cards: [], sessions: [], transient: transient, showing: showing } : undefined;
    syncCompactControls(sessions, showing);
    const footers = history.footers(olderHistory);
    // The search owner answers whether it has anything to draw. Its root is one node that
    // outlives every repaint, so a result row the reader is standing on survives a poll.
    if (searchRenderer.draw(showing || '')) {
      timelineRenderer.showForeign([searchRenderer.element], footers, retained, showing);
      finishTimelineRender();
      return;
    }
    if (!drawn.length && !transient) {
      timelineRenderer.showForeign([history.empty(diagnosis, sessions)], footers, undefined, showing);
      finishTimelineRender();
      return;
    }
    timelineRenderer.update(
      {
        cards: drawn,
        sessions: sessions || [],
        transient: transient,
        showing: showing,
      },
      footers,
    );
    finishTimelineRender();
  }
  const sessionLabelIndex = createSessionLabelIndex();
  function sessionLabelsOf(id: string): string[] {
    return sessionLabelIndex.labels(latest?.rail, id);
  }
  // Kept per rail list, which every message replaces whole, so a draw over many rows reads each
  // row's labels once rather than once per row.
  let labeledMemo: { rail: readonly PanelRailCard[]; sessions: Set<string> } | null = null;
  function labeledSessions(): Set<string> {
    const rail = (latest && latest.rail) || [];
    if (labeledMemo?.rail !== rail) {
      labeledMemo = { rail, sessions: new Set(rail.filter((row) => row.labels?.length).map((row) => row.id)) };
    }
    return labeledMemo.sessions;
  }
  function sessionLabeled(id: string): boolean {
    return labeledSessions().has(id);
  }
  // A card whose print held keeps the menu context it was drawn with, so a rail message that
  // gives a session its first label or takes its last one rewrites that session's cards here.
  // A render or a selection needs none of this: repaint hands the comments over again, and that
  // rewrites every drawn card's context. Headings and rail cards take the fact from their own redraws.
  function refreshLabeledCards(before: Set<string>): void {
    const after = labeledSessions();
    const moved = new Set([...before].filter((id) => !after.has(id)));
    for (const id of after) {
      if (!before.has(id)) {
        moved.add(id);
      }
    }
    commentsRenderer.refreshSessionContexts(moved);
  }

  // Which direction the session heading's Mark as read entry offers, from the same read
  // marks and watermark the rail's own unread dot answers from. Undefined for a session with
  // nothing markable, the heading's answer to the rail's third, plain section: an entry
  // offered on nothing markable would toggle nothing. A word rather than a boolean, because
  // the manifest's when clause cannot tell a real `false` from a context key VS Code treats
  // as absent the same way.
  function sessionReadState(session: string): 'read' | 'unread' | undefined {
    const cards = (latest ? latest.cards : []).filter((card) => card.kind === 'turn' && card.sessionId === session);
    const markable = cards.filter((card) => readState.canMark(card));
    if (!markable.length) {
      return undefined;
    }
    return markable.every((card) => readState.isRead(card)) ? 'read' : 'unread';
  }

  // The navigation owner keeps the timeline's roving walk. The session list handles its own keys.
  navigation.installRoving();

  readState = createReadState({
    initial: saved,
    open,
    cards() {
      return latest ? latest.cards.filter((card) => card.kind === 'turn') : [];
    },
    newestTurnAt(id) {
      const rows = latest && Array.isArray(latest.rail) ? latest.rail : [];
      const row = rows.find(function (candidate) {
        return candidate.id === id;
      });
      return row && typeof row.newestTurnAt === 'number' ? row.newestTurnAt : null;
    },
    save: saveOpen,
    refreshSelection() {
      if (commentsRenderer) commentsRenderer.refreshSelection();
    },
  });

  commentsRenderer = createCommentRenderer({
    document,
    list,
    read: readState,
    open,
    initial: sessionState.initialComments,
    cross: CROSS,
    unreadWord: ACTIONS.statusUnread,
    events: { document: onDocument, window: onWindow },
    post(message) {
      vscode.postMessage(message as unknown as PanelToHost);
    },
    save: saveOpen,
    updateLatest(next) {
      if (latest) latest.comments = next.slice();
    },
    markdownOf,
    nextId,
    attachSlash(area) {
      composerRenderer.attachSlash(area);
    },
    releaseSlash(area) {
      composerRenderer.releaseSlash(area);
    },
    attachLineClipboard(area) {
      composerRenderer.attachLineClipboard(area);
    },
    labeled: (session) => sessionLabeled(session),
  });

  // The record a subagent row's figure opens, drawn over the popover the row itself sits in.
  // Declared before the outer instance so the outer one's row rendering can hand it to a figure,
  // and assigned below, because the nested instance pins the outer one when it is pressed.
  let figureDetails: StatDetailRenderer | undefined;

  const statDetails = createStatDetailRenderer({
    document,
    events: { document: onDocument },
    placeFloat(host, anchor, bottomLimit) {
      if (anchor.closest('.cnextturn')) {
        const composerLimit = Math.min(bottomLimit, statusBar.getBoundingClientRect().top - 6);
        placeFloat(host, anchor.getBoundingClientRect(), composerLimit, 6);
        return;
      }
      placeFloat(host, anchor, bottomLimit);
    },
    selectionWithin(node) {
      return commentsRenderer.selectionWithin(node);
    },
    renderRows(host, rows) {
      renderDetailRows(
        host,
        rows,
        (message) => {
          vscode.postMessage(message);
        },
        figureDetails,
      );
    },
  });

  figureDetails = createStatDetailRenderer({
    document,
    id: 'chippopnested',
    nested: true,
    events: { document: onDocument },
    placeFloat(host, anchor, bottomLimit) {
      placeFloat(host, anchor, bottomLimit);
    },
    selectionWithin(node) {
      return commentsRenderer.selectionWithin(node);
    },
    renderRows(host, rows) {
      renderDetailRows(host, rows, (message) => {
        vscode.postMessage(message);
      });
    },
    // A pressed figure pins the record over it and the popover holding it together, so a pinned
    // child does not die when its hover-only parent's grace fires. A figure the card body draws
    // stands in no popover, so it pins its own record and nothing else.
    onPin(figure) {
      if (statDetails.element.contains(figure)) {
        statDetails.pinCurrent();
      }
    },
  });
  statDetails.attachNested(figureDetails);

  // The reader's Timeline layout, taken from each render. The extension owns the setting, so
  // this is only the copy the last render carried.
  let layout: TimelineLayout = DEFAULT_TIMELINE_LAYOUT;
  const layoutDialog = createLayoutDialog({
    document,
    events: { document: onDocument, window: onWindow },
    layout: () => layout,
    post(message) {
      vscode.postMessage(message);
    },
  });

  const cardOptions: CardRendererOptions = {
    layout: () => layout,
    post(message) {
      vscode.postMessage(message);
    },
    read: readState,
    comments: commentsRenderer,
    statDetails,
    figureDetails,
  };
  cardRenderer = createCardRenderer(cardOptions);

  let chrome: ReturnType<typeof createChromeRenderer>;
  railRenderer = createRailRenderer({
    document,
    clock,
    onDraw: drawCounter('rail'),
    before: list,
    events: {
      document(type, listener, options) {
        onDocument(type, listener, options);
      },
      window(type, listener, options) {
        onWindow(type, listener, options);
      },
    },
    platform: navigator.platform,
    words: ACTIONS,
    twist: TWIST,
    cross: CROSS,
    initial: {
      filter: initialRailFilter,
      filterId: initialRailFilterId,
      sort: initialRailSort,
      defaultSort: initialRailDefaultSort,
      width: initialRailWidth,
      folds: initialRailFolds,
      showArchived: initialRailShowArchived,
      showRuns: initialRailShowRuns,
      headLenses: initialRailHeadLenses,
      groupBy: initialRailGroupBy,
      density: initialRailDensity,
    },
    sendToHost(message) {
      vscode.postMessage(message);
    },
    save: saveOpen,
    selectionWithin(node) {
      return node ? commentsRenderer.selectionWithin(node) : false;
    },
    fallbackFocus() {
      return (
        rovingControls().find(function (control) {
          return !railRenderer.element.contains(control);
        }) ||
        (chrome && chrome.compactMenu()) ||
        null
      );
    },
    showSession(session) {
      searchRenderer.clear();
      vscode.postMessage({ type: 'showSession', session });
    },
    archiveSession: (session) => sessionState.hide(session),
    unarchiveSession: (session) => sessionState.unarchive(session),
    setPinned: (session, pinned, openPinned) => sessionState.setPinned(session, pinned, openPinned),
    rowContext: (session, menuSection, persisted) =>
      sessionState.context(session, persisted, {
        menuSection,
        preventDefaultContextMenuItems: true,
        sessionLabeled: sessionLabeled(session),
      }),
    // The rail takes its width from the session beside it, so a drag changes the room the
    // request card has without a resize event of any kind.
    onLayoutChange() {
      composerPresentation?.place();
      composerRenderer?.layout();
      requestRenderer?.fitTabs();
    },
    onVisibilityChange(shown, filterable) {
      const visibilityChanged = railShown !== shown;
      const labelsChanged = labelsFilterable !== filterable;
      railShown = shown;
      labelsFilterable = filterable;
      if (chrome) {
        syncCompactControls(latest ? latest.sessions : [], latest ? latest.showing : null, shown);
      }
      // Construction reports visibility before the heading and history owners exist.
      if (timelineRenderer && history && (visibilityChanged || labelsChanged)) {
        timelineRenderer.refreshHeadings(
          undefined,
          visibilityChanged ? history.footers(latest?.olderHistory ?? null) : undefined,
        );
      }
    },
    // The rail is built before the timeline is, and it reports its label-editor state as it
    // starts. There is no heading to reword until the timeline owner exists.
    onLabelEditorChange() {
      if (timelineRenderer) timelineRenderer.refreshHeadings();
    },
    dismissHint() {
      hints.hide();
    },
    quietHint(target) {
      hints.press(target);
    },
    hintBody(kind, draw) {
      hints.body(kind, draw);
    },
    redrawHint(kind) {
      hints.redraw(kind);
    },
    contextClass,
    launcher: {
      open() {
        return !!chrome && chrome.launcherOpen();
      },
      anchor() {
        return chrome ? chrome.launcherAnchor() : null;
      },
      compactMenu() {
        return chrome ? chrome.compactMenu() : null;
      },
      close(returnFocus) {
        if (chrome) chrome.closeLauncher(returnFocus);
      },
      toggle(anchor) {
        if (chrome) chrome.toggleLauncher(anchor);
      },
    },
  });
  function applySessionLoading(stamp: { generation: number; complete?: boolean; failed?: boolean }, text?: string) {
    if (stamp.generation < loadingGeneration || (stamp.generation === loadingGeneration && loadingTerminal)) return;
    if (stamp.generation > loadingGeneration) {
      loadingGeneration = stamp.generation;
      loadingTerminal = false;
      progressStamp = null;
    }
    loadingTerminal = stamp.complete === true || stamp.failed === true;
    railRenderer.updateLoading(
      stamp.failed
        ? 'Some sessions were not read. Select a session to try again.'
        : stamp.complete
          ? null
          : (text ?? 'Reading sessions…'),
    );
  }

  const sessionDetails = createSessionDetails(
    document,
    {
      document(type, listener, options) {
        onDocument(type, listener, options);
      },
      window(type, listener, options) {
        onWindow(type, listener, options);
      },
    },
    function (message) {
      vscode.postMessage(message);
    },
    function () {
      const inList = rovingControls().find(function (control) {
        return !railRenderer.element.contains(control);
      });
      if (inList) return inList;
      return railRenderer.visible() ? railRenderer.newButton() : list.querySelector('.compactnew');
    },
  );
  // The host records which panel opened the native menu. The command then returns only to that
  // host, so another panel cannot open the same dialog from a stale browser-side arm.
  //
  // The row also keeps the control the press landed on, the way rail.ts keeps rename and label
  // arms: a rail card names a session the timeline may not be showing, so there is no
  // `.sessionrow` to place the dialog against or to send focus back to when it closes.
  const DETAILS_ARM_MS = 30_000;
  let detailsArm: { session: string; node: HTMLElement; at: number } | null = null;
  onDocument('contextmenu', function (event) {
    const start = event.target instanceof Element ? (event.target as HTMLElement) : null;
    if (start?.closest('#composer')) {
      vscode.postMessage({ type: 'armComposer' });
      return;
    }
    const row = start?.closest<HTMLElement>('.sessionrow') || start?.closest<HTMLElement>('.railrow');
    if (!row) {
      return;
    }
    const card = row.querySelector<HTMLElement>('.railcard');
    const session = card?.dataset.session ?? row.dataset.session;
    if (!session) {
      return;
    }
    const heading = row.classList.contains('sessionrow')
      ? start?.closest<HTMLElement>('.sessionheading > .sessionmenu:not(.sessionlayout):not(.sessionpin)') ||
        row.querySelector<HTMLElement>('.session')
      : null;
    const node = heading || card || row;
    detailsArm = { session, node, at: Date.now() };
    vscode.postMessage({ type: 'armSessionDetails', session });
  });
  // The panel's foot: the composer over the session column, the status bar across the
  // window's bottom edge, and two popovers drawn over the panel rather than inside it. Built
  // once and rewritten whenever what they say changes, which is at the end of a turn, when a
  // turn finishes anywhere in the folder, when the panel becomes visible, and on the press.
  // Every word in them, and the band each is drawn in, arrive already decided: this only puts
  // them on screen and sends the press back.
  composerRenderer = createComposerRenderer({
    words: ACTIONS,
    recovery: savedState,
    document,
    events: { document: onDocument, window: onWindow },
    sendToHost(message) {
      vscode.postMessage(message);
    },
    isFileStaging(session) {
      return attachmentRenderer && attachmentRenderer.isStaging(session);
    },
    platform: navigator.platform,
    hasLocalComments(session) {
      if (!session) return false;
      return commentsFor(commentsRenderer.snapshot(), session).length > 0;
    },
    commentEditorOpen() {
      return commentsRenderer.noteBeingWritten();
    },
    statDetails,
  });
  const composerBox = composerRenderer.element;
  const promptBox = composerRenderer.prompt;
  const composerSash = composerBox.querySelector<HTMLElement>('#footsash')!;
  const composerCollapse = composerBox.querySelector<HTMLButtonElement>('#composer-collapse')!;
  const composerRestore = composerBox.querySelector<HTMLButtonElement>('#composer-restore')!;
  function setComposerHidden(hidden: boolean, persist = true) {
    const active = document.activeElement;
    let returnFocus =
      hidden &&
      !!active &&
      (composerBox.contains(active) ||
        composerRenderer.slashPopover.contains(active) ||
        composerControlsRenderer?.ownsPickerFocus(active));
    if (hidden) composerPresentation?.cancelResize();
    composerHidden = hidden;
    composerBox.classList.toggle('composer-hidden', hidden);
    composerCollapse.hidden = hidden;
    composerRestore.hidden = !hidden;
    composerRenderer.setHidden(hidden);
    composerControlsRenderer?.setHidden(hidden);
    if (hidden) {
      const detailHadFocus = !!active && statDetails.element.contains(active);
      if (statDetails.dismissWithin(composerBox) && detailHadFocus) returnFocus = true;
    }
    const context = JSON.stringify({
      webviewSection: hidden ? 'arcComposerHidden' : 'arcComposer',
      ...(hidden ? { preventDefaultContextMenuItems: true } : {}),
    });
    composerBox.dataset.vscodeContext = context;
    composerSash.dataset.vscodeContext = context;
    composerSash.setAttribute('aria-label', hidden ? ACTIONS.composerHeightCollapsed : ACTIONS.composerHeight);
    composerPresentation?.measure();
    if (persist) saveOpen();
    if (returnFocus) composerRestore.focus();
  }
  setComposerHidden(composerHidden, false);
  composerCollapse.addEventListener('click', () => {
    setComposerHidden(true);
    composerRestore.focus();
  });
  composerRestore.addEventListener('click', () => {
    setComposerHidden(false);
    promptBox.focus();
  });
  attachmentRenderer = createAttachmentRenderer({
    document,
    composer: composerBox,
    prompt: promptBox,
    mount: composerRenderer.slots.files,
    noticeMount: composerRenderer.slots.notice,
    sendToHost(message) {
      vscode.postMessage(message);
    },
    session() {
      return composerRenderer.session();
    },
    view() {
      return usageState && usageState.composer;
    },
    updateFoot() {
      composerPresentation?.update(usageState);
    },
    setDropping(dropping) {
      composerRenderer.setDropping(dropping);
    },
    limits: { count: MAX_PROMPT_ASSETS, fileBytes: MAX_PROMPT_ASSET_BYTES, totalBytes: MAX_PROMPT_ASSET_TOTAL_BYTES },
  });
  const queueLiveRenderer = createQueueLiveRenderer({
    document,
    list,
    glyphs: GLYPH,
    twist: TWIST,
    comments: commentsRenderer,
    replaceLive(session, live) {
      const composer = usageState && usageState.composer;
      if (!composer || composer.sessionId !== session) return null;
      const next = { ...composer, live };
      usageState = { ...(usageState ?? { bar: null, menus: {}, launcher: null }), composer: next };
      return next;
    },
    sendToHost(message) {
      vscode.postMessage(message);
    },
    beforeEdit(session) {
      composerRenderer.endHistoryIntoPrompt();
      return composerRenderer.revision(composerRenderer.sessionIdentity(session));
    },
    allControls,
    rovingControls,
    setRoving,
  });
  // The command menu the box opens on a slash. It is a listbox rather than a menu: the reader
  // stays in the box and the arrow keys move a highlight, so the rows are options and never
  // tab stops of their own.
  // One live region for the whole panel. It is present and empty before any request arrives,
  // then changes only for a request id this host has not seen before. Putting a populated live
  // region inside every rebuilt card is announced unreliably on insertion and can repeat the
  // same request whenever an unrelated usage figure redraws the foot.
  // Where the box says which earlier prompt it has just put back. Its own region rather than
  // the one above, because writing into that one would take the place of a request waiting to
  // be read out, and a reader walking back through their prompts would never hear it.
  requestRenderer = createRequestRenderer({
    document,
    mount: composerRenderer.slots.asks,
    prompt: promptBox,
    moveAnnouncer: composerRenderer.walkAnnouncer,
    events: { window: onWindow },
    sendToHost(message) {
      vscode.postMessage(message);
    },
    afterDraw() {
      requestRenderer?.fitTabs();
      composerPresentation?.measure();
    },
  });
  const composerAction = createComposerAction(document, navigator.platform, composerRenderer, attachmentRenderer);
  composerControlsRenderer = createComposerControlsRenderer({
    document,
    mount: composerRenderer.slots.picks,
    composer: composerBox,
    events: { document: onDocument, window: onWindow },
    sendToHost(message) {
      vscode.postMessage(message);
    },
    selectionWithin(node) {
      return commentsRenderer.selectionWithin(node);
    },
    action: composerAction,
    afterDraw() {
      composerPresentation?.measure();
    },
    announce(words) {
      requestRenderer.announce(words);
    },
  });
  composerControlsRenderer.setHidden(composerHidden);
  const statusBar = composerControlsRenderer.statusBar;
  mountComposerPresentation(document, composerRenderer, composerControlsRenderer, requestRenderer);
  // What the foot was last told, kept apart from the render payload so a usage message can
  // arrive before the first render and still be drawn.
  let usageState: PanelUsage | null = null;
  // What is on screen now, so a repaint that changes nothing leaves the control the reader is
  // standing on alone. The age wording is part of it, so a figure growing stale still
  // redraws itself, and so is the state of both popovers.

  const projectSpend = createProjectSpendRenderer({
    document: document,
    clock,
    railMount: railRenderer.projectSpendMount,
    events: { document: onDocument, window: onWindow },
    twist: TWIST.open,
    selectionWithin(node) {
      return node ? commentsRenderer.selectionWithin(node) : false;
    },
    placeFloat: function (popover, anchor, bottomLimit, topLimit) {
      placeFloat(popover, anchor, bottomLimit, topLimit);
    },
    fallbackFocus: function () {
      return railRenderer.visible() ? railRenderer.newButton() : list.querySelector('.compactnew');
    },
  });
  chrome = createChromeRenderer({
    document: document,
    events: { document: onDocument },
    list: list,
    platform: navigator.platform,
    twist: TWIST.shut,
    pickerName: ACTIONS.picker,
    projectSpend: projectSpend,
    sendToHost: function (message) {
      vscode.postMessage(message);
    },
    showSession: function (session) {
      searchRenderer.clear();
      vscode.postMessage({ type: 'showSession', session: session });
    },
  });
  timelineRenderer = createTimelineRenderer({
    document,
    onDraw: drawCounter('timeline'),
    events: { window: onWindow },
    list,
    retained: list.querySelector<HTMLElement>('.controls')!,
    cardRenderer,
    cardOptions,
    open,
    saveOpen,
    twist: TWIST,
    // A closed card draws no layout-dependent body. Keep its print while the layout changes.
    cardPrint: (card) =>
      `${open.has(card.key) ? `${layout.cardLayout}:${layout.promptPosition}` : ''}:${cardPrint(card)}`,
    interactions: commentsRenderer,
    beforeCardDraw(node) {
      commentsRenderer.beforeCardDraw(node);
    },
    rowContext: (session, persisted) =>
      sessionState.context(session, persisted, {
        sessionRead: sessionReadState(session),
        sessionLabeled: sessionLabeled(session),
      }),
    // The heading's pin reads and writes the same set the rail's pin and the menu's Pin rows do.
    // Local membership changes redraw their contexts and pins. Rail replies reconcile mounted
    // headings from current membership, including headings held behind a replacement view.
    pinned: (session) => (sessionState.hidden.has(session) ? null : sessionState.pinnedTop.has(session)),
    setPinned: (session, pinned) => sessionState.setPinned(session, pinned),
    labels: sessionLabelsOf,
    labelOpen(id) {
      return railRenderer.labelOpen(id);
    },
    filterable() {
      return railRenderer.filterable();
    },
    filterByLabel(name) {
      railRenderer.filterByLabel(name);
    },
    toggleLabelEditor(id, button) {
      railRenderer.toggleLabelEditor(id, button);
    },
    toggleLayoutDialog(gear) {
      layoutDialog.toggle(gear);
    },
    syncDetails(rows) {
      sessionDetails.sync(rows);
    },
    footersDrawn(nodes) {
      history.drawn(nodes);
    },
    setRoving,
    allControls,
    rovingControls,
    fallbackFocus() {
      return railRenderer.visible() ? railRenderer.newButton() : list.querySelector('.compactnew');
    },
  });

  history = createHistoryOwner({
    document,
    sendToHost: kernel.sendToHost,
    hidden: sessionState.hidden,
    clearHidden: () => sessionState.clearHidden(),
    railVisible: () => railRenderer.visible(),
    hiddenEmpty: ACTIONS.hiddenEmpty,
    archivedNote,
    observe(_target, callback, init) {
      return typeof IntersectionObserver === 'function' ? new IntersectionObserver(callback, init) : null;
    },
  });
  composerPresentation = createComposerPresentation({
    document,
    window,
    list,
    events: { window: onWindow },
    initialFloor: sessionState.initialPromptFloor,
    save: saveOpen,
    composer: composerRenderer,
    attachments: attachmentRenderer,
    controls: composerControlsRenderer,
    requests: requestRenderer,
    queueLive: queueLiveRenderer,
    comments: commentsRenderer,
    statDetails,
    clock,
    rail: railRenderer,
    chrome,
    sendToHost: kernel.sendToHost,
  });

  function closeLauncher(returnFocus: boolean = true) {
    chrome.closeLauncher(returnFocus);
  }

  const visibility = mountRetainedVisibility(document, kernel.afterPaint, () => {
    railRenderer.place();
    composerPresentation.place();
    if (chrome.launcherOpen()) chrome.placeLauncher();
  });
  onWindow('resize', () => visibility.resize());

  onWindow('resize', function () {
    if (chrome.launcherOpen()) chrome.placeLauncher();
  });

  // One recorded card whose temporary child activity moved. The host has already rebuilt the
  // card from the tested turn projection, so Preact updates that keyed card in place while the
  // list, rail and composer stay untouched.
  function applyActivityCard(session: string, card: PanelCard) {
    if (!latest || !card || card.sessionId !== session) return;
    const at = activityCardIndexes.get(card.key);
    if (at === undefined) return;
    latest.cards[at] = card;
    timelineRenderer.updateCard(session, card);
  }

  onDocument('keydown', function (raw) {
    const e = raw as KeyboardEvent;
    if (e.key !== 'Escape' || !chrome.launcherOpen()) return;
    closeLauncher(true);
    e.preventDefault();
    e.stopPropagation();
  });

  function repaint() {
    if (!latest) return;
    composerRenderer.prune(latest.sessions);
    // The extension decides which sessions are hidden, because the cut it drives happens
    // before the parse and on that side. Adopting it here is what keeps two hosts from
    // disagreeing about what is away, and what stops one of them explaining an empty list as
    // empty transcripts when the real answer is that everything is hidden.
    sessionState.adopt(latest.hidden ?? [], latest.pinnedTop ?? [], latest.showing, latest.sessionAdoptions);
    // The notes travel the same way, and this is the path that catches a host attaching after
    // they were written: its own stored copy is whatever it last saw, and the extension's is
    // the answer. The timeline renderer holds structural changes while a comment editor is open.
    if (latest.comments) commentsRenderer.adopt(latest.comments);
    // The heading figures the host worked out, adopted before the draw that reads them. A rail
    // message writes them onto the last render as well, so this cannot put a stale copy back.
    timelineRenderer.applyStats(latest.stats || {});
    // Before the list, because the page reserves the foot's height at the bottom, and a
    // list laid out against last render's height would leave a gap or hide its last card.
    composerPresentation.update(usageState);
    layout = timelineLayout(latest.timelineLayout);
    render(latest.cards, latest.diagnosis, latest.sessions, latest.showing, latest.olderHistory);
    layoutDialog.sync();
    railRenderer.update(
      latest.rail,
      latest.labels,
      latest.views,
      latest.railFilters,
      latest.stats,
      workspaceCatalogAvailable,
    );
    // The rail's popovers can hang from a timeline heading, which the draw above can remount or
    // resize, so they are placed after both draws.
    railRenderer.place();
    projectSpend.update(latest.projectSpend);
    clock.tick();
    acknowledgePaint();
  }

  function replaceRows<T extends { id: string }>(
    held: readonly T[],
    changed: readonly T[],
    replaces: readonly string[],
  ): T[] {
    const replacements = new Map(changed.map((row) => [row.id, row]));
    const heldIds = new Set(held.map((row) => row.id));
    const replaced = new Set(replaces);
    return [
      ...changed.filter((row) => !heldIds.has(row.id)),
      ...held.flatMap((row) => {
        const replacement = replacements.get(row.id);
        return replacement ? [replacement] : replaced.has(row.id) ? [] : [row];
      }),
    ];
  }

  function replaceStats(
    held: Record<string, PanelStat[]>,
    changed: Record<string, PanelStat[]>,
    replaces: readonly string[],
  ): Record<string, PanelStat[]> {
    const next = { ...held };
    for (const id of replaces) {
      delete next[id];
    }
    return Object.assign(next, changed);
  }

  function firstSelection(): RenderMessage {
    return {
      type: 'render',
      cards: [],
      sessions: [],
      rail: [],
      stats: {},
      hidden: [],
      pinnedTop: [],
      comments: [],
      labels: [],
      views: [],
      railFilters: [],
      iconFonts: [],
      showing: null,
      sessionAdoptions: [],
      maxSessions: 1,
      olderHistory: null,
      projectSpend: null,
      diagnosis: null,
      usage: null,
      startup: null,
      timelineLayout: DEFAULT_TIMELINE_LAYOUT,
    };
  }

  // Everything this webview remembers, emptied, because the reader asked the extension to
  // forget it. Every field it holds goes: the stored copy has already been emptied,
  // and a set left standing here would be written straight back by the next save.
  //
  // The two sets the extension holds as well are emptied on the render that follows, but the
  // copy carried on the last one is what a repaint before it would adopt, so that goes too.
  function forgetEverything(freshSince: number) {
    open.clear();
    readState.reset(typeof freshSince === 'number' ? freshSince : 0);
    // The notes go with the rest. They are the most expensive thing the reader can make
    // here, and leaving them behind would mean a control that says it forgets everything
    // keeps the one thing worth keeping, on disk, with nothing on screen saying so.
    commentsRenderer.reset();
    sessionState.reset();
    setComposerHidden(false, false);
    railRenderer.reset();
    composerPresentation.resetFloor();
    composerPresentation.place();
    if (latest) {
      latest.hidden = [];
      latest.pinnedTop = [];
    }
    // The results on screen answered a query that has just gone, and the box that would ask
    // for them again is empty.
    searchRenderer.reset();
    saveOpen();
    repaint();
  }

  // Everything the extension sends, read by `parseHostToPanel` before any of it is drawn. A
  // message this side cannot read draws nothing and says so once, because a panel that acted on
  // half a message would leave the reader looking at a state the extension never sent.
  //
  // The handlers below are named by the message they answer, and `dispatchHostToPanel` names
  // every one of them. A message kind added to the contract and left out here does not compile.
  function receiveHostMessage(data: unknown) {
    const startedAt = performance.now();
    const message = parseHostToPanel(data);
    if (!message) {
      const kind = data && typeof data === 'object' && 'type' in data ? data.type : undefined;
      console.warn('Arc: a message from the extension was not understood, so nothing was drawn.', kind);
      return;
    }
    dispatchHostToPanel(message, {
      visibility: (msg) => visibility.receive(msg),
      startupProgress: function (msg) {
        if (
          msg.generation < loadingGeneration ||
          (msg.generation === loadingGeneration && loadingTerminal) ||
          (progressStamp &&
            (msg.generation < progressStamp.generation ||
              (msg.generation === progressStamp.generation &&
                (msg.epoch !== progressStamp.epoch || msg.sequence <= progressStamp.sequence))))
        )
          return;
        const text =
          msg.known > 0
            ? `Reading sessions… ${msg.completed.toLocaleString()} of ${msg.known.toLocaleString()} known sources checked.`
            : 'Reading sessions…';
        applySessionLoading(msg, text);
        progressStamp = msg;
        if (msg.complete && latest) {
          latest.startup = { generation: msg.generation, complete: true };
          acknowledgePaint();
        }
        if (startupStatus?.isConnected)
          startupStatus.textContent = msg.failed ? 'Some sessions were not read. Select a session to try again.' : text;
      },
      focusProjectSpend: function () {
        projectSpend.focus();
      },
      openLauncher: function (msg) {
        chrome.openLauncher(null, null, msg.custom);
      },
      labelEditor: function (msg) {
        railRenderer.receiveLabelEditor(msg.session, msg.heading, msg.rows);
      },
      // Another host wrote a label onto some other session, so an editor open here is
      // looking at counts the write moved and a label it does not name at all. It asks again for
      // its own session rather than being sent one: this side is the only one that knows
      // which session each host has open.
      labelsChanged: function (msg) {
        railRenderer.labelsChanged(msg.session);
      },
      // The label editor, asked for from a rail card's or a session heading's context menu.
      // Every host is told for the reason the comment box is, and the arm is what answers which
      // one saw the press.
      openLabelEditor: function (msg) {
        railRenderer.openArmedLabelEditor(msg.session);
      },
      // The command was selected from the native menu over this session heading. The extension
      // routes it back only to the host that reported opening the menu.
      showSessionDetails: function (msg) {
        const arm = detailsArm;
        detailsArm = null;
        const anchor = arm && arm.session === msg.session && Date.now() - arm.at <= DETAILS_ARM_MS ? arm.node : null;
        sessionDetails.openById(composerRenderer.sessionIdentity(msg.session), anchor);
      },
      // The rename and delete commands on a view section's heading. Both open the same small
      // editor, and the mode says which of the two the reader pressed. Every host is told, for
      // the reason the label editor is, and the rail answers only for a view it draws.
      openViewEditor: function (msg) {
        railRenderer.openViewEditor(msg.view, msg.mode);
      },
      // Rename session, asked for from a saved session's rail row or heading context menu. Every
      // host is told for the reason the label editor is, and the rail answers only on the row or
      // heading it saw pressed.
      openSessionRename: function (msg) {
        railRenderer.openSessionRename(msg.session, msg.title);
      },
      // The answer to the rename the editor sent. The rail and the heading already carry a new
      // name, so this only closes the editor or shows why the rename failed.
      sessionRenameResult: function (msg) {
        railRenderer.receiveSessionRenameResult(msg);
      },
      focusComposer: function (msg) {
        closeLauncher(false);
        composerRenderer.focus(msg.session);
      },
      contextDetail: function (msg) {
        composerControlsRenderer.receiveContext(msg.detail);
      },
      pathCompletion: function (msg) {
        composerRenderer.takePathCompletion(msg.session, msg.request, msg.token, msg.caret, msg.rows);
      },
      fileStaging: function (msg) {
        attachmentRenderer.staging(msg.session, msg.pending, msg.token);
      },
      fileStagingRejected: function (msg) {
        attachmentRenderer.rejected(msg.session, msg.token);
      },
      // What the reader's account has left, and how much each agent asks before it acts. Its
      // own message because it moves on its own clock: a turn ending, the panel coming back
      // into view, or the press on the strip itself, none of which is a reason to draw the
      // list again.
      usage: function (msg) {
        const before = transientSessionOf(usageState);
        usageState = usageAcrossSessionAdoption(usageState, msg.usage);
        const after = transientSessionOf(usageState);
        if (!latest) {
          composerPresentation.update(usageState);
          if (after) {
            render([], null, [], after.id, null);
          } else if (before && startupStatus) {
            syncCompactControls([], null);
            timelineRenderer.showForeign([startupStatus]);
            finishTimelineRender();
          }
          clock.tick();
        } else if ((before && before.id) !== (after && after.id)) repaint();
        else composerPresentation.update(usageState);
      },
      askRejected: function (msg) {
        requestRenderer.reject(msg.session, msg.id);
      },
      projectSpend: function (msg) {
        if (latest) {
          latest.projectSpend = msg.projectSpend;
        }
        projectSpend.update(msg.projectSpend);
      },
      layout: function (msg) {
        layout = msg.layout;
        if (latest) {
          latest.timelineLayout = msg.layout;
        }
        timelineRenderer.refresh();
        layoutDialog.sync();
      },
      // The live card alone, which is the one thing on the foot that moves while a turn runs.
      // Its own message because it arrives eight times a second: the usage message rebuilds
      // every control under the card, and the box among them is the one the reader may be
      // typing their next prompt into.
      live: function (msg) {
        queueLiveRenderer.applyLive(msg.session, msg.live);
      },
      activity: function (msg) {
        applyActivityCard(msg.session, msg.card);
      },
      // The session-state update, reworded after the read set moved: the rail's cards, in one
      // message, so nothing else on screen changes and nothing else is rebuilt. Kept on latest
      // so the next repaint draws the reworded state rather than the stale copy the render
      // carried.
      rail: function (msg) {
        sessionState.adopt(msg.hidden, msg.pinnedTop, sessionState.showing(), msg.sessionAdoptions);
        const projected = railAcrossSessionAdoption(msg.rail, msg.stats, msg.sessionAdoptions);
        const labeledBefore = latest ? labeledSessions() : null;
        if (latest) {
          latest.rail = projected.rail;
          latest.stats = projected.stats;
          latest.labels = msg.labels;
          latest.views = msg.views;
          latest.railFilters = msg.railFilters;
          latest.hidden = msg.hidden;
          latest.pinnedTop = msg.pinnedTop;
        }
        railRenderer.update(
          projected.rail,
          msg.labels,
          msg.views,
          msg.railFilters,
          projected.stats,
          workspaceCatalogAvailable,
        );
        // The rail's rows carry the reader's labels and the heading's figures, so the heading
        // over the session on screen is reworded from the same message its card is.
        timelineRenderer.refreshHeadings(projected.stats, history.footers(latest?.olderHistory ?? null));
        if (labeledBefore) {
          refreshLabeledCards(labeledBefore);
        }
        railRenderer.place();
      },
      // A command the extension answered itself, by opening one of the composer's own menus. The
      // reader typed it and pressed send, so focus goes into the menu the way a press on the
      // control puts it there: they asked for this list and the keyboard is where they are.
      openPick: function (msg) {
        composerRenderer.openSlash();
        composerControlsRenderer.openPick(msg.control);
      },
      // A waiting prompt taken back into the box to be changed. The box is a real element this
      // side owns and never rebuilds, so its value is set here rather than drawn from a payload:
      // rebuilding it would take the caret, the selection and the undo history with it, which
      // are the whole reason the prompt comes back to the box instead of to an editor of its own.
      takeDraft: function (msg) {
        const selected = composerRenderer.sessionIdentity(msg.session) === composerRenderer.session();
        const target = composerRenderer.takeDraft(msg.session, msg.text);
        if (!target) {
          return;
        }
        queueLiveRenderer.takeDraft(target);
        if (selected) {
          setComposerHidden(false);
          composerRenderer.focus(target);
        }
      },
      takeQueuedDraft: function (msg) {
        const selected = composerRenderer.sessionIdentity(msg.session) === composerRenderer.session();
        const target = composerRenderer.takeDraft(msg.session, msg.text, msg.revision);
        const session = target ?? composerRenderer.sessionIdentity(msg.session);
        vscode.postMessage({
          type: 'acceptQueuedEdit',
          value: msg.value,
          session,
          revision: msg.revision,
          currentRevision: composerRenderer.revision(session),
          accepted: target !== null,
        });
        if (!target) {
          return;
        }
        queueLiveRenderer.takeDraft(target);
        if (selected) {
          setComposerHidden(false);
          composerRenderer.focus(target);
        }
      },
      promptRecovery: (msg) => {
        savedState.importRecovery(msg.submittedPrompts);
      },
      requestPromptRecovery: (msg) => {
        vscode.postMessage({
          type: 'importPromptRecovery',
          submittedPrompts: savedState.recovery(),
          request: msg.request,
        });
      },
      restoreDraft: function (msg) {
        composerRenderer.restoreDraft(msg.session, msg.text, msg.revision);
      },
      // The reader's notes as the extension holds them, after any host changed one. Adopted
      // rather than merged, for the reason the hidden set is: this side keeps a copy so it can
      // draw, and the other side keeps the answer. A note written in the sidebar reaches an
      // editor tab through here and nowhere else.
      notes: function (msg) {
        commentsRenderer.adopt(msg.comments);
        // Onto the last render as well, the way the rail update is. A repaint re-adopts the
        // notes from there, and a repaint runs without a fresh render whenever a held one is
        // released or a search reply lands, so without this the note the reader just wrote
        // disappears off the card until some transcript happens to move.
        if (latest) {
          latest.comments = commentsRenderer.snapshot().slice();
        }
        // The panel's own stored copy moves with it, or a reload would restore the set from
        // before the note the reader just wrote in the other host.
        saveOpen();
      },
      // The comment box, asked for from a card's context menu. Every host is told, because the
      // extension cannot tell which one the menu was drawn over, and the arm is what answers
      // that: only the host that saw the press holds anything to open the box on, and a host
      // whose arm names another turn has nothing to do with this press.
      openComment: function (msg) {
        commentsRenderer.openArmed(msg.key);
      },
      // A selected-text command returns only to the host that armed the native menu. The
      // one-shot arm sends its selected markdown back to the extension host.
      sendSelectedText: function (msg) {
        commentsRenderer.handoffArmed(msg.key, msg.copyLabels);
      },
      // The read state a right-click on a card set. The set lives in here, so the command in the
      // extension can only say which turn and which way; the card itself does the rest, through
      // the same press the panel has always used.
      setRead: function (msg) {
        readState.set(msg.key, msg.read);
      },
      // Everything this panel remembers, thrown away. The extension has already emptied the
      // stored copy, and each host has to empty its own or the next save writes it back.
      forgetState: function (msg) {
        // The floor is stamped again on that side, because forgetting is starting over and
        // starting over means what opening the workspace for the first time meant.
        forgetEverything(msg.since);
      },
      // A whole session's read state, set from the menu over its rail card. The set and
      // the watermarks live in here, so the command can only say which session and which
      // way; the two presses below are where the rest of it is written.
      setSessionRead: function (msg) {
        readState.setSession(msg.session, msg.read);
      },
      // Archiving, from the menu over a session heading. The hidden set lives in here and is
      // posted back from the two presses below, so the command can only say which session
      // and which way.
      setSessionArchived: function (msg) {
        if (msg.archived) sessionState.hide(msg.session);
        else sessionState.unarchive(msg.session);
      },
      // Pinning, from the menu over a session heading. The pinned set lives in here and is
      // posted back from the press below, so the command can only say which session and
      // which way.
      setSessionPinned: function (msg) {
        sessionState.setPinned(msg.session, msg.pinned);
      },
      setComposerHidden: function (msg) {
        setComposerHidden(msg.hidden);
        const session = composerRenderer.session();
        if (!msg.hidden && session) composerRenderer.focus(session);
      },
      results: function (msg) {
        // The owner refuses a reply that no longer answers the pending query, and one the
        // reader has already dismissed by choosing a session.
        if (!searchRenderer.accept(msg.query, msg.scope, msg.hits)) return;
        // Through the hold, like a render: a reply can land more than a second after the
        // press, long enough for the reader to be mid-selection in a card, and the results
        // draw themselves the moment the selection lets go.
        repaint();
      },
      // A selection keeps the workspace-owned fields from the last render. The host sends
      // only the values choosing another session can change, and this merge gives the shared
      // repaint path one complete view again.
      selection: function (msg) {
        if (msg.startup) applySessionLoading(msg.startup);
        latest ??= firstSelection();
        latest.cards = msg.cards;
        latest.sessions = replaceRows(latest.sessions, msg.sessions, msg.replaces);
        latest.rail = replaceRows(latest.rail, msg.rail, msg.replaces);
        latest.stats = replaceStats(latest.stats, msg.stats, msg.replaces);
        latest.showing = msg.showing;
        latest.olderHistory = msg.olderHistory;
        latest.diagnosis = msg.diagnosis;
        latest.startup = msg.startup;
        usageState = msg.usage;
        repaint();
      },
      render: function (msg) {
        if (msg.startup) applySessionLoading(msg.startup);
        for (const adoption of msg.sessionAdoptions) {
          composerRenderer.adoptSessionIdentity(adoption.provisional, adoption.durable);
          railRenderer.adoptSessionIdentity(adoption.provisional, adoption.durable);
        }
        latest = msg;
        workspaceCatalogAvailable = true;
        usageState = msg.usage;
        pageStyle.setIconFonts(msg.iconFonts);
        repaint();
      },
    });
    const accepted = (acceptedHostMessageCounts.get(message.type) || 0) + 1;
    acceptedHostMessageCounts.set(message.type, accepted);
    if (accepted % 20 === 0) {
      vscode.postMessage({
        type: 'perf',
        kind: message.type,
        ms: Math.max(0, performance.now() - startedAt),
      });
    }
  }

  // Draw the empty rail shell before the first host payload arrives.
  railRenderer.update([], [], [], undefined, {});

  return { receiveHostMessage, dispose: visibility.dispose };
}
