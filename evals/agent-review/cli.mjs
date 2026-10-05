#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = path.dirname(fileURLToPath(import.meta.url));
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const id = /^[a-z][a-z0-9-]*$/;
const isId = (value) => typeof value === 'string' && id.test(value);
const isHex40 = (value) => typeof value === 'string' && hex40.test(value);
const isHex64 = (value) => typeof value === 'string' && hex64.test(value);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const dictionary = () => Object.create(null);
const fail = (message) => {
  throw new Error(message);
};
const required = (condition, message) => {
  if (!condition) fail(message);
};
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const catalogArg = process.argv.indexOf('--catalog');
const catalogFolder = catalogArg < 0 ? path.join(suite, 'cases') : path.resolve(process.argv[catalogArg + 1] ?? '');
const write = (file, value) => writeFileSync(file, json(value), { flag: 'wx' });
const real = (file) => path.resolve(file);
const physicalDestination = (file) => {
  let parent = real(file);
  const suffix = [];
  while (!existsSync(parent)) {
    suffix.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  const resolved = realpathSync.native(parent);
  required(resolved.toLowerCase() === parent.toLowerCase(), 'linked output parent');
  return path.join(resolved, ...suffix);
};
const inside = (child, parent) => {
  const relative = path.relative(real(parent), real(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const positive = (n) => Number.isFinite(n) && n > 0;
const count = (n, max = 1000) => Number.isSafeInteger(n) && n > 0 && n <= max;
const revision = (n) => Number.isSafeInteger(n) && n > 0;
const unique = (values, label) => required(new Set(values).size === values.length, 'duplicate ' + label);

function git(repository, args, input) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    input,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  required(result.status === 0, `git ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function loadCases(folder) {
  const loaded = readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => read(path.join(folder, name)));
  unique(
    loaded.map((item) => item.id),
    'case id',
  );
  for (const item of loaded) caseCheck(item);
  return loaded;
}

function checkPath(name) {
  required(typeof name === 'string' && name !== '' && !name.includes('\\') && !name.includes('\0'), 'unsafe path');
  required(!path.posix.isAbsolute(name) && !/^[a-z]:/i.test(name), 'absolute path');
  const parts = name.split('/');
  required(
    parts.every((part) => part !== '' && part !== '.' && part !== '..'),
    'path traversal',
  );
  required(
    parts.every((part) => part.toLowerCase() !== '.git'),
    'git path',
  );
  required(
    parts.every((part) => !/[<>:"|?*\x00-\x1f]/u.test(part)),
    'unsafe Git name',
  );
  required(
    parts.every((part) => !/[. ]$/u.test(part)),
    'trailing path alias',
  );
  required(
    parts.every((part) => !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(part)),
    'device path',
  );
}

function caseCheck(item) {
  required(item.schema === 'arc-review-case-v1' && isId(item.id), 'case schema or id');
  required(
    ['accepted_review', 'escaped_candidate', 'deferred_candidate', 'clean_control'].includes(item.source_kind),
    'source kind',
  );
  required(isId(item.family) && revision(item.case_revision) && revision(item.key_revision), 'case revision or family');
  required(item.source && typeof item.source === 'object', 'source commits');
  for (const role of ['base', 'candidate', 'correction']) required(isHex40(item.source[role]), 'source commit');
  required(['historical-partial', 'reviewed'].includes(item.key_state), 'key state');
  required(Array.isArray(item.keys), 'keys');
  if (item.source_kind === 'clean_control')
    required(
      item.keys.length === 0 &&
        item.key_state === 'reviewed' &&
        item.control_audit?.condition === 'audited-no-blocker' &&
        isHex64(item.control_audit.evidence_sha256),
      'clean control audit',
    );
  else
    required(
      item.keys.some((key) => ['high', 'medium'].includes(key.severity)),
      'missing serious key denominator',
    );
  unique(
    item.keys.map((key) => key.id),
    'key id',
  );
  for (const key of item.keys) {
    required(isId(key.id) && ['high', 'medium', 'low'].includes(key.severity), 'key schema');
    required(typeof key.summary === 'string' && key.summary.length > 10, 'key summary');
    required(
      key.evidence && ['accepted', 'deferred', 'reported'].includes(key.evidence.disposition),
      'key disposition',
    );
    required(
      ['review', 'later-symptom'].includes(key.evidence.mode) &&
        ['candidate', 'correction'].includes(key.evidence.reach),
      'key evidence mode or reach',
    );
    required(typeof key.evidence.scope === 'string' && key.evidence.scope.length > 5, 'key evidence scope');
    required(
      typeof key.evidence.source === 'string' && key.evidence.source.length > 5 && isHex64(key.evidence.sha256),
      'key evidence source',
    );
    required(
      Array.isArray(key.evidence.exclude_attempt_ids) && key.evidence.exclude_attempt_ids.every(isId),
      'key source attempts',
    );
    required(['known', 'unresolved'].includes(key.evidence.source_attempt_identity), 'key source identity');
    required(
      key.evidence.source_attempt_identity !== 'known' || key.evidence.exclude_attempt_ids.length > 0,
      'missing source exclusions',
    );
    for (const file of key.paths) checkPath(file);
  }
  for (const file of item.fixture_paths) checkPath(file);
  required(item.historical_context.original_prompt === null, 'historical prompt is unverified');
  required(item.historical_context.plan === null, 'historical plan is unverified');
}

const cases = loadCases(catalogFolder);

function sourceTree(repository, commit) {
  const entries = git(repository, ['ls-tree', '-rz', '--full-tree', commit])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const found = new Map();
  return entries.map((entry) => {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(entry);
    required(match, 'invalid tree entry');
    const [, mode, type, object, name] = match;
    checkPath(name);
    required(['100644', '100755', '120000', '160000'].includes(mode), 'unsupported tree mode: ' + name);
    required(type === 'blob' || type === 'commit', 'non-blob tree entry');
    const parts = name.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const folded = prefix.toLowerCase();
      const previous = found.get(folded);
      required(!previous || previous.name === prefix, 'duplicate case-insensitive path: ' + name);
      required(!previous || previous.file === (index === parts.length), 'file and directory path: ' + name);
      if (index === parts.length) required(!previous, 'duplicate case-insensitive path: ' + name);
      else if (!previous) found.set(folded, { name: prefix, file: false });
    }
    found.set(name.toLowerCase(), { name, file: true });
    return { name, mode, object };
  });
}

function inventory(cache) {
  const objects = git(cache, ['rev-list', '--objects', '--all'])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[0])
    .sort();
  unique(objects, 'captured object');
  return { count: objects.length, sha256: sha(objects.join('\n') + '\n') };
}

function validate(cache) {
  const manifest = read(path.join(cache, 'evidence.json'));
  required(manifest.schema === 'arc-review-cache-v1', 'cache schema');
  required(git(cache, ['rev-parse', '--is-bare-repository']).toString('utf8').trim() === 'true', 'cache must be bare');
  required(
    typeof manifest.source_root === 'string' &&
      (path.win32.isAbsolute(manifest.source_root) || path.posix.isAbsolute(manifest.source_root)),
    'source root',
  );
  required(Array.isArray(manifest.cases) && manifest.cases.length === cases.length, 'cache case list');
  const expected = new Map(cases.map((item) => [item.id, item]));
  unique(
    manifest.cases.map((item) => item.id),
    'captured case',
  );
  required(!existsSync(path.join(cache, 'objects', 'info', 'alternates')), 'object alternate');
  required(!existsSync(path.join(cache, 'config.worktree')), 'cache worktree');
  for (const dir of ['objects', 'objects/pack']) {
    if (!existsSync(path.join(cache, dir))) continue;
    for (const entry of readdirSync(path.join(cache, dir), { withFileTypes: true })) {
      const candidate = path.join(cache, dir, entry.name);
      if (entry.isFile()) required(statSync(candidate).nlink === 1, 'linked cache object');
      if (dir === 'objects' && entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
        for (const object of readdirSync(candidate))
          required(statSync(path.join(candidate, object)).nlink === 1, 'linked cache object');
    }
  }
  const config = git(cache, ['remote']).toString('utf8').trim();
  required(config === '', 'source remote');
  for (const captured of manifest.cases) {
    const item = expected.get(captured.id);
    required(item, 'unknown captured case');
    caseCheck(item);
    required(captured.case_sha256 === sha(json(item)), 'changed case definition');
    for (const role of ['base', 'candidate', 'correction']) {
      required(captured[role] === item.source[role], 'changed source commit');
      required(
        git(cache, ['rev-parse', `refs/evals/${item.id}/${role}`])
          .toString('utf8')
          .trim() === captured[role],
        'changed capture ref',
      );
      required(
        git(cache, ['cat-file', '-t', captured[role]]).toString('utf8').trim() === 'commit',
        'missing captured commit',
      );
      sourceTree(cache, captured[role]);
    }
    const candidatePaths = new Set(sourceTree(cache, item.source.candidate).map((entry) => entry.name));
    for (const file of item.fixture_paths) required(candidatePaths.has(file), 'dangling fixture path: ' + file);
    for (const key of item.keys)
      for (const file of key.paths) required(candidatePaths.has(file), 'dangling key path: ' + file);
  }
  git(cache, ['fsck', '--full', '--no-reflogs']);
  const current = inventory(cache);
  required(
    current.count === manifest.inventory.count && current.sha256 === manifest.inventory.sha256,
    'capture inventory changed',
  );
  return manifest;
}

function capture(repository, out) {
  physicalDestination(out);
  required(existsSync(repository), 'source must exist');
  required(!existsSync(out), 'cache must be fresh');
  required(!inside(out, repository) || inside(out, path.join(suite, '.runs')), 'cache inside source');
  for (const item of cases) {
    caseCheck(item);
    for (const role of ['base', 'candidate', 'correction']) {
      required(
        git(repository, ['cat-file', '-t', item.source[role]]).toString('utf8').trim() === 'commit',
        'missing source commit',
      );
      sourceTree(repository, item.source[role]);
    }
  }
  mkdirSync(out, { recursive: true });
  git(out, ['init', '--bare', '--quiet']);
  const commits = [...new Set(cases.flatMap((item) => Object.values(item.source)))];
  const pack = git(repository, ['pack-objects', '--stdout', '--revs'], commits.join('\n') + '\n');
  git(out, ['unpack-objects', '-r'], pack);
  for (const item of cases)
    for (const role of ['base', 'candidate', 'correction'])
      git(out, ['update-ref', `refs/evals/${item.id}/${role}`, item.source[role]]);
  const manifest = {
    schema: 'arc-review-cache-v1',
    source_root: real(repository),
    cases: cases.map((item) => ({
      id: item.id,
      case_sha256: sha(json(item)),
      ...item.source,
    })),
    inventory: inventory(out),
  };
  write(path.join(out, 'evidence.json'), manifest);
  validate(out);
  return manifest;
}

function excluded(name) {
  const parts = name.toLowerCase().split('/');
  if (parts.some((part) => ['.claude', '.codex', '.agents', '.git', 'node_modules', 'ship-logs'].includes(part)))
    return 'private agent or generated material';
  if (parts.some((part) => ['plans', 'reviews', 'scores', 'results', 'transcripts', 'rollouts'].includes(part)))
    return 'answer or prior review material';
  if (/\.(log|out)$/i.test(name)) return 'run output';
  return null;
}

const reviewPrompt =
  'Review the candidate change for material defects. Report each finding with its file, severity, failure scenario, and evidence. The workspace is the candidate tree. The diff is supplied separately.\n';

function candidateDiff(cache, item, base, all) {
  const changed = git(cache, ['diff', '--name-only', '-z', '--no-renames', item.source.base, item.source.candidate])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const known = new Map([...base, ...all].map((entry) => [entry.name, entry]));
  const removed = [];
  const diffPaths = [];
  for (const name of changed) {
    checkPath(name);
    required(known.has(name), 'changed path missing from trees');
    const reason = excluded(name);
    if (reason) {
      if (base.some((entry) => entry.name === name)) removed.push({ path: name, side: 'base diff', reason });
      if (!all.some((entry) => entry.name === name)) removed.push({ path: name, side: 'candidate diff', reason });
    } else diffPaths.push(name);
  }
  const bytes = Buffer.concat(
    Array.from({ length: Math.ceil(diffPaths.length / 40) }, (_, index) =>
      git(cache, [
        'diff',
        '--binary',
        '--no-renames',
        item.source.base,
        item.source.candidate,
        '--',
        ...diffPaths.slice(index * 40, (index + 1) * 40).map((name) => ':(literal)' + name),
      ]),
    ),
  );
  return { bytes, removed };
}

function prepare(cache, caseId, out) {
  physicalDestination(out);
  const captureManifest = validate(cache);
  const item = cases.find((entry) => entry.id === caseId);
  required(item, 'unknown case');
  required(!existsSync(out), 'output must be fresh');
  const localSource =
    process.platform === 'win32'
      ? /^(?:[a-z]:[\\/]|\\\\)/i.test(captureManifest.source_root)
      : captureManifest.source_root.startsWith('/');
  required(
    !inside(out, cache) &&
      !inside(out, path.resolve(suite, '../..')) &&
      (!localSource || !inside(out, captureManifest.source_root)),
    'output inside source or cache',
  );
  const all = sourceTree(cache, item.source.candidate);
  const base = sourceTree(cache, item.source.base);
  const removed = [];
  const kept = all.filter((entry) => {
    const reason = excluded(entry.name);
    if (reason) removed.push({ path: entry.name, side: 'candidate', reason });
    return !reason;
  });
  for (const entry of kept)
    required(entry.mode === '100644' || entry.mode === '100755', 'symlink or submodule in workspace: ' + entry.name);
  for (const file of item.fixture_paths)
    required(
      kept.some((entry) => entry.name === file),
      'fixture removed: ' + file,
    );
  for (const key of item.keys)
    for (const file of key.paths)
      required(
        kept.some((entry) => entry.name === file),
        'key path removed: ' + file,
      );
  const correction = item.source.correction.toLowerCase();
  const keyIds = item.keys.map((key) => key.id.toLowerCase());
  const contents = kept.map((entry) => {
    const bytes = git(cache, ['cat-file', 'blob', entry.object]);
    const body = bytes.toString('utf8').toLowerCase();
    required(
      !body.includes(correction) && !keyIds.some((key) => body.includes(key)),
      'direct answer leak: ' + entry.name,
    );
    return { ...entry, bytes };
  });
  mkdirSync(path.join(out, 'workspace'), { recursive: true });
  const workspace = path.join(out, 'workspace');
  for (const entry of contents) {
    const dest = path.join(workspace, ...entry.name.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, entry.bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    if (process.platform !== 'win32') chmodSync(dest, entry.mode === '100755' ? 0o755 : 0o644);
  }
  const { bytes: diff, removed: diffRemoved } = candidateDiff(cache, item, base, all);
  removed.push(...diffRemoved);
  const diffText = diff.toString('utf8').toLowerCase();
  required(
    !diffText.includes(correction) && !keyIds.some((key) => diffText.includes(key)),
    'direct answer leak in diff',
  );
  writeFileSync(path.join(out, 'candidate.diff'), diff, { flag: 'wx' });
  const prompt = reviewPrompt;
  writeFileSync(path.join(out, 'prompt.txt'), prompt, { flag: 'wx' });
  const workspaceHash = sha(
    contents
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.name}\0${entry.mode}\0${sha(entry.bytes)}\n`)
      .join(''),
  );
  const manifest = {
    schema: 'arc-review-preparation-v1',
    case_id: item.id,
    case_revision: item.case_revision,
    key_revision: item.key_revision,
    case_hash: sha(json(item)),
    source: item.source,
    workspace_hash: workspaceHash,
    prompt_hash: sha(prompt),
    diff_hash: sha(diff),
    files: contents.map((entry) => ({
      path: entry.name,
      git_object: entry.object,
      mode: entry.mode,
      source_commit: item.source.candidate,
      sha256: sha(entry.bytes),
    })),
    removal_accounting: removed,
    limitations: [
      'historical context unverified',
      'semantic answer leaks not certified',
      'host access isolation not certified',
    ],
  };
  write(path.join(out, 'manifest.json'), { ...manifest, manifest_hash: sha(json(manifest)) });
  return manifest;
}

function preparationCheck(task, item) {
  required(typeof task.preparation_path === 'string', 'preparation path');
  required(typeof task.cache_path === 'string', 'cache path');
  const cache = real(task.cache_path);
  validate(cache);
  const root = real(task.preparation_path);
  const manifest = read(path.join(root, 'manifest.json'));
  const { manifest_hash, ...body } = manifest;
  required(isHex64(manifest_hash) && manifest_hash === sha(json(body)), 'preparation manifest hash');
  required(manifest.schema === 'arc-review-preparation-v1', 'preparation schema');
  required(json(manifest.source) === json(item.source), 'preparation source');
  for (const [field, expected] of Object.entries({
    case_id: task.case_id,
    case_revision: task.case_revision,
    key_revision: task.key_revision,
    case_hash: task.case_hash,
    prompt_hash: task.prompt_hash,
    workspace_hash: task.workspace_hash,
    diff_hash: task.diff_hash,
  }))
    required(manifest[field] === expected, 'preparation condition: ' + field);
  required(readFileSync(path.join(root, 'prompt.txt')).equals(Buffer.from(reviewPrompt)), 'changed prepared prompt');
  required(sha(reviewPrompt) === manifest.prompt_hash, 'changed prepared prompt');
  const all = sourceTree(cache, item.source.candidate);
  const base = sourceTree(cache, item.source.base);
  const expectedFiles = all.filter((entry) => !excluded(entry.name));
  const expectedPaths = new Map(expectedFiles.map((entry) => [entry.name, entry]));
  const expectedRemoval = all
    .filter((entry) => excluded(entry.name))
    .map((entry) => ({ path: entry.name, side: 'candidate', reason: excluded(entry.name) }));
  const { bytes: expectedDiff, removed: diffRemoval } = candidateDiff(cache, item, base, all);
  expectedRemoval.push(...diffRemoval);
  required(json(manifest.removal_accounting) === json(expectedRemoval), 'preparation removal accounting');
  required(readFileSync(path.join(root, 'candidate.diff')).equals(expectedDiff), 'changed prepared diff');
  required(sha(expectedDiff) === manifest.diff_hash, 'changed prepared diff');
  const diffText = expectedDiff.toString('utf8').toLowerCase();
  required(
    !diffText.includes(item.source.correction.toLowerCase()) &&
      !item.keys.some((key) => diffText.includes(key.id.toLowerCase())),
    'direct answer leak in diff',
  );
  required(Array.isArray(manifest.files), 'preparation file inventory');
  for (const file of item.fixture_paths) required(expectedPaths.has(file), 'fixture removed: ' + file);
  for (const key of item.keys)
    for (const file of key.paths) required(expectedPaths.has(file), 'key path removed: ' + file);
  required(manifest.files.length === expectedFiles.length, 'preparation source inventory');
  const workspace = path.join(root, 'workspace');
  const actual = [];
  function walk(folder, prefix = '') {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      checkPath(name);
      if (entry.isDirectory()) walk(path.join(folder, entry.name), name);
      else {
        required(entry.isFile(), 'linked prepared workspace');
        actual.push(name);
      }
    }
  }
  walk(workspace);
  unique(
    manifest.files.map((file) => file.path),
    'prepared path',
  );
  required(json(actual.sort()) === json(manifest.files.map((file) => file.path).sort()), 'changed workspace inventory');
  for (const file of manifest.files) {
    checkPath(file.path);
    required(
      isHex40(file.git_object) && isHex64(file.sha256) && file.source_commit === item.source.candidate,
      'prepared file metadata',
    );
    required(['100644', '100755'].includes(file.mode), 'prepared file mode');
    const source = expectedPaths.get(file.path);
    required(source && source.object === file.git_object && source.mode === file.mode, 'prepared source file');
    const bytes = readFileSync(path.join(workspace, ...file.path.split('/')));
    required(sha(bytes) === file.sha256, 'changed prepared file');
    required(bytes.equals(git(cache, ['cat-file', 'blob', source.object])), 'changed source blob');
    const body = bytes.toString('utf8').toLowerCase();
    required(
      !body.includes(item.source.correction.toLowerCase()) &&
        !item.keys.some((key) => body.includes(key.id.toLowerCase())),
      'direct answer leak: ' + file.path,
    );
    if (process.platform !== 'win32')
      required(
        (statSync(path.join(workspace, ...file.path.split('/'))).mode & 0o111 ? '100755' : '100644') === file.mode,
        'changed prepared mode',
      );
  }
  const computed = sha(
    [...manifest.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => `${file.path}\0${file.mode}\0${file.sha256}\n`)
      .join(''),
  );
  required(computed === manifest.workspace_hash, 'changed workspace hash');
  return {
    manifest_hash,
    case_id: manifest.case_id,
    case_revision: manifest.case_revision,
    key_revision: manifest.key_revision,
    case_hash: manifest.case_hash,
    prompt_hash: manifest.prompt_hash,
    workspace_hash: manifest.workspace_hash,
    diff_hash: manifest.diff_hash,
  };
}

function registrationCheck(registration, verifyPreparation) {
  required(registration.schema === 'arc-review-registration-v1', 'registration schema');
  required(typeof registration.suite_revision === 'string' && registration.suite_revision.length > 0, 'suite revision');
  required(
    isHex64(registration.seed) && Array.isArray(registration.tasks) && registration.tasks.length > 0,
    'seed or tasks',
  );
  unique(
    registration.tasks.map((task) => task.case_id),
    'task',
  );
  required(Array.isArray(registration.arms) && registration.arms.length > 0, 'arms');
  required(registration.tasks.length <= 100 && registration.arms.length <= 20, 'matrix size');
  required(
    registration.tasks.reduce((total, task) => total + task.repeats * task.temporal_blocks, 0) *
      registration.arms.length <=
      100000,
    'matrix size',
  );
  unique(
    registration.arms.map((arm) => arm.id),
    'arm',
  );
  for (const arm of registration.arms) {
    required(
      isId(arm.id) &&
        ['model_id', 'requested_effort', 'harness'].every(
          (field) => typeof arm[field] === 'string' && arm[field].trim() !== '',
        ),
      'arm fields',
    );
    required(
      (arm.observed_effort_required === true && arm.unverified_harness !== true) ||
        (arm.unverified_harness === true && arm.observed_effort_required !== true),
      'effort readback condition',
    );
  }
  for (const task of registration.tasks) {
    const item = cases.find((entry) => entry.id === task.case_id);
    required(
      item && task.case_revision === item.case_revision && task.key_revision === item.key_revision,
      'task case revision',
    );
    required(
      task.case_hash === sha(json(item)) &&
        isHex64(task.prompt_hash) &&
        isHex64(task.workspace_hash) &&
        isHex64(task.diff_hash),
      'task hashes',
    );
    required(
      task.source_kind === item.source_kind && task.family === item.family && task.key_state === item.key_state,
      'task condition',
    );
    required(count(task.repeats, 100) && count(task.temporal_blocks, 100), 'repeat or block count');
    required(positive(task.budget_usd) && count(task.max_attempts ?? 1, 2), 'budget or attempts');
    if (verifyPreparation) task.prepared = preparationCheck(task, item);
    else
      required(
        task.prepared &&
          ['case_id', 'case_revision', 'key_revision', 'case_hash', 'prompt_hash', 'workspace_hash', 'diff_hash'].every(
            (field) => task.prepared[field] === task[field],
          ) &&
          isHex64(task.prepared.manifest_hash),
        'frozen preparation',
      );
  }
}

function matrix(input, verifyPreparation = true) {
  const registration = structuredClone(input);
  registrationCheck(registration, verifyPreparation);
  for (const task of registration.tasks) {
    delete task.preparation_path;
    delete task.cache_path;
  }
  const registration_hash = sha(json(registration));
  const cells = [];
  for (const task of registration.tasks)
    for (let block = 1; block <= task.temporal_blocks; block++) {
      for (let replicate = 1; replicate <= task.repeats; replicate++) {
        const arms = [...registration.arms].sort((a, b) =>
          sha(`${registration.seed}:${task.case_id}:${block}:${replicate}:${a.id}`).localeCompare(
            sha(`${registration.seed}:${task.case_id}:${block}:${replicate}:${b.id}`),
          ),
        );
        for (const [order, arm] of arms.entries()) {
          const cell_id = sha(`${registration_hash}:${task.case_id}:${arm.id}:${replicate}:${block}`);
          cells.push({
            cell_id,
            registration_hash,
            suite_revision: registration.suite_revision,
            case_id: task.case_id,
            case_revision: task.case_revision,
            key_revision: task.key_revision,
            case_hash: task.case_hash,
            prompt_hash: task.prompt_hash,
            workspace_hash: task.workspace_hash,
            diff_hash: task.diff_hash,
            preparation_manifest_hash: task.prepared.manifest_hash,
            source_kind: task.source_kind,
            family: task.family,
            key_state: task.key_state,
            arm_id: arm.id,
            model_id: arm.model_id,
            requested_effort: arm.requested_effort,
            harness: arm.harness,
            observed_effort_required: arm.observed_effort_required === true,
            unverified_harness: arm.unverified_harness === true,
            temporal_block: block,
            replicate,
            order: order + 1,
            budget_usd: task.budget_usd,
            max_attempts: task.max_attempts ?? 1,
          });
        }
      }
    }
  return { schema: 'arc-review-matrix-v1', registration_hash, registration, cells };
}

function attemptCheck(attempt, ordinal, expected) {
  required(isId(attempt.attempt_id) && attempt.attempt_number === ordinal, 'attempt identity or order');
  required(['completed', 'model-failure', 'budget-exhausted', 'void'].includes(attempt.status), 'attempt status');
  required(attempt.cost_usd === null || (Number.isFinite(attempt.cost_usd) && attempt.cost_usd >= 0), 'attempt cost');
  required(attempt.wall_ms === null || (Number.isFinite(attempt.wall_ms) && attempt.wall_ms >= 0), 'attempt wall time');
  for (const field of ['requests', 'tokens', 'tool_calls'])
    required(attempt[field] === null || (Number.isSafeInteger(attempt[field]) && attempt[field] >= 0), 'attempt usage');
  required(Array.isArray(attempt.matched_key_ids) && Array.isArray(attempt.novel_findings), 'attempt findings');
  required(attempt.matched_key_ids.every(isId), 'matched key id');
  unique(attempt.matched_key_ids, 'matched key');
  unique(
    attempt.novel_findings.map((finding) => finding.id),
    'novel finding',
  );
  for (const finding of attempt.novel_findings)
    required(
      isId(finding.id) && typeof finding.serious === 'boolean' && typeof finding.true_finding === 'boolean',
      'novel finding',
    );
  required(Number.isSafeInteger(attempt.false_claims) && attempt.false_claims >= 0, 'false claims');
  required(attempt.wrong_verdict === null || typeof attempt.wrong_verdict === 'boolean', 'wrong verdict');
  required(attempt.verdict === null || ['approve', 'reject'].includes(attempt.verdict), 'verdict');
  if (attempt.status === 'void')
    required(['infrastructure', 'condition-mismatch'].includes(attempt.reason), 'void reason');
  else required(attempt.reason === null, 'nonvoid reason');
  if (expected.observed_effort_required && attempt.status !== 'void')
    required(attempt.observed_effort === expected.requested_effort, 'observed effort mismatch');
  if (attempt.status === 'void')
    required(attempt.matched_key_ids.length === 0 && attempt.novel_findings.length === 0, 'void findings');
}

function summarize(frozen, input, allowPartial) {
  required(
    frozen.schema === 'arc-review-matrix-v1' && frozen.registration_hash === sha(json(frozen.registration)),
    'matrix hash',
  );
  const expectedMatrix = matrix(frozen.registration, false);
  required(json(expectedMatrix) === json(frozen), 'changed matrix');
  required(input.schema === 'arc-review-cells-v1' && Array.isArray(input.cells), 'cell results schema');
  const expected = new Map(frozen.cells.map((cell) => [cell.cell_id, cell]));
  const seen = new Set();
  const seenAttempts = new Set();
  const results = [];
  const costs = [];
  const statusCounts = { completed: 0, 'model-failure': 0, 'budget-exhausted': 0, void: 0 };
  const usage = { requests: 0, tokens: 0, tool_calls: 0, wall_ms: 0 };
  const knownUsage = { ...usage };
  const unknownUsageAttempts = { ...usage };
  for (const result of input.cells) {
    const cell = expected.get(result.cell_id);
    required(cell && !seen.has(result.cell_id), 'unmatched or duplicate cell');
    seen.add(result.cell_id);
    for (const [field, value] of Object.entries(cell)) required(result[field] === value, 'changed condition: ' + field);
    required(
      Array.isArray(result.attempts) && result.attempts.length > 0 && result.attempts.length <= cell.max_attempts,
      'attempt count',
    );
    unique(
      result.attempts.map((attempt) => attempt.attempt_id),
      'attempt id',
    );
    for (const [index, attempt] of result.attempts.entries()) {
      required(!seenAttempts.has(attempt.attempt_id), 'duplicate attempt id');
      seenAttempts.add(attempt.attempt_id);
      attemptCheck(attempt, index + 1, cell);
      if (index > 0) required(result.attempts[index - 1].status === 'void', 'retry after terminal attempt');
      costs.push(attempt.cost_usd);
      for (const field of ['requests', 'tokens', 'tool_calls', 'wall_ms']) {
        if (attempt[field] === null) unknownUsageAttempts[field]++;
        else knownUsage[field] += attempt[field];
      }
      statusCounts[attempt.status]++;
    }
    const selected = result.attempts.find((attempt) => attempt.status !== 'void') ?? null;
    const item = cases.find((entry) => entry.id === cell.case_id);
    for (const attempt of result.attempts)
      for (const key of item.keys)
        required(!key.evidence.exclude_attempt_ids.includes(attempt.attempt_id), 'source attempt excluded');
    const serious = new Set(item.keys.filter((key) => ['high', 'medium'].includes(key.severity)).map((key) => key.id));
    for (const attempt of result.attempts)
      for (const key of attempt.matched_key_ids) required(serious.has(key), 'unknown or nonserious key');
    const matched = selected?.matched_key_ids.length ?? 0;
    required(matched <= serious.size, 'score inflation');
    const novelSerious = selected?.novel_findings.some((finding) => finding.true_finding && finding.serious) ?? false;
    const cellCosts = result.attempts.map((entry) => entry.cost_usd);
    results.push({
      cell_id: cell.cell_id,
      case_id: cell.case_id,
      arm_id: cell.arm_id,
      source_kind: cell.source_kind,
      family: cell.family,
      temporal_block: cell.temporal_block,
      replicate: cell.replicate,
      status: selected?.status ?? 'void',
      key_state: item.key_state,
      key_incomplete: novelSerious,
      comparison: item.key_state === 'reviewed' && !novelSerious ? 'eligible' : 'exploratory',
      serious_key_count: serious.size,
      matched_serious_count: matched,
      matched_by_severity: Object.fromEntries(
        ['high', 'medium'].map((severity) => [
          severity,
          selected?.matched_key_ids.filter((keyId) =>
            item.keys.some((key) => key.id === keyId && key.severity === severity),
          ).length ?? 0,
        ]),
      ),
      known_key_recall: serious.size === 0 || !selected ? null : matched / serious.size,
      false_blocker:
        serious.size === 0 && selected && selected.wrong_verdict !== null
          ? selected.wrong_verdict === true && selected.verdict === 'reject'
          : null,
      false_claims: selected?.false_claims ?? null,
      novel_true_findings: selected?.novel_findings.filter((finding) => finding.true_finding).length ?? 0,
      wrong_verdict: selected?.wrong_verdict ?? null,
      wrong_approval:
        serious.size > 0 && selected && selected.wrong_verdict !== null
          ? selected.wrong_verdict === true && selected.verdict === 'approve'
          : null,
      wrong_rejection:
        serious.size > 0 && selected && selected.wrong_verdict !== null
          ? selected.wrong_verdict === true && selected.verdict === 'reject'
          : null,
      cost_usd: cellCosts.some((value) => value === null) ? null : cellCosts.reduce((a, b) => a + b, 0),
      known_cost_usd: cellCosts.filter((value) => value !== null).reduce((a, b) => a + b, 0),
      unknown_cost_attempts: cellCosts.filter((value) => value === null).length,
      usage: Object.fromEntries(
        ['requests', 'tokens', 'tool_calls', 'wall_ms'].map((field) => [
          field,
          result.attempts.some((entry) => entry[field] === null)
            ? null
            : result.attempts.reduce((total, entry) => total + entry[field], 0),
        ]),
      ),
    });
  }
  const missing = frozen.cells.filter((cell) => !seen.has(cell.cell_id)).map((cell) => cell.cell_id);
  required(allowPartial || missing.length === 0, 'missing cells: ' + missing.length);
  const incompleteTasks = new Set(results.filter((row) => row.key_incomplete).map((row) => row.case_id));
  for (const row of results)
    if (incompleteTasks.has(row.case_id)) {
      row.key_incomplete = true;
      row.comparison = 'exploratory';
    }
  const unknownCosts = costs.filter((value) => value === null).length;
  for (const field of Object.keys(usage)) usage[field] = unknownUsageAttempts[field] ? null : knownUsage[field];
  const byCohort = dictionary();
  for (const result of results) {
    const cohort = result.source_kind;
    const family = result.family;
    const arm = result.arm_id;
    (((byCohort[cohort] ??= dictionary())[family] ??= dictionary())[arm] ??= []).push(result);
  }
  const familyMeans = dictionary();
  for (const [cohort, families] of Object.entries(byCohort)) {
    familyMeans[cohort] = dictionary();
    for (const [family, arms] of Object.entries(families)) {
      familyMeans[cohort][family] = dictionary();
      for (const [arm, rows] of Object.entries(arms)) {
        const tasks = new Map();
        for (const row of rows)
          if (row.known_key_recall !== null) {
            const values = tasks.get(row.case_id) ?? [];
            values.push(row.known_key_recall);
            tasks.set(row.case_id, values);
          }
        const taskMeans = [...tasks.values()].map((values) => values.reduce((a, b) => a + b, 0) / values.length);
        familyMeans[cohort][family][arm] = taskMeans.length
          ? taskMeans.reduce((a, b) => a + b, 0) / taskMeans.length
          : null;
      }
    }
  }
  const cohortMeans = dictionary();
  for (const [cohort, families] of Object.entries(familyMeans)) {
    cohortMeans[cohort] = dictionary();
    for (const arm of frozen.registration.arms) {
      const values = Object.values(families)
        .map((family) => family[arm.id])
        .filter((value) => value !== null && value !== undefined);
      cohortMeans[cohort][arm.id] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    }
  }
  const grouped = new Map();
  for (const row of results) {
    const key = `${row.case_id}\0${row.temporal_block}\0${row.replicate}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const pairs = [];
  const pairContrasts = [];
  for (const task of frozen.registration.tasks)
    for (let block = 1; block <= task.temporal_blocks; block++)
      for (let replicate = 1; replicate <= task.repeats; replicate++) {
        const group = grouped.get(`${task.case_id}\0${block}\0${replicate}`) ?? [];
        pairs.push({
          case_id: task.case_id,
          temporal_block: block,
          replicate,
          present: group.length,
          expected: frozen.registration.arms.length,
          valid: group.filter((row) => row.known_key_recall !== null).length === frozen.registration.arms.length,
        });
        for (let left = 0; left < frozen.registration.arms.length; left++)
          for (let right = left + 1; right < frozen.registration.arms.length; right++) {
            const a = group.find((row) => row.arm_id === frozen.registration.arms[left].id);
            const b = group.find((row) => row.arm_id === frozen.registration.arms[right].id);
            const valid =
              a?.known_key_recall !== null &&
              a?.known_key_recall !== undefined &&
              b?.known_key_recall !== null &&
              b?.known_key_recall !== undefined;
            pairContrasts.push({
              case_id: task.case_id,
              family: task.family,
              source_kind: task.source_kind,
              temporal_block: block,
              replicate,
              left_arm: frozen.registration.arms[left].id,
              right_arm: frozen.registration.arms[right].id,
              valid,
              exploratory: task.key_state !== 'reviewed' || incompleteTasks.has(task.case_id),
              recall_delta: valid ? b.known_key_recall - a.known_key_recall : null,
            });
          }
      }
  const pairedMeans = dictionary();
  if (missing.length === 0) {
    for (const pair of pairContrasts) {
      const label = pair.left_arm + ':' + pair.right_arm;
      const cohort = (pairedMeans[pair.source_kind] ??= dictionary());
      const family = (cohort[pair.family] ??= dictionary());
      const armPair = (family[label] ??= {
        expected_pairs: 0,
        valid_pairs: 0,
        missing_valid_pairs: 0,
        tasks: dictionary(),
      });
      armPair.expected_pairs++;
      if (pair.valid) {
        armPair.valid_pairs++;
        (armPair.tasks[pair.case_id] ??= []).push(pair.recall_delta);
      } else armPair.missing_valid_pairs++;
    }
    for (const families of Object.values(pairedMeans))
      for (const arms of Object.values(families))
        for (const value of Object.values(arms)) {
          const taskMeans = Object.values(value.tasks).map(
            (deltas) => deltas.reduce((a, b) => a + b, 0) / deltas.length,
          );
          value.mean_delta = taskMeans.length ? taskMeans.reduce((a, b) => a + b, 0) / taskMeans.length : null;
          delete value.tasks;
        }
  }
  const pairedCohortMeans = dictionary();
  for (const [cohort, families] of Object.entries(pairedMeans)) {
    pairedCohortMeans[cohort] = dictionary();
    for (let left = 0; left < frozen.registration.arms.length; left++)
      for (let right = left + 1; right < frozen.registration.arms.length; right++) {
        const label = frozen.registration.arms[left].id + ':' + frozen.registration.arms[right].id;
        const values = Object.values(families)
          .map((family) => family[label]?.mean_delta)
          .filter((value) => value !== null && value !== undefined);
        pairedCohortMeans[cohort][label] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      }
  }
  return {
    schema: 'arc-review-summary-v1',
    registration_hash: frozen.registration_hash,
    complete: missing.length === 0,
    comparison_suppressed: missing.length > 0,
    expected_cells: frozen.cells.length,
    observed_cells: results.length,
    missing_cell_ids: missing,
    attempts: statusCounts,
    cost_usd: unknownCosts ? null : costs.reduce((a, b) => a + b, 0),
    known_cost_usd: costs.filter((value) => value !== null).reduce((a, b) => a + b, 0),
    unknown_cost_attempts: unknownCosts,
    usage,
    known_usage: knownUsage,
    unknown_usage_attempts: unknownUsageAttempts,
    results,
    pairs,
    pair_contrasts: missing.length ? [] : pairContrasts,
    paired_family_means: pairedMeans,
    paired_cohort_means: pairedCohortMeans,
    family_means: familyMeans,
    cohort_means: cohortMeans,
    note: 'Descriptive known-key coverage only. Partial keys and newly discovered serious findings remain exploratory.',
  };
}

function options(args) {
  const parsed = {};
  for (let index = 0; index < args.length;) {
    if (args[index] === '--allow-partial') {
      required(!parsed['allow-partial'], 'duplicate option');
      parsed['allow-partial'] = true;
      index++;
      continue;
    }
    required(args[index]?.startsWith('--') && args[index + 1], 'option requires value');
    const key = args[index].slice(2);
    required(!(key in parsed), 'duplicate option');
    parsed[key] = args[index + 1];
    index += 2;
  }
  return parsed;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const opts = options(args);
  const need = (...names) => names.forEach((name) => required(opts[name], 'missing --' + name));
  let output;
  if (command === 'capture') {
    need('repository', 'out');
    output = capture(real(opts.repository), real(opts.out));
  } else if (command === 'validate') {
    need('cache');
    output = validate(real(opts.cache));
  } else if (command === 'prepare') {
    need('cache', 'case', 'out');
    output = prepare(real(opts.cache), opts.case, real(opts.out));
  } else if (command === 'matrix') {
    need('registration', 'out');
    output = matrix(read(opts.registration));
    write(opts.out, output);
  } else if (command === 'summarize') {
    need('matrix', 'cells');
    output = summarize(read(opts.matrix), read(opts.cells), opts['allow-partial']);
    if (opts.out) write(opts.out, output);
  } else fail('expected capture, validate, prepare, matrix, or summarize');
  process.stdout.write(json(output));
}

try {
  main();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
