import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert';
import { createHints, HINT_BODY_DELAY_MAC_MS, HINT_BODY_DELAY_MS, HINT_DELAY_MS } from './hints.ts';

// Implements the element members the hint service uses. Disconnected anchors skip placement, leaving only hint contents under test.
class FakeElement {
  className = '';
  id = '';
  hidden = false;
  isConnected = false;
  dataset: Record<string, string> = {};
  children: (FakeElement | { textContent: string })[] = [];
  style = { getPropertyValue: (): string => '' };
  private text = '';
  private attributes = new Map<string, string>();
  readonly classList = {
    add: (name: string): void => {
      if (!this.classList.contains(name)) {
        this.className = `${this.className} ${name}`.trim();
      }
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(' ')
        .filter((part) => part && part !== name)
        .join(' ');
    },
    toggle: (name: string, on: boolean): void => {
      if (on) {
        this.classList.add(name);
      } else {
        this.classList.remove(name);
      }
    },
    contains: (name: string): boolean => this.className.split(' ').includes(name),
  };

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }

  append(...nodes: (FakeElement | { textContent: string })[]): void {
    this.children.push(...nodes);
  }

  appendChild(node: FakeElement | { textContent: string }): void {
    this.children.push(node);
  }

  replaceChildren(...nodes: (FakeElement | { textContent: string })[]): void {
    this.text = '';
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height'> {
    return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
  }

  contains(node: unknown): boolean {
    return node === this;
  }

  closest(): FakeElement | null {
    return this.dataset.hint === undefined ? null : this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function service() {
  vi.stubGlobal('Element', FakeElement);
  let observed: { callback: MutationCallback; filter: string[] } | null = null;
  const listeners = new Map<string, (event: unknown) => void>();
  const body = new FakeElement();
  const document = {
    body,
    createElement: () => new FakeElement(),
    createTextNode: (textContent: string) => ({ textContent }),
  } as unknown as Document;
  const hints = createHints({
    document,
    window: { innerWidth: 1000, innerHeight: 800 },
    platform: 'Win32',
    events: {
      document(type, listener) {
        listeners.set(type, listener as (event: unknown) => void);
      },
      window() {},
    },
    observe(_target, callback, init) {
      observed = { callback, filter: init.attributeFilter ?? [] };
    },
    setDelay: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearDelay() {},
  });
  const popover = hints.element as unknown as FakeElement;
  const [title, detail, hintBody] = popover.children as FakeElement[];
  const focus = (anchor: FakeElement): void => listeners.get('focusin')!({ target: anchor });
  // Report an attribute change on a node the way the browser does: only for an attribute the service observes.
  const changed = (node: FakeElement, attribute: string): void => {
    if (observed?.filter.includes(attribute)) {
      const record = { type: 'attributes', target: node, attributeName: attribute } as unknown as MutationRecord;
      observed.callback([record], {} as MutationObserver);
    }
  };
  return { hints, popover, title, detail, hintBody, focus, changed };
}

function anchor(dataset: Record<string, string>): FakeElement {
  const node = new FakeElement();
  node.dataset = dataset;
  return node;
}

// A body anchor replaces title and detail. A subsequent plain anchor restores both without retaining the body.
test('the hint box shows a drawn body for an anchor that names one, and the plain box after it', () => {
  const { hints, popover, title, detail, hintBody, focus } = service();
  const drawn = new FakeElement();
  drawn.textContent = 'Fix login (retry)';
  hints.body('railcard', () => drawn as unknown as HTMLElement);
  focus(anchor({ hint: 'Fix login (retry)', hintDetail: 'Codex, $1.20', hintBody: 'railcard' }));
  assert.equal(popover.hidden, false);
  assert.ok(popover.classList.contains('hintcard'), popover.className);
  assert.equal(hintBody.hidden, false);
  assert.deepEqual(hintBody.children, [drawn]);
  assert.equal(title.hidden, true, 'the title showed beside the body');
  assert.equal(detail.hidden, true, 'the detail showed beside the body');

  focus(anchor({ hint: 'Filters', hintDetail: 'All sessions' }));
  assert.equal(popover.classList.contains('hintcard'), false, popover.className);
  assert.equal(hintBody.hidden, true);
  assert.equal(hintBody.children.length, 0, 'the plain box kept the previous body');
  assert.equal(title.hidden, false);
  assert.equal(title.textContent, 'Filters');
  assert.equal(detail.hidden, false);
});

// Redraw updates only an open body of the requested kind.
test('a redraw rebuilds an open body of its kind and nothing else', () => {
  const { hints, focus } = service();
  let draws = 0;
  hints.body('railcard', () => {
    draws += 1;
    return new FakeElement() as unknown as HTMLElement;
  });
  focus(anchor({ hint: 'Fix login', hintBody: 'railcard' }));
  assert.equal(draws, 1);
  hints.redraw('railcard');
  assert.equal(draws, 2, 'a redraw left the open card as it was');
  hints.redraw('other');
  assert.equal(draws, 2);
  focus(anchor({ hint: 'Filters' }));
  hints.redraw('railcard');
  assert.equal(draws, 2, 'a redraw drew a card over a plain hint');
});

// A missing subject closes the hint and removes its anchor's accessible description.
test('a body drawn for a subject that is gone closes the box', () => {
  const { hints, popover, focus } = service();
  let gone = false;
  hints.body('railcard', () => (gone ? null : (new FakeElement() as unknown as HTMLElement)));
  const card = anchor({ hint: 'Fix login', hintDescription: 'Takes a prompt now', hintBody: 'railcard' });
  focus(card);
  assert.equal(card.getAttribute('aria-describedby'), 'hintdescription');
  gone = true;
  hints.redraw('railcard');
  assert.equal(popover.hidden, true, 'the box stayed open over a session the rail no longer holds');
  assert.equal(card.getAttribute('aria-describedby'), null);
});

// Pointer and focus events use a fake clock. Cleared delays never run. Advance runs due delays in order.
function pointerService(platform: string) {
  class FakePointerEvent {
    target: unknown = null;
    relatedTarget: unknown = null;
  }
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.stubGlobal('Node', FakeElement);
  vi.stubGlobal('Element', FakeElement);
  const listeners = new Map<string, (event: unknown) => void>();
  let now = 0;
  const timers: { run: () => void; ms: number; due: number; cleared: boolean }[] = [];
  const hints = createHints({
    document: {
      body: new FakeElement(),
      createElement: () => new FakeElement(),
      createTextNode: (textContent: string) => ({ textContent }),
    } as unknown as Document,
    window: { innerWidth: 1000, innerHeight: 800 },
    platform,
    events: {
      document(type, listener) {
        listeners.set(type, listener as (event: unknown) => void);
      },
      window() {},
    },
    observe() {},
    setDelay: (run, ms) => {
      timers.push({ run, ms, due: now + ms, cleared: false });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearDelay(handle) {
      timers[(handle as unknown as number) - 1].cleared = true;
    },
  });
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((timer) => !timer.cleared && timer.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) {
        break;
      }
      now = next.due;
      next.cleared = true;
      next.run();
    }
    now = until;
  };
  const popover = hints.element as unknown as FakeElement;
  const hintBody = popover.children[2] as FakeElement;
  const drawn: string[] = [];
  hints.body('railcard', (card) => {
    drawn.push(card.dataset.hint ?? '');
    const node = new FakeElement();
    node.textContent = card.dataset.hint ?? '';
    return node as unknown as HTMLElement;
  });
  const pointer = (type: string, target: FakeElement, relatedTarget: FakeElement | null) =>
    listeners.get(type)!(Object.assign(new FakePointerEvent(), { target, relatedTarget }));
  const focus = (target: FakeElement): void => listeners.get('focusin')!({ target });
  const row = (dataset: Record<string, string>): FakeElement => {
    const node = anchor(dataset);
    node.isConnected = true;
    return node;
  };
  return { hints, popover, hintBody, timers, advance, pointer, focus, row, drawn };
}

