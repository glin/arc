import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { openingRecordOf } from './codex';
import type { CodexSubagentFile } from './codex';
import type { ClaudeChildSessionFile, ClaudeChildSessionReference } from './transcript';
import { isInside, projectSlug, type SessionFile } from './transcript';

export type SelectedSource = SessionFile & { dev: number };

// A window carries its own descendants, including nested and cross-agent launches.
export function selectedDependencies(
  sessionId: string,
  children: readonly CodexSubagentFile[],
  claudeChildren: readonly ClaudeChildSessionFile[],
  claudeChildReferences: readonly ClaudeChildSessionReference[],
) {
  const edges = new Map<string, string[]>();
  const add = (parent: string | null, child: string) => {
    if (!parent) return;
    const held = edges.get(parent) ?? [];
    held.push(child);
    edges.set(parent, held);
  };
  for (const child of children) add(child.parentThreadId, child.threadId);
  for (const child of claudeChildren) add(child.parentSessionId, child.sessionId);
  for (const child of claudeChildReferences) add(child.parentSessionId, child.sessionId);
  const own = new Set([sessionId]);
  for (const id of own) for (const child of edges.get(id) ?? []) own.add(child);
  return {
    children: children.filter((child) => own.has(child.threadId)),
    claudeChildren: claudeChildren.filter((child) => own.has(child.sessionId)),
    claudeChildReferences: claudeChildReferences.filter((child) => own.has(child.parentSessionId)),
  };
}

// Filename candidates establish no membership. Only the native opening admits an early read.
export async function resolveSelectedSource(
  sessionId: string,
  roots: readonly string[],
  projects: string,
  codex: string,
  signal: AbortSignal,
): Promise<SelectedSource | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || !roots.length || signal.aborted) return null;
  const candidates: Array<{ file: string; agent: 'claude' | 'codex' }> = [];
  {
    const slugs = roots.map((root) => projectSlug(root).toLowerCase());
    for (const directory of await entries(projects)) {
      const name = directory.name.toLowerCase();
      if (
        directory.isDirectory() &&
        slugs.some((slug) => name === slug || name.startsWith(`${slug.replace(/-$/, '')}-`))
      ) {
        const file = path.join(projects, directory.name, `${sessionId}.jsonl`);
        candidates.push({ file, agent: 'claude' });
      }
    }
    await walk(codex, 3);
  }
  const accepted: SelectedSource[] = [];
  for (const candidate of candidates) {
    if (signal.aborted) return null;
    const source = await validateSelectedSource({ ...candidate, sessionId }, roots, signal);
    if (source) accepted.push(source);
  }
  return accepted.length === 1 ? accepted[0] : null;

  async function walk(directory: string, depth: number): Promise<void> {
    if (signal.aborted) return;
    for (const entry of await entries(directory)) {
      if (signal.aborted) return;
      const file = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) candidates.push({ file, agent: 'codex' });
      else if (depth > 0 && entry.isDirectory()) await walk(file, depth - 1);
    }
  }
}

async function entries(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function validateSelectedSource(
  source: Pick<SessionFile, 'agent' | 'file' | 'sessionId'> &
    Partial<Pick<SessionFile, 'ino' | 'cwd'>> & { dev?: number },
  roots: readonly string[],
  signal: AbortSignal,
): Promise<SelectedSource | null> {
  try {
    if (signal.aborted) return null;
    const before = await fs.stat(source.file);
    if (
      !before.isFile() ||
      (source.ino !== undefined && source.ino !== before.ino) ||
      (source.dev !== undefined && source.dev !== before.dev)
    )
      return null;
    let cwd: string | null = null;
    let id: string | null = null;
    if (source.agent === 'codex') {
      const file = await fs.open(source.file, 'r');
      try {
        const buffer = Buffer.allocUnsafe(128 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        const end = head.indexOf('\n');
        if (end < 0) return null;
        const line = head.slice(0, end);
        const opening = JSON.parse(line) as { payload?: { id?: unknown } };
        cwd = openingRecordOf(line)?.cwd ?? null;
        id = typeof opening.payload?.id === 'string' ? opening.payload.id : null;
      } finally {
        await file.close();
      }
    } else {
      const file = await fs.open(source.file, 'r');
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        const lines = head.split('\n');
        if (!head.endsWith('\n')) lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const record = JSON.parse(line) as { sessionId?: unknown; cwd?: unknown };
          if (typeof record.sessionId === 'string' && record.sessionId) {
            if (record.sessionId !== source.sessionId) return null;
            id = record.sessionId;
          }
          if (cwd === null && typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
        }
      } finally {
        await file.close();
      }
    }
    const after = await fs.stat(source.file);
    if (
      signal.aborted ||
      id !== source.sessionId ||
      !cwd ||
      !isInside(cwd, [...roots]) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (source.cwd !== undefined && source.cwd !== cwd)
    )
      return null;
    return {
      agent: source.agent,
      file: source.file,
      sessionId: source.sessionId,
      cwd,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ino: after.ino,
      dev: after.dev,
    };
  } catch {
    return null;
  }
}
