import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  collectProcessAncestry,
  collectWindowsAncestry,
  parseLinuxProcess,
  parseMacProcesses,
  terminalOwner,
  terminalOwnership,
  validAncestry,
  validTerminalOrigin,
  type ProcessAncestry,
  type TerminalShell,
} from './terminalownership.ts';

afterEach(() => vi.useRealTimers());
const ancestry = (): ProcessAncestry => ({
  platform: process.platform as ProcessAncestry['platform'],
  chain: [
    { pid: 30, parent: 20, birth: '300' },
    { pid: 20, parent: 10, birth: '200' },
    { pid: 10, parent: 99, birth: '100' },
  ],
});
const shell = (value: number | undefined): TerminalShell => ({ processId: Promise.resolve(value) });

test('current terminal membership selects the complete observed segment despite a missing older ancestor', async () => {
  const source = { allowed: () => true, terminals: () => [shell(20)] };
  const terminal = shell(20);
  source.terminals = () => [terminal];
  assert.deepEqual(await terminalOwner(ancestry(), source), { status: 'match', root: { pid: 20, birth: '200' } });
  assert.deepEqual(await terminalOwner(ancestry(), { ...source, terminals: () => [] }), { status: 'none' });
});

test('shell-less and exited terminals do not prevent another current terminal match', async () => {
  const terminals = [shell(undefined), shell(-1), shell(0), { ...shell(10), exitStatus: { code: 0 } }, shell(20)];
  assert.equal((await terminalOwner(ancestry(), { allowed: () => true, terminals: () => terminals })).status, 'match');
});

test('all unresolved terminal PIDs share one deadline', async () => {
  vi.useFakeTimers();
  const terminals = Array.from({ length: 4 }, () => ({ processId: new Promise<number>(() => {}) }));
  const pending = terminalOwner(ancestry(), { allowed: () => true, terminals: () => terminals });
  await vi.advanceTimersByTimeAsync(1000);
  assert.deepEqual(await pending, { status: 'unknown' });
});

test('transfer, trust, duplicate roots, limits and platform disagreement refuse uncertain membership', async () => {
  const terminal = shell(20);
  let snapshots = 0;
  assert.equal(
    (await terminalOwner(ancestry(), { allowed: () => true, terminals: () => (++snapshots === 1 ? [terminal] : []) }))
      .status,
    'unknown',
  );
  for (const source of [
    { allowed: () => false, terminals: () => [terminal] },
    { allowed: () => true, terminals: () => Array.from({ length: 257 }, () => terminal) },
    (() => {
      const terminals = [shell(20), shell(10)];
      return { allowed: () => true, terminals: () => terminals };
    })(),
  ])
    assert.equal((await terminalOwner(ancestry(), source)).status, 'unknown');
  assert.equal(
    (
      await terminalOwner(
        { ...ancestry(), platform: process.platform === 'win32' ? 'linux' : 'win32' },
        { allowed: () => true, terminals: () => [] },
      )
    ).status,
    'unknown',
  );
});

test('final admission observes caller birth, root birth and current membership independently', async () => {
  let terminals = [shell(20)];
  let observed = ancestry();
  const ownership = terminalOwnership({ allowed: () => true, terminals: () => terminals }, async (pids) =>
    pids.map((pid) => {
      const row = observed.chain.find((row) => row.pid === pid)!;
      return { pid: row.pid, birth: row.birth };
    }),
  );
  const origin = { platform: ancestry().platform, caller: { pid: 30, birth: '300' }, root: { pid: 20, birth: '200' } };
  assert.equal(await ownership.admit(origin), true);
  observed = ancestry();
  observed.chain[0].birth = '301';
  assert.equal(await ownership.admit(origin), false);
  observed = ancestry();
  observed.chain[1].birth = '201';
  assert.equal(await ownership.admit(origin), false);
  observed = ancestry();
  terminals = [];
  assert.equal(await ownership.admit(origin), false);
});

test('wire identities reject unknown fields, missing edges, cycles and younger parents', () => {
  assert.equal(validAncestry(ancestry()), true);
  for (const mutate of [
    (value: ProcessAncestry) => {
      value.chain[1].pid = 25;
    },
    (value: ProcessAncestry) => {
      value.chain[1].birth = '400';
    },
    (value: ProcessAncestry) => {
      value.chain[1].pid = 30;
    },
    (value: ProcessAncestry) => {
      value.chain[0].birth = '0';
    },
    (value: ProcessAncestry) => {
      value.chain = Array(33).fill(value.chain[0]);
    },
  ]) {
    const value = ancestry();
    mutate(value);
    assert.equal(validAncestry(value), false);
  }
  const origin = { platform: 'win32', caller: { pid: 11, birth: '123' }, root: { pid: 10, birth: '120' } };
  assert.equal(validTerminalOrigin(origin), true);
  assert.equal(validTerminalOrigin({ ...origin, extra: true }), false);
  assert.equal(validTerminalOrigin({ ...origin, caller: { ...origin.caller, extra: true } }), false);
});

