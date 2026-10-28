import { formatCacheSpan, formatRelative } from '../view/time.ts';
import { cacheHitText, diffHalves, type CacheHitDetail } from '../view/stat-detail.ts';
import { ARRIVAL_WORD } from '../view/card-presentation.ts';
import type { DetailRows } from './card-rows.ts';
import { drawContextDetail, type ContextDetailView } from './context-detail.ts';
import { FLOAT_EDGE, FLOAT_GAP } from './dom.ts';
import { appendNameText, inlineText } from './inline-text.ts';

// Delay after the pointer leaves a chip or popover. This lets the pointer cross the gap without pinning.
export const HOVER_GRACE_MS = 150;

export const STAT_WARNING_SIGN = '\u26a0\ufe0e';

// What a low cached share in the warning tone means, as its title and its hidden words.
const LOW_CACHE_WARNING =
  'Less than 80% of input served from cache across at least five model requests and $0.50 of estimated input cost.';

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
  // Draw the label as a muted group heading with no bullet.
  group?: boolean;
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

interface CostRowView {
  label: string;
  count?: string;
  percent: string;
  share: number;
  value: string;
  title: string;
}

// The tabbed form of the two cost popovers, as `turncard.ts` builds it.
export interface CostDetailView {
  warnings: { text: string; quiet?: string; title?: string }[];
  split?: {
    main: string;
    delegated: string;
    mainShare: number;
  };
  sections: {
    label: string;
    detail: string;
    value?: string;
    title: string;
    facts?: { parts: string[]; title: string; warning?: number };
  }[];
  tabs: {
    name: string;
    parts: { rows: CostRowView[]; more?: { shown: number; open: string; close: string }; empty?: string }[];
  }[];
  included: { label: string; value: string; title?: string }[];
}

export interface StatDetailList {
  nameWorktree?: { label: string; name: string; path: string; open(): void };
  context?: ContextDetailView;
  // Draws the cost form in place of the entries.
  cost?: CostDetailView;
  // Choose the record layout. Omission uses the compact label-and-value grid.
  layout?: 'stacked' | 'tool-breakdown' | 'skills' | 'economics' | 'files' | 'agents' | 'dispatched' | 'commits';
  // Declare entry actions. Draw their buttons whenever the popover is shown.
  // Actions select the dialog role and disclosure attributes for the anchor.
  actions?: boolean;
  heading?: DetailHead;
  // Lines drawn before the entries, each in its own line. A line with an action draws as a press.
  lead?: DetailLine[];
  entries: DetailHead[];
  // Turn record arrays shared with the card body. Entries provide the chip's plain-text detail.
  rows?: DetailRows;
  bound?: DetailHead;
  // Lines that change how a figure reads. They stay visible under the breakdown.
  footer?: string[];
  // Standing explanations, folded under a closed "About these figures" disclosure.
  // Notes select the dialog role, so a pinned popover can reach the disclosure.
  notes?: string[];
}

// Label of the notes disclosure in every figure popover.
const NOTES_SUMMARY = 'About these figures';

// One open state for the notes disclosure across every figure popover in the panel, kept in memory.
const notesOpen = new WeakMap<Document, boolean>();

