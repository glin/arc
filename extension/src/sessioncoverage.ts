import { isInside, normalizeFsPath, supportedFileIdentity, sameSessionRevision, type SessionFile } from './transcript';
import { isAgySessionId } from './agydiscovery';
import { isCompressedRolloutName } from './compressedrollouts';
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
  // The Codex walk lists every directory in range. Links and directories beyond its limit are opaque.
  directoryTree?: { depth: number; untraversed: readonly string[] };
  // The compressed Codex rollouts the walk saw. They are not in `files`, and the walk read no stat for them.
  compressed?: readonly string[];
}

export interface SessionCoverage extends SourceEnumeration {
  domain: SessionCoverageDomain;
  scope: string;
  revision: string;
  members?: ReadonlySet<string>;
  paths?: ReadonlySet<string>;
  directoryPaths?: ReadonlySet<string>;
  untraversedPaths?: ReadonlySet<string>;
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

export function sessionCoverageFileKey(agent: SessionFile['agent'], file: string): string {
  return agent + '\0' + normalizeFsPath(file);
}

function qualifiedSessionObservations(
  files: ReadonlyMap<string, SessionFile>,
  context: SessionCoverageContext & { domain: 'physical' },
  enumeration: { claude: SessionCoverage; codex: SessionCoverage },
  observations: readonly SessionCollisionObservation[],
  includeCompressed = false,
): Map<string, SessionCollisionObservation> {
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
      sessionPresence(enumeration[source.agent], context, { file: source.file }) !== 'present'
    )
      continue;
    const key = sessionCoverageFileKey(source.agent, source.file);
    if (includeCompressed && source.agent === 'codex' && isCompressedRolloutName(source.file)) {
      qualified.set(key, observation);
      continue;
    }
    const listed = files.get(key);
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
    qualified.set(key, observation);
  }
  return qualified;
}

export function indexedPhysical(
  enumeration: SourceEnumeration,
  context: SessionCoverageContext & { domain: 'physical' },
  files = enumeration.files,
): SessionCoverage {
  return {
    ...enumeration,
    ...context,
    files,
    paths: new Set(files.map(normalizeFsPath)),
    directoryPaths: enumeration.directories
      ? new Set(enumeration.directories.map((directory) => normalizeFsPath(directory).replace(/\/$/, '')))
      : undefined,
    untraversedPaths: enumeration.directoryTree
      ? new Set(enumeration.directoryTree.untraversed.map(normalizeFsPath))
      : undefined,
  };
}

export function nativeReservationTwin(source: SessionFile): string | undefined {
  if (source.agent !== 'codex') return undefined;
  if (isCompressedRolloutName(source.file)) return source.file.slice(0, -'.zst'.length);
  const twin = source.file + '.zst';
  return isCompressedRolloutName(twin) ? twin : undefined;
}

