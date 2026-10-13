import { panelDom } from './dom.ts';
import { createHost, type VsCodeWebviewApi } from './host.ts';
import { startPanel } from './panel.ts';
import { createSavedState } from './state.ts';

declare const SAVED_STATE: unknown;
declare function acquireVsCodeApi(): VsCodeWebviewApi;

export interface BrowserPanelStartOptions {
  preferBrowserState?: boolean;
  afterHostMessage?: (message: unknown) => void;
}

export interface BrowserPanelControl {
  reloadDevelopmentDocument(): void;
}

export function startBrowserPanel(options: BrowserPanelStartOptions = {}): BrowserPanelControl {
  const ports = createHost(acquireVsCodeApi());
  const sharedState = !options.preferBrowserState && typeof SAVED_STATE === 'object' ? SAVED_STATE : undefined;
  const savedState = createSavedState(sharedState, ports.browserState, ports.host);
  const readerShellId =
    typeof SAVED_STATE === 'object' && SAVED_STATE !== null
      ? (SAVED_STATE as { readerPageId?: string }).readerPageId
      : undefined;

  const globalEvents = {
    document(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      document.addEventListener(type, listener, options);
    },
    window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      window.addEventListener(type, listener, options);
    },
  };

  const panel = startPanel({
    dom: panelDom(document),
    readOnly: ports.readOnly,
    events: globalEvents,
    savedState,
    sendToHost: ports.host.send,
    afterPaint(callback: () => void) {
      requestAnimationFrame(() => requestAnimationFrame(callback));
    },
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'readerDocument') {
      if (
        message.readerPageId === readerShellId &&
        message.documentId === panel.readerPageId &&
        typeof message.challenge === 'string' &&
        /^[a-f0-9]{32}$/.test(message.challenge)
      )
        ports.host.send({
          type: 'ready',
          readerPageId: readerShellId,
          readerDocumentId: panel.readerPageId,
          readerChallenge: message.challenge,
        });
      return;
    }
    panel.receiveHostMessage(event.data);
    options.afterHostMessage?.(event.data);
  });
  window.addEventListener('pagehide', () => panel.dispose(), { once: true });
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      ports.host.send({ type: 'ready', readerPageId: readerShellId, readerDocumentId: panel.readerPageId });
      savedState.publishRecovery();
    }),
  );
  return {
    reloadDevelopmentDocument() {
      ports.host.send({ type: 'developmentReload' });
    },
  };
}
