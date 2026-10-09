import { createStatDetailRenderer, type StatDetailRenderer, type StatDetailList } from './stat-detail.ts';
import type { ContextDetail } from '../domain/context-detail.ts';
import { placeFloat } from './dom.ts';
import { ChoicePicker, initializeChoicePickers } from './choice-picker.ts';
import { h, render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { UsageBar } from '../view/usage.ts';
import { CONTEXT_CLASSES } from '../view/card-presentation.ts';
import type { ComposerView, Menu, PanelToHost } from './protocol.ts';
import { found } from './dom.ts';

const CHOSEN = '\u2713';
const TWIST = { open: '\u25BE', shut: '\u25B8' };

interface ControlsOptions {
  document: Document;
  selectionWithin?(node: HTMLElement): boolean;
  contextDetails?: StatDetailRenderer;
  contextList?(): StatDetailList;
  releaseContext?(): void;
  mount: HTMLElement;
  composer: HTMLElement;
  events: {
    document(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    window(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
  sendToHost(message: PanelToHost): void;
  action(view: ComposerView, current?: HTMLElement): HTMLElement;
  afterDraw(): void;
  announce(words: string): void;
}

export interface ComposerControlsRenderer {
  receiveContext(detail: ContextDetail): void;
  statusBar: HTMLElement;
  usagePopover: HTMLElement;
  pickPopover: HTMLElement;
  update(bar: UsageBar | null, view: ComposerView | null, menus: Record<string, Menu>): void;
  openPick(control: string): void;
  place(): void;
  contains(node: Node): boolean;
  setHidden(hidden: boolean): void;
  ownsPickerFocus(node: Node): boolean;
}

function UsageBriefView(props: { brief: UsageBar['briefs'][number] }): ComponentChildren {
  return h('span', { class: 'sbagent' }, [
    h('span', { class: 'sbwho' }, props.brief.label),
    ...props.brief.figures.flatMap((figure, index) => [
      index ? h('span', { class: 'sbsep' }, '\u00B7') : null,
      h('span', { class: `sbpct${figure.level ? ` ${CONTEXT_CLASSES[figure.level]}` : ''}` }, `${figure.percent}%`),
      h('span', { class: 'sbunit' }, figure.unit),
    ]),
  ]);
}

function UsageOpenView(props: { bar: UsageBar; sendToHost(message: PanelToHost): void }): ComponentChildren {
  return h('div', { class: 'sbopen' }, [
    ...props.bar.groups.map((group) =>
      h(
        'div',
        {
          class: 'sbgroup',
          key: group.agent,
          role: 'group',
          'aria-label': [group.label, group.exact].filter(Boolean).join(', '),
        },
        [
          h('div', { class: 'sbhead' }, [
            h('span', {}, group.label),
            group.plan ? [' ', h('span', { class: 'sbplan' }, group.plan)] : null,
          ]),
          group.status ? h('div', { class: 'pickwhy', style: { overflowWrap: 'anywhere' } }, group.status) : null,
          ...group.lines.map((line) => {
            const band = line.level ? CONTEXT_CLASSES[line.level] : '';
            return h('div', { class: 'sbline', key: line.key, title: line.name }, [
              h('span', { class: 'sblabel' }, line.label),
              ' ',
              h(
                'span',
                { class: `sbbar${band ? ` ${band}` : ''}`, 'aria-hidden': 'true' },
                h('i', { style: { width: `${line.fill}%` } }),
              ),
              h('span', { class: `sbpct${band ? ` ${band}` : ''}` }, `${line.percent}%`),
              line.resets ? [' ', h('span', { class: 'sbreset', title: line.resetsExact }, line.resets)] : null,
              line.detail ? [' ', h('span', { class: 'sbdetail' }, line.detail)] : null,
            ]);
          }),
        ],
      ),
    ),
    h(
      'button',
      {
        class: 'sbread',
        key: 'read',
        type: 'button',
        'aria-label': [props.bar.read, props.bar.refresh?.name].filter(Boolean).join('. '),
        'aria-disabled': String(props.bar.refresh?.busy ?? false),
        'aria-busy': String(props.bar.refresh?.busy ?? false),
        'data-control': 'usage:read',
        onClick() {
          if (props.bar.refresh?.busy) return;
          props.sendToHost({ type: 'refreshUsage', agent: null, force: true });
        },
      },
      props.bar.read,
    ),
  ]);
}

function PickRow(props: {
  item: Menu['items'][number];
  menu: Menu;
  allStatus: boolean;
  close(): void;
  redraw(): void;
  composer: HTMLElement;
  popover: HTMLElement;
  sendToHost(message: PanelToHost): void;
}): ComponentChildren {
  const { item, menu } = props;
  const kind = item.kind as string;
  const status = kind === 'status';
  const toggle = kind === 'toggle';
  const action = kind === 'action';
  const role = status
    ? props.allStatus
      ? 'listitem'
      : undefined
    : action
      ? 'menuitem'
      : toggle
        ? 'menuitemcheckbox'
        : 'menuitemradio';
  const attributes = {
    class: `pickrow${status ? ' status' : ''}${item.caution ? ' caution' : ''}`,
    role,
    'aria-label': item.name,
    'aria-checked': action || status ? undefined : String(item.checked),
    'data-control': status ? undefined : `${menu.control}:${item.value}`,
  };
  const children = [
    h('span', { class: 'picktick' }, !action && !status && item.checked ? CHOSEN : ''),
    h('span', { class: 'pickbody' }, [
      h('span', { class: 'pickname' }, item.label),
      item.description ? h('span', { class: 'pickwhy' }, item.description) : null,
    ]),
  ];
  if (status) {
    return h('div', attributes, children);
  }
  return h(
    'button',
    {
      ...attributes,
      type: 'button',
      onClick() {
        if (!toggle) {
          props.close();
        }
        props.sendToHost({
          type: 'pick',
          control: menu.control,
          agent: menu.agent,
          session: menu.session ?? '',
          model: menu.model ?? '',
          value: item.value,
        });
        props.redraw();
        setTimeout(() => {
          const back = toggle
            ? found(props.popover, `${menu.control}:${item.value}`)
            : found(props.composer, menu.control);
          back?.focus();
        }, 0);
      },
    },
    children,
  );
}

function ControlsView(props: {
  bar: UsageBar | null;
  view: ComposerView | null;
  menus: Record<string, Menu>;
  openPick: string | null;
  usagePinned: boolean;
  usageHovered: boolean;
  options: ControlsOptions;
  statusBar: HTMLElement;
  usagePopover: HTMLElement;
  pickPopover: HTMLElement;
  setOpenPick(value: string | null): void;
  setUsagePinned(value: boolean): void;
  setUsageHovered(value: boolean): void;
  redraw(): void;
}): ComponentChildren {
  const shown = props.usagePinned || props.usageHovered;
  const extras = useRef<HTMLSpanElement>(null);
  const contextOwner = useRef<{
    session: string;
    kind: string;
    node: HTMLButtonElement | HTMLSpanElement;
  } | null>(null);
  const actionOwner = useRef<{ session: string; kind: string; node: HTMLElement } | null>(null);
  const sendOver = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const slot = extras.current;
    if (!slot || !props.view) {
      contextOwner.current = null;
      actionOwner.current = null;
      sendOver.current = null;
      props.options.afterDraw();
      return;
    }

    const view = props.view;
    let context: HTMLButtonElement | HTMLSpanElement | null = null;
    if (view.context) {
      const kind = 'button';
      const held = contextOwner.current;
      if (held && held.session === view.sessionId && held.kind === kind && held.node.parentNode === slot) {
        context = held.node;
      } else {
        const node = props.options.document.createElement(kind);
        const bar = props.options.document.createElement('span');
        bar.className = 'cctxbar';
        bar.setAttribute('aria-hidden', 'true');
        const fill = props.options.document.createElement('i');
        bar.appendChild(fill);
        const percent = props.options.document.createElement('span');
        percent.className = 'cctxpct';
        node.append(bar, percent);
        if (held) props.options.releaseContext?.();
        held?.node.remove();
        context = node;
        contextOwner.current = { session: view.sessionId, kind, node };
      }
      props.options.contextDetails?.mount(context, true);
      props.options.contextDetails?.update(context, '', props.options.contextList ?? null);
      context.setAttribute('aria-haspopup', 'dialog');
      context.setAttribute('aria-controls', 'composer-context-detail');
      if (!context.hasAttribute('aria-expanded')) context.setAttribute('aria-expanded', 'false');
      context.className = `cctx${view.context.level ? ` ${CONTEXT_CLASSES[view.context.level]}` : ''}`;
      context.dataset.hint = '';
      context.removeAttribute('title');
      context.setAttribute('aria-label', view.context.name);
      const fill = context.querySelector<HTMLElement>('.cctxbar i');
      const percent = context.querySelector<HTMLElement>('.cctxpct');
      if (fill) {
        fill.style.width = `${view.context.fill}%`;
      }
      const percentText = `${view.context.percent}%`;
      if (percent && percent.textContent !== percentText) {
        percent.textContent = percentText;
      }
      context.dataset.control = 'context';
    } else {
      props.options.releaseContext?.();
      contextOwner.current?.node.remove();
      contextOwner.current = null;
    }

    const heldAction = actionOwner.current;
    const actionKind = view.box.actionKind;
    const sameAction =
      heldAction?.session === view.sessionId && heldAction.kind === actionKind && heldAction.node.parentNode === slot;
    const action = props.options.action(view, sameAction ? heldAction.node : undefined);
    if (!sameAction) {
      if (heldAction?.node.parentNode === slot) {
        heldAction.node.replaceWith(action);
      }
      actionOwner.current = { session: view.sessionId, kind: actionKind, node: action };
    }

    const showSendOver = view.sendOverAsk && !('disabled' in action && action.disabled);
    let over: HTMLSpanElement | null = null;
    if (showSendOver) {
      over = sendOver.current;
      if (!over || over.parentNode !== slot) {
        over = props.options.document.createElement('span');
        over.className = 'csendover';
        sendOver.current = over;
      }
      over.textContent = view.sendOverAsk;
    } else {
      sendOver.current?.remove();
      sendOver.current = null;
    }

    const ordered = [context, over, action].filter((node): node is HTMLElement => node !== null);
    let cursor = slot.firstChild;
    for (const node of ordered) {
      if (node === cursor) {
        cursor = cursor.nextSibling;
      } else {
        slot.insertBefore(node, cursor);
      }
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    props.options.afterDraw();
  });
  const menu = props.openPick === 'mcp' ? (props.menus.mcp ?? null) : null;
  const allStatus = !!menu && menu.items.length > 0 && menu.items.every((item) => item.kind === 'status');
  useLayoutEffect(() => {
    render(
      props.bar
        ? h(
            'button',
            {
              class: 'sbrow',
              type: 'button',
              'aria-label': props.bar.name,
              'data-control': 'usage',
              'aria-expanded': String(shown),
              'aria-controls': 'usagepop',
              onPointerEnter() {
                props.setUsageHovered(true);
              },
              onPointerLeave() {
                props.setUsageHovered(false);
              },
              onFocus() {
                props.setUsageHovered(true);
              },
              onBlur() {
                props.setUsageHovered(false);
              },
              onClick() {
                props.setUsagePinned(!props.usagePinned);
              },
            },
            [
              ...props.bar.briefs.map((brief) => h(UsageBriefView, { key: brief.agent, brief })),
              !props.bar.briefs.length
                ? h('span', { class: 'sbagent' }, props.bar.refresh?.busy ? 'Reading usage' : 'Account usage')
                : null,
              props.bar.age ? h('span', { class: 'sbage' }, props.bar.age) : null,
              h('span', { class: 'sbtwist' }, shown ? TWIST.open : TWIST.shut),
            ],
          )
        : null,
      props.statusBar,
    );
    props.statusBar.hidden = !props.bar;
    render(
      props.bar && shown ? h(UsageOpenView, { bar: props.bar, sendToHost: props.options.sendToHost }) : null,
      props.usagePopover,
    );
    props.usagePopover.hidden = !props.bar || !shown;
    if (props.bar) {
      props.usagePopover.setAttribute('aria-label', props.bar.name);
    }
    render(
      menu
        ? h('div', { class: 'pickmenu' }, [
            h('div', { class: 'pickhead' }, menu.head),
            menu.empty ? h('div', { class: 'pickempty' }, menu.empty) : null,
            ...menu.items.map((item) =>
              h(PickRow, {
                key: item.value,
                item,
                menu,
                allStatus,
                composer: props.options.composer,
                popover: props.pickPopover,
                sendToHost: props.options.sendToHost,
                close: () => props.setOpenPick(null),
                redraw: props.redraw,
              }),
            ),
          ])
        : null,
      props.pickPopover,
    );
    props.pickPopover.hidden = !menu;
    if (menu) {
      props.pickPopover.setAttribute('role', allStatus ? 'list' : 'menu');
      props.pickPopover.setAttribute('aria-label', menu.head);
    }
    props.options.afterDraw();
  });
  if (!props.view) {
    return null;
  }
  return h('div', { class: 'cpicks' }, [
    ...props.view.picks.map((pick) =>
      pick.control !== 'mcp'
        ? h(ChoicePicker, {
            key: pick.control,
            id: `composer-${pick.control}`,
            owner: `${props.view!.sessionId}:${props.menus[pick.control]?.agent ?? ''}:${props.menus[pick.control]?.model ?? ''}:${props.menus[pick.control]?.revision ?? 0}`,
            control: pick.control,
            label: pick.label,
            name: pick.name,
            detail: pick.detail,
            className: `cpick${pick.caution ? ' caution' : ''}`,
            options: props.menus[pick.control]?.items.filter((item) => item.kind === 'radio') ?? [],
            selected: props.menus[pick.control]?.items.find((item) => item.checked)?.value ?? null,
            disabled: pick.disabled,
            open: props.openPick === pick.control,
            setOpen(open: boolean) {
              props.setOpenPick(open ? pick.control : null);
              if (open)
                props.options.sendToHost({
                  type: 'openControl',
                  control: pick.control,
                  session: props.view!.sessionId,
                });
            },
            commit(value: string) {
              const menu = props.menus[pick.control];
              if (!menu || menu.items.find((item) => item.value === value)?.checked) return;
              props.options.sendToHost({
                type: 'pick',
                control: menu.control,
                agent: menu.agent,
                session: menu.session ?? '',
                model: menu.model ?? '',
                value,
              });
            },
          })
        : h(
            'button',
            {
              class: `cpick${pick.caution ? ' caution' : ''}`,
              type: 'button',
              key: pick.control,
              'data-hint': pick.detail,
              disabled: pick.disabled,
              'aria-label': pick.name,
              'data-control': pick.control,
              'aria-haspopup': pick.disabled ? undefined : 'menu',
              'aria-expanded': pick.disabled ? undefined : String(props.openPick === pick.control),
              'aria-controls': pick.disabled ? undefined : 'pickpop',
              onClick() {
                if (pick.disabled) {
                  return;
                }
                const opening = props.openPick !== pick.control;
                props.setOpenPick(opening ? pick.control : null);
                if (opening) {
                  props.options.sendToHost({
                    type: 'openControl',
                    control: pick.control,
                    session: props.view!.sessionId,
                  });
                  (
                    props.pickPopover.querySelector<HTMLElement>('button.pickrow:not([disabled])') ?? props.pickPopover
                  ).focus();
                }
              },
              onKeyDown(event: KeyboardEvent) {
                if (pick.disabled || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                props.setOpenPick(pick.control);
                props.options.sendToHost({
                  type: 'openControl',
                  control: pick.control,
                  session: props.view!.sessionId,
                });
                const rows = [...props.pickPopover.querySelectorAll<HTMLElement>('button.pickrow:not([disabled])')];
                (event.key === 'ArrowUp' ? rows.at(-1) : rows[0])?.focus();
                if (!rows.length) props.pickPopover.focus();
              },
            },
            [pick.label, pick.disabled ? null : h('span', { class: 'cchev' }, TWIST.open)],
          ),
    ),
    h('span', { style: { display: 'contents' }, ref: extras }),
  ]);
}

export function createComposerControlsRenderer(options: ControlsOptions): ComposerControlsRenderer {
  initializeChoicePickers(options.document);
  const statusBar = options.document.createElement('div');
  statusBar.id = 'statusbar';
  statusBar.hidden = true;
  const usagePopover = options.document.createElement('div');
  usagePopover.id = 'usagepop';
  usagePopover.className = 'pop';
  usagePopover.hidden = true;
  usagePopover.setAttribute('role', 'group');
  const pickPopover = options.document.createElement('div');
  pickPopover.id = 'pickpop';
  pickPopover.className = 'pop';
  pickPopover.hidden = true;
  pickPopover.tabIndex = -1;
  let bar: UsageBar | null = null;
  let announcedAttempt = 0;
  let receivedUsage = false;
  let view: ComposerView | null = null;
  let contextDetail: ContextDetail | null = null;
  let contextRequest = 0;
  let contextOpen = false;
  let contextLoading = false;
  let contextAnchor: HTMLElement | null = null;
  let contextCleanup: (() => void) | null = null;
  const contextDetails = createStatDetailRenderer({
    document: options.document,
    id: 'composer-context-detail',
    events: options.events,
    actionAnchor: true,
    selectionWithin: options.selectionWithin,
    placeFloat(pop, anchor, bottom) {
      placeFloat(options.document.defaultView!, pop, anchor, bottom, 6);
    },
    onOpen(anchor) {
      contextAnchor = anchor;
      if (contextOpen || !view?.context) return;
      contextOpen = true;
      if (contextDetail && ['available', 'mismatch'].includes(contextDetail.status)) return;
      contextLoading = true;
      options.sendToHost({
        type: 'contextDetail',
        session: view.sessionId,
        request: ++contextRequest,
        generation: view.context.generation,
      });
    },
    onClose() {
      contextOpen = false;
      contextLoading = false;
    },
  });
  const contextList = (): StatDetailList => ({
    actions: true,
    entries: [],
    context: {
      used: view?.context?.used ?? 0,
      capacity: view?.context?.capacity ?? 1,
      detail: contextDetail,
      loading: contextLoading,
      compact: !!view?.context?.compact,
      run() {
        if (!view) return;
        const session = view.sessionId;
        contextDetail = null;
        contextDetails.dismiss();
        options.sendToHost({ type: 'compact', session });
      },
    },
  });
  options.contextDetails = {
    ...contextDetails,
    mount(node, ownStop) {
      if (contextAnchor !== node) {
        contextCleanup?.();
        contextAnchor = node;
        contextCleanup = contextDetails.mount(node, ownStop);
      }
      return contextCleanup!;
    },
  };
  options.contextList = contextList;
  options.releaseContext = () => {
    contextCleanup?.();
    contextCleanup = null;
    contextAnchor = null;
    contextDetail = null;
    contextRequest++;
  };
  let menus: Record<string, Menu> = {};
  let openPick: string | null = null;
  let hidden = false;
  let usagePinned = false;
  let usageHovered = false;
  const draftSetupSaid = new Map<string, string>();
  let menuSearch = { text: '', at: 0 };
  const setOpenPick = (value: string | null) => {
    if (hidden && value) return;
    if (value === 'mcp' && openPick !== 'mcp') menuSearch = { text: '', at: 0 };
    openPick = value;
  };
  const menuRows = () => [...pickPopover.querySelectorAll<HTMLButtonElement>('button.pickrow:not([disabled])')];
  const menuStop = (node: HTMLElement | null) => {
    for (const row of menuRows()) row.tabIndex = row === node ? 0 : -1;
  };

  const place = () => {
    if (contextOpen && contextAnchor && !contextDetails.element.hidden)
      placeFloat(window, contextDetails.element, contextAnchor, window.innerHeight - 6, 6);
    if (pickPopover.hidden || !openPick || options.composer.hidden) {
      return;
    }
    const anchor = found(options.composer, openPick) ?? options.composer;
    const at = anchor.getBoundingClientRect();
    const box = pickPopover.getBoundingClientRect();
    const room = at.top - 6;
    const above = at.top - box.height - 4;
    const below = at.bottom + 4;
    const floor = Math.max(6, window.innerHeight - box.height - 6);
    pickPopover.style.top = `${Math.max(6, Math.min(room >= box.height ? above : below, floor))}px`;
    pickPopover.style.left = `${Math.max(6, Math.min(at.left, window.innerWidth - box.width - 6))}px`;
  };
  const draw = () => {
    const active = options.document.activeElement as HTMLElement | null;
    const menuHadFocus = !!active && pickPopover.contains(active);
    const held =
      active &&
      (options.mount.contains(active) ||
        statusBar.contains(active) ||
        usagePopover.contains(active) ||
        pickPopover.contains(active))
        ? (active.dataset.control ?? null)
        : null;
    render(
      h(ControlsView, {
        bar,
        view,
        menus,
        openPick,
        usagePinned,
        usageHovered,
        options,
        statusBar,
        usagePopover,
        pickPopover,
        setOpenPick(value: string | null) {
          setOpenPick(value);
          draw();
          place();
        },
        setUsagePinned(value: boolean) {
          usagePinned = value;
          draw();
        },
        setUsageHovered(value: boolean) {
          usageHovered = value;
          draw();
        },
        redraw: draw,
      }),
      options.mount,
    );
    if (held) {
      const again = (hidden ? [statusBar, usagePopover] : [options.composer, statusBar, usagePopover, pickPopover])
        .map((root) => found(root, held))
        .find(Boolean);
      if (again && !('disabled' in again && again.disabled)) {
        again.focus();
      } else if (openPick === 'mcp' && !pickPopover.hidden) {
        (menuRows()[0] ?? pickPopover).focus();
      } else if (menuHadFocus && !hidden) {
        const trigger = found(options.composer, 'mcp') as HTMLButtonElement | null;
        (trigger && !trigger.disabled ? trigger : options.composer.querySelector<HTMLElement>('#prompt'))?.focus();
      }
    }
    if (menuHadFocus && !held && pickPopover.hidden && !hidden)
      options.composer.querySelector<HTMLElement>('#prompt')?.focus();
    if (openPick === 'mcp' && !pickPopover.hidden) {
      const rows = menuRows();
      if (options.document.activeElement === pickPopover && rows.length) rows[0].focus();
      menuStop(
        rows.includes(options.document.activeElement as HTMLButtonElement)
          ? (options.document.activeElement as HTMLElement)
          : (rows[0] ?? null),
      );
    }
  };
  pickPopover.addEventListener('focusin', (event) => menuStop(event.target as HTMLElement));
  pickPopover.addEventListener('keydown', (event) => {
    if (openPick !== 'mcp') return;
    const rows = menuRows();
    const at = rows.indexOf(options.document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      found(options.composer, 'mcp')?.focus();
      openPick = null;
      menuSearch = { text: '', at: 0 };
      draw();
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    let to: HTMLElement | undefined;
    if (event.key === 'Home') to = rows[0];
    else if (event.key === 'End') to = rows.at(-1);
    else if (event.key === 'ArrowDown') to = rows[Math.min(at + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') to = rows[Math.max(at - 1, 0)];
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      const now = Date.now();
      const text = (now - menuSearch.at < 750 ? menuSearch.text : '') + event.key.toLocaleLowerCase();
      menuSearch = { text, at: now };
      const repeated = Array.from(text).every((letter) => letter === text[0]);
      const prefix = repeated ? text[0] : text;
      const ordered = repeated ? [...rows.slice(at + 1), ...rows.slice(0, at + 1)] : rows;
      to = ordered.find((row) => row.querySelector('.pickname')?.textContent?.toLocaleLowerCase().startsWith(prefix));
    } else return;
    event.preventDefault();
    event.stopPropagation();
    to?.focus();
  });
  usagePopover.addEventListener('pointerenter', () => {
    usageHovered = true;
    draw();
  });
  usagePopover.addEventListener('pointerleave', () => {
    usageHovered = false;
    draw();
  });
  usagePopover.addEventListener('focusin', () => {
    usageHovered = true;
    draw();
  });
  usagePopover.addEventListener('focusout', (event) => {
    if (!usagePopover.contains(event.relatedTarget as Node | null)) {
      usageHovered = false;
      draw();
    }
  });
  options.events.document('pointerdown', (raw) => {
    const event = raw as PointerEvent;
    const target = event.target as Node | null;
    const anchor = openPick ? found(options.composer, openPick) : null;
    if (
      openPick &&
      target &&
      !pickPopover.contains(target) &&
      !(target instanceof Element && target.closest('.choicepop')) &&
      !anchor?.contains(target)
    ) {
      openPick = null;
      draw();
    }
    if (usagePinned && target && !usagePopover.contains(target) && !statusBar.contains(target)) {
      usagePinned = false;
      draw();
    }
  });
  options.events.document('keydown', (raw) => {
    const event = raw as KeyboardEvent;
    if (event.key !== 'Escape') {
      return;
    }
    if (openPick) {
      const back = found(options.composer, openPick);
      openPick = null;
      draw();
      back?.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (usagePinned || usageHovered) {
      usagePinned = false;
      usageHovered = false;
      draw();
      found(statusBar, 'usage')?.focus();
      event.preventDefault();
      event.stopPropagation();
    }
  });
  options.events.window('resize', place);
  return {
    receiveContext(detail) {
      if (
        !view?.context ||
        detail.session !== view.sessionId ||
        detail.request !== contextRequest ||
        detail.generation !== view.context.generation ||
        !contextOpen ||
        !contextLoading
      )
        return;
      contextLoading = false;
      contextDetail = detail;
      if (contextAnchor) contextDetails.update(contextAnchor, '', contextList());
    },
    statusBar,
    usagePopover,
    pickPopover,
    place,
    setHidden(value) {
      hidden = value;
      if (hidden) contextDetails.dismiss();
      if (hidden) openPick = null;
      draw();
    },
    ownsPickerFocus(node) {
      return pickPopover.contains(node) || (node instanceof Element && !!node.closest('.choicepop') && !!openPick);
    },
    contains(node) {
      return (
        statusBar.contains(node) ||
        usagePopover.contains(node) ||
        pickPopover.contains(node) ||
        (node instanceof Element && !!node.closest('.choicepop'))
      );
    },
    update(nextBar, nextView, nextMenus) {
      bar = nextBar;
      if (!receivedUsage && bar?.refresh && !bar.refresh.busy) announcedAttempt = bar.refresh.id;
      if (bar) receivedUsage = true;
      if (bar?.refresh?.announcement && bar.refresh.id > announcedAttempt) {
        announcedAttempt = bar.refresh.id;
        options.announce(bar.refresh.announcement);
      }
      if (view?.sessionId !== nextView?.sessionId) openPick = null;
      const replaced = view?.sessionId !== nextView?.sessionId;
      const refreshed =
        view?.context?.generation !== nextView?.context?.generation ||
        view?.context?.used !== nextView?.context?.used ||
        view?.context?.capacity !== nextView?.context?.capacity;
      if (replaced || refreshed) {
        contextDetail = null;
        contextRequest++;
        contextLoading = false;
        if (replaced || !nextView?.context) {
          const focused = options.document.activeElement;
          if (contextDetails.element.contains(focused) || contextAnchor === focused)
            options.composer.querySelector<HTMLElement>('#prompt')?.focus();
          contextDetails.dismiss();
        }
      }
      view = nextView;
      if (!replaced && refreshed && contextOpen && view?.context) {
        contextLoading = true;
        options.sendToHost({
          type: 'contextDetail',
          session: view.sessionId,
          request: ++contextRequest,
          generation: view.context.generation,
        });
      }
      menus = nextMenus;
      if (view?.draftTag) {
        const said = draftSetupSaid.get(view.sessionId);
        draftSetupSaid.set(view.sessionId, view.draftTag.detail);
        if (said !== undefined && said !== view.draftTag.detail) {
          options.announce(view.draftTag.detail);
        }
      }
      if (openPick && (!menus[openPick] || view?.picks.find((pick) => pick.control === openPick)?.disabled)) {
        openPick = null;
      }
      draw();
      place();
    },
    openPick(control) {
      if (hidden) return;
      setOpenPick(control);
      draw();
      place();
      if (control === 'mcp') (menuRows()[0] ?? pickPopover).focus();
      else found(options.composer, control)?.focus();
    },
  };
}
