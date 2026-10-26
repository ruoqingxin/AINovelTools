import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createDesktopHarness, invoke, until, workspace } from "./desktop-smoke-runtime.mjs";
import { runNative } from "./coauthor-evaluation.mjs";
import { distribution, environment, loadFixture, reserveCost, reviewTemplate,
  retrievalScore, validateCloudOptions, writeReport } from "./coauthor-evaluation-core.mjs";
import { createBudgetRelay } from "./coauthor-evaluation-budget.mjs";
import { coauthorLoopbackTurn, assertLoopbackRegression } from "./coauthor-runtime-loopback.mjs";

const { values } = parseArgs({ options: {
  app: { type: "string" }, case: { type: "string" }, repetitions: { type: "string" },
  "prepare-only": { type: "boolean", default: false }, loopback: { type: "boolean", default: false },
  "allow-cloud": { type: "boolean", default: false }, "cloud-profile": { type: "string" },
  "max-cost-micros": { type: "string" }, currency: { type: "string" },
  "loopback-input-tokens": { type: "string" },
  "loopback-expect-input-limit": { type: "boolean", default: false },
  "loopback-expect-late-expansion": { type: "boolean", default: false },
} });
const { fixture, hash } = await loadFixture();
assert(!(values["prepare-only"] && values.loopback), "Choose prepare-only or loopback.");
const local = values["prepare-only"] || values.loopback;
const loopbackInputTokens = Number(values["loopback-input-tokens"] ?? 32768);
if (values["loopback-input-tokens"] !== undefined) {
  assert(values.loopback, "A custom local input budget requires --loopback.");
  assert(Number.isSafeInteger(loopbackInputTokens) && loopbackInputTokens >= 256 && loopbackInputTokens <= 65536,
    "Local input budget must be an integer from 256 to 65536 tokens.");
}
if (values["loopback-expect-input-limit"]) {
  assert(values.loopback && values["loopback-input-tokens"] !== undefined,
    "An expected input limit requires --loopback and --loopback-input-tokens.");
}
if (values["loopback-expect-late-expansion"]) {
  assert(values.loopback && values["loopback-input-tokens"] !== undefined
    && values.case === "full-source-check" && !values["loopback-expect-input-limit"],
  "Late expansion requires --loopback, --loopback-input-tokens and --case full-source-check without expected input limit.");
}
if (local) {
  assert(!values["allow-cloud"] && !values["cloud-profile"], "Local modes cannot read a cloud profile.");
}
const options = validateCloudOptions(local ? {
  ...values, "allow-cloud": true, "cloud-profile": "00000000-0000-0000-0000-000000000000",
  "max-cost-micros": "1", currency: "USD",
} : values, fixture);
await mkdir(join(workspace, ".tmp"), { recursive: true });
const directory = await mkdtemp(join(workspace, ".tmp/coauthor-model-eval-"));
const review = reviewTemplate(options.cases, options.repetitions);
await writeFile(join(directory, "review.json"), JSON.stringify(review, null, 2));
const report = {
  mode: values["prepare-only"] ? "preparedOnly" : values.loopback ? "nativeLoopback" : "realModel",
  environment: environment(hash), status: "running", turns: [], reservedCostMicros: 0,
  selection: { caseIds: options.cases.map((c) => c.id), repetitions: options.repetitions },
  modelRequests: 0, limitations: [
    "Synthetic projects, not real author projects or migrated long-novel acceptance.",
    "Streaming firstTextMs is not a verified useful result; human review records usefulness separately.",
    "Recorded token counts and costs can be estimates if the provider omits usage. They are not a billing ledger.",
    "Initial candidates and tool reads are not proof of understanding or accurate citation.",
    "Real repetitions default to 1. Small-sample P50/P95 is descriptive, not a production SLA.",
    "No formal changes or proposal adoption are performed by the harness.",
  ],
};
if (values.loopback) {
  report.loopbackInputTokenBudget = loopbackInputTokens;
  report.expectedInitialInputLimit = values["loopback-expect-input-limit"];
  report.expectedLateExpansion = values["loopback-expect-late-expansion"];
  report.loopbackHttpRequests = 0;
}
let harness, main, server, relay, temporaryProfileId, encryptedCopy;

