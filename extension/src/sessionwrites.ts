import { createHash } from 'node:crypto';
import type { LauncherRequest } from './view/launcher';
import type { SessionListingRow } from './sessionreads';

export interface SessionWriteParams {
  sessionId?: string;
  turns?: number;
  setup?: LauncherRequest;
  prompt?: string;
  name?: string;
  labels?: string[];
  pinned?: boolean;
  agentRun?: boolean;
  action?: 'label-add' | 'label-remove' | 'pin' | 'unpin' | 'archive' | 'unarchive';
  dryRun?: boolean;
  force?: boolean;
}

export function validSessionWrite(method: string, params: Record<string, unknown>): boolean {
  const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
  const labels = (value: unknown) => Array.isArray(value) && value.length <= 20 && value.every((one) => text(one, 200));
  if (method === 'setups') return Object.keys(params).length === 0;
  if (method === 'start') {
    const setup = params.setup as Record<string, unknown> | undefined;
    const fields = ['setup', 'prompt', 'name', 'labels', 'pinned', 'agentRun'];
    return (
      Object.keys(params).every((key) => fields.includes(key)) &&
      text(params.prompt, 48 * 1024) &&
      typeof params.agentRun === 'boolean' &&
      (params.name === undefined || text(params.name, 200)) &&
      (params.labels === undefined || labels(params.labels)) &&
      (params.pinned === undefined || typeof params.pinned === 'boolean') &&
      !!setup &&
      !Array.isArray(setup) &&
      (setup.kind === 'row'
        ? Object.keys(setup).sort().join(',') === 'key,kind' && text(setup.key, 200)
        : setup.kind === 'custom' &&
          Object.keys(setup).sort().join(',') === 'agent,effort,kind,model,permissionMode' &&
          ['agent', 'model', 'effort', 'permissionMode'].every((key) => text(setup[key], 200)))
    );
  }
  if (method !== 'curate') return false;
  return (
    Object.keys(params).every((key) => ['sessionId', 'action', 'labels', 'dryRun', 'force'].includes(key)) &&
    text(params.sessionId, 256) &&
    !!params.sessionId &&
    ['label-add', 'label-remove', 'pin', 'unpin', 'archive', 'unarchive'].includes(params.action as string) &&
    typeof params.dryRun === 'boolean' &&
    typeof params.force === 'boolean' &&
    (params.labels === undefined || labels(params.labels)) &&
    (!(params.action as string).startsWith('label-') || labels(params.labels))
  );
}

// Retention never evicts an accepted ID. A full activation refuses further writes.
export class SessionWriteRequests {
  private readonly results = new Map<string, { payload: string; result: Promise<unknown> }>();
  constructor(
    private readonly windowId: string,
    private readonly limit = 256,
  ) {}
  run(id: string, payload: unknown, apply: () => unknown | Promise<unknown>): Promise<unknown> {
    if (!id.startsWith(this.windowId + ':'))
      return Promise.reject(new Error('The request outcome belongs to another Arc activation and is unknown.'));
    const hash = createHash('sha256')
      .update(
        JSON.stringify(payload, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      )
      .digest('hex');
    const held = this.results.get(id);
    if (held)
      return held.payload === hash
        ? held.result
        : Promise.reject(new Error('The request ID already names a different request.'));
    if (this.results.size >= this.limit)
      return Promise.reject(new Error('This Arc window has reached its session-write request limit.'));
    const result = Promise.resolve().then(apply);
    this.results.set(id, { payload: hash, result });
    return result;
  }
}

// Current no-turn rows use the same archive checks as completed turns.
export function archiveRefusal(row: SessionListingRow, force: boolean): string | null {
  if (
    ['running', 'waiting', 'subagents', 'background'].includes(row.runStatus) ||
    ['running', 'input'].includes(row.attention)
  )
    return 'The session is running or needs input.';
  if (row.facts !== 'current' || row.attention === 'unknown' || row.runStatus === 'unknown')
    return 'The session state is unavailable. Show Arc and retry.';
  if (row.attention === 'unread' && !force) return 'The completed session is unread. Use --force to archive it.';
  return null;
}
