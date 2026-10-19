import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { queryWindowsProcesses } from './windowpipe.ts';

export const TERMINAL_OWNERSHIP_CAPABILITY = 'terminalOwnershipV1';
export const TERMINAL_LIMITS = { deadlineMs: 2000, shellDeadlineMs: 1000, ancestry: 32, terminals: 256 } as const;
export type ProcessIdentity = { pid: number; birth: string };
export type ProcessRow = ProcessIdentity & { parent: number };
export type ProcessAncestry = { platform: 'win32' | 'linux' | 'darwin'; chain: ProcessRow[] };
export type TerminalOrigin = { platform: ProcessAncestry['platform']; caller: ProcessIdentity; root: ProcessIdentity };
export type TerminalOwner = { status: 'match'; root: ProcessIdentity } | { status: 'none' | 'unknown' };
export type TerminalShell = { processId: PromiseLike<number | undefined>; exitStatus?: unknown };
export type TerminalSource = {
  terminals: () => readonly TerminalShell[];
  allowed: () => boolean;
};
const run = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const sameProcess = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.pid === right.pid && left.birth === right.birth;

export function validProcessIdentity(value: unknown): value is ProcessIdentity {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'birth,pid' &&
    pid(value.pid) &&
    typeof value.birth === 'string' &&
    /^[0-9]{1,24}$/.test(value.birth) &&
    BigInt(value.birth) > 0n
  );
}

export function validAncestry(value: unknown): value is ProcessAncestry {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'chain,platform' ||
    !['win32', 'linux', 'darwin'].includes(value.platform as string) ||
    !Array.isArray(value.chain) ||
    value.chain.length === 0 ||
    value.chain.length > TERMINAL_LIMITS.ancestry
  )
    return false;
  const seen = new Set<number>();
  return value.chain.every((row, index, rows) => {
    if (
      !object(row) ||
      Object.keys(row).sort().join(',') !== 'birth,parent,pid' ||
      !validProcessIdentity({ pid: row.pid, birth: row.birth }) ||
      !Number.isSafeInteger(row.parent) ||
      (row.parent as number) < 0 ||
      seen.has(row.pid as number)
    )
      return false;
    seen.add(row.pid as number);
    if (index === 0) return true;
    const child = rows[index - 1] as ProcessRow;
    return child.parent === row.pid && BigInt(row.birth as string) <= BigInt(child.birth);
  });
}

export function validTerminalOrigin(value: unknown): value is TerminalOrigin {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'caller,platform,root' &&
    ['win32', 'linux', 'darwin'].includes(value.platform as string) &&
    validProcessIdentity(value.caller) &&
    validProcessIdentity(value.root) &&
    BigInt(value.root.birth) <= BigInt(value.caller.birth)
  );
}

export function parseLinuxProcess(text: string, processId: number): ProcessRow {
  const closing = text.lastIndexOf(')');
  const fields = text
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  const result = { pid: processId, parent: Number(fields[1]), birth: fields[19] };
  if (
    closing < 0 ||
    Number(text.slice(0, text.indexOf(' '))) !== processId ||
    !validAncestry({ platform: 'linux', chain: [result] })
  )
    throw new Error('Process unavailable.');
  return result;
}

export function parseMacProcesses(text: string): Map<number, ProcessRow> {
  const lines = text.trim().split('\n');
  if (lines.length > 4096 || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Process limit exceeded.');
  const rows = new Map<number, ProcessRow>();
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('Process unavailable.');
    const row = { pid: Number(match[1]), parent: Number(match[2]), birth: String(Date.parse(match[3]) / 1000) };
    if (!validAncestry({ platform: 'darwin', chain: [row] }) || rows.has(row.pid))
      throw new Error('Process unavailable.');
    rows.set(row.pid, row);
  }
  return rows;
}

