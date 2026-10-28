import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assessReview, distribution, loadFixture, loadModelFixture, nativeRows, percentile, priorReplyReuse, reserveCost,
  retrievalScore, reviewTemplate, summarizeBaseline, validateCloudOptions, writeReport } from "./coauthor-evaluation-core.mjs";
import { workspace } from "./desktop-smoke-runtime.mjs";
import { createBudgetLedger, createBudgetRelay, responseUsage } from "./coauthor-evaluation-budget.mjs";
import { loopbackContext, coauthorLoopbackTurn, coauthorReviewTurn, assertLoopbackRegression } from "./coauthor-runtime-loopback.mjs";
import { assertReviewEvidence, inspectReviewEvidence, renderReviewPacket } from "./coauthor-review-evidence.mjs";

const cloudProfile = { capability: "CHAT", privacy_level: "ALLOW_CLOUD", secret_ref: "synthetic",
  base_url: "https://example.invalid/v1", model_id: "synthetic-test", price_currency: "CNY",
  context_window: 1_000_000, max_output_tokens: 384_000,
  input_price_micros_per_million: 2_000_000, output_price_micros_per_million: 8_000_000 };

test("verbatim continuation observation uses the matching option and Unicode positions without grading", () => {
  const selected = "她将铜匣推回桌角。\n\n" + "她还不想付出代价。".repeat(12);
  const previous = `前案😀\n\n方案一：她已经割舍。\n\n方案二：${selected}\n\n两案均未采用。`;
  const current = selected + "\n\n门外的人终于开口。";
  const observation = priorReplyReuse(previous, current);
  assert.equal(observation.verbatimPrefixChars, Array.from(selected + "\n\n").length);
  assert.equal(observation.previousOffsetChars, Array.from(previous.slice(0, previous.indexOf(selected))).length);
  assert.equal(observation.reviewCandidate, true);
  assert.equal(observation.authorIntentAssessed, false);
  assert.equal(observation.observationOnly, true);
  assert.equal(priorReplyReuse(previous, "她将铜匣推回桌角。\n\n新的情节。").reviewCandidate, false);
  assert.equal(priorReplyReuse(previous, "").previousOffsetChars, null);
  assert.equal(priorReplyReuse("", current).verbatimPrefixChars, 0);
  assert.equal(priorReplyReuse("😀".repeat(100), "😀".repeat(81)).verbatimPrefixChars, 81);
});

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

test("request allowance counts reservations independently of money and cannot be reset by settlement", () => {
  const ledger = createBudgetLedger(cloudProfile, "CNY", 10_000_000, 3);
  const ids = [ledger.reserve(), ledger.reserve(), ledger.reserve()];
  assert.equal(ledger.snapshot().remainingRequests, 0);
  ids.forEach((id) => ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 }, 200));
  assert.throws(() => ledger.reserve(), /MODEL_REQUEST_LIMIT/);
  assert.equal(ledger.snapshot().blockedReason, "MODEL_REQUEST_LIMIT");
  assert.equal(ledger.snapshot().records.length, 3);
  assert(ledger.snapshot().conservativeSpentMicros < 10_000_000);
  assert.throws(() => ledger.reserve(), /MODEL_REQUEST_LIMIT/);
});

test("three-request HTTP allowance rejects the fourth before invoking the upstream", async () => {
  let calls = 0;
  const relay = await createBudgetRelay({ profile: cloudProfile, currency: "CNY",
    limitMicros: 10_000_000, maxRequests: 3, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { headers: { "Content-Type": "application/json" } });
    } });
  const send = () => fetch(`${relay.baseUrl}/chat/completions`, { method: "POST",
    headers: { Authorization: "Bearer synthetic-test-only", "Content-Type": "application/json" },
    body: JSON.stringify({ model: cloudProfile.model_id, max_tokens: 2048 }) });
  try {
    for (let i = 0; i < 3; i++) {
      const response = await send();
      assert.equal(response.status, 200);
      await response.text();
    }
    const denied = await send();
    assert.equal(denied.status, 402);
    await denied.text();
    assert.equal(calls, 3);
    assert.equal(relay.snapshot().blockedReason, "MODEL_REQUEST_LIMIT");
    assert.equal(relay.snapshot().records.length, 3);
  } finally { await relay.close(); }
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

