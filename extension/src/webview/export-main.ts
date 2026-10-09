import { h, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SiteAsset, SiteBlock, SiteCard, SiteFacts, SiteManifest, SiteText } from './export-model.ts';
import { EXPORT_LIMITS } from '../domain/export-limits.ts';
import { createCardRenderer, CardBodyLayout } from './card.ts';
import {
  CARD_LAYOUTS,
  PROMPT_POSITIONS,
  DEFAULT_TIMELINE_LAYOUT,
  TIMELINE_LAYOUT_WORDS,
  timelineLayout,
} from '../view/timeline-layout.ts';
import { matchSessions } from '../domain/session-query.ts';
import { createStatDetailRenderer } from './stat-detail.ts';
import { panelDom, placeFloat } from './dom.ts';
import { createClock } from './clock.ts';
import { exportFactLabel, exportFactValue } from '../view/export-facts.ts';
import {
  emptyTrail,
  visitPlace,
  stepBack,
  stepForward,
  trailPlace,
  canStepBack,
  canStepForward,
} from '../domain/places.ts';

declare global {
  interface Window {
    __arcExportManifest: SiteManifest;
    __arcExportReceive(id: string, data: unknown): void;
    __arcExportMetrics: { loadedBytes: number; retainedBytes: number; cards: number; previewBytes: number };
  }
}

const model = window.__arcExportManifest;
let layout = { ...DEFAULT_TIMELINE_LAYOUT };
let sessionFilter = '';
const metrics = (window.__arcExportMetrics = { loadedBytes: 0, retainedBytes: 0, cards: 0, previewBytes: 0 });
const cache = new Map<string, { data: unknown; bytes: number }>();
let cacheBytes = 0;
const ownedBytes = new Map<string, number>();
function trim() {
  const owned = [...ownedBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
  while (cacheBytes + owned > EXPORT_LIMITS.retainedBytes && cache.size) {
    const key = cache.keys().next().value!;
    cacheBytes -= cache.get(key)!.bytes;
    cache.delete(key);
  }
  metrics.retainedBytes = cacheBytes + owned;
  if (metrics.retainedBytes > EXPORT_LIMITS.retainedBytes)
    throw new Error('Close the recorded detail before opening more text.');
}
function own(key: string, data: unknown) {
  if (data == null) ownedBytes.delete(key);
  else ownedBytes.set(key, new TextEncoder().encode(JSON.stringify(data)).length);
  trim();
}
own('manifest', model);
let activeBody = '';
let activeText = '';
const textChanges = new Set<() => void>();
function activateText(key: string) {
  activeText = key;
  for (const change of textChanges) change();
}
const bodyChanges = new Set<() => void>();
function activateBody(key: string) {
  if (activeBody !== key) activateText('');
  activeBody = key;
  for (const change of bodyChanges) change();
}
const pending = new Map<string, { accept(data: unknown): void }>();
window.__arcExportReceive = (id, data) => pending.get(id)?.accept(data);

function load<T>(asset: SiteAsset, signal?: AbortSignal): Promise<T> {
  if (
    !/^a-[a-z0-9]+\.js$/.test(asset.file) ||
    !/^d[a-z0-9]+$/.test(asset.id) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 0 ||
    asset.bytes > EXPORT_LIMITS.assetBytes
  ) {
    return Promise.reject(new Error('The saved session file is unavailable.'));
  }
  if (signal?.aborted) return Promise.reject(new Error('Loading cancelled.'));
  const held = cache.get(asset.id);
  if (held) {
    cache.delete(asset.id);
    cache.set(asset.id, held);
    return Promise.resolve(held.data as T);
  }
  return new Promise<T>((resolve, reject) => {
    const script = document.createElement('script');
    const done = () => {
      pending.delete(asset.id);
      script.remove();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(new Error('Loading cancelled.'));
    };
    pending.set(asset.id, {
      accept(data) {
        done();
        const previous = cache.get(asset.id);
        if (previous) cacheBytes -= previous.bytes;
        cache.set(asset.id, { data, bytes: asset.bytes });
        cacheBytes += asset.bytes;
        metrics.loadedBytes += asset.bytes;
        trim();
        resolve(data as T);
      },
    });
    script.onerror = () => {
      done();
      reject(new Error('The saved session file did not open.'));
    };
    script.onload = () => {
      if (pending.has(asset.id)) {
        done();
        reject(new Error('The saved session file is incomplete.'));
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    script.src = new URL(`./${asset.file}`, document.baseURI).href;
    document.head.appendChild(script);
  });
}

const WORDS = { prompt: 'You asked', assignment: 'Assigned task', answer: 'Response', commentary: 'Commentary' };

function FullBlock({ block }: { block: SiteBlock }) {
  const [index, setIndex] = useState(-1);
  const [text, setText] = useState<SiteText | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const change = () => {
      if (activeText !== block.key) {
        setIndex(-1);
        setText(null);
      }
    };
    textChanges.add(change);
    return () => {
      textChanges.delete(change);
    };
  }, [block.key]);
  useEffect(() => {
    own(`text:${block.key}`, text);
    return () => own(`text:${block.key}`, null);
  }, [text]);
  useEffect(() => {
    setText(null);
    setError('');
    if (index < 0) return undefined;
    const controller = new AbortController();
    void load<SiteText>(block.chunks[index], controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && activeText === block.key) setText(value);
      },
      (reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      },
    );
    return () => controller.abort();
  }, [index, block.key]);
  return h('section', { class: 'section export-block', 'data-block': block.key }, [
    h('h4', { class: 'sectionheading' }, WORDS[block.kind]),
    h('span', { class: 'dim', title: new Date(block.at).toLocaleString() }, new Date(block.at).toLocaleTimeString()),
    block.notResponse ? h('p', { class: 'dim' }, block.notResponse.replaceAll('-', ' ')) : null,
    index < 0 ? h('p', { class: 'export-plain' }, block.preview) : null,
    text
      ? h('div', { class: 'summary', 'data-full-text': block.key, dangerouslySetInnerHTML: { __html: text.html } })
      : null,
    text ? h('details', {}, [h('summary', {}, 'Recorded text'), h('pre', { class: 'export-plain' }, text.raw)]) : null,
    error ? h('p', { role: 'alert' }, error) : null,
    h('div', { class: 'export-controls' }, [
      index < 0
        ? h(
            'button',
            {
              type: 'button',
              onClick: () => {
                activateText(block.key);
                setIndex(0);
              },
            },
            'Read full text',
          )
        : h('span', { role: 'status' }, text ? `Text ${index + 1} of ${block.chunks.length}` : 'Loading text...'),
      index > 0 ? h('button', { type: 'button', onClick: () => setIndex(index - 1) }, 'Previous text') : null,
      index >= 0 && index + 1 < block.chunks.length
        ? h('button', { type: 'button', onClick: () => setIndex(index + 1) }, 'Next text')
        : null,
    ]),
  ]);
}