export async function collectWindowsAncestry(
  processId: number,
  signal: AbortSignal,
  query = queryWindowsProcesses,
  execute = run,
): Promise<ProcessRow[]> {
  const chain = (await query('ancestry', [processId], signal)) as ProcessRow[];
  if (!validAncestry({ platform: 'win32', chain }) || chain[0].pid !== processId)
    throw new Error('Process ancestry unavailable.');
  const tail = chain[chain.length - 1];
  const image = await query('image', [tail.pid], signal);
  if (!object(image) || image.pid !== tail.pid || image.birth !== tail.birth || typeof image.image !== 'string')
    throw new Error('Process changed.');
  const shell = Buffer.from(image.image, 'base64').toString('utf8');
  if (!path.win32.isAbsolute(shell) || !/[\\/]usr[\\/]bin[\\/](?:bash|sh)\.exe$/i.test(shell)) return chain;
  const utility = path.win32.join(path.win32.dirname(shell), 'ps.exe');
  const snapshot = async () => {
    const { stdout } = await execute(utility, ['-e'], {
      windowsHide: true,
      timeout: TERMINAL_LIMITS.deadlineMs,
      maxBuffer: 1024 * 1024,
      signal,
      env: { ...process.env, LC_ALL: 'C' },
    });
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length > 4097 || !/^\s*PID\s+PPID\s+PGID\s+WINPID\s/.test(lines.shift() ?? ''))
      throw new Error('Process unavailable.');
    const logical = new Map<number, { parent: number; native: number }>();
    const native = new Set<number>();
    for (const line of lines) {
      const fields = /^(?:[IOS] )?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line);
      if (!fields) throw new Error('Process unavailable.');
      const id = Number(fields[1]),
        parent = Number(fields[2]),
        winpid = Number(fields[3]);
      if (!pid(id) || !Number.isSafeInteger(parent) || !pid(winpid) || logical.has(id) || native.has(winpid))
        throw new Error('Process unavailable.');
      logical.set(id, { parent, native: winpid });
      native.add(winpid);
    }
    const edges = new Map<number, number>();
    for (const row of logical.values()) {
      const parent = logical.get(row.parent);
      if (parent) edges.set(row.native, parent.native);
    }
    return edges;
  };
  const edges = await snapshot();
  const corrections = new Map<number, number>();
  while (chain.length < TERMINAL_LIMITS.ancestry) {
    const index = chain.findIndex((row) => edges.has(row.pid) && edges.get(row.pid) !== row.parent);
    if (index < 0) break;
    const child = chain[index],
      parent = edges.get(child.pid)!;
    chain.splice(index + 1);
    const segment = (await query('ancestry', [parent], signal)) as ProcessRow[];
    if (
      !validAncestry({ platform: 'win32', chain: segment }) ||
      segment[0].pid !== parent ||
      BigInt(segment[0].birth) > BigInt(child.birth) ||
      segment.some((row) => chain.some((one) => one.pid === row.pid))
    )
      throw new Error('Process changed.');
    corrections.set(child.pid, parent);
    child.parent = parent;
    chain.push(...segment.slice(0, TERMINAL_LIMITS.ancestry - chain.length));
  }
  if (corrections.size) {
    const repeated = await snapshot();
    for (const [child, parent] of corrections) if (repeated.get(child) !== parent) throw new Error('Process changed.');
    const fresh = await query(
      'identities',
      chain.map((row) => row.pid),
      signal,
    );
    if (
      !Array.isArray(fresh) ||
      fresh.length !== chain.length ||
      fresh.some((row, index) => !validProcessIdentity(row) || !sameProcess(row, chain[index]))
    )
      throw new Error('Process changed.');
  }
  return chain;
}

// Every read that the deadline or the caller's signal stops fails with this message.
export const PROCESS_COLLECTION_EXPIRED = 'Process collection expired.';

