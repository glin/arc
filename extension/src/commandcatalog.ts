import { PromptEntry } from './agentwire';

export interface CommandCatalogSource {
  agent: string;
  commands: readonly PromptEntry[];
  key?: string;
  usageSource?: number;
  sessionId?: string | null;
  exited?: boolean;
}

export interface CommandCatalogUpdate extends CommandCatalogSource {
  complete: boolean;
  optionalOnly?: boolean;
}

function sameEntry(left: PromptEntry, right: PromptEntry): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.description === right.description &&
    left.argumentHint === right.argumentHint &&
    left.path === right.path &&
    left.sessionSkillRelease === right.sessionSkillRelease
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

// Ordinary provider lists survive child retirement. Supplied entries retain their child generation.
// A captured revision lets a live update invalidate an older idle read.
export class CommandCatalogs {
  private lists: Record<string, PromptEntry[]> = {};
  private readonly revisions = new Map<string, number>();
  private readonly children = new Map<string, { generation: number; commands: PromptEntry[] }>();
  private childIdentities = '';

  childCommands(
    sources: readonly CommandCatalogSource[],
    drafts: ReadonlyMap<string, string> = new Map(),
  ): Record<string, PromptEntry[]> {
    const commands: Record<string, PromptEntry[]> = {};
    for (const source of sources) {
      if (!source.key || source.exited) continue;
      const child = this.children.get(source.key);
      if (!child || child.generation !== source.usageSource) continue;
      if (source.sessionId) commands[source.sessionId] = child.commands;
      for (const [id, key] of drafts) if (key === source.key) commands[id] = child.commands;
    }
    return commands;
  }

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
    const identities = JSON.stringify(
      sources
        .filter((source) => source.key)
        .map((source) => [source.key, source.usageSource, source.sessionId, source.exited]),
    );
    let childChanged = identities !== this.childIdentities;
    this.childIdentities = identities;
    for (const [key, child] of this.children)
      if (!sources.some((source) => source.key === key && source.usageSource === child.generation && !source.exited)) {
        this.children.delete(key);
        childChanged = true;
      }
    if (
      update?.key &&
      update.usageSource !== undefined &&
      sources.some((source) => source.key === update.key && source.usageSource === update.usageSource && !source.exited)
    ) {
      const commands = update.commands.filter((entry) => entry.sessionSkillRelease).map((entry) => ({ ...entry }));
      const previous = this.children.get(update.key);
      if (previous?.generation !== update.usageSource || !sameEntries(previous.commands, commands)) {
        this.children.set(update.key, { generation: update.usageSource, commands });
        childChanged = true;
      }
    }
    if (update && !update.optionalOnly && (update.complete || update.commands.length > 0)) {
      next[update.agent] = update.commands.filter((entry) => !entry.sessionSkillRelease).map((entry) => ({ ...entry }));
      this.revisions.set(update.agent, this.revision(update.agent) + 1);
    }
    for (const source of sources) {
      if (!(source.agent in next) && source.commands.length > 0) {
        next[source.agent] = source.commands
          .filter((entry) => !entry.sessionSkillRelease)
          .map((entry) => ({ ...entry }));
      }
    }
    if (!childChanged && sameCatalogs(this.lists, next)) {
      return null;
    }
    this.lists = next;
    return next;
  }
}
