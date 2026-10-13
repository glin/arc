import { isInside, normalizeFsPath, supportedFileIdentity, sameSessionRevision, type SessionFile } from './transcript';
import { sessionSourceKey, sessionCatalogMembership, type SessionPageSource } from './sessionreads';

export type SessionCoverageDomain =
  | 'physical'
  | 'admitted'
  | 'published'
  | 'relationships'
  | 'classification'
  | 'selected'
  | 'accounting'
  | 'durable';
export type SessionPresence = 'present' | 'absent' | 'unknown';

// Producer evidence covers the supported traversal, including unread directories and failed candidates.
export interface SourceEnumeration {
  status: 'complete' | 'incomplete' | 'unavailable';
  files: readonly string[];
  uncertain: readonly string[];
  missingRoot?: boolean;
  root?: string;
  directories?: readonly string[];
}

export interface SessionCoverage extends SourceEnumeration {
  domain: SessionCoverageDomain;
  scope: string;
  revision: string;
  members?: ReadonlySet<string>;
  paths?: ReadonlySet<string>;
  directoryPaths?: ReadonlySet<string>;
}

export interface SessionCoverageContext {
  domain: SessionCoverageDomain;
  scope: string;
  revision: string;
}

export interface SessionCollisionEvidence {
  scope: string;
  sources: readonly SessionFile[];
}

export interface SessionCollisionObservation {
  scope: string;
  revision: string;
  source: SessionFile;
  excluded: boolean;
  hidden?: boolean;
}

// Retain competing sources until current identity, physical absence, or scope exclusion answers each source.
export function reconcileSessionCollisions(
  current: readonly SessionPageSource[],
  previous: SessionCollisionEvidence | undefined,
  context: SessionCoverageContext & { domain: 'physical' },
  enumeration: { claude: SourceEnumeration; codex: SourceEnumeration },
  observations: readonly SessionCollisionObservation[],
): SessionCollisionEvidence {
  const known = new Set([
    ...current.filter((entry) => entry.ambiguous).map((entry) => entry.session.sessionId),
    ...(previous?.sources.map((source) => source.sessionId) ?? []),
  ]);
  if (!known.size) return { scope: context.scope, sources: [] };
  const contested = new Set(known);
  const sources = new Map<string, Map<string, SessionFile>>();
  const files = new Map<string, SessionFile>();
  const fileKey = (source: SessionFile) => source.agent + '\0' + normalizeFsPath(source.file);
  for (const entry of current) {
    files.set(fileKey(entry.session), entry.session);
  }
  const qualified = new Map<string, SessionCollisionObservation>();
  for (const observation of observations) {
    const source = observation.source;
    if (
      observation.scope !== context.scope ||
      observation.revision !== context.revision ||
      (source.agent !== 'claude' && source.agent !== 'codex') ||
      !supportedFileIdentity(source) ||
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      !Number.isFinite(source.mtimeMs) ||
      source.mtimeMs < 0 ||
      sessionPresence({ ...enumeration[source.agent], ...context }, context, { file: source.file }) !== 'present'
    )
      continue;
    const listed = files.get(fileKey(source));
    const hidden = observation.hidden === true && source.agent === 'codex';
    if (observation.hidden && (!hidden || listed)) continue;
    if (
      !observation.excluded &&
      !hidden &&
      (!listed ||
        !sameSessionRevision(source, listed) ||
        sessionCoverageMember(source) !== sessionCoverageMember(listed))
    )
      continue;
    qualified.set(fileKey(source), observation);
  }
  for (const observation of qualified.values()) {
    if (observation.excluded || !observation.hidden) continue;
    const source = observation.source;
    known.add(source.sessionId);
    const group = sources.get(source.sessionId) ?? new Map<string, SessionFile>();
    group.set(sessionSourceKey(source.agent, source.sessionId, source.file), source);
    sources.set(source.sessionId, group);
  }
  for (const entry of current) {
    if (!known.has(entry.session.sessionId)) continue;
    const group = sources.get(entry.session.sessionId) ?? new Map<string, SessionFile>();
    group.set(entry.source, entry.session);
    sources.set(entry.session.sessionId, group);
  }
  if (previous) {
    for (const source of previous.sources) {
      const observation = qualified.get(fileKey(source));
      if (observation) continue;
      const physical = { ...enumeration[source.agent], ...context };
      if (sessionPresence(physical, context, { file: source.file }) === 'absent') continue;
      const group = sources.get(source.sessionId) ?? new Map<string, SessionFile>();
      group.set(sessionSourceKey(source.agent, source.sessionId, source.file), source);
      sources.set(source.sessionId, group);
    }
  }
  const retained: SessionFile[] = [];
  for (const id of known) {
    const group = sources.get(id);
    if (!group?.size) continue;
    const only = group.values().next().value;
    if (group.size === 1 && !contested.has(id)) continue;
    const observed = only && files.get(fileKey(only));
    if (
      group.size === 1 &&
      only &&
      observed?.sessionId === id &&
      qualified.get(fileKey(observed))?.source.sessionId === id &&
      sessionCoverageMember(only) === sessionCoverageMember(observed)
    )
      continue;
    retained.push(...group.values());
  }
  return { scope: context.scope, sources: retained };
}

