<#
.SYNOPSIS
Captures a short Windows performance snapshot for Arc lag.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\capture-panel-diagnostics.ps1 `
  -Scenario "rail open, scrolling, 39 pins, 4 running"
#>

[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [ValidateRange(1, 60)]
  [int]$Samples = 8,
  [ValidateRange(1, 10)]
  [int]$SampleIntervalSeconds = 1,
  [string]$Scenario = ''
)

Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This collector requires Windows. Run node scripts/capture-panel-diagnostics.js on Linux or macOS.'
}

$capturedAt = Get-Date
$collectorHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
$stamp = $capturedAt.ToString('yyyyMMdd-HHmmss-fff')
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) "arc-diagnostics-$stamp"
}

if (Test-Path -LiteralPath $OutputDirectory) {
  throw "Output directory already exists: $OutputDirectory"
}

$output = (New-Item -ItemType Directory -Path $OutputDirectory -ErrorAction Stop).FullName
$repoRoot = Split-Path -Parent $PSScriptRoot
$captureErrors = New-Object System.Collections.Generic.List[string]
$utf8 = New-Object System.Text.UTF8Encoding($false)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ArcWindowsCounters {
  [StructLayout(LayoutKind.Sequential)] public struct PerformanceInfo {
    public uint Size;
    public IntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable;
    public IntPtr SystemCache, KernelTotal, KernelPaged, KernelNonpaged;
    public IntPtr PageSize;
    public uint HandleCount, ProcessCount, ThreadCount;
  }
  [DllImport("psapi.dll", SetLastError=true)] static extern bool GetPerformanceInfo(out PerformanceInfo info, uint size);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetGuiResources(IntPtr process, uint flags);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("secur32.dll")] static extern uint LsaEnumerateLogonSessions(out uint count, out IntPtr list);
  [DllImport("secur32.dll")] static extern uint LsaFreeReturnBuffer(IntPtr list);
  public static PerformanceInfo Memory() {
    PerformanceInfo info = new PerformanceInfo();
    info.Size = (uint)Marshal.SizeOf(typeof(PerformanceInfo));
    if (!GetPerformanceInfo(out info, info.Size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return info;
  }
  public static uint Gui(IntPtr process, uint flags) {
    SetLastError(0);
    uint value = GetGuiResources(process, flags);
    int error = Marshal.GetLastWin32Error();
    if (value == 0 && error != 0) throw new System.ComponentModel.Win32Exception(error);
    return value;
  }
  public static uint LogonCount() {
    uint count; IntPtr list;
    uint status = LsaEnumerateLogonSessions(out count, out list);
    if (status != 0) throw new Exception("LsaEnumerateLogonSessions status " + status);
    if (list != IntPtr.Zero) LsaFreeReturnBuffer(list);
    return count;
  }
}
'@

function Write-CaptureFile {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowEmptyString()][string]$Content
  )

  [IO.File]::WriteAllText((Join-Path $output $Name), $Content, $utf8)
}

function Add-CaptureError {
  param(
    [Parameter(Mandatory = $true)][string]$Area,
    [Parameter(Mandatory = $true)][string]$Message
  )

  $captureErrors.Add("${Area}: $Message")
}

function Invoke-CapturedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  try {
    $lines = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $body = @(
      "Command: $FilePath $($Arguments -join ' ')"
      "Exit code: $exitCode"
      ''
      ($lines | Out-String).TrimEnd()
    ) -join [Environment]::NewLine
    Write-CaptureFile -Name $Name -Content $body
    if ($exitCode -ne 0) {
      Add-CaptureError -Area $Name -Message "command exited with code $exitCode"
    }
  } catch {
    Write-CaptureFile -Name $Name -Content $_.Exception.ToString()
    Add-CaptureError -Area $Name -Message $_.Exception.Message
  }
}

function File-Metadata {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  [pscustomobject]@{
    path = $item.FullName
    bytes = $item.Length
    lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
  }
}

function Read-Optional {
  param([scriptblock]$Read, [string]$Area)
  try { & $Read } catch {
    Add-CaptureError -Area $Area -Message $_.Exception.Message
    $null
  }
}

# Each editor window writes its own diagnostics log. Copies the withheld session tool lines of every kept log to
# WithheldDestination, then the last whole lines of the newest log to Destination. Each copy keeps its newest whole
# lines within its bound.
function Copy-DiagnosticsLog {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$WithheldDestination,
    [long]$MaximumBytes = 1048576,
    [long]$MaximumWithheldBytes = 262144
  )

  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $null }
  $logs = @(Get-ChildItem -LiteralPath $Directory -File |
    Where-Object { $_.Name -match '^arc-\d{8}-\d{6}-\d+\.jsonl$' } |
    Sort-Object Name)
  if (-not $logs.Count) { return $null }
  $withheld = New-Object System.Collections.Generic.List[string]
  foreach ($log in $logs) {
    $reader = New-Object IO.StreamReader([IO.File]::Open($log.FullName, 'Open', 'Read', 'ReadWrite'), (New-Object Text.UTF8Encoding($false)))
    try {
      foreach ($line in $reader.ReadToEnd().Split("`n")) {
        if ($line.Contains('"event":"sessionComponentsWithheld"')) { $withheld.Add("$line`n") }
      }
    } finally {
      $reader.Dispose()
    }
  }
  $withheldBytes = 0
  $first = $withheld.Count
  while ($first -gt 0 -and $withheldBytes + [Text.Encoding]::UTF8.GetByteCount($withheld[$first - 1]) -le $MaximumWithheldBytes) {
    $first -= 1
    $withheldBytes += [Text.Encoding]::UTF8.GetByteCount($withheld[$first])
  }
  $kept = $withheld.GetRange($first, $withheld.Count - $first)
  [IO.File]::WriteAllText($WithheldDestination, ($kept -join ''), (New-Object Text.UTF8Encoding($false)))
  $newest = $logs[-1]
  $start = [Math]::Max(0, $newest.Length - $MaximumBytes)
  $buffer = New-Object byte[] ($newest.Length - $start)
  $read = 0
  $stream = [IO.File]::Open($newest.FullName, 'Open', 'Read', 'ReadWrite')
  try {
    [void]$stream.Seek($start, 'Begin')
    while ($read -lt $buffer.Length) {
      $count = $stream.Read($buffer, $read, $buffer.Length - $read)
      if ($count -le 0) { break }
      $read += $count
    }
  } finally {
    $stream.Dispose()
  }
  $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  if ($start -gt 0) { $text = $text.Substring($text.IndexOf("`n") + 1) }
  [IO.File]::WriteAllText($Destination, $text, (New-Object Text.UTF8Encoding($false)))
  [pscustomobject]@{
    path = $newest.FullName
    bytes = $newest.Length
    copiedBytes = [Text.Encoding]::UTF8.GetByteCount($text)
    withheldLines = $kept.Count
    withheldBytes = $withheldBytes
  }
}

