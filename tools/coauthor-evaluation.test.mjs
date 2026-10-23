import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { assessReview, distribution, loadFixture, nativeRows, percentile, reserveCost,
  retrievalScore, reviewTemplate, summarizeBaseline, validateCloudOptions } from "./coauthor-evaluation-core.mjs";
import { workspace } from "./desktop-smoke-runtime.mjs";

test("fixed scenes cover all goals, workload types and valid relevance identities", async () => {
  const { fixture, hash } = await loadFixture();
  assert.equal(hash.length, 64);
  assert.equal(fixture.cases.length, 13);
  assert.deepEqual(new Set(fixture.cases.map((c) => c.goal)), new Set(["proactive", "relevant", "grounded"]));
  assert.deepEqual(new Set(fixture.cases.map((c) => c.workload)), new Set(["discussion", "localEdit", "fullCheck"]));
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
