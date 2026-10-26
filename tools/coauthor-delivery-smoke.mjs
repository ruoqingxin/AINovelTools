import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDesktopHarness, invoke, until, workspace } from "./desktop-smoke-runtime.mjs";
import { runNative } from "./coauthor-evaluation.mjs";
import { loopbackContext } from "./coauthor-runtime-loopback.mjs";

// Isolated localhost protocol probes, not DeepSeek quality evidence.
assert.equal(process.argv.length, 2, "This local-only smoke test accepts no cloud/profile options.");
const harness = await createDesktopHarness("coauthor-delivery");
const report = { status: "running", realModelRequests: 0, httpRequests: 0, turns: [], qualityVerified: false };
let main, server, profile, scope, project, probe, requests, seedMessage, ruleSource;
const oldStory = "她将铜匣推回桌角。门外的脚步停了。\n\n"
  + "她等那脚步走远，才伸手把灯拨亮一点。铜匣的盖子被她掀开过一次，又合上。"
  + "她试着想一想那个人，想他站在门口的样子，想他说过的最后一句话。想得起来，画面清楚，声音也清楚。"
  + "只是心里没有动静。\n\n她把手指按在胸口，按了一会儿，像在确认一处不再疼的旧伤。"
  + "灯还亮着。她坐着，没有起身。";
const newStory = "她将铜匣推回桌角。窗纸上多了一道影子。她把门闩压紧，听见外面的人叫了一个陌生的名字。";
const call = (name, args, index = 0) => ({ id: `delivery-${requests}-${index}`, type: "function",
  function: { name, arguments: JSON.stringify(args) } });
const tools = (...calls) => ({ role: "assistant", content: "", tool_calls: calls });
const deliver = (args) => tools(call("deliver_reply", { ruleChanges: [], ...args }));
const plain = (content) => ({ role: "assistant", content });
const continuation = (content) => ({
  mode: "CONTINUATION", content, requestQuote: "继续写",
  continuation: { messageId: seedMessage.id, anchor: "她坐着，没有起身。",
    preservedQuotes: ["她将铜匣推回桌角"] },
});

function response(body) {
  const { context } = loopbackContext(body.messages);
  assert(body.tools.some((tool) => tool.function.name === "deliver_reply"));
  if (probe === "seed") return deliver({ mode: "DISCUSSION", content: oldStory });
  if (probe === "repair") {
    assert(context.historicalMessages.some((message) => message.id === seedMessage.id));
    if (requests === 1) return plain(oldStory + "\n要不要我接着写？");
    if (requests === 2) return deliver(continuation(oldStory + "\n要不要我接着写？"));
    assert.equal(requests, 3);
    assert(body.messages.some((message) => message.role === "tool" && JSON.parse(message.content).error?.includes("连续80字")));
    return deliver(continuation(newStory));
  }
  if (probe === "reprint") return deliver({ mode: "REPRINT", content: oldStory, requestQuote: "重贴整合全文" });
  if (probe === "changing-errors") {
    if (requests === 1) return deliver({ mode: "DISCUSSION", content: "" });
    if (requests === 2) return deliver({ mode: "REPRINT", content: "伪造授权", requestQuote: "重贴整合全文" });
    return deliver({ mode: "CONTINUATION", content: "缺少承接点", requestQuote: "继续写" });
  }
  if (probe === "missing-delivery") return plain("这不是已交付回复，要不要继续？");
  if (probe === "batch") return tools(call("deliver_reply", { mode: "DISCUSSION", content: "不能抢先完成", ruleChanges: [] }),
    call("record_decision", { expectedVersion: 0, topic: "不应执行", content: "继续写", quote: "继续写", status: "CHOSEN" }, 1));
  if (probe === "rule-change") {
    if (requests === 1) {
      ruleSource = context.relevantSources.hits.find((source) => source.title === "突破代价规则");
      assert(ruleSource);
      return tools(call("read_source", { key: ruleSource.key, revision: ruleSource.revision }));
    }
    const read = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content))
      .find((result) => result.key === ruleSource.key);
    assert(read?.content.includes("普通术法"));
    return deliver({ mode: "DISCUSSION", content: "这里提出特殊恢复机制，不视为原规则已有的能力。",
      ruleChanges: [{ key: read.key, revision: read.revision, quote: "普通术法", proposal: "新增有代价的特殊恢复机制，仍待作者决定。" }] });
  }
  throw new Error(`Unknown probe: ${probe}`);
}

