import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { installJobGate, installManuscriptGate, jobGate, manuscriptGate, manuscriptSnapshot, writerLocked } from "./desktop-interruption-db.mjs";
import { createDesktopHarness, invoke, until } from "./desktop-smoke-runtime.mjs";

const { values } = parseArgs({ options: { app: { type: "string" } } });
const { artifacts, instances, events, launch, stop, cleanup } = await createDesktopHarness("p4-interruption", values.app);
const root = join(artifacts, "synthetic-project");
const saveButton = "\u4fdd\u5b58\u6b63\u6587";
const durableText = "Durable draft before immediate termination.";
const transientText = "Input inside the autosave debounce window.";
const targetText = "Formal save interrupted inside its SQL transaction.";
let db;

async function writing(instance, chapterId, text) {
  await instance.page.goto(`${instance.origin}/writing#${chapterId}`);
  await instance.page.reload();
  const editor = instance.page.locator(".creation-edit-panel .tiptap-editor");
  await until(() => editor.getAttribute("contenteditable"), (value) => value === "true", "editor ready");
  if (text) await editor.getByText(text, { exact: true }).waitFor();
  return editor;
}

async function sustainedLock(label) {
  await until(() => Promise.resolve(writerLocked(db)), Boolean, `${label} entered writer transaction`, 10_000);
  const start = performance.now();
  for (let sample = 0; sample < 5; sample++) {
    await sleep(100);
    assert.equal(writerLocked(db), true, `${label} must remain inside the injected transaction`);
  }
  return { samples: 6, lockedMs: Math.round(performance.now() - start) };
}

