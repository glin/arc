import { actionable, editableTarget } from './dom.ts';
import type { ReadStateOwner } from './read-state.ts';
import { turnMenuContext, type TurnMenuNode } from '../view/card-menu.ts';
import {
  answerPart,
  blockOfQuote,
  COMMENT_ACTIONS,
  commentableMessageId,
  commentsOn,
  markName,
  noteName,
  quotesPromptHeading,
  quoteSpan,
  saidPart,
  withoutMarker,
  type CommentPart,
  type TurnComment,
} from '../view/comments.ts';

export interface CommentCard {
  key: string;
  sessionId: string;
  sessionTitle?: string;
  kind: string;
  live?: boolean;
  statusWord: string;
  headline: string;
  startedAt: number;
  summary?: string;
  marks?: Array<{ word: string }>;
}

type CommentMark = HTMLButtonElement & { _offLine?: boolean; _ids?: string[] };
type CommentForm = HTMLFormElement & { _area?: HTMLTextAreaElement };

interface CommentAnchor {
  card: CommentCard;
  text: string;
  part: CommentPart;
  offset?: number;
  rect: DOMRect;
  range?: Range;
}

interface OpenEditor extends CommentAnchor {
  back: Element | null;
  painted?: HTMLElement;
}

interface OpenMark {
  mark: CommentMark;
  pinned: boolean;
}

// Where a list of comments hung: the card, the comments its mark carried, and the height the
// mark stood at. A card drawn again carries new marks, and the place finds the one that took
// over.
interface MarkPlace {
  host: HTMLElement | null;
  ids: string[];
  top: number | null;
}

// A list the card took away while it was drawn again. The list opens again on the new mark, and
// the keyboard goes back to the control it was on.
interface ListToReopen {
  place: MarkPlace;
  pinned: boolean;
  control: string | null;
}