// A qualified opening can resolve an earlier reservation even when its ID cannot reserve.
export function retainNativeSessionReservations(
  current: readonly SessionFile[],
  previous: readonly SessionFile[] | undefined,
  context: SessionCoverageContext & { domain: 'physical' },
  enumeration: { claude: SourceEnumeration; codex: SourceEnumeration },
  observations: readonly SessionCollisionObservation[],
  inRoots: (cwd: string) => boolean,
  compressed?: { coverage?: SessionCoverage; plainPresent: (file: string) => boolean },
): SessionFile[] {
  const files = new Map(
    current
      .filter((source) => !isCompressedRolloutName(source.file))
      .map((source) => [sessionCoverageFileKey(source.agent, source.file), source]),
  );
  if (
    !observations.some(({ excluded, hidden, source }) => excluded || hidden || isCompressedRolloutName(source.file)) &&
    (!previous ||
      previous.every(
        (source) =>
          files.get(sessionCoverageFileKey(source.agent, source.file))?.sessionId.toLowerCase() ===
          source.sessionId.toLowerCase(),
      ))
  )
    return [...files.values()].filter((source) => isAgySessionId(source.sessionId));

  const physical = {
    claude: indexedPhysical(enumeration.claude, context),
    codex:
      compressed?.coverage ??
      indexedPhysical(enumeration.codex, context, [
        ...enumeration.codex.files,
        ...(enumeration.codex.compressed ?? []),
      ]),
  };
  const qualified = qualifiedSessionObservations(files, context, physical, observations, true);
  const plainPresence = (source: SessionFile): SessionPresence | undefined => {
    if (!isCompressedRolloutName(source.file)) return undefined;
    if (compressed?.plainPresent(source.file)) return 'present';
    return sessionPresence(physical.codex, context, { file: nativeReservationTwin(source) });
  };
  for (const [key, { source, excluded }] of qualified) {
    const plain = plainPresence(source);
    if (!excluded && plain === 'unknown') {
      qualified.delete(key);
      continue;
    }
    if (excluded || plain === 'present') files.delete(key);
    else files.set(key, source);
  }
  const reservations = [...files.values()].filter((source) => isAgySessionId(source.sessionId));
  for (const source of previous ?? []) {
    if (source.agent === 'agy' || (source.cwd && !inRoots(source.cwd))) continue;
    const key = sessionCoverageFileKey(source.agent, source.file);
    if (files.get(key)?.sessionId.toLowerCase() === source.sessionId.toLowerCase() || qualified.has(key)) continue;
    const coverage = physical[source.agent];
    if (plainPresence(source) === 'present') continue;
    if (sessionPresence(coverage, context, { file: source.file }) === 'absent') {
      const twin = nativeReservationTwin(source);
      if (
        !twin ||
        qualified.has(sessionCoverageFileKey('codex', twin)) ||
        sessionPresence(coverage, context, { file: twin }) === 'absent'
      )
        continue;
    }
    reservations.push(source);
  }
  return reservations;
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
  const files = new Map(
    current.map((entry) => [sessionCoverageFileKey(entry.session.agent, entry.session.file), entry.session]),
  );
  const physical = {
    claude: indexedPhysical(enumeration.claude, context),
    codex: indexedPhysical(enumeration.codex, context),
  };
  const qualified = qualifiedSessionObservations(files, context, physical, observations);
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
      if (source.agent === 'agy') continue;
      const observation = qualified.get(sessionCoverageFileKey(source.agent, source.file));
      if (observation) continue;
      if (sessionPresence(physical[source.agent], context, { file: source.file }) === 'absent') continue;
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
    const observed = only && files.get(sessionCoverageFileKey(only.agent, only.file));
    if (
      group.size === 1 &&
      only &&
      observed?.sessionId === id &&
      qualified.get(sessionCoverageFileKey(observed.agent, observed.file))?.source.sessionId === id &&
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
      const visited = (directory: string) =>
        coverage.directoryPaths
          ? coverage.directoryPaths.has(directory)
          : coverage.directories!.some((path) => normalizeFsPath(path).replace(/\/$/, '') === directory);
      let directory = file.slice(0, file.lastIndexOf('/'));
      if (visited(directory)) return 'absent';
      if (!coverage.root || !coverage.directoryTree) return 'unknown';
      const root = normalizeFsPath(coverage.root).replace(/\/$/, '');
      if (!directory.startsWith(root + '/')) return 'unknown';
      const depth = directory.slice(root.length + 1).split('/').length;
      if (depth > coverage.directoryTree.depth) return 'unknown';
      while (directory !== root) {
        const opaque = coverage.untraversedPaths
          ? coverage.untraversedPaths.has(directory)
          : coverage.directoryTree.untraversed.some((path) => normalizeFsPath(path) === directory);
        if (opaque) return 'unknown';
        directory = directory.slice(0, directory.lastIndexOf('/'));
        if (visited(directory)) return 'absent';
      }
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
