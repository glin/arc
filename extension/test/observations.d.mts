export interface TestObservation {
  runId: string;
  path: string;
  childEnvironment(parent?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  event(phase: string, event: string, detail?: Record<string, unknown>): void;
  begin(phase: string, detail?: Record<string, unknown>): void;
  end(phase: string, detail?: Record<string, unknown>): void;
  unavailable(phase: string, reason: string): void;
  incomplete(phase: string, reason: string): void;
  finish(result?: {
    exitCode?: number | null;
    signal?: string | null;
    outcome?: string;
    reason?: string | null;
    [name: string]: unknown;
  }): void;
}

export function createTestObservation(options: {
  lane: string;
  cwd?: string;
  command?: string[];
  workerCap?: number | string | null;
  capacity?: number | null;
  env?: NodeJS.ProcessEnv;
  outputDirectory?: string;
  parentRunId?: string | null;
  announce?: (line: string) => void;
}): TestObservation;

export function coordinationEnvironment(
  env?: NodeJS.ProcessEnv,
  temporary?: string,
): {
  temporary: string;
  variables: Record<string, string | null>;
};