function formalSnapshot(root) {
  const db = new DatabaseSync(join(root, "project.sqlite"), { readOnly: true });
  try {
    const tables = ["entities", "entity_revisions", "author_settings", "plan_nodes",
      "plan_node_revisions", "planning_sections", "manuscript_revisions"];
    return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

async function seedProjects(repetition) {
  const result = await runNative("prepare_model_evaluation_projects", {
    COAUTHOR_EVAL_EXPORT_ROOT: join(directory, `projects-${repetition}`),
    COAUTHOR_EVAL_CASES: options.cases.map((c) => c.id).join(","),
  });
  const projects = result.rows.filter((row) => row.type === "project");
  assert.equal(projects.length, options.cases.length, "Native seed export incomplete");
  return projects;
}

function readSelectedProfile() {
  const root = join(process.env.LOCALAPPDATA ?? process.env.APPDATA, "AINovelTools");
  const db = new DatabaseSync(join(root, "settings.sqlite"), { readOnly: true });
  try {
    const profile = db.prepare("SELECT * FROM model_profiles WHERE id=?").get(values["cloud-profile"]);
    assert(profile, "Selected profile not found.");
    return { root, profile };
  } finally { db.close(); }
}

async function configureCloud(root, profile) {
  const originalProfile = profile;
  const copy = { ...profile, id: randomUUID(), max_output_tokens: Math.min(profile.max_output_tokens, 2048),
    timeout_seconds: Math.min(profile.timeout_seconds, 90), retry_limit: 0 };
  // A fresh profile identity means the real user's profile cannot be updated.
  const db = new DatabaseSync(join(main.state, "AINovelTools/settings.sqlite"));
  try {
    const columns = ["id", "name", "provider", "capability", "base_url", "model_id", "context_window",
      "max_output_tokens", "privacy_level", "timeout_seconds", "retry_limit", "input_price_micros_per_million",
      "output_price_micros_per_million", "price_currency", "secret_ref", "created_at", "updated_at"];
    db.prepare(`INSERT INTO model_profiles (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map((column) => copy[column]));
  } finally { db.close(); }
  const name = `${createHash("sha256").update(originalProfile.secret_ref).digest("hex")}.dpapi`;
  const secretDirectory = join(main.state, "AINovelTools/secrets");
  await mkdir(secretDirectory, { recursive: true });
  encryptedCopy = join(secretDirectory, name);
  try { await copyFile(join(root, "secrets", name), encryptedCopy); }
  catch (error) { if (error.code !== "ENOENT") throw error; encryptedCopy = undefined; }
  // No delete_model_secret for a copied reference: it points at the real OS credential.
  return copy;
}

async function configureLoopback() {
  server = createServer(async (request, response) => {
    report.loopbackHttpRequests += 1;
    try {
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const message = coauthorLoopbackTurn(body);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }));
    } catch (error) {
      console.error(`Local regression provider failed: ${error.message}`);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const saved = await invoke(main, "upsert_model_profile", { input: {
    name: "Synthetic evaluation loopback", provider: "OPEN_AI_COMPATIBLE", capability: "CHAT",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "coauthor-eval-loopback",
    contextWindow: 131072, maxOutputTokens: 2048, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 15,
    retryLimit: 0, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, priceCurrency: "USD",
  } });
  temporaryProfileId = saved.id;
  await invoke(main, "save_model_secret", { profileId: saved.id, secret: "synthetic-evaluation-loopback-only" });
  return { id: saved.id, max_output_tokens: 2048 };
}

async function runTurn(project, scenario, turn, profile, repetition, turnIndex) {
  const runId = randomUUID();
  const before = await invoke(main, "get_coauthor_state", { scope: project.scope });
  const preferencesBefore = await invoke(main, "get_ai_task_preferences");
  const feeBudgetBefore = await invoke(main, "get_ai_budget_settings");
  // Listen on the actual native event, not mocked browser IPC.
  await main.page.evaluate(async ({ scope, runId }) => {
    const start = performance.now();
    const state = { start, events: [], done: false, result: null, error: null };
    window.__coauthorEvaluation = state;
    const callback = window.__TAURI_INTERNALS__.transformCallback(({ payload }) => {
      if (payload.runId === runId && payload.sessionId === scope.sessionId) {
        state.events.push({ kind: payload.kind, elapsedMs: performance.now() - start,
          characters: payload.content.length });
      }
    }, false);
    state.listener = await window.__TAURI_INTERNALS__.invoke("plugin:event|listen",
      { event: "coauthor-progress", target: { kind: "Any" }, handler: callback });
    state.callback = callback;
  }, { scope: project.scope, runId });
  await main.page.evaluate((input) => {
    const state = window.__coauthorEvaluation;
    state.start = performance.now();
    window.__TAURI_INTERNALS__.invoke("run_coauthor", { input }).then(
      (result) => { state.result = result; },
      (error) => { state.error = { code: error?.code ?? "UNKNOWN", message: String(error?.message ?? error) }; },
    ).finally(() => { state.elapsedMs = performance.now() - state.start; state.done = true; });
  }, {
    scope: project.scope, runId, profileId: profile.id, message: turn.message,
    expectedDocumentVersion: before.document.version, selection: turn.allowDraftEdits ? scenario.selection ?? null : null,
    allowDraftEdits: Boolean(turn.allowDraftEdits), temperature: 0.2, maxOutputTokens: profile.max_output_tokens,
  });
  let state;
  try {
    state = await until(() => main.page.evaluate(() => {
      const { result, error, events, elapsedMs, done } = window.__coauthorEvaluation;
      return { result, error, events, elapsedMs, done };
    }), (s) => s.done, "coauthor evaluation turn", 920_000);
  } catch (error) {
    await invoke(main, "cancel_coauthor_run", { scope: project.scope, runId }).catch(() => {});
    throw error;
  } finally {
    await main.page.evaluate(async () => {
      const state = window.__coauthorEvaluation;
      await window.__TAURI_INTERNALS__.invoke("plugin:event|unlisten",
        { event: "coauthor-progress", eventId: state.listener });
      window.__TAURI_INTERNALS__.unregisterCallback(state.callback);
    });
  }
  const run = state.result?.run ?? await invoke(main, "get_coauthor_run", { scope: project.scope, id: runId }).catch(() => null);
  const requests = run?.audit.filter((a) => a.kind === "model_request") ?? [];
  const usage = await invoke(main, "list_ai_runs", { limit: 100 });
  const requestRuns = requests.map((r) => usage.find((u) => u.id === r.usageId));
  assert(requestRuns.every(Boolean), "Missing usage records, cannot continue the evaluation.");
  const after = await invoke(main, "get_coauthor_state", { scope: project.scope });
  const unchanged = JSON.stringify(before.document) === JSON.stringify(after.document);
  const entry = {
    caseId: scenario.id, repetition, turnIndex, workload: scenario.workload, runId,
    status: run?.status ?? "FAILED_BEFORE_RUN", error: state.error,
    elapsedMs: state.elapsedMs,
    firstTextMs: state.events.find((e) => e.kind === "text" && e.characters > 0)?.elapsedMs ?? null,
    firstUsefulResultMs: null, modelRequests: requests.length,
    toolCalls: run?.audit.filter((a) => a.kind === "tool").length ?? 0,
    toolErrors: run?.audit.filter((a) => a.kind === "tool" && a.result?.executed === false).length ?? 0,
    recordedInputTokens: requestRuns.reduce((n, r) => n + r.estimatedInputTokens, 0),
    recordedOutputTokens: requestRuns.reduce((n, r) => n + r.estimatedOutputTokens, 0),
    recordedCostMicros: requestRuns.every((r) => r.estimatedCostMicros !== null)
      ? requestRuns.reduce((n, r) => n + r.estimatedCostMicros, 0) : null,
    promptVersions: [...new Set(requests.map((r) => r.promptVersion))],
    initialRetrieval: retrievalScore(scenario.retrieval.relevant.map((id) => project.sources[id]),
      run?.audit.find((a) => a.kind === "initial_search")?.result?.hits ?? []),
    candidateCoverageAfterLocalFollowup: retrievalScore(scenario.retrieval.relevant.map((id) => project.sources[id]), [
      ...(run?.audit.find((a) => a.kind === "initial_search")?.result?.hits ?? []),
      ...(run?.audit.find((a) => a.kind === "local_source_followup")?.result?.result?.hits ?? []),
    ]),
    workingDocumentUnchanged: unchanged, output: run?.output ?? "", audit: run?.audit ?? [],
    taskPreferencesUnchanged: JSON.stringify(preferencesBefore)
      === JSON.stringify(await invoke(main, "get_ai_task_preferences")),
    feeBudgetSettingsUnchanged: JSON.stringify(feeBudgetBefore)
      === JSON.stringify(await invoke(main, "get_ai_budget_settings")),
    events: state.events,
  };
  report.turns.push(entry);
  report.modelRequests += requests.length;
  if (relay) {
    report.budget = relay.snapshot();
    await writeFile(join(directory, "budget.json"), JSON.stringify(report.budget, null, 2));
  }
  await writeFile(join(directory, "turns.jsonl"), report.turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  assert(unchanged, "Blocking failure: persisted working document changed without author adoption.");
  assert(entry.taskPreferencesUnchanged, "A run must not persist its temporary token budget.");
  assert(entry.feeBudgetSettingsUnchanged, "An input expansion must not change the money budget.");
  assert(!run?.audit.some((a) => a.kind === "draft_proposal") || turn.allowDraftEdits,
    "Blocking failure: proposed draft edits during discussion-only turn.");
  if (values.loopback) entry.localRegression = assertLoopbackRegression(entry, {
    expectInputLimit: values["loopback-expect-input-limit"],
    expectLateExpansion: values["loopback-expect-late-expansion"],
  });
  console.log(`${scenario.id} turn ${turnIndex + 1}: ${entry.status}; ${requests.length} requests; ${entry.elapsedMs.toFixed(0)}ms`);
  return entry;
}

try {
  if (values["prepare-only"]) {
    for (let repetition = 0; repetition < options.repetitions; repetition++) await seedProjects(repetition);
    report.status = "preparedNotRun";
  } else {
    let selected;
    if (!values.loopback) {
      selected = readSelectedProfile();
      const turns = options.cases.reduce((n, c) => n + c.turns.length, 0) * options.repetitions;
      report.fullPlanReserveMicros = reserveCost(selected.profile, values.currency, turns);
      relay = await createBudgetRelay({ profile: selected.profile, currency: values.currency,
        limitMicros: options.maxCostMicros, maxRequests: turns * 10 });
      report.budget = relay.snapshot();
      report.reservedCostMicros = report.budget.requestReserveMicros;
      report.profile = { host: new URL(selected.profile.base_url).hostname, model: selected.profile.model_id,
        currency: values.currency, maxOutputTokens: Math.min(selected.profile.max_output_tokens, 2048),
        retryLimit: 0, fallback: false };
    }
    harness = await createDesktopHarness("coauthor-eval-native", values.app);
    main = await harness.launch("isolated-state");
    let profile;
    if (selected) {
      await harness.stop(main);
      profile = await configureCloud(selected.root, { ...selected.profile, base_url: relay.baseUrl });
      main = await harness.launch("isolated-state");
    } else profile = await configureLoopback();
    report.environment.build = "Native desktop executable; debug/release depends on --app";
    const executable = values.app ?? join(workspace, "target/debug/ainoveltools-desktop.exe");
    report.environment.executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
    const preferences = await invoke(main, "get_ai_task_preferences");
    preferences.discussion = {
      ...preferences.discussion, profileId: profile.id, fallbackProfileId: null, temperature: 0.2,
      maxOutputTokens: profile.max_output_tokens,
      prompt: { context: { inputTokenBudget: values.loopback ? loopbackInputTokens : 32768 } },
    };
    await invoke(main, "save_ai_task_preferences", { preferences });
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      const projects = await seedProjects(repetition);
      for (const project of projects) {
        const scenario = options.cases.find((c) => c.id === project.caseId);
        await invoke(main, "open_project", { root: project.root });
        const original = formalSnapshot(project.root);
        for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
          console.log(`Running ${scenario.id}, turn ${turnIndex + 1}/${scenario.turns.length}`);
          const entry = await runTurn(project, scenario, scenario.turns[turnIndex], profile, repetition, turnIndex);
          const unchanged = formalSnapshot(project.root) === original;
          report.turns.at(-1).formalContentUnchanged = unchanged;
          await writeFile(join(directory, "turns.jsonl"), report.turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
          assert(unchanged, "Blocking failure: formal entities, planning or manuscript content changed.");
          assert(!relay?.snapshot().blocked, "Request-boundary budget guard stopped the evaluation.");
          if (entry.status !== "COMPLETED") break;
        }
      }
    }
    report.status = values.loopback ? "harnessVerifiedNotQuality" : "pendingHumanReview";
    if (values.loopback) {
      assert.equal(report.loopbackHttpRequests, report.modelRequests,
        "Actual local HTTP requests must match the native request audit.");
    }
    report.incompleteCases = [...new Set(report.turns.filter((t) => t.status !== "COMPLETED").map((t) => t.caseId))];
    report.expectedInputLimitCases = report.turns.filter((t) => t.localRegression?.expectedInputLimit)
      .map((t) => t.caseId);
    if (report.turns.some((t) => t.status !== "COMPLETED" && !t.localRegression?.expectedInputLimit)) {
      report.status = "completedWithFailures";
    }
    report.workloads = ["discussion", "localEdit", "fullCheck"].map((workload) => ({
      workload, elapsedMs: distribution(report.turns.filter((t) => t.workload === workload).map((t) => t.elapsedMs)),
    }));
  }
} catch (error) {
  report.status = "failed";
  report.failure = String(error.message ?? error);
  process.exitCode = 1;
} finally {
  const cleanupFailures = [];
  if (temporaryProfileId && main) {
    try { await invoke(main, "delete_model_secret", { profileId: temporaryProfileId }); }
    catch { cleanupFailures.push("Temporary loopback credential cleanup failed."); }
  }
  if (harness) {
    try { await harness.cleanup(); } catch { cleanupFailures.push("Native process cleanup failed."); }
  }
  if (encryptedCopy) {
    try { await rm(encryptedCopy, { force: true }); } catch { cleanupFailures.push("Encrypted credential copy cleanup failed."); }
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (relay) {
    try {
      await relay.close();
      report.budget = relay.snapshot();
      await writeFile(join(directory, "budget.json"), JSON.stringify(report.budget, null, 2));
    } catch { cleanupFailures.push("Budget relay cleanup or ledger persistence failed."); }
  }
  if (cleanupFailures.length) {
    report.status = "failed";
    report.cleanupFailures = cleanupFailures;
    process.exitCode = 1;
  }
  await writeReport(directory, report);
  console.log(`Evaluation ${report.status}: ${join(directory, "report.md")}`);
}
