# Native File And Installation Acceptance

These optional Windows tests use real Tauri/WebView2, native file dialogs and
the actual NSIS installer. No dialog return values or IPC responses are mocked.
They use synthetic projects and isolated application settings, never cloud
models or production credentials.

## Prerequisites

- The workspace's Node 24, pnpm and Rust toolchains.
- An interactive Windows desktop, Windows PowerShell and WebView2 Runtime.
- An existing Playwright installation. Set `PLAYWRIGHT_MODULE_PATH` to its
  module directory if it is not resolvable from the workspace.
- Explicit execution approval for launching GUI processes, installing and
  uninstalling. Close existing application instances first; the installer
  harness refuses to terminate them.

## Build And Run

From the workspace root, build a separately named, per-user debug NSIS package:

```powershell
$config = (Resolve-Path tools/desktop-install.config.json).Path
pnpm --filter @ainoveltools/desktop tauri build --debug --bundles nsis --config $config
$env:PLAYWRIGHT_MODULE_PATH = "C:\path\to\node_modules\playwright"
pnpm test:desktop-install -AllowInstall
```

The override uses product `AI Novel Tools Acceptance` and identifier
`com.ainoveltools.acceptance`. It does not change the production configuration.
The build may download NSIS and Tauri's installer plugin into its tool cache.
The test requires the named setup executable's acceptance product metadata.
`-Installer` can select another copy of that same named setup inside the
workspace, but its payload must match the current acceptance build.

Run acceptance before rebuilding the normal executable. Tauri's NSIS payload
has its bundle-type tag changed from `UNK` to `NSS`; the binary comparison models
only that single tag change and checks every other byte via SHA-256. If the
build artifact is missing, ambiguous or stale, rebuild instead of bypassing
the check. This comparison is not a digital signature or authenticity check.

For native file-dialog acceptance without installation:

```powershell
pnpm test:desktop-files
pnpm test:desktop-files --app E:\AINovelTools\path\to\ainoveltools-desktop.exe
```

This requires a visible-window executable. The earlier hidden recovery
override is not the configuration used for native file acceptance.

## Coverage

- Real new-project save picker and existing-project folder picker.
- Cancel while no project is open, without creating a project or recent entry.
- Create and reopen a project whose path contains Chinese characters and spaces.
- Invalid selected folder reports an error and preserves the current project.
- Cancel with an active project, save through the actual editor and relaunch
  with the same saved revision and restored recent project.
- Install to this run's `.tmp/p4-install-*/installed application` directory.
- Verify per-user uninstall metadata and actual shortcut targets.
- Run native file acceptance and the three-chapter/two-instance/export/backup/
  restore recovery harness against the installed executable.
- Uninstall and verify that the application, uninstaller, shortcuts and
  uninstall entry are removed.
- Compare six manifest/database hashes across the three external synthetic
  projects before and after uninstall.
- Verify the selected production installer registry entries remain unchanged.

The native helper matches only the launched process ID, exact dialog title and
standard Windows dialog class. It uses Win32 controls rather than a keyboard
sequence that could target another application. It can bring this test's dialog
to the foreground, so these tests are not headless or suitable for a locked
desktop. Selection paths are restricted to this workspace.

Chapter creation and some recovery steps use real IPC; file selection and
editor saving use actual UI controls. This does not claim every step was manual.

## Isolation And Cleanup

The harness rejects pre-existing acceptance registration/shortcuts, external
installer paths and a redirected `.tmp` directory. Installation is into a
new checked run directory. The installer creates separately named current-user
registry entries and shortcuts, which are real OS changes despite isolated
application data.

Uninstall runs a copy of this run's own uninstaller, with the checked install
directory. Ordinary NSIS uninstall retains a remembered install-location key;
the harness removes only its separately named test key after checking its value.
It never removes the shared manufacturer key or a production product key.
Application settings and WebView2 data are isolated by the existing desktop
harness, and all projects are outside the install directory.

Cleanup runs on failure too. A cleanup failure is recorded and makes acceptance
fail. Do not run the harness again over leftover registration: inspect the
failed result and resolve that test installation first. Projects, process logs,
screenshots, the setup executable and result records remain for inspection;
they are local artifacts, not source files to commit.

The five `test:desktop-acceptance-tools` tests check opt-in/path/executable guards
and PowerShell syntax without launching dialogs or installing. Root `check` and
`test` include them. They are skipped on non-Windows hosts.

## Restore And Limits

After acceptance, restore the normal visible-window build:

```powershell
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle
```

This verifies a separately identified debug NSIS package on a machine that
already has WebView2. It is not release signing, SmartScreen, MSI, machine-wide
installation, an upgrade/downgrade, a clean-machine WebView2 bootstrap test,
offline distribution, power-loss or cross-platform acceptance. Rebuilding the
normal app does not regenerate the acceptance package.