test("model suite adapters retain both frozen hashes, labels and source bodies", async () => {
  const fixed = await loadModelFixture();
  assert.equal(fixed.hash, "45470389a637a61f0948dbd9c18ae702c6fffdf1877abc20c7f5cc42ba78bb47");
  assert.equal(fixed.fixture.cases.length, 13);
  const n2 = await loadModelFixture("n2-retrieval");
  assert.equal(n2.hash, "66a12d9f9f75743fd215f0c283306aaf6a83b301edd9a89f1691a76867854d93");
  assert.deepEqual(n2.fixture.cases.map((entry) => entry.id),
    ["n2-renamed-cost", "n2-long-tail", "n2-exact-alias-no-repeat"]);
  assert.equal(n2.fixture.cases[1].prefixRepeat, 240);
  assert.deepEqual(n2.fixture.cases[2].nativeRetrievalContract.expectedFollowup, []);
  assert.deepEqual(n2.fixture.cases[2].retrieval.relevant, ["ladder", "cost"],
    "Skipping an automatic followup must not relabel the cost rule as irrelevant.");
  for (const entry of n2.fixture.cases) {
    for (const source of entry.nativeRetrievalContract.sources) {
      assert.equal(source.requiredQuote, n2.fixture.sources.find((candidate) => candidate.id === source.id).content);
    }
  }
  await assert.rejects(loadModelFixture("../custom.json"), /Unknown/);
});

