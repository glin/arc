import { test } from 'vitest';
import assert from 'node:assert';
import { activityDetail, describeToolInput } from './activitydetail.ts';

test('captured built-in inputs have an explicit subject contract', () => {
  const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
    ['Bash', { command: 'npm test' }, 'required', 'command', 'npm test'],
    ['Edit', { file_path: 'src/a.ts' }, 'required', 'path', 'src/a.ts'],
    ['apply_patch', { paths: ['src/a.ts', 'src/b.ts'] }, 'required', 'path', 'src/a.ts\nsrc/b.ts'],
    ['view_image', { path: 'shots/panel.png' }, 'required', 'path', 'shots/panel.png'],
    ['WebSearch', { query: 'activity details' }, 'required', 'query', 'activity details'],
    ['web_search', { queries: ['first query', 'second query'] }, 'required', 'query', 'first query\nsecond query'],
    ['ToolSearch', { query: 'calendar tools' }, 'required', 'query', 'calendar tools'],
    ['WebFetch', { url: 'https://example.com' }, 'required', 'url', 'https://example.com'],
    ['web__run', { search_query: [{ q: 'Codex protocol' }] }, 'required', 'query', 'Codex protocol'],
    ['SendMessage', { recipient: 'reviewer', message: 'Please review' }, 'required', 'prose', 'reviewer'],
    ['send_message', { target: 'reviewer', message: 'Please review' }, 'required', 'prose', 'reviewer'],
    ['followup_task', { target: 'reviewer', message: 'Check again' }, 'required', 'prose', 'reviewer'],
    ['Task', { task_name: 'review_parser' }, 'required', 'prose', 'review_parser'],
    ['AskUserQuestion', { questions: [{ question: 'Which option?' }] }, 'required', 'prose', 'Which option?'],
    ['SendUserFile', { files: [{ path: 'report.txt' }] }, 'required', 'path', 'report.txt'],
    ['ReportFindings', { findings: [{ title: 'Missing detail' }] }, 'optional', 'prose', 'Missing detail'],
    ['TodoWrite', { todos: [{ content: 'Add fixture' }] }, 'optional', 'prose', 'Add fixture'],
    ['TaskOutput', { task_id: 'task-1' }, 'optional', 'prose', 'task-1'],
    ['TaskStop', { task_id: 'task-1' }, 'optional', 'prose', 'task-1'],
  ];
  for (const [tool, input, policy, format, exact] of cases) {
    assert.deepEqual(activityDetail(tool, input), { policy, format, exact }, tool);
  }
});

test('verb-only operations intentionally have no detail', () => {
  for (const tool of ['wait', 'wait_agent', 'write_stdin', 'list_agents', 'ListAgents', 'update_plan']) {
    assert.deepEqual(
      activityDetail(tool, { target: 'secret', cell_id: 'opaque' }),
      {
        policy: 'none',
        format: 'none',
        exact: '',
      },
      tool,
    );
  }
});

test('unknown tools use safe subject fields without dumping arbitrary input', () => {
  assert.equal(activityDetail('new_tool', { query: 'readable', secret: 'hidden' }).exact, 'readable');
  assert.equal(activityDetail('new_tool', { secret: 'hidden', patch: 'large' }).exact, '');
  assert.equal(describeToolInput({ paths: ['a.ts', 'b.ts'] }), 'a.ts\nb.ts');
});
