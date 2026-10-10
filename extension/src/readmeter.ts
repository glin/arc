import { AsyncLocalStorage } from 'node:async_hooks';

// Counts the bytes that transcript reads return while a measurement window is open.
// A read outside a window counts nothing.

export interface ReadWindow {
  readonly startedAt: number;
  bytes: number;
  readonly files: Set<string>;
}

export interface ReadTally {
  files: number;
  bytes: number;
  ms: number;
}

let openWindow: ReadWindow | null = null;

const meterClock = () => performance.now();

// Returns the byte count unchanged, so a read site wraps its read call in place.
export function meterRead(file: string, bytes: number, offset?: number): number {
  if (openWindow && bytes > 0) {
    openWindow.bytes += bytes;
    openWindow.files.add(file);
  }
  const measurement = measurements.getStore();
  if (measurement && bytes > 0) {
    const phase = measurement.phases[measurement.phase];
    phase.bytes += bytes;
    phase.reads++;
    if (offset !== undefined) {
      const key = `${measurement.phase}:${file}`;
      const ranges = measurement.ranges.get(key) ?? [];
      let start = offset;
      let end = offset + bytes;
      const retained: Array<[number, number]> = [];
      for (const range of ranges) {
        phase.repeatedBytes += Math.max(0, Math.min(end, range[1]) - Math.max(start, range[0]));
        if (range[1] < start || range[0] > end) retained.push(range);
        else {
          start = Math.min(start, range[0]);
          end = Math.max(end, range[1]);
        }
      }
      retained.push([start, end]);
      measurement.ranges.set(key, retained);
    }
  }
  return bytes;
}

export interface ReadPhaseMetrics {
  bytes: number;
  repeatedBytes: number;
  reads: number;
  cursorCopies: number;
  childLifecycleReads: number;
  sourceChangeRetries: number;
  ms: number;
}

export type ReadMetrics = Record<string, ReadPhaseMetrics>;
const measurements = new AsyncLocalStorage<{
  phase: string;
  at: number;
  phases: ReadMetrics;
  ranges: Map<string, Array<[number, number]>>;
}>();

export function readPhase(phase: string): void {
  const measurement = measurements.getStore();
  if (!measurement) return;
  const now = meterClock();
  measurement.phases[measurement.phase].ms += now - measurement.at;
  measurement.phase = phase;
  measurement.at = now;
  measurement.phases[phase] ??= {
    bytes: 0,
    repeatedBytes: 0,
    reads: 0,
    cursorCopies: 0,
    childLifecycleReads: 0,
    sourceChangeRetries: 0,
    ms: 0,
  };
}

export function meterReadWork(work: 'cursorCopies' | 'sourceChangeRetries' | 'childLifecycleReads'): void {
  const measurement = measurements.getStore();
  if (measurement) measurement.phases[measurement.phase][work]++;
}

// Measurements stay within one asynchronous operation. Reports contain no source paths or text.
export async function withReadMetrics<T>(
  operation: () => Promise<T>,
  report: (metrics: ReadMetrics) => void,
): Promise<T> {
  return measurements.run(
    {
      phase: 'other',
      at: meterClock(),
      phases: {
        other: {
          bytes: 0,
          repeatedBytes: 0,
          reads: 0,
          cursorCopies: 0,
          childLifecycleReads: 0,
          sourceChangeRetries: 0,
          ms: 0,
        },
      },
      ranges: new Map(),
    },
    async () => {
      try {
        return await operation();
      } finally {
        readPhase('other');
        report(measurements.getStore()!.phases);
      }
    },
  );
}

// One window is open at a time. A new window replaces one that an exception left open.
export function openReadWindow(clock: () => number = meterClock): ReadWindow {
  openWindow = { startedAt: clock(), bytes: 0, files: new Set() };
  return openWindow;
}

// The tally counts each file once, however many reads it took.
export function closeReadWindow(window: ReadWindow, clock: () => number = meterClock): ReadTally {
  if (openWindow === window) openWindow = null;
  return { files: window.files.size, bytes: window.bytes, ms: clock() - window.startedAt };
}
