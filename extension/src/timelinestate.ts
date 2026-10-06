import { sessionOutcomeOf, type SessionFile, type SessionMeta, type SessionRead, type TurnOutcome } from './transcript';
import {
  childWriteKey,
  claudeChildWriteIndex,
  liveOpenChildren,
  openChildCounts,
  outcomeWithWiderChildren,
  sessionStatusOf,
} from './turnrail';
import type { SessionRailFacts } from './projectspend';
import type { ClaudeChildSessionFile, ClaudeChildSessionReference } from './transcript';

export { carriedSubagentCount } from './turncard';

// Combine accepted tail, lifetime, and parsed reads without reopening their files.
export function outcomesFor(
  sessions: readonly SessionFile[],
  lifetime: Readonly<Record<string, SessionRailFacts>>,
  parsedFor: (file: string) => SessionRead | undefined,
  metaFor: (session: SessionFile) => Pick<SessionMeta, 'outcome' | 'backgroundCommands'>,
): Map<string, TurnOutcome | null> {
  return new Map(
    sessions.map((session) => {
      const parsed = parsedFor(session.file);
      const meta = metaFor(session);
      return [
        session.sessionId,
        outcomeWithWiderChildren(
          meta.outcome ?? null,
          lifetime[session.sessionId]?.outcome ?? null,
          parsed ? sessionOutcomeOf(parsed) : null,
          meta.backgroundCommands,
        ),
      ];
    }),
  );
}

// Resolve child writes only when an outcome needs them. Dispatched sessions use separate status evidence.
export function liveTimelineChildren(
  outcomes: ReadonlyMap<string, TurnOutcome | null>,
  children: readonly ClaudeChildSessionFile[],
  references: readonly ClaudeChildSessionReference[],
  statWrites: ReadonlyMap<string, number>,
  hostExitedAt: ReadonlyMap<string, number>,
  now: number,
): Map<string, string[]> {
  let index: Map<string, number> | null = null;
  const writtenAt = (session: string, child: string): number | undefined => {
    index ??= claudeChildWriteIndex(
      children,
      references.flatMap((reference) => (reference.kind === 'dispatch' ? [] : [reference])),
      statWrites,
    );
    return index.get(childWriteKey(session, child));
  };
  return liveOpenChildren(outcomes, writtenAt, hostExitedAt, now);
}

// Session-list status and child counts share the supplied observation clock and live child IDs.
export function timelineRailState(
  outcomes: ReadonlyMap<string, TurnOutcome | null>,
  children: ReadonlyMap<string, readonly string[]>,
  running: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  runningSince: ReadonlyMap<string, number>,
  backgroundCommands: ReadonlyMap<string, number>,
  now: number,
): { statuses: ReturnType<typeof sessionStatusOf>; openChildren: Map<string, number> } {
  const openChildren = openChildCounts(children);
  const statuses = sessionStatusOf([], running, outcomes, now, waiting, runningSince, openChildren, backgroundCommands);
  return { statuses, openChildren };
}
