param(
    [string]$Installer,
    [switch]$AllowInstall
)

$ErrorActionPreference = "Stop"
if (-not $AllowInstall) { throw "Installation acceptance requires -AllowInstall and explicit execution approval." }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $Installer) {
    $Installer = Join-Path $workspace "target\debug\bundle\nsis\AI Novel Tools Acceptance_0.1.0_x64-setup.exe"
}
$Installer = [IO.Path]::GetFullPath($Installer)
if (-not $Installer.StartsWith($workspace + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installer must be inside this workspace."
}
if ([IO.Path]::GetFileName($Installer) -ne "AI Novel Tools Acceptance_0.1.0_x64-setup.exe") {
    throw "Only the named NSIS acceptance setup executable is allowed."
}
if ((Get-Item -LiteralPath $Installer).VersionInfo.ProductName -ne "AI Novel Tools Acceptance") {
    throw "Only the separately named acceptance installer is allowed."
}
if (Get-Process -Name "ainoveltools-desktop" -ErrorAction SilentlyContinue) {
    throw "Close existing desktop instances before installer acceptance; this script will not terminate them."
}

$product = "AI Novel Tools Acceptance"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$productKey = "HKCU:\Software\ainoveltools\$product"
$machineKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath("DesktopDirectory")) "$product.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "$product.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "$product\$product.lnk")
)
foreach ($existing in @($uninstallKey, $productKey, $machineKey) + $shortcuts) {
    if (Test-Path -LiteralPath $existing) { throw "Acceptance registration or shortcut already exists: $existing" }
}

function Production-Registration {
    $records = @()
    foreach ($key in @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Novel Tools",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Novel Tools",
        "HKCU:\Software\ainoveltools\AI Novel Tools"
    )) {
        if (Test-Path -LiteralPath $key) {
            $item = Get-Item -LiteralPath $key
            $values = [ordered]@{}
            foreach ($name in @($item.GetValueNames() | Sort-Object)) { $values[$name] = $item.GetValue($name) }
            $records += @{ key = $key; values = $values }
        } else { $records += @{ key = $key; absent = $true } }
    }
    return ConvertTo-Json -InputObject $records -Depth 6 -Compress
}
function Run-Installer([string]$executable, [string]$arguments) {
    $child = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $child.WaitForExit(120000)) {
        $child.Kill()
        throw "Timed out waiting for this acceptance installer process."
    }
    if ($child.ExitCode -ne 0) { throw "Installer exit code: $($child.ExitCode)" }
}
function File-Sha256([string]$path) {
    $stream = [IO.File]::OpenRead($path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "")
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}
function Expected-NsisHash([string]$path) {
    # Tauri packages a copy tagged NSS, then restores the build artifact to UNK.
    # Model exactly that one tag change; every other payload byte must match.
    $bytes = [IO.File]::ReadAllBytes($path)
    $marker = "__TAURI_BUNDLE_TYPE_VAR_UNK"
    $text = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $offset = $text.IndexOf($marker, [StringComparison]::Ordinal)
    if ($offset -lt 0 -or $offset -ne $text.LastIndexOf($marker, [StringComparison]::Ordinal)) {
        throw "Expected exactly one unbundled Tauri tag; rebuild acceptance before testing."
    }
    $replacement = [Text.Encoding]::ASCII.GetBytes("__TAURI_BUNDLE_TYPE_VAR_NSS")
    [Buffer]::BlockCopy($replacement, 0, $bytes, $offset, $replacement.Length)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace("-", "") }
    finally { $algorithm.Dispose() }
}

