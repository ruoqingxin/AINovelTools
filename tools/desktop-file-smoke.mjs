import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDesktopHarness, invoke, until, workspace } from "./desktop-smoke-runtime.mjs";

const { values } = parseArgs({ options: { app: { type: "string" } } });
const harness = await createDesktopHarness("p4-files", values.app);
const { artifacts, events, launch, stop, cleanup } = harness;
// Unicode and spaces exercise the real Windows picker and native path handling.
const projectName = "\u539f\u751f\u9009\u62e9 \u6d4b\u8bd5\u5de5\u7a0b";
const createTitle = "\u9009\u62e9\u5c0f\u8bf4\u5de5\u7a0b\u4f4d\u7f6e";
const openTitle = "\u6253\u5f00\u5c0f\u8bf4\u5de5\u7a0b";
const root = join(artifacts, projectName);
const invalidRoot = join(artifacts, "not-a-project");
let main;
let passed = false;

async function native(title, action, path) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(workspace, "tools/desktop-native-dialog.ps1"),
    "-ProcessId", String(main.child.pid), "-Title", title, "-Action", action];
  if (path) args.push("-Path", path);
  const result = await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, { windowsHide: true });
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(error || `Native helper exit ${code}`)));
  });
  const report = JSON.parse(result);
  assert.equal(report.processId, main.child.pid);
  assert.equal(report.action, action);
  events.push({ stage: "native-dialog", title, action, processId: report.processId });
  return report;
}

async function projectPage() {
  await main.page.goto(`${main.origin}/`);
  await main.page.reload();
  await main.page.getByRole("heading", { name: "\u5c0f\u8bf4\u5de5\u7a0b", exact: true }).waitFor();
}

const createButton = () => main.page.getByRole("button", { name: "\u65b0\u5efa\u5de5\u7a0b", exact: true });
const openButton = () => main.page.getByRole("button", { name: "\u6253\u5f00\u5de5\u7a0b", exact: true });

try {
  main = await launch("file-state");
  assert.equal(await invoke(main, "current_project"), null);
  await projectPage();
  for (const [button, title] of [[createButton, createTitle], [openButton, openTitle]]) {
    await button().click();
    await native(title, "Cancel");
    await until(() => button().isEnabled(), Boolean, "native cancellation unlocked actions");
    assert.equal(await invoke(main, "current_project"), null);
    assert.deepEqual(await invoke(main, "list_recent_projects"), []);
  }
  assert(!((await readdir(artifacts)).includes(projectName)));
  events.push({ stage: "cancel-no-project-or-recents" });

  await createButton().click();
  await native(createTitle, "Select", root);
  const manifest = await until(() => invoke(main, "current_project"), Boolean, "native project creation");
  assert.equal(manifest.name, projectName);
  const diskManifest = JSON.parse(await readFile(join(root, "project.json"), "utf8"));
  assert.equal(diskManifest.projectId, manifest.projectId);
  await until(() => createButton().isEnabled(), Boolean, "creation unlocked actions");
  events.push({ stage: "native-created", projectId: manifest.projectId, root });

  await mkdir(invalidRoot);
  await openButton().click();
  await native(openTitle, "Select", invalidRoot);
  await main.page.getByRole("alert").waitFor();
  assert.equal((await invoke(main, "current_project")).projectId, manifest.projectId);
  await until(() => openButton().isEnabled(), Boolean, "invalid selection unlocked actions");
  await main.page.screenshot({ path: join(artifacts, "invalid-folder.png"), fullPage: true });
  events.push({ stage: "invalid-folder-preserved-current-project" });

  await openButton().click();
  await native(openTitle, "Cancel");
  await until(() => openButton().isEnabled(), Boolean, "cancel with active project");
  assert.equal((await invoke(main, "current_project")).projectId, manifest.projectId);

  await invoke(main, "close_project");
  await projectPage();
  await openButton().click();
  await native(openTitle, "Select", root);
  await until(() => invoke(main, "current_project"), (p) => p?.projectId === manifest.projectId, "native reopen");
  const chapter = await invoke(main, "create_plan_node", { parentId: null, kind: "CHAPTER", title: "Installed acceptance chapter" });
  await main.page.goto(`${main.origin}/writing#${chapter.id}`);
  await main.page.reload();
  const editor = main.page.locator(".creation-edit-panel .tiptap-editor[contenteditable=true]");
  await editor.waitFor();
  await editor.fill("Synthetic installed application manuscript.");
  await main.page.getByRole("button", { name: "\u4fdd\u5b58\u6b63\u6587", exact: true }).click();
  const revision = await until(() => invoke(main, "current_manuscript", { chapterId: chapter.id }), Boolean, "installed editor save");
  await main.page.screenshot({ path: join(artifacts, "native-opened-editor.png"), fullPage: true });
  await stop(main);
  main = await launch("file-state");
  await until(() => invoke(main, "current_project"), (p) => p?.projectId === manifest.projectId, "installed recent-project restoration");
  assert.equal((await invoke(main, "current_manuscript", { chapterId: chapter.id })).id, revision.id);
  assert.equal((await invoke(main, "list_recent_projects")).length, 1);
  events.push({ stage: "native-reopen-save-relaunch", projectId: manifest.projectId, revisionId: revision.id });
  for (const instance of harness.instances) assert.deepEqual(instance.pageErrors, []);
  passed = true;
} catch (error) {
  events.push({ stage: "failed", error: String(error) });
  if (main?.page && !main.page.isClosed()) {
    await main.page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await cleanup();
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed, root, events }, null, 2));
  console.log(`Native file acceptance ${passed ? "passed" : "failed"}: ${artifacts}`);
}
