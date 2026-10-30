import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createDesktopHarness, invoke, until } from "./desktop-smoke-runtime.mjs";

const { values } = parseArgs({ options: { app: { type: "string" } } });
const harness = await createDesktopHarness("model-sync", values.app);
const { artifacts, events, launch, cleanup } = harness;
const requests = [];
const profileIds = [];
const responses = new Map();
let main;
let projectRoot;
let passed = false;
const text = "Mira lives in Harbor.";
const documentJson = JSON.stringify({
  type: "doc", content: [{ type: "paragraph", attrs: { blockId: "fixture-block" },
    content: [{ type: "text", text }] }],
});
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const count = requests.filter((item) => item.model === body.model).length;
    const run = query(
      "SELECT r.id, r.status, r.request_body FROM ai_run_records r JOIN model_profiles p ON p.id=r.profile_id WHERE p.model_id=? ORDER BY r.rowid DESC LIMIT 1",
      body.model,
    )[0];
    assert.equal(run?.status, "RUNNING", "model is synced and recorded before the HTTP request");
    assert.equal(JSON.parse(run.request_body).model, body.model, "request snapshot is recorded before sending");
    requests.push({ model: body.model, stream: body.stream, recordedBeforeRequest: true });
    const result = responses.get(body.model)?.(body, count);
    assert(result, `No fixture for ${body.model}`);
    if (result.status) {
      response.writeHead(result.status).end();
    } else {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        choices: [{ message: { content: result.content }, finish_reason: "stop" }],
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
const entityResult = JSON.stringify([{ name: "Harbor", description: text, aliases: [], tags: [] }]);
const chapterResult = JSON.stringify([{
  kind: "ENTITY", blockId: "fixture-block", quote: text,
  entityType: "LOCATION", name: "Harbor", description: text, aliases: [], tags: [],
}]);
const claimsResult = JSON.stringify({ claims: [{
  type: "CHARACTER_LOCATION", subject: "Mira", predicate: "lives in", object: "Harbor",
  quote: text, blockId: "fixture-block", importance: 3, confidence: 100,
}] });

function query(sql, ...params) {
  const db = new DatabaseSync(join(projectRoot, "project.sqlite"), { readOnly: true });
  try { return db.prepare(sql).all(...params); }
  finally { db.close(); }
}

async function project(name) {
  projectRoot = join(artifacts, name);
  await invoke(main, "create_project", { root: projectRoot, name });
  assert.deepEqual(query("SELECT id FROM model_profiles"), [], "new projects start without model snapshots");
}

async function profile(model, respond, id = randomUUID()) {
  responses.set(model, respond);
  const saved = await invoke(main, "upsert_model_profile", { input: {
    id, name: model, provider: "OPEN_AI_COMPATIBLE", capability: "CHAT",
    baseUrl, modelId: model, contextWindow: 16384, maxOutputTokens: 2048,
    privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 10, retryLimit: 0,
    inputPriceMicrosPerMillion: 1_000_000, outputPriceMicrosPerMillion: 2_000_000,
    priceCurrency: "USD",
  } });
  if (!profileIds.includes(id)) {
    profileIds.push(id);
    await invoke(main, "save_model_secret", { profileId: id, secret: "synthetic-loopback-only-key" });
  }
  return saved;
}

async function preference(task, primary, fallback = null) {
  const preferences = await invoke(main, "get_ai_task_preferences");
  preferences[task] = {
    profileId: primary.id, fallbackProfileId: fallback?.id ?? null,
    temperature: 0.1, maxOutputTokens: 1024,
    prompt: { context: { includeProjectKnowledge: false, inputTokenBudget: 8192 } },
  };
  await invoke(main, "save_ai_task_preferences", { preferences });
}

async function lastRun({ model, status = "COMPLETED", attempts = 1, fallback = null }) {
  const runs = await invoke(main, "list_ai_runs", { limit: 100 });
  const run = runs[0];
  assert(run, "task creates a usage record");
  assert.equal(run.status, status);
  assert.equal(run.profileName, model);
  assert.equal(run.attemptCount, attempts);
  assert.equal(run.retryReason, fallback ? "PROVIDER_UNAVAILABLE" : null);
  const request = await invoke(main, "get_ai_run_request", { runId: run.id });
  assert.equal(JSON.parse(request.requestBody).model, model, "snapshot names the actual attempted model");
  assert.equal(query("SELECT fallback_profile_id FROM ai_run_records WHERE id=?", run.id)[0].fallback_profile_id, fallback?.id ?? null);
  events.push({ stage: projectRoot, runId: run.id, model, status, attempts });
  return run;
}

async function expectFailure(command, args, code) {
  const error = await main.page.evaluate(async ({ command, args }) => {
    try {
      await window.__TAURI_INTERNALS__.invoke(command, args);
      return null;
    } catch (error) {
      return error;
    }
  }, { command, args });
  assert.equal(error?.code, code, JSON.stringify(error));
}

function extractionInput(primary) {
  return { profileId: primary.id, entityType: "CONCEPT", entityName: "World",
    briefSummary: "Places", applicabilityScope: "Book", sourceText: text,
    userGuidance: null, temperature: 0.1, maxOutputTokens: 1024 };
}

async function chapter() {
  const saved = await invoke(main, "create_plan_node", { parentId: null, kind: "CHAPTER", title: "Fixture chapter" });
  const current = await invoke(main, "current_manuscript_draft", { chapterId: saved.id });
  const draft = await invoke(main, "save_manuscript_draft", {
    chapterId: saved.id, baseRevisionId: null, documentJson, expectedVersion: current.version,
  });
  await invoke(main, "commit_manuscript_draft", {
    chapterId: saved.id, baseRevisionId: null, documentJson, expectedVersion: draft.version,
  });
  return saved;
}

async function planning(primary) {
  const job = await invoke(main, "enqueue_planning_ai_job", { input: {
    profileId: primary.id, mode: "GENERATE", sectionId: "seed-premise",
    sectionTitle: "Fixture premise", sectionPrompt: "Describe the premise.",
    existingContext: "", referenceContent: "", userGuidance: "", allowRewrite: false,
    temperature: 0.1, maxOutputTokens: 1024, taskKey: "workDesign", sourceName: null,
  } });
  const jobs = await until(() => invoke(main, "list_jobs"), (items) =>
    items.some((item) => item.id === job.id && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.status)),
  "planning job finishes", 45000);
  return jobs.find((item) => item.id === job.id);
}

