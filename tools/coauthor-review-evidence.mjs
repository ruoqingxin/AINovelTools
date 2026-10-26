import assert from "node:assert/strict";

const keyOf = (turn) => `${turn.caseId}:${turn.repetition}:${turn.turnIndex}`;
const guards = ["workingDocumentUnchanged", "formalContentUnchanged",
  "taskPreferencesUnchanged", "feeBudgetSettingsUnchanged"];

export function inspectReviewEvidence(report, fixture, hash) {
  assert.equal(report.mode, "realModel", "Mock, prepared-only and local retrieval runs cannot pass model quality review.");
  const suite = report.suite ?? "fixed";
  assert(["fixed", "n2-comparison"].includes(suite), "Unsupported real-model review suite.");
  assert.equal(suite, fixture.version === 1 ? "fixed" : fixture.name, "Review suite and fixture must agree.");
  assert.equal(report.environment?.fixtureSha256, hash, "Fixture changed; do not mix review versions.");
  const ids = report.selection?.caseIds;
  const repetitions = report.selection?.repetitions;
  assert(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length
    && ids.every((id) => fixture.cases.some((entry) => entry.id === id)), "Unknown, empty or duplicate review selection.");
  assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3, "Repetitions must be 1..3.");
  assert(Array.isArray(report.turns), "Recorded turns must be an array.");
  const cases = fixture.cases.filter((entry) => ids.includes(entry.id));
  const samples = cases.flatMap((entry) => Array.from({ length: repetitions }, (_, repetition) =>
    entry.turns.map((turn, turnIndex) => ({ caseId: entry.id, repetition, turnIndex, request: turn.message }))).flat());
  const expected = new Map(samples.map((sample) => [keyOf(sample), sample]));
  const identities = new Set();
  const issues = [];
  const unrecordedChecks = [];
  for (const [index, turn] of report.turns.entries()) {
    assert(Number.isInteger(turn.repetition) && Number.isInteger(turn.turnIndex), "Turn indices must be integers.");
    const sample = expected.get(keyOf(turn));
    assert(sample, "Unknown recorded turn outside the selected fixture.");
    assert(sample.record === undefined, "Duplicate recorded turn.");
    assert(typeof turn.runId === "string" && turn.runId.trim() && !identities.has(turn.runId),
      "Missing or duplicate native run identity.");
    identities.add(turn.runId);
    sample.record = turn;
    sample.reportIndex = index;
    const problem = (message) => issues.push(`${keyOf(turn)}: ${message}`);
    if (turn.status !== "COMPLETED") problem(`status ${turn.status}`);
    if (turn.error != null) problem("native error recorded");
    if (turn.status === "COMPLETED" && (typeof turn.output !== "string" || !turn.output.trim())) {
      problem("completed turn has no output");
    }
    assert(Array.isArray(turn.audit), "Native audit must be an array.");
    const requests = turn.audit.filter((event) => event.kind === "model_request");
    if (!Number.isSafeInteger(turn.modelRequests) || turn.modelRequests !== requests.length
      || turn.modelRequests < 0 || turn.modelRequests > 10 || (turn.status === "COMPLETED" && !turn.modelRequests)) {
      problem("model request count does not match the native audit");
    }
    if (!Array.isArray(turn.promptVersions) || turn.promptVersions.length !== 1
      || !turn.promptVersions[0] || requests.some((event) => event.promptVersion !== turn.promptVersions[0])) {
      problem("prompt version does not match the native requests");
    }
    for (const guard of guards) {
      if (turn[guard] === true) continue;
      // Older reports predate the two budget-setting guards; do not invent their evidence.
      if (report.suite === undefined && !Object.hasOwn(turn, guard) && guards.indexOf(guard) >= 2) {
        unrecordedChecks.push(`${keyOf(turn)}: ${guard}`);
      } else problem(`${guard} is not verified`);
    }
  }
  for (const sample of samples) {
    if (!sample.record) issues.push(`${keyOf(sample)}: missing recorded turn`);
  }
  const requests = report.turns.reduce((count, turn) =>
    count + turn.audit.filter((event) => event.kind === "model_request").length, 0);
  if (!Number.isSafeInteger(report.modelRequests) || report.modelRequests !== requests) {
    issues.push("Report request total does not match the native audit.");
  }
  if (report.failure) issues.push(`Run failure: ${report.failure}`);
  if (report.cleanupFailures?.length) issues.push("Native evaluation cleanup failed.");
  if (report.budget?.blocked) issues.push("The evaluation budget guard stopped the run.");
  if (report.incompleteCases?.length) issues.push("The report declares incomplete cases.");
  if (new Set(report.turns.flatMap((turn) => turn.promptVersions ?? [])).size > 1) {
    issues.push("Mixed prompt versions cannot be reviewed as one candidate.");
  }
  return { cases, repetitions, samples, issues, unrecordedChecks };
}

