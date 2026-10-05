import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spendFileVersion } from './agentspend.ts';
import { childFileTotals, cloneChildArtifacts, reduceChildArtifacts, type ChildFileChange } from './childartifacts.ts';
import {
  normalizeFsPath,
  readClaudeAgentSpend,
  refreshClaudeAgentFacts,
  sameCommitSha,
  type Turn,
} from './transcript.ts';
import { tempDir } from './temproot.ts';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function prompt(text: string, second: number) {
  return {
    type: 'user',
    isSidechain: true,
    cwd: 'c:/repo',
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}
function tool(id: string, name: string, input: Record<string, unknown>, second: number) {
  return {
    type: 'assistant',
    isSidechain: true,
    cwd: 'c:/repo',
    timestamp: at(second),
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] },
  };
}
function edited(id: string, filePath: string, added: number, removed: number, second: number) {
  return {
    type: 'user',
    isSidechain: true,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult: {
      filePath,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: removed,
          newStart: 1,
          newLines: added,
          lines: [...Array(added).fill('+new'), ...Array(removed).fill('-old')],
        },
      ],
    },
  };
}
function committed(id: string, stdout: string, second: number) {
  return {
    type: 'user',
    isSidechain: true,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
    toolUseResult: { stdout, stderr: '' },
  };
}
// A result the way a Claude child records one: the text the tool printed, and no
// `toolUseResult` beside it.
function textResult(id: string, text: string, second: number) {
  return {
    type: 'user',
    isSidechain: true,
    timestamp: at(second),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  };
}
function answer(text: string, second: number) {
  return {
    type: 'assistant',
    isSidechain: true,
    timestamp: at(second),
    message: {
      role: 'assistant',
      id: `a${second}`,
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  };
}

// Two turns that each edit `src/a.ts` and each commit, then a record the writer never finished.
function childRecord(): string {
  const lines = [
    prompt('fix the parser', 0),
    tool('e1', 'Edit', { file_path: 'c:/repo/src/a.ts' }, 1),
    edited('e1', 'c:/repo/src/a.ts', 3, 1, 2),
    tool('c1', 'Bash', { command: 'git commit -am "Fix parser"' }, 3),
    committed('c1', '[topic abc1234] Fix parser\n 1 file changed, 3 insertions(+), 1 deletion(-)', 4),
    answer('Committed.', 5),
    prompt('fix the lexer too', 6),
    tool('e2', 'Edit', { file_path: String.raw`C:\repo\src\a.ts` }, 7),
    edited('e2', String.raw`C:\repo\src\a.ts`, 2, 0, 8),
    tool('e3', 'Edit', { file_path: 'c:/repo/src/b.ts' }, 9),
    edited('e3', 'c:/repo/src/b.ts', 1, 4, 10),
    tool('c2', 'Bash', { command: 'git commit -am "Fix lexer"' }, 11),
    committed('c2', '[topic def5678] Fix lexer\n 2 files changed, 3 insertions(+), 4 deletions(-)', 12),
    answer('Committed again.', 13),
  ].map((line) => JSON.stringify(line));
  const file = path.join(tempDir('child-artifacts-'), 'agent-child.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n${lines[1].slice(0, 40)}`);
  return file;
}

test('a child counts each path and commit once, sums its edits, and marks a cut-off record partial', () => {
  const file = childRecord();
  const artifacts = readClaudeAgentSpend(file).artifacts;
  assert.ok(artifacts);
  assert.deepEqual(
    artifacts.files.map((file) => normalizeFsPath(file.path)),
    ['c:/repo/src/a.ts', 'c:/repo/src/b.ts'],
  );
  assert.deepEqual(artifacts.commits, ['abc1234', 'def5678']);
  const totals = childFileTotals(artifacts.files);
  assert.deepEqual([totals.added, totals.removed], [6, 5]);
  assert.equal(
    artifacts.files.some((file) => file.countsUnknown),
    false,
  );
  assert.equal(artifacts.complete, false);
  assert.equal(artifacts.revision, spendFileVersion(file));
});

test("a clone of a child's artifacts shares no file or commit array with the source", () => {
  const source = {
    files: [{ path: 'c:/repo/src/a.ts', added: 3, removed: 1, isNew: false }],
    commits: ['abc1234'],
    tools: { Bash: 2 },
    failed: { count: 1, byTool: { Bash: 1 } },
    complete: true,
    revision: 'r1',
  };
  const clone = cloneChildArtifacts(source);
  assert.deepEqual(clone, source, 'a clone carries every figure the source carried');
  clone.files[0].added = 99;
  clone.files.push({ path: 'c:/repo/src/b.ts', added: 1, removed: 0, isNew: true });
  clone.commits.push('def5678');
  assert.deepEqual(source.files, [{ path: 'c:/repo/src/a.ts', added: 3, removed: 1, isNew: false }]);
  assert.deepEqual(source.commits, ['abc1234']);
  clone.tools!.Bash = 99;
  clone.failed!.byTool.Edit = 1;
  assert.deepEqual([source.tools, source.failed], [{ Bash: 2 }, { count: 1, byTool: { Bash: 1 } }]);
});

test('a child counts its calls and its failures by tool, and the span it ran', () => {
  const lines = [
    prompt('run the tests', 0),
    tool('b1', 'Bash', { command: 'npm test' }, 1),
    {
      type: 'user',
      isSidechain: true,
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'Exit code 1' }],
      },
    },
    tool('r1', 'Read', { file_path: 'c:/repo/src/a.ts' }, 3),
    textResult('r1', 'ok', 4),
    tool('b2', 'Bash', { command: 'npm test' }, 5),
    textResult('b2', 'ok', 6),
    answer('The tests pass.', 7),
  ].map((line) => JSON.stringify(line));
  const file = path.join(tempDir('child-run-'), 'agent-child.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const artifacts = readClaudeAgentSpend(file).artifacts;
  assert.deepEqual(
    [artifacts?.tools, artifacts?.failed, artifacts?.startedAt, artifacts?.endedAt],
    [{ Bash: 2, Read: 1 }, { count: 1, byTool: { Bash: 1 } }, Date.parse(at(0)), Date.parse(at(7))],
  );
});

