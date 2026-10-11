import assert from 'node:assert';
import { Fragment, h, render } from 'preact';
import { act } from 'preact/test-utils';
import { test } from 'vitest';
import { CARD_LAYOUTS, cardBodyColumns, PROMPT_POSITIONS } from '../view/timeline-layout.ts';
import { CARD_GLYPHS, groupCommitRows } from '../view/card-presentation.ts';
import { CARD_ACTIONS } from '../view/card-words.ts';
import { recordSectionLabel, recordSections } from './card.ts';
import {
  AgentRow,
  agentFigureRecord,
  cappedFileRows,
  CommitGroups,
  CommitRow,
  commitRowTitle,
  DetailRowList,
  detailRowsFor,
  FileRow,
  filesMoreAccessibleName,
  filesMoreButton,
  filesMoreLabel,
  FILES_SECTION_CAP,
  renderDetailRows,
  type AgentRowView,
  type CommitRowView,
  type DetailRows,
  type FileRowView,
} from './card-rows.ts';
import type { CardView } from './payload-contracts.ts';
import { DiffPair, labelledDiff, StaticStatChip } from './stat-chip.ts';
import { walkOutOf } from './stat-detail.ts';
import type { StatDetailList, StatDetailRenderer } from './stat-detail.ts';
import { commitRecordCards, LONGEST_MAKER, type CommitRecordCase } from '../turnfixtures.ts';
import { RepositoryCommits } from '../gitcommits.ts';
import { recordCommits } from '../transcript.ts';
import { turn } from '../turnfixtures.ts';
import { commitCard, dispatchedAgentCard } from '../turncard.ts';

// Click events used by the file's minimal DOM implementation.
interface FakeClickEvent {
  type: string;
  stopPropagation(): void;
  preventDefault(): void;
  ctrlKey: boolean;
  metaKey: boolean;
}

class FakeNode {
  parentNode: FakeElement | null = null;
  constructor(public readonly nodeType: number) {}
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.children;
    if (!siblings) {
      return null;
    }
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3);
  }
}

