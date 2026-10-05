import { element } from './dom.ts';
import type { PanelToHost } from './protocol.ts';

export const ROVING_SELECTOR =
  '.session, .sessionmenu, button.sessionlabel, button.sessionparent, .sessionlabelact, .head:not(.livehead):not(.statichead), .statdetail, .result, .cliveoff, .cwaitingact';

export function plainNavigationKey(
  event: Pick<
    KeyboardEvent,
    'defaultPrevented' | 'isComposing' | 'keyCode' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function navigationIndex(key: string, index: number, length: number): number | null {
  if (!length) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown') return Math.min(index + 1, length - 1);
  if (key === 'ArrowUp') return Math.max(index - 1, 0);
  return null;
}

// Mark matching controls as changed subtrees arrive. Reads reuse the cached walk until the page changes.
const ROVING_MARK = 'data-roving';

// Compare nodeType across realms, where local Element instanceof checks fail.
const ELEMENT_NODE = 1;

export type NavigationMessage = Extract<PanelToHost, { type: 'goBack' | 'goForward' }>;

export interface NavigationEvents {
  document(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

// Exposes queued mutations and observer cleanup.
export interface NavigationWatch {
  takeRecords(): MutationRecord[];
  disconnect(): void;
}

export interface NavigationService {
  allControls(): HTMLElement[];
  rovingControls(controls?: readonly HTMLElement[]): HTMLElement[];
  setRoving(node: HTMLElement | null, controls?: readonly HTMLElement[]): void;
  installRoving(): void;
  refreshBackToTop(): void;
  // Disconnects the observer so a finished owner stops marking controls.
  dispose(): void;
}

export function navigationButton(button: number): NavigationMessage['type'] | null {
  if (button === 3) {
    return 'goBack';
  }
  if (button === 4) {
    return 'goForward';
  }
  return null;
}

export function handleNavigationPress(
  event: Pick<MouseEvent, 'button' | 'preventDefault'>,
  send?: (message: NavigationMessage) => void,
): boolean {
  const move = navigationButton(event.button);
  if (!move) {
    return false;
  }
  event.preventDefault();
  send?.({ type: move });
  return true;
}

export function farFromTop(scrolled: number, viewport: number): boolean {
  return scrolled > viewport;
}

export function createNavigation(options: {
  document: Document;
  window: Pick<Window, 'innerHeight'>;
  list: HTMLElement;
  events: NavigationEvents;
  observe(target: Node, callback: MutationCallback, init: MutationObserverInit): NavigationWatch;
  sendToHost(message: NavigationMessage): void;
  toTopLabel: string;
}): NavigationService {
  const marked = `[${ROVING_MARK}]`;
  // Cache the complete walk and reachable controls. Page changes invalidate both.
  let walk: HTMLElement[] | null = null;
  let reachable: HTMLElement[] | null = null;
  const shown = (node: HTMLElement): boolean => !node.closest('[hidden]');
  const isElement = (node: Node): node is HTMLElement => node.nodeType === ELEMENT_NODE;
  const mark = (node: HTMLElement): void => {
    const belongs = options.list.contains(node) && node.matches(ROVING_SELECTOR);
    if (belongs === node.hasAttribute(ROVING_MARK)) {
      return;
    }
    if (belongs) {
      node.setAttribute(ROVING_MARK, '');
    } else {
      node.removeAttribute(ROVING_MARK);
    }
  };
  // Inspect complete subtrees because owners build them off-page. Remove stale marks from controls outside the walk.
  const markTree = (node: Node): void => {
    if (!isElement(node)) {
      return;
    }
    mark(node);
    for (const inner of Array.from(node.querySelectorAll<HTMLElement>(`${ROVING_SELECTOR}, ${marked}`))) {
      mark(inner);
    }
  };
  const absorb = (changes: MutationRecord[]): void => {
    if (!changes.length) {
      return;
    }
    walk = null;
    reachable = null;
    for (const change of changes) {
      if (change.type === 'attributes') {
        if (change.attributeName === 'class' && isElement(change.target)) {
          mark(change.target);
        }
        continue;
      }
      for (const added of Array.from(change.addedNodes)) {
        markTree(added);
      }
    }
  };
  markTree(options.document.body);
  const watcher = options.observe(options.document.body, absorb, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  });
  // Drain queued mutations before reading controls, including changes from the same rendering pass.
  const allControls = (): HTMLElement[] => {
    absorb(watcher.takeRecords());
    walk ??= Array.from(options.document.querySelectorAll<HTMLElement>(marked));
    return walk;
  };
  const rovingControls = (controls?: readonly HTMLElement[]): HTMLElement[] => {
    const all = allControls();
    if (controls && controls !== all) {
      return controls.filter(shown);
    }
    reachable ??= all.filter(shown);
    return reachable;
  };
  const setRoving = (node: HTMLElement | null, controls: readonly HTMLElement[] = allControls()): void => {
    for (const control of controls) {
      control.tabIndex = control === node ? 0 : -1;
    }
  };
  let rovingInstalled = false;
  const installRoving = (): void => {
    if (rovingInstalled) {
      return;
    }
    rovingInstalled = true;
    options.events.document('keydown', (raw) => {
      const event = raw as KeyboardEvent;
      const from = event.target instanceof Element ? event.target.closest<HTMLElement>(ROVING_SELECTOR) : null;
      if (
        !from ||
        !options.list.contains(from) ||
        !plainNavigationKey(event) ||
        (event.target as HTMLElement).closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        return;
      }
      const controls = rovingControls();
      const index = controls.indexOf(from);
      if (index < 0) {
        return;
      }
      const next = navigationIndex(event.key, index, controls.length);
      const to = next === null ? null : controls[next];
      if (!to) {
        return;
      }
      event.preventDefault();
      setRoving(to);
      to.focus();
    });
    options.events.document('focusin', (event) => {
      const node = event.target instanceof Element ? event.target.closest<HTMLElement>(ROVING_SELECTOR) : null;
      if (node && options.list.contains(node)) {
        setRoving(node);
      }
    });
  };
  let toTopButton: HTMLButtonElement | null = null;
  const refreshBackToTop = (): void => {
    if (!toTopButton) {
      toTopButton = element(options.document, 'button', 'totop', options.toTopLabel);
      toTopButton.hidden = true;
      options.document.body.appendChild(toTopButton);
      toTopButton.addEventListener('click', backToTop);
    }
    const scrolled = options.document.scrollingElement?.scrollTop ?? 0;
    toTopButton.hidden = !farFromTop(scrolled, options.window.innerHeight);
  };
  function backToTop(): void {
    if (options.document.scrollingElement) {
      options.document.scrollingElement.scrollTop = 0;
    }
    const inList = rovingControls().filter((node) => options.list.contains(node));
    const first = inList[0] ?? rovingControls()[0];
    if (first) {
      setRoving(first);
      first.focus();
    }
    refreshBackToTop();
  }
  options.events.document('scroll', refreshBackToTop, true);
  options.events.window('resize', refreshBackToTop);
  options.events.document('mousedown', (event) => {
    if (!(event instanceof MouseEvent)) {
      return;
    }
    handleNavigationPress(event, options.sendToHost);
  });
  options.events.document('mouseup', (event) => {
    if (event instanceof MouseEvent) {
      handleNavigationPress(event);
    }
  });
  const dispose = (): void => {
    watcher.disconnect();
  };
  return { allControls, rovingControls, setRoving, installRoving, refreshBackToTop, dispose };
}
