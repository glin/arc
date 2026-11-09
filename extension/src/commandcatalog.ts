import type { PromptEntry, CommandDiscoveryOutcome } from './agentwire';
import * as path from 'node:path';
import { comparableFolder } from './configwatch';

export function commandConfiguration(launch: {
  command: string;
  leadingArgs: string[];
  env: Record<string, string>;
}): string {
  return JSON.stringify([
    launch.command,
    launch.leadingArgs,
    Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

export function commandScope(agent: string, cwd: string, configuration = '', rules: path.PlatformPath = path): string {
  return JSON.stringify([agent, comparableFolder(cwd, rules), configuration]);
}

export interface CommandCatalogSource {
  agent: string;
  commandScope: string;
  commandOutcome: CommandDiscoveryOutcome;
  commands: readonly PromptEntry[];
  key?: string;
  usageSource?: number;
  sessionId?: string | null;
  exited?: boolean;
  // A child launched under a launch policy. It never changes the provider list. A Claude read-only launch adds `--setting-sources ""`, which narrows that child's list to the built-in skills. A Codex policy child reports an unnarrowed list, and the same rule applies so one rule covers both providers.
  restricted?: boolean;
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
    left.builtin === right.builtin &&
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

export function isRestrictedChild(policy: unknown): boolean {
  return policy !== undefined;
}

// Marks each live child that runs under a launch policy. `policyOf` returns a child's policy by key.
export function commandSources<S extends { key: string }>(
  states: readonly S[],
  policyOf: (key: string) => unknown,
): (S & { restricted: boolean })[] {
  return states.map((state) => ({ ...state, restricted: isRestrictedChild(policyOf(state.key)) }));
}

// Ordinary provider lists survive child retirement. A restricted child never writes or seeds a provider list. Supplied entries retain their child generation.
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

  revision(scope: string): number {
    return this.revisions.get(scope) ?? 0;
  }

  current(): Readonly<Record<string, readonly PromptEntry[]>> {
    return this.lists;
  }

  publish(
    sources: readonly CommandCatalogSource[],
    update?: CommandCatalogUpdate,
    expectedRevision?: number,
  ): Record<string, PromptEntry[]> | null {
    const scope = update?.commandScope ?? '';
    if (update && expectedRevision !== undefined && this.revision(scope) !== expectedRevision) {
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
    const restricted =
      update?.key !== undefined && sources.some((source) => source.key === update.key && source.restricted);
    if (
      update &&
      !restricted &&
      !update.optionalOnly &&
      update.commandOutcome !== 'failed' &&
      update.commandOutcome !== 'unanswered' &&
      (update.complete || update.commands.length > 0)
    ) {
      next[scope] = update.commands.filter((entry) => !entry.sessionSkillRelease).map((entry) => ({ ...entry }));
      this.revisions.set(scope, this.revision(scope) + 1);
    }
    for (const source of sources) {
      const sourceScope = source.commandScope;
      if (
        !source.restricted &&
        !(sourceScope in next) &&
        source.commandOutcome !== 'failed' &&
        source.commandOutcome !== 'unanswered' &&
        source.commands.length > 0
      ) {
        next[sourceScope] = source.commands
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

interface DiscoveryRead {
  outcome: CommandDiscoveryOutcome;
  attempts: number;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}

// One scope shares its read and its bounded recovery cycle across all prompt boxes.
export class CommandDiscovery {
  private readonly reads = new Map<string, DiscoveryRead>();
  private readonly owners = new Map<string, string>();
  private disposed = false;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private enqueue(
    read: (signal: AbortSignal) => Promise<CommandDiscoveryOutcome>,
    signal: AbortSignal,
  ): Promise<CommandDiscoveryOutcome> {
    if (signal.aborted) return Promise.resolve('unanswered');
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(start);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        resolve('unanswered');
      };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        this.active++;
        Promise.resolve()
          .then(() => (signal.aborted ? ('unanswered' as const) : read(signal)))
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      };
      this.waiting.push(start);
      signal.addEventListener('abort', cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < 2 && this.waiting.length) this.waiting.shift()!();
  }

  request(
    scope: string,
    read: (signal: AbortSignal) => Promise<CommandDiscoveryOutcome>,
    force = false,
    owner = scope,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.owners.get(owner) !== scope) this.cancel(owner);
    this.owners.set(owner, scope);
    let state = this.reads.get(scope);
    if (!state) {
      state = { outcome: 'unanswered', attempts: 0 };
      this.reads.set(scope, state);
    }
    if (state.pending)
      return state.controller?.signal.aborted
        ? state.pending.then(() =>
            this.owners.get(owner) === scope ? this.request(scope, read, force, owner) : undefined,
          )
        : state.pending;
    if (force) {
      clearTimeout(state.timer);
      state.timer = undefined;
      state.attempts = 0;
      state.outcome = 'unanswered';
    }
    if (state.timer || state.outcome === 'success' || state.attempts >= 2) return Promise.resolve();
    const current = state;
    const controller = new AbortController();
    current.controller = controller;
    current.attempts++;
    const pending = Promise.resolve()
      .then(() => this.enqueue(read, controller.signal))
      .then(
        (outcome) => {
          if (!controller.signal.aborted) current.outcome = outcome;
        },
        () => {
          if (!controller.signal.aborted) current.outcome = 'failed';
        },
      )
      .finally(() => {
        current.pending = undefined;
        if (controller.signal.aborted || this.disposed || ![...this.owners.values()].includes(scope)) return;
        if (current.outcome === 'failed' && current.attempts < 2) {
          current.timer = setTimeout(() => {
            current.timer = undefined;
            const owner = [...this.owners].find(([, ownedScope]) => ownedScope === scope)?.[0];
            if (owner) void this.request(scope, read, false, owner);
          }, 1_000);
          current.timer.unref?.();
        }
      });
    current.pending = pending;
    return pending;
  }

  cancel(owner: string): void {
    const scope = this.owners.get(owner);
    this.owners.delete(owner);
    if (!scope || [...this.owners.values()].includes(scope)) return;
    const state = this.reads.get(scope);
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.controller?.abort();
    if (state.outcome !== 'success') {
      state.attempts = 0;
      state.outcome = 'unanswered';
    }
  }

  cancelAll(matches: (scope: string) => boolean = () => true): void {
    for (const [owner, scope] of [...this.owners]) if (matches(scope)) this.cancel(owner);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
  }
}
