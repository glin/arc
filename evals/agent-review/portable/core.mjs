import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suite = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const root = path.resolve(suite, '../..');
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const encoded = (value) => JSON.stringify(value, null, 2) + '\n';
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const hex = /^[0-9a-f]{64}$/;
const id = /^portable-[0-9]{3}$/;
const plainId = /^[a-z][a-z0-9-]*$/;

export function safePath(name) {
  assert(typeof name === 'string' && name.length > 0 && !name.includes('\\'), `unsafe path: ${name}`);
  assert(!path.posix.isAbsolute(name) && !/^[a-z]:/i.test(name), `absolute path: ${name}`);
  for (const part of name.split('/')) {
    assert(part && part !== '.' && part !== '..', `path traversal: ${name}`);
    assert(!/[<>:"|?*\x00-\x1f]/u.test(part) && !/[. ]$/u.test(part), `unsafe path: ${name}`);
    assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part), `device path: ${name}`);
    assert(
      !['.git', '.claude', '.codex', '.agents', 'evals', 'node_modules'].includes(part.toLowerCase()),
      `excluded path: ${name}`,
    );
  }
  return name;
}

function regular(file) {
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink(), `linked or non-file input: ${file}`);
  return fs.readFileSync(file);
}

function walkRegular(folder, relative = '') {
  const base = fs.lstatSync(path.join(folder, relative));
  assert(base.isDirectory() && !base.isSymbolicLink(), `linked or non-directory input: ${folder}`);
  const out = [];
  for (const entry of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    safePath(name);
    assert(!entry.isSymbolicLink(), `linked input: ${name}`);
    if (entry.isDirectory()) out.push(...walkRegular(folder, name));
    else {
      assert(entry.isFile(), `non-file input: ${name}`);
      out.push(name);
    }
  }
  return out;
}

function collisions(names) {
  const seen = new Map();
  for (const name of names) {
    const parts = name.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const partial = parts.slice(0, n).join('/');
      const key = partial.toLowerCase();
      const prior = seen.get(key);
      assert(!prior || prior === partial, `case-folded collision: ${name}`);
      seen.set(key, partial);
    }
  }
  assert(new Set(names).size === names.length, 'duplicate input path');
}

function caseShape(item, name) {
  assert(
    item.schema === 'arc-portable-review-case-v1' && id.test(item.id) && name === `${item.id}.json`,
    'case identity',
  );
  assert(Number.isSafeInteger(item.revision) && item.revision > 0, `case revision: ${item.id}`);
  assert(
    plainId.test(item.family) && ['development', 'holdout'].includes(item.split),
    `case family or split: ${item.id}`,
  );
  assert(['bug', 'clean'].includes(item.kind) && item.source_mode === 'fixed', `case kind or source: ${item.id}`);
  assert(
    item.provenance && ['adapted', 'historical'].includes(item.provenance.classification),
    `case provenance: ${item.id}`,
  );
  assert(Array.isArray(item.inputs) && item.inputs.length > 0, `empty case: ${item.id}`);
  collisions(item.inputs.map((entry) => safePath(entry.path)));
  for (const input of item.inputs) assert(hex.test(input.sha256), `input hash: ${item.id}`);
  assert(hex.test(item.prompt_sha256) && hex.test(item.diff_sha256), `prompt or diff hash: ${item.id}`);
  assert(Array.isArray(item.keys), `missing keys: ${item.id}`);
  assert(item.kind === 'bug' ? item.keys.length > 0 : item.keys.length === 0, `key count: ${item.id}`);
  assert(typeof item.audit === 'string' && item.audit.length > 10, `missing audit: ${item.id}`);
  const ids = new Set();
  for (const key of item.keys) {
    assert(plainId.test(key.id) && !ids.has(key.id), `key identity: ${item.id}`);
    ids.add(key.id);
    assert(['high', 'medium', 'low'].includes(key.severity), `key severity: ${item.id}`);
    assert(key.summary && key.scenario && Array.isArray(key.paths) && key.paths.length > 0, `key details: ${item.id}`);
    for (const p of key.paths)
      assert(
        item.inputs.some((input) => input.path === safePath(p)),
        `key path: ${item.id}`,
      );
  }
}

