export interface VisibilityBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisibilityObservation {
  box: VisibilityBox;
  full: boolean;
}

export interface RetainedVisibilityPorts {
  opacity(): string;
  setOpacity(value: string): void;
  box(): VisibilityBox;
  observe?: (receive: (entry: VisibilityObservation) => void) => () => void;
  afterPaint(callback: () => void): void;
  place(): void;
  hidden?(): void;
  released?(): void;
}

function sameBox(a: VisibilityBox, b: VisibilityBox): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function createRetainedVisibility(ports: RetainedVisibilityPorts) {
  let revision = -1;
  let generation = 0;
  let visible = true;
  let disposed = false;
  let originalOpacity: string | null = null;
  let currentBox: VisibilityBox | null = null;
  let disconnect: (() => void) | undefined;

  function invalidate() {
    generation++;
    disconnect?.();
    disconnect = undefined;
  }

  function conceal() {
    if (originalOpacity === null) originalOpacity = ports.opacity();
    ports.setOpacity('0');
  }

  function prepare() {
    invalidate();
    conceal();
    ports.place();
    currentBox = ports.box();
    const expected = generation;
    let painted = false;
    let observed: VisibilityObservation | null = null;
    const release = () => {
      if (disposed || !visible || generation !== expected || !painted) return;
      const box = ports.box();
      // Without IntersectionObserver, the existing paint boundary keeps the retained page usable.
      if (ports.observe && (!observed?.full || box.width <= 0 || box.height <= 0 || !sameBox(observed.box, box)))
        return;
      ports.setOpacity(originalOpacity!);
      ports.released?.();
    };
    disconnect = ports.observe?.((entry) => {
      if (generation !== expected || disposed) return;
      observed = entry;
      release();
    });
    ports.afterPaint(() => {
      painted = true;
      release();
    });
  }

  return {
    receive(message: { visible: boolean; revision: number }) {
      if (
        disposed ||
        !Number.isSafeInteger(message.revision) ||
        message.revision < 0 ||
        message.revision <= revision ||
        typeof message.visible !== 'boolean'
      )
        return;
      revision = message.revision;
      visible = message.visible;
      if (!visible) {
        ports.hidden?.();
        invalidate();
        conceal();
        currentBox = null;
      } else if (originalOpacity !== null) {
        prepare();
      }
    },
    resize() {
      if (disposed || !visible || originalOpacity === null) return;
      const box = ports.box();
      if (!currentBox || !sameBox(currentBox, box)) prepare();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
      if (originalOpacity !== null) ports.setOpacity(originalOpacity);
    },
  };
}

export function createRetainedFocus<Node>(ports: {
  hasFocus(): boolean;
  activeIsDefault(): boolean;
  eligible(node: Node): boolean;
  focus(node: Node): void;
}) {
  let last: Node | null = null;
  let retained: Node | null = null;
  let released = false;
  function restore() {
    const node = retained;
    if (!released || !node || !ports.hasFocus()) return;
    retained = null;
    if (ports.activeIsDefault() && ports.eligible(node)) ports.focus(node);
  }
  return {
    focused(node: Node) {
      if (!ports.eligible(node)) {
        last = retained = null;
        return;
      }
      if (retained !== node) retained = null;
      last = node;
    },
    activity(node: Node | null) {
      retained = null;
      last = node && ports.eligible(node) ? node : null;
    },
    hidden() {
      released = false;
      retained = last;
    },
    released() {
      released = true;
      restore();
    },
    windowFocused: restore,
  };
}

export function mountRetainedVisibility(
  document: Document,
  afterPaint: RetainedVisibilityPorts['afterPaint'],
  place: () => void,
) {
  const root = document.documentElement;
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.inert = true;
  sentinel.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0';
  document.body.appendChild(sentinel);
  const view = document.defaultView!;
  const focus = createRetainedFocus<HTMLElement>({
    hasFocus: () => document.hasFocus(),
    activeIsDefault: () =>
      !document.activeElement || document.activeElement === document.body || document.activeElement === root,
    eligible: (node) =>
      node.isConnected &&
      !node.closest('[hidden],[inert]') &&
      node.getClientRects().length > 0 &&
      !node.matches(':disabled') &&
      node.matches('button,input,textarea,select,a[href],[contenteditable="true"],[tabindex]'),
    focus: (node) => {
      const input = node instanceof view.HTMLInputElement || node instanceof view.HTMLTextAreaElement ? node : null;
      const inputStart = input?.selectionStart;
      const inputEnd = input?.selectionEnd;
      const inputDirection = input?.selectionDirection;
      const selection = document.getSelection();
      const anchor = selection?.anchorNode;
      const end = selection?.focusNode;
      const anchorOffset = selection?.anchorOffset ?? 0;
      const endOffset = selection?.focusOffset ?? 0;
      const selected = selection && !selection.isCollapsed;
      node.focus({ preventScroll: true });
      if (input && inputStart != null && inputEnd != null)
        input.setSelectionRange(inputStart, inputEnd, inputDirection ?? undefined);
      if (selected && anchor?.isConnected && end?.isConnected)
        selection.setBaseAndExtent(anchor, anchorOffset, end, endOffset);
    },
  });
  const focused = (event: FocusEvent) => {
    if (event.target instanceof view.HTMLElement && event.target !== document.body && event.target !== root)
      focus.focused(event.target);
    focus.windowFocused();
  };
  const activity = (event: Event) => {
    const active = document.activeElement;
    focus.activity(
      active instanceof view.HTMLElement && event.target instanceof view.Node && active.contains(event.target)
        ? active
        : null,
    );
  };
  document.addEventListener('pointerdown', activity, true);
  document.addEventListener('click', activity, true);
  document.addEventListener('keydown', activity, true);
  document.addEventListener('focusin', focused);
  view.addEventListener('focus', focus.windowFocused);
  const controller = createRetainedVisibility({
    opacity: () => root.style.opacity,
    setOpacity: (value) => {
      root.style.opacity = value;
    },
    box: () => sentinel.getBoundingClientRect(),
    observe:
      typeof view.IntersectionObserver === 'function'
        ? (receive) => {
            const observer = new view.IntersectionObserver(
              (entries) => {
                const entry = entries.at(-1);
                if (entry)
                  receive({
                    box: entry.boundingClientRect,
                    full: entry.isIntersecting && entry.intersectionRatio === 1,
                  });
              },
              { root: null, threshold: [0, 1] },
            );
            observer.observe(sentinel);
            return () => observer.disconnect();
          }
        : undefined,
    afterPaint,
    place,
    hidden: focus.hidden,
    released: focus.released,
  });
  return {
    receive: controller.receive,
    resize: controller.resize,
    dispose() {
      controller.dispose();
      document.removeEventListener('pointerdown', activity, true);
      document.removeEventListener('click', activity, true);
      document.removeEventListener('keydown', activity, true);
      document.removeEventListener('focusin', focused);
      view.removeEventListener('focus', focus.windowFocused);
      sentinel.remove();
    },
  };
}
