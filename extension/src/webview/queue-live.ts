import { h, render, type ComponentChildren } from 'preact';
import type { CommentRenderer } from './comments.ts';
import { AttachmentFiles } from './attachments.ts';
import type { ComposerLive, ComposerView, PanelToHost, QueuedPrompt } from './protocol.ts';

interface QueueLiveOptions {
  document: Document;
  list: HTMLElement;
  glyphs: Record<string, string>;
  twist: { open: string; shut: string };
  comments: CommentRenderer;
  replaceLive(session: string, live: ComposerLive[]): ComposerView | null;
  sendToHost(message: PanelToHost): void;
  beforeEdit(session: string): number;
  allControls(): HTMLElement[];
  rovingControls(controls?: HTMLElement[]): HTMLElement[];
  setRoving(node: HTMLElement | null, controls?: HTMLElement[]): void;
}

export interface QueueLiveRenderer {
  update(view: ComposerView | null): void;
  applyLive(session: string, live: ComposerLive[]): void;
  takeDraft(session: string): void;
}

export function queueLiveKey(session: string, kind: ComposerLive['kind']): string {
  return `${session}\n${kind}`;
}

function liveKey(session: string, live: ComposerLive): string {
  return `${queueLiveKey(session, live.kind)}\n${live.at}`;
}

function liveIdentity(session: string, live: ComposerLive): string {
  return liveKey(session, live);
}

const LIVE_PREVIEW_CHARS = 400;

function QueueCard(props: {
  view: ComposerView;
  item: QueuedPrompt;
  open: boolean;
  glyphs: Record<string, string>;
  twist: { open: string; shut: string };
  toggle(id: string): void;
  edit(item: QueuedPrompt): void;
  drop(item: QueuedPrompt): void;
  sendToHost(message: PanelToHost): void;
}) {
  const { item, view } = props;
  const actions = h('span', { class: 'cqacts' }, [
    h(
      'button',
      {
        class: 'cqact cwaitingact',
        type: 'button',
        'data-control': item.editControl,
        'aria-label': item.editName,
        onClick() {
          props.edit(item);
        },
      },
      item.editLabel,
    ),
    h(
      'button',
      {
        class: 'cqact cwaitingact',
        type: 'button',
        'data-control': item.copyControl,
        'aria-label': item.copyName,
        onClick() {
          props.sendToHost({ type: 'copy', text: item.copyText });
        },
      },
      item.copyLabel,
    ),
    h(
      'button',
      {
        class: 'cqact cwaitingact',
        type: 'button',
        'data-control': item.dropControl,
        'aria-label': item.dropName,
        onClick() {
          props.drop(item);
        },
      },
      item.dropLabel,
    ),
  ]);
  const disclosure: ComponentChildren = item.long
    ? h(
        'button',
        {
          class: 'cqopen cwaitingact',
          type: 'button',
          'data-control': item.control,
          'aria-label': props.open ? item.shutName : item.openName,
          'aria-expanded': String(props.open),
          onClick() {
            props.toggle(item.id);
          },
        },
        [
          h('span', { class: 'cqchev' }, props.open ? props.twist.shut : props.twist.open),
          h('span', { class: 'cqtext' }, item.label),
        ],
      )
    : h('div', { class: 'headline' }, item.label);
  return h(
    'div',
    {
      class: 'turn running clive cwaiting',
      'data-queued': item.id,
      role: 'status',
    },
    [
      h('div', { class: 'head statichead', 'aria-label': item.headName }, [
        h('span', { class: 'glyph' }, props.glyphs.running),
        h(
          'span',
          { class: 'when', title: item.absolute, 'data-at': item.at ? String(item.at) : undefined },
          item.relative,
        ),
        h('span', { class: 'agent' }, item.agent),
      ]),
      disclosure,
      item.long && props.open ? h('div', { class: 'cqfull' }, item.text) : null,
      item.files.length
        ? h(AttachmentFiles, {
            session: view.sessionId,
            files: item.files,
            removable: false,
            pending: null,
            sendToHost: props.sendToHost,
          })
        : null,
      h('div', { class: 'doing' }, [
        h('span', { class: 'actglyph', 'aria-hidden': 'true' }, props.glyphs.running),
        h('span', { class: 'actverb' }, item.status),
        actions,
      ]),
      item.reason ? h('div', { class: 'clivereason' }, item.reason) : null,
    ],
  );
}

