export type UsageLevel = 'filling' | 'gettingFull' | 'nearlyFull';

export interface UsageFigure {
  percent: number;
  unit: string;
  level: UsageLevel | null;
}

export interface UsageBrief {
  agent: string;
  label: string;
  figures: UsageFigure[];
  name: string;
}

export interface UsageLine {
  key: string;
  label: string;
  percent: number;
  fill: number;
  level: UsageLevel | null;
  resets: string;
  resetsExact: string;
  detail: string;
  name: string;
}

export interface UsageGroup {
  agent: string;
  label: string;
  plan: string;
  lines: UsageLine[];
  exact: string;
  status: string;
}

export type UsageRefreshPhase =
  | 'discovering'
  | 'excluded'
  | 'unavailable'
  | 'queued'
  | 'waiting'
  | 'reading'
  | 'success'
  | 'empty'
  | 'failed';

export interface UsageRefreshState {
  phase: UsageRefreshPhase;
  detail: string;
  superseded?: boolean;
}

export interface UsageRefresh {
  id: number;
  agents: Record<string, UsageRefreshState>;
}

export interface UsageBar {
  briefs: UsageBrief[];
  groups: UsageGroup[];
  age: string;
  read: string;
  name: string;
  refresh?: { id: number; busy: boolean; name: string; announcement: string };
}
