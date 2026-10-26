import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { workspace } from "./desktop-smoke-runtime.mjs";

export const fixturePath = join(workspace, "tools/fixtures/coauthor-evaluation.json");
export async function loadFixture() {
  const raw = await readFile(fixturePath, "utf8");
  const fixture = JSON.parse(raw);
  assert.equal(fixture.version, 1);
  const ids = new Set(fixture.sources.map((s) => s.id));
  assert.equal(ids.size, fixture.sources.length);
  assert.equal(new Set(fixture.cases.map((c) => c.id)).size, fixture.cases.length);
  for (const c of fixture.cases) {
    assert(c.turns.length && c.rubric.length, `Incomplete case ${c.id}`);
    assert(c.retrieval.relevant.every((id) => ids.has(id)), `Unknown source in ${c.id}`);
  }
  return { fixture, hash: createHash("sha256").update(raw).digest("hex") };
}

export async function loadModelFixture(suite = "fixed") {
  if (suite === "fixed") return loadFixture();
  if (suite === "n2-comparison") {
    const raw = await readFile(join(workspace, "tools/fixtures/coauthor-deepseek-comparison.json"), "utf8");
    const fixture = JSON.parse(raw);
    assert.equal(fixture.version, "coauthor-deepseek-comparison-v1");
    assert.equal(fixture.name, suite);
    const ids = new Set(fixture.sources.map((source) => source.id));
    assert.equal(ids.size, fixture.sources.length);
    assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, fixture.cases.length);
    for (const entry of fixture.cases) {
      assert(entry.turns.length && entry.rubric.length);
      assert(entry.retrieval.relevant.every((id) => ids.has(id)));
    }
    return { fixture, hash: createHash("sha256").update(raw).digest("hex") };
  }
  assert.equal(suite, "n2-retrieval", "Unknown evaluation suite.");
  const raw = await readFile(join(workspace, "tools/fixtures/coauthor-n2-regression.json"), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.version, "coauthor-n2-v1");
  const sources = data.retrieval.sources;
  const cases = data.retrieval.cases.map((entry) => {
    const required = [...entry.expectedInitial, ...entry.expectedFollowup];
    assert.equal(new Set(required).size, required.length);
    const contractSources = required.map((id) => {
      const source = sources.find((candidate) => candidate.id === id);
      assert(source, `Unknown N2 source ${id}`);
      return { id, title: source.title, requiredQuote: source.content };
    });
    return {
      id: `n2-${entry.id}`, goal: "relevant", workload: "discussion",
      turns: [{ message: entry.query }], prefixRepeat: entry.prefixRepeat,
      retrieval: { query: entry.query, relevant: ["ladder", "cost"] },
      rubric: ["初始、补查与原文送达分开核对，不视为自然语言质量评分", "准确版本和关键限制原文实际送达，不引入无关仓库"],
      nativeRetrievalContract: {
        expectedInitial: entry.expectedInitial, expectedFollowup: entry.expectedFollowup,
        sources: contractSources,
      },
    };
  });
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  return { fixture: { version: data.version, name: "n2-retrieval", sources, cases },
    hash: createHash("sha256").update(raw).digest("hex") };
}

export function percentile(values, p) {
  assert(p > 0 && p <= 1);
  assert(values.every((v) => Number.isFinite(v) && v >= 0), "Invalid measurement");
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

export function distribution(values, minimum = 20) {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95),
    sufficient: values.length >= minimum };
}

