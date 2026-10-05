import type { Browser } from 'playwright-core';

export function launchAnyBrowser(options?: {
  args?: string[];
}): Promise<{ browser: Browser; channel: string | undefined } | null>;

export function processExists(pid: number): boolean;
