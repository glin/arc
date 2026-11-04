import assert from 'node:assert';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { test } from 'vitest';
import type { UsageBar, UsageGroup } from '../view/usage.ts';
import { UsageOpenView } from './composer-controls.ts';

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  constructor(readonly tagName: string) {}
  get firstChild() {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener() {}
  removeEventListener() {}
  appendChild(child: FakeElement | FakeText) {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeElement | FakeText, before: FakeElement | FakeText | null) {
    child.parentNode?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeElement | FakeText) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  byClass(name: string): FakeElement[] {
    return [
      ...(this.attributes.get('class')?.split(' ').includes(name) ? [this] : []),
      ...this.children.flatMap((child) => (child instanceof FakeElement ? child.byClass(name) : [])),
    ];
  }
}

async function usageView(groups: UsageGroup[]): Promise<FakeElement> {
  const globals = globalThis as { document?: Document };
  const previous = globals.document;
  globals.document = {
    createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  } as unknown as Document;
  const mount = new FakeElement('main');
  const bar: UsageBar = { briefs: [], groups, age: '', read: 'Read again', name: 'Account usage' };
  try {
    await act(() => render(h(UsageOpenView, { bar, sendToHost() {} }), mount as unknown as HTMLElement));
    return mount;
  } finally {
    globals.document = previous;
  }
}

const group = (over: Partial<UsageGroup> = {}): UsageGroup => ({
  agent: 'claude',
  label: 'Claude',
  plan: '',
  age: '',
  exact: '',
  status: '',
  lines: [],
  ...over,
});

test('usage headings place plans and ages separately and expose the exact reading time', async () => {
  const root = await usageView([
    group({ plan: 'Max plan', age: '3h ago', exact: '11/2/2026, 11:32:00 AM' }),
    group({ agent: 'codex', label: 'Codex', age: '25m ago', exact: '11/2/2026, 2:07:00 PM' }),
    group({ agent: 'fresh', plan: 'Max plan' }),
    group({ agent: 'unknown' }),
  ]);
  const heads = root.byClass('sbhead');
  assert.deepEqual(
    heads.map((head) => head.textContent),
    ['Claude Max plan 3h ago', 'Codex 25m ago', 'Claude Max plan', 'Claude'],
  );
  assert.deepEqual(
    root.byClass('sbplan').map((plan) => plan.textContent),
    ['Max plan', 'Max plan'],
  );
  const ages = root.byClass('sbage');
  assert.deepEqual(
    ages.map((age) => age.textContent),
    ['3h ago', '25m ago'],
  );
  assert.equal(ages[0].attributes.get('title'), '11/2/2026, 11:32:00 AM');
  assert.equal(ages[1].attributes.get('title'), '11/2/2026, 2:07:00 PM');
  assert.equal(root.byClass('sbgroup')[0].attributes.get('aria-label'), 'Claude, 11/2/2026, 11:32:00 AM');
});

test('usage warnings retain the shared decorative sign and replace the empty-reading line', async () => {
  const status = 'Usage reading failed. Read again to retry.';
  const root = await usageView([group({ status }), group({ agent: 'codex', label: 'Codex' })]);
  const warning = root.byClass('sbstatus')[0];
  assert.ok(warning.textContent.endsWith(status));
  assert.equal(warning.byClass('statwarningsign').length, 1);
  assert.equal(warning.byClass('statwarningsign')[0].attributes.get('aria-hidden'), 'true');
  assert.equal(root.byClass('sbgroup')[0].byClass('sbnone').length, 0);
  assert.equal(root.byClass('sbgroup')[1].byClass('sbnone')[0].textContent, 'No usage reading');
});

test('usage rows retain empty reset columns and identify credit caps', async () => {
  const line = {
    key: 'claude:session:',
    label: '5h',
    percent: 0,
    fill: 0,
    level: null,
    resets: '',
    resetsExact: '',
    detail: '',
    name: '5h, 0% used',
  };
  const root = await usageView([
    group({
      lines: [
        line,
        {
          ...line,
          key: 'claude:spend',
          label: 'credits',
          resets: 'resets in 28d',
          resetsExact: 'Monday 6:00 PM',
          detail: '$1,875.19 of $2,000.00',
        },
      ],
    }),
  ]);
  const rows = root.byClass('sbline');
  assert.equal(root.byClass('sbnone').length, 0);
  assert.equal(rows[0].byClass('is-cap').length, 0);
  assert.equal(rows[1].byClass('is-cap').length, 1);
  const resets = root.byClass('sbreset');
  assert.equal(resets.length, 2);
  assert.equal(resets[0].textContent, '');
  assert.equal(resets[0].attributes.has('title'), false);
  assert.equal(resets[1].attributes.get('title'), 'Monday 6:00 PM');
  assert.equal(root.byClass('sbbar')[0].attributes.get('aria-hidden'), 'true');
  assert.equal(rows[0].attributes.get('title'), line.name);
});
