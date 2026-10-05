const ARC_IDENTITY = {
  productName: "Arc",
  repositoryName: "arc",
  publisher: "glin",
  extensionName: "arc",
  extensionId: "glin.arc",
  commandPrefix: "arc",
  settingsSection: "arc",
  panelType: "arc.panel",
  panelStateKey: "arc.panelState",
  homeDirectory: ".arc",
  snapshotsDirectory: "snapshots",
  environmentPrefix: "ARC_",
  visualizationScheme: "arc-visualization:",
  cliPackageName: "arc-agent-status",
  cliExecutable: "arc-status",
  vsixFileName: "arc.vsix",
  baselineScheme: "arc-baseline",
  patchScheme: "arc-patch"
};
const STORED_STATE_KEYS = {
  usage: "arc.usage",
  askModes: "arc.askModes",
  models: "arc.models",
  efforts: "arc.efforts",
  sessionSettings: "arc.sessionSettings",
  recentProfiles: "arc.recentProfiles",
  claudeSkills: "arc.claudeSkills"
};
const MULTI_ROOT_SPEND_WORKSPACE_PREFIX = ".arc-workspace-";
export {
  ARC_IDENTITY,
  MULTI_ROOT_SPEND_WORKSPACE_PREFIX,
  STORED_STATE_KEYS
};
