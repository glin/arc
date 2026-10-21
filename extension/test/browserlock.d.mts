import type { TestObservation } from './observations.mjs';

export function acquireBrowserLock(options?: {
  deadlineMs?: number;
  label?: string;
  observation?: TestObservation | null;
}): Promise<{ release(): boolean }>;
