import { ARC_IDENTITY } from './identity';
import type { ArcCliEnvironment } from './agenthost';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionSkillRelease } from './bundledtools';
import type { SessionSkillRelease } from './sessionskills';

export async function terminalCommandDirectory(
  directory: string,
  signal: AbortSignal,
  platform = process.platform,
): Promise<string> {
  if (platform !== 'win32' || path.join(directory, 'arc.cmd').length < 260) return directory;
  const before = fs.statSync(directory, { bigint: true });
  const canonical = fs.realpathSync(directory);
  const packagedBridge = path.join(__dirname, 'windowpipe.exe');
  const bridge = fs.existsSync(packagedBridge) ? packagedBridge : path.join(__dirname, '../dist/windowpipe.exe');
  const spelling = await new Promise<string>((resolve, reject) => {
    execFile(
      bridge,
      ['--short-path', directory],
      { encoding: 'utf8', signal, timeout: 10_000, maxBuffer: 65_536, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
  const after = fs.statSync(directory, { bigint: true });
  const delivered = fs.statSync(spelling, { bigint: true });
  if (
    !spelling ||
    path.join(spelling, 'arc.cmd').length >= 260 ||
    !terminalToolPath(spelling, platform) ||
    !before.isDirectory() ||
    before.ino === 0n ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.ino !== delivered.ino ||
    before.dev !== delivered.dev ||
    canonical.toLowerCase() !== fs.realpathSync(directory).toLowerCase()
  ) {
    throw new Error('Arc cannot run its commands from this installation folder.');
  }
  return spelling;
}

export function terminalToolPath(
  bin: string,
  platform = process.platform,
): { variable: string; value: string } | undefined {
  const delimiter = platform === 'win32' ? ';' : ':';
  if (bin.includes(delimiter) || /[\r\n]/u.test(bin)) return undefined;
  return { variable: platform === 'win32' ? 'Path' : 'PATH', value: delimiter + bin };
}
export interface TerminalToolCollection {
  persistent: boolean;
  description: unknown;
  clear(): void;
  append(variable: string, value: string): void;
  replace(variable: string, value: string): void;
}
export interface ToolAdmission {
  root: string;
  identity: string;
}

// A generation owns its preparation and publication until admission changes or disposal.
export class TerminalTools {
  private generation = 0;
  private controller: AbortController | undefined;
  private selected: { admission: string; directory: string; commandDirectory: string } | undefined;
  private disposed = false;
  private pending: Promise<string> | undefined;
  private preparation: { admission: string; status: 'preparing' | 'failed'; error?: string } | undefined;
  constructor(
    private readonly collection: TerminalToolCollection,
    private readonly admission: () => ToolAdmission | null,
    private readonly prepare: (admission: ToolAdmission, signal: AbortSignal) => Promise<string>,
    private readonly editorExecutable: string,
    private readonly platform = process.platform,
  ) {
    collection.persistent = false;
    collection.clear();
  }
  private clear(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.selected = undefined;
    this.preparation = undefined;
    this.collection.clear();
  }
  async refresh(): Promise<void> {
    this.clear();
    if (this.disposed) return;
    const generation = this.generation;
    let identity: string | undefined;
    try {
      const admission = this.admission();
      if (!admission) return;
      identity = JSON.stringify(admission);
      this.preparation = { admission: identity, status: 'preparing' };
      const controller = new AbortController();
      this.controller = controller;
      await this.pending?.catch(() => undefined);
      if (this.disposed || generation !== this.generation || identity !== JSON.stringify(this.admission())) return;
      this.pending = this.prepare(admission, controller.signal);
      const directory = await this.pending;
      if (this.disposed || generation !== this.generation || identity !== JSON.stringify(this.admission())) return;
      const commandDirectory = await terminalCommandDirectory(directory, controller.signal, this.platform);
      if (this.disposed || generation !== this.generation || identity !== JSON.stringify(this.admission())) return;
      const entry = terminalToolPath(commandDirectory, this.platform);
      if (!entry) throw new Error('Arc cannot add this installation folder to the terminal PATH.');
      this.collection.description = 'Arc terminal commands';
      this.collection.append(entry.variable, entry.value);
      this.collection.replace(
        `${ARC_IDENTITY.environmentPrefix}EDITOR_EXECUTABLE`,
        this.platform === 'win32' ? this.editorExecutable.replaceAll('\\', '/') : this.editorExecutable,
      );
      this.selected = { admission: identity, directory, commandDirectory };
      this.preparation = undefined;
    } catch (error) {
      if (generation === this.generation) {
        this.clear();
        if (identity)
          this.preparation = {
            admission: identity,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
      }
    }
  }
  current(windowId: string | null): ArcCliEnvironment {
    let admission: ToolAdmission | null;
    try {
      admission = this.disposed ? null : this.admission();
      if (admission && this.selected && this.selected.admission === JSON.stringify(admission))
        return {
          directory: this.selected.commandDirectory,
          editorExecutable: this.editorExecutable,
          windowId,
          platform: this.platform,
        };
    } catch (error) {
      this.selected = undefined;
      this.collection.clear();
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Arc failed to prepare its commands. ${cause} Resolve the problem, then reload the window and try again.`,
        { cause: error },
      );
    }
    this.selected = undefined;
    this.collection.clear();
    if (admission && this.preparation?.admission === JSON.stringify(admission)) {
      if (this.preparation.status === 'preparing')
        throw new Error('Arc is preparing its commands. Try starting the session again shortly.');
      throw new Error(
        `Arc failed to prepare its commands. ${this.preparation.error} Resolve the problem, then reload the window and try again.`,
      );
    }
    throw new Error('Arc commands are unavailable in this window.');
  }
  sessionSkills(): SessionSkillRelease | undefined {
    try {
      if (this.disposed || !this.selected || this.selected.admission !== JSON.stringify(this.admission()))
        return undefined;
      return sessionSkillRelease(path.dirname(this.selected.directory));
    } catch {
      // Unvalidated development output and refused releases retain manual native discovery.
      return undefined;
    }
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
