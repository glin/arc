import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalToolPath } from '../../extension/src/toolownership.ts';
import { validateToolFiles, type ToolPayload } from '../../extension/src/bundledtools.ts';

export interface SkillPayload {
  directory: string;
  identity: string;
  files: ReadonlyMap<string, Buffer>;
}

// Each executing artifact owns one layout. Caller directories never select instructions.
export function readSkillPayload(executable: string, platform = process.platform): SkillPayload {
  if (!path.isAbsolute(executable)) throw new Error('Arc needs an absolute command path to find its session skill.');
  const folder = path.dirname(executable);
  let directory: string;
  if (path.basename(executable) === 'cli.cjs' && path.basename(folder) === 'dist') {
    directory = path.join(folder, 'tools/skills/arc-sessions');
  } else if (
    path.basename(executable) === 'arc.cjs' &&
    path.basename(folder) === 'cli' &&
    path.basename(path.dirname(folder)) === 'tools'
  ) {
    directory = path.join(folder, '../skills/arc-sessions');
  } else if (path.basename(executable) === 'arc.cjs' && path.basename(folder) === 'cli') {
    const release = path.dirname(folder);
    const payload = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8')) as ToolPayload;
    const { contentId, ...content } = payload;
    if (
      payload.schemaVersion !== 1 ||
      payload.nodeMinimum !== 18 ||
      payload.plugin?.name !== 'arc-hooks' ||
      !Array.isArray(payload.platforms) ||
      !payload.platforms.includes(platform) ||
      !payload.files?.['cli/arc.cjs'] ||
      !payload.files?.['skills/arc-sessions/SKILL.md'] ||
      contentId !== createHash('sha256').update(JSON.stringify(content)).digest('hex')
    )
      throw new Error('Arc cannot identify this command release. Rebuild or reinstall Arc.');
    validateToolFiles(release, payload.files, ['release.json']);
    directory = path.join(release, 'skills/arc-sessions');
  } else if (path.basename(executable) === 'arc.cjs' && path.basename(folder) === 'dist') {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, '../package.json'), 'utf8'));
    if (manifest.name !== '@glin/arc') throw new Error('Arc cannot identify this command package.');
    directory = path.join(folder, '../skills/arc-sessions');
  } else {
    throw new Error('Arc cannot find its session skill in this command layout. Rebuild or reinstall Arc.');
  }
  const files = new Map<string, Buffer>();
  const visit = (relative: string): void => {
    const current = path.join(directory, relative);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Arc cannot copy the linked skill path ${current}.`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) visit(relative ? `${relative}/${entry}` : entry);
    } else if (stat.isFile()) {
      files.set(relative, fs.readFileSync(current));
    } else {
      throw new Error(`Arc cannot copy the non-file skill path ${current}.`);
    }
  };
  visit('');
  const definition = files.get('SKILL.md')?.toString('utf8');
  if (!definition?.startsWith('---\n') && !definition?.startsWith('---\r\n'))
    throw new Error('Arc cannot identify its session skill. Rebuild or reinstall Arc.');
  if (!/^name: arc-sessions\r?$/m.test(definition.split(/\r?\n---(?:\r?\n|$)/)[0]))
    throw new Error('Arc cannot identify its session skill. Rebuild or reinstall Arc.');
  for (const [, reference] of definition.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g))
    if (!files.has(reference))
      throw new Error(`Arc cannot find the session skill file ${reference}. Rebuild or reinstall Arc.`);
  const identity = createHash('sha256');
  for (const [relative, bytes] of files) {
    identity.update(JSON.stringify(relative));
    identity.update(':');
    identity.update(createHash('sha256').update(bytes).digest('hex'));
    identity.update('\n');
  }
  return { directory: canonicalToolPath(directory), identity: identity.digest('hex'), files };
}

export interface SkillTemporaryRoot {
  source: string;
  configured: string | undefined;
  state: 'resolved' | 'absent' | 'unresolved';
  canonical?: string;
}

export function skillTemporaryRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runtimeTemporary = os.tmpdir(),
): SkillTemporaryRoot[] {
  const candidates: { source: string; value: string | undefined; required: boolean }[] = [
    ...['TMP', 'TEMP', 'TMPDIR'].map((source) => ({ source, value: env[source], required: true })),
    { source: 'runtime', value: runtimeTemporary, required: true },
  ];
  if (platform === 'win32') {
    for (const [source, base] of [
      ['system', env.SystemRoot ?? env.SYSTEMROOT],
      ['local', env.LOCALAPPDATA],
    ] as const) {
      candidates.push({ source, value: base ? path.join(base, 'Temp') : undefined, required: false });
    }
  } else {
    for (const value of ['/tmp', '/var/tmp']) candidates.push({ source: 'system', value, required: false });
    if (platform === 'darwin') {
      for (const value of ['/private/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'])
        candidates.push({ source: 'system', value, required: false });
    }
  }
  return candidates.map(({ source, value, required }) => {
    if (value === undefined)
      return { source, configured: value, state: source === 'system' || source === 'local' ? 'unresolved' : 'absent' };
    try {
      if (!path.isAbsolute(value)) throw new Error('The temporary folder is not absolute.');
      // Resolve the root itself. Missing configured tails never establish absence or stability.
      const physical = fs.realpathSync.native(value);
      if (!fs.statSync(physical).isDirectory()) throw new Error('The temporary folder is not a directory.');
      return { source, configured: value, state: 'resolved', canonical: canonicalToolPath(physical, platform) };
    } catch (error) {
      return {
        source,
        configured: value,
        state: !required && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unresolved',
      };
    }
  });
}
