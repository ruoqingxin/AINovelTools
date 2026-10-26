import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assessReview, distribution, loadFixture, nativeRows, percentile, reserveCost,
  retrievalScore, reviewTemplate, summarizeBaseline, validateCloudOptions, writeReport } from "./coauthor-evaluation-core.mjs";
import { workspace } from "./desktop-smoke-runtime.mjs";
import { createBudgetLedger, createBudgetRelay, responseUsage } from "./coauthor-evaluation-budget.mjs";
import { loopbackContext, coauthorLoopbackTurn, assertLoopbackRegression } from "./coauthor-runtime-loopback.mjs";

const cloudProfile = { capability: "CHAT", privacy_level: "ALLOW_CLOUD", secret_ref: "synthetic",
  base_url: "https://example.invalid/v1", model_id: "synthetic-test", price_currency: "CNY",
  context_window: 1_000_000, max_output_tokens: 384_000,
  input_price_micros_per_million: 2_000_000, output_price_micros_per_million: 8_000_000 };

test("request budget settles actual conservative usage instead of reserving all 150 requests", () => {
  const ledger = createBudgetLedger(cloudProfile, "CNY", 10_000_000, 150);
  assert.equal(ledger.snapshot().requestReserveMicros, 2_016_384);
  for (let i = 0; i < 150; i++) {
    ledger.settle(ledger.reserve(), { prompt_tokens: 1000, completion_tokens: 500 }, 200);
  }
  assert.equal(ledger.snapshot().conservativeSpentMicros, 900_000);
  assert.throws(() => ledger.reserve(), /exhausted/);
  assert.throws(() => ledger.settle(1, {}, 200), /repeated/);
});

test("unknown usage, failures and concurrent reservations never release reserved funds", () => {
  const ledger = createBudgetLedger(cloudProfile, "CNY", 4_032_768, 10);
  ledger.settle(ledger.reserve(), null, 200);
  const second = ledger.reserve();
  assert.equal(ledger.snapshot().conservativeSpentMicros, 4_032_768);
  ledger.settle(second, { prompt_tokens: 1, completion_tokens: 1 }, 500);
  assert.throws(() => ledger.reserve());
  assert.equal(ledger.snapshot().conservativeSpentMicros, 4_032_768);
  assert(ledger.snapshot().records.every((r) => r.state === "unknownUsageReserveHeld"));
  const excessive = createBudgetLedger(cloudProfile, "CNY", 10_000_000, 10);
  assert.throws(() => excessive.settle(excessive.reserve(),
    { prompt_tokens: 1_000_001, completion_tokens: 0 }, 200), /envelope/);
  assert(excessive.snapshot().blocked);
  assert.throws(() => excessive.reserve());
});

test("usage parser handles JSON, CRLF SSE, multibyte text and truncated frames conservatively", () => {
  const usage = { prompt_tokens: 100, completion_tokens: 30 };
  assert.deepEqual(responseUsage(JSON.stringify({ usage }), "application/json"), usage);
  assert.deepEqual(responseUsage(`data: {"text":"中文"}\r\n\r\ndata: ${JSON.stringify({ usage })}\r\n\r\ndata: [DONE]\r\n\r\n`,
    "text/event-stream"), usage);
  assert.equal(responseUsage(`data: ${JSON.stringify({ usage })}`, "text/event-stream"), null);
  assert.equal(responseUsage("data: broken\n\n", "text/event-stream"), null);
  assert.equal(responseUsage("{}", "application/json"), null);
});

test("HTTP relay pins the upstream, prevents model/tool switching and enforces budget before fetch", async () => {
  let calls = 0;
  const relay = await createBudgetRelay({ profile: cloudProfile, currency: "CNY",
    limitMicros: 2_016_384, maxRequests: 10, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://example.invalid/v1/chat/completions");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-test-only");
      return new Response(JSON.stringify({ choices: [], usage: null }), {
        headers: { "Content-Type": "application/json" },
      });
    } });
  const send = (extra) => fetch(`${relay.baseUrl}/chat/completions`, { method: "POST",
    headers: { Authorization: "Bearer synthetic-test-only", "Content-Type": "application/json" },
    body: JSON.stringify({ model: cloudProfile.model_id, max_tokens: 2048, ...extra }) });
  try {
    for (const extra of [{ model: "other" }, { max_tokens: 2049 }, { tools: [{ type: "web_search" }] },
      { max_completion_tokens: 4096 }]) {
      const response = await send(extra);
      assert.equal(response.status, 502);
      await response.text();
    }
    assert.equal(calls, 0);
    assert.equal((await send({})).status, 200);
    const denied = await send({});
    assert.equal(denied.status, 402);
    const message = await denied.text();
    assert(!message.includes("synthetic-test-only"));
    assert.equal(calls, 1);
    assert.equal(relay.snapshot().conservativeSpentMicros, 2_016_384);
  } finally { await relay.close(); }
});

