import { Fragment, h, render, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  ARRIVAL_WORD,
  arrivalSpoken,
  arrivalTitle,
  cardPartId,
  CARD_GLYPHS,
  cardPrint,
  commitGroupLabel,
  repositoryWorkFigures,
} from '../view/card-presentation.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import { quotesPromptHeading } from '../view/comments.ts';
import type { ReadStateOwner } from './read-state.ts';
import type { CommentRenderer } from './comments.ts';
import { captureDisclosures, enhanceSummary, restoreDisclosures, type DisclosureSnapshot } from './summary.ts';
import type { StatDetailRenderer } from './stat-detail.ts';
import type { StatDetailList } from './stat-detail.ts';
import type { PanelToHost } from './protocol.ts';
import { inlineText } from './inline-text.ts';
import { StatChip } from './stat-chip.ts';
import type { CardChip as ChipView } from './stat-chip.ts';
import {
  commitGrouping,
  commitHeadingFact,
  commitRowSpoken,
  commitRowTitle,
  DetailRowList,
  detailRowsFor,
  FILES_SECTION_CAP,
  singleCommitGroup,
  writtenCommitRows,
} from './card-rows.ts';
import { cardBodyColumns, type CardBodyPart, type TimelineLayout } from '../view/timeline-layout.ts';
import type { ActivityRow, CardView } from './payload-contracts.ts';

export type { CardChip } from './stat-chip.ts';
export { cardPrint };

export type { CardView } from './payload-contracts.ts';

export interface CardWords {
  activityBreakdown: string;
  activityBreakdownTable: string;
  activityBreakdownRunning: string;
  activityBreakdownDifference: string;
  activityRecorded: string;
  activityRecordedSoFar: string;
  activitySkillsHeading: string;
  activitySkillsOpen: string;
  activitySkillsMissing: string;
  activitySkillsBestEffort: string;
  activitySkillsPopover: string;
  promptLess: string;
  promptMore: string;
  laterAsksShow: string;
  lastActive: string;
  laterAsksHide: string;
  turnDiff: string;
  openCommit: string;
  saidSection: string;
  logRepliesOnly: string;
  logMessagesOnly: string;
  logEverything: string;
  logFilterDetail: string;
  logShowingReplies: string;
  logShowingMessages: string;
  logAllActivity: string;
  logMessagesView: string;
  logRepliesView: string;
  logShowAllActivity: string;
  logShowMessagesOnly: string;
  logNoMessages: string;
  saidReplied: string;
  saidMore: string;
  saidLess: string;
  saidCollapse: string;
  saidExpand: string;
  saidWholeDetail: string;
  saidLessDetail: string;
  saidOpenWholeDetail: string;
  logRunShow: string;
  logRunHide: string;
  logLineShow: string;
  logLineHide: string;
  session: string;
  sessionNothingNew: string;
  expandAllTurns: string;
  collapseAllTurns: string;
  sessionActions: string;
  sessionActionsDetail: string;
  railPinHint: string;
  railPinDetail: string;
  railUnpinHint: string;
  railUnpinDetail: string;
  labelOpen: string;
  railFilterTake: string;
  sessionLabelFilterDetail: string;
  sessionLabelsAdd: string;
  sessionParentWord: string;
  sessionParentHint: { readonly dispatched: string; readonly subagent: string; readonly reader: string };
  sessionParentDetail: string;
  sessionParentAction: string;
  codeCopy: string;
  codeCopied: string;
}

export function cardWords(): CardWords {
  return CARD_ACTIONS;
}

export type CardHost = HTMLElement;

export interface CardRendererOptions {
  post(message: PanelToHost): void;
  read: ReadStateOwner;
  comments: CommentRenderer;
  statDetails: StatDetailRenderer;
  // The second popover instance, which a subagent row's figure opens over the first one. Absent
  // where no caller draws subagent rows, and a figure then stays a run of text.
  figureDetails?: StatDetailRenderer;
  // The reader's Timeline layout, as the last render carried it.
  layout(): TimelineLayout;
}

function stop(event: Event): void {
  event.stopPropagation();
}

function Summary({ html, card, options }: { html: string; card: CardView; options: CardRendererOptions }) {
  const root = useRef<HTMLDivElement>(null);
  const retained = useRef<DisclosureSnapshot>({ open: new Map(), focus: null });
  if (root.current) retained.current = captureDisclosures(root.current);
  useLayoutEffect(() => {
    if (root.current) {
      const cleanup = enhanceSummary(root.current, {
        post: options.post,
        words: cardWords(),
        ...(card.kind === 'compaction' ? {} : { sessionId: card.sessionId, turnKey: card.key }),
      });
      restoreDisclosures(root.current, retained.current);
      return cleanup;
    }
    return undefined;
  }, [html, card.kind, card.sessionId, card.key]);
  return h('div', { class: 'summary', ref: root, dangerouslySetInnerHTML: { __html: html } });
}

function disclosureId(card: CardView, part: string): string {
  return cardPartId(card.key, part);
}

export function cardHeadingId(key: string): string {
  return `card-${encodeURIComponent(key)}-heading`;
}

function Section({
  title,
  children,
  className = '',
  hiddenTitle = false,
}: {
  title: string;
  children?: ComponentChildren;
  className?: string;
  hiddenTitle?: boolean;
}) {
  return h('div', { class: `sec${className ? ` ${className}` : ''}` }, [
    h(
      'h4',
      { class: hiddenTitle ? 'sectionheading saidonly' : 'sectionheading' },
      h('span', { class: 'sec-title' }, h('span', { class: 'sec-word' }, title)),
    ),
    children,
  ]);
}

// The branch fact and the merged word beside a one-branch Commits heading, such as
// `main · merged`, muted after the figure and drawn as a sibling of the collapse button.
function factSpan(fact: { text: string; arrival?: { key: string; title: string; spoken: string } }): ComponentChildren {
  return h('span', { class: 'commitheadfact' }, [
    fact.text,
    fact.arrival
      ? h(Fragment, {}, [
          ' ',
          h('span', { class: 'commitheadarrival', title: fact.arrival.title, 'data-arrival': fact.arrival.key }, [
            ARRIVAL_WORD,
            h('span', { class: 'sr-only' }, fact.arrival.spoken),
          ]),
        ])
      : null,
  ]);
}

// `count` is a plain number for Subagents, Dispatched and Files, and the Commits heading's own
// figure otherwise, such as `12` alone or `12 · 3 merged`. A bare number, whether it arrives as
// a number or as a digit-only string, still gets the title's own pluralized word appended, the
// way Files says "12 files" rather than a naked "12". A figure that already carries its own
// words, such as the merged count, rides into the spoken name as it stands.
export function recordSectionLabel(title: string, count: number | string, shown: boolean): string {
  const action = shown ? `Collapse ${title}` : `Expand ${title}`;
  const bare = typeof count === 'number' ? count : /^\d+$/.test(count) ? Number(count) : null;
  if (bare === null) {
    return `${title}, ${count}, ${action}`;
  }
  // Dispatched is a participle rather than a plural, so it reads the same for one session and
  // for several. Every other title drops its plural `s` for one.
  const countLabel = title === 'Dispatched' || bare !== 1 ? title.toLowerCase() : title.slice(0, -1).toLowerCase();
  return `${title}, ${bare} ${countLabel}, ${action}`;
}

function RecordSection({
  card,
  title,
  count,
  fact,
  children,
  className = '',
  section,
}: {
  card: CardView;
  title: string;
  count: number | string;
  // What a one-group Commits record says about its branch, muted after the figure, and the
  // merged word with its hover and its hidden words when the branch was merged.
  fact?: { text: string; arrival?: { key: string; title: string; spoken: string } };
  children?: ComponentChildren;
  className?: string;
  section: string;
}) {
  const [shownChoice, setShownChoice] = useState<boolean | null>(null);
  const shown = shownChoice ?? true;
  const listId = disclosureId(card, section);
  return h('div', { class: `sec${className ? ` ${className}` : ''}` }, [
    h(
      'h4',
      { class: 'sectionheading' },
      h('div', { class: 'acthead' }, [
        h(
          'button',
          {
            class: 'actword',
            'aria-label': recordSectionLabel(title, count, shown),
            'aria-controls': listId,
            'aria-expanded': String(shown),
            'data-control': `record:${section}:${card.key}`,
            onClick(event: MouseEvent) {
              stop(event);
              setShownChoice(!shown);
            },
          },
          h('span', { class: 'sec-title' }, [
            h('span', { class: 'sec-word' }, title),
            ' ',
            h('span', { class: 'count' }, String(count)),
          ]),
        ),
        // The branch fact and the merged word sit beside the button rather than inside it, so
        // the heading can wrap a long branch name, the branch name and the merged word's hover
        // and hidden words stay reachable outside a control CLAUDE.md bars from carrying a
        // native title, and a click on the fact presses nothing, since the button no longer
        // wraps it.
        fact ? factSpan(fact) : null,
      ]),
    ),
    h('div', { id: listId, hidden: !shown }, children),
  ]);
}

