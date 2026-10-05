[CmdletBinding()]
param(
  [string]$Repository = (Split-Path $PSScriptRoot -Parent),
  [string]$CodeCommand = 'code',
  [switch]$SkipBuild
)

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

$runRoot = Join-Path $env:TEMP ("arc-vscode-test-" + [guid]::NewGuid().ToString('N'))
$userData = Join-Path $runRoot 'user-data'
$extensions = Join-Path $runRoot 'extensions'
New-Item -ItemType Directory -Path $userData, $extensions | Out-Null

Write-Output "VS Code user data: $userData"
Write-Output "VS Code extensions: $extensions"

$arguments = @(
  '--new-window',
  '--user-data-dir', $userData,
  '--extensions-dir', $extensions,
  '--extensionDevelopmentPath', $extensionPath,
  $repositoryPath
)
& $CodeCommand @arguments
if ($LASTEXITCODE -ne 0) { throw "VS Code exited with code $LASTEXITCODE" }