function Body({ entry }: { entry: SiteCard }) {
  const [bodyPage, setBodyPage] = useState(-1);
  const [offset, setOffset] = useState(0);
  const [blocks, setBlocks] = useState<SiteBlock[]>([]);
  const [facts, setFacts] = useState<SiteFacts | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = () => {
      if (activeBody !== entry.card.key) {
        setBodyPage(-1);
        setBlocks([]);
        setFacts(null);
        setOffset(0);
      }
    };
    bodyChanges.add(changed);
    return () => {
      bodyChanges.delete(changed);
    };
  }, [entry.card.key]);
  useEffect(() => {
    own(`body:${entry.card.key}`, blocks);
    return () => own(`body:${entry.card.key}`, null);
  }, [blocks]);
  useEffect(() => {
    own(`facts:${entry.card.key}`, facts);
    return () => own(`facts:${entry.card.key}`, null);
  }, [facts]);
  useEffect(() => {
    setBlocks([]);
    setError('');
    if (bodyPage < 0) return undefined;
    const controller = new AbortController();
    void load<SiteBlock[]>(entry.bodies[bodyPage], controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && activeBody === entry.card.key) setBlocks(value);
      },
      (reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      },
    );
    return () => controller.abort();
  }, [bodyPage, entry.card.key]);
  const activity = [
    entry.bodies.length && bodyPage < 0
      ? h(
          'button',
          {
            type: 'button',
            onClick: () => {
              activateBody(entry.card.key);
              setBodyPage(0);
            },
          },
          'Read recorded text',
        )
      : null,
    ...blocks
      .slice(offset, offset + EXPORT_LIMITS.initialCards)
      .map((block) => h(FullBlock, { block, key: block.key })),
    error ? h('p', { role: 'alert' }, error) : null,
    bodyPage >= 0
      ? h('div', { class: 'export-controls' }, [
          h('span', { role: 'status' }, `Session text ${bodyPage + 1} of ${entry.bodies.length}`),
          bodyPage > 0 || offset > 0
            ? h(
                'button',
                {
                  type: 'button',
                  onClick() {
                    if (offset) setOffset(Math.max(0, offset - EXPORT_LIMITS.initialCards));
                    else {
                      setBodyPage(bodyPage - 1);
                      setOffset(0);
                    }
                  },
                },
                'Previous section',
              )
            : null,
          offset + EXPORT_LIMITS.initialCards < blocks.length || bodyPage + 1 < entry.bodies.length
            ? h(
                'button',
                {
                  type: 'button',
                  onClick() {
                    if (offset + EXPORT_LIMITS.initialCards < blocks.length)
                      setOffset(offset + EXPORT_LIMITS.initialCards);
                    else {
                      setBodyPage(bodyPage + 1);
                      setOffset(0);
                    }
                  },
                },
                'Next section',
              )
            : null,
        ])
      : null,
  ];
  const recorded = h(
    'details',
    {
      onToggle(event: Event) {
        if ((event.currentTarget as HTMLDetailsElement).open && !facts) {
          activateBody(entry.card.key);
          void load<SiteFacts>(entry.facts).then(
            (value) => {
              if (activeBody === entry.card.key) setFacts(value);
            },
            (reason: Error) => setError(reason.message),
          );
        }
      },
    },
    [h('summary', {}, 'Recorded figures and changes'), facts ? h(Facts, { value: facts }) : null],
  );
  return h(CardBodyLayout, {
    layout,
    hasRecord: true,
    part(name) {
      if (name === 'prompt')
        return [
          h('section', { class: 'section export-prompt' }, [
            h('h4', { class: 'sectionheading' }, 'Prompt'),
            h('p', { class: 'export-plain' }, entry.card.prompt),
          ]),
        ];
      if (name === 'response')
        return [h('div', { class: 'summary', dangerouslySetInnerHTML: { __html: entry.card.summaryHtml || '' } })];
      if (name === 'activity')
        return [
          h(Relationships, { keys: entry.relationships ?? [] }),
          ...activity,
          ...(layout.cardLayout === 'compact' ? [recorded] : []),
        ];
      return name === 'record' ? [recorded] : [];
    },
  });
}

