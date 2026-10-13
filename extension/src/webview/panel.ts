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
import { replaceRows, replaceStats, RowDeltaReceiver } from './row-deltas.ts';
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
  readOnly?: boolean;
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

// Browser tests supply this optional callback to count full timeline and session list draws.
declare global {
  interface Window {
    __arcOnDraw?: (renderer: 'timeline' | 'rail') => void;
  }
}
function drawCounter(renderer: 'timeline' | 'rail'): (() => void) | undefined {
  return typeof window === 'undefined' || !window.__arcOnDraw ? undefined : () => window.__arcOnDraw!(renderer);
}

// Starts one panel page lifetime from the supplied browser ports.
export function startPanel(kernel: PanelKernel): StartedPanel {
  const list = kernel.dom.list;
  const startupStatus = list.querySelector<HTMLElement>('[data-startup-status]');
  const savedState = kernel.savedState;
  // This posting port wraps kernel.sendToHost. The acquired VS Code API remains inside host.ts.
  const vscode = Object.freeze({ postMessage: kernel.sendToHost });
  const onDocument = kernel.events.document;
  const onWindow = kernel.events.window;
  // All subscribed ages and durations share one panel clock.
  const clock = createClock({ document });
  // Shares the content-search owner between host-message dispatch and timeline rendering.
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
  let labelsFilterable: boolean | undefined;
  let latest: RenderMessage | null = null;
  // Session rows the host's last render and session list messages left in this panel.
  // A delta that cannot apply asks the host for a snapshot once, and the drawn rows stay until the snapshot arrives.
  const rowDeltas = new RowDeltaReceiver(() => vscode.postMessage({ type: 'rowsGap' }));
  const activityCardIndexes = new Map<string, number>();
  let workspaceCatalogAvailable = false;
  let progressStamp: Extract<HostToPanel, { type: 'startupProgress' }> | null = null;
  let loadingGeneration = -1;
  // A completed generation stays complete. A failure gives way to later status from its generation, such as an accepted retry.
  let loadingComplete = false;
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

  // The saved-state owner selects the shared host state, falling back to this webview's browser state.
  // Bootstrap supplies it before the first render.
  const saved = savedState.initial;
  let composerHidden = kernel.readOnly === true || saved.composerHidden === true;
  const sessionState = createPanelSessionState({
    readOnly: kernel.readOnly,
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
  // Clear and close controls use a multiplication sign. Each button supplies its own accessible name.
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

  // Save browser state and shared host state. Their separate lifetimes require both copies.
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

  // Synchronizes compact controls with current sessions and session list visibility.
  function syncCompactControls(sessions: PanelSessionRow[], showing: string | null, railUp?: boolean) {
    const shown = railUp === undefined ? railRenderer.visible() : railUp;
    chrome.updateResponsive(sessions || [], showing, shown, latest?.rail ?? [], railRenderer.snapshot().sort);
  }

  // Refresh page layout and queued cards, then retain the existing roving stop or select the first reachable control.
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
      // Projected provisional rows offer no rename until the session list names their durable identity.
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
    // The search root survives redraws, preserving focus on unchanged result rows.
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
  // Cache labeled-session membership for each complete session list payload.
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
  // Refresh retained card contexts when a session gains its first label or loses its last.
  // Full renders already refresh these contexts. Headings and session list cards update through their own renderers.
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

  // Returns read or unread for sessions with markable turns. Sessions without markable turns receive no menu entry.
  // String values distinguish unread from an absent context key in VS Code when clauses.
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
    operate(operation) {
      if (!kernel.readOnly) vscode.postMessage({ type: 'readerRead', operation });
    },
    refreshSelection() {
      if (commentsRenderer) commentsRenderer.refreshSelection();
    },
  });

  commentsRenderer = createCommentRenderer({
    readOnly: kernel.readOnly,
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

  // Nested figure details require the outer popover for pinning. Assign them after creating that outer instance.
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
        kernel.readOnly,
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
      renderDetailRows(
        host,
        rows,
        (message) => {
          vscode.postMessage(message);
        },
        undefined,
        kernel.readOnly,
      );
    },
    // Pin the containing popover with the nested record so its hover grace cannot close the child.
    // Figures in card bodies have no containing popover.
    onPin(figure) {
      if (statDetails.element.contains(figure)) {
        statDetails.pinCurrent();
      }
    },
  });
  statDetails.attachNested(figureDetails);

  // Retain the Timeline layout from the latest host render.
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
    readOnly: kernel.readOnly,
    layout: () => layout,
    post(message) {
      vscode.postMessage(message);
    },
    read: readState,
    comments: commentsRenderer,
    statDetails,
    figureDetails,
  };
  cardOptions.post = Object.assign(cardOptions.post, { readOnly: kernel.readOnly });
  cardRenderer = createCardRenderer(cardOptions);

  let chrome: ReturnType<typeof createChromeRenderer>;
  railRenderer = createRailRenderer({
    readOnly: kernel.readOnly,
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
    // Session list sash changes alter request-card width without a viewport resize event.
    onLayoutChange() {
      composerPresentation?.place();
      composerRenderer?.layout();
      requestRenderer?.fitTabs();
    },
    onVisibilityChange(shown, filterable) {
      const labelsChanged = labelsFilterable !== filterable;
      labelsFilterable = filterable;
      if (chrome) {
        syncCompactControls(latest ? latest.sessions : [], latest ? latest.showing : null, shown);
      }
      // Construction reports visibility before the heading owner exists.
      if (timelineRenderer && labelsChanged) {
        timelineRenderer.refreshHeadings();
      }
    },
    // Initial label-editor state arrives before the timeline owner exists.
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
  // The session list status line. A stamp that carries a source count shows it, and any other pending stamp shows the bare text.
  function loadingText(stamp: { completed?: number; known?: number }): string {
    return stamp.known
      ? `Reading sessions… ${(stamp.completed ?? 0).toLocaleString()} of ${stamp.known.toLocaleString()} known sources checked.`
      : 'Reading sessions…';
  }
  function applySessionLoading(stamp: {
    generation: number;
    complete?: boolean;
    failed?: boolean;
    held?: boolean;
    completed?: number;
    known?: number;
  }) {
    if (stamp.generation < loadingGeneration || (stamp.generation === loadingGeneration && loadingComplete)) return;
    if (stamp.generation > loadingGeneration) {
      loadingGeneration = stamp.generation;
      loadingComplete = false;
      progressStamp = null;
    }
    // A failed stamp hides the line. The host marks every later status of that generation failed too, so the line
    // returns with the next generation.
    // A held stamp hides the line after the session list has completed, but it stays pending, so its generation still accepts
    // the completion that the startup acknowledgement waits for.
    loadingComplete = stamp.complete === true && stamp.failed !== true;
    railRenderer.updateLoading(stamp.failed || stamp.complete || stamp.held ? null : loadingText(stamp));
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
  // The host routes the native-menu command to the panel that armed it.
  // Retain the pressed control for dialog placement and focus return, including session list rows outside the selected timeline.
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
  // The prompt box owner mounts stable controls and routes their actions to the host.
  composerRenderer = createComposerRenderer({
    readOnly: kernel.readOnly,
    words: ACTIONS,
    recovery: savedState,
    document,
    events: { document: onDocument, window: onWindow },
    sendToHost(message) {
      vscode.postMessage(message);
    },
    submissionNotice(session, words) {
      attachmentRenderer.submissionNotice(session, words);
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
    if (kernel.readOnly) hidden = true;
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
    composerRestore.hidden = kernel.readOnly === true || !hidden;
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
    if (kernel.readOnly) return;
    setComposerHidden(false);
    promptBox.focus();
  });
  attachmentRenderer = createAttachmentRenderer({
    readOnly: kernel.readOnly,
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
  // The request owner uses the prompt box's stable mounts and separate history announcer.
  // A persistent request live region avoids repeated announcements during unrelated updates.
  requestRenderer = createRequestRenderer({
    document,
    mount: composerRenderer.slots.asks,
    prompt: promptBox,
    moveAnnouncer: composerRenderer.walkAnnouncer,
    events: { window: onWindow },
    cross: CROSS,
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
  // Retain usage independently so it can arrive before the first render.
  let usageState: PanelUsage | null = null;
  // Project cost owns both faces and their shared dialog state.

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
    readOnly: kernel.readOnly,
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
    // Heading pins share session-state membership with session list pins and native menus.
    // Membership changes refresh mounted headings, including headings retained behind a replacement view.
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
    hiddenEmpty: ACTIONS.hiddenEmpty,
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

  // Replace one recorded card's temporary child activity in place, leaving the session list and prompt box intact.
  function applyActivityCard(session: string, card: PanelCard) {
    if (!latest || !card || card.sessionId !== session) return;
    const at = activityCardIndexes.get(card.key);
    if (at === undefined) return;
    latest.cards[at] = card;
    timelineRenderer.updateCard(session, card);
  }

  function applyActivityCards(cards: PanelCard[]) {
    if (!latest) return;
    const accepted = cards.filter((card) => {
      const at = activityCardIndexes.get(card.key);
      if (at === undefined || latest!.cards[at].sessionId !== card.sessionId) return false;
      latest!.cards[at] = card;
      return true;
    });
    timelineRenderer.updateCards(accepted);
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
    // Adopt host-owned archive and pin state before rendering sessions.
    sessionState.adopt(latest.hidden ?? [], latest.pinnedTop ?? [], latest.showing, latest.sessionAdoptions);
    // Adopt host-owned comments, including changes from other panels. The timeline defers structure changes during comment editing.
    if (latest.comments) commentsRenderer.adopt(latest.comments);
    // Adopt heading figures before drawing. Session list updates also replace these retained figures.
    timelineRenderer.applyStats(latest.stats || {});
    // Measure the prompt box before laying out the timeline, so its final card has the correct bottom clearance.
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
      latest.queryContext,
    );
    // Place session list popovers after both owners draw because their timeline-heading anchors can move.
    railRenderer.place();
    projectSpend.update(latest.projectSpend);
    clock.tick();
    acknowledgePaint();
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

  // Clear local saved state and retained host-owned sets. Otherwise the next save or repaint restores discarded values.
  function forgetEverything(freshSince: number) {
    open.clear();
    readState.reset(typeof freshSince === 'number' ? freshSince : 0);
    // Clear saved comments with the other panel state.
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
    // Clear results from the discarded search query.
    searchRenderer.reset();
    saveOpen();
    repaint();
  }

  // Parses host messages before dispatch. Unreadable messages produce a warning and no update.
  // The typed dispatch requires a handler for every message kind.
  const appliedFilters = new Map<string, number>();
  function receiveHostMessage(data: unknown) {
    const startedAt = performance.now();
    const parsed = parseHostToPanel(data);
    if (!parsed) {
      const kind = data && typeof data === 'object' && 'type' in data ? data.type : undefined;
      console.warn('Arc: a message from the extension was not understood, so nothing was drawn.', kind);
      return;
    }
    // Rebuild complete session lists from a row delta. A delta that cannot apply draws nothing.
    const message = parsed.type === 'render' || parsed.type === 'rail' ? rowDeltas.expand(parsed) : parsed;
    if (!message) return;
    dispatchHostToPanel(message, {
      readState: (msg) => {
        if (readState.synchronize(msg.state)) {
          repaint();
        }
      },
      applySessionFilter: (msg) => {
        if (kernel.readOnly || Date.now() >= msg.deadline || appliedFilters.has(msg.request)) return;
        for (const [request, deadline] of appliedFilters) {
          if (Date.now() >= deadline) appliedFilters.delete(request);
        }
        appliedFilters.set(msg.request, msg.deadline);
        railRenderer.applyQuery(msg.query);
        sessionState.save(msg.request);
      },
      health: (msg) => vscode.postMessage({ type: 'health', sequence: msg.sequence }),
      visibility: (msg) => visibility.receive(msg),
      startupProgress: function (msg) {
        if (latest && msg.queryContext) {
          if (
            latest.queryContext?.scope !== msg.queryContext.scope ||
            latest.queryContext?.revision !== msg.queryContext.revision ||
            latest.queryContext?.coverage !== msg.queryContext.coverage
          )
            searchRenderer.refresh();
          latest.queryContext = msg.queryContext;
          railRenderer.update(
            latest.rail,
            latest.labels,
            latest.views,
            latest.railFilters,
            latest.stats,
            workspaceCatalogAvailable,
            msg.queryContext,
          );
        }
        if (msg.queryOnly) return;
        if (
          msg.generation < loadingGeneration ||
          (msg.generation === loadingGeneration && loadingComplete) ||
          (progressStamp &&
            (msg.generation < progressStamp.generation ||
              (msg.generation === progressStamp.generation &&
                (msg.epoch !== progressStamp.epoch || msg.sequence <= progressStamp.sequence))))
        )
          return;
        applySessionLoading(msg);
        progressStamp = msg;
        if (msg.complete && latest) {
          latest.startup = { generation: msg.generation, complete: true };
          acknowledgePaint();
        }
        // A failed stamp clears the placeholder text.
        if (startupStatus?.isConnected && !msg.held) startupStatus.textContent = msg.failed ? '' : loadingText(msg);
      },
      focusProjectSpend: function () {
        projectSpend.focus();
      },
      openLauncher: function (msg) {
        chrome.openLauncher(railRenderer.visible() ? railRenderer.newMenu() : chrome.compactMenu(), null, msg.custom);
      },
      labelEditor: function (msg) {
        railRenderer.receiveLabelEditor(msg.session, msg.heading, msg.rows);
      },
      // Refresh an open label editor after workspace label counts change. Its owner knows which session needs fresh rows.
      labelsChanged: function (msg) {
        railRenderer.labelsChanged(msg.session);
      },
      // Open the label editor only in the panel whose native-menu arm matches the session.
      openLabelEditor: function (msg) {
        railRenderer.openArmedLabelEditor(msg.session);
      },
      // Open session details in the panel that armed the native menu.
      showSessionDetails: function (msg) {
        const arm = detailsArm;
        detailsArm = null;
        const anchor = arm && arm.session === msg.session && Date.now() - arm.at <= DETAILS_ARM_MS ? arm.node : null;
        sessionDetails.openById(composerRenderer.sessionIdentity(msg.session), anchor);
      },
      // Opens the requested view editor in rename or delete mode.
      openViewEditor: function (msg) {
        railRenderer.openViewEditor(msg.view, msg.mode);
      },
      // Opens the rename editor for the session whose native menu this panel armed.
      openSessionRename: function (msg) {
        railRenderer.openSessionRename(msg.session, msg.title);
      },
      // Finishes the matching rename request or displays its error.
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
      insertPrompt: function (msg) {
        // A collapsed Prompt box would take the text where the reader cannot see it.
        if (composerHidden && !kernel.readOnly) setComposerHidden(false);
        composerRenderer.insertAtCaret(msg.session, msg.text);
      },
      fileStaging: function (msg) {
        attachmentRenderer.staging(msg.session, msg.pending, msg.token, msg.count);
      },
      fileStagingRejected: function (msg) {
        attachmentRenderer.rejected(msg.session, msg.token);
      },
      // Updates account usage and prompt controls independently of the full render payload.
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
      // Updates temporary live cards through their owner without rebuilding prompt controls.
      live: function (msg) {
        queueLiveRenderer.applyLive(msg.session, msg.live);
      },
      activity: function (msg) {
        if ('cards' in msg) applyActivityCards(msg.cards);
        else applyActivityCard(msg.session, msg.card);
      },
      // Retain session list updates on latest so later repaints keep the current workspace state.
      rail: function (msg) {
        if (
          msg.queryContext &&
          (latest?.queryContext?.scope !== msg.queryContext.scope ||
            latest?.queryContext?.revision !== msg.queryContext.revision ||
            latest?.queryContext?.coverage !== msg.queryContext.coverage)
        )
          searchRenderer.refresh();
        sessionState.adopt(msg.hidden, msg.pinnedTop, sessionState.showing(), msg.sessionAdoptions);
        const projected = railAcrossSessionAdoption(msg.rail, msg.stats, msg.sessionAdoptions);
        const labeledBefore = latest ? labeledSessions() : null;
        if (latest) {
          latest.queryContext = msg.queryContext;
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
          msg.queryContext,
        );
        // Refresh timeline headings from the same labels and figures as the session list.
        timelineRenderer.refreshHeadings(projected.stats);
        if (labeledBefore) {
          refreshLabeledCards(labeledBefore);
        }
        railRenderer.place();
      },
      // Open the prompt setting menu requested by a submitted panel command.
      openPick: function (msg) {
        composerRenderer.openSlash();
        composerControlsRenderer.openPick(msg.control);
      },
      // Returns a queued prompt to the existing text field.
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
      // Adopts the host's comments as the complete current set.
      notes: function (msg) {
        commentsRenderer.adopt(msg.comments);
        // Retain comments on latest so deferred and search-triggered repaints cannot restore an older set.
        if (latest) {
          latest.comments = commentsRenderer.snapshot().slice();
        }
        // Save the updated browser copy for panel reloads.
        saveOpen();
      },
      // Opens a comment editor only for the turn this panel armed from the native menu.
      openComment: function (msg) {
        commentsRenderer.openArmed(msg.key);
      },
      // A selected-text command returns only to the host that armed the native menu. The
      // one-shot arm sends its selected markdown back to the extension host.
      sendSelectedText: function (msg) {
        commentsRenderer.handoffArmed(msg.key, msg.copyLabels);
      },
      // Applies the requested turn read state through the shared read owner.
      setRead: function (msg) {
        readState.set(msg.key, msg.read);
      },
      // Clear this panel's state after the host clears its saved copy.
      forgetState: function (msg) {
        // Reset the read-state floor to the host's fresh timestamp.
        savedState.withoutHostSave(() => forgetEverything(msg.since));
      },
      // Applies the requested session read state and its watermarks through the read owner.
      setSessionRead: function (msg) {
        readState.setSession(msg.session, msg.read);
      },
      // Applies session archive membership through the session-state owner.
      setSessionArchived: function (msg) {
        if (msg.archived) sessionState.hide(msg.session);
        else sessionState.unarchive(msg.session);
      },
      // Applies session pin membership through the session-state owner.
      setSessionPinned: function (msg) {
        sessionState.setPinned(msg.session, msg.pinned);
      },
      setComposerHidden: function (msg) {
        setComposerHidden(msg.hidden);
        const session = composerRenderer.session();
        if (!msg.hidden && session) composerRenderer.focus(session);
      },
      results: function (msg) {
        // Accept only replies to the pending query that the reader has not dismissed.
        if (!searchRenderer.accept(msg.query, msg.scope, msg.hits)) return;
        // Timeline selection defers result drawing until the reader releases it.
        repaint();
      },
      // Replace session-specific values while preserving workspace state from the latest render.
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
