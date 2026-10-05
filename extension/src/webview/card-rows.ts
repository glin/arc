// The record rows a turn keeps: its files, its subagents and its commits.
//
// One component per row kind, drawn by the chip popover that carries the record. A row posts
// the message its kind names, so a press reaches the editor tab the row stands for.

import { Fragment, h, render, type ComponentChild } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  ARRIVAL_WORD,
  arrivalSpoken,
  arrivalTitle,
  cardPartId,
  CARD_GLYPHS,
  commitGroupLabel,
  commitGroupName,
  commitHeadFact,
  groupCommitRows,
  openMakerSession,
  type CommitGrouping,
  type CommitGroupView,
} from '../view/card-presentation.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import { runningFor } from '../view/rail.ts';
import { inlineText } from './inline-text.ts';
import { DiffPair, hasDiff, StaticStatChip } from './stat-chip.ts';
import type { CardIcon, CardView } from './payload-contracts.ts';
import type { PanelToHost } from './protocol.ts';
import type { StatDetailList, StatDetailRenderer } from './stat-detail.ts';

export type FileRowView = NonNullable<CardView['files']>[number];
export type AgentRowView = NonNullable<CardView['agents']>[number];
export type AgentFigureView = AgentRowView['figures'][number];
export type CommitRowView = NonNullable<CardView['commits']>[number];

// A turn's record, addressed by the card it belongs to. The same shape the extension puts on
// a chip's detail list, so the browser reads rows rather than building them.
export type DetailRows =
  // `turnDiff` is unset on the turn's own record, which offers the whole turn as one diff. A
  // subagent's files record holds one child's share of that turn, so it offers none.
  | { kind: 'files'; key: string; files: FileRowView[]; turnDiff?: boolean; sourceSessionId?: string }
  // Ordinary subagents filter the parent card's rows. Dispatched rows carry their own.
  | { kind: 'agents'; key: string; agents: AgentRowView[]; files: FileRowView[]; commits: CommitRowView[] }
  | { kind: 'dispatched'; key: string; agents: AgentRowView[]; files: FileRowView[]; commits: CommitRowView[] }
  | { kind: 'commits'; key: string; commits: CommitRowView[] };

export type RowPost = (message: PanelToHost) => void;

const noContextClass = () => '';

// The rows a subagent's commits figure may draw. The Commits list holds the turn's commits and
// its landings together, and a landing is not a commit a child wrote, so a figure's record
// reads the written commits alone.
export function writtenCommitRows(card: CardView): CommitRowView[] {
  return (card.commits ?? []).filter((row) => row.kind === 'commit');
}

// The record a chip popover draws, taken off the card that already holds it. A detail list
// names its record on `layout`, and the card carries the rows themselves, so the popover and
// the card body read the same owner and a press on either reaches the same editor tab.
export function detailRowsFor(card: CardView, layout: string | undefined): DetailRows | null {
  if (layout === 'files') {
    return { kind: 'files', key: card.key, files: card.files ?? [] };
  }
  if (layout === 'agents') {
    return {
      kind: 'agents',
      key: card.key,
      agents: card.agents ?? [],
      files: card.files ?? [],
      commits: writtenCommitRows(card),
    };
  }
  if (layout === 'dispatched') {
    return { kind: 'dispatched', key: card.key, agents: card.dispatched ?? [], files: [], commits: [] };
  }
  if (layout === 'commits') {
    return { kind: 'commits', key: card.key, commits: card.commits ?? [] };
  }
  return null;
}

function stop(event: Event): void {
  event.stopPropagation();
}

export function FileIcon({ icon }: { icon: CardIcon }) {
  const themed = icon.glyph || icon.image;
  const child = icon.glyph
    ? h(
        'span',
        {
          style: {
            fontFamily: icon.glyph.font,
            fontSize: icon.glyph.size || undefined,
            color: icon.glyph.colour || undefined,
          },
        },
        icon.glyph.character,
      )
    : icon.image
      ? h('img', { src: icon.image, alt: '' })
      : icon.label;
  return h(
    'span',
    {
      class: themed ? 'ficon themed' : 'ficon',
      style: !themed && icon.colour ? { color: icon.colour } : undefined,
      'aria-hidden': 'true',
    },
    child,
  );
}

