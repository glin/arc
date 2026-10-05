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
  // Build the figure's record when its popover opens, avoiding work on every clock tick.
  record?: () => StatDetailList;
}

// Draw a static figure or an interactive figure with a record popover.
// Interactive figures use a button role and suppress the enclosing hint and native title.
// Named static figures use a group role so assistive technology reads their full names.
// Only the figure identified by stop enters the Tab order. Row arrow keys reach the others.
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
  // Interactive figures fall back to their visible label for an accessible name.
  const spoken = stat.name || (record ? stat.compactLabel : '');
  // A callback ref connects the figure without hooks. The renderer dismisses popovers when their anchors leave the page.
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

// Draw the same cost, turns, and context line in Full rows and Compact row hover cards.
// Hide the line when it has no figures.
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

// Enter and Space activate the figure once per press. Prevent Space scrolling and ignore held-key repeats.
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

// Return whether either diff half is nonzero. Callers omit empty wrappers and separators.
export function hasDiff(added: number | undefined, removed: number | undefined): boolean {
  return diffHalves(added, removed).length > 0;
}

// Add a separated diff pair only when at least one half is nonzero.
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

// Draw nonzero diff halves with a space between them. A zero pair draws nothing.
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