test("DeepSeek comparison suite freezes nine additional cases, matched pairs and eleven turns separately", async () => {
  const { fixture, hash } = await loadModelFixture("n2-comparison");
  assert.equal(hash, "5f23d62c34a34f9473d21839496fd114c0b70c11330da5aa620ced6e7e6ebd14");
  assert.equal(fixture.cases.length, 9);
  assert.equal(fixture.cases.reduce((total, entry) => total + entry.turns.length, 0), 11);
  assert(fixture.cases.every((entry) => entry.id.startsWith("compare-")));
  const [short, long] = fixture.cases.filter((entry) => entry.comparisonGroup === "renamed-short-versus-long-tail");
  assert.deepEqual(short.turns, long.turns);
  assert.equal(long.prefixRepeat, 240);
  const [discuss, prepare] = fixture.cases.filter((entry) => entry.comparisonGroup === "discussion-versus-preparation");
  assert.deepEqual(discuss.decisions, prepare.decisions);
  assert(!discuss.turns[0].allowDraftEdits);
  assert.equal(prepare.turns[0].allowDraftEdits, true);
  assert.equal(fixture.thresholds.humanScoreMin, 2);
  assert.equal((await loadFixture()).hash, "45470389a637a61f0948dbd9c18ae702c6fffdf1877abc20c7f5cc42ba78bb47");
  for (const [args, message] of [
    [[], /requires --allow-cloud/],
    [["--allow-cloud"], /cloud-profile/],
    [["--prepare-only", "--allow-cloud"], /Local modes/],
    [["--loopback", "--case", "alias-recall"], /Unknown/],
  ]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"),
      "--suite", "n2-comparison", ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
});

test("N2 suite is local-only and invalid suite/case options fail before native launch", () => {
  for (const [args, message] of [
    [["--suite", "n2-retrieval"], /local-only/],
    [["--suite", "n2-retrieval", "--loopback", "--allow-cloud"], /local-only/],
    [["--suite", "n2-retrieval", "--prepare-only", "--cloud-profile", "anything"], /local-only/],
    [["--suite", "n2-retrieval", "--loopback", "--loopback-expect-input-limit"], /cannot use/],
    [["--suite", "n2-retrieval", "--loopback", "--case", "semantic-paraphrase"], /Unknown/],
    [["--suite", "../custom.json", "--loopback"], /Unknown evaluation suite/],
  ]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"), ...args],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
});

test("N2 driver reads discovered exact pointers then locates the real tail without calling it a full read", async () => {
  const { fixture } = await loadModelFixture("n2-retrieval");
  const scenario = fixture.cases[1];
  const pointers = scenario.nativeRetrievalContract.sources.map((source, i) => ({
    key: `ENTITY:${source.id}`, revision: `rev-${source.id}`, title: source.title,
    sourceReference: `source-0-${i + 1}`,
    navigationOnly: true, sourceTextRetained: false,
  }));
  const messages = [{ role: "user", content: JSON.stringify({
    contextOnly: true, navigationCompacted: true, sourcePointers: pointers,
    relevantDecisions: { decisionScope: { origin: "CURRENT_BRANCH_DISCUSSION",
      updatesFormalSources: false, impliesFormalSyncRequired: false } },
  }) }, { role: "user", content: scenario.turns[0].message }];
  const tools = [{ function: { name: "read_source", parameters: { required: ["reference"] } } }];
  const first = coauthorLoopbackTurn({ messages, tools }, { scenario });
  assert.equal(first.tool_calls.length, 2);
  first.tool_calls.forEach((item, i) => {
    assert.deepEqual(JSON.parse(item.function.arguments), {
      reference: pointers[i].sourceReference, offset: 0, limit: 256,
    });
  });
  const noReference = structuredClone(messages);
  const missingReferenceContext = JSON.parse(noReference[0].content);
  delete missingReferenceContext.sourcePointers[0].sourceReference;
  noReference[0].content = JSON.stringify(missingReferenceContext);
  assert.throws(() => coauthorLoopbackTurn({ messages: noReference }, { scenario }), /program reference/);
  const retainedText = structuredClone(messages);
  const retainedContext = JSON.parse(retainedText[0].content);
  retainedContext.sourcePointers[0].content = "不得伪装成仅身份指针";
  retainedText[0].content = JSON.stringify(retainedContext);
  assert.throws(() => coauthorLoopbackTurn({ messages: retainedText }, { scenario }), /must not retain/);
  const notPointerOnly = structuredClone(messages);
  const invalidContext = JSON.parse(notPointerOnly[0].content);
  invalidContext.sourcePointers[0].sourceTextRetained = true;
  notPointerOnly[0].content = JSON.stringify(invalidContext);
  assert.throws(() => coauthorLoopbackTurn({ messages: notPointerOnly }, { scenario }));
  messages.push(first);
  first.tool_calls.forEach((item, i) => messages.push({ role: "tool", tool_call_id: item.id,
    content: JSON.stringify({ ...pointers[i], offset: 0, totalChars: 1800, content: "风景与路况。".repeat(36) }) }));
  const tail = coauthorLoopbackTurn({ messages, tools }, { scenario });
  tail.tool_calls.forEach((item) => assert.equal(JSON.parse(item.function.arguments).offset, 1288));
  messages.push(tail);
  tail.tool_calls.forEach((item, i) => messages.push({ role: "tool", tool_call_id: item.id,
    content: JSON.stringify({ ...pointers[i], offset: 1288, totalChars: 1800,
      content: scenario.nativeRetrievalContract.sources[i].requiredQuote }) }));
  assert.match(coauthorLoopbackTurn({ messages }, { scenario }).content, /不用于创作质量评分/);
  const broken = structuredClone(messages);
  broken.at(-1).content = JSON.stringify({ ...pointers[1], offset: 1288, totalChars: 1800, content: "缺少尾部规则" });
  assert.throws(() => coauthorLoopbackTurn({ messages: broken }, { scenario }), /tail read/);
  assert.throws(() => coauthorLoopbackTurn({ messages: messages.slice(0, 1).concat({
    role: "user", content: "与当前变体不符",
  }) }, { scenario }), /must agree/);
});

test("N2 driver does not silently repair a missing companion; exact-alias compacted navigation can requery once", async () => {
  const { fixture } = await loadModelFixture("n2-retrieval");
  const messages = (scenario) => [{ role: "user", content: JSON.stringify({
    contextOnly: true, navigationCompacted: true,
  }) }, { role: "user", content: scenario.turns[0].message }];
  assert.throws(() => coauthorLoopbackTurn({ messages: messages(fixture.cases[0]) },
    { scenario: fixture.cases[0] }), /must discover/);
  const exact = fixture.cases[2];
  const turn = coauthorLoopbackTurn({ messages: messages(exact) }, { scenario: exact });
  assert.equal(turn.tool_calls[0].function.name, "search_sources");
  assert.equal(JSON.parse(turn.tool_calls[0].function.arguments).query, exact.retrieval.query);
});

test("N2 audit rejects candidate-only evidence, wrong delivery ranges, extra reads and premature coverage claims", async () => {
  const { fixture } = await loadModelFixture("n2-retrieval");
  const scenario = fixture.cases[1];
  const sources = scenario.nativeRetrievalContract.sources.map((source) => ({
    ...source, key: `ENTITY:${source.id}`, revision: `rev-${source.id}`,
  }));
  const contract = { initialKeys: [sources[0].key], followupKeys: [sources[1].key], sources };
  const prefix = [
    { kind: "initial_search", result: { execution: "RETURNED_PAGE", hits: [sources[0]] } },
    { kind: "local_source_followup", result: { result: { execution: "RETURNED_PAGE", hits: [sources[1]] } } },
  ];
  const reads = sources.map((source) => ({ kind: "tool", name: "read_source", result: {
    ...source, offset: 1200, content: source.requiredQuote, totalChars: 1800,
  } }));
  const request = { kind: "model_request", round: 2, estimatedInputTokens: 100, inputTokenBudget: 32768 };
  const delivery = { kind: "source_delivery", round: 2, transportAcknowledged: true, understandingVerified: false,
    sources: reads.map((event) => ({ key: event.result.key, revision: event.result.revision,
      offset: event.result.offset, chars: [...event.result.content].length })) };
  const entry = { suite: "n2-retrieval", caseId: scenario.id, status: "COMPLETED",
    nativeRetrievalContract: contract, audit: [...prefix, ...reads, request, delivery] };
  assert.equal(assertLoopbackRegression(entry).qualityVerified, false);
  for (const field of ["offset", "revision", "chars"]) {
    const broken = structuredClone(entry);
    broken.audit.at(-1).sources[0][field] = field === "revision" ? "wrong" : 0;
    assert.throws(() => assertLoopbackRegression(broken), /acknowledged delivery/);
  }
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [...prefix, delivery] }), /original read/);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [...prefix, ...reads] }), /acknowledged delivery/);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [...prefix, ...reads, delivery] }), /acknowledged delivery/);
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [
    ...prefix, ...reads, { ...request, round: 3 }, delivery,
  ] }), /acknowledged delivery/);
  for (const failure of [{ executed: false }, { error: "read failed" }]) {
    const broken = structuredClone(entry);
    Object.assign(broken.audit[2].result, failure);
    assert.throws(() => assertLoopbackRegression(broken), /original read/);
  }
  const invalidFollowup = structuredClone(entry);
  invalidFollowup.audit[1].result.result.execution = "FAILED";
  assert.throws(() => assertLoopbackRegression(invalidFollowup));
  assert.throws(() => assertLoopbackRegression({ ...entry, nativeRetrievalContract: undefined }), /frozen retrieval contract/);
  assert.throws(() => assertLoopbackRegression({ ...entry, suite: undefined }));
  assert.throws(() => assertLoopbackRegression({ ...entry, audit: [
    ...entry.audit, { kind: "tool", name: "read_source", result: { key: "ENTITY:noise" } },
  ] }), /warehouse/);
  const zeroOffset = structuredClone(entry);
  zeroOffset.audit.filter((event) => event.kind === "tool").forEach((event) => { event.result.offset = 0; });
  zeroOffset.audit.at(-1).sources.forEach((source) => { source.offset = 0; });
  assert.throws(() => assertLoopbackRegression(zeroOffset), /later original range/);
  const exact = { ...entry, caseId: "n2-exact-alias-no-repeat", nativeRetrievalContract: {
    initialKeys: [sources[0].key], followupKeys: [], sources: [sources[0]],
  }, audit: [prefix[0], { kind: "local_source_followup", result: { execution: "NOT_RUN" } },
    reads[0], request, delivery] };
  assert.equal(assertLoopbackRegression(exact).qualityVerified, false);
  assert.throws(() => assertLoopbackRegression({ ...exact, audit: [
    prefix[0], prefix[1], reads[0], request, delivery,
  ] }));
  for (const unexpected of [{ error: "followup failed" }, { result: { hits: [] } }]) {
    const broken = structuredClone(exact);
    Object.assign(broken.audit[1].result, unexpected);
    assert.throws(() => assertLoopbackRegression(broken));
  }
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

