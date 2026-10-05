// The panel's content search: the query it waits on, the answer it accepts, and the list it
// draws the hits in.
//
// Nothing on screen starts a search yet. The box that did is gone, and the rail's advanced
// search will own what replaces it. This owner holds the door that control will press, so the
// engine does not rot in the meantime.
//
// The reply arrives long after the ask, because reading every session in a large workspace
// takes about a second and a half and blocks the extension host for all of it. So the query is
// kept, and an answer is taken only while it is still the query the panel is waiting on and
// still wanted. A reader who chooses a session has dismissed the search, and a reply that
// lands after that press must not draw itself over the session they chose.

import { type ComponentChild, h, render } from 'preact';
import { FIND_PREFIX, isSearch } from '../domain/session-query.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import type { SearchHit } from './protocol.ts';

export type { SearchHit } from './protocol.ts';

// What the search was actually run over. It arrives with the results rather than being read
// off the session on screen, because that pin can move while a reply is in flight and the
// answer belongs to the search that ran. The extension names it and this file only indexes by
// it, so an unknown name falls back to the workspace wording.
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
  sendToHost(message: { type: 'search'; text: string } | { type: 'showSession'; session: string }): void;
}

export interface SearchRenderer {
  // The one node the timeline is handed. It is created once and never replaced, so a result
  // row survives every repaint that does not change the hits.
  element: HTMLElement;
  // Turn a plain query into a content search and ask for it.
  start(query: string): void;
  // Take a reply. Answers whether it was accepted, so a refused one can be told from a
  // drawn one.
  accept(query: string, scope: string, hits: readonly SearchHit[]): boolean;
  // A session was chosen. The results go, because the render that follows would draw this
  // same list again and nothing would appear to happen. The query stays: it is what found
  // the session, and running it again is the way back.
  clear(): void;
  // Everything this panel remembers, emptied. The query goes with the results, because the
  // control that would run it again is empty too.
  reset(): void;
  // Draw the current state and answer whether search owns the timeline column.
  draw(showing: string): boolean;
}

function snippetLine(snippet: string, ranges: readonly (readonly [number, number])[]) {
  // The positions arrive on the hit, worked out beside the search itself, so the panel holds
  // no copy of the matching rule and the marks cannot disagree with what the search read.
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
  // The scoped wording follows the results, not the pin: "no turn says that" over a
  // workspace and over one session are different claims.
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
          // The whole row, in the order the eye reads it. The spans inside are not announced,
          // because this name replaces them.
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
  // While one session is pinned the search reads it alone, so the busy line must not promise
  // the whole workspace.
  return h('p', { class: 'empty' }, showing ? searchWords().searchWorkingScoped : searchWords().searchWorking);
}

export function createSearchRenderer(options: SearchRendererOptions): SearchRenderer {
  const element = options.document.createElement('div');
  element.className = 'searchowner';
  // The query whose reply is still wanted. It is transient, not panel state: nothing saves it
  // and nothing restores it.
  let query = '';
  // Whether an answer is still wanted. It is also the gate on replies: a reply for a query the
  // reader has dismissed carries the same text as the one they asked for.
  let working = false;
  let hits: readonly SearchHit[] | null = null;
  let scope: string = DEFAULT_SEARCH_SCOPE;

  const ask = (text: string) => {
    query = text;
    // The shared query rule decides what a query is. This only decides whether to say the
    // panel is busy, and being wrong about that costs a message shown or not shown for an
    // instant.
    working = isSearch(text);
    if (!working) {
      hits = null;
    }
    options.sendToHost({ type: 'search', text });
  };

  const press = (hit: SearchHit) => {
    hits = null;
    working = false;
    options.sendToHost({ type: 'showSession', session: hit.sessionId });
  };

  return {
    element,
    start(text) {
      // The word comes from the shared grammar, so this cannot type one the parser does not
      // read.
      ask(`${FIND_PREFIX}: ${text}`);
    },
    accept(replyQuery, replyScope, replyHits) {
      // Only while it still answers the pending query. A slow search finishing after a newer
      // ask would otherwise draw results for a query nobody wants.
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
