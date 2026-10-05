// The themes a mockup can be drawn in.
//
// Two of them are the editor's own defaults and live in `extension/src/panelfixture.ts`,
// because the tests measure against those. The rest are here, because they belong to a
// mockup and nothing that ships may depend on them.
//
// A tone that reads well on Dark Modern can be unreadable on a theme the reader actually
// installed. The panel gets its colours from the editor, so the only way to see that is to
// draw the panel in a real theme's variables and look.
import { DARK_MODERN_THEME, LIGHT_MODERN_THEME } from '../../../extension/src/panelfixture.ts';

export interface MockTheme {
  /* The class the switcher puts on the page, as `html.theme-<id>`. */
  id: string;
  label: string;
  /* Which of the editor's two kinds this theme is, which decides the `vscode-<kind>` class
     on the body and therefore which of panel.css's own blocks answers. */
  kind: 'dark' | 'light';
  table: string;
}

/* A theme file only sets the colours it wants to change. Every other name falls to the
   colour registry's default for the theme's kind, which is what the table it is layered on
   already holds. So a theme is written here as the names it overrides and nothing else. */
function derive(base: string, overrides: Record<string, string>): string {
  let table = base;
  for (const [name, value] of Object.entries(overrides)) {
    const at = new RegExp(`(--vscode-${name}:)[^;]+;`);
    if (!at.test(table)) { throw new Error(`the base table has no --vscode-${name} to override`); }
    table = table.replace(at, `$1${value};`);
  }
  return table;
}

/* One Dark Pro Darker, from akamud's theme file. A bluish-grey ground rather than the neutral
   grey of Dark Modern, and a brown for editorWarning.foreground where Dark Modern sends a
   yellow. That one name is why a status word looks different here from every screenshot
   taken against the editor's own theme. */
const ONE_DARK_PRO_DARKER = derive(DARK_MODERN_THEME, {
  'descriptionForeground': '#abb2bf',
  'editor-background': '#23272e',
  'sideBar-background': '#1e2227',
  'editorWidget-background': '#1e2227',
  'focusBorder': '#3e4452',
  'textLink-foreground': '#61afef',
  'list-hoverBackground': '#2c313a',
  'list-activeSelectionBackground': '#2c313a',
  'list-activeSelectionForeground': '#d7dae0',
  'list-inactiveSelectionBackground': '#323842',
  'button-background': '#404754',
  'button-secondaryBackground': '#30333d',
  'button-secondaryForeground': '#c0bdbd',
  'input-background': '#1d1f23',
  'input-foreground': '#abb2bf',
  'dropdown-background': '#1e2227',
  'dropdown-border': '#1e2227',
  'textBlockQuote-border': '#4b5362',
  'editorWarning-foreground': '#d19a66',
  'editorHoverWidget-background': '#1e2227',
  'editorHoverWidget-border': '#181a1f',
  'editor-selectionBackground': '#67769660',
  'editor-findMatchHighlightBackground': '#ffffff22',
});

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