export function FileRow({
  cardKey,
  file,
  post,
  sourceSessionId,
}: {
  cardKey: string;
  file: FileRowView;
  post: RowPost;
  sourceSessionId?: string;
}) {
  return h(
    'button',
    {
      class: 'row click',
      title: file.detail ?? file.shownPath,
      'aria-label': file.label,
      'data-control': `file:${cardKey}:${file.path}`,
      'data-vscode-context': JSON.stringify({
        webviewSection: 'arcFile',
        path: file.path,
        preventDefaultContextMenuItems: true,
      }),
      onClick(event: MouseEvent) {
        stop(event);
        post({
          type: 'openFile',
          key: cardKey,
          path: file.path,
          ...(sourceSessionId ? { sourceSessionId } : {}),
          beside: event.ctrlKey || event.metaKey,
        });
      },
    },
    [
      h(FileIcon, { icon: file.icon }),
      file.lead
        ? h('span', { class: 'name path' }, [
            h('span', { class: 'lead' }, file.lead),
            h('span', { class: 'base' }, file.name),
          ])
        : h('span', { class: 'name' }, file.name),
      // A row the shell named without hunks draws no counts: a zero would read as a claim
      // that nothing moved in a file this record could not detail. A file that recorded a
      // zero on both halves draws no cell at all, so the row ends on its name and draws no
      // separator in front of an empty one. The nums span, when it is drawn, opens with a
      // literal space, the way a commit row's facts line does, because the stylesheet's flex
      // gap is not there for a copy of the row's text or a reading with no stylesheet. The
      // space in front of the word new is written only where the pair it parts is drawn.
      !file.countsUnknown && (hasDiff(file.added, file.removed) || file.isNew)
        ? h(Fragment, {}, [
            ' ',
            h('span', { class: 'nums' }, [
              h(DiffPair, { added: file.added, removed: file.removed }),
              file.isNew
                ? h(Fragment, {}, [hasDiff(file.added, file.removed) ? ' ' : null, h('span', { class: 'dim' }, 'new')])
                : null,
            ]),
          ])
        : null,
    ],
  );
}

// The press under the file rows. It opens the whole turn as one diff, which is a different
// act from opening one file, so it is drawn as a link rather than as another row.
export function TurnDiffAction({ cardKey, post }: { cardKey: string; post: RowPost }) {
  return h(
    'div',
    { class: 'actions' },
    h(
      'button',
      {
        class: 'editor-link',
        'data-control': `diff:${cardKey}`,
        onClick(event: MouseEvent) {
          stop(event);
          post({ type: 'openTurnDiff', key: cardKey, beside: event.ctrlKey || event.metaKey });
        },
      },
      CARD_ACTIONS.turnDiff,
    ),
  );
}

// The Files section's own row cap, past which the card body stops drawing the record inline. A
// scroll region inside the timeline's own scroll would trap the wheel, so the section cuts the
// list itself and offers a press for the rest instead. The chip popover floats above the page
// and already scrolls on its own, so it passes no cap.
export const FILES_SECTION_CAP = 20;

// The rows a capped Files section draws before the reader presses for the rest, and whether the
// list is capped at all. A caller with no cap, or a list at or under it, gets every row back
// untouched, the same array and not a copy of it. `capped` and `hiddenCount` name the cut at
// rest and hold steady across a toggle, so the button they feed never draws "Show 0 more files"
// at the boundary and a caller never has to recompute the cut this function already made.
export function cappedFileRows<T>(
  files: readonly T[],
  cap: number | undefined,
  expanded: boolean,
): { shown: readonly T[]; capped: boolean; hiddenCount: number } {
  if (!cap || files.length <= cap) {
    return { shown: files, capped: false, hiddenCount: 0 };
  }
  const hiddenCount = files.length - cap;
  if (expanded) {
    return { shown: files, capped: true, hiddenCount };
  }
  return { shown: files.slice(0, cap), capped: true, hiddenCount };
}

// The words a capped Files section's button carries. A single hidden file reads as a file, not
// a files, and the toggle names what the next press does rather than repeating what this one
// did, so an expanded list reads "fewer" instead of the count that pressed it open.
export function filesMoreLabel(hiddenCount: number, expanded: boolean): string {
  if (expanded) {
    return CARD_ACTIONS.filesLess;
  }
  return `Show ${hiddenCount} ${hiddenCount === 1 ? CARD_ACTIONS.filesMoreOne : CARD_ACTIONS.filesMoreMany}`;
}

