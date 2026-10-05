import assert from 'node:assert';
import * as fs from 'node:fs';
import { tempDir } from '../temproot.ts';
import * as path from 'node:path';
import { test, vi } from 'vitest';
import { productionFiles } from '../../scripts/check-webview-globals.ts';
import { actionable, found, markdownOf, panelDom, placeFloat } from './dom.ts';
import { renderRichMarkdown } from '../richtext.ts';

test('DOM Markdown copy retains native disclosures with lists, fences, and tables', () => {
  class CopyElement {
    readonly nodeType = 1;
    constructor(
      public nodeName: string,
      public childNodes: (CopyElement | { nodeType: number; textContent: string })[],
    ) {}
    get textContent(): string {
      return this.childNodes.map((child) => child.textContent).join('');
    }
  }
  const text = (value: string) => ({ nodeType: 3, textContent: value });
  const block = (name: string, ...children: (CopyElement | ReturnType<typeof text>)[]) =>
    new CopyElement(name, children);
  vi.stubGlobal('Element', CopyElement);
  try {
    const root = block(
      'DIV',
      block(
        'DETAILS',
        block('SUMMARY', text('Measurements')),
        block(
          'UL',
          block('LI', text('One')),
          block('LI', text('Two')),
          block('LI', block('PRE', block('CODE', text('</details>\n')))),
        ),
        block('PRE', block('CODE', text('exact code\n'))),
        block(
          'TABLE',
          block('THEAD', block('TR', block('TH', text('Agent')), block('TH', text('Result')))),
          block('TBODY', block('TR', block('TD', text('Sol')), block('TD', text('Passed')))),
        ),
      ),
    );
    const copy = markdownOf(root as unknown as Node);
    assert.match(copy, /^<details>\n<summary>Measurements<\/summary>/);
    assert.match(copy, /- One\n- Two/);
    assert.match(copy, /```\nexact code\n```/);
    assert.match(copy, /\| Agent \| Result \|\n\| --- \| --- \|\n\| Sol \| Passed \|/);
    assert.match(copy, /<\/details>$/);
    const rendered = renderRichMarkdown(copy);
    assert.match(rendered, /<details>/);
    assert.match(rendered, /<table>/);
    assert.match(rendered, /<li><pre><code>&lt;\/details&gt;\n<\/code><\/pre>/);
    assert.match(rendered, /<table>[\s\S]*<\/details>\s*$/);
  } finally {
    vi.unstubAllGlobals();
  }
});

function listLookupCount(root: string): number {
  const sources = productionFiles(root)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  return (sources.match(/getElementById\(['"]list['"]\)/g) ?? []).length;
}

test('the list has one explicit authoritative lookup', () => {
  const list = {} as HTMLElement;
  const asked: string[] = [];
  const document = {
    getElementById(id: string) {
      asked.push(id);
      return id === 'list' ? list : null;
    },
  } as unknown as Document;
  assert.equal(panelDom(document).list, list);
  assert.deepEqual(asked, ['list']);

  assert.equal(listLookupCount(__dirname), 1);
});

test('the authoritative list lookup scan includes nested browser modules', (t) => {
  const root = tempDir('arc-list-owner-');
  t.onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'owner.ts'), "document.getElementById('list');\n");
  assert.equal(listLookupCount(root), 1);
});

test('control wiring keeps names as data and uses native activation', () => {
  let pressed = 0;
  const listeners = new Map<string, (event: MouseEvent) => void>();
  const node = {
    dataset: {} as DOMStringMap,
    setAttribute(name: string, value: string) {
      (this as Record<string, unknown>)[name] = value;
    },
    addEventListener(name: string, listener: (event: MouseEvent) => void) {
      listeners.set(name, listener);
    },
  } as unknown as HTMLElement;
  actionable(node, 'Open one', 'one', () => {
    pressed += 1;
  });
  assert.equal(
    node.getAttribute ? node.getAttribute('aria-label') : (node as unknown as Record<string, unknown>)['aria-label'],
    'Open one',
  );
  assert.equal(node.dataset.control, 'one');
  listeners.get('click')?.({} as MouseEvent);
  assert.equal(pressed, 1);

  const control = { dataset: { control: 'a[quoted]"name' } } as unknown as HTMLElement;
  const root = { querySelectorAll: () => [control] } as unknown as ParentNode;
  assert.equal(found(root, 'a[quoted]"name'), control);
});

test('a float keeps its place when its anchor is off the page, and opens under a live one', () => {
  const view = { innerWidth: 800, innerHeight: 600 };
  const float = {
    style: { left: '40px', top: '50px' } as CSSStyleDeclaration,
    getBoundingClientRect: () => ({ width: 200, height: 100 }),
  } as unknown as HTMLElement;
  const anchor = (connected: boolean, hidden: boolean) =>
    ({
      isConnected: connected,
      closest: (selector: string) => (selector === '[hidden]' && hidden ? {} : null),
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    }) as unknown as HTMLElement;
  for (const gone of [anchor(false, false), anchor(true, true)]) {
    placeFloat(view, float, gone, { align: 'end', gap: 4 });
    assert.deepEqual([float.style.left, float.style.top], ['40px', '50px']);
  }
  const live = {
    isConnected: true,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 500, right: 520, width: 20, height: 20 }),
  } as unknown as HTMLElement;
  placeFloat(view, float, live, { align: 'end', gap: 4 });
  assert.deepEqual([float.style.left, float.style.top], ['320px', '124px']);
});

