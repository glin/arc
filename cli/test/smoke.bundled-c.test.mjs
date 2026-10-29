// @module-tag subprocess
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { terminalOwnership } from '../../extension/src/terminalownership.ts';
import { parseSessionRequest, WindowChannel } from '../../extension/src/sessionrequests.ts';
import { sessionListingPage, SESSION_PAGE_LIMITS } from '../../extension/src/sessionreads.ts';
import { childEnv } from '../../extension/src/agenthost.ts';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DispatchReceipts } from '../../extension/src/dispatchreceipts.ts';
import { payloadSha256 } from '../../extension/src/sessionwrites.ts';
import { projectSlug } from '../../extension/src/transcript.ts';
import * as fs from 'node:fs';
import { WINDOW_PIPE_SOURCE } from '../../extension/src/windowpipe-source.ts';
import {
  skillFiles,
  collectRow,
  collectPage,
  collectTurns,
  input,
  cli,
  smokeEnv,
  setupReply,
} from './smoke-fixture.ts';

afterEach(() => vi.useRealTimers());

// A failed launch smoke case deletes its home, so print the dispatch receipts first.
// The helper never throws, so it cannot replace the failure it reports or skip the cleanup.
function printDispatchReceipts(home) {
  try {
    const root = join(home, 'dispatch');
    if (!fs.existsSync(root)) return console.error(`No dispatch directory under ${home}`);
    for (const launch of fs.readdirSync(root)) {
      const directory = join(root, launch);
      let names;
      try {
        names = fs.readdirSync(directory);
      } catch {
        continue;
      }
      const wanted = names.filter(
        (name) =>
          ['stderr.log', 'observation.json', 'monitor.json'].includes(name) ||
          /^state(\.\d+)?\.json$/.test(name) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.anchor)?\.json$/.test(name) ||
          name.endsWith('.consumption.json'),
      );
      for (const name of wanted) {
        try {
          const bytes = readFileSync(join(directory, name));
          const tail = bytes.subarray(Math.max(0, bytes.length - 16 * 1024));
          console.error(`--- dispatch/${launch}/${name} (${bytes.length} bytes) ---
${tail.toString('utf8')}`);
        } catch (error) {
          console.error(`--- dispatch/${launch}/${name} unreadable: ${error.message} ---`);
        }
      }
    }
  } catch (error) {
    console.error(`Dispatch receipts unavailable under ${home}: ${error.message}`);
  }
}

