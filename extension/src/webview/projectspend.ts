import { Fragment, h, render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import {
  projectSpendAgentName,
  projectSpendCategory,
  projectSpendDate,
  projectSpendFace,
  projectSpendFaceName,
  projectSpendIndexingWord,
  projectSpendRateLines,
  projectSpendWindow,
  projectSpendWordMark,
  projectSpendWordWake,
  type ProjectSpend,
  type ProjectSpendCategory,
  type ProjectSpendWindow,
} from '../view/projectspend.ts';
import { formatCompactRelative } from '../view/time.ts';
import type { Clock } from './clock.ts';

export const PROJECT_SPEND_SHORT_LABEL = 480;

interface ProjectSpendEvents {
  document(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

interface ProjectSpendOptions {
  document: Document;
  clock: Pick<Clock, 'subscribe'>;
  railMount: HTMLElement;
  events: ProjectSpendEvents;
  twist: string;
  selectionWithin(node: HTMLElement | null): boolean;
  // The limits keep the rail dialog in the viewport below its button.
  placeFloat(popover: HTMLElement, anchor: DOMRect, bottomLimit?: number, topLimit?: number): void;
  fallbackFocus(): HTMLElement | null;
}

interface ProjectSpendSnapshot {
  spend: ProjectSpend | null;
  open: boolean;
  period: string;
  pricingOpen: boolean;
  place: ProjectSpendPlace;
  railVisible: boolean;
  short: boolean;
  indexingWord: string;
  age: string;
  twist: string;
}

type ProjectSpendPlace = 'rail' | 'compact';
type Listener = () => void;

export interface ProjectSpendRenderer {
  update(spend: ProjectSpend | null | undefined, preserveSelection?: boolean): void;
  releaseSelection(): void;
  focus(): void;
  setRailVisible(visible: boolean): void;
  place(): void;
  tick(now?: number): void;
  snapshot(): ProjectSpendSnapshot;
  subscribe(listener: Listener): () => void;
  setFace(place: ProjectSpendPlace, node: HTMLElement | null): void;
  setDialog(node: HTMLElement | null): void;
  toggle(place: ProjectSpendPlace): void;
  choosePeriod(period: string): void;
  setPricingOpen(open: boolean): void;
  focusAfterFaceRender(place: ProjectSpendPlace, button: HTMLButtonElement | null): void;
  finishDialogRender(dialog: HTMLElement | null): void;
}

function selectedWindow(snapshot: ProjectSpendSnapshot): ProjectSpendWindow | null {
  return snapshot.spend ? projectSpendWindow(snapshot.spend.windows, snapshot.period) : null;
}

function categoryWindows(category: ProjectSpendCategory | null): readonly ProjectSpendWindow[] {
  return Array.isArray(category?.windows) ? category.windows : [];
}

function ProjectSpendFaceView({
  owner,
  place,
  only = false,
}: {
  owner: ProjectSpendRenderer;
  place: ProjectSpendPlace;
  only?: boolean;
}): ComponentChildren {
  const [, redraw] = useState(0);
  useLayoutEffect(() => owner.subscribe(() => redraw((revision) => revision + 1)), [owner]);
  const snapshot = owner.snapshot();
  const window = selectedWindow(snapshot);
  const face = snapshot.spend && window ? projectSpendFace(snapshot.spend, window, place, snapshot.short) : null;
  let button: HTMLButtonElement | null = null;
  useLayoutEffect(() => owner.focusAfterFaceRender(place, button));
  return h(
    'div',
    {
      class: `projectspendhost projectspend${place}host${place === 'compact' && only ? ' projectspendonly' : ''}`,
      hidden: !face,
      ref: (node: HTMLElement | null) => owner.setFace(place, node),
    },
    face && snapshot.spend && window
      ? h(
          'button',
          {
            class: `projectspendbutton projectspend${place}`,
            ref: (node: HTMLButtonElement | null) => {
              button = node;
            },
            'aria-expanded': String(snapshot.open),
            'aria-controls': 'projectspendpop',
            'aria-haspopup': 'dialog',
            'aria-label': projectSpendFaceName(snapshot.spend, window, face, snapshot.open),
            onClick: () => owner.toggle(place),
          },
          [
            h('span', { class: 'projectspendname' }, face.label),
            h('span', { class: `projectspendamount${face.quiet ? ' quiet' : ''}` }, [
              face.value,
              face.when ? h(Fragment, {}, [' ', h('span', { class: 'projectspendwhen' }, face.when)]) : null,
            ]),
            h('span', { class: 'projectspendtwist' }, snapshot.twist),
          ],
        )
      : null,
  );
}

export function ProjectSpendCompactFace({
  owner,
  only,
}: {
  owner: ProjectSpendRenderer;
  only: boolean;
}): ComponentChildren {
  return h(ProjectSpendFaceView, { owner, place: 'compact', only });
}

function SpendCell({ value, selected }: { value: ProjectSpendWindow | undefined; selected: boolean }) {
  const lower = value?.status === 'atLeast';
  const unknown = value?.status === 'unknown';
  const text = lower ? value?.display.replace(/^At least /, '') : unknown ? 'Unknown' : value?.display;
  return h(
    'td',
    {
      class: `projectspendcell${selected ? ' selected' : ''}${lower ? ' lower' : ''}`,
      'aria-label': lower || unknown ? value?.display : undefined,
      title: lower || unknown ? value?.display : undefined,
    },
    text,
  );
}

function SpendRow({
  name,
  windows,
  columns,
  period,
  total = false,
}: {
  name: string;
  windows: readonly ProjectSpendWindow[];
  columns: readonly ProjectSpendWindow[];
  period: string;
  total?: boolean;
}) {
  if (!windows.length) {
    return null;
  }
  return h('tr', { class: total ? 'projectspendtotal' : undefined }, [
    h('th', { scope: 'row' }, name),
    ...columns.map((column) =>
      h(SpendCell, {
        key: column.id,
        value: windows.find((value) => value.id === column.id),
        selected: column.id === period,
      }),
    ),
  ]);
}

function PricingDetails({
  owner,
  spend,
  omitted,
}: {
  owner: ProjectSpendRenderer;
  spend: ProjectSpend;
  omitted: ProjectSpendCategory[];
}) {
  const sources = Array.isArray(spend.rateSources) ? spend.rateSources : [];
  if (!sources.length && !omitted.length) {
    return null;
  }
  const lines = projectSpendRateLines(sources);
  const body: ComponentChildren[] = [];
  if (sources.some((source) => source.provenance !== 'reported')) {
    body.push(
      h(
        'p',
        { class: 'projectspendrate', key: 'caveat' },
        'These amounts price the usage at API rates. A subscription plan charges differently.',
      ),
    );
  }
  if (omitted.length) {
    const named = omitted.map((category) => projectSpendAgentName(category.label));
    body.push(
      h(
        'p',
        { class: 'projectspendrate', key: 'omitted' },
        `Some ${named.join(' and ')} usage has no rate. The totals leave it out.`,
      ),
    );
  }
  if (lines.length === 1) {
    body.push(h('p', { class: 'projectspendrate', key: 'rate' }, `Rate: ${lines[0]}.`));
  } else if (lines.length) {
    body.push(
      h('p', { class: 'projectspendrate', key: 'rates-head' }, 'Rates used, in the order the panel applies them:'),
    );
    body.push(
      h(
        'ul',
        { class: 'projectspendratelist', key: 'rates' },
        lines.map((line) => h('li', { key: line }, line)),
      ),
    );
  }
  return h(
    'details',
    {
      class: 'projectspendpricing',
      open: owner.snapshot().pricingOpen,
      onToggle: (event: Event) => owner.setPricingOpen((event.currentTarget as HTMLDetailsElement).open),
    },
    [h('summary', { 'data-control': 'projectspend:pricing' }, 'Pricing details'), ...body],
  );
}

function ProjectSpendDialog({ owner }: { owner: ProjectSpendRenderer }): ComponentChildren {
  const [, redraw] = useState(0);
  useLayoutEffect(() => owner.subscribe(() => redraw((revision) => revision + 1)), [owner]);
  const snapshot = owner.snapshot();
  const spend = snapshot.spend;
  const windows = Array.isArray(spend?.windows) ? spend.windows : [];
  const claude = spend ? projectSpendCategory(spend, 'claude') : null;
  const codex = spend ? projectSpendCategory(spend, 'codex') : null;
  const categories = [claude, codex].filter((category): category is ProjectSpendCategory => !!category);
  const omitted = categories.filter((category) =>
    categoryWindows(category).some(
      (period) => !!period.unpricedRequests && windows.some((column) => column.id === period.id),
    ),
  );
  const bounded = categories
    .concat(spend ? [{ id: 'total', label: 'Total', windows }] : [])
    .some((category) => categoryWindows(category).some((period) => period.status === 'atLeast'));
  const word = snapshot.indexingWord;
  const children: ComponentChildren[] = [];
  if (spend) {
    children.push(
      h('div', { class: 'projectspendpophead', key: 'head' }, [
        h('div', { class: 'projectspendpoptitle' }, spend.name),
      ]),
    );
    if (spend.calculating) {
      children.push(
        h('p', { class: 'projectspendcalculating', key: 'calculating' }, 'Calculating from local records…'),
      );
    } else {
      children.push(
        h(
          'table',
          {
            class: 'projectspendgrid',
            key: 'grid',
            'aria-label': 'Project cost by agent and period',
          },
          [
            h(
              'thead',
              {},
              h('tr', {}, [
                h('th', { key: 'corner' }),
                ...windows.map((window) =>
                  h(
                    'th',
                    { scope: 'col', key: window.id },
                    h(
                      'button',
                      {
                        class: 'projectspendperiod',
                        'data-control': `projectspend:period:${window.id}`,
                        'aria-pressed': String(window.id === snapshot.period),
                        onClick: () => owner.choosePeriod(window.id),
                      },
                      window.label,
                    ),
                  ),
                ),
              ]),
            ),
            h('tbody', {}, [
              h(SpendRow, {
                key: 'claude',
                name: projectSpendAgentName(claude?.label),
                windows: categoryWindows(claude),
                columns: windows,
                period: snapshot.period,
              }),
              h(SpendRow, {
                key: 'codex',
                name: projectSpendAgentName(codex?.label),
                windows: categoryWindows(codex),
                columns: windows,
                period: snapshot.period,
              }),
              h(SpendRow, {
                key: 'total',
                name: 'Total',
                windows,
                columns: windows,
                period: snapshot.period,
                total: true,
              }),
            ]),
          ],
        ),
      );
      if (bounded) {
        children.push(h('p', { class: 'projectspendrate', key: 'bounded' }, 'Dotted figures are lower bounds.'));
      }
      const meta: ComponentChildren[] = [];
      if (spend.earliestRecord) {
        meta.push(
          h(
            'span',
            {
              class: 'projectspendcoverage',
              key: 'coverage',
              title: spend.earliestRecord,
            },
            `Records since ${projectSpendDate(spend.earliestRecord)}`,
          ),
        );
      }
      if ((word || spend.lastIndexedAt) && meta.length) {
        meta.push('\u00a0· ');
      }
      if (word) {
        meta.push(h('span', { class: 'projectspendupdating', key: 'status' }, word));
      } else if (spend.lastIndexedAt) {
        const at = spend.lastIndexedAt;
        const age = `Updated ${snapshot.age}`;
        const full = new Date(at).toLocaleString();
        meta.push(
          h(
            'span',
            {
              class: 'projectspendupdated',
              key: 'age',
              'data-project-spend-at': String(at),
              title: full,
              'aria-label': `${age}. ${full}`,
            },
            age,
          ),
        );
      }
      if (meta.length) {
        children.push(h('div', { class: 'projectspendmeta', key: 'meta' }, meta));
      }
      children.push(h(PricingDetails, { owner, spend, omitted, key: 'pricing' }));
    }
  }
  let dialog: HTMLElement | null = null;
  useLayoutEffect(() => owner.finishDialogRender(dialog));
  return h(
    'div',
    {
      id: 'projectspendpop',
      class: 'pop projectspendpop',
      hidden: !snapshot.open || !spend,
      role: 'dialog',
      'aria-label': 'Project cost',
      tabindex: -1,
      'data-control': 'projectspend:dialog',
      ref: (node: HTMLElement | null) => {
        dialog = node;
        owner.setDialog(node);
      },
    },
    children,
  );
}

export function createProjectSpendRenderer(options: ProjectSpendOptions): ProjectSpendRenderer {
  const listeners = new Set<Listener>();
  const faces: Record<ProjectSpendPlace, HTMLElement | null> = { rail: null, compact: null };
  const shortMedia = window.matchMedia(`(max-width: ${PROJECT_SPEND_SHORT_LABEL - 1}px)`);
  const dialogMount = options.document.createElement('div');
  options.document.body.appendChild(dialogMount);
  let dialog: HTMLElement | null = null;
  let latest: ProjectSpend | null = null;
  let drawn: ProjectSpend | null = null;
  let open = false;
  let period = 'today';
  let pricingOpen = false;
  let place: ProjectSpendPlace = 'rail';
  let railVisible = false;
  let short = shortMedia.matches;
  let displayedShort = short;
  let indexingStatus = '';
  let busySince = 0;
  let wordAt = 0;
  let wordShown = false;
  let displayedIndexingWord = '';
  let wordTimer: ReturnType<typeof setTimeout> | null = null;
  let ageText = '';
  let repaintOwed = false;
  let pendingControl: string | null = null;
  let pendingFace: ProjectSpendPlace | null = null;
  let pendingFallback = false;
  let watchedActive: HTMLElement | null = null;
  let watchedControl: string | null = null;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const snapshot = (): ProjectSpendSnapshot => ({
    spend: drawn,
    open,
    period,
    pricingOpen,
    place,
    railVisible,
    short: displayedShort,
    indexingWord: displayedIndexingWord,
    age: ageText,
    twist: options.twist,
  });
  const withinSubject = () =>
    options.selectionWithin(faces.rail) || options.selectionWithin(faces.compact) || options.selectionWithin(dialog);
  const currentFace = (): HTMLElement | null => faces[place] ?? faces[place === 'rail' ? 'compact' : 'rail'];
  const currentButton = (): HTMLButtonElement | null =>
    currentFace()?.querySelector<HTMLButtonElement>('.projectspendbutton') ?? null;
  const dialogControls = (): HTMLElement[] =>
    Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), summary') ?? []).filter(
      (control) => control.tabIndex >= 0 && control.getClientRects().length > 0,
    );
  const scheduleWord = (now: number) => {
    if (wordTimer) {
      clearTimeout(wordTimer);
      wordTimer = null;
    }
    const next = projectSpendWordWake(busySince, wordAt, now);
    if (!next) {
      return;
    }
    wordTimer = setTimeout(() => {
      wordTimer = null;
      const at = Date.now();
      wordShown = projectSpendIndexingWord(!!latest?.indexing, busySince, wordAt, at);
      wordAt = projectSpendWordMark(!!latest?.indexing, wordShown, wordAt, at);
      scheduleWord(at);
      if (withinSubject()) {
        repaintOwed = true;
      } else {
        displayedIndexingWord = wordShown ? indexingStatus : '';
        notify();
      }
    }, next - now);
  };
  const acceptTiming = (spend: ProjectSpend | null, now: number) => {
    const indexing = !!spend?.indexing;
    if (!indexing) {
      busySince = 0;
    } else if (!busySince) {
      busySince = now;
    }
    if (spend?.indexingStatus) {
      indexingStatus = spend.indexingStatus;
    }
    wordShown = projectSpendIndexingWord(indexing, busySince, wordAt, now);
    wordAt = projectSpendWordMark(indexing, wordShown, wordAt, now);
    scheduleWord(now);
  };
  const acceptVisibleTiming = (now: number) => {
    displayedShort = short;
    displayedIndexingWord = wordShown ? indexingStatus : '';
    const indexedAt = Number(drawn?.lastIndexedAt);
    ageText = drawn?.lastIndexedAt && Number.isFinite(indexedAt) ? formatCompactRelative(indexedAt, now) : '';
  };
  const applyLatest = () => {
    const active = options.document.activeElement as HTMLElement | null;
    const activeControl = dialog?.contains(active) ? (active?.dataset.control ?? null) : null;
    const activeInSubject =
      !!active && (!!dialog?.contains(active) || !!faces.rail?.contains(active) || !!faces.compact?.contains(active));
    watchedActive = activeInSubject ? active : null;
    watchedControl = activeControl;
    drawn = latest;
    const windows = Array.isArray(drawn?.windows) ? drawn.windows : [];
    if (drawn && !windows.some((window) => window.id === period)) {
      period = windows[0]?.id ?? period;
    }
    if (!drawn) {
      open = false;
      if (activeInSubject) {
        pendingFallback = true;
      }
    }
    repaintOwed = false;
    acceptVisibleTiming(Date.now());
    notify();
  };

  const owner: ProjectSpendRenderer = {
    update(spend, preserveSelection = true) {
      latest = spend ?? null;
      acceptTiming(latest, Date.now());
      if (preserveSelection && withinSubject()) {
        repaintOwed = true;
        return;
      }
      applyLatest();
    },
    releaseSelection() {
      if (repaintOwed && !withinSubject()) {
        applyLatest();
      }
    },
    focus() {
      if (!latest) {
        return;
      }
      drawn = latest;
      acceptVisibleTiming(Date.now());
      open = true;
      place = railVisible ? 'rail' : 'compact';
      const windows = Array.isArray(drawn.windows) ? drawn.windows : [];
      if (!windows.some((window) => window.id === period)) {
        period = windows[0]?.id ?? period;
      }
      pendingControl = windows.length ? `projectspend:period:${period}` : 'projectspend:dialog';
      repaintOwed = false;
      notify();
    },
    setRailVisible(visible) {
      if (railVisible === visible) {
        return;
      }
      const active = options.document.activeElement as HTMLElement | null;
      const oldPlace: ProjectSpendPlace = railVisible ? 'rail' : 'compact';
      railVisible = visible;
      const nextPlace: ProjectSpendPlace = visible ? 'rail' : 'compact';
      if (open) {
        place = nextPlace;
      }
      if (active && faces[oldPlace]?.contains(active) && !dialog?.contains(active)) {
        pendingFace = nextPlace;
      }
      notify();
    },
    place() {
      if (!open || !dialog) {
        return;
      }
      const anchor = currentButton();
      if (!anchor) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      // The rail dialog opens below its button when that space fits a control.
      if (currentFace() === faces.rail) {
        const style = getComputedStyle(dialog);
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, summary'));
        const controlHeight = Math.max(
          parseFloat(style.lineHeight) || 0,
          ...controls.map((control) => control.offsetHeight),
        );
        const minimumHeight =
          controlHeight +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth);
        const bottom = window.innerHeight - 6;
        const below = rect.bottom + 6;
        options.placeFloat(dialog, rect, bottom, bottom - below >= minimumHeight ? below : 6);
      } else {
        dialog.style.maxHeight = '';
        options.placeFloat(dialog, rect);
      }
    },
    tick(now = Date.now()) {
      const at = Number(drawn?.lastIndexedAt);
      if (!drawn?.lastIndexedAt || displayedIndexingWord || !Number.isFinite(at)) {
        return;
      }
      const next = formatCompactRelative(at, now);
      if (next === ageText) {
        return;
      }
      if (withinSubject()) {
        repaintOwed = true;
      } else {
        ageText = next;
        notify();
      }
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFace(facePlace, node) {
      if (faces[facePlace] === node) {
        return;
      }
      if (faces[facePlace]) {
        measured?.unobserve(faces[facePlace]);
      }
      faces[facePlace] = node;
      if (node) {
        measured?.observe(node);
      }
    },
    setDialog(node) {
      if (dialog === node) {
        return;
      }
      if (dialog) {
        measured?.unobserve(dialog);
      }
      dialog = node;
      if (node) {
        measured?.observe(node);
      }
    },
    toggle(facePlace) {
      if (open) {
        open = false;
        pendingFace = railVisible ? 'rail' : 'compact';
      } else {
        if (!latest) {
          return;
        }
        drawn = latest;
        acceptVisibleTiming(Date.now());
        place = facePlace;
        open = true;
        const windows = Array.isArray(drawn.windows) ? drawn.windows : [];
        if (!windows.some((window) => window.id === period)) {
          period = windows[0]?.id ?? period;
        }
        pendingControl = windows.length ? `projectspend:period:${period}` : 'projectspend:dialog';
        repaintOwed = false;
      }
      notify();
    },
    choosePeriod(next) {
      period = next;
      notify();
    },
    setPricingOpen(next) {
      if (pricingOpen !== next) {
        pricingOpen = next;
        notify();
      }
    },
    focusAfterFaceRender(facePlace, button) {
      if (pendingFace === facePlace) {
        pendingFace = null;
        (button ?? options.fallbackFocus())?.focus();
      }
    },
    finishDialogRender(node) {
      if (watchedActive) {
        const removed = !watchedActive.isConnected;
        watchedActive = null;
        if (removed && drawn && open && options.document.activeElement === options.document.body) {
          pendingControl = watchedControl?.startsWith('projectspend:period:')
            ? `projectspend:period:${period}`
            : 'projectspend:dialog';
        }
        watchedControl = null;
      }
      if (pendingFallback) {
        pendingFallback = false;
        options.fallbackFocus()?.focus();
        return;
      }
      if (pendingControl && node) {
        const target = Array.from(node.querySelectorAll<HTMLElement>('[data-control]')).find(
          (control) => control.dataset.control === pendingControl,
        );
        pendingControl = null;
        const controls = dialogControls();
        const selected = controls.find((control) => control.getAttribute('aria-pressed') === 'true');
        (target ?? selected ?? controls[0] ?? node).focus();
      }
      owner.place();
    },
  };

  // Font changes resize the face and dialog without resizing the viewport.
  const measured = typeof ResizeObserver === 'function' ? new ResizeObserver(() => owner.place()) : null;
  options.events.window('pagehide', (event) => {
    if (!(event as PageTransitionEvent).persisted) {
      measured?.disconnect();
    }
  });

  shortMedia.addEventListener('change', () => {
    short = shortMedia.matches;
    if (withinSubject()) {
      repaintOwed = true;
    } else {
      displayedShort = short;
      notify();
    }
  });
  options.events.document('selectionchange', () => owner.releaseSelection());
  options.events.document('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (open && key.key === 'Tab' && dialog?.contains(key.target as Node | null)) {
      const controls = dialogControls();
      const edge = key.shiftKey ? controls[0] : controls[controls.length - 1];
      if (key.target === edge || key.target === dialog) {
        open = false;
        notify();
      }
      return;
    }
    if (key.key !== 'Escape' || !open) {
      return;
    }
    key.preventDefault();
    key.stopPropagation();
    owner.toggle(place);
  });
  options.events.document('focusout', (event) => {
    const focus = event as FocusEvent;
    const from = focus.target as Node | null;
    const to = focus.relatedTarget as Node | null;
    if (
      !open ||
      !to ||
      (!dialog?.contains(from) && !currentFace()?.contains(from)) ||
      dialog?.contains(to) ||
      currentFace()?.contains(to)
    ) {
      return;
    }
    open = false;
    notify();
  });
  options.events.document('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    if (!open || dialog?.contains(target) || target?.closest?.('.projectspendbutton')) {
      return;
    }
    open = false;
    notify();
  });
  options.events.window('resize', () => owner.place());
  options.events.window('scroll', () => owner.place(), true);
  options.clock.subscribe((now) => owner.tick(now));

  render(h(ProjectSpendFaceView, { owner, place: 'rail' }), options.railMount);
  render(h(ProjectSpendDialog, { owner }), dialogMount);
  return owner;
}