// A float 200 wide and 100 tall, placed under an anchor in a view 800 wide. The view's height
// decides whether it fits below.
function floatAt(
  height: number,
  anchor: { top: number; left: number },
  placement: Parameters<typeof placeFloat>[3],
): [string, string] {
  const float = {
    style: {} as CSSStyleDeclaration,
    getBoundingClientRect: () => ({ width: 200, height: 100 }),
  } as unknown as HTMLElement;
  const rect = {
    top: anchor.top,
    bottom: anchor.top + 20,
    left: anchor.left,
    right: anchor.left + 20,
    width: 20,
    height: 20,
  };
  placeFloat({ innerWidth: 800, innerHeight: height }, float, rect, placement);
  return [float.style.left, float.style.top];
}

test('a float lines up with its anchor but never starts left of the box around it', () => {
  const row = { top: 95, bottom: 125, left: 120, right: 700, width: 580, height: 30 };
  assert.deepEqual(floatAt(600, { top: 100, left: 230 }, { align: 'end', gap: 4, around: row }), ['120px', '129px']);
  assert.deepEqual(floatAt(600, { top: 100, left: 500 }, { align: 'end', gap: 4, around: row }), ['320px', '129px']);
  assert.deepEqual(floatAt(600, { top: 100, left: 790 }, { gap: 4 }), ['594px', '124px']);
});

test('a float that does not fit below flips, stays, or slides as its placement says', () => {
  // Room above: every flip opens there, and a slide keeps its bottom on the view's margin.
  assert.deepEqual(floatAt(600, { top: 520, left: 10 }, { gap: 4 })[1], '416px');
  assert.deepEqual(floatAt(600, { top: 520, left: 10 }, { gap: 4, overflow: 'flip-or-stay' })[1], '416px');
  assert.deepEqual(floatAt(600, { top: 520, left: 10 }, { gap: 4, overflow: 'slide' })[1], '494px');
  // No room above either.
  assert.deepEqual(floatAt(140, { top: 20, left: 10 }, { gap: 4 })[1], '6px');
  assert.deepEqual(floatAt(140, { top: 20, left: 10 }, { gap: 4, overflow: 'flip-or-stay' })[1], '44px');
  assert.deepEqual(floatAt(140, { top: 20, left: 10 }, { gap: 4, overflow: 'slide' })[1], '34px');
  // Taller than the view: a slide stops at the top margin.
  assert.deepEqual(floatAt(90, { top: 20, left: 10 }, { gap: 4, overflow: 'slide' })[1], '6px');
});
