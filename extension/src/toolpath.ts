import { ARC_IDENTITY } from './identity';
import type { ArcCliEnvironment } from './agenthost';

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
  private selected: { admission: string; directory: string } | undefined;
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
      const entry = terminalToolPath(directory, this.platform);
      if (!entry) throw new Error('Arc cannot add this installation folder to the terminal PATH.');
      this.collection.description = 'Arc terminal commands';
      this.collection.append(entry.variable, entry.value);
      this.collection.replace(
        `${ARC_IDENTITY.environmentPrefix}EDITOR_EXECUTABLE`,
        this.platform === 'win32' ? this.editorExecutable.replaceAll('\\', '/') : this.editorExecutable,
      );
      this.selected = { admission: identity, directory };
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
          directory: this.selected.directory,
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
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
