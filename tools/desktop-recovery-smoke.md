# Desktop Recovery Acceptance

This optional Windows/WebView2 harness uses the actual built Tauri application
and real IPC. It does not mock commands or call cloud models.

## Prerequisites

- The workspace's Node, pnpm and Rust toolchains.
- Microsoft WebView2 Runtime.
- Playwright, provided by an existing local installation. Set
  `PLAYWRIGHT_MODULE_PATH` to that package directory if it is not resolvable from
  the workspace. It is not a new application dependency.

Build an isolated acceptance binary with hidden windows, then run the harness:

```powershell
$config = (Resolve-Path tools/desktop-recovery.config.json).Path
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle --config $config
$env:PLAYWRIGHT_MODULE_PATH = "C:\path\to\node_modules\playwright"
pnpm test:desktop-recovery
```

Run these commands from the workspace root. `--app` can select another compatible binary:

```powershell
node tools/desktop-recovery-smoke.mjs --app E:\AINovelTools\target\debug\ainoveltools-desktop.exe
```

## Coverage

- Three chapters saved through the real editor, with a second saved revision.
- Durable local drafts, a conflict from a second desktop instance, and UI
  preservation of the conflict content as a recovery copy before rereading.
- Shared modal confirmation cancellation for rereading and saved-only export,
  including default cancel focus.
- Dark appearance applied through the UI and retained across desktop restart.
- TXT export through the UI and Markdown through IPC, checked against actual
  files and saved revisions rather than drafts.
- Backup and verified restore executed by the actual maintenance worker.
- Forced termination and relaunch, including recent-project restoration, crash
  marker, original revision, draft version/base and recovery records.
- Restored project revision IDs, draft contents/version, history and integrity.

Project/tree creation and maintenance enqueueing use real IPC to avoid native
file dialogs. Editor save, conflict recovery and TXT export use UI controls.
These distinctions are recorded rather than claiming every step was a manual
UI workflow.

## Isolation And Artifacts

Each run creates a fresh `.tmp/p4-desktop-*` directory. Child processes receive
isolated `LOCALAPPDATA`, `APPDATA` and WebView2 profiles. A second instance uses
another profile and opens only this run's test project. No production recent
project, model settings or secrets are read or changed.

Loopback-only debugging uses a fresh port per instance. The harness terminates
only processes it launched, including on failure; it leaves test projects,
screenshots, process logs and `result.json` for inspection. It does not delete
previous runs. The harness is intentionally separate from ordinary unit-test
gates because it starts a desktop runtime and terminates its own processes.

After acceptance, build without the override or run `start-dev.cmd` to return to
the application's normal visible-window configuration. The override is only
for the acceptance build.

This is not a cloud-model, installer, power-loss or single-process multiwindow
test. A second desktop instance exercises actual independent SQLite writers.
