import type { PanelToHost } from './protocol.ts';
import { isLocalLinkPath } from '../domain/link-path.ts';
import { parseSessionLink, sessionLinkContext } from '../domain/session-link.ts';

export interface SummaryWords {
  codeCopy: string;
  codeCopied: string;
}

export interface SummaryOptions {
  post(message: PanelToHost): void;
  words: SummaryWords;
  sessionId?: string;
  turnKey?: string;
}

export interface DisclosureSnapshot {
  open: Map<string, boolean>;
  focus: { key: string; signature: string; index: number } | null;
}

function disclosureKeys(root: HTMLElement): Map<HTMLDetailsElement, string> {
  const keys = new Map<HTMLDetailsElement, string>();
  const counts = new Map<string, number>();
  for (const details of root.querySelectorAll<HTMLDetailsElement>('details')) {
    const parent = details.parentElement?.closest('details');
    const heading =
      details.firstElementChild?.getAttribute('data-disclosure-heading') ?? details.firstElementChild?.innerHTML ?? '';
    const key = `${parent ? keys.get(parent) : ''}/${JSON.stringify(heading)}`;
    keys.set(details, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Repeated headings cannot establish which disclosure survived a refresh.
  for (const [details, key] of keys) {
    const parent = details.parentElement?.closest('details');
    if (counts.get(key)! > 1 || (parent && !keys.has(parent))) keys.delete(details);
  }
  return keys;
}

function focusSignature(node: Element): string {
  return JSON.stringify([
    node.tagName,
    node.getAttribute('data-link'),
    node.getAttribute('data-link-kind'),
    node.getAttribute('data-image'),
    node.getAttribute('data-visualization'),
    node.className,
    node.tagName === 'SUMMARY' ? (node.getAttribute('data-disclosure-heading') ?? node.innerHTML) : '',
  ]);
}

export function captureDisclosures(root: HTMLElement): DisclosureSnapshot {
  const open = new Map<string, boolean>();
  let focus: DisclosureSnapshot['focus'] = null;
  for (const [details, key] of disclosureKeys(root)) {
    open.set(key, details.open);
    const active = root.ownerDocument.activeElement;
    if (active && details.contains(active) && active.closest('details') === details) {
      const signature = focusSignature(active);
      const peers = Array.from(details.querySelectorAll('summary, a, button')).filter(
        (node) => focusSignature(node) === signature,
      );
      focus = { key, signature, index: peers.indexOf(active) };
    }
  }
  return { open, focus };
}

export function restoreDisclosures(root: HTMLElement, snapshot: DisclosureSnapshot): void {
  for (const [details, key] of disclosureKeys(root)) {
    details.open = snapshot.open.get(key) ?? false;
    if (snapshot.focus?.key === key && root.ownerDocument.activeElement === root.ownerDocument.body) {
      const peers = Array.from(details.querySelectorAll<HTMLElement>('summary, a, button')).filter(
        (node) => focusSignature(node) === snapshot.focus!.signature,
      );
      peers[snapshot.focus.index]?.focus({ preventScroll: true });
    }
  }
}

// The caller names the element type matched by its fixed selector.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function closestWithin<T extends Element>(root: HTMLElement, target: EventTarget | null, selector: string): T | null {
  const element = target instanceof Element ? target.closest<T>(selector) : null;
  return element && root.contains(element) ? element : null;
}

export function enhanceSummary(root: HTMLElement, options: SummaryOptions): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const wrap = root.ownerDocument.createElement('div');
    wrap.className = 'codeblock';
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const button = root.ownerDocument.createElement('button');
    button.className = 'copy';
    button.textContent = options.words.codeCopy;
    wrap.appendChild(button);
  }
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[data-link]'))) {
    const href = link.dataset.link || '';
    if (parseSessionLink(href).kind !== 'other') {
      link.dataset.vscodeContext = JSON.stringify(sessionLinkContext(href));
      link.setAttribute('aria-label', `Open session: ${link.textContent || ''}`);
      continue;
    }
    const inTable = !!link.closest('table');
    const webLink = /^https?:/i.test(href.trimStart());
    if (webLink && !inTable) {
      continue;
    }
    const source =
      isLocalLinkPath(href) && options.sessionId && options.turnKey
        ? {
            session: options.sessionId,
            key: options.turnKey,
          }
        : {};
    link.dataset.vscodeContext = JSON.stringify({
      webviewSection: webLink ? 'arcTableLink' : 'arcLink',
      link: link.dataset.link,
      ...(link.dataset.linkKind === 'file-citation' ? { destination: { kind: 'fileCitation', path: href } } : {}),
      ...(inTable ? { arcCopyLink: true } : {}),
      ...source,
      preventDefaultContextMenuItems: true,
    });
  }

  const activate = (event: MouseEvent) => {
    const copy = closestWithin<HTMLButtonElement>(root, event.target, 'button.copy');
    if (copy) {
      event.stopPropagation();
      const pre = copy.parentElement?.querySelector('pre');
      options.post({ type: 'copy', text: pre?.textContent || '' });
      copy.textContent = options.words.codeCopied;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (copy.isConnected) {
          copy.textContent = options.words.codeCopy;
        }
      }, 1200);
      timers.add(timer);
      return;
    }
    const visualization = closestWithin<HTMLButtonElement>(root, event.target, 'button[data-visualization]');
    if (visualization) {
      event.preventDefault();
      event.stopPropagation();
      options.post({ type: 'openVisualization', path: visualization.dataset.visualization || '' });
      return;
    }
    const image = closestWithin<HTMLButtonElement>(root, event.target, 'button[data-image]');
    if (image) {
      event.preventDefault();
      event.stopPropagation();
      options.post({
        type: 'openImage',
        path: image.dataset.image || '',
        beside: event.ctrlKey || event.metaKey,
      });
      return;
    }
    const link = closestWithin<HTMLAnchorElement>(root, event.target, 'a[data-link]');
    if (!link) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = parseSessionLink(link.dataset.link || '');
    if (target.kind === 'session') {
      options.post({ type: 'showSession', session: target.session, responseLink: true });
    } else if (target.kind === 'other') {
      if (link.dataset.linkKind === 'file-citation') {
        options.post({
          type: 'openLink',
          destination: { kind: 'fileCitation', path: link.dataset.link || '' },
          beside: event.ctrlKey || event.metaKey,
        });
      } else {
        options.post({ type: 'openLink', href: link.dataset.link || '', beside: event.ctrlKey || event.metaKey });
      }
    }
  };
  root.addEventListener('click', activate);
  return () => {
    root.removeEventListener('click', activate);
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };
}
