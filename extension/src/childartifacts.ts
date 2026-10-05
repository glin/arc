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

// One child's recorded edits to a file, summed across turns.
// These totals describe recorded edits, rather than the final net diff. Parent cards and child details share the file-row fields.
export interface ChildFileChange {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  // Set when the row has no counted lines and includes an edit without hunks.
  countsUnknown?: true;
  // The cause of missing line counts. `settleCounts` retains it when other edits supply partial counts.
  // Absent when the caller supplies no cause.
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
  // The child's turn count, present only above one. Resumed dispatched sessions and repeatedly prompted Codex children can have multiple turns.
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

// Copies child artifacts, including nested file, commit, tool, and failure values.
// Changes to the copy do not affect the cached result.
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

// Returns the earliest nonzero start and latest nonzero end.
// Each turn uses `processEndedAt` when present, otherwise `endedAt`. Zero timestamps supply no boundary.
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

// Reduces the child's record to distinct files and commits. Repeated edits to a path add to that file's totals.
// The child row excludes the parent's own work.
export function reduceChildArtifacts(child: ChildEvidence, options: ChildArtifactOptions): ChildArtifacts {
  const files = new Map<string, ChildFileChange>();
  const commits: string[] = [];
  // Maps and `Object.fromEntries` preserve arbitrary tool names, including `__proto__`, as ordinary counts.
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
      // An edit without hunks can share an entry with counted edits to the same path.
      // Keep those lines. `settleCounts` chooses the final unknown or partial status after all edits are accumulated.
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
  // Settle each row after accumulating all edits. Missing hunks and counted edits together determine its status.
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

// Settles a file row after all recorded edits have been accumulated.
// Missing hunks do not remove counted lines. A row with counted lines becomes partial. A row without counted lines becomes unknown.
// Child details, turn cards, and session headings use this rule.
export function settleCounts(row: ChildFileChange): void {
  if (!row.countsUnknown && !row.countsPartial) {
    return;
  }
  // Keep `unknownReason` when counted edits make the row partial. The edit without hunks still explains the missing counts.
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

// Adds distinct recovered commits without modifying cached artifacts. Returns the original object when every recovered commit is already present.
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
