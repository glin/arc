// Normalizes account usage and prepares collapsed figures and expanded limit rows.
// Each agent wire supplies `UsageReading` without a model request.
// This module determines labels, caution bands, resets, and reading age.

import { RateLimit, SpendCap, UsageReading } from './agentwire';
import { CONTEXT_BANDS, bandForPercent, formatClock, wholePercent } from './turnview';
import type { UsageBar, UsageBrief, UsageFigure, UsageGroup, UsageLine } from './view/usage.ts';
export type { UsageBar, UsageBrief, UsageFigure, UsageGroup, UsageLine } from './view/usage.ts';

// A table lookup that cannot find a function on the prototype. A window or a group named
// `constructor` would otherwise be treated as an entry that was never written down.
function owns(table: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

// Account names for the usage bar. These are independent of turn source labels.
export const USAGE_AGENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

// The order the agents are drawn in, which is the order they are offered in everywhere else.
export const USAGE_AGENT_ORDER: readonly string[] = ['claude', 'codex'];

// Maximum reading age before the usage bar displays its age.
export const USAGE_FRESH_MS = 120_000;
export const MAX_USAGE_RESET_DELAY_MS = 2_147_000_000;

export function usageResetDelay(atSeconds: number, now: number): number {
  return Math.min(MAX_USAGE_RESET_DELAY_MS, Math.max(0, atSeconds * 1000 - now + 1));
}

export interface UsageTimerHost {
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}

const USAGE_TIMER_HOST: UsageTimerHost = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class UsageResetTimer {
  private timer: unknown = null;

  constructor(private readonly host: UsageTimerHost = USAGE_TIMER_HOST) {}

  schedule(atSeconds: number | null, now: number, callback: () => void): void {
    this.dispose();
    if (atSeconds === null) {
      return;
    }
    this.timer = this.host.set(
      () => {
        this.timer = null;
        callback();
      },
      usageResetDelay(atSeconds, now),
    );
  }

  dispose(): void {
    if (this.timer === null) {
      return;
    }
    this.host.clear(this.timer);
    this.timer = null;
  }
}

export class UsageWriteQueue {
  private pending: Promise<void> = Promise.resolve();

  write(task: () => PromiseLike<void>): Promise<void> {
    const write = this.pending.then(() => task()).then(() => undefined);
    this.pending = write.catch(() => undefined);
    return write;
  }

  drain(): Promise<void> {
    return this.pending;
  }
}

// A limit and its reading time. Mid-turn events update limits independently,
// so an agent's limits can have different reading times.
export interface WindowReading extends RateLimit {
  readAt: number;
  // Requested account answers replace one another. Live events survive a cap-only answer
  // because that answer does not carry the response-header window the child just observed.
  source?: 'account' | 'event';
}

export interface SpendReading extends SpendCap {
  readAt: number;
}

// Everything the bar knows about one agent.
export interface AgentUsage {
  agent: string;
  plan: string;
  windows: WindowReading[];
  spend: SpendReading | null;
  creditResetsAtSeconds?: number | null;
  // The last requested answer, including one that confirmed there was no cap or window.
  // Partial mid-turn events do not move it.
  checkedAt: number | null;
}

// Recognizes duration-based limit window names.
const MINUTE_WINDOW = /^(\d+)_minute$/;

const WINDOW_WORDS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
};
const SPEND_LABEL = 'credits';
const SPEND_SPOKEN = 'the credit cap';
const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$' };

