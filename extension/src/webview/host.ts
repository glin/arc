import type { PanelToHost } from './protocol.ts';

export interface VsCodeWebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PanelHost {
  send(message: PanelToHost): void;
}

export interface BrowserStatePort {
  read(): unknown;
  write(state: unknown): void;
}

export interface HostPorts {
  host: PanelHost;
  browserState: BrowserStatePort;
}

// The object supplied by VS Code stays in this closure. Browser rendering receives only the
// operations it needs, so it cannot publish the privileged object through the page.
export function createHost(api: VsCodeWebviewApi): HostPorts {
  return {
    host: {
      send(message) {
        api.postMessage(message);
      },
    },
    browserState: {
      read() {
        return api.getState();
      },
      write(state) {
        api.setState(state);
      },
    },
  };
}
