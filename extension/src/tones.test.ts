import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BACKGROUNDS,
  CHIP_MIX,
  chipWorstOf,
  colourDistance,
  contrastOn,
  DARK_BLOCK,
  labColourDistance,
  LIGHT_BLOCK,
  measureTones,
  parseColor,
  resolveValue,
  ruleBody,
  SOLE_GROUNDS,
  statusSelectorTones,
  statusToneDistances,
  textToneNames,
  toneUsages,
  toneValue,
  worstOf,
} from './tones.ts';
import { AGENT_ROW_BUILDERS, DARK_MODERN_THEME, LIGHT_MODERN_THEME } from './panelfixture.ts';
import type { AgentState } from './turncard.ts';
import { bareSubject, classWords, cssContract, cssSelectors, namesClassWord } from '../test/source-contract.ts';

// A stylesheet small enough to read in one look, shaped the way panel.css is: a :root block
// that declares every tone, a light block that overrides a few, and rules that paint text.
const SHEET = `
:root {
  --plain: #ffffff;
  --token: var(--vscode-editorWarning-foreground, #d29922);
  --alpha: var(--vscode-charts-orange, #d18616);
  --warn: #cca700;
  --tint: #808080;
}
body.vscode-light, body.vscode-high-contrast-light {
  --plain: #000000;
}
.a { color: var(--plain); }
.b { color: var(--token); }
.c { color: var(--alpha); }
.d { color: var(--warn); }
.e { background: var(--tint); border-color: var(--tint); }
.f { color: var(--vscode-foreground); }
`;

const DARK_TABLE = '--vscode-editorWarning-foreground:#cca700;--vscode-charts-orange:#ea5c0055;';
const LIGHT_TABLE = '--vscode-editorWarning-foreground:#bf8803;--vscode-charts-orange:#ea5c0055;';
const THEMES = [
  { id: 'dark', kind: 'dark', table: DARK_TABLE },
  { id: 'light', kind: 'light', table: LIGHT_TABLE },
] as const;

