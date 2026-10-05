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
  // Registers the drawing for anchors whose `data-hint-body` names `kind`. The drawing takes
  // the anchor and returns the element the box shows in place of its title and detail, or null
  // when the anchor's subject is gone, which closes the box.
  body(kind: string, draw: (anchor: HTMLElement) => HTMLElement | null): void;
  // Draws the open box again when its anchor's body is `kind`. An owner calls this after an
  // update that changes what the body shows without changing the anchor's attributes.
  redraw(kind: string): void;
}

export const HINT_DELAY_MS = 300;
// How long the pointer rests on an anchor that names a drawn body before the body opens. It is
// the editor's own hover delay, 500 ms on Windows and Linux and 1500 ms on macOS. It is longer
// than a plain hint's because a body is a card, and a pointer passing down the rail must not
// open one on every row.
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
  // Read by a screen reader through `aria-describedby`, never seen. Most anchors need none of
  // this: their visible detail is the whole description, and `show` links `detail` itself. An
  // anchor whose visible detail repeats words its accessible name already carries supplies a
  // shorter one through `data-hint-description`, and that is what gets linked here instead, so
  // the description a screen reader reads never doubles the name.
  const description = element(options.document, 'div', 'sr-only');
  description.id = 'hintdescription';
  // A drawn body, shown in place of the title and detail for an anchor that names one with
  // `data-hint-body`. The anchor's `data-hint` still opens the box, and its description rules
  // stay as they are, so a screen reader never reads the body.
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
    // An anchor that marks itself as holding a record wears that mark while the record is
    // open, the way a chip wears it while its popover stands. Every other anchor is left
    // alone: its own hover is the whole of what it shows.
    if (node.classList.contains('has-detail')) {
      node.classList.add('detail-pinned');
    }
    writeTitle(hint);
    detail.textContent = hintDetail;
    // An anchor whose detail is written as lines asks for them with `data-hint-lines`. Every
    // other detail is one run of text the box wraps for itself.
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
    // Written on every show, even where this node carries no description, so the hidden node
    // never keeps the previous node's text once it stops being the one aria-describedby names.
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
    // A card waits with the box closed. Another anchor's hint, such as one keyboard focus opened,
    // must not stand over the rows while the pointer rests, and a redraw of that hint must not
    // cancel the wait.
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
  // A scroll of a container that holds the anchor moves the anchor out from under the box.
  // Scroll does not bubble, so the document hears it in the capture phase, from every scroller
  // the panel draws.
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
