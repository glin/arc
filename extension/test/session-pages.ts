import * as crypto from 'node:crypto';
import {
  readSessionCursor,
  sessionListingPage,
  sessionPageSources,
  sessionScopeDigest,
  type SessionListingRow,
  type SessionPage,
  type SessionPageRequest,
} from '../src/sessionreads.ts';
import { type SessionFile } from '../src/transcript';
import assert from 'node:assert/strict';

export type PageOptions = Partial<SessionPageRequest<SessionFile>> & {
  row?: (session: SessionFile) => Partial<SessionListingRow>;
  current?: (session: SessionFile) => boolean;
};

export function pageFile(n: number, changes: Partial<SessionFile> = {}): SessionFile {
  return {
    agent: n % 2 ? 'codex' : 'claude',
    file: `C:/Users/Mixed/Sessions/${n}.jsonl`,
    sessionId: `session-${n}`,
    mtimeMs: 1,
    size: 10,
    dev: '7',
    ino: String(1000 + n),
    ...changes,
  };
}

export const pageBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// Row sizes vary, so pages end at different distances from their budget.
export const variedName = (session: SessionFile) => ({
  name: 'n'.repeat(400 + ((Number(session.sessionId.slice('session-'.length)) * 7919) % 600)),
});

export function createSessionPages(projected = () => {}) {
  const pageSecret = crypto.randomBytes(32);

  const pageScope = sessionScopeDigest('mixed-case scope');

  function listPage(files: SessionFile[], cursor: string | null, options: PageOptions = {}): SessionPage {
    const { row, current, ...request } = options;
    const check = cursor === null ? null : readSessionCursor(cursor, pageSecret, pageScope);
    if (check && check.status !== 'valid') throw new Error(`Cursor ${check.status}.`);
    return sessionListingPage({
      sources: sessionPageSources(files),
      cursor: check?.status === 'valid' ? check.body : null,
      limit: 128,
      catalog: 'complete',
      fresh: true,
      scope: pageScope,
      secret: pageSecret,
      requester: null,
      project: ({ session }) => {
        projected();
        return {
          row: {
            id: session.sessionId,
            provider: session.agent,
            name: `Session ${session.sessionId}`,
            setup: { model: 'model', effort: 'high', source: 'recorded' },
            labels: [],
            pinned: false,
            archived: false,
            runStatus: 'done',
            attention: 'idle',
            lastActivity: 1,
            parent: null,
            agentRun: false,
            facts: 'current',
            ...row?.(session),
          },
          current: current?.(session) ?? true,
        };
      },
      ...request,
    });
  }

  function traverse(files: (page: number) => SessionFile[], options: (page: number) => PageOptions = () => ({})) {
    const pages: SessionPage[] = [];
    let cursor: string | null = null;
    do {
      const page = listPage(files(pages.length), cursor, options(pages.length));
      pages.push(page);
      cursor = page.next;
    } while (cursor && pages.length < 2000);
    assert.equal(cursor, null);
    return pages;
  }

  return { pageSecret, pageScope, listPage, traverse };
}
