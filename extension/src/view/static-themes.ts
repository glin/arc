// Default editor colors for static panel pages.
export const DARK_MODERN_THEME = `:root{
--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;
--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;
--vscode-editorWidget-background:#202020;--vscode-editorWidget-foreground:#cccccc;--vscode-editorWidget-border:#454545;
--vscode-widget-border:#313131;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;
--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-inactiveSelectionBackground:#37373d;
--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;
--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;
--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#989898;
--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;--vscode-dropdown-border:#3c3c3c;
--vscode-toolbar-hoverBackground:rgba(90,93,94,0.31);--vscode-textCodeBlock-background:#2b2b2b;--vscode-textBlockQuote-border:#616161;
--vscode-testing-iconPassed:#73c991;--vscode-testing-iconFailed:#f14c4c;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700;
--vscode-progressBar-background:#0078d4;
--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-deletedResourceForeground:#c74e39;
--vscode-settings-headerForeground:#ffffff;--vscode-editorHoverWidget-background:#202020;--vscode-editorHoverWidget-border:#454545;
--vscode-editor-selectionBackground:#264f78;--vscode-editor-findMatchHighlightBackground:#ea5c0055;
--vscode-charts-yellow:#cca700;--vscode-charts-blue:#59a4f9;--vscode-charts-orange:#ea5c0055;
--vscode-font-family:"Segoe WPF","Segoe UI",system-ui,sans-serif;--vscode-font-size:13px;
--vscode-editor-font-family:Consolas,"Courier New",monospace;
}
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);}`;

// Light Modern theme variables for light fixture pages.
export const LIGHT_MODERN_THEME = `:root{
--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;
--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;
--vscode-editorWidget-background:#f8f8f8;--vscode-editorWidget-foreground:#3b3b3b;--vscode-editorWidget-border:#e5e5e5;
--vscode-widget-border:#e5e5e5;--vscode-focusBorder:#005fb8;--vscode-textLink-foreground:#005fb8;
--vscode-list-hoverBackground:#f2f2f2;--vscode-list-activeSelectionBackground:#e8e8e8;--vscode-list-activeSelectionForeground:#000000;
--vscode-list-inactiveSelectionBackground:#e4e6f1;
--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#0258a8;
--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
--vscode-dropdown-background:#ffffff;--vscode-dropdown-foreground:#3b3b3b;--vscode-dropdown-border:#cecece;
--vscode-toolbar-hoverBackground:rgba(184,184,184,0.31);--vscode-textCodeBlock-background:#f8f8f8;--vscode-textBlockQuote-border:#e5e5e5;
--vscode-testing-iconPassed:#73c991;--vscode-testing-iconFailed:#f14c4c;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#bf8803;
--vscode-progressBar-background:#005fb8;
--vscode-gitDecoration-addedResourceForeground:#587c0c;--vscode-gitDecoration-modifiedResourceForeground:#895503;--vscode-gitDecoration-deletedResourceForeground:#ad0707;
--vscode-settings-headerForeground:#1f1f1f;--vscode-editorHoverWidget-background:#f8f8f8;--vscode-editorHoverWidget-border:#e5e5e5;
--vscode-editor-selectionBackground:#add6ff;--vscode-editor-findMatchHighlightBackground:#ea5c0055;
--vscode-charts-yellow:#bf8803;--vscode-charts-blue:#0063d3;--vscode-charts-orange:#ea5c0055;
--vscode-font-family:"Segoe WPF","Segoe UI",system-ui,sans-serif;--vscode-font-size:13px;
--vscode-editor-font-family:Consolas,"Courier New",monospace;
}
body{background:var(--vscode-editor-background);color:var(--vscode-foreground);}`;

// One Dark Pro Darker with its bordered look, layered over the Dark Modern table.
// The bordered theme sets no widget or input border, so Arc draws its own grey #80808059 there.
// The table names that grey so that the Dark Modern borders do not show through.
export const ONE_DARK_PRO_DARKER_COLORS: Readonly<Record<string, string>> = {
  descriptionForeground: '#abb2bf',
  'editor-background': '#23272e',
  'sideBar-background': '#1e2227',
  'editorWidget-background': '#1e2227',
  'widget-border': '#80808059',
  focusBorder: '#3e4452',
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
  'input-border': '#80808059',
  'dropdown-background': '#1e2227',
  'dropdown-border': '#1e2227',
  'textBlockQuote-border': '#4b5362',
  'editorWarning-foreground': '#d19a66',
  'settings-headerForeground': '#fff',
  'editorHoverWidget-background': '#1e2227',
  'editorHoverWidget-border': '#181a1f',
  'editor-selectionBackground': '#67769660',
  'editor-findMatchHighlightBackground': '#ffffff22',
};

export const ONE_DARK_PRO_DARKER_THEME = `${DARK_MODERN_THEME}
:root{
${Object.entries(ONE_DARK_PRO_DARKER_COLORS)
  .map(([name, value]) => `--vscode-${name}:${value};`)
  .join('')}
}`;