test("cloud request cap is validated before profile access and cannot bypass authorization", () => {
  for (const value of ["0", "-1", "NaN", "3.5", "451"]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"),
      `--max-model-requests=${value}`], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cloud request cap must be an integer/);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
  for (const args of [["--max-model-requests", "3"], ["--loopback", "--max-model-requests", "3"]]) {
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-model-evaluation.mjs"), ...args],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /allow-cloud|cannot be used with local modes/);
    assert.doesNotMatch(result.stdout, /Desktop launched/);
  }
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

test("model quality review cannot pass a report with no recorded turns even when all scores are filled", async () => {
  const { fixture, hash } = await loadFixture();
  const directory = await mkdtemp(join(tmpdir(), "coauthor-review-missing-turns-"));
  const cases = fixture.cases.slice(0, 1);
  const review = reviewTemplate(cases, 1);
  review[0].reviewer = "synthetic regression reviewer";
  review[0].blockingFailures = [];
  review[0].criteria.forEach((criterion) => { criterion.score = 3; criterion.evidence = "synthetic evidence"; });
  try {
    await writeFile(join(directory, "report.json"), JSON.stringify({
      mode: "realModel", status: "pendingHumanReview", environment: { fixtureSha256: hash },
      selection: { caseIds: cases.map((entry) => entry.id), repetitions: 1 }, turns: [], modelRequests: 0,
    }));
    await writeFile(join(directory, "review.json"), JSON.stringify(review));
    const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-evaluation-review.mjs"), directory],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1, "Filled scores cannot substitute for missing native turns.");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function recordedReviewReport(fixture, hash, repetitions = 2) {
  const cases = fixture.cases.filter((entry) => ["alias-recall", "extend-confirmed"].includes(entry.id));
  const turns = cases.flatMap((entry) => Array.from({ length: repetitions }, (_, repetition) =>
    entry.turns.map((_turn, turnIndex) => ({
      caseId: entry.id, repetition, turnIndex, runId: `${entry.id}-${repetition}-${turnIndex}`,
      status: "COMPLETED", error: null, output: "Complete synthetic response, including its ending.",
      modelRequests: 1, promptVersions: ["synthetic-test"],
      audit: [{ kind: "model_request", round: 1, promptVersion: "synthetic-test" }],
      workingDocumentUnchanged: true, formalContentUnchanged: true,
      taskPreferencesUnchanged: true, feeBudgetSettingsUnchanged: true,
    }))).flat());
  return { mode: "realModel", suite: "fixed", status: "pendingHumanReview",
    environment: { fixtureSha256: hash }, selection: { caseIds: cases.map((entry) => entry.id), repetitions },
    turns, modelRequests: turns.length };
}

test("comparison review binds its own fixture and cannot be substituted for the original fixed suite", async () => {
  const fixed = await loadFixture();
  const comparison = await loadModelFixture("n2-comparison");
  const record = recordedReviewReport(fixed.fixture, fixed.hash, 1).turns[0];
  const scenario = comparison.fixture.cases[0];
  const report = { mode: "realModel", suite: "n2-comparison", status: "pendingHumanReview",
    environment: { fixtureSha256: comparison.hash }, modelRequests: 1,
    selection: { caseIds: [scenario.id], repetitions: 1 },
    turns: [{ ...record, caseId: scenario.id }] };
  assert.equal(assertReviewEvidence(report, comparison.fixture, comparison.hash).samples.length, 1);
  assert.throws(() => assertReviewEvidence(report, fixed.fixture, fixed.hash), /suite and fixture/);
  assert.throws(() => assertReviewEvidence({ ...report, suite: "fixed" }, comparison.fixture, comparison.hash));
  assert.match(renderReviewPacket(report, comparison.fixture, comparison.hash, "synthetic"), /compare-uncertain-explanation/);
});

test("review evidence covers every selected repetition and turn without accepting duplicates or foreign identities", async () => {
  const { fixture, hash } = await loadFixture();
  const report = recordedReviewReport(fixture, hash);
  assert.equal(assertReviewEvidence(report, fixture, hash).samples.length, 6);
  const missing = structuredClone(report);
  missing.turns.pop();
  missing.modelRequests--;
  assert.throws(() => assertReviewEvidence(missing, fixture, hash), /missing recorded turn/);
  for (const mutate of [
    (value) => value.turns.push(value.turns[0]),
    (value) => { value.turns[0].caseId = "foreign"; },
    (value) => { value.turns[0].repetition = -1; },
    (value) => { value.turns[0].repetition = 2; },
    (value) => { value.turns[0].turnIndex = "0"; },
    (value) => { value.turns[0].turnIndex = 0.5; },
    (value) => { value.turns[0].runId = value.turns[1].runId; },
    (value) => { value.turns[0].runId = ""; },
    (value) => { value.selection.caseIds = []; },
    (value) => { value.selection.caseIds.push(value.selection.caseIds[0]); },
    (value) => { value.selection.caseIds = ["foreign"]; },
    (value) => { value.selection.repetitions = 4; },
  ]) {
    const broken = structuredClone(report);
    mutate(broken);
    assert.throws(() => assertReviewEvidence(broken, fixture, hash));
  }
});

test("review evidence rejects interrupted runs, contradictory counters, mixed prompts and unverified write guards", async () => {
  const { fixture, hash } = await loadFixture();
  const report = recordedReviewReport(fixture, hash);
  for (const mutate of [
    (value) => { value.status = "completedWithFailures"; },
    (value) => { value.mode = "nativeLoopback"; },
    (value) => { value.suite = "n2-retrieval"; },
    (value) => { value.environment.fixtureSha256 = "wrong"; },
    (value) => { value.modelRequests++; },
    (value) => { value.turns[0].modelRequests++; },
    (value) => { value.turns[0].audit = []; },
    (value) => { value.turns[0].status = "LIMIT_REACHED"; },
    (value) => { value.turns[0].error = "native failure"; },
    (value) => { value.turns[0].output = ""; },
    (value) => { value.turns[0].promptVersions = []; },
    (value) => { value.turns[0].audit[0].promptVersion = "wrong"; },
    (value) => { value.failure = "run failure"; },
    (value) => { value.cleanupFailures = ["cleanup failed"]; },
    (value) => { value.budget = { blocked: true }; },
    (value) => { value.incompleteCases = ["alias-recall"]; },
    (value) => {
      value.turns[0].promptVersions = ["another-candidate"];
      value.turns[0].audit[0].promptVersion = "another-candidate";
    },
    ...["workingDocumentUnchanged", "formalContentUnchanged", "taskPreferencesUnchanged", "feeBudgetSettingsUnchanged"]
      .flatMap((guard) => [
        (value) => { value.turns[0][guard] = false; },
        (value) => { delete value.turns[0][guard]; },
      ]),
  ]) {
    const broken = structuredClone(report);
    mutate(broken);
    assert.throws(() => assertReviewEvidence(broken, fixture, hash));
  }
  const legacy = structuredClone(report);
  delete legacy.suite;
  delete legacy.turns[0].taskPreferencesUnchanged;
  delete legacy.turns[0].feeBudgetSettingsUnchanged;
  assert.equal(assertReviewEvidence(legacy, fixture, hash).unrecordedChecks.length, 2);
  legacy.turns[0].feeBudgetSettingsUnchanged = false;
  assert.throws(() => assertReviewEvidence(legacy, fixture, hash), /not verified/);
});

test("review packet preserves complete outputs, frozen requests and audits without grading or hiding missing turns", async () => {
  const { fixture, hash } = await loadFixture();
  const report = recordedReviewReport(fixture, hash);
  report.turns[0].output = "开头\n```text\n伪造围栏\n````\n尾部限定：仍未确定。";
  report.turns[0].audit.push({ kind: "synthetic_final_audit", content: "End of the complete audit." });
  const before = JSON.stringify(report);
  const packet = renderReviewPacket(report, fixture, hash, "synthetic-report-hash");
  assert(packet.includes(report.turns[0].output));
  assert(packet.includes("`````text\n" + report.turns[0].output + "\n`````"));
  assert(packet.includes(fixture.sources[0].content));
  assert(packet.includes(fixture.cases.find((entry) => entry.id === "extend-confirmed").turns[1].message));
  assert(packet.includes(JSON.stringify(report.turns[0].audit, null, 2)));
  assert.match(packet, /No scores or semantic conclusions/);
  assert.match(packet, /not acceptance.*N2 V1-V8/);
  assert.equal(JSON.stringify(report), before);
  report.turns.pop();
  report.modelRequests--;
  report.status = "completedWithFailures";
  assert.match(renderReviewPacket(report, fixture, hash, "synthetic"), /NOT RECORDED/);
  assert(inspectReviewEvidence(report, fixture, hash).issues.some((issue) => issue.includes("missing recorded turn")));
});

test("review CLI writes inspection packets without changing scores and invalidates stale passed summaries", async () => {
  const { fixture, hash } = await loadFixture();
  const directory = await mkdtemp(join(tmpdir(), "coauthor-review-evidence-"));
  const report = recordedReviewReport(fixture, hash);
  const cases = fixture.cases.filter((entry) => report.selection.caseIds.includes(entry.id));
  const review = reviewTemplate(cases, report.selection.repetitions);
  const invoke = (...args) => spawnSync(process.execPath,
    [join(workspace, "tools/coauthor-evaluation-review.mjs"), ...args, directory],
    { encoding: "utf8", windowsHide: true });
  const readSummary = async () => JSON.parse(await readFile(join(directory, "quality-summary.json"), "utf8"));
  try {
    const reportRaw = JSON.stringify(report);
    const reviewRaw = JSON.stringify(review);
    await writeFile(join(directory, "report.json"), reportRaw);
    await writeFile(join(directory, "review.json"), reviewRaw);
    assert.equal(invoke("--packet").status, 0);
    assert.match(await readFile(join(directory, "review-packet.md"), "utf8"), /Complete Recorded Output/);
    assert.equal(await readFile(join(directory, "report.json"), "utf8"), reportRaw);
    assert.equal(await readFile(join(directory, "review.json"), "utf8"), reviewRaw);
    assert.equal(invoke().status, 1);
    const pending = await readSummary();
    assert.equal(pending.status, "pending");
    assert.match(pending.reportSha256, /^[0-9a-f]{64}$/);
    assert.match(pending.reviewSha256, /^[0-9a-f]{64}$/);
    assert.equal(pending.selection.fullFixedSuite, false);
    assert.equal(pending.selection.recordedTurns, 6);
    for (const row of review) {
      row.reviewer = "synthetic regression reviewer";
      row.blockingFailures = [];
      row.criteria.forEach((criterion) => { criterion.score = 3; criterion.evidence = "synthetic regression only"; });
    }
    await writeFile(join(directory, "review.json"), JSON.stringify(review));
    assert.equal(invoke().status, 0);
    assert.equal((await readSummary()).status, "passed", "This is synthetic CLI regression, not a real quality result.");
    report.turns.pop();
    report.modelRequests--;
    await writeFile(join(directory, "report.json"), JSON.stringify(report));
    assert.equal(invoke().status, 1);
    const invalid = await readSummary();
    assert.equal(invalid.status, "invalid");
    assert.match(invalid.failure, /missing recorded turn/);
    assert.notEqual(invalid.reportSha256, pending.reportSha256);
    report.mode = "nativeLoopback";
    await writeFile(join(directory, "report.json"), JSON.stringify(report));
    assert.equal(invoke("--packet").status, 1);
    assert.equal(invoke().status, 1);
    assert.equal((await readSummary()).status, "invalid");
    await writeFile(join(directory, "quality-summary.json"), JSON.stringify({ status: "passed" }));
    await writeFile(join(directory, "report.json"), "{broken");
    assert.equal(invoke().status, 1);
    assert.equal((await readSummary()).status, "invalid", "Unreadable evidence must not leave a stale pass.");
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test("current native protocol delivers final discussion without an extra simulated request", () => {
  const context = { contextOnly: true, relevantSources: { hits: [] }, relevantDecisions: { memories: [],
    decisionScope: { origin: "CURRENT_BRANCH_DISCUSSION", updatesFormalSources: false, impliesFormalSyncRequired: false } } };
  const messages = [{ role: "user", content: JSON.stringify(context) }, { role: "user", content: "普通讨论" }];
  const body = { messages, tools: [{ function: { name: "deliver_reply" } }] };
  const result = coauthorLoopbackTurn(body);
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].function.name, "deliver_reply");
  const args = JSON.parse(result.tool_calls[0].function.arguments);
  assert.equal(args.mode, "DISCUSSION");
  assert.match(args.content, /不用于创作质量评分/);
  assert.equal(result.content, "");
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "edit", function: { name: "edit_draft" } }] },
    { role: "tool", tool_call_id: "edit", content: JSON.stringify({ prepared: true }) });
  assert.match(coauthorLoopbackTurn(body).content, /不用于创作质量评分/,
    "Draft completion must remain a program receipt, not a second final delivery.");
});

