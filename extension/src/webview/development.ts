import './panel.css';
import { startBrowserPanel } from './bootstrap.ts';
import { createDevelopmentScrollRestorer, markDevelopmentReload, takeDevelopmentReload } from './development-state.ts';

const DEVELOPMENT_RELOAD_EVENT = 'arc:reload';

declare global {
  interface Window {
    __arcDevReady?: boolean;
  }
}

const hot = import.meta.hot;
const { preferBrowserState, scrollTop } = takeDevelopmentReload(window.sessionStorage);
const markReload = () => {
  markDevelopmentReload(window.sessionStorage, window.scrollY);
};
const scrollRestorer = createDevelopmentScrollRestorer(scrollTop, {
  position: () => window.scrollY,
  restore: (top) => {
    window.scrollTo(0, top);
  },
  frame: (callback) => {
    requestAnimationFrame(callback);
  },
});
window.addEventListener('scroll', scrollRestorer.readerScrolled, { passive: true });
const panel = startBrowserPanel({
  preferBrowserState,
  afterHostMessage: scrollRestorer.afterHostMessage,
});
const replaceDocument = () => {
  markReload();
  panel.reloadDevelopmentDocument();
};
let waitingForServer = false;
const checkDevelopmentServer = async () => {
  try {
    const client = new URL('/@vite/client', import.meta.url);
    const response = await fetch(client, { cache: 'no-store' });
    if (response.ok) {
      replaceDocument();
      return;
    }
  } catch {
    // The current panel stays active while Vite is unavailable.
  }
  window.setTimeout(() => {
    void checkDevelopmentServer();
  }, 2000);
};
const reloadWhenServerReturns = () => {
  if (waitingForServer) {
    return;
  }
  waitingForServer = true;
  window.setTimeout(() => {
    void checkDevelopmentServer();
  }, 2000);
};

window.__arcDevReady = true;
window.addEventListener('pagehide', markReload, { once: true });
if (hot) {
  hot.accept();
  hot.on(DEVELOPMENT_RELOAD_EVENT, replaceDocument);
  // Vite awaits these listeners before it runs its own browser navigation.
  /* oxlint-disable typescript/no-misused-promises */
  hot.on(
    'vite:beforeFullReload',
    () =>
      new Promise<void>(() => {
        replaceDocument();
      }),
  );
  hot.on(
    'vite:ws:disconnect',
    () =>
      new Promise<void>(() => {
        reloadWhenServerReturns();
      }),
  );
  /* oxlint-enable typescript/no-misused-promises */
  hot.dispose(markReload);
}
