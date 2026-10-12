import { afterAll } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { FIXTURE_CLOCK } from '../src/panelfixture.ts';

// Advances two animation frames. Poll separately for the state produced by native browser events.
export const SETTLED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

// Freeze Date before pausing timers. Restore advancing Date for subsequent runFor calls.
export async function pauseClock(page: Page): Promise<number> {
  const time = (await page.evaluate('Date.now()')) as number;
  await page.clock.setFixedTime(time);
  await page.clock.pauseAt(time);
  await page.clock.setSystemTime(time);
  return time;
}

async function launchBrowserOrNone(): Promise<Browser | null> {
  // CommonJS requires a dynamic import for browserchannels.mjs. The ESM test runner imports it statically.
  const { launchAnyBrowser } = await import('./browserchannels.mjs');
  const result = await launchAnyBrowser();
  return result?.browser ?? null;
}

export interface TestBrowser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

let browserLaunch: Promise<Browser | null> | null = null;

// Each test has a fresh context, while the process shares browser startup work.
export async function browserOrNone(): Promise<TestBrowser | null> {
  browserLaunch ??= launchBrowserOrNone();
  const browser = await browserLaunch;
  if (!browser) {
    return null;
  }
  const contexts: BrowserContext[] = [];
  return {
    async newPage(): Promise<Page> {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      // Install the fixture clock before page content so session grouping and relative ages use the same starting instant.
      await page.clock.install({ time: FIXTURE_CLOCK });
      // Resume the clock so armed presses and cache bands expire during tests.
      await page.clock.resume();
      return page;
    },
    async close(): Promise<void> {
      await Promise.all(contexts.map((context) => context.close()));
    },
  };
}

afterAll(async () => {
  const browser = await browserLaunch;
  await browser?.close();
});