function PromptBlock({
  text,
  control,
  expanded,
  full,
  setFull,
  onOverflowChange,
}: {
  text: string;
  control: string;
  expanded: boolean;
  full: boolean;
  setFull(value: boolean): void;
  onOverflowChange(control: string, overflow: boolean): void;
}) {
  const prompt = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = prompt.current;
    if (!node || !expanded || full) {
      return;
    }
    const next = node.scrollHeight > node.clientHeight + 2;
    if (next !== overflow) {
      setOverflow(next);
      onOverflowChange(control, next);
    }
  }, [control, expanded, full, onOverflowChange, text, overflow]);
  useLayoutEffect(() => () => onOverflowChange(control, false), [control, onOverflowChange]);
  return h(Fragment, {}, [
    h('div', { class: `prompt${full ? ' is-full' : ''}`, ref: prompt }, text),
    h(
      'button',
      {
        class: 'more',
        hidden: !overflow,
        'aria-expanded': String(full),
        'data-control': control,
        onClick(event: MouseEvent) {
          stop(event);
          setFull(!full);
        },
      },
      full ? cardWords().promptLess : cardWords().promptMore,
    ),
  ]);
}

function PromptSection({ card, expanded }: { card: CardView; expanded: boolean }) {
  const [full, setFull] = useState(false);
  const overflowing = useRef(new Set<string>());
  const [overflowCount, setOverflowCount] = useState(0);
  const contentId = disclosureId(card, 'prompts');
  const onOverflowChange = useCallback((control: string, overflow: boolean) => {
    const held = overflowing.current;
    if (held.has(control) === overflow) {
      return;
    }
    if (overflow) {
      held.add(control);
    } else {
      held.delete(control);
    }
    setOverflowCount(held.size);
  }, []);
  const rows: ComponentChildren[] = [];
  const opening = card.prompt || card.delegation;
  if (opening) {
    const control = `more:${card.key}`;
    rows.push(
      h(PromptBlock, {
        text: opening,
        control,
        expanded,
        full,
        setFull,
        onOverflowChange,
        key: 'prompt',
      }),
    );
    if (card.promptNotice) {
      rows.push(h('div', { class: 'dim promptnotice', key: 'prompt-notice' }, card.promptNotice));
    }
  }
  if (card.laterPrompts?.length) {
    rows.push(h(AskRows, { card, expanded, full, setFull, onOverflowChange, key: 'asks' }));
  }
  const expandable = overflowCount > 0 || full;
  return h('div', { class: 'sec promptsec' }, [
    h(
      'h4',
      { class: 'sectionheading' },
      expandable
        ? h(
            'button',
            {
              class: 'acthead',
              'aria-label': full ? cardWords().promptLess : cardWords().promptMore,
              'aria-controls': contentId,
              'aria-expanded': String(full),
              'data-control': `prompts:${card.key}`,
              onClick(event: MouseEvent) {
                stop(event);
                setFull(!full);
              },
            },
            h('span', { class: 'sec-title actword' }, h('span', { class: 'sec-word' }, card.promptHeading)),
          )
        : h('span', { class: 'sec-title' }, h('span', { class: 'sec-word' }, card.promptHeading)),
    ),
    h('div', { id: contentId }, rows),
  ]);
}

function AskRows({
  card,
  expanded,
  full,
  setFull,
  onOverflowChange,
}: {
  card: CardView;
  expanded: boolean;
  full: boolean;
  setFull(value: boolean): void;
  onOverflowChange(control: string, overflow: boolean): void;
}) {
  return h(
    Fragment,
    {},
    (card.laterPrompts ?? []).flatMap((ask, index) => [
      h('div', { class: 'asklabel', key: `label:${index}` }, [
        h('span', { class: 'asklabelword' }, ask.label),
        ' ',
        h('span', { class: 'dim askwhen', title: ask.absolute }, ask.when),
      ]),
      h(PromptBlock, {
        text: ask.text,
        control: `more:${card.key}:ask${index}`,
        expanded,
        full,
        setFull,
        onOverflowChange,
        key: `ask:${index}`,
      }),
    ]),
  );
}

// The prompt drawn above the response, when the Prompt position setting asks for it. The question is
// read before the answer, so it is clamped short, and what the reader typed while the turn ran
// folds behind one press. A saved comment on one of those asks shows them until the reader
// presses, so the comment is drawn on its line rather than on a block nobody can see. A card
// with no first prompt draws its first ask as its first prompt block, so a comment on that ask
// is stored under `prompt`, and a comment on the You asked heading draws on that ask.
function PromptLead({ card, expanded, options }: { card: CardView; expanded: boolean; options: CardRendererOptions }) {
  const [full, setFull] = useState(false);
  const [asksChoice, setAsksChoice] = useState<boolean | null>(null);
  const onOverflowChange = useCallback(() => {}, []);
  const asks = card.laterPrompts ?? [];
  const opening = card.prompt || card.delegation;
  // With no first prompt, the first ask is the prompt block that a comment on the prompt or on
  // the drawn You asked heading lands on.
  const onAsk = ({ part, quote }: { part: string; quote?: string }) =>
    part.startsWith('prompt:') ||
    (!opening && (part === 'prompt' || (part === 'summary' && quotesPromptHeading(quote || ''))));
  const asksShown =
    asksChoice ?? options.comments.snapshot().some((comment) => comment.turnKey === card.key && onAsk(comment));
  const asksId = disclosureId(card, 'asks');
  return h('div', { class: 'promptlead' }, [
    h('h4', { class: 'sectionheading saidonly' }, card.promptHeading),
    opening
      ? h(PromptBlock, {
          text: opening,
          control: `more:${card.key}`,
          expanded,
          full,
          setFull,
          onOverflowChange,
          key: 'prompt',
        })
      : null,
    card.promptNotice ? h('div', { class: 'dim promptnotice' }, card.promptNotice) : null,
    asks.length
      ? h(
          'button',
          {
            class: 'more promptasks',
            'aria-expanded': String(asksShown),
            'aria-controls': asksId,
            'data-control': `asks:${card.key}`,
            onClick(event: MouseEvent) {
              stop(event);
              setAsksChoice(!asksShown);
            },
          },
          asksShown ? cardWords().laterAsksHide : `${asks.length} ${cardWords().laterAsksShow}`,
        )
      : null,
    asks.length
      ? h(
          'div',
          { id: asksId, hidden: !asksShown },
          asksShown ? h(AskRows, { card, expanded, full, setFull, onOverflowChange }) : null,
        )
      : null,
  ]);
}

