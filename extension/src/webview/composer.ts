import { h, render, type ComponentChildren } from 'preact';
import {
  historyPress,
  isSendChord,
  lineIntent,
  lineRange,
  matchCommandNames,
  PATH_COMPLETION_DEBOUNCE_MS,
  pathToken,
  promptToken,
  remoteControlRequest,
  renameRequest,
  undoBreak,
  undoIntent,
  undoRecord,
  undoStart,
  undoTake,
} from '../domain/composer-editing.ts';
import type { UndoStack } from '../domain/composer-editing.ts';
import { claudeCommandIsSkill } from '../domain/claude-skills.ts';
import { historySaid } from '../view/composer-editing.ts';
import { actionable, editableTarget } from './dom.ts';
import type { ComposerView, PanelToHost, PathEntry, PromptEntryView } from './protocol.ts';
import type { SavedStateService } from './state.ts';
import type { StatDetailList, StatDetailRenderer } from './stat-detail.ts';

const WALK_ANNOUNCE_MS = 120;
const HOST_ACTIVATION_GRACE_MS = 150;
const RESTORATION_ALIAS_LIMIT = 64;

// The prompt box supplies separate controls for `/compact` and `/model`.
// Before a working directory reports its skill list, other Claude commands receive highlights.
// Afterward, only listed names receive highlights.
const CLAUDE_NATIVE_COMMANDS = new Set(['compact', 'model']);

interface HistoryWalk {
  list: { text: string; submission?: string }[];
  at: number;
  stash: string;
  text: string;
  shut: boolean;
}

interface SlashAttachment {
  ownsInput: boolean;
  onComplete?: () => void;
}

interface SkillMark {
  command: string;
  start: number;
  end: number;
  key: string;
}

interface SkillEdit {
  start: number;
  oldEnd: number;
  newEnd: number;
}

export interface ComposerSlots {
  asks: HTMLElement;
  annotations: HTMLElement;
  files: HTMLElement;
  notice: HTMLElement;
  draftTag: HTMLElement;
  origin: HTMLElement;
  nextTurn: HTMLElement;
  picks: HTMLElement;
}

interface ComposerOptions {
  readOnly?: boolean;
  words: Pick<
    typeof import('../view/card-words.ts').CARD_ACTIONS,
    'composerCollapse' | 'composerCollapseDetail' | 'composerRestore' | 'composerRestoreDetail'
  >;
  recovery: SavedStateService;
  document: Document;
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
  submissionNotice(session: string, words: string | null): void;
  isFileStaging(session: string | null): boolean;
  platform: string;
  hasLocalComments(session: string | null): boolean;
  commentEditorOpen(): boolean;
  statDetails: StatDetailRenderer;
}

export interface ComposerRenderer {
  element: HTMLElement;
  prompt: HTMLTextAreaElement;
  slashPopover: HTMLElement;
  walkAnnouncer: HTMLElement;
  slots: ComposerSlots;
  update(view: ComposerView | null): void;
  setHidden(hidden: boolean): void;
  view(): ComposerView | null;
  session(): string | null;
  focus(session: string): boolean;
  takeDraft(session: string, text: string, revision?: number): string | null;
  restoreDraft(session: string, text: string, revision: number): boolean;
  adoptSessionIdentity(provisional: string, durable: string): boolean;
  sessionIdentity(session: string): string;
  endHistoryIntoPrompt(): void;
  // Returns whether the prompt was sent. The page-level chord leaves a refused press with its focused control.
  send(fromKey: boolean): boolean;
  grow(): void;
  setDropping(dropping: boolean): void;
  actionIcon(kind: string): SVGSVGElement;
  prune(sessions: readonly { id: string }[]): void;
  advanceRevision(session: string | null): number;
  revision(session: string): number;
  layout(): void;
  attachSlash(area: HTMLTextAreaElement): void;
  releaseSlash(area: HTMLTextAreaElement | null): void;
  drawSlash(preserveScroll?: boolean): void;
  openSlash(): void;
  closeSlash(): void;
  takePathCompletion(session: string, request: number, token: string, caret: number, rows: PathEntry[]): void;
  // Insert text at the caret of the named session's draft. A session that is not shown yet receives it when it is.
  insertAtCaret(session: string, text: string): void;
  attachLineClipboard(area: HTMLTextAreaElement): void;
  // Runs after the renderer sets the draft itself, which sends no input event.
  onDraftSet(listener: () => void): void;
}

interface ComposerNodes {
  element?: HTMLElement;
  prompt?: HTMLTextAreaElement;
  skillLayer?: HTMLElement;
  selectionLayer?: HTMLElement;
  sash?: HTMLElement;
  slots: Partial<ComposerSlots>;
}

function ComposerShell(props: { nodes: ComposerNodes; words: ComposerOptions['words'] }): ComponentChildren {
  const slot = (name: keyof ComposerSlots) =>
    h('div', {
      key: name,
      'data-composer-slot': name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      style: { display: 'contents' },
      ref: (node: HTMLElement | null) => {
        if (node) {
          props.nodes.slots[name] = node;
        }
      },
    });
  return h(
    'div',
    {
      id: 'composer',
      hidden: true,
      ref: (node: HTMLElement | null) => {
        if (node) {
          props.nodes.element = node;
        }
      },
    },
    [
      h(
        'button',
        {
          id: 'composer-collapse',
          type: 'button',
          'aria-label': props.words.composerCollapse,
          'data-hint': props.words.composerCollapse,
          'data-hint-detail': props.words.composerCollapseDetail,
        },
        '\u25BE',
      ),
      h('div', {
        id: 'footsash',
        class: 'sash',
        role: 'separator',
        'aria-orientation': 'horizontal',
        tabIndex: 0,
        ref: (node: HTMLElement | null) => {
          if (node) {
            props.nodes.sash = node;
          }
        },
      }),
      h(
        'button',
        {
          id: 'composer-restore',
          type: 'button',
          hidden: true,
          'aria-label': props.words.composerRestore,
          'data-hint': props.words.composerRestore,
          'data-hint-detail': props.words.composerRestoreDetail,
        },
        '\u25B4',
      ),
      slot('asks'),
      slot('annotations'),
      slot('files'),
      slot('notice'),
      slot('draftTag'),
      slot('origin'),
      slot('nextTurn'),
      h('div', { class: 'cinput', key: 'input-surface' }, [
        h('div', { class: 'cwrap', key: 'prompt-wrap' }, [
          h('textarea', {
            id: 'prompt',
            key: 'prompt',
            ref: (node: HTMLTextAreaElement | null) => {
              if (node) {
                props.nodes.prompt = node;
              }
            },
          }),
          h('div', {
            class: 'cskilllayer',
            key: 'skill-layer',
            ref: (node: HTMLElement | null) => {
              if (node) {
                props.nodes.skillLayer = node;
              }
            },
          }),
          h('div', {
            class: 'cselectionlayer',
            'aria-hidden': 'true',
            key: 'selection-layer',
            ref: (node: HTMLElement | null) => {
              if (node) {
                props.nodes.selectionLayer = node;
              }
            },
          }),
        ]),
        slot('picks'),
      ]),
    ],
  );
}

