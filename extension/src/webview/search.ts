// Content search state and results. Replies must match the pending query.
// Selecting a session clears results and stops waiting for a reply.

import { type ComponentChild, h, render } from 'preact';
import { FIND_PREFIX, isSearch } from '../domain/session-query.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import type { SearchHit } from './protocol.ts';

export type { SearchHit } from './protocol.ts';

// Scope used when a reply names an unknown search scope.
export const DEFAULT_SEARCH_SCOPE = 'workspace';

interface SearchWords {
  searchEmptyByScope: Record<string, string | undefined>;
  searchCountByScope: Record<string, string | undefined>;
  searchWorking: string;
  searchWorkingScoped: string;
  searchPrompt: string;
  searchSummary: string;
}

function searchWords(): SearchWords {
  return CARD_ACTIONS;
}

export interface SearchRendererOptions {
  document: Document;
  sendToHost(
    message: { type: 'search'; text: string; retained?: boolean } | { type: 'showSession'; session: string },
  ): void;
}

export interface SearchRenderer {
  // Stable timeline container. Unchanged results retain their rows across draws.
  element: HTMLElement;
  // Turn a plain query into a content search and ask for it.
  start(query: string): void;
  // Re-evaluate active results after the scoped catalog changes.
  refresh(): void;
  // Accept a pending query's reply and report whether it was accepted.
  accept(query: string, scope: string, hits: readonly SearchHit[]): boolean;
  // Dismiss results and pending replies. Keep the query for another search.
  clear(): void;
  // Clear the query, results, pending reply, and scope.
  reset(): void;
  // Draw current results or progress. Return whether search occupies the timeline.
  draw(showing: string): boolean;
}

function snippetLine(snippet: string, ranges: readonly (readonly [number, number])[]) {
  // The host supplies match ranges so highlighting uses the search's matching rules.
  const parts: ComponentChild[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range[0] > at) {
      parts.push(snippet.slice(at, range[0]));
    }
    parts.push(h('span', { class: 'hl', key: `hl${range[0]}` }, snippet.slice(range[0], range[1])));
    at = range[1];
  }
  if (at < snippet.length) {
    parts.push(snippet.slice(at));
  }
  return h('div', { class: 'resultsnippet' }, parts);
}

function Results({ hits, scope, press }: { hits: readonly SearchHit[]; scope: string; press(hit: SearchHit): void }) {
  // Results carry their scope. Session selection can change while a search runs.
  if (!hits.length) {
    return h('div', { class: 'results' }, h('p', { class: 'empty' }, searchWords().searchEmptyByScope[scope]));
  }
  const counted = searchWords().searchCountByScope[scope];
  return h('div', { class: 'results' }, [
    h(
      'div',
      { class: 'resultcount', key: 'count' },
      `${hits.length}${hits.length === 1 ? ' turn' : ' turns'}${counted ? ` ${counted}` : ''}`,
    ),
    ...hits.map((hit) =>
      h(
        'button',
        {
          class: 'result',
          key: hit.key,
          type: 'button',
          'data-control': `result:${hit.key}`,
          // The button's name replaces its descendant text in the accessibility tree.
          'aria-label': `${hit.sessionTitle}, ${hit.when}, ${hit.snippet}`,
          onClick() {
            press(hit);
          },
        },
        [
          h('div', { class: 'resulthead' }, [
            h('span', { class: 'resultname' }, hit.sessionTitle),
            h('span', { class: 'resultwhen' }, hit.when),
          ]),
          h('div', { class: 'resultmeta' }, [
            h('span', {}, hit.agent),
            h('span', {}, hit.where === 'prompt' ? searchWords().searchPrompt : searchWords().searchSummary),
          ]),
          snippetLine(hit.snippet, hit.ranges ?? []),
        ],
      ),
    ),
  ]);
}

function Working({ showing }: { showing: string }) {
  // A selected session uses scoped progress wording.
  return h('p', { class: 'empty' }, showing ? searchWords().searchWorkingScoped : searchWords().searchWorking);
}

export function createSearchRenderer(options: SearchRendererOptions): SearchRenderer {
  const element = options.document.createElement('div');
  element.className = 'searchowner';
  // Pending query text stays local to this page.
  let query = '';
  // Dismissal rejects replies even when their query text matches.
  let working = false;
  let hits: readonly SearchHit[] | null = null;
  let scope: string = DEFAULT_SEARCH_SCOPE;

  const ask = (text: string, retained = false) => {
    query = text;
    // The shared grammar decides whether to wait for search results.
    working = isSearch(text);
    if (!working) {
      hits = null;
    }
    options.sendToHost({ type: 'search', text, ...(retained ? { retained: true } : {}) });
  };

  const press = (hit: SearchHit) => {
    hits = null;
    working = false;
    options.sendToHost({ type: 'showSession', session: hit.sessionId });
  };

  return {
    element,
    start(text) {
      // Use the content-search prefix from the shared grammar.
      ask(`${FIND_PREFIX}: ${text}`);
    },
    refresh() {
      if (!hits && !working) return;
      hits = null;
      ask(query, true);
    },
    accept(replyQuery, replyScope, replyHits) {
      // Reject replies for an older query or a dismissed search.
      if (replyQuery !== query) {
        return false;
      }
      if (!working) {
        return false;
      }
      hits = replyHits;
      scope = searchWords().searchEmptyByScope[replyScope] ? replyScope : DEFAULT_SEARCH_SCOPE;
      working = false;
      return true;
    },
    clear() {
      hits = null;
      working = false;
    },
    reset() {
      query = '';
      hits = null;
      working = false;
      scope = DEFAULT_SEARCH_SCOPE;
    },
    draw(showing) {
      if (hits) {
        render(h(Results, { hits, scope, press }), element);
        return true;
      }
      if (working) {
        render(h(Working, { showing }), element);
        return true;
      }
      render(null, element);
      return false;
    },
  };
}
