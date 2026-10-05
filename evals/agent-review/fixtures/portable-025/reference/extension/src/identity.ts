export const ARC_IDENTITY = {
  productName: 'Arc',
  repositoryName: 'arc',
  publisher: 'glin',
  extensionName: 'arc',
  extensionId: 'glin.arc',
  commandPrefix: 'arc',
  settingsSection: 'arc',
  panelType: 'arc.panel',
  panelStateKey: 'arc.panelState',
  homeDirectory: '.arc',
  snapshotsDirectory: 'snapshots',
  environmentPrefix: 'ARC_',
  visualizationScheme: 'arc-visualization:',
  cliPackageName: 'arc-agent-status',
  cliExecutable: 'arc-status',
  vsixFileName: 'arc.vsix',
  baselineScheme: 'arc-baseline',
  patchScheme: 'arc-patch',
} as const;

// Keys Arc reads and writes in VS Code workspace and global state. Saved reader state lives under
// these exact strings, and a new spelling starts from nothing.
export const STORED_STATE_KEYS = {
  usage: 'arc.usage',
  askModes: 'arc.askModes',
  models: 'arc.models',
  efforts: 'arc.efforts',
  sessionSettings: 'arc.sessionSettings',
  recentProfiles: 'arc.recentProfiles',
  claudeSkills: 'arc.claudeSkills',
} as const;

// The path prefix that names a multi-root workspace in the saved project spend ledger. A ledger
// saved under another workspace name is discarded and rebuilt from every transcript.
export const MULTI_ROOT_SPEND_WORKSPACE_PREFIX = '.arc-workspace-';
