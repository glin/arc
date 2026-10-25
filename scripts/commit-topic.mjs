import { spawnSync } from 'node:child_process';

const [topic, separator, ...args] = process.argv.slice(2);

function refuse(message) {
  console.error(message);
  process.exit(1);
}

if (!topic || separator !== '--')
  refuse('Usage: node scripts/commit-topic.mjs <assigned-topic> -- <git-commit-arguments>');
if (topic === 'main') refuse('Source commits require an assigned topic branch. main is refused.');
for (const key of Object.keys(process.env)) {
  if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/i.test(key))
    refuse(`Unset ${key} before committing from this checkout.`);
}

const branch = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' });
if (branch.error) refuse(branch.error.message);
if (branch.status !== 0) refuse('Source commits require an attached topic branch in a Git checkout.');
const actual = branch.stdout.trim();
if (actual === 'refs/heads/main') refuse('Source commits on main are refused. Switch to the assigned topic branch.');
if (actual !== `refs/heads/${topic}`) refuse(`The checkout branch does not match the assigned topic: ${topic}`);

const result = spawnSync('git', ['commit', ...args], { stdio: 'inherit' });
if (result.error) refuse(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
