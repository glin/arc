const SCROLL_KEY = 'arc.development.scroll';
const RELOAD_KEY = 'arc.development.reload';

export interface DevelopmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DevelopmentScrollPort {
  position(): number;
  restore(scrollTop: number): void;
  frame(callback: () => void): void;
}

export interface DevelopmentScrollRestorer {
  afterHostMessage(message: unknown): void;
  readerScrolled(): void;
}

function takeItem(storage: DevelopmentStorage, key: string): string | null {
  const value = storage.getItem(key);
  storage.removeItem(key);
  return value;
}

export function saveDevelopmentScroll(storage: DevelopmentStorage, scrollTop: number): void {
  storage.setItem(SCROLL_KEY, JSON.stringify(Math.max(0, scrollTop)));
}

export function takeDevelopmentScroll(storage: DevelopmentStorage): number | null {
  const raw = takeItem(storage, SCROLL_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function markDevelopmentReload(storage: DevelopmentStorage, scrollTop: number): void {
  storage.setItem(RELOAD_KEY, 'true');
  saveDevelopmentScroll(storage, scrollTop);
}

export function takeDevelopmentReload(storage: DevelopmentStorage): {
  preferBrowserState: boolean;
  scrollTop: number | null;
} {
  const preferBrowserState = takeItem(storage, RELOAD_KEY) === 'true';
  return { preferBrowserState, scrollTop: takeDevelopmentScroll(storage) };
}

export function createDevelopmentScrollRestorer(
  scrollTop: number | null,
  port: DevelopmentScrollPort,
): DevelopmentScrollRestorer {
  let wanted = scrollTop;
  let scheduled = false;
  let restoring = false;

  const schedule = () => {
    if (wanted === null || scheduled) {
      return;
    }
    scheduled = true;
    port.frame(attempt);
  };
  const attempt = () => {
    scheduled = false;
    if (wanted === null) {
      return;
    }
    restoring = true;
    port.restore(wanted);
    port.frame(() => {
      restoring = false;
      if (wanted === null) {
        return;
      }
      if (Math.abs(port.position() - wanted) <= 1) {
        wanted = null;
      } else {
        schedule();
      }
    });
  };

  return {
    afterHostMessage(message) {
      if (message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'render') {
        schedule();
      }
    },
    readerScrolled() {
      if (!restoring) {
        wanted = null;
      }
    },
  };
}
