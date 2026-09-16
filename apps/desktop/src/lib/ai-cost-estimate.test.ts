import { describe, expect, it } from "vitest";
import { estimateNextRunCost, nextRunCostLabel } from "./ai-cost-estimate";
import type { ModelProfile } from "./tauri-client";

const profile: ModelProfile = {
  id: "profile-1",
  name: "测试模型",
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
  secretRef: null,
  hasSecret: true,
  createdAt: "0",
  updatedAt: "0",
};

describe("AI next-run cost estimate", () => {
  it("uses historical average tokens and the current model price", () => {
    const estimate = estimateNextRunCost([{
      taskKey: "writing",
      currency: "USD",
      runCount: 2,
      inputTokens: 8000,
      outputTokens: 4000,
      estimatedCostMicros: 60000,
    }], "writing", profile);

    expect(estimate).toMatchObject({ status: "READY", currency: "CNY", runCount: 2 });
    expect(nextRunCostLabel(estimate, 30)).toContain("按未命中缓存估算");
  });

  it("keeps manually configured prices for other providers", () => {
    const estimate = estimateNextRunCost([{ taskKey: "writing", currency: "USD", runCount: 2, inputTokens: 8000, outputTokens: 4000, estimatedCostMicros: 60000 }], "writing", { ...profile, provider: "OPEN_AI", modelId: "gpt-test" });
    expect(estimate).toMatchObject({ status: "READY", estimatedMicros: 30000, currency: "USD" });
  });

  it("explains missing price and sample states without blocking submission", () => {
    expect(estimateNextRunCost([], "writing", { ...profile, provider: "OPEN_AI", modelId: "gpt-test", inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0 })).toEqual({ status: "MISSING_PRICE" });
    expect(estimateNextRunCost([], "writing", profile)).toEqual({ status: "INSUFFICIENT_SAMPLES" });
  });
});
