// The tool-result kinds that `arc cost --by-tool` and the cost popover's Tools tab share. A
// request's cost goes to the tool results it read, split evenly between them.

export const TOOL_KINDS = [
  'git',
  'file read',
  'file edit',
  'search',
  'test or build',
  'subagent launch',
  'wait',
  'other',
  'no tool result',
];

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (character === '\\' && quote !== "'" && index + 1 < segment.length && /[\\"'\s]/.test(segment[index + 1])) {
      word += segment[++index];
    } else if (character === quote) {
      quote = null;
    } else if ((character === '"' || character === "'") && quote === null) {
      quote = character;
    } else if (/\s/.test(character) && quote === null) {
      if (word) {
        words.push(word);
        word = '';
      }
    } else {
      word += character;
    }
  }
  if (word) words.push(word);
  return words;
}

// The kind of a shell command line, and the program of the segment that decided it.
function shellCommand(command: string): { kind: string; program: string | null } {
  const segments = command
    .replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*\n)[\s\S]*?^\s*\2\s*$/gm, '$1')
    .split(/&&|\|\||;|\r?\n/);
  for (const segment of segments) {
    const words = shellWords(segment.trim());
    if (!words.length || /^\$(?:env:)?[A-Za-z_]\w*\s*=/.test(segment.trim())) continue;
    let index = 0;
    while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index])) index++;
    const program = words[index]
      ?.replaceAll('\\', '/')
      .split('/')
      .at(-1)
      ?.replace(/\.exe$/i, '')
      .toLowerCase();
    if (!program || program === 'cd' || program === 'set-location') continue;
    const args = words.slice(index + 1);
    return { kind: programKind(program, args), program };
  }
  return { kind: 'other', program: null };
}

function programKind(program: string, args: readonly string[]): string {
  if (program === 'git') return 'git';
  if (['cat', 'head', 'tail', 'less', 'type', 'get-content'].includes(program))
    return program === 'cat' && args.some((word) => word.startsWith('>')) ? 'other' : 'file read';
  if (['rg', 'grep', 'find', 'ls', 'select-string', 'get-childitem'].includes(program)) return 'search';
  if (['npm', 'npx', 'pnpm', 'yarn', 'pytest', 'vitest', 'tsc', 'make', 'cargo', 'dotnet'].includes(program))
    return 'test or build';
  if (program === 'sed') return args.includes('-n') ? 'file read' : 'other';
  if (program === 'python' || program === 'python3')
    return args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]) ? 'test or build' : 'other';
  if (program === 'go') return args[0] === 'test' ? 'test or build' : 'other';
  if (program === 'node') return args.includes('--test') ? 'test or build' : 'other';
  return 'other';
}

export interface ToolResult {
  kind: string;
  label: string;
}

// A labelled shell result, such as `Bash git`. A command without a program keeps the bare tool name.
function shellResult(tool: string, command: string): ToolResult {
  const { kind, program } = shellCommand(command);
  return { kind, label: program ? `${tool} ${program}` : tool };
}

export function toolKind(name: string, input: unknown): ToolResult {
  if (name === 'Agent' || name === 'Task') return { kind: 'subagent launch', label: name };
  if (name === 'Read') return { kind: 'file read', label: name };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return { kind: 'file edit', label: name };
  if (name === 'Grep' || name === 'Glob') return { kind: 'search', label: name };
  if (name === 'Bash' || name === 'PowerShell')
    return shellResult(
      name,
      typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string'
        ? input.command
        : '',
    );
  return { kind: 'other', label: name };
}

// PowerShell startup options that take a value, by full name and alias.
const POWERSHELL_VALUE_OPTIONS = new Set([
  'configurationfile',
  'configurationname',
  'config',
  'custompipename',
  'executionpolicy',
  'ex',
  'ep',
  'inputformat',
  'inp',
  'if',
  'outputformat',
  'o',
  'of',
  'psconsolefile',
  'settingsfile',
  'version',
  'v',
  'windowstyle',
  'w',
  'workingdirectory',
  'wd',
]);
// PowerShell startup switches that take no value, by full name and alias.
const POWERSHELL_SWITCHES = new Set([
  'interactive',
  'i',
  'login',
  'l',
  'mta',
  'noexit',
  'noe',
  'nologo',
  'noninteractive',
  'noni',
  'noprofile',
  'nop',
  'noprofileloadtime',
  'sta',
]);

