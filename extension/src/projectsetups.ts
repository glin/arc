import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { IDENTITY_ARGS, parseIdentity, type GitRunner } from './gitcommits';
import { normalizeFsPath } from './transcript';
import { STORED_STATE_KEYS } from './identity';
import {
  normalizePinnedSetups,
  normalizeSetupValues,
  RECENT_SETUP_LIMIT,
  sameValues,
  type PinnedSetup,
} from './domain/session-setups';
import type { SessionProfile } from './view/launcher';

export interface ProjectSetups {
  version: 1;
  pins: PinnedSetup[];
  recents: SessionProfile[];
}

export interface SetupStorage {
  get(key: string): unknown;
  update(key: string, value: ProjectSetups): PromiseLike<void>;
}

export function normalizeProjectPath(folder: string): string {
  const unified = folder.replace(/\\/g, '/');
  const cased = /^(?:[a-zA-Z]:|\/\/)/.test(unified) ? normalizeFsPath(unified) : unified;
  return cased.replace(/\/+$/, '') || '/';
}

export class SetupProjects {
  private known = new Map<string, string>();
  constructor(
    private git: GitRunner,
    private canonical: (folder: string) => Promise<string> = realpath,
  ) {}

  async resolve(folder: string | null): Promise<string | null> {
    if (!folder) return null;
    const folderKey = normalizeProjectPath(folder);
    try {
      const answer = this.git.identity
        ? await this.git.identity(folder)
        : { stdout: await this.git.run(folder, [...IDENTITY_ARGS]), outsideGit: false };
      const place = parseIdentity(answer.stdout);
      const target = place.commonDir ?? (answer.outsideGit ? folder : null);
      if (!target) return this.known.get(folderKey) ?? null;
      const common = answer.stdout?.split('\n')[0]?.trim();
      const project = `${place.commonDir ? 'git' : 'folder'}:${normalizeProjectPath(await this.canonical(common || target))}`;
      this.known.set(folderKey, project);
      return project;
    } catch {
      return this.known.get(folderKey) ?? null;
    }
  }
}

export function projectSetupKey(project: string): string {
  return STORED_STATE_KEYS.projectSetups + createHash('sha256').update(project).digest('hex');
}

export function normalizeProjectSetups(raw: unknown): ProjectSetups {
  const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const recents: SessionProfile[] = [];
  for (const row of Array.isArray(entry.recents) ? entry.recents : []) {
    const values = normalizeSetupValues(row);
    if (values && !recents.some((one) => sameValues(one, values))) recents.push({ ...values, source: 'recent' });
    if (recents.length === RECENT_SETUP_LIMIT) break;
  }
  return { version: 1, pins: normalizePinnedSetups(entry.pins), recents };
}

export class ProjectSetupStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private storage: SetupStorage) {}

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next;
    return next;
  }

  private async entry(project: string): Promise<ProjectSetups> {
    const key = projectSetupKey(project);
    const raw = this.storage.get(key);
    if (raw !== undefined) return normalizeProjectSetups(raw);
    const seeded: ProjectSetups = {
      version: 1,
      pins: normalizePinnedSetups(this.storage.get(STORED_STATE_KEYS.pinnedSetups)),
      recents: [],
    };
    await this.storage.update(key, seeded);
    return seeded;
  }

  read(project: string | null): Promise<ProjectSetups> {
    return this.queue(() => (project ? this.entry(project) : Promise.resolve({ version: 1, pins: [], recents: [] })));
  }

  pins(project: string | null, pins: readonly PinnedSetup[]): Promise<void> {
    return this.queue(async () => {
      if (!project) throw new Error('Saved setups are unavailable here.');
      const entry = await this.entry(project);
      await this.storage.update(projectSetupKey(project), { ...entry, pins: normalizePinnedSetups(pins) });
    });
  }

  accept(project: string | null, profile: SessionProfile): Promise<ProjectSetups> {
    return this.queue(async () => {
      if (!project) return { version: 1, pins: [], recents: [] };
      const entry = await this.entry(project);
      const recents = [
        { ...profile, source: 'recent' as const },
        ...entry.recents.filter((one) => !sameValues(one, profile)),
      ].slice(0, RECENT_SETUP_LIMIT);
      const next = { ...entry, recents };
      await this.storage.update(projectSetupKey(project), next);
      return next;
    });
  }
}
