import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function measurementBuildPath(scratch: string, tree: string, platform = process.platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.relative(paths.resolve(scratch, 'build'), paths.resolve(tree)) === '';
}

// Only the disposable detached build belongs to this measurement.
export function removeMeasurementTree(repository: string, scratch: string, tree: string): void {
  if (!measurementBuildPath(scratch, tree)) throw new Error(`Cleanup path is outside the measurement build: ${tree}`);
  let root: fs.Stats;
  try {
    root = fs.lstatSync(tree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory())
    throw new Error(`Measurement build is not a plain directory: ${tree}`);
  const git = (args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  const entries = git(['worktree', 'list', '--porcelain', '-z']).split('\0\0');
  const canonical = fs.realpathSync(tree);
  let admitted = false;
  for (const [index, entry] of entries.entries()) {
    const fields = entry.split('\0');
    const named = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!named || !fs.existsSync(named)) continue;
    const relative = path.relative(canonical, fs.realpathSync(named));
    if (relative === '') {
      admitted = index > 0 && fields.includes('detached') && !fields.some((field) => /^locked(?: |$)/.test(field));
    } else if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      throw new Error(`Measurement build contains another worktree: ${named}`);
    }
  }
  if (!admitted) throw new Error(`Measurement build is not an unlocked detached worktree: ${tree}`);

  const marker = path.join(canonical, '.git');
  const markerInfo = fs.lstatSync(marker);
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile())
    throw new Error(`Measurement build Git marker is not a plain file: ${marker}`);
  const registration = execFileSync('git', ['-C', tree, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
  }).trim();
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const backlink = fs.readFileSync(path.join(registration, 'gitdir'), 'utf8').trim();
  if (
    path.relative(path.join(common, 'worktrees'), path.dirname(registration)) !== '' ||
    !path.isAbsolute(backlink) ||
    path.relative(marker, backlink) !== ''
  )
    throw new Error(`Measurement build registration does not match its checkout: ${tree}`);

  const directories = new Map<string, fs.Stats>();
  const scan = (directory: string, device = root.dev): void => {
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== device) {
      throw new Error(`Measurement directory changed or crosses a filesystem: ${directory}`);
    }
    directories.set(directory, info);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (directory !== tree && name.toLowerCase() === '.git')
        throw new Error(`Measurement build contains a nested checkout: ${directory}`);
      const stat = fs.lstatSync(file);
      if (!stat.isSymbolicLink() && stat.isDirectory()) scan(file, device);
    }
  };
  scan(tree);
  scan(registration, fs.lstatSync(registration).dev);
  const remove = (directory: string): void => {
    const before = directories.get(directory);
    const current = fs.lstatSync(directory);
    if (
      !before ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    ) {
      throw new Error(`Measurement directory changed during cleanup: ${directory}`);
    }
    // Keep Git registration available if an earlier deletion fails.
    const names = fs
      .readdirSync(directory)
      .sort((a, b) => Number(a.toLowerCase() === '.git') - Number(b.toLowerCase() === '.git'));
    for (const name of names) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fs.unlinkSync(file);
      else if (stat.isDirectory()) remove(file);
      else fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  };
  remove(tree);
  remove(registration);
}
