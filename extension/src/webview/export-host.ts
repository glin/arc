import { EXPORT_HOST_POLICY, type SiteManifest } from './export-model.ts';
import type { CardView } from './payload-contracts.ts';
import { parsePanelToHost, type RenderMessage } from './protocol.ts';
import { DEFAULT_TIMELINE_LAYOUT } from '../view/timeline-layout.ts';
import { STATIC_PAGE_RAIL_WIDTH } from '../view/static-page.ts';
import { installMenu, type MenuEntry } from './static-menu.ts';
import { navigationShortcut } from './navigation.ts';

declare global {
  interface Window {
    acquireVsCodeApi(): import('./host.ts').VsCodeWebviewApi;
    __arcExportMenu: MenuEntry[];
    __arcExportMetrics: { cards: number; retainedBytes: number; largestCardBytes: number; pageTargetBytes: number };
  }
}

const decode = (id: string): unknown => {
  const encoded = document.getElementById(`arc-data-${id}`)?.textContent;
  if (!encoded) throw new Error('The captured session is unavailable.');
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};
const catalog = decode('manifest') as SiteManifest;
const targetBytes = 32 * 1024 * 1024;
let selected = catalog.root;
let pageIndex = 0;
let pageStart = 0;
let generation = 0;
let cards: CardView[] = [];
let state: Record<string, unknown> = { composerHidden: true, railWidth: STATIC_PAGE_RAIL_WIDTH, railShowRuns: true };
let layout: import('../view/timeline-layout.ts').TimelineLayout = {
  ...DEFAULT_TIMELINE_LAYOUT,
  promptPosition: 'above',
};
type ExportPlace = { session: string; start: number; page: number; turn?: string };
let initialVisit = true;
window.addEventListener('popstate', (event) => {
  const place = event.state?.arcExport as ExportPlace | undefined;
  if (place) show(place.session, place.page, place.turn, false, false, place.start);
});
document.addEventListener(
  'keydown',
  (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
    )
      return;
    const direction = navigationShortcut(event, navigator.platform);
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (direction === 'goBack') history.back();
    else history.forward();
  },
  true,
);
const approved = new WeakSet<MessageEvent>();
window.addEventListener(
  'message',
  (event) => {
    if (!approved.has(event)) event.stopImmediatePropagation();
  },
  true,
);
const deliver = (data: unknown) => {
  const event = new MessageEvent('message', { data });
  approved.add(event);
  window.dispatchEvent(event);
};
const RealDate = Date;
window.Date = class CapturedDate extends RealDate {
  constructor(value: string | number = catalog.capturedAt) {
    super(value);
  }
  static now() {
    return catalog.capturedAt;
  }
} as DateConstructor;

