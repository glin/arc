import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalToolPath } from '../../extension/src/toolownership.ts';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { COMMANDS, checkCommandHelp, findCommand, renderCommandHelp } from '../src/commands.ts';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { declarationSource } from '../../extension/test/source-contract.ts';
import { validContinuationPath } from '../../extension/src/compactrequest.ts';
import { bundledTools } from '../../extension/scripts/bundled-tools.mjs';
import { readSkillPayload, skillTemporaryRoots } from '../src/skillfiles.ts';
import { operateSkill } from '../src/skills.ts';
import { runCollect } from '../src/collect.ts';
import { SESSION_PAGE_ERRORS } from '../../extension/src/sessionreads.ts';
import { skillFiles, collectWindow, collectRow, collectPage, collectTurns, collectArgs, cli } from './smoke-fixture.ts';

test('collector restart excludes abandoned rows and preserves independent observations', async () => {
  const calls = [];
  const queue = [
    collectPage([collectRow('old')], { next: 'cursorA', complete: false }),
    new Error(SESSION_PAGE_ERRORS.scope),
    collectPage([collectRow('new')], {
      coverage: 'incomplete',
      freshness: 'stale',
      complete: false,
      extra: 'preserved',
    }),
    collectTurns('new'),
  ];
  const output = JSON.parse(
    await runCollect([...collectArgs, '--turns', '2', '--query', '-is:archived', '--limit', '1'], {
      now: () => 0,
      request: async (method, params, window) => {
        calls.push({ method, params, window });
        const reply = queue.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }),
  );
  assert.deepEqual(output.rows, [{ page: 2, row: 0 }]);
  assert.deepEqual(output.listing.usablePages, [2]);
  assert.equal(output.pages[0].reply.sessions[0].id, 'old');
  assert.equal(output.pages[2].reply.extra, 'preserved');
  assert.equal(output.listing.ended, true);
  assert.equal(output.listing.coverage, 'incomplete');
  assert.equal(output.listing.freshness, 'stale');
  assert.deepEqual(
    calls.map((one) => one.method),
    ['sessions', 'sessions', 'sessions', 'session'],
  );
  assert.deepEqual(
    calls.slice(0, 3).map((one) => one.params),
    [
      { limit: 1, query: '-is:archived' },
      { limit: 1, query: '-is:archived', cursor: 'cursorA' },
      { limit: 1, query: '-is:archived' },
    ],
  );
  assert.ok(calls.every((one) => one.window === collectWindow));
  // These caller projections answer different questions from the same raw collection.
  assert.deepEqual(
    output.rows.map((ref) => output.pages[ref.page].reply.sessions[ref.row].attention),
    ['unknown'],
  );
  assert.deepEqual(
    output.outcomes
      .filter((one) => one.status === 'completed')
      .map((one) => output.reads[one.observations.at(-1)].reply.notes),
    [['bounded']],
  );
});

test('collector recovers unavailable empty first pages and retries the identical continuation', async () => {
  const cursors = [];
  const queue = [
    collectPage([], { coverage: 'unavailable', complete: false }),
    collectPage([collectRow('one')], { next: 'next', complete: false }),
    new Error(SESSION_PAGE_ERRORS.catalog),
    collectPage([collectRow('two')]),
  ];
  const output = JSON.parse(
    await runCollect(collectArgs, {
      now: () => 0,
      request: async (_, params) => {
        cursors.push(params.cursor);
        const reply = queue.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }),
  );
  assert.deepEqual(cursors, [undefined, undefined, 'next', 'next']);
  assert.equal(output.listing.pageRequests, 4);
  assert.deepEqual(output.listing.usablePages, [1, 3]);
  assert.equal(output.rows.length, 2);
  const unavailable = JSON.parse(
    await runCollect(collectArgs, {
      now: () => 0,
      request: async () => collectPage([], { coverage: 'unavailable', complete: false }),
    }),
  );
  assert.equal(unavailable.listing.stop, 'catalog-unavailable');
  assert.equal(unavailable.listing.ended, false);
  assert.equal(unavailable.listing.coverage, null);
  assert.equal(unavailable.pages.length, 2);
});

test('collector preserves collisions and skips identities outside the turn protocol', async () => {
  const rows = [
    collectRow('a', 'same'),
    collectRow('b', 'same', { provider: 'codex' }),
    collectRow('c', 'same', { path: 'other' }),
    collectRow('d', null),
    collectRow('e', ''),
    collectRow('f', 'x'.repeat(257)),
    collectRow('g', 'short', { truncated: ['id'] }),
    collectRow('h', 'ambiguous', { ambiguous: true }),
    collectRow('i', '-literal/?#'),
  ];
  const calls = [];
  const result = JSON.parse(
    await runCollect([...collectArgs, '--turns', '1'], {
      now: () => 0,
      request: async (method, params) => {
        calls.push([method, params]);
        return method === 'sessions'
          ? collectPage(rows)
          : collectTurns(params.sessionId, { readObservation: 'raw-receipt' });
      },
    }),
  );
  assert.equal(result.rows.length, rows.length);
  assert.deepEqual(
    result.outcomes.map((one) => one.reason ?? one.status),
    [
      'ambiguous-identity',
      'ambiguous-identity',
      'ambiguous-identity',
      'null-identity',
      'empty-identity',
      'long-identity',
      'truncated-identity',
      'ambiguous-identity',
      'completed',
    ],
  );
  assert.deepEqual(
    calls.map((one) => one[0]),
    ['sessions', 'session'],
  );
  assert.equal(calls[1][1].sessionId, '-literal/?#');
  assert.equal(result.reads[0].reply.readObservation, 'raw-receipt');
});

test('collector stops listing failures without erasing earlier valid pages', async () => {
  for (const [second, expected] of [
    [{}, 'malformed-listing'],
    [new Error('unknown refusal'), 'listing-failed'],
    [collectPage([collectRow('b')], { next: 'next', complete: false }), 'repeated-cursor'],
    [collectPage([collectRow('a')]), 'duplicate-source'],
  ]) {
    const queue = [collectPage([collectRow('a')], { next: 'next', complete: false }), second];
    const output = JSON.parse(
      await runCollect(collectArgs, {
        now: () => 0,
        request: async () => {
          const one = queue.shift();
          if (one instanceof Error) throw one;
          return one;
        },
      }),
    );
    assert.equal(output.listing.stop, expected);
    assert.equal(output.pages.length, 2);
    assert.equal(output.pages[0].reply.sessions[0].id, 'a');
    assert.equal(output.listing.ended, false);
  }
  let requests = 0;
  const refused = JSON.parse(
    await runCollect(collectArgs, {
      now: () => 0,
      request: async () => {
        requests++;
        throw new Error(SESSION_PAGE_ERRORS.cursor);
      },
    }),
  );
  assert.equal(requests, 2);
  assert.equal(refused.listing.generation, 1);
  assert.equal(refused.rows.length, 0);
});

test('collector validates turn replies and keeps bounded partial observations', async () => {
  for (const [reply, reason] of [
    [collectTurns('other'), 'identity-mismatch'],
    [collectTurns('one', { provider: 'codex' }), 'identity-mismatch'],
    [{ version: 1 }, 'malformed-turns'],
    [collectTurns('one', { state: 'stale', turns: [{}] }), 'malformed-turns'],
    [collectTurns('one'), undefined],
  ]) {
    const output = JSON.parse(
      await runCollect([...collectArgs, '--turns', '1'], {
        now: () => 0,
        request: async (method) => (method === 'sessions' ? collectPage([collectRow('one')]) : reply),
      }),
    );
    assert.equal(output.outcomes[0].reason, reason);
    assert.deepEqual(output.reads[0].reply, reply);
  }
  let attempts = 0;
  const retried = JSON.parse(
    await runCollect([...collectArgs, '--turns', '1', '--max-reads', '2'], {
      now: () => 0,
      request: async (method) => {
        if (method === 'sessions') return collectPage([collectRow('one'), collectRow('two')]);
        if (++attempts === 1) throw new Error('The selected Arc window did not answer in time.');
        return collectTurns('one');
      },
    }),
  );
  assert.equal(retried.turnRequests, 2);
  assert.equal(retried.outcomes.length, 2);
  assert.equal(retried.outcomes[0].observations.length, 1);
  assert.ok(retried.outcomes.every((one) => one.status !== 'completed'));
  attempts = 0;
  const recovered = JSON.parse(
    await runCollect([...collectArgs, '--turns', '1'], {
      now: () => 0,
      request: async (method) => {
        if (method === 'sessions') return collectPage([collectRow('one')]);
        if (++attempts === 1) throw new Error('The selected Arc window did not answer in time.');
        return collectTurns('one');
      },
    }),
  );
  assert.equal(recovered.outcomes[0].status, 'completed');
  assert.deepEqual(recovered.outcomes[0].observations, [0, 1]);
});

test('collector bounds admission, concurrency and escaped output with outcomes for every row', async () => {
  let now = 0;
  let calls = 0;
  const expired = JSON.parse(
    await runCollect([...collectArgs, '--turns', '1', '--deadline-ms', '1'], {
      now: () => now,
      request: async () => {
        calls++;
        now = 2;
        return collectPage([collectRow('one')], { next: 'later', complete: false });
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(expired.listing.stop, 'deadline');
  assert.equal(expired.outcomes[0].reason, 'deadline');
  let page = 0;
  let active = 0;
  let peak = 0;
  const capacity = JSON.parse(
    await runCollect([...collectArgs, '--turns', '1'], {
      now: () => 0,
      request: async (method, params) => {
        if (method === 'session') {
          peak = Math.max(peak, ++active);
          await Promise.resolve();
          active--;
          return collectTurns(params.sessionId);
        }
        const prefix = String(page++);
        return collectPage(
          Array.from({ length: 128 }, (_, index) => collectRow(prefix + '-' + index)),
          { complete: false, next: 'page' + page, padding: '\u0000😀'.repeat(9000) },
        );
      },
    }),
  );
  // Oversized replies stop their path instead of producing truncated JSON.
  assert.equal(capacity.listing.stop, 'listing-failed');
  assert.equal(peak, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(capacity)) <= 8 * 1024 * 1024);
  page = 0;
  const maximum = JSON.parse(
    await runCollect([...collectArgs, '--turns', '1'], {
      now: () => 0,
      request: async (method, params) => {
        if (method === 'session') {
          peak = Math.max(peak, ++active);
          await Promise.resolve();
          active--;
          return collectTurns(params.sessionId);
        }
        const prefix = String(page++);
        return collectPage(
          Array.from({ length: 128 }, (_, index) => collectRow(prefix + '-' + index)),
          { complete: false, next: 'page' + page, padding: '\u0000😀'.repeat(2000) },
        );
      },
    }),
  );
  assert.ok(maximum.listing.pageRequests <= 64);
  assert.ok(maximum.turnRequests <= 32);
  assert.equal(maximum.outcomes.length, maximum.rows.length);
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) <= 8 * 1024 * 1024);
  assert.ok(peak <= 2);
  assert.equal(peak, 2);
  assert.ok(maximum.outcomes.some((one) => one.reason === 'output-limit'));
});

test('collector refuses invalid flags before any transport request', async () => {
  const calls = [];
  const request = async (...call) => calls.push(call);
  for (const args of [
    ['--json', '--json'],
    ['--turns', '0'],
    ['--max-pages', '65'],
    ['--max-reads', '1'],
    ['--limit', '129'],
    ['--deadline-ms', '0'],
    ['--query', 'find:needle'],
    ['--query'],
    ['--window', ''],
    ['toString'],
    ['--unknown'],
  ])
    await assert.rejects(
      runCollect(args.includes('--window') ? args : [...collectArgs, ...args], { now: () => 0, request }),
      undefined,
      args.join(' '),
    );
  assert.deepEqual(calls, []);
});

test('ordinary smoke fixtures create homes beneath physical temporary directories', () => {
  const files = fs.readdirSync(new URL('.', import.meta.url)).filter((file) => /^smoke.*\.(mjs|ts)$/.test(file));
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /mkdtempSync\(join\(tmpdir\(\),/, file);
  }
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
        if (conflict === 'edited' && action === 'remove') assert.equal(result.status, 'failed');
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

// Runs the compiled command with a fixture home and returns its exit status and receipt.
function runSkillCommand(home, action, ...agents) {
  const child = spawnSync(process.execPath, [cli, 'skills', action, ...agents.flatMap((agent) => ['--agent', agent])], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ARC_HOME: join(home, '.arc'), CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
  });
  assert.ok(child.stdout, child.stderr);
  return { status: child.status, ...JSON.parse(child.stdout) };
}

const linkKinds = process.platform === 'win32' ? ['junction', 'dir'] : ['dir'];

// Returns false when this machine cannot create the link, such as a Windows symbolic link without developer mode.
function tryLink(target, link, kind) {
  mkdirSync(join(link, '..'), { recursive: true });
  try {
    fs.symlinkSync(target, link, kind);
    return true;
  } catch (error) {
    if (kind === 'dir' && process.platform === 'win32' && error.code === 'EPERM') return false;
    throw error;
  }
}

function unlink(link) {
  if (!fs.existsSync(link) || !fs.lstatSync(link).isSymbolicLink()) return;
  if (process.platform === 'win32') fs.rmdirSync(link);
  else fs.unlinkSync(link);
}

// Each layout names the link, what it points at, the agent that owns the real folder, and the agent that reads through the link.
const linkedLayouts = {
  'the Codex folder links to the Claude folder': ['.agents/skills', '.claude/skills', 'claude', 'codex'],
  'the Claude folder links to the Codex folder': ['.claude/skills', '.agents/skills', 'codex', 'claude'],
  'the agents folder links to the Claude folder': ['.agents', '.claude', 'claude', 'codex'],
};

function expectPayloadCopy(directory, payload) {
  assert.deepEqual(skillFiles(directory), [...payload.files.keys()].sort());
  assert.deepEqual(readFileSync(join(directory, 'SKILL.md')), payload.files.get('SKILL.md'));
}

test.for(
  Object.keys(linkedLayouts).flatMap((layout) =>
    linkKinds.flatMap((kind) =>
      [
        ['real', 'linked'],
        ['linked', 'real'],
      ].map((order) => [layout, kind, order]),
    ),
  ),
)(
  'personal skills folders linked to the other agent are left unchanged: %s, %s link, order %j',
  { tags: ['subprocess'] },
  ([layout, kind, order], context) => {
    const [linkPath, targetPath, real, linked] = linkedLayouts[layout];
    const payload = readSkillPayload(cli);
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-skill-'));
    try {
      mkdirSync(join(home, targetPath), { recursive: true });
      if (!tryLink(join(home, targetPath), join(home, linkPath), kind))
        context.skip('This machine cannot create directory symbolic links.');
      const agents = order.map((entry) => (entry === 'real' ? real : linked));
      const run = runSkillCommand(home, 'install', ...agents);
      assert.equal(run.status, 0, JSON.stringify(run));
      assert.deepEqual(
        run.results.map((result) => [result.agent, result.status]),
        agents.map((agent) => [agent, agent === real ? 'installed' : 'linked']),
      );
      const realFolder = join(home, real === 'claude' ? '.claude' : '.agents', 'skills');
      expectPayloadCopy(join(realFolder, 'arc-sessions'), payload);
      const result = run.results.find((item) => item.agent === linked);
      assert.equal(result.destination, canonicalToolPath(join(realFolder, 'arc-sessions')));
      assert.match(result.reason, /skills folder is linked to the .* skills folder/);
      if (!layout.startsWith('the agents folder'))
        assert.equal(fs.existsSync(join(home, linkPath + '.arc-skill-control')), false);
      const again = runSkillCommand(home, 'install', ...agents);
      assert.equal(again.status, 0, JSON.stringify(again));
      assert.equal(again.results.find((item) => item.agent === linked).status, 'linked');
    } finally {
      unlink(join(home, linkPath));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'a skills folder linked elsewhere is left unchanged and reports the skill at its target',
  { tags: ['subprocess'] },
  () => {
    const payload = readSkillPayload(cli);
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-elsewhere-'));
    const target = join(home, 'dotfiles/skills');
    try {
      mkdirSync(target, { recursive: true });
      tryLink(target, join(home, '.agents/skills'), linkKinds[0]);
      const missing = runSkillCommand(home, 'install', 'codex');
      assert.equal(missing.status, 1, JSON.stringify(missing));
      assert.equal(missing.results[0].status, 'incomplete');
      assert.match(missing.results[0].reason, /linked to .*dotfiles.*missing.*copy or link .* to .*dotfiles/);
      assert.doesNotMatch(missing.results[0].reason, /README/);
      assert.deepEqual(fs.readdirSync(target), []);
      fs.cpSync(payload.directory, join(target, 'arc-sessions'), { recursive: true });
      for (const action of ['install', 'update']) {
        const matching = runSkillCommand(home, action, 'codex');
        assert.equal(matching.status, 0, JSON.stringify(matching));
        assert.equal(matching.results[0].status, 'linked');
      }
      writeFileSync(join(target, 'arc-sessions/SKILL.md'), 'reader edit');
      const changed = runSkillCommand(home, 'update', 'codex');
      assert.equal(changed.results[0].status, 'incomplete');
      assert.match(changed.results[0].reason, /different from this version/);
      assert.equal(readFileSync(join(target, 'arc-sessions/SKILL.md'), 'utf8'), 'reader edit');
      const removed = runSkillCommand(home, 'remove', 'codex');
      assert.equal(removed.status, 0, JSON.stringify(removed));
      assert.equal(removed.results[0].status, 'linked');
      assert.match(removed.results[0].reason, /by hand/);
      assert.equal(fs.existsSync(join(target, 'arc-sessions/SKILL.md')), true);
      assert.equal(fs.existsSync(join(home, '.agents/skills.arc-skill-control')), false);
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'removing from a folder linked to an Arc-owned skill needs no action and leaves the skill in place',
  { tags: ['subprocess'] },
  () => {
    const payload = readSkillPayload(cli);
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-remove-'));
    try {
      mkdirSync(join(home, '.claude/skills'), { recursive: true });
      tryLink(join(home, '.claude/skills'), join(home, '.agents/skills'), linkKinds[0]);
      assert.equal(runSkillCommand(home, 'install', 'claude').results[0].status, 'installed');
      const left = runSkillCommand(home, 'remove', 'codex');
      assert.equal(left.status, 0, JSON.stringify(left));
      assert.equal(left.results[0].status, 'linked');
      assert.match(left.results[0].reason, /no action is needed/);
      assert.doesNotMatch(left.results[0].reason, /arc skills|by hand|README/);
      expectPayloadCopy(join(home, '.claude/skills/arc-sessions'), payload);
      const removed = runSkillCommand(home, 'remove', 'claude');
      assert.equal(removed.status, 0, JSON.stringify(removed));
      assert.equal(removed.results[0].status, 'removed');
      assert.match(removed.results[0].reason, /Codex also read this skill/);
      assert.equal(fs.existsSync(join(home, '.claude/skills/arc-sessions')), false);
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('a linked folder removal reads nothing inside the skill at the target', async () => {
  const payload = readSkillPayload(cli);
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-noread-'));
  const target = join(home, 'dotfiles/skills');
  const methods = { readdirSync: mutableFs.readdirSync, readFileSync: mutableFs.readFileSync };
  const reads = [];
  try {
    mkdirSync(join(target, 'arc-sessions'), { recursive: true });
    writeFileSync(join(target, 'arc-sessions/SKILL.md'), 'reader copy');
    tryLink(target, join(home, '.agents/skills'), linkKinds[0]);
    for (const method of Object.keys(methods))
      mutableFs[method] = function (file, ...args) {
        if (String(file).includes('arc-sessions')) reads.push(`${method} ${String(file)}`);
        return methods[method](file, ...args);
      };
    syncBuiltinESMExports();
    const removed = await operateSkill('remove', 'codex', payload, { home, signal: new AbortController().signal });
    assert.equal(removed.status, 'linked', JSON.stringify(removed));
    assert.deepEqual(reads, []);
  } finally {
    Object.assign(mutableFs, methods);
    syncBuiltinESMExports();
    unlink(join(home, '.agents/skills'));
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  'a linked folder names the other agent install command only for a skill that is missing there',
  { tags: ['subprocess'] },
  () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-userowned-'));
    try {
      mkdirSync(join(home, '.claude/skills'), { recursive: true });
      tryLink(join(home, '.claude/skills'), join(home, '.agents/skills'), linkKinds[0]);
      const missing = runSkillCommand(home, 'install', 'codex');
      assert.equal(missing.results[0].status, 'incomplete', JSON.stringify(missing));
      assert.match(missing.results[0].reason, /arc skills install --agent claude/);
      assert.equal(fs.existsSync(join(home, '.claude/skills/arc-sessions')), false);
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'a linked folder needs no action after a person edits or replaces the copy in the other agent folder',
  { tags: ['subprocess'] },
  () => {
    const payload = readSkillPayload(cli);
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-replaced-'));
    const skill = join(home, '.claude/skills/arc-sessions');
    try {
      mkdirSync(join(home, '.claude/skills'), { recursive: true });
      tryLink(join(home, '.claude/skills'), join(home, '.agents/skills'), linkKinds[0]);
      assert.equal(runSkillCommand(home, 'install', 'claude').results[0].status, 'installed');
      for (const scenario of ['an edited Arc install', 'a copy made by hand']) {
        if (scenario === 'a copy made by hand') {
          rmSync(skill, { recursive: true, force: true });
          rmSync(join(home, '.claude/skills.arc-skill-control'), { recursive: true, force: true });
          fs.cpSync(payload.directory, skill, { recursive: true });
        }
        writeFileSync(join(skill, 'SKILL.md'), `reader edit of ${scenario}`);
        for (const action of ['remove', 'update', 'install']) {
          const run = runSkillCommand(home, action, 'codex');
          assert.equal(run.status, 0, `${scenario}, ${action}: ${JSON.stringify(run)}`);
          assert.equal(run.results[0].status, 'linked', `${scenario}, ${action}`);
          assert.match(run.results[0].reason, /no action is needed/);
          assert.doesNotMatch(run.results[0].reason, /arc skills|by hand|README/);
          assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), `reader edit of ${scenario}`);
        }
      }
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

const unusablePeerCopies = {
  'an empty folder': (skill) => mkdirSync(skill),
  'a folder without SKILL.md': (skill) => {
    mkdirSync(skill);
    writeFileSync(join(skill, 'notes.md'), 'not a skill');
  },
  'an ordinary file': (skill) => writeFileSync(skill, 'not a folder'),
  'a link that leads nowhere': (skill, home) => tryLink(join(home, 'missing-skill'), skill, linkKinds[0]),
};

test.for(
  Object.keys(unusablePeerCopies).flatMap((copy) =>
    ['the Codex folder links to the Claude folder', 'the Claude folder links to the Codex folder'].map((layout) => [
      copy,
      layout,
    ]),
  ),
)(
  'a linked folder is incomplete when the other agent folder holds %s: %s',
  { tags: ['subprocess'] },
  ([copy, layout], context) => {
    const [linkPath, targetPath, real, linked] = linkedLayouts[layout];
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-unusable-'));
    const skill = join(home, targetPath, 'arc-sessions');
    try {
      mkdirSync(join(home, targetPath), { recursive: true });
      if (!tryLink(join(home, targetPath), join(home, linkPath), linkKinds[0]))
        context.skip('This machine cannot create directory symbolic links.');
      if (unusablePeerCopies[copy](skill, home) === false) context.skip('This machine cannot create that link.');
      for (const action of ['install', 'update']) {
        const run = runSkillCommand(home, action, linked);
        assert.equal(run.status, 1, `${action}: ${JSON.stringify(run)}`);
        assert.equal(run.results[0].status, 'incomplete', action);
        assert.doesNotMatch(run.results[0].reason, /no action is needed|README/);
        assert.match(run.results[0].reason, /Arc will not replace it/);
        assert.match(run.results[0].reason, /arc-sessions is (a folder|a file|a link)/);
        assert.match(run.results[0].reason, new RegExp(`arc skills install --agent ${real}`));
      }
      const removed = runSkillCommand(home, 'remove', linked);
      assert.equal(removed.status, 0, JSON.stringify(removed));
      assert.equal(removed.results[0].status, 'linked');
      assert.match(removed.results[0].reason, /skill is not there/);
      assert.doesNotMatch(removed.results[0].reason, /uses the skill/);
      assert.equal(fs.lstatSync(skill, { throwIfNoEntry: false }) !== undefined, true);
      if (copy === 'an empty folder') {
        rmSync(skill, { recursive: true });
        assert.equal(runSkillCommand(home, 'install', real).results[0].status, 'installed');
      }
    } finally {
      unlink(join(home, linkPath));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'a linked folder names the other agent update command for an older Arc install nobody edited',
  { tags: ['subprocess'] },
  async () => {
    const current = readSkillPayload(cli);
    const files = new Map(current.files);
    files.set('SKILL.md', Buffer.concat([files.get('SKILL.md'), Buffer.from('\nolder\n')]));
    const older = { ...current, identity: 'older', files };
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-older-'));
    try {
      mkdirSync(join(home, '.claude/skills'), { recursive: true });
      tryLink(join(home, '.claude/skills'), join(home, '.agents/skills'), linkKinds[0]);
      const installed = await operateSkill('install', 'claude', older, {
        home,
        signal: new AbortController().signal,
      });
      assert.equal(installed.status, 'installed', JSON.stringify(installed));
      for (const action of ['install', 'update']) {
        const run = runSkillCommand(home, action, 'codex');
        assert.equal(run.status, 1, `${action}: ${JSON.stringify(run)}`);
        assert.equal(run.results[0].status, 'incomplete', action);
        assert.match(run.results[0].reason, /arc skills update --agent claude/);
      }
      const updated = runSkillCommand(home, 'update', 'claude');
      assert.equal(updated.results[0].status, 'updated', JSON.stringify(updated));
      expectPayloadCopy(join(home, '.claude/skills/arc-sessions'), current);
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'the direction for a skill with no readable SKILL.md leads to a working install after an Arc install',
  { tags: ['subprocess'] },
  async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-deleted-'));
    try {
      mkdirSync(join(home, '.claude/skills'), { recursive: true });
      tryLink(join(home, '.claude/skills'), join(home, '.agents/skills'), linkKinds[0]);
      const installed = await operateSkill('install', 'claude', readSkillPayload(cli), {
        home,
        signal: new AbortController().signal,
      });
      assert.equal(installed.status, 'installed', JSON.stringify(installed));
      rmSync(join(installed.destination, 'SKILL.md'));
      const linked = runSkillCommand(home, 'install', 'codex');
      assert.equal(linked.results[0].status, 'incomplete', JSON.stringify(linked));
      const command = /arc skills (install|update) --agent (claude|codex)/.exec(linked.results[0].reason);
      assert.ok(command, linked.results[0].reason);
      // The person follows the direction: move or delete the entry, then run the named command.
      rmSync(installed.destination, { recursive: true });
      const named = runSkillCommand(home, command[1], command[2]);
      assert.equal(named.status, 0, JSON.stringify(named));
      assert.equal(named.results[0].status, 'installed', JSON.stringify(named));
      expectPayloadCopy(installed.destination, readSkillPayload(cli));
      assert.equal(runSkillCommand(home, 'install', 'codex').results[0].status, 'linked');
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.for(['an invalid ownership binding', 'an unfinished retained operation'])(
  'a linked folder gives recovery directions for %s',
  { tags: ['subprocess'] },
  async (state) => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-linked-recovery-'));
    const payload = readSkillPayload(cli);
    const files = new Map(payload.files);
    files.set('SKILL.md', Buffer.concat([files.get('SKILL.md'), Buffer.from('\nprevious version\n')]));
    const previous = { ...payload, identity: 'previous', files };
    try {
      mkdirSync(join(home, '.claude/skills'), { recursive: true });
      tryLink(join(home, '.claude/skills'), join(home, '.agents/skills'), linkKinds[0]);
      const installed = await operateSkill('install', 'claude', previous, {
        home,
        signal: new AbortController().signal,
      });
      assert.equal(installed.status, 'installed', JSON.stringify(installed));
      if (state === 'an invalid ownership binding') {
        const ownership = join(installed.control, 'ownership.json');
        const binding = JSON.parse(readFileSync(ownership, 'utf8'));
        writeFileSync(ownership, JSON.stringify({ ...binding, destination: join(home, 'different') }));
      } else {
        mkdirSync(join(installed.control, 'operation-00000000-0000-0000-0000-000000000000'));
      }
      const entries = fs.readdirSync(installed.control, { recursive: true }).sort();
      const records = skillFiles(installed.control).map((relative) => [
        relative,
        readFileSync(join(installed.control, relative)),
      ]);
      const directory = fs.lstatSync(installed.destination, { bigint: true }).ino;
      for (const action of ['install', 'update', 'remove']) {
        const refused = runSkillCommand(home, action, 'claude');
        assert.equal(refused.status, 1, JSON.stringify(refused));
        const linked = runSkillCommand(home, action, 'codex');
        assert.equal(linked.status, action === 'remove' ? 0 : 1, JSON.stringify(linked));
        assert.equal(linked.results[0].status, action === 'remove' ? 'linked' : 'incomplete');
        if (action === 'remove') {
          assert.match(linked.results[0].reason, /no action is needed/);
          assert.doesNotMatch(linked.results[0].reason, /arc skills|manual-recovery/);
        } else {
          assert.match(linked.results[0].reason, /docs\/arc-sessions\.md#manual-recovery/);
          assert.doesNotMatch(linked.results[0].reason, /arc skills/);
        }
        expectPayloadCopy(installed.destination, previous);
        assert.equal(fs.lstatSync(installed.destination, { bigint: true }).ino, directory);
        assert.deepEqual(fs.readdirSync(installed.control, { recursive: true }).sort(), entries);
        for (const [relative, bytes] of records)
          assert.deepEqual(readFileSync(join(installed.control, relative)), bytes);
        assert.equal(fs.existsSync(join(home, '.agents/skills.arc-skill-control')), false);
      }
    } finally {
      unlink(join(home, '.agents/skills'));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

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
  { tags: ['subprocess'] },
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
  { tags: ['subprocess'] },
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

test(
  'manual recovery retires a stopped unsealed replacement and permits a new operation',
  { tags: ['subprocess'] },
  async () => {
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
  },
);

function releaseSkillFixture(root) {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  fs.copyFileSync(cli, join(dist, 'cli.cjs'));
  fs.copyFileSync(join(cli, '../windowpipe.exe'), join(dist, 'windowpipe.exe'));
  const { identity } = bundledTools(dist, fileURLToPath(new URL('../../', import.meta.url)), {
    extensionVersion: '0.1.0',
    sourceCommit: 'a'.repeat(40),
  });
  const release = join(root, 'installed release');
  fs.renameSync(join(dist, 'tools'), release);
  writeFileSync(join(release, 'release.json'), JSON.stringify(identity));
  return { release, identity };
}

test.each(['extension', 'bundled', 'npm', 'release'])(
  'skills update replaces both personal copies from the %s command layout',
  { tags: ['subprocess'] },
  (layout) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-skill-command-layout-'));
    const home = join(root, 'home');
    mkdirSync(home);
    try {
      const installed = runSkillCommand(home, 'install', 'claude', 'codex');
      assert.equal(installed.status, 0, JSON.stringify(installed));
      assert.deepEqual(
        installed.results.map((one) => one.status),
        ['installed', 'installed'],
      );
      let executable;
      let source;
      if (layout === 'release') {
        const { release } = releaseSkillFixture(root);
        executable = join(release, 'cli/arc.cjs');
        source = join(release, 'skills/arc-sessions');
      } else {
        const [command, payload] = {
          extension: ['extension/dist/cli.cjs', 'extension/dist/tools/skills/arc-sessions'],
          bundled: ['extension/dist/tools/cli/arc.cjs', 'extension/dist/tools/skills/arc-sessions'],
          npm: ['npm/dist/arc.cjs', 'npm/skills/arc-sessions'],
        }[layout];
        executable = join(root, command);
        source = join(root, payload);
        mkdirSync(join(executable, '..'), { recursive: true });
        fs.copyFileSync(cli, executable);
        fs.cpSync(new URL('../skills/arc-sessions', import.meta.url), source, { recursive: true });
        if (layout === 'npm') writeFileSync(join(root, 'npm/package.json'), '{"name":"@glin/arc"}');
      }
      writeFileSync(join(source, 'layout-resource.txt'), 'updated resource');
      if (layout === 'release') {
        const manifestPath = join(executable, '../../release.json');
        const { contentId: _, ...manifest } = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.files['skills/arc-sessions/layout-resource.txt'] = {
          sha256: createHash('sha256').update('updated resource').digest('hex'),
          mode: 0o644,
        };
        fs.chmodSync(join(source, 'layout-resource.txt'), 0o644);
        writeFileSync(
          manifestPath,
          JSON.stringify({
            ...manifest,
            contentId: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
          }),
        );
      }
      const child = spawnSync(
        process.execPath,
        [executable, 'skills', 'update', '--agent', 'claude', '--agent', 'codex'],
        {
          cwd: home,
          env: { ...process.env, HOME: home, USERPROFILE: home, ARC_HOME: join(home, '.arc'), CLAUDE_CONFIG_DIR: '' },
          encoding: 'utf8',
        },
      );
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const receipt = JSON.parse(child.stdout);
      assert.deepEqual(
        receipt.results.map((one) => one.status),
        ['updated', 'updated'],
      );
      if (layout === 'release') {
        const env = {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          ARC_HOME: join(home, '.arc'),
          CLAUDE_CONFIG_DIR: '',
          ARC_EDITOR_EXECUTABLE: process.execPath,
        };
        for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
        env.PATH =
          join(executable, '../../launchers') +
          (process.platform === 'win32' ? ';' : ':') +
          (process.env.PATH ?? process.env.Path ?? '');
        const launched = spawnSync(
          process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
          process.platform === 'win32'
            ? ['/d', '/c', 'arc skills update --agent claude --agent codex']
            : ['-c', 'arc skills update --agent claude --agent codex'],
          { cwd: home, env, encoding: 'utf8' },
        );
        assert.equal(launched.status, 0, launched.stderr || launched.stdout);
        assert.deepEqual(
          JSON.parse(launched.stdout).results.map((one) => one.status),
          ['unchanged', 'unchanged'],
        );
      }
      const payload = readSkillPayload(executable);
      for (const folder of ['.claude', '.agents'])
        expectPayloadCopy(join(home, folder, 'skills/arc-sessions'), payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('release skill selection requires its complete artifact identity', { tags: ['subprocess'] }, () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'arc-skill-release-'));
  try {
    const { release, identity } = releaseSkillFixture(root);
    const executable = join(release, 'cli/arc.cjs');
    for (const platform of ['win32', 'darwin', 'linux'])
      assert.equal(
        readSkillPayload(executable, platform).directory,
        canonicalToolPath(join(release, 'skills/arc-sessions')),
      );
    assert.throws(() => readSkillPayload(executable, 'freebsd'), /cannot identify this command release/);
    const manifest = join(release, 'release.json');
    writeFileSync(manifest, '{}');
    assert.throws(() => readSkillPayload(executable), /cannot identify this command release/);
    writeFileSync(manifest, JSON.stringify({ ...identity, contentId: '0'.repeat(64) }));
    assert.throws(() => readSkillPayload(executable), /cannot identify this command release/);
    writeFileSync(manifest, JSON.stringify(identity));
    fs.appendFileSync(executable, '\n// changed command bytes\n');
    assert.throws(() => readSkillPayload(executable), /cli\/arc.cjs is damaged/);
    fs.unlinkSync(manifest);
    const hashFolder = join(root, 'b'.repeat(64));
    fs.renameSync(release, hashFolder);
    assert.throws(() => readSkillPayload(join(hashFolder, 'cli/arc.cjs')), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      assert.deepEqual([...selected.files.keys()].sort(), skillFiles(source));
      for (const [file, bytes] of selected.files) assert.deepEqual(bytes, readFileSync(join(source, file)));
      identities.push(selected.identity);
      fs.renameSync(join(root, payload), join(root, payload) + '.unavailable');
      assert.throws(() => readSkillPayload(join(root, executable)), /ENOENT/);
    }
    assert.equal(new Set(identities).size, 1);
    const linked = join(root, 'release/tools/skills/arc-sessions/compaction.md');
    fs.renameSync(
      join(root, 'release/tools/skills/arc-sessions.unavailable'),
      join(root, 'release/tools/skills/arc-sessions'),
    );
    fs.rmSync(linked);
    assert.throws(
      () => readSkillPayload(join(root, 'release/tools/cli/arc.cjs')),
      /cannot find the session skill file compaction\.md/,
    );
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

test(
  'Windows short temporary-root spellings resolve to their physical directory',
  { tags: ['subprocess'] },
  ({ skip }) => {
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
  },
);

test('command admission requires complete help data', () => {
  checkCommandHelp(COMMANDS);
  for (const command of COMMANDS) {
    assert.equal(findCommand([...command.name.split(' '), '--help']), command);
    assert.ok(renderCommandHelp(command).trim());
    assert.throws(() => checkCommandHelp([{ ...command, help: undefined }]), /Missing command help/);
    for (const field of ['summary', 'synopsis', 'flags', 'output', 'refusals', 'example']) {
      assert.throws(
        () => checkCommandHelp([{ ...command, help: { ...command.help, [field]: undefined } }]),
        /Missing command help/,
      );
    }
  }
});

test('continuation file opening refuses nonregular descriptors with platform nonblocking flags', () => {
  const source = readFileSync(new URL('../src/manage.ts', import.meta.url), 'utf8');
  const declaration = declarationSource(source, 'readContinuationFile').replace(/^export\s+/, '');
  const compiled = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const platform of ['win32', 'linux', 'darwin']) {
    let closed = false;
    const filesystem = {
      constants: Object.freeze({ O_RDONLY: 0, O_NONBLOCK: 2048 }),
      openSync: (_file, flags) => {
        assert.equal(flags, platform === 'win32' ? 0 : 2048);
        return 123;
      },
      fstatSync: () => ({ isFile: () => false }),
      closeSync: (fd) => {
        assert.equal(fd, 123);
        closed = true;
      },
    };
    const readContinuationFile = runInNewContext(`${compiled}; readContinuationFile;`, {
      fs: filesystem,
      process: { platform },
      validContinuationPath: (file) => validContinuationPath(file, platform),
    });
    assert.throws(
      () => readContinuationFile(platform === 'win32' ? 'C:/temp/next.txt' : '/tmp/next.txt', 'a'.repeat(64)),
      /regular file/,
    );
    assert.equal(closed, true);
  }
});

// Catches the CLI's copy of the not-observed refusal drifting from the window's text.
test('the CLI not-observed refusal reuses the window text', () => {
  const cli = readFileSync(new URL('../src/compact.ts', import.meta.url), 'utf8');
  assert.ok(cli.includes("COMPACT_REJECTIONS['not-observed']"), 'the CLI reports the window text');
  assert.ok(!cli.includes('has not seen this command'), 'the CLI holds no copy of the window text');
});
