import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { acquireToolLock, admitToolPath, canonicalToolPath } from '../../extension/src/toolownership.ts';
import { readSkillPayload, skillTemporaryRoots, type SkillPayload } from './skillfiles.ts';

export type SkillAgent = 'claude' | 'codex';
export type SkillAction = 'install' | 'update' | 'remove';
type Identity = { dev: string; ino: string; birth: string };
type Files = Record<string, string>;
interface Owned {
  schema: 1;
  home: string;
  area: string;
  destination: string;
  control: Identity;
  directory: Identity;
  agent: SkillAgent;
  source: string;
  token: string;
  files: Files;
  settled: true;
}
export interface SkillResult {
  agent: SkillAgent;
  destination: string;
  status:
    | 'installed'
    | 'updated'
    | 'removed'
    | 'unchanged'
    | 'linked'
    | 'external-match-preserved'
    | 'incomplete'
    | 'failed'
    | 'cancelled';
  reason?: string;
  control?: string;
  operation?: string;
  publication?: 'installed' | 'updated' | 'removed';
}
export interface SkillOptions {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  home?: string;
  // Fixture callbacks acknowledge exact boundaries without a shipped activation route.
  checkpoint?: (phase: string) => Promise<void>;
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const identity = (file: string): Identity => {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`The skill folder is redirected or unavailable: ${file}`);
  return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function json(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error(`The skill ownership file is unavailable: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}
function scan(directory: string): Files {
  const files: Files = {};
  const visit = (relative: string): void => {
    const current = path.join(directory, relative);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`The skill contains a link: ${current}`);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current).sort();
      if (relative && !entries.length) throw new Error(`The skill contains an added empty folder: ${current}`);
      for (const entry of entries) visit(relative ? `${relative}/${entry}` : entry);
    } else if (stat.isFile()) files[relative] = digest(fs.readFileSync(current));
    else throw new Error(`The skill contains an unsupported file: ${current}`);
  };
  visit('');
  return files;
}
const equalFiles = (a: Files, b: Files): boolean => same(Object.entries(a).sort(), Object.entries(b).sort());
function check(directory: string, expectedIdentity: Identity, files: Files): void {
  admitToolPath(directory);
  if (!same(identity(directory), expectedIdentity) || !equalFiles(scan(directory), files))
    throw new Error(`The skill changed during setup: ${directory}`);
}
function removeCopy(directory: string, expectedIdentity: Identity, files: Files): void {
  const remaining = { ...files };
  check(directory, expectedIdentity, remaining);
  // Empty resource folders are removed with their last file, so every check sees the exact tree.
  for (const relative of Object.keys(files).sort().reverse()) {
    check(directory, expectedIdentity, remaining);
    fs.unlinkSync(path.join(directory, relative));
    delete remaining[relative];
    for (
      let folder = path.dirname(path.join(directory, relative));
      folder !== directory;
      folder = path.dirname(folder)
    ) {
      if (fs.readdirSync(folder).length) break;
      fs.rmdirSync(folder);
    }
  }
  check(directory, expectedIdentity, {});
  fs.rmdirSync(directory);
}
function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Reads the install record and checks it against the copy now at the destination. Throws when Arc does not own that copy.
function ownedCopy(
  metadata: string,
  destination: string,
  expected: { home: string; area: string; agent: SkillAgent; control: Identity },
): Owned {
  const value = json(metadata) as Owned;
  if (
    Object.keys(value).sort().join(',') !==
      'agent,area,control,destination,directory,files,home,schema,settled,source,token' ||
    value.schema !== 1 ||
    value.home !== expected.home ||
    value.area !== expected.area ||
    value.destination !== destination ||
    value.agent !== expected.agent ||
    !value.settled ||
    !same(value.control, expected.control) ||
    typeof value.token !== 'string' ||
    typeof value.files !== 'object' ||
    !value.files ||
    !value.directory
  )
    throw new Error(`Unrecognized skill ownership at ${metadata}. Preserve it for manual review.`);
  check(destination, value.directory, value.files);
  return value;
}
function ownsCopy(
  control: string,
  destination: string,
  expected: { home: string; area: string; agent: SkillAgent },
): boolean {
  try {
    ownedCopy(path.join(control, 'installed.json'), destination, { ...expected, control: identity(control) });
    return true;
  } catch {
    return false;
  }
}

const agentNames: Record<SkillAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
const otherAgent = (agent: SkillAgent): SkillAgent => (agent === 'claude' ? 'codex' : 'claude');
// A personal skills folder is linked when it resolves anywhere but its own place under the home folder.
function skillFolder(agent: SkillAgent, nativeHome: string): { input: string; area: string; linked: boolean } {
  const relative = path.join(agent === 'claude' ? '.claude' : '.agents', 'skills');
  const input = path.join(nativeHome, relative);
  const area = canonicalToolPath(input);
  return { input, area, linked: area !== path.join(canonicalToolPath(nativeHome), relative) };
}
function safeSkillFolder(agent: SkillAgent, nativeHome: string): ReturnType<typeof skillFolder> | undefined {
  try {
    return skillFolder(agent, nativeHome);
  } catch {
    return undefined;
  }
}
export function skillFolderLinked(agent: SkillAgent, nativeHome = os.homedir()): boolean {
  return safeSkillFolder(agent, nativeHome)?.linked ?? false;
}

export async function operateSkill(
  action: SkillAction,
  agent: SkillAgent,
  payload: SkillPayload,
  options: SkillOptions,
): Promise<SkillResult> {
  const env = options.env ?? process.env;
  const nativeHome = options.home ?? os.homedir();
  if (!path.isAbsolute(nativeHome)) throw new Error('Arc needs an absolute personal home folder.');
  const home = canonicalToolPath(nativeHome);
  const { input: areaInput, area, linked: areaLinked } = skillFolder(agent, nativeHome);
  const destination = path.join(area, 'arc-sessions');
  const control = `${area}.arc-skill-control`;
  const result = (status: SkillResult['status'], reason?: string): SkillResult => ({
    agent,
    destination,
    status,
    ...(reason ? { reason } : {}),
  });
  if (
    agent === 'claude' &&
    env.CLAUDE_CONFIG_DIR &&
    canonicalToolPath(env.CLAUDE_CONFIG_DIR) !== canonicalToolPath(path.join(nativeHome, '.claude'))
  )
    return result(
      'failed',
      'Custom Claude configuration is unsupported. Use the manual skill installation instructions.',
    );
  const files = Object.fromEntries([...payload.files].map(([relative, bytes]) => [relative, digest(bytes)]));
  const peer = safeSkillFolder(otherAgent(agent), nativeHome);
  if (areaLinked) {
    // Arc never writes through a linked skills folder. Whatever is at the target serves this agent.
    const name = agentNames[agent];
    const other = otherAgent(agent);
    const toPeer = peer !== undefined && !peer.linked && peer.area === area;
    const target = toPeer ? `the ${agentNames[other]} skills folder` : area;
    const intro = `The ${name} skills folder is linked to ${target}${toPeer ? ` at ${area}` : ''}.`;
    const present = exists(destination);
    // The peer commands refuse a copy that Arc does not own, so they are offered only for an absent copy or one the peer's install record still matches.
    const peerOwned = toPeer && present && ownsCopy(control, destination, { home, area, agent: other });
    const peerCommand = toPeer && (!present || peerOwned);
    if (action === 'remove')
      return result(
        'linked',
        `${intro} Arc left the linked folder unchanged.${
          present
            ? peerCommand
              ? ` Remove the skill there with arc skills remove --agent ${other}.`
              : ` Arc does not manage that copy. Remove the skill at ${destination} by hand.`
            : ''
        }`,
      );
    let matches = false;
    if (present) {
      try {
        matches = equalFiles(scan(fs.realpathSync.native(destination)), files);
      } catch {
        matches = false;
      }
    }
    if (matches)
      return result('linked', `${intro} ${name} reads the skill there, and Arc left the linked folder unchanged.`);
    const verb = present ? 'update' : 'install';
    return result(
      'incomplete',
      `${intro} The skill there is ${present ? 'different from this version' : 'missing'}, and Arc leaves linked folders unchanged. ${
        peerCommand
          ? `Run arc skills ${verb} --agent ${other} to ${verb} it there.`
          : toPeer
            ? `Arc does not manage the copy at ${destination}. Update it there by hand as described in cli/README.md#session-skill.`
            : 'Link or copy the skill there as described in cli/README.md#session-skill.'
      }`,
    );
  }
  const metadata = path.join(control, 'installed.json');
  // A read-only match never grants permission to write through redirected discovery folders.
  if (action === 'install' && exists(destination) && !exists(metadata)) {
    try {
      const physical = fs.realpathSync.native(destination);
      if (!equalFiles(scan(physical), files))
        return result('failed', 'An existing skill has different files. Preserve it or move it manually.');
      const roots = skillTemporaryRoots(env);
      const lexicalArea =
        process.platform === 'win32' ? path.normalize(areaInput).toLowerCase() : path.normalize(areaInput);
      const redirected = canonicalToolPath(areaInput) !== lexicalArea;
      const linked =
        fs.lstatSync(destination).isSymbolicLink() ||
        redirected ||
        canonicalToolPath(destination) !== path.resolve(destination);
      const volatile =
        roots.some(
          (root) =>
            root.state === 'unresolved' || (root.canonical && contains(root.canonical, canonicalToolPath(physical))),
        ) ||
        contains(payload.directory, canonicalToolPath(physical)) ||
        linked;
      return result(
        volatile ? 'incomplete' : 'external-match-preserved',
        volatile
          ? 'The matching external skill remains unchanged. Its storage lifetime is uncertain.'
          : 'The matching external skill remains user-owned.',
      );
    } catch (error) {
      return result('failed', String(error));
    }
  }
  if (options.signal.aborted) return result('cancelled', 'Skill setup was not started after cancellation.');
  admitToolPath(areaInput);
  admitToolPath(control);
  fs.mkdirSync(area, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    fs.mkdirSync(control, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const controlIdentity = identity(control);
  if (identity(area).dev !== controlIdentity.dev)
    throw new Error('The personal skill folder and its setup storage must use the same filesystem.');
  const binding = { schema: 1, home, area, areaIdentity: identity(area), destination, identity: controlIdentity };
  const ownership = path.join(control, 'ownership.json');
  if (created) save(ownership, binding);
  if (!same(json(ownership), binding))
    throw new Error(`Unrecognized skill ownership at ${control}. Preserve it for manual review.`);
  let software: ReturnType<typeof acquireToolLock> | undefined;
  let lock: ReturnType<typeof acquireToolLock> | undefined;
  let settled = true;
  let committed = false;
  let journaled = false;
  let operationIdentity: Identity | undefined;
  const staged: Files = {};
  let operation: string | undefined;
  let claimed: Identity | undefined;
  let backupIdentity: Identity | undefined;
  let previous: Owned | undefined;
  const published: Files = {};
  let stage = '';
  let stagingIdentity: Identity | undefined;
  let backup = '';
  let token = '';
  const checkpoint = async (phase: string): Promise<void> => {
    await options.checkpoint?.(phase);
    await yieldIO();
    if (options.signal.aborted) throw new Error('Skill setup was cancelled.');
  };
  try {
    software = acquireToolLock(path.join(control, 'software.lock'));
    lock = acquireToolLock(path.join(control, 'destination.lock'));
    for (const entry of fs.readdirSync(control)) {
      if (
        !['ownership.json', 'installed.json', 'software.lock', 'destination.lock'].includes(entry) &&
        !/^operation-[0-9a-f-]{36}$/.test(entry)
      )
        throw new Error(`Unrecognized skill setup files at ${control}. Preserve them for manual review.`);
      if (entry.startsWith('operation-')) {
        const folder = path.join(control, entry);
        identity(folder);
        if (
          !exists(path.join(folder, 'seal.json')) ||
          !same(json(path.join(folder, 'seal.json')), { schema: 1, token: entry.slice(10), settled: true })
        )
          throw new Error(
            `Unfinished skill setup at ${folder}. Follow docs/arc-sessions.md#manual-recovery before retrying.`,
          );
        if (fs.readdirSync(folder).some((name) => !['journal.json', 'seal.json'].includes(name)))
          throw new Error(
            `Retained skill setup files at ${folder}. Follow docs/arc-sessions.md#manual-recovery before retrying.`,
          );
      }
    }
    if (exists(metadata)) previous = ownedCopy(metadata, destination, { home, area, agent, control: controlIdentity });
    else if (exists(destination)) throw new Error(`An existing skill is not owned by Arc: ${destination}`);
    if (!previous && action !== 'install') throw new Error(`Arc does not own a skill at ${destination}.`);
    if (previous && action !== 'remove' && equalFiles(previous.files, files)) return result('unchanged');
    token = randomUUID();
    operation = path.join(control, `operation-${token}`);
    fs.mkdirSync(operation, { mode: 0o700 });
    operationIdentity = identity(operation);
    settled = false;
    stage = path.join(operation, 'stage');
    backup = path.join(operation, 'backup');
    fs.mkdirSync(stage, { mode: 0o700 });
    stagingIdentity = identity(stage);
    for (const [relative, bytes] of payload.files) {
      fs.mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true });
      fs.writeFileSync(path.join(stage, relative), bytes, { flag: 'wx', mode: 0o600 });
      staged[relative] = files[relative];
    }
    // Check exclusive completed-file publication support before changing a discovered skill.
    const linkTest = path.join(operation, 'link-test');
    fs.linkSync(path.join(stage, 'SKILL.md'), linkTest);
    fs.unlinkSync(linkTest);
    const journal = {
      schema: 1,
      token,
      home,
      area,
      destination,
      control: controlIdentity,
      action,
      agent,
      source: payload.identity,
      locks: {
        software: { file: software.file, token: software.token },
        destination: { file: lock.file, token: lock.token },
      },
      stage,
      stageIdentity: stagingIdentity,
      backup,
      previous,
      files,
    };
    save(path.join(operation, 'journal.json'), journal);
    journaled = true;
    await checkpoint('prepared');
    check(stage, stagingIdentity, files);
    if (previous) {
      check(destination, previous.directory, previous.files);
      fs.renameSync(destination, backup);
      backupIdentity = previous.directory;
      if (!same(identity(backup), backupIdentity)) throw new Error('The previous skill folder changed during setup.');
      await checkpoint('backed-up');
    }
    if (action !== 'remove') {
      admitToolPath(areaInput);
      if (!same(identity(control), controlIdentity)) throw new Error('The skill setup folder changed.');
      fs.mkdirSync(destination, { mode: 0o700 });
      claimed = identity(destination);
      save(path.join(operation, 'claim.json'), { token, destination, directory: claimed });
      for (const relative of [...payload.files.keys()].sort(
        (a, b) => Number(a === 'SKILL.md') - Number(b === 'SKILL.md') || a.localeCompare(b),
      )) {
        await checkpoint(relative === 'SKILL.md' ? 'before-definition' : 'resource');
        check(destination, claimed, published);
        check(
          stage,
          stagingIdentity,
          Object.fromEntries(Object.entries(files).filter(([name]) => !(name in published))),
        );
        fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
        fs.linkSync(path.join(stage, relative), path.join(destination, relative));
        published[relative] = files[relative];
        fs.unlinkSync(path.join(stage, relative));
        for (let folder = path.dirname(path.join(stage, relative)); folder !== stage; folder = path.dirname(folder)) {
          if (fs.readdirSync(folder).length) break;
          fs.rmdirSync(folder);
        }
      }
      check(destination, claimed, files);
      await checkpoint('published');
    }
    if (previous) {
      if (!same(json(metadata), previous)) throw new Error('The skill ownership changed during setup.');
      fs.unlinkSync(metadata);
    }
    if (claimed)
      save(metadata, {
        schema: 1,
        home,
        area,
        destination,
        control: controlIdentity,
        directory: claimed,
        agent,
        source: payload.identity,
        token,
        files,
        settled: true,
      } satisfies Owned);
    committed = true;
    if (backupIdentity && previous) removeCopy(backup, backupIdentity, previous.files);
    // Stage resources already have regular installed names. Clear only this operation's exact staging tree.
    removeCopy(stage, stagingIdentity, action === 'remove' ? files : {});
    if (exists(path.join(operation, 'claim.json'))) fs.unlinkSync(path.join(operation, 'claim.json'));
    save(path.join(operation, 'seal.json'), { schema: 1, token, settled: true });
    settled = true;
    const sharedWith = action === 'remove' && peer?.linked && peer.area === area ? agentNames[otherAgent(agent)] : '';
    return {
      ...result(
        action === 'install' ? 'installed' : action === 'update' ? 'updated' : 'removed',
        sharedWith
          ? `${sharedWith} also read this skill through its linked skills folder, so it no longer finds it.`
          : undefined,
      ),
      control,
      operation,
    };
  } catch (error) {
    if (!settled && operation && !journaled) {
      try {
        if (!operationIdentity || !same(identity(operation), operationIdentity))
          throw new Error('The skill preparation folder changed.', { cause: error });
        if (fs.readdirSync(operation).some((name) => !['stage', 'link-test'].includes(name)))
          throw new Error('The skill preparation files changed.', { cause: error });
        const linkTest = path.join(operation, 'link-test');
        if (exists(linkTest)) {
          const target = fs.lstatSync(path.join(stage, 'SKILL.md'), { bigint: true });
          const link = fs.lstatSync(linkTest, { bigint: true });
          if (!link.isFile() || link.isSymbolicLink() || link.dev !== target.dev || link.ino !== target.ino)
            throw new Error('The skill publication check changed.', { cause: error });
          if (digest(fs.readFileSync(linkTest)) !== files['SKILL.md'])
            throw new Error('The skill publication bytes changed.', { cause: error });
          fs.unlinkSync(linkTest);
        }
        if (stagingIdentity) removeCopy(stage, stagingIdentity, staged);
        if (fs.readdirSync(operation).length)
          throw new Error('The skill preparation folder is not empty.', { cause: error });
        fs.rmdirSync(operation);
        settled = true;
      } catch {
        /* Preserve uncertain preparation files and matching locks. */
      }
    } else if (!settled && operation && !committed) {
      try {
        if (claimed) removeCopy(destination, claimed, published);
        if (backupIdentity && previous) {
          if (exists(destination)) throw new Error('A different skill now occupies the destination.', { cause: error });
          check(backup, backupIdentity, previous.files);
          fs.renameSync(backup, destination);
        }
        if (exists(metadata)) {
          const current = json(metadata) as Owned;
          if (current.token === token) fs.unlinkSync(metadata);
          else if (!same(current, previous))
            throw new Error('The skill ownership changed during recovery.', { cause: error });
        }
        if (previous && !exists(metadata)) save(metadata, previous);
        if (exists(stage) && stagingIdentity)
          removeCopy(
            stage,
            stagingIdentity,
            Object.fromEntries(Object.entries(files).filter(([relative]) => !(relative in published))),
          );
        if (exists(path.join(operation, 'claim.json'))) fs.unlinkSync(path.join(operation, 'claim.json'));
        save(path.join(operation, 'seal.json'), { schema: 1, token, settled: true });
        settled = true;
      } catch {
        /* Uncertain copies and matching locks remain for manual recovery. */
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    const retainedLock = (error as Error & { cause?: NodeJS.ErrnoException }).cause?.code === 'EEXIST';
    const recovery = 'Follow docs/arc-sessions.md#manual-recovery before retrying.';
    return {
      ...result(
        !settled ? 'incomplete' : options.signal.aborted ? 'cancelled' : 'failed',
        `${reason}${(!settled || retainedLock) && !reason.includes(recovery) ? ' ' + recovery : ''}`,
      ),
      ...(committed
        ? {
            publication:
              action === 'install'
                ? ('installed' as const)
                : action === 'update'
                  ? ('updated' as const)
                  : ('removed' as const),
          }
        : {}),
      control,
      operation,
    };
  } finally {
    if (settled) {
      lock?.release();
      software?.release();
    }
  }
}

export async function runSkills(action: string, args: string[]): Promise<void> {
  const agents: SkillAgent[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--agent' || !['claude', 'codex'].includes(args[i + 1])) {
      process.exitCode = 2;
      throw new Error('Use --agent claude or --agent codex for each selected personal skill.');
    }
    const agent = args[++i] as SkillAgent;
    if (!agents.includes(agent)) agents.push(agent);
  }
  if (!agents.length) {
    process.exitCode = 2;
    throw new Error('Select at least one --agent claude or --agent codex.');
  }
  const payload = readSkillPayload(canonicalToolPath(fs.realpathSync.native(path.resolve(process.argv[1]))));
  const controller = new AbortController();
  let cancellation = 0;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const [signal, status] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    const handler = (): void => {
      cancellation ||= status;
      controller.abort();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const results: SkillResult[] = [];
  // Output errors cannot interrupt filesystem settlement.
  const ignoreOutputError = (): void => {};
  process.stdout.on('error', ignoreOutputError);
  process.stderr.on('error', ignoreOutputError);
  try {
    // A linked folder reads what its target holds, so folders that Arc writes run first. Results keep the flag order.
    const ordered = [...agents].sort((a, b) => Number(skillFolderLinked(a)) - Number(skillFolderLinked(b)));
    const byAgent = new Map<SkillAgent, SkillResult>();
    for (const agent of ordered) {
      if (controller.signal.aborted) {
        byAgent.set(agent, {
          agent,
          destination: '',
          status: 'cancelled',
          reason: 'Not attempted after cancellation.',
        });
        continue;
      }
      try {
        byAgent.set(agent, await operateSkill(action as SkillAction, agent, payload, { signal: controller.signal }));
      } catch (error) {
        byAgent.set(agent, {
          agent,
          destination: '',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const agent of agents) results.push(byAgent.get(agent)!);
    process.exitCode =
      cancellation || (results.some((r) => ['failed', 'incomplete', 'cancelled'].includes(r.status)) ? 1 : 0);
    try {
      process.stdout.write(JSON.stringify({ version: 1, action, results, cancellation: cancellation || null }) + '\n');
    } catch {
      /* Settlement is complete. */
    }
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