function snapshot() {
  const db = new DatabaseSync(join(project.root, "project.sqlite"), { readOnly: true });
  try {
    return JSON.stringify(["entities", "entity_revisions", "author_settings", "plan_nodes", "plan_node_revisions",
      "planning_sections", "manuscript_revisions", "coauthor_decisions"].map((table) =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

async function run(name, message, expectedStatus, expectedRequests) {
  probe = name;
  requests = 0;
  const before = await invoke(main, "get_coauthor_state", { scope });
  const original = snapshot();
  const preferences = await invoke(main, "get_ai_task_preferences");
  const feeBudget = await invoke(main, "get_ai_budget_settings");
  const runId = randomUUID();
  await main.page.evaluate(async ({ scope, runId }) => {
    window.__deliveryEvents = [];
    window.__deliveryCallback = window.__TAURI_INTERNALS__.transformCallback(({ payload }) => {
      if (payload.runId === runId && payload.sessionId === scope.sessionId) window.__deliveryEvents.push(payload);
    }, false);
    window.__deliveryListener = await window.__TAURI_INTERNALS__.invoke("plugin:event|listen",
      { event: "coauthor-progress", target: { kind: "Any" }, handler: window.__deliveryCallback });
  }, { scope, runId });
  let result;
  try {
    const task = invoke(main, "run_coauthor", { input: {
      scope, runId, profileId: profile.id, message, expectedDocumentVersion: before.document.version,
      selection: null, allowDraftEdits: false, temperature: 0.2, maxOutputTokens: 2048,
    } });
    if (name === "cancel") {
      await until(() => Promise.resolve(requests), (count) => count === 1, "in-flight buffered delivery");
      await invoke(main, "cancel_coauthor_run", { scope, runId });
    }
    result = await task;
  } finally {
    await main.page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|unlisten",
        { event: "coauthor-progress", eventId: window.__deliveryListener });
      window.__TAURI_INTERNALS__.unregisterCallback(window.__deliveryCallback);
    });
  }
  const events = await main.page.evaluate(() => window.__deliveryEvents);
  const run = result.run;
  report.turns.push({ probe: name, requests, run, events });
  await writeFile(join(harness.artifacts, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(run.status, expectedStatus);
  assert.equal(requests, expectedRequests);
  assert.equal(run.audit.filter((event) => event.kind === "model_request").length, requests);
  assert(run.audit.filter((event) => event.kind === "model_request").every((event) => event.promptVersion === "coauthor-v24"));
  assert.deepEqual((await invoke(main, "get_coauthor_state", { scope })).document, before.document);
  assert.equal(snapshot(), original, "Delivery must not alter formal content or decisions.");
  assert.deepEqual(await invoke(main, "get_ai_task_preferences"), preferences);
  assert.deepEqual(await invoke(main, "get_ai_budget_settings"), feeBudget);
  const textEvents = events.filter((event) => event.kind === "text");
  if (expectedStatus === "COMPLETED") {
    assert.equal(textEvents.length, 1, "Only accepted final content may be published.");
    assert(run.output.startsWith(textEvents[0].content));
  } else {
    assert.equal(textEvents.length, 0, "Rejected text must not stream before validation.");
    assert(!run.output.includes("要不要继续"));
  }
  console.log(`${name}: ${run.status}, ${requests} localhost requests`);
  return run;
}

try {
  main = await harness.launch("isolated-state");
  server = createServer(async (request, res) => {
    report.httpRequests++;
    requests++;
    try {
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (probe === "cancel") return;
      const message = response(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        ...(probe === "seed" ? {} : { usage: { prompt_tokens: 100, completion_tokens: 30 } }),
      }));
    } catch (error) {
      console.error(error);
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  profile = await invoke(main, "upsert_model_profile", { input: {
    name: "Local delivery contract", provider: "OPEN_AI_COMPATIBLE", capability: "CHAT",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "synthetic-delivery",
    contextWindow: 131072, maxOutputTokens: 2048, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 15,
    retryLimit: 0, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, priceCurrency: "USD",
  } });
  await invoke(main, "save_model_secret", { profileId: profile.id, secret: "localhost-synthetic-only" });
  const seeded = await runNative("prepare_model_evaluation_projects", {
    COAUTHOR_EVAL_EXPORT_ROOT: join(harness.artifacts, "project-seed"),
    COAUTHOR_EVAL_CASES: "discover-existing", COAUTHOR_EVAL_SUITE: "fixed",
  });
  project = seeded.rows.find((row) => row.type === "project");
  scope = project.scope;
  await invoke(main, "open_project", { root: project.root });
  const preferences = await invoke(main, "get_ai_task_preferences");
  preferences.discussion = { ...preferences.discussion, profileId: profile.id, fallbackProfileId: null,
    prompt: { context: { inputTokenBudget: 32768 } }, maxOutputTokens: 2048 };
  await invoke(main, "save_ai_task_preferences", { preferences });
  report.executableSha256 = createHash("sha256")
    .update(await readFile(join(workspace, "target/debug/ainoveltools-desktop.exe"))).digest("hex");
  const seedRun = await run("seed", "请给出短方案，只在回复中试写。", "COMPLETED", 1);
  const seedUsageId = seedRun.audit.find((event) => event.kind === "model_request").usageId;
  const seedUsage = (await invoke(main, "list_ai_runs", { limit: 100 })).find((run) => run.id === seedUsageId);
  assert(seedUsage?.estimatedOutputTokens > 0, "Missing provider usage must still account for final tool arguments.");
  report.seedFallbackOutputTokens = seedUsage.estimatedOutputTokens;
  const messages = await invoke(main, "list_discussion_messages", { sessionId: scope.sessionId, limit: 16 });
  seedMessage = messages.find((message) => message.role === "ASSISTANT" && message.content === oldStory);
  assert(seedMessage, "Native assistant message identity must be recorded.");
  const repaired = await run("repair", "继续写，保留她将铜匣推回桌角，只给新增情节。", "COMPLETED", 3);
  assert.equal(report.turns.at(-1).events.find((event) => event.kind === "text").content, newStory);
  assert(repaired.output.startsWith(newStory));
  assert(!repaired.output.includes("要不要我接着写"));
  assert.equal(repaired.audit.filter((event) => event.kind === "reply_delivery_rejected").length, 2);
  await run("reprint", "请重贴整合全文。", "COMPLETED", 1);
  await run("changing-errors", "继续写。", "FAILED", 3);
  await run("missing-delivery", "继续写。", "FAILED", 3);
  const batch = await run("batch", "继续写。", "FAILED", 3);
  assert(batch.audit.filter((event) => event.kind === "tool").every((event) => event.result.executed === false));
  const changed = await run("rule-change", "讨论突破代价规则的改动提案，不修改资料。", "COMPLETED", 2);
  assert(changed.output.includes("待作者决定，未修改正式资料"));
  assert(changed.output.includes(ruleSource.revision));
  await run("cancel", "继续写。", "CANCELLED", 1);
  assert.equal(report.httpRequests, report.turns.reduce((count, turn) => count + turn.requests, 0));
  assert.equal(main.pageErrors.length, 0);
  report.status = "localProtocolVerifiedNotQuality";
} catch (error) {
  report.status = "failed";
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  try {
    if (profile && main) await invoke(main, "delete_model_secret", { profileId: profile.id });
  } catch (error) {
    report.status = "failed"; report.cleanupFailure = String(error); process.exitCode = 1;
  }
  try { await harness.cleanup(); }
  catch (error) { report.status = "failed"; report.cleanupFailure = String(error); process.exitCode = 1; }
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await writeFile(join(harness.artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Delivery evidence: ${harness.artifacts}, ${report.status}`);
}
