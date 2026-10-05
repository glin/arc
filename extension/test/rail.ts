// Shared helpers for the rail browser test files.
//
// The tests that drive the rail in a real browser live in `extension/src/rail.*.browser.test.ts`.
// Those files import the page, payload, and selector helpers from here so each one stays a plain list of tests.

import type { Page } from 'playwright-core';
import { SETTLED } from './browser.ts';
import { pageHtml, renderPayload, themed } from '../src/panelfixture.ts';
import { ALL_RAIL_FILTER_ID } from '../src/domain/rail-filters.ts';

export interface RailCard {
  id: string;
  label: string;
  at: number;
  pinnedTop: boolean;
  [key: string]: unknown;
}

export interface PanelPayload extends Record<string, unknown> {
  rail: RailCard[];
  sessions: Array<Record<string, unknown>>;
  showing: string;
  labels: unknown[];
  views: unknown[];
  railFilters: unknown[];
  stats: Record<string, unknown>;
}

// What a name box tells a reader who cannot see the note beside it: the regions the box names,
// whether each one answers, what it reports itself as, and the notes inside it.
interface DescribedNote {
  named: string[];
  answers: number[];
  roles: (string | null)[];
  said: string[];
  invalid: string | null;
}

export function payload(...args: Parameters<typeof renderPayload>): PanelPayload {
  return renderPayload(...args) as PanelPayload;
}

// The fold ids the rail writes on the sections the fixture's saved views produce. A view's
// section is named by the view's own id, so renaming the view keeps the fold the reader set.
// The fixture files s1 under Composer and under Release 0.4, and s2 under Release 0.4 alone.
export const COMPOSER_VIEW = 'railgroup:view:v1';

export const RELEASE_VIEW = 'railgroup:view:v2';

// One control, named by the section its row is drawn under as well as by its session.
// A session two saved views both match draws a card under each of their sections, so a
// selector on the session alone names more than one node and every locator built from it
// fails on the strict mode that stops a guard measuring the wrong card.
export function inSection(section: string, control: string): string {
  return `.railrow[data-rail-bucket="${section}"] [data-control="${control}"]`;
}

// The saved views ride every rail message. The boundary refuses one without them, and a
// refused message reaches no renderer at all, so a guard built on a message missing them
// measures the first render for ever and never the update it was written for.
export function railMessage(base: PanelPayload, rail: RailCard[]): Record<string, unknown> {
  return {
    type: 'rail',
    rail,
    labels: base.labels,
    views: base.views,
    railFilters: base.railFilters,
    stats: base.stats,
    hidden: Array.isArray(base.hidden) ? base.hidden : [],
    pinnedTop: Array.isArray(base.pinnedTop) ? base.pinnedTop : [],
  };
}

// The rail head rests on its counts and its two tools, and the magnifying glass puts the filter
// box in the counts' place. Most of the rail tests measure the box, so each page opens it with the
// magnifying glass over an unfiltered rail. A test that passes its own saved query keeps it, and
// the page then opens on that query with the counts on the head.
const BOX_SEED = { railFilterId: ALL_RAIL_FILTER_ID };

export async function openPage(
  page: Page,
  initial = payload(),
  fixedTime?: number,
  savedState: Record<string, unknown> = {},
): Promise<void> {
  await page.setViewportSize({ width: 1350, height: 900 });
  if (fixedTime !== undefined) {
    await page.clock.setFixedTime(fixedTime);
  }
  const seeded = 'railFilter' in savedState ? savedState : { ...savedState, ...BOX_SEED };
  await page.setContent(
    themed(pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${JSON.stringify(seeded)};`)),
  );
  await page.evaluate(`window.postMessage(${JSON.stringify(initial)}, '*')`);
  await page.evaluate(SETTLED);
  if (seeded !== savedState) {
    await page.locator('[data-control="railsearch"]').click();
    await page.evaluate(SETTLED);
  }
}

export async function postToPage(page: Page, message: unknown): Promise<void> {
  await page.evaluate(`window.postMessage(${JSON.stringify(message)}, '*')`);
  await page.evaluate(SETTLED);
}

// What a box says about the name in it, read the way a screen reader reads it. The note is
// found through the box's own `aria-describedby`, and the region it names must exist and
// report itself. A note drawn beside a box and named by nothing is a note nobody hears.
export async function describedNote(page: Page, selector: string): Promise<DescribedNote> {
  return (await page.evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)});
    const named = (box.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
    const regions = named.map((id) => [...document.querySelectorAll('#' + CSS.escape(id))]);
    return {
      named,
      // Every named id answers exactly once, or the box points at nothing a reader is told.
      answers: regions.map((nodes) => nodes.length),
      roles: regions.map((nodes) => nodes[0] ? nodes[0].getAttribute('role') : null),
      said: regions.flatMap((nodes) => nodes.flatMap((node) =>
        [...node.querySelectorAll('.labelnote')].map((note) => note.textContent))),
      invalid: box.getAttribute('aria-invalid'),
    };
  })()`)) as DescribedNote;
}
