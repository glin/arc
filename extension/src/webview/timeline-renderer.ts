import { h, render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { resumeCommand } from '../domain/resume.ts';
import { PIN_GLYPH, sessionCount } from '../view/rail.ts';
import type { SessionDetailsRow } from './sessiondetails.ts';
import type { CommentRenderer } from './comments.ts';
import {
  cardHasBody,
  cardHeadingId,
  cardWords,
  type CardHost,
  type CardRenderer,
  type CardRendererOptions,
  type CardView,
} from './card.ts';
import type { StatDetailList } from './stat-detail.ts';
import { inlineText } from './inline-text.ts';
import { StatChip } from './stat-chip.ts';
import { TIMELINE_LAYOUT_WORDS } from '../view/timeline-layout.ts';
import { LAYOUT_DIALOG_ID } from './layout-dialog.ts';
import { ROVING_SELECTOR } from './navigation.ts';
import { nativeMenuIcon, pressNativeMenu } from './native-menu.ts';

export interface SessionRow {
  id: string;
  label?: string;
  fullLabel?: string;
  // Saved-record status controls whether the heading offers Rename.
  persisted?: boolean;
  agent?: string;
  agentKey?: string;
  at?: number;
  relative?: string;
  when?: string;
  parent?: SessionParentView;
}

interface SessionParentView {
  id: string;
  label: string;
  relation: 'dispatched' | 'subagent' | 'reader';
}

export interface SessionStat {
  kind: string;
  label: string;
  compactLabel?: string;
  name?: string;
  metric?: string;
  detail?: string;
  detailList?: StatDetailList;
  level?: string;
  focusable?: boolean;
  added?: number;
  removed?: number;
  word?: string;
  warnings?: readonly unknown[];
}

export interface TimelineView {
  cards: CardView[];
  sessions: SessionRow[];
  // Host's displayed session identity. Omission retains the last displayed identity for navigation checks.
  showing?: string | null;
  transient?: { id: string; title?: string } | null;
}

interface TimelineRendererOptions {
  document: Document;
  events: { window(type: string, listener: EventListenerOrEventListenerObject): void };
  list: HTMLElement;
  retained: HTMLElement;
  cardRenderer: CardRenderer;
  cardOptions: CardRendererOptions;
  open: Set<string>;
  saveOpen(): void;
  twist: { open: string; shut: string };
  cardPrint(card: CardView): string;
  interactions: CommentRenderer;
  beforeCardDraw(host: CardHost): void;
  rowContext(sessionId: string, persisted: boolean): string;
  // Pin state, or null when pinning is unavailable, including archived sessions.
  pinned(sessionId: string): boolean | null;
  setPinned(sessionId: string, pinned: boolean): void;
  labels(sessionId: string): string[];
  labelOpen(sessionId: string): boolean;
  filterable(): boolean;
  filterByLabel(name: string): void;
  toggleLabelEditor(sessionId: string, button: HTMLButtonElement): void;
  toggleLayoutDialog(gear: HTMLElement, session?: string): void;
  syncDetails(rows: readonly SessionDetailsRow[]): void;
  footersDrawn?(nodes: readonly Node[]): void;
  setRoving(node: HTMLElement | null, controls?: HTMLElement[]): void;
  allControls(): HTMLElement[];
  rovingControls(controls?: HTMLElement[]): HTMLElement[];
  fallbackFocus(): HTMLElement | null;
  // Optional full-draw callback for tests. Production omits it.
  onDraw?(): void;
}

interface SessionView {
  id: string;
  title: string;
  cards: CardView[];
  row?: SessionRow;
  stats: SessionStat[];
  labels: string[];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${encodeURIComponent(value)}`;
}

// Add the drawn turn count when it differs from the whole-session count.
// Compare formatted labels through sessionCount so the detail follows the chip's wording.
function withDrawnCount(chip: SessionStat, shown: number): SessionStat {
  const shownText = sessionCount(shown);
  const text = chip.compactLabel || chip.label;
  if (text === shownText) {
    return chip;
  }
  const shownDetail = `${shownText} shown.`;
  if (!chip.detailList) {
    return { ...chip, detail: [chip.detail, shownDetail].filter(Boolean).join('\n') };
  }
  const [firstLine, ...remainingLines] = (chip.detail || '').split('\n');
  const [firstEntry, ...remainingEntries] = chip.detailList.entries;
  return {
    ...chip,
    detail: [firstLine, shownDetail, ...remainingLines].join('\n'),
    detailList: {
      ...chip.detailList,
      entries: [...(firstEntry ? [firstEntry] : []), { label: shownDetail }, ...remainingEntries],
    },
  };
}

// Lead with cost and turns. Preserve host order for the remaining figures.
function orderedStats(stats: SessionStat[], shown: number): SessionStat[] {
  const cost = stats.find((candidate) => candidate.metric === 'cost');
  const turn = stats.find((candidate) => candidate.metric === 'turns');
  const rest = stats.filter((candidate) => candidate.metric !== 'cost' && candidate.metric !== 'turns');
  return [...(cost ? [cost] : []), ...(turn ? [withDrawnCount(turn, shown)] : []), ...rest];
}

function contextWord(stats: SessionStat[]): string {
  return stats.find((candidate) => candidate.word)?.word || '';
}

function expandableKeys(cards: CardView[]): string[] {
  return cards.filter(cardHasBody).map((card) => card.key);
}

function allOpen(cards: CardView[], open: Set<string>): boolean {
  const keys = expandableKeys(cards);
  return keys.length > 0 && keys.every((key) => open.has(key));
}

function headingLabel(
  session: SessionView,
  options: TimelineRendererOptions,
): { expanded: boolean; label: string; hint: string; action: string; detail: string } {
  const expanded = allOpen(session.cards, options.open);
  const action = expanded ? cardWords().collapseAllTurns : cardWords().expandAllTurns;
  // The heading's hint detail includes the last activity's full local time before the disclosure action.
  const when = session.row?.when;
  const detail = when ? `${cardWords().lastActive} ${when}. ${action}` : action;
  const hint = session.row?.fullLabel || session.row?.label || session.title;
  const context = contextWord(session.stats);
  return {
    expanded,
    hint,
    action,
    detail,
    label: `${cardWords().session} ${hint}` + (context ? `, ${context}` : '') + `, ${action}`,
  };
}

// Stroked gear for Timeline layout. Its larger drawing keeps the strokes visible beside the menu dots.
function layoutIcon() {
  return h('svg', { class: 'sessionlayouticon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, [
    h('circle', { cx: '8', cy: '8', r: '4', 'stroke-width': '2.1' }),
    h('path', {
      'stroke-width': '2.5',
      d: 'M13 8h2.2M3 8H0.8M8 3V0.8M8 13v2.2M11.54 4.46l1.55-1.55M4.46 4.46L2.91 2.91M4.46 11.54l-1.55 1.55M11.54 11.54l1.55 1.55',
    }),
  ]);
}

// Mounted pin redraw callbacks by session. They read current membership even while timeline content waits.
type PinRedraws = Map<string, Set<() => void>>;

// Keep the pin's accessible name stable. aria-pressed announces its state.
function SessionPin({
  session,
  title,
  options,
  pins,
}: {
  session: string;
  title: string;
  options: TimelineRendererOptions;
  pins: PinRedraws;
}) {
  const [, setRevision] = useState(0);
  useLayoutEffect(() => {
    const redraw = () => setRevision((value) => value + 1);
    const drawn = pins.get(session) ?? new Set<() => void>();
    drawn.add(redraw);
    pins.set(session, drawn);
    return () => {
      drawn.delete(redraw);
      if (!drawn.size && pins.get(session) === drawn) {
        pins.delete(session);
      }
    };
  }, [session, pins]);
  const pinned = options.pinned(session);
  if (pinned === null) {
    return null;
  }
  const words = cardWords();
  return h(
    'button',
    {
      class: pinned ? 'sessionmenu sessionpin is-pinned' : 'sessionmenu sessionpin',
      type: 'button',
      'data-control': `sessionpin:${session}`,
      'aria-pressed': pinned ? 'true' : 'false',
      'aria-label': `${words.railPinHint}: ${title}`,
      'data-hint': pinned ? words.railUnpinHint : words.railPinHint,
      'data-hint-detail': pinned ? words.railUnpinDetail : words.railPinDetail,
      onClick() {
        options.setPinned(session, !pinned);
      },
    },
    h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: PIN_GLYPH })),
  );
}

function SessionStats({
  stats,
  shown,
  parent,
  options,
}: {
  stats: SessionStat[];
  shown: number;
  parent: SessionParentView | undefined;
  options: TimelineRendererOptions;
}) {
  if (!stats.length && !parent) {
    return null;
  }
  const ordered = orderedStats(stats, shown);
  return h(
    'div',
    { class: 'sessionstats' },
    inlineText([
      ...ordered.map((chip, index) =>
        h(StatChip, {
          chip,
          statDetails: options.cardOptions.statDetails,
          key: chip.metric ?? index,
        }),
      ),
      parent ? h(SessionParent, { parent, options, key: 'parent' }) : null,
    ]),
  );
}

// The reader-started or delegated parent follows the heading figures. Its hint names
// the relation, and its press opens the parent session.
function SessionParent({ parent, options }: { parent: SessionParentView; options: TimelineRendererOptions }) {
  const relation = `${cardWords().sessionParentHint[parent.relation]} ${parent.label}`;
  return h(
    'button',
    {
      class: 'statchip sessionparent',
      type: 'button',
      tabIndex: -1,
      'data-control': `sessionparent:${parent.id}`,
      'data-hint': relation,
      'data-hint-detail': cardWords().sessionParentDetail,
      'aria-label': `${relation}, ${cardWords().sessionParentAction}`,
      onClick() {
        options.cardOptions.post({
          type: parent.relation === 'reader' ? 'showReaderParent' : 'showSession',
          session: parent.id,
        });
      },
    },
    inlineText([
      h('span', { class: 'sessionparentword' }, cardWords().sessionParentWord),
      h('span', { class: 'sessionparenttitle' }, parent.label),
    ]),
  );
}

function SessionLabels({ session, options }: { session: SessionView; options: TimelineRendererOptions }) {
  const button = useRef<HTMLButtonElement>(null);
  const title = session.title;
  const word = session.labels.length ? cardWords().labelOpen : cardWords().sessionLabelsAdd;
  const pressable = options.filterable();
  const labels = session.labels.map((label) =>
    pressable
      ? h(
          'button',
          {
            class: 'sessionlabel',
            type: 'button',
            tabIndex: -1,
            key: label,
            'data-label': label,
            'data-control': `sessionlabel:${label}`,
            'data-hint': label,
            'data-hint-detail': cardWords().sessionLabelFilterDetail,
            'aria-label': `${cardWords().railFilterTake} label ${label}`,
            onClick() {
              options.filterByLabel(label);
            },
          },
          label,
        )
      : h('span', { class: 'sessionlabel', title: label, key: label }, label),
  );
  const edit = h(
    'button',
    {
      class: 'sessionlabelact',
      key: 'edit',
      type: 'button',
      ref: button,
      'data-session': session.id,
      'data-control': `sessionlabels:${session.id}`,
      'aria-haspopup': 'dialog',
      'aria-controls': 'labelpop',
      'aria-expanded': String(options.labelOpen(session.id)),
      'aria-label': `${word}: ${title}`,
      onClick() {
        if (button.current) {
          options.toggleLabelEditor(session.id, button.current);
        }
      },
    },
    word,
  );
  return h(
    'div',
    {
      class: 'sessionlabels',
      role: 'group',
      'aria-label': cardWords().labelOpen,
    },
    inlineText([...labels, edit]),
  );
}

function detailsRow(session: SessionView): SessionDetailsRow {
  const row = session.row;
  return {
    id: session.id,
    label: row?.label || session.title,
    fullLabel: row?.fullLabel || row?.label || session.title,
    agent: row?.agent || session.cards[0]?.agent || '',
    // Build a resume command for each persisted row, so Session details works for any session list card.
    resumeCommand: row?.persisted ? resumeCommand(row.agentKey || '', session.id) : null,
  };
}

function SessionLower({ session, options }: { session: SessionView; options: TimelineRendererOptions }) {
  return h('div', { class: 'sessionlower' }, h(SessionLabels, { session, options }));
}

type CardRedraws = Map<string, (card: CardView, print: string) => void>;

function CardMount({
  card,
  print,
  options,
  hosts,
  redraws,
  onOpenChange,
}: {
  card: CardView;
  print: string;
  options: TimelineRendererOptions;
  hosts: Map<string, CardHost>;
  redraws: CardRedraws;
  onOpenChange(): void;
}) {
  const host = useRef<CardHost>(null);
  const drawn = useRef(card);
  const drawnPrint = useRef<string | null>(null);
  drawn.current = card;
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) {
      return undefined;
    }
    hosts.set(card.key, node);
    const publish = (next: CardView, nextPrint: string) => {
      drawn.current = next;
      drawnPrint.current = nextPrint;
      if (node.firstChild) options.beforeCardDraw(node);
      options.cardRenderer.draw(node, next, {
        isExpanded: () => options.open.has(card.key),
        setExpanded(expanded) {
          if (expanded) {
            options.open.add(card.key);
          } else {
            options.open.delete(card.key);
          }
          options.saveOpen();
          onOpenChange();
        },
        expandedChanged: onOpenChange,
      });
      options.cardRenderer.refreshClock(node, next);
    };
    redraws.set(card.key, publish);
    if (drawnPrint.current !== print) publish(card, print);
    return undefined;
  });
  useLayoutEffect(() => {
    if (host.current) {
      options.cardRenderer.refreshClock(host.current, drawn.current);
    }
  });
  useLayoutEffect(
    () => () => {
      const node = host.current;
      if (node) {
        hosts.delete(card.key);
        redraws.delete(card.key);
        options.cardRenderer.remove(node);
      }
    },
    [],
  );
  const common = {
    ref: host,
    class: card.kind === 'compaction' ? 'compaction' : `turn ${card.status}`,
    'data-key': card.key,
    'data-session': card.sessionId,
    'aria-labelledby': cardHeadingId(card.key),
  };
  return card.kind === 'compaction' ? h('section', common) : h('article', common);
}

type HeadingRedraws = Map<string, Set<(stats?: SessionStat[], card?: CardView) => void>>;

function headingPrint(session: SessionView, options: TimelineRendererOptions): string {
  return JSON.stringify([
    session.id,
    session.title,
    session.row,
    session.stats,
    session.labels,
    headingLabel(session, options),
    options.rowContext(session.id, session.row?.persisted === true),
    options.pinned(session.id),
    options.labelOpen(session.id),
    options.filterable(),
  ]);
}

function SessionHeading({
  session: supplied,
  options,
  hosts,
  headings,
  pins,
}: {
  session: SessionView;
  options: TimelineRendererOptions;
  hosts: Map<string, CardHost>;
  headings: HeadingRedraws;
  pins: PinRedraws;
}) {
  const [, setRevision] = useState(0);
  const source = useRef(supplied);
  const current = useRef(supplied);
  if (source.current !== supplied) {
    source.current = supplied;
    current.current = supplied;
  }
  const session = current.current;
  const heldFocus = useRef<HTMLElement | null>(null);
  const heldControls = useRef<HTMLElement[] | null>(null);
  const heldStop = useRef<HTMLElement | null>(null);
  const print = useRef('');
  print.current = headingPrint(session, options);
  useLayoutEffect(() => {
    const redraw = (stats?: SessionStat[], card?: CardView) => {
      if (card) {
        const index = current.current.cards.findIndex((candidate) => candidate.key === card.key);
        if (index < 0) return;
        current.current.cards[index] = card;
      }
      const next = { ...current.current, stats: stats ?? current.current.stats, labels: options.labels(supplied.id) };
      const nextPrint = headingPrint(next, options);
      if (nextPrint === print.current) return;
      const active = options.document.activeElement as HTMLElement | null;
      heldFocus.current = active && row.current?.contains(active) ? active : null;
      heldControls.current = Array.from(row.current?.querySelectorAll<HTMLElement>(ROVING_SELECTOR) ?? []);
      heldStop.current = heldControls.current.find((node) => node.tabIndex === 0) ?? null;
      current.current = next;
      print.current = nextPrint;
      setRevision((value) => value + 1);
    };
    const mounted = headings.get(supplied.id) ?? new Set();
    mounted.add(redraw);
    headings.set(supplied.id, mounted);
    return () => {
      mounted.delete(redraw);
      if (!mounted.size) headings.delete(supplied.id);
    };
  }, [supplied.id, options, headings]);
  const button = useRef<HTMLButtonElement>(null);
  const headingId = stableId('session-heading', session.id);
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const prior = heldControls.current;
    heldControls.current = null;
    if (!prior) return;
    const local = Array.from(row.current?.querySelectorAll<HTMLElement>(ROVING_SELECTOR) ?? []);
    const priorStop = heldStop.current;
    heldStop.current = null;
    if (
      local.length === prior.length &&
      local.every((node, index) => node === prior[index]) &&
      (!priorStop || priorStop.tabIndex === 0)
    ) {
      heldFocus.current = null;
      return;
    }
    const controls = options.allControls();
    const visible = options.rovingControls(controls);
    const active = options.document.activeElement as HTMLElement | null;
    const held = heldFocus.current;
    const displaced = held && active !== held && (!active || active === options.document.body || !active.isConnected);
    const fallback = displaced
      ? held.isConnected
        ? held
        : row.current?.querySelector<HTMLElement>('.sessionlabelact')
      : null;
    const stop =
      fallback ||
      (active && visible.includes(active) ? active : null) ||
      (priorStop && visible.includes(priorStop)
        ? priorStop
        : priorStop
          ? row.current?.querySelector<HTMLElement>('.sessionlabelact')
          : null) ||
      visible.find((node) => node.tabIndex === 0) ||
      visible[0] ||
      null;
    options.setRoving(stop, controls);
    if (displaced) fallback?.focus({ preventScroll: true });
    heldFocus.current = null;
  });
  const groupId = stableId('session-turns', session.id);
  const state = headingLabel(session, options);
  const turns = session.cards.filter((card) => card.kind !== 'compaction');
  const title = session.title;
  useLayoutEffect(() => {
    const reconcile = () => {
      if (row.current) {
        row.current.dataset.vscodeContext = options.rowContext(session.id, session.row?.persisted === true);
      }
      setRevision((value) => value + 1);
    };
    const unsubscribe = options.cardOptions.read.subscribe(reconcile);
    reconcile();
    return unsubscribe;
  }, [session.id, session.row?.persisted, options]);
  const toggle = () => {
    const keys = expandableKeys(session.cards);
    const shutting = keys.length > 0 && keys.every((key) => options.open.has(key));
    for (const key of keys) {
      if (shutting) {
        options.open.delete(key);
      } else {
        options.open.add(key);
      }
    }
    const marked =
      !shutting &&
      options.cardOptions.read.markMany(
        session.cards
          .filter((card) => cardHasBody(card) && hosts.has(card.key) && options.cardOptions.read.canMark(card))
          .map((card) => card.key),
      );
    for (const key of keys) {
      const host = hosts.get(key);
      if (host) {
        options.cardRenderer.refresh(host);
      }
    }
    const next = headingLabel(session, options);
    if (button.current) {
      button.current.setAttribute('aria-expanded', String(next.expanded));
      button.current.setAttribute('aria-label', next.label);
      button.current.setAttribute('data-hint-detail', next.detail);
      const twist = button.current.querySelector('.twist');
      if (twist) {
        twist.textContent = next.expanded ? options.twist.open : options.twist.shut;
      }
    }
    options.cardOptions.comments.refreshSelection();
    if (!marked) {
      options.saveOpen();
    }
    setRevision((value) => value + 1);
  };
  return h(
    'div',
    {
      class: 'sessionrow',
      ref: row,
      'data-session': session.id,
      'data-vscode-context': options.rowContext(session.id, session.row?.persisted === true),
    },
    [
      h('h2', { class: 'sessionheading', id: headingId }, [
        h(
          'button',
          {
            class: 'session',
            ref: button,
            'data-hint': state.hint,
            'data-hint-detail': state.detail,
            'data-control': `session:${session.id}`,
            'aria-expanded': String(state.expanded),
            'aria-controls': groupId,
            'aria-label': state.label,
            onClick: toggle,
          },
          [
            h('span', { class: 'twist' }, state.expanded ? options.twist.open : options.twist.shut),
            h('span', { class: 'name' }, title),
          ],
        ),
        h(SessionPin, { session: session.id, title, options, pins }),
        h(
          'button',
          {
            class: 'sessionmenu',
            'data-control': `sessionmenu:${session.id}`,
            'aria-haspopup': 'menu',
            'aria-label': `${cardWords().sessionActions}: ${title}`,
            'data-hint': cardWords().sessionActions,
            'data-hint-detail': cardWords().sessionActionsDetail,
            onClick: pressNativeMenu,
          },
          nativeMenuIcon(),
        ),
        // Every session heading opens the shared Timeline options dialog. The dialog marks its opener expanded.
        h(
          'button',
          {
            class: 'sessionmenu sessionlayout',
            type: 'button',
            'data-control': `sessionlayout:${session.id}`,
            'aria-haspopup': 'dialog',
            'aria-controls': LAYOUT_DIALOG_ID,
            'aria-expanded': 'false',
            'aria-label': TIMELINE_LAYOUT_WORDS.title,
            'data-hint': TIMELINE_LAYOUT_WORDS.title,
            'data-hint-detail': TIMELINE_LAYOUT_WORDS.hintDetail,
            onClick(event: MouseEvent) {
              options.toggleLayoutDialog(
                event.currentTarget as HTMLElement,
                session.row?.persisted === true ? session.id : undefined,
              );
            },
          },
          layoutIcon(),
        ),
        session.row?.when ? h('span', { class: 'sr-only' }, session.row.when) : null,
      ]),
      h(SessionStats, { stats: session.stats, shown: turns.length, parent: session.row?.parent, options }),
      h(SessionLower, { session, options }),
    ],
  );
}

function Session({
  session,
  options,
  hosts,
  redraws,
  prints,
  pins,
  headings,
}: {
  session: SessionView;
  options: TimelineRendererOptions;
  hosts: Map<string, CardHost>;
  redraws: CardRedraws;
  prints: Map<string, string>;
  pins: PinRedraws;
  headings: HeadingRedraws;
}) {
  const redrawHeading = () => headings.get(session.id)?.forEach((redraw) => redraw());
  return h(
    'section',
    {
      class: 'sessionsection',
      'data-session': session.id,
      'aria-labelledby': stableId('session-heading', session.id),
    },
    [
      h(SessionHeading, { session, options, hosts, pins, headings }),
      h('div', { class: 'group', id: stableId('session-turns', session.id), 'data-session': session.id }, [
        h('div', { class: 'transientcards', 'data-session': session.id }),
        ...session.cards.map((card) =>
          h(CardMount, {
            card,
            print: prints.get(card.key) || '',
            options,
            hosts,
            redraws,
            onOpenChange: redrawHeading,
            key: card.key,
          }),
        ),
      ]),
    ],
  );
}

function Timeline({
  sessions,
  options,
  hosts,
  redraws,
  prints,
  pins,
  headings,
}: {
  sessions: SessionView[];
  options: TimelineRendererOptions;
  hosts: Map<string, CardHost>;
  redraws: CardRedraws;
  prints: Map<string, string>;
  pins: PinRedraws;
  headings: HeadingRedraws;
}) {
  return h(
    'div',
    { class: 'timeline-tree' },
    sessions.map((session) =>
      h(Session, {
        session,
        options,
        hosts,
        redraws,
        prints,
        pins,
        headings,
        key: session.id,
      }),
    ),
  );
}

function sessionsOf(
  view: TimelineView,
  stats: Record<string, SessionStat[]>,
  options: TimelineRendererOptions,
): SessionView[] {
  const rows = new Map(view.sessions.map((row) => [row.id, row]));
  const order: string[] = [];
  const cards = new Map<string, CardView[]>();
  for (const card of view.cards) {
    if (!cards.has(card.sessionId)) {
      order.push(card.sessionId);
      cards.set(card.sessionId, []);
    }
    cards.get(card.sessionId)!.push(card);
  }
  if (view.transient && !cards.has(view.transient.id)) {
    order.unshift(view.transient.id);
    cards.set(view.transient.id, []);
  }
  return order.map((id) => ({
    id,
    title:
      cards.get(id)?.[0]?.sessionTitle || (view.transient?.id === id ? view.transient.title : undefined) || 'Session',
    cards: cards.get(id)!,
    row: rows.get(id),
    stats: stats[id] || [],
    labels: options.labels(id),
  }));
}

interface ReadingAnchor {
  key: string;
  top: number;
}

interface SelectionPoint {
  key: string;
  offset: number;
  node: Node;
  nodeOffset: number;
}
interface HeldSelection {
  anchor: SelectionPoint;
  focus: SelectionPoint;
}

function cardForNode(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>('[data-key]') || null;
}

function textOffset(document: Document, host: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(host);
  before.setEnd(node, offset);
  return before.cloneContents().textContent?.length || 0;
}

function pointAt(document: Document, host: HTMLElement, offset: number): { node: Node; offset: number } {
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let left = Math.max(0, offset);
  let node = walk.nextNode();
  while (node) {
    const length = node.textContent?.length || 0;
    if (left <= length) {
      return { node, offset: left };
    }
    left -= length;
    node = walk.nextNode();
  }
  return { node: host, offset: host.childNodes.length };
}

export interface TimelineRenderer {
  settled(): boolean;
  refreshLayout(): void;
  drawRowContext(session: string): void;
  refreshHeadings(stats?: Record<string, SessionStat[]>, footers?: Node[]): void;
  // Reconcile the named mounted headings without replacing timeline content.
  drawRowContexts(sessions: readonly string[]): void;
  update(view: TimelineView, footers?: Node[]): void;
  updateCard(session: string, card: CardView): boolean;
  updateCards(cards: readonly CardView[]): boolean;
  showForeign(nodes: Node[], footers?: Node[], retained?: TimelineView, showing?: string | null): void;
  // Adopt the heading figures a host message carried, without drawing. The caller draws next.
  applyStats(stats: Record<string, SessionStat[]>): void;
  // Draw the headings again, adopting new figures when a message carried them.
  refresh(stats?: Record<string, SessionStat[]>): void;
  element: HTMLElement;
}

export function createTimelineRenderer(options: TimelineRendererOptions): TimelineRenderer {
  const root = options.document.createElement('div');
  root.className = 'timeline-root';
  const tree = options.document.createElement('div');
  tree.className = 'timeline-owner';
  const foreign = options.document.createElement('div');
  foreign.className = 'timeline-foreign';
  const footer = options.document.createElement('div');
  footer.className = 'timeline-footer';
  root.append(tree, foreign, footer);
  for (const child of Array.from(options.list.children)) {
    if (child === options.retained) {
      continue;
    }
    if (child.matches('[data-startup-status]')) {
      foreign.appendChild(child);
    } else {
      child.remove();
    }
  }
  options.list.appendChild(root);

  const hosts = new Map<string, CardHost>();
  const redraws: CardRedraws = new Map();
  const cardIndexes = new Map<string, number>();
  const deferredCards = new Map<string, CardView>();
  const pins: PinRedraws = new Map();
  const headings: HeadingRedraws = new Map();
  const renderedCards = new Map<string, CardView>();
  const renderedPrints = new Map<string, string>();
  // Latest host-supplied session figures, independent of the drawn view.
  // render and rail messages both update them. The last arrival takes precedence.
  let sessionStats: Record<string, SessionStat[]> = {};
  let latest: TimelineView | null = null;
  let renderedShowing: string | null | undefined;
  // Keep replacement views and card updates separately so Activity updates cannot discard pending search results.
  let pendingView: (() => void) | null = null;
  let pendingViewReplaces = false;
  // Navigation held by a comment editor. Closing the editor releases it even if its quote remains selected.
  let pendingViewEscapes = false;
  let pendingRefresh: (() => void) | null = null;
  let pendingCard: (() => void) | null = null;

  const visibleControl = (node: HTMLElement | null | undefined): node is HTMLElement =>
    !!node && node.isConnected && !node.closest('[hidden]');

  const normalizeRoving = (preferred: HTMLElement | null | undefined): HTMLElement | null => {
    const controls = options.allControls();
    const visible = options.rovingControls(controls);
    const stop = preferred && visible.includes(preferred) ? preferred : visible[0] || null;
    options.setRoving(stop, controls);
    return stop;
  };

  const sharedFallback = (): HTMLElement | null =>
    options.rovingControls().find((control) => !root.contains(control)) || options.fallbackFocus();

  const survivingTurnControl = (keys: string[], index: number): HTMLElement | null => {
    if (index < 0) {
      return null;
    }
    return (
      [...keys.slice(index + 1), ...keys.slice(0, index).reverse()]
        .map((key) => hosts.get(key)?.querySelector<HTMLElement>('.head:not(.statichead)'))
        .find(visibleControl) || null
    );
  };

  const labelFallback = (session: string | undefined, label: string | undefined): HTMLElement | null => {
    if (!session) {
      return null;
    }
    const section = Array.from(tree.querySelectorAll<HTMLElement>('section.sessionsection')).find(
      (candidate) => candidate.dataset.session === session,
    );
    if (!section) {
      return null;
    }
    const matching = label
      ? Array.from(section.querySelectorAll<HTMLElement>('button.sessionlabel')).find(
          (candidate) => candidate.dataset.label === label,
        )
      : null;
    return matching || section.querySelector<HTMLElement>('.sessionlabelact');
  };

  const readingAnchor = (): ReadingAnchor | null => {
    if (!options.document.scrollingElement?.scrollTop) {
      return null;
    }
    for (const node of Array.from(tree.querySelectorAll<HTMLElement>('.turn:not(.clive), .compaction'))) {
      const box = node.getBoundingClientRect();
      if (box.bottom > 0 && box.top < window.innerHeight && node.dataset.key) {
        return { key: node.dataset.key, top: box.top };
      }
    }
    return null;
  };

  const heldSelection = (): HeldSelection | null => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      return null;
    }
    const anchorHost = selection.anchorNode ? cardForNode(selection.anchorNode) : null;
    const focusHost = selection.focusNode ? cardForNode(selection.focusNode) : null;
    if (
      !anchorHost?.dataset.key ||
      !focusHost?.dataset.key ||
      !root.contains(anchorHost) ||
      !root.contains(focusHost) ||
      !selection.anchorNode ||
      !selection.focusNode
    ) {
      return null;
    }
    return {
      anchor: {
        key: anchorHost.dataset.key,
        offset: textOffset(options.document, anchorHost, selection.anchorNode, selection.anchorOffset),
        node: selection.anchorNode,
        nodeOffset: selection.anchorOffset,
      },
      focus: {
        key: focusHost.dataset.key,
        offset: textOffset(options.document, focusHost, selection.focusNode, selection.focusOffset),
        node: selection.focusNode,
        nodeOffset: selection.focusOffset,
      },
    };
  };

  const restoreSelection = (held: HeldSelection | null) => {
    if (!held) {
      return;
    }
    const anchorHost = hosts.get(held.anchor.key);
    const focusHost = hosts.get(held.focus.key);
    if (!anchorHost || !focusHost) {
      return;
    }
    const anchor = held.anchor.node.isConnected
      ? { node: held.anchor.node, offset: held.anchor.nodeOffset }
      : pointAt(options.document, anchorHost, held.anchor.offset);
    const focus = held.focus.node.isConnected
      ? { node: held.focus.node, offset: held.focus.nodeOffset }
      : pointAt(options.document, focusHost, held.focus.offset);
    const selection = window.getSelection();
    if (
      !selection ||
      (selection.anchorNode === anchor.node &&
        selection.anchorOffset === anchor.offset &&
        selection.focusNode === focus.node &&
        selection.focusOffset === focus.offset)
    ) {
      return;
    }
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };

  const draw = (view: TimelineView, footers: Node[] = []): boolean => {
    const anchor = readingAnchor();
    const selection = heldSelection();
    const active = options.document.activeElement as HTMLElement | null;
    const held = active && root.contains(active) ? active : null;
    const oldControls = options.rovingControls();
    const priorStop = oldControls.find((node) => node.tabIndex === 0) || null;
    const heldFooterControl = held && footer.contains(held) ? held.dataset.control : undefined;
    const heldLabel = held?.matches('button.sessionlabel') ? held.dataset.label : undefined;
    const heldLabelSession =
      held && heldLabel ? held.closest<HTMLElement>('.sessionsection')?.dataset.session : undefined;
    const stopLabel = priorStop?.matches('button.sessionlabel') ? priorStop.dataset.label : undefined;
    const stopLabelSession = stopLabel
      ? priorStop?.closest<HTMLElement>('.sessionsection')?.dataset.session
      : undefined;
    const heldIndex = held ? oldControls.indexOf(held) : -1;
    const heldCard = held?.closest<HTMLElement>('[data-key]') || null;
    const oldCardOrder = Array.from(tree.querySelectorAll<HTMLElement>('article.turn:not(.clive)'));
    const heldCardIndex = heldCard ? oldCardOrder.indexOf(heldCard) : -1;
    const oldCardKeys = oldCardOrder.map((card) => card.dataset.key || '');
    const stopCard = priorStop?.closest<HTMLElement>('article.turn:not(.clive)') || null;
    const stopCardIndex = stopCard ? oldCardOrder.indexOf(stopCard) : -1;
    const stopIndex = priorStop ? oldControls.indexOf(priorStop) : -1;
    const nextCards = new Map<string, CardView>();
    const prints = new Map<string, string>();
    let deferred = false;
    for (const card of view.cards) {
      const prior = renderedCards.get(card.key);
      const host = hosts.get(card.key);
      const nextPrint = options.cardPrint(card);
      const priorPrint = prior ? (renderedPrints.get(card.key) ?? null) : null;
      if (prior && host && priorPrint !== nextPrint && options.interactions.cardRewriteWaits(host)) {
        nextCards.set(card.key, prior);
        prints.set(card.key, priorPrint || '');
        deferred = true;
      } else {
        nextCards.set(card.key, card);
        prints.set(card.key, nextPrint);
      }
    }
    const shown = { ...view, cards: view.cards.map((card) => nextCards.get(card.key)!) };
    const sessions = sessionsOf(shown, sessionStats, options);
    render(h(Timeline, { sessions, options, hosts, redraws, prints, pins, headings }), tree);
    options.onDraw?.();
    options.syncDetails(
      shown.sessions.map((row) =>
        detailsRow({
          id: row.id,
          title: row.label || 'Session',
          cards: shown.cards.filter((card) => card.sessionId === row.id),
          row,
          stats: sessionStats[row.id] || [],
          labels: options.labels(row.id),
        }),
      ),
    );
    renderedCards.clear();
    for (const [key, card] of nextCards) {
      renderedCards.set(key, card);
    }
    renderedPrints.clear();
    for (const [key, print] of prints) {
      renderedPrints.set(key, print);
    }
    if (view.showing !== undefined) {
      renderedShowing = view.showing;
    }
    footer.replaceChildren(...footers);
    options.footersDrawn?.(footers);

    if (anchor) {
      const node = hosts.get(anchor.key);
      if (node && options.document.scrollingElement) {
        options.document.scrollingElement.scrollTop += node.getBoundingClientRect().top - anchor.top;
      }
    }
    restoreSelection(selection);
    const nextFooterControl = heldFooterControl
      ? Array.from(footer.querySelectorAll<HTMLElement>('[data-control]')).find(
          (node) => node.dataset.control === heldFooterControl,
        )
      : null;
    if (visibleControl(nextFooterControl)) {
      normalizeRoving(visibleControl(priorStop) ? priorStop : sharedFallback());
      nextFooterControl.focus({ preventScroll: true });
      return deferred;
    }
    const localFocus = options.document.activeElement as HTMLElement | null;
    const cardRestoredFocus =
      heldCard?.isConnected && localFocus !== held && visibleControl(localFocus) && heldCard.contains(localFocus);
    if (held && !cardRestoredFocus && (!held.isConnected || options.document.activeElement !== held)) {
      const controls = options.rovingControls();
      const survivingTurn = survivingTurnControl(oldCardKeys, heldCardIndex);
      const fallback =
        (visibleControl(held) ? held : null) ||
        labelFallback(heldLabelSession, heldLabel) ||
        survivingTurn ||
        (heldCardIndex >= 0 ? sharedFallback() : controls[Math.min(Math.max(heldIndex, 0), controls.length - 1)]) ||
        null;
      normalizeRoving(fallback || priorStop);
      fallback?.focus({ preventScroll: true });
    } else if (visibleControl(priorStop)) {
      normalizeRoving(priorStop);
    } else {
      const controls = options.rovingControls();
      const survivingTurn = survivingTurnControl(oldCardKeys, stopCardIndex);
      normalizeRoving(
        labelFallback(stopLabelSession, stopLabel) ||
          survivingTurn ||
          (stopCardIndex >= 0 ? sharedFallback() : controls[Math.min(Math.max(stopIndex, 0), controls.length - 1)]) ||
          sharedFallback(),
      );
    }
    return deferred;
  };

  const structuralChange = (view: TimelineView): boolean => {
    const current = Array.from(renderedCards.keys());
    const next = view.cards.map((card) => card.key);
    return current.length !== next.length || current.some((key, index) => key !== next[index]);
  };

  const held = () => options.interactions.heldSelection() || options.interactions.noteBeingWritten();

  // Detect navigation so the selection in the departing session does not block the requested view.
  const opensAnother = (showing: string | null | undefined): boolean => !!showing && showing !== renderedShowing;

  const navigatedAway = (view: TimelineView): boolean => opensAnother(view.showing);

  // Clear only this timeline's selection. Preserve selections in the session list.
  const dropOwnSelection = () => {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      return;
    }
    const inside = (node: Node | null) => !!node && root.contains(node);
    if (inside(selection.anchorNode) || inside(selection.focusNode)) {
      selection.removeAllRanges();
    }
  };

  const structuralRewriteWaits = (view: TimelineView): boolean => {
    // Keep a comment's card mounted while the reader writes, including during navigation.
    if (options.interactions.noteBeingWritten()) {
      return true;
    }
    if (navigatedAway(view)) {
      return false;
    }
    const selection = heldSelection();
    if (selection) {
      if (selection.anchor.key !== selection.focus.key) {
        return true;
      }
      return !view.cards.some((card) => card.key === selection.anchor.key);
    }
    return options.interactions.heldSelection();
  };

  const applyPending = () => {
    // Release requested navigation when the comment editor closes, even if its quote remains selected.
    if (pendingView && pendingViewEscapes && !options.interactions.noteBeingWritten()) {
      const escape = pendingView;
      pendingView = null;
      pendingViewEscapes = false;
      escape();
      return;
    }
    if (held() || (!pendingView && !pendingCard && !pendingRefresh)) {
      return;
    }
    const viewAction = pendingView;
    const cardAction = pendingCard;
    const refreshAction = pendingRefresh;
    pendingView = null;
    pendingViewEscapes = false;
    pendingCard = null;
    pendingRefresh = null;
    viewAction?.();
    if (!viewAction) cardAction?.();
    refreshAction?.();
  };

  options.interactions.onRelease(applyPending);

  const update = (view: TimelineView, footers: Node[] = []) => {
    latest = view;
    cardIndexes.clear();
    view.cards.forEach((card, index) => cardIndexes.set(card.key, index));
    deferredCards.clear();
    pendingRefresh = null;
    pendingCard = null;
    if (structuralChange(view) && structuralRewriteWaits(view)) {
      pendingView = () => update(view, footers);
      pendingViewReplaces = true;
      pendingViewEscapes = navigatedAway(view);
      return;
    }
    // Remove stale selection before navigating. Clear the pending view before closing the comment list.
    // Closing releases pending work, which must not replace the newly requested session.
    if (navigatedAway(view) && !options.interactions.noteBeingWritten()) {
      dropOwnSelection();
      pendingView = null;
      pendingViewEscapes = false;
      options.interactions.closeMarkFloat(false);
    }
    foreign.replaceChildren();
    tree.hidden = false;
    pendingViewReplaces = false;
    pendingViewEscapes = false;
    if (draw(view, footers)) {
      pendingView = () => update(view, footers);
    } else {
      pendingView = null;
    }
  };

  const showForeign = (nodes: Node[], footers: Node[] = [], retained?: TimelineView, showing?: string | null) => {
    pendingRefresh = null;
    const next = showing === undefined ? retained?.showing : showing;
    const away = opensAnother(next);
    // Comment editing blocks any replacement. Selection blocks only updates to the same displayed session.
    if (options.interactions.noteBeingWritten() || (!away && options.interactions.heldSelection())) {
      pendingView = () => showForeign(nodes, footers, retained, showing);
      pendingViewReplaces = true;
      pendingViewEscapes = away;
      return;
    }
    pendingView = null;
    pendingViewEscapes = false;
    pendingCard = null;
    deferredCards.clear();
    if (away) {
      dropOwnSelection();
    }
    options.interactions.closeMarkFloat(false);
    const active = options.document.activeElement as HTMLElement | null;
    const activeInRoot = active && root.contains(active) ? active : null;
    const oldControls = options.rovingControls();
    const priorStop = oldControls.find((node) => node.tabIndex === 0) || null;
    const heldIndex = activeInRoot ? oldControls.indexOf(activeInRoot) : -1;
    const stopIndex = priorStop ? oldControls.indexOf(priorStop) : -1;
    if (retained) {
      latest = retained;
      cardIndexes.clear();
      retained.cards.forEach((card, index) => cardIndexes.set(card.key, index));
      tree.hidden = false;
      draw(retained, footers);
    } else {
      latest = null;
      cardIndexes.clear();
      renderedCards.clear();
      renderedPrints.clear();
      // Record the foreign view's displayed session for the next navigation check.
      if (next !== undefined) {
        renderedShowing = next;
      }
      render(null, tree);
      options.syncDetails([]);
      tree.hidden = true;
      footer.replaceChildren(...footers);
      options.footersDrawn?.(footers);
    }
    foreign.replaceChildren(...nodes);
    const controls = options.rovingControls();
    const index = activeInRoot ? heldIndex : stopIndex;
    const fallback = visibleControl(priorStop)
      ? priorStop
      : controls[Math.min(Math.max(index, 0), controls.length - 1)] || sharedFallback();
    normalizeRoving(fallback);
    if (activeInRoot && (!activeInRoot.isConnected || options.document.activeElement !== activeInRoot)) {
      fallback?.focus({ preventScroll: true });
    }
  };

  const publishCard = (card: CardView): boolean => {
    const host = hosts.get(card.key);
    const publish = redraws.get(card.key);
    const prior = renderedCards.get(card.key);
    if (!host || !publish || !prior) return false;
    const print = options.cardPrint(card);
    if (renderedPrints.get(card.key) !== print) {
      if (options.interactions.cardRewriteWaits(host)) {
        deferredCards.set(card.key, card);
        return true;
      }
      publish(card, print);
      renderedPrints.set(card.key, print);
    } else {
      options.cardRenderer.refreshClock(host, card);
    }
    renderedCards.set(card.key, card);
    deferredCards.delete(card.key);
    if (cardHasBody(prior) !== cardHasBody(card)) {
      headings.get(card.sessionId)?.forEach((redraw) => redraw(undefined, card));
    }
    return false;
  };

  const updateCard = (session: string, card: CardView): boolean => {
    return card.sessionId === session && updateCards([card], true);
  };

  const updateCards = (cards: readonly CardView[], mountedOnly = false): boolean => {
    if (!latest) return false;
    const accepted: CardView[] = [];
    for (const card of cards) {
      const index = cardIndexes.get(card.key);
      if (index === undefined || latest.cards[index].sessionId !== card.sessionId) continue;
      latest.cards[index] = card;
      accepted.push(card);
    }
    if (!accepted.length) return false;
    // Adopt accepted cards while a structural replacement waits. That replacement draws the newest Activity snapshots when released.
    if (pendingView && pendingViewReplaces) return true;
    if (mountedOnly) {
      for (const card of accepted) publishCard(card);
      pendingCard = deferredCards.size
        ? () => {
            for (const pending of deferredCards.values()) publishCard(pending);
          }
        : null;
      return true;
    }
    // The list draw adopts every current card, including held single-card updates.
    deferredCards.clear();
    pendingCard = null;
    if (draw(latest, Array.from(footer.childNodes))) {
      pendingView = () => update(latest!, Array.from(footer.childNodes));
    } else pendingView = null;
    return true;
  };

  const refresh = (stats?: Record<string, SessionStat[]>, footers?: Node[]) => {
    if (stats) {
      sessionStats = stats;
    }
    // Adopt figures while a replacement view waits. Draw them when that view is released.
    if (pendingView) {
      if (stats || footers || !pendingRefresh) {
        pendingRefresh = () => refresh(undefined, footers);
      }
      return;
    }
    const nextFooters = footers ?? Array.from(footer.childNodes);
    if (latest) {
      draw(latest, nextFooters);
    } else if (footers) {
      const active = options.document.activeElement as HTMLElement | null;
      const heldControl = active && footer.contains(active) ? active.dataset.control : undefined;
      const priorStop = options.rovingControls().find((node) => node.tabIndex === 0) || null;
      footer.replaceChildren(...footers);
      options.footersDrawn?.(footers);
      const nextControl = heldControl
        ? Array.from(footer.querySelectorAll<HTMLElement>('[data-control]')).find(
            (node) => node.dataset.control === heldControl,
          )
        : null;
      if (visibleControl(nextControl)) {
        normalizeRoving(visibleControl(priorStop) ? priorStop : sharedFallback());
        nextControl.focus({ preventScroll: true });
      }
    }
  };

  const refreshHeadings = (stats?: Record<string, SessionStat[]>, footers?: Node[]) => {
    if (stats) sessionStats = stats;
    for (const [id, mounted] of headings) {
      for (const redraw of mounted) redraw(pendingView ? undefined : (stats?.[id] ?? (stats ? [] : undefined)));
    }
    if (pendingView) {
      if (stats || footers || !pendingRefresh) {
        pendingRefresh = () => refreshHeadings(sessionStats, footers);
      }
      return;
    }
    if (
      !footers ||
      (footers.length === footer.childNodes.length && footers.every((node, index) => node === footer.childNodes[index]))
    )
      return;
    const active = options.document.activeElement as HTMLElement | null;
    const held = active && footer.contains(active) ? active : null;
    const priorStop = options.rovingControls().find((node) => node.tabIndex === 0) || null;
    footer.replaceChildren(...footers);
    options.footersDrawn?.(footers);
    const replacement = held?.dataset.control
      ? Array.from(footer.querySelectorAll<HTMLElement>('[data-control]')).find(
          (node) => node.dataset.control === held.dataset.control,
        )
      : null;
    const fallback = visibleControl(replacement)
      ? replacement
      : visibleControl(priorStop)
        ? priorStop
        : options.rovingControls()[0] || sharedFallback();
    normalizeRoving(visibleControl(priorStop) ? priorStop : options.rovingControls()[0] || sharedFallback());
    if (held && options.document.activeElement !== held) fallback?.focus({ preventScroll: true });
  };

  // Membership updates the named mounted headings, including a held or retained view.
  // The heading captures its focus and keyboard stop before its pin can disappear.
  const drawRowContexts = (sessions: readonly string[]) => {
    const wanted = new Set(sessions);
    for (const row of root.querySelectorAll<HTMLElement>('.sessionrow')) {
      const drawn = row.dataset.session;
      if (drawn === undefined || !wanted.has(drawn)) {
        continue;
      }
      // A pin or an archive changes the menu, never whether the session is saved.
      const persisted =
        (JSON.parse(row.dataset.vscodeContext ?? '{}') as { sessionPersisted?: unknown }).sessionPersisted === true;
      row.dataset.vscodeContext = options.rowContext(drawn, persisted);
    }
    // Update Preact props with the native context. Otherwise a reversal can preserve an outdated optimistic attribute.
    for (const session of wanted) {
      headings.get(session)?.forEach((redraw) => redraw());
      pins.get(session)?.forEach((redraw) => redraw());
    }
  };

  return {
    element: root,
    refreshLayout() {
      if (options.retained.isConnected) {
        options.list.style.setProperty('--session-top', `${options.retained.getBoundingClientRect().height}px`);
      } else {
        options.list.style.removeProperty('--session-top');
      }
    },
    drawRowContext(session) {
      drawRowContexts([session]);
    },
    drawRowContexts,
    refreshHeadings,
    settled: () => !pendingView && !pendingCard && !pendingRefresh,
    update,
    updateCard,
    updateCards,
    showForeign,
    applyStats(stats) {
      sessionStats = stats;
    },
    refresh,
  };
}