// The record sections the Card layout setting draws in the body: the same rows the chip popovers
// draw, under a heading with the count.
export function recordSections(card: CardView, options: CardRendererOptions): ComponentChildren[] {
  const sections: ComponentChildren[] = [];
  if (card.agents?.length) {
    sections.push(
      h(
        RecordSection,
        {
          card,
          title: 'Subagents',
          count: card.agents.length,
          className: 'recordsec recordagents',
          section: 'agents',
          key: 'agents',
        },
        h(DetailRowList, {
          rows: {
            kind: 'agents',
            key: card.key,
            agents: card.agents,
            files: card.files ?? [],
            commits: writtenCommitRows(card),
          },
          post: options.post,
          figureDetails: options.figureDetails,
        }),
      ),
    );
  }
  if (card.dispatched?.length) {
    sections.push(
      h(
        RecordSection,
        {
          card,
          title: 'Dispatched',
          count: card.dispatched.length,
          className: 'recordsec recorddispatched',
          section: 'dispatched',
          key: 'dispatched',
        },
        h(DetailRowList, {
          rows: { kind: 'dispatched', key: card.key, agents: card.dispatched, files: [], commits: [] },
          post: options.post,
          figureDetails: options.figureDetails,
        }),
      ),
    );
  }
  // One section for the repository work, commits and landings together, in the order they
  // happened. The heading keeps the shape its two peers keep, the section's word and a figure
  // beside it, and counts the landings apart from the commits the way the commits chip above
  // the card does, so a landing among the rows is never counted as a commit here and left out
  // of the figure there. A record of one branch draws no group heading, so the heading names
  // the branch beside the figure.
  const commits = card.commits ?? [];
  if (commits.length) {
    const landings = commits.filter((commit) => commit.kind === 'landing').length;
    const figures = repositoryWorkFigures(commits.length - landings, landings);
    const single = singleCommitGroup(commitGrouping(commits));
    const heading = single ? commitHeadingFact(single) : null;
    const fact =
      single && heading
        ? {
            text: heading.fact,
            ...(heading.factArrival ? { arrival: { key: single.key, ...heading.factArrival } } : {}),
          }
        : undefined;
    sections.push(
      h(
        RecordSection,
        {
          card,
          title: 'Commits',
          count: figures,
          fact,
          className: 'recordsec recordcommits',
          section: 'commits',
          key: 'commits',
        },
        h(DetailRowList, { rows: { kind: 'commits', key: card.key, commits }, post: options.post }),
      ),
    );
  }
  if (card.files?.length) {
    sections.push(
      h(
        RecordSection,
        {
          card,
          title: 'Files',
          count: card.files.length,
          className: 'recordsec recordfiles',
          section: 'files',
          key: 'files',
        },
        h(DetailRowList, {
          rows: { kind: 'files', key: card.key, files: card.files },
          post: options.post,
          cap: FILES_SECTION_CAP,
        }),
      ),
    );
  }
  return sections;
}

// The controls a rendered message can hold: the links in it, the copy button on each code
// block, and the button a picture or a visualization is drawn as.
const MESSAGE_CONTROLS = 'a[href], a[data-link], button, input, select, textarea, summary, [tabindex]';

// Take everything under a bounded block's cut out of the tab order, and give it back when the
// bound lifts.
//
// `overflow: hidden` clips the drawing and leaves what it clipped focusable. A reader walking
// a long message with the keyboard would otherwise land on a link, a copy button and a picture
// they cannot see, one after another, before ever reaching the control that would show them.
//
// Geometry rather than a count, for the reason the bound itself is measured. A control the cut
// runs through keeps its place: half of it is on screen and pressable, which is the rest of
// the block's own rule.
//
// The value each control had is kept beside it, so giving it back restores what was there
// rather than what a control of that kind usually has.
function clipFocus(node: HTMLElement, bounded: boolean): void {
  const edge = bounded ? node.getBoundingClientRect().bottom : 0;
  for (const control of Array.from(node.querySelectorAll<HTMLElement>(MESSAGE_CONTROLS))) {
    const under = bounded && control.getBoundingClientRect().top >= edge;
    const held = control.dataset.clipped;
    if (under && held === undefined) {
      control.dataset.clipped = control.getAttribute('tabindex') ?? '';
      control.tabIndex = -1;
    } else if (!under && held !== undefined) {
      if (held) {
        control.setAttribute('tabindex', held);
      } else {
        control.removeAttribute('tabindex');
      }
      delete control.dataset.clipped;
    }
  }
}

// Every bounded message in a card body, clipped again.
//
// Run after the comment marks are written. Writing them removes and remakes the marks inside
// the blocks they sit on, so a mark under a cut comes back as a fresh element carrying neither
// the tab stop taken off its predecessor nor the note of what it had. Nothing else would put
// it back: a mark is drawn over the text rather than in it, so remaking one resizes neither
// the block nor its content and the block never measures again.
function reclipMessages(body: HTMLElement): void {
  for (const text of Array.from(body.querySelectorAll<HTMLElement>('.saidtext'))) {
    clipFocus(text, text.scrollHeight > text.clientHeight + 2);
  }
}

// The bound each kind of message opens at, as a multiple of the block's own font size. Six
// lines of the summary's 1.5 line height for a narration, and the 36em a reply has had since
// the section shipped. The same two figures are the fallbacks in `.saidtext`'s `max-height`.
// That draws the bound for the one frame before the block has measured itself.
const SAID_BOUND = { narration: 9, reply: 36 };

// Where a bounded block cuts, moved up to the bottom of the last whole unit above the bound.
// A unit is a line box of text, a whole table row, or a picture.
//
// Measured rather than counted, for the reason the bound itself is measured. Markdown has no
// line grid. A paragraph's margin, a code block's padding and a table's borders all move the
// line boxes off any multiple of the line height. So a bound rounded to whole lines would
// still cut through one. A clamp cannot do it either, because `-webkit-line-clamp` clips
// nothing at all in a block holding a `pre`.
//
// Text inside a button is skipped. A code block's Copy control is drawn over the text and its
// box ends where no line does. A picture is never skipped, although the renderer wraps every
// one of them in a button so the reader can open it. There the button is the picture.
//
// Returns 0 when no whole unit fits above the bound, and the bare bound then stands.
function snapCut(node: HTMLElement, bound: number): number {
  const top = node.getBoundingClientRect().top;
  // Half a pixel of room. A rect bottom and the bound are both fractional. A unit ending
  // exactly on the bound is otherwise refused by the last fraction of either.
  const limit = top + bound + 0.5;
  // Started at the block's own top, which is where a cut of nothing falls. These are viewport
  // coordinates, and a block scrolled above the top of the window has a negative one. Started
  // at zero, every unit in such a block loses to the window's own edge and the walk answers
  // with the distance to it.
  let best = top;
  const consider = (bottom: number) => {
    if (bottom <= limit && bottom > best) {
      best = bottom;
    }
  };
  let row: Element | null = null;
  // A table row is one unit, taken once. Its cells wrap to different depths, so the row ends
  // where its tallest cell ends. A cut above that reads as a broken table. Both branches below
  // hand a row here, and whichever meets it first takes it.
  const considerRow = (cell: Element) => {
    if (cell === row) {
      return;
    }
    row = cell;
    consider(cell.getBoundingClientRect().bottom);
  };
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let at = walk.nextNode(); at; at = walk.nextNode()) {
    if (at.nodeType === Node.ELEMENT_NODE) {
      // A picture is one unit however tall it is, and it holds no text to take a range over.
      // In a table row it is part of the row, and the row is the unit. Its own bottom sits
      // above the row's, so taking it would cut through the cells beside it.
      const element = at as HTMLElement;
      if (element.tagName !== 'IMG') {
        continue;
      }
      const holding = element.closest('tr');
      if (holding) {
        considerRow(holding);
      } else {
        consider(element.getBoundingClientRect().bottom);
      }
      continue;
    }
    const parent = at.parentElement;
    if (!at.nodeValue || !at.nodeValue.trim() || !parent || parent.closest('button')) {
      continue;
    }
    const cell = parent.closest('tr');
    if (cell) {
      considerRow(cell);
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(at);
    for (const rect of Array.from(range.getClientRects())) {
      consider(rect.bottom);
    }
  }
  return best > top ? best - top : 0;
}

