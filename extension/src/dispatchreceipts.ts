import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileAtomically } from './atomicfile';
import { arcHome } from './store';
import { payloadSha256, type RequesterIdentity } from './sessionwrites';
import type { LaunchPolicy } from './launchpolicy';

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
function safePath(file: string): void {
  let current = path.resolve(file);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('The dispatch path is redirected.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
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
      if (!path.isAbsolute(input.alias) || path.relative(this.root, input.alias).split(path.sep)[0] !== '..')
        throw new Error('A report alias must stay outside private dispatch storage.');
      safePath(path.dirname(input.alias));
      if (fs.existsSync(input.alias)) {
        safePath(input.alias);
        if (!fs.lstatSync(input.alias).isFile()) throw new Error('A report alias must name a regular file.');
      }
    }
    if (fs.readdirSync(this.root).filter((name) => DISPATCH_ID.test(name)).length >= 256)
      throw new Error('Arc has reached its retained dispatch launch limit.');
    const launchId = randomUUID();
    const directory = path.join(this.root, launchId);
    fs.mkdirSync(directory, { mode: 0o700 });
    const launch: DispatchLaunch = { ...input, launchId, transport: 'hosted' };
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
          ? DISPATCH_ID.test(binding.nativeTurnId)
          : /^[1-9][0-9]*$/.test(binding.nativeTurnId)))
    )
      throw new Error('The dispatch worker identity is invalid.');
    const file = this.file(id, 'accepted.json');
    const text = JSON.stringify({ launchId: id, ...binding });
    if (fs.existsSync(file)) {
      const witness = JSON.parse(read(path.join(this.root, `${id}.accepted.json`)));
      if (
        read(file) !== text ||
        witness.sha256 !== payloadSha256(text) ||
        !equalIdentity(witness.identity, identity(file))
      )
        throw new Error('The accepted dispatch turn cannot change.');
    } else {
      exclusive(file, text);
      exclusive(
        path.join(this.root, `${id}.accepted.json`),
        JSON.stringify({ launchId: id, identity: identity(file), sha256: payloadSha256(text) }),
      );
    }
  }
  publish(
    id: string,
    input: Omit<DispatchEvent, 'launchId' | 'eventId' | 'assignment' | 'report'>,
    text: string | null,
  ): DispatchEvent {
    const launch = this.launch(id);
    if (text !== null && (input.availability !== 'available' || Buffer.byteLength(text) > REPORT_BYTES))
      throw new Error('The dispatch response exceeds its saved report allowance.');
    return this.lock(id, () => {
      const state = this.state(id);
      if (state.events.length >= 256) throw new Error('The dispatch has reached its retained event limit.');
      const eventId = randomUUID();
      const reportFile = this.file(id, `${eventId}.md`);
      const report =
        text === null ? null : { path: reportFile, sha256: payloadSha256(text), bytes: Buffer.byteLength(text) };
      if (text !== null) exclusive(reportFile, text);
      const event: DispatchEvent = { ...input, launchId: id, eventId, assignment: 1, report };
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized) > JSON_BYTES) throw new Error('The dispatch event exceeds its allowance.');
      exclusive(this.file(id, `${eventId}.json`), serialized);
      state.events.push({
        id: eventId,
        sha256: payloadSha256(serialized),
        identity: identity(this.file(id, `${eventId}.json`)),
        reportIdentity: report ? identity(reportFile) : null,
      });
      this.save(id, state);
      if (launch.alias && text !== null) {
        // An alias never supplies authoritative report bytes.
        try {
          safePath(path.dirname(launch.alias));
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
    const held = this.state(id).events.find((one) => one.id === eventId);
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
    const reply = { ...event, text: text !== null && text.length <= DISPATCH_TEXT_LIMIT ? text : null };
    if (Buffer.byteLength(JSON.stringify(reply)) > JSON_BYTES) reply.text = null;
    return reply;
  }
  status(id: string): {
    launch: DispatchLaunch;
    events: (DispatchEvent & { consumption: EventState; delivery: 'unavailable' })[];
  } {
    const launch = this.launch(id);
    return {
      launch,
      events: this.state(id).events.map((one) => {
        const consumption = this.consumption(id, one.id);
        delete consumption.token;
        return { ...this.event(id, one.id), consumption, delivery: 'unavailable' };
      }),
    };
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
      this.event(id, eventId);
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
    const status = this.status(id);
    const last = status.events.at(-1);
    if (!status.launch.alias || !last?.report) return null;
    const text = read(status.launch.alias, REPORT_BYTES);
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
  private state(id: string): {
    launchId: string;
    events: { id: string; sha256: string; identity: FileIdentity; reportIdentity: FileIdentity | null }[];
  } {
    const state = JSON.parse(read(this.file(id, 'state.json'), 4 * JSON_BYTES));
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
    exclusive(file, '');
    try {
      return work();
    } finally {
      fs.unlinkSync(file);
    }
  }
}
