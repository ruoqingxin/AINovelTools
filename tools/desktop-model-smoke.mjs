import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createDesktopHarness, invoke, until } from "./desktop-smoke-runtime.mjs";

const { values } = parseArgs({ options: {
  app: { type: "string" },
  "cloud-profile": { type: "string" },
  "allow-cloud": { type: "boolean", default: false },
} });
assert.equal(Boolean(values["cloud-profile"]), values["allow-cloud"], "Cloud mode requires both --cloud-profile UUID and --allow-cloud.");
const harness = await createDesktopHarness("p4-model", values.app);
const { artifacts, events, launch, stop, cleanup } = harness;
const requests = [];
const gates = new Map();
const temporaryProfileIds = [];
let main;
let passed = false;

// This fixture is a real loopback HTTP provider, not an IPC mock. Never log
// Authorization headers or forward a credential to another endpoint.
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ model: body.model, stream: body.stream, maxTokens: body.max_tokens });
    const count = requests.filter((item) => item.model === body.model).length;
    if (body.model === "unavailable" || (body.model === "retry-once" && count === 1)) {
      response.writeHead(503).end();
    } else if (body.model === "authentication") {
      response.writeHead(401).end();
    } else if (body.model === "headers-held") {
      gates.set(body.model, () => response.destroy());
    } else if (body.model === "json-held") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
      gates.set(body.model, () => response.destroy());
    } else if (body.model === "held-success" || body.model === "stream-held") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fixture preview" } }] })}\r\n\r\n`);
      gates.set(body.model, () => response.end(`data: ${JSON.stringify({
        choices: [{ delta: { content: " and completed candidate." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      })}\r\n\r\ndata: [DONE]\r\n\r\n`));
    } else {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        choices: [{ message: { content: "Fixture JSON candidate." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      }));
    }
  } catch {
    response.writeHead(500).end();
  }
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;

function release(model) {
  gates.get(model)?.();
  gates.delete(model);
}

