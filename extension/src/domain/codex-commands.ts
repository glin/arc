export const CODEX_COMMANDS = [
  { kind: 'command', name: 'compact', description: 'Compact the session', argumentHint: '' },
  { kind: 'command', name: 'clear', description: 'Start a new session', argumentHint: '' },
  { kind: 'command', name: 'new', description: 'Start and name a new session', argumentHint: '[name]' },
  { kind: 'command', name: 'rename', description: 'Rename the session', argumentHint: '<name>' },
] as const;
