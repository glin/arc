import * as fs from 'node:fs';
import { createClaudeCopyFilter } from './claudecopies';
import { createInterface } from 'node:readline';
import {
  ClaudeChildSessionCache,
  claudeProcessEndedAt,
  createClaudeRelationshipReducer,
  createClaudeSessionReducer,
  projectsRoot,
  readSessionWork,
  refreshClaudeAgentFacts,
  sessionFilesFor,
  sessionOutcomeOf,
  type SessionFile,
  type SessionRead,
  type ClaudeChildSessionFile,
  type ClaudeChildSessionReference,
} from './transcript';
import { carriedSubagentCount, liveTimelineChildren, outcomesFor, timelineRailState } from './timelinestate';
import { toCard, TURN_QUIET_MS, type TurnCard } from './turncard';
import { childrenOutliveTurn, type RailStatus } from './view/rail';
import { CHILD_CLOSE_MARGIN_MS } from './turnrail';

export type TimelineRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export interface TimelineFinding {
  rule: TimelineRule;
  result: 'pass' | 'violation' | 'unknown';
  session: string;
  turn?: string;
  child?: string;
  reason: string;
  lastWork?: number;
  close?: number;
  closeStatus?: string;
  writtenAt?: number;
}

export interface TimelineEvidence {
  complete: boolean;
  workComplete: boolean;
  lastWork?: number;
  writtenAt?: number;
  processEndedAt?: number;
  closes: Map<string, { at: number; status: string }>;
  background: Set<string>;
}

type RawRecord = Record<string, any>;

export function timelineRecordTime(record: RawRecord): number | undefined {
  const value = record.attachment?.timestamp ?? record.timestamp;
  const at = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(at) ? at : undefined;
}

// Raw evidence does not use the transcript parser's completion or activity reducers.
export function createTimelineEvidenceReader(now: number, writtenAt?: number) {
  const evidence: TimelineEvidence = {
    complete: true,
    workComplete: true,
    closes: new Map(),
    background: new Set(),
    ...(writtenAt === undefined ? {} : { writtenAt: Math.min(writtenAt, now) }),
  };
  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block?.type === 'text' ? block.text : '')).join('\n')
        : '';
  return {
    evidence,
    apply(record: RawRecord) {
      const at = timelineRecordTime(record);
      const processEndedAt = claudeProcessEndedAt(record);
      if ((at !== undefined && at > now) || (processEndedAt !== null && processEndedAt > now)) return;
      if (processEndedAt !== null) {
        evidence.processEndedAt = Math.max(evidence.processEndedAt ?? -Infinity, processEndedAt);
      }
      if (record.type === 'user' || record.type === 'assistant') {
        if (at === undefined) evidence.workComplete = false;
        else evidence.lastWork = Math.max(evidence.lastWork ?? -Infinity, at);
      }
      const result = record.toolUseResult;
      if (record.type === 'user' && result?.agentId && (result.status === 'running' || result.isAsync === true)) {
        evidence.background.add(String(result.agentId));
      }
      const content = textOf(record.message?.content);
      for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
        const resultText = block.type === 'tool_result' ? textOf(block.content) : '';
        if (/^\s*Async agent launched/.test(resultText)) {
          const id = /(?:^|\n)agentId: ([A-Za-z0-9-]+)/.exec(resultText)?.[1];
          if (id) evidence.background.add(id);
        }
      }
      const notice =
        record.type === 'user' && record.origin?.kind === 'task-notification'
          ? content
          : record.type === 'attachment' &&
              record.attachment?.type === 'queued_command' &&
              record.attachment.commandMode === 'task-notification'
            ? textOf(record.attachment.prompt)
            : null;
      if (notice === null) return;
      const id = /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1];
      const status = /<status>([^<]+)<\/status>/.exec(notice)?.[1];
      if (!id || !status || !['completed', 'failed', 'killed', 'interrupted', 'stopped'].includes(status)) return;
      if (at === undefined) evidence.complete = false;
      else if (at >= (evidence.closes.get(id)?.at ?? -Infinity)) evidence.closes.set(id, { at, status });
    },
  };
}

export interface TimelineCheckState {
  session: string;
  cards: TurnCard[];
  liveChildren: ReadonlySet<string>;
  carried: number;
  rail?: RailStatus;
  parent?: TimelineEvidence;
  children: ReadonlyMap<string, TimelineEvidence>;
}

