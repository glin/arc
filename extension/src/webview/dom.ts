export interface PanelDom {
  list: HTMLElement;
}

export function panelDom(document: Document): PanelDom {
  const list = document.getElementById('list');
  if (!list) {
    throw new Error('Arc: the panel page has no #list element.');
  }
  return { list };
}

// Whether a press belongs to whatever the reader is typing in. Two page-level key listeners
// ask this, so they ask it in one place. A page-level key that fired inside a field would take
// a character the reader meant to type.
export function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

// Control names are compared as data because reader-provided names can contain selector syntax.
export function found(where: ParentNode, name: string): HTMLElement | null {
  const all = where.querySelectorAll<HTMLElement>('[data-control]');
  for (const node of Array.from(all)) {
    if (node.dataset.control === name) {
      return node;
    }
  }
  return null;
}

// Every interactive panel element is a native control. This adds the accessible name, stable
// identity, and optional activation without changing its browser-native keyboard behavior.
export function actionable<T extends HTMLElement>(
  node: T,
  label: string | null,
  id: string | null,
  onActivate?: (event: MouseEvent) => void,
): T {
  if (label) {
    node.setAttribute('aria-label', label);
  }
  if (id) {
    node.dataset.control = id;
  }
  if (onActivate) {
    node.addEventListener('click', onActivate);
  }
  return node;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string = '',
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  return node;
}

let generatedId = 0;

export function nextId(prefix: string): string {
  generatedId += 1;
  return `${prefix}${generatedId}`;
}

type FloatRect = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height'>;

// How a float opens under its anchor.
export interface FloatPlacement {
  // The lowest edge the float may reach. Without it, the float stays inside the viewport margin.
  bottom?: number;
  // The space between the anchor and the float.
  gap?: number;
  // The anchor edge the float lines up with. `end` lines the float's right edge up with the
  // anchor's right edge.
  align?: 'start' | 'end';
  // A wider box that holds the anchor, such as the row the anchor sits on. The float opens
  // clear of this box and never starts left of it.
  around?: FloatRect | HTMLElement;
  // Where the float goes when it does not fit below. `flip` opens it above, at the top edge
  // when there is no room there either. `flip-or-stay` opens it above only when it fits there,
  // and otherwise keeps it below. `slide` moves it up until its bottom meets the lowest edge.
  overflow?: 'flip' | 'flip-or-stay' | 'slide';
}

// The top of a float that opens under its anchor, or goes where `overflow` says when it does
// not fit there.
function floatTop(
  around: Pick<FloatRect, 'top' | 'bottom'>,
  height: number,
  gap: number,
  bottom: number,
  overflow: FloatPlacement['overflow'] = 'flip',
  edge = 6,
): number {
  const below = around.bottom + gap;
  if (below + height <= bottom) {
    return below;
  }
  if (overflow === 'slide') {
    return Math.max(edge, bottom - height);
  }
  const above = around.top - gap - height;
  if (overflow === 'flip-or-stay' && above < edge) {
    return below;
  }
  return Math.max(edge, above);
}

// The box an anchor occupies on screen, or null for an element out of the document or inside
// a hidden region. Such an element measures as an empty box in the viewport corner.
function anchorRect(target: FloatRect | HTMLElement): FloatRect | null {
  if (!('getBoundingClientRect' in target)) {
    return target;
  }
  if (!target.isConnected || target.closest('[hidden]')) {
    return null;
  }
  return target.getBoundingClientRect();
}

// Places a fixed float beside its anchor. A float whose anchor element left the document or
// sits in a hidden region keeps its last place. An anchor passed as a box is placed as given.
// The float's own size comes from its rendered box.
export function placeFloat(
  view: Pick<Window, 'innerWidth' | 'innerHeight'>,
  host: HTMLElement,
  target: FloatRect | HTMLElement,
  bottomLimit?: number | FloatPlacement,
  topLimit?: number,
): void {
  const rect = anchorRect(target);
  if (!rect) {
    return;
  }
  if (topLimit !== undefined && typeof bottomLimit === 'number') {
    const gap = 6;
    const width = host.offsetWidth || 90;
    const availableHeight = Math.max(0, bottomLimit - topLimit);
    host.style.maxHeight = `${availableHeight}px`;
    const height = Math.min(host.offsetHeight || 26, availableHeight);
    const above = rect.top - gap - height;
    const below = rect.bottom + gap;
    const aboveFits = above >= topLimit;
    const belowFits = below + height <= bottomLimit;
    let top: number;
    if (aboveFits) {
      top = above;
    } else if (belowFits) {
      top = below;
    } else {
      const aboveRoom = rect.top - gap - topLimit;
      const belowRoom = bottomLimit - rect.bottom - gap;
      top = aboveRoom >= belowRoom ? topLimit : bottomLimit - height;
    }
    host.style.top = `${Math.max(topLimit, Math.min(top, bottomLimit - height))}px`;
    host.style.left = `${Math.max(4, Math.min(rect.left, view.innerWidth - width - 4))}px`;
    return;
  }
  if (bottomLimit !== undefined) {
    const placement = typeof bottomLimit === 'number' ? { bottom: bottomLimit } : bottomLimit;
    const edge = 6;
    const gap = placement.gap ?? 6;
    const box = host.getBoundingClientRect();
    const held = placement.around ? anchorRect(placement.around) : null;
    const around = held ?? rect;
    const room = view.innerWidth - box.width - edge;
    const start = placement.align === 'end' ? rect.right - box.width : rect.left;
    const floor = held ? Math.max(edge, Math.min(held.left, room)) : edge;
    const left = Math.max(floor, Math.min(start, room));
    const bottom = placement.bottom ?? view.innerHeight - edge;
    const top = floatTop(around, box.height, gap, bottom, placement.overflow, edge);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    return;
  }
  const width = host.offsetWidth || 90;
  const height = host.offsetHeight || 26;
  const above = rect.top > height + 4;
  const top = above ? rect.top - height - 4 : rect.bottom + 6;
  host.style.top = `${Math.max(4, Math.min(top, view.innerHeight - height - 4))}px`;
  host.style.left = `${Math.max(4, Math.min(rect.left, view.innerWidth - width - 4))}px`;
}

