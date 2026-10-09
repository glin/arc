import type { PanelToHost } from './protocol.ts';

export interface VsCodeWebviewApi {
  readOnly?: boolean;
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
  readOnly: boolean;
  host: PanelHost;
  browserState: BrowserStatePort;
}

// Keeps the VS Code API inside this closure. Renderers receive only host messaging and browser state operations.
export function createHost(api: VsCodeWebviewApi): HostPorts {
  return {
    readOnly: api.readOnly === true,
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