// The button's full accessible name: its visible label, plus the count the cap still keeps off
// screen right now. The visible label only ever promises the next bounded batch, so on a turn
// with thousands of files it never speaks the count a screen reader most needs. Silent once
// nothing is left hidden, because a name that added "0 files hidden" would only repeat the label.
export function filesMoreAccessibleName(label: string, hiddenTotal: number): string {
  if (hiddenTotal <= 0) {
    return label;
  }
  return `${label}, ${hiddenTotal} ${hiddenTotal === 1 ? 'file' : 'files'} hidden`;
}

// The Files section's show/hide-more button, built as a pure function so a test can read its
// vnode without mounting Preact's hook machinery. `hiddenCount` is what the visible label
// spends: the next batch a press adds while collapsed, or the count `filesMoreLabel` ignores
// once `labelExpanded` swaps it to "Show fewer files". `ariaExpanded` is true once any batch
// past the first is on screen, which can be well before `labelExpanded` turns true on a list of
// thousands. `hiddenTotal` is the count still off screen right now, added to the accessible name
// so a screen reader hears it even where the label only names the next batch. `controlsId` names
// the element the button's press draws rows into, so a screen reader can name that target from
// the button before ever moving to it.
export function filesMoreButton(
  cardKey: string,
  hiddenCount: number,
  labelExpanded: boolean,
  ariaExpanded: boolean,
  hiddenTotal: number,
  onToggle: () => void,
  controlsId: string,
): ComponentChild {
  const label = filesMoreLabel(hiddenCount, labelExpanded);
  const name = filesMoreAccessibleName(label, hiddenTotal);
  return h(
    'button',
    {
      key: 'more',
      class: 'more',
      'aria-expanded': String(ariaExpanded),
      ...(name !== label ? { 'aria-label': name } : {}),
      'aria-controls': controlsId,
      'data-control': `files-more:${cardKey}`,
      onClick(event: MouseEvent) {
        stop(event);
        onToggle();
      },
    },
    label,
  );
}

// The id the Files section's row list carries, so the show-more toggle's `aria-controls` names
// the exact element it reveals rows into. Shares `cardPartId` with `disclosureId` in card.ts,
// the same id shape a section's own list carries there, so the two never drift apart by hand.
function filesRowsId(cardKey: string): string {
  return cardPartId(cardKey, 'files-rows');
}

