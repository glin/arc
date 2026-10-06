// Counts the bytes that synchronous transcript reads return while a measurement window is open.
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
export function meterRead(file: string, bytes: number): number {
  if (openWindow && bytes > 0) {
    openWindow.bytes += bytes;
    openWindow.files.add(file);
  }
  return bytes;
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
