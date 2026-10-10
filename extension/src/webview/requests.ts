import { h, render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { completedQuestionAnswer, questionAnswered } from '../domain/ask-answer.ts';
import type { ComposerView, PanelToHost } from './protocol.ts';
import { enhanceSummary } from './summary.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import { textField } from './text-field.ts';

type AskCard = ComposerView['asks'][number];
type AskQuestion = AskCard['questions'][number];
type AskChoice = AskQuestion['choices'][number];
type Picked = Record<string, string[]>;
type Written = Record<string, string | undefined>;

const CHOSEN = '\u2713';
const ASK_TAB_ROWS = 2;
// Hold request and draft-setup announcements for this interval.
// New text joins retained announcements. aria-atomic reads the combined text.
const ASK_ANNOUNCE_HOLD_MS = 1000;
const ASK_CONTINUE =
  '.cask .caskaction:not([disabled]), .cask .caskchoice input:not([disabled]),' + ' .cask .caskwritten:not([disabled])';
let idSerial = 0;

interface RequestOptions {
  document: Document;
  mount: HTMLElement;
  prompt: HTMLTextAreaElement;
  moveAnnouncer: HTMLElement;
  events: {
    window(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
  cross: string;
  sendToHost(message: PanelToHost): void;
  afterDraw(): void;
}

interface RequestState {
  picked: Picked;
  written: Written;
  carets: Record<string, [number, number]>;
  shown: number;
  open: boolean;
  submitting: boolean;
}

export interface RequestRenderer {
  askAnnouncer: HTMLElement;
  sendAnnouncer: HTMLElement;
  update(view: ComposerView | null): void;
  reject(session: string, id: string): void;
  announce(words: string): void;
  fitTabs(): void;
}

function requestKey(view: ComposerView, card: AskCard): string {
  return `${view.sessionId}\n${card.id}`;
}

export function requestIdentity(view: ComposerView): string {
  return JSON.stringify([view.sessionId, view.asks.map((card) => card.id)]);
}

function askValue(question: AskQuestion, picked: Picked, written: Written): string {
  const typed = written[question.id];
  return typeof typed === 'string' ? typed : (picked[question.id] ?? []).join(', ');
}

function nextQuestion(card: AskCard, picked: Picked, written: Written, from: number): number {
  for (let step = 1; step <= card.questions.length; step += 1) {
    const at = (from + step) % card.questions.length;
    if (!questionAnswered(card.questions[at].id, picked, written)) {
      return at;
    }
  }
  return from;
}

function hasTabs(card: AskCard): boolean {
  return card.questions.length > 1;
}

function QuestionMarkdown({ html, post }: { html: string; post(message: PanelToHost): void }): ComponentChildren {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (root.current ? enhanceSummary(root.current, { post, words: CARD_ACTIONS }) : undefined),
    [html],
  );
  return h('div', { class: 'summary caskmarkdown', ref: root, dangerouslySetInnerHTML: { __html: html } });
}

function AskCardView(props: {
  view: ComposerView;
  card: AskCard;
  state: RequestState;
  twist: { open: string; shut: string };
  cross: string;
  sendToHost(message: PanelToHost): void;
  focusAfter(control: string): void;
  announceMove(words: string): void;
  submitted(control: string): void;
  afterDraw(): void;
}): ComponentChildren {
  const { card, view } = props;
  const [, setRevision] = useState(0);
  const redraw = () => setRevision((revision) => revision + 1);
  const { picked, written, shown, open, submitting } = props.state;
  const base = useRef('');
  if (!base.current) {
    base.current = `ask${++idSerial}`;
  }
  const at = Math.max(0, Math.min(shown, card.questions.length - 1));
  const answer =
    card.kind === 'question'
      ? completedQuestionAnswer(
          card.questions.map((question) => question.id),
          picked,
          written,
        )
      : null;
  const done = answer !== null;
  const question = card.questions[at];

  useLayoutEffect(() => {
    props.afterDraw();
  });

  const move = (next: number, announce = false) => {
    props.state.shown = next;
    redraw();
    const control = `asktab:${card.id}:${card.questions[next].id}`;
    props.focusAfter(control);
    if (announce) {
      props.announceMove(`${card.steps[next]}. ${card.questions[next].legendText}`);
    }
  };
  const submit = (value: AskCard['actions'][number]['answer'], control: string) => {
    if (submitting) {
      return;
    }
    props.state.submitting = true;
    redraw();
    props.submitted(control);
    props.sendToHost({ type: 'answerAsk', session: view.sessionId, id: card.id, answer: value });
  };
  const takePrimaryAction = () => {
    if (submitting || !question || !questionAnswered(question.id, picked, written)) {
      return;
    }
    if (answer) {
      submit(answer, `ask:${card.id}:answer`);
      return;
    }
    const next = nextQuestion(card, picked, written, at);
    if (next !== at) {
      move(next, true);
    }
  };
  const choose = (question: AskQuestion, choice: AskChoice, checked: boolean) => {
    const nextPicked: Picked = { ...picked };
    const nextWritten: Written = { ...written };
    if (choice.written) {
      if (checked) {
        nextWritten[question.id] = nextWritten[question.id] ?? '';
        nextPicked[question.id] = [];
      } else {
        delete nextWritten[question.id];
      }
    } else {
      delete nextWritten[question.id];
      if (question.multiSelect) {
        const labels = new Set(nextPicked[question.id] ?? []);
        if (checked) {
          labels.add(choice.label);
        } else {
          labels.delete(choice.label);
        }
        nextPicked[question.id] = [...labels];
      } else {
        nextPicked[question.id] = checked ? [choice.label] : [];
      }
    }
    props.state.picked = nextPicked;
    props.state.written = nextWritten;
    redraw();
    if (!question.multiSelect && !choice.written && questionAnswered(question.id, nextPicked, nextWritten)) {
      const next = nextQuestion(card, nextPicked, nextWritten, at);
      if (next !== at) {
        move(next, true);
      }
    }
  };
  const foldCount =
    !open && card.answeredWords.length
      ? card.answeredWords[card.questions.filter((question) => questionAnswered(question.id, picked, written)).length]
      : '';
  const state = submitting ? card.sendingWord : card.stateWord;
  const foldName = `${open ? card.shutName : card.openName}${foldCount ? ` ${foldCount}.` : ''}${state ? ` ${state}` : ''}`;

  const tabs = hasTabs(card)
    ? h(
        'div',
        {
          class: 'casktabs',
          role: 'tablist',
          'aria-label': card.title,
          onKeyDown(event: KeyboardEvent) {
            let next = at;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              next = (at + 1) % card.questions.length;
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              next = (at + card.questions.length - 1) % card.questions.length;
            } else if (event.key === 'Home') {
              next = 0;
            } else if (event.key === 'End') {
              next = card.questions.length - 1;
            } else {
              return;
            }
            event.preventDefault();
            if (next !== at) {
              move(next);
            }
          },
        },
        card.questions.map((question, index) => {
          const selected = index === at;
          const answered = questionAnswered(question.id, picked, written);
          const value = askValue(question, picked, written);
          const name = !answered
            ? question.tabName
            : question.secret
              ? question.tabAnsweredName
              : `${question.tabAnsweredName} ${value}`;
          return h(
            'button',
            {
              class: `casktab${answered ? ' is-answered' : ''}${question.secret ? ' is-secret' : ''}`,
              key: question.id,
              role: 'tab',
              id: `${base.current}-tab-${index}`,
              'aria-selected': String(selected),
              'aria-controls': selected ? `${base.current}-panel-${at}` : undefined,
              'aria-label': name,
              'data-control': `asktab:${card.id}:${question.id}`,
              'data-hint': name,
              'data-hint-detail': question.legendText,
              tabIndex: selected ? 0 : -1,
              disabled: submitting,
              onClick() {
                move(index);
              },
            },
            [
              h('span', { class: 'casktabname' }, question.tab),
              question.secret ? null : h('span', { class: 'casktabpick' }, value),
              h('span', { class: 'casktabtick' }, CHOSEN),
            ],
          );
        }),
      )
    : null;

  const questionNode = question
    ? h(
        'fieldset',
        {
          class: 'caskquestion',
          role: hasTabs(card) ? 'tabpanel' : undefined,
          id: hasTabs(card) ? `${base.current}-panel-${at}` : undefined,
          'aria-labelledby': `${base.current}-legend-${at}`,
        },
        [
          h('div', { class: 'casklegend', id: `${base.current}-legend-${at}` }, [
            question.key && !hasTabs(card) ? h('span', { class: 'caskkey' }, question.key) : null,
            question.key && !hasTabs(card) ? ' ' : null,
            h(QuestionMarkdown, { html: question.legendHtml, post: props.sendToHost }),
          ]),
          question.hint ? h('div', { class: 'caskhint' }, question.hint) : null,
          ...question.choices.flatMap((choice) => {
            const checked = choice.written
              ? typeof written[question.id] === 'string'
              : (picked[question.id] ?? []).includes(choice.label);
            const row: ComponentChildren[] = [
              h(
                'label',
                {
                  class: `caskchoice${checked ? ' is-picked' : ''}`,
                  key: `choice:${choice.label}`,
                },
                [
                  h('input', {
                    type: question.multiSelect ? 'checkbox' : 'radio',
                    name: `ask-${view.sessionId}-${card.id}-${question.id}`,
                    value: choice.label,
                    checked,
                    disabled: submitting,
                    'aria-label': choice.name,
                    'data-control': `ask:${card.id}:${question.id}:${choice.label}`,
                    onChange(event: Event) {
                      choose(question, choice, (event.currentTarget as HTMLInputElement).checked);
                    },
                  }),
                  h('span', { class: 'caskchoicewords' }, [
                    h('span', { class: 'caskchoicelabel', dangerouslySetInnerHTML: { __html: choice.labelHtml } }),
                    choice.detail
                      ? h('span', { class: 'caskchoicedetail', dangerouslySetInnerHTML: { __html: choice.detailHtml } })
                      : null,
                  ]),
                ],
              ),
            ];
            if (choice.written && typeof written[question.id] === 'string') {
              const rememberCaret = (input: HTMLInputElement | HTMLTextAreaElement) => {
                props.state.carets[question.id] = [input.selectionStart ?? 0, input.selectionEnd ?? 0];
              };
              const typed = written[question.id] ?? '';
              const box = {
                class: 'caskwritten',
                key: `written:${question.id}`,
                value: typed,
                placeholder: question.writtenPlaceholder,
                disabled: submitting,
                'aria-label': question.writtenName,
                'data-control': `askwritten:${card.id}:${question.id}`,
                ref(node: HTMLInputElement | HTMLTextAreaElement | null) {
                  const held = props.state.carets[question.id];
                  if (node && held) {
                    node.setSelectionRange(held[0], held[1]);
                  }
                },
                onInput(event: Event) {
                  const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
                  props.state.written = { ...written, [question.id]: input.value };
                  rememberCaret(input);
                  redraw();
                },
                onKeyDown(event: KeyboardEvent) {
                  if (
                    event.key !== 'Enter' ||
                    event.shiftKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.altKey ||
                    event.isComposing ||
                    event.keyCode === 229
                  ) {
                    return;
                  }
                  event.preventDefault();
                  takePrimaryAction();
                },
                onKeyUp(event: KeyboardEvent) {
                  rememberCaret(event.currentTarget as HTMLInputElement | HTMLTextAreaElement);
                },
                onClick(event: MouseEvent) {
                  rememberCaret(event.currentTarget as HTMLInputElement | HTMLTextAreaElement);
                },
                onSelect(event: Event) {
                  rememberCaret(event.currentTarget as HTMLInputElement | HTMLTextAreaElement);
                },
              };
              row.push(
                question.secret
                  ? textField({
                      ...box,
                      type: 'password',
                      text: typed,
                      cross: props.cross,
                      clearLabel: CARD_ACTIONS.askSecretClear,
                      clearControl: `askwrittenclear:${card.id}:${question.id}`,
                      wrapperClass: 'caskwrittenfield',
                      onClear() {
                        props.state.written = { ...written, [question.id]: '' };
                        props.state.carets[question.id] = [0, 0];
                        redraw();
                      },
                    })
                  : h('textarea', { ...box, rows: 2 }),
              );
            }
            return row;
          }),
        ],
      )
    : null;

  const ready = question ? questionAnswered(question.id, picked, written) : false;
  const actionLabel = hasTabs(card) && !done ? card.nextLabel : card.answerLabel;
  const actionName = !ready ? card.incompleteName : done ? card.answerName : card.nextName;
  const actions = h('div', { class: 'caskactions' }, [
    question
      ? h(
          'button',
          {
            class: 'caskaction caskanswer',
            type: 'button',
            disabled: !ready || submitting,
            'aria-label': actionName,
            'data-control': `ask:${card.id}:answer`,
            onClick: takePrimaryAction,
          },
          actionLabel,
        )
      : null,
    ...card.actions.map((action) =>
      h(
        'button',
        {
          class: `caskaction ${action.label.toLowerCase()}`,
          type: 'button',
          key: action.label,
          disabled: submitting,
          'aria-label': action.name,
          'data-control': `ask:${card.id}:${action.label.toLowerCase()}`,
          onClick() {
            submit(action.answer, `ask:${card.id}:${action.label.toLowerCase()}`);
          },
        },
        action.label,
      ),
    ),
    question
      ? h('span', { class: 'caskwait' }, hasTabs(card) ? (card.steps[at] ?? '') : ready ? '' : card.incompleteName)
      : null,
  ]);

  const detail = card.detail
    ? card.detailFormat === 'code'
      ? h('pre', { class: 'caskdetail caskcode' }, h('code', {}, card.detail))
      : h('div', { class: 'caskdetail' }, card.detail)
    : null;
  return h(
    'section',
    {
      class: `cask ${card.kind}${open ? '' : ' is-shut'}${submitting ? ' is-sending' : ''}`,
      role: 'group',
      'aria-label': card.name,
      'aria-busy': submitting ? 'true' : undefined,
      'data-ask': card.id,
    },
    [
      h(
        'button',
        {
          class: 'caskhead caskfold',
          type: 'button',
          'aria-expanded': String(open),
          'aria-controls': `${base.current}-body`,
          'aria-label': foldName,
          'data-control': `askfold:${card.id}`,
          onClick() {
            props.state.open = !open;
            redraw();
          },
        },
        [
          h('span', { class: 'twist' }, open ? props.twist.open : props.twist.shut),
          h('div', { class: 'casktitle' }, card.title),
          foldCount ? h('span', { class: 'caskcount' }, foldCount) : null,
          h('span', { class: 'caskstate' }, state),
        ],
      ),
      h('div', { class: 'caskbody', id: `${base.current}-body`, hidden: !open }, [detail, tabs, questionNode, actions]),
    ],
  );
}

function RequestList(props: {
  view: ComposerView;
  states: Map<string, RequestState>;
  options: RequestOptions;
  twist: { open: string; shut: string };
  focusAfter(control: string): void;
  announceMove(words: string): void;
  submitted(control: string): void;
}): ComponentChildren {
  const identity = requestIdentity(props.view);
  const root = useRef<HTMLDivElement>(null);
  const prior = useRef(identity);
  useLayoutEffect(() => {
    if (prior.current !== identity && root.current) {
      root.current.scrollTop = 0;
    }
    prior.current = identity;
    props.options.afterDraw();
  });
  return h(
    'div',
    { class: 'casks', 'data-scroll-key': identity, ref: root },
    props.view.asks.map((card) => {
      const key = requestKey(props.view, card);
      let state = props.states.get(key);
      if (!state) {
        state = { picked: {}, written: {}, carets: {}, shown: 0, open: true, submitting: false };
        props.states.set(key, state);
      }
      return h(AskCardView, {
        key,
        view: props.view,
        card,
        state,
        twist: props.twist,
        cross: props.options.cross,
        sendToHost: props.options.sendToHost,
        focusAfter: props.focusAfter,
        announceMove: props.announceMove,
        submitted: props.submitted,
        afterDraw: props.options.afterDraw,
      });
    }),
  );
}

function announcer(document: Document, id: string): HTMLElement {
  const node = document.createElement('div');
  node.id = id;
  node.className = 'sr-only';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  return node;
}

export function createRequestRenderer(options: RequestOptions): RequestRenderer {
  const askAnnouncer = announcer(options.document, 'ask-announcer');
  const sendAnnouncer = announcer(options.document, 'send-announcer');
  const states = new Map<string, RequestState>();
  const announced = new Set<string>();
  const sendOverSaid = new Map<string, string>();
  let current: ComposerView | null = null;
  let submittedControl: string | null = null;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingAnnouncements: string[] = [];
  const heldAnnouncements: string[] = [];
  const pendingMoves: string[] = [];

  const queuedAnnouncement = (words: string) => {
    pendingAnnouncements.push(words);
    if (announceTimer !== null) {
      return;
    }
    askAnnouncer.textContent = '';
    announceTimer = setTimeout(() => {
      heldAnnouncements.push(...pendingAnnouncements.splice(0));
      askAnnouncer.textContent = heldAnnouncements.join(' ');
      announceTimer = null;
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
      }
      holdTimer = setTimeout(() => {
        heldAnnouncements.length = 0;
        holdTimer = null;
      }, ASK_ANNOUNCE_HOLD_MS);
    }, 0);
  };
  const announceMove = (words: string) => {
    pendingMoves.push(words);
    if (moveTimer !== null) {
      return;
    }
    options.moveAnnouncer.textContent = '';
    moveTimer = setTimeout(() => {
      options.moveAnnouncer.textContent = pendingMoves.splice(0).join(' ');
      moveTimer = null;
    }, 0);
  };
  const fitTabs = () => {
    for (const strip of options.mount.querySelectorAll<HTMLElement>('.casktabs')) {
      strip.classList.remove('is-marked');
      const rows = new Set([...strip.querySelectorAll<HTMLElement>('.casktab')].map((tab) => tab.offsetTop));
      if (rows.size > ASK_TAB_ROWS) {
        strip.classList.add('is-marked');
      }
    }
  };
  const focusAfter = (control: string) => {
    const node = [...options.mount.querySelectorAll<HTMLElement>('[data-control]')].find(
      (candidate) => candidate.dataset.control === control,
    );
    if (node && !('disabled' in node && node.disabled)) {
      node.focus();
    }
  };
  const draw = () => {
    const active = options.document.activeElement as HTMLElement | null;
    const held = active && options.mount.contains(active) ? (active.dataset.control ?? null) : null;
    render(
      current?.asks.length
        ? h(RequestList, {
            view: current,
            states,
            options,
            twist: { open: '\u25BE', shut: '\u25B8' },
            focusAfter,
            announceMove,
            submitted(control: string) {
              submittedControl = control;
            },
          })
        : null,
      options.mount,
    );
    if (submittedControl && active && active !== options.document.body && !options.mount.contains(active)) {
      submittedControl = null;
    }
    const wanted = held ?? (!active || active === options.document.body ? submittedControl : null);
    if (!wanted) {
      return;
    }
    const again = [...options.mount.querySelectorAll<HTMLElement>('[data-control]')].find(
      (candidate) => candidate.dataset.control === wanted,
    );
    if (again && !('disabled' in again && again.disabled)) {
      again.focus();
      if (wanted === submittedControl) {
        submittedControl = null;
      }
    } else if (wanted.startsWith('ask:') && !again) {
      const next = [...options.mount.querySelectorAll<HTMLElement>(ASK_CONTINUE)].find(
        (candidate) => !candidate.closest('[hidden]'),
      );
      (next ?? options.prompt).focus();
      if (wanted === submittedControl) {
        submittedControl = null;
      }
    }
  };
  const update = (view: ComposerView | null) => {
    current = view;
    if (view) {
      const prefix = `${view.sessionId}\n`;
      const wanted = new Set(view.asks.map((card) => requestKey(view, card)));
      for (const key of states.keys()) {
        if (key.startsWith(prefix) && !wanted.has(key)) {
          states.delete(key);
        }
      }
      const fresh = view.asks.filter((card) => {
        const key = requestKey(view, card);
        if (announced.has(key)) {
          return false;
        }
        announced.add(key);
        return true;
      });
      if (fresh.length) {
        queuedAnnouncement(fresh.map((card) => card.name).join(' '));
      }
      const now = view.sendOverAsk || '';
      const said = sendOverSaid.get(view.sessionId);
      sendOverSaid.set(view.sessionId, now);
      if (said !== undefined && said !== now && now) {
        sendAnnouncer.textContent = '';
        setTimeout(() => {
          sendAnnouncer.textContent = now;
        }, 0);
      }
    }
    draw();
  };
  options.events.window('resize', fitTabs);
  return {
    askAnnouncer,
    sendAnnouncer,
    update,
    fitTabs,
    announce: queuedAnnouncement,
    reject(session, id) {
      const key = `${session}\n${id}`;
      const state = states.get(key);
      if (state) {
        state.submitting = false;
      }
      draw();
    },
  };
}
