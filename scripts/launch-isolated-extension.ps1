[CmdletBinding()]
param(
  [string]$Repository = (Split-Path $PSScriptRoot -Parent),
  [string]$Editor,
  [switch]$LiveData,
  [switch]$SkipBuild
)

# Builds Arc, then opens it through scripts/isolated-editor.mjs, which owns the profile, environment, and cleanup rules.
$repositoryPath = [System.IO.Path]::GetFullPath($Repository)
$extensionPath = Join-Path $repositoryPath 'extension'
$packagePath = Join-Path $extensionPath 'package.json'
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "Arc extension package not found at $packagePath"
}

if (-not $SkipBuild) {
  & npm --prefix $extensionPath run build
  if ($LASTEXITCODE -ne 0) { throw 'Arc extension build failed' }
}

$arguments = @(
  (Join-Path $PSScriptRoot 'isolated-editor.mjs'),
  'open',
  '--repository', $repositoryPath,
  '--workspace', $repositoryPath
)
if ($Editor) { $arguments += @('--editor', $Editor) }
if ($LiveData) { $arguments += '--live-data' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "The isolated editor run ended with code $LASTEXITCODE" }
