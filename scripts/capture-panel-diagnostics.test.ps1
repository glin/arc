param([string]$ScriptPath = (Join-Path $PSScriptRoot 'capture-panel-diagnostics.ps1'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-ParentStatus', 'Get-ProcessDeltas', 'Get-ProcessFindings', 'Copy-DiagnosticsLog')) {
  $function = $tree.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if ($null -eq $function) { throw "Missing $name" }
  . ([scriptblock]::Create($function.Extent.Text))
}

$older = '2026-09-26T10:00:00Z'
$newer = '2026-09-26T11:00:00Z'
if ((Get-ParentStatus -Parent ([pscustomobject]@{startedUtc=$newer}) -Child ([pscustomobject]@{startedUtc=$older})) -ne 'pid-reused') { throw 'Reused parent PID was accepted' }
if ((Get-ParentStatus -Parent $null -Child ([pscustomobject]@{startedUtc=$older})) -ne 'exited') { throw 'Missing parent was accepted' }

$before = @([pscustomobject]@{id=7;name='find';startedUtc=$older;handles=10;gdi=1;user=1})
$after = @([pscustomobject]@{id=7;name='find';startedUtc=$newer;handles=100010;gdi=9001;user=9001})
if (@(Get-ProcessDeltas -Before $before -After $after).Count -ne 0) { throw 'PID reuse produced a delta' }
$after[0].startedUtc = $older
$after[0].gdi = $null
$after[0].user = $null
$delta = @(Get-ProcessDeltas -Before $before -After $after)
if ($delta.Count -ne 1 -or $delta[0].handles -ne 100000 -or $null -ne $delta[0].gdi) { throw 'Same-process delta or unavailable GUI value is wrong' }

$machine = [pscustomobject]@{gdiQuota=10000;userQuota=10000;commitUsedBytes=10;commitLimitBytes=100;logonSessions=1}
$unknown = [pscustomobject]@{id=7;name='find';path='C:\Program Files\Git\usr\bin\find.exe';parentStatus='exited';parentId=2;commandLine='find /';handles=100010;gdi=$null;user=$null}
$findings = @(Get-ProcessFindings -Processes @($unknown) -Machine $machine -Deltas $delta)
if (-not ($findings -match '100010 handles') -or -not ($findings -match 'parent PID 2 is exited') -or -not ($findings -match 'handles grew by 100000')) { throw 'Unknown process or orphan was missed' }
if ($findings -match 'quota') { throw 'Unavailable GUI count was treated as quota pressure' }
if (-not ($findings -match 'GUI readings unavailable')) { throw 'Unavailable GUI readings were hidden' }
$unknown.gdi = 9000
$findings = @(Get-ProcessFindings -Processes @($unknown) -Machine $machine -Deltas @())
if (-not ($findings -match 'gdi 9000 of 10000 quota')) { throw 'Quota threshold was missed' }
$machine.logonSessions = $null
$findings = @(Get-ProcessFindings -Processes @($unknown) -Machine $machine -Deltas @())
if (-not ($findings -match 'LSA logon session count unavailable')) { throw 'Unavailable LSA count was hidden' }

$explorerBefore = @([pscustomobject]@{id=9;name='explorer';startedUtc=$older;handles=100;gdi=8700;user=500})
$explorerAfter = @([pscustomobject]@{id=9;name='explorer';startedUtc=$older;handles=100;gdi=9100;user=9100;path='C:\Windows\explorer.exe';parentStatus='running';parentId=1;commandLine='explorer.exe'})
$growth = @(Get-ProcessDeltas -Before $explorerBefore -After $explorerAfter)
$findings = @(Get-ProcessFindings -Processes $explorerAfter -Machine $machine -Deltas $growth)
if (-not ($findings -match 'gdi objects grew by 400') -or -not ($findings -match 'user objects grew by 8600')) { throw 'Explorer graphics growth was missed' }
if (@($findings -match 'Restart Windows Explorer').Count -ne 1) { throw 'Explorer quota relief was absent or duplicated' }
$explorerAfter[0].startedUtc = $newer
$growth = @(Get-ProcessDeltas -Before $explorerBefore -After $explorerAfter)
$findings = @(Get-ProcessFindings -Processes $explorerAfter -Machine $machine -Deltas $growth)
if ($findings -match 'objects grew') { throw 'Explorer restart produced a graphics growth claim' }

$counterAssignment = $tree.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$counterPaths' }, $true) | Select-Object -First 1
$counterPaths = & ([scriptblock]::Create($counterAssignment.Right.Extent.Text))
if ($counterPaths -notcontains '\Processor(_Total)\% Processor Time') { throw 'Whole-machine CPU counter is absent' }

$logRoot = Join-Path ([IO.Path]::GetTempPath()) "arc-capture-log-$([guid]::NewGuid())"
$logs = New-Item -ItemType Directory -Path (Join-Path $logRoot 'logs')
try {
  # Each window writes its own log.
  $withheld = { param($id) "{`"event`":`"sessionComponentsWithheld`",`"pid`":$id}`n" }
  [IO.File]::WriteAllText((Join-Path $logs 'arc-20261027-090000-1.jsonl'), (& $withheld 1))
  [IO.File]::WriteAllText((Join-Path $logs 'arc-20261027-100000-2.jsonl'), "{`"event`":`"older`"}`n$(& $withheld 2)")
  [IO.File]::WriteAllText((Join-Path $logs 'arc-20261027-110000-3.jsonl'), "$(& $withheld 3){`"event`":`"last`"}`n")
  $copy = Join-Path $logRoot 'copy.jsonl'
  $withheldCopy = Join-Path $logRoot 'withheld.jsonl'
  $copied = Copy-DiagnosticsLog -Directory $logs -Destination $copy -WithheldDestination $withheldCopy -MaximumBytes 30 -MaximumWithheldBytes 92
  if ([IO.File]::ReadAllText($copy) -ne "{`"event`":`"last`"}`n" -or $copied.copiedBytes -ne 17 -or $copied.bytes -ne 63) { throw 'Diagnostics log tail is wrong' }
  if (-not $copied.path.EndsWith('arc-20261027-110000-3.jsonl')) { throw 'Diagnostics log copy missed the newest file' }
  if ([IO.File]::ReadAllText($withheldCopy) -ne ((& $withheld 2) + (& $withheld 3)) -or $copied.withheldLines -ne 2 -or $copied.withheldBytes -ne 92) { throw 'Withheld session tool lines are wrong' }
} finally {
  Remove-Item -LiteralPath $logRoot -Recurse -Force
}

'Diagnostics fixture checks passed.'