test("local content-review adapter uses the isolated read-only contract without pretending to grade quality", () => {
  const body = { tool_choice: "required", tools: [{ function: { name: "review_reply" } }],
    messages: [{ role: "system", content: "仅复核" }, { role: "user", content: JSON.stringify({
      contentReview: true, version: "coauthor-review-v3", candidate: "候选",
      bases: [{ id: "request", text: "作者本轮要求" }],
      riskReasons: ["AUTHOR_REQUESTED"],
    }) }] };
  const message = coauthorLoopbackTurn(body);
  assert.equal(message.tool_calls[0].function.name, "review_reply");
  const result = JSON.parse(message.tool_calls[0].function.arguments);
  assert.equal(result.decision, "PASS");
  assert.deepEqual(result.issues, []);
  assert(!Object.hasOwn(result, "checks"));
  assert.match(result.summary, /不作为语义质量证据/);
  assert.deepEqual(coauthorReviewTurn(body), message);
  assert.throws(() => coauthorReviewTurn({ ...body, tools: [...body.tools, { function: { name: "prepare_changeset" } }] }));
  assert.throws(() => coauthorReviewTurn({ ...body, messages: [...body.messages, { role: "tool", content: "{}" }] }));
});

test("native source reads copy only program references and cannot substitute a fixture identity", () => {
  const source = { key: "ENTITY:realm", revision: "382f1b21-38a9-4319-b93a-d919781f6329:1:hash",
    title: "九曜境界体系", sourceReference: "source-0-1",
    provenance: { origin: "PROJECT_SHARED", isDiscussionDecision: false, truthDeterminedByLocation: false } };
  const context = { contextOnly: true, relevantSources: { hits: [source] }, relevantDecisions: { memories: [],
    decisionScope: { origin: "CURRENT_BRANCH_DISCUSSION", updatesFormalSources: false, impliesFormalSyncRequired: false } } };
  const body = { messages: [{ role: "user", content: JSON.stringify(context) }, { role: "user", content: "普通讨论" }],
    tools: [{ function: { name: "read_source", parameters: { required: ["reference"] } } }] };
  const message = coauthorLoopbackTurn(body);
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { reference: "source-0-1", offset: 0, limit: 2000 });
  delete source.sourceReference;
  body.messages[0].content = JSON.stringify(context);
  assert.throws(() => coauthorLoopbackTurn(body), /actual delivered candidate/);
});

