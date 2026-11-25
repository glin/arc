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