function proposalArgs(primary, savedChapter, action = "CONSISTENCY_CHECK") {
  return {
    profileId: primary.id, chapterId: savedChapter.id, action,
    chapterTitle: savedChapter.title, chapterPlan: "", volumePlan: "", documentJson,
    selection: null, instruction: null, reviewPurpose: action === "CONSISTENCY_CHECK" ? "MANUSCRIPT" : null, stream: false,
    temperature: 0.1, maxOutputTokens: 1024,
  };
}

try {
  main = await launch("isolated");
  const success = (content) => () => ({ content });
  const unavailable = () => ({ status: 503 });
  const authentication = () => ({ status: 401 });
  let primary = await profile("file-primary", success(entityResult));
  await preference("knowledgeExtraction", primary);
  await project("file-ui-fresh");
  await main.page.goto(`${main.origin}/knowledge`);
  await main.page.getByRole("link", { name: "\u63d0\u53d6\u8bbe\u5b9a", exact: true }).click();
  await main.page.getByLabel("\u63d0\u70bc\u4e3b\u9898", { exact: true }).fill("World");
  await main.page.getByLabel("\u7b80\u8981\u6982\u8ff0", { exact: true }).fill("Places");
  await main.page.getByLabel("\u9002\u7528\u8303\u56f4", { exact: true }).fill("Book");
  await main.page.getByLabel("\u5bfc\u5165\u8d44\u6599\u6587\u4ef6").setInputFiles({
    name: "world.md", mimeType: "text/markdown", buffer: Buffer.from(text),
  });
  await main.page.getByRole("button", { name: "\u6309\u4e3b\u9898\u63d0\u70bc", exact: true }).click();
  await main.page.getByLabel("\u5bfc\u5165\u5019\u9009\u5ba1\u6838").waitFor();
  await lastRun({ model: primary.modelId });
  assert.deepEqual(query("SELECT id FROM entities"), [], "extracting does not auto-import candidates");
  await main.page.screenshot({ path: join(artifacts, "file-extraction-candidates.png"), fullPage: true });
  // Leave the candidate uncommitted; subsequent cases use IPC in isolated projects.
  await main.page.goto(main.origin);

  const originalRoot = projectRoot;
  primary = await profile("file-updated", success(entityResult), primary.id);
  await project("file-after-project-switch");
  await invoke(main, "extract_entities_from_text", { input: extractionInput(primary) });
  await lastRun({ model: "file-updated" });
  assert.equal(query("SELECT model_id FROM model_profiles WHERE id=?", primary.id)[0].model_id, "file-updated");
  await invoke(main, "open_project", { root: originalRoot });
  projectRoot = originalRoot;
  await invoke(main, "extract_entities_from_text", { input: extractionInput(primary) });
  await lastRun({ model: "file-updated" });

  for (const failed of [false, true]) {
    primary = await profile(`file-unavailable-${failed}`, unavailable);
    const fallback = await profile(`file-fallback-${failed}`, failed ? authentication : success(entityResult));
    await preference("knowledgeExtraction", primary, fallback);
    await project(`file-fallback-${failed}`);
    const args = { input: extractionInput(primary) };
    if (failed) await expectFailure("extract_entities_from_text", args, "PROVIDER_AUTHENTICATION");
    else assert.equal((await invoke(main, "extract_entities_from_text", args))[0].name, "Harbor");
    await lastRun({ model: fallback.modelId, status: failed ? "FAILED" : "COMPLETED", attempts: 2, fallback });
  }

  for (const mode of ["success", "fallback", "failed-fallback", "invalid-json"]) {
    primary = await profile(`chapter-${mode}`, mode.includes("fallback") ? unavailable :
      success(mode === "invalid-json" ? "not valid json" : chapterResult));
    const fallback = mode.includes("fallback") ? await profile(`chapter-backup-${mode}`,
      mode === "failed-fallback" ? authentication : success(chapterResult)) : null;
    await preference("knowledgeExtraction", primary, fallback);
    await project(`chapter-${mode}`);
    const savedChapter = await chapter();
    const args = { input: {
      profileId: primary.id, chapterId: savedChapter.id, sourceRevisionId: null,
      userGuidance: null, temperature: 0.1, maxOutputTokens: 1024,
    } };
    const failed = mode === "failed-fallback" || mode === "invalid-json";
    if (failed) await expectFailure("extract_chapter_candidates", args,
      mode === "invalid-json" ? "INVALID_RESPONSE" : "PROVIDER_AUTHENTICATION");
    else assert.equal((await invoke(main, "extract_chapter_candidates", args)).items.length, 1);
    await lastRun({ model: (fallback ?? primary).modelId, status: failed ? "FAILED" : "COMPLETED",
      attempts: fallback ? 2 : 1, fallback });
    assert.equal(query("SELECT id FROM entities").length, 0, "chapter extraction requires explicit adoption");
    assert.equal(JSON.parse((await invoke(main, "current_manuscript", { chapterId: savedChapter.id })).documentJson).content[0].content[0].text, text);
  }

  for (const mode of ["success", "fallback", "failed-fallback"]) {
    primary = await profile(`planning-${mode}`, mode.includes("fallback") ? unavailable : success("A complete fixture premise."));
    const fallback = mode.includes("fallback") ? await profile(`planning-backup-${mode}`,
      mode === "failed-fallback" ? authentication : success("A complete fallback premise.")) : null;
    await preference("workDesign", primary, fallback);
    await project(`planning-${mode}`);
    const job = await planning(primary);
    assert.equal(job.status, mode === "failed-fallback" ? "FAILED" : "SUCCEEDED", job.errorSummary);
    await lastRun({ model: (fallback ?? primary).modelId,
      status: mode === "failed-fallback" ? "FAILED" : "COMPLETED", attempts: fallback ? 2 : 1, fallback });
    const payload = JSON.parse(query("SELECT payload FROM jobs WHERE id=?", job.id)[0].payload);
    assert.equal(JSON.parse(payload.finalRequestBody).model, (fallback ?? primary).modelId);
    if (fallback) {
      const jobEvents = await invoke(main, "list_job_events", { jobId: job.id });
      assert.equal(jobEvents.filter((event) => event.stage === "FALLBACK").length, 1);
    }
  }

  for (const failed of [false, true]) {
    primary = await profile(`writing-primary-${failed}`, unavailable);
    const fallback = await profile(`writing-fallback-${failed}`,
      failed ? authentication : success("Mira opens the door. The harbor is quiet. She waits for dawn."));
    await preference("writing", primary, fallback);
    await project(`writing-${failed}`);
    const savedChapter = await chapter();
    const before = await invoke(main, "current_manuscript", { chapterId: savedChapter.id });
    const args = proposalArgs(primary, savedChapter, "DRAFT");
    if (failed) await expectFailure("generate_ai_proposal", args, "PROVIDER_AUTHENTICATION");
    else assert((await invoke(main, "generate_ai_proposal", args)).outputText.includes("Mira"));
    await lastRun({ model: fallback.modelId, status: failed ? "FAILED" : "COMPLETED",
      attempts: 2, fallback });
    assert.equal((await invoke(main, "current_manuscript", { chapterId: savedChapter.id })).id, before.id,
      "fallback must not replace the saved manuscript");
  }

  for (const stage of ["claim", "semantic", "failed-claim", "failed-semantic"]) {
    const claimContent = stage === "failed-semantic" ? JSON.stringify({ claims:
      Array.from({ length: 9 }, (_, index) => ({
        ...JSON.parse(claimsResult).claims[0], subject: `Character ${index}`,
      })),
    }) : claimsResult;
    primary = await profile(`review-${stage}`, (_, count) =>
      !stage.includes("semantic") || count > 0 ? { status: 503 } : { content: claimContent });
    const fallback = await profile(`review-backup-${stage}`, (_, count) => {
      if (stage.startsWith("failed")) return { status: 401 };
      return { content: stage === "claim" && count === 0 ? claimsResult :
        JSON.stringify({ summary: "Fixture semantic review.", findings: [], omitted: [] }) };
    });
    await preference("consistencyReview", primary, fallback);
    await project(`review-${stage}`);
    const savedChapter = await chapter();
    const args = proposalArgs(primary, savedChapter);
    if (stage === "failed-claim") await expectFailure("generate_ai_proposal", args, "PROVIDER_AUTHENTICATION");
    else await invoke(main, "generate_ai_proposal", args);
    await lastRun({ model: fallback.modelId, status: stage === "failed-claim" ? "FAILED" : "COMPLETED",
      attempts: 2, fallback });
    const task = query("SELECT profile_id, fallback_profile_id, attempt_count FROM ai_tasks")[0];
    assert.equal(task.profile_id, fallback.id);
    assert.equal(task.fallback_profile_id, fallback.id);
    assert.equal(task.attempt_count, 2, "review records each switch once");
  }
  assert.deepEqual(main.pageErrors, []);
  passed = true;
} catch (error) {
  events.push({ stage: "failed", error: String(error) });
  await main?.page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try {
    for (const profileId of profileIds) await invoke(main, "delete_model_secret", { profileId });
  } finally {
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    await cleanup();
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed, events, requests }, null, 2));
    console.log(`Model sync smoke ${passed ? "passed" : "failed"}: ${artifacts}`);
  }
}