test("SSE client disconnect retains complete final usage without double settlement", async () => {
  const encoder = new TextEncoder();
  const relay = await createBudgetRelay({ profile: cloudProfile, currency: "CNY",
    limitMicros: 10_000_000, maxRequests: 10, fetchImpl: async (_url, { signal }) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":100,"completion_tokens":30}}\n\ndata: [DONE]\n\n'));
          signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: "POST",
      headers: { Authorization: "Bearer synthetic-test-only", "Content-Type": "application/json" },
      body: JSON.stringify({ model: cloudProfile.model_id, max_tokens: 2048 }) });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    for (let n = 0; n < 100 && relay.snapshot().records[0]?.state === "reserved"; n++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(relay.snapshot().records[0].state, "settledConservativeUsage");
    assert.equal(relay.snapshot().conservativeSpentMicros, 440);
  } finally { await relay.close(); }
});

test("model report distinguishes recorded turns, completed turns and budget from quality acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coauthor-report-test-"));
  try {
    await writeReport(directory, { mode: "realModel", environment: {}, status: "completedWithFailures",
      modelRequests: 2, budget: { conservativeSpentMicros: 100, limitMicros: 1000, currency: "CNY", blocked: false },
      turns: [{ caseId: "synthetic", turnIndex: 0, status: "LIMIT_REACHED", elapsedMs: 1,
        modelRequests: 2, toolErrors: 1 }] });
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    assert.match(markdown, /Recorded turns: 1/);
    assert.match(markdown, /Completed turns: 0/);
    assert.match(markdown, /0.0001 CNY/);
    assert.match(markdown, /Not the provider invoice/);
    assert.match(markdown, /LIMIT_REACHED/);
    assert.match(markdown, /pending until the human review/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fixed scenes cover all goals, workload types and valid relevance identities", async () => {
  const { fixture, hash } = await loadFixture();
  assert.equal(hash.length, 64);
  assert.equal(fixture.cases.length, 13);
  assert.deepEqual(new Set(fixture.cases.map((c) => c.goal)), new Set(["proactive", "relevant", "grounded"]));
  assert.deepEqual(new Set(fixture.cases.map((c) => c.workload)), new Set(["discussion", "localEdit", "fullCheck"]));
});

