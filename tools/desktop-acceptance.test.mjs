import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workspace } from "./desktop-smoke-runtime.mjs";

const windows = { skip: process.platform !== "win32" };
function run(script, args) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(workspace, "tools", script), ...args,
  ], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.ifError(result.error);
  return result;
}
function rejected(args, message) {
  const runs = () => existsSync(join(workspace, ".tmp"))
    ? readdirSync(join(workspace, ".tmp")).filter((name) => name.startsWith("p4-install-")) : [];
  const before = runs();
  const result = run("desktop-install-smoke.ps1", args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  const after = runs();
  assert.deepEqual(after, before, "guard rejection must not create an installation run");
}

test("installation acceptance requires explicit opt-in", windows, () => {
  rejected([], /requires -AllowInstall/);
});
test("installation acceptance rejects an installer outside the workspace", windows, () => {
  rejected(["-AllowInstall", "-Installer", "C:\\Windows\\not-an-installer.exe"], /inside this workspace/);
});
test("installation acceptance rejects ordinary executables before starting them", windows, () => {
  rejected(["-AllowInstall", "-Installer", join(workspace, "target/debug/ainoveltools-desktop.exe")], /Only the named NSIS/);
});
test("native helper rejects selecting a path outside the workspace", windows, () => {
  const result = run("desktop-native-dialog.ps1", [
    "-ProcessId", String(process.pid), "-Title", "Acceptance guard test", "-Action", "Select", "-Path", "C:\\outside-test-project",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /selection must remain inside/);
});
test("acceptance PowerShell scripts parse without syntax errors", windows, () => {
  const script = ["desktop-native-dialog.ps1", "desktop-install-smoke.ps1"].map((name) => {
    const path = join(workspace, "tools", name).replaceAll("'", "''");
    return `$errors=$null; $tokens=$null; [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw ($errors | Out-String) }`;
  }).join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
