import { ChoicePicker, initializeChoicePickers } from './choice-picker.ts';
import {
  modelAfterPick,
  effortAfterPick,
  selectedModelPick,
  modelLabel,
  effortLabel,
  effortPicks,
  defaultsForModel,
} from '../view/model-picks.ts';
import { Fragment, h, render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type {
  SessionLauncherView,
  LauncherChoice,
  LauncherPinnedRow,
  LauncherProfileRow,
  LauncherRequest,
  LauncherValue,
} from '../view/launcher.ts';
import {
  customProfileName,
  customValuesName,
  launcherCustomRequest,
  newSessionKeyshortcut,
  newSessionName,
  UNREADY_LAUNCHER_WORDS,
} from '../view/launcher.ts';
import type { PanelToHost } from './protocol.ts';
import { ProjectSpendCompactFace, type ProjectSpendRenderer } from './projectspend.ts';
import { matchSessions } from '../domain/session-query.ts';
import type { RailSort } from '../domain/rail-sort.ts';
import { PENCIL_GLYPH, PIN_GLYPH, sortRailCards } from '../view/rail.ts';
import {
  missingSetupValues,
  sameValues,
  type CompleteSetupValues,
  type SetupValueName,
} from '../domain/session-setups.ts';
import type { PanelRailCard } from './protocol.ts';

export interface CompactSession {
  id: string;
  label: string;
  agent: string;
  when: string;
}

interface CompactState {
  railUp: boolean;
  sessions: CompactSession[];
  showing: string;
}

type LauncherAction = ((request: LauncherRequest) => void) | null;

// Track focus after a setup pin or unpin request. Host view changes establish the result.
interface PinFocusMove {
  pressed: HTMLElement;
  // A new pinned ID with these values confirms the pin.
  values: CompleteSetupValues | null;
  known: ReadonlySet<string>;
  // This ID's absence confirms the unpin.
  id: string | null;
  // Pin controls after the pressed row, then preceding controls in reverse order.
  neighbors: string[];
}

// List enabled row controls in apply, Edit and pin order.
function rowControls(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('button[data-control]:not([disabled])')];
}

type ListKind = 'apply' | 'edit' | 'pin';
const LIST_PREFIXES: readonly (readonly [string, ListKind])[] = [
  ['launchpin:', 'pin'],
  ['launchedit:', 'edit'],
  ['launch:', 'apply'],
];

// The row key and button kind a list control names. Null for every control outside the list.
function listRowKey(control: string): { key: string; kind: ListKind } | null {
  if (control === 'launch:current') {
    return null;
  }
  for (const [prefix, kind] of LIST_PREFIXES) {
    if (control.startsWith(prefix)) {
      return { key: control.slice(prefix.length), kind };
    }
  }
  return null;
}

const FIELD_CONTROLS = ['launch-agent', 'launch-model', 'launch-effort', 'launch-permissions'] as const;

function setupValues(row: LauncherProfileRow): CompleteSetupValues {
  return {
    agent: row.profile.agent,
    model: row.profile.model,
    effort: row.profile.effort,
    permissionMode: row.profile.permissionMode,
  };
}

interface LauncherState {
  open: boolean;
  anchor: HTMLElement | null;
  action: LauncherAction;
  // The values the custom fields hold. Each draw shows them normalized against the catalog.
  choice: LauncherChoice | null;
}

export interface ChromeRenderer {
  updateLauncher(view: SessionLauncherView | null): void;
  updateCompact(state: CompactState): void;
  updateResponsive(
    sessions: readonly CompactSession[],
    showing: string | null,
    railUp: boolean,
    rail: readonly PanelRailCard[],
    sort: RailSort,
  ): void;
  compactMenu(): HTMLElement | null;
  launcherElement(): HTMLElement | null;
  launcherOpen(): boolean;
  launcherAnchor(): HTMLElement | null;
  // `custom` puts focus on the Agent field in place of the first setup.
  openLauncher(anchor?: HTMLElement | null, action?: LauncherAction, custom?: boolean): void;
  closeLauncher(returnFocus?: boolean): HTMLElement | null;
  toggleLauncher(anchor: HTMLElement): void;
  placeLauncher(): void;
}