class FakeElement extends FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  // Preact detects this property and registers lowercase `click` listeners.
  readonly onclick: null = null;
  private readonly listeners = new Map<string, Set<(event: FakeClickEvent) => void>>();

  constructor(
    public readonly tagName: string,
    private readonly doc: FakeDocument,
  ) {
    super(1);
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: FakeClickEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: FakeClickEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    const at = ref ? this.children.indexOf(ref) : -1;
    if (ref && at >= 0) {
      this.children.splice(at, 0, child);
    } else {
      this.children.push(child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.children.indexOf(child);
    if (at >= 0) {
      this.children.splice(at, 1);
    }
    child.parentNode = null;
    // Removing a focused node or its ancestor clears focus, including when Preact removes a wrapper.
    if (child instanceof FakeElement && child.containsFocused(this.doc.activeElement)) {
      this.doc.activeElement = null;
    }
    return child;
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  // Call registered click listeners with this element as their receiver.
  press(): void {
    const event: FakeClickEvent = {
      type: 'click',
      stopPropagation() {},
      preventDefault() {},
      ctrlKey: false,
      metaKey: false,
    };
    for (const listener of this.listeners.get('click') ?? []) {
      listener.call(this as unknown as EventTarget, event);
    }
  }

  find(dataControl: string): FakeElement | null {
    if (this.attributes.get('data-control') === dataControl) {
      return this;
    }
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.find(dataControl);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  findById(id: string): FakeElement | null {
    if (this.attributes.get('id') === id) {
      return this;
    }
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.findById(id);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  countButtons(): number {
    let count = this.tagName === 'button' ? 1 : 0;
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        count += child.countButtons();
      }
    }
    return count;
  }

  // Check whether this subtree contains the focused node.
  containsFocused(node: FakeElement | null): boolean {
    if (!node) {
      return false;
    }
    if (node === (this as unknown as FakeElement)) {
      return true;
    }
    return this.children.some((child) => child instanceof FakeElement && child.containsFocused(node));
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createElementNS(_namespace: string, tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createTextNode(data: string): FakeText {
    return new FakeText(data);
  }
}

// Set the global document for Preact during `run`, then restore its previous value.
async function withFakeDocument<T>(run: (doc: FakeDocument) => T | Promise<T>): Promise<T> {
  const doc = new FakeDocument();
  const globals = globalThis as { document?: Document };
  const previous = globals.document;
  globals.document = doc as unknown as Document;
  try {
    return await run(doc);
  } finally {
    globals.document = previous;
  }
}

// Collect all descendant text, including visually hidden text used in accessible names.
function fakeText(node: FakeNode): string {
  if (node instanceof FakeText) {
    return node.data;
  }
  if (node instanceof FakeElement) {
    return node.children.map(fakeText).join('');
  }
  return '';
}

// The first mounted fake element under `node`, including `node` itself, that carries `cls`
// among its space-separated classes.
function findByClass(node: FakeNode, cls: string): FakeElement | null {
  if (!(node instanceof FakeElement)) {
    return null;
  }
  if ((node.attributes.get('class') ?? '').split(' ').includes(cls)) {
    return node;
  }
  for (const child of node.children) {
    const found = findByClass(child, cls);
    if (found) {
      return found;
    }
  }
  return null;
}

function fileRowFixture(index: number): FileRowView {
  return {
    name: `f${index}.ts`,
    label: `f${index}.ts`,
    icon: { label: 'f' },
    path: `src/f${index}.ts`,
    shownPath: `src/f${index}.ts`,
    added: 0,
    removed: 0,
    isNew: false,
  };
}

test('record headings use singular accessible labels for one file or subagent', () => {
  assert.equal(recordSectionLabel('Files', 1, true), 'Files, 1 file, Collapse Files');
  assert.equal(recordSectionLabel('Subagents', 1, false), 'Subagents, 1 subagent, Expand Subagents');
  assert.equal(recordSectionLabel('Files', 2, true), 'Files, 2 files, Collapse Files');
  assert.equal(recordSectionLabel('Subagents', 3, false), 'Subagents, 3 subagents, Expand Subagents');
});

// Dispatched is a participle and keeps the same count word for one session and several.
test('a Dispatched heading speaks `dispatched` for one session and for several', () => {
  assert.equal(recordSectionLabel('Dispatched', 1, true), 'Dispatched, 1 dispatched, Collapse Dispatched');
  assert.equal(recordSectionLabel('Dispatched', 2, false), 'Dispatched, 2 dispatched, Expand Dispatched');
});

test('the Commits heading speaks a figure that already carries its own words as it stands, and gives a bare figure the same unit its peers get', () => {
  // Figures with words retain them. Bare counts receive the title's singular or plural unit.
  assert.equal(recordSectionLabel('Commits', '12 · 3 merged', true), 'Commits, 12 · 3 merged, Collapse Commits');
  assert.equal(recordSectionLabel('Commits', '1 merged', false), 'Commits, 1 merged, Expand Commits');
  assert.equal(recordSectionLabel('Commits', '12', true), 'Commits, 12 commits, Collapse Commits');
  assert.equal(recordSectionLabel('Commits', '1', false), 'Commits, 1 commit, Expand Commits');
});

test('the Commits heading collapses like its Files and Subagents peers', () => {
  const card = {
    key: 'card-commits-collapse',
    commits: [{ kind: 'commit', key: 'commit:a1b2c3d', sha: 'a1b2c3d', subject: 'Write the change', branch: null }],
  } as CardView;
  const sections = recordSections(card, { post: () => {} } as never) as Array<{
    props: { title: string; count: unknown; section: string };
  }>;
  const commits = sections.find((section) => section.props.title === 'Commits');
  assert.ok(commits, 'no Commits section was drawn');
  assert.equal(commits?.props.section, 'commits', 'the Commits heading carries no collapse control');
  assert.equal(commits?.props.count, '1', 'the Commits heading changed its visible figure');
});

test('a press on the Commits collapse button hides its rows, and a second press reopens them', async () => {
  const card = {
    key: 'card-commits-press',
    commits: [
      {
        kind: 'commit',
        key: 'commit:a1b2c3d',
        sha: 'a1b2c3d',
        subject: 'Write the change',
        repository: null,
        branch: null,
        headKind: null,
        madeBySession: null,
        dir: 'c:/repo',
        where: null,
        detail: 'Write the change',
        added: 1,
        removed: 0,
        at: 0,
        absolute: '2:26 PM',
      },
    ],
  } as unknown as CardView;
  await withFakeDocument(async (doc) => {
    const container = doc.createElement('div');
    render(h(Fragment, {}, recordSections(card, { post: () => {} } as never)), container as unknown as Element);
    const toggle = container.find(`record:commits:${card.key}`);
    assert.ok(toggle, 'the Commits heading drew no collapse control');
    assert.equal(toggle?.tagName, 'button', 'the Commits collapse control is not a real button');
    const controlsId = toggle?.attributes.get('aria-controls');
    assert.ok(controlsId, 'the Commits toggle carried no aria-controls');
    const rowsHost = container.findById(controlsId);
    assert.ok(rowsHost, "the toggle's aria-controls named no element in the drawn tree");
    const rowShown = () => rowsHost?.attributes.get('hidden') === undefined;
    assert.equal(toggle?.attributes.get('aria-expanded'), 'true');
    assert.equal(rowShown(), true, 'the Commits rows started hidden');
    await act(() => toggle?.press());
    assert.equal(toggle?.attributes.get('aria-expanded'), 'false');
    assert.equal(rowShown(), false, 'a press on the Commits toggle did not hide its rows');
    await act(() => toggle?.press());
    assert.equal(toggle?.attributes.get('aria-expanded'), 'true');
    assert.equal(rowShown(), true, 'a second press on the Commits toggle did not reopen its rows');
  });
});

test('the Commits heading keeps its branch fact and the merged word readable outside the collapse button', async () => {
  // One branch's rows include its merge arrival. The branch fact stays beside the collapse button.
  const rows = [
    {
      kind: 'commit',
      key: 'commit:1234567',
      sha: '1234567',
      subject: 'Write it',
      repository: null,
      branch: 'topic',
      headKind: 'branch',
      madeBySession: null,
      dir: 'c:/repo',
      where: null,
      detail: 'Write it',
      added: 1,
      removed: 0,
      at: 1,
      absolute: '2:26 PM',
    },
    {
      kind: 'landing',
      key: 'landing:1',
      sha: '89abcde',
      subject: 'Merge topic',
      repository: null,
      branch: 'main',
      headKind: 'branch',
      madeBySession: null,
      dir: 'c:/repo',
      where: null,
      detail: 'Merge topic',
      added: null,
      removed: null,
      at: 2,
      absolute: '2:30 PM',
      mergedBranch: 'topic',
      landingTarget: 'main',
    },
  ] as CommitRowView[];
  const card = { key: 'card-commits-fact', commits: rows } as CardView;
  await withFakeDocument((doc) => {
    const container = doc.createElement('div');
    render(h(Fragment, {}, recordSections(card, { post: () => {} } as never)), container as unknown as Element);
    const button = container.find(`record:commits:${card.key}`);
    assert.ok(button, 'the Commits heading drew no collapse button');
    assert.equal(
      button?.attributes.get('aria-label'),
      'Commits, 1 · 1 merged, Collapse Commits',
      "the button's own accessible name should stay the short collapse label",
    );
    const fact = findByClass(container, 'commitheadfact');
    assert.ok(fact, 'the heading drew no branch fact beside the button');
    assert.equal(
      button ? findByClass(button, 'commitheadfact') : null,
      null,
      'the branch fact drew inside the collapse button, not beside it',
    );
    const hiddenWords = findByClass(fact, 'sr-only');
    assert.ok(hiddenWords, 'the merged word carried no hidden words');
    assert.equal(fakeText(hiddenWords), ' into main at 2:30 PM, as 89abcde');
    // Hidden arrival text remains in the fact beside the button's shorter accessible name.
    assert.equal(fakeText(fact), '· on topic · merged into main at 2:30 PM, as 89abcde');
  });
});

test('an open card puts agent work and commits before files', () => {
  const card = {
    key: 'card-order',
    files: [{ name: 'src/a.ts' }],
    agents: [{ description: 'Review the change' }],
    commits: [{ kind: 'commit', key: 'commit:a1b2c3d', sha: 'a1b2c3d', subject: 'Write the change', branch: null }],
  } as CardView;
  const sections = recordSections(card, { post: () => {} } as never) as Array<{ props: { title: string } }>;
  assert.deepEqual(
    sections.map((section) => section.props.title),
    ['Subagents', 'Commits', 'Files'],
  );
});

test('the Files section cap hides rows past its count and gives every row back once expanded', () => {
  const files = Array.from({ length: FILES_SECTION_CAP + 5 }, (_, index) => ({ path: `src/f${index}.ts` }));
  const collapsed = cappedFileRows(files, FILES_SECTION_CAP, false);
  assert.deepEqual(collapsed.shown, files.slice(0, FILES_SECTION_CAP));
  assert.equal(collapsed.capped, true);
  assert.equal(collapsed.hiddenCount, 5);
  // Expanded lists retain the collapsed list's cap status and hidden count.
  assert.deepEqual(cappedFileRows(files, FILES_SECTION_CAP, true), { shown: files, capped: true, hiddenCount: 5 });
  const underCap = files.slice(0, 3);
  assert.deepEqual(cappedFileRows(underCap, FILES_SECTION_CAP, false), {
    shown: underCap,
    capped: false,
    hiddenCount: 0,
  });
  assert.deepEqual(cappedFileRows(files, undefined, false), { shown: files, capped: false, hiddenCount: 0 });
  // Uncapped and short lists return the original array.
  assert.equal(cappedFileRows(files, undefined, false).shown, files);
  assert.equal(cappedFileRows(underCap, FILES_SECTION_CAP, false).shown, underCap);
});

test('the Files section cap sits exactly at the boundary: cap rows draw uncapped, cap + 1 draws one hidden', () => {
  const atCap = Array.from({ length: FILES_SECTION_CAP }, (_, index) => ({ path: `src/f${index}.ts` }));
  const atCapResult = cappedFileRows(atCap, FILES_SECTION_CAP, false);
  assert.deepEqual(atCapResult, { shown: atCap, capped: false, hiddenCount: 0 });
  const overByOne = [...atCap, { path: 'src/one-more.ts' }];
  const overResult = cappedFileRows(overByOne, FILES_SECTION_CAP, false);
  assert.deepEqual(overResult.shown, atCap);
  assert.equal(overResult.capped, true);
  assert.equal(overResult.hiddenCount, 1);
});

test('the Files section cap stays at or under the fifty-row ceiling', () => {
  assert.ok(FILES_SECTION_CAP <= 50, "the Files section cap must not exceed the owner's fifty-row bound");
});

test('the Files section button names the hidden count, in singular and plural, and swaps to fewer once expanded', () => {
  assert.equal(filesMoreLabel(1, false), 'Show 1 more file');
  assert.equal(filesMoreLabel(37, false), 'Show 37 more files');
  assert.equal(filesMoreLabel(37, true), CARD_ACTIONS.filesLess);
});

test('the Files section button vnode carries the shared expander class, a toggle label, aria-expanded, and aria-controls', () => {
  const collapsedButton = filesMoreButton('k', 5, false, false, 5, () => {}, 'rows-k') as {
    key: unknown;
    props: { class: string; children: string; [key: string]: unknown };
  };
  assert.equal(collapsedButton.props.class, 'more');
  assert.equal(collapsedButton.props['aria-expanded'], 'false');
  assert.equal(collapsedButton.props['aria-controls'], 'rows-k');
  assert.equal(collapsedButton.props.children, filesMoreLabel(5, false));
  const expandedButton = filesMoreButton('k', 5, true, true, 0, () => {}, 'rows-k') as {
    key: unknown;
    props: { class: string; children: string; [key: string]: unknown };
  };
  assert.equal(expandedButton.props['aria-expanded'], 'true');
  assert.equal(expandedButton.props.children, filesMoreLabel(5, true));
});

test('the Files section button reports aria-expanded from how much of the list is on screen, not from whether the label says fewer', () => {
  // A partly revealed list reports expansion before its label offers to collapse.
  const midBatch = filesMoreButton('k', 20, false, true, 2_460, () => {}, 'rows-k') as {
    props: { [key: string]: unknown };
  };
  assert.equal(midBatch.props['aria-expanded'], 'true');
  assert.equal(midBatch.props.children, filesMoreLabel(20, false));
  const firstBatch = filesMoreButton('k', 20, false, false, 2_480, () => {}, 'rows-k') as {
    props: { [key: string]: unknown };
  };
  assert.equal(firstBatch.props['aria-expanded'], 'false');
});

test('the Files section button carries a stable key, so it never moves when its keyed siblings do', () => {
  const button = filesMoreButton('k', 5, false, false, 5, () => {}, 'rows-k') as { key: unknown };
  assert.equal(button.key, 'more');
});

test("the Files section button's accessible name adds the count still hidden, and drops it once nothing is", () => {
  assert.equal(filesMoreAccessibleName('Show 20 more files', 2_480), 'Show 20 more files, 2480 files hidden');
  assert.equal(filesMoreAccessibleName('Show 1 more file', 1), 'Show 1 more file, 1 file hidden');
  assert.equal(filesMoreAccessibleName('Show fewer files', 0), 'Show fewer files');
  const collapsedButton = filesMoreButton('k', 20, false, false, 2_480, () => {}, 'rows-k') as {
    props: { [key: string]: unknown };
  };
  assert.equal(collapsedButton.props['aria-label'], 'Show 20 more files, 2480 files hidden');
  const expandedButton = filesMoreButton('k', 20, true, true, 0, () => {}, 'rows-k') as {
    props: { [key: string]: unknown };
  };
  assert.equal(expandedButton.props['aria-label'], undefined, 'a fully revealed list should add no hidden count');
});

test("the Files section button's aria-controls is stable for one card, unique across two, and resolves to the rows element even with an id-unsafe card key", async () => {
  await withFakeDocument(async (doc) => {
    const files = Array.from({ length: FILES_SECTION_CAP + 3 }, (_, index) => fileRowFixture(index));
    const first: DetailRows = { kind: 'files', key: 'a b:c', files, turnDiff: false };
    const second: DetailRows = { kind: 'files', key: 'card-b', files, turnDiff: false };
    const firstContainer = doc.createElement('div');
    const secondContainer = doc.createElement('div');
    render(
      h(DetailRowList, { rows: first, post: () => {}, cap: FILES_SECTION_CAP }),
      firstContainer as unknown as Element,
    );
    render(
      h(DetailRowList, { rows: second, post: () => {}, cap: FILES_SECTION_CAP }),
      secondContainer as unknown as Element,
    );
    const firstToggle = firstContainer.find(`files-more:${first.key}`);
    const secondToggle = secondContainer.find(`files-more:${second.key}`);
    assert.ok(firstToggle, 'the toggle was not drawn for the id-unsafe card key');
    assert.ok(secondToggle, 'the toggle was not drawn for the second card');
    const firstControls = firstToggle?.attributes.get('aria-controls');
    const secondControls = secondToggle?.attributes.get('aria-controls');
    assert.ok(firstControls, 'the first toggle carried no aria-controls');
    assert.ok(secondControls, 'the second toggle carried no aria-controls');
    assert.notEqual(firstControls, secondControls, 'two cards drew the same aria-controls id');
    assert.equal(firstContainer.findById(firstControls)?.countButtons(), FILES_SECTION_CAP);
    assert.equal(secondContainer.findById(secondControls)?.countButtons(), FILES_SECTION_CAP);
  });
});

test('the card body Files section passes the shared cap to its row list', () => {
  const files = Array.from({ length: FILES_SECTION_CAP + 3 }, (_, index) => ({
    path: `src/f${index}.ts`,
    name: `f${index}.ts`,
  })) as unknown as FileRowView[];
  const card = { key: 'card-cap', files } as CardView;
  const sections = recordSections(card, { post: () => {} } as never) as Array<{
    props: { title: string; children: { props: { cap?: number } } };
  }>;
  const filesSection = sections.find((section) => section.props.title === 'Files')!;
  assert.equal(filesSection.props.children.props.cap, FILES_SECTION_CAP);
});

test('the Files chip popover draws every file with no cap, proven through the same renderDetailRows the popover calls', async () => {
  const files = Array.from({ length: FILES_SECTION_CAP + 3 }, (_, index) => fileRowFixture(index));
  const rows: DetailRows = { kind: 'files', key: 'k', files, turnDiff: false };
  await withFakeDocument((doc) => {
    const host = doc.createElement('div');
    renderDetailRows(host as unknown as HTMLElement, rows, () => {});
    assert.equal(host.countButtons(), files.length, 'the popover path drew fewer files than it holds');
    assert.equal(
      host.find(`files-more:${rows.key}`),
      null,
      'the popover path drew a show-more toggle it must never cap',
    );
  });
});

test('one press on the Files show-more toggle never mounts every row of a turn with thousands of files', async () => {
  const files = Array.from({ length: 2_500 }, (_, index) => fileRowFixture(index));
  const rows: DetailRows = { kind: 'files', key: 'card-thousands', files, turnDiff: false };
  await withFakeDocument(async (doc) => {
    const container = doc.createElement('div');
    render(h(DetailRowList, { rows, post: () => {}, cap: FILES_SECTION_CAP }), container as unknown as Element);
    const toggle = container.find(`files-more:${rows.key}`);
    assert.ok(toggle, 'the toggle was not drawn for a Files section past its cap');
    await act(() => toggle?.press());
    assert.equal(
      container.countButtons(),
      FILES_SECTION_CAP * 2 + 1,
      'a single press mounted more than the next bounded batch',
    );
  });
});

test('two presses fired before Preact re-renders each still add their own batch, because the press handler updates off the count Preact holds rather than the one the render that drew it closed over', async () => {
  const total = FILES_SECTION_CAP * 3 + 5;
  const files = Array.from({ length: total }, (_, index) => fileRowFixture(index));
  const rows: DetailRows = { kind: 'files', key: 'card-double-press', files, turnDiff: false };
  await withFakeDocument(async (doc) => {
    const container = doc.createElement('div');
    render(h(DetailRowList, { rows, post: () => {}, cap: FILES_SECTION_CAP }), container as unknown as Element);
    const toggle = container.find(`files-more:${rows.key}`);
    assert.ok(toggle, 'the toggle was not drawn for a Files section past its cap');
    // Both presses use the first render's handler before Preact applies either state update.
    await act(() => {
      toggle?.press();
      toggle?.press();
    });
    assert.equal(
      container.countButtons(),
      FILES_SECTION_CAP * 3 + 1,
      'two presses in one batch did not add two batches of rows',
    );
  });
});

test('the fake DOM clears focus when a removed subtree holds the focused node, not only when the focused node is the one removed', () => {
  const doc = new FakeDocument();
  const globals = globalThis as { document?: Document };
  const previous = globals.document;
  globals.document = doc as unknown as Document;
  try {
    const parent = doc.createElement('div');
    const wrapper = doc.createElement('div');
    const inner = doc.createElement('button');
    wrapper.appendChild(inner);
    parent.appendChild(wrapper);
    inner.focus();
    assert.equal(doc.activeElement, inner, 'the fixture did not focus the nested button');
    parent.removeChild(wrapper);
    assert.equal(
      doc.activeElement,
      null,
      'removing a subtree that holds the focused node left it as the active element',
    );
  } finally {
    globals.document = previous;
  }
});

test('a press on the Files show-more toggle stays on the toggle, walks the list a batch at a time, names its aria-controls target, and keeps its label and accessible name true at every stage', async () => {
  const total = FILES_SECTION_CAP * 2 + 3;
  const files = Array.from({ length: total }, (_, index) => fileRowFixture(index));
  const rows: DetailRows = { kind: 'files', key: 'card-press', files, turnDiff: false };
  await withFakeDocument(async (doc) => {
    const container = doc.createElement('div');
    render(h(DetailRowList, { rows, post: () => {}, cap: FILES_SECTION_CAP }), container as unknown as Element);
    const toggle = container.find(`files-more:${rows.key}`);
    assert.ok(toggle, 'the toggle was not drawn for a Files section past its cap');
    const controlsId = toggle?.attributes.get('aria-controls');
    assert.ok(controlsId, 'the toggle carried no aria-controls');
    const rowsHost = container.findById(controlsId);
    assert.ok(rowsHost, "the toggle's aria-controls named no element in the drawn tree");
    assert.equal(rowsHost?.countButtons(), FILES_SECTION_CAP, 'the first batch did not stop at the cap');
    const toggleLabel = () => (toggle?.firstChild as unknown as FakeText | null)?.data;
    // The initial label names the next batch. The accessible name includes all hidden files.
    assert.equal(toggleLabel(), filesMoreLabel(FILES_SECTION_CAP, false));
    assert.equal(toggle?.attributes.get('aria-expanded'), 'false');
    assert.equal(
      toggle?.attributes.get('aria-label'),
      `Show ${FILES_SECTION_CAP} more files, ${total - FILES_SECTION_CAP} files hidden`,
    );

    toggle?.focus();
    await act(() => toggle?.press());
    // The intermediate batch reports expansion while its label still offers more files.
    assert.equal(container.find(`files-more:${rows.key}`), toggle, 'the toggle unmounted after the first press');
    assert.equal(doc.activeElement, toggle, 'focus left the toggle after the first press');
    assert.equal(rowsHost?.countButtons(), FILES_SECTION_CAP * 2, 'the second batch did not add one more cap of rows');
    assert.equal(
      toggle?.attributes.get('aria-expanded'),
      'true',
      'a batch past the first must report aria-expanded true',
    );
    const remainingAfterFirstPress = total - FILES_SECTION_CAP * 2;
    assert.equal(toggleLabel(), filesMoreLabel(remainingAfterFirstPress, false));
    assert.equal(
      toggle?.attributes.get('aria-label'),
      `Show ${remainingAfterFirstPress} more files, ${remainingAfterFirstPress} files hidden`,
    );

    await act(() => toggle?.press());
    // Revealing the final batch selects the collapse label and removes the hidden count.
    assert.equal(
      container.find(`files-more:${rows.key}`),
      toggle,
      'the toggle unmounted after the batch that fully revealed the list',
    );
    assert.equal(doc.activeElement, toggle, 'focus left the toggle after the batch that fully revealed the list');
    assert.equal(rowsHost?.countButtons(), total, 'the list never finished revealing every row');
    assert.equal(toggle?.attributes.get('aria-expanded'), 'true');
    assert.equal(toggleLabel(), CARD_ACTIONS.filesLess);
    assert.equal(toggle?.attributes.get('aria-label'), undefined, 'a fully revealed list should add no hidden count');

    await act(() => toggle?.press());
    // Collapse returns to the first batch, the label, aria-expanded, and the accessible name.
    assert.equal(container.find(`files-more:${rows.key}`), toggle, 'the toggle unmounted after it collapsed the list');
    assert.equal(doc.activeElement, toggle, 'focus left the toggle after it collapsed the list');
    assert.equal(rowsHost?.countButtons(), FILES_SECTION_CAP, 'collapsing did not return to the first batch');
    assert.equal(toggle?.attributes.get('aria-expanded'), 'false');
    assert.equal(toggleLabel(), filesMoreLabel(FILES_SECTION_CAP, false));
    assert.equal(
      toggle?.attributes.get('aria-label'),
      `Show ${FILES_SECTION_CAP} more files, ${total - FILES_SECTION_CAP} files hidden`,
    );
  });
});

test('a fully revealed Files list stays fully revealed when a redraw grows it, and a list that falls to or under the cap resets so a later regrowth starts at the first batch', async () => {
  const cap = FILES_SECTION_CAP;
  await withFakeDocument(async (doc) => {
    const container = doc.createElement('div');
    const filesOf = (count: number) => Array.from({ length: count }, (_, index) => fileRowFixture(index));
    const draw = async (count: number) => {
      const rows: DetailRows = { kind: 'files', key: 'card-live', files: filesOf(count), turnDiff: false };
      // Flush effects that preserve or reset expansion state before the next redraw.
      await act(() => render(h(DetailRowList, { rows, post: () => {}, cap }), container as unknown as Element));
    };

    // Reveal every batch of a list held just above the cap.
    await draw(cap + 3);
    let toggle = container.find('files-more:card-live');
    assert.ok(toggle, 'the toggle was not drawn for a Files section past its cap');
    await act(() => toggle?.press());
    assert.equal(toggle?.attributes.get('aria-expanded'), 'true', 'the list did not finish revealing');
    assert.equal(
      container.countButtons(),
      cap + 3 + 1,
      'the fully revealed list did not draw every row and its toggle',
    );

    // A redraw that grows the still-capped list keeps it fully revealed without another press.
    await draw(cap * 5);
    assert.equal(
      container.countButtons(),
      cap * 5 + 1,
      'a redraw that grew an already fully revealed list fell back to a partial batch',
    );
    assert.equal(container.find('files-more:card-live')?.attributes.get('aria-expanded'), 'true');

    // A redraw that shrinks the list to or under the cap clears the capped state entirely.
    await draw(cap);
    assert.equal(container.find('files-more:card-live'), null, 'a list at the cap must draw no toggle at all');
    assert.equal(container.countButtons(), cap);

    // Regrowth past the cap starts with the first batch instead of restoring a stale expansion.
    await draw(cap * 5);
    toggle = container.find('files-more:card-live');
    assert.ok(toggle, 'the toggle was not redrawn once the list grew past the cap again');
    assert.equal(toggle?.attributes.get('aria-expanded'), 'false', 'the regrown list resumed a stale expansion');
    assert.equal(
      container.countButtons(),
      cap + 1,
      'the regrown list mounted more than its first batch without a press',
    );
  });
});

test('a static figure exposes its record as a named control', () => {
  const shown = (stat: Record<string, unknown>) =>
    (
      StaticStatChip({
        stat: stat as never,
        contextClass: () => '',
        statDetails: { connect() {} } as never,
      }) as unknown as { props: Record<string, unknown> }
    ).props;
  const record = { heading: { label: '3 files' }, layout: 'files', entries: [] };
  const named = shown({ metric: 'files', compactLabel: '3 files', name: '3 files, 18 lines added, 4 removed', record });
  assert.deepEqual([named.role, named['aria-label']], ['button', '3 files, 18 lines added, 4 removed']);
  const bare = shown({ metric: 'files', compactLabel: '3 files', record });
  assert.deepEqual([bare.role, bare['aria-label']], ['button', '3 files']);
  const plain = shown({ metric: 'tokens', compactLabel: '48k tokens', name: '48k tokens' });
  assert.deepEqual([plain.role, plain['aria-label']], ['group', '48k tokens']);
});

test('a figure that holds a record answers Enter and Space as a click', () => {
  const shown = (stat: Record<string, unknown>) =>
    (
      StaticStatChip({
        stat: stat as never,
        contextClass: () => '',
        statDetails: { connect() {} } as never,
      }) as unknown as { props: Record<string, unknown> }
    ).props;
  const record = { heading: { label: '3 files' }, layout: 'files', entries: [] };
  const press = shown({ metric: 'files', compactLabel: '3 files', record }).onKeyDown as
    | ((event: unknown) => void)
    | undefined;
  assert.equal(typeof press, 'function', 'a figure that holds a record ignores the keys that press a button');
  const answer = (key: string, repeat = false) => {
    let clicks = 0;
    let prevented = false;
    press!({
      key,
      repeat,
      currentTarget: { click: () => clicks++ },
      preventDefault: () => {
        prevented = true;
      },
    });
    return [clicks, prevented];
  };
  assert.deepEqual(answer('Enter'), [1, true], 'Enter on a figure did not press it');
  assert.deepEqual(answer(' '), [1, true], 'Space on a figure did not press it, or scrolled the popover');
  assert.deepEqual(answer('Enter', true), [0, true], 'a held Enter pressed the figure again');
  assert.deepEqual(answer('ArrowRight'), [0, false], 'a key that presses no button pressed the figure');
  const plain = shown({ metric: 'tokens', compactLabel: '48k tokens', name: '48k tokens' });
  assert.equal(plain.onKeyDown, undefined, 'a figure with no record answers a press');
});

test('child figure callbacks preserve own collections, section fallback and captured membership', () => {
  for (const layout of ['agents', 'dispatched'] as const)
    for (const own of ['supplied', 'absent', 'empty'] as const)
      for (const membership of ['opaque', 'legacy', 'absent', 'empty'] as const) {
        const childFile = { path: 'src/shared.ts', identity: 'child', name: 'shared.ts', added: 7, removed: 3 };
        const otherFile = { ...childFile, identity: 'other', added: 2, removed: 1 };
        const parentFiles = [{ ...childFile, added: 13 }, otherFile] as FileRowView[];
        const childFiles = [childFile, otherFile] as FileRowView[];
        const childCommit = {
          kind: 'commit',
          sha: 'bbbbbbb1234567890',
          key: 'child-commit',
          subject: 'Child change',
        } as CommitRowView;
        const parentCommits = [
          { ...childCommit, subject: 'Hydrated child change' },
          { ...childCommit, sha: 'aaaaaaa1234567890', key: 'parent-commit' },
        ];
        const agent: AgentRowView = {
          description: 'Child task',
          sessionId: 'child',
          kind: layout === 'dispatched' ? 'dispatch' : 'subagent',
          state: 'done',
          stateWord: '',
          since: null,
          hintDetail: '',
          model: null,
          effort: null,
          ...(own === 'supplied' ? { files: childFiles, commits: [childCommit] } : {}),
          ...(own === 'empty' ? { files: [], commits: [] } : {}),
          figures: [
            {
              metric: 'files',
              compactLabel: '1 file',
              ...(membership === 'absent' ? {} : { paths: membership === 'empty' ? [] : ['src/shared.ts'] }),
              ...(membership === 'opaque' ? { fileIdentities: ['child'] } : {}),
              ...(membership === 'empty' ? { fileIdentities: [] } : {}),
              record: { heading: { label: '1 file' }, layout: 'files', entries: [] },
            },
            {
              metric: 'commits',
              compactLabel: '1 commit',
              shas: ['bbbbbbb'],
              record: { heading: { label: '1 commit' }, layout: 'commits', entries: [] },
            },
          ],
        };
        const card = {
          key: 'parent',
          files: parentFiles,
          commits: parentCommits,
          agents: layout === 'agents' ? [agent] : [],
          dispatched: layout === 'dispatched' ? [agent] : [],
        } as CardView;
        const records = new Map<string, StatDetailList>();
        const figureDetails = {
          connect(node, _detail, record) {
            assert.equal(typeof record, 'function');
            records.set(node.dataset.metric!, (record as () => StatDetailList)());
          },
        } as StatDetailRenderer;
        const tree = h(DetailRowList, { rows: detailRowsFor(card, layout)!, post: () => {}, figureDetails });
        for (const figure of findAll(tree, (node) => node.props?.role === 'button')) {
          const ref = (figure as { ref: (node: HTMLElement) => void }).ref;
          ref({ dataset: { metric: figure.props!['data-metric'] } } as unknown as HTMLElement);
        }
        const expectedFiles =
          own === 'supplied' ? childFiles : own === 'empty' || layout === 'dispatched' ? [] : parentFiles;
        const files = records.get('files')!.rows;
        if (membership === 'absent') {
          assert.equal(files, undefined);
        } else {
          assert.equal(files?.kind, 'files');
          assert.deepEqual(
            files?.kind === 'files' ? files.files : null,
            membership === 'empty'
              ? []
              : membership === 'opaque'
                ? expectedFiles.filter((file) => file.identity === 'child')
                : expectedFiles,
            `${layout}, ${own}, ${membership}`,
          );
        }
        const commits = records.get('commits')!.rows;
        assert.equal(commits?.kind, 'commits');
        assert.deepEqual(
          commits?.kind === 'commits' ? commits.commits.map((commit) => [commit.sha, commit.subject]) : null,
          own === 'supplied'
            ? [['bbbbbbb1234567890', 'Child change']]
            : own === 'empty' || layout === 'dispatched'
              ? []
              : [['bbbbbbb1234567890', 'Hydrated child change']],
          `${layout}, ${own}, ${membership}`,
        );
      }
});

test('a subagent figure record draws the card rows the child touched and no others', () => {
  const files = ['a.ts', 'b.ts', 'c.ts'].map((name) => ({ path: `src/${name}`, name })) as unknown as FileRowView[];
  const commits = ['1234567', '89abcde', 'fedcba9'].map((sha) => ({ sha, key: sha })) as unknown as CommitRowView[];
  const filesRecord = agentFigureRecord(
    {
      metric: 'files',
      compactLabel: '2 files',
      paths: ['src/a.ts', 'src/c.ts'],
      record: { heading: { label: '2 files' }, layout: 'files', entries: [] },
    },
    'k',
    files,
    commits,
  );
  assert.deepEqual(filesRecord?.().rows, { kind: 'files', key: 'k', files: [files[0], files[2]], turnDiff: false });
  const commitsRecord = agentFigureRecord(
    {
      metric: 'commits',
      compactLabel: '1 commit',
      shas: ['89abcde1234567890'],
      record: { heading: { label: '1 commit' }, layout: 'commits', entries: [] },
    },
    'k',
    files,
    commits,
  );
  assert.deepEqual(commitsRecord?.().rows, { kind: 'commits', key: 'k', commits: [commits[1]] });
  const cost = agentFigureRecord(
    { metric: 'cost', compactLabel: '$1.00', record: { heading: { label: '$1.00 spent' }, entries: [] } },
    'k',
    files,
    commits,
  );
  assert.equal(cost?.().rows, undefined);
});

test('a subagent record drops a maker line that only names the subagent it is already open under', () => {
  const mine = 'Ship rail head row follow-ups';
  const commits = [
    {
      kind: 'commit',
      sha: '1234567',
      key: '1234567',
      madeBy: mine,
      madeBySession: 's-mine',
      absolute: '2:26 PM',
      detail: 'Write it',
    },
    {
      kind: 'commit',
      sha: '89abcde',
      key: '89abcde',
      madeBy: 'A different subagent',
      madeBySession: 's-other',
      absolute: '2:28 PM',
      detail: 'Write it too',
    },
  ] as unknown as CommitRowView[];
  const recordOf = (scopedTo?: { name: string; session: string | null }) =>
    agentFigureRecord(
      {
        metric: 'commits',
        compactLabel: '2 commits',
        shas: ['1234567', '89abcde'],
        record: { heading: { label: '2 commits' }, layout: 'commits', entries: [] },
      },
      'k',
      [],
      commits,
      scopedTo,
    );
  const rows = recordOf({ name: mine, session: 's-mine' })?.().rows;
  const shown = rows?.kind === 'commits' ? rows.commits : [];
  // The child's own commit omits its maker line. Another child's commit retains it.
  assert.deepEqual(
    shown.map((row) => [row.madeBy, row.madeBySession]),
    [
      [undefined, null],
      ['A different subagent', 's-other'],
    ],
  );
  assert.equal(commitRowTitle(shown[0]), 'Write it\nCommitted 2:26 PM');
  const whole = recordOf()?.().rows;
  const wholeRows = whole?.kind === 'commits' ? whole.commits : [];
  assert.deepEqual(
    wholeRows.map((row) => row.madeBy),
    [mine, 'A different subagent'],
  );
});

test('two subagents with an identical description keep their own maker line', () => {
  // Matching descriptions with different session IDs must retain the second child's maker line.
  const shared = 'Review the diff';
  const commits = [
    {
      kind: 'commit',
      sha: '1234567',
      key: '1234567',
      madeBy: shared,
      madeBySession: 's-first',
      absolute: '2:26 PM',
      detail: 'Write it',
    },
    {
      kind: 'commit',
      sha: '89abcde',
      key: '89abcde',
      madeBy: shared,
      madeBySession: 's-second',
      absolute: '2:28 PM',
      detail: 'Write it too',
    },
  ] as unknown as CommitRowView[];
  const record = agentFigureRecord(
    {
      metric: 'commits',
      compactLabel: '2 commits',
      shas: ['1234567', '89abcde'],
      record: { heading: { label: '2 commits' }, layout: 'commits', entries: [] },
    },
    'k',
    [],
    commits,
    { name: shared, session: 's-first' },
  );
  const rows = record?.().rows;
  const shown = rows?.kind === 'commits' ? rows.commits : [];
  assert.deepEqual(
    shown.map((row) => [row.madeBy, row.madeBySession]),
    [
      [undefined, null],
      [shared, 's-second'],
    ],
    "the second subagent, sharing the first one's description, lost its own maker line",
  );
});

test('two subagents with an identical description and no session id each keep their own maker line', () => {
  // Matching descriptions without session IDs establish no identity. Both maker lines remain.
  const shared = 'Review the diff';
  const commits = [
    {
      kind: 'commit',
      sha: '1234567',
      key: '1234567',
      madeBy: shared,
      madeBySession: null,
      absolute: '2:26 PM',
      detail: 'Write it',
    },
    {
      kind: 'commit',
      sha: '89abcde',
      key: '89abcde',
      madeBy: shared,
      madeBySession: null,
      absolute: '2:28 PM',
      detail: 'Write it too',
    },
  ] as unknown as CommitRowView[];
  const record = agentFigureRecord(
    {
      metric: 'commits',
      compactLabel: '2 commits',
      shas: ['1234567', '89abcde'],
      record: { heading: { label: '2 commits' }, layout: 'commits', entries: [] },
    },
    'k',
    [],
    commits,
    { name: shared, session: null },
  );
  const rows = record?.().rows;
  const shown = rows?.kind === 'commits' ? rows.commits : [];
  assert.deepEqual(
    shown.map((row) => [row.madeBy, row.madeBySession]),
    [
      [shared, null],
      [shared, null],
    ],
    'a shared description with no session on either side stripped a maker line it could not prove was its own',
  );
});

test('a subagent commits record picks its rows when a reader opens it', () => {
  const commits = [
    { kind: 'commit', sha: '1234567', key: '1234567', detail: 'Write it', absolute: '2:26 PM' },
  ] as unknown as CommitRowView[];
  let walks = 0;
  const counted = new Proxy(commits, {
    get(target, key, receiver) {
      if (key === 'filter') {
        walks += 1;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const record = agentFigureRecord(
    {
      metric: 'commits',
      compactLabel: '1 commit',
      shas: ['1234567'],
      record: { heading: { label: '1 commit' }, layout: 'commits', entries: [] },
    },
    'k',
    [],
    counted,
  );
  // Building the record leaves the commits unfiltered. Opening it filters them once.
  assert.equal(walks, 0, "the record walked the turn's commits while the row was only drawn");
  record?.();
  assert.equal(walks, 1);
});

function drawnText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(drawnText).join('');
  }
  const vnode = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof vnode.type === 'function') {
    return drawnText((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return drawnText(vnode.props?.children);
}

type DrawnNode = { type?: unknown; props?: Record<string, unknown> & { class?: string; children?: unknown } };

// Find matching elements after expanding component calls in the vnode tree.
function findAll(node: unknown, pick: (node: DrawnNode) => boolean): DrawnNode[] {
  if (node === null || node === undefined || typeof node !== 'object') {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((one) => findAll(one, pick));
  }
  const vnode = node as DrawnNode;
  if (typeof vnode.type === 'function') {
    return findAll((vnode.type as (props: unknown) => unknown)(vnode.props), pick);
  }
  return [...(pick(vnode) ? [vnode] : []), ...findAll(vnode.props?.children, pick)];
}

function findNode(node: unknown, pick: (node: DrawnNode) => boolean): DrawnNode | null {
  return findAll(node, pick)[0] ?? null;
}

function drawnEmpties(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return [];
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(drawnEmpties);
  }
  const vnode = node as { type?: unknown; props?: { class?: string; children?: unknown } };
  if (typeof vnode.type === 'function') {
    return drawnEmpties((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  const inside = drawnEmpties(vnode.props?.children);
  if (typeof vnode.type === 'string' && vnode.props?.class && !drawnText(node)) {
    inside.push(vnode.props.class);
  }
  return inside;
}

test('a file row omits empty count cells, and a commit row draws a recorded zero', () => {
  const fileRow = (over: Partial<FileRowView>) =>
    h(FileRow, {
      cardKey: 'k',
      post: () => {},
      file: {
        name: 'a.ts',
        label: 'a.ts',
        icon: { label: 'TS' },
        path: 'c:/repo/src/a.ts',
        shownPath: 'src/a.ts',
        added: 4,
        removed: 2,
        isNew: false,
        ...over,
      },
    });
  const fileSeen = (over: Partial<FileRowView>) => [drawnText(fileRow(over)), drawnEmpties(fileRow(over))];
  assert.deepEqual(fileSeen({ added: 0, removed: 0, countsUnknown: true }), ['TSa.ts', []]);
  assert.deepEqual(fileSeen({}), ['TSa.ts +4 −2', []]);
  assert.deepEqual(fileSeen({ added: 0, removed: 0, isNew: true }), ['TSa.ts new', []]);
  const commitRow = (over: Partial<CommitRowView>) =>
    h(CommitRow, {
      cardKey: 'k',
      post: () => {},
      commit: {
        kind: 'commit',
        key: 'commit:6816be3',
        sha: '6816be3',
        subject: 'Retag the release',
        repository: null,
        branch: 'main',
        headKind: 'branch',
        madeBySession: null,
        dir: 'c:/repo',
        where: null,
        detail: 'Retag the release',
        added: 0,
        removed: 0,
        at: 0,
        absolute: '2:26 PM',
        ...over,
      },
    });
  const commitSeen = (over: Partial<CommitRowView>) => [drawnText(commitRow(over)), drawnEmpties(commitRow(over))];
  // The count cell stays when it is empty, so every subject ends at the same column.
  assert.deepEqual(commitSeen({}), ['6816be3 Retag the release +0 −0, committed 2:26 PM', []]);
  assert.deepEqual(commitSeen({ added: 4, removed: 0 }), ['6816be3 Retag the release +4, committed 2:26 PM', []]);
  assert.deepEqual(commitSeen({ added: null, removed: null }), [
    '6816be3 Retag the release , committed 2:26 PM',
    ['commitnums'],
  ]);
  assert.deepEqual(commitSeen({ added: 15, removed: 1 }), ['6816be3 Retag the release +15 −1, committed 2:26 PM', []]);
  // A landing no branch explains is a row that reads merged in.
  assert.deepEqual(
    commitSeen({
      kind: 'landing',
      key: 'landing:merge-1',
      mergedBranch: null,
      landingTarget: 'main',
      added: null,
      removed: null,
    }),
    ['6816be3 Retag the release , merged into main 2:26 PM merged in', ['commitnums']],
  );
  // A subagent's row names its maker on a second line, the name a press into its session.
  const made = commitRow({ madeBy: 'Fix the commit record rows', madeBySession: 's-child' });
  assert.equal(
    drawnText(made),
    '6816be3 Retag the release +0 −0, committed 2:26 PM made by Open Fix the commit record rows session',
  );
  const button = findNode(made, (node) => node.props?.class === 'commitmakerlink');
  assert.equal(button?.props?.['data-control'], 'session:k:s-child');
  assert.equal(button?.props?.['data-hint'], 'Open Fix the commit record rows session');
  const plain = commitRow({ madeBy: 'Fix the commit record rows', madeBySession: null });
  assert.equal(
    findNode(plain, (node) => node.props?.class === 'commitmakerlink'),
    null,
  );
  assert.equal(
    drawnText(findNode(plain, (node) => node.props?.class === 'commitmakername')),
    'Fix the commit record rows',
  );
  assert.equal(
    findNode(commitRow({ where: 'in worktree rail-review' }), (node) => node.props?.class === 'where'),
    null,
    'a row drew its place, which its group heading owns',
  );
});

test('a grouped Commits record draws a heading per branch, and a one-branch record names it on the section heading', () => {
  const row = (over: Partial<CommitRowView>): CommitRowView => ({
    kind: 'commit',
    key: `commit:${over.sha}`,
    sha: '0000000',
    subject: 'Write it',
    dir: 'c:/repo',
    where: null,
    detail: 'Write it',
    added: 1,
    removed: 0,
    at: 0,
    absolute: '4:06 PM',
    madeBySession: null,
    repository: { key: 'c:/repo/.git', name: 'repo', own: true },
    branch: 'main',
    headKind: 'branch',
    ...over,
  });
  const plans = { key: 'c:/repo/.claude/plans/.git', name: '.claude/plans', own: false };
  const commits = [
    row({
      sha: '184751b0',
      subject: 'fix(timeline): repair four defects',
      branch: 'ship/commit-record-repairs',
      at: 1,
      where: 'in worktree repairs',
    }),
    row({ sha: '5e0c1d2a', subject: 'docs(plan): record the repair', repository: plans, at: 2 }),
    row({
      kind: 'landing',
      key: 'landing:1',
      sha: 'c36e7b5b',
      subject: 'fix(timeline): repair the landing row',
      at: 3,
      added: null,
      removed: null,
      mergedBranch: 'ship/commit-record-repairs',
      landingTarget: 'main',
      absolute: '4:49 PM',
    }),
    row({
      kind: 'landing',
      key: 'landing:2',
      sha: 'd00dfeed',
      subject: 'Merge a stranger',
      at: 4,
      added: null,
      removed: null,
      mergedBranch: null,
      landingTarget: 'main',
      absolute: '4:50 PM',
    }),
  ];
  const grouping = groupCommitRows(commits);
  const drawn = h(CommitGroups, { cardKey: 'k', groups: grouping.groups, post: () => {} });
  const groups = findAll(drawn, (node) => node.props?.class === 'commitgroup');
  // The card's repository groups lead despite the nested repository's intervening commit.
  assert.deepEqual(
    groups.map((group) => group.props?.['aria-label']),
    ['ship/commit-record-repairs, merged into main at 4:49 PM', 'main', '.claude/plans, main'],
  );
  assert.deepEqual(findAll(drawn, (node) => node.props?.class === 'commitgrouphead').map(drawnText), [
    'ship/commit-record-repairs · in worktree repairs · merged into main at 4:49 PM, as c36e7b5b',
    'main',
    '.claude/plans · main',
  ]);
  // A known branch's landing appears on its heading. An unresolved landing remains a row.
  assert.deepEqual(
    findAll(drawn, (node) => node.props?.class === 'row commitrow').map((node) => node.props?.['data-commit']),
    ['184751b0', 'd00dfeed', '5e0c1d2a'],
  );
  // One branch draws no group, and the section heading names the branch beside the figure.
  const one = [commits[0], commits[2]];
  const sections = recordSections({ key: 'card-3', commits: one } as CardView, { post: () => {} } as never) as Array<{
    props: { count?: string; fact?: { text: string; arrival?: { title: string; spoken: string } } };
  }>;
  assert.equal(sections[0].props.count, '1 · 1 merged');
  assert.equal(sections[0].props.fact?.text, '· on ship/commit-record-repairs · in worktree repairs');
  assert.equal(sections[0].props.fact?.arrival?.spoken, ' into main at 4:49 PM, as c36e7b5b');
  assert.match(
    sections[0].props.fact?.arrival?.title ?? '',
    /^Merged into main at 4:49 PM, as c36e7b5b, which holds this branch's work under a new hash: fix\(timeline\): repair the landing row$/,
  );
});

test('commit and landing rows share a record while keeping distinct identities', () => {
  const commit: CommitRowView = {
    kind: 'commit',
    key: 'commit:6816be3',
    sha: '6816be3',
    subject: 'Retag the release',
    repository: null,
    branch: null,
    headKind: null,
    madeBySession: null,
    dir: 'c:/repo',
    where: null,
    detail: 'Retag the release',
    added: 0,
    removed: 0,
    at: 0,
    absolute: '2:26 PM',
  };
  const landing: CommitRowView = {
    ...commit,
    kind: 'landing',
    key: 'landing:merge-1',
    mergedBranch: null,
    landingTarget: 'main',
  };
  const card = { key: 'card-1', commits: [commit, landing] } as CardView;
  const rows = detailRowsFor(card, 'commits');
  assert.deepEqual(rows?.kind === 'commits' ? rows.commits : [], [commit, landing]);
  assert.equal(detailRowsFor(card, 'landings'), null);
  const grouping = groupCommitRows(card.commits!);
  assert.equal(grouping.single, true);
  assert.deepEqual(
    grouping.groups[0].rows.map((row) => row.key),
    ['commit:6816be3', 'landing:merge-1'],
  );
  const sections = recordSections(card, { post: () => {} } as never) as Array<{
    props: { title: string; count?: number | string };
  }>;
  // The Commits heading counts written commits separately from landings.
  assert.deepEqual(
    sections.map((section) => [section.props.title, section.props.count]),
    [['Commits', '1 · 1 merged']],
  );
  // A landing-only record retains the Commits heading and names its merged count.
  const onlyLanded = recordSections(
    { key: 'card-2', commits: [landing] } as CardView,
    { post: () => {} } as never,
  ) as Array<{ props: { title: string; count?: number | string } }>;
  assert.deepEqual(
    onlyLanded.map((section) => [section.props.title, section.props.count]),
    [['Commits', '1 merged']],
  );
});

test('a figure draws only the line counts that moved', () => {
  assert.equal(drawnText(h(DiffPair, { added: 3, removed: 0 })), '+3');
  assert.equal(drawnText(h(DiffPair, { added: 0, removed: 3 })), '−3');
  assert.equal(DiffPair({ added: 0, removed: 0 }), null);
  assert.deepEqual(labelledDiff('1 file', 0, 0).map(drawnText), ['1 file']);
  assert.deepEqual(labelledDiff('2 files', 4, 2).map(drawnText), ['2 files', ' ', '+4 −2']);
  assert.equal(
    drawnText(
      h(StaticStatChip, {
        stat: { metric: 'files', compactLabel: '1 file', added: 0, removed: 0 },
        contextClass: () => '',
      }),
    ),
    '1 file',
  );
});

test('a subagent files figure that is a floor draws no partial word or mark', () => {
  // The child has one file with unknown counts and one with partial counts.
  // Its artifacts are incomplete. The Files figure leaves these limitations in the detail footer.
  const spend = {
    found: true,
    partial: false,
    effort: 'high',
    models: [],
    artifacts: {
      complete: false,
      revision: 'one',
      files: [
        {
          path: 'C:/repo/src/card.ts',
          added: 0,
          removed: 0,
          isNew: false,
          countsUnknown: true as const,
          unknownReason: 'write' as const,
        },
        {
          path: 'C:/repo/src/other.ts',
          added: 4,
          removed: 0,
          isNew: false,
          countsPartial: true as const,
          unknownReason: 'write' as const,
        },
      ],
      commits: [],
    },
    commits: [],
  };
  const card = dispatchedAgentCard('sess', 'Review the card', spend, 'done', 1000, 65000, 2);
  const figure = card.figures.find((one) => one.metric === 'files');
  assert.ok(figure, 'dispatchedAgentCard drew no files figure for a child with file artifacts');
  // Adapt the figure's plain record to the callback used by `StaticStatChip`.
  const record = figure.record;
  const stat = { ...figure, record: record ? () => record : undefined };
  const drawn = h(StaticStatChip, { stat, contextClass: () => '' });
  assert.equal(
    findNode(drawn, (node) => node.props?.class === 'statpartial'),
    null,
    'a floor subagent figure drew the partial mark on its face',
  );
  assert.equal(
    drawnText(drawn).includes('partial'),
    false,
    'a floor subagent figure said the counts were partial in its drawn or spoken text',
  );
  const named = findNode(drawn, (node) => typeof node.props?.['aria-label'] === 'string');
  assert.ok(named, 'a floor subagent figure drew no accessible name');
  assert.equal(
    (named.props!['aria-label'] as string).includes('partial'),
    false,
    "a floor subagent figure's accessible name said the counts were partial",
  );
  assert.ok(
    record?.footer?.some((line) => line === '1 file was written whole, so its old lines are unknown.'),
    "the floor record's footer dropped the reason one file carries no count at all",
  );
  assert.ok(
    record?.footer?.some((line) => line === '1 file was written whole, so its line counts are partial.'),
    "the floor record's footer dropped the reason one file kept a floor count",
  );
});

test('a long subagent name keeps its complete hover and accessible text', () => {
  const description = 'code_implement_2_deslop_tests_first_remaining_sol_retry_2';
  for (const sessionId of ['child-session', null]) {
    const agent: AgentRowView = {
      description,
      model: 'gpt-6.1-sol',
      effort: 'high',
      state: 'done',
      stateWord: '',
      since: null,
      hintDetail: '23 tools',
      sessionId,
      figures: [],
    };
    const row = h(AgentRow, { cardKey: 'k', agent, post: () => {} });
    const name = findNode(row, (node) => (node.props?.class ?? '').split(' ').includes('name'));
    assert.ok(name);
    assert.ok(drawnText(name).includes(description));
    if (sessionId) {
      assert.equal(name.type, 'button');
      assert.equal(name.props?.['data-hint'], `${description}: ${CARD_ACTIONS.openSubagentSession}`);
      assert.equal(name.props?.['data-hint-detail'], '23 tools');
      assert.equal(name.props?.title, undefined);
    } else {
      assert.equal(name.type, 'span');
      assert.equal(name.props?.title, description);
    }
  }
});

test('a subagent row preserves compound text separators', () => {
  const agent: AgentRowView = {
    description: 'Review child',
    model: 'opus-5',
    effort: 'high',
    state: 'done',
    stateWord: '',
    since: null,
    hintDetail: '23 tools',
    sessionId: 'child-session',
    figures: [
      { metric: 'cost', compactLabel: '$0.31' },
      { metric: 'files', compactLabel: '3 files', name: '3 files, 18 lines added, 4 removed', added: 18, removed: 4 },
    ],
  };
  assert.equal(
    drawnText(h(AgentRow, { cardKey: 'k', agent, post: () => {} })),
    `${CARD_GLYPHS.done} Open Review child session, opus-5 · high reasoning effort $0.31 3 files +18 −4 finished`,
  );
});

function walkStop(tabIndex = 0): HTMLElement {
  return { tabIndex, offsetWidth: 24, offsetHeight: 16, closest: () => null } as unknown as HTMLElement;
}

test('a walk out of one popover lands past the record drawn over it', () => {
  const page = walkStop();
  const figure = walkStop(-1);
  const popStop = walkStop();
  const nestedStop = walkStop();
  const within = (stop: HTMLElement) => stop === figure || stop === popStop || stop === nestedStop;
  assert.equal(walkOutOf([page, figure, popStop, nestedStop], figure, within), null);
  assert.equal(walkOutOf([page, figure, popStop, nestedStop], page, within), null);
  const later = walkStop();
  assert.equal(walkOutOf([page, figure, popStop, nestedStop, later], figure, within), later);
});

test('the card body follows each Timeline layout', () => {
  const expected: Record<string, string[][]> = {
    'compact:above': [['prompt', 'error', 'response', 'activity']],
    'compact:below': [['error', 'response', 'activity', 'prompt']],
    'one-column:above': [['prompt', 'error', 'response', 'activity', 'record']],
    'one-column:below': [['error', 'response', 'activity', 'record', 'prompt']],
    'two-columns:above': [['prompt', 'error', 'response', 'activity'], ['record']],
    'two-columns:below': [['error', 'response', 'activity', 'prompt'], ['record']],
  };
  for (const cardLayout of CARD_LAYOUTS) {
    for (const promptPosition of PROMPT_POSITIONS) {
      const name = `${cardLayout}:${promptPosition}`;
      assert.deepEqual(cardBodyColumns({ cardLayout, promptPosition }, true), expected[name]);
      assert.deepEqual(cardBodyColumns({ cardLayout, promptPosition }, false), expected[`compact:${promptPosition}`]);
    }
  }
});

// Draw the host-built commit fixtures with group headings only for multiple groups.
test('the commits record draws every case of its fixture matrix', () => {
  const cards = commitRecordCards();
  const rowsOf = (name: CommitRecordCase) => cards[name].commits as unknown as CommitRowView[];
  const heading = (name: CommitRecordCase) =>
    cards[name].chips.find((chip) => chip.metric === 'commits')?.detailList?.heading;
  const drawn = (name: CommitRecordCase) => {
    const grouping = groupCommitRows(rowsOf(name));
    return grouping.single
      ? grouping.groups[0].rows.map((commit) => h(CommitRow, { cardKey: 'k', commit, post: () => {} }))
      : h(CommitGroups, { cardKey: 'k', groups: grouping.groups, post: () => {} });
  };
  const texts = (name: CommitRecordCase, part: string) =>
    findAll(drawn(name), (node) => (node.props?.class ?? '').split(' ').includes(part)).map(drawnText);
  assert.equal(heading('missing'), undefined, 'a turn with no commits drew a Commits record');
  assert.deepEqual(texts('recordedZero', 'commitnums'), ['+0 −0'], 'a commit that moved no line drew no +0 −0');
  assert.deepEqual(texts('positive', 'commitnums'), ['+201 −29']);
  assert.deepEqual(texts('partial', 'commitnums'), ['+42']);
  assert.deepEqual(
    texts('longest', 'name').map((subject) => subject.length),
    [83, 83, 69],
    'the longest subject did not reach the row whole',
  );
  assert.deepEqual(texts('longest', 'commitmakerlink'), [`Open ${LONGEST_MAKER} session`]);
  assert.equal(heading('common')?.fact, '· on main');
  assert.deepEqual(texts('common', 'commitmakerword'), ['made by']);
  // The merged branch carries its arrival. The nested repository prefixes its own heading.
  assert.equal(heading('grouped')?.fact, undefined, 'a grouped record named one branch on its heading');
  assert.deepEqual(texts('grouped', 'commitgroupname'), ['ship/commit-record-repairs', 'main']);
  assert.deepEqual(texts('grouped', 'commitgrouprepo'), ['.claude/plans ·']);
  assert.deepEqual(texts('grouped', 'dim'), [], 'a merge its branch explains drew as a row');
  assert.deepEqual(texts('fallback', 'commitgroupname'), ['ship/commit-record-repairs', 'main', 'main']);
  assert.deepEqual(texts('fallback', 'dim'), ['merged in']);
  assert.deepEqual(texts('detached', 'commitgroupname'), ['detached commit', 'main']);
  assert.equal(heading('worktree')?.fact, '· on fix/rail-pin · in worktree rail-review');
  assert.deepEqual(texts('makerWithoutSession', 'commitmakername'), ['Read the reflog']);
  assert.deepEqual(texts('makerWithoutSession', 'commitmakerlink'), []);
  assert.deepEqual([heading('landingOnly')?.label, heading('landingOnly')?.fact], ['1 merged', '· on main']);
  assert.deepEqual(texts('landingOnly', 'dim'), ['merged in']);
  const run = groupCommitRows(rowsOf('manyGroups'));
  assert.equal(heading('manyGroups')?.label, '14 commits · 6 merged');
  assert.deepEqual(
    [run.groups.length, run.groups.filter((group) => group.arrival).length],
    [7, 6],
    'the run did not group into six merged branches and the plans repository',
  );
  // The turn spans two branches. The subagent record names its single branch beside the figure.
  assert.equal(heading('subagentRecord')?.fact, undefined);
  const child = cards.subagentRecord.agents?.[0] as unknown as AgentRowView;
  const figure = child.figures.find((one) => one.metric === 'commits');
  assert.ok(figure, 'the subagent row drew no commits figure');
  const record = agentFigureRecord(figure, 'k', [], rowsOf('subagentRecord'), {
    name: child.description,
    session: child.sessionId,
  })?.();
  assert.equal(
    record?.heading?.fact,
    '· on ship/subagent-evidence-b',
    'the subagent record does not name its one branch',
  );
  assert.equal(record?.rows?.kind === 'commits' ? record.rows.commits.length : 0, 2);
});

test('a subagent record of one merged branch names the merge on its heading', () => {
  const rows = [
    {
      kind: 'commit',
      key: 'commit:1234567',
      sha: '1234567',
      subject: 'Write it',
      repository: null,
      branch: 'topic',
      headKind: 'branch',
      madeBySession: null,
      dir: 'c:/repo',
      where: null,
      detail: 'Write it',
      added: 1,
      removed: 0,
      at: 1,
      absolute: '2:26 PM',
    },
    {
      kind: 'landing',
      key: 'landing:1',
      sha: '89abcde',
      subject: 'Merge topic',
      repository: null,
      branch: 'main',
      headKind: 'branch',
      madeBySession: null,
      dir: 'c:/repo',
      where: null,
      detail: 'Merge topic',
      added: null,
      removed: null,
      at: 2,
      absolute: '2:30 PM',
      mergedBranch: 'topic',
      landingTarget: 'main',
    },
  ] as CommitRowView[];
  const record = agentFigureRecord(
    {
      metric: 'commits',
      compactLabel: '1 commit',
      shas: ['1234567', '89abcde'],
      record: { heading: { label: '1 commit' }, layout: 'commits', entries: [] },
    },
    'k',
    [],
    rows,
  );
  assert.deepEqual(record?.().heading, {
    label: '1 commit',
    fact: '· on topic',
    factArrival: {
      title: "Merged into main at 2:30 PM, as 89abcde, which holds this branch's work under a new hash: Merge topic",
      spoken: ' into main at 2:30 PM, as 89abcde',
    },
  });
});

test('nested printed commits become clickable only after the owning repository resolves', async () => {
  const one = turn({ commits: [] });
  recordCommits(one, '[main abc1234] Printed subject', 1, {
    command: "& 'C:/tools/bash.exe' -c 'git -C C:/notes commit -m first; git -C C:/plans commit -q -m second'",
    shell: 'powershell',
    cwd: 'C:/repo',
    at: 0,
  });
  const posts: unknown[] = [];
  const drawn = () =>
    h(CommitRow, { cardKey: 'card-1', commit: commitCard(one.commits[0], 1), post: (message) => posts.push(message) });
  assert.equal(
    findNode(drawn(), (node) => node.props?.class === 'sha editor-link'),
    null,
  );
  const full = 'abc1234' + '1'.repeat(33);
  const commits = new RepositoryCommits(
    {
      async run(dir, args) {
        if (args.includes('--git-common-dir')) return `${dir}/.git\n${dir}/.git\n${dir}\n`;
        if (args[0] === 'rev-parse') return dir === 'c:/notes' ? full : '';
        return `\x1e${full}\x002026-09-02T04:08:19Z\x00Repository subject\n`;
      },
    },
    () => {},
  );
  commits.apply([one], ['C:/repo']);
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  commits.apply([one], ['C:/repo']);
  const button = findNode(drawn(), (node) => node.props?.class === 'sha editor-link');
  assert.ok(button?.props);
  for (const modifiers of [
    { ctrlKey: false, metaKey: false },
    { ctrlKey: true, metaKey: false },
    { ctrlKey: false, metaKey: true },
  ]) {
    (button.props.onClick as (event: unknown) => void)({ ...modifiers, stopPropagation() {}, preventDefault() {} });
  }
  assert.deepEqual(
    posts,
    [false, true, true].map((beside) => ({
      type: 'openCommit',
      key: 'card-1',
      sha: 'abc1234',
      dir: 'c:/notes',
      beside,
    })),
  );
});

test('commit buttons open complete printed identities behind identical display hashes', () => {
  const one = turn({ commits: [] });
  const hashes = ['abc12345' + '1'.repeat(32), 'abc12345' + '2'.repeat(32)];
  recordCommits(one, hashes.map((sha) => `[main ${sha}] Printed`).join('\n'), 1, {
    command: 'git commit -m x',
    cwd: 'C:/repo',
    at: 0,
  });
  one.commits.forEach((commit, index) => {
    commit.dir = ['C:/first', 'C:/second'][index];
  });
  const cards = one.commits.map((c) => commitCard(c, 1, 'Worker', 'child'));
  assert.deepEqual(
    cards.map((card) => card.madeBySession),
    ['child', 'child'],
  );
  assert.notEqual(cards[0].key, cards[1].key);
  const posts: unknown[] = [];
  for (const card of cards) {
    const button = findNode(
      h(CommitRow, { cardKey: 'k', commit: card, post: (message) => posts.push(message) }),
      (node) => node.props?.class === 'sha editor-link',
    );
    assert.ok(button?.props);
    (button.props.onClick as (event: unknown) => void)({ ctrlKey: false, metaKey: false, stopPropagation() {} });
  }
  assert.deepEqual(
    posts,
    hashes.map((sha, index) => ({
      type: 'openCommit',
      key: 'k',
      sha,
      dir: ['C:/first', 'C:/second'][index],
      beside: false,
    })),
  );
});