export function checkTimeline(state: TimelineCheckState, now: number): TimelineFinding[] {
  const findings: TimelineFinding[] = [];
  const add = (rule: TimelineRule, result: TimelineFinding['result'], reason: string, rest = {}): void => {
    findings.push({ rule, result, session: state.session, reason, ...rest });
  };
  const newest = state.cards.at(-1);
  const rows = state.cards.flatMap((card) => card.agents.map((row) => ({ card, row })));
  const represented = new Set(rows.flatMap(({ row }) => (row.sessionId ? [row.sessionId] : [])));
  const childRows = [
    ...rows.map(({ card, row }) => ({ id: row.sessionId, running: row.state === 'running', turn: card.key })),
    ...[...state.liveChildren]
      .filter((id) => !represented.has(id))
      .map((id) => ({ id, running: true, turn: newest?.key })),
  ];
  for (const child of childRows) {
    const evidence = child.id ? state.children.get(child.id) : undefined;
    const close = child.id ? state.parent?.closes.get(child.id) : undefined;
    const times = {
      turn: child.turn,
      ...(child.id ? { child: child.id } : {}),
      ...(evidence?.lastWork === undefined ? {} : { lastWork: evidence.lastWork }),
      ...(evidence?.writtenAt === undefined ? {} : { writtenAt: evidence.writtenAt }),
      ...(close ? { close: close.at, closeStatus: close.status } : {}),
    };
    if (
      !child.id ||
      !state.parent?.complete ||
      !state.parent.background.has(child.id) ||
      !evidence?.complete ||
      !evidence.workComplete ||
      evidence.lastWork === undefined ||
      evidence.writtenAt === undefined
    ) {
      add('R1', 'unknown', 'Background identity or work evidence is unavailable', times);
      add('R2', 'unknown', 'Background identity or work evidence is unavailable', times);
      continue;
    }
    const fresh = now - evidence.lastWork <= TURN_QUIET_MS;
    const resumed = close !== undefined && evidence.lastWork > close.at + CHILD_CLOSE_MARGIN_MS;
    const ended = state.parent.processEndedAt !== undefined && evidence.lastWork <= state.parent.processEndedAt;
    add(
      'R1',
      child.running && (!fresh || (close !== undefined && !resumed)) ? 'violation' : 'pass',
      'Running child requires recent work after its close',
      times,
    );
    add(
      'R2',
      fresh && resumed && !ended && !child.running ? 'violation' : 'pass',
      'Recent resumed work requires a running child',
      times,
    );
  }
  if (!newest || !childrenOutliveTurn(newest.status)) {
    add('R3', 'unknown', 'An idle newest card is unavailable');
    add('R4', 'unknown', 'An idle newest card is unavailable');
  } else {
    // A carried child already drawn on an older card counts once.
    const running = new Set(childRows.filter((child) => child.running && child.id).map((child) => child.id));
    const figure = newest.chips.find((chip) => chip.metric === 'agents')?.running ?? 0;
    add(
      'R3',
      figure === running.size ? 'pass' : 'violation',
      `Output consistency: figure ${figure}, running children ${running.size}`,
      { turn: newest.key },
    );
    add(
      'R4',
      state.rail === undefined ? 'unknown' : (state.rail === 'subagents') === running.size > 0 ? 'pass' : 'violation',
      `Output consistency: rail ${state.rail ?? 'unavailable'}, running children ${running.size}`,
      { turn: newest.key },
    );
  }
  for (const card of state.cards) {
    for (const metric of ['agents', 'files']) {
      const chip = card.chips.find((value) => value.metric === metric);
      const carried = metric === 'agents' && card === newest ? state.carried : 0;
      const count = chip ? /^([0-9]+)\b/.exec(chip.label)?.[1] : '0';
      const total =
        count === undefined && chip?.label === 'no file changes' ? 0 : count === undefined ? undefined : Number(count);
      const record = chip?.detailList?.entries;
      const rowCount = metric === 'agents' ? card.agents.length : card.files.length;
      const missing = total === undefined || (chip !== undefined && rowCount > 0 && record === undefined);
      const matches =
        total === rowCount + carried &&
        (record === undefined || chip?.detailList?.layout === undefined || record.length === rowCount);
      add(
        'R5',
        missing ? 'unknown' : matches ? 'pass' : 'violation',
        `${metric} figure ${total ?? 'unavailable'}, rows ${rowCount}, carried ${carried}`,
        { turn: card.key },
      );
    }
  }
  return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
}

interface TimelineRead {
  read: SessionRead;
  evidence: TimelineEvidence;
  references: ClaudeChildSessionReference[];
}

