import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_TASK_DEFINITIONS, emptyAiTaskPreferences as recommendedAiTaskPreferences } from "../lib/ai-task-preferences";
import { SettingsView } from "./settings-view";

const mocks = vi.hoisted(() => ({
  listModelProfiles: vi.fn(),
  getAiTaskPreferences: vi.fn(),
  saveAiTaskPreferences: vi.fn(),
  getAiBudgetSettings: vi.fn(),
  saveAiBudgetSettings: vi.fn(),
  listAiRuns: vi.fn(),
  getAiUsageSummary: vi.fn(),
  getAiQualitySummary: vi.fn(),
  getProjectAiTaskOverrides: vi.fn(),
  saveProjectAiTaskOverride: vi.fn(),
  saveProjectAiTaskOverrides: vi.fn(),
  removeProjectAiTaskOverride: vi.fn(),
}));

function recommendedAiTaskPreferenceSnapshot() {
  return Object.fromEntries(
    AI_TASK_DEFINITIONS.map(({ key }) => [key, { ...recommendedAiTaskPreferences[key] }]),
  );
}

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    listModelProfiles: mocks.listModelProfiles,
    getAiTaskPreferences: mocks.getAiTaskPreferences,
    saveAiTaskPreferences: mocks.saveAiTaskPreferences,
    getAiBudgetSettings: mocks.getAiBudgetSettings,
    saveAiBudgetSettings: mocks.saveAiBudgetSettings,
    listAiRuns: mocks.listAiRuns,
    getAiUsageSummary: mocks.getAiUsageSummary,
    getAiQualitySummary: mocks.getAiQualitySummary,
    getProjectAiTaskOverrides: mocks.getProjectAiTaskOverrides,
    saveProjectAiTaskOverride: mocks.saveProjectAiTaskOverride,
    saveProjectAiTaskOverrides: mocks.saveProjectAiTaskOverrides,
    removeProjectAiTaskOverride: mocks.removeProjectAiTaskOverride,
  };
});