test("N2 freezes renamed retrieval variants and V1-V8 paired boundary rubrics without grading prose", async () => {
  const fixture = JSON.parse(await readFile(join(workspace, "tools/fixtures/coauthor-n2-regression.json"), "utf8"));
  assert.equal(fixture.version, "coauthor-n2-v1");
  assert.match(fixture.privacy, /not a blind holdout/);
  assert.deepEqual(fixture.boundaries.map((entry) => entry.id),
    ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"]);
  for (const entry of fixture.boundaries) {
    assert(entry.source && (entry.request || entry.requests?.length) && entry.rubric.length >= 2);
    assert(!Object.hasOwn(entry, "score"));
  }
  assert.equal(fixture.boundaries.find((entry) => entry.id === "V4").requests.length, 2);
  assert.equal(fixture.boundaries.find((entry) => entry.id === "V8").requests.length, 3);
  const ids = new Set(fixture.retrieval.sources.map((entry) => entry.id));
  for (const entry of fixture.retrieval.cases) {
    assert([...entry.expectedInitial, ...entry.expectedFollowup].every((id) => ids.has(id)));
  }
  assert(fixture.retrieval.cases.some((entry) => entry.prefixRepeat > 0));
  assert(fixture.retrieval.cases.some((entry) => entry.expectedFollowup.length === 0));
});

test("followup coverage and latency never overwrite the initial retrieval baseline", () => {
  const fixture = { scales: [{ name: "small" }], cases: [{ id: "a" }],
    thresholds: { recallAt12Min: 0.9, noiseAt12Max: 0.3, falseEmptyRateMax: 0,
      warmP95MsMax: 20, warmSamplesMin: 20 } };
  const rows = [{ type: "coldIndex", scale: { name: "small" }, elapsedMs: 1, passes: 1 },
    ...Array.from({ length: 30 }, (_, sample) => ({
      type: "query", scale: "small", caseId: "a", sample, elapsedMs: 1,
      expectedKeys: ["a", "b"], hits: [{ key: "a", chars: 10 }], pending: 0, hasMore: false,
      followupElapsedMs: 21, followupHits: [{ key: "b", chars: 10 }],
    }))];
  const report = summarizeBaseline(rows, fixture);
  const result = report.results[0];
  assert.equal(result.recallAt12, 0.5);
  assert.equal(result.localFollowup.candidateRecallAt12, 1);
  assert.equal(result.cases[0].recallAt12, 0.5);
  assert.equal(result.latencyMs.p95, 1);
  assert.equal(result.localFollowup.combinedLatencyMs.p95, 22);
  assert.equal(result.gates.recall, false);
  assert.equal(result.gates.combinedWarmP95, false);
  assert.equal(report.gatesPassed, false);
  assert.throws(() => summarizeBaseline(rows.map((row, i) => i === 1
    ? { ...row, followupElapsedMs: undefined } : row), fixture), /Incomplete followup/);
});

test("weak-match loopback requires an exact candidate pointer and original restrictions in the later request", () => {
  const candidate = { key: "ENTITY:cost", revision: "r2", title: "突破代价规则",
    navigationOnly: true, sourceTextRetained: false };
  const messages = [{ role: "user", content: JSON.stringify({
    contextOnly: true, navigationCompacted: true, sourcePointers: [candidate],
  }) }, { role: "user", content: "那套靠遗忘换力量的阶梯，下一层能怎样设计？只聊。" }];
  const turn = coauthorLoopbackTurn({ messages });
  const args = JSON.parse(turn.tool_calls[0].function.arguments);
  assert.equal(args.key, candidate.key);
  assert.equal(args.revision, candidate.revision);
  const deliver = (value) => [...messages, turn, {
    role: "tool", tool_call_id: turn.tool_calls[0].id, content: JSON.stringify(value),
  }];
  assert.throws(() => coauthorLoopbackTurn({ messages: deliver({ ...candidate, content: "只有候选片段" }) }));
  assert.match(coauthorLoopbackTurn({ messages: deliver({
    ...candidate, content: "不可凭普通术法恢复。不得无条件恢复全部记忆。",
  }) }).content, /不用于创作质量评分/);
  assert.throws(() => coauthorLoopbackTurn({ messages: [
    { role: "user", content: JSON.stringify({ contextOnly: true }) }, messages[1],
  ] }));
});

test("weak-match audit needs both a versioned read and acknowledged delivery, not just candidate coverage", () => {
  const candidate = { key: "ENTITY:cost", revision: "r2", title: "突破代价规则" };
  const primary = { key: "ENTITY:realms", revision: "r1" };
  const audit = [
    { kind: "initial_search", result: { hits: [primary] } },
    { kind: "local_source_followup", result: { result: { hits: [candidate] } } },
    { kind: "tool", name: "read_source", result: {
      ...candidate, content: "不可凭普通术法恢复。不得无条件恢复全部记忆。",
    } },
    { kind: "tool", name: "read_source", result: { ...primary, content: "不消耗寿元。灯芯只能用一次。" } },
    { kind: "source_delivery", transportAcknowledged: true, understandingVerified: false,
      sources: [{ ...candidate, chars: 28 }, { ...primary, chars: 4 }] },
  ];
  const entry = { caseId: "semantic-paraphrase", status: "COMPLETED", audit };
  assert.equal(assertLoopbackRegression(entry).qualityVerified, false);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: audit.slice(0, 4) }));
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [
    ...audit.slice(0, 2), { ...audit[2], result: { ...audit[2].result, revision: "wrong" } }, ...audit.slice(3),
  ] }));
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [
    ...audit.slice(0, 4), { ...audit[4], transportAcknowledged: false },
  ] }));
});

test("nearest-rank percentiles do not mutate samples or imply sufficient n", () => {
  const values = [4, 1, 3, 2];
  assert.equal(percentile(values, 0.5), 2);
  assert.equal(percentile(values, 0.95), 4);
  assert.deepEqual(values, [4, 1, 3, 2]);
  assert.equal(distribution([]).p95, null);
  assert.equal(distribution([1]).sufficient, false);
  assert.throws(() => percentile([NaN], 0.5));
});