async function readTimelineFile(session: SessionFile, now: number): Promise<TimelineRead> {
  const parser = createClaudeSessionReducer(session.sessionId, {
    maxTurns: Number.MAX_SAFE_INTEGER,
    childTranscript: session.childTranscript,
    turnsOnly: true,
  });
  const relationships = createClaudeRelationshipReducer(session);
  const raw = createTimelineEvidenceReader(now, session.mtimeMs);
  try {
    const lines = createInterface({ input: fs.createReadStream(session.file), crlfDelay: Infinity });
    const copies = createClaudeCopyFilter();
    for await (const line of lines) {
      if (!line.trim() || copies(line)) continue;
      let record: RawRecord;
      try {
        record = JSON.parse(line);
      } catch {
        raw.evidence.complete = false;
        continue;
      }
      const recordedAt = timelineRecordTime(record);
      const processEndedAt = claudeProcessEndedAt(record);
      if ((recordedAt !== undefined && recordedAt > now) || (processEndedAt !== null && processEndedAt > now)) continue;
      raw.apply(record);
      parser.pushLine(line);
      relationships.apply(line);
    }
  } catch {
    raw.evidence.complete = false;
  }
  return {
    read: parser.read(),
    evidence: raw.evidence,
    references: relationships.references().filter((reference) => reference.kind !== 'dispatch'),
  };
}

export async function sweepTimeline(project: string, since: number, now: number, root = projectsRoot()) {
  const parentIds = new Set<string>();
  const parents = sessionFilesFor(root, [project]).filter((session) => {
    if (session.mtimeMs < since || parentIds.has(session.sessionId)) return false;
    parentIds.add(session.sessionId);
    return true;
  });
  const reads = new Map<string, TimelineRead>();
  const children: ClaudeChildSessionFile[] = [];
  const references: ClaudeChildSessionReference[] = [];
  const cache = new ClaudeChildSessionCache();
  const queue = [...parents];
  const seen = new Set<string>();
  const sessions: SessionFile[] = [];
  while (queue.length) {
    const session = queue.shift()!;
    if (seen.has(session.file)) continue;
    seen.add(session.file);
    const data = await readTimelineFile(session, now);
    reads.set(session.file, data);
    sessions.push(session);
    for (const reference of data.references) {
      references.push(reference);
      if (reference.kind === 'dispatch') continue;
      const child = cache.read(reference, [project]);
      if (child) {
        children.push({ ...child, mtimeMs: Math.min(child.mtimeMs, now) });
        queue.push(child);
      }
    }
  }
  for (const session of sessions) {
    refreshClaudeAgentFacts(
      reads.get(session.file)!.read.turns,
      undefined,
      (agent) =>
        children.find(
          (child) =>
            child.parentSessionId === session.sessionId &&
            child.sessionId === agent.id &&
            agent.toolUseId &&
            child.toolUseIds.includes(agent.toolUseId),
        )?.sessionId ?? null,
    );
  }
  const outcomes = outcomesFor(
    sessions,
    {},
    (file) => reads.get(file)?.read,
    (session) => ({ outcome: sessionOutcomeOf(reads.get(session.file)!.read), backgroundCommands: [] }),
  );
  const live = liveTimelineChildren(
    outcomes,
    children,
    references,
    new Map(),
    new Map(),
    now,
    (file) => readSessionWork(file, undefined, now) ?? undefined,
  );
  const rail = timelineRailState(outcomes, live, new Set(), new Set(), new Map(), new Map(), now);
  const findings: TimelineFinding[] = [];
  let checked = 0;
  for (const session of sessions) {
    const data = reads.get(session.file)!;
    const turns = data.read.turns;
    const applicable = turns.length > 0 && Math.max(...turns.map((turn) => turn.endedAt)) >= since;
    if (!data.evidence.complete) {
      findings.push({
        rule: 'R1',
        result: 'unknown',
        session: session.sessionId,
        reason: 'Parent evidence is incomplete',
      });
    }
    if (!applicable && data.evidence.complete) continue;
    checked++;
    if (!applicable) continue;
    const liveChildren = new Set(live.get(session.sessionId) ?? []);
    const cards = turns.map((turn, index) =>
      toCard(turn, index === turns.length - 1, now, [project], null, false, liveChildren),
    );
    const newest = cards.at(-1)!;
    const childEvidence = new Map(
      children
        .filter((child) => child.parentSessionId === session.sessionId)
        .flatMap((child) => {
          const evidence = reads.get(child.file)?.evidence;
          return evidence ? [[child.sessionId, evidence] as const] : [];
        }),
    );
    findings.push(
      ...checkTimeline(
        {
          session: session.sessionId,
          cards,
          liveChildren,
          carried: carriedSubagentCount(turns.at(-1)!, true, newest.status, liveChildren),
          rail: rail.statuses.get(session.sessionId),
          parent: data.evidence,
          children: childEvidence,
        },
        now,
      ),
    );
  }
  return {
    project,
    now,
    since,
    sessions: checked,
    violations: findings.filter((finding) => finding.result === 'violation'),
    unknown: findings.filter((finding) => finding.result === 'unknown').length,
    historicalWrites: 'Current file write times clamped to observation time. Historical write times are unavailable.',
  };
}
