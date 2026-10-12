import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Optional Windows acceptance harness. It uses real IPC, isolated app settings
// and disposable projects; it never loads the user's recent projects or models.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { app: { type: "string" } } });
const executable = resolve(values.app ?? join(workspace, "target/debug/ainoveltools-desktop.exe"));
if (process.platform !== "win32") throw new Error("This harness requires Windows/WebView2.");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
await mkdir(join(workspace, ".tmp"), { recursive: true });
const artifacts = await mkdtemp(join(workspace, ".tmp/p4-desktop-"));
const projectRoot = join(artifacts, "original");
const restoredRoot = join(artifacts, "restored");
const instances = [];
const events = [];

async function until(read, predicate, label, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function launch(name) {
  const state = join(artifacts, name);
  await mkdir(state, { recursive: true });
  const port = await freePort();
  const child = spawn(executable, [], {
    cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOCALAPPDATA: state, APPDATA: state,
      WEBVIEW2_USER_DATA_FOLDER: join(state, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
  });
  const instance = { child, log: "", pageErrors: [], browser: null, acceptConfirm: true, confirmations: [] };
  instances.push(instance);
  child.on("error", (error) => { instance.log += error.stack; });
  child.stdout.on("data", (data) => { instance.log += data; });
  child.stderr.on("data", (data) => { instance.log += data; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${instance.log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    } catch { return false; }
  }, Boolean, "WebView2 debugging endpoint");
  instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  instance.page = await until(() => Promise.resolve(instance.browser.contexts().flatMap((c) => c.pages())[0]), Boolean, "Tauri page");
  instance.page.on("pageerror", (error) => { instance.pageErrors.push(error.message); });
  instance.page.on("dialog", (dialog) => {
    if (dialog.type() === "confirm") {
      instance.confirmations.push(dialog.message());
      return instance.acceptConfirm ? dialog.accept() : dialog.dismiss();
    }
    return dialog.accept();
  });
  await instance.page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke));
  instance.origin = new URL(instance.page.url()).origin;
  assert.match(instance.origin, /tauri\.localhost|^tauri:\/\//, "must use the built Tauri runtime, not browser mocks");
  events.push({ stage: "desktop-launched", actor: name, pid: child.pid, origin: instance.origin });
  console.log(`Desktop launched: ${name}`);
  return instance;
}

async function stop(instance) {
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    const exited = once(instance.child, "exit");
    instance.child.kill(); // Force-terminate only this harness's own process.
    await Promise.race([exited, sleep(10_000).then(() => { throw new Error("Desktop process did not exit"); })]);
  }
  await instance.browser?.close().catch(() => {});
}

function invoke(instance, command, args = {}) {
  return instance.page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}

async function writing(instance, id) {
  await instance.page.goto(`${instance.origin}/writing#${id}`);
  // Same-document hash navigation does not remount the existing workspace.
  // Explicitly reload when testing a deep link rather than its chapter controls.
  await instance.page.reload();
  const editor = instance.page.locator(".creation-edit-panel .tiptap-editor");
  await editor.waitFor();
  await until(() => editor.getAttribute("contenteditable"), (value) => value === "true", "editor ready");
  return editor;
}

async function job(instance, jobType, payload) {
  const queued = await invoke(instance, "enqueue_job", { jobType, payload: JSON.stringify(payload) });
  const completed = await until(() => invoke(instance, "list_jobs"),
    (jobs) => jobs.some((j) => j.id === queued.id && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(j.status)), `${jobType} worker`);
  const result = completed.find((j) => j.id === queued.id);
  assert.equal(result.status, "SUCCEEDED", result.errorSummary ?? jobType);
  events.push({ stage: jobType, id: result.id, status: result.status });
  return result;
}

function document(text) {
  return JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
}