// One turn's file rows, capped in place and revealed a batch at a time. The button that lifts
// the cap stays mounted for as long as the list is capped, whether any of it is revealed or the
// whole list is, and keeps its own revealed-batch count, which a redraw of a live card leaves
// alone because Preact keeps a component's state wherever the tree above it keeps drawing the
// same component in the same place. Keeping the button mounted rather than swapping it for the
// full list on click keeps the reader's keyboard focus on it, since a button that unmounts on
// press drops focus to the document body.
//
// A press reveals the next batch of `cap` rows rather than the whole list at once. A turn can
// touch thousands of files, and mounting every one of them on a single press is the same
// unbounded draw the cap exists to stop, only moved one press later. The batch is the section's
// own cap rather than a second constant, so a reader who has already learned the rhythm of the
// first press gets the same rhythm on every press after it.
function FilesRows({ rows, post, cap }: { rows: Extract<DetailRows, { kind: 'files' }>; post: RowPost; cap?: number }) {
  const [revealedBatches, setRevealedBatches] = useState(1);
  // Sticky once a press reaches the end of the list, and cleared only by a collapse or by the
  // list falling to or under the cap. Without it, a live card whose turn grows past the batch
  // boundary that used to reach the end would fall back to partly revealed on its own, though no
  // press asked for that: a redraw must leave an expanded list expanded.
  const [stickyExpanded, setStickyExpanded] = useState(false);
  const total = rows.files.length;
  const revealedCount = cap ? cap * revealedBatches : total;
  const atOrUnderCap = !cap || total <= cap;
  const naturallyFullyRevealed = !cap || revealedCount >= total;
  const fullyRevealed = stickyExpanded || naturallyFullyRevealed;
  // True the moment a second batch is on screen, well before the list is fully revealed on a
  // turn of thousands of files, because a screen reader must hear that the press already did
  // something even where most of the list is still hidden.
  const ariaExpanded = revealedBatches > 1;
  // Guarded by `!atOrUnderCap` as well as by the count itself, so a list sitting exactly at the
  // cap, which reads as naturally revealed the moment it has one batch, never re-arms the sticky
  // flag the reset effect below just cleared: the two would otherwise fight to a standstill on
  // every render a list held right at the cap causes.
  useEffect(() => {
    if (!atOrUnderCap && naturallyFullyRevealed && !stickyExpanded) {
      setStickyExpanded(true);
    }
  }, [atOrUnderCap, naturallyFullyRevealed, stickyExpanded]);
  // A list that falls to or under the cap keeps no batches of its own. Clearing the state here
  // means a later regrowth past the cap starts the reader back at the first batch, rather than
  // resuming a stale expansion that would mount every row on the redraw that grew it.
  useEffect(() => {
    if (atOrUnderCap) {
      setRevealedBatches(1);
      setStickyExpanded(false);
    }
  }, [atOrUnderCap]);
  // Once every row is revealed, `cappedFileRows` is asked with the original cap and `expanded:
  // true`, the same call the section made before it could reveal in batches, so a fully open
  // list still reads as capped and keeps its "Show fewer files" button. Short of that, it is
  // asked with the batch boundary reached so far, which is always under `total`, so it keeps
  // reading as capped and keeps handing back the rows this batch has reached.
  const { shown, capped, hiddenCount } = fullyRevealed
    ? cappedFileRows(rows.files, cap, true)
    : cappedFileRows(rows.files, revealedCount, false);
  // What the button's label promises the next press will add, never the count still hidden
  // behind every press to come, so the visible label never claims a press will mount more rows
  // than this one bounded batch. `hiddenCount` above already holds the true remaining count for
  // the accessible name.
  const nextBatch = cap ? Math.min(cap, total - revealedCount) : 0;
  const rowsId = filesRowsId(rows.key);
  const fileRows = shown.map((file) =>
    h(FileRow, {
      cardKey: rows.key,
      file,
      post,
      sourceSessionId: rows.sourceSessionId,
      key: file.path,
    }),
  );
  // The chip popover, which never carries a cap, keeps the file rows as the host's own direct
  // children: the panel.layout browser tests read that structure with a direct-child selector,
  // and the popover already scrolls inside its own bound so it draws no toggle to control. Only
  // the card body, where `cap` names a batch, wraps the rows in the element the toggle controls.
  return h(Fragment, {}, [
    cap === undefined ? fileRows : h('div', { id: rowsId }, fileRows),
    capped
      ? filesMoreButton(
          rows.key,
          fullyRevealed ? hiddenCount : nextBatch,
          fullyRevealed,
          ariaExpanded,
          fullyRevealed ? 0 : hiddenCount,
          () => {
            if (fullyRevealed) {
              setRevealedBatches(1);
              setStickyExpanded(false);
              return;
            }
            setRevealedBatches((batches) => batches + 1);
          },
          rowsId,
        )
      : null,
    rows.turnDiff === false ? null : h(TurnDiffAction, { cardKey: rows.key, post, key: 'diff' }),
  ]);
}

// One subagent, in the Subagents chip popover and in the card's Subagents section alike. The
// state mark is the row's own child, in the first grid column, so the name and the figures
// under it share one left edge in the second. Line one is the name and one model run, wrapped
// rather than cut, and the model and its reasoning effort stay on one line as that run. The
// literal space before the facts is what parts line one from line two when the stylesheet is
// unavailable, and a grid container leaves a space of its own unrendered. Line
// two is the figures and the state word. A running row has live-process evidence and draws the session
// rail's running word with the time since the launch, which the panel clock rewords. An open
// child has an unfinished record Arc cannot place as live, so it draws the word alone and never
// ticks. Its mark is the running dot. The time span holds
// its own leading space and stays empty under a minute, so the clock can add the time later
// without a stray space before it. A finished row draws no word, so its spoken text says
// finished instead. The tools, requests and tokens ride in the row's hint, and each figure
// carries the record behind its own total. The row's state rides on `data-state` rather than a
// class, because the card around the row already carries its own status as a class.
//
// The row itself opens nothing. The name is its one press, into the child session, so a press
// beside the name leaves every figure its own hover. A row whose child has no session draws
// the plain name and takes the keyboard stop the link would have held. Every record is in a
// hint rather than a native tooltip, which opens for a pointer and for nothing else.
// The record behind one figure, built when its popover asks for it. The commits and the files
// records draw their owner's rows, filtered to the shas and the paths the child touched, so
// neither reads as the run of plain text it was. Every other record is the list as it arrived.
// One grouping per rows array. The card body, the card's commits popover and the clock all read
// the card's own `commits` array, so they share one grouping of it, and a subagent's record
// groups its filtered rows once for its heading and its list alike.
const groupings = new WeakMap<readonly CommitRowView[], CommitGrouping<CommitRowView>>();