test("recall, noise and false empty are distinct; absent truth has no fabricated recall", () => {
  assert.deepEqual(retrievalScore(["a", "b"], [{ key: "a" }, { key: "a" }, { key: "noise" }]),
    { recallAt12: 0.5, noiseAt12: 0.5, reciprocalRank: 1, falseEmpty: false, returned: 2 });
  assert.equal(retrievalScore(["a"], []).falseEmpty, true);
  assert.equal(retrievalScore([], []).recallAt12, null);
  assert.equal(retrievalScore(["a"], Array.from({ length: 12 }, () => ({ key: "noise" })).concat({ key: "a" })).recallAt12, 0);
});

test("native parsing ignores cargo/test progress", () => {
  assert.deepEqual(nativeRows('test x ... COAUTHOR_EVAL {"type":"query"}\r\nok\n'), [{ type: "query" }]);
});

test("real-model guard rejects missing opt-in, unknown cases and invalid budgets", async () => {
  const { fixture } = await loadFixture();
  const valid = { "allow-cloud": true, "cloud-profile": "11111111-1111-1111-1111-111111111111",
    "max-cost-micros": "100", currency: "USD" };
  assert.throws(() => validateCloudOptions({}, fixture), /allow-cloud/);
  assert.throws(() => validateCloudOptions({ ...valid, case: "unknown" }, fixture), /Unknown/);
  assert.throws(() => validateCloudOptions({ ...valid, "max-cost-micros": "NaN" }, fixture));
  assert.throws(() => validateCloudOptions({ ...valid, repetitions: "4" }, fixture));
  assert.equal(validateCloudOptions({ ...valid, case: "alias-recall" }, fixture).cases.length, 1);
});

test("CLI without permission fails before reading profiles or launching native app", () => {
  const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs")],
    { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /allow-cloud/);
  assert.doesNotMatch(result.stdout, /Desktop launched/);
});

test("local token-budget overrides cannot alter cloud runs or launch with invalid values", () => {
  for (const args of [
    ["--loopback-input-tokens", "16384"],
    ["--loopback", "--loopback-input-tokens", "NaN"],
    ["--loopback", "--loopback-input-tokens", "255"],
    ["--loopback", "--loopback-input-tokens", "65537"],
  ]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"), ...args],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --loopback|integer from 256 to 65536/);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
});

test("expected-limit regression mode cannot bypass cloud authorization", () => {
  for (const args of [
    ["--loopback-expect-input-limit"],
    ["--loopback", "--loopback-expect-input-limit"],
  ]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"), ...args],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --loopback and --loopback-input-tokens/);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
});

test("late-expansion mode cannot run cloud, unselected cases or mutually exclusive limits", () => {
  for (const args of [
    ["--loopback-expect-late-expansion"],
    ["--loopback", "--loopback-input-tokens", "13312", "--loopback-expect-late-expansion"],
    ["--loopback", "--case", "full-source-check", "--loopback-input-tokens", "13312",
      "--loopback-expect-late-expansion", "--loopback-expect-input-limit"],
  ]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"), ...args],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Late expansion requires/);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
});

test("late-expansion assertion rejects a first-request expansion even if the task completes", () => {
  const setup = { kind: "input_budget", initialInputTokenBudget: 13312, maxInputTokenBudget: 26624 };
  const first = { kind: "model_request", inputTokenBudget: 13312, initialInputTokenBudget: 13312,
    inputBudgetExpanded: false, estimatedInputTokens: 12385 };
  const started = { kind: "tool", name: "start_source_check", result: { check: { id: "check" } } };
  const expansion = { kind: "input_budget_expansion", previousInputTokenBudget: 13312,
    inputTokenBudget: 26624, configurationPersisted: false, taskRestarted: false };
  const second = { ...first, inputTokenBudget: 26624, inputBudgetExpanded: true, estimatedInputTokens: 13419 };
  const entry = { status: "COMPLETED", audit: [setup, first, started, expansion, second] };
  assert(assertLoopbackRegression(entry, { expectLateExpansion: true }).lateExpansionVerified);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [setup, expansion, second] },
    { expectLateExpansion: true }), /already sent/);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [setup, first, expansion, second] },
    { expectLateExpansion: true }), /already established/);
});

