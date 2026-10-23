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

const { values } = parseArgs({ options: {
  app: { type: "string" }, case: { type: "string" }, repetitions: { type: "string" },
  "prepare-only": { type: "boolean", default: false }, loopback: { type: "boolean", default: false },
  "allow-cloud": { type: "boolean", default: false }, "cloud-profile": { type: "string" },
  "max-cost-micros": { type: "string" }, currency: { type: "string" },
} });
const { fixture, hash } = await loadFixture();
assert(!(values["prepare-only"] && values.loopback), "Choose prepare-only or loopback.");
const local = values["prepare-only"] || values.loopback;
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
let harness, main, server, temporaryProfileId, encryptedCopy;

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
    try {
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const toolRead = body.messages.some((m) => m.role === "tool");
      const context = JSON.parse(body.messages.filter((m) => m.role === "user").at(-1).content);
      const source = context.relevantSources.hits.find((s) => s.title === "九曜境界体系");
      const message = !toolRead && source ? {
        role: "assistant", content: "",
        tool_calls: [{ id: "eval-read", type: "function", function: { name: "read_source",
          arguments: JSON.stringify({ key: source.key, revision: source.revision, offset: 0, limit: 2000 }) } }],
      } : { role: "assistant", content: "本地模拟回复，仅用于验证评测链路，不用于创作质量评分。" };
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        choices: [{ message, finish_reason: toolRead ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }));
    } catch {
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
    workingDocumentUnchanged: unchanged, output: run?.output ?? "", audit: run?.audit ?? [],
    events: state.events,
  };
  report.turns.push(entry);
  report.modelRequests += requests.length;
  await writeFile(join(directory, "turns.jsonl"), report.turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  assert(unchanged, "Blocking failure: persisted working document changed without author adoption.");
  assert(!run?.audit.some((a) => a.kind === "draft_proposal") || turn.allowDraftEdits,
    "Blocking failure: proposed draft edits during discussion-only turn.");
  assert.equal(entry.status, "COMPLETED", "Incomplete model turn retained in report; no automatic retries.");
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
      report.reservedCostMicros = reserveCost(selected.profile, values.currency, turns);
      assert(report.reservedCostMicros <= options.maxCostMicros,
        `Configured-price reserve ${report.reservedCostMicros} exceeds --max-cost-micros. No model called.`);
      report.profile = { host: new URL(selected.profile.base_url).hostname, model: selected.profile.model_id,
        currency: values.currency, maxOutputTokens: Math.min(selected.profile.max_output_tokens, 2048),
        retryLimit: 0, fallback: false };
    }
    harness = await createDesktopHarness("coauthor-eval-native", values.app);
    main = await harness.launch("isolated-state");
    let profile;
    if (selected) {
      await harness.stop(main);
      profile = await configureCloud(selected.root, selected.profile);
      main = await harness.launch("isolated-state");
    } else profile = await configureLoopback();
    report.environment.build = "Native desktop executable; debug/release depends on --app";
    const executable = values.app ?? join(workspace, "target/debug/ainoveltools-desktop.exe");
    report.environment.executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
    const preferences = await invoke(main, "get_ai_task_preferences");
    preferences.discussion = {
      ...preferences.discussion, profileId: profile.id, fallbackProfileId: null, temperature: 0.2,
      maxOutputTokens: profile.max_output_tokens,
      prompt: { context: { inputTokenBudget: 32768 } },
    };
    await invoke(main, "save_ai_task_preferences", { preferences });
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      const projects = await seedProjects(repetition);
      for (const project of projects) {
        const scenario = options.cases.find((c) => c.id === project.caseId);
        await invoke(main, "open_project", { root: project.root });
        const original = formalSnapshot(project.root);
        for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
          await runTurn(project, scenario, scenario.turns[turnIndex], profile, repetition, turnIndex);
          const unchanged = formalSnapshot(project.root) === original;
          report.turns.at(-1).formalContentUnchanged = unchanged;
          await writeFile(join(directory, "turns.jsonl"), report.turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
          assert(unchanged, "Blocking failure: formal entities, planning or manuscript content changed.");
        }
      }
    }
    report.status = values.loopback ? "harnessVerifiedNotQuality" : "pendingHumanReview";
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
  if (cleanupFailures.length) {
    report.status = "failed";
    report.cleanupFailures = cleanupFailures;
    process.exitCode = 1;
  }
  await writeReport(directory, report);
  console.log(`Evaluation ${report.status}: ${join(directory, "report.md")}`);
}
