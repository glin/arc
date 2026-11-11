import { h } from 'preact';

// The shared three-dot artwork for native action menus.
export function nativeMenuIcon() {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
    h('circle', { cx: '3', cy: '8', r: '1.6' }),
    h('circle', { cx: '8', cy: '8', r: '1.6' }),
    h('circle', { cx: '13', cy: '8', r: '1.6' }),
  ]);
}

let pendingFocus: AbortController | null = null;

// Open the native menu at the pressed control's bottom-left corner.
export function pressNativeMenu(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  const document = target.ownerDocument;
  const window = document.defaultView;
  pendingFocus?.abort();
  if (window) {
    const pending = new AbortController();
    pendingFocus = pending;
    const clear = () => {
      pending.abort();
      if (pendingFocus === pending) pendingFocus = null;
    };
    // The host returns focus to the webview document after closing a native menu.
    window.addEventListener(
      'focus',
      () => {
        const active = document.activeElement;
        clear();
        if (target.isConnected && (!active || active === document.body || active === document.documentElement)) {
          target.focus({ preventScroll: true });
        }
      },
      { once: true, signal: pending.signal },
    );
    document.addEventListener('pointerdown', clear, { capture: true, signal: pending.signal });
    document.addEventListener('keydown', clear, { capture: true, signal: pending.signal });
  }
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }),
  );
}
