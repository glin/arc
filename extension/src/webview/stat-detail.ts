import { formatCacheSpan, formatRelative } from '../view/time.ts';
import { cacheHitText, diffHalves, type CacheHitDetail } from '../view/stat-detail.ts';
import { ARRIVAL_WORD } from '../view/card-presentation.ts';
import type { DetailRows } from './card-rows.ts';
import { drawContextDetail, type ContextDetailView } from './context-detail.ts';

// How long the popover waits after the pointer leaves the chip or the popover itself. The
// pointer crosses the gap between the two in that time, so a reader reaches a row without
// pinning first.
export const HOVER_GRACE_MS = 150;

export const STAT_WARNING_SIGN = '\u26a0\ufe0e';

interface RelativeDetailLine {
  lead: string;
  at: number;
  title?: string;
  trail: string;
  remaining?: boolean;
  underline?: boolean;
}

// The one press an entry offers, drawn by turning its own label into a button rather than by
// adding a separate control beside it.
export interface DetailNameAction {
  // The whole accessible name, which carries the label's own words and what they act on.
  name: string;
  // The hint a pointer reader sees on hover, since the button carries no native title.
  hint: string;
  run(event: MouseEvent): void;
}

interface DetailHead {
  label: string;
  // A muted fact after the label, drawn in its own tone inside it: the branch a one-group
  // Commits record holds, with its hover when the branch was merged.
  fact?: string;
  factArrival?: { title: string; spoken: string };
  value?: string | RelativeDetailLine;
  // Added and removed lines, drawn in their own tones rather than as words.
  diff?: { added: number; removed: number };
  mutedValue?: boolean;
  // Drawn in the tone the panel gives work that is still moving, the way a running card and
  // a running rail row are drawn.
  busyValue?: boolean;
  valueTitle?: string | null;
  lines?: DetailLine[];
  separateBefore?: boolean;
  warning?: boolean;
  // Drawn whenever the popover is shown, and only where the list declares `actions`. Turns the
  // label itself into the row's one press, in place of a separate button beside it.
  nameAction?: DetailNameAction;
}

type DetailLine =
  | string
  | {
      text: string;
      title?: string;
      action?: DetailNameAction;
      cost?: boolean;
      cacheHit?: CacheHitDetail;
      warning?: boolean;
      // The row's own tone within a sublist that otherwise reads at one weight: the foreground
      // sentence a row is about, the file path underneath it, or a note held back to the idle tone.
      kind?: 'description' | 'path' | 'muted';
      lines?: DetailLine[];
    }
  | RelativeDetailLine;

const KIND_CLASS: Record<'description' | 'path' | 'muted', string> = {
  description: 'chippopdesc',
  path: 'chippoppath',
  muted: 'chippopmuted',
};

export interface StatDetailList {
  context?: ContextDetailView;
  // A reading-order popover keeps its labels and values together. The default compact grid is
  // still right for the many figures whose values scan more easily in a second column.
  layout?: 'stacked' | 'tool-breakdown' | 'skills' | 'economics' | 'files' | 'agents' | 'dispatched' | 'commits';
  // Set where entries carry a press. The list says so once, so the renderer never scans its
  // entries to find out what kind of surface it is drawing.
  //
  // A list that declares it is a different surface from a read-only one. It is a dialog the
  // reader walks into, drawn with its buttons whenever the popover is shown, and its anchor is
  // a disclosure. It takes the pointer, so the reader reaches a button over the grace above.
  // A read-only list keeps ignoring the pointer, which leaves its anchor pressable where the
  // popover is drawn over it.
  actions?: boolean;
  heading?: DetailHead;
  entries: DetailHead[];
  // The turn's record, drawn by the same row components the card body draws. The card that
  // holds the arrays puts it here, so the record crosses to the panel once. The entries above
  // stay as the words the chip's plain-text hover is made of.
  rows?: DetailRows;
  bound?: DetailHead;
  footer?: string[];
}

export type CurrentDetail<T> = T | (() => T);

interface DetailValue {
  detail: CurrentDetail<string | null | undefined>;
  detailList: CurrentDetail<StatDetailList | null | undefined>;
}

interface ResolvedDetailValue {
  detail: string | null | undefined;
  detailList: StatDetailList | null | undefined;
  print: string;
}