function SlashRows(props: {
  entries: Array<PromptEntryView | PathEntry>;
  active: number;
  take(entry: PromptEntryView | PathEntry): void;
}): ComponentChildren {
  return props.entries.map((entry, at) =>
    h(
      'div',
      {
        class: `slashrow${at === props.active ? ' on' : ''}`,
        id: `slashrow${at}`,
        key: entry.completion,
        role: 'option',
        'aria-selected': String(at === props.active),
        'aria-label': 'accessibleName' in entry ? entry.accessibleName : entry.name,
        onPointerDown: (event: PointerEvent) => {
          event.preventDefault();
        },
        onClick: () => props.take(entry),
      },
      [
        h('span', { class: 'slashhead', key: 'head' }, [
          h('span', { class: 'slashname', key: 'name' }, entry.label),
          'hint' in entry && entry.hint ? h('span', { class: 'slashhint', key: 'hint' }, entry.hint) : null,
        ]),
        'description' in entry && entry.description
          ? h('span', { class: 'slashwhy', key: 'description' }, entry.description)
          : null,
      ],
    ),
  );
}

// The caller names the element type that each known Preact root renders.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function renderedNode<T extends Element>(document: Document, child: ComponentChildren): T {
  const host = document.createElement('div');
  render(child, host);
  const node = host.firstElementChild;
  if (!node) {
    throw new Error('Composer component did not render its root.');
  }
  return node as T;
}

function attachLineClipboard(box: HTMLTextAreaElement): void {
  let copiedLine: { start: number; end: number; caret: number } | null = null;
  let menuSelection: { start: number; end: number; caret: number } | null = null;
  let interaction = 0;
  const clearMenu = (restoreCaret = false) => {
    if (
      restoreCaret &&
      menuSelection &&
      box.selectionStart === menuSelection.start &&
      box.selectionEnd === menuSelection.end
    ) {
      box.setSelectionRange(menuSelection.caret, menuSelection.caret);
    }
    copiedLine = null;
    menuSelection = null;
    interaction += 1;
  };
  box.addEventListener('pointerdown', () => clearMenu(true));
  box.addEventListener('blur', () => clearMenu(true));
  box.addEventListener('beforeinput', () => clearMenu(true));
  box.addEventListener('input', () => clearMenu());
  box.addEventListener('copy', () => {
    const line = copiedLine;
    clearMenu();
    if (!line || box.selectionStart !== line.start || box.selectionEnd !== line.end) {
      return;
    }
    const copiedAt = interaction;
    setTimeout(() => {
      if (interaction === copiedAt && box.selectionStart === line.start && box.selectionEnd === line.end) {
        box.setSelectionRange(line.caret, line.caret);
      }
    }, 0);
  });
  box.addEventListener('contextmenu', () => {
    clearMenu(true);
    if (box.selectionStart !== box.selectionEnd) {
      return;
    }
    const caret = box.selectionStart;
    const line = lineRange(box.value, caret, false);
    box.setSelectionRange(line.start, line.end);
    copiedLine = { ...line, caret };
    menuSelection = { ...line, caret };
  });
  box.addEventListener('cut', () => {
    const menuLine = menuSelection;
    if (!menuLine || box.selectionStart !== menuLine.start || box.selectionEnd !== menuLine.end) {
      clearMenu();
      return;
    }
    const line = lineRange(box.value, menuLine.caret, true);
    box.setSelectionRange(line.start, line.end);
    clearMenu();
  });
  box.addEventListener('paste', () => {
    clearMenu(true);
  });
  box.addEventListener('keydown', (event) => {
    clearMenu(true);
    const taking = lineIntent(event);
    if (!taking || box.selectionStart !== box.selectionEnd) {
      return;
    }
    const caret = box.selectionStart;
    const line = lineRange(box.value, caret, taking === 'cut');
    box.setSelectionRange(line.start, line.end);
    copiedLine = taking === 'copy' ? { ...line, caret } : null;
  });
}

// Codex `/rename` and Claude Remote Control send no attachments and do not wait for staging.
// All other drafts wait, including Claude `/rename`, which runs as a prompt.
export function sendWaitsForStaging(agent: string, text: string, staging: boolean): boolean {
  return staging && renameRequest(agent, text) === null && remoteControlRequest(agent, text) === null;
}