function integrity() {
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

async function reopen(manifest) {
  const instance = await launch("isolated-state");
  assert.equal((await invoke(instance, "current_project")).projectId, manifest.projectId);
  assert.equal((await invoke(instance, "startup_recovery_report")).crashMarkerPresent, true);
  return instance;
}

try {
  let main = await launch("isolated-state");
  assert.equal(await invoke(main, "current_project"), null, "settings must be isolated");
  const manifest = await invoke(main, "create_project", { root, name: "P4 interruption acceptance" });
  await invoke(main, "open_project", { root });
  const chapter = await invoke(main, "create_plan_node", { parentId: null, kind: "CHAPTER", title: "Interruption chapter" });
  const chapterId = chapter.id;
  let editor = await writing(main, chapterId);
  await editor.fill("Original formal revision.");
  await main.page.getByRole("button", { name: saveButton, exact: true }).click();
  const original = await until(() => invoke(main, "current_manuscript", { chapterId }), Boolean, "initial formal revision");
  await main.page.locator('.save-state[data-state="saved"]').waitFor();
  await editor.fill(durableText);
  const durable = await until(() => invoke(main, "current_manuscript_draft", { chapterId }),
    (draft) => draft.documentJson?.includes(durableText), "durable draft");
  assert.equal(durable.baseRevisionId, original.id);
  db = new DatabaseSync(join(root, "project.sqlite"));
  db.exec("PRAGMA busy_timeout=0");
  const beforeDebounce = manuscriptSnapshot(db, chapterId);

  // Start the clock before Playwright fill, a conservative bound on input age.
  let exitedAt;
  main.child.once("exit", () => { exitedAt = performance.now(); });
  const editedAt = performance.now();
  await editor.fill(transientText);
  assert.equal(await editor.textContent(), transientText);
  const killRequestedAt = performance.now();
  await stop(main);
  const elapsedMs = Math.round(exitedAt - editedAt);
  events.push({ stage: "pre-debounce-termination", elapsedMs, killRequestedMs: Math.round(killRequestedAt - editedAt), debounceMs: 800 });
  assert(exitedAt - editedAt < 800, "timing inconclusive: process did not exit within the 800ms debounce window");
  assert.deepEqual(manuscriptSnapshot(db, chapterId), beforeDebounce);
  integrity();
  main = await reopen(manifest);
  assert.deepEqual(await invoke(main, "current_manuscript_draft", { chapterId }), durable);
  editor = await writing(main, chapterId, durableText);
  assert.equal(await editor.textContent(), durableText);
  await main.page.screenshot({ path: join(artifacts, "debounce-reopened.png"), fullPage: true });
  events.push({ stage: "pre-debounce-recovered", expectedLoss: transientText, restoredDraftVersion: durable.version, revisionId: original.id });
  console.log("Pre-debounce termination and durable-draft restoration passed");

  await editor.fill(targetText);
  const target = await until(() => invoke(main, "current_manuscript_draft", { chapterId }),
    (draft) => draft.documentJson?.includes(targetText), "formal target draft already durable");
  await invoke(main, "save_recovery_log", { chapterId, documentJson: target.documentJson });
  const [recovery] = await invoke(main, "list_recovery_logs", { chapterId });
  assert(recovery, "recovery copy must exist before the formal transaction");
  assert.equal((await invoke(main, "list_jobs")).length, 0, "no unrelated workers may write during the formal gate");
  const beforeFormal = manuscriptSnapshot(db, chapterId);
  assert.equal(beforeFormal.recovery.length, 1);
  assert.equal(writerLocked(db), false);
  installManuscriptGate(db, chapterId);
  await main.page.getByRole("button", { name: saveButton, exact: true }).click();
  await main.page.locator('.save-state[data-state="saving"]').waitFor();
  const formalLock = await sustainedLock("formal save");
  assert.deepEqual(manuscriptSnapshot(db, chapterId), beforeFormal, "uncommitted formal changes must be invisible");
  await main.page.screenshot({ path: join(artifacts, "formal-save-in-flight.png"), fullPage: true });
  assert.equal(writerLocked(db), true, "formal writer must still be active immediately before termination");
  await stop(main);
  assert.equal(writerLocked(db), false);
  assert.deepEqual(manuscriptSnapshot(db, chapterId), beforeFormal, "revision, cleared draft, recovery deletion and search must roll back together");
  integrity();
  db.exec(`DROP TRIGGER ${manuscriptGate}`);
  events.push({ stage: "formal-transaction-terminated", injection: "synthetic AFTER DELETE recovery_logs SQL delay", ...formalLock, recoveryId: recovery.id });
  main = await reopen(manifest);
  assert.equal((await invoke(main, "current_manuscript", { chapterId })).id, original.id);
  assert.deepEqual(await invoke(main, "current_manuscript_draft", { chapterId }), target);
  assert.equal((await invoke(main, "list_recovery_logs", { chapterId }))[0].id, recovery.id);
  editor = await writing(main, chapterId, targetText);
  await main.page.screenshot({ path: join(artifacts, "formal-rollback-reopened.png"), fullPage: true });
  await main.page.getByRole("button", { name: saveButton, exact: true }).click();
  const retried = await until(() => invoke(main, "current_manuscript", { chapterId }),
    (revision) => revision?.id !== original.id, "formal save retry");
  await main.page.locator('.save-state[data-state="saved"]').waitFor();
  assert.equal((await invoke(main, "list_manuscript_revisions", { chapterId })).length, 2);
  const cleared = await invoke(main, "current_manuscript_draft", { chapterId });
  assert.equal(cleared.documentJson, null);
  assert.equal(cleared.version, target.version + 1);
  assert.deepEqual(await invoke(main, "list_recovery_logs", { chapterId }), []);
  const afterRetry = manuscriptSnapshot(db, chapterId);
  assert.equal(afterRetry.index.filter((row) => row.object_type === "MANUSCRIPT" && row.object_id === retried.id).length, 1);
  integrity();
  events.push({ stage: "formal-retry-succeeded-once", revisionId: retried.id, draftVersion: cleared.version, revisionCount: 2 });
  console.log("In-flight formal transaction rollback and UI retry passed");

  assert.equal(writerLocked(db), false);
  installJobGate(db);
  const queued = await invoke(main, "enqueue_job", { jobType: "REBUILD_SEARCH_INDEX", payload: "{}" });
  const readJob = () => db.prepare("SELECT * FROM jobs WHERE id=?").get(queued.id);
  await until(() => Promise.resolve(readJob()), (job) => job?.status === "RUNNING" && job.attempt_count === 1, "real worker claim");
  const jobLock = await sustainedLock("worker completion receipt");
  assert.equal(readJob().status, "RUNNING", "success receipt must not yet be durable");
  assert.equal(writerLocked(db), true);
  await stop(main);
  const interruptedJob = readJob();
  assert.equal(interruptedJob.status, "RUNNING");
  assert.equal(interruptedJob.attempt_count, 1);
  assert.deepEqual(manuscriptSnapshot(db, chapterId), afterRetry);
  integrity();
  db.exec(`DROP TRIGGER ${jobGate}`);
  events.push({ stage: "worker-receipt-terminated", injection: "synthetic AFTER UPDATE jobs SUCCEEDED SQL delay", ...jobLock, jobId: queued.id, attemptCount: 1 });
  main = await reopen(manifest);
  const completed = await until(() => invoke(main, "list_jobs"), (jobs) => jobs.some((job) => job.id === queued.id && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)), "recovered worker");
  const recoveredJob = completed.find((job) => job.id === queued.id);
  assert.equal(recoveredJob.status, "SUCCEEDED", recoveredJob.errorSummary ?? "worker retry");
  assert.equal(recoveredJob.attemptCount, 2);
  assert.equal(recoveredJob.progress, 100);
  assert.deepEqual(manuscriptSnapshot(db, chapterId), afterRetry, "repeatable index rebuild must preserve manuscript data and index rows");
  integrity();
  editor = await writing(main, chapterId, targetText);
  await main.page.screenshot({ path: join(artifacts, "worker-recovered.png"), fullPage: true });
  events.push({ stage: "worker-requeued-and-completed", jobId: queued.id, status: recoveredJob.status, attemptCount: recoveredJob.attemptCount });
  await invoke(main, "close_project");
  for (const instance of instances) assert.deepEqual(instance.pageErrors, []);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, events }, null, 2));
  console.log(`Real desktop interruption acceptance passed: ${artifacts}`);
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
  try { await cleanup(); }
  finally { db?.close(); }
}