function Get-ProcessSnapshot {
  $cimById = @{}
  try {
    foreach ($row in (Get-CimInstance Win32_Process -ErrorAction Stop)) { $cimById[[int]$row.ProcessId] = $row }
  } catch { Add-CaptureError -Area 'process command lines and parents' -Message $_.Exception.Message }
  $rows = @{}
  foreach ($process in (Get-Process -ErrorAction SilentlyContinue)) {
    try {
      $id = $process.Id
      $cim = $cimById[$id]
      $started = Read-Optional {
        if ($null -eq $process.StartTime) { throw 'start time unavailable' }
        $process.StartTime.ToUniversalTime().ToString('o')
      } "process $id start"
      if ($null -ne $cim -and $null -eq $cim.CreationDate) { $cim = $null }
      if ($null -ne $cim -and $null -ne $cim.CreationDate -and $null -ne $started -and
          [math]::Abs(($cim.CreationDate.ToUniversalTime() - [datetimeoffset]::Parse($started).UtcDateTime).TotalSeconds) -gt 1) {
        $cim = $null
      }
      $path = Read-Optional { $process.Path } "process $id path"
      $handle = Read-Optional { $process.Handle } "process $id handle"
      $gdi = $null
      $user = $null
      if ($null -ne $handle) {
        $gdi = Read-Optional { [ArcWindowsCounters]::Gui($handle, 0) } "process $id GDI"
        $user = Read-Optional { [ArcWindowsCounters]::Gui($handle, 1) } "process $id USER"
      }
      $rows[$id] = [pscustomobject]@{
        id = $id; name = $process.ProcessName; cpuSeconds = (Read-Optional { $process.CPU } "process $id CPU")
        workingSetBytes = (Read-Optional { $process.WorkingSet64 } "process $id working set")
        privateMemoryBytes = (Read-Optional { $process.PrivateMemorySize64 } "process $id private memory")
        pagedMemoryBytes = (Read-Optional { $process.PagedMemorySize64 } "process $id paged memory")
        handles = (Read-Optional { $process.HandleCount } "process $id handles")
        threads = (Read-Optional { $process.Threads.Count } "process $id threads")
        gdi = $gdi; user = $user; startedUtc = $started; path = $path
        commandLine = if ($null -ne $cim) { $cim.CommandLine } else { $null }
        parentId = if ($null -ne $cim) { $cim.ParentProcessId } else { $null }
        parentStatus = 'unknown'
      }
    } catch {
      Add-CaptureError -Area "process $($process.Id)" -Message $_.Exception.Message
    } finally { $process.Dispose() }
  }
  foreach ($row in $rows.Values) {
    if ($null -eq $row.parentId -or $null -eq $row.startedUtc) { continue }
    $parent = $rows[[int]$row.parentId]
    $row.parentStatus = Get-ParentStatus -Parent $parent -Child $row
  }
  @($rows.Values | Sort-Object name, id)
}

