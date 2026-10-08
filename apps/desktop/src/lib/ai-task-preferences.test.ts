import { describe, expect, it } from "vitest";
import {
  describeTaskPreferenceDifferences,
  recommendedTaskPreference,
  resolveTaskChatProfile,
  emptyAiTaskPreferences,
} from "./ai-task-preferences";
import type { ModelProfile } from "./tauri-client";

describe("describeTaskPreferenceDifferences", () => {
  it("reports only settings that differ from the recommended defaults", () => {
    const preference = recommendedTaskPreference("writing");
    preference.temperature = 0.7;
    preference.prompt.context.includeCurrentDraft = false;
    preference.prompt.systemPrompt = "作者自己的系统提示词";

    expect(describeTaskPreferenceDifferences(preference, "writing")).toEqual([
      "温度 0.7（推荐 0.9）",
      "关闭当前草稿（推荐开启）",
      "自定义系统提示词",
    ]);
  });
});

describe("resolveTaskChatProfile", () => {
  const profile = (id: string, capability: ModelProfile["capability"], hasSecret: boolean): ModelProfile => ({
    id, capability, hasSecret, name: id, provider: "OPEN_AI", baseUrl: "", modelId: id,
    contextWindow: 32_768, maxOutputTokens: 4_096, privacyLevel: "ALLOW_CLOUD",
    timeoutSeconds: 60, retryLimit: 0, inputPriceMicrosPerMillion: 0,
    outputPriceMicrosPerMillion: 0, priceCurrency: "USD", secretRef: null, createdAt: "", updatedAt: "",
  });
  const profiles = [profile("embedding", "EMBEDDING", true), profile("unconfigured", "CHAT", false), profile("configured", "CHAT", true)];

  it("prefers the explicit chat model and otherwise falls back to a configured chat model", () => {
    const preferences = {
      ...emptyAiTaskPreferences,
      writing: { ...emptyAiTaskPreferences.writing, profileId: "unconfigured" },
    };
    expect(resolveTaskChatProfile(profiles, preferences, "writing")?.id).toBe("unconfigured");
    preferences.writing.profileId = "embedding";
    expect(resolveTaskChatProfile(profiles, preferences, "writing")?.id).toBe("configured");
    preferences.writing.profileId = "deleted";
    expect(resolveTaskChatProfile(profiles, preferences, "writing")?.id).toBe("configured");
  });

  it("handles absent and unconfigured profiles without choosing an embedding model", () => {
    expect(resolveTaskChatProfile(profiles.slice(0, 2), undefined, "writing")?.id).toBe("unconfigured");
    expect(resolveTaskChatProfile(profiles.slice(0, 1), undefined, "writing")).toBeUndefined();
    expect(resolveTaskChatProfile(undefined, undefined, "writing")).toBeUndefined();
  });
});