test("delivery smoke refuses cloud or arbitrary options before starting a desktop", () => {
  const result = spawnSync(process.execPath, [join(workspace, "tools/coauthor-delivery-smoke.mjs"), "--allow-cloud"],
    { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local-only smoke test accepts no cloud\/profile options/);
  assert(!result.stdout.includes("Desktop launched"));
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
  const displayText = '关键词 "契约 交易 代价 术法"（项目资料，offset=0）：实际返回 4 条\n'
    + '关键词 "砂"（项目资料，offset=0）：未形成有效查询，不能记为 0 命中';
  const entry = { status: "COMPLETED", caseId: "absent-not-absolute",
    output: "未找到直接设定，不能据此断言不存在。",
    audit: [{ kind: "retrieval_summary", receipts, displayText }] };
  assert(assertLoopbackRegression(entry).scriptedNativeRegression);
  assert.throws(() => assertLoopbackRegression({ ...entry,
    output: `${entry.output}\n\n检索操作回执（程序记录；…）` }));
  assert.throws(() => assertLoopbackRegression({ ...entry,
    audit: [{ kind: "retrieval_summary", displayText, receipts: [receipts[0], { ...receipts[1], returned: 0 }] }] }));
  assert.throws(() => assertLoopbackRegression({ ...entry,
    audit: [{ kind: "retrieval_summary", displayText, receipts: receipts.slice(0, 2) }] }));
  for (const invalid of [{ ...receipts[2], returned: 0 },
    { ...receipts[2], status: "RETURNED_PAGE", returned: 0 }]) {
    assert.throws(() => assertLoopbackRegression({ ...entry,
      audit: [{ kind: "retrieval_summary", displayText, receipts: [...receipts.slice(0, 2), invalid] }] }));
  }
  assert.throws(() => assertLoopbackRegression({ ...entry,
    audit: [{ kind: "retrieval_summary", receipts,
      displayText: '关键词 "契约 交易 代价 术法"（项目资料，offset=0）：实际返回 4 条' }] }));
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
  assert.equal(assertLoopbackRegression({ ...entry, promptVersions: ["coauthor-v32"] }).scriptedNativeRegression, true);
  assert.throws(() => assertLoopbackRegression({ ...entry, promptVersions: ["coauthor-v21"] }));
  assert.throws(() => assertLoopbackRegression({ ...entry, promptVersions: ["coauthor-v32", "coauthor-v31"] }));
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