// One mid-turn message, bounded so a long one does not push the rest of the card off screen.
//
// The bound is measured rather than counted: a message is markdown, so the same text is one
// height rendered and another as characters. It is worked out from the block's own font size
// and never read back off the box, so the observer's own write cannot loop: a write that
// changes the box fires the observer, the measure produces the same value, and nothing is
// written.
//
// Measured whenever the block changes size, and not only when the card draws it again. A
// message settles at a new height with nothing rendering: the reader narrows the panel or
// drags the rail wider, and a picture in a message takes its own size once it has loaded.
// Measured on render alone, a message that fitted when it was drawn is clipped with no control
// under it, and the reader cannot reach the rest of it at all.
//
// The text inside is watched as well as the block. A bounded block stops growing at its own
// edge, so content settling taller than the bound moves nothing an observer on the block would
// see.
//
// Measured only while both disclosures are open. A hidden block is drawn at no height at all,
// which reads as a block that fits, and the control would then be missing from every message
// on a card the reader opens later.
//
// Whether the block overflowed goes up to the section as well as staying here. The head's
// Shift press has to know whether anything is cut before the reader presses it, and only the
// block can measure that.
function SaidBlock({
  card,
  entry,
  expanded,
  shown,
  full,
  onCut,
  onFull,
  options,
}: {
  card: CardView;
  entry: NonNullable<CardView['saidMessages']>[number];
  expanded: boolean;
  shown: boolean;
  full: boolean;
  onCut(id: string, clipped: boolean): void;
  onFull(id: string, value: boolean): void;
  options: CardRendererOptions;
}) {
  const block = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const shrank = useRef(false);
  const [overflow, setOverflow] = useState(false);
  const answer = entry.kind === 'answer';
  // The message id joins its parts with colons. An element id is read back through a CSS
  // selector, where a colon opens a pseudo-class. The `data-control` attribute keeps the raw
  // id, because nothing ever puts that in a selector.
  const blockId = `${disclosureId(card, 'said')}-${entry.id.replace(/[^\w-]/g, '-')}`;
  useLayoutEffect(() => {
    const node = block.current;
    if (!node || !expanded || !shown) {
      return undefined;
    }
    const measure = () => {
      const size = parseFloat(getComputedStyle(node).fontSize);
      const bound = size * (answer ? SAID_BOUND.reply : SAID_BOUND.narration);
      // Whether the message is longer than its bound is a fact about the message. Whether it
      // is cut is that fact and the reader's own press together. The control under it reads
      // the first. A message that fits draws no control, however the record was written. A
      // bulk press opens every message, and one that fits must not then offer Show less.
      // Pressing that control would hide it under the reader's own focus.
      const over = node.scrollHeight > bound + 2;
      const clipped = !full && over;
      if (clipped) {
        const cut = snapCut(node, bound);
        const next = cut ? `${cut}px` : '';
        if (node.style.getPropertyValue('--saidcut') !== next) {
          node.style.setProperty('--saidcut', next);
        }
      } else {
        node.style.removeProperty('--saidcut');
      }
      setOverflow((was) => (was === over ? was : over));
      onCut(entry.id, clipped);
      clipFocus(node, clipped);
    };
    measure();
    node.addEventListener('toggle', measure, true);
    if (typeof ResizeObserver !== 'function') {
      return () => node.removeEventListener('toggle', measure, true);
    }
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    const body = node.firstElementChild;
    if (body) {
      watch.observe(body);
    }
    return () => {
      watch.disconnect();
      node.removeEventListener('toggle', measure, true);
    };
  }, [expanded, shown, full, entry.summaryHtml, entry.id, answer, onCut]);
  // A press that shuts a long message takes every line under the button away at once. The
  // reader is left looking at the middle of the message above it. Focus stays on the button.
  useLayoutEffect(() => {
    if (!shrank.current) {
      return;
    }
    shrank.current = false;
    if (more.current) {
      more.current.scrollIntoView({ block: 'nearest' });
    }
  }, [full]);
  return h(
    'div',
    {
      // `data-answer` is the index the card's own `earlierAnswers` carries, newest first, which
      // is what a comment left on one anchors by. The class and the attribute together are what
      // the panel reads to name that part, so every note written before this section existed
      // still resolves to the answer it was left on.
      class: `actrow message commentary done said${answer ? ' answer' : ''}`,
      'data-message': entry.id,
      'data-answer': answer ? String(entry.answerIndex ?? 0) : undefined,
    },
    [
      // The time sits on the bubble and not on the row. A title on the row is inherited by
      // everything inside it, so the same timestamp answered a hover over any word of the
      // message and over every link in it, and a link's own address never showed. The
      // screen reader keeps the time from the line below, which the bubble does not carry.
      h('span', {
        class: 'actglyph',
        'aria-hidden': 'true',
        title: answer
          ? [cardWords().saidReplied, entry.absolute].filter(Boolean).join(' ')
          : entry.absolute || undefined,
      }),
      h('div', { class: 'acttext' }, [
        h(
          'span',
          { class: 'saidonly' },
          [answer ? cardWords().saidReplied : '', entry.absolute].filter(Boolean).join(', '),
        ),
        h(
          'div',
          { class: `saidtext${full ? ' is-full' : ''}`, id: blockId, ref: block },
          h(Summary, { html: entry.summaryHtml ?? '', card, options }),
        ),
        h(
          'button',
          {
            class: 'more',
            ref: more,
            hidden: !overflow,
            'aria-expanded': String(full),
            'aria-controls': blockId,
            'data-control': `saidmore:${card.key}:${entry.id}`,
            onClick(event: MouseEvent) {
              stop(event);
              if (full) {
                shrank.current = true;
              }
              onFull(entry.id, !full);
            },
          },
          full ? cardWords().saidLess : cardWords().saidMore,
        ),
      ]),
    ],
  );
}

