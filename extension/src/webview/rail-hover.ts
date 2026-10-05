// Compact session list rows open one hover card in the shared hint box.
// It shows the full name, agent, figures, and labels from the last drawn row.
// RailStats supplies the same figures as Full rows. The hint box accepts no pointer actions.
// Build only the open hover card rather than storing one inside every row.

import { h, render } from 'preact';
import { contextClass } from '../view/card-presentation.ts';
import type { RailHoverLines, RailHoverPart } from '../view/rail.ts';
import { element } from './dom.ts';
import { RailStats, type StaticStatChip } from './stat-chip.ts';

function metaPart(document: Document, part: RailHoverPart): HTMLElement {
  if (part.kind === 'state') {
    const node = element(document, 'span', part.className ?? '');
    if (part.runningSince !== undefined) {
      // The clock replaces the duration span's text. Keep the state word outside it.
      // The span contains the lead and duration, and stays empty during the first minute.
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
    // panel.css gives context figures the hint box foreground over their level background.
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
