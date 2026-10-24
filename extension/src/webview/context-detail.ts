import { inlineText } from './inline-text.ts';
import { contextShare, type ContextDetail, type ContextMessage } from '../domain/context-detail.ts';
import { formatTokens } from '../view/tokens.ts';
import { wholePercent } from '../view/tokens.ts';

export interface ContextDetailView {
  used: number;
  capacity: number;
  detail: ContextDetail | null;
  loading: boolean;
  compact: boolean;
  run(): void;
}

export function drawContextDetail(document: Document, host: HTMLElement, value: ContextDetailView): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const native = value.detail && ['available', 'mismatch'].includes(value.detail.status) ? value.detail : null;
  const used = native?.used ?? value.used;
  const capacity = native?.capacity ?? value.capacity;
  const exact = `${wholePercent(used / capacity)}% of the context window used, ${used.toLocaleString('en-US')} of ${capacity.toLocaleString('en-US')} tokens`;
  const head = el('div', 'chippophead');
  const figure = el(
    'span',
    'chippopvalue',
    `${wholePercent(used / capacity)}% of ${formatTokens(capacity)} (${formatTokens(used)})`,
  );
  figure.title = exact;
  figure.append(
    el('span', 'sr-only', `, ${used.toLocaleString('en-US')} of ${capacity.toLocaleString('en-US')} tokens`),
  );
  head.append(...inlineText([el('span', 'chippoplabel', 'Context'), figure]));
  host.append(head);
  const notes = el('ul', 'context-notes');
  let reserveNotes = notes;
  if (native?.status === 'available' && used > 0) {
    const breakdown = el('div', 'context-breakdown');
    const columns = el('div', 'context-columns');
    columns.append(...inlineText([el('span', '', 'Used by'), el('span', '', '% of used')]));
    breakdown.append(columns);
    const list = el('ul', 'context-categories');
    list.setAttribute('role', 'list');
    const drawRow = (item: HTMLElement, row: { name: string; tokens: number }) => {
      const share = el('span', 'context-share', contextShare(row.tokens, used));
      share.title = `${row.tokens.toLocaleString('en-US')} tokens`;
      share.append(el('span', 'sr-only', ` of used context, ${row.tokens.toLocaleString('en-US')} tokens`));
      const label = el('span', 'context-category-label', row.name);
      if (row.name === 'Unattributed') label.title = 'Context that Claude does not assign to another message category.';
      item.append(...inlineText([label, share]));
      const meter = el('div', 'sbbar context-meter');
      meter.setAttribute('aria-hidden', 'true');
      const fill = el('i', '');
      fill.style.width = `${(row.tokens / used) * 100}%`;
      meter.append(fill);
      item.append(meter);
    };
    for (const row of [...native.categories].sort((a, b) => b.tokens - a.tokens)) {
      const item = el('li', '');
      if (row.key === 'Messages' && native.messageBreakdown) {
        item.className = 'context-disclosed';
        const disclosure = el('details', 'context-messages');
        const summary = el('summary', '');
        const parent = el('span', 'context-category-row');
        drawRow(parent, row);
        summary.append(parent);
        const children = el('div', 'context-message-children');
        children.append(el('p', 'context-included', 'Included in Messages. Shares of all used context.'));
        const childList = el('ul', 'context-categories');
        childList.setAttribute('role', 'list');
        for (const child of native.messageBreakdown
          .filter((row) => row.tokens !== 0)
          .sort((a: ContextMessage, b: ContextMessage) => b.tokens - a.tokens)) {
          const childItem = el('li', '');
          drawRow(childItem, child);
          childList.append(childItem);
        }
        children.append(childList);
        disclosure.append(summary, children);
        item.append(disclosure);
      } else drawRow(item, row);
      list.append(item);
    }
    breakdown.append(list);
    host.append(breakdown);
    notes.classList.add('context-caveats');
    const measurement = el('details', 'context-measurement');
    measurement.append(el('summary', '', 'Measurement details'), notes);
    host.append(measurement);
    reserveNotes = el('ul', 'context-notes context-caveats');
    notes.append(
      el(
        'li',
        'context-note',
        native.measurement === 'local-estimate'
          ? 'Local estimate. Arc divides text size in bytes by four to approximate tokens.'
          : 'Estimated breakdown.',
      ),
      el('li', 'context-note', 'Percentages of used context are rounded separately.'),
    );
    if (native.measurement === 'local-estimate')
      notes.append(
        el(
          'li',
          'context-note',
          "Context left after subtracting Arc's category estimates, including uncounted tool results, hidden inputs, and estimation differences.",
        ),
      );
    if (native.measurement === 'local-estimate')
      notes.append(el('li', 'context-note', 'Only tool results saved after context truncation are counted.'));
  } else {
    notes.append(
      el(
        'li',
        'context-note',
        value.loading
          ? 'Loading context details...'
          : native?.status === 'mismatch'
            ? 'Estimated breakdown. Categories do not cover the reported total.'
            : native?.used === 0
              ? 'Estimated breakdown. No context used.'
              : value.detail?.reason === 'pending-tools'
                ? 'Category breakdown unavailable while tool calls are pending.'
                : value.detail?.reason === 'awaiting-measurement'
                  ? 'Category breakdown unavailable until Codex measures the new input.'
                  : value.detail?.reason === 'claude-no-live-session'
                    ? 'Send a message to see the context breakdown.'
                    : 'Category breakdown unavailable.',
      ),
    );
    host.append(notes);
    if (native?.status === 'mismatch' && native.categories.length) {
      const table = el('table', 'context-table');
      const headings = el('tr', '');
      for (const name of ['Used by', '% of used']) {
        const th = el('th', '', name);
        th.scope = 'col';
        headings.append(th);
      }
      const thead = el('thead', '');
      thead.append(headings);
      table.append(thead);
      const body = el('tbody', '');
      for (const row of [...native.categories].sort((a, b) => b.tokens - a.tokens)) {
        const tr = el('tr', '');
        const name = el('th', '', row.name);
        name.scope = 'row';
        const share = el('td', '', contextShare(row.tokens, used));
        share.title = `${row.tokens.toLocaleString('en-US')} tokens`;
        share.append(
          el('span', 'sr-only', `${used ? ' of used context' : ''}, ${row.tokens.toLocaleString('en-US')} tokens`),
        );
        tr.append(name, share);
        body.append(tr);
      }
      table.append(body);
      host.append(table);
      if (native.reserve !== null) {
        reserveNotes = el('ul', 'context-notes context-caveats');
        host.append(reserveNotes);
      }
    }
  }
  if (native?.status === 'mismatch' && native.measurement === 'local-estimate') {
    notes.append(
      el(
        'li',
        'context-note',
        'Local text estimates exceed the latest recorded context. Arc divides text size in bytes by four to approximate tokens.',
      ),
    );
  }
  if (native?.measurement === 'local-estimate' && native.basis === 'retained-estimate') {
    notes.append(el('li', 'context-note', 'Codex estimates the context total after compaction.'));
  }
  if (native?.reserve !== null && native?.reserve !== undefined) {
    const note = el('li', 'context-note');
    const count = el('span', '', `${formatTokens(native.reserve)} tokens reserved for compaction`);
    count.title = `${native.reserve.toLocaleString('en-US')} tokens set aside for compaction`;
    count.append(el('span', 'sr-only', ` (${native.reserve.toLocaleString('en-US')} tokens)`));
    note.append(count);
    reserveNotes.append(note);
    if (!reserveNotes.parentNode) host.append(reserveNotes);
  }
  if (!notes.parentNode) host.append(notes);
  const bound = el('div', 'chippopbound chippopitemhead context-bound');
  const remaining = native ? native.remaining : Math.max(0, capacity - used);
  const remainder = el('span', 'context-remaining');
  const amount = el('span', 'chippopvalue', remaining === null ? 'Unavailable' : formatTokens(remaining));
  if (remaining !== null) {
    amount.title = `${remaining.toLocaleString('en-US')} tokens`;
    amount.append(el('span', 'sr-only', ` (${remaining.toLocaleString('en-US')} tokens)`));
  }
  remainder.append(...inlineText([el('span', 'context-remaining-label', 'Remaining'), amount]));
  if (value.compact) {
    const button = el('button', 'cpick', 'Compact');
    button.type = 'button';
    button.setAttribute('aria-label', 'Compact this session');
    button.dataset.hint = 'Compact this session to free context';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      value.run();
    });
    bound.append(button);
  }
  bound.append(remainder);
  host.append(bound);
}