function Relationships({ keys, parent = false }: { keys: string[]; parent?: boolean }) {
  const edges = model.relationships.filter((edge) => keys.includes(edge.key));
  if (!edges.length) return null;
  return h(
    'nav',
    { class: 'export-relationships', 'aria-label': parent ? 'Parent session' : 'Linked work' },
    edges.map((edge) => {
      const target = model.sessions.find((session) => session.key === (parent ? edge.from : edge.to));
      const name = target?.title ?? edge.label ?? 'Linked session';
      return h('div', { key: edge.key }, [
        target
          ? h(
              'a',
              {
                href: `#${encodeURIComponent(target.key)}${parent && edge.turn ? `/${encodeURIComponent(edge.turn)}` : ''}`,
              },
              parent ? `Parent: ${name}` : name,
            )
          : h('span', {}, name),
        edge.coverage === 'partial'
          ? h('p', { class: 'dim' }, `Work is not included: ${edge.reason?.replaceAll('-', ' ') ?? 'unresolved'}.`)
          : null,
      ]);
    }),
  );
}

const statDetails = createStatDetailRenderer({
  document,
  events: { document: (type, listener, options) => document.addEventListener(type, listener, options) },
  placeFloat: (host, anchor) => placeFloat(window, host, anchor),
});

function Facts({ value, name = '' }: { value: unknown; name?: string }) {
  if (value === null || typeof value !== 'object')
    return h('span', { class: 'export-plain' }, exportFactValue(name, value));
  if (Array.isArray(value))
    return value.length
      ? h(
          'ol',
          { class: 'export-facts-list' },
          value.map((item) => h('li', {}, h(Facts, { value: item, name }))),
        )
      : h('span', {}, 'None recorded');
  return h(
    'dl',
    { class: 'export-facts' },
    Object.entries(value).flatMap(([key, item]) => [
      h('dt', {}, exportFactLabel(key)),
      h('dd', {}, h(Facts, { value: item, name: key })),
    ]),
  );
}

