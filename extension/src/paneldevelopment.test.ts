import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'vitest';
import { developmentPanelServer, panelShell, reloadPanelComponent } from './paneldevelopment.ts';

describe('panel development server URL', () => {
  test.each([
    'https://127.0.0.1:5173',
    'http://localhost:5173',
    'http://192.168.1.4:5173',
    'http://127.0.0.1',
    'http://user@127.0.0.1:5173',
    'http://127.0.0.1:5173/source',
    'http://127.0.0.1:5173/?token=secret',
  ])('rejects %s', (value) => {
    assert.throws(() => developmentPanelServer(value), /local (?:loopback|origin)/);
  });

  test('accepts an explicit IPv4 loopback origin', () => {
    assert.deepEqual(developmentPanelServer('http://127.0.0.1:5173'), {
      origin: 'http://127.0.0.1:5173',
      websocketOrigin: 'ws://127.0.0.1:5173',
      clientUrl: 'http://127.0.0.1:5173/@vite/client',
      entryUrl: 'http://127.0.0.1:5173/src/webview/development.ts',
    });
  });
});

function shell(developmentServerUrl: string | null): string {
  return panelShell({
    cspSource: 'vscode-webview-resource:',
    nonce: 'nonce-value',
    savedStateJson: '{}',
    style: '.panel { color: red; }',
    script: 'window.productionPanel = true;',
    developmentServerUrl,
  });
}

test('packaged panel HTML stays inline and permits no development connection', () => {
  const html = shell(null);
  assert.match(html, /<style>\.panel \{ color: red; \}<\/style>/);
  assert.match(html, /<script nonce="nonce-value">window\.productionPanel = true;<\/script>/);
  assert.doesNotMatch(html, /@vite\/client|connect-src|127\.0\.0\.1/);
});

test('development panel HTML selects Vite and relaxes only its local origin', () => {
  const html = shell('http://127.0.0.1:5173');
  assert.doesNotMatch(html, /window\.productionPanel|\.panel \{ color: red; \}/);
  assert.match(html, /script-src 'nonce-nonce-value' http:\/\/127\.0\.0\.1:5173/);
  assert.match(html, /connect-src http:\/\/127\.0\.0\.1:5173 ws:\/\/127\.0\.0\.1:5173/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:5173\/@vite\/client"/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:5173\/src\/webview\/development\.ts"/);
  assert.match(html, /npm --prefix extension run dev/);
});

test('development startup failures stay actionable and reload when the server returns', () => {
  const html = shell('http://127.0.0.1:5173');
  assert.match(html, /The panel source did not load\. Fix the Vite error, then save the file again\./);
  assert.match(html, /The panel development server is unavailable at/);
  assert.match(html, /Run npm --prefix extension run dev\./);
  assert.match(html, /loadDevelopmentEntry/);
  assert.match(html, /script\.src = .*development\.ts.*\+ '\?t=' \+ Date\.now\(\)/);
  assert.doesNotMatch(html, /window\.location\.reload\(\)/);
  assert.match(html, /\.catch\(\(\) => setTimeout\(waitForDevelopmentServer, 2000\)\)/);
});

test('a port conflict stops the local workflow instead of selecting another origin', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'vite.config.ts'), 'utf8');
  assert.match(config, /host: '127\.0\.0\.1'/);
  assert.match(config, /port: 5173/);
  assert.match(config, /strictPort: true/);
});

test('the Vite transformation fills panel values in development CSS and compiles typed owners', async () => {
  const { createServer } = await import('vite');
  const extensionRoot = path.join(__dirname, '..');
  const files = ['/src/webview/panel.ts', '/src/webview/card.ts', '/src/webview/panel.css'];
  assert.match(fs.readFileSync(path.join(extensionRoot, '/src/webview/panel.css'), 'utf8'), /__ARC_[A-Z0-9_]+__/);

  const server = await createServer({
    appType: 'custom',
    configFile: path.join(extensionRoot, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const resolvedCacheDir = path.resolve(server.config.cacheDir);
    assert.equal(resolvedCacheDir, path.resolve(os.tmpdir(), 'arc-vite'));
    assert.ok(!resolvedCacheDir.startsWith(path.resolve(extensionRoot)));
    for (const file of files) {
      const transformed = await server.transformRequest(file);
      assert.ok(transformed, `${file} did not pass through Vite`);
      assert.doesNotMatch(transformed.code, /__ARC_[A-Z0-9_]+__/);
    }
  } finally {
    await server.close();
  }
});

test('a component save validates the update and requests host replacement without a browser reload', async () => {
  const extensionRoot = path.join(__dirname, '..');
  const sent: unknown[] = [];
  const transformed: string[] = [];
  let invalidations = 0;
  let syntaxError = false;
  const server = {
    config: { root: extensionRoot },
    environments: {
      client: {
        moduleGraph: {
          invalidateAll() {
            invalidations += 1;
          },
        },
        hot: {
          send(message: unknown) {
            sent.push(message);
          },
        },
      },
    },
    async transformRequest(url: string) {
      transformed.push(url);
      if (syntaxError) {
        throw new Error('syntax error');
      }
      return { code: '' };
    },
  };
  const update = {
    type: 'update',
    file: path.join(extensionRoot, 'src', 'webview', 'rail.ts'),
    timestamp: 73,
    modules: [{}],
    read: async () => '',
    server,
  };

  assert.equal(
    await reloadPanelComponent({ ...update, file: path.join(extensionRoot, 'src', 'webview', 'panel.css') }),
    undefined,
  );
  assert.equal(invalidations, 0);
  assert.deepEqual(await reloadPanelComponent(update), []);
  assert.deepEqual(transformed, ['/src/webview/rail.ts?t=73']);
  assert.deepEqual(sent, [{ type: 'custom', event: 'arc:reload', data: {} }]);
  assert.equal(invalidations, 1);

  sent.length = 0;
  syntaxError = true;
  await assert.rejects(reloadPanelComponent(update), /syntax error/);
  assert.deepEqual(sent, []);
});
