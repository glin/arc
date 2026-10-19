import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export function sourceIdentity(sourceRoot, explicitCommit = process.env.ARC_SOURCE_COMMIT) {
  if (explicitCommit !== undefined && (explicitCommit.length !== 40 || !/^[a-f0-9]{40}$/i.test(explicitCommit))) {
    throw new Error('ARC_SOURCE_COMMIT must contain a full forty-character hexadecimal source revision.');
  }
  const supplied = explicitCommit?.toLowerCase();
  const root = fs.realpathSync(sourceRoot);
  const unavailable = { sourceCommit: null, dirty: null };
  if (!fs.existsSync(path.join(root, '.git'))) {
    return supplied ? { sourceCommit: supplied, dirty: null } : unavailable;
  }
  let identity;
  try {
    const git = (args) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
      }).trim();
    if (path.relative(fs.realpathSync(git(['rev-parse', '--show-toplevel'])), root) !== '') {
      throw new Error('The source root differs from the checkout root.');
    }
    identity = { sourceCommit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' };
  } catch {
    if (supplied) throw new Error('Cannot check ARC_SOURCE_COMMIT against the source checkout revision.');
    return unavailable;
  }
  if (supplied && supplied !== identity.sourceCommit) {
    throw new Error('ARC_SOURCE_COMMIT conflicts with the source checkout revision.');
  }
  return identity;
}
