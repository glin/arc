import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { tempDir } from '../src/temproot.ts';

export const extensionRoot = path.join(__dirname, '..');

function overlayStaticSources(source: string): void {
  fs.mkdirSync(path.join(source, '../scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(extensionRoot, '../scripts/source-identity.mjs'),
    path.join(source, '../scripts/source-identity.mjs'),
  );
  fs.copyFileSync(path.join(extensionRoot, '../cli/src/main.ts'), path.join(source, '../cli/src/main.ts'));
  fs.copyFileSync(path.join(extensionRoot, '../cli/build.mjs'), path.join(source, '../cli/build.mjs'));
  fs.copyFileSync(
    path.join(extensionRoot, 'scripts/bundled-tools.mjs'),
    path.join(source, 'scripts/bundled-tools.mjs'),
  );
  fs.copyFileSync(path.join(extensionRoot, '../LICENSE'), path.join(source, '../LICENSE'));
  fs.cpSync(path.join(extensionRoot, '../plugins'), path.join(source, '../plugins'), { recursive: true });
  fs.cpSync(path.join(extensionRoot, '../cli/skills'), path.join(source, '../cli/skills'), { recursive: true });
  for (const file of [
    'extension.ts',
    'bundledsetup.ts',
    'bundledtools.ts',
    'toolownership.ts',
    'toolpath.ts',
    'terminalownership.ts',
    'sessionrequests.ts',
    'windowpipe.ts',
    'windowpipe-source.ts',
    'claudeplugin.ts',
    'panelbundle.ts',
    'sessionexport.ts',
    'exportdata.ts',
    'transcript.ts',
    'richtext.ts',
    'codex.ts',
    'agentspend.ts',
    'domain/export-model.ts',
    'readmeter.ts',
    'webview/card.ts',
    'webview/export-host.ts',
    'webview/export-model.ts',
    'webview/navigation.ts',
    'webview/static-menu.ts',
    'webview/static-page.css',
    'webview/static-shell.css',
    'webview/static-menu.css',
    'view/static-shell.ts',
    'view/static-page.ts',
    'view/static-themes.ts',
    'view/export-facts.ts',
    'domain/places.ts',
    'domain/export-limits.ts',
  ]) {
    fs.mkdirSync(path.dirname(path.join(source, 'src', file)), { recursive: true });
    fs.copyFileSync(path.join(extensionRoot, 'src', file), path.join(source, 'src', file));
  }
}

export function embeddedHostIdentity(file: string): Record<string, unknown> {
  const bundle = fs.readFileSync(file, 'utf8');
  // Read the literal consumed by the shipping provider, independently of the sidecar.
  for (const match of bundle.matchAll(/JSON\.parse\(((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\)/g)) {
    const source = ts.createSourceFile('identity.js', `const identity = ${match[1]};`, ts.ScriptTarget.Latest);
    const declaration = (source.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    if (!declaration.initializer || !ts.isStringLiteral(declaration.initializer)) continue;
    const literal = declaration.initializer.text;
    try {
      const identity = JSON.parse(literal);
      if ('sourceCommit' in identity && 'builtAt' in identity) return identity;
    } catch {
      /* Other bundle literals are unrelated to host identity. */
    }
  }
  return assert.fail('shipping host has no embedded build identity');
}

export function extractedExtension(prefix: string) {
  const root = tempDir(prefix);
  const archive = path.join(root, 'source.tar');
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot);
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD', 'extension', 'cli'], {
    cwd: path.dirname(extensionRoot),
    encoding: 'utf8',
  });
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-xf', path.basename(archive), '-C', path.relative(root, sourceRoot)], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(extracted.status, 0, extracted.stderr);
  const source = path.join(sourceRoot, 'extension');
  fs.copyFileSync(path.join(extensionRoot, 'esbuild.mjs'), path.join(source, 'esbuild.mjs'));
  overlayStaticSources(source);
  fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(extensionRoot, '../scripts/windowpipe-build.mjs'),
    path.join(sourceRoot, 'scripts/windowpipe-build.mjs'),
  );
  fs.cpSync(path.join(extensionRoot, 'resources'), path.join(source, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, 'src/windowpipe-source.ts'), path.join(source, 'src/windowpipe-source.ts'));
  fs.symlinkSync(
    path.join(extensionRoot, 'node_modules'),
    path.join(source, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return { root, sourceRoot, source };
}