test("cost reserve includes ten requests per turn and rejects unknown or unsafe profiles", () => {
  const profile = { capability: "CHAT", privacy_level: "ALLOW_CLOUD", secret_ref: "not-logged",
    base_url: "https://example.invalid/v1", price_currency: "USD", context_window: 65536,
    max_output_tokens: 2048, input_price_micros_per_million: 1_000_000,
    output_price_micros_per_million: 2_000_000 };
  assert.equal(reserveCost(profile, "USD", 2), 20 * (65536 + 4096));
  assert.throws(() => reserveCost({ ...profile, base_url: "http://example.invalid" }, "USD", 1));
  assert.throws(() => reserveCost({ ...profile, input_price_micros_per_million: 0 }, "USD", 1));
  assert.throws(() => reserveCost(profile, "CNY", 1));
});

test("unscored human criteria are pending; one blocking failure cannot be averaged away", async () => {
  const { fixture } = await loadFixture();
  const cases = fixture.cases.slice(0, 1);
  const rows = reviewTemplate(cases, 1);
  assert.equal(assessReview(rows, cases, 1).status, "pending");
  rows[0].reviewer = "reviewer";
  rows[0].blockingFailures = [];
  rows[0].criteria.forEach((c) => { c.score = 3; c.evidence = "Exact observed output and audit reference."; });
  assert.equal(assessReview(rows, cases, 1).status, "passed");
  rows[0].blockingFailures.push({ code: "FABRICATED_SOURCE", evidence: "output paragraph 1" });
  assert.equal(assessReview(rows, cases, 1).status, "failed");
  assert.throws(() => assessReview([...rows, ...rows], cases, 1), /Duplicate/);
  assert.equal(assessReview([], cases, 1).status, "pending");
  assert.throws(() => assessReview([], [], 1), /non-empty/);
  rows[0].criteria[0].score = null;
  assert.equal(assessReview(rows, cases, 1).status, "failed", "Known blocker survives incomplete scoring.");
});

test("incomplete or duplicate timing samples cannot produce a baseline pass", async () => {
  const { fixture } = await loadFixture();
  assert.throws(() => summarizeBaseline([], fixture), /Incomplete/);
});

test("baseline retains low recall and per-case latency failures even when pooled latency looks good", () => {
  const fixture = { scales: [{ name: "small" }], cases: [{ id: "a" }, { id: "b" }],
    thresholds: { recallAt12Min: 0.9, noiseAt12Max: 0.3, falseEmptyRateMax: 0,
      warmP95MsMax: 20, warmSamplesMin: 20 } };
  const rows = [{ type: "coldIndex", scale: { name: "small" }, elapsedMs: 1, passes: 1 },
    ...["a", "b"].flatMap((caseId) => Array.from({ length: 30 }, (_, sample) => ({
      type: "query", scale: "small", caseId, sample, elapsedMs: caseId === "b" && sample >= 28 ? 30 : 1,
      expectedKeys: ["truth"], hits: caseId === "a" ? [] : [{ key: "truth", chars: 10 }],
      pending: 0, hasMore: false,
    })))];
  const report = summarizeBaseline(rows, fixture);
  assert.equal(report.results[0].latencyMs.p95, 1);
  assert.equal(report.results[0].gates.warmP95, false);
  assert.equal(report.results[0].gates.recall, false);
  assert.equal(report.results[0].gates.falseEmpty, false);
  assert.equal(report.gatesPassed, false);
});

test("loopback regression requires a separate current request and reference-only history", () => {
  const context = { contextOnly: true, historicalMessages: [{ historicalMessage: "旧茶铺话题" }],
    relevantSources: { hits: [] }, relevantDecisions: { memories: [] } };
  const messages = [{ role: "system", content: "rules" },
    { role: "user", content: JSON.stringify(context) }, { role: "user", content: "本轮只讨论突破代价" }];
  assert.equal(loopbackContext(messages).request, "本轮只讨论突破代价");
  assert.throws(() => loopbackContext([{ role: "user", content: JSON.stringify({ ...context, request: "buried" }) }]));
  assert.throws(() => loopbackContext([{ role: "user", content: "旧茶铺话题" }, ...messages]));
  assert.match(coauthorLoopbackTurn({ messages }).content, /不用于创作质量评分/);
});

