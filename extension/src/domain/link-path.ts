// A Windows drive path names a local file. Every other RFC-style scheme names a URI.
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isLocalLinkPath(link: string): boolean {
  const written = link.trimStart();
  return WINDOWS_DRIVE_PATH.test(written) || !URI_SCHEME.test(written);
}

export type LinkDestination = { kind: 'url'; url: string } | { kind: 'path' | 'fileCitation'; path: string };
export type LinkOpening = 'integrated' | 'external' | 'default';

export function linkTargetIsHtml(target: string): boolean {
  return /\.html?$/i.test(target);
}

// Explicit browser actions require an authority as written, before URL normalization.
export function webLinkUrl(raw: string): boolean {
  if (!/^https?:\/\/[^\s/\\?#]+(?:[/?#]|$)/i.test(raw) || /[\u0000-\u001f\u007f\\]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

export function parseLinkDestination(raw: unknown): LinkDestination | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === 'url' && typeof value.url === 'string' && webLinkUrl(value.url))
    return { kind: 'url', url: value.url };
  if ((value.kind === 'path' || value.kind === 'fileCitation') && typeof value.path === 'string' && value.path)
    return { kind: value.kind, path: value.path };
  return null;
}

export function linkBrowserKind(destination: LinkDestination): 'web' | 'html' | null {
  if (destination.kind === 'url') return webLinkUrl(destination.url) ? 'web' : null;
  // Keep line suffixes aligned with linkLocation in transcript.ts.
  const target =
    destination.kind === 'fileCitation'
      ? destination.path
      : destination.path.replace(/#L\d+(?:-L?\d+)?$|:\d+(?::\d+)?$/, '');
  if (destination.kind === 'path' && !isLocalLinkPath(target)) return null;
  return linkTargetIsHtml(target) ? 'html' : null;
}
