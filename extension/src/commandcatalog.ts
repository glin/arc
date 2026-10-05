import { PromptEntry } from './agentwire';

export interface CommandCatalogSource {
  agent: string;
  commands: readonly PromptEntry[];
}

export interface CommandCatalogUpdate extends CommandCatalogSource {
  complete: boolean;
}

function sameEntry(left: PromptEntry, right: PromptEntry): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.description === right.description &&
    left.argumentHint === right.argumentHint &&
    left.path === right.path
  );
}

function sameEntries(left: readonly PromptEntry[] | undefined, right: readonly PromptEntry[]): boolean {
  return (
    left !== undefined && left.length === right.length && left.every((entry, index) => sameEntry(entry, right[index]))
  );
}

function sameCatalogs(
  left: Readonly<Record<string, readonly PromptEntry[]>>,
  right: Readonly<Record<string, readonly PromptEntry[]>>,
): boolean {
  const leftAgents = Object.keys(left);
  const rightAgents = Object.keys(right);
  return (
    leftAgents.length === rightAgents.length &&
    leftAgents.every((agent) => agent in right && sameEntries(left[agent], right[agent]))
  );
}

// Holds agent command lists. Complete updates or nonempty partial updates replace a list.
// A captured revision lets a live update invalidate an older idle read.
// The Prompt box payload remains independent of process lifetime.
export class CommandCatalogs {
  private lists: Record<string, PromptEntry[]> = {};
  private readonly revisions = new Map<string, number>();

  revision(agent: string): number {
    return this.revisions.get(agent) ?? 0;
  }

  current(): Readonly<Record<string, readonly PromptEntry[]>> {
    return this.lists;
  }

  publish(
    sources: readonly CommandCatalogSource[],
    update?: CommandCatalogUpdate,
    expectedRevision?: number,
  ): Record<string, PromptEntry[]> | null {
    if (update && expectedRevision !== undefined && this.revision(update.agent) !== expectedRevision) {
      return null;
    }

    const next = { ...this.lists };
    if (update && (update.complete || update.commands.length > 0)) {
      next[update.agent] = update.commands.map((entry) => ({ ...entry }));
      this.revisions.set(update.agent, this.revision(update.agent) + 1);
    }
    for (const source of sources) {
      if (!(source.agent in next) && source.commands.length > 0) {
        next[source.agent] = source.commands.map((entry) => ({ ...entry }));
      }
    }
    if (sameCatalogs(this.lists, next)) {
      return null;
    }
    this.lists = next;
    return next;
  }
}