$beforeRegistration = Production-Registration
$temporaryRoot = Join-Path $workspace ".tmp"
if ((Test-Path -LiteralPath $temporaryRoot) -and
    ((Get-Item -LiteralPath $temporaryRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing an acceptance installation under a redirected .tmp directory."
}
$artifacts = Join-Path $workspace (".tmp\p4-install-" + [Guid]::NewGuid().ToString("N"))
$installRoot = [IO.Path]::GetFullPath((Join-Path $artifacts "installed application"))
if (-not $installRoot.StartsWith($artifacts + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved installation directory escaped this run's workspace."
}
$null = New-Item -ItemType Directory -Path $artifacts
$app = Join-Path $installRoot "ainoveltools-desktop.exe"
$uninstaller = Join-Path $installRoot "uninstall.exe"
$runner = Join-Path $artifacts "uninstall-runner.exe"
$events = [Collections.Generic.List[object]]::new()
$passed = $false
$installed = $false
$failure = $null
$fileResult = $null
$projectHashes = @()
$originalLocation = Get-Location

try {
    Set-Location -LiteralPath $workspace
    # /D is deliberately the final, unquoted NSIS argument so spaces remain
    # part of the destination. The root has already been checked above.
    Run-Installer $Installer "/S /D=$installRoot"
    $installed = Test-Path -LiteralPath $uninstaller
    if (-not (Test-Path -LiteralPath $app) -or -not $installed) { throw "Installer did not publish the expected files." }
    if (-not (Test-Path -LiteralPath $uninstallKey)) { throw "Per-user uninstall registration is missing." }
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.InstallLocation.Trim('"') -ne $installRoot) { throw "Unexpected registered installation directory." }
    if ($registration.DisplayName -ne $product -or $registration.DisplayVersion -ne "0.1.0") {
        throw "Unexpected installer product registration."
    }
    $installedHash = File-Sha256 $app
    if ($installedHash -ne (Expected-NsisHash (Join-Path $workspace "target\debug\ainoveltools-desktop.exe"))) {
        throw "Installed binary does not match the acceptance build."
    }
    $createdShortcuts = @($shortcuts | Where-Object { Test-Path -LiteralPath $_ })
    if ($createdShortcuts.Count -eq 0) { throw "No acceptance shortcut was created." }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcut in $createdShortcuts) {
        if ($shell.CreateShortcut($shortcut).TargetPath -ne $app) { throw "Acceptance shortcut points to an unexpected executable." }
    }
    $events.Add(@{ stage = "installed"; installRoot = $installRoot; binarySha256 = $installedHash; shortcuts = $createdShortcuts })

    $node = (Get-Command node -ErrorAction Stop).Source
    $output = @(& $node (Join-Path $PSScriptRoot "desktop-file-smoke.mjs") --app $app)
    $output | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "Installed native-file acceptance failed." }
    $line = $output | Where-Object { $_ -like "Native file acceptance passed: *" } | Select-Object -Last 1
    if (-not $line) { throw "Native acceptance result path is missing." }
    $fileResultPath = Join-Path $line.Substring("Native file acceptance passed: ".Length) "result.json"
    $fileResult = Get-Content -LiteralPath $fileResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $fileResult.passed) { throw "Native acceptance result did not pass." }
    $events.Add(@{ stage = "installed-native-files"; result = $fileResultPath })

    $output = @(& $node (Join-Path $PSScriptRoot "desktop-recovery-smoke.mjs") --app $app)
    $output | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "Installed recovery acceptance failed." }
    $line = $output | Where-Object { $_ -like "Real Tauri recovery acceptance passed: *" } | Select-Object -Last 1
    if (-not $line) { throw "Recovery acceptance result path is missing." }
    $recoveryArtifacts = $line.Substring("Real Tauri recovery acceptance passed: ".Length)
    $recoveryResultPath = Join-Path $recoveryArtifacts "result.json"
    $recoveryResult = Get-Content -LiteralPath $recoveryResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $recoveryResult.passed) { throw "Recovery acceptance result did not pass." }
    $events.Add(@{ stage = "installed-recovery"; result = $recoveryResultPath })
    foreach ($project in @($fileResult.root, (Join-Path $recoveryArtifacts "original"), (Join-Path $recoveryArtifacts "restored"))) {
        foreach ($file in @("project.json", "project.sqlite")) {
            $path = Join-Path $project $file
            $projectHashes += @{ path = $path; sha256 = (File-Sha256 $path) }
        }
    }
    $passed = $true
} catch {
    $failure = $_
    $events.Add(@{ stage = "failed"; error = $_.ToString() })
} finally {
    try {
        if (Test-Path -LiteralPath $uninstaller) {
            # Running a checked copy outside INSTDIR lets NSIS remove the original.
            Copy-Item -LiteralPath $uninstaller -Destination $runner
            Run-Installer $runner "/S _?=$installRoot"
            if ((Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $uninstaller) -or (Test-Path -LiteralPath $uninstallKey)) {
                throw "Acceptance uninstall left application files or uninstall registration."
            }
            foreach ($shortcut in $shortcuts) {
                if (Test-Path -LiteralPath $shortcut) { throw "Acceptance uninstall left a shortcut." }
            }
            # NSIS deliberately keeps the remembered location on ordinary
            # uninstall. Remove only this run's separately named test key.
            if (Test-Path -LiteralPath $productKey) {
                $location = (Get-Item -LiteralPath $productKey).GetValue("")
                if ($location -ne $installRoot) { throw "Refusing to clean an unexpected acceptance registry location." }
                Remove-Item -LiteralPath $productKey -Recurse
            }
            $events.Add(@{ stage = "uninstalled"; testRegistryLocationRemoved = $true })
        }
        if ((Production-Registration) -ne $beforeRegistration) { throw "Production installation registration changed." }
        foreach ($file in $projectHashes) {
            if ((File-Sha256 $file.path) -ne $file.sha256) {
                throw "Uninstall changed an external synthetic project file."
            }
        }
        if ($fileResult) {
            $preserved = Get-Content -LiteralPath (Join-Path $fileResult.root "project.json") -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $preserved.projectId -or -not (Test-Path -LiteralPath (Join-Path $fileResult.root "project.sqlite"))) {
                throw "Uninstall did not preserve the external synthetic project."
            }
            $events.Add(@{ stage = "external-projects-preserved"; verifiedFileHashes = $projectHashes.Count; root = $fileResult.root })
        }
    } catch {
        $passed = $false
        $events.Add(@{ stage = "cleanup-failed"; error = $_.ToString() })
        if (-not $failure) { $failure = $_ }
    }
    Set-Location -LiteralPath $originalLocation
    $result = @{ passed = $passed; installer = $Installer; installed = $installed; events = @($events.ToArray()) }
    [IO.File]::WriteAllText((Join-Path $artifacts "result.json"), ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Write-Host "Installation acceptance artifacts: $artifacts"
}
if ($failure) { throw $failure }
