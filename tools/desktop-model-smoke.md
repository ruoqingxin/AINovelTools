# Desktop Model Acceptance

This optional Windows/WebView2 harness runs the actual Tauri editor, native IPC,
event bridge, HTTP gateway and SQLite. It is separate from the unit-test gates.
The default provider is a real loopback HTTP fixture, not an IPC mock or a cloud
model. The recovery harness shares `desktop-smoke-runtime.mjs`.

## Prerequisites And Local Run

Use the workspace's Node 24, pnpm and Rust toolchains, Microsoft WebView2 Runtime,
and an existing Playwright installation. From the workspace root:

```powershell
$config = (Resolve-Path tools/desktop-recovery.config.json).Path
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle --config $config
$env:PLAYWRIGHT_MODULE_PATH = "C:\path\to\node_modules\playwright"
pnpm test:desktop-model
```

`--app` selects a compatible built executable:

```powershell
node tools/desktop-model-smoke.mjs --app E:\AINovelTools\target\debug\ainoveltools-desktop.exe
```

The local run checks primary 503/fallback live preview, attempt-before-chunk
ordering, the audit record while the fallback is still running, successful
completion without automatically changing the manuscript, cancellation during
silent headers/body and an open stream, authentication without fallback, and
provider retry without counting it as a profile switch. Failed and cancelled
fallbacks retain attempt 2 and do not publish a candidate.

Gateway unit tests additionally cover fragmented Unicode, multiline SSE/CRLF,
heartbeats, usage, `[DONE]` on an open connection, JSON compatibility, length
limits, interruption, malformed input and body timeout classification. The
standard SSE parser discards events without a terminating blank line at EOF;
it does not synthesize a completed event from unfinished data.

## Optional Cloud Run

Cloud calls require explicit approval for possible paid usage and both flags:

```powershell
pnpm test:desktop-model --cloud-profile <configured-profile-UUID> --allow-cloud
```

Select an existing HTTPS chat profile with `ALLOW_CLOUD` privacy and a stored
credential. The harness reads only that profile's metadata from the original
settings database. It clones the metadata into isolated settings with output
capped at 2048 tokens (or the profile's smaller limit), timeout capped at 90
seconds and retry disabled. Original settings and credentials are not changed.

After the local scenarios, a successful full invocation makes two cloud
requests: loopback primary 503 followed by real cloud fallback, then a direct
cloud-configured in-flight cancellation. All prompts and manuscripts are
synthetic; no user novel is read. Cancellation is requested 500ms after the
started event or at the first prose chunk, whichever happens first. The result
records whether a prose chunk was received. A failed run may make fewer calls;
do not blindly rerun a paid test.

Cancellation acceptance proves the application terminates its pending request,
records `CANCELLED`, and creates no candidate. It does not prove the provider
received the request, acknowledged cancellation, stopped generating or stopped
billing. Reasoning may consume the output budget before prose appears; this
is a real length-limit outcome, not proof of successful stream cancellation.

## Isolation And Sensitive Artifacts

Each run creates `.tmp/p4-model-*`, with isolated application data, WebView2
profile and synthetic project. Loopback credentials use unique temporary
profile IDs; only those credentials are removed in `finally`. Processes and
connections started by this harness are cleaned up on success or failure.
Original projects, recent-project settings and original model secrets are
neither modified nor deleted.

Cloud mode uses the existing native OS credential. If an encrypted DPAPI
fallback file exists, the harness copies only the selected credential's
encrypted file into the isolated app-data directory. This file remains in the
artifacts and must be treated as sensitive even though it is encrypted. Never
share the entire artifact directory or commit it.

`result.json`, screenshots and process logs remain for inspection. The script
does not log Authorization headers or plaintext keys. Inspect artifacts before
sharing: cloud screenshots contain synthetic generated text and profile names.
Do not enable network tracing that captures credentials.

After acceptance, restore the normal visible-window binary:

```powershell
pnpm --filter @ainoveltools/desktop tauri build --debug --no-bundle
```

This is not an installer, native file-picker, power-loss, cross-platform or
exhaustive manual acceptance. Early fallback audit/event recording is covered
for writing; other AI workflows retain their existing fallback audit timing.