function LiveCard(props: {
  session: string;
  live: ComposerLive;
  open: boolean;
  toggle(): void;
  glyphs: Record<string, string>;
  sendToHost(message: PanelToHost): void;
}) {
  const { live } = props;
  const bodyId = `live-response:${encodeURIComponent(liveIdentity(props.session, live))}`;
  const heading = [
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, props.glyphs[live.tone]),
    h('span', { class: 'when', title: live.absolute, 'data-at': String(live.at) }, live.relative),
    live.agent ? h('span', { class: 'agent' }, live.agent) : null,
    live.model ? h('span', { class: 'model' }, live.model) : null,
  ];
  return h(
    'div',
    {
      class: `turn ${live.tone} clive${props.open ? ' is-open' : ''}`,
      'data-live': live.kind,
      'data-live-at': String(live.at),
    },
    [
      h('div', { class: 'liveheading' }, [
        h(
          live.reply ? 'button' : 'div',
          {
            class: live.reply ? 'head' : 'head livehead',
            type: live.reply ? 'button' : undefined,
            'aria-label': live.reply
              ? `${live.headline ? `${live.headline} ` : ''}${live.label}. ${live.absolute}. ${props.open ? 'Collapse' : 'Expand'} response`
              : live.label,
            'data-hint': live.reply ? `${props.open ? 'Collapse' : 'Expand'} response` : undefined,
            'aria-controls': live.reply ? bodyId : undefined,
            'aria-expanded': live.reply ? String(props.open) : undefined,
            'data-control': live.reply ? `live:${liveIdentity(props.session, live)}:open` : undefined,
            onClick: live.reply ? props.toggle : undefined,
          },
          heading,
        ),
        live.restoreControl
          ? h(
              'button',
              {
                class: 'cliveact cliverestore',
                type: 'button',
                'data-control': live.restoreControl,
                'aria-label': live.restoreName,
                onClick() {
                  props.sendToHost({ type: 'restoreLive', session: props.session, kind: live.kind });
                },
              },
              live.restoreLabel,
            )
          : null,
        live.dismissControl
          ? h(
              'button',
              {
                class: 'cliveact cliveoff',
                type: 'button',
                'data-control': live.dismissControl,
                'aria-label': live.dismissName,
                onClick() {
                  props.sendToHost({ type: 'dismissLive', session: props.session, kind: live.kind });
                },
              },
              live.dismissLabel,
            )
          : null,
      ]),
      live.headline ? h('div', { class: 'headline' }, live.headline) : null,
      live.files.length
        ? h(AttachmentFiles, {
            session: props.session,
            files: live.files,
            removable: false,
            pending: null,
            sendToHost: props.sendToHost,
          })
        : null,
      live.status
        ? h('div', { class: 'doing', role: 'status' }, [
            h('span', { class: 'actglyph', 'aria-hidden': 'true' }, props.glyphs[live.tone]),
            h('span', { class: 'actverb' }, live.status),
            live.since === null
              ? null
              : [' ', h('span', { class: 'actfig', 'data-since': String(live.since), 'aria-hidden': 'true' })],
          ])
        : null,
      live.reason ? h('div', { class: 'clivereason' }, live.reason) : null,
      live.reply
        ? h(
            'div',
            {
              class: 'body summary cliveresponse',
              id: bodyId,
              hidden: !props.open,
              role: 'region',
              'aria-label': 'Response',
            },
            props.open ? live.reply : null,
          )
        : null,
      live.reply
        ? !props.open
          ? h(
              'div',
              { class: 'clivereply', 'aria-hidden': 'true' },
              h('span', { class: 'clivereplytext' }, live.reply.slice(-LIVE_PREVIEW_CHARS).replace(/\s+/g, ' ').trim()),
            )
          : null
        : null,
    ],
  );
}