function Get-ParentStatus {
  param($Parent, $Child)
  if ($null -eq $Parent) { return 'exited' }
  if ($null -eq $Parent.startedUtc -or $null -eq $Child.startedUtc) { return 'unknown' }
  if ([datetimeoffset]::Parse($Parent.startedUtc).UtcDateTime -gt [datetimeoffset]::Parse($Child.startedUtc).UtcDateTime) { return 'pid-reused' }
  'running'
}

function Get-MachineSnapshot {
  $os = Read-Optional { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } 'machine boot'
  $memory = Read-Optional { [ArcWindowsCounters]::Memory() } 'machine memory'
  $sessions = Read-Optional { [ArcWindowsCounters]::LogonCount() } 'LSA logon session count'
  $quota = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows'
  $quotaValues = Read-Optional { Get-ItemProperty -LiteralPath $quota -ErrorAction Stop } 'GUI quotas'
  $sandboxUsers = Read-Optional { @(Get-LocalUser -ErrorAction Stop | Where-Object Name -like 'CodexSandbox*' | ForEach-Object {
    [pscustomobject]@{ name = $_.Name; lastLogon = if ($_.LastLogon) { $_.LastLogon.ToString('o') } else { $null } }
  }) } 'sandbox users'
  $lsass = Read-Optional { Get-Process lsass -ErrorAction Stop | Select-Object -First 1 Id, HandleCount } 'LSASS handles'
  if ($null -ne $memory) { $page = $memory.PageSize.ToInt64() }
  [pscustomobject]@{
    timeUtc = (Get-Date).ToUniversalTime().ToString('o')
    bootUtc = if ($null -ne $os) { $os.LastBootUpTime.ToUniversalTime().ToString('o') } else { $null }
    physicalAvailableBytes = if ($null -ne $memory) { $memory.PhysicalAvailable.ToInt64() * $page } else { $null }
    commitUsedBytes = if ($null -ne $memory) { $memory.CommitTotal.ToInt64() * $page } else { $null }
    commitLimitBytes = if ($null -ne $memory) { $memory.CommitLimit.ToInt64() * $page } else { $null }
    pagedPoolBytes = if ($null -ne $memory) { $memory.KernelPaged.ToInt64() * $page } else { $null }
    nonpagedPoolBytes = if ($null -ne $memory) { $memory.KernelNonpaged.ToInt64() * $page } else { $null }
    logonSessions = $sessions
    lsass = $lsass
    sandboxUsers = $sandboxUsers
    gdiQuota = if ($null -eq $quotaValues) { $null } elseif ($quotaValues.PSObject.Properties['GDIProcessHandleQuota']) { $quotaValues.GDIProcessHandleQuota } else { 10000 }
    userQuota = if ($null -eq $quotaValues) { $null } elseif ($quotaValues.PSObject.Properties['USERProcessHandleQuota']) { $quotaValues.USERProcessHandleQuota } else { 10000 }
  }
}

function Get-ProcessDeltas {
  param($Before, $After)
  $old = @{}
  foreach ($row in $Before) {
    if ($null -ne $row.startedUtc) { $old["$($row.id)|$($row.startedUtc)"] = $row }
  }
  foreach ($row in $After) {
    if ($null -eq $row.startedUtc) { continue }
    $prior = $old["$($row.id)|$($row.startedUtc)"]
    if ($null -eq $prior) { continue }
    [pscustomobject]@{
      id = $row.id; name = $row.name; startedUtc = $row.startedUtc
      handles = if ($null -ne $row.handles -and $null -ne $prior.handles) { $row.handles - $prior.handles } else { $null }
      gdi = if ($null -ne $row.gdi -and $null -ne $prior.gdi) { $row.gdi - $prior.gdi } else { $null }
      user = if ($null -ne $row.user -and $null -ne $prior.user) { $row.user - $prior.user } else { $null }
    }
  }
}

