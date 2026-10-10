import { URI_DRAG_TYPES } from './domain/prompt-assets';
import { assetMimeForName, IMAGE_ASSET_MIMES } from './promptassets';
import { nativePath } from './pathcompletion';

export type DropPlatform = 'win32' | 'darwin' | 'linux';

export interface DropValue {
  type: string;
  data: string;
}

export interface DroppedImage {
  path: string;
  name: string;
  mime: string;
}

export interface DroppedUriResult {
  // Path text for the draft, one token per file or folder, joined with a space. Empty when nothing qualifies.
  text: string;
  images: DroppedImage[];
  // Count of entries that name no file or folder on this computer.
  skipped: number;
}

export interface DroppedUriOptions {
  workingDirectory: string;
  platform: DropPlatform;
  isDirectory(path: string): Promise<boolean>;
}

function drivePathUri(fsPath: string): string | null {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(fsPath);
  if (drive) {
    return `file:///${drive[1]}%3A/${encodePath(drive[2])}`;
  }
  const share = /^\\\\([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(fsPath);
  if (share) {
    return `file://${share[1]}/${encodePath(share[2])}${share[3] ? `/${encodePath(share[3])}` : ''}`;
  }
  return fsPath.startsWith('/') ? `file:///${encodePath(fsPath.slice(1))}` : null;
}

function encodePath(path: string): string {
  return path
    .split(/[\\/]/)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function resourceUri(resource: unknown): string | null {
  if (typeof resource === 'string') {
    return resource;
  }
  if (!resource || typeof resource !== 'object') {
    return null;
  }
  const value = resource as Record<string, unknown>;
  if (typeof value.external === 'string' && value.external) {
    return value.external;
  }
  if (typeof value.fsPath === 'string' && value.fsPath) {
    return drivePathUri(value.fsPath);
  }
  if (typeof value.scheme === 'string' && typeof value.path === 'string') {
    const authority = typeof value.authority === 'string' ? value.authority : '';
    return `${value.scheme}://${authority}${value.path}`;
  }
  return null;
}

function listOf(type: string, data: string): string[] {
  const kind = type.toLowerCase();
  if (kind === 'application/vnd.code.uri-list' || kind === 'text/uri-list') {
    return data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.flatMap((entry) => {
    const item =
      kind === 'codeeditors' && entry && typeof entry === 'object' ? (entry as { resource?: unknown }).resource : entry;
    const uri = resourceUri(item);
    return uri ? [uri] : [];
  });
}

// Read the URIs a drag carries. The first drag type that yields any entry wins, since VS Code offers one list in several shapes.
export function urisFromTransfer(values: readonly DropValue[]): string[] {
  for (const type of URI_DRAG_TYPES) {
    const uris = values.filter((value) => value.type.toLowerCase() === type).flatMap((v) => listOf(v.type, v.data));
    if (uris.length) {
      return [...new Set(uris)];
    }
  }
  return [];
}

// Add to Arc receives the clicked resource and the Explorer's multi-selection. A click outside the selection adds only the clicked resource.
export function uriStringsFromCommand(resource: unknown, selection: unknown): string[] {
  const text = (value: unknown): string | null => {
    if (typeof value === 'string') {
      return value || null;
    }
    if (value && typeof value === 'object' && typeof (value as { scheme?: unknown }).scheme === 'string') {
      const said = String(value);
      return said && said !== '[object Object]' ? said : null;
    }
    return null;
  };
  const clicked = text(resource);
  const selected = Array.isArray(selection) ? selection.flatMap((entry) => text(entry) ?? []) : [];
  if (clicked && (!selected.length || !selected.includes(clicked))) {
    return [clicked];
  }
  return [...new Set(selected)];
}

// Return the native path for a `file:` URI, or null for any other URI.
export function fileUriToPath(uri: string, platform: DropPlatform): string | null {
  const match = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i.exec(uri.trim());
  if (!match) {
    return null;
  }
  let authority = match[1] ?? '';
  let pathname: string;
  try {
    authority = decodeURIComponent(authority);
    pathname = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (authority.toLowerCase() === 'localhost') {
    authority = '';
  }
  if (platform === 'win32') {
    if (authority) {
      return `\\\\${authority}${pathname.replace(/\//g, '\\')}`;
    }
    const drive = /^\/?([A-Za-z]:)(\/.*)?$/.exec(pathname);
    if (drive) {
      return `${drive[1]}${(drive[2] ?? '/').replace(/\//g, '\\')}`;
    }
    return pathname.startsWith('/') ? pathname.replace(/\//g, '\\') : null;
  }
  return !authority && pathname.startsWith('/') ? pathname : null;
}

function separatorOf(platform: DropPlatform): string {
  return platform === 'win32' ? '\\' : '/';
}

// Write a path the way path completion does: relative to the working directory when inside it, absolute otherwise.
// A path with whitespace takes double quotes, and a folder ends with the separator.
export function promptPath(path: string, directory: boolean, workingDirectory: string, platform: DropPlatform): string {
  const separator = separatorOf(platform);
  const trimmed = (value: string) => (value.length > 1 ? value.replace(/[\\/]+$/, '') : value);
  const root = trimmed(platform === 'win32' ? nativePath(workingDirectory, 'win32') : workingDirectory);
  const folded = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const target = trimmed(path);
  let written = path;
  if (root && folded(target) === folded(root)) {
    written = '.';
  } else if (root && folded(target).startsWith(folded(root.endsWith(separator) ? root : root + separator))) {
    written = target.slice(root.endsWith(separator) ? root.length : root.length + 1);
  }
  if (directory && !written.endsWith(separator)) {
    written += separator;
  }
  return /\s/.test(written) ? `"${written}"` : written;
}

export function imageMimeForName(name: string): string | null {
  const mime = assetMimeForName(name);
  return IMAGE_ASSET_MIMES.has(mime) ? mime : null;
}

function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  );
}

export async function resolveDroppedUris(
  uris: readonly string[],
  options: DroppedUriOptions,
): Promise<DroppedUriResult> {
  const tokens: string[] = [];
  const images: DroppedImage[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const uri of uris) {
    const path = fileUriToPath(uri, options.platform);
    if (!path) {
      skipped += 1;
      continue;
    }
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    let directory = false;
    try {
      directory = await options.isDirectory(path);
    } catch {
      directory = false;
    }
    const mime = directory ? null : imageMimeForName(path);
    if (mime) {
      images.push({ path, name: baseName(path), mime });
    } else {
      tokens.push(promptPath(path, directory, options.workingDirectory, options.platform));
    }
  }
  return { text: tokens.join(' '), images, skipped };
}
