# Desktop Display Scale Acceptance

Uses the actual Tauri/WebView2 runtime, isolated settings and disposable projects.
No cloud model calls or user projects are used.

Build a hidden acceptance application as described in `desktop-recovery-smoke.md`,
then run from the workspace root:

```powershell
$env:PLAYWRIGHT_MODULE_PATH = "C:\path\to\node_modules\playwright"
node tools/desktop-scale-smoke.mjs
```

`--app` selects a compatible built executable. Artifacts are retained in
`.tmp/desktop-scale-*`; only processes created by this run are terminated.
After testing, rebuild without the hidden-window configuration.

The isolated browser process receives `--force-device-scale-factor=1.5` or `2`.
The harness asserts the measured WebView2 `devicePixelRatio`, viewport reflow,
modal boundaries, horizontal overflow and critical controls' hit-test reachability.
It does not modify Windows display settings. This covers display-scale rendering
and reduced available layout dimensions, not a manual multi-monitor DPI transition
or every Windows window-frame and monitor work-area configuration.

Coverage includes a real editor save, nested chapter-abandonment confirmation,
cancelled and approved settings switching, writing, planning, materials, discussion,
review, background jobs and all settings categories. Migrated actions must not call
the browser's native confirmation.

The desktop window also adapts its minimum and oversized dimensions to the
current monitor's work area at startup and on a DPI change. Seven Rust unit tests
cover the sizing calculations, frame/taskbar space, retaining a previously small
window, negative monitor coordinates and unavailable metrics. Those tests do not
replace a real Windows display-setting or multi-monitor transition test.
