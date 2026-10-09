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
  getAiUsageSummary: vi.fn(),
  getProjectAiTaskOverrides: vi.fn(),
  getAuditFlowSettings: vi.fn(),
  getWritingReviewPolicy: vi.fn(),
  saveProjectAiTaskOverride: vi.fn(),
  saveProjectAiTaskOverrides: vi.fn(),
  removeProjectAiTaskOverride: vi.fn(),
  upsertModelProfile: vi.fn(),
  saveModelSecret: vi.fn(),
  testModelProfile: vi.fn(),
  deleteModelSecret: vi.fn(),
  saveWritingReviewPolicy: vi.fn(),
  saveAuditFlowSettings: vi.fn(),
}));

function recommendedAiTaskPreferenceSnapshot() {
  return Object.fromEntries(
    AI_TASK_DEFINITIONS.map(({ key }) => [key, { ...recommendedAiTaskPreferences[key] }]),
  );
}

function chatProfile() {
  return {
    id: "deepseek-profile", name: "DeepSeek 写作", provider: "DEEP_SEEK", capability: "CHAT",
    baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128000,
    maxOutputTokens: 8192, privacyLevel: "ALLOW_CLOUD", timeoutSeconds: 120, retryLimit: 1,
    inputPriceMicrosPerMillion: 2500000, outputPriceMicrosPerMillion: 10000000,
    priceCurrency: "USD", secretRef: "model-profile:deepseek-profile", hasSecret: true,
    createdAt: "0", updatedAt: "0",
  };
}

function renderSettings() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SettingsView /></QueryClientProvider>);
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
    getAiUsageSummary: mocks.getAiUsageSummary,
    getProjectAiTaskOverrides: mocks.getProjectAiTaskOverrides,
    getAuditFlowSettings: mocks.getAuditFlowSettings,
    getWritingReviewPolicy: mocks.getWritingReviewPolicy,
    saveProjectAiTaskOverride: mocks.saveProjectAiTaskOverride,
    saveProjectAiTaskOverrides: mocks.saveProjectAiTaskOverrides,
    removeProjectAiTaskOverride: mocks.removeProjectAiTaskOverride,
    upsertModelProfile: mocks.upsertModelProfile,
    saveModelSecret: mocks.saveModelSecret,
    testModelProfile: mocks.testModelProfile,
    deleteModelSecret: mocks.deleteModelSecret,
    saveWritingReviewPolicy: mocks.saveWritingReviewPolicy,
    saveAuditFlowSettings: mocks.saveAuditFlowSettings,
  };
});