export interface StatDetailRendererOptions {
  actionAnchor?: boolean;
  onOpen?(node: HTMLElement): void;
  onClose?(): void;
  document: Document;
  // The element's own id, which its anchors name in `aria-controls` and `aria-describedby`.
  id?: string;
  // Set on an instance drawn over another one. The outer instance owns the document's Escape
  // key and its outside press for both, so the two cannot answer one key twice.
  nested?: boolean;
  // Called with the anchor a press has just pinned this instance on. The nested instance tells
  // the outer one to pin as well, so a pinned record does not die when its hover-only parent's
  // grace fires. The anchor says which popover holds the press, so a figure standing in the
  // card body pins nothing but its own record.
  onPin?(anchor: HTMLElement): void;
  events: {
    document(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
  placeFloat(host: HTMLElement, anchor: HTMLElement, bottomLimit: number): void;
  selectionWithin?(node: HTMLElement): boolean;
  // Draws a list's record rows into a node the popover owns, and takes that node back when
  // called with no rows. The popover holds no opinion about what a row looks like.
  renderRows?(host: HTMLElement, rows: DetailRows | null): void;
}

export interface StatDetailRenderer {
  // The popover itself, for an owner that has to ask where the pointer or the focus stands.
  readonly element: HTMLElement;
  // Ties a second instance that draws over this one. This instance then treats that element as
  // part of itself: the pointer crossing into it holds this one open, a press inside it is not
  // an outside press, and Escape reaches it first.
  attachNested(nested: StatDetailRenderer): void;
  // Pins what is already drawn, without moving the anchor. The focus-return target is dropped
  // with it, because the press that asked for this stands on a figure inside this popover and
  // focus must never land on an element inside a hidden one.
  pinCurrent(): void;
  mount(node: HTMLElement, ownStop?: boolean): () => void;
  update(
    node: HTMLElement,
    detail: CurrentDetail<string | null | undefined>,
    detailList: CurrentDetail<StatDetailList | null | undefined>,
  ): void;
  connect(
    node: HTMLElement,
    detail: CurrentDetail<string | null | undefined>,
    detailList: CurrentDetail<StatDetailList | null | undefined>,
    ownStop?: boolean,
  ): void;
  retarget(
    within: HTMLElement,
    node: HTMLElement,
    detail: CurrentDetail<string | null | undefined>,
    detailList: CurrentDetail<StatDetailList | null | undefined>,
    ownStop?: boolean,
  ): boolean;
  layout(node: HTMLElement, visible: boolean): void;
  pointerAnchor(event: PointerEvent, node: HTMLElement | null): void;
  dismiss(): boolean;
  dismissWithin(within: HTMLElement): boolean;
}

function current<T>(value: CurrentDetail<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

// The watch that shuts a popover whose anchor has left the page or fallen under a hidden
// ancestor. One observer serves every renderer in a document, and each renderer adds its own
// check to it. A second popover with an observer of its own would walk the body twice on every
// draw, and the panel draws up to a thousand sessions at once.
const anchorWatches = new WeakMap<Document, Set<() => void>>();

function watchAnchors(document: Document, check: () => void): void {
  const existing = anchorWatches.get(document);
  if (existing) {
    existing.add(check);
    return;
  }
  const checks = new Set([check]);
  anchorWatches.set(document, checks);
  new MutationObserver(() => {
    for (const run of checks) {
      run();
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
}

// Everything the browser's own forward walk stops on, in document order.
//
// A popover's own buttons are left out where the walk runs, because the walk answers where the
// reader goes after that popover shuts. A control a roving list has taken out of the walk keeps
// a negative index, so the index decides rather than the selector.
export const TAB_STOPS =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]';

// Where the reader goes when the walk leaves a popover, given every stop the document holds in
// its own order.
//
// The anchor holds its own place whatever index it carries. A figure that is not its row's one
// keyboard stop carries a negative index, and a walk that read only the stops lost the figure it
// started from. `within` answers for the popover walking out and for the record drawn over it,
// which is about a figure standing inside that popover: a reader leaving one must never be
// dropped inside the other. An anchor that is the last stop the page holds sends the reader out
// of the panel rather than into a popover standing behind it.
export function walkOutOf(
  stops: readonly HTMLElement[],
  node: HTMLElement,
  within: (stop: HTMLElement) => boolean,
): HTMLElement | null {
  const walk = stops.filter(
    (stop) =>
      stop === node ||
      (stop.tabIndex >= 0 &&
        !within(stop) &&
        !stop.closest('[hidden]') &&
        (stop.offsetWidth > 0 || stop.offsetHeight > 0)),
  );
  const at = walk.indexOf(node);
  return at < 0 ? null : (walk[at + 1] ?? null);
}

export function createStatDetailRenderer(options: StatDetailRendererOptions): StatDetailRenderer {
  const document = options.document;
  const view = document.defaultView as Window;
  const pop = document.createElement('div');
  pop.id = options.id ?? 'chippop';
  // Both instances carry the class, and the stylesheet formats them through it, so the second
  // popover inherits the first one's shape rather than copying it.
  pop.className = 'pop chippop';
  pop.hidden = true;
  pop.setAttribute('role', 'tooltip');
  // Popovers share one layer, so the one later in the body draws on top. The nested instance
  // is created after the outer one and so draws over it.
  document.body.appendChild(pop);
  let nested: StatDetailRenderer | null = null;
  const inNested = (node: Node | null | undefined): boolean => !!node && !!nested?.element.contains(node);
  const details = new WeakMap<HTMLElement, DetailValue>();
  const cleanups = new WeakMap<HTMLElement, () => void>();
  const pointerAnchors = new WeakMap<PointerEvent, HTMLElement>();
  let anchor: HTMLElement | null = null;
  let pinned = false;
  let pointerOnAnchor = false;
  let pointerOnDetail = false;
  let rowsHost: HTMLElement | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let focusBack: HTMLElement | null = null;
  // Set while a closing popover hands the press back to its anchor, so the anchor's own focus
  // handler does not read that as a reader arriving and draw the popover again.
  let returning = false;
  let dismissedAnchor: HTMLElement | null = null;
  let drawnPrint: string | null = null;
  // Whether the drawing on screen holds its list's buttons. The print says nothing about it:
  // the same list is drawn with buttons pinned and without them as a hover preview.
  let drawnActions = false;
  let contextMeasurementOpen = false;
  let drawDebt: { anchor: HTMLElement; value: ResolvedDetailValue } | null = null;

  const resolve = (
    detail: CurrentDetail<string | null | undefined>,
    detailList: CurrentDetail<StatDetailList | null | undefined>,
  ): ResolvedDetailValue => {
    const resolvedDetail = current(detail);
    const resolvedList = current(detailList);
    return {
      detail: resolvedDetail,
      detailList: resolvedList,
      print: JSON.stringify(resolvedList ?? resolvedDetail ?? ''),
    };
  };

  const cancelGrace = () => {
    if (graceTimer === null) {
      return;
    }
    clearTimeout(graceTimer);
    graceTimer = null;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };
  const relative = (line: RelativeDetailLine) => {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(line.lead));
    const age = el(
      'span',
      `chippopage${line.underline ? ' is-underlined' : ''}`,
      line.remaining ? formatCacheSpan(line.at - Date.now()) : formatRelative(line.at, Date.now()),
    );
    age.dataset.at = String(line.at);
    if (line.remaining) {
      age.dataset.remaining = 'true';
    }
    if (line.title) {
      age.title = line.title;
      age.setAttribute('aria-label', `${age.textContent}. ${line.title}`);
    }
    fragment.appendChild(age);
    fragment.appendChild(document.createTextNode(line.trail));
    return fragment;
  };
  const detailHead = (entry: DetailHead, className: string, withActions = false) => {
    const head = el('div', className);
    const press = withActions ? entry.nameAction : undefined;
    const label = press
      ? el('button', `chippoplabel chippopnamelink${entry.warning ? ' chippopwarning' : ''}`)
      : el('span', `chippoplabel${entry.warning ? ' chippopwarning' : ''}`);
    if (press) {
      (label as HTMLButtonElement).type = 'button';
      label.setAttribute('aria-label', press.name);
      label.setAttribute('data-hint', press.hint);
      label.addEventListener('click', (event) => {
        event.stopPropagation();
        press.run(event);
      });
    }
    if (entry.warning) {
      const sign = el('span', 'statwarningsign', STAT_WARNING_SIGN);
      sign.setAttribute('aria-hidden', 'true');
      label.append(sign, document.createTextNode(' '));
    }
    label.appendChild(document.createTextNode(entry.label));
    if (entry.fact) {
      const fact = el('span', 'commitheadfact', entry.fact);
      if (entry.factArrival) {
        // The merged word carries its own hover, and hidden words speak what the hover says.
        const arrival = el('span', 'commitheadarrival', ARRIVAL_WORD);
        arrival.title = entry.factArrival.title;
        arrival.appendChild(el('span', 'sr-only', entry.factArrival.spoken));
        fact.append(document.createTextNode(' '), arrival);
      }
      label.append(document.createTextNode(' '), fact);
    }
    head.appendChild(label);
    // The same halves the figure over this record draws, and by the same rule: a half that moved
    // no line is left out, so a record that only added lines heads `+4` rather than `+4 −0`. A
    // record that moved nothing at all heads with its label alone and gains no trailing space.
    const halves = diffHalves(entry.diff?.added, entry.diff?.removed);
    if (halves.length) {
      head.appendChild(document.createTextNode(' '));
      const pair = el('span', 'chippopvalue');
      halves.forEach((half, index) => {
        if (index) {
          pair.appendChild(document.createTextNode(' '));
        }
        pair.appendChild(el('span', half.tone, half.text));
      });
      head.appendChild(pair);
    }
    const tone = `${entry.mutedValue ? ' chippopmuted' : ''}${entry.busyValue ? ' is-busy' : ''}`;
    if (entry.value) {
      head.appendChild(document.createTextNode(' '));
      if (typeof entry.value === 'string') {
        const value = el('span', `chippopvalue${tone}`, entry.value);
        if (entry.valueTitle) {
          value.title = entry.valueTitle;
        }
        head.appendChild(value);
      } else {
        const value = el('span', `chippopvalue${tone}`);
        value.appendChild(relative(entry.value));
        head.appendChild(value);
      }
    }
    return head;
  };
  const subitem = (line: DetailLine, withActions: boolean): HTMLLIElement => {
    const row = el('li', 'chippopsubitem');
    if (typeof line === 'string') {
      row.textContent = line;
      return row;
    }
    if ('text' in line) {
      if (line.kind) {
        row.classList.add(KIND_CLASS[line.kind]);
      }
      if (line.cost) {
        row.classList.add('chippopcost');
      }
      if (line.warning) {
        row.classList.add('chippopwarning');
        const sign = el('span', 'statwarningsign', STAT_WARNING_SIGN);
        sign.setAttribute('aria-hidden', 'true');
        row.append(sign, document.createTextNode(' '));
      }
      const press = withActions ? line.action : undefined;
      if (press) {
        const label = el('button', 'chippopnamelink');
        label.type = 'button';
        label.setAttribute('aria-label', press.name);
        label.setAttribute('data-hint', press.hint);
        label.addEventListener('click', (event) => {
          event.stopPropagation();
          press.run(event);
        });
        label.textContent = line.text;
        row.appendChild(label);
      } else {
        row.appendChild(document.createTextNode(line.text));
      }
      if (line.title) {
        row.title = line.title;
      }
      if (line.cacheHit) {
        const text = cacheHitText(line.cacheHit);
        const rate = el('span', 'chippopscale');
        const tail = [text.requestScale].filter((part) => part !== null);
        rate.append(
          document.createTextNode(' ('),
          el('span', `chippopcachehit${line.cacheHit.warning ? ' is-warning' : ''}`, text.cached),
          document.createTextNode(`${tail.map((part) => ` · ${part}`).join('')})`),
        );
        const share = line.cacheHit.warning
          ? 'Less than 80% of input served from cache across at least five model requests and $0.50 of estimated input cost.'
          : 'Share of input tokens served from cache, including cache writes in total input.';
        rate.title = share;
        row.appendChild(rate);
      }
      appendLines(row, line.lines, withActions);
      return row;
    }
    row.appendChild(relative(line));
    return row;
  };
  // Every press inside the popover: the actions a list declares, and the record rows the
  // renderer drew. A row is the only way into a file, a subagent session or a commit from
  // here, so the keyboard walk holds the rows as well as the actions.
  const POP_PRESSES = '.chippopnamelink, .chippoprows button, .context-bound button';
  // The Tab walk holds presses, row figure stops, rows without links, and the Context
  // measurement disclosure. The arrow keys walk presses alone.
  const POP_TAB_STOPS = `${POP_PRESSES}, .chippoprows [tabindex="0"], .context-measurement summary`;
  // Every button the reader can reach inside the popover, in reading order.
  const actionButtons = () => Array.from(pop.querySelectorAll<HTMLButtonElement>(POP_PRESSES));
  // Every stop Tab takes inside the popover, in reading order.
  const tabStops = () => Array.from(pop.querySelectorAll<HTMLElement>(POP_TAB_STOPS));
  const appendLines = (parent: HTMLElement, lines: DetailLine[] | undefined, withActions: boolean): void => {
    if (!lines?.length) {
      return;
    }
    const list = el('ul', 'chippopsublist');
    for (const line of lines) {
      list.appendChild(subitem(line, withActions));
    }
    parent.appendChild(list);
  };
  const drawInto = (value: ResolvedDetailValue, withActions: boolean) => {
    const { detail, detailList: listValue } = value;
    if (rowsHost) {
      options.renderRows?.(rowsHost, null);
      rowsHost = null;
    }
    pop.textContent = '';
    pop.classList.toggle('context-detail', !!listValue?.context);
    if (listValue?.context) {
      drawnPrint = value.print;
      drawnActions = true;
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Context details');
      pop.tabIndex = -1;
      pop.removeAttribute('aria-describedby');
      drawContextDetail(document, pop, listValue.context);
      const measurement = pop.querySelector<HTMLDetailsElement>('.context-measurement');
      if (measurement) measurement.open = contextMeasurementOpen;
      return;
    }
    pop.classList.toggle('chippop-stacked', listValue?.layout === 'stacked');
    pop.classList.toggle('chippop-tools', listValue?.layout === 'tool-breakdown');
    pop.classList.toggle('chippop-skills', listValue?.layout === 'skills');
    pop.classList.toggle('chippop-economics', listValue?.layout === 'economics');
    // A popover drawing rows is the one the reader presses inside, so it takes the pointer
    // whether or not it is pinned. The class is what the stylesheet reads to decide that.
    pop.classList.toggle('chippop-rows', !!listValue?.rows);
    pop.classList.toggle('chippop-agents', listValue?.layout === 'agents' || listValue?.layout === 'dispatched');
    pop.classList.toggle('chippop-commits', listValue?.layout === 'commits');
    drawnPrint = value.print;
    drawnActions = withActions;
    // A popover holding a press is a dialog the reader moves into, and it needs a name of its
    // own there. One holding only text stays a tooltip, read where the reader already stands.
    pop.setAttribute('role', withActions ? 'dialog' : 'tooltip');
    if (withActions && listValue?.heading) {
      // The reader walks into the dialog and hears its name once. The heading label alone
      // leaves out the figure beside it, which the reader sees, so the name carries both.
      const figure = typeof listValue.heading.value === 'string' ? listValue.heading.value : null;
      pop.setAttribute(
        'aria-label',
        [
          [listValue.heading.label, listValue.heading.fact, listValue.heading.factArrival ? ARRIVAL_WORD : null]
            .filter(Boolean)
            .join(' '),
          figure,
        ]
          .filter(Boolean)
          .join(', '),
      );
    } else {
      pop.removeAttribute('aria-label');
    }
    // A line under the rows describes the dialog and does not name it. Carried in the name, it
    // would follow the name on every announcement. Pointed at by `aria-describedby`, each line
    // is spoken once as the reader walks in.
    const footIds =
      withActions && listValue?.footer?.length
        ? // The id carries the popover's own, because both instances can stand at once and a
          // description pointed at by two elements is read from whichever one the browser finds.
          listValue.footer.map((_line, at) => `${pop.id}foot-${at}`)
        : [];
    if (footIds.length) {
      pop.setAttribute('aria-describedby', footIds.join(' '));
    } else {
      pop.removeAttribute('aria-describedby');
    }
    const appendFoot = (line: string, at: number, className: string) => {
      const node = el('div', className, line);
      if (footIds[at]) {
        node.id = footIds[at];
      }
      pop.appendChild(node);
    };
    if (listValue) {
      if (listValue.heading) {
        pop.appendChild(detailHead(listValue.heading, 'chippophead'));
      }
      if (listValue.rows && options.renderRows) {
        const host = el('div', 'chippoprows');
        pop.appendChild(host);
        options.renderRows(host, listValue.rows);
        rowsHost = host;
        (listValue.footer || []).forEach((line, at) => appendFoot(line, at, 'chippopfoot'));
        return;
      }
      // An empty list still carries the margin `chippoplist` draws around its rows, which
      // would leave a blank gap between the heading and whatever follows with nothing in it.
      // The element itself is left off the page rather than styled around, so a list with
      // nothing to say takes no room.
      const hasEntries = listValue.entries.length > 0;
      if (hasEntries) {
        const list = el('ul', 'chippoplist');
        for (const entry of listValue.entries) {
          const item = el('li', 'chippopitem');
          if (entry.separateBefore) {
            item.classList.add('is-separated');
          }
          const head = detailHead(entry, 'chippopitemhead', withActions);
          item.appendChild(head);
          appendLines(item, entry.lines, withActions);
          list.appendChild(item);
        }
        pop.appendChild(list);
      }
      if (listValue.bound) {
        const bound = el('div', 'chippopbound');
        bound.appendChild(detailHead(listValue.bound, 'chippopitemhead'));
        appendLines(bound, listValue.bound.lines, withActions);
        pop.appendChild(bound);
      }
      // With the list gone, the footer would still carry the border and the padding it wears
      // to part itself from a list above it, drawing a second rule right under the heading's
      // own and pushing the description down by both. Where no list and no bound sat between
      // the heading and this footer, it draws flush instead: the heading's rule is the only
      // one, and the description sits below it at the same ordinary gap a list's own top
      // margin would have left.
      const flush = !hasEntries && !listValue.bound;
      (listValue.footer || []).forEach((line, at) =>
        appendFoot(line, at, flush ? 'chippopfoot chippopfoot-flush' : 'chippopfoot'),
      );
      return;
    }
    for (const line of (detail || '').split(/\r?\n/)) {
      pop.appendChild(el('div', line ? 'chippopline' : 'chippopline gap', line || ' '));
    }
  };
  // Whether the drawing on screen is being replaced right now. A redraw takes back the rows it
  // drew, and focus standing on one of them falls to nothing as that row leaves. That is the
  // popover rebuilding itself, not a reader walking out of it, so the watch below stands down
  // for the length of the draw.
  let redrawing = false;
  const draw = (value: ResolvedDetailValue, withActions: boolean) => {
    const measurement = pop.querySelector<HTMLDetailsElement>('.context-measurement');
    if (measurement && drawnPrint !== null) contextMeasurementOpen = measurement.open;
    const focused = ['.context-bound button', '.context-measurement summary'].find(
      (selector) => pop.querySelector(selector) === document.activeElement,
    );
    redrawing = true;
    try {
      drawInto(value, withActions);
      if (focused)
        (
          pop.querySelector<HTMLElement>(focused) ??
          pop.querySelector<HTMLElement>('.context-bound button') ??
          pop
        ).focus({ preventScroll: true });
    } finally {
      redrawing = false;
    }
  };
  // The link from an anchor to the popover, taken back when the popover stops being about it.
  const release = (node: HTMLElement) => {
    node.removeAttribute('aria-describedby');
    if (node.getAttribute('aria-controls') === pop.id) {
      node.setAttribute('aria-expanded', 'false');
    }
  };
  const show = (node: HTMLElement, requested?: ResolvedDetailValue) => {
    cancelGrace();
    const source = details.get(node);
    if (!source) {
      return;
    }
    if (pop.hidden || anchor !== node) options.onOpen?.(node);
    const value = requested ?? resolve(source.detail, source.detailList);
    if (anchor && anchor !== node) {
      release(anchor);
      drawDebt = null;
      drawnPrint = null;
      contextMeasurementOpen = false;
    }
    anchor = node;
    // An interactive list is a disclosure, so its anchor says what it controls and whether
    // that is open. A read-only list is description, and its anchor keeps saying exactly that.
    if (value.detailList?.actions) {
      node.setAttribute('aria-controls', pop.id);
      node.setAttribute('aria-expanded', 'true');
    } else {
      node.setAttribute('aria-describedby', pop.id);
    }
    // Rows and presses are drawn whenever the popover is shown. The pointer crosses to them
    // over the grace above, so a reader reaches one without pinning first.
    const withActions = !!value.detailList?.actions;
    if (value.print !== drawnPrint || withActions !== drawnActions) {
      draw(value, withActions);
    }
    pop.hidden = false;
    if (!node.closest('.cnextturn')) {
      pop.style.removeProperty('max-height');
    }
    options.placeFloat(pop, node, view.innerHeight - 6);
  };
  const hide = (node: HTMLElement | null, force = false, refocus = false) => {
    if (node && anchor !== node) {
      return;
    }
    if (
      !force &&
      (pinned ||
        (options.actionAnchor &&
          (pointerOnAnchor ||
            pointerOnDetail ||
            pop.contains(document.activeElement) ||
            anchor?.contains(document.activeElement))))
    ) {
      return;
    }
    cancelGrace();
    // A record drawn over this one is about a figure inside it, so it goes with it.
    nested?.dismiss();
    // Focus standing on a press inside the popover has nowhere to fall once the popover is
    // taken off the page. It goes back to the anchor whether or not the caller asked, which
    // covers a popover the reader reached over the hover grace and never pinned.
    const held = refocus || pop.contains(document.activeElement);
    const prior = anchor;
    if (prior) {
      prior.classList.remove('detail-pinned');
      release(prior);
      if (options.actionAnchor) prior.removeAttribute('aria-pressed');
      else prior.setAttribute('aria-pressed', 'false');
    }
    pop.hidden = true;
    options.onClose?.();
    pop.classList.remove('pinned');
    const target = focusBack?.isConnected ? focusBack : prior?.isConnected ? prior : null;
    anchor = null;
    pinned = false;
    focusBack = null;
    drawnPrint = null;
    drawnActions = false;
    contextMeasurementOpen = false;
    drawDebt = null;
    // Handed back last, from a shut popover. A chip draws its detail when it takes focus, and
    // a chip that is only being given its press back has not been focused by the reader.
    if (held && target) {
      returning = true;
      target.focus({ preventScroll: true });
      returning = false;
    }
  };
  const hideAfterGrace = (node: HTMLElement | null) => {
    if (pinned) {
      return;
    }
    cancelGrace();
    graceTimer = setTimeout(() => {
      graceTimer = null;
      hide(node);
    }, HOVER_GRACE_MS);
  };
  const markPinned = (node: HTMLElement) => {
    pop.classList.add('pinned');
    node.classList.add('detail-pinned');
    if (!options.actionAnchor) node.setAttribute('aria-pressed', 'true');
  };
  const pin = (node: HTMLElement) => {
    if (pinned && anchor === node) {
      if (options.actionAnchor) dismissedAnchor = node;
      hide(node, true, !!options.actionAnchor);
      return;
    }
    if (anchor) {
      anchor.classList.remove('detail-pinned');
      if (!options.actionAnchor) anchor.setAttribute('aria-pressed', 'false');
    }
    dismissedAnchor = null;
    const active = document.activeElement;
    // A nested record hands focus back to the figure it is about. The figure is where the
    // reader stands, and whatever held focus before the press sits behind a popover this one
    // does not close.
    focusBack = options.actionAnchor ? node : options.nested || !(active instanceof HTMLElement) ? null : active;
    pinned = true;
    show(node);
    markPinned(node);
    options.onPin?.(node);
  };
  const mount = (node: HTMLElement, ownStop = false) => {
    const existing = cleanups.get(node);
    if (existing) {
      return existing;
    }
    node.classList.add('has-detail');
    node.classList.toggle('statdetail', !ownStop);
    if (options.actionAnchor) node.removeAttribute('aria-pressed');
    else node.setAttribute('aria-pressed', String(pinned && anchor === node));
    const enter = () => {
      pointerOnAnchor = true;
      if (dismissedAnchor === node) return;
      if (!pinned) {
        show(node);
      }
    };
    // The pointer leaving the chip starts the grace rather than shutting the popover, so the
    // gap between the two is crossable. Entering the popover cancels it.
    const leave = () => {
      pointerOnAnchor = false;
      if (dismissedAnchor === node) dismissedAnchor = null;
      hideAfterGrace(node);
    };
    const away = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (next && pop.contains(next)) return;
      if (options.actionAnchor && !next) return;
      if (dismissedAnchor === node) dismissedAnchor = null;
      hide(node);
    };
    const focus = () => {
      if (!pinned && !returning && dismissedAnchor !== node) {
        show(node);
      }
    };
    const click = (event: MouseEvent) => {
      event.stopPropagation();
      pin(node);
    };
    // The way into a pinned popover that holds stops. Both keys are offered because the
    // popover is drawn on the body: a plain Tab from here would walk to whatever follows this
    // anchor on the page and step straight over the controls the press just opened. Tab lands
    // on the first stop of the Tab walk, and ArrowDown on the first press, because the arrow
    // keys walk the presses alone.
    const keydown = (event: KeyboardEvent) => {
      // A record that draws the turn's own rows holds presses without declaring actions, so the
      // way in is whether the drawing has a stop rather than what the list called itself.
      if ((!pinned && !options.actionAnchor) || anchor !== node) {
        return;
      }
      if (event.key !== 'ArrowDown' && (event.key !== 'Tab' || event.shiftKey)) {
        return;
      }
      const first = event.key === 'Tab' ? tabStops()[0] : actionButtons()[0];
      if (!first) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    };
    node.addEventListener('keydown', keydown);
    node.addEventListener('pointerenter', enter);
    node.addEventListener('pointerleave', leave);
    node.addEventListener('pointercancel', away);
    node.addEventListener('focus', focus);
    node.addEventListener('blur', away);
    node.addEventListener('click', click);
    const cleanup = () => {
      node.removeEventListener('keydown', keydown);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('pointercancel', away);
      node.removeEventListener('focus', focus);
      node.removeEventListener('blur', away);
      node.removeEventListener('click', click);
      cleanups.delete(node);
      details.delete(node);
      if (anchor === node) {
        pointerOnAnchor = false;
        hide(node, true);
      }
    };
    cleanups.set(node, cleanup);
    return cleanup;
  };
  const update: StatDetailRenderer['update'] = (node, detail, detailList) => {
    details.set(node, { detail, detailList });
    // An interactive anchor says what it opens as soon as it has a list, so a screen reader
    // reads a shut disclosure rather than a bare button the reader has to press to learn from.
    // A list built on demand waits until it is shown: resolving every one of them here would
    // run each card's detail builder on every repaint.
    if (typeof detailList !== 'function' && detailList?.actions) {
      node.setAttribute('aria-controls', pop.id);
      if (options.actionAnchor) node.setAttribute('aria-haspopup', 'dialog');
      if (anchor !== node || pop.hidden) {
        node.setAttribute('aria-expanded', 'false');
      }
    }
    if (anchor === node && !pop.hidden) {
      const value = resolve(detail, detailList);
      if (drawnPrint === value.print) {
        drawDebt = null;
        if (options.actionAnchor) options.placeFloat(pop, node, view.innerHeight - 6);
        return;
      }
      if (options.selectionWithin?.(pop)) {
        drawDebt = { anchor: node, value };
        return;
      }
      drawDebt = null;
      show(node, value);
      if (pinned) {
        markPinned(node);
      }
    }
  };
  const connect: StatDetailRenderer['connect'] = (node, detail, detailList, ownStop) => {
    mount(node, ownStop);
    update(node, detail, detailList);
  };
  const layout: StatDetailRenderer['layout'] = (node, visible) => {
    if (anchor !== node) {
      return;
    }
    if (!visible) {
      if (pinned) {
        pop.hidden = true;
      } else {
        release(node);
        pop.hidden = true;
      }
      return;
    }
    show(node);
    if (pinned) {
      markPinned(node);
    }
  };
  pop.addEventListener(
    'toggle',
    (event) => {
      const measurement = event.target;
      if (!(measurement instanceof HTMLDetailsElement) || !measurement.matches('.context-measurement')) return;
      if (!anchor || pop.hidden) return;
      contextMeasurementOpen = measurement.open;
      if (anchor && !pop.hidden) options.placeFloat(pop, anchor, view.innerHeight - 6);
    },
    true,
  );
  const retarget: StatDetailRenderer['retarget'] = (within, node, detail, detailList, ownStop) => {
    if (!anchor || !within.contains(anchor)) {
      return false;
    }
    const wasPinned = pinned;
    hide(null, true);
    connect(node, detail, detailList, ownStop);
    if (wasPinned) {
      pin(node);
    } else {
      show(node);
    }
    return true;
  };

  const nextStopAfter = (node: HTMLElement): HTMLElement | null =>
    walkOutOf(
      Array.from(document.querySelectorAll<HTMLElement>(TAB_STOPS)),
      node,
      // This popover, and the record drawn over it, which is about a figure standing in it.
      (stop) => pop.contains(stop) || inNested(stop),
    );
  pop.addEventListener('pointerenter', () => {
    pointerOnDetail = true;
    cancelGrace();
  });
  pop.addEventListener('pointerleave', (event) => {
    pointerOnDetail = false;
    // The pointer crossing into the record drawn over this one has not left this one: that
    // record is about a figure inside it, and the reader is still reading this popover.
    if (inNested(event.relatedTarget as Node | null)) {
      return;
    }
    hideAfterGrace(anchor);
  });
  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && options.actionAnchor) {
      event.preventDefault();
      event.stopPropagation();
      dismissedAnchor = anchor;
      hide(null, true, true);
      return;
    }
    const target = event.target as HTMLElement;
    const owner = anchor;
    if (!owner) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const button = target.closest<HTMLButtonElement>(POP_PRESSES);
      if (!button) {
        return;
      }
      const buttons = actionButtons();
      const at = buttons.indexOf(button);
      event.preventDefault();
      event.stopPropagation();
      buttons[event.key === 'ArrowDown' ? Math.min(at + 1, buttons.length - 1) : Math.max(at - 1, 0)]?.focus();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    // Focus need not stand on a stop of the walk. A figure its row's arrows took out of the Tab
    // order still takes focus from a press, and gets it back when its record closes. The browser
    // steps on from where focus stands in the document, so the walk answers only where no stop
    // lies that way.
    const toward = event.shiftKey ? target.DOCUMENT_POSITION_PRECEDING : target.DOCUMENT_POSITION_FOLLOWING;
    if (tabStops().some((stop) => stop !== target && target.compareDocumentPosition(stop) & toward)) {
      return;
    }
    // The popover sits on the body, so where it is in the document is not where it is read.
    // The walk is put back on the anchor's own place in the page: backward it returns to the
    // anchor, and forward it carries on past it. Pinned context stays open.
    if (event.shiftKey) {
      event.preventDefault();
      owner.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    // Focus moves before dismissal, leaving the reader on the next control rather than a
    // removed button.
    const onwards = nextStopAfter(owner);
    onwards?.focus();
    if (!options.actionAnchor || !pinned) hide(null, true);
  });
  // Focus departure closes ordinary detail. Context stays open while pinned or while the
  // pointer remains inside the detail or its anchor.
  pop.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    // A press inside the record drawn over this one is a press inside this one: that record is
    // about a figure standing here, so the reader has not walked out.
    if (
      redrawing ||
      (!pinned && !options.actionAnchor) ||
      (options.actionAnchor && (pinned || !next || pointerOnAnchor || pointerOnDetail)) ||
      (next && (pop.contains(next) || anchor?.contains(next) || inNested(next)))
    ) {
      return;
    }
    hide(null, true);
  });

  if (!options.nested) {
    options.events.document('pointerdown', (raw) => {
      const event = raw as PointerEvent;
      const pointed = pointerAnchors.get(event);
      if (
        (!pinned && !options.actionAnchor) ||
        pop.contains(event.target as Node) ||
        anchor?.contains(event.target as Node) ||
        inNested(event.target as Node) ||
        pointed === anchor
      ) {
        return;
      }
      hide(null, true);
    });
    options.events.document('keydown', (raw) => {
      const event = raw as KeyboardEvent;
      if (event.key !== 'Escape' || (!pinned && pop.hidden)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // The record drawn over this one goes first, and focus lands on the figure it is about.
      // A second Escape then closes this one. Both instances answering the key themselves
      // would close the pair on one press, whichever order the two listeners ran in.
      if (nested?.dismiss()) {
        return;
      }
      if (options.actionAnchor) dismissedAnchor = anchor;
      hide(null, true, pinned || !!options.actionAnchor);
    });
  }
  options.events.document('selectionchange', () => {
    const currentAnchor = anchor;
    const debt = drawDebt;
    if (!debt || !currentAnchor || debt.anchor !== currentAnchor || pop.hidden || options.selectionWithin?.(pop)) {
      return;
    }
    drawDebt = null;
    if (drawnPrint !== debt.value.print) {
      show(currentAnchor, debt.value);
    }
  });
  watchAnchors(document, () => {
    if (anchor && (!anchor.isConnected || anchor.closest('[hidden]'))) {
      hide(null, true);
    }
  });

  return {
    element: pop,
    dismissWithin(within) {
      if (!anchor || !within.contains(anchor)) return false;
      hide(null, true);
      return true;
    },
    attachNested(next) {
      nested = next;
      next.element.addEventListener('pointerenter', cancelGrace);
      next.element.addEventListener('pointerleave', (event) => {
        const to = event.relatedTarget as Node | null;
        // A record opened from a card figure has no popover under it. Its own press and Escape
        // close it, so a pointer that leaves it starts no countdown here.
        if (!anchor || pop.contains(to) || inNested(to)) {
          return;
        }
        hideAfterGrace(anchor);
      });
    },
    pinCurrent() {
      if (pinned || !anchor) {
        return;
      }
      pinned = true;
      focusBack = null;
      markPinned(anchor);
    },
    mount,
    update,
    connect,
    retarget,
    layout,
    pointerAnchor(event, node) {
      if (node) {
        pointerAnchors.set(event, node);
      }
    },
    dismiss() {
      if (!pinned && pop.hidden) {
        return false;
      }
      hide(null, true);
      return true;
    },
  };
}