export function commitGrouping(commits: readonly CommitRowView[]): CommitGrouping<CommitRowView> {
  let grouping = groupings.get(commits);
  if (!grouping) {
    grouping = groupCommitRows(commits);
    groupings.set(commits, grouping);
  }
  return grouping;
}

export function singleCommitGroup<Row extends CommitRowView>(
  grouping: CommitGrouping<Row>,
): CommitGroupView<Row> | null {
  return grouping.single ? grouping.groups[0] : null;
}

// What a one-group record's heading says beside its figure: the branch, and the merged word's
// hover and hidden words when the branch was merged. The panel adds the arrival from the rows,
// because its time moves at midnight and the host's heading must not.
export function commitHeadingFact(group: CommitGroupView): {
  fact: string;
  factArrival?: { title: string; spoken: string };
} {
  return {
    fact: commitHeadFact(group),
    ...(group.arrival
      ? { factArrival: { title: arrivalTitle(group.arrival), spoken: arrivalSpoken(group.arrival) } }
      : {}),
  };
}

// The subagent a record is scoped to. Two subagents can carry an identical description, so the
// name alone cannot tell one from the other. A session on both sides proves they are the same
// maker. Child artifacts can exist without a session id, and where the record's own subagent
// carries none, a shared name proves nothing, so the row keeps its maker line rather than
// risking a different subagent's row losing it.
interface RecordScope {
  name: string;
  session: string | null;
}

// One commit row as the subagent that wrote it sees its own record. A turn's own record carries
// several makers, so the maker line there is the only thing saying who wrote which row. A
// subagent's record is already open under that one subagent's name, so the line naming that
// same subagent says nothing and the row loses it. A row made by somebody else, including a
// different subagent whose description happens to match, keeps it.
function ownRow(row: CommitRowView, scopedTo?: RecordScope): CommitRowView {
  if (
    !scopedTo ||
    scopedTo.session === null ||
    row.madeBy !== scopedTo.name ||
    row.madeBySession !== scopedTo.session
  ) {
    return row;
  }
  return { ...row, madeBy: undefined, madeBySession: null };
}

export function agentFigureRecord(
  figure: AgentFigureView,
  cardKey: string,
  files: FileRowView[],
  commits: CommitRowView[],
  scopedTo?: RecordScope,
  sourceSessionId?: string,
): (() => StatDetailList) | undefined {
  const record = figure.record as StatDetailList | undefined;
  if (!record) {
    return undefined;
  }
  if (figure.metric === 'commits' && figure.shas) {
    // A sha reaches the row abbreviated and the child's own record whole, or the other way
    // about, so the two are matched by prefix the way the turn's own totals match them.
    const shas = figure.shas;
    const held = (sha: string) => shas.some((held) => held.startsWith(sha) || sha.startsWith(held));
    // The rows are picked inside the thunk, so a subagent row that nobody opens costs the
    // render nothing. Picked outside it, every card draw would walk the turn's whole commit
    // list once for each subagent on it.
    //
    // A child's commits often sit on one branch while the turn's span several, so the child's
    // record groups its own rows. Where they form one group, its heading names that branch
    // beside the figure, the way the turn's own record does.
    return () => {
      const own = commits.filter((row) => held(row.sha)).map((row) => ownRow(row, scopedTo));
      const single = singleCommitGroup(commitGrouping(own));
      const heading = single && record.heading ? { ...record.heading, ...commitHeadingFact(single) } : record.heading;
      return { ...record, heading, rows: { kind: 'commits', key: cardKey, commits: own } };
    };
  }
  if (figure.metric === 'files' && figure.paths) {
    const paths = new Set(figure.paths);
    return () => ({
      ...record,
      rows: {
        kind: 'files',
        key: cardKey,
        files: files.filter((row) => paths.has(row.path)),
        turnDiff: false,
        ...(sourceSessionId ? { sourceSessionId } : {}),
      },
    });
  }
  return () => record;
}

