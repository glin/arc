import { formatCacheSpan, formatRelative } from '../view/time.ts';
import { cacheHitText, diffHalves, type CacheHitDetail } from '../view/stat-detail.ts';
import { ARRIVAL_WORD } from '../view/card-presentation.ts';
import type { DetailRows } from './card-rows.ts';
import { drawContextDetail, type ContextDetailView } from './context-detail.ts';

// Delay after the pointer leaves a chip or popover. This lets the pointer cross the gap without pinning.
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

// Action rendered on an entry's label.
export interface DetailNameAction {
  // The whole accessible name, which carries the label's own words and what they act on.
  name: string;
  // The hint a pointer reader sees on hover, since the button carries no native title.
  hint: string;
  run(event: MouseEvent): void;
}

interface DetailHead {
  label: string;
  // Muted text after the label, such as a commit branch. factArrival supplies the branch's landing tooltip.
  fact?: string;
  factArrival?: { title: string; spoken: string };
  value?: string | RelativeDetailLine;
  // Added and removed lines, drawn in their own tones rather than as words.
  diff?: { added: number; removed: number };
  mutedValue?: boolean;
  // Use the running tone for the value.
  busyValue?: boolean;
  valueTitle?: string | null;
  lines?: DetailLine[];
  separateBefore?: boolean;
  warning?: boolean;
  // Turn the label into a button when the list declares actions.
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
      // Distinguish the description, file path, and muted text within a sublist.
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
  // Choose the record layout. Omission uses the compact label-and-value grid.
  layout?: 'stacked' | 'tool-breakdown' | 'skills' | 'economics' | 'files' | 'agents' | 'dispatched' | 'commits';
  // Declare entry actions. Draw their buttons whenever the popover is shown.
  // Actions select the dialog role and disclosure attributes for the anchor.
  actions?: boolean;
  heading?: DetailHead;
  entries: DetailHead[];
  // Turn record arrays shared with the card body. Entries provide the chip's plain-text detail.
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
  // The outer instance handles Escape and outside presses for nested instances.
  nested?: boolean;
  // Report the newly pinned anchor. The outer instance uses it to pin only when that anchor is inside its popover.
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
  // Draw record rows in the supplied host. Release them when rows is null.
  renderRows?(host: HTMLElement, rows: DetailRows | null): void;
}

export interface StatDetailRenderer {
  // The popover itself, for an owner that has to ask where the pointer or the focus stands.
  readonly element: HTMLElement;
  // Treat a nested instance as part of this popover for pointer, focus, and dismissal.
  attachNested(nested: StatDetailRenderer): void;
  // Pin the current popover without changing its anchor. Clear focus return to avoid targeting a hidden outer popover.
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

// Shared anchor checks, served by one body MutationObserver per document.
// Checks dismiss popovers whose anchors leave the page or gain a hidden ancestor.
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

// Candidate controls for the document tab walk. The caller excludes popover descendants and negative tab indexes.
export const TAB_STOPS =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]';

// Find the next visible Tab stop after the anchor in document order.
// Keep the anchor as the starting point even when its tabIndex is negative.
// Exclude both popovers through within. Return null when no stop follows the anchor.
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
  // Both popover instances share the stylesheet's chippop rules.
  pop.className = 'pop chippop';
  pop.hidden = true;
  pop.setAttribute('role', 'tooltip');
  // Nested popovers mount later in the body and draw above the outer instance.
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
  // Suppress the anchor's focus handler while returning focus after dismissal.
  let returning = false;
  let dismissedAnchor: HTMLElement | null = null;
  let drawnPrint: string | null = null;
  // Track whether the current draw includes actions. The content print does not include this flag.
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
    // Use the chip's diff rules. Omit zero halves and omit the separator for an empty pair.
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
  // Arrow-key targets include label actions, record-row buttons, and the Context action.
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
    // Record rows accept pointer input even when the popover is unpinned.
    pop.classList.toggle('chippop-rows', !!listValue?.rows);
    pop.classList.toggle('chippop-agents', listValue?.layout === 'agents' || listValue?.layout === 'dispatched');
    pop.classList.toggle('chippop-commits', listValue?.layout === 'commits');
    drawnPrint = value.print;
    drawnActions = withActions;
    // Declared actions select the dialog role. Other lists use the tooltip role.
    pop.setAttribute('role', withActions ? 'dialog' : 'tooltip');
    if (withActions && listValue?.heading) {
      // Include the heading label and its string value in the dialog's accessible name.
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
    // Footer lines describe the dialog through aria-describedby, separately from its accessible name.
    const footIds =
      withActions && listValue?.footer?.length
        ? // Prefix footer ids with the popover id to distinguish simultaneous instances.
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
      // Omit empty lists so their margins leave no blank gap.
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
      // Use the flush footer style when no entries or bound separate it from the heading.
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
  // Ignore focus departure during redraws. Removing focused rows does not represent reader navigation.
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
    // Interactive anchors expose a disclosure. Read-only anchors expose a description.
    if (value.detailList?.actions) {
      node.setAttribute('aria-controls', pop.id);
      node.setAttribute('aria-expanded', 'true');
    } else {
      node.setAttribute('aria-describedby', pop.id);
    }
    // Draw available actions on hover as well as when pinned.
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
    // Return focus from inside the closing popover, including when the reader entered it without pinning.
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
    // Return focus after hiding. Suppress the anchor handler so it cannot reopen the popover.
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
    // Nested records return focus to their anchor, not to a control behind the outer popover.
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
    // Leaving the chip starts the grace period. Entering the popover cancels it.
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
    // Body-mounted popovers sit outside the anchor's document order.
    // Tab enters at the first Tab stop. ArrowDown enters at the first button.
    const keydown = (event: KeyboardEvent) => {
      // Record rows can contain controls without declaring actions. Inspect the drawn controls.
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
    // Publish disclosure attributes for supplied interactive lists.
    // Resolve lazy lists only when shown, avoiding detail construction on every card draw.
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
      // Exclude this popover and its nested instance from the outgoing Tab route.
      (stop) => pop.contains(stop) || inNested(stop),
    );
  pop.addEventListener('pointerenter', () => {
    pointerOnDetail = true;
    cancelGrace();
  });
  pop.addEventListener('pointerleave', (event) => {
    pointerOnDetail = false;
    // Entering the nested popover keeps the outer instance open.
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
    // A focused figure can have a negative tabIndex. Use its document position to find stops in either direction.
    const toward = event.shiftKey ? target.DOCUMENT_POSITION_PRECEDING : target.DOCUMENT_POSITION_FOLLOWING;
    if (tabStops().some((stop) => stop !== target && target.compareDocumentPosition(stop) & toward)) {
      return;
    }
    // Continue from the anchor's document position. Shift+Tab returns to the anchor. Pinned context remains open.
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
  // Focus departure closes pinned ordinary detail. Context stays open while pinned or while the pointer remains on its popover or anchor.
  pop.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    // Moving focus into the nested popover keeps this instance open.
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
      // Dismiss the nested popover first. A second Escape closes the outer instance.
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
        // A nested instance opened from a card figure has no outer anchor, so it starts no outer grace timer.
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
