import { createHash, randomUUID } from 'node:crypto';
import fs, { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from './atomicfile';
import { launchPolicy, type LaunchPolicy } from './launchpolicy';

// Authoritative restrictions outlive workspaces and have no eviction rule.
export class LaunchPolicyStore {
  private readonly clears = new Map<string, string>();

  constructor(private readonly root: string) {}

  private get pendingFile(): string {
    return join(this.root, 'pending-clear.json');
  }

  prepareClear(key: string, session: string): string {
    const token = randomUUID();
    mkdirSync(this.root, { recursive: true });
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.pendingFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ token, session }));
    } catch (error) {
      // Exclusive creation establishes ownership even when writing the reservation fails.
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
        unlinkSync(this.pendingFile);
      }
      throw new Error('Read-only clearing is unavailable until the previous clear saves its session permissions.', {
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    this.clears.set(key, token);
    return token;
  }

  cancelClear(key: string, token: string): void {
    const held = this.clears.get(key);
    if (held && held !== token) return;
    if (statSync(this.pendingFile).size > 8192) throw new Error('Saved read-only clear permissions are unreadable.');
    const pending = JSON.parse(readFileSync(this.pendingFile, 'utf8'));
    if (pending.token !== token) return;
    unlinkSync(this.pendingFile);
    this.clears.delete(key);
  }

  forgetClear(key: string): void {
    this.clears.delete(key);
  }

  confirmClear(key: string, session: string): boolean {
    const token = this.clears.get(key);
    if (!token) return false;
    const successor = this.readSaved(session);
    if (!successor) return false;
    if (statSync(this.pendingFile).size > 8192) throw new Error('Saved read-only clear permissions are unreadable.');
    const pending = JSON.parse(readFileSync(this.pendingFile, 'utf8'));
    if (pending.token !== token || pending.session === session) return false;
    const original = this.readSaved(pending.session);
    if (!original || JSON.stringify(original) !== JSON.stringify(successor))
      throw new Error('Read-only clearing did not retain its saved session permissions.');
    unlinkSync(this.pendingFile);
    this.clears.delete(key);
    return true;
  }

  private file(id: string): string {
    const digest = createHash('sha256').update(id).digest('hex');
    return join(this.root, digest.slice(0, 2), `${digest}.json`);
  }

  read(id: string): LaunchPolicy | undefined {
    const policy = this.readSaved(id);
    if (policy) return policy;
    try {
      statSync(this.pendingFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    }
    throw new Error(`Session ${id} cannot continue until a read-only clear saves its session permissions.`);
  }

  readSaved(id: string): LaunchPolicy | undefined {
    const file = this.file(id);
    try {
      if (statSync(file).size > 8192) throw new Error('oversized policy');
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value.session !== id || value.policy?.readOnly !== true || !Array.isArray(value.policy.readTools))
        throw new Error('invalid policy');
      return launchPolicy('claude', true, value.policy.readTools);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`Session ${id} has unreadable launch permissions. Its next prompt was not sent.`, {
        cause: error,
      });
    }
  }

  write(id: string, policy: LaunchPolicy): void {
    const previous = this.readSaved(id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(policy))
        throw new Error(`Session ${id} keeps its read-only launch permissions.`);
      return;
    }
    writeFileAtomically(this.file(id), JSON.stringify({ session: id, policy }), undefined, 0o600, false);
  }
}