// A cut call opens its exact text without putting a control on a line that already fits.
function ActivityStep({
  row,
  id,
  card,
  open,
  onOpen,
  onRowsChange,
}: {
  row: ActivityRow;
  id: string;
  card: CardView;
  open: boolean;
  onOpen(id: string, open: boolean): void;
  onRowsChange(): void;
}) {
  const node = useRef<HTMLElement>(null);
  const expandable = row.kind === 'step' || row.kind === 'reasoning';
  const preview = row.kind === 'reasoning' ? row.line : row.code;
  const [cut, setCut] = useState(expandable && !!row.title && row.title !== preview);
  const detailId = `${disclosureId(card, 'line')}-${id.replace(/[^\w-]/g, '-')}`;
  useLayoutEffect(() => {
    const element = node.current;
    if (!element || !expandable || !row.title) {
      return undefined;
    }
    const measure = () => {
      if (!element.isConnected || element.closest('[hidden]')) {
        return;
      }
      const text = element.querySelector(row.kind === 'reasoning' ? '.actverb' : '.actcode');
      setCut(row.title !== preview || (!!text && text.scrollWidth > text.clientWidth + 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [preview, row.title, row.kind, cut, expandable]);
  useLayoutEffect(onRowsChange, [cut, open, onRowsChange]);
  return h(Fragment, {}, [
    h(
      cut ? 'button' : 'div',
      {
        ref: node,
        class: `actrow ${row.status} ${row.kind}${cut ? ' hasmore' : ''}`,
        title: !cut && row.kind === 'reasoning' ? row.title || undefined : undefined,
        tabIndex: cut ? -1 : undefined,
        'data-logrow': cut ? id : undefined,
        'data-control': cut ? `activity-line:${card.key}:${id}` : undefined,
        'aria-label': cut ? row.name || row.title : undefined,
        'aria-expanded': cut ? String(open) : undefined,
        'aria-controls': cut ? detailId : undefined,
        'data-hint': cut ? (open ? cardWords().logLineHide : cardWords().logLineShow) : undefined,
        'data-hint-detail': cut ? row.hintDetail : undefined,
        onClick: cut
          ? (event: MouseEvent) => {
              stop(event);
              onOpen(id, !open);
            }
          : undefined,
        onKeyDown(event: KeyboardEvent) {
          if (event.key !== 'Escape' || !open) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onOpen(id, false);
        },
      },
      [
        h(
          'span',
          { class: 'actglyph', 'aria-hidden': 'true' },
          row.kind === 'ask' || row.kind === 'commentary'
            ? ''
            : row.kind === 'reasoning'
              ? '\u2026'
              : CARD_GLYPHS[
                  row.status === 'done'
                    ? 'done'
                    : row.status === 'failed'
                      ? 'failed'
                      : row.status === 'interrupted'
                        ? 'interrupted'
                        : 'running'
                ],
        ),
        h('span', { class: 'actverb' }, row.line),
        row.code ? h(Fragment, {}, [' ', h('code', { class: 'actcode' }, row.code)]) : null,
        row.figure
          ? h(Fragment, {}, [' ', h('span', { class: 'actfig' }, row.figure)])
          : row.since !== null
            ? h(Fragment, {}, [
                ' ',
                h('span', { class: 'actfig', 'data-since': String(row.since), 'aria-hidden': 'true' }),
              ])
            : null,
      ],
    ),
    cut ? h('div', { class: 'actfull', id: detailId, hidden: !open }, row.title) : null,
  ]);
}

function ActivityToolCount({
  card,
  category,
  detail,
  options,
}: {
  card: CardView;
  category: NonNullable<CardView['activityToolCategories']>[number];
  detail: StatDetailList;
  options: CardRendererOptions;
}) {
  const node = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => (node.current ? options.statDetails.mount(node.current, true) : undefined), []);
  useLayoutEffect(() => {
    if (node.current) {
      options.statDetails.update(node.current, null, detail);
    }
  }, [detail]);
  const visible = `${category.count} ${category.label}`;
  return h(
    'button',
    {
      ref: node,
      class: 'actcount acttool',
      'aria-label': `${visible}, ${cardWords().activityBreakdown}`,
      'data-control': `activity-tool:${card.key}:${category.key}`,
    },
    visible,
  );
}

// How many skills the turn loaded, and the way into the list of them.
//
// The same control as a tool-category count, on the same shared popover. What it opens is a
// dialog rather than a tooltip, because each skill the record named a file for reads its own
// name as the press that opens it. The renderer owns that difference, so this component
// declares the list and nothing else.
function ActivitySkillCount({
  card,
  detail,
  options,
}: {
  card: CardView;
  detail: StatDetailList;
  options: CardRendererOptions;
}) {
  const node = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => (node.current ? options.statDetails.mount(node.current, true) : undefined), []);
  useLayoutEffect(() => {
    if (node.current) {
      options.statDetails.update(node.current, null, detail);
    }
  }, [detail]);
  const visible = card.activitySkillLabel ?? '';
  return h(
    'button',
    {
      ref: node,
      class: 'actcount actskills',
      'aria-label': `${visible}, ${cardWords().activitySkillsPopover}`,
      'data-control': `activity-skills:${card.key}`,
    },
    visible,
  );
}

function ActivitySection({
  card,
  expanded,
  options,
}: {
  card: CardView;
  expanded: boolean;
  options: CardRendererOptions;
}) {
  const [shownChoice, setShownChoice] = useState<boolean | null>(null);
  const [full, setFull] = useState<Record<string, boolean>>({});
  const [cut, setCut] = useState<Record<string, boolean>>({});
  const [runChoice, setRunChoice] = useState<Record<string, boolean>>({});
  const [lineOpen, setLineOpen] = useState<Record<string, boolean>>({});
  const [held, setHeld] = useState<Record<string, boolean>>({});
  type ActivityFilter = 'everything' | 'messages' | 'replies';
  const defaultFilter: ActivityFilter = card.status === 'done' ? 'messages' : 'everything';
  const [automaticFilter, setAutomaticFilter] = useState<ActivityFilter>(defaultFilter);
  const [filterChoice, setFilterChoice] = useState<ActivityFilter | null>(null);
  const previousStatus = useRef(card.status);
  const pendingDoneFilter = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLButtonElement>(null);
  const roving = useRef('');
  const previousRows = useRef<string[]>([]);
  const parentRow = useRef('');
  const focusedRow = useRef<HTMLButtonElement | null>(null);
  const onLineOpen = useCallback((id: string, open: boolean) => {
    setLineOpen((choices) => ({ ...choices, [id]: open }));
  }, []);
  // Set while a Shift press arrives from the keyboard. A browser that fires a synthetic click
  // for a key whose default was prevented would otherwise run the bulk press twice.
  const keyed = useRef(false);
  const listId = disclosureId(card, 'activity');
  const shown = shownChoice ?? true;
  const filter = filterChoice ?? automaticFilter;
  const rows = (card.activity ?? []).filter(
    (row) =>
      filter === 'everything' ||
      (filter === 'replies' ? row.kind === 'message' && row.messageKind === 'answer' : row.kind === 'message'),
  );
  const messages = rows
    .filter((row) => row.kind === 'message')
    .map((row) => ({
      id: row.id!,
      kind: row.messageKind!,
      at: row.at!,
      text: row.text!,
      when: row.when!,
      absolute: row.absolute!,
      summaryHtml: row.summaryHtml,
      answerIndex: row.answerIndex,
    }));
  const allMessages = (card.activity ?? []).filter((row) => row.kind === 'message');
  useLayoutEffect(() => {
    const becameDone = previousStatus.current !== 'done' && card.status === 'done';
    previousStatus.current = card.status;
    if (filterChoice !== null) {
      return;
    }
    if (card.status !== 'done') {
      pendingDoneFilter.current = false;
      setAutomaticFilter('everything');
      return;
    }
    if (!becameDone) {
      return;
    }
    const focused = document.activeElement;
    if (focused && list.current?.contains(focused) && !focused.closest('.actrow.message')) {
      pendingDoneFilter.current = true;
      return;
    }
    setAutomaticFilter('messages');
  }, [card.status, filterChoice]);
  const chooseFilter = (choice: ActivityFilter) => {
    pendingDoneFilter.current = false;
    setShownChoice(true);
    setFilterChoice(choice);
  };
  const toolDetail = (category: NonNullable<CardView['activityToolCategories']>[number]): StatDetailList => {
    const tally = (card.toolTally ?? []).filter((item) => item.category === category.key);
    const rawTotal = tally.reduce((sum, item) => sum + item.count, 0);
    return {
      layout: 'tool-breakdown',
      heading: {
        label: card.status === 'running' ? cardWords().activityBreakdownRunning : cardWords().activityBreakdownTable,
      },
      entries: tally.map((item) => ({ label: item.name, value: String(item.count) })),
      footer: [
        `${rawTotal} ${card.status === 'running' ? cardWords().activityRecordedSoFar : cardWords().activityRecorded}. ${cardWords().activityBreakdownDifference}`,
      ],
    };
  };
  const skills = card.activitySkills ?? [];
  const bestEffort = (skill: NonNullable<CardView['activitySkills']>[number]) => skill.evidence === 'best-effort';
  const skillDetail = (): StatDetailList => ({
    layout: 'skills',
    actions: true,
    heading: { label: cardWords().activitySkillsHeading },
    entries: skills.map((skill) => {
      const label = skill.count > 1 ? `${skill.name} ×${skill.count}` : skill.name;
      return {
        label,
        lines: [
          // A skill description arrives already cut to one line, so the title carries the
          // whole sentence the row cannot show.
          ...(skill.description
            ? [
                {
                  text: skill.description,
                  title: skill.fullDescription ?? skill.description,
                  kind: 'description' as const,
                },
              ]
            : []),
          // Where the file went, or the sentence saying that it has gone. A row that simply
          // dropped its path would read as a skill the record never named a file for.
          skill.shownPath
            ? {
                text: skill.shownPath,
                kind: 'path' as const,
                action: skill.path
                  ? {
                      name: `${label}, ${skill.shownPath}`,
                      hint: cardWords().activitySkillsOpen,
                      run(event: MouseEvent) {
                        options.post({
                          type: 'openSkill',
                          key: card.key,
                          path: skill.path!,
                          beside: event.ctrlKey || event.metaKey,
                        });
                      },
                    }
                  : undefined,
              }
            : { text: cardWords().activitySkillsMissing, kind: 'muted' as const },
        ],
      };
    }),
    // Said once for the whole list, and only where a Codex skill sits in it, rather than
    // naming what the evidence does not prove on every row that carries it.
    footer: skills.some(bestEffort) ? [cardWords().activitySkillsBestEffort] : undefined,
  });
  const rowButtons = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button[data-logrow]') ?? []).filter(
      (button) => !button.closest('[hidden]'),
    );
  const refreshRows = useCallback(() => {
    const buttons = rowButtons();
    if (!buttons.length) {
      return;
    }
    let chosen = buttons.find((button) => button.dataset.logrow === roving.current);
    if (!chosen) {
      chosen = buttons.find((button) => button.dataset.logrow === parentRow.current);
    }
    if (!chosen) {
      const index = Math.max(0, previousRows.current.indexOf(roving.current));
      chosen = buttons[Math.min(index, buttons.length - 1)];
    }
    roving.current = chosen.dataset.logrow!;
    for (const button of buttons) {
      button.tabIndex = button === chosen ? 0 : -1;
    }
    previousRows.current = buttons.map((button) => button.dataset.logrow!);
    if (focusedRow.current && !focusedRow.current.isConnected) {
      chosen.focus({ preventScroll: true });
      focusedRow.current = chosen;
    }
  }, []);
  useLayoutEffect(refreshRows);
  const hide = () => {
    if (list.current?.contains(document.activeElement)) {
      word.current?.focus();
    }
    setShownChoice(false);
  };
  const anyMore = messages.some((entry) => cut[entry.id] && !full[entry.id]);
  const anyFull = messages.some((entry) => full[entry.id]);
  // Reported up by each block rather than measured here, and written only on a real change. A
  // write that changed nothing renders the section again, which measures every block again,
  // which writes again.
  const onCut = useCallback((id: string, clipped: boolean) => {
    setCut((held) => (!!held[id] === clipped ? held : { ...held, [id]: clipped }));
  }, []);
  const onFull = useCallback((id: string, value: boolean) => {
    setFull((held) => ({ ...held, [id]: value }));
  }, []);
  const whole = () => {
    const next: Record<string, boolean> = { ...full };
    for (const entry of messages) {
      next[entry.id] = true;
    }
    return next;
  };
  const bulk = () => {
    word.current?.focus();
    if (!shown) {
      setShownChoice(true);
      setFull(whole());
      return;
    }
    if (anyMore) {
      setFull(whole());
      return;
    }
    if (anyFull) {
      const next = { ...full };
      for (const entry of messages) {
        next[entry.id] = false;
      }
      setFull(next);
    }
  };
  const plainAction = shown ? cardWords().saidCollapse : cardWords().saidExpand;
  const filterName =
    filter === 'replies'
      ? `, ${cardWords().logShowingReplies}`
      : filter === 'messages'
        ? `, ${cardWords().logShowingMessages}`
        : '';
  const shiftAction = !shown
    ? cardWords().saidOpenWholeDetail
    : anyMore
      ? cardWords().saidWholeDetail
      : anyFull
        ? cardWords().saidLessDetail
        : '';
  type ActivitySummaryPart =
    | { key: string; kind: 'message'; count: string; choice: 'messages' | 'replies'; pressed: boolean }
    | { key: string; kind: 'tool'; category: NonNullable<CardView['activityToolCategories']>[number] }
    | { key: string; kind: 'skill' };
  const messageSummary: ActivitySummaryPart[] = (card.activityCounts ?? []).map((count, index) => {
    const choice = index === 0 ? 'messages' : 'replies';
    return {
      key: choice,
      kind: 'message' as const,
      count,
      choice,
      pressed: filter === choice,
    };
  });
  const activitySummary: ActivitySummaryPart[] = [
    ...messageSummary,
    ...(card.activityToolCategories ?? []).map((category) => ({
      key: category.key,
      kind: 'tool' as const,
      category,
    })),
    ...(card.activitySkillCount
      ? [
          {
            key: 'skills',
            kind: 'skill' as const,
          },
        ]
      : []),
  ];
  return h('div', { class: 'sec activitysec' }, [
    h(
      'h4',
      { class: 'sectionheading' },
      h('div', { class: 'acthead' }, [
        h(
          'button',
          {
            class: 'actword',
            ref: word,
            // The name ends on what a plain press does, the way a session heading's name ends
            // on its own action. What a Shift press does reaches a screen reader through the hint's
            // detail line instead.
            'aria-label': `${card.activityName}${filterName}, ${plainAction}`,
            'aria-controls': listId,
            'aria-expanded': String(shown),
            'data-control': `activity:${card.key}`,
            // Hint detail is optional. This control intentionally supplies both fields because its
            // detail is the only visible explanation of the Shift action.
            'data-hint': shiftAction ? plainAction : undefined,
            'data-hint-detail': shiftAction || undefined,
            onClick(event: MouseEvent) {
              stop(event);
              if (keyed.current) {
                return;
              }
              if (event.shiftKey) {
                bulk();
              } else if (shown) {
                hide();
              } else {
                setShownChoice(true);
              }
            },
            onKeyDown(event: KeyboardEvent) {
              if ((event.key !== 'Enter' && event.key !== ' ') || !event.shiftKey) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              keyed.current = true;
              bulk();
            },
            onKeyUp(event: KeyboardEvent) {
              if (event.key === ' ' && event.shiftKey) {
                event.preventDefault();
              }
              keyed.current = false;
            },
            // A key pressed on the head and released somewhere else never reaches the handler above.
            // The refusal would then outlive the press it was written for. Every later press of the
            // mouse on this head would do nothing at all.
            onBlur() {
              keyed.current = false;
            },
          },
          h('span', { class: 'sec-title' }, h('span', { class: 'sec-word' }, card.activityWord)),
        ),
        h(
          'span',
          { class: 'actmix' },
          activitySummary.map((part, index) =>
            h(
              'span',
              {
                class: 'actsummarypart',
                key: part.key,
              },
              [
                index
                  ? h(
                      'span',
                      { class: 'actsummarysep', key: 'separator' },
                      part.kind === 'message' && activitySummary[index - 1].kind === 'message' ? ', ' : ' · ',
                    )
                  : null,
                part.kind === 'message'
                  ? h(
                      'button',
                      {
                        key: 'count',
                        class: 'actcount',
                        'aria-pressed': String(part.pressed),
                        'data-control': `activity-${part.choice}:${card.key}`,
                        'data-hint': part.pressed
                          ? cardWords().logEverything
                          : part.choice === 'messages'
                            ? cardWords().logMessagesOnly
                            : cardWords().logRepliesOnly,
                        'data-hint-detail': cardWords().logFilterDetail,
                        onClick(event: MouseEvent) {
                          stop(event);
                          chooseFilter(part.pressed ? 'everything' : part.choice);
                        },
                      },
                      part.count,
                    )
                  : part.kind === 'tool'
                    ? h(ActivityToolCount, {
                        card,
                        category: part.category,
                        detail: toolDetail(part.category),
                        options,
                        key: 'count',
                      })
                    : h(ActivitySkillCount, { card, detail: skillDetail(), options, key: 'count' }),
              ],
            ),
          ),
        ),
      ]),
    ),
    h('div', { class: 'actview' }, [
      h(
        'span',
        { class: 'actviewstate' },
        filter === 'everything'
          ? cardWords().logAllActivity
          : filter === 'replies'
            ? cardWords().logRepliesView
            : cardWords().logMessagesView,
      ),
      h(
        'button',
        {
          class: 'actviewaction',
          onClick(event: MouseEvent) {
            stop(event);
            chooseFilter(filter === 'everything' ? 'messages' : 'everything');
          },
        },
        filter === 'everything' ? cardWords().logShowMessagesOnly : cardWords().logShowAllActivity,
      ),
    ]),
    h(
      'div',
      {
        class: 'actlist',
        id: listId,
        hidden: !shown,
        ref: list,
        onFocusCapture(event: FocusEvent) {
          const button = (event.target as Element).closest<HTMLButtonElement>('button[data-logrow]');
          if (!button) {
            return;
          }
          focusedRow.current = button;
          roving.current = button.dataset.logrow!;
          parentRow.current = button.closest<HTMLElement>('.actrows')?.dataset.run ?? '';
          refreshRows();
        },
        onBlurCapture(event: FocusEvent) {
          const next = event.relatedTarget as Element | null;
          if (pendingDoneFilter.current && (!next || !list.current?.contains(next))) {
            pendingDoneFilter.current = false;
            setAutomaticFilter('messages');
          }
          if (next && (!list.current?.contains(next) || !next.closest('button[data-logrow]'))) {
            focusedRow.current = null;
          }
        },
        onKeyDown(event: KeyboardEvent) {
          const target = event.target as HTMLButtonElement;
          if (!target.matches('button[data-logrow]')) {
            return;
          }
          const buttons = rowButtons();
          const index = buttons.indexOf(target);
          const next =
            event.key === 'ArrowDown'
              ? Math.min(index + 1, buttons.length - 1)
              : event.key === 'ArrowUp'
                ? Math.max(index - 1, 0)
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : -1;
          if (next < 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          buttons[next]?.focus();
        },
      },
      [
        !rows.length && filter === 'messages' && !allMessages.length
          ? h('p', { class: 'actempty' }, cardWords().logNoMessages)
          : null,
        ...rows.map((row, index) => {
          if (row.kind === 'message') {
            const entry = messages.find((message) => message.id === row.id)!;
            return h(SaidBlock, {
              card,
              entry,
              expanded,
              shown,
              full: !!full[entry.id],
              onCut,
              onFull,
              options,
              key: entry.id,
            });
          }
          if (row.kind !== 'run') {
            const id = row.id ?? row.sourceId ?? `${row.kind}:${index}`;
            return h(ActivityStep, {
              row,
              id,
              card,
              open: !!lineOpen[id],
              onOpen: onLineOpen,
              onRowsChange: refreshRows,
              key: id,
            });
          }
          const id = row.id!;
          const empty = !row.steps?.length;
          const keepsDetail = row.steps?.some(
            (step) => !!step.id && (!!lineOpen[step.id] || focusedRow.current?.dataset.logrow === step.id),
          );
          const open = runChoice[id] ?? (!!row.inFlight || !!held[id] || !!keepsDetail);
          const rowsId = `${listId}-${id.replace(/[^\w-]/g, '-')}`;
          return h(Fragment, { key: id }, [
            h(
              empty ? 'div' : 'button',
              {
                class: `actrow run ${row.status}${empty ? ' earlier' : ''}`,
                'aria-label': row.label,
                'aria-expanded': empty ? undefined : String(open),
                'aria-controls': empty ? undefined : rowsId,
                'data-control': empty ? undefined : `activity-run:${card.key}:${id}`,
                'data-logrow': empty ? undefined : id,
                tabIndex: empty ? undefined : -1,
                'data-hint': empty ? undefined : open ? cardWords().logRunHide : cardWords().logRunShow,
                'data-hint-detail': empty ? undefined : row.hintDetail,
                onClick: empty
                  ? undefined
                  : (event: MouseEvent) => {
                      stop(event);
                      setRunChoice((choices) => ({ ...choices, [id]: !open }));
                    },
                onKeyDown(event: KeyboardEvent) {
                  if (event.key !== 'Escape' || !open || empty) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  setRunChoice((choices) => ({ ...choices, [id]: false }));
                },
              },
              [
                h(
                  'span',
                  { class: 'actglyph', 'aria-hidden': 'true' },
                  empty
                    ? ''
                    : row.status === 'running'
                      ? CARD_GLYPHS.running
                      : row.status === 'interrupted'
                        ? CARD_GLYPHS.interrupted
                        : open
                          ? CARD_GLYPHS.disclosureOpen
                          : CARD_GLYPHS.disclosureClosed,
                ),
                h('span', { class: 'actverb' }, [
                  row.line,
                  row.figure ? h(Fragment, {}, [' \u00b7 ', h('span', { class: 'actbad' }, row.figure)]) : null,
                ]),
                row.mix
                  ? h(Fragment, {}, [row.figure ? ' \u00b7 ' : ' ', h('span', { class: 'actmix' }, row.mix)])
                  : null,
              ],
            ),
            empty
              ? null
              : h(
                  'div',
                  {
                    class: 'actrows',
                    id: rowsId,
                    hidden: !open,
                    'data-run': id,
                    onFocusIn() {
                      setHeld((value) => (value[id] ? value : { ...value, [id]: true }));
                    },
                    onFocusOut(event: FocusEvent) {
                      if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
                        return;
                      }
                      setHeld((value) => ({ ...value, [id]: false }));
                    },
                  },
                  [
                    row.earlier ? h('div', { class: 'actmore' }, row.earlierLine) : null,
                    ...row.steps!.map((step, n) => {
                      const stepId = step.id ?? `${id}:${n}`;
                      return h(ActivityStep, {
                        row: step,
                        id: stepId,
                        card,
                        open: !!lineOpen[stepId],
                        onOpen: onLineOpen,
                        onRowsChange: refreshRows,
                        key: stepId,
                      });
                    }),
                  ],
                ),
          ]);
        }),
      ],
    ),
  ]);
}

function CardsBody({ card, expanded, options }: { card: CardView; expanded: boolean; options: CardRendererOptions }) {
  const rows: ComponentChildren[] = [];
  if (card.kind === 'compaction') {
    if (card.summaryHtml) {
      rows.push(
        h(
          Section,
          { title: 'What carried over', key: 'summary' },
          h(Summary, { html: card.summaryHtml, card, options }),
        ),
      );
    }
    return h(Fragment, {}, rows);
  }
  const layout = options.layout();
  const asked = !!(card.prompt || card.delegation || card.laterPrompts?.length);
  const record = layout.cardLayout === 'compact' ? [] : recordSections(card, options);
  const part = (name: CardBodyPart): ComponentChildren[] => {
    if (name === 'prompt') {
      if (!asked) {
        return [];
      }
      return [
        layout.promptPosition === 'above'
          ? h(PromptLead, { card, expanded, options, key: 'lead' })
          : h(PromptSection, { card, expanded, key: 'prompts' }),
      ];
    }
    if (name === 'error') {
      return card.errorText ? [h('div', { class: 'row warn', key: 'error' }, card.errorText.split('\n')[0])] : [];
    }
    if (name === 'response') {
      return card.summaryHtml
        ? [
            h(
              Section,
              { title: 'Response', hiddenTitle: true, key: 'summary' },
              h(Summary, { html: card.summaryHtml, card, options }),
            ),
          ]
        : [];
    }
    if (name === 'activity') {
      return card.activity?.length ? [h(ActivitySection, { card, expanded, options, key: 'activity' })] : [];
    }
    return record;
  };
  const columns = cardBodyColumns(layout, record.length > 0).map((names) => names.flatMap(part));
  // Two columns puts the record beside the prose. The grid applies only where the card is wide
  // enough for both columns, so a narrow card stacks the record under Activity as One column does.
  if (columns.length === 2) {
    return h(
      'div',
      { class: 'cardcols' },
      h('div', { class: 'cardcolsgrid' }, [
        h('div', { class: 'cardmain', key: 'main' }, columns[0]),
        h('div', { class: 'cardrecord', key: 'record' }, columns[1]),
      ]),
    );
  }
  return h(Fragment, {}, columns[0]);
}

export function cardHasBody(card: CardView): boolean {
  if (card.kind === 'compaction') {
    return !!card.summaryHtml;
  }
  return !!(
    card.errorText ||
    card.summaryHtml ||
    card.saidMessages?.length ||
    card.activity?.length ||
    card.prompt ||
    card.delegation ||
    card.laterPrompts?.length ||
    card.dispatched?.length
  );
}

interface CardOpenState {
  isExpanded(): boolean;
  setExpanded(expanded: boolean): void;
  expandedChanged(): void;
}

// A record chip draws the turn's files, subagents or commits, and the card beside it already
// carries those arrays. The host sends no second copy, so the rows are put on the chip's own
// list here, where both are in hand.
function withRecordRows(card: CardView, chip: ChipView): ChipView {
  const rows = chip.detailList ? detailRowsFor(card, chip.detailList.layout) : null;
  if (!rows || !chip.detailList) {
    return chip;
  }
  // A one-group record's heading gains the merged word here, where the rows are in hand.
  const single = rows.kind === 'commits' ? singleCommitGroup(commitGrouping(rows.commits)) : null;
  const heading =
    single && chip.detailList.heading
      ? { ...chip.detailList.heading, ...commitHeadingFact(single) }
      : chip.detailList.heading;
  return { ...chip, detailList: { ...chip.detailList, heading, rows } };
}

function Card({
  card,
  host,
  openState,
  options,
  updates,
}: {
  card: CardView;
  host: CardHost;
  openState: CardOpenState;
  options: CardRendererOptions;
  updates: WeakMap<CardHost, () => void>;
}) {
  const [, setRevision] = useState(0);
  const repaint = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);
  const head = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const expandable = cardHasBody(card);
  const expanded = expandable && openState.isExpanded();
  const read = options.read.isRead(card);
  const bodyId = disclosureId(card, 'body');
  const compaction = card.kind === 'compaction';
  const glyph = CARD_GLYPHS[compaction ? 'compaction' : (card.status as keyof typeof CARD_GLYPHS)] || '\u25CB';

  useLayoutEffect(() => options.read.subscribe(repaint), []);
  useEffect(() => options.comments.subscribe(repaint), []);
  useLayoutEffect(() => {
    updates.set(host, repaint);
    return () => {
      updates.delete(host);
    };
  }, [host, repaint, updates]);
  useLayoutEffect(() => options.comments.connectCard(host, card), [host, card]);

  const writeContext = () => {
    options.comments.writeContext(host, card, 'body');
    if (head.current) {
      options.comments.writeContext(head.current, card, 'head');
    }
    if (body.current) {
      options.comments.writeContext(body.current, card, 'body');
    }
  };
  const writeNotes = () => {
    if (!body.current || compaction) {
      return;
    }
    options.comments.renderAnnotations(body.current, card);
    reclipMessages(body.current);
  };

  useLayoutEffect(() => {
    host.classList.toggle('has-body', expandable);
    host.classList.toggle('is-open', expanded);
    host.classList.toggle('is-read', read);
    writeContext();
    writeNotes();
    if (expanded && options.read.canMark(card)) {
      options.read.mark(card.key);
    }
  });

  const toggle = () => {
    const next = !expanded;
    openState.setExpanded(next);
    if (next && options.read.canMark(card)) {
      options.read.mark(card.key);
    }
    repaint();
    options.comments.refreshSelection();
  };

  const whenAt = compaction ? card.at : card.endedAt;
  const timing = [
    h(
      'span',
      {
        class: 'when',
        title: compaction ? card.absolute : card.lastAbsolute,
        'data-at': String(whenAt),
      },
      compaction ? card.relative : card.lastRelative,
    ),
    card.duration
      ? h('span', { class: 'durationfact', title: card.durationDetail }, [
          h('span', { class: 'durationword' }, `${card.durationWord} `),
          h(
            'span',
            {
              class: 'durationvalue',
              'data-since': card.live ? String(card.startedAt) : undefined,
            },
            card.duration,
          ),
        ])
      : null,
  ];
  const headProps = {
    class: expandable ? 'head' : 'head statichead',
    ref: head,
    title: options.comments.headTitle(card),
    'aria-label': expandable ? card.label : undefined,
    'aria-controls': expandable ? bodyId : undefined,
    'aria-expanded': expandable ? String(expanded) : undefined,
    'data-control': expandable ? `card:${card.key}` : undefined,
    onClick: expandable ? toggle : undefined,
  };
  const doing = card.doing
    ? [
        h('span', { class: 'actglyph', 'aria-hidden': 'true' }, CARD_GLYPHS.running),
        h('span', { class: 'actverb' }, card.doing),
        card.doingCode ? h(Fragment, {}, [' ', h('code', { class: 'actcode' }, card.doingCode)]) : null,
        card.doingSince
          ? h(Fragment, {}, [
              ' ',
              h('span', {
                class: 'actfig',
                'data-since': String(card.doingSince),
                'aria-hidden': 'true',
              }),
            ])
          : null,
      ]
    : null;

  return h(Fragment, {}, [
    h(
      'h3',
      { class: 'cardheading', id: cardHeadingId(card.key) },
      h(expandable ? 'button' : 'span', headProps, [
        h('span', { class: 'glyph' }, glyph),
        h('span', { class: 'timing' }, timing),
        card.agent ? h('span', { class: 'agent' }, card.agent) : null,
        card.model ? h('span', { class: 'model' }, card.model) : null,
        card.effort ? h('span', { class: 'effort' }, card.effort) : null,
      ]),
    ),
    h(
      'div',
      { class: 'chips', hidden: !card.chips?.length },
      inlineText(
        (card.chips ?? []).map((chip, index) =>
          h(StatChip, {
            chip: withRecordRows(card, chip),
            statDetails: options.statDetails,
            key: chip.metric ?? index,
          }),
        ),
      ),
    ),
    card.headlineHtml
      ? h('div', {
          class: 'headline',
          hidden: !!card.summaryHtml && expanded,
          key: 'html',
          dangerouslySetInnerHTML: { __html: card.headlineHtml },
        })
      : h('div', { class: 'headline', hidden: !!card.summaryHtml && expanded, key: 'text' }, card.headline),
    h('div', { class: 'doing', hidden: !card.doing || expanded }, doing),
    h(
      'div',
      { class: 'body', id: expandable ? bodyId : undefined, hidden: !expanded, ref: body },
      h(CardsBody, { card, expanded, options }),
    ),
  ]);
}