// Each compact row waits its own hover delay. Passing rows closes the previous card without opening intermediate cards.
test('a pointer sweeping down compact rows from an open card opens no card until it rests', () => {
  const { popover, hintBody, advance, pointer, row, drawn } = pointerService('Win32');
  const rows = Array.from({ length: 40 }, (_, index) => row({ hint: `Session ${index}`, hintBody: 'railcard' }));
  pointer('pointerover', rows[0], null);
  assert.equal(popover.hidden, true, 'a rail card opened the moment the pointer arrived');
  advance(HINT_BODY_DELAY_MS);
  assert.equal(hintBody.textContent, 'Session 0');

  for (let index = 1; index < rows.length; index += 1) {
    pointer('pointerout', rows[index - 1], rows[index]);
    pointer('pointerover', rows[index], rows[index - 1]);
    assert.equal(popover.hidden, true, `the card stood open over the rows at Session ${index}`);
    advance(20);
  }
  advance(HINT_BODY_DELAY_MS);
  assert.equal(popover.hidden, false);
  assert.equal(hintBody.textContent, 'Session 39');
  assert.deepEqual(drawn, ['Session 0', 'Session 39'], 'the sweep drew a card for a row it only crossed');
});

// Pointer entry closes another row's keyboard-opened card during the hover delay.
test('a pointer entering a compact row closes the card keyboard focus opened on another row', () => {
  const { popover, hintBody, advance, pointer, focus, row } = pointerService('Win32');
  focus(row({ hint: 'Fix login', hintBody: 'railcard' }));
  assert.equal(hintBody.textContent, 'Fix login');
  pointer('pointerover', row({ hint: 'Ship the rail', hintBody: 'railcard' }), null);
  assert.equal(popover.hidden, true, "the focused row's card stood open over the row the pointer entered");
  advance(HINT_BODY_DELAY_MS - 1);
  assert.equal(popover.hidden, true, 'the card opened before the pointer rested for the full delay');
  advance(1);
  assert.equal(popover.hidden, false);
  assert.equal(hintBody.textContent, 'Ship the rail');
});

