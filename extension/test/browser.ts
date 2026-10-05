import { afterAll } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { FIXTURE_CLOCK } from '../src/panelfixture.ts';

// Advances two animation frames. Poll separately for the state produced by native browser events.
export const SETTLED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

async function launchBrowserOrNone(): Promise<Browser | null> {
  // Dynamic import because this file compiles as CommonJS and browserchannels.mjs is an
  // ECMAScript module. test.mjs, which is plain ESM, imports the same module statically.
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
      // The page reads its own clock to file a rail card under a day and to age what it
      // draws, so it starts on the instant the fixture places its cards at. Set before the
      // content, because a clock installed afterwards never reaches what a script already
      // decided.
      await page.clock.install({ time: FIXTURE_CLOCK });
      // Time then runs on from there at the rate of the real clock. A frozen clock never
      // expires an armed press and never lets a cache band end, and guards wait on both.
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