function Get-ProcessFindings {
  param($Processes, $Machine, $Deltas)
  $deltaById = @{}
  foreach ($delta in $Deltas) { $deltaById[[int]$delta.id] = $delta }
  $findings = New-Object System.Collections.Generic.List[string]
  foreach ($process in $Processes) {
    $explorerQuotaPressure = $false
    foreach ($kind in @('gdi', 'user')) {
      $quota = if ($kind -eq 'gdi') { $Machine.gdiQuota } else { $Machine.userQuota }
      $count = $process.$kind
      if ($null -ne $quota -and $quota -gt 0 -and $null -ne $count -and $count -ge 0.9 * $quota) {
        $findings.Add("$($process.name) PID $($process.id): $kind $count of $quota quota ($([math]::Round(100 * $count / $quota))%).")
        if ($process.name -eq 'explorer') { $explorerQuotaPressure = $true }
      }
    }
    if ($null -ne $process.handles -and $process.handles -ge 100000) {
      $findings.Add("$($process.name) PID $($process.id): $($process.handles) handles, above the 100000 review threshold.")
    }
    if ($process.name -eq 'find' -and $process.path -match '[\\/]Git[\\/]') {
      if ($process.parentStatus -eq 'exited' -or $process.parentStatus -eq 'pid-reused') {
        $findings.Add("Git find PID $($process.id): parent PID $($process.parentId) is $($process.parentStatus). Command: $($process.commandLine)")
      }
    }
    $delta = $deltaById[[int]$process.id]
    if ($process.name -eq 'explorer') {
      foreach ($kind in @('gdi', 'user')) {
        if ($null -ne $delta -and $null -ne $delta.$kind -and $delta.$kind -gt 0) {
          $findings.Add("Explorer PID $($process.id): $kind objects grew by $($delta.$kind) within this capture. Growth alone does not establish a leak.")
        }
      }
      if ($explorerQuotaPressure) {
        $findings.Add('Restart Windows Explorer in Task Manager for temporary relief. The taskbar and File Explorer windows reload. Restarting does not identify the allocation source.')
      }
    }
    if ($null -ne $delta -and $null -ne $delta.handles -and $delta.handles -ge 1000) {
      $findings.Add("$($process.name) PID $($process.id): handles grew by $($delta.handles) within this capture.")
    }
  }
  if ($null -ne $Machine.commitUsedBytes -and $null -ne $Machine.commitLimitBytes -and
      $Machine.commitLimitBytes -gt 0 -and $Machine.commitUsedBytes -ge 0.9 * $Machine.commitLimitBytes) {
    $findings.Add("Memory commitment reached $([math]::Round(100 * $Machine.commitUsedBytes / $Machine.commitLimitBytes))% of the commit limit.")
  }
  $missingGdi = @($Processes | Where-Object { $null -eq $_.gdi }).Count
  $missingUser = @($Processes | Where-Object { $null -eq $_.user }).Count
  if ($missingGdi -gt 0 -or $missingUser -gt 0) {
    $findings.Add("GUI readings unavailable for $missingGdi GDI and $missingUser USER process entries. See capture-errors.txt.")
  }
  if ($null -eq $Machine.logonSessions) { $findings.Add('LSA logon session count unavailable. See capture-errors.txt.') }
  if ($findings.Count -eq 0) { $findings.Add('No configured thresholds were reached.') }
  $findings.ToArray()
}

Push-Location $repoRoot
try {
  Invoke-CapturedCommand -Name 'git-head.txt' -FilePath 'git.exe' -Arguments @('rev-parse', 'HEAD')
  Invoke-CapturedCommand -Name 'git-status.txt' -FilePath 'git.exe' -Arguments @('status', '--short')
  Invoke-CapturedCommand -Name 'git-last-commit.txt' -FilePath 'git.exe' -Arguments @(
    'log', '-1', '--date=iso-strict', '--format=%H%n%ad%n%s'
  )
} finally {
  Pop-Location
}

