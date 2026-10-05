// A Windows drive path names a local file. Every other RFC-style scheme names a URI.
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isLocalLinkPath(link: string): boolean {
  const written = link.trimStart();
  return WINDOWS_DRIVE_PATH.test(written) || !URI_SCHEME.test(written);
}
