import { sendChordKeyshortcut, sendChordSentence } from '../domain/composer-editing.ts';
import { formatCacheSpan } from '../view/time.ts';
import { PROMPT_FLOOR_MIN_EM, clampPromptFloor, promptFloorAfterKey, promptFloorLines } from '../view/composer-size.ts';
import type { AttachmentRenderer } from './attachments.ts';
import type { Clock } from './clock.ts';
import type { CommentRenderer } from './comments.ts';
import type { ComposerControlsRenderer } from './composer-controls.ts';
import { sendWaitsForStaging, type ComposerRenderer } from './composer.ts';
import { actionable, element } from './dom.ts';
import type { ChromeRenderer } from './chrome.ts';
import type {
  ComposerAnnotations,
  ComposerDraftTag,
  ComposerNextTurn,
  ComposerOrigin,
  ComposerView,
  NextTurnFace,
  NextTurnWords,
  PanelToHost,
  PanelUsage,
} from './protocol.ts';
import type { QueueLiveRenderer } from './queue-live.ts';
import type { RailRenderer } from './rail.ts';
import type { RequestRenderer } from './requests.ts';
import type { StatDetailRenderer } from './stat-detail.ts';

interface ComposerPresentationOptions {
  document: Document;
  window: Window;
  list: HTMLElement;
  events: {
    window(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
  initialFloor: number;
  save(): void;
  composer: ComposerRenderer;
  attachments: AttachmentRenderer;
  controls: ComposerControlsRenderer;
  requests: RequestRenderer;
  queueLive: QueueLiveRenderer;
  comments: CommentRenderer;
  statDetails: StatDetailRenderer;
  clock: Clock;
  rail: RailRenderer;
  chrome: ChromeRenderer;
  sendToHost(message: PanelToHost): void;
}

export interface ComposerPresentationOwner {
  update(usage: PanelUsage | null): void;
  measure(): void;
  place(): void;
  cancelResize(): void;
  floor(): number;
  resetFloor(): void;
}

export function mountComposerPresentation(
  document: Document,
  composer: ComposerRenderer,
  controls: ComposerControlsRenderer,
  requests: RequestRenderer,
): void {
  document.body.append(
    composer.element,
    controls.statusBar,
    controls.usagePopover,
    controls.pickPopover,
    composer.slashPopover,
    requests.askAnnouncer,
    composer.walkAnnouncer,
    requests.sendAnnouncer,
  );
}

export function createComposerAction(
  document: Document,
  platform: string,
  composer: ComposerRenderer,
  attachments: AttachmentRenderer,
): (view: ComposerView, current?: HTMLElement) => HTMLElement {
  const line = sendChordSentence(platform);
  const keys = sendChordKeyshortcut(platform);
  return (view, current) => {
    const node = current instanceof HTMLButtonElement ? current : element(document, 'button', 'csend');
    if (!(current instanceof HTMLButtonElement)) {
      node.append(composer.actionIcon(view.box.actionKind));
      actionable(node, null, null, () => {
        composer.send(false);
      });
    }
    node.classList.toggle('stop', view.box.actionKind === 'stop');
    // Read the live prompt text field for the staging decision. The host's `view.draft` does not track each edit.
    const waits = sendWaitsForStaging(view.agent, composer.prompt.value, attachments.isStaging(view.sessionId));
    node.disabled = !view.box.actionEnabled || waits;
    const sends = !waits && view.box.actionKind !== 'stop' && view.box.actionEnabled;
    const actionName = waits ? view.filePendingName : view.box.actionName;
    const spoken = sends ? `${actionName} ${line}` : actionName;
    node.setAttribute('aria-label', spoken);
    if (sends) {
      node.setAttribute('aria-keyshortcuts', keys);
    } else {
      node.removeAttribute('aria-keyshortcuts');
    }
    node.dataset.control = view.box.actionControl;
    node.dataset.hint = view.box.actionLabel;
    node.dataset.hintDetail = spoken;
    return node;
  };
}

export function createComposerPresentation(options: ComposerPresentationOptions): ComposerPresentationOwner {
  const { document, composer, attachments, controls, requests, queueLive, comments, statDetails, clock, rail, chrome } =
    options;
  const composerBox = composer.element;
  const statusBar = controls.statusBar;
  const prompt = composer.prompt;
  const sash = composerBox.querySelector<HTMLElement>('#footsash')!;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) =>
    element(document, tag, className, text);
  let slotsPrint: string | null = null;
  let lastBar: PanelUsage['bar'] = null;
  let lastMenus: PanelUsage['menus'] = {};
  let nextTurnFigure: ComposerNextTurn | null = null;
  let floorEm = clampPromptFloor(options.initialFloor, Number.POSITIVE_INFINITY);
  let drawnFloorEm = PROMPT_FLOOR_MIN_EM;
  let ceilingEm = PROMPT_FLOOR_MIN_EM;
  let resizePointerId: number | null = null;
  let cancelResize: (() => void) | null = null;

  const chipsNode = (annotations: ComposerAnnotations): HTMLElement => {
    const node = el('div', 'cchips');
    const chip = el('span', 'cchip', annotations.label);
    chip.title = annotations.detail;
    chip.setAttribute('aria-label', annotations.name);
    node.append(chip);
    return node;
  };
  const originNode = (origin: ComposerOrigin): HTMLElement => {
    const node = el('button', 'corigin', origin.label);
    actionable(node, origin.name, `origin:${origin.turnKey}`, () => {
      options.sendToHost({ type: 'showSession', session: origin.sessionId });
    });
    return node;
  };
  const draftTagNode = (tag: ComposerDraftTag): HTMLElement => {
    const node = el('div', 'cdrafttag');
    node.title = tag.detail;
    node.append(el('span', 'cdraftword', tag.word));
    return node;
  };
  const stateAt = (figure: ComposerNextTurn | null, now: number): 'range' | 'warm' | 'cold' => {
    if (!figure) {
      return 'range';
    }
    if (figure.afterCompaction && figure.cold) {
      return 'cold';
    }
    if (figure.coldAt === null || !figure.warm || !figure.cold) {
      return 'cold';
    }
    return now < figure.coldAt ? 'warm' : 'cold';
  };
  const facesOf = (figure: ComposerNextTurn): NextTurnFace[] =>
    [figure.warm, figure.cold].filter((face): face is NextTurnFace => face !== null);
  const faceAt = (figure: ComposerNextTurn, now: number): NextTurnFace => {
    const face = stateAt(figure, now) === 'warm' ? figure.warm : figure.cold;
    if (!face) {
      throw new Error('The next-turn price has no visible face.');
    }
    return face;
  };
  const nearAt = (figure: ComposerNextTurn, now: number): boolean =>
    figure.coldAt !== null && Math.abs(figure.coldAt - now) <= figure.nearBoundary;
  const spanText = (words: NextTurnWords, figure: ComposerNextTurn, now: number): string => {
    if (typeof words === 'string' || figure.coldAt === null) {
      return '';
    }
    if (nearAt(figure, now)) {
      return words.near.value;
    }
    return formatCacheSpan(words.count === 'left' ? figure.coldAt - now : now - figure.coldAt);
  };
  const trailText = (words: NextTurnWords, figure: ComposerNextTurn, now: number): string => {
    if (typeof words === 'string') {
      return words;
    }
    if (nearAt(figure, now)) {
      return words.near.lead + words.near.value + words.near.trail;
    }
    return words.lead + spanText(words, figure, now) + words.trail;
  };
  const faceName = (face: NextTurnFace, figure: ComposerNextTurn, now: number): string => {
    const sentence = face.lead + face.price + trailText(face.trail, figure, now);
    return sentence + (sentence.endsWith('.') ? '' : '.') + ` ${figure.disclosure}.`;
  };
  const detailList = () => {
    if (!nextTurnFigure) {
      return null;
    }
    const now = Date.now();
    const face = faceAt(nextTurnFigure, now);
    const words = face.trail;
    const near = nearAt(nextTurnFigure, now);
    const value =
      typeof words === 'string'
        ? words.replace(/^,\s*/, '')
        : {
            lead: (near ? words.near.lead : words.lead).replace(/^,\s*/, ''),
            at: nextTurnFigure.coldAt!,
            title: face.statusTitle ?? undefined,
            trail: near ? words.near.trail : words.trail,
            remaining: true,
            underline: true,
          };
    return {
      layout: face.layout,
      heading: {
        label: face.lead + face.price + ',',
        value,
        mutedValue: true,
        valueTitle: typeof words === 'string' ? face.statusTitle : null,
      },
      entries: face.entries,
      footer: face.footer,
    };
  };
  const wordsNode = (text: string, title: string | null = null): HTMLElement => {
    const node = el('span', 'cnextturnwords', text);
    node.setAttribute('aria-hidden', 'true');
    if (title) {
      node.title = title;
    }
    return node;
  };
  const trailNode = (face: NextTurnFace, figure: ComposerNextTurn, now: number): HTMLElement => {
    const words = face.trail;
    if (typeof words === 'string') {
      return wordsNode(words, face.statusTitle ?? null);
    }
    const near = nearAt(figure, now);
    const node = wordsNode('');
    const lead = el('span', 'cnextturnlead', near ? words.near.lead : words.lead);
    const span = el('span', 'cnextturnspan', spanText(words, figure, now));
    span.dataset.count = words.count;
    if (face.statusTitle) {
      span.title = face.statusTitle;
    }
    node.append(lead, span, el('span', 'cnextturntrail', near ? words.near.trail : words.trail));
    return node;
  };
  const faceNode = (face: NextTurnFace, figure: ComposerNextTurn, now: number): HTMLElement => {
    const line = el('span', 'cnextturnface');
    line.dataset.state = face.state;
    line.append(wordsNode(face.lead));
    const price = el('button', 'cnextturnprice', face.price);
    price.type = 'button';
    price.setAttribute('aria-label', faceName(face, figure, now));
    statDetails.connect(price, null, detailList, true);
    line.append(price, trailNode(face, figure, now));
    return line;
  };
  const writeNextTurn = (node: HTMLElement, figure: ComposerNextTurn, now: number): string => {
    const face = faceAt(figure, now);
    node.dataset.state = face.state;
    for (const one of facesOf(figure)) {
      const line = node.querySelector<HTMLElement>(`.cnextturnface[data-state="${one.state}"]`);
      if (!line) {
        continue;
      }
      line.classList.toggle('is-off', one.state !== face.state);
      if (typeof one.trail !== 'string') {
        const near = nearAt(figure, now);
        const lead = line.querySelector('.cnextturnlead');
        const trail = line.querySelector('.cnextturntrail');
        const nextLead = near ? one.trail.near.lead : one.trail.lead;
        const nextTrail = near ? one.trail.near.trail : one.trail.trail;
        if (lead && lead.textContent !== nextLead) {
          lead.textContent = nextLead;
        }
        if (trail && trail.textContent !== nextTrail) {
          trail.textContent = nextTrail;
        }
      }
      const span = line.querySelector('.cnextturnspan');
      const next = spanText(one.trail, figure, now);
      if (span && span.textContent !== next) {
        span.textContent = next;
      }
      const price = line.querySelector<HTMLElement>('.cnextturnprice');
      const name = faceName(one, figure, now);
      if (price?.getAttribute('aria-label') !== name) {
        price?.setAttribute('aria-label', name);
      }
      if (price && one.state === face.state) {
        price.dataset.control = 'nextturn';
      } else if (price) {
        delete price.dataset.control;
      }
    }
    return face.state;
  };
  const nextTurnNode = (figure: ComposerNextTurn): HTMLElement => {
    const node = el('div', 'cnextturn');
    const now = Date.now();
    for (const face of facesOf(figure)) {
      node.append(faceNode(face, figure, now));
    }
    writeNextTurn(node, figure, now);
    return node;
  };
  const tickNextTurn = (now: number) => {
    const node = composerBox.querySelector<HTMLElement>('.cnextturn');
    if (!node || !nextTurnFigure) {
      return;
    }
    const before = node.dataset.state;
    const shown = node.querySelector('.cnextturnface:not(.is-off) .cnextturnwords:last-child');
    const beforeStatus = shown?.textContent ?? null;
    const state = writeNextTurn(node, nextTurnFigure, now);
    const arrived = node.querySelector<HTMLElement>(`.cnextturnface[data-state="${state}"] .cnextturnprice`);
    if (!arrived) {
      return;
    }
    const status = node.querySelector('.cnextturnface:not(.is-off) .cnextturnwords:last-child');
    if (before === state) {
      if (beforeStatus !== (status?.textContent ?? null)) {
        statDetails.update(arrived, null, detailList);
      }
      return;
    }
    const held = !!document.activeElement && node.contains(document.activeElement);
    statDetails.retarget(node, arrived, null, detailList, true);
    if (held) {
      arrived.focus();
    }
  };
  const promptFontSize = (): number => Number.parseFloat(options.window.getComputedStyle(prompt).fontSize) || 1;
  const promptPaddingEm = (): number => {
    const style = options.window.getComputedStyle(prompt);
    return (Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)) / promptFontSize();
  };
  const automaticFloor = (): number => {
    const style = options.window.getComputedStyle(prompt);
    const height = Number.parseFloat(prompt.style.height) || PROMPT_FLOOR_MIN_EM * promptFontSize();
    const maximum = Number.parseFloat(style.maxHeight);
    return (Number.isFinite(maximum) ? Math.min(height, maximum) : height) / promptFontSize();
  };
  const automaticCeiling = (): number => {
    const viewportLimit = prompt.style.maxHeight;
    if (viewportLimit) {
      prompt.style.maxHeight = '';
    }
    const maximum = Number.parseFloat(options.window.getComputedStyle(prompt).maxHeight);
    if (viewportLimit) {
      prompt.style.maxHeight = viewportLimit;
    }
    return maximum;
  };
  const measuredCeiling = (): number => {
    if (composerBox.hidden) {
      return PROMPT_FLOOR_MIN_EM;
    }
    const composerBounds = composerBox.getBoundingClientRect();
    const promptHeight = prompt.getBoundingClientRect().height;
    const controls = document.querySelector<HTMLElement>('#list > .controls:not([hidden])');
    let headingReserve = Math.max(
      Number.parseFloat(options.window.getComputedStyle(document.body).paddingTop) || 0,
      controls?.getBoundingClientRect().bottom ?? 0,
    );
    for (const heading of document.querySelectorAll<HTMLElement>('#list .sessionsection:not([hidden]) > .sessionrow')) {
      const box = heading.getBoundingClientRect();
      if (box.bottom > headingReserve && box.top <= headingReserve + 2) {
        headingReserve = box.bottom;
      }
    }
    return Math.max(
      PROMPT_FLOOR_MIN_EM,
      (composerBounds.bottom - (composerBounds.height - promptHeight) - headingReserve) / promptFontSize(),
    );
  };
  const drawFloor = (requested: number = floorEm, syncLayout = true): number => {
    const automaticCeilingPx = automaticCeiling();
    const automaticHeight = Number.parseFloat(prompt.style.height) || 0;
    const viewportCeiling = ceilingEm * promptFontSize();
    const maximumStyle =
      viewportCeiling < automaticCeilingPx && automaticHeight > viewportCeiling ? `${ceilingEm}em` : '';
    if (prompt.style.maxHeight !== maximumStyle) {
      prompt.style.maxHeight = maximumStyle;
    }
    const requestedFloor = clampPromptFloor(requested, ceilingEm);
    const next = clampPromptFloor(Math.max(requestedFloor, automaticFloor()), ceilingEm);
    drawnFloorEm = next;
    prompt.style.setProperty('--prompt-floor', `${requestedFloor}em`);
    if (syncLayout) {
      composer.layout();
    }
    const padding = promptPaddingEm();
    const minimum = promptFloorLines(PROMPT_FLOOR_MIN_EM, padding);
    const maximum = promptFloorLines(ceilingEm, padding);
    const current = promptFloorLines(next, padding);
    sash.setAttribute('aria-valuemin', String(minimum));
    sash.setAttribute('aria-valuemax', String(maximum));
    sash.setAttribute('aria-valuenow', String(current));
    sash.setAttribute('aria-valuetext', `${current} lines`);
    return next;
  };
  const chooseFloor = (requested: number): number => {
    floorEm = clampPromptFloor(requested, ceilingEm);
    drawFloor();
    return floorEm;
  };
  const measure = () => {
    const barHeight = statusBar.hidden ? 0 : statusBar.getBoundingClientRect().height;
    ceilingEm = measuredCeiling();
    drawFloor();
    const boxHeight = composerBox.hidden ? 0 : composerBox.getBoundingClientRect().height;
    const bar = `${barHeight}px`;
    const foot = `${barHeight + boxHeight}px`;
    const style = document.body.style;
    if (style.getPropertyValue('--statusbar-height') !== bar) {
      style.setProperty('--statusbar-height', bar);
    }
    if (style.getPropertyValue('--foot-height') !== foot) {
      style.setProperty('--foot-height', foot);
    }
  };
  const place = () => {
    const wide = rail.visible();
    document.body.style.setProperty(
      '--list-left',
      `${wide ? rail.element.getBoundingClientRect().width + rail.sashElement.getBoundingClientRect().width : 0}px`,
    );
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(measure);
    observer.observe(statusBar);
    observer.observe(composerBox);
    observer.observe(options.list);
  }
  sash.addEventListener('pointerdown', (event) => {
    if (
      composerBox.classList.contains('composer-hidden') ||
      !event.isPrimary ||
      event.button !== 0 ||
      resizePointerId !== null
    ) {
      return;
    }
    event.preventDefault();
    const pointerId = event.pointerId;
    resizePointerId = pointerId;
    sash.setPointerCapture(pointerId);
    const fromY = event.clientY;
    const startFloorEm = floorEm;
    const startDrawnFloor = drawnFloorEm;
    let resizeFrame: number | null = null;
    let latestY: number | null = null;
    let finishing = false;
    const apply = (clientY: number) => {
      floorEm = clampPromptFloor(startDrawnFloor + (fromY - clientY) / promptFontSize(), ceilingEm);
      // Apply the requested floor before measuring the ceiling. measure() then calls composer.layout() once for the frame.
      drawFloor(floorEm, false);
      measure();
    };
    const paint = () => {
      resizeFrame = null;
      if (resizePointerId !== pointerId) {
        return;
      }
      const clientY = latestY;
      latestY = null;
      if (clientY !== null) {
        apply(clientY);
      }
      if (!finishing) {
        return;
      }
      resizePointerId = null;
      cancelResize = null;
      options.save();
    };
    const schedule = (clientY: number) => {
      latestY = clientY;
      if (resizeFrame === null) {
        resizeFrame = options.window.requestAnimationFrame(paint);
      }
    };
    const moved = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) {
        return;
      }
      schedule(move.clientY);
    };
    const done = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) {
        return;
      }
      sash.removeEventListener('pointermove', moved);
      sash.removeEventListener('pointerup', done);
      sash.removeEventListener('pointercancel', done);
      finishing = true;
      if (end.type === 'pointerup') {
        schedule(end.clientY);
      } else if (latestY !== null) {
        schedule(latestY);
      } else {
        paint();
      }
    };
    cancelResize = () => {
      if (resizePointerId !== pointerId) {
        return;
      }
      sash.removeEventListener('pointermove', moved);
      sash.removeEventListener('pointerup', done);
      sash.removeEventListener('pointercancel', done);
      if (resizeFrame !== null) {
        options.window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = null;
      latestY = null;
      resizePointerId = null;
      floorEm = startFloorEm;
      cancelResize = null;
    };
    sash.addEventListener('pointermove', moved);
    sash.addEventListener('pointerup', done);
    sash.addEventListener('pointercancel', done);
  });
  sash.addEventListener('keydown', (event) => {
    if (composerBox.classList.contains('composer-hidden')) {
      return;
    }
    const next = promptFloorAfterKey(event.key, drawnFloorEm, ceilingEm);
    if (next === null) {
      return;
    }
    event.preventDefault();
    chooseFloor(next);
    measure();
    options.save();
  });
  prompt.addEventListener('input', measure);
  // During file staging, edits can switch a Codex draft to `/rename`, which bypasses staging.
  // Redraw the button locally because host updates do not arrive on every keystroke.
  const redrawWhileStaging = () => {
    const view = composer.view();
    if (view && attachments.isStaging(view.sessionId)) {
      controls.update(lastBar, view, lastMenus);
    }
  };
  prompt.addEventListener('input', redrawWhileStaging);
  // Draft setters do not dispatch input events. Subscribe to them so programmatic edits also refresh the staging decision.
  composer.onDraftSet(redrawWhileStaging);
  options.events.window('resize', measure);
  options.events.window('scroll', measure, { passive: true });
  clock.subscribe(tickNextTurn);
  measure();

  return {
    measure,
    place,
    cancelResize() {
      cancelResize?.();
    },
    floor: () => floorEm,
    resetFloor() {
      floorEm = PROMPT_FLOOR_MIN_EM;
      measure();
    },
    update(usage) {
      const launcher = usage?.launcher ?? null;
      chrome.updateLauncher(launcher);
      rail.updateLauncher(launcher);
      const bar = usage?.bar ?? null;
      const view = usage?.composer ?? null;
      const menus = usage?.menus ?? {};
      lastBar = bar;
      lastMenus = menus;
      composer.update(view);
      requests.update(view);
      controls.update(bar, view, menus);
      const shape = view
        ? {
            ...view,
            draft: '',
            history: [],
            commands: [],
            asks: [],
            picks: [],
            context: null,
            sendOverAsk: '',
            box: null,
            filePendingName: '',
          }
        : view;
      attachments.update(view);
      const staging = view && attachments.isStaging(view.sessionId) ? attachments.pendingLabel(view.sessionId) : '';
      const print = JSON.stringify([shape, staging]);
      if (print === slotsPrint) {
        measure();
        composer.drawSlash(true);
        queueLive.update(view);
        return;
      }
      slotsPrint = print;
      const active = document.activeElement as HTMLElement | null;
      const inFoot = active && (composerBox.contains(active) || controls.contains(active));
      const held = inFoot ? active.dataset.control : null;
      for (const [name, slot] of Object.entries(composer.slots)) {
        if (!['asks', 'picks', 'files', 'notice'].includes(name)) {
          slot.replaceChildren();
        }
      }
      if (view) {
        if (view.annotations) {
          composer.slots.annotations.append(chipsNode(view.annotations));
        }
        if (view.draftTag) {
          composer.slots.draftTag.append(draftTagNode(view.draftTag));
        }
        if (view.origin) {
          composer.slots.origin.append(originNode(view.origin));
        }
        nextTurnFigure = view.nextTurn ?? null;
        if (nextTurnFigure) {
          composer.slots.nextTurn.append(nextTurnNode(nextTurnFigure));
        }
      } else {
        nextTurnFigure = null;
      }
      queueLive.update(view);
      clock.tick();
      if (held) {
        const again = [...document.querySelectorAll<HTMLElement>('[data-control]')].find(
          (node) => node.dataset.control === held,
        );
        if (again && (!(again instanceof HTMLButtonElement) || !again.disabled)) {
          again.focus();
        }
      }
      measure();
      requests.fitTabs();
      controls.place();
      composer.drawSlash(true);
      comments.refreshSelection();
    },
  };
}