// The command text after a PowerShell `-Command` switch. Only the leading startup options are read.
// Any other word ends them, such as `-File`, `-EncodedCommand`, an unknown option, or a script path.
function powerShellCommand(words: readonly string[]): string | null {
  for (let at = 1; at < words.length; at++) {
    const option = /^-([a-z]+)(:.*)?$/i.exec(words[at]);
    if (!option) return null;
    const name = option[1].toLowerCase();
    if (name === 'c' || name === 'command') return option[2] ? null : words.slice(at + 1).join(' ');
    if (POWERSHELL_VALUE_OPTIONS.has(name)) {
      if (!option[2]) at++;
    } else if (!POWERSHELL_SWITCHES.has(name)) return null;
  }
  return null;
}

// The command line of a Codex `shell` argument array, without its shell wrapper.
function codexShellArray(command: readonly unknown[]): string {
  const words = command.filter((word): word is string => typeof word === 'string');
  const shell = words[0]
    ?.replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/\.exe$/i, '')
    .toLowerCase();
  const flag = words[1]?.toLowerCase();
  if ((shell === 'bash' || shell === 'sh' || shell === 'zsh') && (flag === '-lc' || flag === '-c'))
    return words.slice(2).join(' ');
  if (shell === 'powershell' || shell === 'pwsh') return powerShellCommand(words) ?? words.join(' ');
  return words.join(' ');
}

// A Codex tool call's kind. An `exec` wrapper call maps like the one tool it wraps.
export function codexToolKind(recordedName: string, input: unknown): ToolResult {
  const wrapped = recordedName === 'exec' ? wrappedCommand(input) : null;
  const name =
    recordedName === 'exec'
      ? (nestedToolName(input) ?? (wrapped === null ? recordedName : 'exec_command'))
      : recordedName;
  if (name === 'wait_agent' || name === 'wait' || name === 'write_stdin') return { kind: 'wait', label: name };
  if (name === 'spawn_agent') return { kind: 'subagent launch', label: name };
  if (name === 'apply_patch') return { kind: 'file edit', label: name };
  if (name === 'exec_command' || name === 'shell' || name === 'shell_command') {
    if (wrapped !== null) return shellResult(name, wrapped);
    let parsed: unknown = input;
    if (typeof input === 'string') {
      try {
        parsed = JSON.parse(input);
      } catch {
        parsed = null;
      }
    }
    const fields =
      typeof parsed === 'object' && parsed !== null ? (parsed as { cmd?: unknown; command?: unknown }) : {};
    const command =
      typeof fields.cmd === 'string'
        ? fields.cmd
        : typeof fields.command === 'string'
          ? fields.command
          : Array.isArray(fields.command)
            ? codexShellArray(fields.command)
            : '';
    return shellResult(name, command);
  }
  return { kind: 'other', label: name || 'other' };
}

// Extract a nested tool name when a custom exec wrapper names exactly one tool kind.
// Completed items supply command and edit details. Calls without completed items retain this wrapper-derived name.
export function nestedToolName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const names = new Set<string>();
  for (const match of raw.matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    names.add(match[1]);
  }
  if (names.size !== 1) {
    return null;
  }
  const [name] = names;
  return name === 'exec_command' || name === 'shell_command' ? null : name;
}

// Some client command wrappers have no completed CommandExecution item. Their first
// argument is still a JSON-compatible object, so read a directly written double-quoted
// command without evaluating the surrounding JavaScript.
export function wrappedCommand(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const match =
    /\btools\.(?:exec_command|shell_command)\s*\(\s*\{\s*(?:"(?:cmd|command)"|cmd|command)\s*:\s*("(?:\\.|[^"\\])*")/.exec(
      raw,
    );
  if (!match) {
    return null;
  }
  try {
    const command = JSON.parse(match[1]) as unknown;
    return typeof command === 'string' && command.trim() ? command : null;
  } catch {
    return null;
  }
}

// The part of a request's cost that one tool result it read carries. Every result carries the
// same part, so a request that read three results gives each a third.
export function toolResultShare(results: readonly unknown[]): number {
  return results.length ? 1 / results.length : 0;
}

// Each kind's part of a request's cost, from the kinds of the results it read in order.
export function toolResultWeights(kinds: readonly string[]): Map<string, number> {
  const share = toolResultShare(kinds);
  const weights = new Map<string, number>();
  for (const kind of kinds) weights.set(kind, (weights.get(kind) ?? 0) + share);
  return weights;
}
