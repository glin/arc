export interface DevelopmentPanelServer {
  origin: string;
  websocketOrigin: string;
  clientUrl: string;
  entryUrl: string;
}

interface PanelHotUpdateOptions {
  file: string;
  timestamp: number;
  modules: readonly unknown[];
  server: {
    config: { root: string };
    environments: {
      client: {
        moduleGraph: { invalidateAll(): void };
        hot: { send(payload: { type: 'custom'; event: string; data: unknown }): void };
      };
    };
    transformRequest(url: string): Promise<unknown>;
  };
}

const PANEL_COMPONENT_SOURCE = /\/src\/webview\/.*\.(?:js|ts)$/;

export async function reloadPanelComponent(options: PanelHotUpdateOptions): Promise<[] | undefined> {
  const file = options.file.replaceAll('\\', '/');
  const root = options.server.config.root.replaceAll('\\', '/').replace(/\/$/, '');
  if (!PANEL_COMPONENT_SOURCE.test(file) || !file.startsWith(`${root}/`) || options.modules.length === 0) {
    return undefined;
  }
  options.server.environments.client.moduleGraph.invalidateAll();
  await options.server.transformRequest(`${file.slice(root.length)}?t=${options.timestamp}`);
  options.server.environments.client.hot.send({
    type: 'custom',
    event: 'arc:reload',
    data: {},
  });
  return [];
}

export interface PanelShellOptions {
  cspSource: string;
  nonce: string;
  savedStateJson: string;
  style: string;
  script: string;
  developmentServerUrl: string | null;
}

export function developmentPanelServer(value: string): DevelopmentPanelServer {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'http:' || (hostname !== '127.0.0.1' && hostname !== '[::1]')) {
    throw new Error('The panel development server must use HTTP on the local loopback address.');
  }
  if (!parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('The panel development server URL must contain only a local origin with an explicit port.');
  }
  const origin = parsed.origin;
  return {
    origin,
    websocketOrigin: origin.replace(/^http:/, 'ws:'),
    clientUrl: `${origin}/@vite/client`,
    entryUrl: `${origin}/src/webview/development.ts`,
  };
}

function developmentLoader(server: DevelopmentPanelServer): string {
  const client = JSON.stringify(server.clientUrl);
  const entry = JSON.stringify(server.entryUrl);
  const origin = JSON.stringify(server.origin);
  return `window.__arcDevReady = false;
const showDevelopmentError = (message) => {
  const list = document.getElementById('list');
  if (list && !window.__arcDevReady) list.textContent = message;
};
const loadDevelopmentEntry = () => {
  const script = document.createElement('script');
  script.type = 'module';
  script.src = ${entry} + '?t=' + Date.now();
  document.body.append(script);
};
const waitForDevelopmentServer = () => {
  Promise.all([
    fetch(${client}, { cache: 'no-store' }),
    fetch(${entry}, { cache: 'no-store' }),
  ]).then(([clientResponse, entryResponse]) => {
    if (clientResponse.ok && entryResponse.ok) loadDevelopmentEntry();
    else setTimeout(waitForDevelopmentServer, 2000);
  }).catch(() => setTimeout(waitForDevelopmentServer, 2000));
};
setTimeout(() => {
  if (window.__arcDevReady) return;
  fetch(${client}, { cache: 'no-store' }).then((response) => {
    if (window.__arcDevReady) return;
    if (response.ok) {
      showDevelopmentError('The panel source did not load. Fix the Vite error, then save the file again.');
    } else {
      showDevelopmentError('The panel development server is unavailable at ' + ${origin} + '. Run npm --prefix extension run dev.');
    }
    waitForDevelopmentServer();
  }).catch(() => {
    showDevelopmentError('The panel development server is unavailable at ' + ${origin} + '. Run npm --prefix extension run dev.');
    waitForDevelopmentServer();
  });
}, 1500);`;
}

export function panelShell(options: PanelShellOptions): string {
  const server = options.developmentServerUrl === null ? null : developmentPanelServer(options.developmentServerUrl);
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${options.cspSource}${server ? ` ${server.origin}` : ''}`,
    `script-src 'nonce-${options.nonce}'${server ? ` ${server.origin}` : ''}`,
    ...(server ? [`connect-src ${server.origin} ${server.websocketOrigin}`] : []),
    `font-src ${options.cspSource}`,
    `img-src ${options.cspSource}`,
  ].join('; ');
  const style = server ? '' : `<style>${options.style}</style>`;
  const scripts = server
    ? `<script nonce="${options.nonce}">const SAVED_STATE = ${options.savedStateJson};\n${developmentLoader(server)}</script>
<script type="module" src="${server.clientUrl}"></script>
<script type="module" src="${server.entryUrl}"></script>`
    : `<script nonce="${options.nonce}">const SAVED_STATE = ${options.savedStateJson};</script>
<script nonce="${options.nonce}">${options.script}</script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Arc</title>
<meta http-equiv="Content-Security-Policy" content="${csp}">
${style}
</head>
<body>
<h1 class="sr-only">Arc</h1>
<main id="list" aria-label="Timeline"><p class="empty" data-startup-status role="status" aria-live="polite" aria-atomic="true">Reading sessions…</p></main>
${scripts}
</body>
</html>`;
}
