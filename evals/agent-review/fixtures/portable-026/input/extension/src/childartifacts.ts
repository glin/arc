import type { FileCountReason, ToolFailure, TurnCommit, TurnFileChange } from './transcript';

// The tool name a failure carries when the reader never saw the call it answers. The failure
// still counts, but no tool of that name ran, so no count is drawn under it.
export const UNNAMED_TOOL = 'a tool';

// What a child's own transcript recorded, turn by turn. The calls, the failures and the times
// are optional, because a caller that only needs the files and the commits has none to give.
export interface ChildEvidence {
  turns: ReadonlyArray<{
    files: readonly TurnFileChange[];
    commits: readonly TurnCommit[];
    toolTally?: Readonly<Record<string, number>>;
    failures?: readonly ToolFailure[];
    startedAt?: number;
    endedAt?: number;
    processEndedAt?: number;
  }>;
}

// One file a child changed, summed over every edit of it the child recorded, rather than a
// final net diff. It carries the fields a file row draws, because the card merges these into
// its own file rows and a child's record then draws the rows the card draws.
export interface ChildFileChange {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  // Set where no edit of this file carried its hunks, so the row holds no line count at all.
  countsUnknown?: true;
  // Why the row is short of a count, carried across from the edit that named the path without
  // its lines. It stays when `settleCounts` turns `countsUnknown` into `countsPartial`, because
  // that edit is still why the count is a floor. Absent where the caller built the row without
  // recording a cause.
  unknownReason?: FileCountReason;
  // Set where the row holds a count and another edit of the same file named it without hunks.
  // The counts above are real, and they are a floor.
  countsPartial?: true;
}

// The files and commits one child made, each counted once, and the calls it ran to make them.
export interface ChildArtifacts {
  // Distinct changed files, in the order the child first changed them.
  files: ChildFileChange[];
  // Distinct commit ids, in the order they were first recorded.
  commits: string[];
  // The child's tool calls, counted by tool name. A count per name rather than a list of
  // calls, because this record crosses to the panel on every draw of the card.
  tools?: Record<string, number>;
  // The calls that came back as failures: all of them, and those whose tool is known, counted
  // by tool name. Absent where none failed.
  failed?: { count: number; byTool: Record<string, number> };
  // When the child's first turn started and its last turn ended, in epoch milliseconds.
  // For a Codex guardian, startedAt is the payload clock, before its first turn.
  startedAt?: number;
  endedAt?: number;
  // How many turns the child ran. Present only where it ran more than one. A Claude subagent
  // always holds exactly one, so this fires for a Codex child prompted more than once or for a
  // dispatched session someone resumed and typed into again.
  turnCount?: number;
  // False when the child's record was cut short, so every figure above is a lower bound.
  complete: boolean;
  // The child transcript revision these figures were read at.
  revision: string;
}

// How many tool calls the child made, the total of its counts by tool name. Null when Arc
// never read the child's record.
export function childToolCalls(artifacts: ChildArtifacts | undefined): number | null {
  if (!artifacts) {
    return null;
  }
  let total = 0;
  for (const count of Object.values(artifacts.tools ?? {})) {
    total += count;
  }
  return total;
}

// A child's own copy of the figures a read returned, independent of the cache or the lookup
// result that supplied them. `files` and `commits` are copied too, so a later change to either
// side never reaches through the other.
export function cloneChildArtifacts(artifacts: ChildArtifacts): ChildArtifacts {
  return {
    ...artifacts,
    files: artifacts.files.map((file) => ({ ...file })),
    commits: [...artifacts.commits],
    ...(artifacts.tools ? { tools: { ...artifacts.tools } } : {}),
    ...(artifacts.failed ? { failed: { ...artifacts.failed, byTool: { ...artifacts.failed.byTool } } } : {}),
  };
}

export interface ChildArtifactOptions {
  revision: string;
  complete: boolean;
  // The rules that decide when two recorded paths name one file and when two recorded ids
  // name one commit. The caller passes the transcript reader's own rules.
  pathKey: (path: string) => string;
  sameCommit: (left: string, right: string) => boolean;
}

// The span of a set of turns: the earliest start and the latest end, where the process that
// ran a turn outlived the turn's own last record. A turn with no recorded start carries zero
// rather than an absent field, so a zero is read as no start rather than as an epoch one, and
// a caller that read a turn's start before this one ran never has it pull the span back to 1970.
export function childTurnSpan(turns: readonly { startedAt?: number; endedAt?: number; processEndedAt?: number }[]): {
  startedAt?: number;
  endedAt?: number;
} {
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  for (const turn of turns) {
    if (turn.startedAt) {
      startedAt = Math.min(startedAt ?? turn.startedAt, turn.startedAt);
    }
    const end = turn.processEndedAt ?? turn.endedAt;
    if (end) {
      endedAt = Math.max(endedAt ?? end, end);
    }
  }
  return { startedAt, endedAt };
}

