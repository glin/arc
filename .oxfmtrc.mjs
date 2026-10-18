import { readdirSync } from 'node:fs';

const included = new Set([
  'extension',
  'cli',
  'docs',
  'scripts',
  'plugins',
  'test',
  'evals',
  '.github',
  '.vscode',
  '.claude-plugin',
  '.codex',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'package.json',
  'vitest.config.mts',
  '.oxfmtrc.mjs',
  '.oxlintrc.jsonc',
  '.stylelintrc.cjs',
]);

export default {
  printWidth: 120,
  proseWrap: 'never',
  singleQuote: true,
  sortPackageJson: false,
  ignorePatterns: [
    ...readdirSync(import.meta.dirname)
      .filter((name) => !included.has(name))
      .map((name) => '/' + name.replace(/[?*[\\]/g, '\\$&')),
    '.claude/**',
    '.tmp-*/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/shots/**',
    '**/test/fixtures/**',
    'evals/agent-review/fixtures/**',
    'extension/src/panel-shots.test.ts',
    'docs/spec.md',
  ],
};
