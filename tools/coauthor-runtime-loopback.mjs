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

function retrievalVariantTurn(context, prior, scenario) {
  const contract = scenario.nativeRetrievalContract;
  if (context.navigationCompacted) {
    for (const pointer of context.sourcePointers ?? []) {
      assert.equal(pointer.navigationOnly, true);
      assert.equal(pointer.sourceTextRetained, false);
      assert(!Object.hasOwn(pointer, "content"), "Compacted pointers must not retain original text.");
    }
  }
  const candidates = [
    ...(context.relevantSources?.hits ?? []), ...(context.supplementalSources?.result?.hits ?? []),
    ...(context.sourcePointers ?? []),
    ...prior.filter((result) => result.name === "search_sources").flatMap((result) => result.value.hits ?? []),
  ];
  const missing = contract.sources.filter((source) => !candidates.some((hit) => hit.title === source.title));
  if (missing.length) {
    assert.equal(contract.expectedFollowup.length, 0,
      "A weak-match variant must discover its companion before navigation is compacted.");
    assert(!prior.some((result) => result.name === "search_sources"),
      "An explicit requery must return the missing exact-named seed.");
    return tools([call("search_sources", { query: scenario.retrieval.query })]);
  }
  const calls = [];
  for (const expected of contract.sources) {
    const source = candidates.find((candidate) => candidate.title === expected.title);
    assert(source.key && source.revision);
    const reads = prior.filter((result) => result.name === "read_source"
      && result.value.key === source.key && result.value.revision === source.revision);
    assert(reads.every((read) => read.value.executed !== false && !Object.hasOwn(read.value, "error")
      && typeof read.value.content === "string"));
    if (reads.some((read) => read.value.content.includes(expected.requiredQuote))) continue;
    let offset = 0;
    let limit = 256;
    if (reads.length) {
      const total = reads[0].value.totalChars;
      assert(Number.isSafeInteger(total) && total > 256, "Original source length is required for a tail read.");
      offset = Math.max(0, total - 512);
      limit = 512;
      assert(!reads.some((read) => read.value.offset === offset),
        "The tail read must contain the frozen restrictions; do not loop until a fixture passes.");
    }
    assert.equal(typeof source.sourceReference, "string", "Every readable candidate needs a program reference.");
    calls.push(call("read_source", { reference: source.sourceReference, offset, limit }, calls.length));
  }
  return calls.length ? tools(calls) : text();
}

function scriptedTurn(body, { scenario } = {}) {
  const { context, request } = loopbackContext(body.messages);
  if (body.tools) {
    assert.equal(context.relevantDecisions?.decisionScope?.origin, "CURRENT_BRANCH_DISCUSSION");
    assert.equal(context.relevantDecisions.decisionScope.updatesFormalSources, false);
    assert.equal(context.relevantDecisions.decisionScope.impliesFormalSyncRequired, false);
    for (const message of context.historicalMessages ?? []) {
      if (message.role !== "ASSISTANT") continue;
      assert.equal(message.provenance?.origin, "PRIOR_ASSISTANT_OUTPUT");
      assert.equal(message.provenance.establishesRules, false);
      assert.equal(message.provenance.establishesAuthorDecision, false);
    }
  }
  for (const hit of [...(context.relevantSources?.hits ?? []), ...(context.semanticSources?.hits ?? []),
    ...(context.supplementalSources?.result?.hits ?? [])]) {
    if (body.tools || hit.provenance) {
      assert.equal(hit.provenance.origin, hit.kind === "MESSAGE" ? "CURRENT_BRANCH_HISTORY" : "PROJECT_SHARED");
      assert.equal(hit.provenance.isDiscussionDecision, false);
      assert.equal(hit.provenance.truthDeterminedByLocation, false);
    }
  }
  const prior = [...(context.checkAssessments ?? []).map((value) => ({ name: "record_check_result", value })),
    ...results(body.messages)];
  if (scenario?.nativeRetrievalContract) {
    assert(scenario.turns.some((turn) => turn.message === request), "Active variant and current request must agree.");
    return retrievalVariantTurn(context, prior, scenario);
  }
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
  if (request.includes("那套靠遗忘换力量的阶梯")) {
    const candidate = (context.supplementalSources?.result?.hits ?? context.sourcePointers ?? [])
      .find((source) => source.title === "突破代价规则");
    assert(candidate?.key && candidate?.revision, "Weak-match regression must retain the cost candidate identity.");
    if (context.navigationCompacted) {
      assert.equal(candidate.navigationOnly, true);
      assert.equal(candidate.sourceTextRetained, false);
      assert(!Object.hasOwn(candidate, "content"));
    }
    const read = prior.find((result) => result.name === "read_source"
      && result.value.key === candidate.key && result.value.revision === candidate.revision);
    if (!read) {
      const sources = [candidate, ...(context.relevantSources?.hits ?? context.sourcePointers ?? [])
        .filter((source) => source.title === "九曜境界体系")];
      return tools(sources.map((source, i) => call("read_source", {
        key: source.key, revision: source.revision, offset: 0, limit: 4000,
      }, i)));
    }
    assert.notEqual(read.value.executed, false);
    assert(read.value.content?.includes("普通术法") && read.value.content.includes("不得无条件恢复全部记忆"),
      "Candidate navigation cannot stand in for delivery of the exact original restrictions.");
    return text();
  }
  const source = context.relevantSources?.hits.find((s) => s.title === "九曜境界体系");
  if (!prior.length && source) return tools([call("read_source", {
    key: source.key, revision: source.revision, offset: 0, limit: 2000,
  })]);
  return text();
}

