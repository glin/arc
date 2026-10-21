import type { Browser } from 'playwright-core';
import type { TestObservation } from './observations.mjs';

export function launchAnyBrowser(options?: {
  args?: string[];
  observationParent?: TestObservation | null;
}): Promise<{ browser: Browser; channel: string | undefined } | null>;

export function processExists(pid: number): boolean;