// An amount of money, from the minor units and exponent the agent reported. Grouping is
// fixed here so the same reading is worded the same way on machines with different locales.
export function moneyWord(minor: number, exponent: number, currency: string): string {
  const negative = minor < 0;
  const places = Number.isInteger(exponent) && exponent >= 0 && exponent <= 20 ? exponent : 2;
  const digits = Math.abs(Math.round(minor))
    .toString()
    .padStart(places + 1, '0');
  const split = digits.length - places;
  const whole = (places ? digits.slice(0, split) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = places ? `.${digits.slice(split)}` : '';
  const amount = `${negative ? '-' : ''}${whole}${fraction}`;
  const symbol = owns(CURRENCY_SYMBOLS, currency) ? CURRENCY_SYMBOLS[currency] : '';
  return symbol ? `${symbol}${amount}` : [currency, amount].filter(Boolean).join(' ');
}

// Formats a duration-based window name as compact minutes, hours, or days.
export function windowWord(window: string): string {
  if (owns(WINDOW_WORDS, window)) {
    return WINDOW_WORDS[window];
  }
  const found = MINUTE_WINDOW.exec(window);
  if (found) {
    const minutes = Number(found[1]);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    // Round each unit before choosing its range. A duration of 1439 minutes rounds to a day, preventing a `24h` label.
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    return `${Math.round(minutes / 1440)}d`;
  }
  // A window neither agent has reported before. Said as it arrived rather than dropped: a
  // figure with a name the panel does not know is still the reader's own limit.
  return window.replace(/_/g, ' ');
}

// Recognizes windows whose names encode a duration.
// Codex duration names take precedence over group-based Claude fallback labels.
function statesDuration(window: string): boolean {
  return owns(WINDOW_WORDS, window) || MINUTE_WINDOW.test(window);
}

// Fallback groups for recognized window names when the agent supplies no group.
const WINDOW_GROUPS: Record<string, string> = { five_hour: 'session', seven_day: 'weekly' };

function groupOf(limit: RateLimit): string {
  if (limit.group) {
    return limit.group;
  }
  return owns(WINDOW_GROUPS, limit.window) ? WINDOW_GROUPS[limit.window] : '';
}

// Identify each limit by its group and scope.
// `weekly_all` in a request and `seven_day` in a mid-turn event name the same clock.
// Using their window names would display that limit twice. A limit with no group uses its window as its identity.
function limitKey(limit: RateLimit): string {
  return `${groupOf(limit) || limit.window}:${limit.scope}`;
}

// Fallback durations for Claude session and weekly groups without duration-based window names.
const GROUP_LABELS: Record<string, string> = {
  session: '5h',
  weekly: '7d',
};

// Uses a model scope verbatim as the label. Otherwise use a stated duration before a group fallback.
// Collapsed figures and expanded rows use the same label.
function lineLabel(limit: RateLimit): string {
  if (limit.scope) {
    return limit.scope;
  }
  if (statesDuration(limit.window)) {
    return windowWord(limit.window);
  }
  const group = groupOf(limit);
  return owns(GROUP_LABELS, group) ? GROUP_LABELS[group] : windowWord(limit.window);
}

const GROUP_SPOKEN: Record<string, string> = {
  session: 'the session',
  weekly: 'the week',
};

// Accessible wording for the limit's group or duration.
function spokenWindow(limit: RateLimit): string {
  const group = groupOf(limit);
  if (owns(GROUP_SPOKEN, group)) {
    return GROUP_SPOKEN[group];
  }
  return `the ${windowWord(limit.window)} window`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const A_MINUTE_MS = 60_000;
const AN_HOUR_MS = 60 * A_MINUTE_MS;
const A_DAY_MS = 24 * AN_HOUR_MS;

// Both wordings of one reset, which are always written together.
export interface ResetWords {
  resets: string;
  resetsExact: string;
}

// Returns the next UTC month start as Unix seconds for an expected credit reset.
export function nextMonthStartUtc(now: number): number {
  const current = new Date(now);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1) / 1000;
}

export function resetWord(atSeconds: number | null, now: number, expected = false): ResetWords {
  if (atSeconds === null) {
    return { resets: '', resetsExact: '' };
  }
  const at = atSeconds * 1000;
  const d = new Date(at);
  return {
    resets: `resets ${countdown(at - now)}`,
    resetsExact: `${expected ? 'expected ' : ''}${DAYS[d.getDay()]} ${formatClock(at)}, ${d.getDate()} ${MONTHS[d.getMonth()]}`,
  };
}

// Format a duration using the largest unit with at least one whole unit, rounded down. Durations under a minute produce no text.
// The usage bar uses this scale for resets and ages.
function lengthWord(span: number): string {
  if (span < A_MINUTE_MS) {
    return '';
  }
  if (span < AN_HOUR_MS) {
    return `${Math.floor(span / A_MINUTE_MS)}m`;
  }
  if (span < A_DAY_MS) {
    return `${Math.floor(span / AN_HOUR_MS)}h`;
  }
  return `${Math.floor(span / A_DAY_MS)}d`;
}

// How far off a moment is. Under a minute is said in words: "in 0m" reads as a limit that
// has already gone.
function countdown(away: number): string {
  const length = lengthWord(away);
  return length ? `in ${length}` : 'in less than a minute';
}

// Combine one agent's readings. Complete readings with rate windows replace account-wide limits.
// Keep model-scoped live-event windows because account responses omit some models. Cap-only responses keep live windows because they contain no rate clocks.
// Partial mid-turn events update their named limit and keep the others.
// Retain the plan name from any reading that supplies one. Mid-turn events omit it.
export function foldUsage(current: AgentUsage | null, agent: string, reading: UsageReading): AgentUsage {
  const windows = new Map<string, WindowReading>();
  for (const window of current?.windows ?? []) {
    const keepEvent = window.source === 'event' && (Boolean(window.scope) || reading.limits.length === 0);
    if (!reading.complete || keepEvent) {
      windows.set(limitKey(window), window);
    }
  }
  const source = reading.complete ? 'account' : 'event';
  for (const limit of reading.limits) {
    windows.set(limitKey(limit), { ...limit, readAt: reading.readAt, source });
  }
  return {
    agent,
    plan: reading.plan || current?.plan || '',
    windows: [...windows.values()],
    spend: reading.spend
      ? { ...reading.spend, readAt: reading.readAt }
      : reading.complete
        ? null
        : (current?.spend ?? null),
    creditResetsAtSeconds: reading.creditResetsAtSeconds ?? current?.creditResetsAtSeconds ?? null,
    checkedAt: reading.complete ? reading.readAt : (current?.checkedAt ?? null),
  };
}

export function usagePlanLabel(usage: AgentUsage | undefined): string {
  if (!usage?.plan) {
    return '';
  }
  // Claude's usage control response and status output do not confirm the local credential hint.
  // Max is the most specific plan label supported by those sources.
  if (usage.agent === 'claude' && usage.plan === 'max') {
    return 'Max plan';
  }
  if (usage.agent === 'codex' && usage.plan === 'pro') {
    return 'Pro plan';
  }
  return `${usage.plan} plan`;
}

// A reading built from one free mid-turn event, which is one limit and no plan name.
export function limitReading(
  limit: RateLimit | null,
  readAt: number,
  creditResetsAtSeconds: number | null = null,
): UsageReading {
  return {
    plan: '',
    limits: limit ? [limit] : [],
    complete: false,
    spend: null,
    creditResetsAtSeconds,
    readAt,
  };
}

// Orders unscoped session limits, weekly limits, other limits, then model-scoped limits.
// Equal ranks retain reported order.
function rankOf(limit: RateLimit): number {
  if (limit.scope) {
    return 3;
  }
  const group = groupOf(limit);
  if (group === 'session') {
    return 0;
  }
  if (group === 'weekly') {
    return 1;
  }
  return 2;
}

// The model buckets the usage bar omits.
//
// Claude's `seven_day_overage_included` event names no model. Claude Code presents no row
// for it, while showing the account answer's named model limits. Codex live events can name
// a model bucket. Their scope keeps them distinct from the account limit in storage, but the
// account usage bar omits every scoped Codex window.
function isModelBucketWindow(agent: string, limit: RateLimit): boolean {
  return (!limit.scope && limit.window === 'seven_day_overage_included') || (agent === 'codex' && Boolean(limit.scope));
}

// Returns displayed windows whose reset has not passed, in reading order.
function liveLimits(usage: AgentUsage, now: number): WindowReading[] {
  return usage.windows
    .filter((w) => !isModelBucketWindow(usage.agent, w))
    .filter((w) => w.resetsAtSeconds === null || w.resetsAtSeconds * 1000 > now)
    .sort((a, b) => rankOf(a) - rankOf(b));
}

function liveCreditReset(at: number | null | undefined, now: number): number | null {
  if (at == null || at * 1000 <= now || at * 1000 > now + 365 * 24 * 60 * 60 * 1000) {
    return null;
  }
  return at;
}

// Claude calls its monetary credit window `overage`. It is the reset clock for the spend
// cap, not another limit to draw beside that cap.
function isCreditWindow(limit: RateLimit): boolean {
  return !limit.scope && limit.window === 'overage';
}

function percentOf(utilization: number): number {
  return Math.min(100, wholePercent(utilization));
}

function agentLabel(agent: string): string {
  return owns(USAGE_AGENT_NAMES, agent) ? USAGE_AGENT_NAMES[agent] : agent;
}

// The agents in the order they are offered in, with any the table does not name after them,
// in the order they arrived.
function agentOrder(agents: Iterable<string>): string[] {
  const seen = [...new Set(agents)];
  return [...USAGE_AGENT_ORDER.filter((a) => seen.includes(a)), ...seen.filter((a) => !USAGE_AGENT_ORDER.includes(a))];
}

// Prepares the usage bar for all supplied agents with a displayed window or spend cap.
// Returns null when no groups remain. Session selection does not narrow account usage.
export function usageBar(usages: AgentUsage[], now: number): UsageBar | null {
  const byAgent = new Map(usages.map((u) => [u.agent, u]));
  const briefs: UsageBrief[] = [];
  const groups: UsageGroup[] = [];
  // The oldest reading among the figures actually drawn. The bar says its age once, so it
  // must not let a fresh event make an older account cap sound fresh.
  let readAt = Number.POSITIVE_INFINITY;
  for (const agent of agentOrder(byAgent.keys())) {
    const usage = byAgent.get(agent);
    const live = usage ? liveLimits(usage, now) : [];
    const spend = usage?.spend ?? null;
    if (!usage || (!live.length && !spend)) {
      continue;
    }
    const creditWindow = live.find(isCreditWindow) ?? null;
    const rateWindows = live.filter((limit) => !isCreditWindow(limit));
    const label = agentLabel(agent);
    const figures: UsageFigure[] = [];
    const spoken: string[] = [];
    const lines: UsageLine[] = [];
    for (const limit of rateWindows) {
      readAt = Math.min(readAt, limit.readAt);
      const percent = percentOf(limit.utilization);
      const band = bandForPercent(percent);
      const level = band ? band.level : null;
      const { resets, resetsExact } = resetWord(limit.resetsAtSeconds, now);
      const name = lineLabel(limit);
      lines.push({
        key: `${agent}:${limitKey(limit)}`,
        label: name,
        percent,
        fill: percent,
        level,
        resets,
        resetsExact,
        detail: '',
        // Include utilization, relative reset, and exact reset time in the accessible name.
        // Tooltip-only reset text would be unavailable to screen-reader users.
        name: [`${name}, ${percent}% used`, resets, resetsExact].filter(Boolean).join(', '),
      });
      if (limit.scope) {
        continue;
      }
      figures.push({ percent, unit: name, level });
      spoken.push(`${percent}% of ${spokenWindow(limit)}`);
    }
    if (spend || creditWindow) {
      if (spend) {
        readAt = Math.min(readAt, spend.readAt);
      }
      if (creditWindow) {
        readAt = Math.min(readAt, creditWindow.readAt);
      }
      const percent = percentOf(spend?.utilization ?? creditWindow!.utilization);
      const band = bandForPercent(percent);
      const level = band ? band.level : null;
      const reportedReset =
        liveCreditReset(creditWindow?.resetsAtSeconds, now) ?? liveCreditReset(usage.creditResetsAtSeconds, now);
      const { resets, resetsExact } = resetWord(reportedReset ?? nextMonthStartUtc(now), now, reportedReset === null);
      const detail = spend
        ? `${moneyWord(spend.usedMinor, spend.exponent, spend.currency)} of ` +
          moneyWord(spend.limitMinor, spend.exponent, spend.currency)
        : '';
      lines.push({
        key: `${agent}:spend`,
        label: SPEND_LABEL,
        percent,
        fill: percent,
        level,
        resets,
        resetsExact,
        detail,
        name: [`${SPEND_LABEL}, ${percent}% used`, resets, resetsExact, detail].filter(Boolean).join(', '),
      });
      figures.push({ percent, unit: SPEND_LABEL, level });
      spoken.push(`${percent}% of ${SPEND_SPOKEN}`);
    }
    // Keep agents with only model-scoped limits in their own group. Omit them from the collapsed line, which has no account-wide figure for them.
    if (figures.length) {
      briefs.push({ agent, label, figures, name: [label, ...spoken].join(', ') });
    }
    groups.push({ agent, label, plan: usagePlanLabel(usage), lines });
  }
  if (!groups.length) {
    return null;
  }
  const stale = now - readAt > USAGE_FRESH_MS;
  // How old the figures are, on the ladder the reset times are drawn on. Empty inside the
  // fresh window, where the age is not a signal the reader can act on.
  const age = stale ? `updated ${lengthWord(now - readAt)} ago` : '';
  // The control that reads again carries the same words, so two wordings of one reading,
  // drawn a few pixels apart, can never name different numbers.
  const readWord = age || 'updated just now';
  // Adds the reading's clock time to stale accessible age wording.
  const spokenAge = stale ? `${age}, ${formatClock(readAt)}` : '';
  const said = [briefs.map((b) => b.name).join('. '), spokenAge].filter(Boolean).join(', ');
  return {
    briefs,
    groups,
    age,
    read: `${readWord} · press to read again`,
    name: said ? `${said}. Press to show every limit.` : 'Press to show every limit.',
  };
}

// One turn as the transcript poll sees it, which is all `agentsWithNewTurns` needs of it.
export interface TurnMark {
  id: string;
  agent: string;
  finished: boolean;
}

// Returns agents with newly observed finished turns and the updated seen-id set.
// An empty seen set primes history without requesting usage reads.
// Unfinished turns enter neither the result nor the seen set until completion.
export function agentsWithNewTurns(
  seen: ReadonlySet<string>,
  turns: readonly TurnMark[],
): { agents: string[]; seen: Set<string> } {
  const priming = seen.size === 0;
  const next = new Set(seen);
  const gained: string[] = [];
  for (const turn of turns) {
    if (!turn.finished) {
      continue;
    }
    if (!priming && !next.has(turn.id)) {
      gained.push(turn.agent);
    }
    next.add(turn.id);
  }
  return { agents: agentOrder(gained), seen: next };
}

// Retains account readings per agent. Each bar projection uses the caller's current clock.
export class UsageBook {
  private readonly byAgent = new Map<string, AgentUsage>();
  private readonly record: ((agent: string, reading: UsageReading) => void) | undefined;
  // Agents with failed usage reads. Suppress repeated automatic requests until a forced read.
  private readonly silent = new Set<string>();

  constructor(seed: readonly AgentUsage[] = [], record?: (agent: string, reading: UsageReading) => void) {
    this.record = record;
    for (const usage of seed) {
      this.byAgent.set(usage.agent, usage);
    }
  }

  note(agent: string, reading: UsageReading): void {
    try {
      this.record?.(agent, reading);
    } catch {
      // Historical recording failures leave current account figures available.
    }
    this.byAgent.set(agent, foldUsage(this.byAgent.get(agent) ?? null, agent, reading));
    this.silent.delete(agent);
  }

  noteLimit(agent: string, limit: RateLimit | null, readAt: number, creditResetsAtSeconds: number | null = null): void {
    this.note(agent, limitReading(limit, readAt, creditResetsAtSeconds));
  }

  // Marks an agent as unavailable without discarding its last reading.
  noteSilent(agent: string): void {
    this.silent.add(agent);
  }

  // Selects agents with no fresh complete reading, excluding failed automatic reads.
  // A forced read clears their failed state and includes every requested agent.
  toAsk(agents: readonly string[], now: number, force: boolean): string[] {
    if (force) {
      for (const agent of agents) this.silent.delete(agent);
      return [...agents];
    }
    return agents.filter((agent) => {
      if (this.silent.has(agent)) {
        return false;
      }
      const checkedAt = this.byAgent.get(agent)?.checkedAt ?? null;
      if (checkedAt === null) {
        return true;
      }
      return now - checkedAt > USAGE_FRESH_MS;
    });
  }

  usages(): AgentUsage[] {
    return [...this.byAgent.values()];
  }

  clear(): void {
    this.byAgent.clear();
    this.silent.clear();
  }

  // A window the bar does not draw sets no timer. The computed credit reset does, because
  // the row needs a repaint at the month boundary even when no new reading arrives.
  nextReset(now: number): number | null {
    const usages = this.usages();
    const future = usages
      .flatMap((usage) => usage.windows.filter((w) => !isModelBucketWindow(usage.agent, w) && !isCreditWindow(w)))
      .map((window) => window.resetsAtSeconds)
      .filter((at): at is number => at !== null && at * 1000 > now);
    for (const usage of usages) {
      const creditWindow = liveLimits(usage, now).find(isCreditWindow) ?? null;
      const reportedReset =
        liveCreditReset(creditWindow?.resetsAtSeconds, now) ?? liveCreditReset(usage.creditResetsAtSeconds, now);
      if (usage.spend || creditWindow) {
        future.push(reportedReset ?? nextMonthStartUtc(now));
      }
    }
    return future.length ? Math.min(...future) : null;
  }

  bar(now: number): UsageBar | null {
    return usageBar(this.usages(), now);
  }
}

// Shares the context caution thresholds with the usage bar.
export { CONTEXT_BANDS };
