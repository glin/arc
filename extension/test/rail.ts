// Shared page, payload, and selector helpers for session-list browser tests.

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

// Description targets, roles, text, and validation state linked to a name field.
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

// View IDs identify section folds independently of view names.
// The fixture puts s1 in Composer and Release 0.4, and s2 in Release 0.4.
export const COMPOSER_VIEW = 'railgroup:view:v1';

export const RELEASE_VIEW = 'railgroup:view:v2';

// Select a control within one section.
// A session can appear in multiple views, so its control alone does not identify one element.
export function inSection(section: string, control: string): string {
  return `.railrow[data-rail-bucket="${section}"] [data-control="${control}"]`;
}

// Include saved views in each session-list update. The message boundary rejects updates without them.
export function railMessage(base: PanelPayload, rail: RailCard[]): Record<string, unknown> {
  return {
    type: 'rail',
    rail,
    labels: base.labels,
    views: base.views,
    railFilters: base.railFilters,
    queryContext: base.queryContext,
    stats: base.stats,
    hidden: Array.isArray(base.hidden) ? base.hidden : [],
    pinnedTop: Array.isArray(base.pinnedTop) ? base.pinnedTop : [],
  };
}

// Seed an unfiltered session list when the caller supplies no saved query.
// openPage then opens the filter box. A supplied query keeps the saved state.
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

// Read description targets through aria-describedby, including their text, roles, and match counts.
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
