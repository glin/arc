import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createNavigation, navigationIndex, plainNavigationKey, ROVING_SELECTOR } from './navigation.ts';

// Plain objects model nodes from another realm, which do not pass local Element or HTMLElement instanceof checks.
function fakePage(className: string) {
  const attributes = new Map<string, string>();
  const control = {
    nodeType: 1,
    className,
    tabIndex: -1,
    matches: (selector: string) => selector === ROVING_SELECTOR && className.length > 0,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    closest: () => null,
    querySelectorAll: () => [],
  };
  const body = {
    contains: (node: unknown) => node === control,
    nodeType: 1,
    matches: () => false,
    hasAttribute: () => false,
    setAttribute() {},
    removeAttribute() {},
    closest: () => null,
    querySelectorAll: () => [control],
    appendChild() {},
  };
  return { attributes, control, body };
}

function fakeNavigation(page: ReturnType<typeof fakePage>) {
  const watched: Node[] = [];
  let disconnected = 0;
  const document = {
    body: page.body,
    scrollingElement: null,
    querySelectorAll: () => [page.control].filter((node) => node.hasAttribute('data-roving')),
    createElement: () => ({ ...page.body, hidden: false, addEventListener() {}, classList: { add() {} } }),
  } as unknown as Document;
  const navigation = createNavigation({
    document,
    window: { innerHeight: 100 },
    list: page.body as unknown as HTMLElement,
    events: { document() {}, window() {} },
    observe(target) {
      watched.push(target);
      return {
        takeRecords: () => [],
        disconnect() {
          disconnected += 1;
        },
      };
    },
    sendToHost() {},
    toTopLabel: 'Back to top',
  });
  return { navigation, watched, disconnected: () => disconnected };
}

test('the roving walk is read from a page this realm did not build', () => {
  const page = fakePage('head');
  const { navigation, watched } = fakeNavigation(page);
  assert.deepEqual(watched, [page.body], 'the watch was not taken through the seam the owner was given');
  assert.equal(
    page.attributes.has('data-roving'),
    true,
    'no control on the page joined the walk, so every read of it comes back empty',
  );
  assert.deepEqual(navigation.allControls(), [page.control as unknown as HTMLElement]);
});

test('supplementary navigation stays local and ignores modified or composing keys', () => {
  assert.equal(navigationIndex('Home', 2, 3), 0);
  assert.equal(navigationIndex('End', 0, 3), 2);
  assert.equal(navigationIndex('ArrowDown', 2, 3), 2);
  assert.equal(navigationIndex('ArrowUp', 0, 3), 0);
  assert.equal(navigationIndex('Tab', 0, 3), null);
  assert.equal(navigationIndex('Home', 0, 0), null);
  const plain = {
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  assert.equal(plainNavigationKey(plain), true);
  for (const key of ['defaultPrevented', 'isComposing', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.equal(plainNavigationKey({ ...plain, [key]: true }), false);
  }
  assert.equal(plainNavigationKey({ ...plain, keyCode: 229 }), false);
});

test('a navigation that is finished with the page ends its watch', () => {
  const page = fakePage('railcard');
  const owner = fakeNavigation(page);
  assert.equal(owner.disconnected(), 0);
  owner.navigation.dispose();
  assert.equal(
    owner.disconnected(),
    1,
    'the watch outlives its navigation, so a second one over the page marks every subtree twice',
  );
});