function CaptureFacts({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return h('details', { onToggle: (event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open) }, [
    h('summary', {}, 'Capture details'),
    open ? h(Facts, { value }) : null,
  ]);
}
let entries = new Map<string, SiteCard>();
const cards = createCardRenderer({
  post() {
    throw new Error('This saved session has no editor actions.');
  },
  statDetails,
  layout: () => layout,
  readonlyBody: (card) => h(Body, { entry: entries.get(card.key)! }),
});
const clock = createClock({ document, now: () => model.capturedAt, start() {} });
const header = document.getElementById('export-header')!;
const list = panelDom(document).list;
const sessions = document.getElementById('export-sessions')!;
let trail = emptyTrail();
let controller = new AbortController();
let currentSession = '';
let pageIndex = 0;
let hosts: HTMLElement[] = [];

function navigate(session: string, turn = '') {
  location.hash = `${encodeURIComponent(session)}${turn ? `/${encodeURIComponent(turn)}` : ''}`;
}

function controls() {
  const session = model.sessions.find((item) => item.key === currentSession)!;
  render(
    h('div', { class: 'export-tools' }, [
      h('h1', {}, 'Arc session'),
      h(
        'span',
        { title: new Date(model.capturedAt).toLocaleString() },
        `Captured ${new Date(model.capturedAt).toLocaleString()}`,
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: !canStepBack(trail),
          onClick() {
            trail = stepBack(trail)!;
            navigate(trailPlace(trail)!);
          },
        },
        'Back',
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: !canStepForward(trail),
          onClick() {
            trail = stepForward(trail)!;
            navigate(trailPlace(trail)!);
          },
        },
        'Forward',
      ),
      h('label', {}, [
        'Theme ',
        h(
          'select',
          {
            'aria-label': 'Theme',
            onChange(event: Event) {
              const light = (event.currentTarget as HTMLSelectElement).value === 'light';
              document.documentElement.dataset.theme = light ? 'light' : 'dark';
              document.body.className = `export-page vscode-${light ? 'light' : 'dark'}`;
            },
          },
          [h('option', { value: 'dark' }, 'VS Code dark'), h('option', { value: 'light' }, 'VS Code light')],
        ),
      ]),
      ...(['cardLayout', 'promptPosition'] as const).map((key) =>
        h('label', {}, [
          `${TIMELINE_LAYOUT_WORDS.settings[key]} `,
          h(
            'select',
            {
              'aria-label': TIMELINE_LAYOUT_WORDS.settings[key],
              value: layout[key],
              onChange(event: Event) {
                layout = timelineLayout({ ...layout, [key]: (event.currentTarget as HTMLSelectElement).value });
                void show();
              },
            },
            (key === 'cardLayout' ? CARD_LAYOUTS : PROMPT_POSITIONS).map((value) =>
              h('option', { value }, (TIMELINE_LAYOUT_WORDS.values[key] as Record<string, string>)[value]),
            ),
          ),
        ]),
      ),
      h(CaptureFacts, {
        value: {
          capturedAt: model.capturedAt,
          coverage: model.coverage,
          omissions: model.omissions,
          deliberatelyOmitted: model.deliberatelyOmitted,
          session: {
            key: session.key,
            title: session.title,
            agent: session.agent,
            turnCount: session.turnCount,
            compactionCount: session.compactionCount,
            firstRequestCacheRead: session.firstRequestCacheRead,
            coverage: session.coverage,
            provenance: session.provenance,
            parentOutsideExport: session.parentOutsideExport,
            numbers: session.numbers,
          },
          relationships: model.relationships,
        },
      }),
    ]),
    header,
  );
  render(
    h('div', {}, [
      h('label', {}, [
        'Filter sessions ',
        h('input', {
          type: 'search',
          'aria-label': 'Filter sessions',
          value: sessionFilter,
          onInput(event: Event) {
            sessionFilter = (event.currentTarget as HTMLInputElement).value;
            controls();
          },
        }),
      ]),
      h(
        'nav',
        { 'aria-label': 'Sessions' },
        matchSessions(
          model.sessions.map((item) => ({
            ...item,
            label: item.title,
            costDollars: item.numbers.combined.dollars,
            costAtLeast: item.numbers.combined.partial,
          })),
          sessionFilter,
        ).map((item) =>
          h(
            'a',
            {
              href: `#${encodeURIComponent(item.key)}`,
              'aria-current': item.key === currentSession ? 'page' : undefined,
            },
            item.title,
          ),
        ),
      ),
    ]),
    sessions,
  );
}

