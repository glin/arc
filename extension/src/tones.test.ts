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

// The fixture declares root tones, light overrides, and text-colour rules.

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
  // A third-opacity orange has less contrast after composition over the dark panel.

  const opaque = contrastOn('#ea5c00', '#1f1f1f');
  const real = contrastOn('#ea5c0055', '#1f1f1f');
  assert.ok(opaque > 4.5, `an opaque orange reads at ${opaque.toFixed(2)}`);
  assert.ok(real < 2, `the same orange at a third opacity reads at ${real.toFixed(2)}`);
});

test('a translucent ground is laid over the panel before it is measured', () => {
  // Compose the translucent white background over the panel before measuring white text contrast.

  assert.ok(
    contrastOn('#ffffff', '#ffffff14', '#121314') > 15,
    'a translucent hover ground was measured as the colour it declares rather than the pixel it draws',
  );
  // With no panel named, the ground goes over black, which is the darkest it can be.
  assert.ok(contrastOn('#ffffff', '#ffffff14') > 16);
  // An opaque background ignores the supplied panel colour.
  assert.equal(contrastOn('#ffffff', '#000000', '#ffffff'), contrastOn('#ffffff', '#000000'));
});

test('a chip mix carries the tone alpha, so a faint tone tints faintly', () => {
  // A 26% mix of a third-opacity tone tints the background by about 9%. Its contrast stays close to plain-panel contrast.

  const faint = chipWorstOf('#ea5c0055', ['#1f1f1f'], 26);
  assert.ok(
    Math.abs(faint - contrastOn('#ea5c0055', '#1f1f1f')) < 0.01,
    `the chip ground was built from the tone as though it were opaque: ${faint.toFixed(3)}`,
  );
  // The opaque tone changes the mixed background and reduces contrast.
  assert.ok(chipWorstOf('#ea5c00', ['#1f1f1f'], 26) < contrastOn('#ea5c00', '#1f1f1f'));
});

test('the worst ground decides, and a tinted chip reads worse than the plain ground', () => {
  const grounds = ['#1f1f1f', '#37373d'];
  assert.equal(worstOf('#cca700', grounds), contrastOn('#cca700', '#37373d'));
  // Tinting the background with the text tone reduces their contrast.

  assert.ok(chipWorstOf('#cca700', grounds, 18) < worstOf('#cca700', grounds));
});

test('the distance matches the published CIEDE2000 vectors', () => {
  // Published CIEDE2000 vectors cover hue wrapping, blue rotation, and zero chroma.

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
    // Compare at the published four-decimal precision.

    assert.equal(
      Number(got.toFixed(4)),
      expected,
      `L*a*b* ${first.join(',')} to ${second.join(',')} gave ${got}, not ${expected}`,
    );
  }
});

test('the hue mean holds at exactly half a turn, and a huge chroma stays a number', () => {
  // The half-turn case checks the distance value. Its negligible rotation term does not distinguish the hue-wrap comparison operators.

  assert.ok(
    Math.abs(labColourDistance([50, 2.5, 0], [50, -2.5, 0]) - 7.2474) < 0.0001,
    `hues half a turn apart gave ${labColourDistance([50, 2.5, 0], [50, -2.5, 0])}`,
  );
  // Reversing either pair preserves its distance.

  assert.equal(labColourDistance([50, 2.5, 0], [50, -2.5, 0]), labColourDistance([50, -2.5, 0], [50, 2.5, 0]));
  assert.ok(
    Math.abs(labColourDistance([50, 2.5, 0], [50, -5, 0]) - 10.5117) < 0.0001,
    `an asymmetric half turn gave ${labColourDistance([50, 2.5, 0], [50, -5, 0])}`,
  );
  // The exported function accepts finite Lab triples beyond the sRGB range and must avoid seventh-power overflow.

  assert.ok(
    Math.abs(labColourDistance([50, 1e50, 0], [50, 0, 0]) - 44.4444) < 0.0001,
    `an enormous chroma gave ${labColourDistance([50, 1e50, 0], [50, 0, 0])}`,
  );
});

test('a colour is converted before it is compared, and an identical pair is no distance', () => {
  assert.equal(colourDistance('#ffc107', '#ffc107'), 0);
  // Identical colours have zero distance over any supplied background.
  assert.equal(colourDistance('#ffc107', '#ffc107', '#ffffff'), 0);
  // Black and white differ by 100 on the Lab lightness axis.

  assert.ok(
    Math.abs(colourDistance('#000000', '#ffffff') - 100) < 0.01,
    `black to white measured ${colourDistance('#000000', '#ffffff').toFixed(3)}`,
  );
  // Check the distance between the two light-theme brown tones.
  assert.ok(
    Math.abs(colourDistance('#7d4e14', '#6b4a00') - 6.215) < 0.01,
    `the two light browns measured ${colourDistance('#7d4e14', '#6b4a00').toFixed(3)}`,
  );
});

test('a distance is measured on the pixel, so a translucent tone is laid down first', () => {
  // The translucent orange lies closer to its background than the opaque orange does.

  const opaque = colourDistance('#ea5c00', '#1f1f1f', '#1f1f1f');
  const faint = colourDistance('#ea5c0055', '#1f1f1f', '#1f1f1f');
  assert.ok(
    faint < opaque / 2,
    `a third-opacity orange measured ${faint.toFixed(1)} against ${opaque.toFixed(1)} opaque`,
  );
});

