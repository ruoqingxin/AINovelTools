import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assessReview, loadFixture } from "./coauthor-evaluation-core.mjs";

assert.equal(process.argv.length, 3, "Usage: node tools/coauthor-evaluation-review.mjs <evaluation-directory>");
const directory = resolve(process.argv[2]);
const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
assert.equal(report.mode, "realModel", "Mock, prepared-only and local retrieval runs cannot pass model quality review.");
assert.equal(report.status, "pendingHumanReview", "Only complete real-model runs are eligible.");
const { fixture, hash } = await loadFixture();
assert.equal(report.environment.fixtureSha256, hash, "Fixture changed; do not mix review versions.");
const review = JSON.parse(await readFile(join(directory, "review.json"), "utf8"));
const cases = fixture.cases.filter((c) => report.selection.caseIds.includes(c.id));
const result = assessReview(review, cases, report.selection.repetitions, fixture.thresholds.humanScoreMin);
await writeFile(join(directory, "quality-summary.json"), JSON.stringify(result, null, 2));
console.log(`Recorded-sample human quality: ${result.status}`);
if (result.status !== "passed") process.exitCode = 1;