// Reuse the source key and physical membership encoding for each accepted source.
export function sessionCoverageMember(source: SessionFile): string {
  return sessionCatalogMembership(sessionSourceKey(source.agent, source.sessionId, source.file), [source]);
}

// A projection supplies no removal evidence for another domain, scope, or accepted revision.
export function sessionPresence(
  coverage: SessionCoverage | undefined,
  context: SessionCoverageContext,
  subject: { file?: string; sessionId?: string; agent?: SessionFile['agent'] },
  catalog: readonly SessionFile[] = [],
): SessionPresence {
  if (
    !coverage ||
    coverage.domain !== context.domain ||
    coverage.scope !== context.scope ||
    coverage.revision !== context.revision
  )
    return 'unknown';
  if (context.domain === 'physical') {
    if (!subject.file) return 'unknown';
    const file = normalizeFsPath(subject.file);
    if (coverage.status === 'unavailable') return 'unknown';
    if (coverage.root && !isInside(subject.file, [coverage.root])) return 'unknown';
    if (coverage.missingRoot) return 'absent';
    if (
      coverage.uncertain.some((unknown) => {
        const root = normalizeFsPath(unknown).replace(/\/$/, '');
        return file === root || file.startsWith(root + '/');
      })
    )
      return 'unknown';
    if (coverage.paths ? coverage.paths.has(file) : coverage.files.some((known) => normalizeFsPath(known) === file))
      return 'present';
    if (coverage.directories) {
      const directory = file.slice(0, file.lastIndexOf('/'));
      if (
        !(coverage.directoryPaths
          ? coverage.directoryPaths.has(directory)
          : coverage.directories.some((visited) => normalizeFsPath(visited).replace(/\/$/, '') === directory))
      )
        return 'unknown';
    }
    return 'absent';
  }
  const matches = catalog.filter(
    (source) =>
      (!subject.sessionId || source.sessionId === subject.sessionId) &&
      (!subject.agent || source.agent === subject.agent) &&
      (!subject.file || normalizeFsPath(source.file) === normalizeFsPath(subject.file)),
  );
  const distinct = new Map(
    matches.map((source) => [sessionCoverageMember({ ...source, file: normalizeFsPath(source.file) }), source]),
  );
  if (distinct.size > 1) return 'unknown';
  const source = distinct.values().next().value;
  if (source && supportedFileIdentity(source) && coverage.members?.has(sessionCoverageMember(source))) return 'present';
  if (source) return 'unknown';
  return context.domain === 'admitted' && coverage.status === 'complete' ? 'absent' : 'unknown';
}