export function loadCase(caseId) {
  assert(id.test(caseId), `case id: ${caseId}`);
  const file = path.join(suite, 'portable', 'cases', `${caseId}.json`);
  const item = JSON.parse(regular(file).toString('utf8'));
  caseShape(item, path.basename(file));
  const fixture = path.join(suite, 'fixtures', caseId);
  assert(fs.lstatSync(fixture).isDirectory(), `fixture: ${caseId}`);
  const names = walkRegular(path.join(fixture, 'input'));
  const references = walkRegular(path.join(fixture, 'reference'));
  collisions(names);
  assert(
    names.length === item.inputs.length && names.every((p) => item.inputs.some((i) => i.path === p)),
    `input inventory: ${caseId}`,
  );
  assert(
    references.length === names.length && references.every((p) => names.includes(p)),
    `reference inventory: ${caseId}`,
  );
  for (const input of item.inputs) {
    assert(
      sha(regular(path.join(fixture, 'input', input.path))) === input.sha256,
      `changed input: ${caseId}/${input.path}`,
    );
    regular(path.join(fixture, 'reference', input.path));
  }
  assert(sha(regular(path.join(fixture, 'prompt.txt'))) === item.prompt_sha256, `changed prompt: ${caseId}`);
  assert(sha(regular(path.join(fixture, 'candidate.diff'))) === item.diff_sha256, `changed diff: ${caseId}`);
  regular(path.join(fixture, 'qualify.mjs'));
  return { item, fixture, caseHash: sha(regular(file)) };
}

export function listCases() {
  return fs
    .readdirSync(path.join(suite, 'portable', 'cases'))
    .filter((name) => id.test(name.slice(0, -5)) && name.endsWith('.json'))
    .sort()
    .map((name) => loadCase(name.slice(0, -5)));
}

function checkQualification(output, label) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error(`qualification output: ${label}`);
  }
  assert(Array.isArray(parsed.checks) && parsed.checks.length >= 2, `qualification checks: ${label}`);
  const ids = new Set();
  for (const check of parsed.checks) {
    assert(
      plainId.test(check.id) &&
        !ids.has(check.id) &&
        ['normal', 'symptom'].includes(check.role) &&
        typeof check.pass === 'boolean',
      `qualification check: ${label}`,
    );
    ids.add(check.id);
  }
  assert(
    parsed.checks.some((c) => c.role === 'normal') && parsed.checks.some((c) => c.role === 'symptom'),
    `qualification roles: ${label}`,
  );
  return parsed.checks;
}

export function qualify(script, candidate, reference, kind) {
  const run = (folder, label) => {
    const result = spawnSync(process.execPath, [script, folder], { encoding: 'utf8', timeout: 15000 });
    assert(
      result.status === 0 && !result.error,
      `qualification failed: ${label}: ${result.stderr || result.error?.message || ''}`,
    );
    return checkQualification(result.stdout, label);
  };
  const before = run(candidate, 'candidate');
  const after = run(reference, 'reference');
  assert(
    encoded(before.map(({ id: checkId, role }) => ({ id: checkId, role }))) ===
      encoded(after.map(({ id: checkId, role }) => ({ id: checkId, role }))),
    'qualification check mismatch',
  );
  assert(
    before.filter((c) => c.role === 'normal').every((c) => c.pass),
    'candidate normal behavior failed',
  );
  assert(
    before.filter((c) => c.role === 'symptom').some((c) => !c.pass) === (kind === 'bug'),
    'candidate symptom result',
  );
  assert(
    after.every((c) => c.pass),
    'reference behavior failed',
  );
  return { candidate: before, reference: after };
}

