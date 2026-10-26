import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assessReview, loadModelFixture } from "./coauthor-evaluation-core.mjs";
import { assertReviewEvidence, renderReviewPacket } from "./coauthor-review-evidence.mjs";

const { values, positionals } = parseArgs({ options: { packet: { type: "boolean", default: false } },
  allowPositionals: true });
assert.equal(positionals.length, 1, "Usage: node tools/coauthor-evaluation-review.mjs [--packet] <evaluation-directory>");
const directory = resolve(positionals[0]);
let fixture, hash;
let result, reportSha256 = null, reviewSha256 = null;
try {
  const raw = await readFile(join(directory, "report.json"), "utf8");
  reportSha256 = createHash("sha256").update(raw).digest("hex");
  const report = JSON.parse(raw);
  ({ fixture, hash } = await loadModelFixture(report.suite ?? "fixed"));
  if (values.packet) {
    const packet = renderReviewPacket(report, fixture, hash, reportSha256);
    await writeFile(join(directory, "review-packet.md"), packet);
    console.log(`Inspection packet: ${join(directory, "review-packet.md")}; scores and original evidence unchanged.`);
  } else {
    const evidence = assertReviewEvidence(report, fixture, hash);
    const reviewRaw = await readFile(join(directory, "review.json"), "utf8");
    reviewSha256 = createHash("sha256").update(reviewRaw).digest("hex");
    result = { ...assessReview(JSON.parse(reviewRaw), evidence.cases, evidence.repetitions, fixture.thresholds.humanScoreMin),
      selection: { ...report.selection, recordedTurns: report.turns.length,
        fullSuite: evidence.cases.length === fixture.cases.length,
        fullFixedSuite: (report.suite ?? "fixed") === "fixed" && evidence.cases.length === fixture.cases.length },
      unrecordedChecks: evidence.unrecordedChecks };
  }
} catch (error) {
  if (values.packet) throw error;
  result = { status: "invalid", failure: String(error.message ?? error) };
}
if (!values.packet) {
  await writeFile(join(directory, "quality-summary.json"), JSON.stringify({
    ...result, reportSha256, ...(reviewSha256 ? { reviewSha256 } : {}), fixtureSha256: hash,
  }, null, 2));
  console.log(`Recorded-sample human quality: ${result.status}`);
  if (result.failure) console.error(result.failure);
  if (result.status !== "passed") process.exitCode = 1;
}