export function retrievalScore(expected, hits) {
  const keys = [...new Set(hits.slice(0, 12).map((hit) => hit.key))];
  const relevant = new Set(expected);
  const found = keys.filter((key) => relevant.has(key));
  const first = keys.findIndex((key) => relevant.has(key));
  return {
    recallAt12: relevant.size ? found.length / relevant.size : null,
    noiseAt12: keys.length ? (keys.length - found.length) / keys.length : 0,
    reciprocalRank: relevant.size ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    falseEmpty: relevant.size > 0 && keys.length === 0,
    returned: keys.length,
  };
}

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function summarizeBaseline(rows, fixture) {
  const queries = rows.filter((r) => r.type === "query");
  if (queries.some((r) => Object.hasOwn(r, "followupHits") || Object.hasOwn(r, "followupElapsedMs"))) {
    assert(queries.every((r) => Array.isArray(r.followupHits) && Number.isFinite(r.followupElapsedMs)
      && r.followupElapsedMs >= 0), "Incomplete followup measurements");
  }
  const results = fixture.scales.map((scale) => {
    const selected = queries.filter((r) => r.scale === scale.name);
    assert.equal(selected.length, fixture.cases.length * 30, "Incomplete baseline samples");
    const cases = fixture.cases.map((c) => {
      const samples = selected.filter((r) => r.caseId === c.id);
      assert.equal(new Set(samples.map((s) => s.sample)).size, 30, "Missing or duplicate samples");
      assert(samples.every((s) => s.pending === 0), "Incomplete index cannot be a warm baseline");
      const scores = samples.map((s) => retrievalScore(s.expectedKeys, s.hits));
      const followup = samples.every((s) => Array.isArray(s.followupHits) && Number.isFinite(s.followupElapsedMs)
        && s.followupElapsedMs >= 0) ? (() => {
          const combined = samples.map((s) => retrievalScore(s.expectedKeys, [...s.hits, ...s.followupHits]));
          return {
            latencyMs: distribution(samples.map((s) => s.followupElapsedMs), fixture.thresholds.warmSamplesMin),
            combinedLatencyMs: distribution(samples.map((s) => s.elapsedMs + s.followupElapsedMs), fixture.thresholds.warmSamplesMin),
            candidateRecallAt12: mean(combined.map((s) => s.recallAt12).filter((s) => s !== null)),
            candidateNoiseAt12: mean(combined.map((s) => s.noiseAt12)),
            falseEmptyRate: mean(combined.map((s) => Number(s.falseEmpty))),
          };
        })() : null;
      return { caseId: c.id, latencyMs: distribution(samples.map((s) => s.elapsedMs), fixture.thresholds.warmSamplesMin),
        recallAt12: mean(scores.map((s) => s.recallAt12).filter((s) => s !== null)),
        noiseAt12: mean(scores.map((s) => s.noiseAt12)),
        falseEmptyRate: mean(scores.map((s) => Number(s.falseEmpty))),
        mrr: mean(scores.map((s) => s.reciprocalRank).filter((s) => s !== null)),
        returnedExcerptChars: distribution(samples.map((s) => s.hits.reduce((n, h) => n + h.chars, 0))),
        hasMore: samples.some((s) => s.hasMore), localFollowup: followup };
    });
    const cold = rows.filter((r) => r.type === "coldIndex" && r.scale.name === scale.name);
    assert.equal(cold.length, 1, "Missing cold build");
    const recall = mean(cases.map((c) => c.recallAt12).filter((v) => v !== null));
    const noise = mean(cases.map((c) => c.noiseAt12));
    const falseEmpty = mean(cases.filter((c) => c.recallAt12 !== null).map((c) => c.falseEmptyRate));
    const latency = distribution(selected.map((r) => r.elapsedMs));
    const followup = cases.every((c) => c.localFollowup) ? {
      candidateRecallAt12: mean(cases.map((c) => c.localFollowup.candidateRecallAt12).filter((v) => v !== null)),
      candidateNoiseAt12: mean(cases.map((c) => c.localFollowup.candidateNoiseAt12)),
      falseEmptyRate: mean(cases.filter((c) => c.recallAt12 !== null).map((c) => c.localFollowup.falseEmptyRate)),
      latencyMs: distribution(selected.map((r) => r.followupElapsedMs)),
      combinedLatencyMs: distribution(selected.map((r) => r.elapsedMs + r.followupElapsedMs)),
    } : null;
    return { scale, coldIndex: { elapsedMs: cold[0].elapsedMs, n: 1, passes: cold[0].passes },
      latencyMs: latency, recallAt12: recall, noiseAt12: noise, falseEmptyRate: falseEmpty, cases,
      localFollowup: followup,
      gates: {
        recall: recall >= fixture.thresholds.recallAt12Min,
        noise: noise <= fixture.thresholds.noiseAt12Max,
        falseEmpty: falseEmpty <= fixture.thresholds.falseEmptyRateMax,
        warmP95: cases.every((c) => c.latencyMs.sufficient && c.latencyMs.p95 <= fixture.thresholds.warmP95MsMax),
        ...(followup ? {
          followupRecall: followup.candidateRecallAt12 >= fixture.thresholds.recallAt12Min,
          followupNoise: followup.candidateNoiseAt12 <= fixture.thresholds.noiseAt12Max,
          followupFalseEmpty: followup.falseEmptyRate <= fixture.thresholds.falseEmptyRateMax,
          combinedWarmP95: cases.every((c) => c.localFollowup.combinedLatencyMs.sufficient
            && c.localFollowup.combinedLatencyMs.p95 <= fixture.thresholds.warmP95MsMax),
        } : {}),
      } };
  });
  return { mode: "localRetrieval", modelRequests: 0, results,
    gatesPassed: results.every((r) => Object.values(r.gates).every(Boolean)),
    limitations: [
      "Synthetic labeled corpus, keyword retrieval and optional bounded lexical followup; not real-model acceptance or a real long-novel SLA.",
      "Initial and followup candidate coverage are separate; discovered candidates are not original-text delivery or understanding.",
      "Cold index measured once per scale; no cold P50/P95 or OS cache-flush claim.",
      "Excerpt characters measure returned payload, not internal database reads, sent tokens or citation correctness.",
      "No old/new semantic-quality comparison is claimed. Relevant labels and thresholds are reviewable targets.",
    ] };
}

