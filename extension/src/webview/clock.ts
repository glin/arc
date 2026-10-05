// The panel's one clock, and the ages and durations it keeps current.
//
// Every age on the page is a host timestamp worded against a browser clock. The host cannot
// send the wording, because it moves on a second only the browser counts, and a message a
// minute for every figure on screen is not a message the panel can afford. So each owner
// draws the node and marks it with the instant it is about, and this owner rewords it.
//
// The words are written in place, and only when they actually move. The tick runs sixty times
// for every time a minute figure changes, and a rewrite replaces the text node a reader is
// selecting or a screen reader is sitting on.
//
// One clock, so two figures drawn from the same instant can never disagree by a second. An
// owner that needs the tick for something other than an age subscribes to it.

import { runningFor } from '../view/rail.ts';
import { formatCacheSpan, formatDuration, formatRelative } from '../view/time.ts';

// How long the panel waits between ticks. A minute figure moves once a minute, but a running
// turn counts seconds, so the second is the step.
export const TICK_MS = 1000;

// How long something has been running, from the instant it started.
const DURATIONS = '[data-since]';

// How long a subagent or a session has been running, worded as the session rail words a
// running session: whole minutes after a space, and nothing under the first one. A node's
// `data-running-lead` words go before the duration, and only once a duration shows.
const RUNNING = '[data-running-since]';

// How long ago something happened, or how much of a cache lifetime is left when the node says
// so. The rail's own ages are left out: `rail.ts` rewords its cards itself, because an age
// moving there can also move the card's cache band.
const AGES = '[data-at]:not(.railwhen)';

export interface ClockOptions {
  document: Document;
  // The clock the ticker reads. The page's own by default.
  now?(): number;
  // How the repeating tick is started. Supplied by tests that drive the tick by hand.
  start?(run: () => void, ms: number): void;
}

export interface Clock {
  // Run every listener once, now. Called after a draw, so a figure the owner drew empty is
  // filled before the reader sees it rather than a second later.
  tick(now?: number): void;
  // Take the tick until the returned function is called. A listener that is dropped stops
  // being called, so an owner that goes away leaves nothing behind.
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
    // Over a copy, so a listener that drops itself while the tick runs cannot change the set
    // the loop is walking.
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
