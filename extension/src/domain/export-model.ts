export interface ExportIdentity {
  agent: 'claude' | 'codex';
  sessionId: string;
  parentSessionId?: string;
}
export interface ExportReaderLink {
  parent: ExportIdentity;
  child: ExportIdentity;
}
export interface ExportReaderState {
  archived: readonly ExportIdentity[];
  startedHere: readonly ExportIdentity[];
  agentRuns: readonly ExportIdentity[];
  // Agent runs the reader prompted from the Prompt box. Membership files the session as the reader's own.
  prompted: readonly ExportIdentity[];
}
export type ExportOmissionReason =
  | 'missing'
  | 'unreadable'
  | 'ambiguous'
  | 'conflicting'
  | 'unsupported'
  | 'unresolved'
  | 'inventory-incomplete'
  | 'external-path';
export interface ExportOmission {
  session: string | null;
  relationship: string | null;
  reason: ExportOmissionReason;
}
export interface ExportRelationship {
  key: string;
  from: string;
  to: string | null;
  kind: 'subagent' | 'dispatched' | 'reader-started';
  ownership: 'delegated' | 'navigation';
  requestedByReader: boolean;
  coverage: 'complete' | 'partial';
  reason?: ExportOmissionReason;
  label?: string;
  turn?: string;
}
export interface ExportUsage {
  requests: number | null;
  input: number | null;
  cacheRead: number | null;
  cacheWrite1h: number | null;
  cacheWrite5m: number | null;
  cacheWrite30m: number | null;
  output: number | null;
  thinking: number | null;
}
export interface ExportCostPart {
  role: 'main' | 'delegated';
  scope: string | null;
  model: string | null;
  provider: string | null;
  contextWindow: number | null;
  contextBand: 'short' | 'long' | null;
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null | undefined;
  serviceTier: string | null;
  recordedCost: number | null;
  costBasis: string | null;
  unclassifiedCacheWrite: number;
  incomplete: boolean;
  requestCountExact: boolean;
  estimated: boolean;
  compactionUsage?: true;
  origin: 'recorded' | 'claude-cost-state' | 'claude-advisor';
  // The requests that read a subagent wait return, and their usage.
  waits?: { requests: number; timedOut: number; usage: ExportUsage };
  usage: ExportUsage;
}
export interface ExportCost {
  dollars: number | null;
  partial: boolean;
}
export interface ExportNumbers {
  parts: ExportCostPart[];
  main: ExportCost;
  delegated: ExportCost;
  combined: ExportCost;
  coverage: { usage: 'complete' | 'partial' | 'unavailable'; cost: 'complete' | 'partial' | 'unpriced' };
}
export interface ExportBlock {
  stepsBefore?: number;
  opening?: boolean;
  key: string;
  kind: 'prompt' | 'assignment' | 'answer' | 'commentary';
  text: string;
  at: number;
  sourceOrder: number | null;
  notResponse: 'repeat-notice' | 'no-response-requested' | 'after-handback' | null;
}
export interface ExportTurn {
  key: string;
  startedAt: number;
  endedAt: number;
  finished: boolean;
  interrupted: boolean;
  model: string | null;
  provider: string | null;
  effort: string | null;
  blocks: ExportBlock[];
  usage: ExportUsage;
  usageParts: ExportCostPart[];
  relationships: string[];
  context: {
    tokens: number | null;
    window: number | null;
    request: {
      at: number;
      lifetime: string | null;
      inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null | undefined;
      serviceTier: string | null;
      readBack: boolean;
      outputTokens: number;
      effort: string | null;
      bedrock: boolean;
    } | null;
  };
  outputRate: { output: number; milliseconds: number } | null;
  outputRateModel?: string;
  outputRateBasis?: 'stream' | 'request';
  error: string | null;
  activity: {
    steps?: {
      ordinal: number;
      name: string;
      detail: string;
      fullDetail?: string;
      headline?: string;
      at: number;
      status: 'running' | 'done' | 'failed' | 'interrupted';
    }[];
    failedOrdinals?: number[];
    failedTools?: Record<string, number>;
    tools?: Record<string, number>;
    calls: number;
    failures: number;
    categories: string[];
    counts: {
      edits: number;
      reads: number;
      searches: number;
      commands: number;
      agents: number;
      coordination: number;
      web: number;
      other: number;
    };
  };
  agents: {
    relationships?: string[];
    spend?: ExportCostPart[];
    spendFound?: boolean;
    key: string;
    description: string;
    agentType: string | null;
    model: string | null;
    ownModel?: string;
    outputRate?: { output: number; milliseconds: number };
    outputRateModel?: string;
    effort: string | null;
    status: string;
    startedAt: number | null;
    durationMs: number | null;
    tokens: number | null;
    toolUses: number | null;
    partial: boolean;
    artifacts?: {
      files: ExportTurn['files'];
      commits: string[];
      tools?: Record<string, number>;
      failed?: { count: number; byTool: Record<string, number> };
      startedAt?: number;
      endedAt?: number;
      turnCount?: number;
      complete: boolean;
    };
  }[];
  files: {
    path: string;
    identity?: string;
    added: number | null;
    removed: number | null;
    isNew: boolean;
    reason: 'shell' | 'write' | 'replaceAll' | 'notebook' | 'zero' | null;
    countsUnknown?: true;
    countsPartial?: true;
  }[];
  commits: {
    sha: string;
    subject: string;
    at: number;
    files: number | null;
    added: number | null;
    removed: number | null;
  }[];
  changes: 'complete' | 'partial';
  filesComplete?: boolean;
}
export interface ExportCompaction {
  key: string;
  at: number;
  summary: string;
  trigger: string;
  model: string | null;
  provider: string | null;
  contextBefore: number | null;
  contextAfter: number | null;
  droppedTokens: number | null;
  durationMs: number | null;
  usage: ExportUsage | null;
  previousRequest: {
    tokens: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    at: number | null;
    lifetime: string | null;
    inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null | undefined;
    serviceTier: string | null;
  } | null;
  summaryChars: number | null;
  postCompactionCacheRead?: number | null;
  retainedContext: { tokens: number; window: number | null } | null;
  contextWindow: number | null;
  inferenceClass: 'in-region' | 'geo' | 'global' | 'bedrock-regional' | null | undefined;
  serviceTier: string | null;
}
export interface ExportPage {
  key: string;
  session: string;
  turns: ExportTurn[];
  compactions: ExportCompaction[];
}
export interface ExportSession {
  key: string;
  agent: 'claude' | 'codex';
  title: string;
  archived: boolean;
  agentRun: boolean;
  pages: string[];
  turnCount: number;
  compactionCount: number;
  firstRequestCachedTokens: number | null;
  numbers: ExportNumbers;
  parentOutsideExport: boolean;
  provenance: { sourceBytes: number; sha256: string };
  coverage: {
    text: 'complete';
    relationships: 'complete' | 'partial';
    context: 'recorded' | 'unavailable';
    changes: 'recorded' | 'partial';
  };
}
export interface SessionExport {
  version: 1;
  root: string;
  capturedAt: number;
  sessions: ExportSession[];
  relationships: ExportRelationship[];
  omissions: ExportOmission[];
  coverage: { text: 'complete'; relationships: 'complete' | 'partial'; inventory: 'complete' | 'partial' };
  deliberatelyOmitted: readonly string[];
}
