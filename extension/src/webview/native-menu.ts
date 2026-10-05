import { h } from 'preact';

// The shared three-dot artwork for native action menus.
export function nativeMenuIcon() {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
    h('circle', { cx: '3', cy: '8', r: '1.6' }),
    h('circle', { cx: '8', cy: '8', r: '1.6' }),
    h('circle', { cx: '13', cy: '8', r: '1.6' }),
  ]);
}

// Open the native menu at the pressed control's bottom-left corner.
export function pressNativeMenu(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
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