export function environment(hash) {
  const git = (...args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).stdout?.trim() ?? null;
  return { at: new Date().toISOString(), fixtureSha256: hash, commit: git("rev-parse", "HEAD"),
    dirtyWorktree: Boolean(git("status", "--porcelain")), os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, memoryBytes: totalmem(),
    node: process.version, build: "Rust debug tests; no parallel measurement jobs" };
}

export function nativeRows(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.includes("COAUTHOR_EVAL "))
    .map((line) => JSON.parse(line.slice(line.indexOf("COAUTHOR_EVAL ") + 14)));
}

export function validateCloudOptions(values, fixture) {
  assert.equal(values["allow-cloud"], true, "Real evaluation requires --allow-cloud.");
  assert.match(values["cloud-profile"] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Explicit --cloud-profile UUID required.");
  const maxCostMicros = Number(values["max-cost-micros"]);
  assert(Number.isSafeInteger(maxCostMicros) && maxCostMicros > 0, "Positive --max-cost-micros required.");
  assert.match(values.currency ?? "", /^[A-Z]{3}$/, "--currency required.");
  const repetitions = Number(values.repetitions ?? 1);
  assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3, "Repetitions must be 1..3.");
  const ids = values.case ? values.case.split(",") : fixture.cases.map((c) => c.id);
  assert(ids.length && new Set(ids).size === ids.length && ids.every((id) => fixture.cases.some((c) => c.id === id)), "Unknown or duplicate case.");
  return { maxCostMicros, repetitions, cases: fixture.cases.filter((c) => ids.includes(c.id)) };
}

export function reserveCost(profile, currency, turns) {
  assert.equal(profile.capability, "CHAT");
  assert.equal(profile.privacy_level, "ALLOW_CLOUD");
  assert(profile.secret_ref, "Selected profile must have a credential.");
  const endpoint = new URL(profile.base_url);
  assert(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password, "Credential-free HTTPS endpoint required.");
  assert.equal(profile.price_currency, currency, "Budget currency must match configured prices.");
  for (const key of ["input_price_micros_per_million", "output_price_micros_per_million", "context_window", "max_output_tokens"]) {
    assert(Number.isSafeInteger(profile[key]) && profile[key] > 0, `Missing/zero/invalid ${key}; configure prices before cloud evaluation.`);
  }
  assert(profile.context_window >= 65_536, "Evaluation needs at least 65536 context tokens for the existing tool definitions.");
  // Reserve the entire configured context window for each of ten possible requests.
  // This is a configured-price estimate, never a provider billing guarantee.
  const perTurn = 10 * (Math.ceil(profile.context_window * profile.input_price_micros_per_million / 1_000_000)
    + Math.ceil(Math.min(profile.max_output_tokens, 2048) * profile.output_price_micros_per_million / 1_000_000));
  const reserved = perTurn * turns;
  assert(Number.isSafeInteger(reserved) && reserved > 0);
  return reserved;
}

export function reviewTemplate(cases, repetitions) {
  return cases.flatMap((c) => Array.from({ length: repetitions }, (_, repetition) => ({
    caseId: c.id, repetition, goal: c.goal, workload: c.workload,
    criteria: c.rubric.map((criterion) => ({ criterion, score: null, evidence: null })),
    blockingFailures: null, reviewer: null, firstUsefulResultMs: null,
    notes: null, status: "pending",
  })));
}