export function createComposerRenderer(options: ComposerOptions): ComposerRenderer {
  const { document } = options;
  const nodes: ComposerNodes = { slots: {} };
  const element = renderedNode<HTMLElement>(document, h(ComposerShell, { nodes, words: options.words }));
  let hidden = false;
  const prompt = nodes.prompt!;
  const skillLayer = nodes.skillLayer!;
  const selectionLayer = nodes.selectionLayer!;
  const sash = nodes.sash!;
  const slots = nodes.slots as ComposerSlots;
  const slashPopover = renderedNode<HTMLElement>(
    document,
    h('div', {
      id: 'slashpop',
      class: 'pop',
      hidden: true,
      role: 'listbox',
    }),
  );
  const walkAnnouncer = renderedNode<HTMLElement>(
    document,
    h('div', {
      id: 'walk-announcer',
      class: 'sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }),
  );

  let current: ComposerView | null = null;
  let aim: string | null = null;
  let pendingFocus: string | null = null;
  let dropping = false;
  const drafts = new Map<string, string>();
  const revisions = new Map<string, number>();
  const restorationAliases = new Map<string, string>();
  const sessionIdentity = (session: string): string => restorationAliases.get(session) ?? session;
  const revisionOrigin = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  let revisionClock = revisionOrigin;
  const undoStacks = new Map<string | null, UndoStack>();
  let historyWalk: HistoryWalk | null = null;
  let walkShutMenu = false;
  let walkTimer: ReturnType<typeof setTimeout> | null = null;

  let slashBox: HTMLTextAreaElement = prompt;
  let slashAt = 0;
  let slashShut = false;
  let slashDrawBox: HTMLTextAreaElement | null = null;
  let slashDrawPrint = '';
  const slashAttachments = new WeakMap<HTMLTextAreaElement, SlashAttachment>();
  let pathRows: PathEntry[] = [];
  let pathRequest = 0;
  let pathStateIdentity = '';
  let pathRequestIdentity = '';
  let pathResultIdentity = '';
  let pathTimer: ReturnType<typeof setTimeout> | null = null;
  let hostActivation: ReturnType<typeof setTimeout> | null = null;
  let pointerSkill: HTMLElement | null = null;
  let pointerPoint: { x: number; y: number } | null = null;
  let skillPress: {
    pointerId: number;
    x: number;
    y: number;
    command: string;
  } | null = null;
  let skillClick: HTMLElement | null = null;
  let skillValue = '';
  let skillMarks: SkillMark[] = [];
  let nextSkillKey = 0;
  let pendingSkillEdit: { value: string; start: number; end: number } | null = null;
  let pendingSkillDraw: { edit?: SkillEdit | null; restored?: readonly SkillMark[] } | null = null;
  const undoSkillMarks = new WeakMap<object, SkillMark[]>();

  const syncSkillLayer = () => {
    skillLayer.style.width = `${prompt.clientWidth}px`;
    selectionLayer.style.width = `${prompt.clientWidth}px`;
    skillLayer.scrollTop = prompt.scrollTop;
    skillLayer.scrollLeft = prompt.scrollLeft;
    selectionLayer.scrollTop = prompt.scrollTop;
    selectionLayer.scrollLeft = prompt.scrollLeft;
    const viewport = skillLayer.getBoundingClientRect();
    for (const skill of skillLayer.querySelectorAll<HTMLElement>('.cskilltoken')) {
      const visible =
        !hidden &&
        [...skill.getClientRects()].some(
          (rect) =>
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom &&
            rect.right > viewport.left &&
            rect.left < viewport.right,
        );
      skill.tabIndex = visible ? 0 : -1;
      options.statDetails.layout(skill, visible);
    }
    pointAtSkill(pointerPoint ? skillAtPoint(pointerPoint.x, pointerPoint.y) : null);
  };
  let menuHighlight: { value: string; start: number; end: number } | null = null;
  const clearMenuHighlight = () => {
    menuHighlight = null;
    if (selectionLayer.firstChild) {
      render(null, selectionLayer);
    }
  };
  let draftSetListener: (() => void) | null = null;
  const setPromptValue = (value: string) => {
    clearMenuHighlight();
    prompt.value = value;
    draftSetListener?.();
  };
  const showMenuHighlight = () => {
    const start = prompt.selectionStart;
    const end = prompt.selectionEnd;
    if (start === end) {
      clearMenuHighlight();
      return;
    }
    const value = prompt.value;
    menuHighlight = { value, start, end };
    render(
      [
        h('span', null, value.slice(0, start)),
        h('span', { class: 'cselected' }, value.slice(start, end)),
        h('span', null, value.slice(end)),
        value.endsWith('\n') ? h('span', null, '\u200b') : null,
      ],
      selectionLayer,
    );
    syncSkillLayer();
  };
  const reusableSkillKeys = (
    value: string,
    edit?: SkillEdit | null,
    restored?: readonly SkillMark[],
  ): Map<string, string> => {
    const reusable = new Map<string, string>();
    if (restored) {
      for (const mark of restored) {
        reusable.set(`${mark.command}\0${mark.start}\0${mark.end}`, mark.key);
      }
      return reusable;
    }
    if (value === skillValue) {
      for (const mark of skillMarks) {
        reusable.set(`${mark.command}\0${mark.start}\0${mark.end}`, mark.key);
      }
      return reusable;
    }
    if (
      !edit ||
      edit.start < 0 ||
      edit.oldEnd < edit.start ||
      edit.oldEnd > skillValue.length ||
      edit.newEnd < edit.start ||
      edit.newEnd > value.length ||
      skillValue.slice(0, edit.start) !== value.slice(0, edit.start) ||
      skillValue.slice(edit.oldEnd) !== value.slice(edit.newEnd)
    ) {
      return reusable;
    }
    const shift = edit.newEnd - edit.oldEnd;
    for (const mark of skillMarks) {
      const start = mark.end <= edit.start ? mark.start : mark.start >= edit.oldEnd ? mark.start + shift : null;
      if (start === null) {
        continue;
      }
      reusable.set(`${mark.command}\0${start}\0${start + mark.end - mark.start}`, mark.key);
    }
    return reusable;
  };
  const resetSkillIdentity = () => {
    skillValue = '';
    skillMarks = [];
  };
  const drawSkills = (edit?: SkillEdit | null, restored?: readonly SkillMark[]) => {
    // Codex skills receive highlights. Claude commands qualify when the skill list names them or has not arrived.
    // Claude panel controls and CLAUDE_NATIVE_COMMANDS receive no command highlights.
    const entries = [
      ...new Map(
        (current?.commands ?? [])
          .filter(
            (entry) =>
              entry.prefix === '/' &&
              !entry.panelControl &&
              (entry.kind === 'skill' ||
                (current?.agent === 'claude' &&
                  !CLAUDE_NATIVE_COMMANDS.has(entry.command.toLowerCase()) &&
                  claudeCommandIsSkill(entry.command, current?.claudeSkills ?? null))),
          )
          .map((entry) => [entry.label.toLowerCase(), entry]),
      ).values(),
    ].sort((left, right) => right.label.length - left.label.length);
    const value = prompt.value;
    const focusedSkill = skillLayer.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const reusable = reusableSkillKeys(value, edit, restored);
    const nextMarks: SkillMark[] = [];
    const parts: ComponentChildren[] = [];
    let cursor = 0;
    let at = 0;
    while (at < value.length) {
      const slash = value.indexOf('/', at);
      if (slash < 0) {
        break;
      }
      const token = promptToken(current?.agent ?? '', value, slash);
      if (!token || token.prefix !== '/' || token.start !== slash) {
        at = slash + 1;
        continue;
      }
      const entry = entries.find((candidate) => {
        if (value.slice(slash, slash + candidate.label.length).toLowerCase() !== candidate.label.toLowerCase()) {
          return false;
        }
        const suffix = value.slice(slash + candidate.label.length, token.end);
        return !suffix || /^[.,!?;:)\]}]+$/.test(suffix);
      });
      if (!entry) {
        at = slash + 1;
        continue;
      }
      if (slash > cursor) {
        parts.push(h('span', { 'aria-hidden': 'true', key: `text-${cursor}` }, value.slice(cursor, slash)));
      }
      const print = value.slice(slash, slash + entry.label.length);
      const end = slash + entry.label.length;
      const identity = `${entry.command}\0${slash}\0${end}`;
      const key = reusable.get(identity) ?? `skill-${nextSkillKey++}`;
      nextMarks.push({ command: entry.command, start: slash, end, key });
      // Claude entries carry paths only when the host finds their SKILL.md.
      // Entries without paths use pathless marks, accessible names and popovers.
      parts.push(
        h(
          'span',
          {
            role: 'button',
            tabIndex: 0,
            class: 'cskilltoken',
            key,
            'data-skill': entry.command,
            'aria-label': `Skill ${print}${entry.description ? `. ${entry.description}` : ''}${entry.path ? `. File ${entry.path}` : ''}`,
            onKeyDown: (event: KeyboardEvent) => {
              if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) {
                return;
              }
              event.preventDefault();
              (event.currentTarget as HTMLElement).click();
            },
            onFocus: syncSkillLayer,
            ref: (node: HTMLElement | null) => {
              if (!node) {
                return;
              }
              options.statDetails.mount(node, true);
              options.statDetails.update(node, entry.description || entry.label, {
                layout: 'stacked',
                heading: { label: entry.label },
                entries: entry.path ? [{ label: 'File', value: entry.path, valueTitle: entry.path }] : [],
                footer: [entry.description || 'No details supplied'],
              } satisfies StatDetailList);
            },
          },
          print,
        ),
      );
      cursor = slash + entry.label.length;
      at = cursor;
    }
    if (cursor < value.length) {
      parts.push(h('span', { 'aria-hidden': 'true', key: `text-${cursor}` }, value.slice(cursor)));
    }
    if (value.endsWith('\n')) {
      parts.push(h('span', { 'aria-hidden': 'true', key: 'trailing-line' }, '\u200b'));
    }
    skillValue = value;
    skillMarks = nextMarks;
    const undoStep = aim === null ? undefined : undoStacks.get(aim)?.done.at(-1);
    if (undoStep?.text === value) {
      undoSkillMarks.set(
        undoStep,
        nextMarks.map((mark) => ({ ...mark })),
      );
    }
    render(parts, skillLayer);
    if (focusedSkill && !focusedSkill.isConnected) {
      prompt.focus({ preventScroll: true });
    }
    syncSkillLayer();
  };

  const skillAtPoint = (x: number, y: number): HTMLElement | null => {
    for (const skill of skillLayer.querySelectorAll<HTMLElement>('.cskilltoken')) {
      if (
        [...skill.getClientRects()].some(
          (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
        )
      ) {
        return skill;
      }
    }
    return null;
  };
  const pointAtSkill = (next: HTMLElement | null) => {
    if (next === pointerSkill) {
      return;
    }
    if (pointerSkill) {
      pointerSkill.classList.remove('is-hovered');
      pointerSkill.dispatchEvent(new PointerEvent('pointerleave'));
    }
    pointerSkill = next;
    prompt.classList.toggle('is-over-skill', !!next);
    if (next) {
      next.classList.add('is-hovered');
      next.dispatchEvent(new PointerEvent('pointerenter'));
    }
  };
  const clearHostActivation = () => {
    if (hostActivation !== null) {
      clearTimeout(hostActivation);
    }
    hostActivation = null;
  };
  const armHostActivation = () => {
    clearHostActivation();
    const held = setTimeout(() => {
      if (hostActivation === held) {
        hostActivation = null;
      }
    }, HOST_ACTIVATION_GRACE_MS);
    hostActivation = held;
  };

  const revision = (session: string): number => revisions.get(session) ?? revisionOrigin;
  const advanceRevision = (session: string | null): number => {
    if (session === null) {
      return revisionOrigin;
    }
    const next = ++revisionClock;
    revisions.set(session, next);
    return next;
  };
  const undoStack = (): UndoStack => {
    let held = undoStacks.get(aim);
    if (!held) {
      held = undoStart(prompt.value, prompt.selectionStart, prompt.selectionEnd);
      undoStacks.set(aim, held);
    }
    return held;
  };
  const recordUndo = () =>
    undoRecord(undoStack(), prompt.value, prompt.selectionStart, prompt.selectionEnd, Date.now());
  const historyFiled = (value: string): string => (historyWalk?.text === value ? historyWalk.stash : value);
  const endWalk = () => {
    historyWalk = null;
    if (walkTimer !== null) {
      clearTimeout(walkTimer);
      walkTimer = null;
    }
    if (!walkShutMenu) {
      return;
    }
    walkShutMenu = false;
    slashShut = false;
  };
  const announceWalk = (said: string) => {
    walkAnnouncer.textContent = '';
    if (walkTimer !== null) {
      clearTimeout(walkTimer);
    }
    walkTimer = setTimeout(() => {
      walkAnnouncer.textContent = said;
      walkTimer = null;
    }, WALK_ANNOUNCE_MS);
  };
  const grow = () => {
    const floor = prompt.style.getPropertyValue('--prompt-floor');
    prompt.style.removeProperty('--prompt-floor');
    prompt.style.height = 'auto';
    const height = prompt.scrollHeight;
    if (floor) {
      prompt.style.setProperty('--prompt-floor', floor);
    }
    prompt.style.height = `${height}px`;
    const identity = pendingSkillDraw;
    pendingSkillDraw = null;
    drawSkills(identity?.edit, identity?.restored);
  };
  const commandRows = (): PromptEntryView[] => {
    if (slashShut || !current?.commands?.length) {
      return [];
    }
    if (slashBox.selectionStart !== slashBox.selectionEnd) {
      return [];
    }
    const token = promptToken(current?.agent ?? '', slashBox.value, slashBox.selectionStart);
    if (!token) {
      return [];
    }
    const entries = current.commands.filter((entry) => entry.prefix === token.prefix);
    const byName = new Map(entries.map((entry) => [entry.command, entry]));
    return matchCommandNames([...byName.keys()], token.typed)
      .map((name) => byName.get(name))
      .filter((entry): entry is PromptEntryView => entry !== undefined);
  };
  const pathIdentity = (): string | null => {
    if (historyWalk || slashBox !== prompt || aim === null || prompt.selectionStart !== prompt.selectionEnd) {
      return null;
    }
    const token = pathToken(prompt.value, prompt.selectionStart);
    return token ? JSON.stringify([aim, token.typed, prompt.selectionStart]) : null;
  };
  const invalidatePath = () => {
    if (pathTimer !== null) {
      clearTimeout(pathTimer);
      pathTimer = null;
    }
    pathRows = [];
    pathRequestIdentity = '';
    pathResultIdentity = '';
    pathRequest += 1;
  };
  const rows = (): Array<PromptEntryView | PathEntry> => {
    if (slashShut) {
      return [];
    }
    const commands = commandRows();
    if (commands.length) {
      return commands;
    }
    const identity = pathIdentity();
    return identity && pathResultIdentity === identity && pathRows.length ? pathRows : [];
  };
  const requestPath = () => {
    const identity = pathIdentity();
    if (identity !== pathStateIdentity) {
      pathStateIdentity = identity ?? '';
      invalidatePath();
    }
    if (!identity || commandRows().length || pathResultIdentity === identity || pathRequestIdentity === identity) {
      return;
    }
    const request = pathRequest;
    pathRequestIdentity = identity;
    pathTimer = setTimeout(() => {
      pathTimer = null;
      const token = pathToken(prompt.value, prompt.selectionStart);
      if (pathIdentity() !== identity || !token || commandRows().length || aim === null) {
        return;
      }
      options.sendToHost({
        type: 'pathCompletion',
        session: aim,
        request,
        token: token.typed,
        caret: prompt.selectionStart,
      });
    }, PATH_COMPLETION_DEBOUNCE_MS);
  };
  const placeSlash = () => {
    if (slashPopover.hidden) {
      return;
    }
    const at = slashBox.getBoundingClientRect();
    const box = slashPopover.getBoundingClientRect();
    const above = at.top - box.height - 4;
    const top = above >= 6 ? above : at.bottom + 4;
    slashPopover.style.top = `${Math.max(6, Math.min(top, window.innerHeight - box.height - 6))}px`;
    slashPopover.style.left = `${Math.max(6, Math.min(at.left, window.innerWidth - box.width - 6))}px`;
    slashPopover.style.width = `${Math.max(0, Math.min(at.width, window.innerWidth - 12))}px`;
  };
  const drawSlash = (preserveScroll = false) => {
    const entries = hidden && slashBox === prompt ? [] : rows();
    if (slashAt >= entries.length) {
      slashAt = 0;
    }
    const token = promptToken(current?.agent ?? '', slashBox.value, slashBox.selectionStart);
    const selection = [slashBox.selectionStart, slashBox.selectionEnd];
    const print = JSON.stringify([slashBox === prompt ? aim : null, token, selection, slashAt, entries]);
    const keepScroll = preserveScroll && slashDrawBox === slashBox && slashDrawPrint === print;
    const scroll = slashPopover.scrollTop;
    slashDrawBox = slashBox;
    slashDrawPrint = print;
    render(entries.length ? h(SlashRows, { entries, active: slashAt, take: takeCompletion }) : null, slashPopover);
    slashPopover.hidden = entries.length === 0;
    if (current?.completionName) {
      slashPopover.setAttribute('aria-label', current.completionName);
    }
    slashBox.setAttribute('aria-autocomplete', 'list');
    slashBox.setAttribute('aria-controls', 'slashpop');
    slashBox.setAttribute('aria-expanded', String(entries.length > 0));
    if (entries.length) {
      slashBox.setAttribute('aria-activedescendant', `slashrow${slashAt}`);
    } else {
      slashBox.removeAttribute('aria-activedescendant');
    }
    placeSlash();
    const active = slashPopover.querySelector<HTMLElement>('.slashrow.on');
    if (keepScroll) {
      slashPopover.scrollTop = scroll;
    } else {
      active?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  const hideSlash = () => {
    slashPopover.hidden = true;
    slashBox.setAttribute('aria-expanded', 'false');
    slashBox.removeAttribute('aria-activedescendant');
  };
  const boxChanged = (keep?: string, edit?: SkillEdit | null, restored?: readonly SkillMark[]) => {
    const held = typeof keep === 'string' ? keep : prompt.value;
    if (aim !== null) {
      drafts.set(aim, held);
    }
    pendingSkillDraw = { edit, restored };
    grow();
    const path = pathToken(prompt.value, prompt.selectionStart);
    if (!promptToken(current?.agent ?? '', prompt.value, prompt.selectionStart) && !path) {
      slashShut = false;
    }
    if (path) {
      slashShut = false;
    }
    slashAt = 0;
    requestPath();
    drawSlash();
    if (aim !== null) {
      options.sendToHost({ type: 'draft', text: prompt.value, keep: held, session: aim, revision: revision(aim) });
    }
  };
  const takeCommand = (entry: PromptEntryView | PathEntry | undefined) => {
    if (!entry || 'directory' in entry) {
      return;
    }
    const token = promptToken(current?.agent ?? '', slashBox.value, slashBox.selectionStart);
    if (!token) {
      return;
    }
    const before = slashBox.value.slice(0, token.start);
    const after = slashBox.value.slice(token.end);
    const rest = after.charAt(0) === ' ' ? after.slice(1) : after;
    const caret = before.length + entry.completion.length;
    const completed = before + entry.completion + rest;
    if (slashBox === prompt) {
      setPromptValue(completed);
    } else {
      slashBox.value = completed;
    }
    slashBox.focus();
    slashBox.setSelectionRange(caret, caret);
    if (slashBox === prompt) {
      endWalk();
      advanceRevision(aim);
      recordUndo();
      boxChanged(undefined, { start: token.start, oldEnd: token.end, newEnd: token.start + entry.completion.length });
    } else {
      slashAttachments.get(slashBox)?.onComplete?.();
    }
    slashAt = 0;
    drawSlash();
  };
  const takePath = (entry: PathEntry | undefined) => {
    const identity = pathIdentity();
    if (!entry || slashBox !== prompt || !identity || pathResultIdentity !== identity) {
      return;
    }
    const token = pathToken(prompt.value, prompt.selectionStart);
    if (!token) {
      return;
    }
    const quote = prompt.value.charAt(token.start - 1);
    const quoted = /^["'`]$/.test(quote);
    const completion = quoted || !/\s/.test(entry.completion) ? entry.completion : `"${entry.completion}"`;
    const before = prompt.value.slice(0, token.start);
    setPromptValue(before + completion + prompt.value.slice(token.end));
    const end = before.length + completion.length;
    const keptClosingQuote = quoted && prompt.value.charAt(end) === quote;
    const addedClosingQuote = !quoted && completion.startsWith('"');
    const caret = entry.directory && addedClosingQuote ? end - 1 : end + (!entry.directory && keptClosingQuote ? 1 : 0);
    prompt.focus();
    prompt.setSelectionRange(caret, caret);
    endWalk();
    advanceRevision(aim);
    undoBreak(undoStack());
    recordUndo();
    undoBreak(undoStack());
    boxChanged(undefined, { start: token.start, oldEnd: token.end, newEnd: end });
  };
  let pendingInsert: { session: string; text: string } | null = null;
  const insertIntoPrompt = (text: string) => {
    const value = prompt.value;
    const start = Math.min(prompt.selectionStart, prompt.selectionEnd);
    const end = Math.max(prompt.selectionStart, prompt.selectionEnd);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${/^\s/.test(after) ? '' : ' '}`;
    setPromptValue(before + inserted + after);
    const caret = before.length + inserted.length;
    prompt.focus();
    prompt.setSelectionRange(caret, caret);
    endWalk();
    advanceRevision(aim);
    undoBreak(undoStack());
    recordUndo();
    undoBreak(undoStack());
    boxChanged(undefined, { start, oldEnd: end, newEnd: start + inserted.length });
  };
  const takeCompletion = (entry: PromptEntryView | PathEntry | undefined) => {
    if (!entry) {
      return;
    }
    if ('directory' in entry) {
      takePath(entry);
    } else {
      takeCommand(entry);
    }
  };
  const slashKeydown = (event: KeyboardEvent): boolean => {
    if (document.activeElement !== slashBox) {
      return false;
    }
    const entries = rows();
    if (!entries.length) {
      return false;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      slashAt = (slashAt + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length;
      drawSlash();
      return true;
    }
    if (
      (event.key === 'Enter' || event.key === 'Tab') &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const entry = entries[slashAt];
      if ('directory' in entry && event.key !== 'Tab') {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      if ('directory' in entry) {
        takePath(entry);
      } else {
        takeCommand(entries[slashAt]);
      }
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      slashShut = true;
      drawSlash();
      return true;
    }
    return false;
  };
  const handleHistoryKey = (event: KeyboardEvent): boolean => {
    if (event.isComposing || event.keyCode === 229) {
      return false;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return false;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return false;
    }
    if (historyWalk && slashShut && !walkShutMenu) {
      historyWalk.shut = true;
    }
    const submissions = options.recovery.recovery();
    const owned = new Set(
      submissions
        .filter((attempt) => sessionIdentity(attempt.owner ?? attempt.source) === aim)
        .map((attempt) => attempt.id),
    );
    const walk = historyWalk ?? {
      list: [
        ...submissions
          .filter((attempt) => owned.has(attempt.id))
          .reverse()
          .map((attempt) => ({ text: attempt.text, submission: attempt.id })),
        ...(current?.sessionId === aim && Array.isArray(current.history)
          ? current.history.map((text) => ({ text }))
          : []),
      ],
      at: 0,
      stash: prompt.value,
      text: prompt.value,
      shut: slashShut,
    };
    const intended = historyPress(
      walk.list.length,
      walk.at,
      event.key === 'ArrowUp',
      prompt.selectionStart,
      prompt.selectionStart !== prompt.selectionEnd,
    );
    if (!intended.take) {
      return false;
    }
    const selected = walk.list[walk.at - 1];
    const eligible = (entry: HistoryWalk['list'][number]) =>
      entry.submission === undefined || owned.has(entry.submission);
    const before = walk.list.slice(0, walk.at).filter(eligible).length;
    walk.list = walk.list.filter(eligible);
    const removed = walk.at > 0 && !eligible(selected);
    walk.at = before;
    const moved = removed
      ? { at: event.key === 'ArrowUp' ? Math.min(before + 1, walk.list.length) : before }
      : historyPress(walk.list.length, walk.at, event.key === 'ArrowUp', prompt.selectionStart, false);
    event.preventDefault();
    const stepped = removed || moved.at !== walk.at;
    if (stepped) {
      setPromptValue(moved.at === 0 ? walk.stash : walk.list[moved.at - 1].text);
      const caret = moved.at === 0 ? 0 : prompt.value.length;
      prompt.setSelectionRange(caret, caret);
    }
    walk.at = moved.at;
    walk.text = prompt.value;
    if (moved.at === 0) {
      endWalk();
    } else {
      historyWalk = walk;
    }
    if (stepped) {
      resetSkillIdentity();
      recordUndo();
      boxChanged(walk.stash);
      const standing = moved.at > 0 && !!promptToken(current?.agent ?? '', prompt.value, prompt.selectionStart);
      walkShutMenu = standing && !walk.shut;
      slashShut = standing || walk.shut;
      drawSlash();
    }
    announceWalk(historySaid(moved.at, walk.list.length, prompt.value, stepped));
    return true;
  };
  const undoMove = (back: boolean) => {
    const stack = undoStack();
    const target = back ? stack.done.at(-2) : stack.undone.at(-1);
    const step = undoTake(stack, back);
    if (!step) {
      return;
    }
    setPromptValue(step.text);
    prompt.setSelectionRange(step.start, step.end);
    endWalk();
    advanceRevision(aim);
    boxChanged(undefined, null, target ? undoSkillMarks.get(target) : undefined);
  };
  const aimAt = (session: string) => {
    if (aim === session && undoStacks.has(session)) {
      return;
    }
    clearMenuHighlight();
    if (aim !== null) {
      const held = historyFiled(prompt.value);
      drafts.set(aim, held);
      if (held !== prompt.value) {
        options.sendToHost({ type: 'draft', text: held, keep: held, session: aim, revision: revision(aim) });
      }
    }
    aim = session;
    setPromptValue(drafts.get(session) ?? '');
    resetSkillIdentity();
    if (!undoStacks.has(session)) {
      undoStacks.set(session, undoStart(prompt.value, prompt.selectionStart, prompt.selectionEnd));
    }
    slashShut = false;
    slashAt = 0;
    endWalk();
    requestPath();
  };
  const attachSlash = (box: HTMLTextAreaElement, ownsInput = true) => {
    slashAttachments.set(box, { ownsInput });
    slashBox = box;
    slashAt = 0;
    slashShut = false;
    if (ownsInput) {
      box.addEventListener('input', () => {
        if (slashBox !== box) {
          return;
        }
        if (!promptToken(current?.agent ?? '', box.value, box.selectionStart)) {
          slashShut = false;
        }
        slashAt = 0;
        drawSlash();
      });
    }
    box.addEventListener('focus', () => {
      slashBox = box;
      drawSlash();
    });
    box.addEventListener('blur', hideSlash);
    if (box !== prompt) {
      box.addEventListener('keydown', slashKeydown);
    }
  };

  prompt.addEventListener('beforeinput', () => {
    pendingSkillEdit = { value: prompt.value, start: prompt.selectionStart, end: prompt.selectionEnd };
  });
  prompt.addEventListener('input', (event) => {
    clearMenuHighlight();
    const pending = pendingSkillEdit;
    pendingSkillEdit = null;
    let edit: SkillEdit | null = null;
    if (event instanceof InputEvent && pending?.value === skillValue) {
      let { start, end } = pending;
      const removed = pending.value.length - prompt.value.length;
      const inputType = event.inputType ?? '';
      if (start === end && removed > 0 && inputType.startsWith('delete')) {
        if (inputType === 'deleteContentBackward') {
          start -= removed;
        } else {
          end += removed;
        }
      }
      edit = { start, oldEnd: end, newEnd: start + prompt.value.length - (pending.value.length - (end - start)) };
    } else if (event instanceof InputEvent) {
      if (event.data !== null && (event.inputType ?? '').startsWith('insert')) {
        const start = prompt.selectionStart - event.data.length;
        edit = {
          start,
          oldEnd: start + skillValue.length + event.data.length - prompt.value.length,
          newEnd: prompt.selectionStart,
        };
      }
    }
    recordUndo();
    endWalk();
    advanceRevision(aim);
    boxChanged(undefined, edit);
  });
  prompt.addEventListener('scroll', syncSkillLayer);
  skillLayer.addEventListener('scroll', () => {
    if (skillLayer.scrollTop !== prompt.scrollTop || skillLayer.scrollLeft !== prompt.scrollLeft) {
      syncSkillLayer();
    }
  });
  prompt.addEventListener('pointerdown', (event) => {
    clearMenuHighlight();
    if (event.button === 0) {
      armHostActivation();
    } else {
      clearHostActivation();
    }
    skillClick = null;
    const skill = skillAtPoint(event.clientX, event.clientY);
    options.statDetails.pointerAnchor(event, skill);
    skillPress =
      skill && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        ? {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            command: skill.dataset.skill ?? '',
          }
        : null;
  });
  prompt.addEventListener('pointermove', (event) => {
    pointerPoint = { x: event.clientX, y: event.clientY };
    pointAtSkill(skillAtPoint(event.clientX, event.clientY));
  });
  prompt.addEventListener('pointerleave', () => {
    pointerPoint = null;
    pointAtSkill(null);
  });
  prompt.addEventListener('pointerup', (event) => {
    const press = skillPress;
    skillPress = null;
    if (
      !press ||
      press.pointerId !== event.pointerId ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4
    ) {
      return;
    }
    const skill = skillAtPoint(event.clientX, event.clientY);
    skillClick = skill?.dataset.skill === press.command ? skill : null;
  });
  prompt.addEventListener('pointercancel', () => {
    skillPress = null;
    skillClick = null;
  });
  prompt.addEventListener('click', (event) => {
    const skill = skillClick;
    skillClick = null;
    if (!skill) {
      return;
    }
    const clicks = event.detail;
    queueMicrotask(() => {
      if (!skill.isConnected) {
        return;
      }
      if (clicks > 1 ? skill.getAttribute('aria-pressed') !== 'true' : prompt.selectionStart !== prompt.selectionEnd) {
        return;
      }
      skill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
  prompt.addEventListener('keydown', (event) => {
    clearMenuHighlight();
    const pinnedSkill = skillLayer.querySelector('[aria-pressed="true"]');
    if (event.key === 'Escape' && !pinnedSkill && !slashPopover.hidden && slashKeydown(event)) {
      return;
    }
    if (event.key === 'Escape' && options.statDetails.dismiss()) {
      event.preventDefault();
      return;
    }
    const wanted = undoIntent(event);
    if (wanted) {
      event.preventDefault();
      event.stopPropagation();
      undoMove(wanted === 'undo');
      return;
    }
    if (prompt.selectionStart === 0 && prompt.selectionEnd === 0 && handleHistoryKey(event)) {
      return;
    }
    if (slashKeydown(event) || handleHistoryKey(event)) {
      return;
    }
    // The send chord submits the typed text even when completion is open. Plain Enter and Tab accept a completion first.
    if (isSendChord(event, options.platform)) {
      event.preventDefault();
      controller.send(true);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      controller.send(true);
    }
  });
  prompt.addEventListener('contextmenu', () => {
    clearHostActivation();
    showMenuHighlight();
  });
  for (const action of ['copy', 'cut', 'paste', 'beforeinput']) {
    prompt.addEventListener(action, clearMenuHighlight);
  }
  attachLineClipboard(prompt);
  attachSlash(prompt, false);
  options.events.document('selectionchange', () => {
    if (document.activeElement === prompt) {
      if (
        !menuHighlight ||
        menuHighlight.value !== prompt.value ||
        menuHighlight.start !== prompt.selectionStart ||
        menuHighlight.end !== prompt.selectionEnd
      ) {
        clearMenuHighlight();
      }
      requestPath();
      drawSlash(true);
    }
  });
  // The page-level send chord also works after comment saving returns focus to a card.
  // Editable controls and open comment editors retain their keys. Already handled keys remain handled.
  // Prevent the default only after sending succeeds, so refused sends retain native link activation.
  options.events.document('keydown', (raw) => {
    const event = raw as KeyboardEvent;
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (!isSendChord(event, options.platform) || aim === null) {
      return;
    }
    if (editableTarget(event.target) || options.commentEditorOpen()) {
      return;
    }
    if (controller.send(true)) {
      event.preventDefault();
    }
  });
  // Capture open popovers before their owners close them. Escape stops work only when no popover was open.
  const transientEscapes = new WeakSet<Event>();
  options.events.window(
    'keydown',
    (raw) => {
      const event = raw as KeyboardEvent;
      if (event.key === 'Escape' && options.document.querySelector('.pop:not([hidden])')) {
        transientEscapes.add(event);
      }
    },
    true,
  );
  options.events.window('keydown', (raw) => {
    const event = raw as KeyboardEvent;
    if (
      event.defaultPrevented ||
      event.key !== 'Escape' ||
      event.isComposing ||
      event.keyCode === 229 ||
      aim === null ||
      transientEscapes.has(event)
    ) {
      return;
    }
    if (editableTarget(event.target) && event.target !== prompt) {
      return;
    }
    if (current?.box.actionControl !== 'stop' || prompt.value.trim()) {
      return;
    }
    controller.send(false);
  });
  options.events.document('pointerdown', (raw) => {
    const event = raw as PointerEvent;
    clearMenuHighlight();
    if (event.target !== prompt) {
      clearHostActivation();
    }
    if (!slashPopover.hidden && !slashPopover.contains(event.target as Node) && event.target !== prompt) {
      slashShut = true;
      drawSlash();
    }
  });
  // VS Code sometimes focuses its outer webview frame after a window-activation click.
  // Restore that prompt click with its existing caret or selection.
  options.events.window('blur', () => {
    if (hostActivation === null) {
      return;
    }
    const held = hostActivation;
    const session = aim;
    const start = prompt.selectionStart;
    const end = prompt.selectionEnd;
    setTimeout(() => {
      if (hostActivation !== held) {
        return;
      }
      clearHostActivation();
      const active = document.activeElement;
      if (
        session !== aim ||
        element.hidden ||
        (active !== prompt && active !== document.body && active !== document.documentElement)
      ) {
        return;
      }
      prompt.focus({ preventScroll: true });
      prompt.setSelectionRange(start, end);
    }, 0);
  });
  options.events.window('resize', syncSkillLayer);

  const controller: ComposerRenderer = {
    element,
    prompt,
    slashPopover,
    walkAnnouncer,
    slots,
    setHidden(value) {
      if (options.readOnly) {
        element.hidden = true;
        element.style.display = 'none';
        value = true;
      }
      hidden = value;
      if (hidden) pendingFocus = null;
      drawSlash();
      syncSkillLayer();
    },
    update(view) {
      current = view;
      if (view) {
        if (!drafts.has(view.sessionId)) {
          drafts.set(view.sessionId, view.draft);
        }
        aimAt(view.sessionId);
        const placeholder = dropping ? view.box.dropPlaceholder : view.box.placeholder;
        prompt.placeholder = placeholder;
        actionable(prompt, placeholder, 'prompt');
        if (!element.classList.contains('composer-hidden')) {
          sash.setAttribute('aria-label', view.box.heightName);
        }
        sash.dataset.hint = view.box.heightHint;
        sash.dataset.hintDetail = view.box.heightHintDetail;
      }
      element.hidden = !view;
      grow();
      drawSlash(true);
      if (pendingInsert && view && sessionIdentity(view.sessionId) === pendingInsert.session && !element.hidden) {
        const waiting = pendingInsert;
        pendingInsert = null;
        insertIntoPrompt(waiting.text);
      }
      if (pendingFocus && view?.sessionId === pendingFocus && !element.hidden && !hidden) {
        pendingFocus = null;
        prompt.focus();
      }
    },
    view: () => current,
    session: () => aim,
    focus(session) {
      pendingFocus = session;
      if (!current || current.sessionId !== session || element.hidden || hidden) {
        return false;
      }
      pendingFocus = null;
      prompt.focus();
      return true;
    },
    takeDraft(session, text, messageRevision) {
      const target = sessionIdentity(session);
      if (messageRevision !== undefined && revision(target) !== messageRevision) {
        return null;
      }
      advanceRevision(target);
      if (aim !== target) {
        drafts.set(target, text);
        undoStacks.set(target, undoStart(text, text.length, text.length));
        return target;
      }
      aimAt(target);
      drafts.set(target, text);
      setPromptValue(text);
      resetSkillIdentity();
      endWalk();
      recordUndo();
      slashShut = false;
      slashAt = 0;
      grow();
      requestPath();
      drawSlash();
      return target;
    },
    restoreDraft(session, text, messageRevision) {
      const target = sessionIdentity(session);
      if (revision(target) !== messageRevision) {
        return false;
      }
      drafts.set(target, text);
      if (aim === target) {
        setPromptValue(text);
        resetSkillIdentity();
        endWalk();
        recordUndo();
        grow();
        requestPath();
        drawSlash();
      }
      return true;
    },
    adoptSessionIdentity(provisional, durable) {
      if (!provisional || !durable || provisional === durable) {
        return false;
      }
      restorationAliases.delete(provisional);
      restorationAliases.set(provisional, durable);
      while (restorationAliases.size > RESTORATION_ALIAS_LIMIT) {
        const oldest = restorationAliases.keys().next().value;
        if (!oldest) {
          break;
        }
        restorationAliases.delete(oldest);
      }
      const provisionalRevision = revisions.get(provisional);
      const durableRevision = revisions.get(durable);
      const durableHasState = drafts.has(durable) || durableRevision !== undefined || undoStacks.has(durable);
      const provisionalIsNewer =
        provisionalRevision !== undefined && (durableRevision === undefined || provisionalRevision > durableRevision);
      const moveState = aim !== durable && (!durableHasState || provisionalIsNewer);
      if (moveState) {
        const text = aim === provisional ? historyFiled(prompt.value) : drafts.get(provisional);
        if (text !== undefined) {
          drafts.set(durable, text);
        }
        if (provisionalRevision !== undefined) {
          revisions.set(durable, provisionalRevision);
        }
        const stack = aim === provisional ? undoStack() : undoStacks.get(provisional);
        if (stack) {
          undoStacks.set(durable, stack);
        }
      }
      drafts.delete(provisional);
      revisions.delete(provisional);
      undoStacks.delete(provisional);
      if (pendingFocus === provisional) {
        pendingFocus = durable;
      }
      if (aim === provisional) {
        aim = durable;
        if (!moveState) {
          setPromptValue(drafts.get(durable) ?? '');
          resetSkillIdentity();
          endWalk();
        }
        pathStateIdentity = '';
        invalidatePath();
      }
      return true;
    },
    sessionIdentity,
    endHistoryIntoPrompt() {
      if (!historyWalk || historyWalk.text !== prompt.value) {
        endWalk();
        return;
      }
      const held = historyWalk.stash;
      if (held === prompt.value) {
        endWalk();
        return;
      }
      endWalk();
      setPromptValue(held);
      prompt.setSelectionRange(held.length, held.length);
      recordUndo();
      boxChanged();
    },
    send(fromKey) {
      if (options.readOnly) return false;
      const view = current;
      const box = view?.box;
      if (!view || !box) {
        return false;
      }
      if (sendWaitsForStaging(view.agent, prompt.value, options.isFileStaging(aim))) {
        return false;
      }
      if (!box.actionEnabled && view.files.length) {
        return false;
      }
      // Key sends use local comments before the host's annotation count arrives.
      // The host rejects comments already assigned to queued submissions, so this check does not guarantee delivery.
      if (!fromKey) {
        if (box.actionControl === 'stop') {
          if (aim !== null) {
            options.sendToHost({ type: 'stopTurn', session: aim });
          }
          return false;
        }
        if (!box.actionEnabled) {
          return false;
        }
      } else if (!prompt.value.trim() && !(view.annotations || view.files.length || options.hasLocalComments(aim))) {
        return false;
      }
      if (aim === null) {
        return false;
      }
      const next = advanceRevision(aim);
      let attempt;
      try {
        attempt = options.recovery.submit(aim, next, prompt.value, view.recoverySetup);
      } catch (error) {
        options.submissionNotice(
          aim,
          error instanceof Error ? error.message : 'This prompt could not be saved. Copy it before trying again.',
        );
        return false;
      }
      options.submissionNotice(aim, null);
      options.sendToHost({ type: 'sendPrompt', text: prompt.value, session: aim, revision: next, attempt });
      drafts.set(aim, '');
      setPromptValue('');
      undoStacks.set(aim, undoStart('', 0, 0));
      slashShut = false;
      slashAt = 0;
      endWalk();
      grow();
      requestPath();
      return true;
    },
    grow,
    setDropping(value) {
      dropping = value;
      element.classList.toggle('dropping', value);
      if (current) {
        prompt.placeholder = value ? current.box.dropPlaceholder : current.box.placeholder;
      }
    },
    onDraftSet(listener) {
      draftSetListener = listener;
    },
    actionIcon(kind) {
      const mark =
        kind === 'stop'
          ? h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1 })
          : h('path', { d: 'M3.5 8.5 8 4l4.5 4.5M8 4v9' });
      return renderedNode<SVGSVGElement>(
        document,
        h(
          'svg',
          {
            viewBox: '0 0 16 16',
            'aria-hidden': 'true',
          },
          mark,
        ),
      );
    },
    prune(sessions) {
      const listed = new Set(sessions.map((session) => session.id));
      for (const session of undoStacks.keys()) {
        if (session !== null && !listed.has(session)) {
          undoStacks.delete(session);
        }
      }
    },
    advanceRevision,
    revision,
    layout: syncSkillLayer,
    attachSlash(area) {
      attachSlash(area, true);
    },
    releaseSlash(area) {
      if (slashBox !== area) {
        return;
      }
      hideSlash();
      slashBox = prompt;
      slashShut = false;
      slashAt = 0;
    },
    drawSlash,
    openSlash() {
      slashShut = false;
      slashAt = 0;
      drawSlash();
    },
    closeSlash() {
      slashShut = true;
      drawSlash();
    },
    insertAtCaret(session, text) {
      const target = sessionIdentity(session);
      if (!text || options.readOnly) {
        return;
      }
      if (aim !== target || !current || element.hidden) {
        pendingInsert = { session: target, text };
        return;
      }
      insertIntoPrompt(text);
    },
    takePathCompletion(session, request, token, caret, rows) {
      const identity = pathIdentity();
      const expected = JSON.stringify([session, token, caret]);
      if (session !== aim || request !== pathRequest || identity !== expected || pathRequestIdentity !== identity) {
        return;
      }
      pathRows = rows;
      pathRequestIdentity = '';
      pathResultIdentity = identity;
      slashAt = 0;
      drawSlash();
    },
    attachLineClipboard,
  };
  return controller;
}
