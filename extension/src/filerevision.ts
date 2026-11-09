import type fs from 'node:fs';
import type { FileRevision } from './transcript';

export function fileIdentityValue(value: unknown, positive = false): boolean {
  return typeof value === 'string'
    ? (positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/).test(value)
    : typeof value === 'number' && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

export function revisionOf(stat: fs.Stats | fs.BigIntStats): FileRevision {
  const size =
    typeof stat.size === 'bigint'
      ? stat.size >= 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(stat.size)
        : -1
      : stat.size;
  const ns = (stat as fs.BigIntStats).mtimeNs;
  const mtimeMs =
    typeof stat.mtimeMs === 'bigint'
      ? ns === undefined
        ? Number(stat.mtimeMs)
        : Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000
      : stat.mtimeMs;
  return {
    size,
    mtimeMs,
    dev: typeof stat.dev === 'bigint' ? stat.dev.toString() : stat.dev,
    ino: typeof stat.ino === 'bigint' ? stat.ino.toString() : stat.ino,
  };
}

export function supportedFileIdentity(value: { dev?: unknown; ino?: unknown }): boolean {
  return fileIdentityValue(value.dev) && fileIdentityValue(value.ino, true);
}

// The file stat that qualifies a saved opening.
export interface OpeningStat {
  size: number;
  mtimeMs: number;
  dev?: number | string;
  ino?: number | string;
}

// The working directory that the opening of a Claude transcript named, with the stat of the file that the listing took.
export interface SavedClaudeOpening extends OpeningStat {
  cwd: string;
}

// Reports whether an opening saved at one file stat still answers for the file at `stat`.
// With a device and inode on both sides, they must match, the file must not shrink, and a file of the same size must
// keep its modification time. So a replaced or shrunk file, or a rewrite at the same size, needs another read.
// Growth with the same identity keeps the opening.
// A saved stat without an inode takes a current inode only at the same size and modification time.
// Without an inode on either side, growth also needs a modification time that does not move backwards.
// A saved inode with no current inode needs another read.
export function savedOpeningCurrent(saved: OpeningStat, stat: OpeningStat): boolean {
  const savedIdentity = supportedFileIdentity(saved);
  const currentIdentity = supportedFileIdentity(stat);
  if (!savedIdentity && currentIdentity) return stat.size === saved.size && stat.mtimeMs === saved.mtimeMs;
  if (stat.size < saved.size) return false;
  const unmoved = stat.size > saved.size || stat.mtimeMs === saved.mtimeMs;
  if (savedIdentity && currentIdentity)
    return String(stat.dev) === String(saved.dev) && String(stat.ino) === String(saved.ino) && unmoved;
  return !savedIdentity && stat.mtimeMs >= saved.mtimeMs && unmoved;
}

// Reports whether a saved opening still answers for a Claude parent transcript at `stat`.
// Without an inode, an append and a replacement that grew have the same stat, so the size and modification time must match.
export function savedParentOpeningCurrent(saved: OpeningStat, stat: OpeningStat): boolean {
  return (
    savedOpeningCurrent(saved, stat) &&
    (supportedFileIdentity(stat) || (stat.size === saved.size && stat.mtimeMs === saved.mtimeMs))
  );
}