// Reduce a child's own record to its distinct files and commits. A path that several turns
// changed is one file whose counted edits all add to the line totals. Only the child's record
// is read, so a path or a commit the parent turn recorded as well counts once on the child
// row, and the parent's own work stays off it.
export function reduceChildArtifacts(child: ChildEvidence, options: ChildArtifactOptions): ChildArtifacts {
  const files = new Map<string, ChildFileChange>();
  const commits: string[] = [];
  // Tool names are the agent's own words, so they are gathered in maps and written out with
  // `Object.fromEntries`, which keeps a name such as `__proto__` an ordinary count.
  const tools = new Map<string, number>();
  const failed = new Map<string, number>();
  let failedCount = 0;
  const { startedAt, endedAt } = childTurnSpan(child.turns);
  for (const turn of child.turns) {
    for (const [name, count] of Object.entries(turn.toolTally ?? {})) {
      tools.set(name, (tools.get(name) ?? 0) + count);
    }
    for (const failure of turn.failures ?? []) {
      failedCount += 1;
      if (failure.tool !== UNNAMED_TOOL) {
        failed.set(failure.tool, (failed.get(failure.tool) ?? 0) + 1);
      }
    }
    for (const file of turn.files) {
      const key = options.pathKey(file.path);
      let held = files.get(key);
      if (!held) {
        held = { path: file.path, added: 0, removed: 0, isNew: false };
        files.set(key, held);
      }
      if (file.isNew) {
        held.isNew = true;
      }
      // A record marked as saying nothing about its size can still carry counted lines. One
      // child turn that edits a path and writes it whole holds both on one entry, so the mark
      // never stands for a zero. The counted lines always reach the row, and `settleCounts`
      // below decides which mark the row keeps once every record of the path has been read.
      if (file.countsUnknown) {
        held.countsUnknown = true;
        if (file.unknownReason) {
          held.unknownReason = file.unknownReason;
        }
      }
      held.added += file.added;
      held.removed += file.removed;
    }
    for (const commit of turn.commits) {
      if (!commits.some((held) => options.sameCommit(held, commit.sha))) {
        commits.push(commit.sha);
      }
    }
  }
  // Read once every record of a path has been gathered into its row, because the mark a row
  // carries depends on whether any record of it counted a line.
  for (const held of files.values()) {
    settleCounts(held);
  }
  return {
    files: [...files.values()],
    commits,
    ...(tools.size ? { tools: Object.fromEntries(tools) } : {}),
    ...(failedCount ? { failed: { count: failedCount, byTool: Object.fromEntries(failed) } } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(child.turns.length > 1 ? { turnCount: child.turns.length } : {}),
    complete: options.complete,
    revision: options.revision,
  };
}

// Which of the two marks a row carries, once every record of one path has been read into it.
//
// A record that names a path without its hunks says nothing about the lines another record
// counted on it, so it never takes those lines away. A row holding a count is partial rather
// than unknown, which keeps it in the line totals and marks the total a floor, a fact its
// record carries rather than the figure's face. A row holding no count at all is unknown,
// whichever record named it first.
//
// A child's own reducer, the card's rows, and the session heading's rows all settle a row here,
// so the child's figure, the turn's figure, the heading's figure and the rows under them cannot
// mark one file two ways.
export function settleCounts(row: ChildFileChange): void {
  if (!row.countsUnknown && !row.countsPartial) {
    return;
  }
  // A row that resolves to a counted floor keeps `unknownReason`, because the record that named
  // the path without its lines is still why the count is short. An Edit and then a whole-file
  // Write of one path settles to partial, and the figure still says the file was written whole.
  if (row.added || row.removed) {
    row.countsPartial = true;
    delete row.countsUnknown;
  } else {
    row.countsUnknown = true;
    delete row.countsPartial;
  }
}

// What a child's files come to: the lines its counted edits moved. The figure on the child's
// row reads this, so the figure and the rows behind it cannot count one child's work two ways.
export function childFileTotals(files: readonly ChildFileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}

// Whether a record's last line is whole. A writer that stopped mid-record leaves a last line
// that does not parse. The turns read before it are real, but the work after it is unknown.
export function lastLineWhole(line: string): boolean {
  if (!line.trim()) {
    return true;
  }
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

// The same figures with the commits a repository read recovered for the child. The result is
// a new object, because the figures a child read returns are shared with the cache that holds
// them.
export function withRecoveredCommits(
  artifacts: ChildArtifacts,
  recovered: readonly { sha: string }[],
  sameCommit: (left: string, right: string) => boolean,
): ChildArtifacts {
  const commits = [...artifacts.commits];
  for (const commit of recovered) {
    if (!commits.some((held) => sameCommit(held, commit.sha))) {
      commits.push(commit.sha);
    }
  }
  return commits.length === artifacts.commits.length ? artifacts : { ...artifacts, commits };
}
