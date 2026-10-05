const UNNAMED_TOOL = "a tool";
function childToolCalls(artifacts) {
  if (!artifacts) {
    return null;
  }
  let total = 0;
  for (const count of Object.values(artifacts.tools ?? {})) {
    total += count;
  }
  return total;
}
function cloneChildArtifacts(artifacts) {
  return {
    ...artifacts,
    files: artifacts.files.map((file) => ({ ...file })),
    commits: [...artifacts.commits],
    ...artifacts.tools ? { tools: { ...artifacts.tools } } : {},
    ...artifacts.failed ? { failed: { ...artifacts.failed, byTool: { ...artifacts.failed.byTool } } } : {}
  };
}
function childTurnSpan(turns) {
  let startedAt;
  let endedAt;
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
function reduceChildArtifacts(child, options) {
  const files = /* @__PURE__ */ new Map();
  const commits = [];
  const tools = /* @__PURE__ */ new Map();
  const failed = /* @__PURE__ */ new Map();
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
  for (const held of files.values()) {
    settleCounts(held);
  }
  return {
    files: [...files.values()],
    commits,
    ...tools.size ? { tools: Object.fromEntries(tools) } : {},
    ...failedCount ? { failed: { count: failedCount, byTool: Object.fromEntries(failed) } } : {},
    ...startedAt !== void 0 ? { startedAt } : {},
    ...endedAt !== void 0 ? { endedAt } : {},
    ...child.turns.length > 1 ? { turnCount: child.turns.length } : {},
    complete: options.complete,
    revision: options.revision
  };
}
function settleCounts(row) {
  if (!row.countsUnknown && !row.countsPartial) {
    return;
  }
  if (row.added || row.removed) {
    row.countsPartial = true;
    delete row.countsUnknown;
  } else {
    row.countsUnknown = true;
    delete row.countsPartial;
  }
}
function childFileTotals(files) {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}
function lastLineWhole(line) {
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
function withRecoveredCommits(artifacts, recovered, sameCommit) {
  const commits = [...artifacts.commits];
  for (const commit of recovered) {
    if (!commits.some((held) => sameCommit(held, commit.sha))) {
      commits.push(commit.sha);
    }
  }
  return commits.length === artifacts.commits.length ? artifacts : { ...artifacts, commits };
}
export {
  UNNAMED_TOOL,
  childFileTotals,
  childToolCalls,
  childTurnSpan,
  cloneChildArtifacts,
  lastLineWhole,
  reduceChildArtifacts,
  settleCounts,
  withRecoveredCommits
};