async function show() {
  controller.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const [key, turn] = location.hash
    .slice(1)
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    });
  const session =
    model.sessions.find((item) => item.key === key) ?? model.sessions.find((item) => item.key === model.root)!;
  if (session.key !== currentSession) pageIndex = 0;
  currentSession = session.key;
  trail = visitPlace(trail, currentSession);
  const requestedPage = turn ? session.pages.findIndex((page) => page.keys.includes(turn)) : -1;
  if (requestedPage >= 0) pageIndex = requestedPage;
  activateBody('');
  own('page', null);
  statDetails.dismiss();
  for (const host of hosts) cards.remove(host);
  hosts = [];
  entries = new Map();
  list.replaceChildren();
  controls();
  const heading = document.createElement('h2');
  heading.textContent = session.title;
  list.appendChild(heading);
  const parents = document.createElement('div');
  list.appendChild(parents);
  render(
    h(Relationships, {
      keys: model.relationships.filter((edge) => edge.to === currentSession).map((edge) => edge.key),
      parent: true,
    }),
    parents,
  );
  const linked = document.createElement('div');
  list.appendChild(linked);
  render(
    h(Relationships, {
      keys: model.relationships.filter((edge) => edge.from === currentSession && !edge.turn).map((edge) => edge.key),
    }),
    linked,
  );
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading turns...';
  list.appendChild(status);
  try {
    const loaded = session.pages[pageIndex] ? await load<SiteCard[]>(session.pages[pageIndex], signal) : [];
    if (signal.aborted) return;
    own('page', loaded);
    entries = new Map(loaded.map((entry) => [entry.card.key, entry]));
    metrics.cards = loaded.length;
    metrics.previewBytes = new TextEncoder().encode(JSON.stringify(loaded.map((entry) => entry.card))).length;
    status.textContent = `Timeline page ${pageIndex + 1} of ${Math.max(1, session.pages.length)}`;
    for (const entry of loaded) {
      const host = document.createElement('article');
      list.appendChild(host);
      hosts.push(host);
      let expanded = entry.card.key === turn;
      cards.draw(host, entry.card, {
        expandedChanged() {},
        isExpanded: () => expanded,
        setExpanded(value: boolean) {
          expanded = value;
          history.replaceState(
            null,
            '',
            `#${encodeURIComponent(currentSession)}/${encodeURIComponent(entry.card.key)}`,
          );
        },
      });
    }
    const paging = document.createElement('nav');
    paging.className = 'export-controls';
    paging.setAttribute('aria-label', 'Turn pages');
    list.appendChild(paging);
    const move = (label: string, next: number) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = () => {
        pageIndex = next;
        history.replaceState(null, '', `#${encodeURIComponent(currentSession)}`);
        void show();
      };
      paging.appendChild(button);
    };
    if (pageIndex > 0) move('Newer turns', pageIndex - 1);
    if (pageIndex + 1 < session.pages.length) move('Older turns', pageIndex + 1);
    clock.tick(model.capturedAt);
  } catch (error) {
    if (!signal.aborted) status.textContent = error instanceof Error ? error.message : 'The session did not open.';
  }
}
window.addEventListener('hashchange', () => {
  void show();
});
window.addEventListener('pagehide', () => controller.abort(), { once: true });
void show();
