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
  cliPackageName: '@glin/arc',
  cliExecutable: 'arc-status',
  vsixFileName: 'arc.vsix',
  baselineScheme: 'arc-baseline',
  patchScheme: 'arc-patch',
} as const;

export const MEASUREMENT_ENVIRONMENT = {
  blockAgents: `${ARC_IDENTITY.environmentPrefix}MEASURE_BLOCK_AGENTS`,
  state: `${ARC_IDENTITY.environmentPrefix}MEASURE_STATE`,
  run: `${ARC_IDENTITY.environmentPrefix}MEASURE_RUN`,
} as const;

// Workspace and global saved-state keys. Changing a key stops reading values stored under the old spelling.
export const STORED_STATE_KEYS = {
  usage: 'arc.usage',
  askModes: 'arc.askModes',
  models: 'arc.models',
  efforts: 'arc.efforts',
  sessionSettings: 'arc.sessionSettings',
  recentProfiles: 'arc.recentProfiles',
  pinnedSetups: 'arc.pinnedSetups',
  projectSetups: 'arc.projectSetups.v1:',
  claudeSkills: 'arc.claudeSkills',
} as const;

// Path prefix used to identify multi-root workspaces in the project spend ledger.
export const MULTI_ROOT_SPEND_WORKSPACE_PREFIX = '.arc-workspace-';
