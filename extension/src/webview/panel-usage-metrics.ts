// The panel page's share of panel usage metrics. It counts consumed key chords, View menu
// choices, and committed queries, and posts them to the host at most once every few seconds.
// The page creates it only when the host reports that recording is on.
//
// VS Code's webview script cancels chords such as Ctrl+V from its own window keydown listener. A chord
// counts only when a panel listener cancelled the event before the document's keydown listeners finished.
// A panel handler must cancel in the capture phase or at the document, never in a window bubble listener.

import { USAGE_MESSAGE_ENTRIES, type PanelToHost } from './protocol.ts';

export const USAGE_POST_MS = 5_000;

export interface PageUsageMetrics {
  count(key: string): void;
  // A View menu setting, a lens press, or a saved filter choice.
  view(setting: string, value: string): void;
  // A committed filter box query. The host drops a query that repeats the last one the window counted.
  query(text: string): void;
  // Every keydown, from one window listener in the capture phase. The chord counts when the event is cancelled
  // at the end of the document's listeners. When a handler stops propagation first, the event's own state decides.
  key(event: ChordEvent): void;
  // The document's listeners have finished with this keydown, and no window bubble-phase listener has run yet.
  keyAtDocument(event: ChordEvent): void;
  // Posts what has not been posted yet.
  flush(): void;
}

export interface UsageMetricsTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChordEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
}

export interface DocumentKeydown {
  addEventListener(type: 'keydown', listener: (event: unknown) => void): void;
  removeEventListener(type: 'keydown', listener: (event: unknown) => void): void;
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', '']);

// Modifiers in a fixed order, then the key, such as `Ctrl+Enter`. A lone modifier names no chord.
export function chordName(event: Omit<ChordEvent, 'defaultPrevented' | 'isComposing'>): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
}

export function createPageUsageMetrics(
  post: (message: PanelToHost) => void,
  timers: UsageMetricsTimers,
): PageUsageMetrics {
  let counts = new Map<string, number>();
  let queries: string[] = [];
  let timer: unknown = null;
  // The newest keydown. Its dispatch has finished by the time the next keydown or a flush reads it.
  let held: ChordEvent | null = null;
  // Whether the held keydown was cancelled when the document's listeners finished. Null when a panel
  // handler stopped propagation first, because the window listeners then never run.
  let heldAtDocument: boolean | null = null;
  const settle = () => {
    const event = held;
    const consumed = heldAtDocument ?? event?.defaultPrevented;
    held = null;
    heldAtDocument = null;
    if (!event || !consumed || event.isComposing) return;
    const chord = chordName(event);
    if (chord) counts.set(`key:${chord}`, (counts.get(`key:${chord}`) ?? 0) + 1);
  };
  const flush = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    settle();
    if (!counts.size && !queries.length) return;
    const message: PanelToHost = {
      type: 'panelUsageMetrics',
      counts: Object.fromEntries(counts),
      queries,
    };
    counts = new Map();
    queries = [];
    post(message);
  };
  // The host refuses a message past its entry limit, so a full map or list posts at once.
  const schedule = (entries: number) => {
    if (entries >= USAGE_MESSAGE_ENTRIES) flush();
    else if (timer === null) timer = timers.setTimeout(flush, USAGE_POST_MS);
  };
  const countKey = (key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    schedule(counts.size);
  };
  return {
    count: countKey,
    view(setting, value) {
      countKey(`view:${setting}=${value}`);
    },
    key(event) {
      settle();
      held = event;
      schedule(counts.size + 1);
    },
    keyAtDocument(event) {
      if (event === held) heldAtDocument = event.defaultPrevented;
    },
    query(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      queries.push(trimmed);
      schedule(queries.length);
    },
    flush,
  };
}

// Creates the page's metrics when the host's shell turned recording on, and installs their key listeners on the
// window and the document. The capture phase sees every key, including one whose handler stops propagation.
export function startPageUsageMetrics(
  enabled: boolean,
  post: (message: PanelToHost) => void,
  timers: UsageMetricsTimers,
  onWindow: (type: string, listener: (event: unknown) => void, capture: boolean) => void,
  documentKeydown: DocumentKeydown,
): PageUsageMetrics | undefined {
  if (!enabled) return undefined;
  const metrics = createPageUsageMetrics(post, timers);
  const atDocument = (event: unknown) => metrics.keyAtDocument(event as ChordEvent);
  onWindow(
    'keydown',
    (event) => {
      metrics.key(event as ChordEvent);
      // Adding the listener again during the capture phase makes it the document's last listener for this key.
      documentKeydown.removeEventListener('keydown', atDocument);
      documentKeydown.addEventListener('keydown', atDocument);
    },
    true,
  );
  return metrics;
}
