import { describe, expect, it } from "vitest";
import { AI_TASK_DEFINITIONS, emptyAiTaskPreferences } from "./ai-task-preferences";
import { AI_TASK_PRESETS, applyAiTaskPreset } from "./ai-task-presets";

describe("AI task presets", () => {
  it("covers all seven tasks with bounded generation and context settings", () => {
    for (const preset of AI_TASK_PRESETS) {
      for (const { key } of AI_TASK_DEFINITIONS) {
        const task = preset.tasks[key];
        expect(task.temperature).toBeGreaterThanOrEqual(0);
        expect(task.temperature).toBeLessThanOrEqual(2);
        expect(task.maxOutputTokens).toBeGreaterThan(0);
        expect(task.context.inputTokenBudget).toBeGreaterThanOrEqual(256);
      }
    }
  });

  it("preserves models and custom prompts while applying task tuning", () => {
    const current = {
      ...emptyAiTaskPreferences,
      writing: {
        ...emptyAiTaskPreferences.writing,
        profileId: "writer-profile",
        fallbackProfileId: "backup-profile",
        prompt: {
          ...emptyAiTaskPreferences.writing.prompt,
          systemPrompt: "保持作者既有文风",
          instructionTemplate: "{{userInstruction}}",
        },
      },
    };
    const next = applyAiTaskPreset(current, AI_TASK_PRESETS[1]);

    expect(next.writing.profileId).toBe("writer-profile");
    expect(next.writing.fallbackProfileId).toBe("backup-profile");
    expect(next.writing.prompt.systemPrompt).toBe("保持作者既有文风");
    expect(next.writing.prompt.instructionTemplate).toBe("{{userInstruction}}");
    expect(next.writing.temperature).toBe(0.7);
    expect(next.chapterSplit.temperature).toBe(0.2);
  });
});