describe("SettingsView", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listModelProfiles.mockResolvedValue([]);
    mocks.upsertModelProfile.mockImplementation(async (profile) => ({ ...profile, id: profile.id ?? "saved-profile" }));
    mocks.saveModelSecret.mockResolvedValue(undefined);
    mocks.testModelProfile.mockResolvedValue({ detail: "连接成功", success: true });
    mocks.deleteModelSecret.mockResolvedValue(undefined);
    mocks.getAiTaskPreferences.mockResolvedValue(recommendedAiTaskPreferenceSnapshot());
    mocks.saveAiTaskPreferences.mockImplementation(async (preferences) => preferences);
    mocks.getAiBudgetSettings.mockResolvedValue({
      currency: "USD",
      dailyLimitMicros: null,
      projectLimitMicros: null,
    });
    mocks.saveAiBudgetSettings.mockImplementation(async (settings) => settings);
    mocks.getAiUsageSummary.mockResolvedValue({
      days: 30,
      total: [],
      daily: [],
      byTask: [],
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
    mocks.getWritingReviewPolicy.mockResolvedValue("BALANCED");
    mocks.saveWritingReviewPolicy.mockImplementation(async (policy) => policy);
    mocks.getAuditFlowSettings.mockResolvedValue({ admission: true, manuscript: true, knowledge: true });
    mocks.saveAuditFlowSettings.mockImplementation(async (settings) => settings);
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
    expect(screen.getByLabelText("模型 ID")).toHaveValue("deepseek-flash");
    expect(screen.getByDisplayValue("1000000")).not.toBeVisible();
    fireEvent.click(screen.getByText("模型限制与计费"));
    expect(screen.getByDisplayValue("1000000")).toBeVisible();
    expect(screen.getByDisplayValue("384000")).toBeVisible();
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
    await screen.findByLabelText("作品设定温度");
    fireEvent.click(screen.getByRole("tab", { name: /大纲主线/ }));
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

  it("shows all recommended defaults and restores an overridden task", async () => {
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
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(task.label) }));
      expect(screen.getByLabelText(`${task.label}温度`)).toHaveValue(task.defaultTemperature);
      expect(screen.getByLabelText(`${task.label}最大输出`)).toHaveValue(task.defaultMaxOutputTokens);
    }
    expect(screen.queryByRole("button", { name: "恢复推荐参数" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /大纲主线/ }));
    fireEvent.change(screen.getByLabelText("大纲主线温度"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("大纲主线最大输出"), { target: { value: "2048" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复推荐参数" }));

    expect(screen.getByLabelText("大纲主线温度")).toHaveValue(0.6);
    expect(screen.getByLabelText("大纲主线最大输出")).toHaveValue(6144);
    expect(screen.queryByRole("button", { name: "恢复推荐参数" })).not.toBeInTheDocument();
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

    fireEvent.change(screen.getByLabelText("题材参数"), { target: { value: "mystery" } });
    fireEvent.click(screen.getByRole("tab", { name: /大纲主线/ }));
    expect(screen.getByLabelText("大纲主线温度")).toHaveValue(0.45);
    fireEvent.click(screen.getByRole("tab", { name: /章节拆分/ }));
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
    await screen.findByLabelText("作品设定温度");
    fireEvent.click(screen.getByRole("tab", { name: /大纲主线/ }));
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

  it("keeps advanced controls collapsed but lets the author expand them", async () => {
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
    expect(screen.getByText("备用模型和高级设置")).toBeVisible();
    expect(screen.getByLabelText(/系统提示词覆盖/)).not.toBeVisible();
    expect(screen.getByLabelText(/输入 Token 预算/)).not.toBeVisible();
    fireEvent.click(screen.getByText("备用模型和高级设置"));
    expect(screen.getByLabelText(/系统提示词覆盖/)).toBeVisible();
    expect(screen.getByLabelText(/输入 Token 预算/)).toBeVisible();
    expect(screen.getByLabelText("正文书写备用模型")).toBeVisible();
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
    fireEvent.click(screen.getByRole("tab", { name: "项目覆盖" }));
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

  it("keeps run details and quality review out of settings", async () => {
    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 用量与预算" }));

    expect(await screen.findByRole("link", { name: "运行明细" })).toHaveAttribute("href", "/jobs#ai-runs");
    expect(screen.queryByRole("tab", { name: /运行记录/ })).not.toBeInTheDocument();
    expect(screen.queryByText("质量回顾")).not.toBeInTheDocument();
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

    expect(await screen.findByText(/预估下一次约 CNY .* · 基于项目累计 2 次记录 · DeepSeek Flash .*按未命中缓存估算/)).toBeVisible();
  });

  it("warns when estimated spend reaches a soft budget", async () => {
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ available: true });
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
    fireEvent.click(screen.getByRole("button", { name: "AI 用量与预算" }));

    expect(await screen.findByText("今日估算费用已达到每日预算的 80%")).toBeVisible();
  });

  it("saves the project writing admission policy", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "审核流程" }));

    expect(await screen.findByRole("heading", { name: "审核流程" })).toBeVisible();
    expect(await screen.findByRole("radio", { name: /平衡模式/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /严格模式/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));

    await waitFor(() => expect(mocks.saveWritingReviewPolicy).toHaveBeenCalledWith("REQUIRED"));
    expect(mocks.saveAuditFlowSettings).toHaveBeenCalledWith({ admission: true, manuscript: true, knowledge: true });
    expect(await screen.findByText("审核流程已保存，后续创作会立即按新设置执行。")).toBeVisible();
  });

  it("asks the author to open a project before configuring writing admission", async () => {
    render(<QueryClientProvider client={new QueryClient()}><SettingsView /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "审核流程" }));

    expect(await screen.findByText("请先打开或新建作品，审核流程按作品单独保存。")).toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "写作准入策略" })).not.toBeInTheDocument();
  });

  it("protects unsaved model changes on both category clicks and hash links", async () => {
    renderSettings();
    await screen.findByLabelText("配置名称");
    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "未保存配置" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    expect(screen.getByLabelText("配置名称")).toHaveValue("未保存配置");
    window.history.replaceState({}, "", "#ai-task-models");
    fireEvent(window, new Event("hashchange"));
    expect(window.location.hash).toBe("#model-api");
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "AI 任务模型" }));
    expect(await screen.findByRole("heading", { name: "AI 任务模型" })).toBeVisible();
    expect(window.location.hash).toBe("#ai-task-models");
  });

  it("validates the model URL and protects an entered API key", async () => {
    renderSettings();
    const key = await screen.findByLabelText("API Key");
    fireEvent.change(key, { target: { value: "test-secret" } });
    expect(key).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(key).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("API Base URL"), { target: { value: "invalid-url" } });
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(screen.getByText(/API 地址须为有效/)).toBeVisible();
    expect(mocks.upsertModelProfile).not.toHaveBeenCalled();
  });

  it("saves the model and credential before testing its connection", async () => {
    renderSettings();
    fireEvent.change(await screen.findByLabelText("API Key"), { target: { value: "test-secret" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功")).toBeVisible();
    expect(mocks.upsertModelProfile).toHaveBeenCalledTimes(1);
    expect(mocks.saveModelSecret).toHaveBeenCalledWith("saved-profile", "test-secret");
    expect(mocks.testModelProfile).toHaveBeenCalledWith("saved-profile");
  });

  it("requires confirmation before removing a saved credential", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    renderSettings();
    await screen.findByDisplayValue("DeepSeek 写作");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "删除 Key" }));
    expect(mocks.deleteModelSecret).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除 Key" }));
    await screen.findByText("API Key 已从系统凭据库删除");
    expect(mocks.deleteModelSecret).toHaveBeenCalledWith("deepseek-profile");
  });

  it("preserves temperature precision and supports keyboard task selection", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    window.history.replaceState({}, "", "#ai-task-models");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("作品设定温度")).toHaveValue(0.45));
    fireEvent.change(screen.getByLabelText("作品设定温度"), { target: { value: "0.35" } });
    expect(screen.getByLabelText("作品设定温度")).toHaveValue(0.35);
    fireEvent.keyDown(screen.getByRole("tab", { name: /作品设定/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /大纲主线/ })).toHaveFocus();
    expect(screen.getByLabelText("大纲主线温度")).toBeVisible();
  });

  it("saves every edited project task while preserving inherited tasks", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    const overrides = Object.fromEntries(AI_TASK_DEFINITIONS.map(({ key }) => [key, null]));
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ ...overrides, available: true });
    mocks.saveProjectAiTaskOverride.mockImplementation(async (task, preference) => {
      overrides[task] = preference;
      return { ...overrides, available: true };
    });
    window.history.replaceState({}, "", "#ai-task-models");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("作品设定温度")).toHaveValue(0.45));
    fireEvent.click(screen.getByRole("tab", { name: "项目覆盖" }));
    fireEvent.change(screen.getByLabelText("作品设定温度"), { target: { value: "0.7" } });
    fireEvent.click(screen.getByRole("tab", { name: /大纲主线/ }));
    fireEvent.change(screen.getByLabelText("大纲主线温度"), { target: { value: "0.8" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为项目覆盖" }));
    expect(await screen.findByText("已保存全部修改的项目级任务配置")).toBeVisible();
    expect(mocks.saveProjectAiTaskOverride).toHaveBeenCalledTimes(2);
    expect(mocks.saveProjectAiTaskOverride).toHaveBeenCalledWith("workDesign", expect.objectContaining({ temperature: 0.7 }));
    expect(mocks.saveProjectAiTaskOverride).toHaveBeenCalledWith("outline", expect.objectContaining({ temperature: 0.8 }));
    expect(overrides.writing).toBeNull();
    expect(screen.getByText("与已保存配置一致")).toBeVisible();
  });

  it("keeps unsaved global parameters out of the project editing scope", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ available: true });
    window.history.replaceState({}, "", "#ai-task-models");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("作品设定温度")).toHaveValue(0.45));
    fireEvent.change(screen.getByLabelText("作品设定温度"), { target: { value: "1.3" } });
    fireEvent.click(screen.getByRole("tab", { name: "项目覆盖" }));
    expect(screen.getByLabelText("作品设定温度")).toHaveValue(0.45);
    fireEvent.click(screen.getByRole("tab", { name: "全局配置" }));
    expect(screen.getByLabelText("作品设定温度")).toHaveValue(1.3);
  });

  it("persists disabled review stages without losing the saved admission policy", async () => {
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ available: true });
    window.history.replaceState({}, "", "#writing-admission");
    renderSettings();
    const admission = await screen.findByRole("switch", { name: "创作准入" });
    fireEvent.click(admission);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByText(/准入策略暂不生效/)).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "知识审核" }));
    fireEvent.click(screen.getByRole("button", { name: "保存流程" }));
    await screen.findByText("审核流程已保存，后续创作会立即按新设置执行。");
    expect(mocks.saveAuditFlowSettings).toHaveBeenCalledWith({ admission: false, manuscript: true, knowledge: false });
    expect(mocks.saveWritingReviewPolicy).toHaveBeenCalledWith("BALANCED");
  });

  it("switches usage periods while keeping task totals explicitly all-time", async () => {
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ available: true });
    mocks.getAiUsageSummary.mockImplementation(async (days) => ({
      days, total: [], daily: [], byTask: [{
        taskKey: "writing", currency: "USD", runCount: 3, inputTokens: 1000,
        outputTokens: 2000, estimatedCostMicros: 50000,
      }],
    }));
    window.history.replaceState({}, "", "#ai-usage");
    renderSettings();
    expect(await screen.findByRole("cell", { name: "正文书写" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "7 天" }));
    await waitFor(() => expect(mocks.getAiUsageSummary).toHaveBeenCalledWith(7));
    expect(await screen.findByText("项目全部历史")).toBeVisible();
    expect(screen.getByText("近 7 天")).toBeVisible();
  });

  it("rejects invalid budgets instead of silently turning off the limit", async () => {
    window.history.replaceState({}, "", "#ai-usage");
    renderSettings();
    const daily = await screen.findByLabelText("每日预算上限");
    await waitFor(() => expect(daily).toBeEnabled());
    fireEvent.change(daily, { target: { value: "-5" } });
    expect(daily).toHaveValue(-5);
    expect(daily).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "保存预算" })).toBeDisabled();
    expect(screen.getByText(/预算须为大于 0/)).toBeVisible();
    expect(mocks.saveAiBudgetSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
    expect(daily).toHaveValue(null);
    fireEvent.change(screen.getByLabelText("预算币种"), { target: { value: "CNY" } });
    fireEvent.change(daily, { target: { value: "10.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存预算" }));
    await screen.findByText("AI 软预算已保存，超出上限时仅提示，不会中断生成");
    expect(mocks.saveAiBudgetSettings).toHaveBeenCalledWith({ currency: "CNY", dailyLimitMicros: 10500000, projectLimitMicros: null });
  });

  it("does not replace saved budget warnings with unsaved draft limits", async () => {
    mocks.getProjectAiTaskOverrides.mockResolvedValue({ available: true });
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const row = { currency: "USD", runCount: 1, inputTokens: 100, outputTokens: 200, estimatedCostMicros: 800000 };
    mocks.getAiUsageSummary.mockResolvedValue({ days: 30, total: [row], daily: [{ ...row, date: today }], byTask: [] });
    mocks.getAiBudgetSettings.mockResolvedValue({ currency: "USD", dailyLimitMicros: 1000000, projectLimitMicros: null });
    window.history.replaceState({}, "", "#ai-usage");
    renderSettings();
    await screen.findByText("今日估算费用已达到每日预算的 80%");
    fireEvent.change(screen.getByLabelText("每日预算上限"), { target: { value: "100" } });
    expect(screen.getByText("今日估算费用已达到每日预算的 80%")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "今日预算" })).toHaveAttribute("value", "80");
  });

  it("shows actionable query errors and never enables saving unloaded model settings", async () => {
    mocks.listModelProfiles.mockRejectedValue(new Error("本机配置不可用"));
    renderSettings();
    expect(await screen.findByRole("alert")).toHaveTextContent("本机配置不可用");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });

  it("clears dirty budget formatting even when the saved amount is unchanged", async () => {
    mocks.getAiBudgetSettings.mockResolvedValue({ currency: "USD", dailyLimitMicros: 1000000, projectLimitMicros: null });
    window.history.replaceState({}, "", "#ai-usage");
    renderSettings();
    const daily = await screen.findByLabelText("每日预算上限");
    await waitFor(() => expect(daily).toHaveValue(1));
    fireEvent.change(daily, { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "保存预算" }));
    await screen.findByText("AI 软预算已保存，超出上限时仅提示，不会中断生成");
    expect(screen.getByRole("button", { name: "保存预算" })).toBeDisabled();
    expect(screen.queryByText("未保存修改")).not.toBeInTheDocument();
  });

  it.each(AI_TASK_DEFINITIONS)("selects $label from its settings deep link", async ({ key, label }) => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    window.history.replaceState({}, "", `#ai-task-models?task=${key}`);
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText(`${label}温度`)).toBeEnabled());
    expect(screen.getByRole("tab", { name: new RegExp(label) })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "选择要设置的 AI 任务" }).children).toHaveLength(10);
  });

  it("changes the selected task on a hash link while preserving drafts", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    window.history.replaceState({}, "", "#ai-task-models?task=discussion");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("共创讨论温度")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("共创讨论温度"), { target: { value: "0.75" } });
    window.history.replaceState({}, "", "#ai-task-models?task=writing");
    fireEvent(window, new Event("hashchange"));
    expect(screen.getByLabelText("正文书写温度")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /共创讨论/ }));
    expect(screen.getByLabelText("共创讨论温度")).toHaveValue(0.75);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.history.replaceState({}, "", "#ai-usage");
    fireEvent(window, new Event("hashchange"));
    expect(window.location.hash).toBe("#ai-task-models?task=discussion");
    expect(screen.getByLabelText("共创讨论温度")).toHaveValue(0.75);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("opens the requested project task override and protects it on scope changes", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    mocks.getProjectAiTaskOverrides.mockResolvedValue({
      available: true,
      discussion: { ...recommendedAiTaskPreferences.discussion, temperature: 1.1 },
    });
    window.history.replaceState({}, "", "#ai-task-models?task=discussion&scope=PROJECT");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("共创讨论温度")).toHaveValue(1.1));
    expect(screen.getByRole("tab", { name: "项目覆盖" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByLabelText("共创讨论温度"), { target: { value: "0.8" } });
    fireEvent.click(screen.getByRole("tab", { name: "项目覆盖" }));
    expect(screen.getByLabelText("共创讨论温度")).toHaveValue(0.8);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    window.history.replaceState({}, "", "#ai-task-models?task=writing");
    fireEvent(window, new Event("hashchange"));
    expect(window.location.hash).toBe("#ai-task-models?task=discussion&scope=PROJECT");
    expect(screen.getByLabelText("共创讨论温度")).toHaveValue(0.8);
  });

  it("falls back to global discussion settings when no project is open, including older preference snapshots", async () => {
    mocks.listModelProfiles.mockResolvedValue([chatProfile()]);
    const legacy = recommendedAiTaskPreferenceSnapshot();
    delete legacy.discussion;
    delete legacy.discussionDesign;
    mocks.getAiTaskPreferences.mockResolvedValue(legacy);
    window.history.replaceState({}, "", "#ai-task-models?task=discussion&scope=PROJECT");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("共创讨论温度")).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("tab", { name: "全局配置" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(screen.getByRole("tab", { name: /构思整理/ }));
    expect(screen.getByLabelText("构思整理温度")).toHaveValue(0.45);
  });
});
