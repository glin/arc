import { formatTokens } from './tokens.ts';

export interface CacheHitDetail {
  percent: number;
  warning: boolean;
  requestScale?: [requests: number, averageInput: number];
}

export interface CacheHitText {
  cached: string;
  requestScale: string | null;
}

function detailedTokens(tokens: number): string {
  return tokens < 10_000 ? Math.round(tokens).toLocaleString('en-US') : formatTokens(tokens);
}

export function cacheHitText(detail: CacheHitDetail): CacheHitText {
  let requestScale: string | null = null;
  if (detail.requestScale) {
    const [requests, averageInput] = detail.requestScale;
    requestScale = `${requests} request${requests === 1 ? '' : 's'} · ${detailedTokens(averageInput)} avg input`;
  }
  return {
    cached: `${detail.percent}% cached`,
    requestScale,
  };
}

export function formatCacheHitDetail(detail: CacheHitDetail): string {
  const text = cacheHitText(detail);
  const facts = [text.cached, text.requestScale].filter((part) => part !== null);
  return ` (${facts.join(' · ')})`;
}

// One half of a line count, as the reader sees it: the sign, the number, and which of the two
// tones draws it.
export interface DiffHalf {
  tone: 'add' | 'del';
  text: string;
}

// Omit zero line-count halves. An addition-only count reads +4, and a count with no changes has no halves.
// Shared figures, detail headings and copied counts use this formatting. Accessible names state the same nonzero halves in words.
export function diffHalves(added: number | undefined, removed: number | undefined): DiffHalf[] {
  const halves: DiffHalf[] = [];
  if ((added ?? 0) > 0) {
    halves.push({ tone: 'add', text: `+${added}` });
  }
  if ((removed ?? 0) > 0) {
    halves.push({ tone: 'del', text: `−${removed}` });
  }
  return halves;
}

// Shared metric names for subagent figures on both sides of the host/browser message boundary.
export type AgentFigureMetric = 'cost' | 'commits' | 'files' | 'tokens' | 'duration';

// Shared subagent figure fields, excluding the detail record. AgentFigure and WireAgentFigure extend this interface.
// The host record uses StatDetailList. The browser record uses Record<string, unknown> for commit and file rows.
// StatDetailList lacks an index signature, so it cannot share the browser record type.
export interface AgentFigureFacts {
  metric: AgentFigureMetric;
  compactLabel: string;
  name?: string;
  added?: number;
  removed?: number;
  // The figure's record as one run of text, which the popover reads where it has no list to draw.
  detail?: string;
  // What the record's rows are filtered to, where it draws the card's own rows. One array
  // stands behind the card body and both popovers, so a press in any of them opens the same
  // editor tab.
  paths?: string[];
  // Captured identities distinguish files whose display paths match. Rows without identity use paths.
  fileIdentities?: string[];
  shas?: string[];
}
