$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root ".tools"
$nodeDir = Join-Path $tools "node-v24.9.0-win-x64"
$pnpmDir = Join-Path $tools "pnpm"
$vsDevCmd = "C:\BuildTools\Common7\Tools\VsDevCmd.bat"

foreach ($path in @(
    (Join-Path $tools "cargo\bin"),
    $nodeDir,
    $pnpmDir
)) {
    if (-not (Test-Path $path)) {
        throw "Missing development tool directory: $path"
    }
}

if (-not (Test-Path $vsDevCmd)) {
    throw "Missing Visual C++ build environment: $vsDevCmd"
}

$devEnv = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=amd64 -host_arch=amd64 >nul && set"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to initialize the Visual C++ build environment."
}

foreach ($line in $devEnv) {
    if ($line -match "^([^=]+)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}

$env:CARGO_HOME = Join-Path $tools "cargo"
$env:RUSTUP_HOME = Join-Path $tools "rustup"
$env:PNPM_STORE_DIR = Join-Path $tools "pnpm-store"
$env:Path = "$(Join-Path $tools 'cargo\bin');$nodeDir;$pnpmDir;$env:Path"

Push-Location $root
try {
    & (Join-Path $pnpmDir "pnpm.cmd") dev
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
