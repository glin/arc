import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { reloadPanelComponent } from './src/paneldevelopment.ts';
import { fillPanelText, panelValues } from './src/paneltext.ts';

const values = panelValues();
const PANEL_SOURCE = /\/src\/webview\/.*\.(?:css|js|ts)$/;
const TOKEN_DECLARATION = /^\s*declare const __ARC_[A-Z0-9_]+__:[^;]+;\s*$/gm;

export default defineConfig({
  cacheDir: join(tmpdir(), 'arc-vite'),
  plugins: [
    {
      name: 'arc-panel-values',
      enforce: 'pre',
      transform(source, id) {
        const file = id.split('?', 1)[0].replaceAll('\\', '/');
        if (!PANEL_SOURCE.test(file)) {
          return null;
        }
        const fillable = file.endsWith('.ts') ? source.replace(TOKEN_DECLARATION, '') : source;
        const filled = fillPanelText(fillable, values);
        return filled === source ? null : { code: filled, map: null };
      },
      hotUpdate: reloadPanelComponent,
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: ['127.0.0.1'],
    cors: {
      origin: /^vscode-webview:\/\/[a-z0-9-]+$/i,
    },
  },
});