test('a failure whose call the child never recorded counts, but under no tool name', () => {
  const failedResult = (id: string, second: number) => ({
    type: 'user',
    isSidechain: true,
    timestamp: at(second),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Exit code 1' }],
    },
  });
  const artifacts = childArtifactsOf('child-unnamed-failure-', [
    prompt('run the tests', 0),
    tool('b1', 'Bash', { command: 'npm test' }, 1),
    failedResult('b1', 2),
    // The call this answers was never written to the record.
    failedResult('lost', 3),
    answer('The tests fail.', 4),
  ]);
  assert.deepEqual([artifacts?.tools, artifacts?.failed], [{ Bash: 1 }, { count: 2, byTool: { Bash: 1 } }]);
});

test('a tool name the agent chose stays a count, and a child with no failure carries none', () => {
  const tallied = (name: string, count: number) => ({ files: [], commits: [], toolTally: { [name]: count } });
  const turns = [
    { ...tallied('Bash', 2), failures: [{ tool: '__proto__', message: 'no' }], startedAt: 20, endedAt: 30 },
    { ...tallied('Bash', 1), startedAt: 10, endedAt: 15, processEndedAt: 40 },
  ];
  const options = { revision: 'r1', complete: true, pathKey: normalizeFsPath, sameCommit: sameCommitSha };
  const artifacts = reduceChildArtifacts({ turns }, options);
  assert.deepEqual(Object.entries(artifacts.failed?.byTool ?? {}), [['__proto__', 1]]);
  assert.deepEqual([artifacts.tools, artifacts.startedAt, artifacts.endedAt], [{ Bash: 3 }, 10, 40]);
  assert.equal('failed' in reduceChildArtifacts({ turns: [tallied('Read', 1)] }, options), false);
  // Report turnCount for multiple child turns. A single turn omits the field.

  assert.equal(artifacts.turnCount, 2);
  assert.equal('turnCount' in reduceChildArtifacts({ turns: [tallied('Read', 1)] }, options), false);
});

test('a child record whose last line is whole is complete', () => {
  const file = childRecord();
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n[^\n]*$/, '\n'));
  const artifacts = readClaudeAgentSpend(file).artifacts;
  assert.deepEqual([artifacts?.files.length, artifacts?.commits.length, artifacts?.complete], [2, 2, true]);
});

