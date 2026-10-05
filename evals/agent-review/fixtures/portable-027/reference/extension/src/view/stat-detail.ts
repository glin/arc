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

// The halves of one line count. A half that moved no line is left out, so a record that only
// added lines reads `+4` rather than `+4 −0`, and a record that moved nothing at all comes to
// nothing. Every pair drawn as a sign and a number comes through here: the figure's own pair,
// the head of the record it opens, and the run of text a reader copies out of either. A spoken
// name states the same halves in words instead, and words them where it is built, so it leaves a
// half out by this rule rather than by reading these.
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

// What a subagent row's figure measures. This is the one declaration of the set, and both sides
// of the message boundary read it: `AgentFigure` in `turncard.ts` builds the figures, and
// `CardView` in `webview/payload-contracts.ts` types what arrives. A metric belongs here, so
// neither side can name one the other does not.
export type AgentFigureMetric = 'cost' | 'commits' | 'files' | 'tokens' | 'duration';

// Every field a subagent row's figure carries except the record behind it. `AgentFigure` in
// `turncard.ts` and `WireAgentFigure` in `webview/payload-contracts.ts` both extend this, so a
// field added here arrives on both sides of the message boundary at once.
//
// The record is the one field each side declares for itself. The host types it as
// `StatDetailList` in `turncard.ts`, which no browser-safe module may read, and the panel widens
// the field to the rows a commits or a files record draws. An interface carrying no index
// signature is not assignable to `Record<string, unknown>`, so those two cannot become one field
// here.
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
  shas?: string[];
}
