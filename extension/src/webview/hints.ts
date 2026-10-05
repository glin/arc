import { element, placeFloat } from './dom.ts';

export interface HintEvents {
  document(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

export interface HintService {
  readonly element: HTMLElement;
  hide(node?: HTMLElement | null): boolean;
  // Marks a control as pressed, so focus that a pointer press moves to it shows no hint.
  press(target: EventTarget | null): void;
  // Registers a body renderer for anchors whose data-hint-body names kind.
  // Its element replaces title and detail. A null result closes the hint.
  body(kind: string, draw: (anchor: HTMLElement) => HTMLElement | null): void;
  // Redraws the open body of this kind after its contents change without an anchor attribute change.
  redraw(kind: string): void;
}

export const HINT_DELAY_MS = 300;
// Hover cards wait 500 ms on Windows and Linux, or 1500 ms on macOS.
// Each row waits separately so pointer movement does not open every card it crosses.
export const HINT_BODY_DELAY_MS = 500;
export const HINT_BODY_DELAY_MAC_MS = 1500;

export function createHints(options: {
  document: Document;
  window: Pick<Window, 'innerHeight' | 'innerWidth'>;
  // The browser's platform string, such as `Win32` or `MacIntel`.
  platform: string;
  events: HintEvents;
  observe(target: Node, callback: MutationCallback, init: MutationObserverInit): void;
  setDelay(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearDelay(handle: ReturnType<typeof setTimeout>): void;
}): HintService {
  const bodyDelay = /^Mac/.test(options.platform) ? HINT_BODY_DELAY_MAC_MS : HINT_BODY_DELAY_MS;
  const popover = element(options.document, 'div', 'pop');
  popover.id = 'hintpop';
  popover.hidden = true;
  popover.setAttribute('role', 'tooltip');
  const title = element(options.document, 'div', 'hinttitle');
  const detail = element(options.document, 'div', 'hintdetail');
  detail.id = 'hintdetail';
  // Anchors use this hidden description when visible detail repeats their accessible name.
  // Without an explicit description, aria-describedby uses nonempty visible detail.
  const description = element(options.document, 'div', 'sr-only');
  description.id = 'hintdescription';
  // Body hints replace visible title and detail. The anchor still uses data-hint and the separate accessible description.
  const body = element(options.document, 'div', 'hintbody');
  body.hidden = true;
  const bodies = new Map<string, (anchor: HTMLElement) => HTMLElement | null>();
  popover.append(title, detail, body, description);
  options.document.body.appendChild(popover);

  let visibleFor: HTMLElement | null = null;
  let pendingFor: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressedFor: HTMLElement | null = null;

  const clearPending = (): void => {
    if (timer !== null) {
      options.clearDelay(timer);
    }
    timer = null;
    pendingFor = null;
  };
  const clearBody = (): void => {
    body.replaceChildren();
    body.hidden = true;
    popover.classList.remove('hintcard');
  };
  const hide = (node: HTMLElement | null = null): boolean => {
    if (node && node !== visibleFor && node !== pendingFor) {
      return false;
    }
    const hadHint = visibleFor !== null || pendingFor !== null;
    clearPending();
    visibleFor?.removeAttribute('aria-describedby');
    visibleFor?.classList.remove('detail-pinned');
    visibleFor = null;
    description.textContent = '';
    clearBody();
    popover.hidden = true;
    return hadHint;
  };
  const writeTitle = (text: string): void => {
    title.textContent = '';
    const key = /^(.*?)( \([^)]+\))$/.exec(text);
    title.appendChild(options.document.createTextNode(key?.[1] ?? text));
    if (!key) {
      return;
    }
    const part = element(options.document, 'span', 'hintkey', key[2]);
    title.appendChild(part);
  };
  const place = (node: HTMLElement): void => {
    const value = options.document.body.style.getPropertyValue('--statusbar-height');
    const statusHeight = Number.parseFloat(value) || 0;
    placeFloat(options.window, popover, node, options.window.innerHeight - statusHeight - 6);
  };
  const show = (node: HTMLElement): void => {
    const hint = node.dataset.hint ?? '';
    const hintDetail = node.dataset.hintDetail ?? '';
    const hintDescription = node.dataset.hintDescription;
    if (!hint) {
      hide();
      return;
    }
    clearPending();
    if (visibleFor && visibleFor !== node) {
      visibleFor.removeAttribute('aria-describedby');
      visibleFor.classList.remove('detail-pinned');
    }
    // Detail anchors retain their active styling while the hint is open. Other anchors keep their normal hover styling.
    if (node.classList.contains('has-detail')) {
      node.classList.add('detail-pinned');
    }
    writeTitle(hint);
    detail.textContent = hintDetail;
    // data-hint-lines preserves line breaks. Other detail text wraps normally.
    detail.classList.toggle('lines', node.dataset.hintLines !== undefined);
    detail.hidden = !hintDetail;
    const draw = node.dataset.hintBody ? bodies.get(node.dataset.hintBody) : undefined;
    if (draw) {
      const drawn = draw(node);
      if (!drawn) {
        hide();
        return;
      }
      body.replaceChildren(drawn);
      body.hidden = false;
      title.hidden = true;
      detail.hidden = true;
      popover.classList.add('hintcard');
    } else {
      clearBody();
      title.hidden = false;
    }
    visibleFor = node;
    // Clear the hidden description on every show so it never retains another anchor's text.
    description.textContent = hintDescription ?? '';
    if (hintDescription) {
      node.setAttribute('aria-describedby', description.id);
    } else if (hintDescription === undefined && hintDetail) {
      node.setAttribute('aria-describedby', detail.id);
    } else {
      node.removeAttribute('aria-describedby');
    }
    popover.hidden = false;
    place(node);
  };
  const schedule = (node: HTMLElement, immediate: boolean): void => {
    if (visibleFor === node && !popover.hidden) {
      return;
    }
    // Close the previous hint during a card's hover delay. Redraws must preserve the pending pointer target.
    if (!immediate && node.dataset.hintBody) {
      hide();
    } else {
      clearPending();
    }
    if (immediate) {
      show(node);
      return;
    }
    pendingFor = node;
    const delay = node.dataset.hintBody ? bodyDelay : HINT_DELAY_MS;
    timer = options.setDelay(() => {
      timer = null;
      pendingFor = null;
      if (node.isConnected) {
        show(node);
      }
    }, delay);
  };
  const anchor = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[data-hint]') : null;
  const mutation = (records: MutationRecord[]): void => {
    if (visibleFor && !visibleFor.isConnected) {
      hide();
      return;
    }
    if (pendingFor && !pendingFor.isConnected) {
      hide();
      return;
    }
    if (!visibleFor || popover.hidden) {
      return;
    }
    for (const record of records) {
      if (record.type === 'attributes' && record.target === visibleFor) {
        show(visibleFor);
        return;
      }
    }
  };

  options.events.document('pointerover', (event) => {
    if (!(event instanceof PointerEvent)) {
      return;
    }
    const node = anchor(event.target);
    if (!node || (event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) {
      return;
    }
    schedule(node, !popover.hidden && !node.dataset.hintBody);
  });
  options.events.document('pointerout', (event) => {
    if (!(event instanceof PointerEvent)) {
      return;
    }
    const node = anchor(event.target);
    if (!node || (event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) {
      return;
    }
    const next = anchor(event.relatedTarget);
    if (next) {
      schedule(next, !popover.hidden && !next.dataset.hintBody);
      return;
    }
    hide(node);
  });
  options.events.document('focusin', (event) => {
    const node = anchor(event.target);
    if (node && node !== pressedFor) {
      schedule(node, true);
    }
  });
  options.events.document('focusout', (event) => {
    if (!(event instanceof FocusEvent)) {
      return;
    }
    const node = anchor(event.target);
    if (!node || (event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) {
      return;
    }
    hide(node);
  });
  const press = (target: EventTarget | null): void => {
    const node = anchor(target);
    if (!node) {
      return;
    }
    pressedFor = node;
    hide(node);
    options.setDelay(() => {
      if (pressedFor === node) {
        pressedFor = null;
      }
    }, 0);
  };
  options.events.document('pointerdown', (event) => {
    press(event.target);
  });
  options.events.document('pointerup', () => {
    pressedFor = null;
  });
  options.events.document('pointercancel', () => {
    pressedFor = null;
  });
  options.events.document('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || popover.hidden || !visibleFor) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    hide();
  });
  options.events.window('resize', () => {
    hide();
  });
  // Hide hints when their containing scroller moves. Capture receives scroll events because they do not bubble.
  options.events.document(
    'scroll',
    (event) => {
      const anchorNode = visibleFor ?? pendingFor;
      if (anchorNode && event.target instanceof Node && event.target.contains(anchorNode)) {
        hide();
      }
    },
    { capture: true },
  );
  options.observe(options.document.body, mutation, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-hint', 'data-hint-detail', 'data-hint-lines', 'data-hint-description', 'data-hint-body'],
  });
  return {
    element: popover,
    hide,
    press,
    body(kind, draw) {
      bodies.set(kind, draw);
    },
    redraw(kind) {
      if (visibleFor && !popover.hidden && visibleFor.dataset.hintBody === kind) {
        show(visibleFor);
      }
    },
  };
}