$codeCommand = Get-Command code.cmd -ErrorAction SilentlyContinue
if ($null -eq $codeCommand) {
  $codeCommand = Get-Command code -ErrorAction SilentlyContinue
}
if ($null -ne $codeCommand) {
  Invoke-CapturedCommand -Name 'code-status.txt' -FilePath $codeCommand.Source -Arguments @('--status')
} else {
  Write-CaptureFile -Name 'code-status.txt' -Content 'The code command was not found on PATH.'
  Add-CaptureError -Area 'code-status.txt' -Message 'code command not found'
}

$machineStart = Get-MachineSnapshot
$processes = @(Get-ProcessSnapshot)
Write-CaptureFile -Name 'processes.json' -Content ($processes | ConvertTo-Json -Depth 4)
$processes | Export-Csv -LiteralPath (Join-Path $output 'processes.csv') -NoTypeInformation -Encoding UTF8
Write-CaptureFile -Name 'machine-start.json' -Content ($machineStart | ConvertTo-Json -Depth 5)

$counterPaths = @(
  '\Processor(_Total)\% Processor Time',
  '\Memory\Available MBytes',
  '\Memory\Committed Bytes',
  '\Memory\Commit Limit',
  '\Memory\Page Reads/sec',
  '\Memory\Pages Input/sec',
  '\PhysicalDisk(_Total)\% Disk Time',
  '\PhysicalDisk(_Total)\Disk Bytes/sec',
  '\PhysicalDisk(_Total)\Current Disk Queue Length',
  '\Process(*)\ID Process',
  '\Process(*)\IO Read Bytes/sec',
  '\Process(*)\IO Write Bytes/sec',
  '\Process(*)\% Processor Time',
  '\Process(*)\Working Set - Private'
)

try {
  $counterErrors = @()
  $counterResult = Get-Counter -Counter $counterPaths -SampleInterval $SampleIntervalSeconds `
    -MaxSamples $Samples -ErrorAction SilentlyContinue -ErrorVariable counterErrors
  foreach ($counterError in $counterErrors) {
    Add-CaptureError -Area 'performance-counters.csv' -Message $counterError.Exception.Message
  }
  $counterRows = foreach ($sampleSet in $counterResult) {
    foreach ($sample in $sampleSet.CounterSamples) {
      [pscustomobject]@{
        timestampUtc = $sample.Timestamp.ToUniversalTime().ToString('o')
        instance = $sample.InstanceName
        path = $sample.Path
        value = if ($sample.Status -eq 0) { $sample.CookedValue } else { $null }
        status = $sample.Status
      }
    }
  }
  $counterRows | Export-Csv -LiteralPath (Join-Path $output 'performance-counters.csv') `
    -NoTypeInformation -Encoding UTF8
} catch {
  Write-CaptureFile -Name 'performance-counters-error.txt' -Content $_.Exception.ToString()
  Add-CaptureError -Area 'performance-counters.csv' -Message $_.Exception.Message
}

$machineEnd = Get-MachineSnapshot
$processesEnd = @(Get-ProcessSnapshot)
Write-CaptureFile -Name 'machine-end.json' -Content ($machineEnd | ConvertTo-Json -Depth 5)
Write-CaptureFile -Name 'processes-end.json' -Content ($processesEnd | ConvertTo-Json -Depth 4)
$deltas = @(Get-ProcessDeltas -Before $processes -After $processesEnd)
Write-CaptureFile -Name 'process-deltas.json' -Content ($deltas | ConvertTo-Json -Depth 4)
$findings = @(Get-ProcessFindings -Processes $processesEnd -Machine $machineEnd -Deltas $deltas)
Write-CaptureFile -Name 'findings.txt' -Content ($findings -join [Environment]::NewLine)

$volume = $null
try {
  $volume = New-Object System.IO.DriveInfo([IO.Path]::GetPathRoot($repoRoot))
} catch {
  Add-CaptureError -Area 'volume' -Message $_.Exception.Message
}
$storageFiles = New-Object System.Collections.Generic.List[object]
$appData = [Environment]::GetFolderPath('ApplicationData')
$storageRoots = @(
  (Join-Path $appData 'Code\User\globalStorage\glin.arc'),
  (Join-Path $appData 'Code - Insiders\User\globalStorage\glin.arc'),
  (Join-Path $appData 'Cursor\User\globalStorage\glin.arc')
)
foreach ($storageRoot in $storageRoots) {
  if (-not (Test-Path -LiteralPath $storageRoot -PathType Container)) { continue }
  foreach ($item in (Get-ChildItem -LiteralPath $storageRoot -File -Recurse -ErrorAction SilentlyContinue)) {
    $storageFiles.Add([pscustomobject]@{
      path = $item.FullName
      bytes = $item.Length
      lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
    })
  }
}