const NEWLINE = String.fromCharCode(10);
const TICK = String.fromCharCode(96);
const FENCE = TICK.repeat(3);
const BLOCK_NAMES = new Set([
  'P',
  'DIV',
  'UL',
  'OL',
  'LI',
  'PRE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TABLE',
  'DETAILS',
  'SUMMARY',
]);

export function markdownOf(root: Node): string {
  const inlineOf = (node: Node): string => {
    if (node.nodeType === 3) {
      return (node.textContent ?? '').replace(/\s+/g, ' ');
    }
    if (!(node instanceof Element) || node.nodeName === 'BUTTON') {
      return '';
    }
    if (node.nodeName === 'BR') {
      return NEWLINE;
    }
    if (node.nodeName === 'CODE') {
      return `${TICK}${node.textContent ?? ''}${TICK}`;
    }
    let inner = '';
    for (const child of Array.from(node.childNodes)) {
      inner += inlineOf(child);
    }
    if (!inner) {
      return '';
    }
    if (node.nodeName === 'STRONG' || node.nodeName === 'B') {
      return `**${inner}**`;
    }
    if (node.nodeName === 'EM' || node.nodeName === 'I') {
      return `*${inner}*`;
    }
    return inner;
  };
  const rowCells = (row: Node): string[] =>
    Array.from(row.childNodes)
      .filter((cell): cell is Element => cell instanceof Element && (cell.nodeName === 'TD' || cell.nodeName === 'TH'))
      .map((cell) => inlineOf(cell).trim());
  const rowLine = (row: Node): string => `| ${rowCells(row).join(' | ')} |`;
  const flowOf = (container: Node, joiner: string): string => {
    const parts: string[] = [];
    let run = '';
    let items: string[] = [];
    const flushItems = () => {
      if (items.length) {
        parts.push(items.join(NEWLINE));
        items = [];
      }
    };
    const flushRun = () => {
      const text = run.trim();
      run = '';
      if (!text) {
        return;
      }
      flushItems();
      parts.push(text);
    };
    const itemLines = (item: Node, head: string): string[] => {
      const flow = flowOf(item, NEWLINE);
      if (!flow) {
        return [];
      }
      return flow.split(NEWLINE).map((line, index) => (index === 0 ? `${head}${line}` : `  ${line}`));
    };
    const blockOf = (node: Element): string => {
      const name = node.nodeName;
      if (name === 'SUMMARY') return `<summary>${inlineOf(node).trim()}</summary>`;
      if (name === 'DETAILS') return `<details>${NEWLINE}${flowOf(node, `${NEWLINE}${NEWLINE}`)}${NEWLINE}</details>`;
      if (name === 'PRE') {
        const code = (node.textContent ?? '').replace(/\s+$/, '');
        return code ? `${FENCE}${NEWLINE}${code}${NEWLINE}${FENCE}` : '';
      }
      if (name === 'UL' || name === 'OL') {
        const rows: string[] = [];
        let number = 0;
        for (const item of Array.from(node.childNodes)) {
          if (!(item instanceof Element) || item.nodeName !== 'LI') {
            continue;
          }
          const lines = itemLines(item, name === 'OL' ? `${number + 1}. ` : '- ');
          if (!lines.length) {
            continue;
          }
          number += 1;
          rows.push(...lines);
        }
        return rows.join(NEWLINE);
      }
      if (name === 'BLOCKQUOTE') {
        const inner = flowOf(node, NEWLINE);
        return inner
          ? inner
              .split(NEWLINE)
              .map((line) => (line ? `> ${line}` : '>'))
              .join(NEWLINE)
          : '';
      }
      if (name === 'TABLE') {
        const rows: Element[] = [];
        const gather = (box: Node): void => {
          for (const child of Array.from(box.childNodes)) {
            if (!(child instanceof Element)) {
              continue;
            }
            if (child.nodeName === 'TR') {
              rows.push(child);
            } else {
              gather(child);
            }
          }
        };
        gather(node);
        const lines = rows.map(rowLine);
        if (rows.length > 1) {
          lines.splice(
            1,
            0,
            `| ${rowCells(rows[0])
              .map(() => '---')
              .join(' | ')} |`,
          );
        }
        return lines.join(NEWLINE);
      }
      if (/^H[1-6]$/.test(name)) {
        const text = inlineOf(node).trim();
        return text ? `${'#'.repeat(Number(name[1]))} ${text}` : '';
      }
      if (name === 'P') {
        return inlineOf(node).trim();
      }
      return flowOf(node, `${NEWLINE}${NEWLINE}`);
    };
    for (const child of Array.from(container.childNodes)) {
      if (child instanceof Element && child.nodeName === 'LI') {
        flushRun();
        const lines = itemLines(child, '- ');
        if (lines.length) {
          items.push(lines.join(NEWLINE));
        }
      } else if (child instanceof Element && child.nodeName === 'TR') {
        flushRun();
        items.push(rowLine(child));
      } else if (child instanceof Element && BLOCK_NAMES.has(child.nodeName)) {
        flushRun();
        flushItems();
        const block = blockOf(child);
        if (block) {
          parts.push(block);
        }
      } else {
        run += inlineOf(child);
      }
    }
    flushRun();
    flushItems();
    return parts.join(joiner);
  };
  return flowOf(root, `${NEWLINE}${NEWLINE}`);
}