// The card's clock-worded fields, written in place.
//
// The print that decides whether a card is drawn again leaves every clock-worded value out,
// so a poll tick alone and a day boundary alone both read as no change at all. That is what
// lets a text selection survive the poll. These fields still have to follow the clock, and
// each one is a tooltip, an accessible name or the instant a visible age is drawn from, so
// none of them can wait for the next content change.
function writeCardClock(host: CardHost, card: CardView): void {
  const head = host.querySelector('.head');
  if (head && card.label && head.getAttribute('aria-label') !== card.label) {
    head.setAttribute('aria-label', card.label);
  }
  const when = host.querySelector<HTMLElement>('.when');
  const whenAbsolute = card.kind === 'compaction' ? card.absolute : card.lastAbsolute;
  const whenAt = card.kind === 'compaction' ? card.at : card.endedAt;
  if (when && whenAbsolute && when.title !== whenAbsolute) {
    when.title = whenAbsolute;
  }
  if (when && whenAt !== undefined && when.dataset.at !== String(whenAt)) {
    when.dataset.at = String(whenAt);
  }
  const duration = host.querySelector<HTMLElement>('.durationfact');
  if (duration && card.durationDetail && duration.title !== card.durationDetail) {
    duration.title = card.durationDetail;
  }
  const rows = (card.activity ?? []).flatMap((row) => [row, ...(row.steps ?? [])]);
  for (const message of host.querySelectorAll<HTMLElement>('.actrow.message')) {
    const row = rows.find((candidate) => candidate.id === message.dataset.message);
    if (!row) {
      continue;
    }
    const title =
      row.messageKind === 'answer' ? [cardWords().saidReplied, row.absolute].filter(Boolean).join(' ') : row.absolute;
    if (message.title !== title) {
      message.title = title || '';
    }
    const spoken = message.querySelector('.saidonly');
    if (spoken && spoken.textContent !== row.spoken) {
      spoken.textContent = row.spoken || '';
    }
  }
  for (const button of host.querySelectorAll<HTMLElement>('button[data-logrow]')) {
    const row = rows.find((candidate) => candidate.id === button.dataset.logrow);
    if (row && button.dataset.hintDetail !== row.hintDetail) {
      button.dataset.hintDetail = row.hintDetail || '';
    }
  }
  for (const row of host.querySelectorAll<HTMLElement>('.commitrow[data-record]')) {
    const commit = (card.commits ?? []).find((candidate) => candidate.key === row.dataset.record);
    if (!commit) {
      continue;
    }
    const title = commitRowTitle(commit);
    if (row.title !== title) {
      row.title = title;
    }
    const spoken = row.querySelector('.commitwhen');
    const words = commitRowSpoken(commit);
    if (spoken && spoken.textContent !== words) {
      spoken.textContent = words;
    }
  }
  // A group heading and a one-group section heading say when their branch was merged, in the
  // group's accessible name, the merged word's hover and its hidden words.
  const groupHeads = host.querySelectorAll<HTMLElement>('.commitgroup[data-group], [data-arrival]');
  if (groupHeads.length) {
    const groups = new Map(commitGrouping(card.commits ?? []).groups.map((group) => [group.key, group]));
    for (const node of groupHeads) {
      const group = groups.get(node.dataset.group ?? node.dataset.arrival ?? '');
      if (!group) {
        continue;
      }
      if (node.dataset.group !== undefined) {
        const label = commitGroupLabel(group);
        if (node.getAttribute('aria-label') !== label) {
          node.setAttribute('aria-label', label);
        }
        continue;
      }
      if (!group.arrival) {
        continue;
      }
      const title = arrivalTitle(group.arrival);
      if (node.title !== title) {
        node.title = title;
      }
      const spoken = node.querySelector('.sr-only');
      const words = arrivalSpoken(group.arrival);
      if (spoken && spoken.textContent !== words) {
        spoken.textContent = words;
      }
    }
  }
  const asks = card.laterPrompts ?? [];
  const askWhens = host.querySelectorAll<HTMLElement>('.askwhen');
  for (let index = 0; index < askWhens.length && index < asks.length; index += 1) {
    const absolute = asks[index].absolute;
    if (absolute && askWhens[index].title !== absolute) {
      askWhens[index].title = absolute;
    }
  }
}

export interface CardRenderer {
  draw(host: CardHost, card: CardView, openState: CardOpenState): void;
  refresh(host: CardHost): void;
  refreshClock(host: CardHost, card: CardView): void;
  remove(host: CardHost): void;
}

export function createCardRenderer(options: CardRendererOptions): CardRenderer {
  const updates = new WeakMap<CardHost, () => void>();
  return {
    draw(host, card, openState) {
      host.className = card.kind === 'compaction' ? 'compaction' : `turn ${card.status}`;
      host.dataset.key = card.key;
      host.dataset.session = card.sessionId;
      render(h(Card, { key: card.key, card, host, openState, options, updates }), host);
    },
    refresh(host) {
      updates.get(host)?.();
    },
    refreshClock(host, card) {
      writeCardClock(host, card);
    },
    remove(host) {
      render(null, host);
    },
  };
}
