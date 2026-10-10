import { actionable, element } from './dom.ts';
import type { PanelDiagnosis, PanelOlderHistory, PanelSessionRow, PanelToHost } from './protocol.ts';

type HistoryControl = NonNullable<PanelOlderHistory>;

interface HistoryOptions {
  document: Document;
  sendToHost(message: PanelToHost): void;
  hidden: ReadonlySet<string>;
  hiddenEmpty: string;
  observe(
    target: Element,
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ): IntersectionObserver | null;
}

export interface HistoryOwner {
  footers(control: PanelOlderHistory): Node[];
  drawn(nodes: readonly Node[]): void;
  empty(diagnosis: PanelDiagnosis | null, sessions: readonly PanelSessionRow[]): HTMLElement;
}

const OLDER_PREFETCH_MARGIN = '100% 0px';

export function createHistoryOwner(options: HistoryOptions): HistoryOwner {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) =>
    element(options.document, tag, className, text);
  let footerPrint: string | null = null;
  let footerNodes: Node[] = [];
  let olderSeen: string | null = null;
  let olderObserver: IntersectionObserver | null = null;
  let olderControl: HistoryControl | null = null;
  let olderNode: HTMLElement | null = null;
  const controls = new WeakMap<Node, HistoryControl>();

  const sendOlderRequest = (control: HistoryControl) => {
    if (!control.session || !control.token) {
      return;
    }
    olderSeen = control.token;
    options.sendToHost({ type: 'loadOlder', session: control.session, token: control.token });
  };
  const askForOlder = (control: HistoryControl | null) => {
    if (!control?.auto || !control.token || !control.session || olderSeen === control.token) {
      return;
    }
    sendOlderRequest(control);
  };
  const forgetOlder = () => {
    olderControl = null;
    olderNode = null;
    olderObserver?.disconnect();
  };
  const watchOlder = (node: HTMLElement, control: HistoryControl) => {
    olderControl = control;
    if (!olderObserver) {
      olderObserver = options.observe(
        node,
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              askForOlder(olderControl);
            }
          }
        },
        { rootMargin: OLDER_PREFETCH_MARGIN, threshold: 0 },
      );
    }
    if (!olderObserver) {
      return;
    }
    olderObserver.disconnect();
    if (control.auto) {
      olderObserver.observe(node);
    }
  };
  const olderRow = (control: HistoryControl): HTMLElement => {
    const name = control.name || control.label;
    if (control.kind !== 'load' && control.kind !== 'retry') {
      const note = el('div', 'deeper-note', control.label);
      actionable(note, name === control.label ? null : name, 'olderHistory');
      note.tabIndex = -1;
      note.setAttribute('role', 'status');
      return note;
    }
    const button = el('button', 'deeper', control.label);
    actionable(button, name === control.label ? null : name, 'olderHistory', () => sendOlderRequest(control));
    controls.set(button, control);
    return button;
  };
  return {
    footers(control) {
      const print = JSON.stringify(
        control && [control.kind, control.label, control.name, control.auto, control.token, control.session],
      );
      if (print === footerPrint) return footerNodes;
      footerPrint = print;
      footerNodes = control ? [olderRow(control)] : [];
      return footerNodes;
    },
    drawn(nodes) {
      const node = nodes.find((candidate) => controls.has(candidate)) as HTMLElement | undefined;
      if (!node) {
        forgetOlder();
      } else if (node !== olderNode) {
        olderNode = node;
        watchOlder(node, controls.get(node)!);
      }
    },
    empty(diagnosis, sessions) {
      const box = el('div', 'empty');
      const allHidden = sessions.length > 0 && sessions.every((session) => options.hidden.has(session.id));
      if (allHidden) {
        box.append(el('p', '', options.hiddenEmpty));
        return box;
      }
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      box.setAttribute('aria-atomic', 'true');
      if (diagnosis) {
        box.append(el('p', '', diagnosis.message));
      }
      return box;
    },
  };
}
