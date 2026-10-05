import { h, type ComponentChild, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { contextClass } from '../view/card-presentation.ts';
import { diffHalves } from '../view/stat-detail.ts';
import type { StatDetailList, StatDetailRenderer } from './stat-detail.ts';
import { STAT_WARNING_SIGN } from './stat-detail.ts';
import { inlineText } from './inline-text.ts';

export interface CardChip {
  kind: string;
  label: string;
  name?: string;
  metric?: string;
  detail?: string;
  detailList?: StatDetailList;
  level?: string;
  focusable?: boolean;
  added?: number;
  removed?: number;
  running?: number;
  warnings?: readonly unknown[];
}

export interface StaticStatChip {
  metric: string;
  compactLabel: string;
  name?: string;
  detail?: string;
  level?: string | null;
  added?: number;
  removed?: number;
  warnings?: readonly unknown[];
  // The record behind this figure, drawn in a popover of its own. Built when the popover asks
  // for it rather than on every repaint, because a record that holds rows is a list the card
  // already carries and filtering it on each clock tick buys nothing.
  record?: () => StatDetailList;
}

// One figure, drawn as text the reader can question or as text they cannot. A figure given a
// record and a renderer to draw it in marks itself, takes the keyboard, and opens that record
// on hover, on focus and on a press. It draws no native `title` as well: two hovers on one
// element fight, and only one of them reaches a keyboard. Its empty `data-hint` keeps the hint
// box of whatever holds the figure off the record, because one pointer opens one box.
//
// Every figure carries a role. A name on an element with no role is dropped, because ARIA reads
// no name off a generic element. A figure holding a record is a press that opens and shuts it,
// so it takes the button role and says whether it is pressed, whatever name it was handed. A
// figure with nothing behind it is a run of text, and `group` names the label and
// the pair it wraps as one run, so a reader hears `3 files, 18 lines added, 4 removed` rather
// than the compact form on the face.
//
// `stop` is the row's one keyboard stop. A row hands the arrow keys the crossing from figure to
// figure, so every other figure holding a record stays out of the tab walk.
export function StaticStatChip({
  stat,
  contextClass,
  statDetails,
  stop,
}: {
  stat: StaticStatChip;
  contextClass(level: string): string;
  statDetails?: StatDetailRenderer;
  stop?: boolean;
}) {
  const tone = stat.level ? contextClass(stat.level) : '';
  const record = !!(stat.record && statDetails);
  // A figure that opens a record is a press, so it says so and says what it is whatever name
  // it was handed. Where it speaks no name of its own it takes the words on its own face,
  // because a press with no role and no name reaches a reader as an unnamed something.
  const spoken = stat.name || (record ? stat.compactLabel : '');
  // The record is tied to the element through a callback ref rather than a hook, so the figure
  // stays a plain function a text reading can call outside a render. A ref called with nothing
  // is an element leaving the page, and the renderer's own watch on the body takes the popover
  // off with it, so there is nothing to undo here.
  const connect = (element: HTMLElement | null) => {
    if (element) {
      statDetails!.connect(element, stat.detail ?? null, stat.record, true);
    }
  };
  return h(
    'span',
    {
      ...(record ? { ref: connect, onKeyDown: pressFigure } : {}),
      class: `railstatchip${tone ? ` ${tone}` : ''}${record ? ' has-detail' : ''}`,
      'data-metric': stat.metric,
      ...(record ? { role: 'button' } : stat.name ? { role: 'group' } : {}),
      ...(spoken ? { 'aria-label': spoken } : {}),
      ...(record ? { 'data-hint': '', tabIndex: stop ? 0 : -1 } : stat.detail ? { title: stat.detail } : {}),
    },
    [stat.warnings?.length ? h(WarningSign, {}) : null, ...labelledDiff(stat.compactLabel, stat.added, stat.removed)],
  );
}

// A rail card's figure line: the cost, the turns and the context, in the order the rail
// draws them. A comfortable rail card draws it under its meta line, and the card a compact row
// opens on hover draws the same line, so the two cannot drift apart. A line with no figure is
// drawn hidden.
export function RailStats({
  stats,
  contextClass,
}: {
  stats: readonly StaticStatChip[];
  contextClass(level: string): string;
}): ComponentChildren {
  return h(
    'div',
    { class: 'railstats', hidden: !stats.length },
    inlineText(stats.map((stat) => h(StaticStatChip, { stat, contextClass, key: stat.metric }))),
  );
}

// A span that takes the button role answers the keys a button answers. The click it raises is
// the one the record's renderer listens for, so a key pins the record exactly as a pointer does
// and focus stays on the figure. Space is kept from scrolling the popover or the page, and a
// held key presses once rather than pinning and unpinning on every repeat.
function pressFigure(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  event.preventDefault();
  if (!event.repeat) {
    (event.currentTarget as HTMLElement).click();
  }
}

function WarningSign() {
  return h('span', { class: 'statwarningsign', 'aria-hidden': 'true' }, STAT_WARNING_SIGN);
}

// Whether a record moved any line at all. A recorded zero is absent everywhere a diff pair is
// drawn, so the caller that would wrap the pair drops its wrapper and its separator with it.
export function hasDiff(added: number | undefined, removed: number | undefined): boolean {
  return diffHalves(added, removed).length > 0;
}

// A figure's label and the pair that follows it, for the static figure and the pressable one
// alike. A record that moved no line draws its label alone, and the separator that would have
// led to the pair is never written, so nothing trails the label.
export function labelledDiff(
  label: string | null | undefined,
  added: number | undefined,
  removed: number | undefined,
): ComponentChild[] {
  return inlineText([
    label || null,
    hasDiff(added, removed) ? h(DiffPair, { added: added as number, removed: removed as number }) : null,
  ]);
}

// The added and the removed halves of one record, drawn by the rule `diffHalves` holds: a file
// that only lost lines reads `−3` rather than `+0 −3`, and the space between the halves belongs to
// the pair that has both. A record that moved nothing draws nothing, which is why
// every caller asks `hasDiff` before it writes a label separator in front of this.
export function DiffPair({ added, removed }: { added: number; removed: number }) {
  const halves = diffHalves(added, removed);
  if (!halves.length) {
    return null;
  }
  return h(
    'span',
    {},
    halves.flatMap((half, index) => [index ? ' ' : null, h('span', { class: half.tone }, half.text)]),
  );
}

export function StatChip({ chip, statDetails }: { chip: CardChip; statDetails: StatDetailRenderer }) {
  const node = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!node.current || !chip.detail) {
      return undefined;
    }
    return statDetails.mount(node.current);
  }, [!!chip.detail]);
  useLayoutEffect(() => {
    if (node.current && chip.detail) {
      statDetails.update(node.current, chip.detail, chip.detailList);
    }
  }, [chip.detail, chip.detailList]);
  const chipClass = chip.level ? contextClass(chip.level) : chip.kind === 'warn' ? 'warn' : '';
  const interactive = !!chip.detail;
  const className = `${chipClass ? `${chipClass} ` : ''}statchip${interactive ? ' has-detail statdetail' : ''}`;
  const common = {
    class: className,
    ref: node,
    'data-metric': chip.metric,
    'aria-label': chip.focusable || chip.warnings?.length ? chip.name || chip.label : undefined,
  };
  if (chip.kind === 'diff') {
    return h(interactive ? 'button' : 'span', common, [
      h('span', { 'aria-hidden': 'true' }, labelledDiff(chip.label, chip.added, chip.removed)),
      h('span', { class: 'saidonly' }, chip.name || chip.label),
    ]);
  }
  if (chip.running) {
    // Drawn as `3 subagents 1 running`, with the count in the busy tone, and said as a phrase.
    return h(interactive ? 'button' : 'span', common, [
      h(
        'span',
        { 'aria-hidden': 'true' },
        inlineText([chip.label, h('span', { class: 'statbusy' }, `${chip.running} running`)]),
      ),
      h('span', { class: 'saidonly' }, `${chip.label}, ${chip.running} still running`),
    ]);
  }
  return h(interactive ? 'button' : 'span', common, [chip.warnings?.length ? h(WarningSign, {}) : null, chip.label]);
}
