import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { manuscriptSnapshot } from "./desktop-interruption-db.mjs";
import { createDesktopHarness, invoke, until } from "./desktop-smoke-runtime.mjs";

const { values } = parseArgs({ options: { app: { type: "string" } } });
const { artifacts, instances, events, launch, stop, cleanup } = await createDesktopHarness("p4-backup-interruption", values.app);
const root = join(artifacts, "synthetic-project");
const snapshots = join(root, "snapshots");
const attachment = "interruption-payload.bin";
const saveButton = "\u4fdd\u5b58\u6b63\u6587";
let db;
let writerHeld = false;
const watchers = [];

async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest("hex")}`;
}

async function treeHashes(rootPath) {
  const files = {};
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      assert(!entry.isSymbolicLink(), "synthetic artifacts must not redirect to another location");
      if (entry.isDirectory()) await walk(path);
      else files[relative(rootPath, path).split(sep).join("/")] = await hash(path);
    }
  }
  await walk(rootPath);
  return files;
}

async function writing(instance, chapterId, text) {
  await instance.page.goto(`${instance.origin}/writing#${chapterId}`);
  await instance.page.reload();
  const editor = instance.page.locator(".creation-edit-panel .tiptap-editor");
  await until(() => editor.getAttribute("contenteditable"), (value) => value === "true", "editor ready");
  if (text) await editor.getByText(text, { exact: true }).waitFor();
  return editor;
}

// The watcher is armed before enqueueing. A bounded attachment provides time
// to observe staging after the online SQLite backup, without product hooks.
function boundary(instance, mode) {
  let observation;
  const watcher = watch(snapshots, { recursive: true }, (_event, filename) => {
    if (observation || !filename) return;
    const parts = String(filename).split(/[\\/]/);
    const matched = /^\.([0-9a-f-]{36})-([0-9a-f-]{36})\.partial$/.exec(parts[0]);
    if (!matched || parts[1] !== "attachments" || parts[2] !== attachment) return;
    const staging = join(snapshots, parts[0]);
    const path = join(staging, "attachments", attachment);
    if (!existsSync(path)) return;
    try {
      assert.equal(existsSync(join(staging, "manifest.json")), false, "staging witness must precede manifest publication");
      assert.equal(existsSync(join(snapshots, matched[1])), false, "formal snapshot must not yet exist");
      const size = statSync(path).size;
      if (mode === "pre-publication") {
        assert(instance.child.kill(), "terminate only this harness's desktop process");
      } else {
        // Hold an empty external write transaction after the source DB has been
        // copied. File publication can proceed, but its SUCCEEDED update cannot.
        db.exec("BEGIN IMMEDIATE");
        writerHeld = true;
      }
      observation = { mode, jobId: matched[1], staging, attachmentBytesAtWitness: size };
      watcher.close();
    } catch (error) {
      observation = { error: String(error) };
      watcher.close();
    }
  });
  watcher.on("error", (error) => { observation = { error: String(error) }; });
  watchers.push(watcher);
  return () => observation;
}

function integrity() {
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

async function terminal(instance, id) {
  const jobs = await until(() => invoke(instance, "list_jobs"),
    (jobs) => jobs.some((job) => job.id === id && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)),
    "backup/restore terminal status");
  return jobs.find((job) => job.id === id);
}

async function reopen(manifest) {
  const instance = await launch("isolated-state");
  assert.equal((await invoke(instance, "current_project")).projectId, manifest.projectId);
  assert.equal((await invoke(instance, "startup_recovery_report")).crashMarkerPresent, true);
  return instance;
}

async function published(path, jobId, projectId) {
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  assert.equal(manifest.jobId, jobId);
  assert.equal(manifest.projectId, projectId);
  assert.equal(manifest.schemaVersion, 53);
  assert.equal(manifest.formatVersion, 1);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert(name === "project.json" || name === "project.sqlite" || name.startsWith("attachments/"));
    assert(!name.split("/").some((part) => ["", ".", ".."].includes(part)));
    assert.equal(await hash(join(path, ...name.split("/"))), expected, name);
  }
  assert(manifest.files["project.json"]);
  assert(manifest.files["project.sqlite"]);
  assert(manifest.files[`attachments/${attachment}`]);
  return treeHashes(path);
}