test("scripted full check deliberately rejects a typo then follows the native recovery instruction", () => {
  const context = { contextOnly: true, relevantSources: { hits: [] } };
  const messages = [{ role: "user", content: JSON.stringify(context) },
    { role: "user", content: "完整查证全部设定卡" }];
  function deliver(message, values) {
    messages.push(message);
    message.tool_calls.forEach((c, i) => messages.push({
      role: "tool", tool_call_id: c.id, content: JSON.stringify(values[i]),
    }));
  }
  const start = coauthorLoopbackTurn({ messages });
  assert.equal(start.tool_calls[0].function.name, "start_source_check");
  const entries = Array.from({ length: 6 }, (_, i) => ({ key: `ENTITY:${i}`, revision: `r${i}`,
    title: ["九曜境界体系", "突破代价规则", "北港宗门旧抄本", "禁书残页", "林澈前期知情边界", "南港集市"][i] }));
  deliver(start, [{ check: { id: "check" }, entries }]);
  const reads = coauthorLoopbackTurn({ messages });
  assert.equal(reads.tool_calls.length, 6);
  deliver(reads, entries.map((entry) => ({ ...entry, content: "突破规则，尚未确定真伪" })));
  const judgments = coauthorLoopbackTurn({ messages });
  const args = judgments.tool_calls.map((c) => JSON.parse(c.function.arguments));
  assert(args[0].revision.endsWith("-intentional-typo"));
  assert.deepEqual(args.map((a) => a.assessment), ["RELEVANT", "RELEVANT", "UNCERTAIN", "IRRELEVANT", "IRRELEVANT", "IRRELEVANT"]);
  const recovery = { tool: "get_source_checks", arguments: { checkId: "check", offset: 0 } };
  deliver(judgments, args.map((arg, i) => i ? { recorded: true, entry: arg }
    : { executed: false, recorded: false, recovery }));
  const retry = coauthorLoopbackTurn({ messages });
  assert.equal(retry.tool_calls[0].function.name, "get_source_checks");
  assert.deepEqual(JSON.parse(retry.tool_calls[0].function.arguments), recovery.arguments);
  deliver(retry, [{ check: { id: "check" }, entries }]);
  const corrected = coauthorLoopbackTurn({ messages });
  assert.equal(corrected.tool_calls.length, 1);
  assert.equal(JSON.parse(corrected.tool_calls[0].function.arguments).revision, "r0");
});

test("scripted search distinguishes valid zero hits, four candidates and an invalid query", () => {
  const messages = [{ role: "user", content: JSON.stringify({ contextOnly: true }) },
    { role: "user", content: "有没有设定过星砂契约？" }];
  const turn = coauthorLoopbackTurn({ messages });
  assert.deepEqual(turn.tool_calls.map((c) => JSON.parse(c.function.arguments).query),
    ["星砂契约", "契约 交易 代价 术法", "砂"]);
  const receipts = [{ method: "KEYWORD", query: "星砂契约", status: "RETURNED_PAGE", returned: 0 },
    { method: "KEYWORD", query: "契约 交易 代价 术法", status: "RETURNED_PAGE", returned: 4 },
    { method: "KEYWORD", query: "砂", status: "INVALID_QUERY", returned: null }];
  const entry = { status: "COMPLETED", caseId: "absent-not-absolute",
    output: '关键词 "契约 交易 代价 术法"（项目资料，offset=0）：实际返回 4 条\n'
      + '关键词 "砂"（项目资料，offset=0）：未形成有效查询，不能记为 0 命中',
    audit: [{ kind: "retrieval_summary", receipts }] };
  assert(assertLoopbackRegression(entry).scriptedNativeRegression);
  assert.throws(() => assertLoopbackRegression({ ...entry, output: "两个搜索均0命中" }));
  assert.throws(() => assertLoopbackRegression({ ...entry,
    audit: [{ kind: "retrieval_summary", receipts: [receipts[0], { ...receipts[1], returned: 0 }] }] }));
  assert.throws(() => assertLoopbackRegression({ ...entry,
    audit: [{ kind: "retrieval_summary", receipts: receipts.slice(0, 2) }] }));
  for (const invalid of [{ ...receipts[2], returned: 0 },
    { ...receipts[2], status: "RETURNED_PAGE", returned: 0 }]) {
    assert.throws(() => assertLoopbackRegression({ ...entry,
      audit: [{ kind: "retrieval_summary", receipts: [...receipts.slice(0, 2), invalid] }] }));
  }
  assert.throws(() => assertLoopbackRegression({ ...entry,
    output: '关键词 "契约 交易 代价 术法"（项目资料，offset=0）：实际返回 4 条' }));
});

