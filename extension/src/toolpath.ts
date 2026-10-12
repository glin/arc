import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ARC_IDENTITY } from './identity';
import { acquireToolLock, admitToolPath } from './toolownership';

export interface UserPathValue {
  value: string | null;
  kind: 'String' | 'ExpandString';
}

export function terminalToolPath(
  bin: string,
  platform = process.platform,
): { variable: string; value: string } | undefined {
  const delimiter = platform === 'win32' ? ';' : ':';
  if (bin.includes(delimiter) || /[\r\n]/u.test(bin)) return undefined;
  return { variable: platform === 'win32' ? 'Path' : 'PATH', value: delimiter + bin };
}

export function appendedUserPath(previous: UserPathValue, bin: string): UserPathValue {
  if (!terminalToolPath(bin, 'win32')) throw new Error('Arc PATH setup cannot use this installation folder.');
  const normalized = (value: string) =>
    value
      .replace(/^"|"$/g, '')
      .replace(/[\\/]+$/, '')
      .replaceAll('/', '\\')
      .toLowerCase();
  if (previous.value?.split(';').some((entry) => normalized(entry) === normalized(bin))) return previous;
  return {
    kind: previous.kind,
    value: `${previous.value ?? ''}${previous.value && !previous.value.endsWith(';') ? ';' : ''}${bin}`,
  };
}

export function existingToolCommands(env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const folders = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((folder) => path.isAbsolute(folder));
  const suffixes = platform === 'win32' ? ['', '.com', '.exe', '.bat', '.cmd', '.ps1'] : [''];
  const found: string[] = [];
  for (const name of [ARC_IDENTITY.cliExecutable]) {
    for (const folder of folders) {
      const file = suffixes
        .map((suffix) => path.join(folder, name + suffix))
        .find((candidate) => {
          try {
            return fs.statSync(candidate).isFile() && (platform === 'win32' || !!(fs.statSync(candidate).mode & 0o111));
          } catch {
            return false;
          }
        });
      if (file) {
        found.push(file);
        break;
      }
    }
  }
  return found;
}

function windowsPathCommand(script: string): string {
  return execFileSync(
    path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 8192, windowsHide: true },
  ).trim();
}

// The lock target belongs to the user, independently of every selected software root.
export function appendWindowsUserPath(
  bin: string,
  userHome = os.homedir(),
  platform = process.platform,
  execute = windowsPathCommand,
): 'appended' | 'present' {
  if (platform !== 'win32') throw new Error('Automatic external PATH setup is available only on Windows.');
  const home = admitToolPath(userHome);
  const lock = acquireToolLock(path.join(home, '.arc-command-path.lock'));
  try {
    const directory = admitToolPath(bin);
    const previous = JSON.parse(
      execute(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
try {
  $raw=if($key){$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}
  $kind=if($null -eq $raw){'ExpandString'}else{$key.GetValueKind('Path').ToString()}
  @{value=$raw;kind=$kind}|ConvertTo-Json -Compress
}finally{if($key){$key.Dispose()}}`),
    ) as UserPathValue;
    if (
      (previous.value !== null && typeof previous.value !== 'string') ||
      !['String', 'ExpandString'].includes(previous.kind)
    )
      throw new Error('The user PATH has an unsupported registry representation.');
    const next = appendedUserPath(previous, directory);
    if (next === previous) return 'present';
    const receipt = Buffer.from(JSON.stringify({ previous, next }), 'utf8').toString('base64');
    const output = execute(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$change=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${receipt}'))|ConvertFrom-Json
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $raw=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind=if($null -eq $raw){'ExpandString'}else{$key.GetValueKind('Path').ToString()}
  if($raw -cne $change.previous.value -or $kind -cne $change.previous.kind){throw 'The user PATH changed during Arc setup. Retry setup.'}
  $key.SetValue('Path',$change.next.value,[Microsoft.Win32.RegistryValueKind]::$kind)
}finally{$key.Dispose()}
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ArcPathNotification { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r); }'
$result=[UIntPtr]::Zero
[void][ArcPathNotification]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result)
Write-Output 'appended'`);
    if (output !== 'appended') throw new Error('Windows did not confirm Arc PATH setup.');
    return 'appended';
  } finally {
    lock.release();
  }
}

export function manualToolPath(bin: string): string {
  if (!terminalToolPath(bin, 'linux'))
    return 'This installation folder cannot be added to PATH. Run the installed command by its full path.';
  const quoted = "'" + bin.replaceAll("'", "'\\''") + "'";
  return `Bash or Zsh: export PATH="$PATH":${quoted}. Bash login shells read the first available ~/.bash_profile, ~/.bash_login or ~/.profile. Interactive non-login Bash reads ~/.bashrc. Zsh login shells read \${ZDOTDIR:-$HOME}/.zprofile. Interactive Zsh reads \${ZDOTDIR:-$HOME}/.zshrc. Fish: fish_add_path --append --path ${quoted}. Other shells need their own PATH syntax. Existing aliases and functions keep precedence.`;
}