try {
  let main = await launch("main-state");
  assert.equal(await invoke(main, "current_project"), null, "settings isolation");
  const manifest = await invoke(main, "create_project", { root: projectRoot, name: "P4 continuous writing" });
  await invoke(main, "open_project", { root: projectRoot });
  const manager = await invoke(main, "create_plan_node", { parentId: null, kind: "VOLUME_MANAGER", title: "Volumes" });
  const volume = await invoke(main, "create_plan_node", { parentId: manager.id, kind: "VOLUME", title: "Volume 1" });
  const chapters = [];
  for (let index = 1; index <= 3; index++) {
    chapters.push(await invoke(main, "create_plan_node", { parentId: volume.id, kind: "CHAPTER", title: `Chapter ${index}` }));
  }
  const revisions = [];
  let editor = await writing(main, chapters[0].id);
  for (const [index, chapter] of chapters.entries()) {
    if (index > 0) {
      await main.page.getByRole("button", { name: "下一章", exact: true }).click();
      await main.page.locator(".chapter-focus-header").getByRole("heading", { name: chapter.title, exact: true }).waitFor();
      editor = main.page.locator(".creation-edit-panel .tiptap-editor");
      await editor.waitFor();
    }
    const text = `Saved chapter ${index + 1}. 中文正文。`;
    await editor.fill(text);
    await main.page.getByRole("button", { name: "保存正文", exact: true }).click();
    revisions.push(await until(() => invoke(main, "current_manuscript", { chapterId: chapter.id }),
      (revision) => revision?.documentJson.includes(text), `chapter ${index + 1} save`));
    await main.page.locator('.chapter-focus-header .save-state[data-state="saved"]').waitFor();
    console.log(`Chapter ${index + 1} saved through UI`);
  }
  editor = await writing(main, chapters[1].id);
  await editor.fill("Saved chapter 2 revised. 保留旧修订。");
  await main.page.getByRole("button", { name: "保存正文", exact: true }).click();
  const secondRevision = await until(() => invoke(main, "current_manuscript", { chapterId: chapters[1].id }),
    (revision) => revision?.id !== revisions[1].id, "second revision");
  const history = await invoke(main, "list_manuscript_revisions", { chapterId: chapters[1].id });
  assert.equal(history.length, 2);
  assert(history.some((revision) => revision.id === revisions[1].id));
  revisions[1] = secondRevision;
  events.push({ stage: "three-chapters-saved", revisionIds: revisions.map((revision) => revision.id) });

  const chapterId = chapters[2].id;
  editor = await writing(main, chapterId);
  await editor.fill("Durable local draft, not formal prose.");
  const draft = await until(() => invoke(main, "current_manuscript_draft", { chapterId }),
    (value) => value.documentJson?.includes("Durable local draft"), "draft debounce");
  assert.equal(draft.baseRevisionId, revisions[2].id);
  const other = await launch("other-state");
  await invoke(other, "open_project", { root: projectRoot });
  const otherDraft = await invoke(other, "current_manuscript_draft", { chapterId });
  assert.equal(otherDraft.version, draft.version);
  const remoteText = "Newer draft from second desktop instance.";
  const remoteDraft = await invoke(other, "save_manuscript_draft", {
    chapterId, baseRevisionId: draft.baseRevisionId, documentJson: document(remoteText), expectedVersion: draft.version,
  });
  await editor.fill("Unsaved conflict content to preserve.");
  await main.page.locator(".creation-memory-status[role=alert]").waitFor();
  assert.equal(await editor.textContent(), "Unsaved conflict content to preserve.");
  assert.equal((await invoke(main, "current_manuscript", { chapterId })).id, revisions[2].id);
  await main.page.screenshot({ path: join(artifacts, "two-instance-conflict.png"), fullPage: true });
  main.acceptConfirm = false;
  const confirmationsBeforeReread = main.confirmations.length;
  await main.page.getByRole("button", { name: "保留副本并重读", exact: true }).click();
  assert.equal(main.confirmations.length, confirmationsBeforeReread + 1);
  assert.equal(await editor.textContent(), "Unsaved conflict content to preserve.");
  assert.equal((await invoke(main, "list_recovery_logs", { chapterId })).length, 0);
  main.acceptConfirm = true;
  await main.page.getByRole("button", { name: "保留副本并重读", exact: true }).click();
  await editor.getByText(remoteText, { exact: true }).waitFor();
  const recovery = await invoke(main, "list_recovery_logs", { chapterId });
  assert(recovery.some((log) => log.documentJson.includes("Unsaved conflict content")));
  events.push({ stage: "two-instance-conflict-preserved", draftVersion: remoteDraft.version, recoveryIds: recovery.map((log) => log.id) });
  await stop(other);

  await main.page.getByText("导出正文", { exact: true }).click();
  await main.page.getByLabel("导出范围", { exact: true }).selectOption("book");
  main.acceptConfirm = false;
  const confirmationsBeforeExport = main.confirmations.length;
  const exportsBeforeCancellation = await readdir(join(projectRoot, "exports"));
  await main.page.getByRole("button", { name: "导出", exact: true }).click();
  assert.equal(main.confirmations.length, confirmationsBeforeExport + 1);
  assert.equal(await main.page.locator(".manuscript-export-result").count(), 0);
  assert.deepEqual(await readdir(join(projectRoot, "exports")), exportsBeforeCancellation);
  main.acceptConfirm = true;
  await main.page.getByRole("button", { name: "导出", exact: true }).click();
  await main.page.getByRole("status").filter({ hasText: "已导出 3 章" }).waitFor();
  const exportPath = await main.page.locator(".manuscript-export-result code").textContent();
  const exportedText = await readFile(exportPath, "utf8");
  assert(exportedText.includes("Saved chapter 1."));
  assert(exportedText.includes("Saved chapter 2 revised."));
  assert(exportedText.includes("Saved chapter 3."));
  assert(!exportedText.includes("Newer draft"));
  assert(!exportedText.includes("Unsaved conflict"));
  await main.page.screenshot({ path: join(artifacts, "real-txt-export.png"), fullPage: true });
  const markdown = await invoke(main, "export_manuscript", { input: {
    expectedProjectId: manifest.projectId, format: "MARKDOWN", scope: { kind: "BOOK" },
  } });
  assert.equal(markdown.chapters.length, 3);
  assert.equal(markdown.draftChapterCount, 1);
  assert.deepEqual(markdown.chapters.map((chapter) => chapter.revisionId), revisions.map((revision) => revision.id));
  const exportedMarkdown = await readFile(markdown.path, "utf8");
  assert(exportedMarkdown.startsWith("# P4 continuous writing"));
  for (const text of ["Saved chapter 1\\. 中文正文。", "Saved chapter 2 revised\\. 保留旧修订。", "Saved chapter 3\\. 中文正文。"]) {
    assert(exportedMarkdown.includes(text));
  }
  assert(!exportedMarkdown.includes("Newer draft"));
  assert(!exportedMarkdown.includes("Unsaved conflict"));
  events.push({ stage: "real-txt-markdown-export", txtPath: exportPath, markdownPath: markdown.path });
  const backup = await job(main, "BACKUP", {});
  const source = join(projectRoot, "snapshots", backup.id);
  const backupManifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  assert.equal(backupManifest.projectId, manifest.projectId);
  await job(main, "RESTORE_VERIFY", { source, target: restoredRoot });
  await stop(main);
  events.push({ stage: "forced-process-termination" });

  main = await launch("main-state");
  assert.equal((await invoke(main, "current_project")).projectId, manifest.projectId);
  const report = await invoke(main, "startup_recovery_report");
  assert.equal(report.crashMarkerPresent, true);
  assert(report.recoveryLogCount >= 1);
  assert.equal((await invoke(main, "current_manuscript", { chapterId })).id, revisions[2].id);
  const reopenedDraft = await invoke(main, "current_manuscript_draft", { chapterId });
  assert.equal(reopenedDraft.version, remoteDraft.version);
  assert.equal(reopenedDraft.baseRevisionId, revisions[2].id);
  editor = await writing(main, chapterId);
  await editor.getByText(remoteText, { exact: true }).waitFor();
  await main.page.getByRole("tab", { name: /版本/ }).click();
  await main.page.locator(".recovery-banner").waitFor();
  await main.page.screenshot({ path: join(artifacts, "reopened-recovery.png"), fullPage: true });
  events.push({ stage: "crash-reopen-verified", report, draftVersion: reopenedDraft.version });
  await invoke(main, "open_project", { root: restoredRoot });
  for (const [index, chapter] of chapters.entries()) {
    assert.equal((await invoke(main, "current_manuscript", { chapterId: chapter.id })).id, revisions[index].id);
  }
  const restoredDraft = await invoke(main, "current_manuscript_draft", { chapterId });
  assert.equal(restoredDraft.version, remoteDraft.version);
  assert.equal(restoredDraft.baseRevisionId, revisions[2].id);
  assert.equal(restoredDraft.documentJson, remoteDraft.documentJson);
  assert.equal((await invoke(main, "list_manuscript_revisions", { chapterId: chapters[1].id })).length, 2);
  assert((await invoke(main, "list_recovery_logs", { chapterId })).some((log) => log.documentJson.includes("Unsaved conflict")));
  assert.equal((await invoke(main, "health_scan")).sqliteIntegrity, "ok");
  editor = await writing(main, chapterId);
  await editor.getByText(remoteText, { exact: true }).waitFor();
  await main.page.screenshot({ path: join(artifacts, "restored-draft.png"), fullPage: true });
  events.push({ stage: "backup-restore-verified", restoredRoot, draftVersion: restoredDraft.version });
  await invoke(main, "close_project");
  for (const instance of instances) assert.deepEqual(instance.pageErrors, []);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, events }, null, 2));
  console.log(`Real Tauri recovery acceptance passed: ${artifacts}`);
} catch (error) {
  for (const instance of instances) {
    if (instance.page && !instance.page.isClosed()) {
      await instance.page.screenshot({ path: join(artifacts, `failure-${instance.child.pid}.png`), fullPage: true }).catch(() => {});
    }
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: false, error: String(error), events }, null, 2));
  console.error(`Acceptance artifacts: ${artifacts}`);
  throw error;
} finally {
  for (const instance of instances) {
    await stop(instance);
    await writeFile(join(artifacts, `desktop-${instance.child.pid}.log`), instance.log);
  }
}