test('Linux and macOS parse independent native process fixtures with malformed and row-limit refusal', () => {
  const fields = ['S', '54', ...Array(17).fill('0'), '90743'];
  assert.deepEqual(parseLinuxProcess(`81 (a command (with) spaces) ${fields.join(' ')}`, 81), {
    pid: 81,
    parent: 54,
    birth: '90743',
  });
  const mac = parseMacProcesses(' 73 14 Sat Oct 17 19:30:01 2026\n 14 1 Fri Oct 16 11:00:00 2026\n');
  assert.equal(mac.get(73)?.parent, 14);
  assert.ok(BigInt(mac.get(73)!.birth) > BigInt(mac.get(14)!.birth));
  assert.throws(() => parseMacProcesses('not a process'));
  assert.throws(() => parseMacProcesses(Array(4097).fill('1 0 Sat Oct 17 19:30:01 2026').join('\n')));
  assert.throws(() => parseLinuxProcess('81 (missing) S 0', 81));
});

test('cancelled collection refuses before starting a helper', async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(collectProcessAncestry(process.pid, aborted.signal), /Process collection expired/);
});

test('MSYS logical parents route a missing native hop to one current terminal and preserve admission', async () => {
  vi.stubEnv('MSYSTEM', undefined);
  try {
    const rows = [
      { pid: 30, parent: 20, birth: '300' },
      { pid: 20, parent: 99, birth: '200' },
    ];
    const root = [
      { pid: 10, parent: 5, birth: '100' },
      { pid: 5, parent: 0, birth: '50' },
    ];
    const text =
      ' PID PPID PGID WINPID TTY UID STIME COMMAND\n 3 2 3 20 cons1 1 00:00 /usr/bin/sh\n 2 1 2 10 cons1 1 00:00 /usr/bin/bash\n';
    const query = vi.fn<(operation: string, ids: number[]) => Promise<unknown>>(async (operation, ids) => {
      if (operation === 'image') return { ...rows[1], image: Buffer.from('D:/Git/usr/bin/sh.exe').toString('base64') };
      if (operation === 'identities')
        return ids.map((id) => {
          const row = [...rows, ...root].find((row) => row.pid === id)!;
          return { pid: row.pid, birth: row.birth };
        });
      return structuredClone(ids[0] === 30 ? rows : root);
    });
    const execute = vi.fn<() => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: text,
      stderr: '',
    }));
    const chain = await collectWindowsAncestry(30, new AbortController().signal, query, execute as never);
    assert.deepEqual(
      chain.map((row) => row.pid),
      [30, 20, 10, 5],
    );
    const first = [shell(5)],
      second = [shell(40)];
    const owners = [first, second].map((terminals) =>
      terminalOwnership({ allowed: () => true, terminals: () => terminals }, async (ids) =>
        ids.map((id) => {
          const row = chain.find((row) => row.pid === id)!;
          return { pid: id, birth: row.birth };
        }),
      ),
    );
    const observed = { platform: ancestry().platform, chain };
    const matches = await Promise.all(owners.map((owner) => owner.inquire(observed)));
    assert.deepEqual(matches, [{ status: 'match', root: { pid: 5, birth: '50' } }, { status: 'none' }]);
    assert.equal(
      await owners[0].admit({
        platform: observed.platform,
        caller: { pid: 30, birth: '300' },
        root: { pid: 5, birth: '50' },
      }),
      true,
    );
    assert.equal(execute.mock.calls.length, 2);
    // MSYS ps prefixes a row with a state flag (I, O or S) when the process waits on its terminal or is stopped.
    for (const flag of ['I', 'O', 'S']) {
      execute.mockImplementationOnce(async () => ({
        stdout: `${text}${flag} 4 1 4 50 cons1 1 00:00 /usr/bin/less\n`,
        stderr: '',
      }));
      const flagged = await collectWindowsAncestry(30, new AbortController().signal, query, execute as never);
      assert.deepEqual(
        flagged.map((row) => row.pid),
        [30, 20, 10, 5],
      );
    }
    execute.mockImplementation(async () => ({ stdout: text.replace('3 2 3 20', '3 2 3 30'), stderr: '' }));
    const executed = await collectWindowsAncestry(30, new AbortController().signal, query, execute as never);
    assert.deepEqual(
      executed.map((row) => row.pid),
      [30, 10, 5],
    );

    // ps never prints these first columns, so a row that starts with one is not process output.
    const unprinted = ['-7 1 7 60', 'x7 1 7 60', 'I7 1 7 60'].map(
      (row) => `${text}${row} cons1 1 00:00 /usr/bin/less\n`,
    );
    for (const invalid of [
      text + ' 2 1 2 40 cons1 1 00:00 /usr/bin/bash\n',
      text.replace('2 1 2 10', '2 1 2 20'),
      ...unprinted,
    ]) {
      execute.mockImplementation(async () => ({ stdout: invalid, stderr: '' }));
      await assert.rejects(collectWindowsAncestry(30, new AbortController().signal, query, execute as never));
    }
    execute
      .mockImplementationOnce(async () => ({ stdout: text, stderr: '' }))
      .mockImplementationOnce(async () => ({ stdout: text.replace('3 2 3 20', '3 1 3 20'), stderr: '' }));
    await assert.rejects(collectWindowsAncestry(30, new AbortController().signal, query, execute as never));
  } finally {
    vi.unstubAllEnvs();
  }
});