export function AgentRow({
  cardKey,
  agent,
  post,
  files = [],
  commits = [],
  figureDetails,
}: {
  cardKey: string;
  agent: AgentRowView;
  post: RowPost;
  files?: FileRowView[];
  commits?: CommitRowView[];
  figureDetails?: StatDetailRenderer;
}) {
  const link = agent.sessionId;
  const word =
    agent.state === 'running' && agent.since !== null
      ? h('span', { class: 'agentstate' }, [
          agent.stateWord,
          h(
            'span',
            { class: 'railfor', 'data-running-since': String(agent.since) },
            runningFor(agent.since, Date.now()),
          ),
        ])
      : agent.stateWord
        ? h('span', { class: 'agentstate' }, agent.stateWord)
        : null;
  // The row is one keyboard stop, whatever its figures come to. The first figure holding a
  // record takes it, and the arrow keys below cross to the rest, so a popover of eight children
  // costs the reader eight presses to walk rather than forty.
  let firstStop = true;
  const line: ComponentChild[] = agent.figures.map((figure) => {
    const record = agentFigureRecord(
      figure,
      cardKey,
      files,
      commits,
      { name: agent.description, session: agent.sessionId },
      agent.kind === 'dispatch' ? (agent.sessionId ?? undefined) : undefined,
    );
    const stop = !!record && !!figureDetails && firstStop;
    if (stop) {
      firstStop = false;
    }
    return h(StaticStatChip, {
      stat: { ...figure, record },
      contextClass: noContextClass,
      statDetails: figureDetails,
      stop,
      key: figure.metric,
    });
  });
  if (word) {
    line.push(word);
  } else if (agent.state === 'done') {
    line.push(h('span', { class: 'sr-only' }, 'finished'));
  }
  if (!link) {
    line.push(h('span', { class: 'sr-only' }, ', session unavailable'));
  }
  const record = agent.hintDetail ? { 'data-hint-detail': agent.hintDetail, 'data-hint-lines': '' } : {};
  // The row is a focus stop wherever it holds the run line and no link to carry it. A linked
  // row puts that same record on its name, so one stop reaches the press and the record at
  // once. A figure answers for its own total and never for the run line, so a row of figures
  // leaves the run line out of the keyboard's reach unless the row itself holds a stop.
  const rowStop = !link && !!agent.hintDetail;
  // The arrow keys cross the row's figures. Focus on a figure opens its record unpinned, so
  // the record the reader left closes before the next one opens.
  const crossFigures = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    const host = event.currentTarget as HTMLElement;
    const stops = Array.from(host.querySelectorAll<HTMLElement>('.railstatchip[tabindex]'));
    const at = stops.indexOf(event.target as HTMLElement);
    const to = at < 0 ? null : stops[at + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!to) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    figureDetails?.dismiss();
    for (const figure of stops) {
      figure.tabIndex = figure === to ? 0 : -1;
    }
    to.focus();
  };
  return h(
    'div',
    {
      class: 'row agentrow',
      'data-kind': agent.kind ?? 'subagent',
      'data-state': agent.state,
      'data-hint': agent.kind === 'dispatch' ? CARD_ACTIONS.dispatchedRecord : CARD_ACTIONS.subagentRecord,
      ...record,
      ...(rowStop ? { tabIndex: 0 } : {}),
    },
    [
      h(
        'span',
        { class: 'glyph', 'aria-hidden': 'true' },
        CARD_GLYPHS[agent.state === 'open' ? 'running' : agent.state],
      ),
      ' ',
      h(
        'span',
        { class: 'agenthead' },
        inlineText([
          link
            ? h(
                'button',
                {
                  class: 'name namelink',
                  'data-control': `session:${cardKey}:${agent.sessionId}`,
                  'data-hint':
                    agent.kind === 'dispatch' ? CARD_ACTIONS.openDispatchedSession : CARD_ACTIONS.openSubagentSession,
                  ...record,
                  onClick(event: MouseEvent) {
                    stop(event);
                    post({ type: 'showSession', session: agent.sessionId as string });
                  },
                },
                [
                  h('span', { class: 'sr-only' }, 'Open '),
                  agent.description,
                  h('span', { class: 'sr-only' }, ' session,'),
                ],
              )
            : h('span', { class: 'name' }, [agent.description, h('span', { class: 'sr-only' }, ',')]),
          agent.model || agent.effort
            ? h(
                'span',
                { class: 'agentmodelrun' },
                inlineText([
                  agent.model ? h('span', { class: 'model' }, agent.model) : null,
                  agent.effort
                    ? h('span', { class: 'effort' }, [
                        agent.model ? h('span', { 'aria-hidden': 'true' }, '· ') : null,
                        agent.effort,
                        h('span', { class: 'sr-only' }, ' reasoning effort'),
                      ])
                    : null,
                ]),
              )
            : null,
        ]),
      ),
      ' ',
      h('span', { class: 'agentfacts', onKeyDown: crossFigures }, inlineText(line)),
    ],
  );
}

