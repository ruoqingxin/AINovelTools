# UI Scope

- Prioritize the desktop application. Do not proactively add mobile layouts, mobile-specific interactions, or phone viewport verification unless the user explicitly requests mobile support.
- Evaluate layout and usability changes on desktop viewport sizes. Preserve existing mobile behavior where practical, but do not expand the task to improve it.

# Test Scope

- Match verification to the changed behavior. Do not run every suite after every small iteration.
- Frontend-only changes: use `pnpm test:ui:changed` or explicit affected files with `pnpm test:ui src/views/example.test.tsx`. Run the desktop TypeScript check when types or components change.
- `test:ui:changed` uses changes since `HEAD`, including staged, unstaged and untracked files. A clean worktree selects no tests; that is not a full pass. For committed work use explicit files or pass a suitable base with `pnpm --filter @ainoveltools/desktop exec vitest run --changed <base>`.
- Changes to package manifests, Vitest configuration or other global triggers may intentionally select the entire frontend suite.
- Frontend dependency selection does not verify Rust, database migrations, native IPC registration, test tools or native platform behavior. Shared styles and runtime-only links may require explicit related tests and a visual check.
- Rust changes: run the affected crate/module with `cargo test -p <crate> <module-filter>`. Expand coverage for shared storage, migrations, project switching, cancellation, publication and other data-integrity changes.
- Run `pnpm check:ipc` when native command arguments, registration, serialization or generated IPC types change.
- Run tool tests when those tools or their fixtures change. Installer, recovery, interruption and model-evaluation suites are not required for unrelated UI changes.
- Run an appropriate browser/native smoke test when changing a user workflow. Do not repeat the entire historical smoke matrix for each intermediate edit.
- Preserve `pnpm test` as the full automated regression gate for releases, broad changes or uncertain impact. Native/installer smoke tests remain separate opt-in checks.
- Reuse or extend existing cases before adding tests. Remove a case only when its assertions are obsolete or retained elsewhere. Do not delete data-loss, stale-result, authorization or cross-project protections to reduce counts.
- Report what actually ran and what did not. Automated/loopback tests do not prove model semantic quality. Do not run paid model evaluations without explicit authorization.
