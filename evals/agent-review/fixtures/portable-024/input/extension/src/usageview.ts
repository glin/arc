// What the usage bar shows, and what a reading of it means.
//
// Both agents answer for the reader's own rate limits, and neither charges model tokens to
// do it. The two payloads have nothing in common, so each wire reduces its own to
// `UsageReading` and everything after that point happens here: which limits are still about
// a period the reader is in, what each one is called, which caution band it sits in, when it
// resets, and how old the figure is.
//
// The bar has two faces and both are written here. Collapsed it carries a compact set of
// figures and no bars, because colour carries the caution band. Opened it lists every limit
// each agent reported, grouped as the agent groups them, with a bar on each.
//
// This file imports no `vscode`, so it is the part of the bar the tests can reach. `SCRIPT`
// in `panelhost.ts` draws what it is handed and decides none of it.

import { RateLimit, SpendCap, UsageReading } from './agentwire';
import { CONTEXT_BANDS, bandForPercent, formatClock, wholePercent } from './turnview';
import type { UsageBar, UsageBrief, UsageFigure, UsageGroup, UsageLine } from './view/usage.ts';
export type { UsageBar, UsageBrief, UsageFigure, UsageGroup, UsageLine } from './view/usage.ts';

// A table lookup that cannot find a function on the prototype. A window or a group named
// `constructor` would otherwise be treated as an entry that was never written down.
function owns(table: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

// The names on the bar. Not `AGENT_NAMES`, which names the source of a turn: these name the
// account the limit belongs to, the name is one word wide, and "Claude Code max" reads as a
// plan called Code. The two tables answer different questions and are meant to be able to
// differ.
export const USAGE_AGENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

// The order the agents are drawn in, which is the order they are offered in everywhere else.
export const USAGE_AGENT_ORDER: readonly string[] = ['claude', 'codex'];

// How long a figure stays fresh enough to say nothing about its age.
//
// A timestamp on a figure read seconds ago is a signal the reader cannot act on, and the bar
// is read again whenever the panel becomes visible and whenever a turn finishes, so most
// readings are seconds old. Past this the age is drawn, because a rate limit moves while
// nobody is looking at it.
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

// One limit's figure, and the moment that figure was read. The reading time rides the limit
// rather than the agent because the free mid-turn events carry one limit at a time, so an
// agent's limits can honestly have been read minutes apart.
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

// One figure on the collapsed line. It carries no width: the collapsed bar draws no bars,
// and a fill here would be an invitation to draw one.
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

// How long a window's clock runs, from the window's own name. A limit is named by its
// length rather than by a word for it, which is both what the reader asked for and what the
// Codex app itself prints. Short, because it shares a line with the figure, the bar and the
// reset time inside a sidebar.
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
    // Each unit is rounded before its own range is tested, so a length that rounds up to a
    // full day of hours is said as a day. Tested the other way round, 1439 minutes reads
    // `24h`, which is a day written in the unit below it.
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

// Whether a window's name says how long its clock runs. Codex names every window for its own
// length, so the length it reported is the length drawn; Claude names its own after the limit
// rather than the clock, and only the two names it shares with Codex land here.
function statesDuration(window: string): boolean {
  return owns(WINDOW_WORDS, window) || MINUTE_WINDOW.test(window);
}

// The clock a limit runs on, from the agent's own word for it.
//
// An agent that names no group leaves the window to answer, which is what a payload keyed by
// window name gives: the two windows both agents have always reported are the same two
// clocks under their old names. A limit that is neither is left without a group, and is
// drawn under its own window name.
const WINDOW_GROUPS: Record<string, string> = { five_hour: 'session', seven_day: 'weekly' };

function groupOf(limit: RateLimit): string {
  if (limit.group) {
    return limit.group;
  }
  return owns(WINDOW_GROUPS, limit.window) ? WINDOW_GROUPS[limit.window] : '';
}

// What one limit is, apart from every other limit the same agent reports.
//
// The group and the scope, not the window, because the two sources an agent answers through
// are free to name one clock two ways: a request that calls it `weekly_all` and a mid-turn
// event that calls it `seven_day` are one limit, and folding them under two names would draw
// the same figure twice under the same word. The window is the fallback for an agent that
// names no group, which is the one case where it is the only identity there is.
function limitKey(limit: RateLimit): string {
  return `${groupOf(limit) || limit.window}:${limit.scope}`;
}

// How long each clock runs, for an agent that reports the clock and not its length.
//
// Claude's listed limits carry a kind and a group and no duration at all. The same answer
// carries `five_hour` and `seven_day` as sibling keys for those very two clocks, so the
// lengths here are Claude's own words for its own windows rather than a guess. This is the
// one place a duration is inferred instead of reported.
const GROUP_LABELS: Record<string, string> = {
  session: '5h',
  weekly: '7d',
};

// What a limit is called, on the collapsed line and on the opened list alike, so a `5h` on
// the line names the `5h` row below it. A model-scoped limit takes the model's own display
// name, verbatim, because that is the word the reader knows it by and the panel has no
// better one. Anything else is named for how long its clock runs, and a stated length
// answers before a group does, so a session limit running on some other clock is never
// called five hours.
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

// The same figure said out loud. The collapsed line has room for `wk` and a reader listening
// to it does not, so the unit is spelled out here rather than read as two letters.
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

// How long the reader has, and the moment itself.
//
// The duration is what the line draws, because "in 4h" is the answer to the question a
// reader glancing at a limit is asking. It rounds down, so "in 4h" is at least four hours
// and never less. The moment is kept beside it for the hover, since a duration alone cannot
// be written into a calendar.
//
// A limit whose reset has already gone is dropped before it reaches here, so nothing below
// words a moment in the past.
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

// How long a stretch of time is, in the largest unit that still gives a whole number of it,
// rounded down. Empty under a minute, where no unit gives one.
//
// Every duration the bar draws is worded from here. A reset and an age are the same kind of
// fact pointing opposite ways, and a second ladder for the second of them would put two
// scales on one control.
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

// One agent's readings, folded together.
//
// A complete reading replaces the account-wide limits when it carries rate windows. Scoped
// live windows remain because the account answer can omit its per-model inventory. A cap-only
// answer keeps live windows too, because it says nothing about any rate clock. A partial
// mid-turn event names only the limit it covers, so that limit is updated without throwing
// away the others. The plan name is taken from any reading that carries one: the mid-turn
// events carry none, and dropping the name every time one arrives would make the bar flicker.
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
  // Neither Claude's usage control response nor its status output corroborates the local
  // credential hint, so Max is the most specific plan label the panel can report safely.
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

// The reading order the owner asked for: the session limit, then the week, then every
// model-scoped one in the order the agent reported it. The session comes first because it is
// the one that stops the reader today. A limit on some other clock sits between the week and
// the scoped ones, where a reader looking for the two familiar figures will already have
// passed it.
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

// The limits still worth drawing, in reading order. A limit whose reset time has already
// passed is not one of them, because its figure is about a period the reader has left and
// "93%, resets Tuesday" said on Wednesday is not a stale figure but a wrong one.
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

// The whole bar, or nothing at all when no agent has a live limit, so the panel draws no bar
// rather than an empty one.
//
// Every agent the folder uses is on it, not only the one whose session is on screen: a
// Claude session is often where a Codex run is dispatched from, and following the
// selection would hide a figure at the moment it is being spent.
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
        // The bar is drawn rather than written, so the figure and the reset are said here or
        // a reader who is not looking at the line loses both. The exact moment is said too,
        // because the hover that carries it is the one place it appears on screen and a
        // reader listening to the line reaches no hover.
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
    // An agent whose only live limits are model-scoped keeps its group and takes no part of
    // the collapsed line, rather than putting its name there with nothing after it.
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
  // The moment itself, which only the accessible name carries. A duration says how old a
  // figure is and never when it was read, and the two together pin one reading down:
  // "read 3d ago, 2:22 PM" is one moment and no other.
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

// Which agents gained a finished turn since the last look.
//
// Nothing else moves the figures for a turn run in a terminal: the bar is fed by children
// this window started, and the turns the reader actually watches are read off transcripts
// somebody else wrote. The poll knows when a finished turn appears, per session and so
// per agent, so the read hangs on that rather than on the reader remembering to press.
//
// `seen` is every turn id already counted, and the returned set replaces it. An empty one
// primes and names nobody: the first poll after a reload finds every turn in the folder new,
// and reading on that would pay a process start per agent on every window open, which the
// startup read already covers. An unfinished turn is counted nowhere and enters `seen`
// nowhere either, so it counts once, when it finishes.
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

// Everything the bar has been told, kept per agent. It holds no clock of its own: the wording
// is worked out from `Date.now()` at the moment the bar is drawn, so a reading left alone
// grows an age without anything having to repaint it.
export class UsageBook {
  private readonly byAgent = new Map<string, AgentUsage>();
  private readonly record: ((agent: string, reading: UsageReading) => void) | undefined;
  // The agents that could not answer. A machine with only one of the two CLIs installed
  // would otherwise pay a failed process start every time the panel came back into view,
  // for an agent that is never going to answer. Cleared when the reader presses the bar,
  // because a press is somebody saying to try again.
  private readonly silent = new Set<string>();

  constructor(seed: readonly AgentUsage[] = [], record?: (agent: string, reading: UsageReading) => void) {
    this.record = record;
    for (const usage of seed) {
      this.byAgent.set(usage.agent, usage);
    }
  }

  note(agent: string, reading: UsageReading): void {
    this.record?.(agent, reading);
    this.byAgent.set(agent, foldUsage(this.byAgent.get(agent) ?? null, agent, reading));
    this.silent.delete(agent);
  }

  noteLimit(agent: string, limit: RateLimit | null, readAt: number, creditResetsAtSeconds: number | null = null): void {
    this.note(agent, limitReading(limit, readAt, creditResetsAtSeconds));
  }

  // An agent that was asked and did not answer. Its last reading, if it has one, stays:
  // an old figure with its age on it says more than an empty bar.
  noteSilent(agent: string): void {
    this.silent.add(agent);
  }

  // Which of the agents to actually ask.
  //
  // Reading costs no model tokens, but it does cost a process start when nothing is
  // running, and the panel becoming visible is a common event. So a figure still inside
  // its fresh window is left alone, and an agent that has already failed to answer is not
  // asked again. A press says otherwise: the reader pressing the bar is asking for this
  // figure now, whatever its age, and it clears the silence too.
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

// The band table is re-exported so a reader of this file can see the bar takes the context
// chip's scale rather than one of its own. The panel keeps one vocabulary for getting full,
// and a second set of thresholds here would be two answers to one question.
export { CONTEXT_BANDS };