export function coauthorReviewTurn(body) {
  if (!body.tools?.some((tool) => tool.function.name === "review_reply")) return null;
  assert.deepEqual(body.tools.map((tool) => tool.function.name), ["review_reply"]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  const packet = JSON.parse(body.messages[1].content);
  assert.equal(packet.contentReview, true);
  assert.equal(packet.version, "coauthor-review-v3");
  assert(packet.candidate && packet.bases.some((basis) => basis.id === "request"));
  assert(!body.messages.some((message) => message.tool_calls || message.role === "tool"));
  assert(packet.riskReasons.includes("AUTHOR_REQUESTED"));
  assert(!Object.hasOwn(packet, "obligations") && !Object.hasOwn(packet, "localFindings"));
  return tools([call("review_reply", { decision: "PASS", issues: [],
    summary: "本机固定通过只验证复核协议，不作为语义质量证据。" })]);
}

export function coauthorLoopbackTurn(body, options = {}) {
  const review = coauthorReviewTurn(body);
  if (review) return review;
  const message = scriptedTurn(body, options);
  const readsByReference = body.tools?.some((tool) => tool.function.name === "read_source"
    && tool.function.parameters.required.includes("reference"));
  if (readsByReference && message.tool_calls) {
    const { context } = loopbackContext(body.messages);
    const prior = results(body.messages);
    const candidates = [
      ...(context.relevantSources?.hits ?? []), ...(context.semanticSources?.hits ?? []),
      ...(context.supplementalSources?.result?.hits ?? []), ...(context.sourcePointers ?? []),
      ...prior.flatMap((result) => [...(result.value.hits ?? []), result.value]),
    ];
    for (const item of message.tool_calls.filter((item) => item.function.name === "read_source")) {
      const args = JSON.parse(item.function.arguments);
      const source = candidates.find((candidate) => typeof candidate.sourceReference === "string"
        && (typeof args.reference === "string" ? candidate.sourceReference === args.reference
          : candidate.key === args.key && candidate.revision === args.revision));
      assert(source, "Reference reads must use an actual delivered candidate, never the frozen export identity.");
      item.function.arguments = JSON.stringify({ reference: source.sourceReference,
        ...(Object.hasOwn(args, "offset") ? { offset: args.offset } : {}),
        ...(Object.hasOwn(args, "limit") ? { limit: args.limit } : {}) });
    }
  }
  if (!message.content || !body.tools?.some((tool) => tool.function.name === "deliver_reply")) return message;
  const prior = results(body.messages);
  if (prior.some((result) => result.value.executed !== false
    && (result.name === "edit_draft" || ["start_source_check", "read_check_source",
      "record_check_result", "save_check_note"].includes(result.name)))) return message;
  return tools([call("deliver_reply", { mode: "DISCUSSION", content: message.content,
    requestQuote: null, continuation: null, ruleChanges: [] })]);
}

export function assertLoopbackRegression(entry, { expectInputLimit = false, expectLateExpansion = false } = {}) {
  if (entry.promptVersions) assert(entry.promptVersions.every((version) => version === "coauthor-v32"));
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
  if (expectLateExpansion) {
    assert.equal(expansions.length, 1);
    const before = entry.audit.slice(0, entry.audit.findIndex((event) => event.kind === "input_budget_expansion"));
    assert(before.some((event) => event.kind === "model_request"),
      "Late expansion must follow an already sent model request.");
    assert(before.some((event) => event.kind === "tool" && event.name === "start_source_check"
      && event.result?.check?.id && event.result.executed !== false),
    "Late expansion must preserve an already established native check.");
  }
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
  if (entry.suite === "n2-retrieval" || entry.caseId?.startsWith("n2-")) {
    assert.equal(entry.suite, "n2-retrieval");
    const contract = entry.nativeRetrievalContract;
    assert(contract?.sources?.length, "N2 native regression requires the frozen retrieval contract.");
    const primary = entry.audit.find((event) => event.kind === "initial_search")?.result;
    const supplemental = entry.audit.find((event) => event.kind === "local_source_followup")?.result;
    assert.equal(primary?.execution, "RETURNED_PAGE");
    assert.deepEqual(primary.hits.map((hit) => hit.key).sort(), [...contract.initialKeys].sort());
    assert.deepEqual((supplemental?.result?.hits ?? []).map((hit) => hit.key).sort(), [...contract.followupKeys].sort());
    if (!contract.followupKeys.length) {
      assert.equal(supplemental?.execution, "NOT_RUN", "Exact naming must not force an automatic followup.");
      assert(!Object.hasOwn(supplemental, "error") && !Object.hasOwn(supplemental, "result"));
    } else {
      assert.equal(supplemental?.result?.execution, "RETURNED_PAGE");
      assert(!Object.hasOwn(supplemental, "error"));
    }
    const discovered = [...primary.hits, ...(supplemental?.result?.hits ?? [])];
    for (const expected of contract.sources) {
      const source = discovered.find((hit) => hit.key === expected.key);
      assert(source?.revision && source.title === expected.title);
      const index = entry.audit.findIndex((event) => event.kind === "tool" && event.name === "read_source"
        && event.result?.executed !== false && !Object.hasOwn(event.result ?? {}, "error") && event.result?.key === source.key
        && event.result?.revision === source.revision && event.result?.content?.includes(expected.requiredQuote));
      assert(index >= 0, "Frozen restrictions must occur in a successful original read, not a candidate excerpt.");
      const read = entry.audit[index].result;
      const later = entry.audit.slice(index + 1);
      assert(later.some((event, deliveryIndex) => event.kind === "source_delivery"
        && event.transportAcknowledged === true && event.understandingVerified === false
        && later.slice(0, deliveryIndex).some((request) => request.kind === "model_request"
          && request.round === event.round)
        && event.sources.some((delivered) => delivered.key === source.key && delivered.revision === source.revision
          && delivered.offset === read.offset && delivered.chars === [...read.content].length)),
      "An exact source, revision, offset and character count must have acknowledged delivery.");
      if (entry.caseId === "n2-long-tail") {
        assert(read.offset > 0, "The long-tail regression must actually deliver a later original range.");
      }
    }
    assert(!entry.audit.some((event) => event.kind === "tool" && event.name === "read_source"
      && event.result?.executed !== false && !contract.sources.some((source) => source.key === event.result?.key)),
    "The irrelevant warehouse must not be read as a rule.");
  }
  if (entry.caseId === "semantic-paraphrase") {
    const primary = entry.audit.find((event) => event.kind === "initial_search")?.result;
    const supplemental = entry.audit.find((event) => event.kind === "local_source_followup")?.result;
    assert.equal(primary?.hits?.length, 1, "Initial retrieval must not be silently replaced with combined coverage.");
    assert.equal(supplemental?.result?.hits?.length, 1);
    const candidate = supplemental.result.hits[0];
    assert.equal(candidate.title, "突破代价规则");
    for (const source of [primary.hits[0], candidate]) {
      const readIndex = entry.audit.findIndex((event) => event.kind === "tool" && event.name === "read_source"
        && event.result.key === source.key && event.result.revision === source.revision
        && event.result.executed !== false && typeof event.result.content === "string"
        && (source === candidate
          ? event.result.content.includes("不得无条件恢复全部记忆") && event.result.content.includes("普通术法")
          : event.result.content.includes("灯芯只能用一次") && event.result.content.includes("不消耗寿元")));
      assert(readIndex >= 0, "Both key sources must actually be read at the exact revision.");
      assert(entry.audit.slice(readIndex + 1).some((event) => event.kind === "source_delivery"
        && event.transportAcknowledged === true && event.understandingVerified === false
        && event.sources.some((delivered) => delivered.key === source.key && delivered.revision === source.revision
          && delivered.chars > 0)), "A tool read without subsequent acknowledged delivery is not sufficient.");
    }
  }
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
    assert(receipt.displayText?.includes("关键词 \"契约 交易 代价 术法\"（项目资料，offset=0）：实际返回 4 条"));
    assert(receipt.displayText?.includes("关键词 \"砂\"（项目资料，offset=0）：未形成有效查询，不能记为 0 命中"));
    assert(!entry.output.includes("检索操作回执（程序记录"), "Program search receipts belong to audit, not the reply.");
  }
  return { scriptedNativeRegression: true, qualityVerified: false,
    ...(expectLateExpansion ? { lateExpansionVerified: true } : {}) };
}
