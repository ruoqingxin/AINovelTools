import { describe, expect, it } from "vitest";
import {
  describeTaskPreferenceDifferences,
  recommendedTaskPreference,
} from "./ai-task-preferences";

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
