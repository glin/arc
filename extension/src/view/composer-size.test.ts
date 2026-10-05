import assert from 'node:assert';
import { test } from 'vitest';
import {
  PROMPT_FLOOR_MIN_EM,
  PROMPT_LINE_EM,
  clampPromptFloor,
  promptFloorAfterKey,
  promptFloorLines,
} from './composer-size.ts';

test('the prompt floor stays finite and inside the measured range', () => {
  assert.equal(clampPromptFloor(undefined, 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(clampPromptFloor('12', 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(clampPromptFloor(NaN, 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(clampPromptFloor(Infinity, 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(clampPromptFloor(2, 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(clampPromptFloor(12.345, 20), 12.35);
  assert.equal(clampPromptFloor(30, 20), 20);
  assert.equal(clampPromptFloor(12, 2), PROMPT_FLOOR_MIN_EM);
});

test('the separator keys move by lines and reach both ends', () => {
  assert.equal(promptFloorAfterKey('ArrowUp', 5, 20), 5 + PROMPT_LINE_EM);
  assert.equal(promptFloorAfterKey('ArrowDown', 5, 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(promptFloorAfterKey('Home', 12, 20), PROMPT_FLOOR_MIN_EM);
  assert.equal(promptFloorAfterKey('End', 12, 20), 20);
  assert.equal(promptFloorAfterKey('Tab', 12, 20), null);
  const padding = 0.7;
  assert.equal(promptFloorLines(3.6, padding), 2);
  assert.equal(promptFloorLines(3.6 + PROMPT_LINE_EM, padding), 3);
  assert.equal(promptFloorLines(20, padding), 14);
});