export interface CommentRendererOptions {
  document: Document;
  list: HTMLElement;
  read: ReadStateOwner;
  open: Set<string>;
  initial: unknown;
  cross: string;
  unreadWord: string;
  events: {
    document(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    window(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
  post(message: Record<string, unknown>): void;
  save(): void;
  updateLatest(comments: TurnComment[]): void;
  markdownOf(root: Node): string;
  nextId(prefix: string): string;
  attachSlash(area: HTMLTextAreaElement): void;
  releaseSlash(area: HTMLTextAreaElement | null): void;
  attachLineClipboard(area: HTMLTextAreaElement): void;
  // Whether the source session carries a label.
  labeled(session: string): boolean;
}

export interface CommentRenderer {
  snapshot(): readonly TurnComment[];
  subscribe(listener: () => void): () => void;
  onRelease(listener: () => void): () => void;
  adopt(value: unknown): void;
  reset(): void;
  headTitle(card: CommentCard): string;
  connectCard(node: HTMLElement, card: CommentCard): () => void;
  cardFor(node: Element): CommentCard | null;
  writeContext(node: HTMLElement, card: CommentCard, where: TurnMenuNode): void;
  renderAnnotations(body: HTMLElement, card: CommentCard): void;
  beforeCardDraw(node: HTMLElement): void;
  refreshSelection(): void;
  // Rewrites the menu context of every drawn card in the named sessions, after their labels
  // change.
  refreshSessionContexts(sessions: ReadonlySet<string>): void;
  closeMarkFloat(refocus?: boolean): void;
  noteBeingWritten(): boolean;
  selectionWithin(node: HTMLElement): boolean;
  heldSelection(): boolean;
  cardRewriteWaits(node: HTMLElement): boolean;
  openArmed(key: string): void;
  handoffArmed(key: string, copyLabels: boolean): void;
  write(card: CommentCard, quote: string, part: CommentPart, words: string): void;
}

const SAID_ROW = '.actrow.message[data-message]';
const PROMPT_LEAD_LABEL = '.promptlead > .sectionheading';

// The Activity log holds rows a comment has no name for, such as a run or a step. A message
// the agent wrote is a message whether or not it closed a reply, and each one carries the id
// that names its own part.
export function outsideCommentMarks(node: Element | null): boolean {
  // The You asked heading over a prompt drawn before the response is a label, not what anyone
  // said. Counted as response text, it would shift every stored response offset below it.
  if (node?.closest(PROMPT_LEAD_LABEL)) {
    return true;
  }
  // A message whose id no saved comment can keep takes no comment. An empty id would save it on
  // the final response.
  const said = node?.closest<HTMLElement>(SAID_ROW);
  return (
    !!node?.closest('.actlist') && !node.closest('.answer') && !(said && commentableMessageId(said.dataset.message))
  );
}

const QUOTE_BLOCKS = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, summary, .row, .prompt';

const FENCE = '```';
const MARK_LEAVE_MS = 260;
const MENU_ARM_MS = 30_000;

export function createCommentRenderer(options: CommentRendererOptions): CommentRenderer {
  const document = options.document;
  const view = document.defaultView as Window;
  let comments = Array.isArray(options.initial) ? (options.initial.slice() as TurnComment[]) : [];
  let count = 0;
  let quoteFloat: HTMLDivElement | null = null;
  let quoteBar: HTMLDivElement | null = null;
  let quoteSlot: HTMLDivElement | null = null;
  let editor: OpenEditor | null = null;
  let markFloat: HTMLDivElement | null = null;
  let markOpen: OpenMark | null = null;
  let markLeaving: ReturnType<typeof setTimeout> | null = null;
  // The pointer went down inside the open list and has not come up. A redraw in that time takes
  // the pressed control away, and the release then reaches nothing.
  let pressingList = false;
  // Keyboard focus the panel moves itself. A mark that takes it stays shut, so Escape and a
  // delete leave no list open behind them.
  let quietFocus = false;
  let listToReopen: ListToReopen | null = null;
  let selecting = false;
  let menuArm: (CommentAnchor & { at: number; key: string; selected: boolean }) | null = null;
  let selectionContextKey: string | null = null;
  const listeners = new Set<() => void>();
  const releaseListeners = new Set<() => void>();
  const cards = new WeakMap<HTMLElement, CommentCard>();

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string | null,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  // The card bodies whose marks a sweep could not draw, because the reader held the list over
  // them. Each one is swept when the reader lets go. A text selection live in its card holds the
  // sweep until the next release, so a sweep never rewrites the words under a drag.
  const heldSweeps = new Set<HTMLElement>();

  const sweepHeldCards = () => {
    for (const body of Array.from(heldSweeps)) {
      const host = body.isConnected ? body.closest<HTMLElement>('.turn:not(.clive), .compaction') : null;
      const card = host ? cards.get(host) : undefined;
      if (!host || !card) {
        heldSweeps.delete(body);
        continue;
      }
      if (selectionWithin(host)) {
        continue;
      }
      heldSweeps.delete(body);
      renderAnnotations(body, card);
    }
  };

  const release = () => {
    sweepHeldCards();
    for (const listener of releaseListeners) {
      listener();
    }
  };

  const notesOn = (card: CommentCard): TurnComment[] => commentsOn(comments, card.key, card.sessionId);

  const cardFor = (node: Element): CommentCard | null => {
    const host = node.closest<HTMLElement>('.turn:not(.clive), .compaction');
    return host ? cards.get(host) || null : null;
  };

  const partOfNode = (node: Element | null): CommentPart => {
    if (!node) {
      return 'summary';
    }
    const prompt = node.closest('.prompt');
    if (prompt) {
      const card = prompt.closest('.turn:not(.clive), .compaction');
      const all = card?.querySelectorAll('.prompt');
      if (!all) {
        return 'prompt';
      }
      for (let index = 0; index < all.length; index += 1) {
        if (all[index] === prompt) {
          return index === 0 ? 'prompt' : `prompt:${index - 1}`;
        }
      }
      return 'prompt';
    }
    const answer = node.closest<HTMLElement>('.answer');
    if (answer) {
      return answerPart(Number(answer.dataset.answer || 0));
    }
    // A reply keeps the answer name it was written under, so every comment saved before
    // messages were commentable still resolves to the same text.
    const said = node.closest<HTMLElement>(SAID_ROW);
    return said?.dataset.message ? saidPart(said.dataset.message) : 'summary';
  };

  const contentRange = (block: Element): Range => {
    const range = document.createRange();
    range.selectNodeContents(block);
    return range;
  };

  const quoteOf = (node: Element, contents: () => Node, flat: string): string => {
    const text = node.closest('pre')
      ? `${FENCE}\n${flat.replace(/\s+$/, '')}\n${FENCE}`
      : options.markdownOf(contents()) || flat;
    return text.trim();
  };

  const lineQuote = (block: Element | null): string => {
    if (!block) {
      return '';
    }
    const range = contentRange(block);
    return quoteOf(block, () => range.cloneContents(), block.textContent || '');
  };

  const lineBlock = (at: Element | null, card: Element): Element | null => {
    if (!at || at.closest('.notesec') || outsideCommentMarks(at)) {
      return null;
    }
    const block = at.closest(QUOTE_BLOCKS);
    return block && card.contains(block) ? block : null;
  };

  // The lines a stored offset counts, in the card head and in the body alike. Saving and
  // drawing both count these, so an offset names the same line at both ends.
  const countedBlocks = (card: Element): Element[] =>
    Array.from(card.querySelectorAll(QUOTE_BLOCKS)).filter(
      (node) => !node.closest('.notesec') && !outsideCommentMarks(node),
    );

  const partBlocks = (card: Element, part: CommentPart): Element[] =>
    countedBlocks(card).filter((node) => partOfNode(node) === part);

  const offsetOf = (card: Element, part: CommentPart, node: Node, offset: number): number | undefined => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const block = element?.closest(QUOTE_BLOCKS);
    if (!block) {
      return undefined;
    }
    let total = 0;
    for (const candidate of partBlocks(card, part)) {
      if (candidate === block) {
        const before = document.createRange();
        before.selectNodeContents(candidate);
        try {
          before.setEnd(node, offset);
        } catch {
          return total;
        }
        return total + (before.cloneContents().textContent || '').replace(/\s+/g, ' ').trimStart().length;
      }
      total += lineQuote(candidate).replace(/\s+/g, ' ').trim().length + 1;
    }
    return undefined;
  };

  const selectionHere = (): CommentAnchor | null => {
    const selection = view.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const node = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
    const host = node?.closest<HTMLElement>('.turn:not(.clive), .compaction');
    const card = host ? cards.get(host) : undefined;
    if (!node || !host || !card) {
      return null;
    }
    const ends = [range.startContainer, range.endContainer].map((end) =>
      end.nodeType === Node.ELEMENT_NODE ? (end as Element) : end.parentElement,
    );
    const at = ends[0] && host.contains(ends[0]) ? ends[0] : node;
    const part = partOfNode(at);
    const text = quoteOf(node, () => range.cloneContents(), selection.toString());
    const rect = range.getBoundingClientRect();
    if (!text || (!rect.width && !rect.height)) {
      return null;
    }
    const commentable =
      ends.every((end) => !!end && !end.closest('.notesec') && !outsideCommentMarks(end)) &&
      host.classList.contains('turn');
    if (!commentable) {
      return null;
    }
    return {
      card,
      text,
      part,
      offset: offsetOf(host, part, range.startContainer, range.startOffset),
      rect,
      range: range.cloneRange(),
    };
  };

  // Every drawn card, live or not. The card map names the ones that carry a menu context.
  const writeContextsWhere = (matches: (host: HTMLElement, card: CommentCard) => boolean) => {
    for (const host of Array.from(document.querySelectorAll<HTMLElement>('.turn, .compaction'))) {
      const card = cards.get(host);
      if (!card || !matches(host, card)) {
        continue;
      }
      const labeled = options.labeled(card.sessionId);
      const selected = selectionContextKey === host.dataset.key;
      host.dataset.vscodeContext = JSON.stringify(
        turnMenuContext(card, options.read.isRead(card), 'body', notesOn(card).length > 0, selected, labeled),
      );
      const head = host.querySelector<HTMLElement>('.head');
      const body = host.querySelector<HTMLElement>('.body');
      if (head) {
        const context = turnMenuContext(
          card,
          options.read.isRead(card),
          'head',
          notesOn(card).length > 0,
          selected,
          labeled,
        );
        if (context) {
          head.dataset.vscodeContext = JSON.stringify(context);
        } else {
          delete head.dataset.vscodeContext;
        }
      }
      if (body) {
        const context = turnMenuContext(
          card,
          options.read.isRead(card),
          'body',
          notesOn(card).length > 0,
          selected,
          labeled,
        );
        if (context) {
          body.dataset.vscodeContext = JSON.stringify(context);
        } else {
          delete body.dataset.vscodeContext;
        }
      }
    }
  };
  const writeCardContexts = (key: string) => writeContextsWhere((host) => host.dataset.key === key);

  const sameRange = (left: Range | undefined, right: Range | undefined): boolean =>
    !!left &&
    !!right &&
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset;

  const refreshSelectionContext = (selection: CommentAnchor | null = selectionHere()) => {
    const next = selection?.card.key ?? null;
    const previous = selectionContextKey;
    selectionContextKey = next;
    if (previous && previous !== next) {
      writeCardContexts(previous);
    }
    if (next) {
      writeCardContexts(next);
    }
  };

  const placeFloat = (host: HTMLElement, rect: DOMRect, bottomLimit?: number, topLimit?: number) => {
    if (topLimit !== undefined && bottomLimit !== undefined) {
      const gap = 6;
      const available = Math.max(0, bottomLimit - topLimit);
      host.style.maxHeight = `${available}px`;
      const height = Math.min(host.offsetHeight || 26, available);
      const above = rect.top - gap - height;
      const below = rect.bottom + gap;
      const top =
        above >= topLimit
          ? above
          : below + height <= bottomLimit
            ? below
            : rect.top - gap - topLimit >= bottomLimit - rect.bottom - gap
              ? topLimit
              : bottomLimit - height;
      host.style.top = `${Math.max(topLimit, Math.min(top, bottomLimit - height))}px`;
      host.style.left = `${Math.max(4, Math.min(rect.left, view.innerWidth - (host.offsetWidth || 90) - 4))}px`;
      return;
    }
    const height = host.offsetHeight || 26;
    const top = rect.top > height + 4 ? rect.top - height - 4 : rect.bottom + 6;
    host.style.top = `${Math.max(4, Math.min(top, view.innerHeight - height - 4))}px`;
    host.style.left = `${Math.max(4, Math.min(rect.left, view.innerWidth - (host.offsetWidth || 90) - 4))}px`;
  };

  const floatBounds = () => {
    let top = 4;
    const controls = document.querySelector<HTMLElement>('.controls');
    if (controls && !controls.hidden) {
      top = Math.max(top, controls.getBoundingClientRect().bottom);
    }
    for (const heading of Array.from(document.querySelectorAll<HTMLElement>('.sessionrow'))) {
      const box = heading.getBoundingClientRect();
      if (box.bottom > top && box.top <= top + 2) {
        top = Math.max(top, box.bottom);
      }
    }
    let bottom = view.innerHeight - 4;
    for (const selector of ['#composer', '#statusbar']) {
      const fixed = document.querySelector<HTMLElement>(selector);
      if (fixed && !fixed.hidden) {
        bottom = Math.min(bottom, fixed.getBoundingClientRect().top);
      }
    }
    return { top, bottom };
  };

  const holdMarkOpen = () => {
    if (markLeaving) {
      clearTimeout(markLeaving);
      markLeaving = null;
    }
  };

  const unlightMarks = () => {
    for (const span of Array.from(document.querySelectorAll('.cmark.lit, .cmark.dulled'))) {
      span.classList.remove('lit', 'dulled');
    }
  };

  const cardHostOf = (node: Element): HTMLElement | null => node.closest<HTMLElement>('.turn:not(.clive), .compaction');

  const placeOf = (mark: CommentMark): MarkPlace => ({
    host: cardHostOf(mark),
    ids: mark._ids ?? [],
    top: mark.isConnected ? mark.getBoundingClientRect().top : null,
  });

  // The mark that now carries a comment the old mark carried.
  const markAt = (place: MarkPlace): CommentMark | null => {
    if (!place.host?.isConnected) {
      return null;
    }
    return (
      Array.from(place.host.querySelectorAll<CommentMark>('.linemark')).find((mark) =>
        (mark._ids ?? []).some((id) => place.ids.includes(id)),
      ) ?? null
    );
  };

  // Between the sticky heading and the fixed composer, where the reader can see it.
  const onScreen = (node: HTMLElement): boolean => {
    const box = node.getBoundingClientRect();
    if (!box.width && !box.height) {
      return false;
    }
    const bounds = floatBounds();
    return box.top >= bounds.top && box.bottom <= bounds.bottom;
  };

  const nearestOnScreen = (nodes: HTMLElement[], top: number): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let distance = Infinity;
    for (const node of nodes) {
      if (!onScreen(node)) {
        continue;
      }
      const gap = Math.abs(node.getBoundingClientRect().top - top);
      if (gap < distance) {
        best = node;
        distance = gap;
      }
    }
    return best;
  };

  const focusQuietly = (target: HTMLElement) => {
    quietFocus = true;
    try {
      target.focus({ preventScroll: true });
    } finally {
      quietFocus = false;
    }
  };

  // The keyboard goes back to the line the list hung from when its mark is on screen. Otherwise
  // it goes to the nearest mark on the card that is on screen, and then to the nearest control on
  // screen. Every candidate is in view, so the panel never scrolls to show it.
  const returnFocus = (place: MarkPlace) => {
    const top = place.top ?? floatBounds().top;
    const host = place.host?.isConnected ? place.host : null;
    const same = markAt(place);
    const target =
      (same && onScreen(same) ? same : null) ??
      (host ? nearestOnScreen(Array.from(host.querySelectorAll<HTMLElement>('.linemark')), top) : null) ??
      nearestOnScreen(
        Array.from(
          options.list.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ),
        top,
      );
    if (target) {
      focusQuietly(target);
    }
  };

  // The card the list hung in, swept now rather than on the redraw the change causes. A live
  // text selection in the card holds the sweep for the next release, the way it holds every
  // held sweep.
  const sweepPlace = (place: MarkPlace) => {
    const body = place.host?.isConnected ? place.host.querySelector<HTMLElement>('.body') : null;
    const card = place.host ? cards.get(place.host) : undefined;
    if (!body || !card || !place.host) {
      return;
    }
    if (selectionWithin(place.host)) {
      heldSweeps.add(body);
      return;
    }
    renderAnnotations(body, card);
  };

  // Shuts the list. With `settle`, held sweeps and held redraws run, and the keyboard returns
  // to the line when the reader asked for that or was inside the list.
  const shutMarkFloat = (refocus: boolean, settle: boolean): MarkPlace | null => {
    const previous = markOpen;
    const inside = !!(markFloat && document.activeElement && markFloat.contains(document.activeElement));
    markOpen = null;
    pressingList = false;
    if (markFloat) {
      markFloat.hidden = true;
      markFloat.replaceChildren();
    }
    if (!previous) {
      return null;
    }
    unlightMarks();
    previous.mark.setAttribute('aria-expanded', 'false');
    previous.mark.removeAttribute('aria-describedby');
    const place = placeOf(previous.mark);
    if (!settle) {
      return place;
    }
    release();
    if (refocus || inside) {
      sweepPlace(place);
      returnFocus(place);
    }
    return place;
  };

  const closeMarkFloat = (refocus = false) => {
    shutMarkFloat(refocus, true);
  };

  // A sweep or a rewrite of the card takes the mark the list hangs from. The list is shut
  // without settling, because the card is mid-draw, and opens again once the card is drawn.
  const takeListOff = (node: Element) => {
    if (!markOpen?.mark || !node.contains(markOpen.mark)) {
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const control = markFloat && active && markFloat.contains(active) ? (active.dataset.control ?? '') : null;
    const pinned = markOpen.pinned;
    const place = shutMarkFloat(false, false);
    if (place) {
      listToReopen = { place, pinned, control };
    }
  };

  const putListBack = (body: Element) => {
    const pending = listToReopen;
    if (!pending?.place.host || !pending.place.host.contains(body)) {
      return;
    }
    listToReopen = null;
    const mark = pending.pinned ? markAt(pending.place) : null;
    if (!mark) {
      if (pending.control !== null) {
        returnFocus(pending.place);
      }
      return;
    }
    openMarkFloat(mark, false);
    if (markOpen) {
      markOpen.pinned = true;
    }
    if (pending.control === null || !markFloat) {
      return;
    }
    const same = pending.control
      ? Array.from(markFloat.querySelectorAll<HTMLElement>('[data-control]')).find(
          (node) => node.dataset.control === pending.control,
        )
      : null;
    const target = same ?? markFloat.querySelector<HTMLElement>('.noteact');
    if (target) {
      target.focus({ preventScroll: true });
    } else {
      returnFocus(pending.place);
    }
  };

  const markHost = (): HTMLDivElement => {
    if (markFloat) {
      return markFloat;
    }
    markFloat = el('div', 'markfloat notesec');
    markFloat.id = options.nextId('markfloat');
    markFloat.hidden = true;
    markFloat.setAttribute('role', 'region');
    markFloat.setAttribute('aria-label', 'Comments');
    markFloat.addEventListener('mouseenter', holdMarkOpen);
    // A primary press inside the list pins it and holds its card until the press ends. Pinned,
    // the list outlasts the blur of a mark that opened it on focus.
    markFloat.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !markOpen) {
        return;
      }
      markOpen.pinned = true;
      pressingList = true;
    });
    markFloat.addEventListener('mouseleave', () => {
      holdMarkOpen();
      markLeaving = setTimeout(() => {
        markLeaving = null;
        if (markOpen && !markOpen.pinned) {
          closeMarkFloat();
        }
      }, MARK_LEAVE_MS);
    });
    markFloat.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeMarkFloat(true);
      }
    });
    document.body.appendChild(markFloat);
    return markFloat;
  };

  const cardOfRange = (range: Range): HTMLElement | null => {
    const within = range.commonAncestorContainer;
    const node = within.nodeType === Node.ELEMENT_NODE ? (within as Element) : within.parentElement;
    return node?.closest<HTMLElement>('.turn:not(.clive), .compaction') ?? null;
  };

  const unpaint = (root: Element, className: string) => {
    for (const span of Array.from(root.querySelectorAll<HTMLElement>(`span.${className}`))) {
      const parent = span.parentNode;
      if (!parent) {
        continue;
      }
      while (span.firstChild) {
        parent.insertBefore(span.firstChild, span);
      }
      parent.removeChild(span);
    }
    root.normalize();
  };

  const textRuns = (root: Element): Array<{ node: Text; from: number; to: number }> => {
    const runs: Array<{ node: Text; from: number; to: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent?.closest('button, .notesec')) {
        runs.push({ node: node as Text, from: 0, to: node.textContent?.length ?? 0 });
      }
    }
    return runs;
  };

  const wrapText = (root: Element, from: number, to: number, className: string, ids = '') => {
    let at = 0;
    const wanted: Array<{ node: Text; from: number; to: number }> = [];
    for (const run of textRuns(root)) {
      const end = at + run.to;
      const start = Math.max(from, at);
      const finish = Math.min(to, end);
      if (finish > start) {
        wanted.push({ node: run.node, from: start - at, to: finish - at });
      }
      at = end;
    }
    for (let index = wanted.length - 1; index >= 0; index -= 1) {
      const run = wanted[index];
      let node = run.node;
      if (run.to < node.length) {
        node.splitText(run.to);
      }
      if (run.from > 0) {
        node = node.splitText(run.from);
      }
      const span = el('span', className);
      if (ids) {
        span.dataset.notes = ids;
      }
      node.parentNode?.insertBefore(span, node);
      span.appendChild(node);
    }
  };

  const paintRange = (range: Range, className: string) => {
    if (range.collapsed) {
      return;
    }
    const runs: Array<{ node: Text; from: number; to: number }> = [];
    const take = (node: Text) => {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      if (to > from) {
        runs.push({ node, from, to });
      }
    };
    const within = range.commonAncestorContainer;
    if (within.nodeType === Node.TEXT_NODE) {
      take(within as Text);
    } else {
      for (const run of textRuns(within as Element)) {
        if (range.intersectsNode(run.node)) {
          take(run.node);
        }
      }
    }
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      let node = run.node;
      if (run.to < node.length) {
        node.splitText(run.to);
      }
      if (run.from > 0) {
        node = node.splitText(run.from);
      }
      const span = el('span', className);
      node.parentNode?.insertBefore(span, node);
      span.appendChild(node);
    }
  };

  const quoteWord = (onPress: () => void): HTMLButtonElement => {
    const word = el('button', 'quoteact', COMMENT_ACTIONS.write);
    word.type = 'button';
    word.tabIndex = -1;
    word.appendChild(el('span', 'quotekey', COMMENT_ACTIONS.writeKey));
    word.addEventListener('mousedown', (event) => event.preventDefault());
    actionable(word, COMMENT_ACTIONS.writeName, null, onPress);
    return word;
  };

  const quoteHost = (): HTMLDivElement => {
    if (quoteFloat) {
      return quoteFloat;
    }
    quoteFloat = el('div', 'quotefloat');
    quoteFloat.hidden = true;
    quoteBar = el('div', 'quotebar');
    quoteSlot = el('div', 'quoteslot');
    quoteSlot.hidden = true;
    quoteBar.appendChild(
      quoteWord(() => {
        const found = selectionHere();
        if (found) {
          openEditor(found);
        }
      }),
    );
    quoteFloat.append(quoteBar, quoteSlot);
    document.body.appendChild(quoteFloat);
    return quoteFloat;
  };

  const noteEditor = (text: string, onSave: (words: string) => void, onCancel: () => void): CommentForm => {
    const form = el('form', 'noteedit') as CommentForm;
    form.setAttribute('aria-label', COMMENT_ACTIONS.editor);
    const id = options.nextId('notebox');
    const label = el('label', 'notelabel saidonly', COMMENT_ACTIONS.editor);
    label.htmlFor = id;
    const area = el('textarea', 'notearea');
    area.id = id;
    area.rows = 4;
    area.value = text;
    area.placeholder = COMMENT_ACTIONS.editorHint;
    form.append(label, area);
    options.attachSlash(area);
    options.attachLineClipboard(area);
    const close = el('button', 'noteclose', options.cross);
    close.type = 'button';
    actionable(close, `${COMMENT_ACTIONS.cancel}. ${COMMENT_ACTIONS.cancelKey}`, null, (event) => {
      event.stopPropagation();
      onCancel();
    });
    form.appendChild(close);
    const acts = el('div', 'noteacts');
    const save = el('button', 'notesave', COMMENT_ACTIONS.save);
    save.type = 'submit';
    actionable(save, `${COMMENT_ACTIONS.save}. ${COMMENT_ACTIONS.editorKeys}`, null, (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSave(area.value);
    });
    acts.appendChild(save);
    form.appendChild(acts);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onSave(area.value);
    });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        onSave(area.value);
      }
    });
    form._area = area;
    return form;
  };

  const placeQuoteHost = (rect: DOMRect) => {
    const host = quoteHost();
    if (!editor) {
      host.style.maxHeight = '';
      placeFloat(host, rect);
      return;
    }
    const bounds = floatBounds();
    placeFloat(host, rect, bounds.bottom, bounds.top);
  };

  const refreshSelection = () => {
    if (editor) {
      placeQuoteHost(editor.rect);
      return;
    }
    const host = quoteHost();
    const found = selectionHere();
    if (!found) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    placeQuoteHost(found.rect);
  };

  const closeEditor = () => {
    const back = editor?.back;
    const painted = editor?.painted;
    editor = null;
    if (painted) {
      unpaint(painted, 'csel');
    }
    options.releaseSlash(quoteSlot?.querySelector('.notearea') ?? null);
    quoteSlot?.replaceChildren();
    if (quoteSlot) {
      quoteSlot.hidden = true;
    }
    if (quoteBar) {
      quoteBar.hidden = false;
    }
    if (quoteFloat) {
      quoteFloat.classList.remove('commenting');
      quoteFloat.style.maxHeight = '';
      quoteFloat.hidden = true;
    }
    if (back instanceof HTMLElement && back.isConnected) {
      back.focus({ preventScroll: true });
    }
    release();
    refreshSelection();
  };

  const change = (move: Record<string, unknown>) => {
    options.save();
    options.updateLatest(comments);
    notify();
    options.post({ type: 'note', note: move });
  };

  const write = (card: CommentCard, quote: string, part: CommentPart, words: string, offset?: number) => {
    count += 1;
    const note: TurnComment = {
      id: `${Date.now()}:${count}:${Math.random().toString(36).slice(2, 10)}`,
      sessionId: card.sessionId,
      turnKey: card.key,
      part,
      quote,
      ...(offset === undefined ? {} : { offset }),
      note: words,
      headline: card.headline || '',
      sessionTitle: card.sessionTitle || '',
      turnAt: card.startedAt,
      at: Date.now(),
    };
    comments = comments.concat(note);
    options.open.add(card.key);
    const move = { op: 'write', note };
    change(move);
  };

  const openEditor = (anchor: CommentAnchor) => {
    closeMarkFloat();
    if (editor) {
      return;
    }
    const host = quoteHost();
    editor = { ...anchor, back: document.activeElement };
    const painted = anchor.range ? cardOfRange(anchor.range) : null;
    if (painted && anchor.range) {
      editor.painted = painted;
      paintRange(anchor.range, 'csel');
    }
    quoteBar!.hidden = true;
    quoteSlot!.replaceChildren();
    quoteSlot!.hidden = false;
    const form = noteEditor(
      '',
      (text) => {
        const current = editor;
        const words = text.trim();
        closeEditor();
        if (current && words) {
          write(current.card, current.text, current.part, words, current.offset);
        }
      },
      closeEditor,
    );
    if (anchor.text) {
      const quote = el('div', 'notesaid saidonly', anchor.text);
      quote.id = options.nextId('quoteline');
      form.insertBefore(quote, form.firstChild);
      form._area?.setAttribute('aria-describedby', quote.id);
    }
    quoteSlot!.appendChild(form);
    host.classList.add('commenting');
    host.hidden = false;
    placeQuoteHost(anchor.rect);
    form._area?.focus({ preventScroll: true });
  };

  const lightMark = (id: string) => {
    const card = markOpen?.mark.closest('.turn');
    if (!card) {
      return;
    }
    const spans = Array.from(card.querySelectorAll<HTMLElement>('.cmark'));
    const mine = (span: HTMLElement) => (span.dataset.notes || '').split(' ').includes(id);
    if (!spans.some(mine)) {
      return;
    }
    for (const span of spans) {
      span.classList.toggle('lit', mine(span));
      span.classList.toggle('dulled', !mine(span));
    }
  };

  const markRow = (note: TurnComment, showQuote: boolean): HTMLDivElement => {
    const row = el('div', 'marknote');
    row.dataset.note = note.id;
    row.addEventListener('mouseenter', () => lightMark(note.id));
    row.addEventListener('mouseleave', unlightMarks);
    row.addEventListener('focusin', () => lightMark(note.id));
    row.addEventListener('focusout', unlightMarks);
    if (showQuote && note.quote) {
      row.appendChild(el('div', 'notequote', note.quote));
    }
    row.appendChild(el('div', 'notetext', note.note));
    const acts = el('div', 'noteacts');
    const edit = el('button', 'noteact', COMMENT_ACTIONS.edit);
    edit.type = 'button';
    actionable(edit, `${COMMENT_ACTIONS.edit}: ${noteName(note)}`, `noteedit:${note.id}`, (event) => {
      event.stopPropagation();
      if (markOpen) {
        markOpen.pinned = true;
      }
      holdMarkOpen();
      const form = noteEditor(
        note.note,
        (text) => {
          const words = text.trim();
          if (!words) {
            closeMarkFloat(true);
            return;
          }
          const edited = { ...note, note: words, at: Date.now() };
          comments = comments.map((candidate) => (candidate.id === note.id ? edited : candidate));
          closeMarkFloat(true);
          change({ op: 'write', note: edited });
        },
        () => {
          closeMarkFloat(true);
        },
      );
      row.replaceChildren(form);
      form._area?.focus({ preventScroll: true });
    });
    const remove = el('button', 'noteact', COMMENT_ACTIONS.delete);
    remove.type = 'button';
    actionable(remove, `${COMMENT_ACTIONS.delete}: ${noteName(note)}`, `notedel:${note.id}`, (event) => {
      event.stopPropagation();
      comments = comments.filter((candidate) => candidate.id !== note.id);
      // The card is swept once here, before the change goes round. Every later redraw the
      // change causes finds the marks already drawn and leaves them.
      closeMarkFloat(true);
      change({ op: 'delete', id: note.id });
    });
    acts.append(edit, remove);
    row.appendChild(acts);
    return row;
  };

  // The comments a mark carries, read from the store when the list opens, so a list never shows
  // a comment as it stood when the mark was drawn.
  const notesOf = (mark: CommentMark): TurnComment[] =>
    (mark._ids ?? [])
      .map((id) => comments.find((note) => note.id === id))
      .filter((note): note is TurnComment => !!note);

  const openMarkFloat = (pressed: CommentMark, pinned: boolean) => {
    let mark = pressed;
    const host = markHost();
    if (markOpen && markOpen.mark !== mark) {
      const place = placeOf(mark);
      closeMarkFloat();
      // Shutting the other list can sweep this card, which replaces the mark the reader pressed.
      if (!mark.isConnected) {
        const rebuilt = markAt(place);
        if (!rebuilt) {
          return;
        }
        mark = rebuilt;
      }
    }
    const notes = notesOf(mark);
    if (!notes.length) {
      return;
    }
    host.replaceChildren(...notes.map((note) => markRow(note, mark._offLine === true)));
    host.hidden = false;
    const held = pinned || !!(markOpen && markOpen.mark === mark && markOpen.pinned);
    markOpen = { mark, pinned: held };
    mark.setAttribute('aria-expanded', 'true');
    mark.setAttribute('aria-describedby', host.id);
    placeFloat(host, mark.getBoundingClientRect());
    if (pinned) {
      host.querySelector<HTMLElement>('.noteact')?.focus({ preventScroll: true });
    }
  };

  const armMarkClose = () => {
    holdMarkOpen();
    markLeaving = setTimeout(() => {
      markLeaving = null;
      if (markOpen && !markOpen.pinned) {
        closeMarkFloat();
      }
    }, MARK_LEAVE_MS);
  };

  const lineMark = (notes: TurnComment[], line: string): CommentMark => {
    const mark = el('button', 'linemark') as CommentMark;
    mark.type = 'button';
    mark.dataset.count = String(notes.length);
    mark.setAttribute('aria-expanded', 'false');
    mark._ids = notes.map((note) => note.id);
    actionable(mark, markName(notes.length, line), `linemark:${notes[0].id}`, (event) => {
      event.stopPropagation();
      holdMarkOpen();
      if (markOpen?.mark === mark && markOpen.pinned) {
        closeMarkFloat(true);
        return;
      }
      openMarkFloat(mark, true);
    });
    mark.addEventListener('mouseenter', () => {
      holdMarkOpen();
      if (markOpen?.mark === mark || markOpen?.pinned) {
        return;
      }
      openMarkFloat(mark, false);
    });
    mark.addEventListener('mouseleave', armMarkClose);
    mark.addEventListener('focus', () => {
      holdMarkOpen();
      if (quietFocus) {
        return;
      }
      if (markOpen?.mark !== mark && !noteBeingWritten()) {
        openMarkFloat(mark, false);
      }
    });
    mark.addEventListener('blur', () => {
      if (markOpen?.mark === mark && !markOpen.pinned) {
        closeMarkFloat();
      }
    });
    mark.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeMarkFloat();
      }
    });
    return mark;
  };

  const markBlock = (block: Element, notes: TurnComment[], quote: string, partOffset: number) => {
    const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
    const hits: Array<{ from: number; to: number; id: string }> = [];
    for (const note of notes) {
      const wanted = withoutMarker((note.quote || '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim());
      const relative = note.offset === undefined ? undefined : Math.max(0, note.offset - partOffset);
      const span = quoteSpan(text, wanted, relative);
      if (span) {
        hits.push({ ...span, id: note.id });
      }
    }
    const edges = Array.from(new Set(hits.flatMap((hit) => [hit.from, hit.to]))).sort((one, other) => one - other);
    const segments: Array<{ from: number; to: number; ids: string[] }> = [];
    for (let index = 0; index + 1 < edges.length; index += 1) {
      const from = edges[index];
      const to = edges[index + 1];
      const ids = hits.filter((hit) => hit.from <= from && hit.to >= to).map((hit) => hit.id);
      if (ids.length) {
        segments.push({ from, to, ids });
      }
    }
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      wrapText(block, segment.from, segment.to, 'cmark', segment.ids.join(' '));
    }
    block.insertBefore(lineMark(notes, quote), block.firstChild);
  };

  // What the last sweep of each card body was drawn from. The words of every counted line, the
  // part each line belongs to, the prompt labels, and each comment's part, quote, offset and
  // text decide where the marks go and what their lists say. The counts of drawn marks and
  // tints say the marks of that sweep are still on the card.
  const drawnFrom = new WeakMap<HTMLElement, string>();

  const sweepSource = (host: Element, body: HTMLElement, mine: readonly TurnComment[]): string =>
    JSON.stringify([
      mine.map((note) => [note.id, note.part || 'summary', note.quote || '', note.offset ?? null, note.note]),
      countedBlocks(host).map((node) => [partOfNode(node), body.contains(node), node.textContent || '']),
      Array.from(body.querySelectorAll(PROMPT_LEAD_LABEL)).map((node) => node.textContent || ''),
    ]);

  const drawnMarks = (body: HTMLElement): string =>
    `${body.querySelectorAll('.offline, .linemark').length}:${body.querySelectorAll('.cmark').length}`;

  // One rule holds a card for the list over it: the reader is writing in the list or pressing
  // inside it. A sweep and a rewrite of the card both ask it.
  const listHolds = (node: Element): boolean =>
    !!markOpen?.mark && node.contains(markOpen.mark) && (pressingList || noteBeingWritten());

  const renderAnnotations = (body: HTMLElement, card: CommentCard) => {
    if (listHolds(body)) {
      heldSweeps.add(body);
      return;
    }
    const mine = notesOn(card);
    if (!mine.length && !body.querySelector('.offline, .linemark, .cmark')) {
      drawnFrom.delete(body);
      putListBack(body);
      return;
    }
    const host = cardHostOf(body) ?? body;
    const source = sweepSource(host, body, mine);
    if (drawnFrom.get(body) === `${source}|${drawnMarks(body)}`) {
      putListBack(body);
      return;
    }
    takeListOff(body);
    for (const old of Array.from(body.querySelectorAll('.offline, .linemark'))) {
      old.remove();
    }
    unpaint(body, 'cmark');
    if (!mine.length) {
      drawnFrom.delete(body);
      putListBack(body);
      return;
    }
    const sides = new Map<CommentPart, Element[]>();
    // A saved offset counts the lines in the card head ahead of the body, such as the card
    // heading under `summary`. Each part's count starts past them.
    const lead = new Map<CommentPart, number>();
    for (const node of countedBlocks(host)) {
      const part = partOfNode(node);
      if (!body.contains(node)) {
        lead.set(part, (lead.get(part) ?? 0) + lineQuote(node).replace(/\s+/g, ' ').trim().length + 1);
        continue;
      }
      const values = sides.get(part) ?? [];
      values.push(node);
      sides.set(part, values);
    }
    const within = (note: TurnComment): number | undefined =>
      note.offset === undefined ? undefined : note.offset - (lead.get(note.part || 'summary') ?? 0);
    // After the response, the You asked heading is drawn text and takes comments under
    // `summary`. Before the response it is read and not drawn, and it holds no offset. A summary
    // comment is looked for on it only when no other line holds its quote, so the heading's
    // words elsewhere in the card keep their comments. A comment found on it draws on the prompt
    // it names.
    const labels = Array.from(body.querySelectorAll(PROMPT_LEAD_LABEL));
    const located = new Map<Element, TurnComment[]>();
    const away: TurnComment[] = [];
    const answerParts = Array.from(sides.keys())
      .filter((part) => part.startsWith('answer:'))
      .sort((one, other) => Number(one.slice(7)) - Number(other.slice(7)));
    const saidParts = Array.from(sides.keys()).filter((part) => part.startsWith('said:'));
    // The part a comment names can move. A reply written before messages carried their own
    // name resolves under `summary`, and a message id carries an ordinal among the messages
    // sharing its timestamp, which a later read of the transcript renumbers. A reply that is
    // not a response leaves the response to an earlier reply, which renumbers the replies
    // and moves the response. The quote finds the line the reader wrote on in
    // every case.
    const elsewhere = (note: TurnComment): CommentPart[] => {
      if (note.part === 'summary') {
        return answerParts;
      }
      if ((note.part || '').startsWith('answer:')) {
        return ['summary', ...answerParts.filter((part) => part !== note.part)];
      }
      if ((note.part || '').startsWith('said:')) {
        return saidParts.filter((part) => part !== note.part);
      }
      return [];
    };
    for (const note of mine) {
      let nodes = sides.get(note.part || 'summary') ?? [];
      let quotes = nodes.map(lineQuote);
      let index = blockOfQuote(quotes, note.quote || '', within(note));
      if (index < 0) {
        for (const part of elsewhere(note)) {
          nodes = sides.get(part) ?? [];
          quotes = nodes.map(lineQuote);
          index = blockOfQuote(quotes, note.quote || '', within(note));
          if (index >= 0) {
            break;
          }
        }
      }
      if (
        index < 0 &&
        (note.part || 'summary') === 'summary' &&
        labels.length &&
        quotesPromptHeading(note.quote || '')
      ) {
        nodes = labels;
        index = 0;
      }
      const found = nodes[index]?.matches(PROMPT_LEAD_LABEL)
        ? nodes[index].parentElement?.querySelector('.prompt')
        : nodes[index];
      if (index < 0 || !found) {
        away.push(note);
        continue;
      }
      const group = located.get(found) ?? [];
      group.push(note);
      located.set(found, group);
    }
    for (const [part, nodes] of sides) {
      let partOffset = lead.get(part) ?? 0;
      for (const node of nodes) {
        const quote = lineQuote(node);
        const group = located.get(node);
        if (group?.length) {
          markBlock(node, group, quote, partOffset);
        }
        partOffset += quote.replace(/\s+/g, ' ').trim().length + 1;
      }
    }
    if (away.length) {
      const row = el('div', 'offline notesec');
      const mark = lineMark(away, '');
      mark._offLine = true;
      mark.className = 'linemark offlinemark';
      mark.textContent = markName(away.length, '');
      delete mark.dataset.count;
      row.appendChild(mark);
      body.insertBefore(row, body.firstChild);
    }
    drawnFrom.set(body, `${source}|${drawnMarks(body)}`);
    putListBack(body);
  };

  const noteBeingWritten = () => !!document.querySelector('.noteedit');

  const selectionWithin = (node: HTMLElement): boolean => {
    const selection = view.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      return false;
    }
    const range = selection.getRangeAt(0);
    if (range.intersectsNode) {
      return range.intersectsNode(node);
    }
    const within = range.commonAncestorContainer;
    const target = within.nodeType === Node.ELEMENT_NODE ? (within as Element) : within.parentElement;
    return !!target && node.contains(target);
  };

  const cardRewriteWaits = (node: HTMLElement): boolean =>
    listHolds(node) || !!(editor?.painted && node.contains(editor.painted)) || selectionWithin(node);

  options.events.window('resize', () => {
    if (editor) {
      placeQuoteHost(editor.rect);
    }
  });
  options.events.document('contextmenu', (raw) => {
    const event = raw as MouseEvent;
    menuArm = null;
    const found = selectionHere();
    refreshSelectionContext(found);
    const at = event.target instanceof Element ? event.target : null;
    const host = at?.closest<HTMLElement>('.turn');
    const card = host ? cards.get(host) : undefined;
    // Any card names the panel that drew the menu, for New session with the same labels.
    const menuCard = at?.closest<HTMLElement>('.turn, .compaction');
    const armed = menuCard ? cards.get(menuCard) : undefined;
    if (armed) {
      options.post({ type: 'armSessionDetails', session: armed.sessionId });
    }
    if (!at || !host || !card) {
      return;
    }
    const inside = found && found.card.key === card.key ? found : null;
    const block = inside ? null : lineBlock(at, host);
    const part = inside?.part ?? partOfNode(at);
    menuArm = {
      at: Date.now(),
      key: host.dataset.key || '',
      selected: !!inside,
      card,
      text: inside?.text ?? lineQuote(block),
      part,
      offset: inside?.offset,
      rect: inside?.rect ?? (block ?? host).getBoundingClientRect(),
      range: inside?.range ?? (block ? contentRange(block) : undefined),
    };
    if (inside) {
      options.post({ type: 'armSelectedText', session: card.sessionId, key: card.key });
    }
  });
  options.events.document(
    'mousedown',
    (raw) => {
      const event = raw as MouseEvent;
      selecting = true;
      const at = event.target instanceof Element ? event.target : null;
      if (editor && at && !at.closest('.quotefloat') && event.button === 0) {
        const area = quoteSlot?.querySelector<HTMLTextAreaElement>('.notearea');
        if (!area?.value.trim()) {
          closeEditor();
        }
      } else if (
        markOpen?.pinned &&
        at &&
        !at.closest('.markfloat') &&
        at !== markOpen.mark &&
        at.closest('.linemark') !== markOpen.mark
      ) {
        closeMarkFloat();
      }
    },
    true,
  );
  options.events.document('mouseup', () => {
    // After the click the release makes, so the pressed control is still there to take it.
    if (pressingList) {
      setTimeout(() => {
        if (!pressingList) {
          return;
        }
        pressingList = false;
        release();
      }, 0);
    }
    if (!selecting) {
      return;
    }
    selecting = false;
    setTimeout(refreshSelection, 0);
  });
  // A press that ends without a mouseup, such as a native drag out of the list, lets go here.
  const pressEnded = () => {
    if (pressingList) {
      pressingList = false;
      release();
    }
  };
  options.events.document('dragend', pressEnded, true);
  options.events.document('pointercancel', pressEnded, true);
  options.events.window('blur', () => {
    selecting = false;
    pressEnded();
  });
  options.events.document('selectionchange', () => {
    const current = selectionHere();
    if (
      menuArm?.selected &&
      (!current ||
        current.card.key !== menuArm.key ||
        current.text !== menuArm.text ||
        !sameRange(current.range, menuArm.range))
    ) {
      menuArm = null;
    }
    refreshSelectionContext(current);
    if (!selecting) {
      refreshSelection();
    }
    release();
  });
  options.events.document(
    'scroll',
    (raw) => {
      if (quoteFloat && !quoteFloat.hidden) {
        refreshSelection();
      }
      if (noteBeingWritten()) {
        return;
      }
      const at = raw.target;
      if (at instanceof Element && markFloat?.contains(at)) {
        return;
      }
      closeMarkFloat();
    },
    true,
  );
  options.events.document('keydown', (raw) => {
    const event = raw as KeyboardEvent;
    if (
      event.key !== COMMENT_ACTIONS.writeKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.defaultPrevented ||
      editor
    ) {
      return;
    }
    if (editableTarget(event.target)) {
      return;
    }
    const found = selectionHere();
    if (!found) {
      return;
    }
    openEditor(found);
    event.preventDefault();
  });

  return {
    snapshot: () => comments,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRelease(listener) {
      releaseListeners.add(listener);
      return () => releaseListeners.delete(listener);
    },
    adopt(value) {
      comments = Array.isArray(value) ? (value.slice() as TurnComment[]) : [];
      notify();
    },
    reset() {
      comments = [];
      closeEditor();
      closeMarkFloat();
      notify();
    },
    headTitle(card) {
      return (
        card.statusWord +
        (options.read.canMark(card) && !options.read.isRead(card) ? `, ${options.unreadWord}` : '') +
        (card.marks?.length ? ` \u00b7 ${card.marks.map((mark) => mark.word).join(', ')}` : '')
      );
    },
    connectCard(node, card) {
      cards.set(node, card);
      return () => {
        if (cards.get(node) === card) {
          cards.delete(node);
        }
      };
    },
    cardFor,
    refreshSessionContexts(sessions) {
      if (sessions.size) {
        writeContextsWhere((_host, card) => sessions.has(card.sessionId));
      }
    },
    writeContext(node, card, where) {
      const context = turnMenuContext(
        card,
        options.read.isRead(card),
        where,
        notesOn(card).length > 0,
        selectionContextKey === card.key,
        options.labeled(card.sessionId),
      );
      if (context) {
        node.dataset.vscodeContext = JSON.stringify(context);
      } else {
        delete node.dataset.vscodeContext;
      }
    },
    renderAnnotations,
    // The timeline asks `cardRewriteWaits` first, so a card reaches here only when the list
    // over it does not hold it. The list comes off before the rewrite and goes back after it.
    beforeCardDraw(node) {
      takeListOff(node);
      const pending = listToReopen;
      if (!pending) {
        return;
      }
      queueMicrotask(() => {
        if (listToReopen !== pending) {
          return;
        }
        listToReopen = null;
        if (pending.control !== null) {
          returnFocus(pending.place);
        }
      });
    },
    refreshSelection,
    closeMarkFloat,
    noteBeingWritten,
    selectionWithin,
    heldSelection: () => selectionWithin(options.list),
    cardRewriteWaits,
    openArmed(key) {
      if (!menuArm || menuArm.key !== key || Date.now() - menuArm.at > MENU_ARM_MS) {
        return;
      }
      const anchor = menuArm;
      menuArm = null;
      openEditor(anchor);
    },
    handoffArmed(key, copyLabels) {
      const arm = menuArm;
      menuArm = null;
      if (!arm || !arm.selected || arm.key !== key || Date.now() - arm.at > MENU_ARM_MS) {
        return;
      }
      const current = selectionHere();
      if (!current || current.card.key !== key || current.text !== arm.text || !sameRange(current.range, arm.range)) {
        return;
      }
      options.post({
        type: 'selectedTextHandoff',
        session: arm.card.sessionId,
        key,
        text: arm.text,
        copyLabels,
      });
    },
    write(card, quote, part, words) {
      write(card, quote, part, words);
    },
  };
}
