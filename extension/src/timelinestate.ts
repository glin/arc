import {
  readSessionWork,
  sessionOutcomeOf,
  type SessionFile,
  type SessionMeta,
  type SessionRead,
  type TurnOutcome,
} from './transcript';
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

// Cache positive and absent work timestamps at the child's exact file version.
export class ClaudeChildWorkCache {
  private entries = new Map<string, { version: string; at: number | undefined }>();

  read(file: string, version: string, reader = readSessionWork): number | undefined {
    const held = this.entries.get(file);
    if (held?.version === version) return held.at;
    const at = reader(file) ?? undefined;
    this.entries.set(file, { version, at });
    return at;
  }

  retain(files: ReadonlySet<string>): void {
    for (const file of this.entries.keys()) {
      if (!files.has(file)) this.entries.delete(file);
    }
  }
}

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
// A child with no write time in the discovery index takes its write time from `unlistedAt`.
export function liveTimelineChildren(
  outcomes: ReadonlyMap<string, TurnOutcome | null>,
  children: readonly ClaudeChildSessionFile[],
  references: readonly ClaudeChildSessionReference[],
  statWrites: ReadonlyMap<string, number>,
  hostExitedAt: ReadonlyMap<string, number>,
  now: number,
  workAt: (file: string) => number | undefined = () => undefined,
  unlistedAt: (session: string, child: string) => number | undefined = () => undefined,
): Map<string, string[]> {
  let index: Map<string, number> | null = null;
  const writtenAt = (session: string, child: string): number | undefined => {
    index ??= claudeChildWriteIndex(
      children,
      references.flatMap((reference) => (reference.kind === 'dispatch' ? [] : [reference])),
      statWrites,
    );
    return index.get(childWriteKey(session, child)) ?? unlistedAt(session, child);
  };
  let files: Map<string, string> | null = null;
  const childWorkAt = (session: string, child: string): number | undefined => {
    files ??= new Map([
      ...children.map((child) => [childWriteKey(child.parentSessionId, child.sessionId), child.file] as const),
      ...references
        .filter((reference) => reference.kind !== 'dispatch')
        .map((reference) => [childWriteKey(reference.parentSessionId, reference.sessionId), reference.file] as const),
    ]);
    const file = files.get(childWriteKey(session, child));
    return file === undefined ? undefined : workAt(file);
  };
  return liveOpenChildren(outcomes, writtenAt, hostExitedAt, now, childWorkAt);
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