test("scripted check retains malicious final wording only to test the native receipt boundary", () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({ key: `ENTITY:${i}`, revision: `r${i}` }));
  const messages = [{ role: "user", content: JSON.stringify({ contextOnly: true,
    checkAssessments: entries.map((entry) => ({ recorded: true, entry })) }) },
  { role: "user", content: "完整查证全部设定卡" },
  { role: "assistant", tool_calls: [{ id: "page", function: { name: "get_source_checks" } }] },
  { role: "tool", tool_call_id: "page", content: JSON.stringify({ check: { id: "check" }, entries }) }];
  assert.match(coauthorLoopbackTurn({ messages }).content, /故意错误的查证收尾/);
});

test("local regression cannot call an incomplete or fabricated draft receipt a pass", () => {
  const entry = { caseId: "extend-confirmed", turnIndex: 1, status: "COMPLETED",
    output: "归灯境之后为归灯境。第一句已改好，采用后会自动同步设定卡。" };
  assert.throws(() => assertLoopbackRegression(entry));
  const passed = assertLoopbackRegression({ ...entry,
    output: "尚未采用或正式提交。结曜之后为归灯境。守灯人例外仍然有效。" });
  assert.equal(passed.scriptedNativeRegression, true);
  assert.equal(passed.qualityVerified, false);
  assert.throws(() => assertLoopbackRegression({ ...entry, status: "LIMIT_REACHED" }));
});

test("native regression uses estimated tokens including overhead, not serialized characters", () => {
  const entry = { status: "COMPLETED", audit: [{
    kind: "model_request", inputChars: 50_000, estimatedInputTokens: 15_800, inputTokenBudget: 16_384,
  }] };
  assert.equal(assertLoopbackRegression(entry).scriptedNativeRegression, true);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [{
    ...entry.audit[0], estimatedInputTokens: 16_385,
  }] }));
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [{
    kind: "model_request", inputChars: 10_000,
  }] }));
});

test("native input expansion allows one bounded increase without restarting or saving settings", () => {
  const setup = { kind: "input_budget", initialInputTokenBudget: 32768, maxInputTokenBudget: 65536 };
  const expansion = { kind: "input_budget_expansion", previousInputTokenBudget: 32768,
    inputTokenBudget: 65536, configurationPersisted: false, taskRestarted: false };
  const request = { kind: "model_request", inputTokenBudget: 65536, initialInputTokenBudget: 32768,
    inputBudgetExpanded: true, estimatedInputTokens: 40000 };
  const entry = { status: "COMPLETED", audit: [setup, expansion, request] };
  assert(assertLoopbackRegression(entry).scriptedNativeRegression);
  for (const audit of [
    [setup, expansion, expansion, request],
    [setup, { ...expansion, taskRestarted: true }, request],
    [setup, { ...expansion, configurationPersisted: true }, request],
    [setup, { ...expansion, inputTokenBudget: 131072 }, request],
    [setup, request],
  ]) {
    assert.throws(() => assertLoopbackRegression({ ...entry, audit }));
  }
});

test("expected initial overflow still requires zero provider calls and an honest stop notice", () => {
  const entry = { status: "LIMIT_REACHED", modelRequests: 0,
    output: "尚未发送模型请求，仍然不足，不再自动扩容。",
    audit: [
      { kind: "input_budget", initialInputTokenBudget: 4096, maxInputTokenBudget: 8192 },
      { kind: "input_budget_expansion", previousInputTokenBudget: 4096, inputTokenBudget: 8192,
        configurationPersisted: false, taskRestarted: false },
      { kind: "budget_limit", reason: "INPUT_TOKEN_BUDGET", inputTokenBudget: 8192,
        estimatedInputTokens: 12000, modelRequestsSent: 0 },
    ] };
  assert(assertLoopbackRegression(entry, { expectInputLimit: true }).expectedInputLimit);
  assert.throws(() => assertLoopbackRegression(entry), /must finish/);
  assert.throws(() => assertLoopbackRegression({ ...entry, modelRequests: 1 }, { expectInputLimit: true }));
  assert.throws(() => assertLoopbackRegression({ ...entry, output: "已完成" }, { expectInputLimit: true }));
});
