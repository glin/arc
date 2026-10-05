// Writes the stylesheet a mockup wears: both of the editor's theme variable tables, then
// panel.css filled the way the webview receives it. Beside it go mock.css, the artboard
// scaffolding, and theme-switch.js, which moves the page between the two theme kinds.
// Run from extension/:  npx tsx ../.claude/skills/panel-mockup/snapshot-css.ts <dir>
//
// It also checks the scaffold against the panel. Every panel class the scaffold overrides
// has to still exist in panel.css, or a rename in the panel would leave the mockups quietly
// unstyled.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fillPanelText, panelValues } from '../../../extension/src/paneltext.ts';
import { MOCK_THEMES } from './themes.ts';

const out = process.argv[2] || '.';
const root = path.resolve(__dirname, '..', '..', '..');
const panel = fs.readFileSync(path.join(root, 'extension', 'src', 'webview', 'panel.css'), 'utf8');
const scaffold = fs.readFileSync(path.join(__dirname, 'mock.css'), 'utf8');

// The scaffold's own classes. Everything else it names belongs to the panel. A name here has
// to be one no panel rule can reach, because the scaffold sits outside every frame and the
// panel's own type and spacing would otherwise dress the artboards. The artboard row is
// mockrow for that reason: panel.css draws .row at the small type step, with padding of its
// own.
const own = new Set([
  'board', 'lead', 'mockrow', 'frame', 'railmock', 'idle', 'cap', 'before', 'flow', 'inplace',
  'mocktheme', 'mockthemelabel', 'mockthemepick',
  ...MOCK_THEMES.map((theme) => `theme-${theme.id}`),
]);
// Comments come off first: a file name such as mock.css reads as a class otherwise.
const rules = scaffold.replace(/\/\*[\s\S]*?\*\//g, '');
const named = new Set([...rules.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
const missing = [...named].filter((name) => !own.has(name) && !panel.includes(`.${name}`));
if (missing.length) {
  console.error(`mock.css names panel classes that panel.css no longer has: ${missing.join(', ')}`);
  process.exit(1);
}

// Warns when Codex cannot read the skill through .agents/skills/panel-mockup.
// Snapshot generation continues without that link.
const link = path.join(root, '.agents', 'skills', 'panel-mockup');
if (!fs.existsSync(path.join(link, 'SKILL.md'))) {
  console.warn('warning: .agents/skills/panel-mockup is not a link to the skill, so Codex will not find it.'
    + ' Set core.symlinks to true and check it out again, or make a directory junction there.');
}

// A theme table declares every --vscode-* name on :root, because panel.css reads those names
// in its own :root block, and a custom property is substituted where it is declared rather
// than where it is used. A table on body would leave every tone sitting on its fallback. So
// each theme is the same declarations under html.theme-<id>, which theme-switch.js sets
// together with body.vscode-dark or body.vscode-light, the class the editor puts on a
// webview. The first theme also answers on :root, so the page is dressed before any script
// runs.
//
// The trailing `body` rule comes off every table. It paints the page the colour of an editor
// tab, and this page is a sheet of artboards that mock.css paints instead. The text colour
// goes back once, taken from whichever table is live.
function scoped(table: string, selector: string): string {
  return table.replace(/^:root\{/, `${selector}{`).replace(/\nbody\{[^}]*\}\s*$/, '');
}
// The switcher reads its own list from here rather than carrying a second copy that could
// name a theme the stylesheet was never built with.
const catalogue = MOCK_THEMES.map((t) => `${t.id}:${t.kind}:${t.label}`).join('|');
const css = [
  `:root{--mock-themes:"${catalogue}";}`,
  ...MOCK_THEMES.map((theme, index) => scoped(
    theme.table, index === 0 ? `:root, html.theme-${theme.id}` : `html.theme-${theme.id}`,
  )),
  'body{color:var(--vscode-foreground);}',
  fillPanelText(panel, panelValues()),
].join('\n');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'panel-snapshot.css'), css);
for (const name of ['mock.css', 'theme-switch.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(out, name));
}
console.log(`wrote ${path.join(out, 'panel-snapshot.css')} (${css.length} bytes), mock.css and theme-switch.js`);
