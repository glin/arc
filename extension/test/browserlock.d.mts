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

interface BrowserLockOptions {
  deadlineMs?: number;
  label?: string;
  observation?: TestObservation | null;
  onWaiting?: ((wait: BrowserLockWait) => void) | null;
}

export function acquireBrowserLock(options?: BrowserLockOptions): Promise<{ release(): boolean }>;

export function acquireBrowserLock(
  options: BrowserLockOptions & { tryOnly: true },
): Promise<{ release(): boolean } | null>;
