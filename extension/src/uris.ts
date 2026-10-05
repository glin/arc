import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { ARC_IDENTITY } from './identity';

export const SCHEME = ARC_IDENTITY.baselineScheme;
export const PATCH_SCHEME = ARC_IDENTITY.patchScheme;

export function baselineUri(snapshot: string, livePath: string): vscode.Uri {
  // Path mirrors the live file so the diff header shows the real filename (not the
  // snapshot hash). The snapshot to read is in `s`; `v` is the snapshot mtime, which
  // makes each baseline version a distinct URI. VS Code caches virtual-document
  // content per URI, so without `v` a Keep-advanced baseline would render its pre-Keep
  // content in a later turn's diff.
  let version = '0';
  try {
    version = String(fs.statSync(snapshot).mtimeMs);
  } catch {
    /* missing snapshot */
  }
  const query = `s=${encodeURIComponent(snapshot)}&v=${version}`;
  return vscode.Uri.from({ scheme: SCHEME, path: livePath, query });
}

// One side of a turn's own diff. The path mirrors the live file so the diff header shows
// the real filename. `v` is a digest of the text this side carries, for the reason
// `baselineUri` documents: VS Code caches virtual-document content per URI, so a side
// whose text has changed needs a URI that has changed with it.
export function turnFileUri(filePath: string, side: 'before' | 'after', version: string): vscode.Uri {
  const query = `side=${side}&v=${encodeURIComponent(version)}`;
  return vscode.Uri.from({ scheme: PATCH_SCHEME, path: filePath, query });
}
