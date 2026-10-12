import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export function canonicalToolPath(value: string, platform = process.platform): string {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try {
      current = path.join(fs.realpathSync.native(current), ...tail.reverse());
      return platform === 'win32' ? current.toLowerCase() : current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// Existing redirects never establish permission to write through their targets.
export function admitToolPath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Arc setup needs an absolute installation folder.');
  for (let folder = path.normalize(value); ; folder = path.dirname(folder)) {
    try {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Arc setup cannot use the redirected or non-directory folder ${folder}.`);
      if (process.platform !== 'win32' && stat.uid !== process.getuid?.() && folder === value)
        throw new Error(`Arc setup cannot write to another user's folder ${folder}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.dirname(folder) === folder) break;
  }
  return canonicalToolPath(value);
}

export function acquireToolLock(file: string): { file: string; token: string; release(): void } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const owner = JSON.stringify({ token, pid: process.pid });
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Another Arc setup owns ${file}. Close its processes before resolving retained ownership manually.`,
        {
          cause: error,
        },
      );
    throw error;
  }
  try {
    fs.writeFileSync(fd, owner);
  } finally {
    fs.closeSync(fd);
  }
  return {
    file,
    token,
    release: () => {
      try {
        if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file);
      } catch {
        /* Preserve uncertain ownership. */
      }
    },
  };
}

export function retainedToolOwnership(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if ('retainOwnership' in error && error.retainOwnership === true) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}
