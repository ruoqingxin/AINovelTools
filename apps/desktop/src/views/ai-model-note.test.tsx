import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recommendedTaskPreference } from "../lib/ai-task-preferences";
import type { ModelProfile } from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";

const mocks = vi.hoisted(() => ({
  getAiBudgetSettings: vi.fn(),
  getAiUsageSummary: vi.fn(),
}));

vi.mock("../lib/tauri-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client");
  return {
    ...actual,
    getAiBudgetSettings: mocks.getAiBudgetSettings,
    getAiUsageSummary: mocks.getAiUsageSummary,
  };
});

const profile: ModelProfile = {
  id: "profile-1",
  name: "写作模型",
  provider: "DEEP_SEEK",
  capability: "CHAT",
  baseUrl: "https://api.deepseek.com",
  modelId: "deepseek-v4-flash",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  privacyLevel: "ALLOW_CLOUD",
  timeoutSeconds: 120,
  retryLimit: 1,
  inputPriceMicrosPerMillion: 2_500_000,
  outputPriceMicrosPerMillion: 10_000_000,
  priceCurrency: "USD",
  secretRef: "model-profile:profile-1",
  hasSecret: true,
  createdAt: "0",
  updatedAt: "0",
};

describe("AiModelNote", () => {
  beforeEach(() => {
    mocks.getAiBudgetSettings.mockResolvedValue({
      currency: "USD",
      dailyLimitMicros: 25000,
      projectLimitMicros: 200000,
    });
    mocks.getAiUsageSummary.mockResolvedValue({
      days: 30,
      total: [{ currency: "USD", runCount: 2, inputTokens: 8000, outputTokens: 4000, estimatedCostMicros: 60000 }],
      daily: [{
        date: localDateKey(),
        currency: "USD",
        runCount: 1,
        inputTokens: 4000,
        outputTokens: 2000,
        estimatedCostMicros: 10000,
      }],
      byTask: [{
        taskKey: "writing",
        currency: "USD",
        runCount: 2,
        inputTokens: 8000,
        outputTokens: 4000,
        estimatedCostMicros: 60000,
      }],
    });
  });

  it("shows the selected model, next-run estimate, and configuration differences", async () => {
    const preference = recommendedTaskPreference("writing");
    preference.temperature = 0.7;
    preference.prompt.systemPrompt = "作者自己的系统提示词";

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AiModelNote
          taskLabel="正文书写"
          taskKey="writing"
          profile={profile}
          preference={preference}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("写作模型 · deepseek-v4-flash")).toBeVisible();
    expect(await screen.findByText(/预估下一次约 USD 0\.03/)).toBeVisible();
    expect(screen.getByText(/配置差异：温度 0\.7/)).toBeVisible();
    expect(screen.getByText(/自定义系统提示词/)).toBeVisible();
    expect(screen.getByText("本次后预计超过每日预算（160%）")).toBeVisible();
  });
});

function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
