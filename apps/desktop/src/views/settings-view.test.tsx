import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./settings-view";

const mocks = vi.hoisted(() => ({ listModelProfiles: vi.fn() }));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return { ...actual, listModelProfiles: mocks.listModelProfiles };
});

describe("SettingsView", () => {
  afterEach(cleanup);

  beforeEach(() => mocks.listModelProfiles.mockResolvedValue([]));

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
});