test('a path a child both counted and mentioned keeps its floor, in one turn or in two', () => {
  const change = (added: number, removed: number, unknown = false) => ({
    path: 'c:/repo/src/a.ts',
    added,
    removed,
    isNew: false,
    edits: [],
    ...(unknown ? { countsUnknown: true as const } : {}),
  });
  const options = { revision: 'r1', complete: true, pathKey: normalizeFsPath, sameCommit: sameCommitSha };
  for (const turns of [
    // One entry can carry measured edit counts and an uncounted whole-file write together.

    [{ files: [change(3, 1, true)], commits: [] }],
    [
      { files: [change(3, 1)], commits: [] },
      { files: [change(0, 0, true)], commits: [] },
    ],
    [
      { files: [change(0, 0, true)], commits: [] },
      { files: [change(3, 1)], commits: [] },
    ],
  ]) {
    const artifacts = reduceChildArtifacts({ turns }, options);
    const totals = childFileTotals(artifacts.files);
    // An uncounted write preserves measured edit counts and marks them partial.

    assert.deepEqual([artifacts.files.length, totals.added, totals.removed, artifacts.complete], [1, 3, 1, true]);
    assert.deepEqual(
      [artifacts.files[0].countsPartial ?? null, artifacts.files[0].countsUnknown ?? null],
      [true, null],
    );
  }
});

test('a commit and a path the parent turn recorded as well count once on the child row', () => {
  const file = childRecord();
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n[^\n]*$/, '\n'));
  const parent = {
    files: [
      { path: String.raw`C:\repo\src\b.ts`, added: 1, removed: 4, isNew: false, edits: [] },
      { path: 'c:/repo/src/parent.ts', added: 9, removed: 9, isNew: false, edits: [] },
    ],
    commits: [
      { sha: 'abc1234f', subject: 'Fix parser', files: 1, added: 3, removed: 1, at: 0, place: null, dir: null },
      { sha: '9999999', subject: 'Parent work', files: 1, added: 9, removed: 9, at: 0, place: null, dir: null },
    ],
    agents: [
      {
        id: 'child',
        toolUseId: 'task1',
        description: 'Fix child',
        agentType: null,
        model: null,
        effort: null,
        spend: [],
        spendFound: false,
        spendPartial: false,
        durationMs: null,
        tokens: null,
        toolUses: null,
        status: 'completed',
      },
    ],
  } as unknown as Turn;
  refreshClaudeAgentFacts([parent], () => readClaudeAgentSpend(file), undefined);
  const artifacts = parent.agents[0].artifacts;
  assert.deepEqual(
    [
      artifacts?.files.map((file) => normalizeFsPath(file.path)),
      artifacts?.commits,
      childFileTotals(artifacts?.files ?? []).added,
      childFileTotals(artifacts?.files ?? []).removed,
      artifacts?.complete,
    ],
    [['c:/repo/src/a.ts', 'c:/repo/src/b.ts'], ['abc1234', 'def5678'], 6, 5, true],
  );
});

// A child fixture with result text and no structured toolUseResult values.
// one Write, one Edit, a commit and a command that committed nothing.
function textOnlyChildRecord(): string {
  const lines = [
    prompt('fix the parser', 0),
    tool('w1', 'Write', { file_path: 'c:/repo/src/new.ts', content: 'one\ntwo\nthree\n' }, 1),
    textResult('w1', 'File created successfully.', 2),
    tool(
      'e1',
      'Edit',
      {
        file_path: 'c:/repo/src/a.ts',
        old_string: 'keep\nold one\nold two\ntail',
        new_string: 'keep\nnew one\ntail',
      },
      3,
    ),
    textResult('e1', 'The file c:/repo/src/a.ts has been updated.', 4),
    tool('b1', 'Bash', { command: 'git commit -am "Fix parser"' }, 5),
    textResult('b1', '[topic abc1234] Fix parser\n 2 files changed, 4 insertions(+), 2 deletions(-)', 6),
    tool('b2', 'Bash', { command: 'npm test' }, 7),
    textResult('b2', 'all tests passed', 8),
    answer('Committed.', 9),
  ].map((line) => JSON.stringify(line));
  const file = path.join(tempDir('child-text-evidence-'), 'agent-child.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('a child that recorded only call inputs and result text still draws its files and commits', () => {
  const file = textOnlyChildRecord();
  const parent = {
    files: [],
    commits: [],
    agents: [
      {
        id: 'child',
        toolUseId: 'task1',
        description: 'Fix child',
        agentType: null,
        model: null,
        effort: null,
        spend: [],
        spendFound: false,
        spendPartial: false,
        durationMs: null,
        tokens: null,
        toolUses: null,
        status: 'completed',
      },
    ],
  } as unknown as Turn;
  refreshClaudeAgentFacts([parent], () => readClaudeAgentSpend(file), undefined);
  const artifacts = parent.agents[0].artifacts;
  const totals = childFileTotals(artifacts?.files ?? []);
  assert.deepEqual(
    [
      artifacts?.files.map((changed) => normalizeFsPath(changed.path)),
      artifacts?.commits,
      totals.added,
      totals.removed,
      artifacts?.files.filter((changed) => changed.countsUnknown).length,
      artifacts?.complete,
    ],
    [['c:/repo/src/new.ts', 'c:/repo/src/a.ts'], ['abc1234'], 1, 2, 1, true],
  );
});

