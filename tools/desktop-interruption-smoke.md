# Desktop Interruption Acceptance

Optional Windows/WebView2 acceptance against the actual Tauri binary and real
IPC. It calls no cloud models, reads no user projects or settings, and injects
SQL delays only into the synthetic project created by the current run.

## Run

Use Node 24 and locally available Playwright as in
`desktop-recovery-smoke.md`. From the workspace root:

```powershell
$config = (Resolve-Path tools/desktop-recovery.config.json).Path
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle --config $config
$env:PLAYWRIGHT_MODULE_PATH = "C:\path\to\node_modules\playwright"
pnpm test:desktop-interruption
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle
```

The last command restores the normal visible-window binary. `--app` can select
another compatible binary. GUI execution requires an interactive desktop and
permission to start and forcibly terminate only the harness's own processes.

## Evidence

- An existing formal revision and durable local draft are created through the
  real editor. New UI input is followed immediately by forced process exit.
  The clock starts before input and must show actual process exit within the
  800ms debounce window; an inconclusive timing fails, rather than counting as
  success. The old durable draft returns on relaunch; the new input is expected
  to be lost because it was never committed.
- A target draft is saved first. A synthetic `AFTER DELETE recovery_logs`
  trigger holds the real formal-save transaction after revision insertion and
  draft clearing. With no jobs queued, the saving UI and a sustained external
  SQLite writer lock witness the in-flight save. The process is killed while
  still locked. Revision, draft/version/base, recovery and index snapshots must
  remain exactly unchanged, with SQLite integrity and foreign keys valid.
  After dropping the gate and relaunching, one UI retry creates exactly one new
  revision, clears the draft and recovery, and indexes the revision once.
- An actual `REBUILD_SEARCH_INDEX` worker claims a queued job. An
  `AFTER UPDATE jobs` gate delays its SUCCEEDED receipt, after the operation
  itself has completed. The durable job must remain RUNNING, attempt 1, under a
  sustained writer lock. Forced exit, gate removal and relaunch must finish the
  same job with attempt 2, without changing manuscript/index contents.

The delay gates use bounded recursive SQL, not production hooks or fabricated
IPC results. The external probe immediately rolls back any lock it acquires.
The gates are removed after the process exits and before relaunch. On failure,
the synthetic project may retain a gate; do not open that disposable failed
project as a normal working project. Do not reuse the harness against user
databases.

## Boundaries

Results, screenshots, isolated profiles and process logs remain under a fresh
`.tmp/p4-interruption-*`. Only the child processes started by this run are
terminated; old runs are not deleted. Ordinary check/test runs execute four
small non-GUI SQLite helper tests, never this desktop acceptance.

This is process-death evidence at selected, SQL-delayed commit boundaries, not
arbitrary timing, power loss or a promise of zero input loss. It does not cover
backup file-copy/publication interruption, pending AI candidates, cloud partial
prose cancellation, task cancellation recovery, manual inspection of every
workflow, installer upgrades, signing or other platforms.
