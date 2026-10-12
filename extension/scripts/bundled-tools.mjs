import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function bundledTools(dist, sourceRoot, build) {
  const destination = path.join(dist, 'tools');
  if (fs.existsSync(destination))
    fs.renameSync(destination, path.join(path.dirname(dist), '.tmp-tools-' + randomUUID()));
  fs.mkdirSync(destination, { recursive: true });
  const inputs = ['../LICENSE', '../plugins/arc-hooks/LICENSE'];
  const files = {};
  const copy = (source, relative, mode = 0o644) => {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, mode);
    files[relative] = { sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), mode };
  };
  copy(path.join(dist, 'cli.cjs'), 'cli/arc.cjs');
  copy(path.join(dist, 'windowpipe.exe'), 'cli/windowpipe.exe');
  copy(path.join(sourceRoot, 'LICENSE'), 'LICENSE');
  const plugin = path.join(sourceRoot, 'plugins/arc-hooks');
  const visit = (relative) => {
    for (const entry of fs
      .readdirSync(path.join(plugin, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && !entry.name.endsWith('.test.js')) {
        copy(path.join(plugin, file), `plugin/${file}`);
        inputs.push(`../plugins/arc-hooks/${file}`);
      } else if (!entry.isFile()) throw new Error(`Unsupported bundled plugin file ${file}.`);
    }
  };
  for (const folder of ['.claude-plugin', 'hooks', 'scripts']) visit(folder);
  copy(path.join(plugin, 'LICENSE'), 'plugin/LICENSE');
  const launchers = {
    arc: '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$ARC_EDITOR_EXECUTABLE" "${0%/*}/../cli/arc.cjs" "$@"\n',
    'arc.cmd':
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%ARC_EDITOR_EXECUTABLE%" "%~dp0..\\cli\\arc.cjs" %*\r\nexit /b %errorlevel%\r\n',
  };
  for (const [name, bytes] of Object.entries(launchers)) {
    const relative = `launchers/${name}`;
    const mode = name === 'arc' ? 0o755 : 0o644;
    fs.mkdirSync(path.join(destination, 'launchers'), { recursive: true });
    fs.writeFileSync(path.join(destination, relative), bytes, { mode });
    fs.chmodSync(path.join(destination, relative), mode);
    files[relative] = { sha256: createHash('sha256').update(bytes).digest('hex'), mode };
  }
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  const identity = {
    schemaVersion: 1,
    ...build,
    nodeMinimum: 18,
    platforms: ['win32', 'linux', 'darwin'],
    plugin: { name: pluginManifest.name, version: pluginManifest.version },
    files,
  };
  identity.contentId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { identity, inputs };
}
