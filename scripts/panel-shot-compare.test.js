const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function comparator() {
  return import('../extension/scripts/compare-panel-shots.mjs');
}

function image(width, height, bytes) {
  return { width, height, data: Uint8ClampedArray.from(bytes) };
}

test('panel shot comparison accepts equal RGBA images', async () => {
  const { compareRgba } = await comparator();
  const result = compareRgba(image(1, 1, [1, 2, 3, 4]), image(1, 1, [1, 2, 3, 4]));
  assert.equal(result.equal, true);
  assert.equal(result.changedPixels, 0);
  assert.equal(result.firstDifference, null);
});

test('panel shot comparison reports changed pixels and the first location', async () => {
  const { compareRgba } = await comparator();
  const result = compareRgba(image(2, 1, [1, 2, 3, 4, 5, 6, 7, 8]), image(2, 1, [1, 2, 3, 4, 9, 6, 7, 8]));
  assert.equal(result.equal, false);
  assert.equal(result.changedPixels, 1);
  assert.deepEqual(result.firstDifference, {
    x: 1,
    y: 0,
    before: [5, 6, 7, 8],
    after: [9, 6, 7, 8],
  });
});

test('panel shot comparison reports changed dimensions', async () => {
  const { compareRgba } = await comparator();
  const result = compareRgba(image(1, 1, [0, 0, 0, 0]), image(2, 1, new Array(8).fill(0)));
  assert.equal(result.equal, false);
  assert.equal(result.reason, 'dimensions');
  assert.deepEqual(result.before, { width: 1, height: 1 });
  assert.deepEqual(result.after, { width: 2, height: 1 });
});

test('panel shot comparison reports a missing state', async () => {
  const { shotPairs } = await comparator();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-shot-compare-'));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  fs.mkdirSync(before);
  fs.mkdirSync(after);
  try {
    fs.writeFileSync(path.join(before, 'wide.webp'), 'before');
    assert.deepEqual(shotPairs(before, after), [
      {
        name: 'wide',
        before: path.join(before, 'wide.webp'),
        after: path.join(after, 'wide.webp'),
        missing: 'after',
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A state drawn for the first time has no baseline to compare against. It is named and the run
// stands, because a comparison that stops on it reports nothing about the states that do have
// both images. A state whose after image is gone still fails the run.
test('panel shot comparison names a state with no baseline and keeps the run standing', async () => {
  const { compareShotDirectories } = await comparator();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-shot-compare-'));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  fs.mkdirSync(before);
  fs.mkdirSync(after);
  try {
    fs.writeFileSync(path.join(after, 'nested.webp'), 'after');
    const fresh = await compareShotDirectories(before, after);
    assert.equal(fresh.ok, true);
    assert.deepEqual(fresh.results, [{ name: 'nested', missing: 'before' }]);

    fs.writeFileSync(path.join(before, 'gone.webp'), 'before');
    const lost = await compareShotDirectories(before, after);
    assert.equal(lost.ok, false);
    assert.deepEqual(
      lost.results.map((result) => [result.name, result.missing]),
      [
        ['gone', 'after'],
        ['nested', 'before'],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
