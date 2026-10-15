import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalToolPath } from '../../extension/src/toolownership.ts';
import { parseSessionRequest, WindowChannel } from '../../extension/src/sessionrequests.ts';
import { sessionListingPage, SESSION_PAGE_LIMITS } from '../../extension/src/sessionreads.ts';
import { childEnv } from '../../extension/src/agenthost.ts';
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { COMMANDS, checkCommandHelp, renderCommandHelp, renderOverviewHelp } from '../src/commands.ts';
import { fileURLToPath } from 'node:url';
import { DispatchReceipts } from '../../extension/src/dispatchreceipts.ts';
import { payloadSha256 } from '../../extension/src/sessionwrites.ts';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readSkillPayload, skillTemporaryRoots } from '../src/skillfiles.ts';
import { operateSkill } from '../src/skills.ts';

test('ordinary smoke fixtures create homes beneath physical temporary directories', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.doesNotMatch(source, /mkdtempSync\(join\(tmpdir\(\),/);
});

test('owned skill copies publish resources before discovery and survive their payload removal', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-owned-skill-'));
  const source = join(home, 'package');
  fs.mkdirSync(join(source, 'dist'), { recursive: true });
  fs.cpSync(new URL('../skills', import.meta.url), join(source, 'skills'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"@glin/arc"}');
  fs.mkdirSync(join(source, 'skills/arc-sessions/resources'));
  writeFileSync(join(source, 'skills/arc-sessions/resources/data.txt'), 'resource bytes');
  const payload = readSkillPayload(join(source, 'dist/arc.cjs'));
  const destination = join(home, '.agents/skills/arc-sessions');
  try {
    const result = await operateSkill('install', 'codex', payload, {
      home,
      signal: new AbortController().signal,
      checkpoint: async (phase) => {
        if (phase === 'before-definition') {
          assert.equal(fs.existsSync(join(destination, 'SKILL.md')), false);
          assert.equal(readFileSync(join(destination, 'resources/data.txt'), 'utf8'), 'resource bytes');
        }
      },
    });
    assert.equal(result.status, 'installed', JSON.stringify(result));
    rmSync(source, { recursive: true });
    for (const [relative, bytes] of payload.files) assert.deepEqual(readFileSync(join(destination, relative)), bytes);
    assert.equal(fs.lstatSync(join(destination, 'SKILL.md')).isSymbolicLink(), false);
    assert.equal(
      (await operateSkill('update', 'codex', payload, { home, signal: new AbortController().signal })).status,
      'unchanged',
    );
    assert.equal(
      (await operateSkill('remove', 'codex', payload, { home, signal: new AbortController().signal })).status,
      'removed',
    );
    assert.equal(fs.existsSync(destination), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('foreign, changed, added and linked skills remain unchanged for explicit operations', async () => {
  const payload = readSkillPayload(cli);
  for (const conflict of ['manual', 'edited', 'added', 'link', 'broken']) {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-preserve-skill-'));
    const destination = join(home, '.agents/skills/arc-sessions');
    const options = { home, signal: new AbortController().signal };
    try {
      if (conflict === 'manual') fs.cpSync(payload.directory, destination, { recursive: true });
      else if (conflict === 'link' || conflict === 'broken') {
        mkdirSync(join(destination, '..'), { recursive: true });
        fs.symlinkSync(conflict === 'link' ? payload.directory : join(home, 'missing'), destination, 'junction');
      } else {
        assert.equal((await operateSkill('install', 'codex', payload, options)).status, 'installed');
        if (conflict === 'edited') writeFileSync(join(destination, 'SKILL.md'), 'reader edit');
        else writeFileSync(join(destination, 'extra.txt'), 'reader addition');
      }
      const before = fs.lstatSync(destination);
      const bytes = conflict === 'broken' ? null : readFileSync(join(destination, 'SKILL.md'));
      for (const action of ['install', 'update', 'remove']) {
        const result = await operateSkill(action, 'codex', payload, options);
        assert.ok(['failed', 'incomplete', 'external-match-preserved'].includes(result.status), JSON.stringify(result));
        assert.equal(fs.lstatSync(destination).ino, before.ino);
        if (bytes) assert.deepEqual(readFileSync(join(destination, 'SKILL.md')), bytes);
      }
    } finally {
      if (['link', 'broken'].includes(conflict) && fs.lstatSync(destination).isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(destination);
        else fs.unlinkSync(destination);
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('cancelled replacements restore matching originals and retain conflicting destinations and locks', async () => {
  const original = readSkillPayload(cli);
  const files = new Map(original.files);
  files.set('SKILL.md', Buffer.concat([files.get('SKILL.md'), Buffer.from('\nchanged\n')]));
  const replacement = { ...original, identity: 'replacement', files };
  for (const conflict of [false, true]) {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-cancel-skill-'));
    const destination = join(home, '.agents/skills/arc-sessions');
    try {
      assert.equal(
        (await operateSkill('install', 'codex', original, { home, signal: new AbortController().signal })).status,
        'installed',
      );
      const controller = new AbortController();
      const result = await operateSkill('update', 'codex', replacement, {
        home,
        signal: controller.signal,
        checkpoint: async (phase) => {
          if (phase === 'backed-up') {
            if (conflict) mkdirSync(destination);
            controller.abort();
          }
        },
      });
      assert.equal(result.status, conflict ? 'incomplete' : 'cancelled');
      if (conflict) {
        assert.deepEqual(fs.readdirSync(destination), []);
        assert.ok(fs.existsSync(join(result.control, 'destination.lock')));
        assert.deepEqual(readFileSync(join(result.operation, 'backup/SKILL.md')), original.files.get('SKILL.md'));
        assert.match(
          (await operateSkill('install', 'codex', original, { home, signal: new AbortController().signal })).reason,
          /Another Arc setup/,
        );
      } else {
        assert.deepEqual(readFileSync(join(destination, 'SKILL.md')), original.files.get('SKILL.md'));
        assert.equal(fs.existsSync(join(result.control, 'destination.lock')), false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('independent software roots arbitrate one personal skill destination', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-skill-race-'));
  const payload = readSkillPayload(cli);
  let release;
  let acknowledge;
  const observed = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const first = operateSkill('install', 'codex', payload, {
      home,
      env: { ...process.env, ARC_HOME: join(home, 'software-a') },
      signal: new AbortController().signal,
      checkpoint: async (phase) => {
        if (phase === 'prepared') {
          acknowledge();
          await paused;
        }
      },
    });
    await observed;
    const blocked = await operateSkill('install', 'codex', payload, {
      home,
      env: { ...process.env, ARC_HOME: join(home, 'software-b') },
      signal: new AbortController().signal,
    });
    assert.equal(blocked.status, 'failed');
    assert.match(blocked.reason, /Another Arc setup/);
    const control = canonicalToolPath(join(home, '.agents/skills.arc-skill-control'));
    assert.equal(JSON.parse(readFileSync(join(control, 'destination.lock'))).pid, process.pid);
    release();
    assert.equal((await first).status, 'installed');
  } finally {
    release?.();
    rmSync(home, { recursive: true, force: true });
  }
});

test.each(['backup', 'stage', 'claim', 'seal', 'cancelled-seal'])(
  'committed replacement survives %s cleanup failure',
  async (boundary) => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-committed-skill-'));
    const original = readSkillPayload(cli);
    const files = new Map(original.files);
    files.set('SKILL.md', Buffer.concat([files.get('SKILL.md'), Buffer.from('\nreplacement\n')]));
    const replacement = { ...original, identity: 'replacement', files };
    const controller = new AbortController();
    const options = { home, signal: controller.signal };
    const methods = {
      unlinkSync: mutableFs.unlinkSync,
      rmdirSync: mutableFs.rmdirSync,
      writeFileSync: mutableFs.writeFileSync,
    };
    let injected = false;
    try {
      assert.equal((await operateSkill('install', 'codex', original, options)).status, 'installed');
      const fail = () => {
        injected = true;
        if (boundary === 'cancelled-seal') controller.abort();
        throw Object.assign(new Error('cleanup sharing failure'), { code: 'EPERM' });
      };
      mutableFs.unlinkSync = function (file, ...args) {
        if (!injected && boundary === 'backup' && String(file).includes('backup')) {
          methods.unlinkSync(file, ...args);
          return fail();
        }
        if (!injected && boundary === 'claim' && String(file).endsWith('claim.json')) return fail();
        return methods.unlinkSync(file, ...args);
      };
      mutableFs.rmdirSync = function (file, ...args) {
        if (!injected && boundary === 'stage' && String(file).endsWith('stage')) return fail();
        return methods.rmdirSync(file, ...args);
      };
      mutableFs.writeFileSync = function (file, ...args) {
        if (!injected && ['seal', 'cancelled-seal'].includes(boundary) && String(file).endsWith('seal.json'))
          return fail();
        return methods.writeFileSync(file, ...args);
      };
      syncBuiltinESMExports();
      const result = await operateSkill('update', 'codex', replacement, options);
      assert.equal(injected, true);
      assert.equal(result.status, 'incomplete', JSON.stringify(result));
      assert.equal(result.publication, 'updated');
      assert.equal(result.reason.split('docs/arc-sessions.md#manual-recovery').length - 1, 1);
      assert.deepEqual(readFileSync(join(result.destination, 'SKILL.md')), files.get('SKILL.md'));
      assert.equal(JSON.parse(readFileSync(join(result.control, 'installed.json'))).source, 'replacement');
      assert.equal(fs.existsSync(join(result.control, 'destination.lock')), true);
      assert.equal(fs.existsSync(join(result.operation, 'seal.json')), false);
    } finally {
      Object.assign(mutableFs, methods);
      syncBuiltinESMExports();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.each(['link', 'unlink'])(
  'pre-journal %s refusal retires exact preparation files and permits retry',
  async (boundary) => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-prepared-skill-'));
    const payload = readSkillPayload(cli);
    const options = { home, signal: new AbortController().signal };
    const method = boundary === 'link' ? 'linkSync' : 'unlinkSync';
    const original = mutableFs[method];
    let injected = false;
    try {
      mutableFs[method] = function (...args) {
        if (!injected && args.some((file) => String(file).endsWith('link-test'))) {
          injected = true;
          throw Object.assign(new Error('publication unavailable'), { code: 'EPERM' });
        }
        return original(...args);
      };
      syncBuiltinESMExports();
      const refused = await operateSkill('install', 'codex', payload, options);
      assert.equal(injected, true);
      assert.equal(refused.status, 'failed', JSON.stringify(refused));
      assert.equal(fs.existsSync(refused.destination), false);
      assert.deepEqual(fs.readdirSync(refused.control), ['ownership.json']);
      mutableFs[method] = original;
      syncBuiltinESMExports();
      assert.equal((await operateSkill('install', 'codex', payload, options)).status, 'installed');
    } finally {
      mutableFs[method] = original;
      syncBuiltinESMExports();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('independent software roots reach the same occupied destination lock', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-destination-lock-'));
  const payload = readSkillPayload(cli);
  const options = { home, signal: new AbortController().signal };
  try {
    assert.equal((await operateSkill('install', 'codex', payload, options)).status, 'installed');
    const lock = canonicalToolPath(join(home, '.agents/skills.arc-skill-control/destination.lock'));
    writeFileSync(lock, JSON.stringify({ token: 'foreign-live-token', pid: process.pid }));
    for (const root of ['software-a', 'software-b']) {
      const result = await operateSkill('update', 'codex', payload, {
        ...options,
        env: { ...process.env, ARC_HOME: join(home, root) },
      });
      assert.equal(result.status, 'failed');
      assert.ok(result.reason.includes(lock), result.reason);
      assert.equal(JSON.parse(readFileSync(lock)).token, 'foreign-live-token');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([false, true])(
  'compiled CLI handlers settle repeated cancellation with output failure %s',
  (outputFailure) => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-handler-skill-'));
    try {
      const receipt = join(home, 'receipt.json');
      const preload = join(home, 'preload.cjs');
      writeFileSync(
        preload,
        `const fs=require('node:fs');const link=fs.linkSync;let sent=false;
fs.linkSync=function(...args){const result=link(...args);if(!sent && String(args[1]).endsWith('SKILL.md')){sent=true;process.emit('SIGTERM');process.emit('SIGHUP');process.stdout.emit('error',Object.assign(new Error('closed output'),{code:'EPIPE'}));}return result;};
const write=process.stdout.write.bind(process.stdout);process.stdout.write=function(bytes,...args){fs.writeFileSync(${JSON.stringify(receipt)},bytes);if(${outputFailure})throw Object.assign(new Error('unavailable output'),{code:'EIO'});return write(bytes,...args);};`,
      );
      const child = spawnSync(
        process.execPath,
        ['--require', preload, cli, 'skills', 'install', '--agent', 'codex', '--agent', 'claude'],
        { env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' },
      );
      assert.equal(child.status, 143, child.stdout + child.stderr);
      const result = JSON.parse(readFileSync(receipt));
      assert.equal(result.cancellation, 143);
      assert.deepEqual(
        result.results.map((item) => item.status),
        ['cancelled', 'cancelled'],
      );
      assert.equal(fs.existsSync(join(home, '.agents/skills/arc-sessions')), false);
      assert.equal(fs.existsSync(join(home, '.agents/skills.arc-skill-control/destination.lock')), false);
      assert.equal(fs.existsSync(join(home, '.claude')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === 'win32').each(['before-backup', 'backup-cleanup'])(
  'Windows open reader preserves the skill at %s sharing boundary',
  async (boundary) => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-sharing-skill-'));
    const original = readSkillPayload(cli);
    const files = new Map(original.files);
    files.set('SKILL.md', Buffer.concat([files.get('SKILL.md'), Buffer.from('\nreplacement\n')]));
    const options = { home, signal: new AbortController().signal };
    let reader;
    let closed = Promise.resolve();
    const hold = async (file) => {
      const script = `$stream=[IO.File]::Open('${file.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('reader-open');[Console]::In.ReadLine()|Out-Null;$stream.Dispose()`;
      reader = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      closed = new Promise((resolve, reject) => {
        reader.once('close', () => resolve());
        reader.once('error', reject);
      });
      await new Promise((resolve, reject) => {
        let output = '';
        let errors = '';
        reader.stderr.on('data', (bytes) => {
          errors += bytes;
        });
        reader.stdout.on('data', (bytes) => {
          output += bytes;
          if (output.includes('reader-open')) resolve();
        });
        reader.once('error', reject);
        reader.once('exit', (code) => reject(new Error(`Reader exited ${code}: ${errors}`)));
      });
    };
    try {
      const installed = await operateSkill('install', 'codex', original, options);
      assert.equal(installed.status, 'installed');
      if (boundary === 'before-backup') await hold(join(installed.destination, 'SKILL.md'));
      const result = await operateSkill(
        'update',
        'codex',
        { ...original, identity: 'replacement', files },
        {
          ...options,
          checkpoint: async (phase) => {
            if (phase === 'backed-up' && boundary === 'backup-cleanup')
              await hold(
                join(
                  canonicalToolPath(join(home, '.agents/skills.arc-skill-control')),
                  fs
                    .readdirSync(canonicalToolPath(join(home, '.agents/skills.arc-skill-control')))
                    .find(
                      (name) =>
                        name.startsWith('operation-') &&
                        fs.existsSync(
                          join(canonicalToolPath(join(home, '.agents/skills.arc-skill-control')), name, 'backup'),
                        ),
                    ),
                  'backup/SKILL.md',
                ),
              );
          },
        },
      );
      assert.equal(result.status, boundary === 'before-backup' ? 'failed' : 'incomplete', JSON.stringify(result));
      assert.deepEqual(
        readFileSync(join(installed.destination, 'SKILL.md')),
        boundary === 'before-backup' ? original.files.get('SKILL.md') : files.get('SKILL.md'),
      );
      if (boundary === 'backup-cleanup')
        assert.equal(JSON.parse(readFileSync(join(result.control, 'installed.json'))).source, 'replacement');
    } finally {
      if (reader) {
        reader.stdin.end('\n');
        await closed;
      }
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('manual recovery retires a stopped unsealed replacement and permits a new operation', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-stopped-skill-'));
  const payload = readSkillPayload(cli);
  const options = { home, signal: new AbortController().signal };
  const destination = canonicalToolPath(join(home, '.agents/skills/arc-sessions'));
  let child;
  let stopped;
  try {
    assert.equal((await operateSkill('install', 'codex', payload, options)).status, 'installed');
    const worker = join(home, 'stopped.cjs');
    const { buildSync } = await import('esbuild');
    buildSync({
      stdin: {
        resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
        contents: `import {operateSkill} from './skills.ts';
import {readSkillPayload} from './skillfiles.ts';
const payload=readSkillPayload(${JSON.stringify(cli)});
const files=new Map(payload.files); files.set('SKILL.md',Buffer.concat([files.get('SKILL.md'),Buffer.from('\\nreplacement\\n')]));
operateSkill('update','codex',{...payload,identity:'replacement',files},{home:${JSON.stringify(home)},signal:new AbortController().signal,checkpoint:async phase=>{
if(phase==='backed-up'){process.stdin.resume(); process.stdout.write('backed-up\\n'); await new Promise(resolve=>process.stdin.once('data',resolve));}
}}).catch(error=>{console.error(error);process.exitCode=1;});`,
      },
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    stopped = new Promise((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (bytes) => {
        output += bytes;
        if (output.includes('backed-up\n')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Replacement exited before acknowledgement: ${code}`)));
    });
    child.kill('SIGKILL');
    await stopped;
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    const control = canonicalToolPath(join(home, '.agents/skills.arc-skill-control'));
    const operation = fs
      .readdirSync(control)
      .map((name) => join(control, name))
      .find((folder) => fs.existsSync(join(folder, 'journal.json')) && !fs.existsSync(join(folder, 'seal.json')));
    assert.ok(operation);
    const retained = await operateSkill('update', 'codex', payload, options);
    assert.match(retained.reason, /Another Arc setup/);
    assert.equal(retained.reason.split('docs/arc-sessions.md#manual-recovery').length - 1, 1);
    fs.cpSync(control, join(home, 'recovery-copy'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(operation, 'journal.json')));
    const id = (folder) => {
      const stat = fs.lstatSync(folder, { bigint: true });
      assert.equal(stat.isSymbolicLink(), false);
      return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
    };
    const hashes = (folder) => {
      const files = {};
      for (const name of fs.readdirSync(folder)) {
        assert.equal(fs.lstatSync(join(folder, name)).isFile(), true);
        files[name] = createHash('sha256')
          .update(readFileSync(join(folder, name)))
          .digest('hex');
      }
      return files;
    };
    assert.equal(journal.token, operation.slice(operation.lastIndexOf('operation-') + 10));
    assert.equal(journal.destination, destination);
    assert.equal(journal.stage, join(operation, 'stage'));
    assert.equal(journal.backup, join(operation, 'backup'));
    assert.deepEqual(id(control), journal.control);
    assert.deepEqual(id(journal.backup), journal.previous.directory);
    assert.deepEqual(hashes(journal.backup), journal.previous.files);
    assert.deepEqual(id(journal.stage), journal.stageIdentity);
    assert.deepEqual(hashes(journal.stage), journal.files);
    assert.equal(fs.existsSync(destination), false);
    fs.renameSync(journal.backup, destination);
    assert.deepEqual(JSON.parse(readFileSync(join(control, 'installed.json'))), journal.previous);
    for (const name of Object.keys(journal.files)) fs.unlinkSync(join(journal.stage, name));
    fs.rmdirSync(journal.stage);
    assert.deepEqual(fs.readdirSync(operation), ['journal.json']);
    fs.unlinkSync(join(operation, 'journal.json'));
    fs.rmdirSync(operation);
    for (const lock of Object.values(journal.locks)) {
      assert.equal(JSON.parse(readFileSync(lock.file)).token, lock.token);
      fs.unlinkSync(lock.file);
    }
    assert.equal((await operateSkill('remove', 'codex', payload, options)).status, 'removed');
    assert.equal((await operateSkill('install', 'codex', payload, options)).status, 'installed');
    for (const [relative, bytes] of payload.files) assert.deepEqual(readFileSync(join(destination, relative)), bytes);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await stopped;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('edited owned removal preserves the reader bytes', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-edited-removal-'));
  const payload = readSkillPayload(cli);
  const options = { home, signal: new AbortController().signal };
  const definition = join(home, '.agents/skills/arc-sessions/SKILL.md');
  try {
    assert.equal((await operateSkill('install', 'codex', payload, options)).status, 'installed');
    writeFileSync(definition, 'reader changes');
    const result = await operateSkill('remove', 'codex', payload, options);
    assert.equal(result.status, 'failed');
    assert.equal(readFileSync(definition, 'utf8'), 'reader changes');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the compiled skill CLI validates selectors before destination writes and reports independent providers', () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-skill-cli-'));
  const env = { ...smokeEnv, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: join(home, 'ignored') };
  try {
    for (const args of [[], ['--agent', 'other'], ['--root', home]]) {
      const result = spawnSync(process.execPath, [cli, 'skills', 'install', ...args], { env, encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(fs.readdirSync(home), []);
    }
    const installed = spawnSync(process.execPath, [cli, 'skills', 'install', '--agent', 'claude', '--agent', 'codex'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.deepEqual(
      JSON.parse(installed.stdout).results.map((r) => r.status),
      ['installed', 'installed'],
    );
    assert.equal(fs.existsSync(join(home, 'ignored')), false);
    for (const directory of ['.claude', '.agents'])
      assert.deepEqual(
        readFileSync(join(home, directory, 'skills/arc-sessions/SKILL.md')),
        readFileSync(new URL('../skills/arc-sessions/SKILL.md', import.meta.url)),
      );
    const launcher = join(home, 'launcher');
    fs.symlinkSync(join(cli, '..'), launcher, 'junction');
    try {
      const aliased = spawnSync(
        process.execPath,
        [join(launcher, 'arc.cjs'), 'skills', 'install', '--agent', 'codex'],
        { env, encoding: 'utf8' },
      );
      assert.equal(aliased.status, 0, aliased.stdout + aliased.stderr);
      assert.deepEqual(
        JSON.parse(aliased.stdout).results.map((result) => result.status),
        ['unchanged'],
      );
    } finally {
      if (process.platform === 'win32') fs.rmdirSync(launcher);
      else fs.unlinkSync(launcher);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/warm.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
fixture.prompt_cache.expires_at = Math.ceil(Date.now() / 1000) + 300;
const input = JSON.stringify(fixture);
const cli = fileURLToPath(new URL('../dist/arc.cjs', import.meta.url));
const smokeEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' };

test('session skill payload selection follows each executing artifact and rejects caller substitutes', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-skill-layout-'));
  const source = fileURLToPath(new URL('../skills/arc-sessions', import.meta.url));
  const copies = [
    ['extension/dist/cli.cjs', 'extension/dist/tools/skills/arc-sessions'],
    ['npm/dist/arc.cjs', 'npm/skills/arc-sessions'],
    ['release/tools/cli/arc.cjs', 'release/tools/skills/arc-sessions'],
  ];
  try {
    const identities = [];
    for (const [executable, payload] of copies) {
      mkdirSync(join(root, executable, '..'), { recursive: true });
      writeFileSync(join(root, executable), '');
      fs.cpSync(source, join(root, payload), { recursive: true });
      if (executable.startsWith('npm/')) writeFileSync(join(root, 'npm/package.json'), '{"name":"@glin/arc"}');
      const selected = readSkillPayload(join(root, executable));
      assert.deepEqual(selected.files.get('SKILL.md'), readFileSync(join(source, 'SKILL.md')));
      identities.push(selected.identity);
      fs.renameSync(join(root, payload), join(root, payload) + '.unavailable');
      assert.throws(() => readSkillPayload(join(root, executable)), /ENOENT/);
    }
    assert.equal(new Set(identities).size, 1);
    assert.throws(() => readSkillPayload(join(root, 'unknown.cjs')), /layout/);
    assert.throws(() => readSkillPayload('dist/arc.cjs'), /absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('temporary-root classification resolves linked spellings and retains unresolved configured roots', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-skill-temp-'));
  const temporary = join(root, 'physical temporary');
  const alias = join(root, 'linked temporary');
  try {
    mkdirSync(temporary);
    fs.symlinkSync(temporary, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const catalog = skillTemporaryRoots({ TMP: alias, TEMP: join(root, 'missing') }, process.platform, root);
    const physical = fs.realpathSync.native(temporary);
    assert.equal(
      catalog.find((entry) => entry.source === 'TMP').canonical,
      process.platform === 'win32' ? physical.toLowerCase() : physical,
    );
    assert.equal(catalog.find((entry) => entry.source === 'TEMP').state, 'unresolved');
    assert.equal(catalog.find((entry) => entry.source === 'TMPDIR').state, 'absent');
    assert.equal(catalog.find((entry) => entry.source === 'runtime').state, 'resolved');
    for (const platform of ['linux', 'darwin']) {
      const expected =
        platform === 'darwin'
          ? ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']
          : ['/tmp', '/var/tmp'];
      assert.deepEqual(
        skillTemporaryRoots({}, platform, root)
          .filter((entry) => entry.source === 'system')
          .map((entry) => entry.configured),
        expected,
      );
    }
  } finally {
    if (fs.existsSync(alias)) {
      if (process.platform === 'win32') {
        fs.rmdirSync(alias);
      } else fs.unlinkSync(alias);
    }
    assert.deepEqual(fs.readdirSync(temporary), []);
    assert.equal(fs.lstatSync(root).isDirectory(), true);
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['aliased', 'unresolved'])(
  'matching external copy remains incomplete for %s temporary storage',
  async (kind) => {
    const root = mkdtempSync(fileURLToPath(new URL('./arc-external-', import.meta.url)));
    const home = join(root, 'home');
    const destination = join(home, '.agents/skills/arc-sessions');
    const temporary = join(root, 'temporary');
    const alias = join(root, 'alias');
    const payload = readSkillPayload(cli);
    try {
      mkdirSync(temporary);
      fs.symlinkSync(temporary, alias, process.platform === 'win32' ? 'junction' : 'dir');
      fs.cpSync(payload.directory, destination, { recursive: true });
      const before = fs.lstatSync(destination, { bigint: true });
      const env = {
        ...process.env,
        TMP: kind === 'aliased' ? alias : temporary,
        TEMP: kind === 'unresolved' ? join(root, 'missing') : temporary,
        TMPDIR: temporary,
      };
      // The configured alias resolves to the regular copy's home, without redirecting the copy.
      if (kind === 'aliased') {
        if (process.platform === 'win32') fs.rmdirSync(alias);
        else fs.unlinkSync(alias);
        fs.symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
        env.TMP = alias;
      }
      const roots = skillTemporaryRoots(env);
      assert.equal(roots.filter((entry) => entry.state === 'unresolved').length, kind === 'unresolved' ? 1 : 0);
      const outcome = await operateSkill('install', 'codex', payload, {
        home,
        env,
        signal: new AbortController().signal,
      });
      assert.equal(outcome.status, 'incomplete', JSON.stringify(outcome));
      assert.equal(fs.lstatSync(destination, { bigint: true }).ino, before.ino);
      for (const [relative, bytes] of payload.files) assert.deepEqual(readFileSync(join(destination, relative)), bytes);
      assert.equal(fs.existsSync(join(home, '.agents/skills.arc-skill-control')), false);
    } finally {
      if (fs.existsSync(alias)) {
        if (process.platform === 'win32') fs.rmdirSync(alias);
        else fs.unlinkSync(alias);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('ordinary skill refusals omit recovery guidance and retained operations name it once', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-refusal-skill-'));
  const payload = readSkillPayload(cli);
  const options = { home, signal: new AbortController().signal };
  const destination = join(home, '.agents/skills/arc-sessions');
  const guide = 'docs/arc-sessions.md#manual-recovery';
  try {
    const absent = await operateSkill('remove', 'codex', payload, options);
    assert.equal(absent.status, 'failed');
    assert.equal(absent.reason.includes(guide), false);
    fs.cpSync(payload.directory, destination, { recursive: true });
    const foreign = await operateSkill('remove', 'codex', payload, options);
    assert.equal(foreign.status, 'failed');
    assert.equal(foreign.reason.includes(guide), false);
    rmSync(destination, { recursive: true });
    const installed = await operateSkill('install', 'codex', payload, options);
    writeFileSync(join(destination, 'SKILL.md'), 'reader edit');
    const edited = await operateSkill('remove', 'codex', payload, options);
    assert.equal(edited.status, 'failed');
    assert.equal(edited.reason.includes(guide), false);
    writeFileSync(join(destination, 'SKILL.md'), payload.files.get('SKILL.md'));
    const controller = new AbortController();
    controller.abort();
    const cancelled = await operateSkill('remove', 'codex', payload, { home, signal: controller.signal });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.reason.includes(guide), false);
    const lock = join(installed.control, 'destination.lock');
    writeFileSync(lock, '{"token":"live-fixture","pid":1}');
    const live = await operateSkill('remove', 'codex', payload, options);
    assert.equal(live.status, 'failed');
    assert.equal(live.reason.split(guide).length - 1, 1);
    fs.unlinkSync(lock);
    const retained = join(installed.control, 'operation-00000000-0000-0000-0000-000000000000');
    mkdirSync(retained);
    const interrupted = await operateSkill('remove', 'codex', payload, options);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.reason.split(guide).length - 1, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows short temporary-root spellings resolve to their physical directory', ({ skip }) => {
  if (process.platform !== 'win32') {
    skip();
    return;
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc temporary spaces '));
  try {
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'for %I in (.) do @echo %~fsI'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const short = result.stdout.trim();
    if (!short.includes('~')) {
      skip('This volume supplies no short path alias.');
      return;
    }
    const entry = skillTemporaryRoots({ TEMP: short }, 'win32', root).find((item) => item.source === 'TEMP');
    assert.equal(entry.state, 'resolved');
    assert.equal(entry.canonical, fs.realpathSync.native(root).toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled dispatch commands preserve exact event claims and readable private reports without a host', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-dispatch-smoke-'));
  const receipts = new DispatchReceipts(home);
  const origin = 'a'.repeat(24);
  const launch = receipts.reserve({
    origin,
    requester: null,
    policy: null,
    promptSha256: payloadSha256('review'),
    completion: 'wait',
    alias: null,
  });
  const event = receipts.publish(
    launch.launchId,
    { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
    'Saved report',
  );
  const outcome = join(home, 'outcome.md');
  writeFileSync(outcome, 'Accepted');
  const run = promisify(execFile);
  const env = { ...smokeEnv, ARC_HOME: home };
  const call = async (action, extra = []) =>
    JSON.parse(
      (
        await run(process.execPath, [cli, 'dispatch', action, launch.launchId, ...extra, '--json'], {
          env,
          encoding: 'utf8',
        })
      ).stdout,
    );
  try {
    assert.equal((await call('result', ['--event', event.eventId])).text, 'Saved report');
    assert.equal((await call('status')).events[0].eventId, event.eventId);
    const claim = await call('claim', ['--event', event.eventId, '--origin', origin, '--owner', 'consumer']);
    const recovered = await call('claim', ['--event', event.eventId, '--origin', origin, '--owner', 'consumer']);
    assert.equal(recovered.token, claim.token);
    const ackArgs = [
      '--event',
      event.eventId,
      '--origin',
      origin,
      '--owner',
      'consumer',
      '--token',
      claim.token,
      '--outcome-file',
      outcome,
    ];
    assert.equal((await call('ack', ackArgs)).status, 'consumed');
    assert.equal((await call('ack', ackArgs)).disposition, 'Accepted');
    writeFileSync(outcome, 'Rejected');
    await assert.rejects(call('ack', ackArgs), /different saved disposition/);
    assert.equal((await call('refresh')).events.length, 1);
    assert.equal((await call('recover', ['--event', event.eventId])).delivery, 'unavailable');
    assert.equal((await call('monitor')).state, 'unavailable');
    assert.equal((await call('wait', ['--deadline-ms', '1'])).state, 'uncertain');
    await assert.rejects(call('result', ['--event', '../unsafe']));
    await assert.rejects(call('status', ['--owner', 'unexpected']));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bundled windows command reaches authenticated hosts and keeps secrets out of both output formats', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-windows-smoke-'));
  const first = new WindowChannel(home);
  const second = new WindowChannel(home);
  const env = { ...smokeEnv, ARC_HOME: home };
  const run = promisify(execFile);
  try {
    first.setGuardedReadHandler(async () => {
      throw new Error('Discovery sends no read acknowledgment.');
    });
    first.setDispatchHandler(() => {
      throw new Error('Discovery sends no dispatch action.');
    });
    await first.update({
      folders: ['C:/Project With Spaces'],
      scopeReady: true,
      panelReady: true,
      panelVisible: false,
    });
    await second.update({ folders: [], scopeReady: false, panelReady: false, panelVisible: false });
    const json = await run(process.execPath, [cli, 'windows', '--json'], { env, encoding: 'utf8' });
    const report = JSON.parse(json.stdout);
    assert.equal(report.version, 1);
    assert.equal(report.complete, true);
    assert.equal(report.windows.length, 2);
    assert.equal(report.windows.find((window) => window.hostId === first.hostId).panelReady, true);
    assert.equal(report.windows.find((window) => window.hostId === second.hostId).scopeReady, false);
    assert.ok(report.windows.find((window) => window.hostId === first.hostId).capabilities.includes('sessionRead'));
    assert.ok(report.windows.find((window) => window.hostId === first.hostId).capabilities.includes('dispatchResults'));
    assert.equal(
      report.windows.find((window) => window.hostId === second.hostId).capabilities.includes('sessionRead'),
      false,
    );
    assert.equal(json.stdout.includes('token'), false);
    assert.equal(json.stdout.includes('address'), false);
    const human = await run(process.execPath, [cli, 'windows'], { env, encoding: 'utf8' });
    assert.match(human.stdout, /scope ready  panel hidden  "C:\/Project With Spaces"/);
    assert.match(human.stdout, /scope loading  panel not ready  \(no folders\)/);
    for (const channel of [first, second]) {
      const registration = readFileSync(join(home, 'hosts', `${channel.hostId}.json`), 'utf8');
      assert.equal(human.stdout.includes(JSON.parse(registration).token), false);
    }
    await Promise.all([first.dispose(), second.dispose()]);
    const empty = await run(process.execPath, [cli, 'windows', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(empty.stdout), { version: 1, windows: [], complete: true });
    for (let index = 0; index <= 1024; index++) {
      writeFileSync(join(home, 'hosts', `unrelated-${index}`), '');
    }
    const incomplete = await run(process.execPath, [cli, 'windows', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(incomplete.stdout), { version: 1, windows: [], complete: false });
    const partial = await run(process.execPath, [cli, 'windows'], { env, encoding: 'utf8' });
    assert.match(partial.stdout, /discovery is incomplete/);
    assert.equal(partial.stdout.includes('No Arc windows are open.'), false);
    await assert.rejects(run(process.execPath, [cli, 'windows', '--unknown'], { env }), /Usage: arc windows/);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled discovery retains registry access denial without leaking errors or failing partial output', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-window-access-'));
  const reachable = new WindowChannel(home);
  const denied = 'f'.repeat(24);
  const deniedFile = join(home, 'hosts', denied + '.json');
  const preload = join(home, 'access.cjs');
  const run = promisify(execFile);
  try {
    await reachable.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    writeFileSync(deniedFile, '{}');
    writeFileSync(
      preload,
      `const fs = require('node:fs'); const original = fs.lstatSync; fs.lstatSync = function(file, ...args) { if (file === ${JSON.stringify(deniedFile)}) throw Object.assign(new Error('secret-token-address-stack'), { code: 'EACCES' }); return original.call(this, file, ...args); };`,
    );
    const options = { env: { ...smokeEnv, ARC_HOME: home }, encoding: 'utf8' };
    const json = await run(process.execPath, ['--require', preload, cli, 'windows', '--json'], options);
    const report = JSON.parse(json.stdout);
    assert.equal(report.version, 1);
    assert.equal(report.complete, false);
    assert.deepEqual(
      report.windows.map((window) => window.hostId),
      [reachable.hostId],
    );
    assert.deepEqual(report.diagnostics, [{ code: 'EACCES', stage: 'registry', hostId: denied }]);
    assert.doesNotMatch(json.stdout, /secret|token|address|stack/);
    const human = await run(process.execPath, ['--require', preload, cli, 'windows'], options);
    assert.match(human.stdout, /discovery is incomplete/);
    assert.match(human.stdout, /Window details f{24}: EACCES\./);
    assert.doesNotMatch(human.stdout, /secret|token|address|stack/);
  } finally {
    await reachable.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bundled CLI reports the package version', () => {
  const output = execFileSync(process.execPath, [cli, '--version'], { env: smokeEnv, encoding: 'utf8' });
  assert.equal(output.trim(), packageJson.version);
});

test('every admitted command renders shared help before stdin, discovery, network, or file changes', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-help-smoke-'));
  const preload = join(home, 'no-io.cjs');
  const run = promisify(execFile);
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const net = require('node:net');
const read = fs.readFileSync;
const deny = () => { throw new Error('Help performed I/O.'); };
fs.readFileSync = (file, ...args) => file === ${JSON.stringify(cli)} ? read(file, ...args) : deny();
fs.readFile = deny;
fs.promises.readFile = deny;
fs.promises.opendir = deny;
for (const name of ['readdirSync', 'statSync', 'lstatSync', 'mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'rmSync']) fs[name] = deny;
for (const name of ['readdir', 'stat', 'lstat', 'mkdir', 'writeFile', 'rename', 'unlink', 'rm']) {
  fs[name] = deny;
  fs.promises[name] = deny;
}
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
process.stdin.setEncoding = deny;
process.stdin[Symbol.asyncIterator] = deny;
`,
  );
  try {
    const options = {
      env: { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: 'unavailable' },
      encoding: 'utf8',
      timeout: 10_000,
    };
    for (const command of COMMANDS) {
      const result = await run(
        process.execPath,
        ['--require', preload, cli, ...command.name.split(' '), '--help'],
        options,
      );
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, renderCommandHelp(command) + '\n');
    }
    for (const args of [[], ['help'], ['--help']]) {
      assert.equal(
        (await run(process.execPath, ['--require', preload, cli, ...args], options)).stdout,
        renderOverviewHelp() + '\n',
      );
    }
    assert.equal(
      (await run(process.execPath, ['--require', preload, cli, 'start', '--help', '--version'], options)).stdout.trim(),
      packageJson.version,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('command admission requires complete help data', () => {
  checkCommandHelp(COMMANDS);
  for (const command of COMMANDS) {
    assert.throws(() => checkCommandHelp([{ ...command, help: undefined }]), /Missing command help/);
    for (const field of ['summary', 'synopsis', 'flags', 'output', 'refusals', 'example']) {
      assert.throws(
        () => checkCommandHelp([{ ...command, help: { ...command.help, [field]: undefined } }]),
        /Missing command help/,
      );
    }
  }
});

test('bundled self compaction uses read-only readiness, one admission and observation without retries', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc compact smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  let ready = true;
  let loseReply = false;
  const readyTimes = [];
  channel.setCompactRequestHandler(async (request) => {
    requests.push(request);
    if (request.method === 'compact-ready') readyTimes.push(Date.now());
    if (request.method === 'compact-ready') return { ready };
    if (request.method === 'compact-request' && loseReply) {
      await channel.dispose();
      return {};
    }
    return { state: 'queued', requestId: request.params.requestId };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = { ...smokeEnv, ARC_HOME: home };
    const requestId = channel.hostId + ':aaaaaaaa-1111-2222-3333-444444444444';
    const args = [
      cli,
      'compact',
      'request',
      '--self',
      '--after-turn',
      '--request-id',
      requestId,
      '--window',
      channel.hostId,
      '--json',
    ];
    const output = await run(process.execPath, args, { env });
    assert.equal(JSON.parse(output.stdout).state, 'queued');
    assert.deepEqual(
      requests.map((r) => r.method),
      ['compact-ready', 'compact-request'],
    );
    assert.equal(requests[1].id, requestId);
    await run(
      process.execPath,
      [cli, 'compact', 'status', '--request-id', requestId, '--window', channel.hostId, '--json'],
      { env },
    );
    assert.equal(requests.at(-1).method, 'compact-status');
    const before = requests.length;
    for (const extra of ['--session', '--background', '--self'])
      await assert.rejects(run(process.execPath, [...args, extra], { env }));
    assert.equal(requests.length, before);
    ready = false;
    const readsBefore = readyTimes.length;
    const refused = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(refused.state, 'refused');
    // Back-to-back reads would end before a late native tool start reaches the window.
    const reads = readyTimes.slice(readsBefore);
    assert.ok(reads.length >= 2, 'readiness reads more than once');
    assert.ok(reads.at(-1) - reads[0] >= 450 * (reads.length - 1), 'readiness reads are spread across its deadline');
    assert.equal(
      requests.slice(before).every((r) => r.method === 'compact-ready'),
      true,
    );
    ready = true;
    loseReply = true;
    const writesBefore = requests.filter((r) => r.method === 'compact-request').length;
    const uncertain = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.requestId, requestId);
    assert.equal(requests.filter((r) => r.method === 'compact-request').length, writesBefore + 1);
    // The lost reply closed the window, so status names the outcome instead of failing.
    const gone = await run(
      process.execPath,
      [cli, 'compact', 'status', '--request-id', requestId, '--window', channel.hostId, '--json'],
      { env },
    );
    assert.equal(JSON.parse(gone.stdout).state, 'unavailable');
    assert.equal(JSON.parse(gone.stdout).requestId, requestId);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// This packaged check catches argument routing and unwanted dispatch receipts with one local channel.
test('bundled management commands carry reader-default classification, prompt files and curation without implicit receipts', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc management smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setDispatchHandler(() => null);
  channel.setRequestHandler((request) => {
    requests.push(request);
    return request.method === 'start'
      ? { status: 'accepted', provider: request.params.setup.agent, sessionId: 'accepted' }
      : { status: 'applied' };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = { ...smokeEnv, CLAUDE_CODE_SESSION_ID: 'coordinator', ARC_HOME: home, ARC_WINDOW: channel.hostId };
    const prompt = join(home, 'initial prompt.txt');
    writeFileSync(prompt, 'Review this project.');
    for (const provider of ['claude', 'codex'])
      for (const [classification, agentRun] of [
        [[], false],
        [['--agent-run'], true],
        [['--agent-run=true'], true],
        [['--agent-run=false'], false],
      ]) {
        const args = [
          cli,
          'start',
          '--provider',
          provider,
          '--model',
          'runtime-model',
          '--effort',
          'runtime-effort',
          '--prompt-file',
          prompt,
          ...classification,
          '--name',
          'Review',
          '--label',
          'Initial',
          '--pinned',
        ];
        const output = await run(process.execPath, args, { env, encoding: 'utf8' });
        assert.equal(output.stdout.includes('ARC_DISPATCH_SESSION='), false);
        assert.equal(requests.at(-1).params.agentRun, agentRun);
        assert.equal(requests.at(-1).params.prompt, 'Review this project.');
        const tagged = await run(process.execPath, [...args, '--arc-dispatch'], { env, encoding: 'utf8' });
        const receipt = JSON.parse(tagged.stdout.trim().split('\n')[1].slice('ARC_DISPATCH_SESSION='.length));
        assert.equal(receipt.agent, provider);
        assert.equal(receipt.owned === true, !agentRun);
      }
    await run(process.execPath, [cli, 'label', 'remove', 'accepted', '--label', 'Initial', '--dry-run'], { env });
    assert.equal(requests.at(-1).params.action, 'label-remove');
    assert.equal(requests.at(-1).params.dryRun, true);
    await run(process.execPath, [cli, 'archive', 'accepted', '--force'], { env });
    assert.equal(requests.at(-1).params.force, true);
    for (const cwd of [home, process.cwd()]) {
      await run(
        process.execPath,
        [cli, 'start', '--provider', 'codex', '--prompt-file', prompt, '--read-only', '--cwd', '.'],
        { env, cwd },
      );
      assert.equal(requests.at(-1).params.cwd, realpathSync(cwd));
      assert.equal(requests.at(-1).params.readOnly, true);
      assert.equal(requests.at(-1).params.agentRun, false);
    }
    await run(
      process.execPath,
      [
        cli,
        'start',
        '--provider',
        'claude',
        '--prompt-file',
        prompt,
        '--read-only',
        '--read-tool',
        'mcp__server__read',
        '--read-tool',
        'mcp__server__list',
      ],
      { env },
    );
    assert.deepEqual(requests.at(-1).params.readTools, ['mcp__server__read', 'mcp__server__list']);
    const before = requests.length;
    for (const flags of [
      ['--agent-run', '--agent-run'],
      ['--agent-run', '--agent-run=false'],
      ['--agent-run=true', '--agent-run'],
      ['--agent-run=true', '--agent-run=false'],
      ['--agent-run='],
      ['--agent-run=yes'],
      ['--agent-run=True'],
      ['--agent-run', 'false'],
      ['--untagged'],
      ['--read-only', '--permissions', 'danger-full-access'],
      ['--read-only', '--read-tool', 'mcp__server__read'],
      ['--read-tool', 'mcp__server__read'],
    ]) {
      await assert.rejects(
        run(process.execPath, [cli, 'start', '--provider', 'codex', '--prompt-file', prompt, ...flags], { env }),
      );
    }
    assert.equal(requests.length, before, 'invalid classification never reaches the host');
    writeFileSync(prompt, '/clear');
    await assert.rejects(
      run(process.execPath, [cli, 'start', '--provider', 'codex', '--prompt-file', prompt], { env }),
      /prompt-box command/,
    );
    assert.equal(requests.length, before);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled read validates bounded attribution and capability before retaining curation retries', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc read smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = {
      ...process.env,
      ARC_HOME: home,
      ARC_WINDOW: channel.hostId,
      CLAUDE_CODE_SESSION_ID: 'reader',
      CODEX_THREAD_ID: '',
    };
    const args = [
      cli,
      'read',
      'worker',
      '--observation',
      observation,
      '--request-id',
      `${channel.hostId}:read`,
      '--json',
    ];
    await assert.rejects(run(process.execPath, args, { env }), /does not support marking sessions read/);
    channel.setGuardedReadHandler(async (request) => {
      requests.push(request);
      return {
        version: 1,
        status: request.params.dryRun ? 'dry-run' : 'applied',
        requestId: request.id,
        sessionId: 'worker',
        requester: { provider: request.requesterProvider, id: request.requester },
        marked: [],
        reason: 'saved',
      };
    });
    const applied = JSON.parse((await run(process.execPath, args, { env })).stdout);
    assert.equal(applied.status, 'applied');
    await run(process.execPath, args, { env });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requesterProvider, 'claude');
    assert.deepEqual(requests[0].params, { sessionId: 'worker', observation, dryRun: false });
    await assert.rejects(run(process.execPath, [...args, '--dry-run'], { env }), /already names a different request/);
    for (const [invalid, invalidEnv, pattern] of [
      [args.slice(0, -3), env, /Usage: arc read/],
      [args.map((arg) => (arg === observation ? 'bad' : arg)), env, /read observation is invalid/],
      [[...args, '--force'], env, /unavailable for read/],
      [args, { ...env, CODEX_THREAD_ID: 'other' }, /Run read from one/],
      [args, { ...env, CLAUDE_CODE_SESSION_ID: '' }, /Run read from one/],
    ])
      await assert.rejects(run(process.execPath, invalid, { env: invalidEnv }), pattern);
    assert.equal(requests.length, 1);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled send reads Unicode multiline prompt files, requires observations and request IDs, and refuses ambiguity before sending', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc send smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const sends = [];
  channel.setGuardedSendHandler(async (request) => {
    sends.push(request);
    return {
      version: 1,
      status: 'accepted',
      requestId: request.id,
      payloadSha256: 'host',
      nativeTurnId: 'turn-1',
      reason: 'The session received the prompt.',
    };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = {
      ...smokeEnv,
      ARC_HOME: home,
      ARC_WINDOW: channel.hostId,
      CLAUDE_CODE_SESSION_ID: 'coordinator',
      CODEX_THREAD_ID: '',
    };
    const prompt = join(home, 'follow up.txt');
    const text = 'Línea uno ✓\nSecond line\r\n';
    writeFileSync(prompt, '\uFEFF' + text);
    const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
    const id = `${channel.hostId}:one`;
    const args = [cli, 'send', 'worker', '--prompt-file', prompt, '--observation', observation, '--request-id', id];
    const reply = JSON.parse((await run(process.execPath, [...args, '--json'], { env, encoding: 'utf8' })).stdout);
    assert.equal(reply.status, 'accepted');
    assert.equal(reply.requestId, id);
    assert.equal(sends[0].params.prompt, text);
    assert.equal(sends[0].requester, 'coordinator');
    assert.equal(sends[0].requesterProvider, 'claude');
    const retried = await run(process.execPath, args, { env, encoding: 'utf8' });
    assert.match(retried.stdout, /received the prompt\. Request ID: /);
    assert.equal(sends.length, 1);
    const refusals = [
      [args.filter((arg) => arg !== '--observation' && arg !== observation), env, /Usage: arc send/],
      [args.slice(0, -2), env, /Usage: arc send/],
      [args.map((arg) => (arg === observation ? 'stale' : arg)), env, /observation is invalid/],
      [[...args, '--agent-run=false'], env, /unavailable for send/],
      [args, { ...env, CODEX_THREAD_ID: 'codex-thread' }, /Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID/],
      [args, { ...env, CLAUDE_CODE_SESSION_ID: '' }, /Run send from/],
    ];
    for (const [refused, refusedEnv, pattern] of refusals)
      await assert.rejects(run(process.execPath, refused, { env: refusedEnv }), pattern);
    for (const [content, pattern] of [
      ['/compact', /prompt-box command/],
      [' \n', /prompt-box command/],
      ['x'.repeat(48 * 1024 + 1), /exceeds 48 KiB/],
      ['"'.repeat(40_000), /channel limit/],
    ]) {
      writeFileSync(prompt, content);
      await assert.rejects(run(process.execPath, args, { env }), pattern);
    }
    assert.equal(sends.length, 1);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled guarded starts refuse ambiguous requesters, and a window without the provider capability gets only the base request keys', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc guarded start smoke '));
  const channel = new WindowChannel(home);
  // A window from before the provider field publishes no capabilities, and its parser accepts only the base keys.
  const info = channel.info;
  channel.info = function () {
    const { capabilities: _capabilities, ...rest } = info.call(this);
    return rest;
  };
  const run = promisify(execFile);
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return request.method === 'start'
      ? { status: 'accepted', provider: 'claude', sessionId: 'worker' }
      : { state: 'current', turns: [] };
  });
  const sends = [];
  channel.setGuardedSendHandler(async (request) => {
    sends.push(request);
    return { version: 1, status: 'accepted', requestId: request.id, payloadSha256: 'x', nativeTurnId: 't', reason: '' };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = {
      ...smokeEnv,
      ARC_HOME: home,
      ARC_WINDOW: channel.hostId,
      CLAUDE_CODE_SESSION_ID: 'coordinator',
      CODEX_THREAD_ID: '',
    };
    const prompt = join(home, 'prompt.txt');
    writeFileSync(prompt, 'Prepare the worktree.');
    const start = [cli, 'start', '--provider', 'claude', '--prompt-file', prompt];
    await assert.rejects(
      run(process.execPath, [...start, '--arc-dispatch'], { env, encoding: 'utf8' }),
      /must reload.*dispatch/,
    );
    assert.equal(requests.length, 0);
    await run(process.execPath, start, { env, encoding: 'utf8' });
    await run(process.execPath, [cli, 'session', 'worker', '--json'], { env, encoding: 'utf8' });
    const base = 'id,method,params,requester,token,version';
    assert.deepEqual(
      requests.map((request) => Object.keys(request).sort().join(',')),
      [base, base],
    );
    const observation = 'a'.repeat(40) + '.' + 'b'.repeat(43);
    const send = [cli, 'send', 'worker', '--prompt-file', prompt, '--observation', observation];
    await assert.rejects(
      run(process.execPath, [...send, '--request-id', `${channel.hostId}:send`], { env }),
      /must reload/,
    );
    assert.equal(sends.length, 0);
    const ambiguous = { ...env, CODEX_THREAD_ID: 'codex-thread' };
    await assert.rejects(
      run(process.execPath, [...start, '--arc-dispatch'], { env: ambiguous }),
      /Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID/,
    );
    assert.equal(requests.length, 2);
    await run(process.execPath, start, { env: ambiguous, encoding: 'utf8' });
    assert.equal(requests.length, 3, 'a start without --arc-dispatch keeps working and records no owner');
    assert.equal('requesterProvider' in requests[2], false);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled session commands select one window, reject unknown IDs, and bound turns before sending', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-session-smoke-'));
  const channel = new WindowChannel(home);
  const second = new WindowChannel(home);
  const run = promisify(execFile);
  let requests = 0;
  channel.setRequestHandler((request) => {
    requests++;
    if (request.method === 'session' && request.params.sessionId !== 'known') throw new Error('Unknown session.');
    return { method: request.method, params: request.params, requester: request.requester };
  });
  const env = {
    ...smokeEnv,
    ARC_HOME: home,
    ARC_WINDOW: channel.hostId,
    CODEX_THREAD_ID: 'requesting-agent',
    CLAUDE_CODE_SESSION_ID: '',
  };
  try {
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    await second.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const listing = await run(process.execPath, [cli, 'sessions'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(listing.stdout), { method: 'sessions', params: {}, requester: 'requesting-agent' });
    const paged = await run(process.execPath, [cli, 'sessions', '--limit', '5', '--cursor', 'Page-2_x', '--json'], {
      env,
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(paged.stdout).params, { cursor: 'Page-2_x', limit: 5 });
    const maximum = SESSION_PAGE_LIMITS.rows;
    assert.equal(maximum, 128);
    const pageRequest = {
      sources: [],
      cursor: null,
      limit: maximum,
      catalog: 'complete',
      fresh: true,
      scope: 'smoke',
      secret: Buffer.alloc(32),
      requester: null,
      project: () => assert.fail('An empty catalog has no rows to project.'),
    };
    assert.equal(sessionListingPage(pageRequest).complete, true);
    assert.throws(() => sessionListingPage({ ...pageRequest, limit: maximum + 1 }), /Limit must be between/);
    const wireRequest = {
      id: 'page-bound',
      version: 1,
      token: 'b'.repeat(64),
      requester: null,
      method: 'sessions',
      params: { limit: maximum },
    };
    assert.deepEqual(parseSessionRequest(wireRequest), wireRequest);
    assert.equal(parseSessionRequest({ ...wireRequest, params: { limit: maximum + 1 } }), null);
    const largest = await run(process.execPath, [cli, 'sessions', '--limit', String(maximum)], {
      env,
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(largest.stdout).params, { limit: maximum });
    const atMaximum = requests;
    await assert.rejects(
      run(process.execPath, [cli, 'sessions', '--limit', String(maximum + 1)], { env }),
      /Limit must be between/,
    );
    assert.equal(requests, atMaximum);
    const detail = await run(
      process.execPath,
      [cli, 'session', 'known', '--turns', '2', '--window', channel.hostId, '--json'],
      { env: { ...env, ARC_WINDOW: second.hostId }, encoding: 'utf8' },
    );
    assert.equal(JSON.parse(detail.stdout).params.turns, 2);
    await assert.rejects(run(process.execPath, [cli, 'session', 'unknown'], { env }), /Unknown session/);
    const before = requests;
    for (const args of [
      ['session', 'known', '--turns', '21'],
      ['session', 'known', '--turns', '0'],
      ['session', 'known', '--turns', '1.5'],
      ['sessions', '--turns', '1'],
      ['sessions', '--limit', '1', '--limit', '2'],
      ['sessions', '--cursor', 'a', '--cursor', 'b'],
      ['session', 'known', '--limit', '1'],
      ['session'],
    ]) {
      await assert.rejects(run(process.execPath, [cli, ...args], { env }));
    }
    // The window would also refuse these, so the message shows that the CLI refused them first.
    for (const [args, message] of [
      [['--limit', '0'], /Limit must be between 1 and 128/],
      [['--limit', '129'], /Limit must be between 1 and 128/],
      [['--limit', '1.5'], /Limit must be between 1 and 128/],
      [['--limit'], /Limit must be between 1 and 128/],
      [['--cursor'], /Restart the listing without --cursor/],
      [['--cursor', 'abc='], /Restart the listing without --cursor/],
      [['--cursor', 'a'.repeat(513)], /Restart the listing without --cursor/],
    ]) {
      await assert.rejects(run(process.execPath, [cli, 'sessions', ...args], { env }), message);
    }
    assert.equal(requests, before);
    await assert.rejects(
      run(process.execPath, [cli, 'sessions'], { env: { ...env, ARC_WINDOW: '' } }),
      /Select one Arc window/,
    );
  } finally {
    await Promise.all([channel.dispose(), second.dispose()]);
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled session commands attribute child requests only to their native session identity', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-child-requester-smoke-'));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  channel.setRequestHandler((request) => ({ requester: request.requester }));
  const launched = childEnv(
    { ...smokeEnv, CLAUDE_CODE_SESSION_ID: 'parent-claude', CODEX_THREAD_ID: 'parent-codex' },
    { ARC_HOME: home, ARC_WINDOW: channel.hostId },
    'codex',
  );
  try {
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    for (const [native, requester] of [
      [{}, null],
      [{ CODEX_THREAD_ID: 'native-codex' }, 'native-codex'],
      [{ CLAUDE_CODE_SESSION_ID: 'native-claude' }, 'native-claude'],
    ]) {
      const result = await run(process.execPath, [cli, 'session', 'target-session', '--json'], {
        env: { ...smokeEnv, ...launched, ...native },
        encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(result.stdout), { requester });
    }
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bundled CLI reads Claude JSON and emits its versioned JSON contract', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--json'], {
    env: smokeEnv,
    input,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.context.maxTokens, 200_000);
  assert.equal(parsed.cache.state, 'warm');
  assert.equal(parsed.nextTurn.state, 'warm');
  assert.equal(parsed.workspace.name, 'arc');
  assert.equal(parsed.session.estimatedCostDollars, 0.1234);
  assert.equal(parsed.limits.fiveHour.usedPercentage, 23.5);
});

test('the bundled CLI emits a compact text status line', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--width', '70'], {
    env: smokeEnv,
    input,
    encoding: 'utf8',
  });
  const [primary, secondary] = output.trimEnd().split('\n');
  assert.match(primary, /^ctx 8% of 200k \(16k\) \| cache warm .* \| next turn starts at \$0\.02$/);
  assert.equal(secondary, 'session $0.12, 45s | 5h 23.5% | 7d 41.2%');
});

test('the bundled CLI emits only the next-turn segment for another status line', () => {
  const output = execFileSync(process.execPath, [cli, 'statusline', '--next-turn'], {
    env: smokeEnv,
    input,
    encoding: 'utf8',
  });
  assert.equal(output, 'next turn starts at $0.02\n');
});

test('the bundled CLI rejects malformed JSON without writing status output', () => {
  const result = spawnSync(process.execPath, [cli, 'statusline'], {
    env: smokeEnv,
    input: '{',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'arc: Claude status input is not valid JSON.\n');
});

test('the bundled cost command reads isolated roots and reports failures on stderr', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-cost-smoke-'));
  const projects = join(root, 'projects');
  const codex = join(root, 'sessions');
  const file = join(projects, 'sample', 'session-1.jsonl');
  mkdirSync(join(projects, 'sample'), { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-26T00:00:01Z',
      message: {
        id: 'request-1',
        model: 'claude-opus-5',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n',
  );
  const env = {
    ...smokeEnv,
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root,
    ARC_PROJECTS_ROOT: projects,
    ARC_CODEX_ROOT: codex,
  };
  try {
    const result = spawnSync(process.execPath, [cli, 'cost', 'session-1'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 2);
    assert.match(report.buildCommit, /^[0-9a-f]{40}$/);
    assert.equal(report.source.file, file);
    assert.equal(report.parent.requests, 1);
    assert.equal('modelCosts' in report.parent, false);
    const detail = spawnSync(process.execPath, [cli, 'cost', file, '--source-only', '--by-model'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(detail.status, 0, detail.stderr);
    const flagged = JSON.parse(detail.stdout);
    const { modelCosts, ...parent } = flagged.parent;
    assert.deepEqual(parent, report.parent);
    assert.deepEqual(flagged.children, []);
    assert.deepEqual(flagged.combined, parent);
    assert.equal(modelCosts[0].model, 'claude-opus-5');
    assert.equal(modelCosts[0].requests, 1);
    const rejected = spawnSync(process.execPath, [cli, 'cost', 'session-1', '--source-only'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /requires an existing transcript file path/);
    const failure = spawnSync(process.execPath, [cli, 'cost', 'missing'], { env, encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /No transcript found/);
    const native = readFileSync(file, 'utf8');
    const stream = [
      { type: 'system', subtype: 'init', session_id: 'stream', tools: [] },
      { ...JSON.parse(native), parent_tool_use_id: null },
      { type: 'result', subtype: 'success', total_cost_usd: 1 },
    ];
    for (const content of [
      JSON.stringify(stream),
      JSON.stringify(stream, null, 2),
      stream.map((record) => JSON.stringify(record)).join('\n'),
      '',
      'not JSON',
      '{"unrelated":true}',
    ]) {
      writeFileSync(file, content);
      const unsupported = spawnSync(process.execPath, [cli, 'cost', file, '--source-only'], { env, encoding: 'utf8' });
      assert.equal(unsupported.status, 1, content);
      assert.equal(unsupported.stdout, '');
      assert.match(unsupported.stderr, /Claude stream logs|No native transcript records/);
      assert.equal(unsupported.stderr.includes(file), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the packed package installs only arc globally and runs locally offline', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-installed-smoke-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const consumer = join(root, 'consumer');
  const prefix = join(root, 'global');
  const packable = join(root, 'package');
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run packaging smoke tests through npm.');
  mkdirSync(consumer);
  mkdirSync(join(packable, 'dist'), { recursive: true });
  mkdirSync(join(packable, 'skills/arc-sessions'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/arc.cjs', 'skills/arc-sessions/SKILL.md']) {
    copyFileSync(join(packageRoot, file), join(packable, file));
  }
  writeFileSync(join(packable, 'dist/obsolete.cjs'), 'obsolete bundle');
  writeFileSync(join(packable, 'dist/arc.cjs.map'), 'source map');
  writeFileSync(join(root, 'user.npmrc'), '');
  writeFileSync(join(root, 'global.npmrc'), '');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'arc-smoke-consumer', private: true }));
  const env = {
    ...Object.fromEntries(Object.entries(smokeEnv).filter(([key]) => !key.toLowerCase().startsWith('npm_config_'))),
    npm_config_userconfig: join(root, 'user.npmrc'),
    npm_config_globalconfig: join(root, 'global.npmrc'),
    npm_config_cache: join(root, 'cache'),
    npm_config_prefix: prefix,
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: root,
    ARC_PROJECTS_ROOT: join(root, 'projects'),
    ARC_CODEX_ROOT: join(root, 'sessions'),
    HOME: join(root, 'native home'),
    USERPROFILE: join(root, 'native home'),
  };
  const nativeRoots = [join(env.HOME, '.claude/skills'), join(env.HOME, '.agents/skills')];
  for (const folder of nativeRoots) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'preserve'), 'native instructions');
  }
  const options = { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 };
  function npm(args, cwd = consumer) {
    const result = spawnSync(process.execPath, [npmCli, ...args], { ...options, cwd });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  function installed(installPrefix, command, args, stdin) {
    const launcher = join(installPrefix, process.platform === 'win32' ? `${command}.cmd` : `bin/${command}`);
    if (process.platform === 'win32') {
      assert.ok(lstatSync(launcher).isFile());
    } else {
      assert.ok(lstatSync(launcher).isSymbolicLink());
      assert.ok(lstatSync(realpathSync(launcher)).mode & 0o111);
    }
    const result =
      process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', `call "${launcher}" ${args.map((arg) => `"${arg}"`).join(' ')}`], {
            ...options,
            windowsVerbatimArguments: true,
            input: stdin,
          })
        : spawnSync(launcher, args, { ...options, input: stdin });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stderr}`);
    return result.stdout;
  }
  try {
    const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], packable));
    const tarball = join(root, packed.filename);
    assert.deepEqual(packed.files.map(({ path }) => path).sort(), [
      'LICENSE',
      'README.md',
      'dist/arc.cjs',
      'package.json',
      'skills/arc-sessions/SKILL.md',
    ]);
    npm(['install', '--global', '--prefix', prefix, tarball]);
    const installedRoot = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@glin/arc');
    const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(
      readFileSync(join(installedRoot, 'skills/arc-sessions/SKILL.md'), 'utf8'),
      readFileSync(join(packageRoot, 'skills/arc-sessions/SKILL.md'), 'utf8'),
    );
    assert.equal(manifest.name, '@glin/arc');
    assert.deepEqual(manifest.bin, { arc: 'dist/arc.cjs' });
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.publishConfig.access, 'public');
    assert.deepEqual(manifest.repository, {
      type: 'git',
      url: 'git+https://github.com/glin/arc.git',
      directory: 'cli',
    });
    assert.equal(manifest.homepage, 'https://github.com/glin/arc/tree/main/cli#readme');
    assert.equal(manifest.bugs.url, 'https://github.com/glin/arc/issues');
    assert.equal(
      readFileSync(join(installedRoot, 'README.md'), 'utf8'),
      readFileSync(join(packageRoot, 'README.md'), 'utf8'),
    );
    assert.deepEqual(
      readFileSync(join(installedRoot, 'LICENSE')),
      readFileSync(new URL('../../LICENSE', import.meta.url)),
    );
    const transcript = join(consumer, 'session.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-26T00:00:01Z',
        message: {
          id: 'installed-request',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      }) + '\n',
    );
    const costArgs = ['cost', transcript, '--source-only', '--by-model'];
    const expectedCost = JSON.parse(execFileSync(process.execPath, [cli, ...costArgs], options));
    const installedInput = JSON.stringify({
      ...fixture,
      prompt_cache: { ...fixture.prompt_cache, expires_at: 1 },
    });
    const expectedStatus = JSON.parse(
      execFileSync(process.execPath, [cli, 'statusline', '--json'], { ...options, input: installedInput }),
    );
    const expectedHelp = execFileSync(process.execPath, [cli, '--help'], options);
    for (const command of ['arc']) {
      assert.equal(installed(prefix, command, ['--version']).trim(), packageJson.version);
      assert.equal(installed(prefix, command, ['--help']), expectedHelp);
      assert.deepEqual(
        JSON.parse(installed(prefix, command, ['statusline', '--json'], installedInput)),
        expectedStatus,
      );
      assert.deepEqual(JSON.parse(installed(prefix, command, costArgs)), expectedCost);
    }

    npm(['install', tarball]);
    for (const folder of nativeRoots) {
      assert.deepEqual(fs.readdirSync(folder), ['preserve']);
      assert.equal(readFileSync(join(folder, 'preserve'), 'utf8'), 'native instructions');
    }
    assert.equal(npm(['exec', '--offline', '--no', '--', 'arc', '--version']).trim(), packageJson.version);
    assert.deepEqual(JSON.parse(npm(['exec', '--offline', '--no', '--', 'arc', ...costArgs])), expectedCost);
    for (const invoke of [
      (args) => installed(prefix, 'arc', args),
      (args) => npm(['exec', '--offline', '--no', '--', 'arc', ...args]),
    ]) {
      for (const [action, status] of [
        ['install', 'installed'],
        ['update', 'unchanged'],
        ['remove', 'removed'],
      ]) {
        const receipt = JSON.parse(invoke(['skills', action, '--agent', 'codex']));
        assert.deepEqual(
          receipt.results.map((result) => result.status),
          [status],
        );
        const definition = join(env.HOME, '.agents/skills/arc-sessions/SKILL.md');
        if (action !== 'remove')
          assert.deepEqual(readFileSync(definition), readFileSync(join(packageRoot, 'skills/arc-sessions/SKILL.md')));
        else assert.equal(fs.existsSync(definition), false);
      }
    }
    console.log(`Installed package commands executed on ${process.platform} with Node ${process.version}.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('bundled filter commands retrieve selected identities and clear through an explicit launcher flag', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-filter-smoke-'));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return { method: request.method, params: request.params };
  });
  const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: channel.hostId };
  try {
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const query = 'session:claude:one OR session:codex:two';
    for (const args of [
      ['sessions', '--query', query],
      ['filter', query],
      ['filter', '--query', query],
      ['filter', '--clear'],
    ]) {
      const answer = JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { env })).stdout);
      assert.equal(answer.params.query, args.includes('--clear') ? '' : query);
    }
    if (process.platform === 'win32') {
      const command = `& '${process.execPath.replaceAll("'", "''")}' '${cli.replaceAll("'", "''")}' filter --clear --json`;
      const answer = JSON.parse((await run('powershell.exe', ['-NoProfile', '-Command', command], { env })).stdout);
      assert.deepEqual(answer.params, { query: '' });
    }
    const before = requests.length;
    for (const args of [
      ['filter'],
      ['filter', ''],
      ['filter', '--clear', '--clear'],
      ['filter', query, '--clear'],
      ['filter', 'session:one OR'],
      ['filter', 'x'.repeat(201)],
      ['sessions', '--query'],
      ['sessions', '--query', query, '--query', query],
      ['sessions', '--query', 'find:needle'],
      ['filter', '--unknown'],
      ['filter', '--query'],
      ['filter', '--query', ''],
      ['filter', '--query', query, query],
      ['filter', '--query', query, '--clear'],
      ['filter', '--query', query, '--query', query],
    ])
      await assert.rejects(run(process.execPath, [cli, ...args], { env }));
    assert.equal(requests.length, before);
    const registration = join(home, 'hosts', `${channel.hostId}.json`);
    const old = JSON.parse(readFileSync(registration, 'utf8'));
    old.capabilities = ['requesterProvider', 'sessionQuery'];
    writeFileSync(registration, JSON.stringify(old));
    for (const prefix of ['id:01a12cef id:01a12a6b', '-session:claude:abcdefgh', 'session:codex:abcdefgh']) {
      for (const args of [
        ['filter', prefix],
        ['filter', '--query', prefix],
        ['sessions', '--query', prefix],
      ])
        await assert.rejects(run(process.execPath, [cli, ...args], { env }), /must reload/);
    }
    assert.equal(requests.length, before);
    old.capabilities = ['requesterProvider'];
    writeFileSync(registration, JSON.stringify(old));
    await assert.rejects(run(process.execPath, [cli, 'filter', query], { env }), /must reload/);
    await assert.rejects(run(process.execPath, [cli, 'sessions', '--query', query], { env }), /must reload/);
    assert.equal(requests.length, before);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
test('bundled dispatch wait preserves manual routes, invalid selectors and explicit host refusals', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-dispatch-wait-smoke-'));
  const channel = new WindowChannel(home);
  const receipts = new DispatchReceipts(home);
  const run = promisify(execFile);
  channel.setDispatchHandler(() => {
    throw new Error('This dispatch belongs to another Arc activation.');
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const input = {
      origin: channel.hostId,
      requester: null,
      policy: null,
      promptSha256: payloadSha256('review'),
      alias: null,
    };
    const manual = receipts.reserve({ ...input, completion: 'manual' });
    const waited = receipts.reserve({ ...input, completion: 'wait' });
    const env = { ...smokeEnv, ARC_HOME: home };
    const call = (id, extra = []) =>
      run(process.execPath, [cli, 'dispatch', 'wait', id, '--deadline-ms', '1', ...extra, '--json'], { env });
    await assert.rejects(call(manual.launchId), /did not select waited/);
    await assert.rejects(call(waited.launchId, ['--window', 'invalid']), /Invalid Arc window/);
    await assert.rejects(call(waited.launchId), /another Arc activation/);
    channel.setDispatchHandler(() => {
      throw new Error('The selected Arc window is unavailable.');
    });
    await assert.rejects(call(waited.launchId), /unavailable/);
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
