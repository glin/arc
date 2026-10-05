import type { AgentFigureFacts } from '../view/stat-detail.ts';
import type { CardChip } from './stat-chip.ts';

export interface CardIcon {
  label: string;
  colour?: string;
  glyph?: { character: string; font: string; size: string; colour: string };
  image?: string;
}

export interface ActivityRow {
  sourceId?: string;
  kind: string;
  status: string;
  line: string;
  code: string;
  figure: string;
  since: number | null;
  title: string;
  name?: string;
  id?: string;
  at?: number;
  messageKind?: string;
  text?: string;
  summaryHtml?: string;
  when?: string;
  absolute?: string;
  spoken?: string;
  answerIndex?: number;
  count?: number;
  failed?: number;
  earlier?: number;
  earlierLine?: string;
  mix?: string;
  label?: string;
  hintDetail?: string;
  inFlight?: boolean;
  steps?: ActivityRow[];
}

// The figure a subagent row draws, as it arrives over the wire. It extends the shared
// declaration instead of intersecting with it, so a field written again here with a type the
// shared declaration does not allow fails at this `extends` clause.
export interface WireAgentFigure extends AgentFigureFacts {
  // The record behind this figure, widened to the rows a commits or a files record draws, so the
  // extension sends the shas and the paths rather than a second copy of the card's own arrays.
  record?: Record<string, unknown>;
}

export interface CardView extends Record<string, unknown> {
  kind: string;
  key: string;
  sessionId: string;
  sessionTitle?: string;
  status: string;
  statusWord: string;
  relative: string;
  absolute: string;
  duration: string;
  durationWord: string;
  durationDetail: string;
  lastRelative: string;
  lastAbsolute: string;
  label: string;
  agent: string;
  model: string | null;
  effort: string | null;
  headline: string;
  headlineHtml?: string;
  prompt: string;
  delegation: string;
  promptHeading: string;
  promptNotice: string;
  summary: string;
  summaryHtml?: string;
  earlierAnswers?: Array<{ at: number; absolute: string; summaryHtml?: string }>;
  saidMessages?: Array<{
    id: string;
    kind: string;
    at: number;
    text: string;
    when: string;
    summaryHtml?: string;
    absolute: string;
    answerIndex?: number;
  }>;
  saidName?: string;
  saidMix?: string;
  laterPrompts?: Array<{ text: string; when: string; absolute: string; label: string }>;
  files?: Array<{
    name: string;
    lead?: string;
    label: string;
    icon: CardIcon;
    path: string;
    shownPath: string;
    // What the row hovers with, where a row has more to say than its path. A row a subagent
    // changed names that subagent here.
    detail?: string;
    added: number;
    removed: number;
    isNew: boolean;
    countsUnknown?: true;
  }>;
  chips?: CardChip[];
  marks?: Array<{ word: string }>;
  live?: boolean;
  activity?: ActivityRow[];
  activityWord?: string;
  activityName?: string;
  activityCounts?: string[];
  activityTools?: string;
  activityToolCategories?: Array<{ key: string; label: string; count: number }>;
  activitySkills?: Array<{
    name: string;
    count: number;
    description?: string;
    fullDescription?: string;
    path?: string;
    shownPath?: string;
    evidence: string;
  }>;
  activitySkillCount?: number;
  activitySkillLabel?: string;
  doing?: string;
  doingCode?: string;
  doingSince?: number | null;
  startedAt: number;
  endedAt?: number;
  toolMix?: string;
  toolTally?: Array<{ name: string; count: number; category: string }>;
  agents?: Array<{
    kind?: 'subagent' | 'dispatch';
    files?: NonNullable<CardView['files']>;
    commits?: NonNullable<CardView['commits']>;
    description: string;
    model: string | null;
    effort: string | null;
    figures: WireAgentFigure[];
    state: 'done' | 'running' | 'open' | 'failed' | 'interrupted' | 'stopped';
    stateWord: string;
    since: number | null;
    hintDetail: string;
    sessionId: string | null;
  }>;
  dispatched?: CardView['agents'];
  commits?: Array<{
    objectSha?: string;
    kind: 'commit' | 'landing';
    key: string;
    sha: string;
    subject: string;
    repository: { key: string; name: string; own: boolean } | null;
    branch: string | null;
    headKind: 'branch' | 'detached' | null;
    dir: string | null;
    where: string | null;
    detail: string;
    added: number | null;
    removed: number | null;
    at: number;
    absolute: string;
    madeBy?: string;
    madeBySession: string | null;
    mergedBranch?: string | null;
    landingTarget?: string;
  }>;
  errorText?: string | null;
  at?: number;
}

// One figure drawn on a rail card. A message carries a session's figures once, keyed by
// session id under `stats`, and the rail takes the three it draws out of that record.
export interface RailStat {
  metric: string;
  compactLabel: string;
  detail?: string;
  level?: string | null;
  warnings?: readonly unknown[];
}

export interface RailCacheMark {
  expiresAt: number;
  nearlyGoneAt: number | null;
}

export interface RailCardView extends Record<string, unknown> {
  id: string;
  persisted: boolean;
  label: string;
  // The card's own drawn name, present only where it differs from `label`. A reader draws
  // `name ?? label`, so a session whose name never grew past the sixty-character label costs
  // nothing extra on the wire.
  name?: string;
  agent: string;
  agentWord: string;
  relative: string;
  at: number;
  absolute: string;
  current: boolean;
  pinnedTop: boolean;
  archived: boolean;
  agentRun?: boolean;
  // The same fact `agentRun` names, apart from which bucket the card sits in. Declared
  // beside it so a card built for the panel cannot drop it and still satisfy this type:
  // `railCounts` and `is:warm` read it straight through archiving, where `agentRun` does not.
  runByAgent?: boolean;
  status: 'background' | 'done' | 'failed' | 'interrupted' | 'running' | 'stopped' | 'subagents' | 'waiting' | null;
  subagents: number | null;
  commands: number | null;
  runningSince: number | null;
  runningSinceWhen: string | null;
  cache: RailCacheMark | null;
  nameBeforeAge: string;
  nameAfterAge: string;
  unsentWord: string | null;
  unsentName: string | null;
  // How many turns the reader has not seen, such as `3 new` or `at least 3 new`, or null.
  indicator: string | null;
  costDollars: number | null;
  costAtLeast: boolean;
  // The exact cache-expiry return count `cache-expiry:` matches on. Declared beside the cost
  // fields it is read the same way as, though no rail stat draws it.
  cacheExpiryCount: number | null;
  // Whether that count is a floor rather than the whole answer, read the same way `costAtLeast`
  // is.
  cacheExpiryAtLeast: boolean;
  labels: string[];
  labelChips: string[];
  labelsMore: string | null;
  labelsMoreName: string | null;
  unread: boolean;
  newestTurnAt: number | null;
  menuSection: string;
}
