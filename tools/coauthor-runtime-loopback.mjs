import assert from "node:assert/strict";

function call(name, args, index = 0) {
  return { id: `regression-${name}-${index}`, type: "function",
    function: { name, arguments: JSON.stringify(args) } };
}

function tools(calls) {
  return { role: "assistant", content: "", tool_calls: calls };
}

function text(content = "本地模拟回复，仅验证原生执行链路，不用于创作质量评分。") {
  return { role: "assistant", content };
}

export function loopbackContext(messages) {
  const contexts = messages.filter((m) => m.role === "user").flatMap((m) => {
    try {
      const value = JSON.parse(m.content);
      return value?.contextOnly || value?.relevantSources ? [value] : [];
    } catch { return []; }
  });
  assert.equal(contexts.length, 1, "Exactly one explicit reference context is required.");
  const context = contexts[0];
  const latest = messages.filter((m) => m.role === "user").at(-1).content;
  assert.equal(context.contextOnly, true, "Historical data must be marked reference-only.");
  assert(!Object.hasOwn(context, "request"), "Current request must not be buried in JSON.");
  assert(messages.filter((m) => m.role === "user").length === 2,
    "Historical messages must not be replayed as current user roles.");
  return { context, request: latest };
}

function results(messages) {
  const calls = new Map(messages.flatMap((m) => m.tool_calls ?? []).map((c) => [c.id, c]));
  return messages.filter((m) => m.role === "tool").map((m) => ({
    ...calls.get(m.tool_call_id)?.function, value: JSON.parse(m.content),
  }));
}

function fullCheck(prior) {
  const pages = prior.filter((r) => ["start_source_check", "get_source_checks"].includes(r.name));
  if (!pages.length) return tools([call("start_source_check", {
    title: "本地回归完整查证", query: "突破代价相关、无关和未决依据", kinds: ["ENTITY"],
  })]);
  const page = pages.at(-1).value;
  assert.equal(page.entries.length, 6, "Regression uses exactly six synthetic cards.");
  const checkId = page.check.id;
  const reads = prior.filter((r) => r.name === "read_check_source");
  const recorded = new Set(prior.filter((r) => r.name === "record_check_result" && r.value.recorded)
    .map((r) => r.value.entry.key));
  if (recorded.size === page.entries.length) {
    return text("故意错误的查证收尾：无未完成项，全部疑点已解决，已修复全书；语义和查证索引待更新均为999。");
  }
  if (!reads.length) return tools(page.entries.filter((entry) => !recorded.has(entry.key)).map((entry, i) =>
    call("read_check_source", { checkId, key: entry.key, offset: 0, limit: 4000 }, i)));
  const failureIndex = prior.findIndex((r) => r.name === "record_check_result" && r.value.executed === false);
  if (failureIndex >= 0 && !prior.slice(failureIndex + 1).some((r) => r.name === "get_source_checks")) {
    const recovery = prior[failureIndex].value.recovery;
    assert.equal(recovery.tool, "get_source_checks");
    return tools([call(recovery.tool, recovery.arguments, 10)]);
  }
  const pending = page.entries.filter((entry) => !recorded.has(entry.key));
  if (!pending.length) return text();
  return tools(pending.map((entry, i) => {
    const read = reads.find((r) => r.value.key === entry.key).value;
    assert.equal(typeof read.content, "string", "Unassessed source must not be compacted.");
    const relevant = ["九曜境界体系", "突破代价规则"].includes(entry.title);
    const uncertain = entry.title === "北港宗门旧抄本";
    return call("record_check_result", {
      checkId, key: entry.key,
      revision: entry.revision + (failureIndex < 0 && i === 0 ? "-intentional-typo" : ""),
      assessment: relevant ? "RELEVANT" : uncertain ? "UNCERTAIN" : "IRRELEVANT",
      reason: uncertain ? "原文明确真伪未定，不能视为已证实的抄写错误。" : relevant
        ? "该卡明确描述突破代价。" : "该卡不提供有效的突破代价规则；不据此推断地域规则。",
      quote: uncertain ? "尚未确定真伪" : relevant ? "突破" : "",
    }, failureIndex < 0 ? i : 20 + i);
  }));
}

