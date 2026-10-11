import { ARC_IDENTITY } from './identity';
import { DRAFT_SESSION_PREFIX } from './labels';

export type SessionLink = { kind: 'other' } | { kind: 'invalid' } | { kind: 'session'; session: string };

function validTarget(session: string): boolean {
  return session.length > 0 && !/[\s\u0000-\u001f\u007f-\u009f\\/?#]/u.test(session);
}

export function parseSessionLink(href: string): SessionLink {
  const written = href.trimStart();
  const scheme = ARC_IDENTITY.sessionScheme;
  if (written.slice(0, scheme.length).toLowerCase() !== scheme) return { kind: 'other' };
  try {
    const session = decodeURIComponent(written.slice(scheme.length));
    return validTarget(session) ? { kind: 'session', session } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export function formatSessionLink(session: string): string | null {
  if (!validTarget(session)) return null;
  try {
    return ARC_IDENTITY.sessionScheme + encodeURIComponent(session);
  } catch {
    return null;
  }
}

export function sessionLinkContext(link: string) {
  return {
    webviewSection: 'arcTableLink',
    link,
    session: '',
    key: '',
    arcSelection: false,
    arcTurn: false,
    arcComments: false,
    arcCopyLink: false,
    preventDefaultContextMenuItems: true,
  };
}

export interface ResponseSessionTarget {
  sessionId: string;
  agent: string;
  cwd?: string | null;
}

export type ResponseSessionResolution =
  | { kind: 'resolved'; target: ResponseSessionTarget }
  | { kind: 'missing' | 'ambiguous' | 'loading' };

// Catalog entries have already passed discovery admission. Pending starts require a recorded project directory.
export function resolveResponseSession(
  session: string,
  catalog: readonly ResponseSessionTarget[] | null,
  pending: readonly ResponseSessionTarget[],
  inside: (cwd: string) => boolean,
): ResponseSessionResolution {
  if (!validTarget(session) || session.startsWith(DRAFT_SESSION_PREFIX)) return { kind: 'missing' };
  const matches = new Map<string, ResponseSessionTarget>();
  for (const source of catalog ?? []) {
    if (source.sessionId === session && (!source.cwd || inside(source.cwd))) matches.set(source.agent, source);
  }
  for (const source of pending) {
    if (source.sessionId === session && source.cwd && inside(source.cwd)) matches.set(source.agent, source);
  }
  if (matches.size > 1) return { kind: 'ambiguous' };
  if (matches.size === 1) return { kind: 'resolved', target: matches.values().next().value! };
  return { kind: catalog === null ? 'loading' : 'missing' };
}

export function pendingResponseSessionAdmitted(
  pending: ResponseSessionTarget,
  catalog: readonly ResponseSessionTarget[],
): boolean {
  return catalog.some((source) => source.agent === pending.agent && source.sessionId === pending.sessionId);
}