export function assertReviewEvidence(report, fixture, hash) {
  const evidence = inspectReviewEvidence(report, fixture, hash);
  assert.equal(report.status, "pendingHumanReview", "Only complete real-model runs are eligible.");
  assert.equal(evidence.issues.length, 0, `Invalid recorded evidence:\n${evidence.issues.join("\n")}`);
  return evidence;
}

function fenced(text, language = "text") {
  const value = String(text);
  const length = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length + 1));
  const fence = "`".repeat(length);
  return `${fence}${language}\n${value}\n${fence}`;
}

export function renderReviewPacket(report, fixture, hash, reportSha256) {
  const evidence = inspectReviewEvidence(report, fixture, hash);
  const lines = ["# Recorded Model Review Packet", "",
    `Report SHA256: ${reportSha256}`, `Fixture SHA256: ${hash}`,
    `Report status: ${report.status}`, `Repetitions: ${evidence.repetitions}`,
    `Recorded/expected turns: ${report.turns.length}/${evidence.samples.length}`, "",
    "Inspection material only. No scores or semantic conclusions are generated.",
    "Read the full response, including qualifications, parentheses and ending.",
    "Score each frozen criterion 0..3 in review.json; each needs at least 2.",
    "Record the exact turn, response passage and audit index. Explicitly review blocking failures.",
    "Passing a selected subset is not acceptance of the full fixed suite or the N2 V1-V8 variants.", "",
    "## Execution Issues", "",
    ...(evidence.issues.length ? evidence.issues.map((issue) => fenced(issue)) : ["No structural execution issues detected."]),
    "", "## Unrecorded Legacy Checks", "",
    ...(evidence.unrecordedChecks.length ? evidence.unrecordedChecks.map((check) => fenced(check)) : ["None."]),
    "", "## Frozen Source Texts", ""];
  for (const source of fixture.sources) {
    lines.push(`### ${source.id}`, fenced(JSON.stringify(source, null, 2), "json"), "");
  }
  for (const entry of evidence.cases) {
    lines.push(`## Case: ${entry.id}`, "", "### Frozen Criteria", "",
      ...entry.rubric.map((criterion, index) => `${index + 1}. ${criterion}`), "");
    if (entry.draft !== undefined) lines.push("### Initial Working Draft", fenced(entry.draft), "");
    if (entry.narrativePosition !== undefined) {
      lines.push("### Narrative Position", fenced(entry.narrativePosition), "");
    }
    if (entry.prefixRepeat) {
      lines.push(`Seeded source prefix repetitions: ${entry.prefixRepeat}; exact source snapshots remain in the audit.`, "");
    }
    for (const sample of evidence.samples.filter((item) => item.caseId === entry.id)) {
      lines.push(`### Repetition ${sample.repetition + 1}, Turn ${sample.turnIndex + 1}`, "",
        "#### Author Request", fenced(sample.request), "");
      if (!sample.record) {
        lines.push("NOT RECORDED. Do not substitute another turn or infer a response.", "");
        continue;
      }
      const turn = sample.record;
      lines.push(`Native run: ${turn.runId}`, `Status: ${turn.status}`,
        `Audit location: report.json -> turns[${sample.reportIndex}].audit`, "",
        "#### Complete Recorded Output", fenced(turn.output ?? ""), "",
        "#### Complete Native Audit", fenced(JSON.stringify(turn.audit, null, 2), "json"), "");
    }
  }
  return lines.join("\n") + "\n";
}
