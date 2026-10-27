import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomically } from './atomicfile';
import { admitToolPath } from './toolownership';
import { revisionOf, supportedFileIdentity } from './transcript';
import { COMPACT_LIMITS, validContinuation, type CompactPersistence, type CompactReceipt } from './compactrequest';

interface Lease {
  activation: string;
  pid: number;
}
const activationValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Uses the immutable successor and release format of question recovery. Only complete files become leases.
export class CompactStore implements CompactPersistence {
  private released = false;
  private acquired = false;
  private closing = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly root: string;
  constructor(
    root: string,
    private readonly activation: string,
    private readonly now = Date.now,
    private readonly endedProcess = dead,
    private readonly pid = process.pid,
    private readonly limits = { records: COMPACT_LIMITS.records as number, bytes: 16 * 1024 * 1024 },
  ) {
    if (!activationValid(activation)) throw new Error('Continuation storage is unavailable.');
    this.root = path.resolve(root);
  }
  private readJson(file: string, limit = 65536): unknown {
    admitToolPath(path.dirname(file));
    const before = fs.lstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !supportedFileIdentity(revisionOf(before)) ||
      before.size > limit ||
      (process.platform !== 'win32' && before.uid !== BigInt(process.getuid!()))
    )
      throw new Error('Continuation storage is unavailable.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        throw new Error('Continuation storage changed.');
      const bytes = Buffer.alloc(limit + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.lstatSync(file, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        length > limit ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size
      )
        throw new Error('Continuation storage changed.');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    } finally {
      fs.closeSync(fd);
    }
  }
  private lease(): Lease | null {
    let name = 'initial';
    const seen = new Set<string>();
    for (let count = 0; count < 4096; count++) {
      let value: Lease;
      try {
        value = this.readJson(path.join(this.root, 'leases', name), 256) as Lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return name === 'initial'
            ? null
            : (() => {
                throw error;
              })();
        throw error;
      }
      if (
        !value ||
        !activationValid(value.activation) ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        seen.has(value.activation)
      )
        throw new Error('Continuation ownership is unavailable.');
      seen.add(value.activation);
      const next = `${value.activation}.next`;
      try {
        fs.lstatSync(path.join(this.root, 'leases', next));
        name = next;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return value;
        throw error;
      }
    }
    throw new Error('Continuation ownership history is full.');
  }
  private isReleased(owner: string): boolean {
    try {
      return this.readJson(path.join(this.root, 'leases', `${owner}.released`), 256) === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  ended(owner: string): boolean {
    return this.endedOwners([owner]).has(owner);
  }
  private endedOwners(owners: Iterable<string>): Set<string> {
    const pending = new Set([...owners].filter(activationValid));
    const ended = new Set<string>();
    try {
      let name = 'initial';
      const seen = new Set<string>();
      for (let count = 0; pending.size && count < 4096; count++) {
        const lease = this.readJson(path.join(this.root, 'leases', name), 256) as Lease;
        if (
          !activationValid(lease.activation) ||
          !Number.isSafeInteger(lease.pid) ||
          lease.pid <= 0 ||
          seen.has(lease.activation)
        )
          break;
        seen.add(lease.activation);
        if (pending.delete(lease.activation)) {
          try {
            if (this.isReleased(lease.activation) || this.endedProcess(lease.pid)) ended.add(lease.activation);
          } catch {
            /* Unknown owner evidence leaves its receipts unchanged. */
          }
        }
        name = `${lease.activation}.next`;
      }
    } catch {
      /* Unknown ownership preserves the observed outcome. */
    }
    return ended;
  }
  private publish(file: string, value: unknown): void {
    // A crash during staging leaves no authoritative partial lease or receipt. link is exclusive publication.
    const staging = path.join(path.dirname(file), `${this.activation}.${this.pid}.${randomUUID()}.staging`);
    const fd = fs.openSync(staging, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(staging, file);
    } finally {
      fs.unlinkSync(staging);
    }
  }
  private owns(): boolean {
    if (this.released) return false;
    admitToolPath(this.root);
    fs.mkdirSync(path.join(this.root, 'leases'), { recursive: true, mode: 0o700 });
    this.leaseBytes();
    const previous = this.lease();
    if (previous?.activation === this.activation && previous.pid === this.pid) return (this.acquired = true);
    if (previous && !this.isReleased(previous.activation) && !this.endedProcess(previous.pid)) return false;
    try {
      this.publish(path.join(this.root, 'leases', previous ? `${previous.activation}.next` : 'initial'), {
        activation: this.activation,
        pid: this.pid,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const current = this.lease();
    return (this.acquired = current?.activation === this.activation && current.pid === this.pid);
  }
  private leaseBytes(): number {
    const names = this.names(path.join(this.root, 'leases'), 8192);
    let bytes = 0;
    for (const name of names) {
      if (!/^(?:initial|[a-f0-9]{24}\.(?:next|released)|[a-f0-9]{24}\.[0-9]+\.[a-f0-9-]{36}\.staging)$/.test(name))
        throw new Error('Continuation ownership contains unfamiliar files.');
      const file = path.join(this.root, 'leases', name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256)
        throw new Error('Continuation ownership is unavailable.');
      bytes += stat.size;
    }
    return bytes;
  }
  private names(directory: string, limit: number): string[] {
    const opened = fs.opendirSync(directory);
    const names: string[] = [];
    try {
      for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
        if (names.length === limit) throw new Error('Continuation storage is full.');
        names.push(entry.name);
      }
    } finally {
      opened.closeSync();
    }
    return names;
  }
  private file(id: string): string {
    if (!/^[a-f0-9]{24}:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))
      throw new Error('Continuation request is unavailable.');
    return path.join(this.root, createHash('sha256').update(id).digest('hex') + '.json');
  }
  private valid(receipt: CompactReceipt): boolean {
    const continuation = receipt?.observation?.continuation;
    return (
      receipt?.version === 1 &&
      activationValid(receipt.owner) &&
      receipt.binding?.activation === receipt.owner &&
      // A session whose row the catalog has not published yet records no authority or source identity.
      (receipt.binding.authority === undefined || typeof receipt.binding.authority === 'string') &&
      typeof receipt.binding.assignmentId === 'string' &&
      (receipt.binding.sourceIdentity === undefined || typeof receipt.binding.sourceIdentity === 'string') &&
      Number.isFinite(receipt.admittedAt) &&
      (receipt.terminalAt === null || Number.isFinite(receipt.terminalAt)) &&
      !!continuation &&
      validContinuation(continuation.text, continuation.sha256) &&
      ['waiting', 'preparing', 'attempting', 'accepted', 'cancelled', 'refused', 'uncertain'].includes(
        continuation.state,
      ) &&
      receipt.observation.requestId.startsWith(receipt.owner + ':')
    );
  }
  read(id: string): CompactReceipt | null {
    try {
      const receipt = this.readJson(this.file(id)) as CompactReceipt;
      if (!this.valid(receipt) || receipt.observation.requestId !== id || this.expired(receipt)) return null;
      return receipt;
    } catch {
      return null;
    }
  }
  private expired(receipt: CompactReceipt): boolean {
    return receipt.terminalAt !== null && this.now() >= receipt.terminalAt + COMPACT_LIMITS.retentionMs;
  }
  private records(): { file: string; receipt: CompactReceipt; bytes: number }[] {
    return this.names(this.root, this.limits.records + 1)
      .filter((name) => name !== 'leases')
      .map((name) => {
        // Unpublished staging files are never execution authority. They still consume byte capacity.
        if (!/^[a-f0-9]{64}\.json$/.test(name))
          throw new Error('Continuation storage contains unfinished or unfamiliar files.');
        const file = path.join(this.root, name);
        const receipt = this.readJson(file) as CompactReceipt;
        if (!this.valid(receipt) || this.file(receipt.observation.requestId) !== file)
          throw new Error('Saved continuation is unreadable.');
        return { file, receipt, bytes: fs.lstatSync(file).size };
      });
  }
  private serialize(work: (ended: ReadonlySet<string>) => void, reclaim = false): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Continuation storage closed.'));
    const result = this.queue.then(() => {
      if (!this.owns()) throw new Error('Another window owns saved continuations.');
      const records = this.records();
      const ended = this.endedOwners(
        records
          .filter(
            ({ receipt }) =>
              receipt.owner !== this.activation &&
              (['waiting', 'preparing', 'attempting'].includes(receipt.observation.continuation!.state) ||
                (reclaim && receipt.terminalAt !== null)),
          )
          .map(({ receipt }) => receipt.owner),
      );
      this.reclassify(records, ended);
      work(ended);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private reclassify(records: ReturnType<CompactStore['records']>, ended: ReadonlySet<string>): void {
    for (const entry of records) {
      const continuation = entry.receipt.observation.continuation!;
      if (
        entry.receipt.owner === this.activation ||
        !['waiting', 'preparing', 'attempting'].includes(continuation.state) ||
        !ended.has(entry.receipt.owner)
      )
        continue;
      continuation.state = continuation.state === 'attempting' ? 'uncertain' : 'cancelled';
      continuation.write = continuation.state === 'uncertain' ? 'unknown' : 'not-written';
      continuation.reason = 'The originating window ended. Continuation will not restart.';
      continuation.sequence++;
      entry.receipt.terminalAt = this.now();
      this.replace(entry.file, entry.receipt);
    }
  }
  private replace(file: string, receipt: CompactReceipt): void {
    writeFileAtomically(
      file,
      JSON.stringify(receipt),
      (temporary, target) => {
        const fd = fs.openSync(
          temporary,
          fs.constants.O_RDWR | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK),
        );
        try {
          if (!fs.fstatSync(fd, { bigint: true }).isFile()) throw new Error('Continuation storage changed.');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.readJson(target);
        fs.renameSync(temporary, target);
      },
      0o600,
      false,
    );
  }
  reserve(receipt: CompactReceipt): Promise<void> {
    return this.serialize((ended) => {
      if (!this.valid(receipt) || receipt.owner !== this.activation)
        throw new Error('Continuation storage is unavailable.');
      const text = JSON.stringify(receipt);
      if (Buffer.byteLength(text) > 65536) throw new Error('The continuation is too large to save.');
      let records = this.records();
      for (const entry of records)
        if (
          this.expired(entry.receipt) &&
          entry.receipt.terminalAt !== null &&
          entry.receipt.observation.continuation!.write !== 'unknown' &&
          (entry.receipt.owner === this.activation || ended.has(entry.receipt.owner))
        )
          fs.unlinkSync(entry.file);
      records = this.records();
      const eligible = records
        .filter(
          ({ receipt }) =>
            receipt.terminalAt !== null &&
            !['waiting', 'preparing', 'attempting'].includes(receipt.observation.continuation!.state) &&
            receipt.observation.continuation!.write !== 'unknown' &&
            (receipt.owner === this.activation || ended.has(receipt.owner)),
        )
        .sort((a, b) => a.receipt.terminalAt! - b.receipt.terminalAt!);
      const full = () =>
        records.length >= this.limits.records ||
        records.reduce((sum, entry) => sum + entry.bytes, Buffer.byteLength(text) + this.leaseBytes()) >
          this.limits.bytes;
      for (const entry of eligible) {
        if (!full()) break;
        fs.unlinkSync(entry.file);
        records = records.filter((current) => current !== entry);
      }
      if (full()) throw new Error('Saved continuations are full.');
      this.publish(this.file(receipt.observation.requestId), receipt);
    }, true);
  }
  save(receipt: CompactReceipt): Promise<void> {
    return this.serialize(() => {
      const file = this.file(receipt.observation.requestId);
      const previous = this.readJson(file) as CompactReceipt;
      if (
        !this.valid(previous) ||
        !this.valid(receipt) ||
        previous.owner !== this.activation ||
        receipt.owner !== this.activation ||
        previous.observation.continuation?.sha256 !== receipt.observation.continuation?.sha256 ||
        JSON.stringify(previous.binding) !== JSON.stringify(receipt.binding)
      )
        throw new Error('Continuation ownership changed.');
      const text = JSON.stringify(receipt);
      if (Buffer.byteLength(text) > 65536) throw new Error('The continuation is too large to save.');
      this.replace(file, receipt);
    });
  }
  release(): void {
    this.closing = true;
    void this.queue
      .then(() => {
        try {
          if (this.acquired && this.owns())
            this.publish(path.join(this.root, 'leases', `${this.activation}.released`), true);
        } finally {
          this.released = true;
        }
      })
      .catch(() => {
        this.released = true;
      });
  }
}
