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