// A list with actions or notes draws as a dialog. Every other list draws as a tooltip.
const isDialogList = (list: StatDetailList | null | undefined): boolean => !!list?.actions || !!list?.notes?.length;

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
    // Window listeners. Omission adds them to the document's own window.
    window?(type: string, listener: EventListenerOrEventListenerObject): void;
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
  // A press-only anchor opens its popover pinned on a press, and a hover or focus opens nothing.
  mount(node: HTMLElement, ownStop?: boolean, pressOnly?: boolean): () => void;
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
    pressOnly?: boolean,
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
  // The cost tab the reader chose. It holds while the popover stays pinned. Empty selects the first tab.
  let costTab = '';
  // Whether the reader opened the delegated models past the third. It holds as the cost tab does.
  let costMore = false;
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
  let contextMessagesOpen = false;
  // Ids of the drawn parts before the notes disclosure, which describe a figure with notes.
  let breakdownIds: string[] = [];
  // Counts the ids given to figures that name a dialog.
  let figureIds = 0;
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
      print: JSON.stringify(
        resolvedList?.nameWorktree ? [resolvedDetail, resolvedList] : (resolvedList ?? resolvedDetail ?? ''),
      ),
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
  // The press a line with an action draws, shared by sub-items and lead lines.
  const pressLine = (text: string, press: DetailNameAction): HTMLButtonElement => {
    const label = el('button', 'chippopnamelink');
    label.type = 'button';
    label.setAttribute('aria-label', press.name);
    label.setAttribute('data-hint', press.hint);
    label.addEventListener('click', (event) => {
      event.stopPropagation();
      press.run(event);
    });
    label.textContent = text;
    return label;
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
        row.appendChild(pressLine(line.text, press));
      } else {
        row.appendChild(document.createTextNode(line.text));
      }
      if (line.title) {
        row.title = line.title;
        if (!press) {
          row.setAttribute('role', 'group');
          row.setAttribute(
            'aria-label',
            line.title.startsWith(`${line.text}.`) ? line.title : `${line.text}. ${line.title}`,
          );
        }
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
          ? LOW_CACHE_WARNING
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
  // Arrow keys reach label actions, record-row buttons, the Context action, and the worktree link.
  const POP_PRESSES = '.chippopnamelink, .chippoprows button, .context-bound button, .sessionworktreelink';
  // The Tab walk holds presses, row figure stops, rows without links, the Context
  // disclosures and the notes disclosure. The arrow keys walk presses alone.
  const POP_TAB_STOPS = `${POP_PRESSES}, .chippoprows [tabindex="0"], .poptabs [tabindex="0"], .context-messages summary, .context-measurement summary, .chippopnotes summary`;
  // Every action the reader can reach inside the popover, in reading order.
  const actionButtons = () => Array.from(pop.querySelectorAll<HTMLElement>(POP_PRESSES));
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
  // A dialog with no heading takes its name from its figure through the figure's id, so the
  // browser reads the figure's spoken text and skips its drawn text.
  const figureNameId = (node: HTMLElement): string => node.id || (node.id = `${pop.id}figure-${++figureIds}`);
  // The notes close the popover under the breakdown, so everything drawn before them is the breakdown.
  // Its shown parts get ids, and the figure's description names them. A cost tab strip and the
  // hidden tab panels stay out of it.
  const describeBreakdown = () => {
    breakdownIds = Array.from(pop.children).flatMap((part, at) =>
      (part as HTMLElement).hidden || part.matches('.poptabs, .chippopnotes')
        ? []
        : [part.id || (part.id = `${pop.id}part-${at}`)],
    );
  };
  const appendNotes = (notes: string[] | undefined) => {
    if (!notes?.length) {
      return;
    }
    describeBreakdown();
    const disclosure = el('details', 'projectspendpricing chippopnotes');
    // A hover shows the closed summary. A pinned popover restores the panel's open state.
    disclosure.open = pinned && (notesOpen.get(document) ?? false);
    disclosure.appendChild(el('summary', '', NOTES_SUMMARY));
    const list = el('ul', 'projectspendratelist');
    for (const line of notes) {
      list.appendChild(el('li', '', line));
    }
    disclosure.appendChild(list);
    pop.appendChild(disclosure);
  };
  // The cost form: warnings, the split bar, the tab strip, and each tab's panel. A panel holds the
  // Main agent and Delegated sections and the "Included above" footnote on one grid, so dollars,
  // bars and percents line up across them. Only the selected tab's panel shows. A hover opens on
  // the first tab, and choosing a tab or the View more expander in a hover pins the popover.
  const drawCost = (cost: CostDetailView) => {
    for (const warning of cost.warnings) {
      const line = el('p', 'line chippopwarning');
      const sign = el('span', 'statwarningsign', '\u26A0\uFE0E');
      sign.setAttribute('aria-hidden', 'true');
      line.append(sign, warning.text);
      if (warning.quiet) line.append(el('span', 'chippopscale', ` \u00B7 ${warning.quiet}`));
      if (warning.title) line.title = warning.title;
      pop.appendChild(line);
    }
    if (cost.split) {
      // Each side names its section's role, so the bar and the headings share their words.
      const side = (label: string, percent: string, right: boolean) => {
        const node = el('span', right ? 'splitside right' : 'splitside');
        node.append(...inlineText([el('span', '', label), el('span', 'chippopvalue', percent)]));
        return node;
      };
      const split = el('div', 'split');
      const bar = el('div', 'sbbar context-meter splitbar');
      bar.setAttribute('aria-hidden', 'true');
      const main = el('i', 'main');
      main.style.width = `${cost.split.mainShare * 100}%`;
      const delegated = el('i', 'delegated');
      delegated.style.width = `${(1 - cost.split.mainShare) * 100}%`;
      bar.append(main, delegated);
      split.append(
        ...inlineText([
          side(cost.sections[0]?.label ?? '', cost.split.main, false),
          bar,
          side(cost.sections[1]?.label ?? '', cost.split.delegated, true),
        ]),
      );
      pop.appendChild(split);
    }
    const buttons: HTMLButtonElement[] = [];
    const panels: HTMLElement[] = [];
    const select = (at: number, focus: boolean) => {
      if (focus && !pinned && anchor) pin(anchor);
      costTab = cost.tabs[at]?.name ?? '';
      buttons.forEach((button, index) => {
        button.setAttribute('aria-selected', String(index === at));
        button.tabIndex = index === at ? 0 : -1;
      });
      panels.forEach((panel, index) => {
        panel.hidden = index !== at;
      });
      // A chosen tab changes the breakdown and the popover's height, so the figure's description
      // follows the shown panel and the popover is placed again, as a disclosure toggle does.
      if (focus && anchor && !pop.hidden) {
        if (breakdownIds.length) {
          describeBreakdown();
          anchor.setAttribute('aria-describedby', breakdownIds.join(' '));
        }
        place(anchor);
      }
      if (focus) buttons[at]?.focus();
    };
    const tabbed = cost.tabs.length > 1;
    if (tabbed) {
      const strip = el('div', 'casktabs poptabs');
      strip.setAttribute('role', 'tablist');
      strip.setAttribute('aria-label', 'Cost breakdown');
      cost.tabs.forEach((tab, at) => {
        const button = el('button', 'casktab');
        button.type = 'button';
        button.id = `${pop.id}costtab-${at}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `${pop.id}costpanel-${at}`);
        button.append(el('span', 'casktabname', tab.name));
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          select(at, true);
        });
        buttons.push(button);
        strip.append(button);
      });
      // Arrow keys, Home and End move between tabs. Every other key reaches the popover's own handlers.
      strip.addEventListener('keydown', (event) => {
        const at = buttons.indexOf(event.target as HTMLButtonElement);
        const last = buttons.length - 1;
        const next =
          at < 0
            ? -1
            : event.key === 'ArrowRight'
              ? (at + 1) % buttons.length
              : event.key === 'ArrowLeft'
                ? (at + last) % buttons.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? last
                    : -1;
        if (next < 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        select(next, true);
      });
      pop.appendChild(strip);
    }
    const costRow = (row: CostRowView, counted: boolean) => {
      const item = el('li', 'costrow');
      item.title = row.title;
      const bar = el('div', 'sbbar context-meter');
      bar.setAttribute('aria-hidden', 'true');
      const fill = el('i');
      fill.style.width = `${row.share * 100}%`;
      bar.append(fill);
      // Name, agent count, dollars and percent on one line, and the bar under them.
      item.append(
        ...inlineText([
          el('span', 'context-category-label', row.label),
          ...(counted ? [el('span', 'costcount chippopscale', row.count ?? '')] : []),
          el('span', 'chippopvalue dollars', row.value),
          el('span', 'chippopscale pct', row.percent),
          bar,
        ]),
      );
      return item;
    };
    cost.tabs.forEach((tab, at) => {
      // A count column shows only on a tab with a counted row, so a tab without one keeps its columns close.
      const counted = tab.parts.some((part) => part.rows.some((row) => row.count));
      const panel = el('div', counted ? 'costgrid' : 'costgrid nocount');
      if (tabbed) {
        panel.id = `${pop.id}costpanel-${at}`;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', `${pop.id}costtab-${at}`);
      }
      cost.sections.forEach((section, index) => {
        const part = tab.parts[index] ?? { rows: [] };
        const list = el('ul', 'context-categories costrows costsection');
        list.setAttribute('role', 'list');
        const head = el('li', 'costrow costhead');
        head.title = section.title;
        const role = el('span', 'costrole');
        role.append(
          ...inlineText([
            el('span', '', section.label),
            ...(section.detail ? [el('span', 'splitmodel', section.detail)] : []),
          ]),
        );
        head.append(
          ...inlineText([role, ...(section.value ? [el('span', 'chippopvalue dollars', section.value)] : [])]),
        );
        list.append(head);
        if (section.facts) {
          const facts = el('li', 'costfacts chippopscale');
          facts.title = section.facts.title;
          // One span holds the fragments, so the row's grid places the line as one cell.
          const text = el('span');
          const warning = section.facts.warning;
          section.facts.parts.forEach((part, at) => {
            if (at) text.append(' \u00B7 ');
            if (at !== warning) {
              text.append(part);
              return;
            }
            // The sign is drawn by CSS, which screen readers skip, so hidden words carry the warning.
            const low = el('span', 'chippopcachehit is-warning', part);
            low.title = LOW_CACHE_WARNING;
            low.append(el('span', 'sr-only', `, warning: ${LOW_CACHE_WARNING}`));
            text.append(low);
          });
          facts.append(text);
          list.append(facts);
        }
        const rows = part.rows.map((row) => costRow(row, counted));
        list.append(...rows);
        if (!rows.length && part.empty) list.append(el('li', 'costempty chippopscale', part.empty));
        const more = part.more;
        if (more) {
          const folded = rows.slice(more.shown);
          const item = el('li', 'costmore');
          const disclosure = el('details', 'projectspendpricing');
          const summary = el('summary');
          // The open state outlives a redraw, so a live update keeps the reader's choice.
          const show = () => {
            disclosure.open = costMore;
            summary.textContent = costMore ? more.close : more.open;
            for (const row of folded) row.hidden = !costMore;
          };
          summary.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            costMore = !costMore;
            if (!pinned && anchor) pin(anchor);
            show();
            if (anchor && !pop.hidden) place(anchor);
          });
          disclosure.append(summary);
          item.append(disclosure);
          list.append(item);
          show();
        }
        panel.append(list);
      });
      if (cost.included.length) {
        const box = el('div', 'included');
        box.append(el('p', 'context-included chippopscale includedhead', 'Included above'));
        const list = el('ul', 'includedrows');
        list.setAttribute('role', 'list');
        for (const fact of cost.included) {
          const item = el('li');
          if (fact.title) item.title = fact.title;
          item.append(...inlineText([el('span', '', fact.label), el('span', 'dollars', fact.value)]));
          list.append(item);
        }
        box.append(list);
        panel.append(box);
      }
      panels.push(panel);
      pop.appendChild(panel);
    });
    select(
      Math.max(
        0,
        cost.tabs.findIndex((tab) => tab.name === costTab),
      ),
      false,
    );
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
      const messages = pop.querySelector<HTMLDetailsElement>('.context-messages');
      if (messages) messages.open = contextMessagesOpen;
      return;
    }
    // Other drawings become focus targets when keyboard navigation needs the box itself.
    pop.removeAttribute('tabindex');
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
    breakdownIds = [];
    // Declared actions or notes select the dialog role. Other lists use the tooltip role.
    const dialog = withActions || isDialogList(listValue);
    pop.setAttribute('role', dialog ? 'dialog' : 'tooltip');
    if (dialog && listValue?.heading) {
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
      pop.removeAttribute('aria-labelledby');
    } else if (dialog && anchor) {
      // A dialog without a heading takes its figure's name.
      pop.removeAttribute('aria-label');
      pop.setAttribute('aria-labelledby', figureNameId(anchor));
    } else {
      pop.removeAttribute('aria-label');
      pop.removeAttribute('aria-labelledby');
    }
    // Footer lines describe the dialog through aria-describedby, separately from its accessible name.
    const footIds =
      dialog && listValue?.footer?.length
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
    if (listValue && !listValue.nameWorktree) {
      if (listValue.heading) {
        pop.appendChild(detailHead(listValue.heading, 'chippophead'));
      }
      if (listValue.cost) {
        drawCost(listValue.cost);
        (listValue.footer || []).forEach((line, at) => appendFoot(line, at, 'chippopfoot'));
        appendNotes(listValue.notes);
        return;
      }
      // Lead lines wear the name form, so a press or a first line keeps the regular weight.
      for (const line of listValue.lead ?? []) {
        const row = el('div', 'chippopline chippopname');
        if (typeof line === 'string') row.textContent = line;
        else if (!('text' in line)) row.appendChild(relative(line));
        else if (withActions && line.action) row.appendChild(pressLine(line.text, line.action));
        else row.textContent = line.text;
        pop.appendChild(row);
      }
      if (listValue.rows && options.renderRows) {
        const host = el('div', 'chippoprows');
        pop.appendChild(host);
        options.renderRows(host, listValue.rows);
        rowsHost = host;
        (listValue.footer || []).forEach((line, at) => appendFoot(line, at, 'chippopfoot'));
        appendNotes(listValue.notes);
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
          if (entry.group) {
            item.classList.add('is-group');
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
      appendNotes(listValue.notes);
      return;
    }
    // The first line of a name anchor's detail is the name. It draws as the name hint draws it.
    const named = anchor?.dataset.hintKind === 'name';
    (detail || '').split(/\r?\n/).forEach((line, at) => {
      if (named && at === 0 && line) {
        const row = el('div', 'chippopline chippopname');
        appendNameText(document, row, line);
        pop.appendChild(row);
        return;
      }
      pop.appendChild(el('div', line ? 'chippopline' : 'chippopline gap', line || ' '));
    });
    const worktree = listValue?.nameWorktree;
    if (worktree) {
      const row = el('div', 'chippopline sessionworktree');
      row.appendChild(el('span', 'sessionworktreelabel', worktree.label));
      row.appendChild(document.createTextNode(' '));
      const link = el('a', 'sessionworktreelink');
      link.href = worktree.path;
      link.setAttribute('aria-label', `Open worktree folder ${worktree.name}`);
      appendNameText(document, link, worktree.name);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        worktree.open();
      });
      row.appendChild(link);
      const destination = el('div', 'sessionworktreedestination');
      appendNameText(document, destination, worktree.path);
      row.appendChild(destination);
      pop.appendChild(row);
    }
  };
  // Ignore focus departure during redraws. Removing focused rows does not represent reader navigation.
  let redrawing = false;
  const draw = (value: ResolvedDetailValue, withActions: boolean) => {
    const measurement = pop.querySelector<HTMLDetailsElement>('.context-measurement');
    if (measurement && drawnPrint !== null) contextMeasurementOpen = measurement.open;
    const messages = pop.querySelector<HTMLDetailsElement>('.context-messages');
    if (messages && drawnPrint !== null) contextMessagesOpen = messages.open;
    const notes = pop.querySelector<HTMLDetailsElement>('.chippopnotes');
    // Only a pinned drawing holds the reader's choice. A hover drawing is always closed.
    if (notes && drawnPrint !== null && pop.classList.contains('pinned')) notesOpen.set(document, notes.open);
    const focused = [
      '.sessionworktreelink',
      '.poptabs [tabindex="0"]',
      '.context-bound button',
      '.context-messages summary',
      '.context-measurement summary',
      '.chippopnotes summary',
      '.costmore summary',
    ].find((selector) => pop.querySelector(selector) === document.activeElement);
    redrawing = true;
    try {
      drawInto(value, withActions);
      if (focused) {
        const target =
          pop.querySelector<HTMLElement>(focused) ?? pop.querySelector<HTMLElement>('.context-bound button') ?? pop;
        if (target === pop) pop.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
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
  // The cost figure of the session heading or a turn card. Its popover reaches the panel's edge on
  // the side of the figure with more room, so "Included above" shows without a scroll on a tall
  // panel. The cap never drops below the stylesheet's min(70vh, 520px), which every other figure
  // popover keeps. A nested popover and the composer's next-turn detail keep their own bounds.
  const costFigure = (node: HTMLElement) =>
    !options.nested && node.dataset.metric === 'cost' && !node.closest('.cnextturn');
  const place = (node: HTMLElement) => {
    const bottom = view.innerHeight - FLOAT_EDGE;
    if (costFigure(node)) {
      const rect = node.getBoundingClientRect();
      const room = Math.max(bottom - rect.bottom - FLOAT_GAP, rect.top - FLOAT_GAP - FLOAT_EDGE);
      pop.style.maxHeight = `${Math.max(room, Math.min(0.7 * view.innerHeight, 520))}px`;
    } else if (!node.closest('.cnextturn')) {
      pop.style.removeProperty('max-height');
    }
    options.placeFloat(pop, node, bottom);
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
      contextMessagesOpen = false;
      costTab = '';
      costMore = false;
    }
    anchor = node;
    // Draw available actions on hover as well as when pinned.
    const withActions = !!value.detailList?.actions;
    if (value.print !== drawnPrint || withActions !== drawnActions) {
      draw(value, withActions);
    }
    // Dialog anchors expose a disclosure. Read-only anchors expose a description.
    // A figure with notes does both, and its description names the visible breakdown alone.
    if (isDialogList(value.detailList)) {
      node.setAttribute('aria-controls', pop.id);
      node.setAttribute('aria-expanded', 'true');
    }
    if (value.detailList?.notes?.length && breakdownIds.length) {
      node.setAttribute('aria-describedby', breakdownIds.join(' '));
    } else if (!value.detailList?.actions) {
      node.setAttribute('aria-describedby', pop.id);
    }
    pop.hidden = false;
    place(node);
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
    costTab = '';
    costMore = false;
    focusBack = null;
    drawnPrint = null;
    drawnActions = false;
    contextMeasurementOpen = false;
    contextMessagesOpen = false;
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
    // Pinning a hover drawing restores the notes open state without a redraw.
    const notes = pop.querySelector<HTMLDetailsElement>('.chippopnotes');
    if (notes) notes.open = notesOpen.get(document) ?? false;
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
    // A pin from inside the popover, such as a press on a cost tab, returns focus to the anchor.
    focusBack = options.actionAnchor
      ? node
      : options.nested || !(active instanceof HTMLElement)
        ? null
        : pop.contains(active)
          ? node
          : active;
    pinned = true;
    show(node);
    markPinned(node);
    options.onPin?.(node);
  };
  const mount = (node: HTMLElement, ownStop = false, pressOnly = false) => {
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
    // A pinned drawing taller than the box with neither enters the box itself, which the keys then scroll.
    const keydown = (event: KeyboardEvent) => {
      // Record rows can contain controls without declaring actions. Inspect the drawn controls.
      if ((!pinned && !options.actionAnchor) || anchor !== node) {
        return;
      }
      if (event.key !== 'ArrowDown' && (event.key !== 'Tab' || event.shiftKey)) {
        return;
      }
      const stop = event.key === 'Tab' ? tabStops()[0] : actionButtons()[0];
      const scrolls = pinned && !tabStops().length && pop.scrollHeight > pop.clientHeight;
      const first = stop ?? (scrolls ? pop : null);
      if (!first) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (first === pop) pop.tabIndex = -1;
      first.focus();
    };
    node.addEventListener('keydown', keydown);
    if (!pressOnly) {
      node.addEventListener('pointerenter', enter);
      node.addEventListener('pointerleave', leave);
      node.addEventListener('focus', focus);
    }
    node.addEventListener('pointercancel', away);
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
    if (typeof detailList !== 'function' && isDialogList(detailList)) {
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
        if (options.actionAnchor) place(node);
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
  const connect: StatDetailRenderer['connect'] = (node, detail, detailList, ownStop, pressOnly) => {
    mount(node, ownStop, pressOnly);
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
      const disclosure = event.target;
      if (!(disclosure instanceof HTMLDetailsElement)) return;
      if (!anchor || pop.hidden) return;
      if (disclosure.matches('.chippopnotes')) notesOpen.set(document, disclosure.open);
      else if (disclosure.matches('.context-measurement')) contextMeasurementOpen = disclosure.open;
      else if (disclosure.matches('.context-messages')) contextMessagesOpen = disclosure.open;
      else return;
      if (anchor && !pop.hidden) place(anchor);
    },
    true,
  );
  // A resize changes the room beside the cost figure, so an open cost popover takes its cap again.
  const onResize = () => {
    if (anchor && !pop.hidden && costFigure(anchor)) place(anchor);
  };
  if (options.events.window) options.events.window('resize', onResize);
  else view.addEventListener('resize', onResize);
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
