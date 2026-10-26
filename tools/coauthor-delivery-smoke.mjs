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
const deliver = (args) => tools(call("deliver_reply", {
  requestQuote: null, continuation: null, ruleChanges: [], ...args,
}));
const plain = (content) => ({ role: "assistant", content });
const continuation = (content) => ({
  mode: "CONTINUATION", content, requestQuote: "继续写",
  continuation: { messageId: seedMessage.id, anchor: "她坐着，没有起身。",
    preservedQuotes: ["她将铜匣推回桌角"] },
});

function response(body) {
  const { context } = loopbackContext(body.messages);
  assert(body.tools.some((tool) => tool.function.name === "deliver_reply"));
  assert.equal(body.tool_choice, "required");
  const schema = body.tools.find((tool) => tool.function.name === "deliver_reply").function.parameters;
  for (const field of ["requestQuote", "continuation", "ruleChanges"]) assert(schema.required.includes(field));
  if (probe === "seed") return deliver({ mode: "DISCUSSION", content: oldStory });
  if (["program-reference", "v25-metadata-recovery", "v25-unchanged-retry"].includes(probe)) {
    const original = context.historicalMessages.find((message) => message.id === seedMessage.id);
    assert(original?.continuationReference, "The actual supplied AI entry must carry a program reference.");
    assert(!context.historicalMessages.some((message) => message.role === "USER" && message.continuationReference));
    const args = {
      mode: "CONTINUATION", content: newStory, requestQuote: "继续写",
      continuation: { reference: original.continuationReference, preservedQuotes: ["她将铜匣推回桌角。"] },
    };
    if (probe === "program-reference") return deliver(args);
    if (requests === 1) {
      const user = context.historicalMessages.find((message) => message.role === "USER");
      assert(user);
      return deliver({ ...continuation(oldStory + "\n窗外来了新的人。"),
        continuation: { messageId: user.id, anchor: "继续写，保留她将铜匣推回桌角这句",
          preservedQuotes: ["她将铜匣推回桌角。"] } });
    }
    const rejected = JSON.parse(body.messages.filter((message) => message.role === "tool").at(-1).content);
    assert.equal(rejected.recovery.action, "REGENERATE_CONTENT");
    assert.equal(rejected.recovery.contentMustChange, true);
    assert.equal([...rejected.recovery.repeatedExcerpt].length, 80);
    assert(rejected.recovery.preserveQuotes.some((quote) => quote.includes("她将铜匣推回桌角")));
    const previousCall = body.messages.filter((message) => message.tool_calls).at(-1).tool_calls[0];
    assert(!JSON.parse(previousCall.function.arguments).content.includes("只是心里没有动静"));
    if (probe === "v25-unchanged-retry" && requests === 2) args.content = oldStory + "\n窗外来了新的人。";
    return deliver(args);
  }
  if (probe === "read-reference") {
    if (requests === 1) return tools(call("search_sources", { query: "她将铜匣推回桌角", history: true }));
    const outputs = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
    const read = outputs.find((result) => result.kind === "MESSAGE" && result.content?.startsWith("历史发言 [ASSISTANT]"));
    if (!read) {
      const hit = outputs.flatMap((result) => result.hits ?? []).find((hit) => hit.key === `MESSAGE:${seedMessage.id}`);
      assert(hit, "Only a real search result supplies the historical source revision.");
      return tools(call("read_source", { key: hit.key, revision: hit.revision, offset: 0, limit: 4000 }));
    }
    assert(read.continuationReference?.startsWith("read-"));
    return deliver({ mode: "CONTINUATION", content: newStory, requestQuote: "继续写",
      continuation: { reference: read.continuationReference, preservedQuotes: ["她将铜匣推回桌角。"] } });
  }
  if (probe === "unknown-reference") {
    return deliver({ mode: "CONTINUATION", content: newStory, requestQuote: "继续写",
      continuation: { reference: "not-issued", preservedQuotes: [] } });
  }
  if (probe === "missing-preserved-quote") {
    const original = context.historicalMessages.find((message) => message.id === seedMessage.id);
    assert(original?.continuationReference);
    assert.deepEqual(context.requiredPreservedQuotes, ["她将铜匣推回桌角。"]);
    const args = {
      mode: "CONTINUATION", content: newStory, requestQuote: "继续写",
      continuation: { reference: original.continuationReference, preservedQuotes: ["她将铜匣推回桌角。"] },
    };
    if (requests === 1) return deliver({ ...args, content: newStory.replace("她将铜匣推回桌角。", "") });
    const last = JSON.parse(body.messages.filter((message) => message.role === "tool").at(-1).content);
    assert.equal(last.recovery.action, "REPAIR_CONTENT");
    assert.equal(last.recovery.contentMustChange, true);
    assert.equal(last.recovery.discardRejectedContent, false);
    assert.deepEqual(last.recovery.missingPreservedQuotes, ["她将铜匣推回桌角。"]);
    const previousCall = body.messages.filter((message) => message.tool_calls).at(-1).tool_calls[0];
    assert(JSON.parse(previousCall.function.arguments).content.includes("窗纸上多了一道影子"));
    return deliver(args);
  }
  if (["source-reference", "source-version-recovery", "source-no-progress", "unknown-source-reference"].includes(probe)) {
    const schema = body.tools.find((tool) => tool.function.name === "read_source").function.parameters;
    assert.deepEqual(schema.required, ["reference"]);
    assert(!Object.hasOwn(schema.properties, "revision") && !Object.hasOwn(schema.properties, "key"));
    if (probe === "unknown-source-reference") return tools(call("read_source", { reference: "not-issued" }));
    ruleSource = context.relevantSources.hits.find((source) => source.title === "九曜境界体系");
    assert(ruleSource?.sourceReference && ruleSource.revision);
    const prior = body.messages.filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content));
    if (probe === "source-no-progress") {
      if (requests === 2) return tools(call("search_sources", { query: "九曜境界体系" }));
      if (requests === 4) return tools(call("get_decisions", { query: "境界" }));
      assert([1, 3, 5].includes(requests));
      if (requests > 1) assert(prior.some((result) => result.errorCode === "SOURCE_VERSION_MISMATCH"));
      return tools(call("read_source", { key: ruleSource.key, revision: ruleSource.revision + "-copy-error" }));
    }
    if (probe === "source-version-recovery" && requests === 1) {
      return tools(call("read_source", { key: ruleSource.key, revision: ruleSource.revision + "-copy-error" }));
    }
    if (!prior.some((result) => result.key === ruleSource.key && result.content && !result.error)) {
      const rejected = prior.find((result) => result.errorCode === "SOURCE_VERSION_MISMATCH");
      if (probe === "source-version-recovery") {
        assert(rejected);
        assert(!rejected.error.includes("已经变化"));
        assert(rejected.recovery.sourceReferences.some((source) => source.reference === ruleSource.sourceReference));
      }
      return tools(call("read_source", { reference: ruleSource.sourceReference, offset: 0, limit: 4000 }));
    }
    return deliver({ mode: "DISCUSSION", content: "只核对本地原文读取和版本恢复，不作为真实模型质量证据。" });
  }
  if (probe === "repair") {
    assert(context.historicalMessages.some((message) => message.id === seedMessage.id));
    if (requests === 1) return plain(oldStory + "\n要不要我接着写？");
    if (requests === 2) return deliver(continuation(oldStory + "\n要不要我接着写？"));
    assert.equal(requests, 3);
    assert(body.messages.some((message) => message.role === "tool" && JSON.parse(message.content).error?.includes("连续80字")));
    return deliver(continuation(newStory));
  }
  if (probe === "reprint") return deliver({ mode: "REPRINT", content: oldStory, requestQuote: "重贴整合全文" });
  if (probe === "v24-parameters") {
    if (requests === 1) return deliver({ mode: "CONTINUATION", content: newStory });
    assert.equal(requests, 2);
    const error = JSON.parse(body.messages.filter((message) => message.role === "tool").at(-1).content).error;
    assert(error.includes("requestQuote") && error.includes("continuation.messageId"));
    const args = continuation(newStory);
    args.continuation.preservedQuotes = ["她将铜匣推回桌角。"];
    return deliver(args);
  }
  if (probe === "v24-preservation") {
    if (requests === 1) return deliver(continuation(oldStory + "\n新来的人递进一封信。"));
    if (requests === 2) {
      const args = continuation(oldStory.replace("她将铜匣推回桌角。", "") + "\n新来的人递进一封信。");
      args.continuation.preservedQuotes = [];
      return deliver(args);
    }
    assert.equal(requests, 3);
    const error = JSON.parse(body.messages.filter((message) => message.role === "tool").at(-1).content).error;
    assert(error.includes("缺少作者明确要求保留") && error.includes("连续80字"));
    return deliver(continuation(newStory));
  }
  if (probe === "changing-errors") {
    if (requests === 1) return deliver({ mode: "DISCUSSION", content: "" });
    if (requests === 2) return deliver({ mode: "REPRINT", content: "伪造授权", requestQuote: "重贴整合全文" });
    return deliver({ mode: "CONTINUATION", content: "缺少承接点", requestQuote: "继续写" });
  }
  if (probe === "missing-delivery") return plain("这不是已交付回复，要不要继续？");
  if (probe === "batch") return tools(call("deliver_reply", { mode: "DISCUSSION", content: "不能抢先完成", ruleChanges: [] }),
    call("record_decision", { expectedVersion: 0, topic: "不应执行", content: "继续写", quote: "继续写", status: "CHOSEN" }, 1));
  if (probe === "rule-change" || probe === "explicit-change") {
    if (requests === 1) {
      ruleSource = context.relevantSources.hits.find((source) => source.title === "突破代价规则");
      assert(ruleSource);
      return tools(call("read_source", { key: ruleSource.key, revision: ruleSource.revision }));
    }
    const read = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content))
      .find((result) => result.key === ruleSource.key);
    assert(read?.content.includes("普通术法"));
    if (probe === "explicit-change" && requests === 2) {
      return deliver({ mode: "DISCUSSION", content: "这是改规则。可以改用新的恢复机制。" });
    }
    if (probe === "explicit-change") {
      assert.equal(requests, 3);
      assert(body.messages.some((message) => message.role === "tool"
        && JSON.parse(message.content).error?.includes("ruleChanges为空")));
    }
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
  assert(run.audit.filter((event) => event.kind === "model_request").every((event) => event.promptVersion === "coauthor-v27"));
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
  await run("v24-parameters", "继续写，保留她将铜匣推回桌角这句，只给新增情节。", "COMPLETED", 2);
  await run("v24-preservation", "继续写，保留她将铜匣推回桌角这句，只给新增情节。", "COMPLETED", 3);
  await run("changing-errors", "继续写。", "FAILED", 3);
  await run("missing-delivery", "继续写。", "FAILED", 3);
  const batch = await run("batch", "继续写。", "FAILED", 3);
  assert(batch.audit.filter((event) => event.kind === "tool").every((event) => event.result.executed === false));
  const changed = await run("rule-change", "讨论突破代价规则的改动提案，不修改资料。", "COMPLETED", 2);
  assert(changed.output.includes("待作者决定，未修改正式资料"));
  assert(changed.output.includes(ruleSource.revision));
  await run("explicit-change", "讨论突破代价规则的改动提案，不修改资料。", "COMPLETED", 3);
  for (const [name, count] of [["program-reference", 1], ["v25-metadata-recovery", 2],
    ["v25-unchanged-retry", 3], ["missing-preserved-quote", 2]]) {
    const session = await invoke(main, "create_discussion_session", {
      title: name, scopeKind: "PROJECT", scopeId: null, scopeText: null,
      topicKind: null, linkedEntityId: null,
    });
    scope = { ...scope, sessionId: session.id };
    await run("seed", "请给出短方案，只在回复中试写。", "COMPLETED", 1);
    const current = await invoke(main, "list_discussion_messages", { sessionId: scope.sessionId, limit: 16 });
    seedMessage = current.filter((message) => message.role === "ASSISTANT" && message.content === oldStory)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    assert(seedMessage);
    const result = await run(name, "继续写，保留她将铜匣推回桌角这句，只给新增情节。", "COMPLETED", count);
    if (name === "v25-metadata-recovery") {
      assert.equal(result.audit.filter((event) => event.kind === "reply_recovery_context").length, 1);
      assert(result.audit.some((event) => event.name === "deliver_reply"
        && JSON.parse(event.arguments).content.includes("只是心里没有动静")));
    }
    if (name === "missing-preserved-quote") {
      assert(!result.audit.some((event) => event.kind === "reply_recovery_context"));
    }
  }
  await run("read-reference", "继续写，保留她将铜匣推回桌角这句，只给新增情节。", "COMPLETED", 3);
  await run("unknown-reference", "继续写。", "FAILED", 3);
  for (const [name, status, count] of [
    ["source-reference", "COMPLETED", 2], ["source-version-recovery", "COMPLETED", 3],
    ["source-no-progress", "FAILED", 5], ["unknown-source-reference", "FAILED", 3],
  ]) {
    const result = await run(name, "核对九曜境界体系原文，只讨论。", status, count);
    const reads = result.audit.filter((event) => event.name === "read_source");
    if (name === "source-reference" || name === "source-version-recovery") {
      const read = reads.find((event) => event.result?.content);
      assert(read);
      assert.deepEqual(read.resolvedSource, { key: ruleSource.key, revision: ruleSource.revision, offset: 0, limit: 4000 });
      assert(JSON.parse(read.arguments).reference, "Audit must retain the actual model reference, not replace it with canonical args.");
      assert(result.audit.some((event) => event.kind === "source_delivery"
        && event.sources.some((source) => source.key === ruleSource.key && source.revision === ruleSource.revision)));
    }
    if (name === "source-no-progress") {
      assert.equal(reads.filter((event) => event.result.errorCode === "SOURCE_VERSION_MISMATCH").length, 3);
      assert(result.audit.some((event) => event.kind === "tool_recovery_limit"
        && event.reason === "SOURCE_NO_PROGRESS" && event.interleavingResets === false));
    }
    if (name === "unknown-source-reference") {
      assert(reads.every((event) => event.result.executed === false && !event.result.content && !event.resolvedSource));
    }
  }
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
