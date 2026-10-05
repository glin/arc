// Prints the live markup of one region of the real panel, so a board pastes the panel's own
// elements instead of a drawing of them.
//
// Run from extension/:
//   npx tsx ../.claude/skills/panel-mockup/region-markup.ts <css-selector> [--state <shot state>] [--all]
//
// It loads the page the way panel-shots.ts does, drives it to a state from that file's SHOTS
// array, and writes the matched element's outerHTML one element per line. The default state
// is the first row of SHOTS. Name another with --state to reach a region that only one state
// has, such as an open card or a pinned popover. The states run in order and each starts from
// what the last one left on screen, so reaching a later state replays every state before it.
//
// The page is driven by `shoot`, which takes each replayed state's picture into a scratch
// directory and deletes it at the end. The reader sees only the markup on stdout.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIXTURE_CLOCK, pageHtml, renderPayload, themed } from '../../../extension/src/panelfixture.ts';
import { SETTLED, SHOTS, browserOrNone, shoot } from '../../../extension/scripts/panel-shots.ts';

// Walks the matched elements and writes one line per element. A string rather than a
// function, for the reason panel-shots.ts gives: this file is transpiled, and a transpiled
// arrow function calls helpers the page has never heard of.
//
// `data-vscode-context` comes off every element. It holds a JSON object in double quotes, so
// a line carrying it cannot be pasted into a Python or HTML generator. Every other attribute,
// `id` and `data-key` included, prints as it is, because a board that renames them stops
// matching the panel's own rules.
const DUMP = `(function (selector, all) {
  var found = Array.prototype.slice.call(document.querySelectorAll(selector));
  if (!found.length) { return null; }
  var nodes = all ? found : [found[0]];
  var EMPTY = { AREA: 1, BASE: 1, BR: 1, COL: 1, EMBED: 1, HR: 1, IMG: 1, INPUT: 1, LINK: 1, META: 1, SOURCE: 1, TRACK: 1, WBR: 1 };
  function escaped(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function words(node) {
    return node.nodeValue.replace(/\\s+/g, ' ').trim();
  }
  function opener(el) {
    var clone = el.cloneNode(false);
    clone.removeAttribute('data-vscode-context');
    var html = clone.outerHTML;
    var close = '</' + el.tagName.toLowerCase() + '>';
    if (html.slice(-close.length) === close) { html = html.slice(0, -close.length); }
    return html;
  }
  function write(node, depth, out) {
    var pad = new Array(depth + 1).join('  ');
    if (node.nodeType === 3) {
      if (words(node)) { out.push(pad + escaped(words(node))); }
      return;
    }
    if (node.nodeType !== 1) { return; }
    var open = opener(node);
    if (EMPTY[node.tagName]) { out.push(pad + open); return; }
    var tag = node.tagName.toLowerCase();
    var kids = Array.prototype.slice.call(node.childNodes).filter(function (kid) {
      return kid.nodeType === 1 || (kid.nodeType === 3 && words(kid));
    });
    if (kids.length === 0) { out.push(pad + open + '</' + tag + '>'); return; }
    if (kids.length === 1 && kids[0].nodeType === 3) {
      out.push(pad + open + escaped(words(kids[0])) + '</' + tag + '>');
      return;
    }
    out.push(pad + open);
    for (var i = 0; i < kids.length; i++) { write(kids[i], depth + 1, out); }
    out.push(pad + '</' + tag + '>');
  }
  return nodes.map(function (node) {
    var out = [];
    write(node, 0, out);
    return out.join('\\n');
  });
})`;

function usage(message: string): never {
  console.error(message);
  console.error('Run from extension/: npx tsx ../.claude/skills/panel-mockup/region-markup.ts'
    + ' <css-selector> [--state <shot state>] [--all]');
  process.exit(1);
}

interface Args {
  selector: string;
  state: string;
  all: boolean;
}

function args(): Args {
  const given = process.argv.slice(2);
  let selector = '';
  let state = SHOTS[0].name;
  let all = false;
  for (let index = 0; index < given.length; index++) {
    const arg = given[index];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--state') {
      const name = given[++index];
      if (!name) { usage('--state needs the name of a state.'); }
      state = name;
    } else if (!selector) {
      selector = arg;
    } else {
      usage(`Only one selector at a time, and this is the second: ${arg}`);
    }
  }
  if (!selector) { usage('Name the region with a CSS selector.'); }
  return { selector, state, all };
}

async function main(): Promise<void> {
  const { selector, state, all } = args();
  const target = SHOTS.findIndex((shot) => shot.name === state);
  if (target < 0) {
    console.error(`No state is called ${state}. The states are the SHOTS array in`
      + ' extension/scripts/panel-shots.ts:');
    console.error(`  ${SHOTS.map((shot) => shot.name).join(', ')}`);
    process.exit(1);
  }
  const browser = await browserOrNone();
  if (!browser) {
    console.error('No Edge, Chrome or bundled Chromium on this machine, so nothing was read.');
    process.exit(1);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-region-markup-'));
  try {
    // The same page the pictures are taken on: the fixture's clock, the payload the webview
    // receives, and the cards the reader has already read.
    const page = await browser.newPage({ viewport: { width: 1350, height: 900 }, deviceScaleFactor: 2 });
    await page.clock.setFixedTime(FIXTURE_CLOCK);
    const initialPayload = renderPayload() as { cards: Array<{ key: string }> };
    const savedState = JSON.stringify({ read: initialPayload.cards.map((card) => card.key) });
    const html = pageHtml().replace('const SAVED_STATE = {};', `const SAVED_STATE = ${savedState};`);
    await page.setContent(themed(html, 'dark'));
    await page.addStyleTag({
      content: `
        *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
        html, body, * { scrollbar-width: none !important; }
        ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      `,
    });
    await page.evaluate(SETTLED);
    await page.evaluate(`window.postMessage(${JSON.stringify(initialPayload)}, '*')`);
    await page.evaluate(SETTLED);

    // `shoot` names each picture it writes on stdout, and stdout here carries the markup
    // alone. Its reports go to stderr while it runs.
    const said = console.log;
    console.log = (...parts: unknown[]) => console.error(...parts);
    try {
      for (let index = 0; index <= target; index++) {
        // The last state keeps whatever it opened. `after` shuts a popover once its picture is
        // taken, and the region asked for is often inside that popover.
        const shot = index === target ? { ...SHOTS[index], after: undefined } : SHOTS[index];
        await shoot(page, shot, scratch);
      }
    } finally {
      console.log = said;
    }

    const dumped = (await page.evaluate(
      `(${DUMP})(${JSON.stringify(selector)}, ${all})`,
    )) as string[] | null;
    if (!dumped) {
      // Not `process.exit`. That leaves the browser running and the scratch directory
      // behind. The close below is what ends the run.
      console.error(`Nothing on the page matches ${selector} in the ${state} state.`);
      process.exitCode = 1;
      return;
    }
    console.log(dumped.join('\n\n'));
  } finally {
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