export function coauthorLoopbackTurn(body) {
  const { context, request } = loopbackContext(body.messages);
  if (body.tools) {
    assert.equal(context.relevantDecisions?.decisionScope?.origin, "CURRENT_BRANCH_DISCUSSION");
    assert.equal(context.relevantDecisions.decisionScope.updatesFormalSources, false);
    assert.equal(context.relevantDecisions.decisionScope.impliesFormalSyncRequired, false);
  }
  for (const hit of [...(context.relevantSources?.hits ?? []), ...(context.semanticSources?.hits ?? [])]) {
    if (body.tools || hit.provenance) {
      assert.equal(hit.provenance.origin, hit.kind === "MESSAGE" ? "CURRENT_BRANCH_HISTORY" : "PROJECT_SHARED");
      assert.equal(hit.provenance.isDiscussionDecision, false);
      assert.equal(hit.provenance.truthDeterminedByLocation, false);
    }
  }
  const prior = [...(context.checkAssessments ?? []).map((value) => ({ name: "record_check_result", value })),
    ...results(body.messages)];
  if (request.includes("完整查证全部设定卡")) return fullCheck(prior);
  if (request.includes("有没有设定过星砂契约")) {
    if (!prior.some((r) => r.name === "search_sources")) {
      return tools([call("search_sources", { query: "星砂契约" }, 0),
        call("search_sources", { query: "契约 交易 代价 术法" }, 1),
        call("search_sources", { query: "砂" }, 2)]);
    }
    return text();
  }
  if (request.includes("继续按之前定的突破代价")) {
    assert(context.relevantDecisions.memories.some((memory) => memory.decision.version === 2
      && memory.decision.status === "CHOSEN" && memory.decision.content.includes("承诺")));
    assert(body.messages.at(-1).role !== "user" || body.messages.at(-1).content === request);
  }
  if (request.includes("只把工作稿第一句改成")) {
    if (!prior.length) return tools([call("read_draft", { offset: 0, limit: 4000 })]);
    if (!prior.some((r) => r.name === "edit_draft")) {
      return tools([call("edit_draft", { operation: "replace",
        before: "结曜之后尚未确定。", after: "结曜之后为归灯境。" })]);
    }
    // Deliberately wrong prose must never become the persisted edit receipt.
    return text("归灯境之后为归灯境。第一句已改好，采用后会自动同步设定卡。");
  }
  const source = context.relevantSources?.hits.find((s) => s.title === "九曜境界体系");
  if (!prior.length && source) return tools([call("read_source", {
    key: source.key, revision: source.revision, offset: 0, limit: 2000,
  })]);
  return text();
}