interface ChromeOptions {
  document: Document;
  events: {
    document(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
  list: HTMLElement;
  platform: string;
  twist: string;
  pickerName: string;
  sendToHost(message: PanelToHost): void;
  showSession(session: string): void;
  projectSpend: ProjectSpendRenderer;
}

const NO_CHOICE: LauncherChoice = { agent: '', model: '', effort: '', permissionMode: '' };

// The values the custom fields start from: the quick New setup, normalized against the
// catalog, or no agent at all.
function defaultLauncherChoice(view: SessionLauncherView): LauncherChoice {
  const profile = view.primary?.profile;
  return profile ? normalizedChoice(view, profile) : NO_CHOICE;
}

// Keep stored field values, including values absent from the current catalog.
// A missing Agent leaves every field empty.
function normalizedChoice(view: SessionLauncherView, held: LauncherChoice): LauncherChoice {
  const agent = view.agents.find((one) => one.value === held.agent);
  if (!agent) {
    return NO_CHOICE;
  }
  return {
    agent: agent.value,
    model: held.model,
    effort: held.effort,
    permissionMode: held.permissionMode,
  };
}

// One line for each held value the catalog lacks, in field order, naming the stored value.
function heldCaution(view: SessionLauncherView, held: LauncherChoice): string[] {
  const reasons = view.words.missingReasons;
  const say = (name: SetupValueName, value: string) => (value ? `${reasons[name]}: ${value}` : reasons[name]);
  if (!held.agent) {
    return [];
  }
  const values = { ...held, agent: held.agent as CompleteSetupValues['agent'] };
  return missingSetupValues(values, view.agents)
    .filter((name) => (name !== 'model' && name !== 'effort') || Boolean(values[name]))
    .map((name) => say(name, values[name === 'permission' ? 'permissionMode' : name] ?? ''));
}

function CompactPicker(props: {
  document: Document;
  pickerName: string;
  sessions: CompactSession[];
  showing: string;
  showSession(session: string): void;
}): ComponentChildren {
  const next = { sessions: props.sessions, showing: props.showing };
  const latest = useRef(next);
  latest.current = next;
  const [drawn, setDrawn] = useState(next);
  const select = useRef<HTMLSelectElement>(null);

  useLayoutEffect(() => {
    if (props.document.activeElement !== select.current) {
      setDrawn(latest.current);
    }
  }, [props.sessions, props.showing]);

  return h(
    'select',
    {
      ref: select,
      value: drawn.showing,
      'data-control': 'picker',
      'aria-label': props.pickerName,
      onChange: (event: Event) => {
        const showing = (event.currentTarget as HTMLSelectElement).value;
        setDrawn((current) => ({ ...current, showing }));
        props.showSession(showing);
      },
      onBlur: () => setDrawn(latest.current),
    },
    drawn.sessions.map((session) =>
      h(
        'option',
        {
          key: session.id,
          value: session.id,
        },
        `${session.label} \u00b7 ${session.agent} \u00b7 ${session.when}`,
      ),
    ),
  );
}

function CompactControls(props: {
  document: Document;
  view: SessionLauncherView | null;
  state: CompactState;
  platform: string;
  twist: string;
  pickerName: string;
  launcherExpanded: boolean;
  projectSpend: ProjectSpendRenderer;
  sendToHost(message: PanelToHost): void;
  showSession(session: string): void;
  openLauncher(anchor: HTMLElement): void;
  setCompactMenu(node: HTMLElement | null): void;
}): ComponentChildren {
  const view = props.view;
  const primaryName = view
    ? newSessionName(view.words.primaryName, props.platform)
    : UNREADY_LAUNCHER_WORDS.primaryName;
  const picker = props.state.sessions.length >= 2;
  return h(Fragment, null, [
    h('span', { class: 'compactnewsplit', key: 'new' }, [
      h(
        'button',
        {
          class: 'compactnew',
          disabled: !view,
          'aria-label': primaryName || undefined,
          'aria-keyshortcuts': view ? newSessionKeyshortcut(props.platform) : undefined,
          'data-hint': primaryName || undefined,
          'data-hint-detail': view?.words.primaryDetail,
          onClick: () =>
            props.sendToHost({ type: 'newSession', ...(view?.owner === undefined ? {} : { owner: view.owner }) }),
        },
        view?.words.primaryLabel ?? UNREADY_LAUNCHER_WORDS.primaryLabel,
      ),
      h(
        'button',
        {
          class: 'compactnewmenu',
          ref: props.setCompactMenu,
          disabled: !view,
          'aria-haspopup': 'dialog',
          'aria-controls': 'launcher',
          'aria-expanded': String(props.launcherExpanded),
          'aria-label': view?.words.menuName ?? UNREADY_LAUNCHER_WORDS.menuName,
          'data-hint': view?.words.menuName,
          onClick: (event: MouseEvent) => props.openLauncher(event.currentTarget as HTMLElement),
        },
        props.twist,
      ),
    ]),
    picker
      ? h(CompactPicker, {
          key: 'picker',
          document: props.document,
          pickerName: props.pickerName,
          sessions: props.state.sessions,
          showing: props.state.showing,
          showSession: props.showSession,
        })
      : null,
    h(ProjectSpendCompactFace, {
      key: 'project-spend',
      owner: props.projectSpend,
      only: !picker,
    }),
  ]);
}

export function createChromeRenderer(options: ChromeOptions): ChromeRenderer {
  initializeChoicePickers(options.document);
  const compactElement = options.document.createElement('div');
  compactElement.className = 'controls';
  compactElement.hidden = true;
  options.list.insertBefore(compactElement, options.list.firstChild);

  const launcherMount = options.document.createElement('div');
  options.document.body.appendChild(launcherMount);

  let launcherView: SessionLauncherView | null = null;
  let compactState: CompactState = { railUp: true, sessions: [], showing: '' };
  let launcherNode: HTMLElement | null = null;
  let compactMenuNode: HTMLElement | null = null;
  let launcherSnapshot: LauncherState = {
    open: false,
    anchor: null,
    action: null,
    choice: null,
  };
  let setLauncherState: ((state: LauncherState) => void) | null = null;
  let pendingFocus: string | null = null;
  // Track the list's Tab stop and previous row order to restore focus when a row disappears.
  let listStop: string | null = null;
  let listOrder: string[] = [];
  let pinMove: PinFocusMove | null = null;
  // An explicit field-control target from Edit or custom opening takes priority over `pendingFocus`.
  let focusRequest: string | null = null;

  const placeLauncher = () => {
    if (!launcherNode || !launcherSnapshot.open) {
      return;
    }
    const rect = launcherSnapshot.anchor?.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 12);
    const left = rect
      ? Math.max(6, Math.min(rect.right - width, window.innerWidth - width - 6))
      : window.innerWidth - width - 6;
    launcherNode.style.width = `${width}px`;
    launcherNode.style.left = `${left}px`;
    // The rendered height decides the top, so a tall popover never ends below the viewport.
    const height = launcherNode.offsetHeight;
    launcherNode.style.top = `${rect ? Math.max(6, Math.min(rect.bottom + 4, window.innerHeight - height - 6)) : 6}px`;
  };

  const compactRender = () => {
    compactElement.hidden = compactState.railUp;
    render(
      h(CompactControls, {
        document: options.document,
        view: launcherView,
        state: compactState,
        platform: options.platform,
        twist: options.twist,
        pickerName: options.pickerName,
        launcherExpanded: launcherSnapshot.open && launcherSnapshot.anchor === compactMenuNode,
        sendToHost: options.sendToHost,
        showSession: options.showSession,
        projectSpend: options.projectSpend,
        openLauncher: (anchor: HTMLElement) => controller.toggleLauncher(anchor),
        setCompactMenu: (node: HTMLElement | null) => {
          compactMenuNode = node;
        },
      }),
      compactElement,
    );
  };

  const commitLauncher = (state: LauncherState) => {
    const previousAnchor = launcherSnapshot.anchor;
    if (previousAnchor && previousAnchor !== state.anchor) {
      previousAnchor.setAttribute('aria-expanded', 'false');
    }
    launcherSnapshot = state;
    if (state.anchor) {
      state.anchor.setAttribute('aria-expanded', String(state.open));
    }
    setLauncherState?.(state);
    compactRender();
  };

  // Retain the list's focused control when available.
  // Otherwise keep its button kind on the surviving row, next row or previous row, falling back to the pin.
  // With no retained stop, select the first row's first control.
  const resolveListStop = (view: SessionLauncherView): string | null => {
    const rows = [
      ...view.pinned.map((row) => ({ key: row.key, apply: row.available })),
      ...view.recent.map((row) => ({ key: row.key, apply: true })),
    ];
    const controls = (row: { key: string; apply: boolean }) => [
      ...(row.apply ? [`launch:${row.key}`] : []),
      `launchedit:${row.key}`,
      `launchpin:${row.key}`,
    ];
    const previous = listOrder;
    listOrder = rows.map((row) => row.key);
    const all = rows.flatMap(controls);
    if (listStop && all.includes(listStop)) {
      return listStop;
    }
    const held = listStop ? listRowKey(listStop) : null;
    const at = held ? previous.indexOf(held.key) : -1;
    if (held && at >= 0) {
      const byKey = new Map(rows.map((row) => [row.key, row]));
      const near = [...previous.slice(at), ...previous.slice(0, at).reverse()].find((key) => byKey.has(key));
      const row = near ? byKey.get(near) : undefined;
      if (row) {
        const choices = controls(row);
        listStop = choices.find((one) => listRowKey(one)?.kind === held.kind) ?? choices[choices.length - 1];
        return listStop;
      }
    }
    listStop = all[0] ?? null;
    return listStop;
  };

  // Index launcher controls by name, excluding disabled controls.
  const focusableControls = (): Map<string, HTMLElement> => {
    const found = new Map<string, HTMLElement>();
    for (const node of launcherNode?.querySelectorAll<HTMLElement>('[data-control]') ?? []) {
      const control = node.dataset.control;
      if (control && !found.has(control) && !(node as HTMLButtonElement).disabled) {
        found.set(control, node);
      }
    }
    return found;
  };

  // Resolve a pending pin focus move against the new view.
  // Keep the pressed button until the result arrives, or focus a surviving neighbor if it disappears.
  const settlePinMove = (view: SessionLauncherView, node: HTMLElement): boolean => {
    const move = pinMove;
    if (!move) {
      return false;
    }
    const active = options.document.activeElement;
    const onPressed =
      active === move.pressed || (!move.pressed.isConnected && (!active || active === options.document.body));
    if (!onPressed) {
      pinMove = null;
      return false;
    }
    const values = move.values;
    const added = values
      ? view.pinned.find((row) => !move.known.has(row.id) && sameValues(row.profile, values))
      : undefined;
    const removed = move.id !== null && !view.pinned.some((row) => row.id === move.id);
    if (added) {
      pinMove = null;
      focusableControls().get(`launchpin:${added.key}`)?.focus();
    } else if (removed || !move.pressed.isConnected) {
      pinMove = null;
      const controls = focusableControls();
      let neighbor: HTMLElement | undefined;
      for (const control of move.neighbors) {
        neighbor = controls.get(control);
        if (neighbor) {
          break;
        }
      }
      (neighbor ?? node.querySelector<HTMLElement>('button[data-control]:not([disabled])'))?.focus();
    }
    return true;
  };

  function Launcher(): ComponentChildren {
    const [state, setState] = useState(launcherSnapshot);
    const [openField, setOpenField] = useState<string | null>(null);
    setLauncherState = setState;
    launcherSnapshot = state;

    const view = launcherView;
    const held = state.choice ?? (view ? defaultLauncherChoice(view) : NO_CHOICE);
    const shown = view ? normalizedChoice(view, held) : NO_CHOICE;
    const agent = view ? (view.agents.find((one) => one.value === shown.agent) ?? null) : null;
    const selected = agent ? selectedModelPick(agent.catalog ?? [], shown.model, agent.defaults) : null;
    const model = agent?.models.find((one) => one.identity === selected?.identity) ?? null;

    useLayoutEffect(() => {
      if (state.open && (shown.agent === 'claude' || shown.agent === 'codex')) {
        options.sendToHost({ type: 'requestDefaults', agent: shown.agent, model: shown.model });
      }
    }, [state.open, shown.agent, shown.model, agent?.defaults?.revision]);

    useLayoutEffect(() => {
      placeLauncher();
      if (!state.open || !view || !launcherNode) {
        pinMove = null;
        return;
      }
      const controls = focusableControls();
      const groupTarget = (control: string) => controls.get(control);
      // An explicit request, from Edit or a custom opening, wins over a passive restore.
      if (focusRequest) {
        const prefix = focusRequest;
        focusRequest = null;
        pendingFocus = null;
        groupTarget(prefix)?.focus();
        return;
      }
      if (pinMove && settlePinMove(view, launcherNode)) {
        pendingFocus = null;
        return;
      }
      if (!pendingFocus) {
        return;
      }
      const active = options.document.activeElement as HTMLButtonElement | null;
      if (active && !active.disabled && launcherNode.contains(active)) {
        pendingFocus = null;
        return;
      }
      const target = pendingFocus;
      pendingFocus = null;
      // A field keeps its focus. A removed setup row hands focus to the nearest remaining row.
      const group = FIELD_CONTROLS.find((control) => control === target);
      const fallback = group ? groupTarget(group) : listRowKey(target) && listStop ? controls.get(listStop) : undefined;
      const first =
        controls.get('launch:current') ??
        (listStop ? controls.get(listStop) : undefined) ??
        groupTarget(FIELD_CONTROLS[0]);
      (controls.get(target) ?? fallback ?? first)?.focus();
    }, [state, view]);

    // A reader's change replaces what the fields hold with what they show plus that change.
    const updateChoice = (next: LauncherChoice) => {
      commitLauncher({ ...state, choice: next });
    };
    const post = (request: LauncherRequest) => {
      if (state.action) {
        state.action(request);
      } else {
        options.sendToHost({
          type: 'newSession',
          request,
          ...(view?.owner === undefined ? {} : { owner: view.owner }),
        });
      }
      controller.closeLauncher(false);
    };
    // Edit loads the row's stored values into the fields, then puts focus on the Agent field.
    const pressEdit = (row: LauncherProfileRow) => {
      pinMove = null;
      focusRequest = FIELD_CONTROLS[0];
      commitLauncher({ ...state, choice: setupValues(row) });
      options.sendToHost({ type: 'requestDefaults', agent: row.profile.agent, model: row.profile.model });
    };
    // Up and Down wrap across rows, retaining the button kind or falling back to the pin.
    // Home and End select boundary rows. Left and Right move within the current row without wrapping.
    const listKeydown = (event: KeyboardEvent) => {
      const list = event.currentTarget as HTMLElement;
      const rows = [...list.querySelectorAll<HTMLElement>('.launchentry')].filter((row) => rowControls(row).length);
      const active = options.document.activeElement as HTMLElement | null;
      const at = rows.findIndex((row) => active && row.contains(active));
      if (at < 0 || !active) {
        return;
      }
      const here = rowControls(rows[at]);
      let next: HTMLElement | undefined;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        next = here[here.indexOf(active) + (event.key === 'ArrowRight' ? 1 : -1)];
      } else {
        const target =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : event.key === 'ArrowDown'
                ? (at + 1) % rows.length
                : event.key === 'ArrowUp'
                  ? (at - 1 + rows.length) % rows.length
                  : -1;
        if (target < 0) {
          return;
        }
        const there = rowControls(rows[target]);
        const kind = listRowKey(active.dataset.control ?? '')?.kind;
        next = there.find((one) => listRowKey(one.dataset.control ?? '')?.kind === kind) ?? there[there.length - 1];
      }
      next?.focus();
      event.preventDefault();
    };
    // Cancel a pending move when focus leaves the pressed pin so a later result does not pull focus back.
    // Defer the check one microtask. Removing the pressed pin preserves the neighbor fallback.
    const listFocusOut = (event: FocusEvent) => {
      const move = pinMove;
      if (!move || event.target !== move.pressed) {
        return;
      }
      queueMicrotask(() => {
        if (pinMove === move && move.pressed.isConnected && options.document.activeElement !== move.pressed) {
          pinMove = null;
        }
      });
    };
    // Focus inside the list carries the Tab stop with it.
    const listFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const control = target.dataset?.control;
      if (!control || !listRowKey(control)) {
        return;
      }
      listStop = control;
      for (const node of (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button[data-control]')) {
        node.tabIndex = node === target ? 0 : -1;
      }
    };
    const pressPin = (event: MouseEvent, row: LauncherProfileRow, pinned: LauncherPinnedRow | null) => {
      if (!view) {
        return;
      }
      const order = [...view.pinned, ...view.recent].map((one) => one.key);
      const at = order.indexOf(row.key);
      pinMove = {
        pressed: event.currentTarget as HTMLElement,
        values: pinned ? null : setupValues(row),
        known: new Set(view.pinned.map((one) => one.id)),
        id: pinned?.id ?? null,
        neighbors: [...order.slice(at + 1), ...order.slice(0, at).reverse()].map((key) => `launchpin:${key}`),
      };
      if (pinned) {
        options.sendToHost({
          type: 'unpinSetup',
          id: pinned.id,
          ...(view.owner === undefined ? {} : { owner: view.owner }),
        });
      } else {
        options.sendToHost({
          type: 'pinSetup',
          request: { kind: 'row', key: row.key, values: setupValues(row) },
          ...(view.owner === undefined ? {} : { owner: view.owner }),
        });
      }
    };

    const glyph = (path: string) => h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: path }));
    let body: ComponentChildren = null;
    if (view) {
      const rows: ComponentChildren[] = [h('div', { class: 'launchhead', key: 'heading' }, view.words.menuHeading)];
      if (view.inherited) {
        const row = view.inherited;
        rows.push(
          h(
            'button',
            {
              class: 'launchrow',
              key: `row:${row.key}`,
              'data-control': `launch:${row.key}`,
              'aria-label': row.name,
              onClick: () => post({ kind: 'row', key: row.key }),
            },
            [h('span', { class: 'launchname' }, row.label), h('span', { class: 'launchdetail' }, row.detail)],
          ),
        );
      }
      const stop = resolveListStop(view);
      // A row is a plain wrapper around sibling buttons, so no button sits inside another.
      const entry = (row: LauncherProfileRow, pinned: LauncherPinnedRow | null) => {
        const usable = !pinned || pinned.available;
        const apply = `launch:${row.key}`;
        const edit = `launchedit:${row.key}`;
        const pin = `launchpin:${row.key}`;
        return h('div', { class: usable ? 'launchentry' : 'launchentry is-unavailable', key: `row:${row.key}` }, [
          h(
            'button',
            {
              class: 'launchrow',
              key: 'apply',
              'data-control': apply,
              'aria-label': row.name,
              disabled: !usable,
              tabIndex: stop === apply ? 0 : -1,
              onClick: () => post({ kind: 'row', key: row.key }),
            },
            [
              h('span', { class: 'launchname', title: row.detail }, row.label),
              h('span', { class: 'launchdetail', title: row.detail }, row.detail),
            ],
          ),
          h(
            'button',
            {
              // Edit is an icon button of the pin's shape and tones, so it shares the pin's class.
              class: 'launchpin launchedit',
              key: 'edit',
              type: 'button',
              'data-control': edit,
              'aria-label': `${view.words.editName}. ${row.name}`,
              'data-hint': view.words.editHint,
              'data-hint-detail': view.words.editDetail,
              tabIndex: stop === edit ? 0 : -1,
              onClick: () => pressEdit(row),
            },
            glyph(PENCIL_GLYPH),
          ),
          h(
            'button',
            {
              class: pinned ? 'launchpin is-pinned' : 'launchpin',
              key: 'pin',
              type: 'button',
              'data-control': pin,
              'aria-pressed': pinned ? 'true' : 'false',
              'aria-label': `${view.words.pinName}. ${row.name}`,
              'data-hint': pinned ? view.words.unpinHint : view.words.pinHint,
              'data-hint-detail': pinned ? view.words.unpinDetail : view.words.pinDetail,
              tabIndex: stop === pin ? 0 : -1,
              onClick: (event: MouseEvent) => pressPin(event, row, pinned),
            },
            glyph(PIN_GLYPH),
          ),
        ]);
      };
      const list: ComponentChildren[] = [
        h('div', { class: 'launchhead', key: 'pinned-heading' }, view.words.pinnedHeading),
      ];
      if (view.pinned.length) {
        list.push(...view.pinned.map((row) => entry(row, row)));
      } else {
        list.push(h('div', { class: 'launchnote', key: 'pinned-empty' }, view.words.pinnedEmpty));
      }
      if (view.recent.length) {
        list.push(h('div', { class: 'launchhead', key: 'recent-heading' }, view.words.recentHeading));
        list.push(...view.recent.map((row) => entry(row, null)));
      }
      rows.push(
        h(
          'div',
          { class: 'launchlist', key: 'list', onKeyDown: listKeydown, onFocusIn: listFocus, onFocusOut: listFocusOut },
          list,
        ),
      );

      // The custom fields and the action row, below the list on the same page.
      const request = launcherCustomRequest(view, shown);
      const match = request
        ? view.pinned.find(
            (row) =>
              row.profile.agent === request.agent &&
              row.profile.model === request.model &&
              row.profile.effort === request.effort &&
              row.profile.permissionMode === request.permissionMode,
          )
        : undefined;
      rows.push(h('div', { class: 'launchhead', key: 'custom-heading' }, view.words.customHeading));
      const field = (
        key: string,
        name: string,
        values: readonly LauncherValue[],
        value: string | null,
        label: string,
        changed: (value: string) => void,
      ) =>
        h('div', { class: 'launchfield', key }, [
          h('span', { class: 'launchfieldname' }, name),
          h(ChoicePicker, {
            id: `launchfield-${key}`,
            control: `launch-${key}`,
            owner: `${shown.agent}:${agent?.defaults?.revision ?? 0}:${key === 'effort' ? shown.model : ''}`,
            label,
            detail:
              key === 'model'
                ? agent?.defaults?.base?.reason
                : key === 'effort'
                  ? defaultsForModel(agent?.catalog ?? [], shown.model, agent?.defaults)?.reason
                  : undefined,
            name: `${name}: ${label}`,
            options: values,
            selected: values.some((item) => item.value === value) ? value : null,
            storedValue:
              key === 'model'
                ? shown.model
                : key === 'effort'
                  ? shown.effort
                  : key === 'agent'
                    ? shown.agent
                    : shown.permissionMode,
            disabled: !values.length,
            open: state.open && openField === key,
            setOpen: (open: boolean) => setOpenField(open ? key : null),
            commit: changed,
          }),
        ]);
      rows.push(
        field(
          'agent',
          view.words.agentLabel,
          view.agents,
          shown.agent || null,
          agent?.label ?? 'Choose an agent',
          (value) => {
            if (value === shown.agent) return;
            const next = view.agents.find((one) => one.value === value)!;
            updateChoice({ agent: value, model: '', effort: '', permissionMode: next.defaultPermission });
            options.sendToHost({ type: 'requestDefaults', agent: value as 'claude' | 'codex', model: '' });
          },
        ),
      );
      rows.push(
        field(
          'model',
          view.words.modelLabel,
          agent?.models ?? [],
          model?.value ?? null,
          agent ? modelLabel(agent.catalog ?? [], shown.model, agent.defaults) : 'Choose an agent',
          (value) => {
            const next = modelAfterPick(agent?.catalog ?? [], shown.model, shown.effort, value, agent?.defaults);
            if (!next) return;
            updateChoice({ ...shown, ...next });
            if (next.model !== shown.model)
              options.sendToHost({
                type: 'requestDefaults',
                agent: shown.agent as 'claude' | 'codex',
                model: next.model,
              });
          },
        ),
      );
      const efforts = agent
        ? effortPicks(agent.catalog ?? [], shown.model, agent.defaults).map((item) => ({
            value: item.value,
            label: item.label,
            detail: item.description,
            name: item.label,
          }))
        : [];
      const currentEffort =
        shown.effort || (agent ? defaultsForModel(agent.catalog ?? [], shown.model, agent.defaults)?.effort : null);
      rows.push(
        field(
          'effort',
          view.words.effortLabel,
          efforts,
          currentEffort ?? null,
          agent ? effortLabel(agent.catalog ?? [], shown.model, shown.effort, agent.defaults) : 'Choose an agent',
          (value) => {
            const effort = effortAfterPick(agent?.catalog ?? [], shown.model, shown.effort, value, agent?.defaults);
            if (effort !== null) updateChoice({ ...shown, effort });
          },
        ),
      );
      rows.push(
        field(
          'permissions',
          view.words.permissionLabel,
          agent?.permissions ?? [],
          shown.permissionMode,
          agent
            ? (agent.permissions.find((one) => one.value === shown.permissionMode)?.label ??
                `${shown.permissionMode} (unavailable)`)
            : 'Choose an agent',
          (value) => updateChoice({ ...shown, permissionMode: value }),
        ),
      );
      const caution = heldCaution(view, held);
      if (caution.length) {
        rows.push(
          h(
            'div',
            { class: 'launchcaution', key: 'caution' },
            caution.map((line) => h('div', { key: line }, line)),
          ),
        );
      }
      rows.push(
        h('div', { class: 'launchactions', key: 'actions' }, [
          // The custom-field pin reads its pressed state from matching pinned values in the host view.
          h(
            'button',
            {
              class: match ? 'launchpin is-pinned' : 'launchpin',
              key: 'fieldpin',
              type: 'button',
              'data-control': 'launch-fieldpin',
              disabled: !request,
              'aria-pressed': match ? 'true' : 'false',
              'aria-label': request ? `${view.words.pinName}. ${customValuesName(view, request)}` : view.words.pinName,
              'data-hint': match ? view.words.unpinHint : view.words.pinHint,
              'data-hint-detail': match ? view.words.unpinDetail : view.words.pinDetail,
              onClick: () => {
                if (!request) {
                  return;
                }
                pinMove = null;
                if (match) {
                  options.sendToHost({
                    type: 'unpinSetup',
                    id: match.id,
                    ...(view.owner === undefined ? {} : { owner: view.owner }),
                  });
                } else {
                  options.sendToHost({
                    type: 'pinSetup',
                    request,
                    ...(view.owner === undefined ? {} : { owner: view.owner }),
                  });
                }
              },
            },
            glyph(PIN_GLYPH),
          ),
          h(
            'button',
            {
              class: 'launchcreate',
              key: 'create',
              'data-control': 'launch-create',
              disabled: !request,
              'aria-label': request ? customProfileName(view, request) : view.words.createLabel,
              onClick: () => {
                if (request) {
                  post(request);
                }
              },
            },
            view.words.createLabel,
          ),
        ]),
      );
      body = rows;
    }

    return h(
      'div',
      {
        id: 'launcher',
        class: 'pop',
        hidden: !state.open || !view,
        role: 'dialog',
        'aria-label': view ? view.words.menuName : undefined,
        ref: (node: HTMLElement | null) => {
          launcherNode = node;
        },
      },
      body,
    );
  }

  const launcherRender = () => render(h(Launcher, {}), launcherMount);

  const controller: ChromeRenderer = {
    updateLauncher(view) {
      if (view?.owner !== launcherView?.owner) {
        controller.closeLauncher(false);
        pendingFocus = null;
        listStop = null;
      }
      const active = options.document.activeElement as HTMLElement | null;
      if (!pendingFocus && active && launcherNode?.contains(active)) {
        pendingFocus = active.dataset.control ?? null;
      }
      launcherView = view;
      // A popover opened before the first view takes its starting values from that view.
      if (view && launcherSnapshot.open && !launcherSnapshot.choice) {
        commitLauncher({ ...launcherSnapshot, choice: defaultLauncherChoice(view) });
      }
      launcherRender();
      compactRender();
    },
    updateCompact(state) {
      compactState = state;
      compactRender();
    },
    updateResponsive(sessions, showing, railUp, rail, sort) {
      const remaining = new Map(sessions.map((session) => [session.id, session]));
      const ordered: CompactSession[] = [];
      for (const card of sortRailCards(rail, sort)) {
        const session = remaining.get(card.id);
        if (session) {
          ordered.push(session);
          remaining.delete(card.id);
        }
      }
      const all = ordered.concat([...remaining.values()]);
      const offered = matchSessions(all, '');
      const visible =
        !showing || offered.some((session) => session.id === showing)
          ? offered
          : offered.concat(all.filter((session) => session.id === showing));
      controller.updateCompact({ railUp, sessions: visible, showing: showing ?? '' });
      options.projectSpend.setRailVisible(railUp);
    },
    compactMenu: () => compactMenuNode,
    launcherElement: () => launcherNode,
    launcherOpen: () => launcherSnapshot.open,
    launcherAnchor: () => launcherSnapshot.anchor,
    openLauncher(anchor = null, action = null, custom = false) {
      // Start fields from the quick New setup and reset the list's Tab stop.
      // Focus the inherited row, first setup or Agent field. Custom openings focus the Agent field.
      const choice = launcherView ? defaultLauncherChoice(launcherView) : null;
      listStop = null;
      pinMove = null;
      focusRequest = custom ? FIELD_CONTROLS[0] : null;
      pendingFocus = custom ? null : 'launch-open';
      commitLauncher({ open: true, anchor, action, choice });
    },
    closeLauncher(returnFocus = true) {
      const back = launcherSnapshot.anchor;
      const active = options.document.activeElement as HTMLElement | null;
      const wasInside = !!(active && launcherNode?.contains(active));
      pinMove = null;
      focusRequest = null;
      commitLauncher({ open: false, anchor: null, action: null, choice: null });
      if (returnFocus && back?.focus) {
        back.focus();
      } else if (wasInside) {
        active?.blur();
      }
      return back;
    },
    toggleLauncher(anchor) {
      if (launcherSnapshot.open) {
        controller.closeLauncher(true);
      } else {
        controller.openLauncher(anchor);
      }
    },
    placeLauncher,
  };

  options.events.document('pointerdown', (event) => {
    const target = event.target as Node | null;
    if (
      !launcherSnapshot.open ||
      !target ||
      launcherNode?.contains(target) ||
      (target instanceof Element && !!target.closest('.choicepop[id^="launchfield-"]')) ||
      launcherSnapshot.anchor?.contains(target)
    ) {
      return;
    }
    controller.closeLauncher(false);
  });

  launcherRender();
  compactRender();
  return controller;
}
