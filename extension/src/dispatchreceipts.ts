import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileAtomically } from './atomicfile';
import { arcHome } from './store';
import { payloadSha256, type RequesterIdentity } from './sessionwrites';
import type { LaunchPolicy } from './launchpolicy';
import { canonicalToolPath } from './toolownership';

export const DISPATCH_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const DISPATCH_TEXT_LIMIT = 16_000;
const JSON_BYTES = 48 * 1024;
const REPORT_BYTES = 8 * 1024 * 1024;
const OWNER = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOKEN = /^[a-f0-9]{64}$/;
type FileIdentity = { dev: string; ino: string };
export type DispatchOutcome = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'needs-input' | 'unknown';
export interface DispatchLaunch {
  launchId: string;
  origin: string;
  transport: 'hosted';
  requester: RequesterIdentity | null;
  policy: LaunchPolicy | null;
  promptSha256: string;
  completion: 'manual' | 'wait';
  alias: string | null;
  aliasParent?: FileIdentity;
}
export interface DispatchEvent {
  launchId: string;
  eventId: string;
  assignment: 1;
  outcome: DispatchOutcome;
  availability: 'pending' | 'available' | 'unavailable';
  nativeEnding: unknown;
  askId: string | null;
  report: { path: string; sha256: string; bytes: number } | null;
}
interface Anchor {
  launchId: string;
  directory: FileIdentity;
  receipt: FileIdentity;
  sha256: string;
}
interface EventState {
  owner?: string;
  token?: string;
  disposition?: string;
  dispositionSha256?: string;
}

