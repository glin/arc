import type { TestObservation } from './observations.mjs';

export interface BrowserLockOwner {
  pid: number;
  cwd?: string;
  startedAt?: string;
  command?: string;
}

// held is false while the lock is free and earlier queued runs go first.
export interface BrowserLockWait {
  owner: BrowserLockOwner | null;
  held: boolean;
  ahead: number;
  waitedMs: number;
}

// The rejection when the wait reaches its deadline.
export interface BrowserLockTimeout extends Error {
  code: 'ARC_LOCK_TIMEOUT';
  owner: BrowserLockOwner | null;
  held: boolean;
  ahead: number;
}

// The rejection when the signal aborts the wait.
export interface BrowserLockCancelled extends Error {
  code: 'ARC_LOCK_CANCELLED';
}

interface BrowserLockOptions {
  deadlineMs?: number;
  label?: string;
  observation?: TestObservation | null;
  onWaiting?: ((wait: BrowserLockWait) => void) | null;
  signal?: AbortSignal | null;
}

export function acquireBrowserLock(options?: BrowserLockOptions): Promise<{ release(): boolean }>;

export function acquireBrowserLock(
  options: BrowserLockOptions & { tryOnly: true },
): Promise<{ release(): boolean } | null>;