export function assessReview(review, cases, repetitions, minimumScore = 2) {
  assert(Array.isArray(review), "Review must be an array.");
  assert(cases.length > 0 && Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3,
    "An explicit non-empty review selection is required.");
  assert(Number.isInteger(minimumScore) && minimumScore >= 0 && minimumScore <= 3);
  const expected = reviewTemplate(cases, repetitions);
  const keys = review.map((r) => `${r.caseId}:${r.repetition}`);
  assert.equal(new Set(keys).size, keys.length, "Duplicate review row.");
  assert(review.every((r) => expected.some((e) => e.caseId === r.caseId && e.repetition === r.repetition)),
    "Unknown review row.");
  const results = expected.map((e) => {
    const row = review.find((r) => r.caseId === e.caseId && r.repetition === e.repetition);
    const complete = row && typeof row.reviewer === "string" && row.reviewer.trim().length > 0
      && Array.isArray(row.blockingFailures)
      && row.blockingFailures.every((f) => typeof f.code === "string" && f.code.length > 0
        && typeof f.evidence === "string" && f.evidence.trim().length > 0)
      && Array.isArray(row.criteria) && row.criteria.length === e.criteria.length
      && row.criteria.every((c, i) => c.criterion === e.criteria[i].criterion
        && Number.isInteger(c.score) && c.score >= 0 && c.score <= 3
        && typeof c.evidence === "string" && c.evidence.trim().length > 0);
    const blocked = Array.isArray(row?.blockingFailures) && row.blockingFailures.length > 0;
    return { caseId: e.caseId, repetition: e.repetition, goal: e.goal,
      status: blocked ? "failed" : !complete ? "pending" : row.criteria.some((c) => c.score < minimumScore) ? "failed" : "passed" };
  });
  return { status: results.some((r) => r.status === "failed") ? "failed"
    : results.some((r) => r.status === "pending") ? "pending" : "passed",
  cases: results, limitations: ["Human review of these recorded samples only, not a guarantee for arbitrary novels."] };
}

export async function writeReport(directory, report) {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  const lines = ["# Coauthor Evaluation", "", `Mode: ${report.mode}`,
    `Fixture: ${report.environment.fixtureSha256}`, `Commit: ${report.environment.commit}`, ""];
  if (report.suite) lines.push(`Suite: ${report.suite}`, "");
  if (report.mode === "localRetrieval") {
    lines.push("| Scale | Cold ms (n=1) | Warm n | P50 ms | P95 ms | Recall@12 | Noise@12 | False empty |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const r of report.results) {
      lines.push(`| ${r.scale.name} | ${r.coldIndex.elapsedMs.toFixed(2)} | ${r.latencyMs.n} | ${r.latencyMs.p50.toFixed(2)} | ${r.latencyMs.p95.toFixed(2)} | ${r.recallAt12.toFixed(3)} | ${r.noiseAt12.toFixed(3)} | ${r.falseEmptyRate.toFixed(3)} |`);
    }
    lines.push("", `Local target gates: ${report.gatesPassed ? "PASS" : "FAIL"}. Not model acceptance.`);
    if (report.results.some((r) => r.localFollowup)) {
      lines.push("", "| Scale | Followup P95 ms | Combined P95 ms | Candidate Recall@12 | Candidate Noise@12 |",
        "| --- | ---: | ---: | ---: | ---: |");
      for (const r of report.results.filter((r) => r.localFollowup)) {
        const f = r.localFollowup;
        lines.push(`| ${r.scale.name} | ${f.latencyMs.p95.toFixed(2)} | ${f.combinedLatencyMs.p95.toFixed(2)} | ${f.candidateRecallAt12.toFixed(3)} | ${f.candidateNoiseAt12.toFixed(3)} |`);
      }
      lines.push("", "Candidate coverage is not original-text delivery or semantic acceptance; initial metrics above are unchanged.");
    }
    for (const r of report.results) {
      const failures = r.cases.filter((c) => c.recallAt12 !== null && c.recallAt12 < 1);
      lines.push("", `${r.scale.name} incomplete recall: ${failures.map((c) => `${c.caseId}=${c.recallAt12.toFixed(3)}`).join(", ") || "none"}`);
    }
  } else {
    lines.push(`Status: ${report.status}`, `Recorded turns: ${report.turns.length}`,
      `Completed turns: ${report.turns.filter((t) => t.status === "COMPLETED").length}`,
      `Model requests: ${report.modelRequests}`,
      "Real-model semantic acceptance remains pending until the human review is completed.");
    if (report.failure) lines.push("", `Failure: ${report.failure}`);
    if (report.budget) {
      lines.push("", `Configured-price conservative charge: ${report.budget.conservativeSpentMicros / 1_000_000} ${report.budget.currency}`,
        `Authorized budget: ${report.budget.limitMicros / 1_000_000} ${report.budget.currency}`,
        `Budget blocked: ${report.budget.blocked}. Not the provider invoice; see budget.json.`);
    }
    if (report.turns.length) {
      lines.push("", "| Case | Turn | Status | Elapsed ms | Requests | Tool errors |",
        "| --- | ---: | --- | ---: | ---: | ---: |");
      for (const t of report.turns) {
        lines.push(`| ${t.caseId} | ${t.turnIndex + 1} | ${t.status} | ${t.elapsedMs.toFixed(2)} | ${t.modelRequests} | ${t.toolErrors} |`);
      }
    }
  }
  lines.push("", ...(report.limitations ?? []).map((s) => `- ${s}`));
  await writeFile(join(directory, "report.md"), lines.join("\n") + "\n");
}
