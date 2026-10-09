import * as esbuild from 'esbuild';
import { staticPageBody } from '../src/view/static-page.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BROWSER_BUILD,
  browserBundle,
  browserStylesheet,
  staticThemeStylesheet,
  staticShellStylesheet,
} from '../src/panelbundle.ts';
import { fillPanelText, panelValues } from '../src/paneltext.ts';
import { CARD_ACTIONS } from '../src/view/card-words.ts';
import {
  CAPTURE_RAIL_WIDTH,
  CAPTURE_TIME,
  DEMO_LABELS,
  DEMO_RAIL_FOLDS,
  DEMO_SESSION_IDS,
  demoPayload,
  demoContextSample,
} from './readme-fixture.ts';
import { DEMO_MENU_COMMANDS, manifestMenu } from './web-demo-menu.ts';

const destination = path.resolve(process.argv[2] ?? path.join(__dirname, '../../.scratch-web-demo/site'));
// Bundle production label and read rules for page-local demo edits.
// Bundle the menu stand-in with entries supplied separately from the manifest.
const labelRules = esbuild.buildSync({
  stdin: {
    contents: `import { labelCounts, labelEditorReply, labelsOf, railLabelFields, setSessionLabels } from './src/turnlabels.ts';
import { newBySession } from './src/domain/read.ts';
import { applyComment, normalizeComments } from './src/turncomments.ts';
import { emptyTrail, visitPlace, stepBack, stepForward, trailPlace } from './src/turnplaces.ts';
import { isSendChord } from './src/domain/composer-editing.ts';
import { navigationShortcut } from './src/webview/navigation.ts';
import { installMenu } from './scripts/web-demo-menu.ts';
import { demoHost } from './scripts/web-demo-host.ts';
window.__ARC_DEMO_SAMPLES__.host = demoHost;
window.__ARC_DEMO_SAMPLES__.labelRules = { labelCounts, labelEditorReply, labelsOf, railLabelFields, setSessionLabels };
window.__ARC_DEMO_SAMPLES__.readRules = { newBySession };
window.__ARC_DEMO_SAMPLES__.commentRules = { applyComment, normalizeComments };
window.__ARC_DEMO_SAMPLES__.placeRules = { emptyTrail, visitPlace, stepBack, stepForward, trailPlace };
window.__ARC_DEMO_SAMPLES__.isSendChord = isSendChord;
window.__ARC_DEMO_SAMPLES__.navigationShortcut = navigationShortcut;
window.__ARC_DEMO_SAMPLES__.installMenu = installMenu;`,
    resolveDir: path.join(__dirname, '..'),
    loader: 'ts',
  },
  ...BROWSER_BUILD,
}).outputFiles[0].text;
const samples = {
  clock: CAPTURE_TIME,
  contexts: Object.fromEntries(DEMO_SESSION_IDS.map((id) => [id, demoContextSample(id)])),
  railWidth: CAPTURE_RAIL_WIDTH,
  railFolds: DEMO_RAIL_FOLDS,
  labels: DEMO_LABELS,
  labelWords: { labelled: CARD_ACTIONS.railLabelled, heading: CARD_ACTIONS.labelHeading },
  menuEntries: manifestMenu(
    JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')),
    new Set([...DEMO_MENU_COMMANDS, 'arc.renameView', 'arc.deleteView']),
  ),
  payloads: Object.fromEntries(DEMO_SESSION_IDS.map((id) => [id, demoPayload(id)])),
};
const assets: Record<string, string> = {
  'panel.js': fillPanelText(browserBundle().text, panelValues()),
  'panel.css': fillPanelText(browserStylesheet(), panelValues()),
  'themes.css': staticThemeStylesheet(),
  'demo.css': staticShellStylesheet(),
  'adapter.js': labelRules + fs.readFileSync(path.join(__dirname, 'web-demo-adapter.js'), 'utf8'),
  'samples.js': `window.__ARC_DEMO_SAMPLES__ = ${JSON.stringify(samples)};\n`,
  'index.html': `<!DOCTYPE html>
<html lang="en" data-theme="onedark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'"><title>Arc demo</title><link rel="stylesheet" href="./themes.css"><link rel="stylesheet" href="./panel.css"><link rel="stylesheet" href="./demo.css"></head>
${staticPageBody('Arc demo', 'Explore sample sessions in this read-only demo.', 'Loading sample sessions...')}<script src="./samples.js" defer></script><script src="./adapter.js" defer></script><script src="./panel.js" defer></script></body></html>`,
};
for (const [name, content] of Object.entries(assets).filter(([name]) => name === 'panel.js' || name === 'panel.css')) {
  if (/__ARC_[A-Z0-9_]+__/.test(content)) throw new Error(`${name} has an unresolved panel token`);
}
fs.mkdirSync(destination, { recursive: true });
for (const [name, content] of Object.entries(assets)) fs.writeFileSync(path.join(destination, name), content);
console.log(destination);
console.log(
  'Model catalog uses provider snapshots. Check freshness from extension with node --import tsx scripts/demo-catalog-check.ts --cwd <launch-folder>.',
);
