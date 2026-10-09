import type { CardView } from './payload-contracts.ts';
import type {
  SessionExport,
  ExportSession,
  ExportTurn,
  ExportCompaction,
  ExportBlock,
} from '../domain/export-model.ts';

export interface SiteAsset {
  id: string;
  file: string;
  bytes: number;
}
export interface SiteText {
  raw: string;
  html: string;
}
export interface SiteBlock extends Omit<ExportBlock, 'text'> {
  preview: string;
  chunks: SiteAsset[];
}
export interface SiteCard {
  card: CardView;
  bodies: SiteAsset[];
  facts: SiteAsset;
  relationships?: string[];
}
export interface SitePage extends SiteAsset {
  keys: string[];
}
export interface SiteSession extends Omit<ExportSession, 'pages'> {
  pages: SitePage[];
}
export interface SiteManifest extends Omit<SessionExport, 'sessions'> {
  sessions: SiteSession[];
}
export type SiteFacts = Omit<ExportTurn, 'blocks'> | Omit<ExportCompaction, 'summary'>;

// The static entry never accepts panel host messages. Every new protocol request requires a decision.
export const EXPORT_HOST_POLICY = {
  health: 'blocked',
  contextDetail: 'blocked',
  ready: 'blocked',
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
  copy: 'blocked',
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
  setLayout: 'blocked',
  exportSessionHtml: 'blocked',
  saveState: 'blocked',
  search: 'blocked',
  loadOlder: 'local',
  openLink: 'blocked',
  openVisualization: 'blocked',
  openImage: 'blocked',
  openTurnDiff: 'blocked',
  openCommit: 'blocked',
  openFile: 'blocked',
  openSkill: 'blocked',
} satisfies Record<import('./protocol.ts').PanelToHost['type'], 'blocked' | 'local'>;