$userProfile = [Environment]::GetFolderPath('UserProfile')
$agentsViewDb = File-Metadata -Path (Join-Path $userProfile '.agentsview\sessions.db')
$repoBundle = File-Metadata -Path (Join-Path $repoRoot 'extension\dist\extension.js')
$installedBundles = New-Object System.Collections.Generic.List[object]
$extensionRoot = Join-Path $userProfile '.vscode\extensions'
if (Test-Path -LiteralPath $extensionRoot -PathType Container) {
  foreach ($directory in (Get-ChildItem -LiteralPath $extensionRoot -Directory -Filter 'glin.arc-*' `
      -ErrorAction SilentlyContinue)) {
    $bundlePath = Join-Path $directory.FullName 'dist\extension.js'
    $metadata = File-Metadata -Path $bundlePath
    if ($null -ne $metadata) {
      $hash = Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256 -ErrorAction SilentlyContinue
      $installedBundles.Add([pscustomobject]@{
        path = $metadata.path
        bytes = $metadata.bytes
        lastWriteTimeUtc = $metadata.lastWriteTimeUtc
        sha256 = if ($null -ne $hash) { $hash.Hash } else { $null }
      })
    }
  }
}

$repoBundleHash = $null
if ($null -ne $repoBundle) {
  $repoHash = Get-FileHash -LiteralPath $repoBundle.path -Algorithm SHA256 -ErrorAction SilentlyContinue
  if ($null -ne $repoHash) { $repoBundleHash = $repoHash.Hash }
}

$settingsLines = New-Object System.Collections.Generic.List[string]
foreach ($settingsPath in @(
  (Join-Path $appData 'Code\User\settings.json'),
  (Join-Path $appData 'Code - Insiders\User\settings.json'),
  (Join-Path $appData 'Cursor\User\settings.json')
)) {
  if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { continue }
  $matches = Select-String -LiteralPath $settingsPath -Pattern '"arc\.' -ErrorAction SilentlyContinue
  if ($null -ne $matches) {
    $settingsLines.Add($settingsPath)
    foreach ($match in $matches) { $settingsLines.Add($match.Line.Trim()) }
  }
}
Write-CaptureFile -Name 'panel-settings.txt' -Content ($settingsLines -join [Environment]::NewLine)

$arcHome = if ($env:ARC_HOME) { $env:ARC_HOME } else { Join-Path $userProfile '.arc' }
$diagnosticsLog = Read-Optional -Area 'diagnostics log' -Read {
  Copy-DiagnosticsLog -Directory (Join-Path $arcHome 'logs') -Destination (Join-Path $output 'diagnostics-log.jsonl') -WithheldDestination (Join-Path $output 'session-components-withheld.jsonl')
}

$manifest = [pscustomobject]@{
  capturedAtUtc = $capturedAt.ToUniversalTime().ToString('o')
  durationSeconds = [Math]::Max(0, ($Samples - 1) * $SampleIntervalSeconds)
  captureDurationSeconds = ((Get-Date) - $capturedAt).TotalSeconds
  computerName = [Environment]::MachineName
  osVersion = [Environment]::OSVersion.VersionString
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  platform = 'win32'
  windowsDiagnostics = 'enabled'
  captureTool = [pscustomobject]@{ path = $PSCommandPath; sha256 = $collectorHash }
  repoRoot = $repoRoot
  outputDirectory = $output
  scenario = $Scenario
  volume = if ($null -ne $volume) {
    [pscustomobject]@{
      name = $volume.Name
      format = $volume.DriveFormat
      totalBytes = $volume.TotalSize
      freeBytes = $volume.AvailableFreeSpace
    }
  } else { $null }
  repoBundle = if ($null -ne $repoBundle) {
    [pscustomobject]@{
      path = $repoBundle.path
      bytes = $repoBundle.bytes
      lastWriteTimeUtc = $repoBundle.lastWriteTimeUtc
      sha256 = $repoBundleHash
    }
  } else { $null }
  installedBundles = $installedBundles
  agentsViewDatabase = $agentsViewDb
  extensionStorageFiles = $storageFiles
  diagnosticsLog = $diagnosticsLog
  captureErrors = $captureErrors
}
Write-CaptureFile -Name 'manifest.json' -Content ($manifest | ConvertTo-Json -Depth 8)
Write-CaptureFile -Name 'capture-errors.txt' -Content ($captureErrors -join [Environment]::NewLine)

Write-Output "Diagnostics written to $output"
