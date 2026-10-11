import { test } from 'vitest';
import assert from 'node:assert';
import { exportSavedSession, savedExportSource, type SessionExportPorts } from './sessionexport';
import type { ExportCaptureOptions } from './exportdata';
import { ExportCancelled } from './exportwriter';

const source = {
  agent: 'claude' as const,
  file: '/configured/projects/session.jsonl',
  sessionId: 'saved',
  size: 100,
  mtimeMs: 1,
};
function fixture() {
  const calls: string[] = [];
  let written: ExportCaptureOptions | undefined;
  const controller = new AbortController();
  const ports: SessionExportPorts = {
    confirm: async (title, detail) => {
      calls.push(title);
      assert.match(detail, /linked session work/);
      return true;
    },
    chooseFolder: async () => {
      calls.push('folder');
      return '/destination';
    },
    progress: async (title, operation) => {
      calls.push(title);
      return operation(controller.signal, (message) => calls.push(message));
    },
    write: async (destination, options) => {
      assert.equal(destination, '/destination');
      written = options;
      options.progress?.('text', 2);
      return { index: '/destination/site/index.html' };
    },
    completed: async (title, index) => {
      calls.push(`open ${title} ${index}`);
    },
    failed: (message) => {
      calls.push(message);
    },
  };
  return { calls, ports, controller, written: () => written };
}

test('export retains its initiating saved identity and configured roots through native choices', async () => {
  const f = fixture();
  const root = { ...source };
  f.ports.confirm = async () => {
    root.sessionId = 'later-selection';
    return true;
  };
  await exportSavedSession(
    root,
    'Starting session',
    {
      roots: { claude: '/configured/projects', codex: '/configured/sessions' },
      readerParents: { child: 'saved' },
      capturedAt: 100,
    },
    f.ports,
  );
  assert.equal(f.written()?.root.sessionId, 'saved');
  assert.equal(f.written()?.root.file, source.file);
  assert.deepEqual(f.written()?.roots, { claude: '/configured/projects', codex: '/configured/sessions' });
  assert.deepEqual(f.written()?.readerParents, { child: 'saved' });
  assert.equal(f.written()?.signal, f.controller.signal);
  assert.equal(f.written()?.capturedAt, 100);
  assert.deepEqual(f.calls, [
    'folder',
    'Exporting Starting session',
    'Reading recorded text (2 sessions)',
    'open Starting session /destination/site/index.html',
  ]);
});

test('native declines, cancellation and failures never offer a partial export', async () => {
  for (const phase of ['confirmation', 'folder', 'cancel', 'failure'] as const) {
    const f = fixture();
    if (phase === 'confirmation') f.ports.confirm = async () => false;
    if (phase === 'folder') f.ports.chooseFolder = async () => undefined;
    if (phase === 'cancel' || phase === 'failure')
      f.ports.write = async () => {
        throw phase === 'cancel' ? new ExportCancelled() : new Error('Saved text unavailable.');
      };
    await exportSavedSession(source, 'Session name', {}, f.ports);
    assert.ok(!f.calls.some((call) => call.startsWith('open ')));
    assert.equal(f.calls.filter((call) => call.startsWith('Arc:')).length, phase === 'failure' ? 1 : 0);
    if (phase === 'failure') assert.match(f.calls.at(-1)!, /Session name was not exported.*Saved text unavailable/);
  }
});

test('native choices retain the initiating archive and launch membership snapshot', async () => {
  const f = fixture();
  const readerState = {
    archived: [{ agent: 'claude' as const, sessionId: 'saved' }],
    startedHere: [{ agent: 'codex' as const, sessionId: 'reader' }],
    agentRuns: [{ agent: 'claude' as const, sessionId: 'run' }],
  };
  const expected = structuredClone(readerState);
  f.ports.confirm = async () => {
    readerState.archived[0].sessionId = 'later';
    readerState.startedHere.length = 0;
    readerState.agentRuns.length = 0;
    return true;
  };
  await exportSavedSession(source, 'Saved session', { readerState }, f.ports);
  assert.deepEqual(f.written()!.readerState, expected);
});

test('only an unambiguous saved catalog source can start export', async () => {
  assert.equal(savedExportSource('draft', [source]), null);
  assert.equal(savedExportSource('saved', [source, { ...source, agent: 'codex' }]), null);
  const selected = savedExportSource('saved', [source]);
  assert.deepEqual(selected, source);
  assert.notEqual(selected, source);
  const f = fixture();
  await exportSavedSession(null, 'Draft session', {}, f.ports);
  assert.deepEqual(f.calls, ['Arc: Draft session is unavailable or ambiguous.']);
});

test('a failed local Open preserves the completed export outcome', async () => {
  const f = fixture();
  f.ports.completed = async () => {
    throw new Error('No browser');
  };
  await exportSavedSession(source, 'Session name', {}, f.ports);
  assert.equal(f.calls.at(-1), 'Arc: Session name was exported but did not open.');
});

test('native export choices bound long multiline names while retaining the exact saved identity', async () => {
  const f = fixture();
  const title = 'Long saved title with an emoji ?? and newline\n'.repeat(100);
  await exportSavedSession(source, title, {}, f.ports);
  assert.ok(f.calls[0].length <= 101);
  assert.match(f.calls[0], /\.\.\. as HTML\?$/);
  assert.ok(!f.calls[0].includes('\n'));
  assert.equal(f.written()?.root.sessionId, source.sessionId);
  assert.equal(f.written()?.root.file, source.file);
  assert.ok(f.calls.some((call) => call.startsWith('open Long saved title')));
});

test('native export progress distinguishes found sessions, scanned sessions and current byte work', async () => {
  const f = fixture();
  f.ports.write = async (_destination, options) => {
    options.progress?.('relationships', 0, { discovered: 1, completed: 0, bytes: 49152 });
    options.progress?.('relationships', 1, { discovered: 3, completed: 1, bytes: 98304 });
    return { index: '/destination/site/index.html' };
  };
  await exportSavedSession(source, 'Session name', {}, f.ports);
  assert.ok(
    f.calls.includes(`Finding linked work (1 session found, 0 scanned, ${(49152).toLocaleString()} bytes read)`),
  );
  assert.ok(
    f.calls.includes(`Finding linked work (3 sessions found, 1 scanned, ${(98304).toLocaleString()} bytes read)`),
  );
});