describe("SettingsView", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  beforeEach(() => {
    mocks.listModelProfiles.mockResolvedValue([]);
    mocks.getAiTaskPreferences.mockResolvedValue(recommendedAiTaskPreferenceSnapshot());
    mocks.saveAiTaskPreferences.mockImplementation(async (preferences) => preferences);
    mocks.getAiBudgetSettings.mockResolvedValue({
      currency: "USD",
      dailyLimitMicros: null,
      projectLimitMicros: null,
    });
    mocks.saveAiBudgetSettings.mockImplementation(async (settings) => settings);
    mocks.listAiRuns.mockResolvedValue([]);
    mocks.getAiUsageSummary.mockResolvedValue({
      days: 30,
      total: [],
      daily: [],
      byTask: [],
    });
    mocks.getAiQualitySummary.mockResolvedValue({
      totalProposals: 0,
      totalRated: 0,
      totalHelpful: 0,
      totalWithIssues: 0,
      groups: [],
    });
    mocks.getProjectAiTaskOverrides.mockResolvedValue({
      available: false,
      workDesign: null,
      outline: null,
      volumePlanning: null,
      chapterSplit: null,
      chapterPlan: null,
      consistencyReview: null,
      writing: null,
      knowledgeExtraction: null,
    });
    mocks.saveProjectAiTaskOverride.mockImplementation(async (_task, preference) => ({
      available: true,
      workDesign: preference,
      outline: null,
      volumePlanning: null,
      chapterSplit: null,
      chapterPlan: null,
      consistencyReview: null,
      writing: null,
      knowledgeExtraction: null,
    }));
    mocks.saveProjectAiTaskOverrides.mockImplementation(async (preferences) => ({
      available: true,
      ...preferences,
    }));
    mocks.removeProjectAiTaskOverride.mockResolvedValue({
      available: true,
      workDesign: null,
      outline: null,
      volumePlanning: null,
      chapterSplit: null,
      chapterPlan: null,
      consistencyReview: null,
      writing: null,
      knowledgeExtraction: null,
    });
  });

  it("places model API configuration under settings", async () => {
    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    expect(screen.getByRole("heading", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "模型 API" })).toHaveAttribute("data-active");
    expect(await screen.findByRole("heading", { name: "模型 API" })).toBeVisible();
    expect(screen.getByLabelText("新建模型配置")).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("deepseek-v4-flash");
    expect(screen.getByDisplayValue("128000")).toBeVisible();
    expect(screen.getByDisplayValue("8192")).toBeVisible();
  });

  it("starts a visibly new model configuration draft", async () => {
    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    await screen.findByRole("heading", { name: "模型 API" });
    fireEvent.click(screen.getByLabelText("新建模型配置"));
    expect(screen.getByDisplayValue("新模型配置")).toBeVisible();
    expect(screen.getByText("已创建新的配置草稿，填写后保存即可。")).toBeVisible();
  });

  it("switches profiles from the persistent model list", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:deepseek-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
      {
        id: "embedding-profile", name: "小说知识库", provider: "SILICON_FLOW", capability: "EMBEDDING",
        baseUrl: "https://api.siliconflow.cn/v1", modelId: "BAAI/bge-m3", contextWindow: 8192,
        maxOutputTokens: 1, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 60, retryLimit: 2,
        secretRef: "model-profile:embedding-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: "编辑 DeepSeek 写作 deepseek-v4-flash" })).toBeVisible();
    expect(await screen.findByDisplayValue("DeepSeek 写作")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "编辑 小说知识库 BAAI/bge-m3" }));
    expect(await screen.findByDisplayValue("小说知识库")).toBeVisible();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("BAAI/bge-m3");
  });

  it("routes each AI task to a configured chat model", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:deepseek-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
      {
        id: "outline-profile", name: "大纲模型", provider: "OPEN_AI", capability: "CHAT",
        baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.6-terra", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:outline-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    expect(await screen.findByRole("heading", { name: "AI 任务模型" })).toBeVisible();
    fireEvent.change(await screen.findByLabelText("大纲主线模型"), { target: { value: "outline-profile" } });
    fireEvent.change(screen.getByLabelText("大纲主线备用模型"), { target: { value: "deepseek-profile" } });
    fireEvent.change(screen.getByLabelText("大纲主线温度"), { target: { value: "0.4" } });
    fireEvent.change(screen.getByLabelText("大纲主线最大输出"), { target: { value: "4096" } });
    fireEvent.click(screen.getByRole("button", { name: "保存任务配置" }));

    await screen.findByText("任务模型与生成参数已保存，后续生成会立即使用新配置");
    expect(mocks.saveAiTaskPreferences).toHaveBeenCalledWith(expect.objectContaining({
      outline: expect.objectContaining({
        profileId: "outline-profile",
        fallbackProfileId: "deepseek-profile",
        temperature: 0.4,
        maxOutputTokens: 4096,
        prompt: expect.objectContaining({
          systemPrompt: null,
          instructionTemplate: null,
        }),
      }),
    }));
  });

  it("shows the eight recommended defaults and restores an overridden task", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:deepseek-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    expect(await screen.findByRole("heading", { name: "AI 任务模型" })).toBeVisible();
    await screen.findByLabelText("作品设定温度");

    for (const task of AI_TASK_DEFINITIONS) {
      expect(screen.getByLabelText(`${task.label}温度`)).toHaveValue(task.defaultTemperature);
      expect(screen.getByLabelText(`${task.label}最大输出`)).toHaveValue(task.defaultMaxOutputTokens);
    }
    expect(screen.queryByRole("button", { name: "恢复生成参数" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("大纲主线温度"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("大纲主线最大输出"), { target: { value: "2048" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复生成参数" }));

    expect(screen.getByLabelText("大纲主线温度")).toHaveValue(0.6);
    expect(screen.getByLabelText("大纲主线最大输出")).toHaveValue(6144);
    expect(screen.queryByRole("button", { name: "恢复生成参数" })).not.toBeInTheDocument();
  });

  it("applies a genre preset without replacing the selected model or custom prompt", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:deepseek-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);
    const preferences = recommendedAiTaskPreferenceSnapshot();
    preferences.workDesign = {
      ...preferences.workDesign,
      profileId: "deepseek-profile",
      prompt: {
        ...preferences.workDesign.prompt,
        systemPrompt: "保持作者既有边界",
      },
    };
    mocks.getAiTaskPreferences.mockResolvedValue(preferences);

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    await screen.findByLabelText("作品设定温度");

    fireEvent.click(screen.getByRole("button", { name: "悬疑推理" }));
    expect(screen.getByLabelText("大纲主线温度")).toHaveValue(0.45);
    expect(screen.getByLabelText("章节拆分温度")).toHaveValue(0.2);
    fireEvent.click(screen.getByRole("button", { name: "保存任务配置" }));

    await screen.findByText("任务模型与生成参数已保存，后续生成会立即使用新配置");
    expect(mocks.saveAiTaskPreferences).toHaveBeenCalledWith(expect.objectContaining({
      workDesign: expect.objectContaining({
        profileId: "deepseek-profile",
        temperature: 0.35,
        prompt: expect.objectContaining({
          systemPrompt: "保持作者既有边界",
        }),
      }),
      writing: expect.objectContaining({ temperature: 0.7 }),
    }));
  });

  it("opens AI task routing from a deep link and clears deleted model mappings", async () => {
    window.location.hash = "#ai-task-models";
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "available-profile", name: "可用模型", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:available-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getAiTaskPreferences.mockResolvedValue({
      ...recommendedAiTaskPreferenceSnapshot(),
      outline: { profileId: "deleted-profile", temperature: null, maxOutputTokens: null },
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "AI 任务模型" })).toBeVisible();
    const outlineModel = await screen.findByLabelText("大纲主线模型");
    await waitFor(() => expect(outlineModel).toHaveValue(""));
    fireEvent.click(screen.getByRole("button", { name: "保存任务配置" }));

    await screen.findByText("任务模型与生成参数已保存，后续生成会立即使用新配置");
    expect(mocks.saveAiTaskPreferences).toHaveBeenCalledWith(expect.objectContaining({
      outline: expect.objectContaining({
        profileId: null,
        temperature: 0.6,
        maxOutputTokens: 6144,
        prompt: expect.objectContaining({
          context: expect.objectContaining({ inputTokenBudget: 32768 }),
        }),
      }),
    }));
  });

  it("edits and preserves per-task prompt, variables, context switches, and budget", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:deepseek-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    await screen.findByRole("heading", { name: "AI 任务模型" });
    await screen.findByLabelText("作品设定温度");
    fireEvent.click(screen.getByRole("tab", { name: /正文书写/ }));

    fireEvent.change(screen.getByLabelText(/系统提示词覆盖/), { target: { value: "保持第一人称，克制表达。" } });
    fireEvent.change(screen.getByLabelText(/自定义任务模板/), { target: { value: "章节 {{chapterTitle}}" } });
    fireEvent.click(screen.getByRole("button", { name: "{{userInstruction}}" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /当前草稿/ }));
    fireEvent.change(screen.getByLabelText(/输入 Token 预算/), { target: { value: "24576" } });
    fireEvent.click(screen.getByRole("button", { name: "保存任务配置" }));

    await screen.findByText("任务模型与生成参数已保存，后续生成会立即使用新配置");
    expect(mocks.saveAiTaskPreferences).toHaveBeenCalledWith(expect.objectContaining({
      writing: expect.objectContaining({
        prompt: {
          systemPrompt: "保持第一人称，克制表达。",
          instructionTemplate: "章节 {{chapterTitle}}{{userInstruction}}",
          context: expect.objectContaining({
            includeCurrentDraft: false,
            inputTokenBudget: 24576,
          }),
        },
      }),
    }));
  });

  it("saves the selected task as a project-level override", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        secretRef: "model-profile:deepseek-profile", hasSecret: true, createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getProjectAiTaskOverrides.mockResolvedValue({
      available: true,
      workDesign: null,
      outline: null,
      volumePlanning: null,
      chapterSplit: null,
      chapterPlan: null,
      consistencyReview: null,
      writing: null,
      knowledgeExtraction: null,
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    await screen.findByLabelText("作品设定温度");
    fireEvent.click(screen.getByRole("button", { name: "保存为项目覆盖" }));

    await screen.findByText("已保存“作品设定”的项目级覆盖");
    expect(mocks.saveProjectAiTaskOverride).toHaveBeenCalledWith(
      "workDesign",
      expect.objectContaining({ temperature: 0.45, maxOutputTokens: 4096 }),
    );
  });

  it("loads project overrides into a separate project editing scope", async () => {
    const global = recommendedAiTaskPreferenceSnapshot();
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
        priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
        createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getAiTaskPreferences.mockResolvedValue(global);
    mocks.getProjectAiTaskOverrides.mockResolvedValue({
      available: true,
      workDesign: {
        ...global.workDesign,
        temperature: 1.1,
        maxOutputTokens: 3072,
      },
      outline: null,
      volumePlanning: null,
      chapterSplit: null,
      chapterPlan: null,
      consistencyReview: null,
      writing: null,
      knowledgeExtraction: null,
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    await screen.findByLabelText("作品设定温度");
    expect(screen.getByLabelText("作品设定温度")).toHaveValue(0.45);

    fireEvent.click(screen.getByRole("tab", { name: "项目覆盖" }));
    await waitFor(() => expect(screen.getByLabelText("作品设定温度")).toHaveValue(1.1));
    expect(screen.getByLabelText("作品设定最大输出")).toHaveValue(3072);
  });

  it("persists the preferred model to all project task overrides", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
        priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
        createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getProjectAiTaskOverrides.mockResolvedValue({
      available: true,
      workDesign: null,
      outline: null,
      volumePlanning: null,
      chapterSplit: null,
      chapterPlan: null,
      consistencyReview: null,
      writing: null,
      knowledgeExtraction: null,
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    await screen.findByLabelText("作品设定温度");
    fireEvent.click(screen.getByRole("tab", { name: "项目覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "全部使用首选模型" }));

    await screen.findByText("已将“DeepSeek 写作”应用并保存到全部项目任务");
    expect(mocks.saveProjectAiTaskOverrides).toHaveBeenCalledTimes(1);
    const saved = mocks.saveProjectAiTaskOverrides.mock.calls[0][0];
    expect(AI_TASK_DEFINITIONS.every(({ key }) => saved[key].profileId === "deepseek-profile")).toBe(true);
  });

  it("shows estimated model cost for unified AI runs", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
        priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
        createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.listAiRuns.mockResolvedValue([
      {
        id: "run-1",
        taskKey: "outline",
        source: "PLANNING",
        action: "outline",
        status: "COMPLETED",
        chapterTitle: "故事大纲",
        profileName: "规划模型",
        attemptCount: 1,
        retryReason: null,
        errorCode: null,
        estimatedInputTokens: 1000,
        estimatedOutputTokens: 500,
        estimatedCostMicros: 20000,
        priceCurrency: "USD",
        promptVersion: "planning-v1",
        createdAt: "2026-09-11T00:00:00Z",
        finishedAt: "2026-09-11T00:00:01Z",
      },
    ]);

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "预算与记录" }));
    expect(await screen.findAllByText(/USD 0\.02/)).toHaveLength(2);
    expect(screen.getByText("大纲主线 · 故事大纲")).toBeVisible();
    expect(screen.getByText(/耗时 1 秒/)).toBeVisible();
  });

  it("estimates the next task cost from saved token usage", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
        priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
        createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getAiUsageSummary.mockResolvedValue({
      days: 30,
      total: [],
      daily: [],
      byTask: [{
        taskKey: "workDesign",
        currency: "USD",
        runCount: 2,
        inputTokens: 8000,
        outputTokens: 4000,
        estimatedCostMicros: 60000,
      }],
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));

    expect(await screen.findByText(/预估下一次约 USD 0\.03 · 基于近 30 天 2 次记录/)).toBeVisible();
  });

  it("warns when estimated spend reaches a soft budget", async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
        priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
        createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getAiUsageSummary.mockResolvedValue({
      days: 30,
      total: [{
        currency: "USD",
        runCount: 2,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostMicros: 20000,
      }],
      daily: [{
        date: today,
        currency: "USD",
        runCount: 2,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostMicros: 20000,
      }],
      byTask: [],
    });
    mocks.getAiBudgetSettings.mockResolvedValue({
      currency: "USD",
      dailyLimitMicros: 25000,
      projectLimitMicros: 100000,
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "预算与记录" }));

    expect(await screen.findByText("今日估算费用已达到每日预算的 80%")).toBeVisible();
  });

  it("shows model and prompt quality review metrics", async () => {
    mocks.listModelProfiles.mockResolvedValue([
      {
        id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
        baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
        maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
        inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
        priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
        createdAt: "0", updatedAt: "0",
      },
    ]);
    mocks.getAiQualitySummary.mockResolvedValue({
      totalProposals: 3,
      totalRated: 3,
      totalHelpful: 2,
      totalWithIssues: 1,
      groups: [{
        taskKey: "writing",
        action: "DRAFT",
        promptVersion: "r3-writing-v4+task-abc",
        profileName: "DeepSeek 写作",
        proposalCount: 3,
        acceptedCount: 2,
        ratedCount: 3,
        helpfulCount: 2,
        notHelpfulCount: 1,
        validCount: 2,
        warningCount: 1,
        needsInputCount: 0,
        invalidCount: 0,
      }],
    });

    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "预算与记录" }));

    expect(await screen.findByText("整章创作 · DeepSeek 写作")).toBeVisible();
    expect(screen.getByText("有帮助 67%")).toBeVisible();
    expect(screen.getByText("需补资料 0 · 校验问题 33%")).toBeVisible();
    expect(screen.getByText("采用 67%")).toBeVisible();
  });
});
