// The card a compact rail row opens on hover, drawn into the shared hint box.
//
// The row cuts its agent word, its figures and its labels, and a long name ends in an
// ellipsis, so the card says all of them in full. The figures are the comfortable row's own
// figure line, drawn by the same component, and they open no popover because the hint box
// takes no pointer. The card is built when the hover opens, from the card and the figures the
// rail last drew, and never held inside a row: the rail draws up to a thousand rows, and one
// card is on screen at a time.

import { h, render } from 'preact';
import { contextClass } from '../view/card-presentation.ts';
import type { RailHoverLines, RailHoverPart } from '../view/rail.ts';
import { element } from './dom.ts';
import { RailStats, type StaticStatChip } from './stat-chip.ts';

function metaPart(document: Document, part: RailHoverPart): HTMLElement {
  if (part.kind === 'state') {
    const node = element(document, 'span', part.className ?? '');
    if (part.runningSince !== undefined) {
      // The panel clock rewrites the duration span's whole text as the minutes pass. The span
      // holds `for` and the duration, and is empty in the first minute, so the word `running`
      // sits outside it.
      const lead = part.lead ?? '';
      const clocked = part.duration ? `${lead}${part.duration}` : '';
      node.append(document.createTextNode(part.text.slice(0, part.text.length - clocked.length)));
      const duration = element(document, 'span', '', clocked);
      duration.dataset.runningSince = String(part.runningSince);
      if (lead) {
        duration.dataset.runningLead = lead;
      }
      node.append(duration);
      return node;
    }
    node.textContent = part.text;
    return node;
  }
  const node = element(document, 'span', part.kind === 'unsent' ? 'railunsent' : '', part.text);
  if (part.at !== undefined) {
    node.dataset.at = String(part.at);
  }
  return node;
}

export function railHoverCard(
  document: Document,
  lines: RailHoverLines,
  stats: readonly StaticStatChip[],
): HTMLElement {
  const root = element(document, 'div');
  root.append(element(document, 'div', 'hintname', lines.name));
  const meta = element(document, 'div', 'hintmeta');
  lines.meta.forEach((part, index) => {
    if (index) {
      meta.append(document.createTextNode(' · '));
    }
    meta.append(metaPart(document, part));
  });
  root.append(meta);
  if (lines.note) {
    root.append(element(document, 'div', 'hintnote', lines.note));
  }
  if (stats.length) {
    // The context figure takes the hint box's own foreground over its level wash, which
    // `panel.css` scopes to the figure line inside the card.
    const figures = element(document, 'div');
    render(h(RailStats, { stats, contextClass }), figures);
    root.append(figures);
  }
  if (lines.labels.shown.length || lines.labels.more) {
    const labels = element(document, 'div', 'hintlabels');
    lines.labels.shown.forEach((label, index) => {
      if (index) {
        labels.append(document.createTextNode(' '));
      }
      labels.append(element(document, 'span', 'raillabel', label));
    });
    if (lines.labels.more) {
      const more = element(document, 'span', 'raillabel raillabelmore', lines.labels.more);
      if (lines.labels.shown.length) {
        labels.append(document.createTextNode(' '));
      }
      labels.append(more);
    }
    root.append(labels);
  }
  return root;
}