export async function collectProcessAncestry(processId = process.pid, signal?: AbortSignal): Promise<ProcessAncestry> {
  if (!pid(processId)) throw new Error('Process unavailable.');
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  const timer = setTimeout(cancel, TERMINAL_LIMITS.deadlineMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const check = () => {
    if (cancellation.signal.aborted) throw new Error(PROCESS_COLLECTION_EXPIRED);
  };
  try {
    check();
    const platform = process.platform;
    let chain: ProcessRow[];
    if (platform === 'win32') {
      chain = await collectWindowsAncestry(processId, cancellation.signal);
    } else if (platform === 'linux' || platform === 'darwin') {
      const snapshot = async () =>
        parseMacProcesses(
          (
            await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
              env: { ...process.env, LC_ALL: 'C' },
              timeout: TERMINAL_LIMITS.deadlineMs,
              maxBuffer: 1024 * 1024,
              signal: cancellation.signal,
            })
          ).stdout,
        );
      const rows = platform === 'darwin' ? await snapshot() : null;
      const read = async (id: number) =>
        rows
          ? rows.get(id)
          : parseLinuxProcess(
              await fs.readFile(`/proc/${id}/stat`, { encoding: 'utf8', signal: cancellation.signal }),
              id,
            );
      chain = [];
      let current = processId;
      while (current > 0 && chain.length < TERMINAL_LIMITS.ancestry) {
        check();
        let row: ProcessRow | undefined;
        try {
          row = await read(current);
        } catch (error) {
          if (!chain.length) throw error;
          break;
        }
        if (!row) break;
        if (chain.some((one) => one.pid === row.pid)) throw new Error('Process ancestry contains a cycle.');
        if (chain.length && BigInt(row.birth) > BigInt(chain[chain.length - 1].birth)) break;
        chain.push(row);
        current = row.parent;
      }
      const repeated = platform === 'darwin' ? await snapshot() : null;
      for (const row of chain) {
        const fresh = repeated ? repeated.get(row.pid) : await read(row.pid);
        if (!fresh || !sameProcess(row, fresh) || row.parent !== fresh.parent) throw new Error('Process changed.');
      }
    } else throw new Error('Process platform unavailable.');
    check();
    const result = { platform, chain };
    if (!validAncestry(result) || result.chain[0].pid !== processId) throw new Error('Process ancestry unavailable.');
    return result;
  } catch (error) {
    if (cancellation.signal.aborted) throw new Error(PROCESS_COLLECTION_EXPIRED, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function terminalOwner(ancestry: ProcessAncestry, source: TerminalSource): Promise<TerminalOwner> {
  if (!source.allowed() || ancestry.platform !== process.platform || !validAncestry(ancestry))
    return { status: 'unknown' };
  const terminals = [...source.terminals()];
  if (terminals.length > TERMINAL_LIMITS.terminals) return { status: 'unknown' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const roots = await Promise.race([
      Promise.all(
        terminals.map(async (terminal) => (terminal.exitStatus === undefined ? await terminal.processId : undefined)),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TERMINAL_LIMITS.shellDeadlineMs);
      }),
    ]);
    if (!roots || !source.allowed()) return { status: 'unknown' };
    const current = source.terminals();
    if (current.length !== terminals.length || current.some((terminal) => !terminals.includes(terminal)))
      return { status: 'unknown' };
    const matches = new Map<number, ProcessIdentity>();
    for (let index = 0; index < terminals.length; index++) {
      if (terminals[index].exitStatus !== undefined || !pid(roots[index])) continue;
      const row = ancestry.chain.find((row) => row.pid === roots[index]);
      if (row) matches.set(row.pid, { pid: row.pid, birth: row.birth });
    }
    if (matches.size > 1) return { status: 'unknown' };
    return matches.size ? { status: 'match', root: [...matches.values()][0] } : { status: 'none' };
  } catch {
    return { status: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

export async function readProcessIdentities(pids: number[], signal?: AbortSignal): Promise<ProcessIdentity[]> {
  if (signal?.aborted || pids.some((id) => !pid(id))) throw new Error('Process details unavailable.');
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  const timer = setTimeout(cancel, TERMINAL_LIMITS.deadlineMs);
  signal?.addEventListener('abort', cancel, { once: true });
  const parentSignal = signal;
  signal = cancellation.signal;
  try {
    let result: unknown;
    if (process.platform === 'win32') result = await queryWindowsProcesses('identities', pids, signal);
    else if (process.platform === 'linux')
      result = await Promise.all(
        pids.map(async (id) => {
          const row = parseLinuxProcess(await fs.readFile(`/proc/${id}/stat`, { encoding: 'utf8', signal }), id);
          return { pid: row.pid, birth: row.birth };
        }),
      );
    else if (process.platform === 'darwin') {
      const output = await run('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,lstart='], {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: TERMINAL_LIMITS.deadlineMs,
        maxBuffer: 65536,
        signal,
      });
      const rows = parseMacProcesses(output.stdout);
      result = pids.map((id) => {
        const row = rows.get(id);
        return row && { pid: row.pid, birth: row.birth };
      });
    }
    if (
      !Array.isArray(result) ||
      result.length !== pids.length ||
      result.some((row, index) => !validProcessIdentity(row) || row.pid !== pids[index])
    )
      throw new Error('Process details unavailable.');
    if (signal.aborted) throw new Error('Process details unavailable.');
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', cancel);
  }
}

export function terminalOwnership(source: TerminalSource, identify = readProcessIdentities) {
  return {
    inquire: (ancestry: ProcessAncestry) => terminalOwner(ancestry, source),
    admit: async (origin: TerminalOrigin, signal?: AbortSignal): Promise<boolean> => {
      if (!source.allowed() || origin.platform !== process.platform || !validTerminalOrigin(origin)) return false;
      try {
        const identities = await identify([origin.caller.pid, origin.root.pid], signal);
        if (!source.allowed() || !sameProcess(identities[0], origin.caller) || !sameProcess(identities[1], origin.root))
          return false;
        const owner = await terminalOwner(
          { platform: origin.platform, chain: [{ ...origin.root, parent: 0 }] },
          source,
        );
        return source.allowed() && owner.status === 'match' && sameProcess(owner.root, origin.root);
      } catch {
        return false;
      }
    },
  };
}

export function integratedTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === 'vscode' || !!env.VSCODE_IPC_HOOK_CLI || !!env.VSCODE_PID;
}

export function localTerminalPlacement(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    !env.WSL_DISTRO_NAME &&
    !env.SSH_CONNECTION &&
    !env.SSH_CLIENT &&
    !env.REMOTE_CONTAINERS &&
    !env.VSCODE_REMOTE_CONTAINERS_SESSION
  );
}

export function validTerminalOwner(value: unknown): value is TerminalOwner {
  return (
    object(value) &&
    (value.status === 'match'
      ? Object.keys(value).sort().join(',') === 'root,status' && validProcessIdentity(value.root)
      : (value.status === 'none' || value.status === 'unknown') && Object.keys(value).join(',') === 'status')
  );
}
