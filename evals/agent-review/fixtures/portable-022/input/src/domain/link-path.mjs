const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
function isLocalLinkPath(link) {
  const written = link.trimStart();
  return WINDOWS_DRIVE_PATH.test(written) || !URI_SCHEME.test(written);
}
export {
  isLocalLinkPath
};