function identity(file: string): FileIdentity {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error('The dispatch path is redirected.');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function equalIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export function safeDispatchPath(file: string, platform = process.platform): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let current = paths.resolve(file);
  while (true) {
    if ([os.homedir(), os.tmpdir()].some((base) => current === paths.resolve(base))) break;
    if (platform === 'darwin' && current === '/tmp' && fs.realpathSync.native(current) === '/private/tmp') break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('The dispatch path is redirected.');
    const parent = paths.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
const safePath = safeDispatchPath;
export function outsideDispatchStorage(root: string, file: string, platform = process.platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(root, file);
  return (
    paths.isAbsolute(file) && (paths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${paths.sep}`))
  );
}
function read(file: string, limit = JSON_BYTES): string {
  safePath(file);
  const before = identity(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.size > BigInt(limit) ||
      !equalIdentity(before, { dev: String(stat.dev), ino: String(stat.ino) })
    )
      throw new Error('The dispatch file is unavailable or replaced.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error('The dispatch file exceeds its read allowance.');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    if (!equalIdentity(before, identity(file)) || Buffer.byteLength(text) > limit)
      throw new Error('The dispatch file changed during the read.');
    return text;
  } finally {
    fs.closeSync(fd);
  }
}
function exclusive(file: string, text: string): void {
  safePath(path.dirname(file));
  fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function validId(id: string): void {
  if (!DISPATCH_ID.test(id)) throw new Error('The dispatch identity is invalid.');
}

// Native records supply response and usage evidence. These files retain launch and consumption identity only.
export class DispatchReceipts {
  readonly root: string;
  constructor(home = arcHome()) {
    this.root = path.join(path.resolve(home), 'dispatch');
  }
  reserve(input: Omit<DispatchLaunch, 'launchId' | 'transport'>): DispatchLaunch {
    if (
      !/^[a-f0-9]{24}$/.test(input.origin) ||
      !TOKEN.test(input.promptSha256) ||
      (input.requester &&
        (!DISPATCH_ID.test(input.requester.id) || !['claude', 'codex'].includes(input.requester.provider)))
    )
      throw new Error('The dispatch origin or requester is invalid.');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    safePath(this.root);
    if (input.alias) {
      if (
        !path.isAbsolute(input.alias) ||
        !outsideDispatchStorage(canonicalToolPath(this.root), canonicalToolPath(input.alias))
      )
        throw new Error('A report alias must stay outside private dispatch storage.');
      safePath(path.dirname(input.alias));
      for (let parent = fs.realpathSync.native(path.dirname(input.alias)); ; parent = path.dirname(parent)) {
        if (equalIdentity(identity(parent), identity(this.root)))
          throw new Error('A report alias must stay outside private dispatch storage.');
        if (parent === path.dirname(parent)) break;
      }
      if (fs.existsSync(input.alias)) {
        safePath(input.alias);
        if (!fs.lstatSync(input.alias).isFile()) throw new Error('A report alias must name a regular file.');
      }
    }
    const launchId = randomUUID();
    const directory = path.join(this.root, launchId);
    fs.mkdirSync(directory, { mode: 0o700 });
    const launch: DispatchLaunch = {
      ...input,
      ...(input.alias ? { aliasParent: identity(fs.realpathSync.native(path.dirname(input.alias))) } : {}),
      launchId,
      transport: 'hosted',
    };
    const receipt = JSON.stringify(launch);
    exclusive(path.join(directory, 'receipt.json'), receipt);
    const anchor: Anchor = {
      launchId,
      directory: identity(directory),
      receipt: identity(path.join(directory, 'receipt.json')),
      sha256: payloadSha256(receipt),
    };
    exclusive(path.join(this.root, `${launchId}.json`), JSON.stringify(anchor));
    exclusive(path.join(directory, 'state.json'), JSON.stringify({ launchId, events: [] }));
    return launch;
  }
  launch(id: string): DispatchLaunch {
    validId(id);
    const anchor = JSON.parse(read(path.join(this.root, `${id}.json`))) as Anchor;
    const directory = path.join(this.root, id);
    const file = path.join(directory, 'receipt.json');
    const text = read(file);
    if (
      anchor.launchId !== id ||
      !equalIdentity(anchor.directory, identity(directory)) ||
      !equalIdentity(anchor.receipt, identity(file)) ||
      payloadSha256(text) !== anchor.sha256
    )
      throw new Error('The authoritative dispatch receipt was replaced.');
    const launch = JSON.parse(text) as DispatchLaunch;
    if (launch.launchId !== id || launch.transport !== 'hosted' || !/^[a-f0-9]{24}$/.test(launch.origin))
      throw new Error('The dispatch receipt identity is invalid.');
    return launch;
  }
  bind(
    id: string,
    binding: { provider: 'claude' | 'codex'; sessionId: string; submissionId: number; nativeTurnId: string | null },
  ): void {
    this.launch(id);
    if (
      !DISPATCH_ID.test(binding.sessionId) ||
      !Number.isSafeInteger(binding.submissionId) ||
      binding.submissionId < 1 ||
      (binding.nativeTurnId !== null &&
        !(binding.provider === 'codex'
          ? typeof binding.nativeTurnId === 'string' &&
            binding.nativeTurnId.length > 0 &&
            binding.nativeTurnId.length <= 4096 &&
            !/[\u0000-\u001f]/.test(binding.nativeTurnId)
          : /^[1-9][0-9]*$/.test(binding.nativeTurnId)))
    )
      throw new Error('The dispatch worker identity is invalid.');
    const file = this.file(id, 'accepted.json');
    const text = JSON.stringify({ launchId: id, ...binding });
    const witnessFile = path.join(this.root, `${id}.accepted.json`);
    const checkWitness = () => {
      if (!fs.existsSync(witnessFile)) return false;
      const witness = JSON.parse(read(witnessFile));
      if (
        witness.launchId !== id ||
        read(file) !== text ||
        witness.sha256 !== payloadSha256(text) ||
        !equalIdentity(witness.identity, identity(file))
      )
        throw new Error('The accepted dispatch turn cannot change.');
      return true;
    };
    if (checkWitness()) return;
    this.lock(id, () => {
      if (checkWitness()) return;
      const intentFile = path.join(this.root, `${id}.accepting.json`);
      if (!fs.existsSync(intentFile)) {
        if (fs.existsSync(file)) throw new Error('The accepted dispatch turn has no retained identity.');
        const name = `accepted.${randomUUID()}.pending`;
        const prepared = this.file(id, name);
        exclusive(prepared, text);
        exclusive(
          intentFile,
          JSON.stringify({ launchId: id, name, identity: identity(prepared), sha256: payloadSha256(text) }),
        );
      }
      const intent = JSON.parse(read(intentFile));
      if (
        intent.launchId !== id ||
        !/^accepted\.[a-f0-9-]{36}\.pending$/.test(intent.name) ||
        intent.sha256 !== payloadSha256(text)
      )
        throw new Error('The accepted dispatch turn cannot change.');
      const prepared = this.file(id, intent.name);
      if (!fs.existsSync(file)) {
        if (read(prepared) !== text || !equalIdentity(intent.identity, identity(prepared)))
          throw new Error('The accepted dispatch turn was replaced.');
        fs.linkSync(prepared, file);
      }
      if (read(file) !== text || !equalIdentity(intent.identity, identity(file)))
        throw new Error('The accepted dispatch turn was replaced.');
      exclusive(witnessFile, JSON.stringify({ launchId: id, identity: intent.identity, sha256: intent.sha256 }));
      if (fs.existsSync(prepared)) fs.unlinkSync(prepared);
    });
  }
  publish(
    id: string,
    input: Omit<DispatchEvent, 'launchId' | 'eventId' | 'assignment' | 'report'>,
    text: string | null,
  ): DispatchEvent {
    const launch = this.launch(id);
    if (text !== null && input.availability !== 'available')
      throw new Error('The dispatch response exceeds its saved report allowance.');
    if (text !== null && Buffer.byteLength(text) > REPORT_BYTES) {
      text = null;
      input = { ...input, availability: 'unavailable' };
    }
    return this.lock(id, () => {
      const state = this.state(id);
      if (state.events.length >= 256) {
        const archive = this.file(id, `state.${state.segment ?? 0}.json`);
        const serializedState = JSON.stringify(state);
        if (fs.existsSync(archive)) {
          if (read(archive, 4 * JSON_BYTES) !== serializedState)
            throw new Error('The retained dispatch events conflict.');
        } else exclusive(archive, serializedState);
        state.segment = (state.segment ?? 0) + 1;
        state.events = [];
      }
      const eventId = randomUUID();
      const reportFile = this.file(id, `${eventId}.md`);
      const report =
        text === null ? null : { path: reportFile, sha256: payloadSha256(text), bytes: Buffer.byteLength(text) };
      if (text !== null) exclusive(reportFile, text);
      const event: DispatchEvent = { ...input, launchId: id, eventId, assignment: 1, report };
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized) > JSON_BYTES - 20 * 1024)
        throw new Error('The dispatch event exceeds its allowance.');
      exclusive(this.file(id, `${eventId}.json`), serialized);
      const held = {
        id: eventId,
        sha256: payloadSha256(serialized),
        identity: identity(this.file(id, `${eventId}.json`)),
        reportIdentity: report ? identity(reportFile) : null,
      };
      state.events.push(held);
      exclusive(this.file(id, `${eventId}.anchor.json`), JSON.stringify(held));
      this.save(id, state);
      if (text !== null) {
        try {
          const source = this.file(id, 'current.md');
          if (fs.existsSync(source)) {
            const witness = JSON.parse(read(this.file(id, 'source.json')));
            if (!equalIdentity(witness, identity(source))) throw new Error('The dispatch report source was replaced.');
          }
          writeFileAtomically(source, text, undefined, 0o600, false);
          this.saveSource(id, identity(source));
        } catch {
          /* The immutable event remains available. */
        }
      }
      if (launch.alias && text !== null) {
        // An alias never supplies authoritative report bytes.
        try {
          safePath(path.dirname(launch.alias));
          if (
            !launch.aliasParent ||
            !equalIdentity(launch.aliasParent, identity(fs.realpathSync.native(path.dirname(launch.alias))))
          )
            throw new Error('The report alias folder was replaced.');
          if (fs.existsSync(launch.alias)) safePath(launch.alias);
          writeFileAtomically(launch.alias, text, undefined, 0o600, false);
        } catch {
          /* The private report remains readable. */
        }
      }
      return event;
    });
  }
  event(id: string, eventId: string): DispatchEvent {
    this.launch(id);
    validId(eventId);
    const anchor = this.file(id, `${eventId}.anchor.json`);
    const held = fs.existsSync(anchor)
      ? JSON.parse(read(anchor))
      : this.state(id).events.find((one) => one.id === eventId);
    const file = this.file(id, `${eventId}.json`);
    if (!held) throw new Error('The dispatch event is unknown.');
    const text = read(file);
    const event = JSON.parse(text) as DispatchEvent;
    if (
      event.launchId !== id ||
      event.eventId !== eventId ||
      payloadSha256(text) !== held.sha256 ||
      !equalIdentity(held.identity, identity(file))
    )
      throw new Error('The authoritative dispatch event was replaced.');
    if (event.report) {
      const expected = this.file(id, `${eventId}.md`);
      if (
        event.report.path !== expected ||
        !held.reportIdentity ||
        !equalIdentity(held.reportIdentity, identity(expected))
      )
        throw new Error('The authoritative dispatch report was replaced.');
    }
    return event;
  }
  result(id: string, eventId: string): unknown {
    const event = this.event(id, eventId);
    const text = event.report ? read(event.report.path, REPORT_BYTES) : null;
    if (
      text !== null &&
      (payloadSha256(text) !== event.report!.sha256 || Buffer.byteLength(text) !== event.report!.bytes)
    )
      throw new Error('The frozen dispatch report changed.');
    const consumption = this.consumption(id, eventId);
    delete consumption.token;
    const reply = { ...event, consumption, text: text !== null && text.length <= DISPATCH_TEXT_LIMIT ? text : null };
    if (Buffer.byteLength(JSON.stringify(reply)) > JSON_BYTES) reply.text = null;
    return reply;
  }
  status(
    id: string,
    cursor?: string,
    limit = 32,
  ): {
    launch: DispatchLaunch;
    version: 1;
    next: string | null;
    reportSource: string | null;
    events: (Omit<DispatchEvent, 'nativeEnding'> & {
      consumption: Omit<EventState, 'disposition' | 'token'>;
      delivery: 'unavailable';
    })[];
  } {
    const launch = this.launch(id);
    const current = this.state(id);
    const start = cursor === undefined ? 0 : Number(cursor.slice(id.length + 1));
    const total = (current.segment ?? 0) * 256 + current.events.length;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 128 ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > total ||
      (cursor !== undefined && cursor !== `${id}:${start}`)
    )
      throw new Error('The dispatch page is invalid.');
    const result: ReturnType<DispatchReceipts['status']> = {
      version: 1,
      launch,
      next: null,
      reportSource: fs.existsSync(this.file(id, 'current.md')) ? this.file(id, 'current.md') : null,
      events: [],
    };
    let index = start;
    for (; index < total && result.events.length < limit; index++) {
      const segment = Math.floor(index / 256);
      const state = segment === (current.segment ?? 0) ? current : this.state(id, segment);
      const event = this.event(id, state.events[index % 256].id);
      const { token: _token, disposition: _disposition, ...consumption } = this.consumption(id, event.eventId);
      const { nativeEnding: _ending, ...listed } = event;
      result.events.push({ ...listed, consumption, delivery: 'unavailable' });
      result.next = index + 1 < total ? `${id}:${index + 1}` : null;
      if (Buffer.byteLength(JSON.stringify(result)) > JSON_BYTES - 4096) {
        result.events.pop();
        break;
      }
    }
    result.next = index < total ? `${id}:${index}` : null;
    return result;
  }
  latest(id: string): DispatchEvent | null {
    this.launch(id);
    const one = this.state(id).events.at(-1);
    return one ? this.event(id, one.id) : null;
  }
  claim(id: string, eventId: string, origin: string, owner: string): unknown {
    if (this.launch(id).origin !== origin || !OWNER.test(owner))
      throw new Error('The dispatch claim origin or owner is invalid.');
    return this.lock(id, () => {
      const event = this.event(id, eventId);
      const state = this.consumption(id, eventId);
      if (state.owner && state.owner !== owner) throw new Error('Another owner holds this dispatch event.');
      const status = state.disposition !== undefined ? 'consumed' : state.owner ? 'already-claimed' : 'claimed';
      if (!state.owner) {
        state.owner = owner;
        state.token = randomBytes(32).toString('hex');
        this.saveConsumption(id, eventId, state);
      }
      return { launchId: id, eventId, status, ...state, reportSha256: event.report?.sha256 ?? null };
    });
  }
  ack(id: string, eventId: string, origin: string, owner: string, token: string, disposition: string): unknown {
    if (
      this.launch(id).origin !== origin ||
      !OWNER.test(owner) ||
      !TOKEN.test(token) ||
      Buffer.byteLength(disposition) > 16 * 1024 ||
      Buffer.byteLength(JSON.stringify({ disposition })) > JSON_BYTES - 4096
    )
      throw new Error('The dispatch acknowledgment is invalid.');
    return this.lock(id, () => {
      const event = this.event(id, eventId);
      if (
        Buffer.byteLength(
          JSON.stringify({
            ...event,
            consumption: { disposition, owner, dispositionSha256: payloadSha256(disposition) },
            text: null,
          }),
        ) > JSON_BYTES
      )
        throw new Error('The dispatch acknowledgment exceeds its JSON allowance.');
      const state = this.consumption(id, eventId);
      const digest = payloadSha256(disposition);
      if (state.owner !== owner || state.token !== token)
        throw new Error('The dispatch claim token does not match this event.');
      if (state.dispositionSha256 && state.dispositionSha256 !== digest)
        throw new Error('This dispatch event has a different saved disposition.');
      const file = this.file(id, `${eventId}.disposition.md`);
      if (fs.existsSync(file)) {
        if (read(file, 16 * 1024) !== disposition) throw new Error('The saved dispatch disposition conflicts.');
      } else exclusive(file, disposition);
      state.disposition = disposition;
      state.dispositionSha256 = digest;
      this.saveConsumption(id, eventId, state);
      return { launchId: id, eventId, status: 'consumed', disposition };
    });
  }
  refresh(id: string): DispatchEvent | null {
    const last = this.latest(id);
    if (!last?.report) return null;
    const source = this.file(id, 'current.md');
    const witness = JSON.parse(read(this.file(id, 'source.json')));
    if (!equalIdentity(witness, identity(source))) throw new Error('The dispatch report source was replaced.');
    const text = read(source, REPORT_BYTES);
    if (payloadSha256(text) === last.report.sha256) return null;
    return this.publish(
      id,
      { outcome: last.outcome, availability: 'available', nativeEnding: last.nativeEnding, askId: null },
      text,
    );
  }
  private file(id: string, name: string): string {
    return path.join(this.root, id, name);
  }
  private saveSource(id: string, witness: FileIdentity): void {
    writeFileAtomically(this.file(id, 'source.json'), JSON.stringify(witness), undefined, 0o600, false);
  }
  private state(
    id: string,
    segment?: number,
  ): {
    launchId: string;
    segment?: number;
    events: { id: string; sha256: string; identity: FileIdentity; reportIdentity: FileIdentity | null }[];
  } {
    const state = JSON.parse(
      read(this.file(id, segment === undefined ? 'state.json' : `state.${segment}.json`), 4 * JSON_BYTES),
    );
    if (state.launchId !== id || !Array.isArray(state.events) || state.events.length > 256)
      throw new Error('The dispatch state is invalid.');
    return state;
  }
  private save(id: string, state: unknown): void {
    writeFileAtomically(this.file(id, 'state.json'), JSON.stringify(state), undefined, 0o600, false);
  }
  private consumption(id: string, eventId: string): EventState {
    const file = this.file(id, `${eventId}.consumption.json`);
    return fs.existsSync(file) ? JSON.parse(read(file)) : {};
  }
  private saveConsumption(id: string, eventId: string, state: EventState): void {
    writeFileAtomically(this.file(id, `${eventId}.consumption.json`), JSON.stringify(state), undefined, 0o600, false);
  }
  private lock<T>(id: string, work: () => T): T {
    this.launch(id);
    const file = this.file(id, 'write.lock');
    const temporary = this.file(id, `write.${process.pid}.${randomUUID()}.lock`);
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), launchId: id });
    exclusive(temporary, owner);
    let acquired = false;
    try {
      let target = file;
      if (fs.existsSync(file)) {
        let current = file;
        for (let steps = 0; ; steps++) {
          const heldText = read(current);
          const held = JSON.parse(heldText);
          if (held.launchId !== id || !Number.isSafeInteger(held.pid) || held.pid < 1 || !DISPATCH_ID.test(held.token))
            throw new Error('The dispatch write owner is unavailable.');
          if (steps >= 32) {
            // Retained successors keep stale readers safe when the bounded walk advances its head.
            writeFileAtomically(file, heldText, undefined, 0o600, false);
            throw new Error('The dispatch write changed during recovery. Try again.');
          }
          const successor = this.file(id, `write.${held.token}.next.lock`);
          if (fs.existsSync(successor)) {
            current = successor;
            continue;
          }
          const released = this.file(id, `write.${held.token}.released`);
          if (fs.existsSync(released) && read(released) === heldText) {
            target = successor;
            break;
          }
          let dead = false;
          try {
            process.kill(held.pid, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
          if (!dead) throw new Error('Another process holds this dispatch write.');
          target = successor;
          break;
        }
      }
      // Each immutable predecessor admits one successor, including concurrent dead-owner recovery.
      fs.linkSync(temporary, target);
      acquired = true;
      if (target !== file) writeFileAtomically(file, owner, undefined, 0o600, false);
      return work();
    } finally {
      if (acquired) exclusive(this.file(id, `write.${JSON.parse(owner).token}.released`), owner);
      fs.unlinkSync(temporary);
    }
  }
}
