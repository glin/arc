export const COMPRESSED_BATCH_BYTES = 4 * 1024 * 1024;

// Split entries into batches of at most `bytes`. A single larger record forms its own batch.
export function* compressedEntryBatchIterator<T>(
  entries: Iterable<T>,
  bytes = COMPRESSED_BATCH_BYTES,
  separatorBytes = 0,
  measure: (entry: T) => number = (entry) => Buffer.byteLength(JSON.stringify(entry)),
): IterableIterator<T[]> {
  let current: T[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = measure(entry);
    if (current.length && size + separatorBytes + length > bytes) {
      yield current;
      current = [];
      size = 0;
    }
    if (current.length) size += separatorBytes;
    current.push(entry);
    size += length;
  }
  if (current.length) yield current;
}

export function compressedEntryBatches<T>(entries: Iterable<T>, bytes = COMPRESSED_BATCH_BYTES): T[][] {
  return [...compressedEntryBatchIterator(entries, bytes)];
}

// These messages contain JSON-shaped data. Stop counting when the remaining bytes cannot hold the next value.
export function cappedJsonBytes(value: unknown, limit: number): number {
  if (typeof value === 'string') {
    if (value.length + 2 > limit) return limit + 1;
    return Buffer.byteLength(JSON.stringify(value));
  }
  if (value == null || typeof value !== 'object') return Buffer.byteLength(JSON.stringify(value ?? null));

  let bytes = 2;
  let comma = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += comma + cappedJsonBytes(item, limit - bytes - comma);
      if (bytes > limit) return limit + 1;
      comma = 1;
    }
  } else {
    const object = value as Record<string, unknown>;
    for (const key in object) {
      if (!Object.hasOwn(object, key) || object[key] === undefined) continue;
      bytes += comma + cappedJsonBytes(key, limit - bytes - comma) + 1;
      if (bytes > limit) return limit + 1;
      bytes += cappedJsonBytes(object[key], limit - bytes);
      if (bytes > limit) return limit + 1;
      comma = 1;
    }
  }
  return bytes;
}
