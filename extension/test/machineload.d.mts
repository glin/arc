export const SUITE_LOCK_PATH: string;

export function loadSettings(env?: NodeJS.ProcessEnv): { deadlineMs: number; floorBytes: number };

export function freeMemoryBytes(options?: {
  platform?: NodeJS.Platform;
  readText?: (file: string) => string;
  run?: (command: string, args: string[]) => string;
  osFree?: () => number;
}): number;

export function acquireSuiteLock(options: {
  deadlineMs: number;
  env?: NodeJS.ProcessEnv;
  command?: string;
}): Promise<{ nested: boolean; release(): boolean }>;