try {
  let main = await launch("isolated-state");
  assert.equal(await invoke(main, "current_project"), null);
  const manifest = await invoke(main, "create_project", { root, name: "P4 backup interruption" });
  await invoke(main, "open_project", { root });
  const chapter = await invoke(main, "create_plan_node", { parentId: null, kind: "CHAPTER", title: "Backup chapter" });
  const chapterId = chapter.id;
  const editor = await writing(main, chapterId);
  await editor.fill("Formal text preserved across backup interruption.");
  await main.page.getByRole("button", { name: saveButton, exact: true }).click();
  const revision = await until(() => invoke(main, "current_manuscript", { chapterId }), Boolean, "saved revision");
  await main.page.locator('.save-state[data-state="saved"]').waitFor();
  const draftText = "Durable draft independent from the backup receipt.";
  await editor.fill(draftText);
  const draft = await until(() => invoke(main, "current_manuscript_draft", { chapterId }),
    (value) => value.documentJson?.includes(draftText), "durable draft");
  await invoke(main, "save_recovery_log", { chapterId, documentJson: draft.documentJson });
  const recoveryLogs = await invoke(main, "list_recovery_logs", { chapterId });
  await mkdir(join(root, "attachments"), { recursive: true });
  const file = await open(join(root, "attachments", attachment), "wx");
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    for (let index = 0; index < 64; index++) await file.write(chunk);
    await file.sync();
  } finally { await file.close(); }
  await writeFile(join(root, "recovery", "synthetic-copy.txt"), "Synthetic recovery file only.");
  const inputHashes = { attachment: await hash(join(root, "attachments", attachment)), recovery: await hash(join(root, "recovery", "synthetic-copy.txt")) };
  db = new DatabaseSync(join(root, "project.sqlite"));
  db.exec("PRAGMA busy_timeout=0");
  const manuscript = manuscriptSnapshot(db, chapterId);
  assert.equal((await invoke(main, "list_jobs")).length, 0);

  const beforePublication = boundary(main, "pre-publication");
  const earlyJob = await invoke(main, "enqueue_job", { jobType: "BACKUP", payload: "{}" });
  const early = await until(() => Promise.resolve(beforePublication()), Boolean, "pre-publication filesystem witness");
  assert(!early.error, early.error);
  assert.equal(early.jobId, earlyJob.id);
  await stop(main);
  const earlyTarget = join(snapshots, earlyJob.id);
  assert.equal(existsSync(earlyTarget), false, "interrupted staging must never appear as a formal snapshot");
  assert.equal(existsSync(join(early.staging, "manifest.json")), false);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(earlyJob.id).status, "RUNNING");
  assert.deepEqual(manuscriptSnapshot(db, chapterId), manuscript);
  integrity();
  const staleHashes = await treeHashes(early.staging);
  events.push({ stage: "pre-publication-terminated", ...early, partialFiles: Object.keys(staleHashes) });
  main = await reopen(manifest);
  const earlyRecovered = await terminal(main, earlyJob.id);
  assert.equal(earlyRecovered.status, "SUCCEEDED", earlyRecovered.errorSummary ?? "staging retry");
  assert.equal(earlyRecovered.attemptCount, 2);
  const earlyPublishedHashes = await published(earlyTarget, earlyJob.id, manifest.projectId);
  assert.deepEqual(await treeHashes(early.staging), staleHashes, "retry must not reuse or delete the old interrupted staging");
  const rejectedTarget = join(artifacts, "rejected-partial-restore");
  const restorePartial = await invoke(main, "enqueue_job", {
    jobType: "RESTORE_VERIFY", payload: JSON.stringify({ source: early.staging, target: rejectedTarget }),
  });
  assert.equal((await terminal(main, restorePartial.id)).status, "FAILED");
  assert.equal(existsSync(rejectedTarget), false);
  events.push({ stage: "pre-publication-recovered", jobId: earlyJob.id, attemptCount: 2, partialRestoreRejected: true });
  console.log("Interrupted staging, fresh retry and partial restore rejection passed");

  const afterPublication = boundary(main, "post-publication");
  const lateJob = await invoke(main, "enqueue_job", { jobType: "BACKUP", payload: "{}" });
  const late = await until(() => Promise.resolve(afterPublication()), Boolean, "external receipt lock acquired");
  assert(!late.error, late.error);
  assert.equal(late.jobId, lateJob.id);
  assert.equal(writerHeld, true);
  const lateTarget = join(snapshots, lateJob.id);
  await until(() => Promise.resolve(existsSync(join(lateTarget, "manifest.json"))), Boolean, "directory publication under receipt lock", 4_000);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(lateJob.id).status, "RUNNING");
  await stop(main);
  db.exec("ROLLBACK");
  writerHeld = false;
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(lateJob.id).status, "RUNNING");
  assert.equal(existsSync(late.staging), false);
  const publishedHashes = await published(lateTarget, lateJob.id, manifest.projectId);
  events.push({ stage: "post-publication-terminated", ...late, receiptBlockedBy: "empty external SQLite writer transaction", publishedFiles: Object.keys(publishedHashes) });
  main = await reopen(manifest);
  const lateRecovered = await terminal(main, lateJob.id);
  events.push({ stage: "post-publication-recovery-outcome", jobId: lateJob.id, status: lateRecovered.status, attemptCount: lateRecovered.attemptCount, errorSummary: lateRecovered.errorSummary });
  assert.equal(lateRecovered.status, "SUCCEEDED", lateRecovered.errorSummary ?? "published backup reconciliation");
  assert.equal(lateRecovered.attemptCount, 2);
  assert.deepEqual(await treeHashes(lateTarget), publishedHashes, "recovered receipt must not rewrite the published backup");
  assert.deepEqual(await treeHashes(earlyTarget), earlyPublishedHashes);
  assert.deepEqual(await treeHashes(early.staging), staleHashes);
  assert.deepEqual(manuscriptSnapshot(db, chapterId), manuscript);
  assert.equal(await hash(join(root, "attachments", attachment)), inputHashes.attachment);
  assert.equal(await hash(join(root, "recovery", "synthetic-copy.txt")), inputHashes.recovery);
  integrity();

  const restoredRoot = join(artifacts, "verified-restore");
  const restore = await invoke(main, "enqueue_job", { jobType: "RESTORE_VERIFY", payload: JSON.stringify({ source: lateTarget, target: restoredRoot }) });
  assert.equal((await terminal(main, restore.id)).status, "SUCCEEDED");
  assert.equal(await hash(join(restoredRoot, "attachments", attachment)), inputHashes.attachment);
  assert.equal(await hash(join(restoredRoot, "recovery", "synthetic-copy.txt")), inputHashes.recovery);
  await invoke(main, "open_project", { root: restoredRoot });
  assert.equal((await invoke(main, "current_manuscript", { chapterId })).id, revision.id);
  assert.deepEqual(await invoke(main, "current_manuscript_draft", { chapterId }), draft);
  assert.deepEqual(await invoke(main, "list_recovery_logs", { chapterId }), recoveryLogs);
  assert.equal((await invoke(main, "health_scan")).sqliteIntegrity, "ok");
  await writing(main, chapterId, draftText);
  await main.page.screenshot({ path: join(artifacts, "restored-backup-draft.png"), fullPage: true });
  await main.page.getByRole("link", { name: "\u4efb\u52a1", exact: true }).click();
  await main.page.locator(".jobs-view .job-row").first().waitFor();
  await main.page.screenshot({ path: join(artifacts, "restored-task-recovery.png"), fullPage: true });
  events.push({ stage: "published-backup-restored", revisionId: revision.id, draftVersion: draft.version, attachmentBytes: 64 * 1024 * 1024 });
  await invoke(main, "close_project");
  for (const instance of instances) assert.deepEqual(instance.pageErrors, []);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, events }, null, 2));
  console.log(`Real backup interruption acceptance passed: ${artifacts}`);
} catch (error) {
  if (writerHeld) {
    db.exec("ROLLBACK");
    writerHeld = false;
  }
  for (const instance of instances) {
    if (instance.page && !instance.page.isClosed()) {
      await instance.page.screenshot({ path: join(artifacts, `failure-${instance.child.pid}.png`), fullPage: true }).catch(() => {});
    }
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: false, error: String(error), events }, null, 2));
  console.error(`Acceptance artifacts: ${artifacts}`);
  throw error;
} finally {
  for (const watcher of watchers) watcher.close();
  try { await cleanup(); }
  finally {
    if (writerHeld) db.exec("ROLLBACK");
    db?.close();
  }
}
