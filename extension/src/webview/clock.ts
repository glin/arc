// One panel clock updates relative ages, durations and cache lifetimes from browser time.
// Owners mark nodes with timestamps instead of sending new wording from the host each second.
// Write only changed text to preserve selections and screen-reader position.
// Every subscriber receives the same instant for each tick.

import { runningFor } from '../view/rail.ts';
import { formatCacheSpan, formatDuration, formatRelative } from '../view/time.ts';

// Tick each second for live turn durations, even when other figures change only once a minute.
export const TICK_MS = 1000;

// How long something has been running, from the instant it started.
const DURATIONS = '[data-since]';

// Running session and subagent durations use whole minutes and stay empty during the first minute.
// `data-running-lead` appears only with a nonempty duration.
const RUNNING = '[data-running-since]';

// Update relative ages and remaining cache lifetimes.
// `rail.ts` updates session-list ages separately because they also affect cache bands.
const AGES = '[data-at]:not(.railwhen)';

export interface ClockOptions {
  document: Document;
  // The clock the ticker reads. The page's own by default.
  now?(): number;
  // How the repeating tick is started. Supplied by tests that drive the tick by hand.
  start?(run: () => void, ms: number): void;
}

export interface Clock {
  // Update timestamp text and call every listener. A post-draw tick fills newly drawn empty figures immediately.
  tick(now?: number): void;
  // Subscribe until the returned function removes the listener.
  subscribe(listener: (now: number) => void): () => void;
}

export function writeRelativeTimes(document: Document, now: number): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(DURATIONS))) {
    const next = formatDuration(now - Number(node.dataset.since));
    if (node.textContent !== next) {
      node.textContent = next;
    }
  }
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(RUNNING))) {
    const duration = runningFor(Number(node.dataset.runningSince), now);
    const next = duration && node.dataset.runningLead ? `${node.dataset.runningLead}${duration}` : duration;
    if (node.textContent !== next) {
      node.textContent = next;
    }
  }
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(AGES))) {
    const at = Number(node.dataset.at);
    const next = node.dataset.remaining === 'true' ? formatCacheSpan(at - now) : formatRelative(at, now);
    if (node.textContent !== next) {
      node.textContent = next;
    }
    if (node.title) {
      const name = `${next}. ${node.title}`;
      if (node.getAttribute('aria-label') !== name) {
        node.setAttribute('aria-label', name);
      }
    }
  }
}

export function createClock(options: ClockOptions): Clock {
  const readNow = options.now ?? (() => Date.now());
  const listeners = new Set<(now: number) => void>();
  const tick = (now: number = readNow()) => {
    writeRelativeTimes(options.document, now);
    // Copy listeners so removals during the tick do not change this iteration.
    for (const listener of [...listeners]) {
      listener(now);
    }
  };
  const start =
    options.start ??
    ((run: () => void, ms: number) => {
      setInterval(run, ms);
    });
  start(() => {
    tick();
  }, TICK_MS);
  return {
    tick,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
