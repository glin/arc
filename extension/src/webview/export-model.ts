import type { PanelSessionRow, PanelStat, PanelRailCard } from './protocol.ts';
import type { SessionExport, ExportSession } from '../domain/export-model.ts';

export interface SiteAsset {
  id: string;
  bytes: number;
}
export interface SitePage extends SiteAsset {
  keys: string[];
  cards?: SiteAsset[];
}
export interface SiteSession extends Omit<ExportSession, 'pages'> {
  pages: SitePage[];
}
export interface SiteManifest extends Omit<SessionExport, 'sessions'> {
  sessions: SiteSession[];
  rows: PanelSessionRow[];
  rail: PanelRailCard[];
  stats: Record<string, PanelStat[]>;
}

// The static entry never accepts panel host messages. Every new protocol request requires a decision.
export const EXPORT_HOST_POLICY = {
  readerRead: 'blocked',
  sessionFilterApplied: 'blocked',
  health: 'blocked',
  contextDetail: 'blocked',
  ready: 'local',
  rowsGap: 'blocked',
  painted: 'blocked',
  initialize: 'blocked',
  developmentReload: 'blocked',
  refresh: 'blocked',
  perf: 'blocked',
  goBack: 'local',
  goForward: 'local',
  newSession: 'blocked',
  pinSetup: 'blocked',
  unpinSetup: 'blocked',
  refreshUsage: 'blocked',
  openControl: 'blocked',
  requestDefaults: 'blocked',
  pick: 'blocked',
  draft: 'blocked',
  pathCompletion: 'blocked',
  dropUris: 'blocked',
  answerAsk: 'blocked',
  beginFileStaging: 'blocked',
  attachFiles: 'blocked',
  fileReadError: 'blocked',
  fileRejected: 'blocked',
  removeFile: 'blocked',
  sendPrompt: 'blocked',
  importPromptRecovery: 'blocked',
  compact: 'blocked',
  dismissLive: 'blocked',
  restoreLive: 'blocked',
  stopTurn: 'blocked',
  dequeue: 'blocked',
  editQueued: 'blocked',
  acceptQueuedEdit: 'blocked',
  copy: 'local',
  note: 'blocked',
  armSelectedText: 'blocked',
  selectedTextHandoff: 'blocked',
  armSessionDetails: 'blocked',
  armComposer: 'blocked',
  showReaderParent: 'local',
  showSession: 'local',
  labelEditor: 'blocked',
  setLabels: 'blocked',
  setViews: 'blocked',
  renameSession: 'blocked',
  setRailFilters: 'blocked',
  sessionMembership: 'blocked',
  setLayout: 'local',
  exportSession: 'blocked',
  saveState: 'local',
  search: 'blocked',
  loadOlder: 'local',
  openLink: 'blocked',
  openDirectory: 'blocked',
  openVisualization: 'blocked',
  openImage: 'blocked',
  openTurnDiff: 'blocked',
  openCommit: 'blocked',
  openFile: 'blocked',
  openSkill: 'blocked',
} satisfies Record<import('./protocol.ts').PanelToHost['type'], 'blocked' | 'local'>;