test('a colour is read as hex, as hex with alpha, and as rgb', () => {
  assert.deepEqual(parseColor('#ff8800'), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor('#ea5c0055'), { r: 234, g: 92, b: 0, a: 85 / 255 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.throws(() => parseColor('rebeccapurple'), /cannot read the colour/);
});

test('the two extremes measure at the ratio the standard names', () => {
  assert.equal(contrastOn('#ffffff', '#000000').toFixed(0), '21');
  assert.equal(contrastOn('#000000', '#000000').toFixed(0), '1');
});

test('a translucent tone is measured at the strength it draws, not at its own hex', () => {
  // charts.orange is orange at a third opacity. Read as an opaque colour it looks readable
  // on a dark panel, and composited over that panel it is the defect this module exists for.
  const opaque = contrastOn('#ea5c00', '#1f1f1f');
  const real = contrastOn('#ea5c0055', '#1f1f1f');
  assert.ok(opaque > 4.5, `an opaque orange reads at ${opaque.toFixed(2)}`);
  assert.ok(real < 2, `the same orange at a third opacity reads at ${real.toFixed(2)}`);
});

test('a translucent ground is laid over the panel before it is measured', () => {
  // Several themes draw a hovered row as a percentage of white over whatever is behind it.
  // Read as written, #ffffff14 is pure white, and a white word on it looks hopeless. Laid
  // over the panel it is a barely lighter dark grey, and the same word is easy to read.
  assert.ok(
    contrastOn('#ffffff', '#ffffff14', '#121314') > 15,
    'a translucent hover ground was measured as the colour it declares rather than the pixel it draws',
  );
  // With no panel named, the ground goes over black, which is the darkest it can be.
  assert.ok(contrastOn('#ffffff', '#ffffff14') > 16);
  // An opaque ground is unchanged, so naming a panel costs nothing where it does not apply.
  assert.equal(contrastOn('#ffffff', '#000000', '#ffffff'), contrastOn('#ffffff', '#000000'));
});

test('a chip mix carries the tone alpha, so a faint tone tints faintly', () => {
  // color-mix multiplies the tone's own alpha into the result. charts.orange is orange at a
  // third opacity, so mixing it at 26% tints the ground by about 9%. Reading the mix as
  // opaque draws a chip far louder than the browser's, and reports the wrong figure for it.
  // A tone at a third opacity barely moves its own ground, so its chip figure sits on top of
  // the plain-panel one. Built from the tone as though it were opaque, the ground shifts far
  // enough to pull the figure away, which is what this measures.
  const faint = chipWorstOf('#ea5c0055', ['#1f1f1f'], 26);
  assert.ok(
    Math.abs(faint - contrastOn('#ea5c0055', '#1f1f1f')) < 0.01,
    `the chip ground was built from the tone as though it were opaque: ${faint.toFixed(3)}`,
  );
  // An opaque tone is unaffected, so carrying the alpha costs nothing where there is none.
  assert.ok(chipWorstOf('#ea5c00', ['#1f1f1f'], 26) < contrastOn('#ea5c00', '#1f1f1f'));
});

test('the worst ground decides, and a tinted chip reads worse than the plain ground', () => {
  const grounds = ['#1f1f1f', '#37373d'];
  assert.equal(worstOf('#cca700', grounds), contrastOn('#cca700', '#37373d'));
  // The chip washes the ground with the same tone the text is drawn in, which pulls the two
  // together. This is the reason a badge cannot fix a contrast failure on its own.
  assert.ok(chipWorstOf('#cca700', grounds, 18) < worstOf('#cca700', grounds));
});

test('the distance matches the published CIEDE2000 vectors', () => {
  // Sharma, Wu and Dalal publish 34 pairs chosen to exercise every discontinuity in the
  // formula: the hue-mean wrap at 0 degrees, the blue rotation term near 275, and the
  // chroma-zero branch. These are the ones that catch an implementation that is merely
  // close. A wrong hue wrap or a dropped rotation term passes a smoke test and fails here.
  const VECTORS: [readonly [number, number, number], readonly [number, number, number], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
    [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    [[50, 2.5, 0], [50, 3.2972, 0], 1.0],
    [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0],
    [[50, 2.5, 0], [50, 3.2592, 0.335], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  for (const [first, second, expected] of VECTORS) {
    const got = labColourDistance(first, second);
    // The published figures carry four decimals, so the result is compared at four decimals.
    // A tolerance wider than that lets a value through that rounds to a different figure.
    assert.equal(
      Number(got.toFixed(4)),
      expected,
      `L*a*b* ${first.join(',')} to ${second.join(',')} gave ${got}, not ${expected}`,
    );
  }
});

test('the hue mean holds at exactly half a turn, and a huge chroma stays a number', () => {
  // Two hues exactly 180 apart sit on the branch the published vectors approach but never
  // land on. The sign the wrap gives the hue difference cannot be read off the result there:
  // it enters squared, and through the rotation term, which at the hue mean this case forces
  // is about 1e-22. Reading the wrap as greater-or-equal gives the same figure to the last
  // digit. What this pins is the value itself, not that branch.
  assert.ok(
    Math.abs(labColourDistance([50, 2.5, 0], [50, -2.5, 0]) - 7.2474) < 0.0001,
    `hues half a turn apart gave ${labColourDistance([50, 2.5, 0], [50, -2.5, 0])}`,
  );
  // The same pair the other way round has to give the same figure, and so does an asymmetric
  // one, where the chroma difference is the term the hue sign would reach if it could.
  assert.equal(labColourDistance([50, 2.5, 0], [50, -2.5, 0]), labColourDistance([50, -2.5, 0], [50, 2.5, 0]));
  assert.ok(
    Math.abs(labColourDistance([50, 2.5, 0], [50, -5, 0]) - 10.5117) < 0.0001,
    `an asymmetric half turn gave ${labColourDistance([50, 2.5, 0], [50, -5, 0])}`,
  );
  // No sRGB colour reaches this chroma, but the function is exported and takes any finite
  // triple. Computed as written, the seventh power overflows and the answer is not a number.
  assert.ok(
    Math.abs(labColourDistance([50, 1e50, 0], [50, 0, 0]) - 44.4444) < 0.0001,
    `an enormous chroma gave ${labColourDistance([50, 1e50, 0], [50, 0, 0])}`,
  );
});

test('a colour is converted before it is compared, and an identical pair is no distance', () => {
  assert.equal(colourDistance('#ffc107', '#ffc107'), 0);
  // A tone against itself over any ground is still zero, so a wrong base cannot hide here.
  assert.equal(colourDistance('#ffc107', '#ffc107', '#ffffff'), 0);
  // sRGB white and black land on the Lab lightness axis at 100 and 0, and CIEDE2000 leaves a
  // pure lightness run alone, so this figure also pins the conversion and not just the metric.
  assert.ok(
    Math.abs(colourDistance('#000000', '#ffffff') - 100) < 0.01,
    `black to white measured ${colourDistance('#000000', '#ffffff').toFixed(3)}`,
  );
  // The two shipped light browns, which is the pair this whole measurement exists for.
  assert.ok(
    Math.abs(colourDistance('#7d4e14', '#6b4a00') - 6.215) < 0.01,
    `the two light browns measured ${colourDistance('#7d4e14', '#6b4a00').toFixed(3)}`,
  );
});

test('a distance is measured on the pixel, so a translucent tone is laid down first', () => {
  // The same orange at a third opacity is most of the way to the ground behind it, so it has
  // to measure closer to that ground than the opaque one does.
  const opaque = colourDistance('#ea5c00', '#1f1f1f', '#1f1f1f');
  const faint = colourDistance('#ea5c0055', '#1f1f1f', '#1f1f1f');
  assert.ok(
    faint < opaque / 2,
    `a third-opacity orange measured ${faint.toFixed(1)} against ${opaque.toFixed(1)} opaque`,
  );
});

test('CIE76 would pass a pair this metric refuses, which is why the metric is this one', () => {
  // Two blues 12.05 apart as a plain Lab distance and 1.77 apart here. A guard built on the
  // plain distance with a floor near 12 would sign these off as separable.
  const near = colourDistance('#1f17ee', '#0201ff');
  assert.ok(near < 2, `two blues measured ${near.toFixed(2)} apart`);
  // Both also clear the contrast bar the other guard applies, so neither guard alone is
  // enough and neither is a substitute for the other.
  assert.ok(
    contrastOn('#1f17ee', '#ffffff') > 4.5 && contrastOn('#0201ff', '#ffffff') > 4.5,
    'both blues read against a light panel, which is what makes them a real trap',
  );
});

test('every status tone pair is measured, in every theme, at its closest ground', () => {
  const css = [
    '',
    ':root {',
    '  --ok: #73c991;',
    '  --bad: #f88070;',
    '  --warn: #ffc107;',
    '  --busy: #d19a66;',
    '  --need: #ffa657;',
    '}',
    'body.vscode-light, body.vscode-high-contrast-light {',
    '  --warn: #665000;',
    '  --busy: #7d4e14;',
    '  --need: #9a4f00;',
    '}',
    '.railstatus.running { color: var(--busy); }',
  ].join('\n');
  const rows = statusToneDistances(css, [
    { id: 'd', kind: 'dark', table: '' },
    { id: 'l', kind: 'light', table: '' },
  ]);

  // The whole key set, not a count. A sweep that returned one pair twice and skipped another
  // has the right length and the wrong contents.
  const keys = rows.map((r) => `${r.theme} ${r.pair}`).sort();
  assert.equal(new Set(keys).size, keys.length, 'a pair was measured twice in one theme');
  assert.equal(keys.length, 20, 'five tones make ten pairs, in two themes');
  assert.deepEqual(
    new Set(rows.filter((r) => r.theme === 'd').map((r) => r.pair)),
    new Set([
      'ok/bad',
      'ok/warn',
      'ok/busy',
      'ok/need',
      'bad/warn',
      'bad/busy',
      'bad/need',
      'warn/busy',
      'warn/need',
      'busy/need',
    ]),
  );

  // The light block overrides three of the five, so a reader that always took the dark
  // declaration would report the same figure in both themes for every pair.
  const darkWarnBusy = rows.find((r) => r.theme === 'd' && r.pair === 'warn/busy')!;
  const lightWarnBusy = rows.find((r) => r.theme === 'l' && r.pair === 'warn/busy')!;
  assert.deepEqual(darkWarnBusy.values, ['#ffc107', '#d19a66']);
  assert.deepEqual(lightWarnBusy.values, ['#665000', '#7d4e14']);
  assert.ok(
    Math.abs(darkWarnBusy.distance - 18.777) < 0.02,
    `dark warn against busy measured ${darkWarnBusy.distance.toFixed(3)}`,
  );
  assert.ok(
    Math.abs(lightWarnBusy.distance - 10.094) < 0.02,
    `light warn against busy measured ${lightWarnBusy.distance.toFixed(3)}`,
  );
  assert.ok(
    rows.every((r) => r.grounds.every((g) => BACKGROUNDS[r.kind].includes(g as never))),
    'a row reported a ground the theme does not have',
  );
});

test('a pair is measured across grounds, because the two words are on different cards', () => {
  // Two translucent tones over the four grounds. A sweep that put both on the panel reports
  // one figure, and the pair sits closer with each word on a ground of its own, which is what
  // the reader meets when one card is hovered or selected and the next is not.
  const css = [
    '',
    ':root {',
    '  --ok: #73c991;',
    '  --bad: #f88070;',
    '  --warn: #bbbc68f8;',
    '  --busy: #eefd5b90;',
    '  --need: #ffa657;',
    '}',
    // toneValue reads both theme blocks whatever kind it is asked for, so a fixture needs
    // the light one present even where nothing here is measured in light.
    'body.vscode-light, body.vscode-high-contrast-light {',
    '  --need: #9a4f00;',
    '}',
    '.railstatus.running { color: var(--busy); }',
  ].join('\n');
  const [onPanel] = statusToneDistances(css, [{ id: 'panel', kind: 'dark', table: '', grounds: ['#1f1f1f'] }]).filter(
    (r) => r.pair === 'warn/busy',
  );
  const [worst] = statusToneDistances(css, [{ id: 'all', kind: 'dark', table: '' }]).filter(
    (r) => r.pair === 'warn/busy',
  );
  assert.ok(
    worst.distance < onPanel.distance,
    `the sweep reported ${worst.distance.toFixed(3)} where the panel alone gives ${onPanel.distance.toFixed(3)}`,
  );
  // The two words land on different grounds, which a same-ground sweep can never report.
  assert.notEqual(
    worst.grounds[0],
    worst.grounds[1],
    `both words were measured on ${worst.grounds[0]}, so no pair of grounds was compared`,
  );
  // A same-ground sweep over the same four grounds still reports a larger figure, so this is
  // the cross-product doing the work and not simply a wider ground list.
  const sameGroundBest = Math.min(
    ...BACKGROUNDS.dark.map(
      (g) =>
        statusToneDistances(css, [{ id: 'one', kind: 'dark', table: '', grounds: [g] }]).filter(
          (r) => r.pair === 'warn/busy',
        )[0].distance,
    ),
  );
  assert.ok(
    worst.distance < sameGroundBest,
    `the cross-product gives ${worst.distance.toFixed(3)} where the best single ground gives ${sameGroundBest.toFixed(3)}`,
  );
});

test('two cards are never compared on a ground only one card can wear', () => {
  // Two translucent tones whose composites sit closest with both words over the row a card
  // wears selected but unfocused. The rail draws one of those rows, so reporting the pair at
  // its closest there names a view nobody can open.
  const css = [
    '',
    ':root {',
    '  --ok: #73c991;',
    '  --bad: #f88070;',
    '  --warn: #9d47b9c5;',
    '  --busy: #aec1bb67;',
    '  --need: #ffa657;',
    '}',
    'body.vscode-light, body.vscode-high-contrast-light {',
    '  --need: #9a4f00;',
    '}',
    '.railstatus.running { color: var(--busy); }',
  ].join('\n');
  const rows = statusToneDistances(css, [{ id: 'all', kind: 'dark', table: '' }]);
  const soleValues = SOLE_GROUNDS.map((at) => BACKGROUNDS.dark[at] as string);
  for (const row of rows) {
    assert.ok(
      !(row.grounds[0] === row.grounds[1] && soleValues.includes(row.grounds[0])),
      `${row.pair} is reported at its closest with both words on ${row.grounds[0]}, ` +
        'which one card wears at a time',
    );
  }
  // And the figure it refused is real, so the skip is doing work rather than describing it.
  // The control names its own ground and says nothing is sole in it, which is the answer to
  // a caller who means that one ground and has no second card to place anywhere else.
  const [reported] = rows.filter((r) => r.pair === 'warn/busy');
  const [bothOnIt] = statusToneDistances(css, [
    { id: 'one', kind: 'dark', table: '', grounds: [BACKGROUNDS.dark[3]], soleGrounds: [] },
  ]).filter((r) => r.pair === 'warn/busy');
  assert.ok(
    bothOnIt.distance < reported.distance,
    `both words on ${BACKGROUNDS.dark[3]} give ${bothOnIt.distance.toFixed(3)}, which is not ` +
      `below the ${reported.distance.toFixed(3)} the sweep reports, so this fixture proves nothing`,
  );

  // A role is a position, not a colour. A theme whose ordinary panel is spelled the way the
  // shipped dark theme spells its selected row keeps every combination, because nothing in
  // that theme says a row wears it alone.
  const spelledAlike = statusToneDistances(css, [
    { id: 'custom', kind: 'dark', table: '', grounds: ['#1f1f1f', BACKGROUNDS.dark[3]] },
  ]).filter((r) => r.pair === 'warn/busy')[0];
  assert.ok(
    spelledAlike.distance <= bothOnIt.distance,
    `a ground the theme never called sole was skipped: the sweep reports ` +
      `${spelledAlike.distance.toFixed(3)} where both words on it give ${bothOnIt.distance.toFixed(3)}`,
  );

  // And a theme that leaves itself nowhere to put two cards is a caller error, not a pair
  // quietly reported at no distance at all.
  assert.throws(
    () =>
      statusToneDistances(css, [
        { id: 'empty', kind: 'dark', table: '', grounds: [BACKGROUNDS.dark[3]], soleGrounds: [0] },
      ]),
    /no two cards can be compared/,
  );

  // A position that names no ground takes no combination out, so a caller who miscounts
  // believes a rule is in force that never ran. Each of these says so instead.
  for (const soleGrounds of [[-1], [1], [1.5]]) {
    assert.throws(
      () =>
        statusToneDistances(css, [{ id: 'off', kind: 'dark', table: '', grounds: [BACKGROUNDS.dark[3]], soleGrounds }]),
      /calls ground .* sole, and it gives 1 grounds/,
      `soleGrounds ${JSON.stringify(soleGrounds)} named no ground and was accepted`,
    );
  }
  assert.throws(
    () => statusToneDistances(css, [{ id: 'none', kind: 'dark', table: '', grounds: [] }]),
    /gives no ground to measure a tone on/,
  );
});

test('a tone the stylesheet gives a rail status is found, whoever wrote the list', () => {
  const css = [
    '',
    ':root {',
    '  --busy: #d19a66;',
    '  --paused: #d19a66;',
    '  --comment: #d18616;',
    '}',
    '.railstatus.running { color: var(--busy); }',
    '.railstatus.paused { color: var(--paused); }',
    '.cmt { color: var(--comment); }',
  ].join('\n');
  // This is the hole the written-out list leaves. A new status tone reaches the rail without
  // reaching STATUS_TONES, and the sweep never compares it against anything.
  assert.deepEqual(statusSelectorTones(css), ['busy', 'paused']);
  assert.ok(
    !statusSelectorTones(css).includes('comment'),
    'a tone drawn somewhere other than a rail status is not a status tone',
  );
});

test('a theme that names its own base is measured over that base, in both sweeps', () => {
  // A ground list that does not lead with an opaque panel colour. Read without the base, the
  // translucent white ground measures as pure white and both readings are wrong.
  const css = [
    '',
    ':root {',
    '  --ok: #73c991;',
    '  --bad: #000000;',
    '  --warn: #ffc10780;',
    '  --busy: #d19a66;',
    '  --need: #ffa657;',
    '}',
    'body.vscode-light, body.vscode-high-contrast-light {',
    '  --need: #9a4f00;',
    '}',
    '.railstatus.running { color: var(--busy); }',
    '.a { color: var(--bad); }',
  ].join('\n');
  const theme = {
    id: 'odd',
    kind: 'dark' as const,
    table: '',
    grounds: ['#ffffff80'],
    base: '#000000',
  };
  // --bad has no chip of its own, so this is the plain ground reading and nothing else.
  const [reading] = measureTones(css, [theme]).filter((r) => r.tone === 'bad');
  // Black on translucent white over black is black on mid grey, which is about 5.3 to 1.
  // Read as opaque white it would be the full 21.
  assert.ok(
    Math.abs(reading.worst - 5.317) < 0.01,
    `the ground was read as the colour it declares rather than the pixel: ${reading.worst.toFixed(3)}`,
  );
  // The pair sweep composites over the same base, so both functions agree about the ground.
  // --warn is translucent here, so the ground it is laid over decides where it lands. Read
  // without the base, the translucent ground is taken for opaque white and the pair moves.
  const [pair] = statusToneDistances(css, [theme]).filter((r) => r.pair === 'bad/warn');
  const [asOpaque] = statusToneDistances(css, [{ ...theme, grounds: ['#ffffff'] }]).filter(
    (r) => r.pair === 'bad/warn',
  );
  assert.notEqual(
    pair.distance.toFixed(3),
    asOpaque.distance.toFixed(3),
    'the pair sweep ignored the base and measured over opaque white',
  );
});

test('a rail status is recognised however its rule is written', () => {
  const sheet = (selector: string) =>
    ['', ':root {', '  --t: #d19a66;', '}', `${selector} { color: var(--t); }`].join('\n');
  // Every one of these paints the status word itself.
  for (const selector of [
    '.railstatus',
    '.railstatus.running',
    ".railstatus[data-state='paused']",
    '.railcard:hover .railstatus',
    '.other, .railstatus',
    '.railstatus, .other',
  ]) {
    assert.deepEqual(
      statusSelectorTones(sheet(selector)),
      ['t'],
      `${selector} paints a rail status word and was not recognised`,
    );
  }
  // An attribute value can hold a comma or a combinator, and the arguments of a functional
  // pseudo-class can hold a whole selector. Neither says what element is being drawn, so both
  // are emptied before anything is split.
  for (const selector of [
    '.railstatus[data-state=">"]',
    '.railstatus[data-state="+"]',
    '.railstatus[data-state=" "]',
    '.railstatus[data-state=","]',
    '.railstatus::before',
  ]) {
    assert.deepEqual(
      statusSelectorTones(sheet(selector)),
      ['t'],
      `${selector} paints a rail status word and was not recognised`,
    );
  }
  // A functional pseudo-class can be the subject itself, and then every selector inside it is
  // the element being drawn.
  for (const selector of [
    ':is(.railstatus, .other)',
    ':where(.railstatus)',
    '.other:is(.railstatus)',
    '.railcard :is(.railstatus, .other)',
    ':is(.other, .railstatus)::before',
    '.railcard:has(.railpin) .railstatus',
  ]) {
    assert.deepEqual(
      statusSelectorTones(sheet(selector)),
      ['t'],
      `${selector} paints a rail status word and was not claimed as one`,
    );
  }
  // None of these does. The element being drawn is the one after the last combinator, and in
  // each of these that element stands next to a status, or is everything that is not one.
  for (const selector of [
    '.railstatus + .railwhen',
    '.railstatus > .railicon',
    '.railstatus ~ .railagent',
    '.railstatus .inner',
    '.railstatusbar',
    ':not(.railstatus)',
    ':not(.railstatus.running)',
    ':is(.railstatus, .other) .child',
    ':where(.railstatus, .other) .child',
    '.railstatus[data-state=","] .child',
    // Nested brackets. One emptying pass reaches only the innermost pair, which leaves the
    // name standing inside the outer one and turns a rule that paints everything except a
    // status into a rule that paints one.
    ':not(:is(.other), .railstatus)',
    ':is(:where(.railstatus), .other) .child',
    // :has() tests what stands near the element, so the element drawn is what is outside it.
    '.other:has(+ .railstatus)',
    '.other:has(.railstatus)',
    '.other:has(:is(.railstatus))',
    // An argument of :is() is a whole selector, so its own subject is its last compound.
    ':is(.railstatus .child, .other)',
    ':is(.railstatus .child, .other)::before',
  ]) {
    assert.deepEqual(
      statusSelectorTones(sheet(selector)),
      [],
      `${selector} does not paint a rail status word and was claimed as one`,
    );
  }
});

test('the scan reads the rules that ship, and the whole of what each one names', () => {
  // A fallback after the name is ordinary CSS, and a rule commented out draws nothing. Read
  // the first way, a new rail tone escapes every comparison. Read the second way, the guard
  // demands a tone for a rule the browser threw away.
  const withFallback = [
    '',
    ':root {',
    '  --paused: #d19a66;',
    '}',
    'body.vscode-light, body.vscode-high-contrast-light {',
    '  --paused: #7d4e14;',
    '}',
    '.railstatus.paused { color: var(--paused, #654321); }',
  ].join('\n');
  assert.deepEqual(
    statusSelectorTones(withFallback),
    ['paused'],
    'a tone painted through a var with a fallback was not found',
  );
  const commentedOut = [
    '',
    ':root {',
    '  --paused: #d19a66;',
    '}',
    'body.vscode-light, body.vscode-high-contrast-light {',
    '  --paused: #7d4e14;',
    '}',
    '/* .railstatus.paused { color: var(--paused); } */',
  ].join('\n');
  assert.deepEqual(statusSelectorTones(commentedOut), [], 'a rule inside a comment was read as a rule that ships');
});

test('a tone is read as the browser reads it, not as the file first mentions it', () => {
  // Four ways a stylesheet says one thing and a careless reader says another. Every sheet
  // here draws `#00ff00`, and every one of them reports a different colour to a reader that
  // takes the first match, trusts a comment, lets a comment end a rule, or finds a short
  // name inside a longer one. A guard reading any of those measures a colour nobody sees.
  const LIGHT = ['body.vscode-light, body.vscode-high-contrast-light {', '  --ok: #116329;', '}'];
  const sheet = (...root: string[]) => ['', ':root {', ...root, '}', ...LIGHT].join('\n');
  const cases: Array<[string, string[]]> = [
    ['the first declaration was read, and the browser draws the last', ['  --busy: #d19a66;', '  --busy: #00ff00;']],
    ['a declaration inside a comment was read as one', ['  /* --busy: #d19a66; */', '  --busy: #00ff00;']],
    ['a closing brace inside a comment ended the rule early', ['  /* one } two */', '  --busy: #00ff00;']],
    ['--busy was found inside --busycount', ['  --busycount: #d19a66;', '  --busy: #00ff00;']],
  ];
  for (const [why, root] of cases) {
    assert.equal(toneValue(sheet(...root), '', 'busy', 'dark'), '#00ff00', why);
  }
  // A second rule with the same selector, which the browser reads as well as the first.
  const twiceOver = ['', ':root {', '  --busy: #d19a66;', '}', ...LIGHT, ':root {', '  --busy: #00ff00;', '}'].join(
    '\n',
  );
  assert.equal(toneValue(twiceOver, '', 'busy', 'dark'), '#00ff00', 'only the first rule with that selector was read');
  // And an important declaration wins wherever it stands.
  assert.equal(
    toneValue(sheet('  --busy: #00ff00 !important;', '  --busy: #d19a66;'), '', 'busy', 'dark'),
    '#00ff00',
    'an ordinary declaration beat an important one',
  );
  // And the light block wins only where it declares the tone itself.
  assert.equal(
    toneValue(sheet('  --busy: #00ff00;'), '', 'busy', 'light'),
    '#00ff00',
    'a tone the light block never declares was not read from the dark block',
  );
});

test('a rule is found by its exact selector, and a missing one says so', () => {
  assert.match(ruleBody(SHEET, ':root'), /--plain: #ffffff;/);
  assert.doesNotMatch(ruleBody(SHEET, 'body.vscode-light, body.vscode-high-contrast-light'), /--token/);
  const wrapped = [
    '.chips,',
    '.sessionstats {',
    '  color: var(--idle);',
    '}',
    '.chips .warn {',
    '  color: var(--warn);',
    '}',
    '@media (max-width: 400px) {',
    '  .chips, .sessionstats {',
    '    color: var(--narrow);',
    '  }',
    '}',
    '@supports (display: grid) {',
    '.chips, .sessionstats { color: var(--grid); }',
    '}',
  ].join('\n');
  assert.equal(
    ruleBody(wrapped, '.chips, .sessionstats').trim(),
    'color: var(--idle);',
    'a wrapped selector list, a longer selector, or a rule nested in an at-rule was read as the top-level rule',
  );
  assert.throws(() => ruleBody(wrapped, '.warn'), /has no "\.warn" rule/);
  assert.throws(() => ruleBody(SHEET, '.nothing'), /has no "\.nothing" rule/);
});

test('a declaration is resolved through its token and then through its fallback', () => {
  assert.equal(resolveValue('#123456', DARK_TABLE), '#123456');
  assert.equal(resolveValue('var(--vscode-editorWarning-foreground, #d29922)', DARK_TABLE), '#cca700');
  assert.equal(resolveValue('var(--vscode-editorWarning-foreground, #d29922)', LIGHT_TABLE), '#bf8803');
  // The fallback is only for a host that sends no table at all, so it answers last.
  assert.equal(resolveValue('var(--vscode-missing, #d29922)', DARK_TABLE), '#d29922');
  assert.throws(() => resolveValue('var(--vscode-missing)', DARK_TABLE), /no fallback/);
});

test('only a tone the stylesheet paints text with is collected', () => {
  const found = textToneNames(SHEET);
  assert.deepEqual(found, ['alpha', 'plain', 'token', 'warn']);
  // --tint fills and outlines but never carries a word, so no contrast bar applies to it.
  assert.ok(!found.includes('tint'));
  // A --vscode-* name is the editor's own, not one of this stylesheet's tones.
  assert.ok(!found.includes('vscode-foreground'));
});

test('a tone reports every selector that paints text with it', () => {
  const usages = toneUsages(SHEET);
  assert.deepEqual(usages.plain, ['.a']);
  assert.deepEqual(usages.warn, ['.d']);
  // A tone that only fills or outlines is drawn nowhere as text, so it has no entry at all.
  assert.equal(usages.tint, undefined);
});

test('a light override is read for light and the dark declaration for dark', () => {
  assert.equal(toneValue(SHEET, DARK_TABLE, 'plain', 'dark'), '#ffffff');
  assert.equal(toneValue(SHEET, LIGHT_TABLE, 'plain', 'light'), '#000000');
  // --token has no light override, so light falls back to the :root declaration, which the
  // light theme table then answers differently on its own.
  assert.equal(toneValue(SHEET, LIGHT_TABLE, 'token', 'light'), '#bf8803');
  assert.throws(() => toneValue(SHEET, DARK_TABLE, 'gone', 'dark'), /no longer sets --gone/);
});

test('every tone is measured in both kinds, and a chip tone through its own mix', () => {
  const readings = measureTones(SHEET, THEMES);
  assert.deepEqual([...new Set(readings.map((r) => r.tone))], ['alpha', 'plain', 'token', 'warn']);
  assert.deepEqual([...new Set(readings.map((r) => r.theme))], ['dark', 'light']);

  const alphaDark = readings.find((r) => r.tone === 'alpha' && r.theme === 'dark');
  assert.equal(alphaDark?.value, '#ea5c0055');
  assert.ok(alphaDark.worst < 2, `the translucent tone reads at ${alphaDark.worst.toFixed(2)}`);

  // --warn shares the context chip, so its figure is taken through that chip's 18% wash.
  const warnDark = readings.find((r) => r.tone === 'warn' && r.theme === 'dark');
  assert.equal(warnDark?.chipMix, 18);
  assert.equal(warnDark?.worst, chipWorstOf('#cca700', ['#1f1f1f', '#181818', '#2a2d2e', '#37373d'], 18));

  // --plain is drawn on the panel itself, so no chip mix applies.
  assert.equal(readings.find((r) => r.tone === 'plain')?.chipMix, null);
});

test('a theme brings its own grounds, and its own value for a token', () => {
  // One Dark Pro Darker is a dark theme with a bluish-grey ground of its own and a brown
  // where Dark Modern sends a yellow. A reading taken against Dark Modern answers for
  // neither, which is why a theme carries both its table and its grounds.
  const installed = {
    id: 'onedark',
    kind: 'dark' as const,
    table: '--vscode-editorWarning-foreground:#d19a66;--vscode-charts-orange:#ea5c0055;',
    grounds: ['#23272e', '#1e2227', '#2c313a', '#323842'],
  };
  const [reading] = measureTones(SHEET, [installed], { skip: ['alpha', 'plain', 'warn'] });
  assert.equal(reading.theme, 'onedark');
  assert.equal(reading.value, '#d19a66');
  assert.equal(reading.worst, worstOf('#d19a66', installed.grounds));
  // The same tone against Dark Modern's grounds is a different figure, so the grounds are
  // doing work rather than being carried around.
  assert.notEqual(reading.worst, worstOf('#d19a66', ['#1f1f1f', '#181818', '#2a2d2e', '#37373d']));
});

test('a skipped tone is not measured', () => {
  const readings = measureTones(SHEET, THEMES, { skip: ['alpha', 'token'] });
  assert.deepEqual([...new Set(readings.map((r) => r.tone))], ['plain', 'warn']);
});

test("the request tab's answered value is measured on the chip ground it draws on", () => {
  // .casktab draws on --chipbg, and .casktabpick and .casktabtick draw --ok inside it, so
  // the pixel behind that value is the panel tinted rather than the panel. Measured on the
  // plain panel, --ok reports a figure no reader ever sees. This reads the real stylesheet
  // because the table it checks is about the real stylesheet's own grounds.
  const mix = CHIP_MIX.ok;
  assert.ok(mix !== undefined, 'panel.css draws --ok inside .casktab, whose ground is --chipbg');
  const panel = fs.readFileSync(path.join(__dirname, 'webview', 'panel.css'), 'utf8');
  for (const [kind, table] of [
    ['dark', DARK_MODERN_THEME],
    ['light', LIGHT_MODERN_THEME],
  ] as const) {
    const value = toneValue(panel, table, 'ok', kind);
    const grounds = BACKGROUNDS[kind];
    const chip = chipWorstOf(value, grounds, mix, grounds[0]);
    assert.ok(
      chip < worstOf(value, grounds, grounds[0]),
      `--ok reads no worse inside the tab chip than on the plain ${kind} panel, so the mix is wrong`,
    );
    assert.ok(chip >= 4.5, `--ok reads at ${chip.toFixed(2)} to 1 inside the tab chip on a ${kind} panel`);
  }
});

test('the checked Sort by and Match values reuse the rule the pressed rail count wears', () => {
  // The two values wear the same tint the pressed rail count wears, and the sheet says so by
  // declaring both selectors on the one rule. Two rules with the same values would let one
  // drift from the other with nothing to catch it.
  const panel = fs.readFileSync(path.join(__dirname, 'webview', 'panel.css'), 'utf8');
  const shared = ruleBody(
    panel,
    ".railcount[aria-pressed='true'], .railfiltermatch .railfilterlabel[aria-checked='true']",
  );
  assert.match(shared, /background:\s*var\(--vscode-list-activeSelectionBackground/);
  assert.match(shared, /border-color:\s*var\(--vscode-focusBorder\)/);
});

test('the running count in a chip popover head wears the busy tone', () => {
  // The count is the one figure in a head that moves while the reader looks at it, and the tone
  // is all that says so. A browser test would read the drawn colour, which the Tests rule in
  // CLAUDE.md forbids, so the guard reads the rule and the declaration the rule points at.
  const panel = fs.readFileSync(path.join(__dirname, 'webview', 'panel.css'), 'utf8');
  assert.match(
    ruleBody(panel, '.chippopvalue.is-busy'),
    /color:\s*var\(--busy\)/,
    'the running count in a chip popover head no longer takes --busy',
  );
  for (const [kind, table] of [
    ['dark', DARK_MODERN_THEME],
    ['light', LIGHT_MODERN_THEME],
  ] as const) {
    // `toneValue` throws when panel.css declares no --busy for this ground.
    assert.ok(toneValue(panel, table, 'busy', kind), `panel.css sets no --busy for a ${kind} panel`);
  }
});

// The tone each subagent row state gives its mark and its state word. A state with no word of
// its own, such as done, leaves the word to the row. The table is keyed on every state a row can
// take, so a state the row gains fails the typecheck until it is given its tones here.
const SUBAGENT_ROW_TONES: Record<AgentState, { glyph: string; agentstate?: string }> = {
  done: { glyph: 'ok' },
  running: { glyph: 'busy', agentstate: 'busy' },
  open: { glyph: 'idle', agentstate: 'idle' },
  failed: { glyph: 'bad', agentstate: 'bad' },
  interrupted: { glyph: 'idle' },
  stopped: { glyph: 'idle' },
};

// Every other rule that can colour a row's mark, its state word or an element around them.
const SUBAGENT_ROW_OTHER_COLOURS = [
  '#prompt { color: var(--vscode-input-foreground, var(--vscode-foreground)) }',
  '#prompt::placeholder { color: var(--vscode-input-placeholderForeground, var(--idle)) }',
  '.actrow.done .actglyph { color: var(--ok) }',
  '.actrow.run.done .actglyph { color: var(--idle) }',
  '.actrow.run.running { color: var(--vscode-foreground) }',
  '.actrow.running .actglyph { color: var(--busy) }',
  '.actskills.detail-pinned { color: var(--vscode-textLink-foreground) }',
  '.acttool.detail-pinned { color: var(--vscode-textLink-foreground) }',
  '.add { color: var(--add) }',
  '.agentrow .agentfacts { color: var(--idle) }',
  '.agentrow .agenthead .namelink { color: inherit }',
  '.agentrow .namelink:focus-visible { color: var(--vscode-textLink-foreground) }',
  '.agentrow .namelink:hover { color: var(--vscode-textLink-foreground) }',
  '.chippop.chippop-skills .chippopsublist { color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)) }',
  '.chippopcachehit.is-warning { color: var(--warn) }',
  '.chippopfoot { color: var(--idle) }',
  '.chippopitem::marker { color: var(--idle) }',
  '.chippopline:first-child { color: var(--vscode-foreground) }',
  '.chippopmuted { color: var(--idle) }',
  '.chippopnamelink { color: var(--vscode-textLink-foreground) }',
  '.chippoppath { color: color-mix(in srgb, var(--vscode-editorWidget-foreground, var(--vscode-foreground)) 78%, transparent) }',
  '.chippopscale { color: var(--idle) }',
  '.chippopsubitem.chippopcost { color: var(--vscode-foreground) }',
  '.chippopsubitem::marker { color: var(--idle) }',
  '.chippopsublist { color: var(--idle) }',
  '.chippopvalue.is-busy { color: var(--busy) }',
  '.chippopwarning { color: var(--warn) }',
  '.chips .warn { color: var(--warn) }',
  '.clive .head:hover .when { color: inherit }',
  '.commitgroupfact { color: var(--idle) }',
  '.commitgroupname { color: var(--vscode-foreground) }',
  '.commitgrouprepo { color: var(--idle) }',
  '.commitheadfact { color: var(--idle) }',
  '.commitmakerword { color: var(--idle) }',
  '.commitrow .commitfacts { color: color-mix(in srgb, var(--vscode-editorWidget-foreground, var(--vscode-foreground)) 78%, transparent) }',
  '.compaction .glyph { color: var(--idle) }',
  '.controls select { color: var(--vscode-dropdown-foreground, var(--vscode-foreground)) }',
  '.del { color: var(--del) }',
  '.dim { color: var(--idle) }',
  '.done .glyph { color: var(--ok) }',
  '.editor-link { color: var(--vscode-textLink-foreground) }',
  '.effort { color: var(--idle) }',
  '.empty .dim { color: var(--idle) }',
  '.failed .glyph { color: var(--bad) }',
  '.headline strong { color: var(--vscode-foreground) }',
  '.hidden-note button { color: var(--vscode-textLink-foreground) }',
  '.hintcard .railstats .ctx-filling { color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)) }',
  '.hintcard .railstats .ctx-getting-full { color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)) }',
  '.hintcard .railstats .ctx-nearly-full { color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)) }',
  '.interrupted .glyph { color: var(--idle) }',
  '.linemark { color: var(--idle) }',
  '.linemark:focus-visible { color: var(--vscode-textLink-foreground) }',
  '.linemark:hover { color: var(--vscode-textLink-foreground) }',
  ".linemark[aria-expanded='true'] { color: var(--vscode-textLink-foreground) }",
  '.model { color: var(--idle) }',
  '.more { color: var(--vscode-textLink-foreground) }',
  '.noteact { color: var(--vscode-textLink-foreground) }',
  '.notearea { color: var(--vscode-input-foreground) }',
  '.noteclose { color: var(--idle) }',
  '.noteclose:hover { color: var(--vscode-foreground) }',
  '.notequote { color: var(--idle) }',
  '.notesave { color: var(--vscode-button-foreground, #fff) }',
  '.pop { color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)) }',
  '.prompt { color: var(--idle) }',
  '.quoteact { color: var(--vscode-button-foreground, #fff) }',
  '.railfiltertools > button { color: var(--idle) }',
  '.railstats .ctx-filling { color: var(--notice) }',
  '.railstats .ctx-getting-full { color: var(--warn) }',
  '.railstats .ctx-nearly-full { color: var(--full) }',
  '.railstats { color: var(--idle) }',
  '.railstatus.running { color: var(--busy) }',
  '.row .ficon { color: var(--idle) }',
  '.running .glyph { color: var(--busy) }',
  '.session .twist { color: var(--idle) }',
  '.session { color: var(--vscode-foreground) }',
  '.session:hover { color: var(--vscode-textLink-foreground) }',
  '.sessiondetails dt { color: var(--idle) }',
  '.sessionstats .warn { color: var(--warn) }',
  '.sha { color: var(--vscode-textLink-foreground) }',
  '.statbusy { color: var(--busy) }',
  '.statwarningsign { color: var(--warn) }',
  '.stopped .glyph { color: var(--idle) }',
  '.summary .image-link { color: inherit }',
  '.summary a { color: var(--vscode-textLink-foreground) }',
  '.summary blockquote { color: var(--idle) }',
  '.summary strong { color: var(--vscode-foreground) }',
  'body { color: var(--vscode-foreground) }',
  'button.commitmakerlink { color: var(--vscode-textLink-foreground) }',
  'button.head:hover .durationfact { color: var(--vscode-textLink-foreground) }',
  'button.head:hover .when { color: var(--vscode-textLink-foreground) }',
  'button.sha { color: var(--vscode-textLink-foreground) }',
  'button.statchip { color: inherit }',
  'button:where(.session, .head, .row, .result, .railcard) { color: inherit }',
];

test('each subagent row state draws its mark and its word in its own tone', () => {
  // A browser test would read the drawn colour, which the Tests rule in CLAUDE.md forbids. The
  // scan resolves no cascade either. The classes come from the builders of the row and of both
  // figure popovers, as every word their strings hold. A selector can colour the row when it, or
  // a rule it is nested in, names one of those words anywhere, or when its subject is a bare tag
  // or `*`, because the mark and the state word are both spans.
  // Every colour declaration of such a selector is held to one list, keyed by its whole selector
  // with its at-rules and parents, so a rule of any shape in any theme is an entry of its own.
  const panel = fs.readFileSync(path.join(__dirname, 'webview', 'panel.css'), 'utf8');
  const rowClasses = classWords(AGENT_ROW_BUILDERS.map((file) => path.join(__dirname, file)));
  const rules = cssContract(panel);
  const found: string[] = [];
  for (const rule of rules) {
    // A property name is read in any case, and `all` resets the colour with everything else.
    const colours = rule.declarations.filter((text) => /^(color|all):/i.test(text));
    for (const selector of cssSelectors(rule.selector)) {
      if (!namesClassWord([...rule.conditions, selector].join(' '), rowClasses) && !bareSubject(selector)) continue;
      found.push(...colours.map((colour) => `${[...rule.conditions, selector].join(' { ')} { ${colour} }`));
    }
  }
  const wanted = [
    ...SUBAGENT_ROW_OTHER_COLOURS,
    '.context-categories li { color: var(--vscode-foreground) }',
    '.context-table thead th { color: var(--vscode-foreground) }',
    '.context-columns > span { color: var(--vscode-foreground) }',
  ];
  for (const [state, tones] of Object.entries(SUBAGENT_ROW_TONES)) {
    for (const [part, tone] of Object.entries(tones)) {
      wanted.push(`.agentrow[data-state='${state}'] .${part} { color: var(--${tone}) }`);
    }
  }
  assert.deepEqual(
    found.sort(),
    wanted.sort(),
    'a rule that can colour a subagent row mark or state word was added, removed or changed',
  );
  // A tone the row reads is declared only in the dark and light blocks `toneValue` reads, so a
  // copy scoped to the row or to a state cannot give the row a tone other than the one read here.
  const read = new Set(found.flatMap((entry) => [...entry.matchAll(/var\(--([\w-]+)\)/g)].map((match) => match[1])));
  const scoped = rules.flatMap((rule) =>
    rule.conditions.length === 0 && (rule.selector === DARK_BLOCK || rule.selector === LIGHT_BLOCK)
      ? []
      : rule.declarations
          .filter((text) => read.has(/^--([\w-]+):/.exec(text)?.[1] ?? ''))
          .map((text) => `${[...rule.conditions, rule.selector].join(' { ')} { ${text} }`),
  );
  assert.deepEqual(scoped, [], 'a tone a subagent row reads is declared outside the dark and light blocks');
  // The editor writes every `--vscode-*` variable, so `toneValue` reads only the tones panel.css
  // declares itself.
  for (const tone of [...read].filter((name) => !name.startsWith('vscode-'))) {
    for (const [kind, table] of [
      ['dark', DARK_MODERN_THEME],
      ['light', LIGHT_MODERN_THEME],
    ] as const) {
      // `toneValue` throws when panel.css declares no such tone for this ground.
      assert.ok(toneValue(panel, table, tone, kind), `panel.css sets no --${tone} for a ${kind} panel`);
    }
  }
});
