// extension/src/paneltext.ts
//
// The seam between the panel stylesheet and the values this side decides.
//
// `webview/panel.css` is a real stylesheet. TypeScript modules import their runtime values.
//
// A plain file has no template literal around it, so an interpolation has nowhere to go.
// What replaces it is a token, `__ARC_NAME__`, filled in here. Every one of them names a
// figure or a table that also decides behaviour in `turnview.ts`, so the page asks for the
// tested value by name rather than keeping a second copy of it that could drift.

import { RAIL_MIN_WIDTH, RAIL_WIDTH_DEFAULT } from './turnview';

// One token, as it is written in the two files. Anchored to capitals, digits and
// underscores so it cannot run past its own closing pair into the next one.
const TOKEN = /__ARC_([A-Z0-9_]+)__/g;

// Every value the panel's stylesheet and script can ask for, by token name.
//
// It lives here rather than in `panelhost.ts` because three places need it and only one of
// them is the extension: the panel fills the page with it, and both test files fill the same
// files the same way to read what the webview actually runs. A table written out in each
// would let a guard pass against a value the page never gets.
//
// Built on each call rather than frozen at import, which costs nothing at the two moments it
// runs and keeps this a function of `turnview.ts` rather than a snapshot of it.
export function panelValues(): Record<string, string> {
  return {
    RAIL_WIDTH_DEFAULT: JSON.stringify(RAIL_WIDTH_DEFAULT),
    // The one entry worked out here rather than passed through. The rail is hidden below the
    // width it is allowed to hold, and a media query's `max-width` matches the width it
    // names, so the breakpoint is the last width narrower than the minimum and not the
    // minimum itself. The arithmetic was in the stylesheet before the split, and a stylesheet
    // cannot do arithmetic on a value it is handed.
    RAIL_MIN_WIDTH_LESS_ONE: JSON.stringify(RAIL_MIN_WIDTH - 1),
  };
}

// Every token a file asks for, in the order it asks, with duplicates kept out.
//
// This is what lets a test hold the table to the files rather than to a list written twice.
// A token added to the stylesheet with no value beside it is otherwise found by the reader,
// on screen, as a width that reads `__ARC_RAIL_WIDTH_DEFAULT__px`.
export function panelTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    found.add(match[1]);
  }
  return [...found];
}

// The file's text with every token replaced by the value named beside it.
//
// A token with no value throws rather than being left alone. The page would still parse
// with `__ARC_READ_LIMIT__` in it: the stylesheet would drop one declaration and carry on,
// and the script would throw at load and draw an empty panel with nothing on screen saying
// why. Neither is something the reader could report usefully, and both are a build-time
// mistake, so this fails at the moment the page is assembled and names the token.
export function fillPanelText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN, (whole, name: string) => {
    const held = values[name];
    if (held === undefined) {
      throw new Error(`${whole} has no value: the panel's source asks for ${name} and panelValues does not name it`);
    }
    return held;
  });
}
