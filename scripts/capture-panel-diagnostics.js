#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const repoRoot = path.resolve(__dirname, '..');
const startPattern = '(\\w{3}\\s+\\w{3}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})';

function parseOptions(args) {
  const options = { samples: 8, interval: 1, scenario: '' };
  const names = {
    '--output-directory': 'outputDirectory',
    '--scenario': 'scenario',
    '--samples': 'samples',
    '--sample-interval-seconds': 'interval',
  };
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    if (!name || args[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[name] = args[index + 1];
  }
  for (const [name, maximum] of [
    ['samples', 60],
    ['interval', 10],
  ]) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > maximum)
      throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return options;
}

function parseProcesses(text, commands) {
  const commandByIdentity = new Map();
  const commandPattern = new RegExp(`^\\s*(\\d+)\\s+${startPattern}\\s+(.*)$`);
  for (const line of commands.split('\n')) {
    const match = line.match(commandPattern);
    if (match) commandByIdentity.set(`${match[1]}|${match[2]}`, match[3]);
  }
  const pattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+${startPattern}\\s+([\\d:.-]+)\\s+(\\d+)\\s+(.*)$`);
  const rows = [];
  for (const line of text.split('\n').filter((item) => item.trim())) {
    const match = line.match(pattern);
    if (!match) throw new Error(`Unrecognized ps process row: ${line}`);
    const [, id, parentId, started, cpu, rss, image] = match;
    const date = new Date(started);
    if (!Number.isFinite(date.getTime())) throw new Error(`Unrecognized process start time: ${started}`);
    const [days, clock] = cpu.includes('-') ? cpu.split('-') : ['0', cpu];
    const cpuSeconds = Number(days) * 86400 + clock.split(':').reduce((total, item) => total * 60 + Number(item), 0);
    rows.push({
      id: Number(id),
      parentId: Number(parentId),
      name: path.posix.basename(image),
      path: image,
      startedUtc: date.toISOString(),
      startTimePrecision: 'seconds',
      cpuSeconds,
      workingSetBytes: Number(rss) * 1024,
      privateMemoryBytes: null,
      handles: null,
      gdi: null,
      user: null,
      commandLine: commandByIdentity.get(`${id}|${started}`) ?? null,
      parentStatus: 'unknown',
    });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const parent = byId.get(row.parentId);
    row.parentStatus = !parent ? 'exited' : parent.startedUtc > row.startedUtc ? 'pid-reused' : 'running';
  }
  return rows;
}

function processDeltas(before, after) {
  const prior = new Map(before.map((row) => [`${row.id}|${row.startedUtc}`, row]));
  return after.flatMap((row) => {
    const old = prior.get(`${row.id}|${row.startedUtc}`);
    return old
      ? [
          {
            id: row.id,
            name: row.name,
            startedUtc: row.startedUtc,
            cpuSeconds: row.cpuSeconds - old.cpuSeconds,
            workingSetBytes: row.workingSetBytes - old.workingSetBytes,
          },
        ]
      : [];
  });
}

function cpuReading(before, after) {
  if (!before.length || before.length !== after.length) return null;
  let total = 0;
  let idle = 0;
  for (let index = 0; index < before.length; index++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = after[index].times[key] - before[index].times[key];
      if (delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? (100 * (total - idle)) / total : null;
}

async function captureDiagnostics(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const run = dependencies.run ?? spawnSync;
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unsupported operating system: ${platform}`);
  const output = path.resolve(
    options.outputDirectory || path.join(os.tmpdir(), `arc-diagnostics-${Date.now()}-${process.pid}`),
  );
  if (platform === 'win32') {
    const result = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'capture-panel-diagnostics.ps1'),
        '-OutputDirectory',
        output,
        '-Samples',
        String(options.samples),
        '-SampleIntervalSeconds',
        String(options.interval),
        '-Scenario',
        options.scenario,
      ],
      { stdio: 'inherit', windowsHide: true, shell: false },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Windows diagnostics exited with code ${result.status}.`);
    return output;
  }

  fs.mkdirSync(output);
  const errors = [];
  const started = Date.now();
  const collectorHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  const system = dependencies.system ?? os;
  const read = dependencies.read ?? ((file) => fs.readFileSync(file, 'utf8'));
  const cpus = dependencies.cpus ?? system.cpus;
  const wait = dependencies.wait ?? delay;
  const home = dependencies.home ?? os.homedir();
  const environment = dependencies.environment ?? process.env;
  const write = (name, value) =>
    fs.writeFileSync(
      path.join(output, name),
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  const optional = (area, operation) => {
    try {
      return operation();
    } catch (error) {
      errors.push(`${area}: ${error.message}`);
      return null;
    }
  };
  const command = (name, executable, args) =>
    optional(name, () => {
      const result = run(executable, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...environment, LC_ALL: 'C' },
        shell: false,
      });
      write(
        name,
        `Command: ${executable} ${args.join(' ')}\nExit code: ${result.status}\n\n${result.stdout ?? ''}${result.stderr ?? ''}`,
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`command exited with code ${result.status}`);
      return result.stdout;
    });
  const processes = (label) =>
    optional(label, () => {
      const rows = command(`${label}-ps.txt`, 'ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,time=,rss=,comm=']);
      const commands = command(`${label}-commands.txt`, 'ps', ['-ww', '-axo', 'pid=,lstart=,args=']);
      if (rows === null || commands === null) throw new Error('ps process data is unavailable');
      return parseProcesses(rows, commands);
    });
  const machine = () => {
    const snapshot = {
      timeUtc: new Date().toISOString(),
      bootUtc: new Date(Date.now() - system.uptime() * 1000).toISOString(),
      physicalTotalBytes: system.totalmem(),
      physicalFreeBytes: system.freemem(),
      loadAverage: system.loadavg(),
    };
    if (platform === 'linux') {
      const memory = optional('Linux memory', () => read('/proc/meminfo'));
      const fields = Object.fromEntries(
        (memory ?? '').split('\n').flatMap((line) => {
          const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
          return match ? [[match[1], Number(match[2]) * 1024]] : [];
        }),
      );
      snapshot.physicalAvailableBytes = fields.MemAvailable ?? null;
      snapshot.swapTotalBytes = fields.SwapTotal ?? null;
      snapshot.swapFreeBytes = fields.SwapFree ?? null;
      snapshot.linuxCommittedAsBytes = fields.Committed_AS ?? null;
      snapshot.linuxCommitLimitBytes = fields.CommitLimit ?? null;
      snapshot.linuxVmstat = optional('Linux paging counters', () => read('/proc/vmstat'));
      snapshot.linuxDiskstats = optional('Linux disk counters', () => read('/proc/diskstats'));
    } else {
      snapshot.macVmstat = command(`vm-stat-${Date.now()}.txt`, 'vm_stat', []);
      snapshot.macSwapUsage = command(`swap-usage-${Date.now()}.txt`, 'sysctl', ['vm.swapusage']);
    }
    return snapshot;
  };
  const metadata = (file) =>
    optional(`metadata ${file}`, () => {
      if (!fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      return { path: file, bytes: stat.size, lastWriteTimeUtc: stat.mtime.toISOString() };
    });

  command('git-head.txt', 'git', ['rev-parse', 'HEAD']);
  command('git-status.txt', 'git', ['status', '--short']);
  command('git-last-commit.txt', 'git', ['log', '-1', '--date=iso-strict', '--format=%H%n%ad%n%s']);
  command('code-status.txt', 'code', ['--status']);
  const machineStart = machine();
  const before = processes('processes');
  write('machine-start.json', machineStart);
  write('processes.json', before);
  const samples = [];
  let previousCpu = cpus();
  for (let index = 0; index < options.samples; index++) {
    if (index > 0) await wait(options.interval * 1000);
    const currentCpu = cpus();
    samples.push({ ...machine(), cpuBusyPercent: index > 0 ? cpuReading(previousCpu, currentCpu) : null });
    previousCpu = currentCpu;
  }
  const machineEnd = machine();
  const after = processes('processes-end');
  write('machine-end.json', machineEnd);
  write('processes-end.json', after);
  write('process-deltas.json', before && after ? processDeltas(before, after) : null);
  write('performance-counters.json', samples);

  const storageFiles = [];
  const settings = [];
  const configRoot =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : environment.XDG_CONFIG_HOME || path.join(home, '.config');
  for (const editor of ['Code', 'Code - Insiders', 'Cursor']) {
    const user = path.join(configRoot, editor, 'User');
    const storage = path.join(user, 'globalStorage', 'glin.arc');
    if (fs.existsSync(storage)) {
      optional(`storage ${editor}`, () => {
        for (const entry of fs.readdirSync(storage, { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) storageFiles.push(metadata(path.join(entry.parentPath ?? entry.path, entry.name)));
        }
      });
    }
    const file = path.join(user, 'settings.json');
    if (fs.existsSync(file))
      optional(`settings ${editor}`, () =>
        settings.push(
          file,
          ...read(file)
            .split('\n')
            .filter((line) => /"arc\./.test(line)),
        ),
      );
  }
  const bundle = metadata(path.join(repoRoot, 'extension', 'dist', 'extension.js'));
  if (bundle) bundle.sha256 = crypto.createHash('sha256').update(fs.readFileSync(bundle.path)).digest('hex');
  const installedBundles = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const extensions = path.join(home, editor, 'extensions');
    if (!fs.existsSync(extensions)) continue;
    optional(`installed bundles ${editor}`, () => {
      for (const directory of fs.readdirSync(extensions, { withFileTypes: true })) {
        if (!directory.isDirectory() || !directory.name.startsWith('glin.arc-')) continue;
        const file = path.join(extensions, directory.name, 'dist', 'extension.js');
        const item = metadata(file);
        if (item)
          installedBundles.push({
            ...item,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
          });
      }
    });
  }
  const volume = optional('volume', () => {
    const stat = fs.statfsSync(repoRoot);
    return {
      name: path.parse(repoRoot).root,
      filesystemType: stat.type,
      totalBytes: stat.blocks * stat.bsize,
      freeBytes: stat.bavail * stat.bsize,
    };
  });
  const findings = [];
  if (
    machineEnd.physicalAvailableBytes != null &&
    machineEnd.physicalAvailableBytes < 0.1 * machineEnd.physicalTotalBytes
  )
    findings.push(
      'Available physical memory is below 10 percent of total memory. Check paging activity and the active workload.',
    );
  if (!before || !after) findings.push('Process snapshots are unavailable. See capture-errors.txt.');
  if (!findings.length)
    findings.push('No configured thresholds were reached. Read the recorded counters before attributing a slowdown.');
  // Each editor window writes its own diagnostics log. The capture copies the withheld session tool lines of every
  // kept log, then the last whole lines of the newest log. Each copy keeps its newest whole lines within its bound.
  const diagnosticsLog = optional('diagnostics log', () => {
    const directory = path.join(environment.ARC_HOME || path.join(home, '.arc'), 'logs');
    if (!fs.existsSync(directory)) return null;
    const names = fs
      .readdirSync(directory)
      .filter((name) => /^arc-\d{8}-\d{6}-\d+\.jsonl$/.test(name))
      .sort();
    if (!names.length) return null;
    const withheld = [];
    for (const name of names)
      for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n'))
        if (line.includes('"event":"sessionComponentsWithheld"')) withheld.push(`${line}\n`);
    let withheldBytes = 0;
    let first = withheld.length;
    while (
      first > 0 &&
      withheldBytes + Buffer.byteLength(withheld[first - 1]) <= (dependencies.withheldBytes ?? 256 * 1024)
    )
      withheldBytes += Buffer.byteLength(withheld[--first]);
    write('session-components-withheld.jsonl', withheld.slice(first).join(''));
    const file = path.join(directory, names.at(-1));
    const bytes = fs.statSync(file).size;
    const start = Math.max(0, bytes - (dependencies.logBytes ?? 1024 * 1024));
    const buffer = Buffer.alloc(bytes - start);
    const fd = fs.openSync(file, 'r');
    let count;
    try {
      count = fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.subarray(0, count).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    write('diagnostics-log.jsonl', text);
    return {
      path: file,
      bytes,
      copiedBytes: Buffer.byteLength(text),
      withheldLines: withheld.length - first,
      withheldBytes,
    };
  });
  write('findings.txt', `${findings.join('\n')}\n`);
  write('panel-settings.txt', settings.join('\n'));
  write('manifest.json', {
    capturedAtUtc: new Date(started).toISOString(),
    durationSeconds: (options.samples - 1) * options.interval,
    captureDurationSeconds: (Date.now() - started) / 1000,
    platform,
    osVersion: os.release(),
    nodeVersion: process.version,
    repoRoot,
    outputDirectory: output,
    scenario: options.scenario,
    windowsDiagnostics: 'not-applicable',
    captureTool: {
      path: __filename,
      sha256: collectorHash,
    },
    repoBundle: bundle,
    installedBundles,
    volume,
    agentsViewDatabase: metadata(path.join(home, '.agentsview', 'sessions.db')),
    extensionStorageFiles: storageFiles,
    diagnosticsLog,
    captureErrors: errors,
  });
  write('capture-errors.txt', errors.join('\n'));
  return output;
}

module.exports = { captureDiagnostics, parseOptions, parseProcesses, processDeltas, cpuReading };
if (require.main === module) {
  captureDiagnostics(parseOptions(process.argv.slice(2)))
    .then((output) => {
      if (process.platform !== 'win32') console.log(`Diagnostics written to ${output}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
