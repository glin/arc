// Mockup themes extend the editor defaults from panelfixture.ts.
// Custom theme variables expose contrast differences outside the editor defaults.
import { DARK_MODERN_THEME, LIGHT_MODERN_THEME, ONE_DARK_PRO_DARKER_COLORS } from '../../../extension/src/panelfixture.ts';

export interface MockTheme {
  /* The class the switcher puts on the page, as `html.theme-<id>`. */
  id: string;
  label: string;
  /* Which of the editor's two kinds this theme is, which decides the `vscode-<kind>` class
     on the body and therefore which of panel.css's own blocks answers. */
  kind: 'dark' | 'light';
  table: string;
}

/* Overrides selected colours while retaining every other value from the base table. */
function derive(base: string, overrides: Readonly<Record<string, string>>): string {
  let table = base;
  for (const [name, value] of Object.entries(overrides)) {
    const at = new RegExp(`(--vscode-${name}:)[^;]+;`);
    if (!at.test(table)) { throw new Error(`the base table has no --vscode-${name} to override`); }
    table = table.replace(at, `$1${value};`);
  }
  return table;
}

/* One Dark Pro Darker, from the colors the static pages use. A bluish-grey ground rather than
   the neutral grey of Dark Modern, and a brown for editorWarning.foreground where Dark Modern
   sends a yellow. That one name is why a status word looks different here from every
   screenshot taken against the editor's own theme. */
const ONE_DARK_PRO_DARKER = derive(DARK_MODERN_THEME, ONE_DARK_PRO_DARKER_COLORS);

/* The first entry is what the page shows before anyone presses anything. */
export const MOCK_THEMES: readonly MockTheme[] = [
  { id: 'dark', label: 'Dark Modern', kind: 'dark', table: DARK_MODERN_THEME },
  { id: 'light', label: 'Light Modern', kind: 'light', table: LIGHT_MODERN_THEME },
  { id: 'onedark', label: 'One Dark Pro Darker', kind: 'dark', table: ONE_DARK_PRO_DARKER },
];

/* The grounds a card can sit on in a given theme, in the order tones.ts expects: the panel,
   the sidebar-toned rail, a hovered row, and a row selected but unfocused. */
export function groundsOf(theme: MockTheme): string[] {
  return ['editor-background', 'sideBar-background', 'list-hoverBackground', 'list-inactiveSelectionBackground']
    .map((name) => {
      const found = new RegExp(`--vscode-${name}:([^;]+);`).exec(theme.table);
      if (!found) { throw new Error(`${theme.label} has no --vscode-${name}`); }
      return found[1].trim();
    });
}