test('CIE76 would pass a pair this metric refuses, which is why the metric is this one', () => {
  // CIEDE2000 places these blue tones less than two units apart.

  const near = colourDistance('#1f17ee', '#0201ff');
  assert.ok(near < 2, `two blues measured ${near.toFixed(2)} apart`);
  // Both blue tones also exceed 4.5 contrast against white. Contrast alone does not establish their separation.

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

  // Check unique pair keys as well as their total count.

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

  // The light overrides change the warn/busy pair values and distance.

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
  // Compare translucent tones across separate backgrounds to include adjacent cards with different states.

  const css = [
    '',
    ':root {',
    '  --ok: #73c991;',
    '  --bad: #f88070;',
    '  --warn: #bbbc68f8;',
    '  --busy: #eefd5b90;',
    '  --need: #ffa657;',
    '}',
    // toneValue requires both theme blocks even for a dark-only measurement.

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
  // Compare against same-background measurements using the same four backgrounds.

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
  // The selected, unfocused background belongs to one card at a time and cannot supply both sides of a pair.

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
  // Clearing soleGrounds permits both tones on that background and produces a smaller distance.

  const [reported] = rows.filter((r) => r.pair === 'warn/busy');
  const [bothOnIt] = statusToneDistances(css, [
    { id: 'one', kind: 'dark', table: '', grounds: [BACKGROUNDS.dark[3]], soleGrounds: [] },
  ]).filter((r) => r.pair === 'warn/busy');
  assert.ok(
    bothOnIt.distance < reported.distance,
    `both words on ${BACKGROUNDS.dark[3]} give ${bothOnIt.distance.toFixed(3)}, which is not ` +
      `below the ${reported.distance.toFixed(3)} the sweep reports, so this fixture proves nothing`,
  );

  // soleGrounds identifies positions rather than colour values. A matching colour at an unrestricted position remains eligible.

  const spelledAlike = statusToneDistances(css, [
    { id: 'custom', kind: 'dark', table: '', grounds: ['#1f1f1f', BACKGROUNDS.dark[3]] },
  ]).filter((r) => r.pair === 'warn/busy')[0];
  assert.ok(
    spelledAlike.distance <= bothOnIt.distance,
    `a ground the theme never called sole was skipped: the sweep reports ` +
      `${spelledAlike.distance.toFixed(3)} where both words on it give ${bothOnIt.distance.toFixed(3)}`,
  );

  // Reject a background list with no valid placement for two cards.

  assert.throws(
    () =>
      statusToneDistances(css, [
        { id: 'empty', kind: 'dark', table: '', grounds: [BACKGROUNDS.dark[3]], soleGrounds: [0] },
      ]),
    /no two cards can be compared/,
  );

  // Reject soleGrounds indexes outside the supplied background list.

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
  // Selectors supply status tones even when STATUS_TONES omits them.

  assert.deepEqual(statusSelectorTones(css), ['busy', 'paused']);
  assert.ok(
    !statusSelectorTones(css).includes('comment'),
    'a tone drawn somewhere other than a rail status is not a status tone',
  );
});

test('a theme that names its own base is measured over that base, in both sweeps', () => {
  // The explicit base colour determines the translucent background's composite.

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
  // Black text over translucent white on black has about 5.3 contrast.

  assert.ok(
    Math.abs(reading.worst - 5.317) < 0.01,
    `the ground was read as the colour it declares rather than the pixel: ${reading.worst.toFixed(3)}`,
  );
  // Pair distances use the same base colour when compositing translucent tones and backgrounds.

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
  // Attribute values and nested selector arguments must not split the outer selector.

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
  // A subject inside :is() or :where() can name the status element.

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
  // These selectors draw another element or exclude status elements.

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
    // Nested selector arguments must preserve exclusions.

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
  // Read var() fallbacks and ignore commented-out rules.

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
  // All fixtures resolve busy to #00ff00. Comments, longer names, and earlier declarations must not override it.

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
  // Use the fallback when the supplied table has no matching token.
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
  // The custom theme supplies its own warning token and backgrounds.

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
  // The same tone has different contrast on Dark Modern backgrounds.

  assert.notEqual(reading.worst, worstOf('#d19a66', ['#1f1f1f', '#181818', '#2a2d2e', '#37373d']));
});

test('a skipped tone is not measured', () => {
  const readings = measureTones(SHEET, THEMES, { skip: ['alpha', 'token'] });
  assert.deepEqual([...new Set(readings.map((r) => r.tone))], ['plain', 'warn']);
});

test("the request tab's answered value is measured on the chip ground it draws on", () => {
  // Answered request values use ok over the tinted chip background.

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
  // Checked Sort by and Match values share the pressed count rule to keep their tint declarations together.

  const panel = fs.readFileSync(path.join(__dirname, 'webview', 'panel.css'), 'utf8');
  const shared = ruleBody(
    panel,
    ".railcount[aria-pressed='true'], .railfiltermatch .railfilterlabel[aria-checked='true']",
  );
  assert.match(shared, /background:\s*var\(--vscode-list-activeSelectionBackground/);
  assert.match(shared, /border-color:\s*var\(--vscode-focusBorder\)/);
});

test('the running count in a chip popover head wears the busy tone', () => {
  // The running popover count reads the busy tone.

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

// Every AgentState has a glyph tone. States with a separate status word also name its tone.

const SUBAGENT_ROW_TONES: Record<AgentState, { glyph: string; agentstate?: string }> = {
  done: { glyph: 'ok' },
  running: { glyph: 'busy', agentstate: 'busy' },
  open: { glyph: 'idle', agentstate: 'idle' },
  failed: { glyph: 'bad', agentstate: 'bad' },
  interrupted: { glyph: 'idle' },
  stopped: { glyph: 'idle' },
};

// Additional colour rules permitted around subagent rows.
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
  '.projectspendpricing { color: var(--idle) }',
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
  // Collect colour declarations whose selectors reference row classes or have bare subjects. Enclosing conditions distinguish scoped rules.

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
  // Row tones must have no declarations outside the root and light blocks read by toneValue.

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