// The row's hover, and the hidden words a screen reader reads after the subject. Both end in
// the full local time, which moves at midnight, so `writeCardClock` writes them again from
// these same two functions rather than from a copy of the wording.
//
// A landing drawn as a row is one no branch of the record explains, so its hover says which
// branch it came from when the record knows, and says the record does not know otherwise.
export function commitRowTitle(commit: CommitRowView): string {
  const when =
    commit.kind === 'landing'
      ? `Merged into ${commit.landingTarget} at ${commit.absolute}, as ${commit.sha}${
          commit.mergedBranch
            ? `, from ${commit.mergedBranch}.`
            : '. The record does not say which branch it came from.'
        }`
      : `Committed ${commit.absolute}`;
  return [commit.detail, when].filter(Boolean).join('\n');
}

export function commitRowSpoken(commit: CommitRowView): string {
  return commit.kind === 'landing'
    ? `, merged into ${commit.landingTarget} ${commit.absolute}`
    : `, committed ${commit.absolute}`;
}

// A commit row is one line: the hash, the subject and the line counts. The subject ends in an
// ellipsis rather than wrapping, and the counts keep their cell at the right edge. The hash is
// the row's first control. The branch and the place belong to the record's group heading, or to
// the section heading when the record holds one group, so the row draws neither. The relative
// age is not drawn either, because the card head already carries the turn's age. The full
// subject and the full local time ride in the row's hover and in its spoken name.
//
// A subagent's row adds a second line, the words made by and the subagent's name. The name is a
// press into the subagent's session when the row knows it, and plain text otherwise. A landing
// drawn as a row reads merged in on that line. A commit that reports no line counts, and a
// commit that moved no line, keep the count cell and leave it empty.
export function CommitRow({ cardKey, commit, post }: { cardKey: string; commit: CommitRowView; post: RowPost }) {
  const landing = commit.kind === 'landing';
  const moved = hasDiff(commit.added ?? undefined, commit.removed ?? undefined);
  // A commit recorded as moving no line says so, because an empty cell reads as a count never
  // recorded. Every other pair keeps dropping a zero half.
  const counts = moved
    ? h(DiffPair, { added: commit.added as number, removed: commit.removed as number })
    : commit.added === 0 && commit.removed === 0
      ? h('span', {}, [h('span', { class: 'add' }, '+0'), ' ', h('span', { class: 'del' }, '−0')])
      : null;
  const session = commit.madeBySession;
  const maker = commit.madeBy
    ? h('span', { class: 'commitmaker' }, [
        h('span', { class: 'commitmakerword' }, 'made by'),
        ' ',
        session
          ? h(
              'button',
              {
                class: 'commitmakerlink',
                'data-control': `session:${cardKey}:${session}`,
                'data-hint': openMakerSession(commit.madeBy),
                onClick(event: MouseEvent) {
                  stop(event);
                  post({ type: 'showSession', session });
                },
              },
              [h('span', { class: 'sr-only' }, 'Open '), commit.madeBy, h('span', { class: 'sr-only' }, ' session')],
            )
          : h('span', { class: 'commitmakername' }, commit.madeBy),
      ])
    : null;
  const facts = landing ? h('span', { class: 'dim' }, 'merged in') : maker;
  const sha = commit.dir
    ? h(
        'button',
        {
          class: 'sha editor-link',
          'aria-label': CARD_ACTIONS.openCommit,
          'data-control': `commit:${cardKey}:${commit.sha}`,
          onClick(event: MouseEvent) {
            stop(event);
            post({
              type: 'openCommit',
              key: cardKey,
              sha: commit.objectSha ?? commit.sha,
              dir: commit.dir as string,
              beside: event.ctrlKey || event.metaKey,
            });
          },
        },
        commit.sha,
      )
    : h('span', { class: 'sha' }, commit.sha);
  return h(
    'div',
    {
      class: 'row commitrow',
      'data-commit': commit.sha,
      'data-record': commit.key,
      title: commitRowTitle(commit),
    },
    [
      sha,
      ' ',
      h('span', { class: 'name' }, commit.subject),
      ' ',
      h('span', { class: 'commitnums' }, counts),
      h('span', { class: 'sr-only commitwhen' }, commitRowSpoken(commit)),
      facts
        ? h(Fragment, {}, [' ', h('span', { class: 'commitfacts' }, h('span', { class: 'commitwords' }, facts))])
        : null,
    ],
  );
}