export function copyInputs(from, to, inventory) {
  fs.mkdirSync(to, { recursive: true });
  for (const input of inventory) {
    const bytes = regular(path.join(from, input.path));
    assert(sha(bytes) === input.sha256, `changed input: ${input.path}`);
    const destination = path.join(to, input.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  const actual = walkRegular(to);
  assert(
    actual.length === inventory.length && actual.every((p) => inventory.some((i) => i.path === p)),
    'export inventory',
  );
}

export function captureInstructions(checkout, extra = [], auditedBundle = null) {
  let directory = checkout;
  let manifestPath = path.join(suite, 'portable', 'instructions.json');
  if (auditedBundle !== null) {
    assert(typeof auditedBundle === 'string' && !path.isAbsolute(auditedBundle), 'audited instruction path');
    manifestPath = path.resolve(checkout, auditedBundle);
    assert(
      manifestPath.startsWith(path.join(checkout, 'evals', 'agent-review') + path.sep),
      'audited instruction boundary',
    );
    directory = path.dirname(manifestPath);
    let parent = checkout;
    for (const part of path.relative(checkout, directory).split(path.sep)) {
      parent = path.join(parent, part);
      const info = fs.lstatSync(parent);
      assert(info.isDirectory() && !info.isSymbolicLink(), 'linked audited instruction directory');
    }
  }
  const manifest = JSON.parse(regular(manifestPath).toString('utf8'));
  assert(manifest.schema === 'arc-review-instructions-v1' && Array.isArray(manifest.required), 'instruction manifest');
  if (auditedBundle !== null) {
    assert(
      manifest.condition === 'audited-current-instructions' && extra.length === 0,
      'audited instruction condition',
    );
    assert(
      Array.isArray(manifest.documents) && manifest.documents.length === manifest.required.length,
      'instruction audit',
    );
  }
  const names = [...manifest.required, ...extra];
  if (auditedBundle === null && fs.existsSync(path.join(checkout, 'AGENTS.md'))) names.push('AGENTS.md');
  collisions(names);
  return names.map((name) => {
    safePath(name);
    let parent = directory;
    for (const part of name.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      const info = fs.lstatSync(parent);
      assert(info.isDirectory() && !info.isSymbolicLink(), `linked instruction parent: ${name}`);
    }
    const bytes = regular(path.join(directory, name));
    if (auditedBundle !== null) {
      const audit = manifest.documents.find((doc) => doc.path === name);
      assert(
        audit && hex.test(audit.original_sha256) && audit.exported_sha256 === sha(bytes),
        `changed audited instruction: ${name}`,
      );
      assert(typeof audit.omissions === 'string' && audit.omissions.length > 10, `instruction omissions: ${name}`);
    }
    return { path: name, sha256: sha(bytes), bytes };
  });
}

export function externalRunDirectory(out) {
  const folder = out ? path.resolve(out) : fs.mkdtempSync(path.join(os.tmpdir(), 'arc-review-'));
  assert(!folder.toLowerCase().startsWith(root.toLowerCase() + path.sep), 'run directory inside source');
  let parent = path.dirname(folder);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const physical = fs.realpathSync.native(parent);
  const physicalRoot = fs.realpathSync.native(root);
  assert(
    !physical.toLowerCase().startsWith(physicalRoot.toLowerCase() + path.sep),
    'linked run directory inside source',
  );
  if (out) fs.mkdirSync(folder, { recursive: false });
  return folder;
}

export function prepareFixed(loaded, workspace, instructions) {
  const { item, fixture } = loaded;
  copyInputs(path.join(fixture, 'input'), workspace, item.inputs);
  const context = path.join(workspace, 'context');
  for (const doc of instructions) {
    const dest = path.join(context, doc.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, doc.bytes, { flag: 'wx' });
  }
  const result = qualify(path.join(fixture, 'qualify.mjs'), workspace, path.join(fixture, 'reference'), item.kind);
  const prompt = regular(path.join(fixture, 'prompt.txt')).toString('utf8');
  const diff = regular(path.join(fixture, 'candidate.diff')).toString('utf8');
  return {
    prompt,
    diff,
    qualification: result,
    inventory: item.inputs,
    sourceMode: 'fixed',
    caseHash: loaded.caseHash,
  };
}

export function runIdentity() {
  return randomUUID();
}