export function createQueueLiveRenderer(options: QueueLiveOptions): QueueLiveRenderer {
  let accepted: ComposerView | null = null;
  const drawn = new Map<string, ComposerLive>();
  const debt = new Set<string>();
  const queueOpen = new Set<string>();
  const liveOpen = new Set<string>();
  const parentPrints = new WeakMap<HTMLElement, { details: string; replies: string[] }>();
  const liveOrders = new Map<string, string[]>();
  let pendingParent = false;

  const cardNode = (key: string): HTMLElement | null => {
    const [session, kind, at] = key.split('\n');
    for (const parent of options.list.querySelectorAll<HTMLElement>('.transientcards[data-session]')) {
      if (parent.dataset.session !== session) {
        continue;
      }
      for (const node of parent.querySelectorAll<HTMLElement>('.clive:not(.cwaiting)')) {
        if (node.dataset.live === kind && node.dataset.liveAt === at) {
          return node;
        }
      }
    }
    return null;
  };

  const restoreWalk = (focused: string | null, priorStop: HTMLElement | undefined) => {
    const controls = options.allControls();
    const visible = options.rovingControls(controls);
    const restored = focused ? controls.find((control) => control.dataset.control === focused) || null : null;
    const prior = priorStop && priorStop.isConnected && !priorStop.closest('[hidden]') ? priorStop : null;
    const fallback =
      restored || prior || visible.find((control) => options.list.contains(control)) || visible[0] || null;
    if (!fallback) {
      return;
    }
    options.setRoving(fallback, controls);
    if (focused && fallback !== options.document.activeElement) {
      fallback.focus();
    }
  };

  const draw = () => {
    const active = options.document.activeElement as HTMLElement | null;
    const focused = active?.closest('.clive') ? active.dataset.control || null : null;
    const priorStop = options.allControls().find((control) => control.tabIndex === 0);
    const wanted = new Map<string, ComposerLive>();
    if (accepted) {
      for (const live of accepted.live) {
        wanted.set(liveKey(accepted.sessionId, live), live);
      }
    }
    for (const [key] of drawn) {
      if (wanted.has(key)) {
        continue;
      }
      const node = cardNode(key);
      if (node && options.comments.selectionWithin(node)) {
        debt.add(key);
      } else {
        drawn.delete(key);
        debt.delete(key);
      }
    }
    for (const [key, live] of wanted) {
      const node = cardNode(key);
      if (drawn.has(key) && node && options.comments.selectionWithin(node)) {
        debt.add(key);
      } else {
        drawn.set(key, live);
        debt.delete(key);
      }
    }
    const bySession = new Map<string, { queue: QueuedPrompt[]; live: ComposerLive[] }>();
    const ensure = (session: string) => {
      let cards = bySession.get(session);
      if (!cards) {
        cards = { queue: [], live: [] };
        bySession.set(session, cards);
      }
      return cards;
    };
    if (accepted) {
      const cards = ensure(accepted.sessionId);
      cards.queue = [...accepted.queue].reverse();
    }
    const drawnBySession = new Map<string, string[]>();
    for (const key of drawn.keys()) {
      const [session] = key.split('\n');
      const keys = drawnBySession.get(session) || [];
      keys.push(key);
      drawnBySession.set(session, keys);
    }
    for (const [session, keys] of drawnBySession) {
      const selected = [...debt].some((key) => key.startsWith(`${session}\n`));
      const current =
        accepted?.sessionId === session
          ? accepted.live.map((live) => liveKey(session, live)).filter((key) => drawn.has(key))
          : [];
      const prior = (liveOrders.get(session) || []).filter((key) => drawn.has(key));
      const order = selected
        ? [
            ...prior,
            ...current.filter((key) => !prior.includes(key)),
            ...keys.filter((key) => !prior.includes(key) && !current.includes(key)),
          ]
        : [
            ...current,
            ...prior.filter((key) => !current.includes(key)),
            ...keys.filter((key) => !current.includes(key) && !prior.includes(key)),
          ];
      liveOrders.set(session, order);
      ensure(session).live = order.map((key) => drawn.get(key)!).filter(Boolean);
    }
    const parents = [...options.list.querySelectorAll<HTMLElement>('.transientcards[data-session]')];
    pendingParent = [...bySession].some(
      ([session, cards]) =>
        (cards.queue.length > 0 || cards.live.length > 0) &&
        !parents.some((parent) => parent.dataset.session === session),
    );
    for (const parent of parents) {
      const session = parent.dataset.session || '';
      const cards = bySession.get(session) || { queue: [], live: [] };
      const details = JSON.stringify([
        cards.queue,
        cards.live.map(({ reply: _reply, ...live }) => live),
        cards.queue.map((item) => queueOpen.has(item.id)),
        cards.live.map((live) => liveOpen.has(liveIdentity(session, live))),
      ]);
      const replies = cards.live.map((live) => live.reply);
      const priorPrint = parentPrints.get(parent);
      if (
        priorPrint?.details === details &&
        priorPrint.replies.length === replies.length &&
        replies.every((reply, index) => reply === priorPrint.replies[index])
      ) {
        continue;
      }
      render(
        [
          ...cards.queue.map((item) =>
            h(QueueCard, {
              key: `queue:${item.id}`,
              view: accepted!,
              item,
              open: queueOpen.has(item.id),
              glyphs: options.glyphs,
              twist: options.twist,
              sendToHost: options.sendToHost,
              toggle(id: string) {
                if (queueOpen.has(id)) {
                  queueOpen.delete(id);
                } else {
                  queueOpen.add(id);
                }
                draw();
              },
              edit(queued: QueuedPrompt) {
                queueOpen.delete(queued.id);
                const revision = options.beforeEdit(session);
                options.sendToHost({ type: 'editQueued', value: queued.id, session, revision });
                draw();
              },
              drop(queued: QueuedPrompt) {
                queueOpen.delete(queued.id);
                options.sendToHost({ type: 'dequeue', value: queued.id, session });
                draw();
              },
            }),
          ),
          ...cards.live.map((live) =>
            h(LiveCard, {
              key: liveIdentity(session, live),
              session,
              live,
              open: liveOpen.has(liveIdentity(session, live)),
              toggle() {
                const identity = liveIdentity(session, live);
                if (liveOpen.has(identity)) {
                  liveOpen.delete(identity);
                } else {
                  liveOpen.add(identity);
                }
                draw();
              },
              glyphs: options.glyphs,
              sendToHost: options.sendToHost,
            }),
          ),
        ],
        parent,
      );
      parentPrints.set(parent, { details, replies });
    }
    for (const id of [...queueOpen]) {
      if (!accepted?.queue.some((item) => item.id === id)) {
        queueOpen.delete(id);
      }
    }
    const liveIdentities = new Set([...drawn].map(([key, live]) => liveIdentity(key.split('\n')[0], live)));
    for (const identity of liveOpen) {
      if (!liveIdentities.has(identity)) {
        liveOpen.delete(identity);
      }
    }
    restoreWalk(focused, priorStop);
  };

  options.comments.onRelease(() => {
    if (debt.size || pendingParent) {
      queueMicrotask(draw);
    }
  });

  return {
    update(view) {
      accepted = view;
      draw();
    },
    applyLive(session, live) {
      if (!accepted || accepted.sessionId !== session) {
        return;
      }
      accepted = options.replaceLive(session, live) || { ...accepted, live };
      draw();
    },
    takeDraft(session) {
      if (accepted?.sessionId === session) {
        queueOpen.clear();
        draw();
      }
    },
  };
}
