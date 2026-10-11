// File, subagent and commit rows for turn-card sections and chip popovers.
// Row controls post the message that opens their file, commit or session.

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

// A card's record rows, in the shape carried by a chip's detail list.
export type DetailRows =
  // An unset `turnDiff` offers the whole turn's diff. Subagent file lists set it to false.
  | { kind: 'files'; key: string; files: FileRowView[]; turnDiff?: boolean; sourceSessionId?: string }
  // Explicit child collections take priority. Ordinary native rows fall back to the parent card.
  | { kind: 'agents'; key: string; agents: AgentRowView[]; files: FileRowView[]; commits: CommitRowView[] }
  | { kind: 'dispatched'; key: string; agents: AgentRowView[]; files: FileRowView[]; commits: CommitRowView[] }
  | { kind: 'commits'; key: string; commits: CommitRowView[] };

export type RowPost = ((message: PanelToHost) => void) & { readOnly?: boolean };

const noContextClass = () => '';

// Subagent commit figures list written commits without the parent turn's landings.
export function writtenCommitRows(card: CardView): CommitRowView[] {
  return (card.commits ?? []).filter((row) => row.kind === 'commit');
}

// Read the requested record from the card. Popovers and card sections share these rows.
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
    post.readOnly ? 'span' : 'button',
    {
      class: post.readOnly ? 'row' : 'row click',
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
        if (post.readOnly) return;
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
      // Unknown counts draw no count cell. Recorded zeros draw no cell unless the file is new.
      // Literal spaces preserve separators in copied text and without CSS.
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

// A button styled as a link opens the whole turn's diff below the file rows.
export function TurnDiffAction({ cardKey, post }: { cardKey: string; post: RowPost }) {
  if (post.readOnly) return null;
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

// Card-body file lists reveal bounded batches to avoid nested scrolling and unbounded draws.
// File popovers already scroll and use no cap.
export const FILES_SECTION_CAP = 20;

// Return the visible rows and the collapsed list's hidden count.
// Expanded lists keep `capped` and `hiddenCount` so the collapse button remains available.
// Uncapped and fully visible lists retain the original array.
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

// The toggle names its next action. Collapsed labels distinguish one file from several.
export function filesMoreLabel(hiddenCount: number, expanded: boolean): string {
  if (expanded) {
    return CARD_ACTIONS.filesLess;
  }
  return `Show ${hiddenCount} ${hiddenCount === 1 ? CARD_ACTIONS.filesMoreOne : CARD_ACTIONS.filesMoreMany}`;
}

// Add the total hidden count to the next-batch label. Omit it when no files remain hidden.
export function filesMoreAccessibleName(label: string, hiddenTotal: number): string {
  if (hiddenTotal <= 0) {
    return label;
  }
  return `${label}, ${hiddenTotal} ${hiddenTotal === 1 ? 'file' : 'files'} hidden`;
}

// Build the Files section toggle. The hiddenCount parameter names the next batch while the list is partly revealed.
// The labelExpanded flag selects the collapse label. The ariaExpanded flag reports any batch beyond the first.
// The hiddenTotal parameter names all remaining hidden files. The controlsId parameter identifies the row container.
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

// Identify the file-row container with the shared card-part ID format.
function filesRowsId(cardKey: string): string {
  return cardPartId(cardKey, 'files-rows');
}

// Reveal one turn's file rows in batches of `cap`.
// Keep the toggle mounted throughout expansion so keyboard focus stays on it.
// Preact retains the component's expansion state across card redraws.
function FilesRows({ rows, post, cap }: { rows: Extract<DetailRows, { kind: 'files' }>; post: RowPost; cap?: number }) {
  const [revealedBatches, setRevealedBatches] = useState(1);
  // Keep fully revealed lists expanded when live updates add files.
  // Collapse and shrinking to the cap clear this state.
  const [stickyExpanded, setStickyExpanded] = useState(false);
  const total = rows.files.length;
  const revealedCount = cap ? cap * revealedBatches : total;
  const atOrUnderCap = !cap || total <= cap;
  const naturallyFullyRevealed = !cap || revealedCount >= total;
  const fullyRevealed = stickyExpanded || naturallyFullyRevealed;
  // Report expansion as soon as a second batch appears, even when later batches remain hidden.
  const ariaExpanded = revealedBatches > 1;
  // A list at the cap must not re-enable the sticky state that the reset effect clears.
  useEffect(() => {
    if (!atOrUnderCap && naturallyFullyRevealed && !stickyExpanded) {
      setStickyExpanded(true);
    }
  }, [atOrUnderCap, naturallyFullyRevealed, stickyExpanded]);
  // Reset short lists so later growth starts with the first batch.
  useEffect(() => {
    if (atOrUnderCap) {
      setRevealedBatches(1);
      setStickyExpanded(false);
    }
  }, [atOrUnderCap]);
  // Fully revealed lists retain the original cap and collapse toggle.
  // Partly revealed lists use the current batch boundary as their cap.
  const { shown, capped, hiddenCount } = fullyRevealed
    ? cappedFileRows(rows.files, cap, true)
    : cappedFileRows(rows.files, revealedCount, false);
  // The visible label promises one batch. `hiddenCount` supplies the accessible name's total.
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
  // Uncapped popovers keep file rows as direct children.
  // Capped card sections wrap them in the container named by the toggle's `aria-controls`.
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

// Cache one commit grouping per rows array.
// Card sections, popovers and clock updates share the grouping for the card's own array.
// A subagent's filtered array gets its own grouping.
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

// Add branch facts and merge-arrival text to a single-group heading.
// Browser formatting keeps the arrival time current across midnight.
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

// Identify the subagent whose record is open.
// Matching descriptions alone do not establish identity when session IDs differ or are absent.
interface RecordScope {
  name: string;
  session: string | null;
}

// Omit the maker line only when its description and session match the record's subagent.
// The enclosing record already names that subagent.
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
    // Match abbreviated and full hashes by prefix in either direction.
    const shas = figure.shas;
    const held = (sha: string) => shas.some((held) => held.startsWith(sha) || sha.startsWith(held));
    // Filter rows when the popover opens, avoiding a commit-list walk for every subagent on each draw.
    // Group the filtered rows separately so a single-branch heading names the child's branch.
    return () => {
      const own = commits.filter((row) => held(row.sha)).map((row) => ownRow(row, scopedTo));
      const single = singleCommitGroup(commitGrouping(own));
      const heading = single && record.heading ? { ...record.heading, ...commitHeadingFact(single) } : record.heading;
      return { ...record, heading, rows: { kind: 'commits', key: cardKey, commits: own } };
    };
  }
  if (figure.metric === 'files' && figure.paths) {
    const paths = new Set(figure.paths);
    const identities = figure.fileIdentities ? new Set(figure.fileIdentities) : null;
    return () => ({
      ...record,
      rows: {
        kind: 'files',
        key: cardKey,
        files: files.filter((row) => (identities && row.identity ? identities.has(row.identity) : paths.has(row.path))),
        turnDiff: false,
        ...(sourceSessionId ? { sourceSessionId } : {}),
      },
    });
  }
  return () => record;
}

// A subagent row opens its session from the name and its records from individual figures.
// Running rows tick their duration. Open rows show their state without a live duration.
// Finished rows name their state for screen readers. `data-state` separates child and card status.
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
  // The first available figure takes the figures' Tab stop. Arrow keys move between the remaining figures.
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
  // A linked name carries the run detail. Without that link, the row itself takes its focus stop.
  // Individual figure hints describe only their own totals.
  const rowStop = !link && !!agent.hintDetail;
  // Dismiss the current figure's record before moving focus to the next figure.
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
                  'data-hint': `${agent.description}: ${agent.kind === 'dispatch' ? CARD_ACTIONS.openDispatchedSession : CARD_ACTIONS.openSubagentSession}`,
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
            : h('span', { class: 'name', title: agent.description }, [
                agent.description,
                h('span', { class: 'sr-only' }, ','),
              ]),
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

// Format a commit row's tooltip from its detail and full local time.
// `commitRowSpoken` supplies the corresponding accessible time. Clock updates reuse both functions.
// Landing tooltips name the source branch when recorded and state its absence otherwise.
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

// Draw the hash, subject and counts on one line. Group headings carry the branch and worktree.
// The tooltip contains the full subject and time. Hidden text supplies the accessible time.
// A maker line opens the subagent session when identified. A landing's second line says `merged in`.
// Unknown counts leave the count cell empty. Recorded zeros draw both zero counts.
export function CommitRow({ cardKey, commit, post }: { cardKey: string; commit: CommitRowView; post: RowPost }) {
  const landing = commit.kind === 'landing';
  const moved = hasDiff(commit.added ?? undefined, commit.removed ?? undefined);
  // Draw recorded zeros explicitly so they differ from unknown counts. Other pairs omit zero halves.
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

// Name the branch and worktree, with a repository prefix for a different repository.
// Merge-arrival tooltips and hidden text include the time and hash.
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

// Draw each commit group's heading and rows in one returned tree.
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

// Draw record rows for a chip popover or a card-body section.
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
          files: agent.files ?? (rows.kind === 'dispatched' ? [] : rows.files),
          commits: agent.commits ?? (rows.kind === 'dispatched' ? [] : rows.commits),
          figureDetails,
          key: `${rows.key}:${agent.sessionId ?? agent.description}:${index}`,
        }),
      ),
    );
  }
  return h(CommitRowList, { rows, post });
}

// Mount record rows in the popover's container. Null rows unmount the tree.
export function renderDetailRows(
  host: HTMLElement,
  rows: DetailRows | null,
  post: RowPost,
  figureDetails?: StatDetailRenderer,
  readOnly = false,
): void {
  post = Object.assign(post, { readOnly });
  render(rows ? h(DetailRowList, { rows, post, figureDetails }) : null, host);
}
