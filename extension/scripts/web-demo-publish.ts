// Builds the web demo from this checkout's HEAD and commits it to local gh-pages.
// Run from extension/: node --import tsx scripts/web-demo-publish.ts --message "<subject>" [--remote arc] [--push]
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

export class PublishError extends Error {}

export interface PublishOptions {
  root: string;
  remote: string;
  message: string;
  push: boolean;
  // Writes the checked site into the given empty folder.
  build: (site: string) => void;
}

export type PublishResult =
  | { unchanged: true; source: string }
  | { unchanged: false; source: string; commit: string; pushCommand: string; pushed: boolean };

const BRANCH = 'refs/heads/gh-pages';

// Removes every inherited GIT_ variable. A hook or a rebase gate sets GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE,
// and each one redirects Git away from the -C directory. Windows keys keep their own case, so the match ignores case.
export function gitEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, ...extra };
}

interface GitCall {
  input?: string;
  indexFile?: string;
  allowFailure?: boolean;
}

function git(root: string, args: string[], call: GitCall = {}): { status: number; stdout: string } {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    input: call.input,
    env: gitEnvironment(process.env, call.indexFile ? { GIT_INDEX_FILE: call.indexFile } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new PublishError(`git could not start: ${result.error.message}`);
  const status = result.status ?? 1;
  if (status !== 0 && !call.allowFailure)
    throw new PublishError(`git ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
  return { status, stdout: result.stdout.trim() };
}

function revision(root: string, name: string): string {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`]).stdout;
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const { status } = git(root, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  if (status > 1) throw new PublishError(`git could not compare ${ancestor} with ${descendant}`);
  return status === 0;
}

// HEAD and the tracked changes. --no-optional-locks keeps status from rewriting the real index.
export function checkoutState(root: string): { head: string; changes: string } {
  return {
    head: revision(root, 'HEAD'),
    changes: git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=no']).stdout,
  };
}

// Fetches the remote's main and gh-pages, then returns HEAD when the checkout is clean and the remote's main holds it.
export function checkSource(root: string, remote: string): string {
  git(root, [
    'fetch',
    '--quiet',
    '--end-of-options',
    remote,
    `+refs/heads/main:refs/remotes/${remote}/main`,
    `+refs/heads/gh-pages:refs/remotes/${remote}/gh-pages`,
  ]);
  const { head, changes } = checkoutState(root);
  if (changes)
    throw new PublishError(`Tracked files differ from HEAD. Commit or remove these changes first:\n${changes}`);
  if (!isAncestor(root, head, `refs/remotes/${remote}/main`))
    throw new PublishError(`${remote}/main does not hold HEAD ${head}. Push main to ${remote} first.`);
  return head;
}

function siteFiles(site: string, folder = site): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...siteFiles(site, file));
    else if (entry.isFile()) files.push(file);
    else throw new PublishError(`The site holds an entry that is not a file or a folder: ${file}`);
  }
  return files;
}

// Writes the site's blobs and returns a tree of the site plus an empty .nojekyll.
// The tree comes from the given index file, so the real index and the working tree stay untouched.
// --no-filters stores the built bytes without line-ending or attribute conversion.
export function siteTree(root: string, site: string, indexFile: string): string {
  const files = siteFiles(site);
  const blobs = files.length
    ? git(root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
        input: files.join('\n') + '\n',
      }).stdout.split(/\r?\n/)
    : [];
  const entries = new Map<string, string>();
  files.forEach((file, index) => entries.set(path.relative(site, file).split(path.sep).join('/'), blobs[index]));
  entries.set('.nojekyll', git(root, ['hash-object', '-w', '--stdin'], { input: '' }).stdout);
  const list = [...entries].map(([name, blob]) => `100644 ${blob}\t${name}\n`).join('');
  git(root, ['update-index', '--add', '--index-info'], { input: list, indexFile });
  return git(root, ['write-tree'], { indexFile }).stdout;
}

// Commits the site on top of <remote>/gh-pages and moves local gh-pages to it. Pushes only when asked.
export function commitSite(
  root: string,
  remote: string,
  site: string,
  indexFile: string,
  source: string,
  message: string,
  push: boolean,
): PublishResult {
  const parent = revision(root, `refs/remotes/${remote}/gh-pages`);
  const tree = siteTree(root, site, indexFile);
  if (tree === git(root, ['rev-parse', '--verify', `${parent}^{tree}`]).stdout) return { unchanged: true, source };
  const local = git(root, ['rev-parse', '--verify', '--quiet', BRANCH], {
    allowFailure: true,
  }).stdout;
  if (local && !isAncestor(root, local, parent))
    throw new PublishError(`Local gh-pages holds commits that ${remote}/gh-pages lacks. Push or move them first.`);
  const checkedOut = git(root, ['worktree', 'list', '--porcelain']).stdout.split(/\r?\n/).includes(`branch ${BRANCH}`);
  if (checkedOut) throw new PublishError('A worktree has gh-pages checked out. Remove that worktree first.');
  const commit = git(root, ['commit-tree', tree, '-p', parent, '-F', '-'], {
    input: `docs(demo): ${message}\n\nSource: ${source}\n`,
  }).stdout;
  git(root, ['update-ref', '-m', 'web-demo-publish', BRANCH, commit, local || '0'.repeat(commit.length)]);
  const pushArgs = ['push', remote, 'gh-pages:gh-pages'];
  if (push) git(root, pushArgs);
  return {
    unchanged: false,
    source,
    commit,
    pushCommand: `git ${pushArgs.join(' ')}`,
    pushed: push,
  };
}

// Runs every step in order. The temporary folder holds the site and the index file, and it leaves on every outcome.
export function publish(options: PublishOptions): PublishResult {
  const { root, remote, message, push, build } = options;
  if (!message.trim() || /[\r\n]/.test(message)) throw new PublishError('--message needs a one-line subject.');
  if (!remote || remote.startsWith('-')) throw new PublishError('--remote needs a remote name.');
  const source = checkSource(root, remote);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-web-demo-publish-'));
  try {
    const site = path.join(work, 'site');
    fs.mkdirSync(site);
    build(site);
    const after = checkoutState(root);
    if (after.head !== source || after.changes)
      throw new PublishError('The checkout changed during the build. Run the script again on a quiet checkout.');
    return commitSite(root, remote, site, path.join(work, 'index'), source, message, push);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function run(name: string, cwd: string, args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw new PublishError(`${name} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new PublishError(`${name} failed.`);
}

// Builds the site with web-demo.ts and checks it with check-web-demo-site.mjs. Neither step runs npm.
export function buildDemo(root: string, site: string): void {
  run('web-demo.ts', path.join(root, 'extension'), [
    '--import',
    'tsx',
    path.join(root, 'extension', 'scripts', 'web-demo.ts'),
    site,
  ]);
  run('check-web-demo-site.mjs', root, [path.join(root, '.github', 'scripts', 'check-web-demo-site.mjs'), site]);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      message: { type: 'string' },
      remote: { type: 'string', default: 'arc' },
      push: { type: 'boolean', default: false },
    },
  });
  const root = path.resolve(__dirname, '..', '..');
  const result = publish({
    root,
    remote: values.remote ?? 'arc',
    message: values.message ?? '',
    push: values.push ?? false,
    build: (site) => buildDemo(root, site),
  });
  console.log(`Source: ${result.source}`);
  if (result.unchanged) {
    console.log('The demo site is unchanged.');
    return;
  }
  console.log(`Local gh-pages: ${result.commit}`);
  console.log(result.pushed ? `Pushed gh-pages to ${values.remote}.` : `Push it with: ${result.pushCommand}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