function show(session: string, index = 0, turn?: string, visit = true, append = false, restoredStart?: number): void {
  const captured = catalog.sessions.find((value) => value.key === session);
  if (!captured) return;
  const stamp = ++generation;
  const previousSession = selected;
  const previousStart = pageStart;
  selected = session;
  pageIndex = turn
    ? Math.max(
        0,
        captured.pages.findIndex((page) => page.keys.includes(turn)),
      )
    : index;
  pageStart = restoredStart ?? (append && previousSession === session ? previousStart : pageIndex);
  const retainedBytes = captured.pages.slice(pageStart, pageIndex + 1).reduce((bytes, page) => bytes + page.bytes, 0);
  if (retainedBytes > targetBytes) pageStart = pageIndex;
  if (visit) {
    const place: ExportPlace = { session, start: pageStart, page: pageIndex, ...(turn ? { turn } : {}) };
    const hash = '#arc-' + encodeURIComponent(JSON.stringify(place));
    if (initialVisit) history.replaceState({ arcExport: place }, '', hash);
    else history.pushState({ arcExport: place }, '', hash);
    initialVisit = false;
  }
  // Release abandoned cards before decoding the selected bounded page range.
  const retainedCards = append && pageStart === previousStart ? cards : [];
  cards = [];
  deliver({
    type: 'render',
    cards: retainedCards,
    sessions: catalog.rows,
    rail: catalog.rail,
    stats: catalog.stats,
    hidden: [],
    pinnedTop: [],
    comments: [],
    labels: [],
    views: [],
    railFilters: [],
    iconFonts: [],
    showing: session,
    sessionAdoptions: [],
    maxSessions: catalog.sessions.length,
    olderHistory: null,
    projectSpend: null,
    diagnosis: null,
    usage: null,
    startup: { generation: stamp, complete: false },
    timelineLayout: layout,
  } satisfies RenderMessage);
  queueMicrotask(() => {
    if (stamp !== generation) return;
    const assets = captured.pages.slice(pageStart, pageIndex + 1).flatMap((page) => page.cards ?? []);
    let retainedBytes = 0;
    let largestCardBytes = 0;
    const keys = captured.pages.slice(pageStart, pageIndex + 1).flatMap((page) => page.keys);
    const previousCards = new Map(retainedCards.map((card) => [card.key, card]));
    cards = assets.map((asset, position) => {
      retainedBytes += asset.bytes;
      largestCardBytes = Math.max(largestCardBytes, asset.bytes);
      const key = keys[position];
      return previousCards.get(key) ?? (decode(asset.id) as { card: CardView }).card;
    });
    window.__arcExportMetrics = { cards: cards.length, retainedBytes, largestCardBytes, pageTargetBytes: targetBytes };
    const parent = catalog.relationships.find((edge) => edge.to === session && edge.from !== session);
    const parentRow = parent && catalog.rows.find((row) => row.id === parent.from);
    const rows = catalog.rows.map<import('./protocol.ts').PanelSessionRow>((row) =>
      row.id === session && parentRow
        ? {
            ...row,
            parent: {
              id: parentRow.id,
              label: parentRow.label,
              relation:
                parent.kind === 'reader-started' ? 'reader' : parent.kind === 'dispatched' ? 'dispatched' : 'subagent',
            },
          }
        : row,
    );
    deliver({
      type: 'render',
      cards,
      sessions: rows,
      rail: catalog.rail.map((row) => ({ ...row, current: row.id === session })),
      stats: catalog.stats,
      hidden: [],
      pinnedTop: [],
      comments: [],
      labels: [],
      views: [],
      railFilters: [],
      iconFonts: [],
      showing: session,
      sessionAdoptions: [],
      maxSessions: rows.length,
      olderHistory:
        pageIndex + 1 < captured.pages.length
          ? { kind: 'load', label: 'Older turns', session, token: String(pageIndex + 1), auto: false }
          : null,
      projectSpend: null,
      diagnosis: null,
      usage: null,
      startup: { generation: stamp, complete: true },
      timelineLayout: layout,
    } satisfies RenderMessage);
    if (turn)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`article[data-key="${CSS.escape(turn)}"]`)?.scrollIntoView(),
      );
  });
}

window.acquireVsCodeApi = () => ({
  readOnly: true,
  getState: () => state,
  setState(value) {
    if (value && typeof value === 'object')
      state = { ...value, composerHidden: true, comments: [], hidden: [], pinnedTop: [], submittedPrompts: [] };
  },
  postMessage(raw) {
    const message = parsePanelToHost(raw);
    if (!message || EXPORT_HOST_POLICY[message.type] !== 'local') return;
    switch (message.type) {
      case 'ready':
        show(selected);
        break;
      case 'showSession': {
        const parent =
          message.parent && catalog.relationships.find((edge) => edge.to === selected && edge.from === message.session);
        if (parent) show(parent.from, 0, parent.turn);
        else show(message.session);
        break;
      }
      case 'showReaderParent': {
        const parent = catalog.relationships.find((edge) => edge.to === selected && edge.from === message.session);
        if (parent) show(parent.from, 0, parent.turn);
        break;
      }
      case 'loadOlder':
        if (message.session === selected && message.token === String(pageIndex + 1))
          show(selected, pageIndex + 1, undefined, true, true);
        break;
      case 'goBack':
        history.back();
        break;
      case 'goForward':
        history.forward();
        break;
      case 'setLayout':
        layout = { ...layout, [message.key]: message.value };
        deliver({ type: 'layout', layout });
        break;
      case 'copy':
        void navigator.clipboard?.writeText(message.text);
        break;
    }
  },
});
installMenu(document, window.__arcExportMenu, (command, context) => {
  const session = String(context.session ?? '');
  if (command === 'arc.copySessionId') void navigator.clipboard?.writeText(session);
  if (command === 'arc.showSessionDetails') deliver({ type: 'showSessionDetails', session });
  if (command === 'arc.copyTurnSummary') {
    const card = cards.find((value) => value.key === context.key);
    if (card) void navigator.clipboard?.writeText(card.summary);
  }
});
const header = document.querySelector<HTMLElement>('.demo-header')!;
const measure = () =>
  document.body.style.setProperty('--demo-header-height', `${header.getBoundingClientRect().height}px`);
new ResizeObserver(measure).observe(header);
measure();
document.getElementById('demo-theme')!.addEventListener('change', (event) => {
  const theme = (event.target as HTMLSelectElement).value;
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  document.body.className = theme === 'light' ? 'vscode-light' : 'vscode-dark';
});