async function seedCloudProfile(state, id) {
  assert.match(id, /^[0-9a-f-]{36}$/i);
  const userRoot = join(process.env.LOCALAPPDATA ?? process.env.APPDATA, "AINovelTools");
  const original = new DatabaseSync(join(userRoot, "settings.sqlite"), { readOnly: true });
  let profile;
  try {
    profile = original.prepare("SELECT * FROM model_profiles WHERE id=?").get(id);
  } finally {
    original.close();
  }
  assert(profile && profile.capability === "CHAT" && profile.privacy_level === "ALLOW_CLOUD" && profile.secret_ref, "Select a configured cloud chat profile.");
  const endpoint = new URL(profile.base_url);
  assert.equal(endpoint.protocol, "https:", "Cloud acceptance requires an HTTPS endpoint.");
  const isolatedRoot = join(state, "AINovelTools");
  const isolated = new DatabaseSync(join(isolatedRoot, "settings.sqlite"));
  try {
    // Copy only this explicitly selected profile. Do not copy user task settings,
    // recent projects, novel data or plaintext credentials.
    const columns = ["id", "name", "provider", "capability", "base_url", "model_id",
      "context_window", "max_output_tokens", "privacy_level", "timeout_seconds",
      "retry_limit", "input_price_micros_per_million", "output_price_micros_per_million",
      "price_currency", "secret_ref", "created_at", "updated_at"];
    profile.max_output_tokens = Math.min(profile.max_output_tokens, 2_048);
    profile.timeout_seconds = Math.min(profile.timeout_seconds, 90);
    profile.retry_limit = 0;
    isolated.prepare(`INSERT INTO model_profiles (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((column) => profile[column]));
  } finally {
    isolated.close();
  }
  // The native secret store first reads the existing OS credential. Its DPAPI
  // fallback needs an encrypted copy under the isolated app-data directory.
  const encryptedName = `${createHash("sha256").update(profile.secret_ref).digest("hex")}.dpapi`;
  await mkdir(join(isolatedRoot, "secrets"), { recursive: true });
  try {
    await copyFile(join(userRoot, "secrets", encryptedName), join(isolatedRoot, "secrets", encryptedName));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { id: profile.id, model: profile.model_id, host: endpoint.hostname, maxOutputTokens: profile.max_output_tokens };
}

async function fixtureProfile(model, name, id = randomUUID(), retryLimit = 0) {
  const saved = await invoke(main, "upsert_model_profile", { input: {
    id, name, provider: "OPEN_AI_COMPATIBLE", capability: "CHAT", baseUrl, modelId: model,
    contextWindow: 4_096, maxOutputTokens: 256, privacyLevel: "ALLOW_CLOUD",
    timeoutSeconds: 20, retryLimit, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0,
    priceCurrency: "USD",
  } });
  if (!temporaryProfileIds.includes(saved.id)) {
    temporaryProfileIds.push(saved.id);
    await invoke(main, "save_model_secret", { profileId: saved.id, secret: "synthetic-loopback-only-key" });
  }
  return saved;
}

async function preference(primary, fallback = null, maxOutputTokens = 256) {
  const preferences = await invoke(main, "get_ai_task_preferences");
  preferences.writing = {
    profileId: primary, fallbackProfileId: fallback, temperature: 0.4, maxOutputTokens,
    prompt: { context: { includeProjectKnowledge: false, inputTokenBudget: 2_048 } },
  };
  await invoke(main, "save_ai_task_preferences", { preferences });
}

async function observe(autoCancel = false) {
  await main.page.evaluate(async (autoCancel) => {
    window.__modelSmoke = { events: [], generation: { status: "idle" }, autoCancel, cancel: null, cancelAfterStartMs: null };
    function cancelTask(state, taskId) {
      if (state.cancel || state.generation.status !== "pending") return;
      state.cancel = { at: Date.now(), status: "pending" };
      window.__TAURI_INTERNALS__.invoke("cancel_ai_task", { taskId })
        .then(() => { state.cancel.status = "accepted"; }, (error) => { state.cancel = { ...state.cancel, status: "rejected", error }; });
    }
    for (const event of ["ai-task-started", "ai-task-attempt", "ai-task-chunk"]) {
      const callback = window.__TAURI_INTERNALS__.transformCallback(({ payload }) => {
        const state = window.__modelSmoke;
        state.events.push({ event, payload, at: Date.now() });
        if (event === "ai-task-started" && state.autoCancel && state.cancelAfterStartMs !== null) {
          state.cancelTimer = setTimeout(() => cancelTask(state, payload.taskId), state.cancelAfterStartMs);
        }
        if (event === "ai-task-chunk" && state.autoCancel) {
          cancelTask(state, payload.taskId);
        }
      }, false);
      await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler: callback });
    }
  }, autoCancel);
}

async function writing(chapterId) {
  await main.page.goto(`${main.origin}/writing#${chapterId}`);
  await main.page.reload();
  await main.page.locator(".creation-edit-panel .tiptap-editor[contenteditable=true]").waitFor();
  await observe();
}

async function begin(input) {
  await main.page.evaluate((args) => {
    const state = window.__modelSmoke;
    state.events = [];
    state.generation = { status: "pending" };
    window.__TAURI_INTERNALS__.invoke("generate_ai_proposal", args).then(
      (result) => { clearTimeout(state.cancelTimer); state.generation = { status: "resolved", result, at: Date.now() }; },
      (error) => { clearTimeout(state.cancelTimer); state.generation = { status: "rejected", error, at: Date.now() }; },
    );
  }, input);
}

function smokeState() {
  return main.page.evaluate(() => window.__modelSmoke);
}

async function completed(runId, status) {
  const runs = await until(() => invoke(main, "list_ai_runs", { limit: 80 }),
    (runs) => runs.some((run) => run.id === runId && run.status !== "RUNNING"), "AI terminal status", 95_000);
  const run = runs.find((run) => run.id === runId);
  assert.equal(run.status, status, JSON.stringify(run));
  return run;
}

try {
  main = await launch("model-state");
  assert.equal(await invoke(main, "current_project"), null);
  let cloud;
  if (values["cloud-profile"]) {
    const state = main.state;
    await stop(main);
    cloud = await seedCloudProfile(state, values["cloud-profile"]);
    main = await launch("model-state");
  }
  const root = join(artifacts, "project");
  await invoke(main, "create_project", { root, name: "Synthetic model acceptance" });
  await invoke(main, "open_project", { root });
  const chapter = await invoke(main, "create_plan_node", { parentId: null, kind: "CHAPTER", title: "Synthetic chapter" });
  let primary = await fixtureProfile("unavailable", "Fixture primary");
  const fallback = await fixtureProfile("held-success", "Fixture fallback");
  await preference(primary.id, fallback.id);
  await writing(chapter.id);
  const editor = main.page.locator(".creation-edit-panel .tiptap-editor");
  await editor.fill("Synthetic saved manuscript stays unchanged.");
  await main.page.getByRole("button", { name: "保存正文", exact: true }).click();
  const revision = await until(() => invoke(main, "current_manuscript", { chapterId: chapter.id }), Boolean, "initial revision");
  const input = {
    profileId: primary.id, chapterId: chapter.id, action: "DRAFT",
    chapterTitle: chapter.title, chapterPlan: "", volumePlan: "", documentJson: revision.documentJson,
    selection: null, instruction: "Use this synthetic scene only. Write three short sentences about a locked room.",
    reviewPurpose: null, stream: true, temperature: 0.4, maxOutputTokens: 256,
  };
  const proposals = () => invoke(main, "list_ai_proposals", {
    chapterId: chapter.id, chapterTitle: chapter.title, chapterPlan: "", volumePlan: "",
    documentJson: revision.documentJson, instruction: null, reviewPurpose: null,
  });
  const unchanged = async () => {
    assert.equal((await invoke(main, "current_manuscript", { chapterId: chapter.id })).id, revision.id);
    assert.equal(await editor.textContent(), "Synthetic saved manuscript stays unchanged.");
  };

  await main.page.locator(".ai-draft-action button").click();
  await main.page.locator(".ai-preview").getByText("Fixture preview", { exact: true }).waitFor();
  await main.page.getByRole("status").filter({ hasText: "已切换到“Fixture fallback”" }).waitFor();
  let state = await smokeState();
  let taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
  assert(state.events.findIndex((event) => event.event === "ai-task-attempt") < state.events.findIndex((event) => event.event === "ai-task-chunk"));
  assert.equal((await invoke(main, "list_ai_runs", { limit: 80 })).find((run) => run.id === taskId).attemptCount, 2);
  await main.page.locator(".ai-preview").scrollIntoViewIfNeeded();
  await main.page.screenshot({ path: join(artifacts, "fallback-live-preview.png"), fullPage: true });
  release("held-success");
  let run = await completed(taskId, "COMPLETED");
  assert.equal(run.attemptCount, 2);
  assert.equal(run.retryReason, "PROVIDER_UNAVAILABLE");
  assert.equal(run.profileName, "Fixture fallback");
  await until(proposals, (items) => items.length === 1, "fallback candidate");
  await main.page.locator(".ai-running").waitFor({ state: "detached" });
  assert.equal(await main.page.locator(".ai-preview").textContent(), "Fixture preview and completed candidate.");
  await unchanged();
  events.push({ stage: "ui-fallback-stream", runId: taskId, attemptCount: run.attemptCount });

  for (const model of ["headers-held", "json-held"]) {
    primary = await fixtureProfile(model, "Fixture primary", primary.id);
    await preference(primary.id);
    await begin({ ...input, stream: false });
    await until(() => Promise.resolve(gates.has(model)), Boolean, `${model} request reached provider`);
    state = await until(smokeState, (s) => s.events.some((e) => e.event === "ai-task-started"), "task started");
    taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
    const start = Date.now();
    await invoke(main, "cancel_ai_task", { taskId });
    state = await until(smokeState, (s) => s.generation.status !== "pending", "silent request cancellation", 2_000);
    assert.equal(state.generation.error.code, "TASK_CANCELLED");
    run = await completed(taskId, "CANCELLED");
    assert.equal(run.attemptCount, 1);
    release(model);
    assert.equal((await proposals()).length, 1);
    assert(!state.events.some((event) => event.event === "ai-task-chunk"));
    events.push({ stage: model, runId: taskId, cancelLatencyMs: Date.now() - start });
    await unchanged();
  }

  primary = await fixtureProfile("stream-held", "Fixture primary", primary.id);
  await preference(primary.id, fallback.id);
  await writing(chapter.id);
  await main.page.locator(".ai-draft-action button").click();
  await main.page.locator(".ai-preview").waitFor();
  state = await until(smokeState, (s) => s.events.some((e) => e.event === "ai-task-chunk"), "live stream chunk");
  taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
  const cancelButton = main.page.locator(".ai-running").getByRole("button", { name: "取消", exact: true });
  await until(() => cancelButton.isEnabled(), Boolean, "UI cancel ready");
  await cancelButton.click();
  run = await completed(taskId, "CANCELLED");
  await main.page.locator(".ai-running").waitFor({ state: "detached" });
  assert.equal(run.errorCode, "TASK_CANCELLED");
  release("stream-held");
  assert.equal((await proposals()).length, 1);
  state = await smokeState();
  assert(!state.events.some((event) => event.event === "ai-task-attempt"));
  await main.page.screenshot({ path: join(artifacts, "stream-cancelled.png"), fullPage: true });
  events.push({ stage: "ui-stream-cancelled", runId: taskId });
  await unchanged();

  primary = await fixtureProfile("authentication", "Fixture primary", primary.id);
  await preference(primary.id, fallback.id);
  const fallbackRequests = requests.filter((item) => item.model === "held-success").length;
  await begin(input);
  state = await until(smokeState, (s) => s.generation.status !== "pending", "authentication rejection");
  assert.equal(state.generation.error.code, "PROVIDER_AUTHENTICATION");
  taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
  await completed(taskId, "FAILED");
  assert.equal(requests.filter((item) => item.model === "held-success").length, fallbackRequests);
  assert.equal((await proposals()).length, 1);
  events.push({ stage: "authentication-no-fallback", runId: taskId });

  primary = await fixtureProfile("retry-once", "Fixture primary", primary.id, 1);
  await begin(input);
  state = await until(smokeState, (s) => s.generation.status !== "pending", "retry response");
  assert.equal(state.generation.status, "resolved");
  taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
  run = await completed(taskId, "COMPLETED");
  assert.equal(run.attemptCount, 1, "provider retries are not a profile fallback");
  assert.equal(requests.filter((item) => item.model === "retry-once").length, 2);
  assert.equal(requests.filter((item) => item.model === "held-success").length, fallbackRequests);
  assert.equal((await proposals()).length, 2);
  events.push({ stage: "provider-retry", runId: taskId, requests: 2 });

  primary = await fixtureProfile("unavailable", "Fixture primary", primary.id);
  await fixtureProfile("authentication", "Fixture fallback", fallback.id);
  await preference(primary.id, fallback.id);
  await begin(input);
  state = await until(smokeState, (s) => s.generation.status !== "pending", "failed fallback");
  assert.equal(state.generation.error.code, "PROVIDER_AUTHENTICATION");
  taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
  run = await completed(taskId, "FAILED");
  assert.equal(run.attemptCount, 2);
  assert.equal(run.profileName, "Fixture fallback");
  assert.equal(run.retryReason, "PROVIDER_UNAVAILABLE");
  const requestSnapshot = await invoke(main, "get_ai_run_request", { runId: taskId });
  assert.equal(JSON.parse(requestSnapshot.requestBody).model, "authentication");
  assert.equal((await proposals()).length, 2);
  events.push({ stage: "failed-fallback-audited", runId: taskId, attemptCount: run.attemptCount });

  await fixtureProfile("stream-held", "Fixture fallback", fallback.id);
  await begin(input);
  await until(() => Promise.resolve(gates.has("stream-held")), Boolean, "fallback stream reached provider");
  state = await until(smokeState, (s) => s.events.some((event) => event.event === "ai-task-chunk"), "fallback preview");
  taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
  await invoke(main, "cancel_ai_task", { taskId });
  state = await until(smokeState, (s) => s.generation.status !== "pending", "fallback cancellation", 2_000);
  assert.equal(state.generation.error.code, "TASK_CANCELLED");
  run = await completed(taskId, "CANCELLED");
  assert.equal(run.attemptCount, 2);
  assert.equal(run.retryReason, "PROVIDER_UNAVAILABLE");
  release("stream-held");
  assert.equal((await proposals()).length, 2);
  events.push({ stage: "cancelled-fallback-audited", runId: taskId, attemptCount: run.attemptCount });
  await unchanged();

  if (cloud) {
    primary = await fixtureProfile("unavailable", "Fixture primary", primary.id);
    await preference(primary.id, cloud.id, cloud.maxOutputTokens);
    await begin({ ...input, maxOutputTokens: cloud.maxOutputTokens });
    state = await until(smokeState, (s) => s.generation.status !== "pending", "real cloud fallback", 95_000);
    assert.equal(state.generation.status, "resolved", JSON.stringify(state.generation.error));
    assert(state.generation.result.outputText.trim().length > 0);
    taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
    run = await completed(taskId, "COMPLETED");
    assert.equal(run.attemptCount, 2);
    assert.equal(run.retryReason, "PROVIDER_UNAVAILABLE");
    assert(state.events.findIndex((event) => event.event === "ai-task-attempt") < state.events.findIndex((event) => event.event === "ai-task-chunk"));
    events.push({ stage: "real-cloud-fallback", ...cloud, runId: taskId, outputCharacters: state.generation.result.outputText.length, attemptCount: run.attemptCount });
    await writing(chapter.id);
    await main.page.locator(".proposal-list .proposal").first().waitFor();
    await main.page.screenshot({ path: join(artifacts, "cloud-candidate.png"), fullPage: true });
    await unchanged();
    const candidateCount = (await proposals()).length;
    await preference(cloud.id, null, cloud.maxOutputTokens);
    await main.page.evaluate(() => {
      window.__modelSmoke.autoCancel = true;
      window.__modelSmoke.cancelAfterStartMs = 500;
    });
    await begin({ ...input, profileId: cloud.id, maxOutputTokens: cloud.maxOutputTokens,
      instruction: "Write a short fictional scene about an explorer entering a locked room. Use only synthetic invented details." });
    state = await until(smokeState, (s) => s.generation.status !== "pending", "real cloud stream cancellation", 95_000);
    assert.equal(state.cancel?.status, "accepted", JSON.stringify(state.cancel));
    assert.equal(state.generation.error?.code, "TASK_CANCELLED", JSON.stringify(state.generation));
    taskId = state.events.find((event) => event.event === "ai-task-started").payload.taskId;
    await completed(taskId, "CANCELLED");
    assert.equal((await proposals()).length, candidateCount);
    await unchanged();
    events.push({ stage: "real-cloud-cancelled", ...cloud, runId: taskId,
      cancelLatencyMs: state.generation.at - state.cancel.at,
      receivedProseChunk: state.events.some((event) => event.event === "ai-task-chunk") });
  }
  for (const instance of harness.instances) assert.deepEqual(instance.pageErrors, []);
  passed = true;
} catch (error) {
  if (main?.page && !main.page.isClosed()) {
    await main.page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  }
  events.push({ stage: "failed", error: String(error) });
  throw error;
} finally {
  try {
    for (const profileId of temporaryProfileIds) {
      await invoke(main, "delete_model_secret", { profileId });
    }
  } catch (error) {
    passed = false;
    events.push({ stage: "credential-cleanup-failed", error: String(error) });
    throw error;
  } finally {
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    await cleanup();
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed, cloudRequested: Boolean(values["cloud-profile"]), events, fixtureRequests: requests }, null, 2));
    console.log(`Model acceptance ${passed ? "passed" : "failed"}: ${artifacts}`);
  }
}
