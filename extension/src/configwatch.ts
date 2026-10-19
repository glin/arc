import type { PlatformPath } from 'node:path';

// Agent configuration watches for queried working directories and their ancestors.
//
// The editor watches the base of a pattern recursively when the pattern holds `/` or `**`.
// Every pattern here names a direct child of its base, so each watch covers one folder.

export type WatchKind = 'create' | 'change' | 'delete';

interface WatchHandle {
  dispose(): void;
}

type WatchFactory = (base: string, pattern: string, listener: (kind: WatchKind, path: string) => void) => WatchHandle;

interface ConfigWatchOptions {
  watch: WatchFactory;
  isDirectory(path: string): Promise<boolean>;
  invalidate(): void;
  path: PlatformPath;
  // Whether a configuration directory name in an event compares without case. The editor reports
  // a directory event in the spelling on disk, and Windows and macOS match names without case.
  ignoreCase: boolean;
}

// The folder watch reports the configuration directories themselves.
const CONFIG_DIRECTORY_PATTERN = '{.claude,.codex}';

// Each configuration directory and the files inside it that change agent defaults.
const CONFIG_FILES: Readonly<Record<string, string>> = { '.claude': 'settings*.json', '.codex': 'config.toml' };

interface FolderWatch {
  folder: string;
  watch: WatchHandle;
  inner: Map<string, WatchHandle>;
  // Create and delete events on a configuration directory advance its generation, so an
  // existence check that started before the event registers nothing.
  generations: Map<string, number>;
}

// Each working directory and all its ancestors, keyed so Windows paths compare without case.
function configFolders(cwds: readonly string[], rules: PlatformPath): Map<string, string> {
  const folders = new Map<string, string>();
  for (const cwd of cwds) {
    let folder = rules.resolve(cwd);
    for (;;) {
      const key = folderKey(folder, rules);
      if (!folders.has(key)) folders.set(key, folder);
      const parent = rules.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  return folders;
}

function folderKey(folder: string, rules: PlatformPath): string {
  return rules.sep === '\\' ? folder.toLowerCase() : folder;
}

// A working directory in the form that compares equal for one folder. Windows path rules ignore case.
export function comparableFolder(cwd: string, rules: PlatformPath): string {
  return folderKey(rules.resolve(cwd), rules);
}

// The one key for an applied defaults reading: agent, comparable working directory, and the raw model value.
// The empty base value and a value with a window suffix stay distinct keys.
export function defaultsKey(agent: string, cwd: string, model: string, rules: PlatformPath): string {
  return JSON.stringify([agent, comparableFolder(cwd, rules), model]);
}

export function defaultsKeyParts(key: string): { agent: string; folder: string; model: string } {
  const [agent, folder, model] = JSON.parse(key) as string[];
  return { agent, folder, model };
}

export class ConfigWatches {
  private readonly folders = new Map<string, FolderWatch>();
  private disposed = false;

  constructor(private readonly options: ConfigWatchOptions) {}

  update(cwds: readonly string[]): void {
    if (this.disposed) return;
    const wanted = configFolders(cwds, this.options.path);
    for (const [key, entry] of this.folders) {
      if (wanted.has(key)) continue;
      this.release(entry);
      this.folders.delete(key);
    }
    for (const [key, folder] of wanted) {
      if (this.folders.has(key)) continue;
      const entry: FolderWatch = { folder, watch: { dispose() {} }, inner: new Map(), generations: new Map() };
      this.folders.set(key, entry);
      entry.watch = this.options.watch(folder, CONFIG_DIRECTORY_PATTERN, (kind, changed) =>
        this.folderEvent(entry, kind, changed),
      );
      for (const name of Object.keys(CONFIG_FILES)) this.check(entry, name, false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.folders.values()) this.release(entry);
    this.folders.clear();
  }

  private folderEvent(entry: FolderWatch, kind: WatchKind, changed: string): void {
    if (!this.live(entry)) return;
    const name = this.configName(changed);
    if (!name) return;
    if (kind === 'create') {
      this.advance(entry, name);
      this.addInner(entry, name);
      this.options.invalidate();
    } else if (kind === 'delete') {
      this.advance(entry, name);
      entry.inner.get(name)?.dispose();
      entry.inner.delete(name);
      this.options.invalidate();
    } else if (!entry.inner.has(name)) {
      // A change on a watched directory also reports writes inside it on Windows, so only a
      // directory without its inner watch is checked again.
      this.check(entry, name, true);
    }
  }

  private configName(changed: string): string | undefined {
    const rules = this.options.path;
    const base = rules.basename(changed);
    const name = this.options.ignoreCase ? base.toLowerCase() : base;
    return Object.hasOwn(CONFIG_FILES, name) ? name : undefined;
  }

  // Adds the inner watch when the directory exists. The result registers nothing when a create or
  // delete event on the directory arrives before the check ends.
  private check(entry: FolderWatch, name: string, invalidate: boolean): void {
    const generation = this.generation(entry, name);
    void this.options
      .isDirectory(this.options.path.join(entry.folder, name))
      .catch(() => false)
      .then((found) => {
        if (!found || entry.inner.has(name) || this.generation(entry, name) !== generation) return;
        if (this.addInner(entry, name) && invalidate) this.options.invalidate();
      });
  }

  private generation(entry: FolderWatch, name: string): number {
    return entry.generations.get(name) ?? 0;
  }

  private advance(entry: FolderWatch, name: string): void {
    entry.generations.set(name, this.generation(entry, name) + 1);
  }

  private live(entry: FolderWatch): boolean {
    return !this.disposed && this.folders.get(folderKey(entry.folder, this.options.path)) === entry;
  }

  // Registers nothing for a folder that left the set or after disposal, so release finds every watch.
  private addInner(entry: FolderWatch, name: string): boolean {
    if (!this.live(entry)) return false;
    entry.inner.get(name)?.dispose();
    entry.inner.set(
      name,
      this.options.watch(this.options.path.join(entry.folder, name), CONFIG_FILES[name], () => {
        if (this.live(entry)) this.options.invalidate();
      }),
    );
    return true;
  }

  private release(entry: FolderWatch): void {
    entry.watch.dispose();
    for (const inner of entry.inner.values()) inner.dispose();
    entry.inner.clear();
  }
}
