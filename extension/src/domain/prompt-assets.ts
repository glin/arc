export const MAX_PROMPT_ASSETS = 8;
export const MAX_PROMPT_ASSET_BYTES = 7 * 1024 * 1024;
export const MAX_PROMPT_ASSET_TOTAL_BYTES = 20 * 1024 * 1024;

// Drag types that VS Code sets for an Explorer item or an editor tab, in the order the host reads them.
// VS Code lowercases some of the names, so each compares without case.
export const URI_DRAG_TYPES: readonly string[] = [
  'application/vnd.code.uri-list',
  'resourceurls',
  'codeeditors',
  'text/uri-list',
];
