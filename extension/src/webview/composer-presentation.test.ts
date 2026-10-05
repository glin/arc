import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';

// These text scans check the send button's staging decision and draft-update subscriptions without mounting a browser document.

function functionBody(source: string, startMarker: string, nextMarker: string | null): string {
  const at = source.indexOf(startMarker);
  assert.ok(at >= 0, `${startMarker} is no longer in composer-presentation.ts`);
  const nextAt = nextMarker ? source.indexOf(nextMarker, at + startMarker.length) : -1;
  return nextAt > at ? source.slice(at, nextAt) : source.slice(at);
}

test('the send button gates on sendWaitsForStaging, not on isStaging alone', () => {
  const source = fs.readFileSync(path.join(__dirname, 'composer-presentation.ts'), 'utf8');
  const body = functionBody(
    source,
    'export function createComposerAction',
    'export function createComposerPresentation',
  );
  const waitsAt = body.indexOf('const waits = sendWaitsForStaging(');
  assert.ok(waitsAt >= 0, 'the button no longer computes its wait state from sendWaitsForStaging');
  assert.equal(
    (body.match(/isStaging\(/g) ?? []).length,
    1,
    'the button reads attachments.isStaging(...) outside the one call sendWaitsForStaging makes',
  );
  assert.match(
    body,
    /node\.disabled = !view\.box\.actionEnabled \|\| waits;/,
    'the disabled state no longer follows the sendWaitsForStaging decision',
  );
  assert.match(
    body,
    /const sends = !waits && /,
    'the accessible name and keyboard shortcut no longer follow the sendWaitsForStaging decision',
  );
});

test('the button redraws while a file stages, since the host does not repaint on every keystroke', () => {
  const source = fs.readFileSync(path.join(__dirname, 'composer-presentation.ts'), 'utf8');
  const body = functionBody(source, 'export function createComposerPresentation', null);
  const redrawAt = body.indexOf('const redrawWhileStaging = () => {');
  assert.ok(redrawAt >= 0, 'nothing redraws the button while the reader keeps typing a staged draft');
  const stagingAt = body.indexOf('attachments.isStaging(', redrawAt);
  assert.ok(
    stagingAt > redrawAt && stagingAt - redrawAt < 200,
    'the redraw no longer checks attachments.isStaging before it runs',
  );
  const updateAt = body.indexOf('controls.update(', stagingAt);
  assert.ok(
    updateAt > stagingAt && updateAt - stagingAt < 120,
    'the redraw no longer calls controls.update to repaint the button',
  );
  assert.match(
    body,
    /prompt\.addEventListener\('input', redrawWhileStaging\);/,
    'a keystroke no longer redraws the button',
  );
});

test('a draft the composer sets itself redraws the button, since it sends no input event', () => {
  const presentation = fs.readFileSync(path.join(__dirname, 'composer-presentation.ts'), 'utf8');
  assert.match(
    functionBody(presentation, 'export function createComposerPresentation', null),
    /composer\.onDraftSet\(redrawWhileStaging\);/,
    'the presentation no longer listens for drafts the composer sets itself',
  );
  const composer = fs.readFileSync(path.join(__dirname, 'composer.ts'), 'utf8');
  const setter = functionBody(composer, 'const setPromptValue = (value: string) => {', 'const showMenuHighlight');
  assert.match(
    setter,
    /prompt\.value = value;\s*draftSetListener\?\.\(\);/,
    'setPromptValue no longer reports the new draft, so history, undo, completion and the clear after send leave the button stale',
  );
  assert.match(
    composer,
    /onDraftSet\(listener\) \{\s*draftSetListener = listener;/,
    'the renderer no longer stores the draft listener',
  );
});

test('the composer writes the prompt value only through setPromptValue', () => {
  const composer = fs.readFileSync(path.join(__dirname, 'composer.ts'), 'utf8');
  const setterStart = 'const setPromptValue = (value: string) => {';
  const setterAt = composer.indexOf(setterStart);
  assert.ok(setterAt >= 0, `${setterStart} is no longer in composer.ts`);
  const setterEnd = composer.indexOf('\n  };', setterAt);
  const outside = composer.slice(0, setterAt) + composer.slice(setterEnd);
  assert.doesNotMatch(
    outside,
    /\bprompt\.value\s*=(?!=)/,
    'a direct prompt.value write skips setPromptValue, so the Send button stays stale until the next keystroke',
  );
  const boxWrites = [...outside.matchAll(/\bslashBox\.value\s*=(?!=)/g)];
  assert.equal(boxWrites.length, 1, 'slashBox.value is written outside the guarded non-prompt branch of takeCommand');
  assert.match(
    outside.slice(0, boxWrites[0].index),
    /if \(slashBox === prompt\) \{\s*setPromptValue\(completed\);\s*\} else \{\s*$/,
    'takeCommand writes slashBox.value directly when slashBox is the prompt',
  );
});
