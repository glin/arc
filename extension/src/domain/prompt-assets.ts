export const MAX_PROMPT_ASSETS = 8;
// The size limit for one attached file that is not an image.
export const MAX_PROMPT_ASSET_BYTES = 7 * 1024 * 1024;
// The size limit for one attached image. Claude Code shrinks images before it sends or saves them, and Codex reads them from their staged path.
export const MAX_PROMPT_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_PROMPT_ASSET_TOTAL_BYTES = 100 * 1024 * 1024;
// Claude Code drops PDFs without an error once the PDFs of one prompt total more than about 16 MiB.
export const MAX_CLAUDE_PDF_TOTAL_BYTES = 16 * 1024 * 1024;

export const IMAGE_ASSET_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'text/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

export function normalizeAssetMime(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const mime = raw.trim().toLowerCase();
  return mime.length <= 127 && MIME.test(mime) ? mime : null;
}

// The extension of the last path segment, lowercased. The segment starts after the last `/` or `\`, on every platform. A name that starts with its only dot has none.
function nameExtension(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function assetMimeForName(name: string): string {
  return MIME_BY_EXTENSION[nameExtension(name)] ?? 'application/octet-stream';
}

export function browserAssetMime(name: string, reported: string): string {
  const named = assetMimeForName(name);
  return named !== 'application/octet-stream' ? named : (normalizeAssetMime(reported) ?? 'application/octet-stream');
}

export interface AssetBatchLimits {
  count: number;
  // The limit for one file that is not an image.
  fileBytes: number;
  imageBytes: number;
  totalBytes: number;
}

export const PROMPT_ASSET_LIMITS: AssetBatchLimits = {
  count: MAX_PROMPT_ASSETS,
  fileBytes: MAX_PROMPT_ASSET_BYTES,
  imageBytes: MAX_PROMPT_IMAGE_BYTES,
  totalBytes: MAX_PROMPT_ASSET_TOTAL_BYTES,
};

// The size limit for one attached file of this media type.
export function promptAssetByteLimit(mime: string, limits: AssetBatchLimits = PROMPT_ASSET_LIMITS): number {
  return IMAGE_ASSET_MIMES.has(mime) ? limits.imageBytes : limits.fileBytes;
}

export interface AssetBatchRefusal {
  code: 'count' | 'image-size' | 'file-size' | 'total-size';
  name: string;
  // The offending file size for `image-size` and `file-size`, and the combined size for `total-size`. Zero for `count`.
  size: number;
  // The number of incoming files for `count`. Zero otherwise.
  rejected: number;
}

// Decide from sizes alone whether a batch fits beside the files already held. The first limit that fails wins, in the order count, file size, total size.
export function assetBatchRefusal(
  existing: readonly { size: number }[],
  incoming: readonly { name: string; mime: string; size: number }[],
  limits: AssetBatchLimits = PROMPT_ASSET_LIMITS,
): AssetBatchRefusal | null {
  if (existing.length + incoming.length > limits.count) {
    return { code: 'count', name: '', size: 0, rejected: incoming.length };
  }
  const tooLarge = incoming.find((file) => file.size > promptAssetByteLimit(file.mime, limits));
  if (tooLarge) {
    const code = IMAGE_ASSET_MIMES.has(tooLarge.mime) ? 'image-size' : 'file-size';
    return { code, name: tooLarge.name, size: tooLarge.size, rejected: 0 };
  }
  const total = [...existing, ...incoming].reduce((sum, file) => sum + file.size, 0);
  return total > limits.totalBytes ? { code: 'total-size', name: '', size: total, rejected: 0 } : null;
}

// Drag types that VS Code sets for an Explorer item or an editor tab, in the order the host reads them.
// VS Code lowercases some of the names, so each compares without case.
export const URI_DRAG_TYPES: readonly string[] = [
  'application/vnd.code.uri-list',
  'resourceurls',
  'codeeditors',
  'text/uri-list',
];