// One group's heading: the repository when it is not the open folder's, the branch, the place
// when the tree is named otherwise than its branch, and the merged word when the branch's work
// reached its target. The merged word's hover names the time and the hash, and hidden text says
// the same, so the hover is never the only home of the hash.
function CommitGroupHead({ group }: { group: CommitGroupView }) {
  const arrival = group.arrival;
  return h(
    'div',
    { class: 'commitgrouphead' },
    inlineText([
      group.repository.own ? null : h('span', { class: 'commitgrouprepo' }, `${group.repository.name} ·`),
      h('span', { class: 'commitgroupname' }, commitGroupName(group)),
      group.where ? h('span', { class: 'commitgroupfact' }, `· ${group.where}`) : null,
      arrival
        ? h('span', { class: 'commitgroupfact', title: arrivalTitle(arrival), 'data-arrival': group.key }, [
            ARRIVAL_WORD,
            h('span', { class: 'sr-only' }, arrivalSpoken(arrival)),
          ])
        : null,
    ]),
  );
}

// The groups of a record that touched more than one branch or repository, each a heading and its
// rows behind a hairline. The list walks the groups and returns one tree, so a record of many
// groups is still one draw.
export function CommitGroups({
  cardKey,
  groups,
  post,
}: {
  cardKey: string;
  groups: CommitGroupView<CommitRowView>[];
  post: RowPost;
}) {
  return h(
    'div',
    { class: 'commitgroups' },
    groups.map((group) =>
      h(
        'div',
        {
          class: 'commitgroup',
          role: 'group',
          'aria-label': commitGroupLabel(group),
          'data-group': group.key,
          key: group.key,
        },
        [
          h(CommitGroupHead, { group }),
          ...group.rows.map((commit) => h(CommitRow, { cardKey, commit, post, key: commit.key })),
        ],
      ),
    ),
  );
}

function CommitRowList({ rows, post }: { rows: Extract<DetailRows, { kind: 'commits' }>; post: RowPost }) {
  const grouping = commitGrouping(rows.commits);
  if (!grouping.single && grouping.groups.length) {
    return h(CommitGroups, { cardKey: rows.key, groups: grouping.groups, post });
  }
  return h(
    Fragment,
    {},
    (grouping.groups[0]?.rows ?? []).map((commit) =>
      h(CommitRow, {
        cardKey: rows.key,
        commit,
        post,
        key: commit.key,
      }),
    ),
  );
}

// The rows of one record. A chip popover mounts it, and the card body draws it under a section
// heading when the Card layout setting puts the record in the body.
export function DetailRowList({
  rows,
  post,
  figureDetails,
  cap,
}: {
  rows: DetailRows;
  post: RowPost;
  figureDetails?: StatDetailRenderer;
  // Honoured only when `rows.kind` is `files`. Every other row kind draws every row it holds.
  cap?: number;
}) {
  if (rows.kind === 'files') {
    return h(FilesRows, { rows, post, cap });
  }
  if (rows.kind === 'agents' || rows.kind === 'dispatched') {
    return h(
      Fragment,
      {},
      rows.agents.map((agent, index) =>
        h(AgentRow, {
          cardKey: rows.key,
          agent,
          post,
          files: rows.kind === 'dispatched' ? (agent.files ?? []) : rows.files,
          commits: rows.kind === 'dispatched' ? (agent.commits ?? []) : rows.commits,
          figureDetails,
          key: `${rows.key}:${agent.sessionId ?? agent.description}:${index}`,
        }),
      ),
    );
  }
  return h(CommitRowList, { rows, post });
}

// Draws one record into a node the popover owns. Called again with `null` rows to take the
// same node back, so the popover's next drawing starts from an empty tree.
export function renderDetailRows(
  host: HTMLElement,
  rows: DetailRows | null,
  post: RowPost,
  figureDetails?: StatDetailRenderer,
): void {
  render(rows ? h(DetailRowList, { rows, post, figureDetails }) : null, host);
}