// The figures a child read draws from one record of its own.
function childArtifactsOf(name: string, records: readonly unknown[]) {
  const file = path.join(tempDir(name), 'agent-child.jsonl');
  fs.writeFileSync(file, `${records.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return readClaudeAgentSpend(file).artifacts;
}

// Every file of one read, as the path, its counts and whether it says how many lines moved.
function fileRows(artifacts: { files: readonly ChildFileChange[] } | undefined) {
  return (artifacts?.files ?? []).map((changed) => [
    normalizeFsPath(changed.path),
    changed.added,
    changed.removed,
    changed.countsUnknown === true,
  ]);
}

test('a notebook cell a child replaced counts as a file with no line counts', () => {
  const artifacts = childArtifactsOf('child-notebook-evidence-', [
    prompt('update the notebook', 0),
    tool('n1', 'NotebookEdit', { notebook_path: 'c:/repo/run.ipynb', new_source: 'print(1)' }, 1),
    textResult('n1', 'Updated cell 3.', 2),
    answer('Updated.', 3),
  ]);
  const totals = childFileTotals(artifacts?.files ?? []);
  assert.deepEqual(
    [
      artifacts?.files.map((changed) => normalizeFsPath(changed.path)),
      totals.added,
      artifacts?.files.filter((changed) => changed.countsUnknown).length,
    ],
    [['c:/repo/run.ipynb'], 0, 1],
  );
});

test("a child's input that does not say how many lines moved draws a file with no counts", () => {
  const artifacts = childArtifactsOf('child-uncounted-inputs-', [
    prompt('rename the helper', 0),
    // A whole-file Write does not identify the old lines, so it cannot establish added or removed counts.

    tool('w1', 'Write', { file_path: 'c:/repo/src/whole.ts', content: 'one\ntwo\nthree\n' }, 1),
    textResult('w1', 'File updated successfully.', 2),
    // A `replace_all` edit ran its replacement an unrecorded number of times.
    tool(
      'e1',
      'Edit',
      {
        file_path: 'c:/repo/src/all.ts',
        old_string: 'old',
        new_string: 'new\nnewer',
        replace_all: true,
      },
      3,
    ),
    textResult('e1', 'The file c:/repo/src/all.ts has been updated.', 4),
    // Two sides whose shared lines account for all of them still moved a trailing newline.
    tool('e2', 'Edit', { file_path: 'c:/repo/src/tail.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\n' }, 5),
    textResult('e2', 'The file c:/repo/src/tail.ts has been updated.', 6),
    answer('Renamed.', 7),
  ]);
  assert.deepEqual(fileRows(artifacts), [
    ['c:/repo/src/whole.ts', 0, 0, true],
    ['c:/repo/src/all.ts', 0, 0, true],
    ['c:/repo/src/tail.ts', 0, 0, true],
  ]);
});

test("a child's counted edit keeps the mark another call left on the same file, and its lines", () => {
  const artifacts = childArtifactsOf('child-mark-kept-', [
    prompt('rewrite then patch', 0),
    tool('w1', 'Write', { file_path: 'c:/repo/src/a.ts', content: 'one\ntwo\n' }, 1),
    textResult('w1', 'File updated successfully.', 2),
    tool(
      'e1',
      'Edit',
      {
        file_path: 'c:/repo/src/a.ts',
        old_string: 'keep\nold one\nold two\ntail',
        new_string: 'keep\nnew one\ntail',
      },
      3,
    ),
    textResult('e1', 'The file c:/repo/src/a.ts has been updated.', 4),
    answer('Patched.', 5),
  ]);
  // The Write leaves old lines unknown. The Edit measures one added line and two removed lines, which the file retains as partial counts.

  assert.deepEqual(fileRows(artifacts), [['c:/repo/src/a.ts', 1, 2, false]]);
  assert.equal(artifacts?.files[0].countsPartial, true);
});

test("a child's edit is read from a result that carries a field of no use", () => {
  const editResult = (id: string, second: number, held: unknown) => ({
    ...textResult(id, 'The file has been updated.', second),
    toolUseResult: held,
  });
  const artifacts = childArtifactsOf('child-unusable-result-', [
    prompt('patch both files', 0),
    tool('e1', 'Edit', { file_path: 'c:/repo/src/a.ts', old_string: 'one', new_string: 'one\ntwo' }, 1),
    editResult('e1', 2, [{ type: 'text', text: 'ok' }]),
    tool('e2', 'Edit', { file_path: 'c:/repo/src/b.ts', old_string: 'one', new_string: 'one\ntwo' }, 3),
    editResult('e2', 4, { interrupted: false }),
    answer('Patched.', 5),
  ]);
  assert.deepEqual(fileRows(artifacts), [
    ['c:/repo/src/a.ts', 1, 0, false],
    ['c:/repo/src/b.ts', 1, 0, false],
  ]);
});

test('one result answering the same edit call twice counts its lines once', () => {
  const twice = {
    type: 'user',
    isSidechain: true,
    timestamp: at(2),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'e1', content: 'The file has been updated.' },
        { type: 'tool_result', tool_use_id: 'e1', content: 'The file has been updated.' },
      ],
    },
  };
  const artifacts = childArtifactsOf('child-repeated-result-', [
    prompt('patch it', 0),
    tool('e1', 'Edit', { file_path: 'c:/repo/src/a.ts', old_string: 'one', new_string: 'one\ntwo' }, 1),
    twice,
    answer('Patched.', 3),
  ]);
  assert.deepEqual(fileRows(artifacts), [['c:/repo/src/a.ts', 1, 0, false]]);
});

test('a child records the commit a command other than `git commit` printed', () => {
  const artifacts = childArtifactsOf('child-git-commands-', [
    prompt('land the revert', 0),
    tool('b1', 'Bash', { command: 'git revert --no-edit HEAD' }, 1),
    textResult('b1', '[topic abc1234] Revert "Break the parser"\n 1 file changed, 2 deletions(-)', 2),
    tool('b2', 'Bash', { command: 'GIT_EDITOR=true git rebase --continue' }, 3),
    textResult('b2', '[topic def5678] Fix the parser', 4),
    // Not git, so the line it printed is somebody else's commit quoted back.
    tool('b3', 'Bash', { command: 'node tools/report.mjs' }, 5),
    textResult('b3', '[main 99999999] A commit this call did not make', 6),
    answer('Landed.', 7),
  ]);
  assert.deepEqual(artifacts?.commits, ['abc1234', 'def5678']);
});

test("a child's input of the wrong type draws no file", () => {
  const artifacts = childArtifactsOf('child-typed-inputs-', [
    prompt('do the edits', 0),
    tool('e1', 'Edit', { file_path: { path: 'c:/repo/src/a.ts' }, old_string: 'one', new_string: 'two' }, 1),
    textResult('e1', 'The file has been updated.', 2),
    tool('e2', 'Edit', { file_path: 'c:/repo/src/b.ts', old_string: ['one', 'two'], new_string: 'three' }, 3),
    textResult('e2', 'The file has been updated.', 4),
    tool('w1', 'Write', { file_path: 'c:/repo/src/c.ts', content: { text: 'one' } }, 5),
    textResult('w1', 'File created successfully.', 6),
    tool('n1', 'NotebookEdit', { notebook_path: 7, new_source: 'print(1)' }, 7),
    textResult('n1', 'Updated cell 3.', 8),
    answer('Done.', 9),
  ]);
  assert.deepEqual(fileRows(artifacts), []);
});
