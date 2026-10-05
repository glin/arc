// Writes the tone sheet: measured panel.css tones, including lower-priority text and nontext
// marks, the value each theme resolves them to, text ratios against their worst ground, and
// the selectors that paint with them. Open it beside a mockup and pick a theme.
//
// Run from extension/:  npx tsx ../.claude/skills/panel-mockup/tone-sheet.ts <dir>
//
// It needs panel-snapshot.css, mock.css and theme-switch.js in the same directory, so run
// snapshot-css.ts first. Nothing here is written by hand. Every figure is measured from the
// stylesheet through tones.ts. The sheet and guard cover different themes, exclusions, and
// known-failure rules. docs/ui-design.md defines their boundary.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CHIP_MIX, EXCLUDED_TONES, measureTones, toneUsages } from '../../../extension/src/tones.ts';
import { MOCK_THEMES, groundsOf } from './themes.ts';
import { fillPanelText, panelValues } from '../../../extension/src/paneltext.ts';

const out = process.argv[2] || '.';
const root = path.resolve(__dirname, '..', '..', '..');
const panel = fillPanelText(
  fs.readFileSync(path.join(root, 'extension', 'src', 'webview', 'panel.css'), 'utf8'),
  panelValues(),
);

// Every tone is measured, the excluded ones included, because the sheet is a reference and a
// reader looking up --edge deserves an answer. The exclusions carry their reason instead of
// a marked failure, which is the same list the contrast guard skips.
const themes = MOCK_THEMES.map((t) => ({ id: t.id, kind: t.kind, table: t.table, grounds: groundsOf(t) }));
const readings = measureTones(panel, themes);
const usages = toneUsages(panel);
const tones = [...new Set(readings.map((r) => r.tone))];

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function reading(tone: string, theme: string) {
  const found = readings.find((r) => r.tone === tone && r.theme === theme);
  if (!found) { throw new Error(`no ${theme} reading for --${tone}`); }
  return found;
}

const rows = tones.map((tone) => {
  const mix = CHIP_MIX[tone];
  const excused = EXCLUDED_TONES[tone];
  const where = (usages[tone] ?? []).join(', ');
  const ground = excused ?? (mix === undefined ? 'the panel' : `a chip washed ${mix}% in this tone`);
  // The value column shows only the theme on screen, so the swatch beside it always agrees.
  const values = MOCK_THEMES
    .map((t) => `<code class="tsonly tsonly-${t.id}">${escape(reading(tone, t.id).value)}</code>`)
    .join('');
  const figures = MOCK_THEMES.map((t) => {
    const { worst } = reading(tone, t.id);
    return `        <td class="tsnum${!excused && worst < 4.5 ? ` tsfail-${t.id}` : ''}">${worst.toFixed(2)}</td>`;
  }).join('\n');
  return `      <tr${excused ? ' class="tsexcused"' : ''}>
        <th scope="row"><code>--${tone}</code></th>
        <td><span class="tsword" style="color: var(--${tone})">${escape(tone)}</span></td>
        <td>${values}</td>
${figures}
        <td class="tsidle">${escape(ground)}</td>
        <td class="tsidle tswhere"><code>${escape(where)}</code></td>
      </tr>`;
}).join('\n');

// A figure is marked only for the theme on screen, so the sheet reads as one answer and not
// as three. Both rules are written per theme rather than as a single "not light" selector,
// because a third theme is a dark one and neither half of a two-way rule would answer it.
const themeRules = MOCK_THEMES.map((t) => `  html.theme-${t.id} .tsfail-${t.id} {`
  + ' color: var(--vscode-foreground); font-weight: 700; }\n'
  + `  html.theme-${t.id} .tsonly:not(.tsonly-${t.id}) { display: none; }`).join('\n');

const headings = MOCK_THEMES.map((t) => `<th scope="col" class="tsnum">${escape(t.label)}</th>`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Panel tone sheet</title>
<link rel="stylesheet" href="panel-snapshot.css">
<link rel="stylesheet" href="mock.css">
<style>
  .tssheet { border-collapse: collapse; font-size: 12px; }
  .tssheet th, .tssheet td { padding: 4px 14px 4px 0; text-align: left; vertical-align: top; }
  .tssheet thead th { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--idle); }
  .tssheet tbody th { font-weight: 400; }
  .tsword { font-weight: 600; }
  .tsnum { font-variant-numeric: tabular-nums; text-align: right; }
  .tsidle { color: var(--idle); }
  .tswhere { max-width: 460px; }
  /* A ratio under 4.5, marked in weight and in the theme's own foreground rather than in a
     colour, because a colour that marks a contrast failure has to clear the same bar. */
${themeRules}
  /* An excluded tone has no marked failure. --idle carries lower-priority text. */
  .tsexcused .tsnum { color: var(--idle); }
</style>
</head>
<body class="vscode-dark">
<div class="mocktheme"></div>
<h1>Panel tone sheet</h1>
<p class="lead">Every measured <code>panel.css</code> tone appears here, including excluded lower-priority text and nontext
marks. Pick a theme at the top right to move the page: the swatch, the value and the marked
figures all follow it. A ratio is the WCAG figure for text against the worst of the four grounds
a card can sit on in that theme, taken through the tone's own chip where it has one. Text needs
4.5 to 1. A figure under that is marked in bold for the theme on screen. An exclusion says why it
has no marked failure. <code>--idle</code> carries lower-priority text.</p>
<p class="lead">This page is generated. Every figure is measured from the stylesheet by
<code>extension/src/tones.ts</code>, which is the module the contrast guard in
<code>panel.webview.test.ts</code> uses. The sheet and guard cover different themes,
exclusions, and known-failure rules. See <code>docs/ui-design.md</code> for their boundary.
Regenerate this page rather than editing it.</p>

<section class="board" data-shot="tone-sheet">
  <h2>Measured tones</h2>
  <div class="frame" style="padding: 12px 16px;">
    <table class="tssheet">
      <thead>
        <tr>
          <th scope="col">Tone</th><th scope="col">Word</th><th scope="col">Value</th>
          ${headings}
          <th scope="col">Measured on</th><th scope="col">Drawn by</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>

<script src="theme-switch.js"></script>
</body>
</html>
`;

fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'tone-sheet.html');
fs.writeFileSync(file, html);
console.log(`wrote ${file} (${tones.length} tones)`);
