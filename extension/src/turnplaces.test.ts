// extension/src/turnplaces.test.ts
//
// The tests for turnplaces.ts. A trail is small enough to write out whole, so each test names
// the places it expects rather than asserting on a length.
import { test } from 'vitest';
import assert from 'node:assert';
import {
  PLACE_LIMIT,
  canStepBack,
  canStepForward,
  emptyTrail,
  prunePlaces,
  renamePlace,
  stepBack,
  stepForward,
  trailPlace,
  visitPlace,
} from './turnplaces.ts';

function trailOf(...places: string[]) {
  let trail = emptyTrail();
  for (const place of places) {
    trail = visitPlace(trail, place);
  }
  return trail;
}

test('an empty trail stands nowhere and goes nowhere', () => {
  const trail = emptyTrail();
  assert.equal(trailPlace(trail), null);
  assert.equal(canStepBack(trail), false);
  assert.equal(canStepForward(trail), false);
  assert.equal(stepBack(trail), null);
  assert.equal(stepForward(trail), null);
});

test('a visit stands on the place it visited', () => {
  const trail = trailOf('a', 'b');
  assert.deepEqual(trail.places, ['a', 'b']);
  assert.equal(trailPlace(trail), 'b');
  assert.equal(canStepBack(trail), true);
  assert.equal(canStepForward(trail), false);
});

test('one place is a trail with nowhere to step', () => {
  const trail = trailOf('a');
  assert.equal(trailPlace(trail), 'a');
  assert.equal(canStepBack(trail), false);
  assert.equal(stepBack(trail), null);
});

test('back and forward walk the same places', () => {
  const trail = trailOf('a', 'b', 'c');
  const back = stepBack(trail)!;
  assert.equal(trailPlace(back), 'b');
  assert.equal(trailPlace(stepBack(back)!), 'a');
  assert.equal(trailPlace(stepForward(back)!), 'c');
});

test('back stops at the oldest place', () => {
  const trail = stepBack(trailOf('a', 'b'))!;
  assert.equal(trailPlace(trail), 'a');
  assert.equal(stepBack(trail), null);
});

test('a visit after stepping back ends the forward walk', () => {
  const back = stepBack(trailOf('a', 'b', 'c'))!;
  const trail = visitPlace(back, 'd');
  assert.deepEqual(trail.places, ['a', 'b', 'd']);
  assert.equal(trailPlace(trail), 'd');
  assert.equal(canStepForward(trail), false);
});

test('visiting the place already open changes nothing', () => {
  const trail = trailOf('a', 'b');
  assert.deepEqual(visitPlace(trail, 'b').places, ['a', 'b']);
  assert.equal(visitPlace(trail, 'b').at, trail.at);
});

test('the same place again after a step back is a visit', () => {
  const back = stepBack(trailOf('a', 'b'))!;
  const trail = visitPlace(back, 'b');
  assert.deepEqual(trail.places, ['a', 'b']);
  assert.equal(trailPlace(trail), 'b');
});

test('no session is not a place', () => {
  const trail = trailOf('a');
  assert.deepEqual(visitPlace(trail, '').places, ['a']);
  assert.deepEqual(visitPlace(emptyTrail(), '').places, []);
});

test('the oldest places go once the trail is full', () => {
  let trail = emptyTrail();
  for (let i = 0; i < PLACE_LIMIT + 3; i += 1) {
    trail = visitPlace(trail, `c${i}`);
  }
  assert.equal(trail.places.length, PLACE_LIMIT);
  assert.equal(trail.places[0], 'c3');
  assert.equal(trailPlace(trail), `c${PLACE_LIMIT + 2}`);
});

test('pruning drops the sessions that have gone', () => {
  const trail = prunePlaces(trailOf('a', 'b', 'c'), new Set(['a', 'c']));
  assert.deepEqual(trail.places, ['a', 'c']);
  assert.equal(trailPlace(trail), 'c');
});

test('pruning folds neighbours that become the same place', () => {
  const trail = prunePlaces(trailOf('a', 'b', 'a'), new Set(['a']));
  assert.deepEqual(trail.places, ['a']);
  assert.equal(canStepBack(trail), false);
});

test('pruning the place the reader stands on steps back', () => {
  const trail = prunePlaces(trailOf('a', 'b', 'c'), new Set(['a', 'b']));
  assert.deepEqual(trail.places, ['a', 'b']);
  assert.equal(trailPlace(trail), 'b');
});

test('pruning keeps the reader behind the places they had not seen', () => {
  const walked = stepBack(trailOf('a', 'b', 'c'))!;
  const trail = prunePlaces(walked, new Set(['a', 'c']));
  assert.deepEqual(trail.places, ['a', 'c']);
  assert.equal(trailPlace(trail), 'a');
  assert.equal(canStepForward(trail), true);
});

test('pruning everything leaves a trail that stands nowhere', () => {
  const trail = prunePlaces(trailOf('a', 'b'), new Set<string>());
  assert.deepEqual(trail.places, []);
  assert.equal(trailPlace(trail), null);
  assert.equal(stepBack(trail), null);
});

test('a renamed draft keeps its place on the trail', () => {
  const trail = renamePlace(trailOf('a', 'draft:1'), 'draft:1', 'real-1');
  assert.deepEqual(trail.places, ['a', 'real-1']);
  assert.equal(trailPlace(trail), 'real-1');
});

test('a rename that meets the same session folds the two', () => {
  const trail = renamePlace(trailOf('a', 'draft:1'), 'draft:1', 'a');
  assert.deepEqual(trail.places, ['a']);
  assert.equal(trailPlace(trail), 'a');
});

test('a rename to nothing or to itself changes nothing', () => {
  const trail = trailOf('a', 'b');
  assert.deepEqual(renamePlace(trail, 'b', 'b').places, ['a', 'b']);
  assert.deepEqual(renamePlace(trail, '', 'c').places, ['a', 'b']);
  assert.deepEqual(renamePlace(trail, 'b', '').places, ['a', 'b']);
});

test('pruning the place the reader stands on and all before it stands on the oldest left', () => {
  // Nothing behind them survived, so the only places left lie ahead. Standing on the oldest
  // of those is the nearest the trail can get to where they were.
  const walked = stepBack(trailOf('a', 'b', 'c'))!;
  const trail = prunePlaces(walked, new Set(['c']));
  assert.deepEqual(trail.places, ['c']);
  assert.equal(trailPlace(trail), 'c');
  assert.equal(canStepBack(trail), false);
  assert.equal(canStepForward(trail), false);
});
