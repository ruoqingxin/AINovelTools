# Desktop Backup Interruption Acceptance

Optional Windows/WebView2 acceptance using the built Tauri application, real
editor/IPC and maintenance worker. No cloud requests, user project/settings
access or product test hooks.

## Run

Use the workspace's Node 24, pnpm and Rust toolchains, installed WebView2 and
locally available Playwright. From the workspace root:

```powershell
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle
$env:PLAYWRIGHT_MODULE_PATH = "C:\path\to\node_modules\playwright"
pnpm test:desktop-backup-interruption
```

`--app` selects another compatible built binary. The normal visible-window
configuration is used, with isolated LOCALAPPDATA, APPDATA and WebView2 profile.
Running GUI processes and forcibly terminating the harness's own children
requires permission and an interactive desktop.

## Boundaries Exercised

The harness creates a fresh `.tmp/p4-backup-interruption-*` project, formal
revision, durable draft, recovery log, recovery file and 64MiB synthetic
attachment. Filesystem observation is armed before backup enqueueing.

1. At the staging attachment event, after SQLite online backup and before
   manifest/directory publication, terminate only this desktop process. The
   job must remain RUNNING and the final snapshot must not exist. On relaunch
   the same job must succeed with attempt 2 in fresh staging. The interrupted
   `.partial` stays unchanged and verified restore from it fails without
   creating its target.
2. At the next backup's staging attachment event, acquire an empty external
   SQLite write transaction. It does not modify any data and does not stop file
   copying, hashing, syncing or directory publication. After the final snapshot
   appears, kill the desktop while its success receipt is still blocked, then
   roll back the external transaction. The job must still be RUNNING and its
   published manifest/files must be complete and hash-valid. Relaunch must
   reconcile the same job with attempt 2 without rewriting any snapshot bytes.
3. Verify source manuscript/draft/base/version/recovery/index, both published
   snapshot trees, the stale partial tree and input file hashes. Run actual
   RESTORE_VERIFY from the second published backup, open the restored project,
   verify the saved revision, durable draft, recovery, attachments and integrity,
   and capture real editor/task screenshots.

The watcher captures actual paths/states, not assumed elapsed times. If the
required event arrives too late or the receipt lock cannot be acquired, the
run fails as inconclusive. A file's allocated size does not prove copying is
finished; this test claims a pre-publication boundary, not a specific copied
byte count. The second test injects writer contention, not a fake SQL result.
Partial restore rejection covers this manifest-less interrupted directory only;
it does not establish that every `.partial` path is rejected when its manifest
is already complete but directory rename has not occurred.

## Safety And Limits

Only newly generated projects under this run's directory are used. No prior
artifacts or user processes are deleted or stopped. The external write lock is
rolled back on success or failure. The fixture, profiles, process logs,
screenshots and result JSON remain local and are not committed. Allow roughly
400MiB of temporary disk space per run, including restored-project worker
replay; old runs accumulate.

Recovered backup recognition is read-only and requires a currently RUNNING
reclaimed job, matching job/project IDs and supported format/schema, complete
manifest file inventory and matching core/attachment hashes. Invalid snapshots
remain untouched and the job fails; completed jobs cannot republish over their
existing target. Recovery files retain the existing copy-only, unhashed format.

The restored snapshot contains historical RUNNING task state; opening it may
replay its backup task under existing startup recovery rules. The script does
not fabricate task states, alter the backup format or clean stale partials.

This is selected process-interruption evidence, not power loss, disk corruption,
arbitrary attachment concurrency, directory fsync guarantees, exactly-once
execution for all jobs, installer upgrades, signed release or clean-machine
WebView2 validation. Hashes establish byte consistency, not authenticity against
an adversary who can rewrite both files and manifests.
