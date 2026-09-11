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
    fireEvent.change(screen.getByLabelText("大纲主线温度"), { target: { value: "0.4" } });
    fireEvent.change(screen.getByLabelText("大纲主线最大输出"), { target: { value: "4096" } });
    fireEvent.click(screen.getByRole("button", { name: "保存任务配置" }));

    await screen.findByText("任务模型与生成参数已保存，后续生成会立即使用新配置");
    expect(mocks.saveAiTaskPreferences).toHaveBeenCalledWith(expect.objectContaining({
      outline: { profileId: "outline-profile", temperature: 0.4, maxOutputTokens: 4096 },
    }));
  });

  it("shows the six recommended defaults and restores an overridden task", async () => {
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
    expect(screen.queryByRole("button", { name: "恢复推荐值" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("大纲主线温度"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("大纲主线最大输出"), { target: { value: "2048" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复推荐值" }));

    expect(screen.getByLabelText("大纲主线温度")).toHaveValue(0.6);
    expect(screen.getByLabelText("大纲主线最大输出")).toHaveValue(6144);
    expect(screen.queryByRole("button", { name: "恢复推荐值" })).not.toBeInTheDocument();
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
      outline: { profileId: null, temperature: 0.6, maxOutputTokens: 6144 },
    }));
  });
});
