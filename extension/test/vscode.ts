export const workspace = {
  workspaceFolders: [],
  getConfiguration: () => ({ get: () => null }),
};

export const window = { activeColorTheme: { kind: 0 } };
export const commands = {};
export const env = {};
export const extensions = { all: [] };
export const Uri = {
  joinPath: (base: { fsPath?: string }, ...segments: string[]) => ({
    fsPath: [base.fsPath ?? '', ...segments].join('/'),
  }),
};
export const ColorThemeKind = { Light: 1, HighContrastLight: 4 };
export const FileType = { Directory: 2 };
export const ViewColumn = { Active: 1 };
export class Range {
  readonly stub = true;
}