// Session list updates during a hover delay preserve the pending pointer target and keep the previous card closed.
test('a rail update during the wait still opens the card the pointer rests on', () => {
  const { hints, popover, hintBody, advance, pointer, focus, row, drawn } = pointerService('MacIntel');
  focus(row({ hint: 'Fix login', hintBody: 'railcard' }));
  pointer('pointerover', row({ hint: 'Ship the rail', hintBody: 'railcard' }), null);
  advance(HINT_BODY_DELAY_MAC_MS / 2);
  hints.redraw('railcard');
  assert.equal(popover.hidden, true, "the rail update brought back the focused row's card");
  advance(HINT_BODY_DELAY_MAC_MS / 2);
  assert.equal(popover.hidden, false, 'the rail update cancelled the card the pointer rests on');
  assert.equal(hintBody.textContent, 'Ship the rail');
  assert.deepEqual(drawn, ['Fix login', 'Ship the rail']);
});

// Hover cards wait 500 ms on Windows and Linux, or 1500 ms on macOS. Plain hints use the shorter shared delay.
test('a rail card waits the editor hover delay of each platform, and a plain hint waits less', () => {
  for (const [platform, cardDelay] of [
    ['Win32', 500],
    ['Linux x86_64', 500],
    ['MacIntel', 1500],
  ] as const) {
    const { timers, pointer, row } = pointerService(platform);
    pointer('pointerover', row({ hint: 'Fix login', hintBody: 'railcard' }), null);
    assert.equal(timers.at(-1)?.ms, cardDelay, `a rail card on ${platform} waited ${timers.at(-1)?.ms} ms`);
    pointer('pointerover', row({ hint: 'Filters' }), null);
    assert.equal(timers.at(-1)?.ms, HINT_DELAY_MS, `a plain hint on ${platform} waited ${timers.at(-1)?.ms} ms`);
    assert.ok(cardDelay > HINT_DELAY_MS);
  }
});

// Draw a title's parts in order: text as itself, a wbr element as a bar, and a key span in brackets.
const titleParts = (title: FakeElement): string =>
  title.children
    .map((child) =>
      child instanceof FakeElement
        ? child.className === 'hintkey'
          ? `[${child.textContent}]`
          : '|'
        : child.textContent,
    )
    .join('');

// A session name is the reader's text. It keeps its parenthesis and breaks after a path separator inside a word.
test('a name hint keeps its parenthesis and breaks a path after its separators', () => {
  const { popover, title, focus } = service();
  focus(anchor({ hint: 'C:/work/arc\\plans/x.md /review it now (urgent)', hintKind: 'name' }));
  assert.ok(popover.classList.contains('hintprose'), popover.className);
  assert.equal(titleParts(title), 'C:/|work/|arc\\|plans/|x.md /review it now (urgent)');

  focus(anchor({ hint: 'Fix the build (urgent)', hintKind: 'name' }));
  assert.equal(titleParts(title), 'Fix the build (urgent)', 'the name lost its parenthesis to a key');

  // A control hint keeps the bold title, the key split, and no path breaks.
  focus(anchor({ hint: 'Open a/b (Ctrl+O)' }));
  assert.equal(popover.classList.contains('hintprose'), false, popover.className);
  assert.equal(titleParts(title), 'Open a/b[ (Ctrl+O)]');
});

// A press that pins an anchor's own figure popover leaves no hint over it.
test('an anchor whose figure popover is pinned shows no hint', () => {
  const { popover, focus } = service();
  const pinned = anchor({ hint: 'Session name', hintKind: 'name' });
  pinned.classList.add('has-detail');
  pinned.setAttribute('aria-pressed', 'true');
  focus(pinned);
  assert.equal(popover.hidden, true);
  pinned.setAttribute('aria-pressed', 'false');
  focus(pinned);
  assert.equal(popover.hidden, false);
});

// An open hint redraws when its anchor changes kind, with no new focus or hover.
test('an open hint follows its anchor between the name and control kinds', () => {
  const { popover, title, focus, changed } = service();
  const node = anchor({ hint: 'Open a/b (Ctrl+O)' });
  focus(node);
  node.isConnected = true;
  assert.equal(titleParts(title), 'Open a/b[ (Ctrl+O)]');

  node.dataset.hintKind = 'name';
  changed(node, 'data-hint-kind');
  assert.ok(popover.classList.contains('hintprose'), 'the hint kept the control title after its anchor became a name');
  assert.equal(titleParts(title), 'Open a/|b (Ctrl+O)', 'the name kept the key split or lost its path break');

  delete node.dataset.hintKind;
  changed(node, 'data-hint-kind');
  assert.equal(
    popover.classList.contains('hintprose'),
    false,
    'the prose class stayed after the anchor became a control',
  );
  assert.equal(titleParts(title), 'Open a/b[ (Ctrl+O)]', 'the control title kept the path break or lost its key');
});
