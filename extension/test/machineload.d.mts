import type { TestObservation } from './observations.mjs';

export const HEAVY_LANES: readonly string[];

export function laneLockPath(lane: string, directory?: string): string;

export function loadSettings(env?: NodeJS.ProcessEnv): { deadlineMs: number; floorGb: number | null };

export function freeMemoryBytes(options?: {
  platform?: NodeJS.Platform;
  readText?: (file: string) => string;
  run?: (command: string, args: string[]) => string;
  osFree?: () => number;
}): number;

// Takes every heavy lane lock. It refuses inside a test run.
export function acquireHeavyLaneLocks(options?: {
  env?: NodeJS.ProcessEnv;
  observation?: TestObservation | null;
}): Promise<{ release(): void }>;

// Resolves null when the signal aborts the wait.
export function acquireLaneLock(options: {
  lane: string;
  label?: string;
  deadlineMs?: number;
  env?: NodeJS.ProcessEnv;
  command?: string;
  observation?: TestObservation | null;
  signal?: AbortSignal | null;
}): Promise<{ nested: boolean; release(): boolean } | null>;
