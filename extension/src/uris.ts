import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { ARC_IDENTITY } from './identity';

export const SCHEME = ARC_IDENTITY.baselineScheme;
export const PATCH_SCHEME = ARC_IDENTITY.patchScheme;

export function baselineUri(snapshot: string, livePath: string): vscode.Uri {
  // Use the live path for the diff header and `s` for the snapshot path.
  // `v` carries snapshot mtime to distinguish baseline versions.
  // VS Code caches virtual documents by URI. A changed baseline needs a new URI.
  let version = '0';
  try {
    version = String(fs.statSync(snapshot).mtimeMs);
  } catch {
    /* missing snapshot */
  }
  const query = `s=${encodeURIComponent(snapshot)}&v=${version}`;
  return vscode.Uri.from({ scheme: SCHEME, path: livePath, query });
}

// One side of a turn's diff. The URI path mirrors the live file so the header shows its filename.
// `v` hashes this side's text. VS Code caches virtual documents by URI, so changed text requires a changed URI.
export function turnFileUri(filePath: string, side: 'before' | 'after', version: string): vscode.Uri {
  const query = `side=${side}&v=${encodeURIComponent(version)}`;
  return vscode.Uri.from({ scheme: PATCH_SCHEME, path: filePath, query });
}
