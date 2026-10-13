import { turnKey } from './domain/read';
import {
  pricedNativeCacheReturns,
  publicProjectSpendPrice,
  type CacheExpiryCost,
  type CacheExpiryFacts,
  type CacheExpiryReturn,
  type NativeChildCacheFacts,
  type ProjectSpendPricer,
} from './projectspend';
import type { Turn, TurnOutcome } from './transcript';
import { CHILD_CLOSE_MARGIN_MS } from './turnrail';

export interface ChildExpiryCost extends CacheExpiryCost {
  count: number;
  longestGapMs: number;
}

interface Span {
  turn: Turn;
  start: number;
  end: number;
  next: number;
  cap: number;
  ambiguous: boolean;
  closures: Map<string, number>;
}
const clock = (at: number | null | undefined): at is number =>
  at !== undefined && at !== null && Number.isFinite(at) && at > 0;

// Prices survive a different card batch while their accepted source revision stays unchanged.
export class ChildCacheExpiryAttribution {
  private prices = new Map<
    string,
    {
      revision: NativeChildCacheFacts['revision'];
      facts: CacheExpiryFacts;
      pricer: ProjectSpendPricer;
      returns: ReturnType<typeof pricedNativeCacheReturns>;
    }
  >();

  read(
    turns: readonly Turn[],
    facts: Readonly<Record<string, Readonly<CacheExpiryFacts>>>,
    now: number,
    outcomes: ReadonlyMap<string, TurnOutcome | null> = new Map(),
    ongoing: ReadonlySet<string> = new Set(),
    pricer: ProjectSpendPricer = publicProjectSpendPrice,
    inspect: (item: CacheExpiryReturn) => void = () => {},
  ): Map<string, ChildExpiryCost> {
    const bySession = new Map<string, Turn[]>();
    for (const turn of turns) {
      const group = bySession.get(turn.sessionId) ?? [];
      group.push(turn);
      bySession.set(turn.sessionId, group);
    }
    const result = new Map<string, ChildExpiryCost>();
    const retained = new Set<string>();
    for (const [sessionId, group] of bySession) {
      const closures = new Map<string, number>();
      const untimed = new Set<string>();
      for (const child of outcomes.get(sessionId)?.closedChildren ?? []) {
        if (typeof child === 'string') untimed.add(child);
        else if (clock(child.closedAt)) closures.set(child.id, child.closedAt);
      }
      const sorted = group.filter((turn) => clock(turn.startedAt)).sort((a, b) => a.startedAt - b.startedAt);
      const spans: Span[] = sorted.map((turn, at) => {
        const next = sorted[at + 1]?.startedAt ?? Infinity;
        const outcome = outcomes.get(sessionId);
        const matching = outcome?.startedAt === turn.startedAt ? outcome : null;
        const processEnd = turn.processEndedAt ?? matching?.processEndedAt;
        const recordedEnd = Math.max(turn.endedAt ?? turn.startedAt, matching?.endedAt ?? 0);
        const liveEnd = at === sorted.length - 1 && ongoing.has(sessionId) ? now : recordedEnd;
        const cap = clock(processEnd) ? processEnd : Infinity;
        return {
          turn,
          start: turn.startedAt,
          end: Math.min(Math.max(recordedEnd, liveEnd), cap),
          next,
          cap,
          ambiguous: sorted[at - 1]?.startedAt === turn.startedAt || next === turn.startedAt,
          closures: new Map(
            (turn.agents ?? []).flatMap((agent) =>
              clock(agent.closedAt) ? [[agent.childSessionId ?? agent.id ?? '', agent.closedAt] as const] : [],
            ),
          ),
        };
      });
      for (const source of facts[sessionId]?.childSources ?? []) {
        retained.add(source.source);
        let priced = this.prices.get(source.source);
        if (
          !priced ||
          priced.revision !== source.revision ||
          priced.facts !== source.facts ||
          priced.pricer !== pricer
        ) {
          priced = {
            revision: source.revision,
            facts: source.facts,
            pricer,
            returns: pricedNativeCacheReturns(source, pricer),
          };
          this.prices.set(source.source, priced);
        }
        const childId =
          source.childId ??
          source.source
            .replaceAll('\\', '/')
            .split('/')
            .pop()!
            .replace(/^agent-/, '')
            .replace(/\.jsonl$/, '');
        for (const { item, cost } of priced.returns) {
          inspect(item);
          if (!clock(item.timestamp)) continue;
          let low = 0,
            high = spans.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            if (spans[mid].start <= item.timestamp) low = mid + 1;
            else high = mid;
          }
          const span = spans[low - 1];
          if (
            !span ||
            span.ambiguous ||
            span.end < span.start ||
            item.timestamp >= span.next ||
            item.timestamp > span.cap
          )
            continue;
          const closedAt = Math.max(closures.get(childId) ?? 0, span.closures.get(childId) ?? 0) || undefined;
          const legacyClosed = untimed.has(childId);
          // Recorded work beyond the shared closure margin reopens that child's work episode.
          const reopened =
            clock(closedAt) && clock(source.endedAt) && source.endedAt > closedAt + CHILD_CLOSE_MARGIN_MS;
          if (
            (legacyClosed && item.timestamp > (span.turn.endedAt ?? span.start)) ||
            (clock(closedAt) &&
              item.timestamp > closedAt &&
              (!reopened || item.timestamp <= closedAt + CHILD_CLOSE_MARGIN_MS))
          )
            continue;
          // A retained return establishes historical child activity independently of write freshness.
          const key = turnKey(span.turn);
          const held = result.get(key) ?? { count: 0, longestGapMs: 0, dollars: null, status: 'exact' as const };
          held.count++;
          held.longestGapMs = Math.max(held.longestGapMs, item.gapMs);
          if (cost.dollars !== null) held.dollars = (held.dollars ?? 0) + cost.dollars;
          if (cost.status !== 'exact' || source.facts.truncated || facts[sessionId]?.incompleteSources)
            held.status = 'atLeast';
          result.set(key, held);
        }
      }
    }
    for (const source of this.prices.keys()) if (!retained.has(source)) this.prices.delete(source);
    for (const value of result.values()) if (value.dollars === null) value.status = 'unknown';
    return result;
  }
}