function discoveryCommand(home, channels, deniedFile) {
  const preload = join(home, 'discovery.cjs');
  // Transport deadline tests advance clocks in sessionrequests.test.ts.
  let setup = `require('node:test').mock.timers.enable({ apis: ['setTimeout'] }); const fs = require('node:fs');`;
  if (process.platform === 'win32') {
    // Keep process-table latency outside the authenticated discovery deadline.
    // windowpipe.test.ts checks the real parent read through a native connection without an exchange deadline.
    const parents = channels.map((channel) => {
      const entry = JSON.parse(readFileSync(join(home, 'hosts', `${channel.hostId}.json`), 'utf8'));
      return `if (pid == ${entry.transportPid}) return ${entry.pid};`;
    });
    const parent = /static uint Parent\(uint pid\) \{[\s\S]*?\n  \}/;
    assert.match(WINDOW_PIPE_SOURCE, parent);
    const source = WINDOW_PIPE_SOURCE.replace(
      parent,
      `static uint Parent(uint pid) { ${parents.join(' ')} throw new IOException("Process unavailable"); }`,
    );
    const input = join(home, 'discovery.cs');
    const executable = join(home, 'discovery.exe');
    writeFileSync(input, source);
    const built = spawnSync(
      join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/optimize+', '/target:exe', `/out:${executable}`, input],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const packaged = join(cli, '..', 'windowpipe.exe');
    setup += `const cp = require('node:child_process'); const spawn = cp.spawn; cp.spawn = function(file, ...args) { return spawn.call(this, file === ${JSON.stringify(packaged)} ? ${JSON.stringify(executable)} : file, ...args); };`;
  }
  if (deniedFile) {
    setup += `const original = fs.lstatSync; fs.lstatSync = function(file, ...args) { if (file === ${JSON.stringify(deniedFile)}) throw Object.assign(new Error('secret-token-address-stack'), { code: 'EACCES' }); return original.call(this, file, ...args); };`;
  }
  writeFileSync(preload, setup);
  return ['--require', preload, cli];
}

test('bundled collector routes read-only requests and refuses an invalid flag before transport', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc collect & smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return request.method === 'sessions'
      ? collectPage([collectRow('one', '-literal')])
      : collectTurns(request.params.sessionId);
  });
  try {
    await channel.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: channel.hostId };
    const output = JSON.parse(
      (await run(process.execPath, [cli, 'collect', '--turns', '1', '--json'], { env })).stdout,
    );
    assert.equal(output.outcomes[0].status, 'completed');
    assert.deepEqual(
      requests.map((one) => one.method),
      ['sessions', 'session'],
    );
    const before = requests.length;
    await assert.rejects(run(process.execPath, [cli, 'collect', '--max-pages', '65'], { env }));
    await assert.rejects(run(process.execPath, [cli, 'collect'], { env: { ...env, ARC_WINDOW: '' } }));
    assert.equal(requests.length, before);
  } finally {
    await channel.dispose();
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
    const canonical = fileURLToPath(new URL('../skills/arc-sessions', import.meta.url));
    assert.ok(skillFiles(canonical).length > 1);
    for (const directory of ['.claude', '.agents']) {
      const installedSkill = join(home, directory, 'skills/arc-sessions');
      assert.deepEqual(skillFiles(installedSkill), skillFiles(canonical));
      for (const file of skillFiles(canonical))
        assert.deepEqual(readFileSync(join(installedSkill, file)), readFileSync(join(canonical, file)));
    }
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

test('the bundled windows command reaches authenticated hosts and keeps secrets out of both output formats', async ({
  signal,
}) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-windows-smoke-'));
  const first = new WindowChannel(home);
  const second = new WindowChannel(home);
  const env = { ...smokeEnv, ARC_HOME: home };
  const options = { env, encoding: 'utf8', signal };
  const run = promisify(execFile);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    const command = discoveryCommand(home, [first, second]);
    const json = await run(process.execPath, [...command, 'windows', '--json'], options);
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
    const human = await run(process.execPath, [...command, 'windows'], options);
    assert.match(human.stdout, /scope ready  panel hidden  "C:\/Project With Spaces"/);
    assert.match(human.stdout, /scope loading  panel not ready  \(no folders\)/);
    for (const channel of [first, second]) {
      const registration = readFileSync(join(home, 'hosts', `${channel.hostId}.json`), 'utf8');
      assert.equal(human.stdout.includes(JSON.parse(registration).token), false);
    }
    await Promise.all([first.dispose(), second.dispose()]);
    const empty = await run(process.execPath, [...command, 'windows', '--json'], options);
    assert.deepEqual(JSON.parse(empty.stdout), { version: 1, windows: [], complete: true });
    for (let index = 0; index <= 1024; index++) {
      writeFileSync(join(home, 'hosts', `unrelated-${index}`), '');
    }
    const incomplete = await run(process.execPath, [...command, 'windows', '--json'], options);
    assert.deepEqual(JSON.parse(incomplete.stdout), { version: 1, windows: [], complete: false });
    const partial = await run(process.execPath, [...command, 'windows'], options);
    assert.match(partial.stdout, /discovery is incomplete/);
    assert.equal(partial.stdout.includes('No Arc windows are open.'), false);
    await assert.rejects(run(process.execPath, [...command, 'windows', '--unknown'], options), /Usage: arc windows/);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled discovery retains registry access denial without leaking errors or failing partial output', async ({
  signal,
}) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-window-access-'));
  const reachable = new WindowChannel(home);
  const denied = 'f'.repeat(24);
  const deniedFile = join(home, 'hosts', denied + '.json');
  const run = promisify(execFile);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await reachable.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    writeFileSync(deniedFile, '{}');
    const command = discoveryCommand(home, [reachable], deniedFile);
    const options = { env: { ...smokeEnv, ARC_HOME: home }, encoding: 'utf8', signal };
    const json = await run(process.execPath, [...command, 'windows', '--json'], options);
    const report = JSON.parse(json.stdout);
    assert.equal(report.version, 1);
    assert.equal(report.complete, false);
    assert.deepEqual(
      report.windows.map((window) => window.hostId),
      [reachable.hostId],
    );
    assert.deepEqual(report.diagnostics, [{ code: 'EACCES', stage: 'registry', hostId: denied }]);
    assert.doesNotMatch(json.stdout, /secret|token|address|stack/);
    const human = await run(process.execPath, [...command, 'windows'], options);
    assert.match(human.stdout, /discovery is incomplete/);
    assert.match(human.stdout, /Window details f{24}: EACCES\./);
    assert.doesNotMatch(human.stdout, /secret|token|address|stack/);
  } finally {
    await reachable.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  'bundled continuation request refuses a FIFO without a writer',
  { skip: process.platform === 'win32' },
  async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-compact-fifo-'));
    const file = join(home, 'next.txt');
    try {
      execFileSync('mkfifo', [file]);
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [
            cli,
            'compact',
            'request',
            '--self',
            '--after-turn',
            '--continuation-file',
            file,
            '--continuation-sha256',
            'a'.repeat(64),
            '--request-id',
            'a'.repeat(24) + ':aaaaaaaa-1111-2222-3333-444444444444',
            '--window',
            'a'.repeat(24),
            '--json',
          ],
          { env: smokeEnv, timeout: 3000 },
        ),
        (error) => {
          assert.equal(error.killed, false);
          assert.match(error.stderr, /regular file/);
          return true;
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('manual Claude print launcher returns before release and another process waits for its original result', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-manual-print-'));
  const run = promisify(execFile);
  const prompt = join(home, 'prompt.txt');
  const release = join(home, 'release');
  const started = join(home, 'started.json');
  const log = join(home, 'output.log');
  const alias = join(home, 'report.md');
  const script = join(home, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const shim = join(home, 'claude.cmd');
  const projects = join(home, 'projects');
  const submitted = 'Review this folder.\nKeep the original prompt.';
  writeFileSync(prompt, submitted);
  fs.mkdirSync(join(home, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  writeFileSync(shim, '');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const cwd=process.cwd(),id=process.argv[process.argv.indexOf('--session-id')+1];
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',text=>prompt+=text);
process.stdin.on('end',()=>{
  const file=path.join(process.env.ARC_PROJECTS_ROOT,${JSON.stringify(projectSlug(home))},id+'.jsonl');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({type:'user',uuid:'original-native-user',sessionId:id,cwd,message:{role:'user',content:prompt}})+'\\n');
  fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({id,cwd,prompt,pid:process.pid,args:process.argv.slice(2),ttl:process.env.CLAUDE_CODE_PROMPT_CACHE_TTL}));
  console.error('Original worker is running.');
  const finish=()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;watcher.close();
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,result:'Original report'}));};
  const watcher=fs.watch(cwd,finish);finish();
});`,
    { mode: 0o700 },
  );
  const env = {
    ...smokeEnv,
    ARC_HOME: home,
    ARC_PROJECTS_ROOT: projects,
    CLAUDE_BIN: process.platform === 'win32' ? shim : script,
  };
  let launchId;
  let passed = false;
  try {
    const launched = await run(
      process.execPath,
      [
        cli,
        'run',
        'claude',
        '--cwd',
        home,
        '--model',
        'claude-opus-5-5',
        '--effort',
        'high',
        '--read-only',
        '--prompt-file',
        prompt,
        '--completion',
        'manual',
        '--log',
        log,
        '--output',
        alias,
        '--arc-dispatch',
        '--cache-lifetime',
        '1h',
      ],
      { env, encoding: 'utf8', timeout: 10_000 },
    );
    const lines = launched.stdout.trim().split('\n');
    const launchedJson = JSON.parse(lines[0]);
    launchId = launchedJson.launchId;
    const receipts = new DispatchReceipts(home);
    assert.equal(lines.length, 2, readFileSync(receipts.artifact(launchId, 'stderr.log'), 'utf8'));
    const native = JSON.parse(readFileSync(started, 'utf8'));
    assert.equal(fs.existsSync(release), false);
    assert.equal(native.prompt, submitted);
    assert.equal(realpathSync(native.cwd), realpathSync(home));
    assert.equal(native.id, receipts.launch(launchId).standalone.sessionHint);
    assert.equal(native.args.filter((arg) => arg === '--session-id').length, 1);
    assert.equal(native.args.includes('-p'), true);
    assert.equal(native.args[native.args.indexOf('--output-format') + 1], 'json');
    assert.equal(native.ttl, '1h');
    assert.equal(receipts.launch(launchId).standalone.env.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
    assert.deepEqual(JSON.parse(lines[1].slice('ARC_DISPATCH_SESSION='.length)), {
      agent: 'claude',
      session_id: native.id,
      name: receipts.launch(launchId).standalone.name,
      owned: true,
    });
    assert.equal(receipts.standaloneSession(launchId), native.id);
    assert.equal(receipts.latest(launchId), null);
    assert.equal(readFileSync(receipts.artifact(launchId, 'stdout.log'), 'utf8'), '');
    process.kill(native.pid, 0);
    const waited = run(process.execPath, [cli, 'dispatch', 'wait', launchId, '--deadline-ms', '10000', '--json'], {
      env,
    }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    const status = JSON.parse(
      (await run(process.execPath, [cli, 'dispatch', 'status', launchId, '--json'], { env })).stdout,
    );
    assert.equal(status.launch.launchId, launchId);
    assert.equal(receipts.latest(launchId), null);
    writeFileSync(release, 'complete');
    const completion = await waited;
    assert.equal(completion.error, undefined);
    const observed = JSON.parse(completion.result.stdout);
    assert.equal(observed.launchId, launchId);
    assert.equal(observed.state, 'observed');
    assert.equal(observed.outcome, 'succeeded');
    const report = JSON.parse(
      (
        await run(process.execPath, [cli, 'dispatch', 'result', launchId, '--event', observed.eventId, '--json'], {
          env,
        })
      ).stdout,
    );
    assert.equal(report.text, 'Original report');
    assert.equal(readFileSync(alias, 'utf8'), 'Original report');
    assert.equal(readFileSync(log, 'utf8'), readFileSync(receipts.artifact(launchId, 'worker.log'), 'utf8'));
    assert.match(readFileSync(log, 'utf8'), /Original worker is running/);
    passed = true;
  } finally {
    if (!passed) printDispatchReceipts(home);
    writeFileSync(release, 'complete');
    if (!launchId && fs.existsSync(join(home, 'dispatch')))
      launchId = fs
        .readdirSync(join(home, 'dispatch'))
        .find((name) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(name));
    if (launchId)
      await vi.waitFor(
        () =>
          assert.equal(
            JSON.parse(readFileSync(join(home, 'dispatch', launchId, 'monitor.json'), 'utf8')).released,
            true,
          ),
        { timeout: 10_000 },
      );
    if (launchId) {
      const receipts = new DispatchReceipts(home);
      const producer = JSON.parse(readFileSync(receipts.artifact(launchId, 'output-owner.json'), 'utf8'));
      const pids = new Set([receipts.observation(launchId).supervisor.pid, producer.pid, producer.producerPid]);
      for (const pid of pids)
        if (pid)
          await vi.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }), { timeout: 10_000 });
    }
    // A failed launcher still releases its one local fake worker before fixture cleanup.
    await vi.waitFor(
      () => {
        if (!fs.existsSync(started)) return;
        const pid = JSON.parse(readFileSync(started, 'utf8')).pid;
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      },
      { timeout: 10_000 },
    );
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test('bundled standalone command emits only its admitted native receipt after launch JSON', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-native-receipt-'));
  const run = promisify(execFile);
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  const spoof = 'ARC_DISPATCH_SESSION={"agent":"claude","session_id":"deadbeef"}';
  const preloader = join(home, 'fake-native.cjs');
  const prompt = join(home, 'prompt.txt');
  writeFileSync(prompt, 'Review this folder.');
  writeFileSync(
    preloader,
    `if(require('node:path').basename(process.argv[1])==='exec') {
const fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],${JSON.stringify(spoof)});
for(const row of [{type:'thread.started',thread_id:'${id}'},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',id:'answer',text:${JSON.stringify(spoof)}}},{type:'turn.completed'}]) fs.writeSync(1,JSON.stringify(row)+'\\n');process.exit(0);}`,
  );
  const env = {
    ...smokeEnv,
    ARC_HOME: home,
    CODEX_BIN: process.execPath,
    NODE_OPTIONS: [smokeEnv.NODE_OPTIONS, `--require ${JSON.stringify(preloader)}`].filter(Boolean).join(' '),
  };
  let passed = false;
  try {
    const result = await run(
      process.execPath,
      [
        cli,
        'run',
        'codex',
        '--cwd',
        home,
        '--model',
        'gpt-6.1-sol',
        '--effort',
        'high',
        '--prompt-file',
        prompt,
        '--arc-dispatch',
        '--agent-run=false',
        '--completion',
        'wait',
      ],
      { env, encoding: 'utf8', timeout: 20_000 },
    );
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    const launch = JSON.parse(lines[0]);
    assert.equal(launch.state, 'observed');
    assert.deepEqual(JSON.parse(lines[1].slice('ARC_DISPATCH_SESSION='.length)), {
      agent: 'codex',
      session_id: id,
      name: new DispatchReceipts(home).launch(launch.launchId).standalone.name,
      owned: true,
    });
    assert.equal(result.stdout.includes(spoof), false);
    await vi.waitFor(() =>
      assert.equal(
        JSON.parse(readFileSync(join(home, 'dispatch', launch.launchId, 'monitor.json'), 'utf8')).released,
        true,
      ),
    );
    const help = await run(process.execPath, [cli, 'dispatch', 'rm', '--help'], { env, encoding: 'utf8' });
    assert.match(help.stdout, /preservation is established/);
    await assert.rejects(run(process.execPath, [cli, 'dispatch', 'rm', launch.launchId, '--force'], { env }), /Usage:/);
    passed = true;
  } finally {
    if (!passed) printDispatchReceipts(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled starts refuse ambiguous guarded requesters and send only accepted cache lifetimes', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc guarded start smoke '));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return { status: 'accepted', provider: 'claude', sessionId: 'worker' };
  });
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const env = {
      ...smokeEnv,
      ARC_HOME: home,
      ARC_WINDOW: channel.hostId,
      CLAUDE_CODE_SESSION_ID: 'coordinator',
      CODEX_THREAD_ID: 'codex-thread',
    };
    const prompt = join(home, 'prompt.txt');
    writeFileSync(prompt, 'Prepare the worktree.');
    const start = [cli, 'start', 'claude', '--prompt-file', prompt];
    await assert.rejects(
      run(process.execPath, [...start, '--cache-lifetime', '2h'], { env }),
      /Choose --cache-lifetime 5m or 1h\./,
    );
    await assert.rejects(
      run(process.execPath, [cli, 'start', 'codex', '--prompt-file', prompt, '--cache-lifetime', '1h'], {
        env,
      }),
      /--cache-lifetime applies only to Claude launches\./,
    );
    await assert.rejects(
      run(process.execPath, [...start, '--arc-dispatch'], { env }),
      /Both CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID/,
    );
    assert.equal(requests.length, 0);
    await run(process.execPath, start, { env, encoding: 'utf8' });
    assert.equal(requests.length, 1, 'a start without --arc-dispatch keeps working and records no owner');
    assert.equal('requesterProvider' in requests[0], false);
    assert.equal('cacheLifetime' in requests[0].params, false);
    await run(process.execPath, [...start, '--cache-lifetime', '1h'], { env, encoding: 'utf8' });
    assert.equal(requests[1].params.cacheLifetime, '1h');
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled human session reads preserve delivered text, identity, and uncertainty without exposing receipts', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-human-reads-'));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  const row = {
    ...collectRow('physical-source', 'complete-session-id'),
    path: '/private/transcript',
    name: 'Review\nforged row\u0085\u2028',
    setup: { model: null, effort: null, source: 'unavailable' },
    labels: [{ name: 'cli', source: 'reader' }],
    pinned: true,
    archived: true,
    runStatus: 'stopped',
    lastActivity: null,
    parent: null,
    agentRun: null,
    facts: 'unparsed',
  };
  let reply = collectPage(
    [row, { ...row, id: null, name: null, ambiguous: true, truncated: ['id', 'name'], facts: 'stale' }],
    {
      coverage: 'incomplete',
      freshness: 'stale',
      complete: false,
      next: 'Exact_cursor-2',
      notes: ['Discovery unfinished.'],
    },
  );
  channel.setRequestHandler(() => reply);
  const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: channel.hostId };
  const call = (command, json = false) =>
    run(
      process.execPath,
      [cli, command, ...(command === 'session' ? ['complete-session-id'] : []), ...(json ? ['--json'] : [])],
      { env, encoding: 'utf8' },
    );
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const listing = (await call('sessions')).stdout;
    for (const fact of [
      'complete-session-id',
      'physical-source',
      'classification unknown',
      'ambiguous ID',
      'truncated: id, name',
      '(ID truncated)',
      'facts stale',
      'facts unparsed',
      'pinned',
      'archived',
      'labels: cli',
      'Discovery unfinished.',
      'Exact_cursor-2',
    ])
      assert.ok(listing.includes(fact), fact);
    assert.ok(listing.includes('Review\\nforged row'));
    assert.ok(!listing.includes('\nforged row'));
    assert.doesNotMatch(listing, /[\x7f-\x9f\u2028\u2029]/);
    assert.ok(!listing.includes('/private/transcript'));
    const prompt = '  Привет 🐈\n\tretain whitespace  \n';
    const response = '\n回答\r\n  trailing spaces  ';
    reply = collectTurns('complete-session-id', {
      turns: [
        {
          promptId: 'turn-1',
          startedAt: 0,
          endedAt: 1,
          prompt,
          summary: response,
          model: 'model',
          effort: 'high',
          finished: false,
          interrupted: true,
          error: 'recorded failure',
        },
      ],
      observation: 'SECRET_SEND',
      readObservation: 'SECRET_READ',
      notes: ['Older turn excluded.'],
    });
    const detail = (await call('session')).stdout;
    for (const value of [
      prompt,
      response,
      'turn-1',
      'error',
      'model',
      'high',
      'Older turn excluded.',
      'partial',
      '--json',
    ])
      assert.ok(detail.includes(value), value);
    assert.ok(!detail.includes('SECRET_'));
    reply = { ...collectPage([row]), version: 99 };
    await assert.rejects(call('sessions'), (error) => error.stdout === '' && /^arc: .*--json.*\n$/.test(error.stderr));
  } finally {
    await channel.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bundled setups print readable launch values by default and compact JSON on request', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-setups-smoke-'));
  const channel = new WindowChannel(home);
  const run = promisify(execFile);
  let reply = setupReply;
  const requests = [];
  channel.setRequestHandler((request) => {
    requests.push(request);
    return reply;
  });
  const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: channel.hostId };
  try {
    await channel.update({ folders: [home], scopeReady: true, panelReady: true, panelVisible: true });
    const human = await run(process.execPath, [cli, 'setups'], { env, encoding: 'utf8' });
    assert.match(human.stdout, /Project: \/project/);
    assert.match(human.stdout, /recent:0\s+claude\s+opus\s+high\s+\(default\)\s+\(primary\)/);
    assert.match(human.stdout, /pin:stored\s+codex\s+retired.*unavailable: model/);
    assert.match(human.stdout, /recent:1\s+codex\s+\(default\)\s+\(default\)\s+\(default\)/);
    const lines = human.stdout.trimEnd().split('\n');
    for (const agent of reply.agents) {
      const start = lines.indexOf(agent.provider);
      assert.ok(start >= 0);
      const end = lines.indexOf('', start);
      const section = lines.slice(start + 1, end < 0 ? undefined : end);
      for (const model of agent.models) {
        const line = section.find((line) => line.startsWith(`  ${model.value || '(default)'}  Effort:`));
        assert.ok(line, model.value);
        assert.deepEqual(
          line.split('Effort: ')[1].split(', '),
          model.efforts.map((value) => value || '(default)'),
        );
      }
      assert.ok(
        section.includes(`  Permissions: ${agent.permissions.map((value) => value || '(default)').join(', ')}`),
      );
    }
    const json = await run(process.execPath, [cli, 'setups', '--json'], { env, encoding: 'utf8' });
    assert.equal(json.stdout.trimEnd(), JSON.stringify(reply));
    assert.deepEqual(JSON.parse(json.stdout), reply);
    const { primary: _primary, ...empty } = reply;
    reply = {
      ...empty,
      setups: [],
      agents: [{ ...reply.agents[1], modelsPending: true, models: [{ value: '', efforts: [''] }] }],
    };
    const pending = await run(process.execPath, [cli, 'setups'], { env, encoding: 'utf8' });
    assert.match(pending.stdout, /explicit provider settings/i);
    assert.match(pending.stdout, /loading/i);
    assert.match(pending.stdout, /never/);
    const pendingJson = await run(process.execPath, [cli, 'setups', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(pendingJson.stdout), reply);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.method === 'setups' && Object.keys(request.params).length === 0));
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
    if (request.method === 'setups') return setupReply;
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
    const listing = await run(process.execPath, [cli, 'sessions', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(listing.stdout), { method: 'sessions', params: {}, requester: 'requesting-agent' });
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
    const largest = await run(process.execPath, [cli, 'sessions', '--limit', String(maximum), '--json'], {
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
    await assert.rejects(
      run(process.execPath, [cli, 'sessions'], { env: { ...env, ARC_WINDOW: '' } }),
      /Select one Arc window/,
    );
    // A built CLI must dispatch to its terminal owner when another authenticated window is live.
    let competingRequests = 0;
    second.setRequestHandler(() => {
      competingRequests++;
      return { wrongWindow: true };
    });
    const roots = [{ processId: Promise.resolve(process.pid) }];
    channel.setTerminalOwnership(terminalOwnership({ allowed: () => true, terminals: () => roots }));
    second.setTerminalOwnership(terminalOwnership({ allowed: () => true, terminals: () => [] }));
    // The CLI gives its own process read two seconds and reports that expiry with its own message.
    // A loaded machine delays the read, so the call repeats on that message only. Any other failure ends the case.
    const retryUntil = Date.now() + 60_000;
    let integrated;
    while (!integrated) {
      try {
        integrated = await run(process.execPath, [cli, 'setups', '--json'], {
          env: { ...env, ARC_WINDOW: '', TERM_PROGRAM: 'vscode' },
          encoding: 'utf8',
        });
      } catch (error) {
        if (!/process list took too long/.test(error.stderr ?? '') || Date.now() >= retryUntil) throw error;
      }
    }
    assert.deepEqual(JSON.parse(integrated.stdout), setupReply);
    assert.equal(requests, before + 1);
    assert.equal(competingRequests, 0);
  } finally {
    await Promise.all([channel.dispose(), second.dispose()]);
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('bundled session commands name the inherited window when an explicit window is no longer registered', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'arc-stale-window-smoke-'));
  const retired = new WindowChannel(home);
  const run = promisify(execFile);
  let replacement;
  try {
    await retired.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    await retired.dispose();
    replacement = new WindowChannel(home);
    let requests = 0;
    replacement.setRequestHandler((request) => {
      requests++;
      return { method: request.method };
    });
    await replacement.update({ folders: [], scopeReady: true, panelReady: false, panelVisible: false });
    const env = { ...smokeEnv, ARC_HOME: home, ARC_WINDOW: replacement.hostId, CLAUDE_CODE_SESSION_ID: '' };
    await assert.rejects(
      run(process.execPath, [cli, 'sessions', '--window', retired.hostId, '--json'], { env, encoding: 'utf8' }),
      (error) => {
        assert.ok(error.stderr.includes(`Arc window ${retired.hostId} is not registered`));
        assert.ok(error.stderr.includes(`ARC_WINDOW is ${replacement.hostId} for this command`));
        return true;
      },
    );
    assert.equal(requests, 0);
    const inherited = await run(process.execPath, [cli, 'sessions', '--json'], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(inherited.stdout), { method: 'sessions' });
    assert.equal(requests, 1);
  } finally {
    await Promise.all([retired.dispose(), replacement?.dispose()]);
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
    const standalone = receipts.reserve({
      ...input,
      completion: 'manual',
      transport: 'standalone',
      standalone: {
        provider: 'codex',
        command: process.execPath,
        args: [],
        cwd: home,
        model: 'gpt-6.1-sol',
        effort: 'high',
        name: 'manual',
        agentRun: false,
        background: false,
        sessionHint: null,
        logAlias: null,
        deadlineMs: 1000,
      },
    });
    const event = receipts.publish(
      standalone.launchId,
      { outcome: 'succeeded', availability: 'available', nativeEnding: null, askId: null },
      'Saved report',
    );
    const env = { ...smokeEnv, ARC_HOME: home };
    const call = (id, extra = []) =>
      run(process.execPath, [cli, 'dispatch', 'wait', id, '--deadline-ms', '1', ...extra, '--json'], { env });
    await assert.rejects(call(manual.launchId), /did not select waited/);
    assert.deepEqual(JSON.parse((await call(standalone.launchId)).stdout), {
      launchId: standalone.launchId,
      state: 'observed',
      eventId: event.eventId,
      outcome: 'succeeded',
      availability: 'available',
    });
    for (const deadline of ['0', '110001', '1.5'])
      await assert.rejects(
        run(process.execPath, [cli, 'dispatch', 'wait', standalone.launchId, '--deadline-ms', deadline, '--json'], {
          env,
        }),
        /1 through 110000 milliseconds/,
      );
    assert.equal(receipts.observation(standalone.launchId), null);
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
