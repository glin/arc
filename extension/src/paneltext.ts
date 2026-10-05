// Replace named tokens in panel source with shared runtime values.
// Plain stylesheet files cannot interpolate TypeScript values.

import { RAIL_MIN_WIDTH, RAIL_WIDTH_DEFAULT } from './turnview';

// Match token names containing capitals, digits, and underscores.
const TOKEN = /__ARC_([A-Z0-9_]+)__/g;

// Build the token values shared by the panel and its source tests.
// Read runtime constants on each call.
export function panelValues(): Record<string, string> {
  return {
    RAIL_WIDTH_DEFAULT: JSON.stringify(RAIL_WIDTH_DEFAULT),
    // Hide the session list below its minimum width. A max-width media query includes
    // the named width, so its breakpoint must be one less than the minimum.
    RAIL_MIN_WIDTH_LESS_ONE: JSON.stringify(RAIL_MIN_WIDTH - 1),
  };
}

// List token names in first-occurrence order without duplicates.
export function panelTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    found.add(match[1]);
  }
  return [...found];
}

// Replace each token with its named value.
// Throw for missing values during panel assembly, before unresolved tokens reach the browser.
export function fillPanelText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN, (whole, name: string) => {
    const held = values[name];
    if (held === undefined) {
      throw new Error(`${whole} has no value: the panel's source asks for ${name} and panelValues does not name it`);
    }
    return held;
  });
}
