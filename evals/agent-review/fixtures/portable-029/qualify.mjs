import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const __dirname=process.argv[2]+'/scripts';const jobs=[],checks=[];let cleanup;globalThis.test=(name,fn)=>jobs.push({name,fn});globalThis.afterEach=fn=>cleanup=fn;process.env.ARC_DIAGNOSTICS_TEST_SCRIPT=__dirname+'/capture-panel-diagnostics.js';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const collectorPath = process.env.ARC_DIAGNOSTICS_TEST_SCRIPT || path.join(__dirname, 'capture-panel-diagnostics.js');
const { captureDiagnostics, parseOptions, parseProcesses, processDeltas, cpuReading } = require(collectorPath);

const roots = [];
function fixture(platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-capture-test-'));
  roots.push(root);
  const commands = [];
  const image =
    platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' : '/usr/bin/node';
  const start = 'Fri Oct  2 22:00:00 2026';
  let cpu = 0;
  return {
    root,
    output: path.join(root, 'capture'),
    commands,
    dependencies: {
      platform,
      home: root,
      environment: {},
      wait: async () => {},
      system: {
        uptime: () => 10,
        totalmem: () => 32 * 1024 ** 3,
        freemem: () => 4 * 1024 ** 3,
        loadavg: () => [1, 2, 3],
      },
      cpus: () => [{ times: { user: ++cpu * 20, nice: 0, sys: 0, idle: cpu * 80, irq: 0 } }],
      read(file) {
        if (file === '/proc/meminfo')
          return 'MemAvailable: 4194304 kB\nSwapTotal: 8192 kB\nSwapFree: 4096 kB\nCommitted_AS: 1024 kB\nCommitLimit: 2048 kB\n';
        if (file === '/proc/vmstat') return 'pgmajfault 12\npswpin 2\n';
        if (file === '/proc/diskstats') return '8 0 sda 1 0 8 2 3 0 24 4 0 6 7\n';
        return fs.readFileSync(file, 'utf8');
      },
      run(executable, args) {
        commands.push({ executable, args });
        if (executable === 'powershell.exe') throw new Error('Windows collector ran on Unix');
        if (executable === 'ps')
          return {
            status: 0,
            stderr: '',
            stdout: args.at(-1).includes('rss=')
              ? ` 71 1 ${start} 01:02.50 4096 ${image}\n`
              : `71 ${start} ${image} --type=renderer\n`,
          };
        if (executable === 'vm_stat')
          return {
            status: 0,
            stdout: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPageins: 12.\n',
            stderr: '',
          };
        return { status: 0, stdout: 'fixture output\n', stderr: '' };
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    assert.ok(fs.realpathSync(root).startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}arc-capture-test-`));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform} capture succeeds without Windows tools or GUI warnings`, async () => {
    const f = fixture(platform);
    const configRoot =
      platform === 'darwin' ? path.join(f.root, 'Library', 'Application Support') : path.join(f.root, '.config');
    const user = path.join(configRoot, 'Code', 'User');
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, 'settings.json'), '{\n"arc.maxSessions": 3\n}');
    await captureDiagnostics(
      { samples: 2, interval: 1, scenario: 'scrolling', outputDirectory: f.output },
      f.dependencies,
    );
    const json = (name) => JSON.parse(fs.readFileSync(path.join(f.output, name), 'utf8'));
    assert.equal(json('manifest.json').platform, platform);
    assert.equal(json('manifest.json').windowsDiagnostics, 'not-applicable');
    assert.equal(json('manifest.json').scenario, 'scrolling');
    assert.deepEqual(json('manifest.json').captureErrors, []);
    assert.equal(json('processes.json')[0].workingSetBytes, 4194304);
    assert.match(json('processes.json')[0].commandLine, /--type=renderer$/);
    assert.equal(json('processes.json')[0].name, platform === 'darwin' ? 'Electron' : 'node');
    assert.equal(json('performance-counters.json')[1].cpuBusyPercent, 20);
    assert.equal(json('performance-counters.json')[0].cpuBusyPercent, null);
    assert.match(fs.readFileSync(path.join(f.output, 'panel-settings.txt'), 'utf8'), /arc.maxSessions/);
    assert.doesNotMatch(
      fs.readFileSync(path.join(f.output, 'findings.txt'), 'utf8'),
      /Explorer|GUI readings|LSA|quota/,
    );
    if (platform === 'linux') {
      assert.equal(json('machine-start.json').physicalAvailableBytes, 4 * 1024 ** 3);
      assert.match(json('machine-start.json').linuxVmstat, /pgmajfault 12/);
      assert.ok(!f.commands.some((command) => ['vm_stat', 'sysctl'].includes(command.executable)));
    } else {
      assert.match(json('machine-start.json').macVmstat, /page size of 16384 bytes/);
      assert.ok(f.commands.some((command) => command.executable === 'sysctl'));
    }
  });
}

test('Windows uses the existing PowerShell collector with argument boundaries intact', async () => {
  const f = fixture('win32');
  const run = (executable, args, settings) => {
    assert.equal(executable, 'powershell.exe');
    assert.ok(args.includes('capture scenario with spaces'));
    assert.equal(args[args.indexOf('-OutputDirectory') + 1], f.output);
    assert.equal(settings.shell, false);
    return { status: 0 };
  };
  await captureDiagnostics(
    { samples: 2, interval: 1, scenario: 'capture scenario with spaces', outputDirectory: f.output },
    { platform: 'win32', run },
  );
  assert.equal(fs.existsSync(f.output), false);
});

test('failed Unix process collection stays unavailable and records the failure', async () => {
  const f = fixture('linux');
  const run = f.dependencies.run;
  f.dependencies.run = (executable, args) =>
    executable === 'ps' ? { status: 1, stdout: '', stderr: 'access denied' } : run(executable, args);
  await captureDiagnostics({ samples: 1, interval: 1, scenario: '', outputDirectory: f.output }, f.dependencies);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'processes.json'), 'utf8')), null);
  assert.match(fs.readFileSync(path.join(f.output, 'findings.txt'), 'utf8'), /snapshots are unavailable/);
  assert.match(fs.readFileSync(path.join(f.output, 'capture-errors.txt'), 'utf8'), /command exited with code 1/);
});

test('PID reuse does not combine different process lifetimes', () => {
  const old = parseProcesses('71 1 Fri Oct  2 22:00:00 2026 0:01.00 4096 /usr/bin/node', '');
  const current = parseProcesses('71 1 Fri Oct  2 22:00:01 2026 0:02.00 8192 /usr/bin/node', '');
  assert.deepEqual(processDeltas(old, current), []);
});

test('CPU samples remain unavailable across resets or a changed CPU set', () => {
  const sample = { times: { user: 20, nice: 0, sys: 0, idle: 80, irq: 0 } };
  assert.equal(cpuReading([sample], []), null);
  assert.equal(cpuReading([sample], [sample]), null);
  assert.equal(cpuReading([{ times: { ...sample.times, user: 30 } }], [sample]), null);
});

test('invalid sample limits fail before creating a capture', () => {
  assert.throws(() => parseOptions(['--samples', '0']), /integer from 1/);
  assert.throws(() => parseOptions(['--sample-interval-seconds', '11']), /integer from 1/);
});

for(let i=0;i<jobs.length;i++){let pass=true;try{await jobs[i].fn()}catch{pass=false}finally{cleanup?.()}checks.push({id:'capture-'+i,role:i===0?'symptom':'normal',pass})}console.log(JSON.stringify({checks}));