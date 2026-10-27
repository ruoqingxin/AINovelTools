import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDesktopHarness, invoke } from "./desktop-smoke-runtime.mjs";

// Synthetic local data only. No profiles or model requests are created.
const harness = await createDesktopHarness("coauthor-workspace");
const root = join(harness.artifacts, "synthetic-project");
const receipt = "检索操作回执（程序记录；计数为当次返回页，不是相关条数或全库总数）：\n"
  + '- 关键词 "代价"（项目资料，offset=0）：实际返回 1 条。\n'
  + "未检索到不等于不存在；未形成有效查询、未授权或索引不完整均不能证明查全。";
const reply = "这是本机界面验收使用的历史回复，不是模型质量证据。";
let main;
let passed = false;
try {
  main = await harness.launch("workspace-state");
  const project = await invoke(main, "create_project", { root, name: "共创界面本机验收" });
  const session = await invoke(main, "create_discussion_session", { title: "待删除讨论", scopeKind: "PROJECT" });
  const scope = { projectId: project.projectId, sessionId: session.id };
  const initial = await invoke(main, "get_coauthor_state", { scope });
  const saved = await invoke(main, "save_coauthor_document", { scope, document: {
    ...initial.document, title: "保留的正式设定", content: "已采用的正式内容不随讨论删除。",
  } });
  const formalKey = await invoke(main, "publish_coauthor_document", { scope, expectedVersion: saved.version });
  const branch = await invoke(main, "fork_coauthor_session", { scope, title: "保留的分支" });
  const childScope = { projectId: project.projectId, sessionId: branch.id };
  const childBefore = await invoke(main, "get_coauthor_state", { scope: childScope });
  const entitiesBefore = await invoke(main, "list_entities", { includeArchived: false });
  assert(entitiesBefore.some(entity => `ENTITY:${entity.id}` === formalKey));
  await invoke(main, "close_project");
  const runId = randomUUID();
  const userId = randomUUID();
  const answerId = randomUUID();
  const db = new DatabaseSync(join(root, "project.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN");
    const message = db.prepare("INSERT INTO discussion_messages(id,session_id,role,content,context_version) VALUES(?,?,?,?,?)");
    message.run(userId, session.id, "USER", "只检查本机交互。", null);
    message.run(answerId, session.id, "ASSISTANT", `${reply}\n\n${receipt}`, `coauthor:${runId}`);
    db.prepare("INSERT INTO coauthor_runs(id,session_id,user_message_id,status,document_version,output,audit) VALUES(?,?,?,'COMPLETED',?,?,?)")
      .run(runId, session.id, userId, saved.version, reply, JSON.stringify([
        { kind: "model_request" }, { kind: "reply_delivery", mode: "DISCUSSION" },
      ]));
    db.exec("COMMIT");
  } finally { db.close(); }
  await invoke(main, "open_project", { root });
  const page = main.page;
  await page.goto(`${main.origin}/discussion#${session.id}`);
  const input = page.getByLabel("讨论输入", { exact: true });
  await input.waitFor();
  await page.getByLabel("外观", { exact: true }).click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  assert.equal(await page.getByLabel("工作稿内容", { exact: true }).isVisible(), false);
  const answer = page.getByRole("article").filter({ has: page.getByText(reply, { exact: true }) });
  assert.equal(await answer.locator("details,footer").count(), 0);
  assert.equal(await answer.getByText(/检索操作回执/).count(), 0);
  await answer.getByRole("button", { name: "查看本轮记录", exact: true }).click();
  const records = page.getByRole("dialog", { name: "依据与运行记录", exact: true });
  await records.getByRole("tab", { name: "检索回执", exact: true }).click();
  await records.getByText(receipt, { exact: true }).waitFor();
  await page.screenshot({ path: join(harness.artifacts, "native-records.png"), fullPage: true });
  await records.getByRole("tab", { name: "本轮概览", exact: true }).click();
  await records.getByRole("button", { name: "核对这条回复", exact: true }).click();
  assert((await input.inputValue()).includes(reply));
  await input.fill("保留未发送输入");
  await page.getByRole("tab", { name: "工作稿", exact: true }).click();
  assert.equal(await page.getByLabel("工作稿内容", { exact: true }).inputValue(), saved.content);
  await page.screenshot({ path: join(harness.artifacts, "native-draft.png"), fullPage: true });
  await page.getByRole("tab", { name: "讨论", exact: true }).click();
  assert.equal(await input.inputValue(), "保留未发送输入");
  await page.screenshot({ path: join(harness.artifacts, "native-discussion.png"), fullPage: true });
  await assert.rejects(invoke(main, "delete_discussion_session", { scope: { ...scope, projectId: randomUUID() } }));
  await page.getByRole("button", { name: "删除当前讨论", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "删除当前讨论", exact: true });
  assert.equal(await confirm.getByRole("button", { name: "取消", exact: true }).evaluate(el => el === document.activeElement), true);
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await input.inputValue(), "保留未发送输入");
  assert((await invoke(main, "list_discussion_sessions")).some(entry => entry.id === session.id));
  await page.getByRole("button", { name: "删除当前讨论", exact: true }).click();
  await confirm.getByRole("button", { name: "删除讨论", exact: true }).click();
  await page.waitForFunction(id => document.querySelector('select[aria-label="当前讨论"]')?.value === id, branch.id);
  await page.getByLabel("讨论输入", { exact: true }).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), `coauthor-input:${project.projectId}:${session.id}`), null);
  assert(!(await invoke(main, "list_discussion_sessions")).some(entry => entry.id === session.id));
  await assert.rejects(invoke(main, "get_coauthor_state", { scope }));
  assert.deepEqual(await invoke(main, "list_entities", { includeArchived: false }), entitiesBefore);
  assert.deepEqual((await invoke(main, "get_coauthor_state", { scope: childScope })).document, childBefore.document);
  await page.screenshot({ path: join(harness.artifacts, "native-after-delete.png"), fullPage: true });
  await invoke(main, "close_project");
  const retained = new DatabaseSync(join(root, "project.sqlite"), { readOnly: true });
  try {
    assert(retained.prepare("SELECT deleted_at FROM discussion_sessions WHERE id=?").get(session.id).deleted_at);
    assert.equal(retained.prepare("SELECT COUNT(*) AS total FROM discussion_messages WHERE session_id=?").get(session.id).total, 2);
    assert.equal(retained.prepare("SELECT output FROM coauthor_runs WHERE id=?").get(runId).output, reply);
    assert.deepEqual(retained.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { retained.close(); }
  await harness.stop(main);
  main = await harness.launch("workspace-state");
  await invoke(main, "open_project", { root });
  assert(!(await invoke(main, "list_discussion_sessions")).some(entry => entry.id === session.id));
  assert.deepEqual((await invoke(main, "get_coauthor_state", { scope: childScope })).document, childBefore.document);
  for (const instance of harness.instances) assert.deepEqual(instance.pageErrors, []);
  passed = true;
} catch (error) {
  harness.events.push({ stage: "failed", error: String(error) });
  await main?.page?.screenshot({ path: join(harness.artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await harness.cleanup();
  await writeFile(join(harness.artifacts, "report.json"), JSON.stringify({
    passed, realModelRequests: 0, root, retainedProvenance: true, events: harness.events,
  }, null, 2));
  console.log(`Native workspace smoke ${passed ? "passed" : "failed"}: ${harness.artifacts}`);
}
