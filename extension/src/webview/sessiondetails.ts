import { actionable } from './dom.ts';

export interface SessionDetailsRow {
  id: string;
  label: string;
  // Full session name. Callers fall back to label when the payload omits it.
  fullLabel?: string;
  agent: string;
  resumeCommand: string | null;
}

interface Events {
  document(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  window(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

export function createSessionDetails(
  document: Document,
  events: Events,
  post: (message: { type: 'copy'; text: string }) => void,
  fallback: () => HTMLElement | null,
) {
  let openId: string | null = null;
  // Opening control. Sessions opened from the session list need not have a timeline heading.
  let openAnchor: HTMLElement | null = null;
  // Heading openers resolve their current row after redraws. Session list openers retain their original control.
  let openedFromHeading = false;
  let dialogPrint = '';
  let rows = new Map<string, SessionDetailsRow>();
  let drawn: {
    id: string;
    fullName: HTMLElement;
    agent: HTMLElement;
    sessionId: HTMLElement;
    command: HTMLElement;
    copyId: HTMLButtonElement;
    copyCommand: HTMLButtonElement;
  } | null = null;
  const dialog = document.createElement('section');
  dialog.id = 'sessiondetails';
  dialog.className = 'pop sessiondetails';
  dialog.setAttribute('role', 'dialog');
  dialog.hidden = true;
  document.body.appendChild(dialog);

  function sessionRow(id: string): HTMLElement | null {
    for (const node of document.querySelectorAll<HTMLElement>('.sessionrow')) {
      if (node.dataset.session === id) {
        return node;
      }
    }
    return null;
  }

  function close(returnFocus: boolean): void {
    const id = openId;
    const opener = openAnchor;
    const fromHeading = openedFromHeading;
    openId = null;
    openAnchor = null;
    openedFromHeading = false;
    dialog.hidden = true;
    if (!returnFocus) {
      return;
    }
    // Return to the current heading only for a heading opener. Otherwise use the original control or fallback.
    const target =
      (fromHeading ? sessionRow(id || '')?.querySelector<HTMLElement>('.session') : null) ||
      (opener?.isConnected ? opener : null) ||
      fallback();
    target?.focus();
  }

  function place(): void {
    if (dialog.hidden || !openId) {
      return;
    }
    // Align heading-opened dialogs with the current row. Otherwise use the original control.
    const anchor = (openedFromHeading ? sessionRow(openId) : null) || (openAnchor?.isConnected ? openAnchor : null);
    if (!anchor) {
      close(true);
      return;
    }
    const box = anchor.getBoundingClientRect();
    const edge = 6;
    const narrow = window.innerWidth <= 360;
    dialog.style.left = `${edge}px`;
    dialog.style.right = narrow ? `${edge}px` : '';
    const pop = dialog.getBoundingClientRect();
    const below = box.bottom + edge;
    const above = box.top - pop.height - edge;
    const top = below + pop.height <= window.innerHeight || above < edge ? below : above;
    dialog.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - pop.height - edge))}px`;
    if (!narrow) {
      dialog.style.left = `${Math.max(edge, Math.min(box.right - pop.width, window.innerWidth - pop.width - edge))}px`;
    }
  }

  function copy(label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sessiondetailscopy';
    button.textContent = label;
    actionable(button, label, null, () => post({ type: 'copy', text: button.dataset.copyValue || '' }));
    return button;
  }

  function printOf(row: SessionDetailsRow): string {
    return JSON.stringify([row.id, row.fullLabel, row.label, row.agent, row.resumeCommand]);
  }

  function setText(node: HTMLElement, value: string): void {
    if (node.textContent !== value) {
      node.textContent = value;
    }
  }

  function write(row: SessionDetailsRow): void {
    if (!drawn) {
      return;
    }
    setText(drawn.fullName, row.fullLabel || row.label);
    setText(drawn.agent, row.agent);
    setText(drawn.sessionId, row.id);
    setText(drawn.command, row.resumeCommand || '');
    drawn.copyId.dataset.copyValue = row.id;
    drawn.copyCommand.dataset.copyValue = row.resumeCommand || '';
    dialogPrint = printOf(row);
  }

  function draw(row: SessionDetailsRow): void {
    dialog.replaceChildren();
    const heading = document.createElement('h2');
    heading.id = 'sessiondetails-title';
    heading.tabIndex = -1;
    heading.textContent = 'Session details';
    dialog.setAttribute('aria-labelledby', heading.id);
    const header = document.createElement('div');
    header.className = 'sessiondetailshead';
    header.appendChild(heading);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'sessiondetailsclose';
    closeButton.textContent = 'Close';
    actionable(closeButton, 'Close session details', null, () => close(true));
    header.appendChild(closeButton);
    const list = document.createElement('dl');
    dialog.replaceChildren(header, list);
    const add = (name: string, copyLabel: string | null = null) => {
      const term = document.createElement('dt');
      term.textContent = name;
      const definition = document.createElement('dd');
      const text = document.createElement('span');
      text.className = 'sessiondetailsvalue';
      const copyButton = copyLabel ? copy(copyLabel) : null;
      definition.appendChild(text);
      if (copyButton) {
        definition.appendChild(copyButton);
      }
      list.append(term, definition);
      return { text, copyButton };
    };
    const fullName = add('Full name');
    const agent = add('Agent');
    const sessionId = add('Session ID', 'Copy ID');
    const command = add('Resume command', 'Copy command');
    drawn = {
      id: row.id,
      fullName: fullName.text,
      agent: agent.text,
      sessionId: sessionId.text,
      command: command.text,
      copyId: sessionId.copyButton!,
      copyCommand: command.copyButton!,
    };
    write(row);
  }

  function open(row: SessionDetailsRow, anchor: HTMLElement | null): void {
    if (openId === row.id && !dialog.hidden) {
      close(true);
      return;
    }
    openId = row.id;
    openAnchor = anchor;
    openedFromHeading = !!anchor?.closest('.sessionrow');
    if (!drawn || drawn.id !== row.id) {
      draw(row);
    } else if (dialogPrint !== printOf(row)) {
      write(row);
    }
    dialog.hidden = false;
    place();
    dialog.querySelector<HTMLElement>('h2')?.focus();
  }

  function sync(next: readonly SessionDetailsRow[]): void {
    rows = new Map(next.map((row) => [row.id, row]));
    if (!openId) {
      return;
    }
    const row = rows.get(openId);
    if (!row) {
      close(true);
      return;
    }
    const print = printOf(row);
    if (!dialog.hidden && print !== dialogPrint) {
      write(row);
    }
    if (!dialog.hidden) {
      place();
    }
  }

  function titleHover(node: HTMLElement | null, short: string, full: string): void {
    if (!node) {
      return;
    }
    if (node.dataset.fullTitle === full && node.dataset.shortTitle === short) {
      return;
    }
    node.dataset.fullTitle = full;
    node.dataset.shortTitle = short;
    node.removeAttribute('title');
    if (node.dataset.titleHoverBound) {
      return;
    }
    node.dataset.titleHoverBound = 'true';
    node.addEventListener('pointerenter', () => {
      const fullTitle = node.dataset.fullTitle || '';
      const shortTitle = node.dataset.shortTitle || '';
      if (fullTitle !== shortTitle || node.scrollWidth > node.clientWidth) {
        node.title = fullTitle;
      } else {
        node.removeAttribute('title');
      }
    });
  }

  events.document(
    'keydown',
    (event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape' || dialog.hidden) {
        return;
      }
      key.preventDefault();
      key.stopImmediatePropagation();
      close(true);
    },
    true,
  );
  events.document('pointerdown', (event) => {
    const target = event.target as Node | null;
    if (!dialog.hidden && target && !dialog.contains(target)) {
      close(false);
    }
  });
  events.document('focusin', (event) => {
    const target = event.target as Node | null;
    if (!dialog.hidden && target && !dialog.contains(target)) {
      close(false);
    }
  });
  events.window('scroll', () => place(), true);
  events.window('resize', () => place());
  return {
    sync,
    titleHover,
    place,
    openById(id: string, anchor: HTMLElement | null = null): void {
      const row = rows.get(id);
      if (row) {
        open(row, anchor);
      }
    },
  };
}