export function assertLoopbackRegression(entry, { expectInputLimit = false } = {}) {
  if (entry.promptVersions) assert(entry.promptVersions.every((version) => version === "coauthor-v20"));
  const setup = entry.audit?.find((a) => a.kind === "input_budget");
  let currentBudget = setup?.initialInputTokenBudget;
  let expanded = false;
  const expansions = entry.audit?.filter((a) => a.kind === "input_budget_expansion") ?? [];
  for (const event of entry.audit ?? []) {
    if (event.kind === "context_compaction" && event.stage === "assessed_sources") {
      assert(event.afterEstimatedInputTokens <= event.beforeEstimatedInputTokens,
        "Replacing an assessed source must not increase serialized input tokens.");
    }
  }
  assert(expansions.length <= 1, "A run may expand its input budget only once.");
  for (const request of entry.audit ?? []) {
    if (request.kind === "input_budget_expansion") {
      assert(setup, "Expansion must retain the initial budget policy.");
      assert.equal(request.previousInputTokenBudget, currentBudget);
      assert.equal(request.inputTokenBudget, setup.maxInputTokenBudget);
      assert(request.inputTokenBudget > currentBudget && request.inputTokenBudget <= currentBudget * 2);
      assert(request.inputTokenBudget <= 65536);
      assert.equal(request.configurationPersisted, false);
      assert.equal(request.taskRestarted, false);
      currentBudget = request.inputTokenBudget;
      expanded = true;
    }
    if (request.kind !== "model_request") continue;
    assert(Number.isSafeInteger(request.estimatedInputTokens) && request.estimatedInputTokens > 0);
    assert(Number.isSafeInteger(request.inputTokenBudget) && request.inputTokenBudget > 0);
    assert(request.estimatedInputTokens <= request.inputTokenBudget,
      "Every request must fit the estimated token budget, not a character ceiling.");
    if (setup) {
      assert.equal(request.inputTokenBudget, currentBudget);
      assert.equal(request.initialInputTokenBudget, setup.initialInputTokenBudget);
      assert.equal(request.inputBudgetExpanded, expanded);
    }
  }
  if (expectInputLimit) {
    assert.equal(entry.status, "LIMIT_REACHED", "This regression must stop at the initial input check.");
    assert.equal(entry.modelRequests, 0, "An oversized first request must not reach the provider.");
    assert.equal(expansions.length, 1);
    const limit = entry.audit.find((a) => a.kind === "budget_limit");
    assert.equal(limit?.reason, "INPUT_TOKEN_BUDGET");
    assert.equal(limit?.inputTokenBudget, currentBudget);
    assert.equal(limit?.modelRequestsSent, 0);
    assert(limit.estimatedInputTokens > currentBudget);
    assert(entry.output.includes("尚未发送模型请求"));
    assert(entry.output.includes("仍然不足，不再自动扩容"));
    return { scriptedNativeRegression: true, qualityVerified: false, expectedInputLimit: true };
  }
  assert.equal(entry.status, "COMPLETED", "Scripted native regression must finish.");
  if (entry.caseId === "extend-confirmed" && entry.turnIndex === 1) {
    assert(entry.output.includes("结曜之后为归灯境。守灯人例外仍然有效。"));
    assert(!entry.output.includes("归灯境之后为归灯境"));
    assert(!entry.output.includes("采用后会自动同步"));
    assert(entry.output.includes("尚未采用或正式提交"));
  }
  if (entry.caseId === "full-source-check") {
    assert.equal(entry.audit.filter((a) => a.kind === "tool" && a.name === "start_source_check").length, 1,
      "Budget expansion must not restart the source check.");
    assert.equal(entry.audit.filter((a) => a.kind === "tool" && a.name === "read_check_source").length, 6,
      "Budget expansion must not replay already executed reads.");
    const summary = entry.audit.find((a) => a.kind === "check_summary");
    assert.equal(summary.check.read, 6);
    assert.equal(summary.check.sent, 6);
    assert.equal(summary.check.reviewed, 6);
    assert.equal(summary.check.relevant, 2);
    assert.equal(summary.check.uncertain, 1);
    assert.equal(summary.check.complete, false, "Uncertainty must not be papered over.");
    assert.equal(entry.toolErrors, 1, "One intentional revision typo must be rejected.");
    assert(entry.audit.some((a) => a.kind === "context_compaction" && a.stage === "assessed_sources"));
    for (const label of ["相关：", "无关：", "不确定：", "未判断 0"]) assert(entry.output.includes(label));
    assert(entry.output.includes("各项均已完成读取、送达与判断；仍有 1 项不确定"));
    assert(entry.output.includes("范围仅限 ENTITY"));
    assert(!entry.output.includes("无未完成项"));
    assert(!entry.output.includes("已修复全书；"));
    assert(entry.audit.some((a) => a.kind === "model_check_analysis"
      && a.content.includes("故意错误的查证收尾") && a.displayedAsReceipt === false),
    "Incorrect model wording must stay auditable, not become the check receipt.");
    assert(entry.audit.some((a) => a.kind === "retrieval_summary"));
  }
  if (entry.caseId === "absent-not-absolute") {
    const receipt = entry.audit.find((a) => a.kind === "retrieval_summary");
    assert(receipt, "Native search operations must have a deterministic receipt.");
    const specific = receipt.receipts.find((r) => r.query === "星砂契约" && r.method === "KEYWORD"
      && r.status === "RETURNED_PAGE" && r.returned === 0);
    const broad = receipt.receipts.find((r) => r.query === "契约 交易 代价 术法" && r.method === "KEYWORD");
    const invalid = receipt.receipts.find((r) => r.query === "砂" && r.method === "KEYWORD");
    assert(specific && broad?.status === "RETURNED_PAGE" && broad.returned === 4,
      "Valid empty and nonempty pages must retain separate counts.");
    assert(invalid?.status === "INVALID_QUERY" && invalid.returned === null,
      "An invalid query must not be counted as an executed zero-hit page.");
    assert(entry.output.includes("关键词 \"契约 交易 代价 术法\"（项目资料，offset=0）：实际返回 4 条"));
    assert(entry.output.includes("关键词 \"砂\"（项目资料，offset=0）：未形成有效查询，不能记为 0 命中"));
  }
  return { scriptedNativeRegression: true, qualityVerified: false };
}
