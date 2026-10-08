param(
    [switch]$Check,
    [ValidateRange(1024, 65500)]
    [int]$Port = 1420
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root ".tools"
$runtime = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"

function Resolve-Tool([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

try {
    $requirements = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
    $nodeCandidates = @(
        (Resolve-Tool "node.exe"),
        (Join-Path $tools "node-v24.9.0-win-x64\node.exe"),
        (Join-Path $runtime "node\bin\node.exe")
    )
    $node = $null
    foreach ($candidate in $nodeCandidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
        $versionText = & $candidate --version
        if ($LASTEXITCODE -ne 0) { continue }
        $version = [version]($versionText.Trim() -replace "^v", "")
        if ($version -ge [version]"24.9.0" -and $version.Major -eq 24) {
            $node = $candidate
            break
        }
    }
    if (-not $node) { throw "Node $($requirements.engines.node) is required. Install Node 24 or restore .tools\node-v24.9.0-win-x64." }
    $env:Path = "$(Split-Path -Parent $node);$env:Path"

    $localCargo = Join-Path $tools "cargo\bin\cargo.exe"
    if (Test-Path -LiteralPath $localCargo) {
        $env:CARGO_HOME = Join-Path $tools "cargo"
        if (Test-Path -LiteralPath (Join-Path $tools "rustup")) {
            $env:RUSTUP_HOME = Join-Path $tools "rustup"
        }
        $env:Path = "$(Split-Path -Parent $localCargo);$env:Path"
    } elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")) {
        $env:Path = "$(Join-Path $env:USERPROFILE '.cargo\bin');$env:Path"
    }
    $cargo = Resolve-Tool "cargo.exe"
    if (-not $cargo) { throw "Rust/Cargo is missing. Install the toolchain listed in rust-toolchain.toml." }

    $vsDevCmd = "C:\BuildTools\Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path -LiteralPath $vsDevCmd)) {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path -LiteralPath $vswhere) {
            $installation = & $vswhere -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($installation) { $vsDevCmd = Join-Path $installation "Common7\Tools\VsDevCmd.bat" }
        }
    }
    if (-not (Test-Path -LiteralPath $vsDevCmd)) {
        throw "Visual C++ Build Tools are missing. Install Desktop development with C++ and a Windows SDK."
    }
    $devEnv = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=amd64 -host_arch=amd64 >nul && set"
    if ($LASTEXITCODE -ne 0) { throw "Failed to initialize the Visual C++ build environment." }
    foreach ($line in $devEnv) {
        if ($line -match "^([^=]+)=(.*)$") {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
    $env:Path = "$(Split-Path -Parent $node);$env:Path"

    $pnpmCandidates = @(
        (Join-Path $tools "pnpm\pnpm.cmd"),
        (Resolve-Tool "pnpm.cmd"),
        (Join-Path $runtime "bin\fallback\pnpm.cmd")
    )
    $pnpm = $null
    foreach ($candidate in $pnpmCandidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
        $versionText = & $candidate --version
        if ($LASTEXITCODE -ne 0) { continue }
        $version = [version]$versionText.Trim()
        if ($version -ge [version]"11.19.0" -and $version.Major -eq 11) {
            $pnpm = $candidate
            break
        }
    }
    if (-not $pnpm) { throw "pnpm $($requirements.engines.pnpm) is required. Install $($requirements.packageManager)." }
    $env:Path = "$(Split-Path -Parent $pnpm);$env:Path"

    $tauriCli = Join-Path $root "apps\desktop\node_modules\@tauri-apps\cli\tauri.js"
    $viteCli = Join-Path $root "apps\desktop\node_modules\vite\bin\vite.js"
    if (-not (Test-Path -LiteralPath $tauriCli) -or -not (Test-Path -LiteralPath $viteCli)) {
        throw "Project dependencies are missing. Run pnpm install --frozen-lockfile in $root using Node 24."
    }

    Push-Location $root
    try {
        & $cargo --version
        if ($LASTEXITCODE -ne 0) { throw "Cargo cannot load the project toolchain. Check rust-toolchain.toml." }
        & rustc.exe --version
        if ($LASTEXITCODE -ne 0) { throw "The project's Rust toolchain is unavailable." }
        Write-Host "Node: $node"
        Write-Host "pnpm: $pnpm"
        Write-Host "Visual C++: $vsDevCmd"
        # Probe ports without terminating any existing server.
        $selectedPort = $null
        for ($candidatePort = $Port; $candidatePort -lt $Port + 20; $candidatePort++) {
            $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Any), $candidatePort
            try {
                $listener.Server.ExclusiveAddressUse = $true
                $listener.Start()
                $selectedPort = $candidatePort
                break
            } catch [System.Net.Sockets.SocketException] {
                continue
            } finally {
                $listener.Stop()
            }
        }
        if (-not $selectedPort) { throw "No free development port found. Retry with scripts\dev.ps1 -Port 1500." }
        Write-Host "Development URL: http://127.0.0.1:$selectedPort"
        if ($Check) {
            Write-Host "Development environment check passed."
            exit 0
        }

        $configDir = Join-Path $root ".tmp"
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        $configPath = Join-Path $configDir "start-dev-$PID.json"
        @{
            build = @{
                beforeDevCommand = "pnpm dev --host 127.0.0.1 --port $selectedPort"
                devUrl = "http://127.0.0.1:$selectedPort"
            }
        } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $configPath -Encoding ASCII
        Write-Host "Starting desktop app at http://127.0.0.1:$selectedPort"
        try {
            Push-Location (Join-Path $root "apps\desktop")
            try {
                & $node $tauriCli dev --config $configPath
                $result = $LASTEXITCODE
            } finally {
                Pop-Location
            }
        } finally {
            Remove-Item -LiteralPath $configPath -ErrorAction SilentlyContinue
        }
        exit $result
    } finally {
        Pop-Location
    }
} catch {
    Write-Host ""
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
