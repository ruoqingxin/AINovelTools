import { useQuery } from "@tanstack/react-query";
import {
  getAiTaskPreferences,
  type AiTaskContextPreference,
  type AiTaskPreference,
  type AiTaskPreferences,
  type ModelProfile,
} from "./tauri-client";

export type AiTaskKey = keyof AiTaskPreferences;

export const AI_TASK_DEFINITIONS: Array<{
  key: AiTaskKey;
  label: string;
  description: string;
  defaultTemperature: number;
  defaultMaxOutputTokens: number;
  promptVariables: string[];
}> = [
  { key: "workDesign", label: "作品设定", description: "生成设定候选，或从文件提炼设定内容", defaultTemperature: 0.45, defaultMaxOutputTokens: 4096, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext", "referenceContent"] },
  { key: "outline", label: "大纲主线", description: "根据核心设定生成和补全故事主线", defaultTemperature: 0.6, defaultMaxOutputTokens: 6144, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "volumePlanning", label: "分卷规划", description: "生成分卷目标、阶段转折和卷末状态", defaultTemperature: 0.55, defaultMaxOutputTokens: 6144, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "chapterSplit", label: "章节拆分", description: "把单卷规划拆成可独立执行的章节", defaultTemperature: 0.3, defaultMaxOutputTokens: 4096, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "writing", label: "正文书写", description: "整章创作、续写、重写、润色和摘要", defaultTemperature: 0.9, defaultMaxOutputTokens: 8192, promptVariables: ["chapterTitle", "chapterPlan", "userInstruction", "selection", "currentDraft", "projectKnowledge"] },
  { key: "knowledgeExtraction", label: "知识提炼", description: "从导入文件中提炼人物、地点和设定条目", defaultTemperature: 0.1, defaultMaxOutputTokens: 4096, promptVariables: ["entityType", "entityName", "briefSummary", "applicabilityScope", "userGuidance", "sourceText"] },
];

function recommendedContext(task: AiTaskKey): AiTaskContextPreference {
  const projectPlanningTasks = new Set<AiTaskKey>(["workDesign", "outline", "volumePlanning", "chapterSplit"]);
  const referenceTasks = new Set<AiTaskKey>(["workDesign", "knowledgeExtraction"]);
  const knowledgeTasks = new Set<AiTaskKey>(["workDesign", "outline", "volumePlanning", "chapterSplit", "writing"]);
  return {
    includeProjectContext: projectPlanningTasks.has(task),
    includeReferenceContent: referenceTasks.has(task),
    includeProjectKnowledge: knowledgeTasks.has(task),
    includeCurrentDraft: task === "writing",
    includeChapterPlan: task === "writing",
    inputTokenBudget: task === "writing" ? 49_152 : task === "workDesign" || task === "chapterSplit" ? 24_576 : 32_768,
  };
}

export function recommendedTaskPreference(task: AiTaskKey): AiTaskPreference {
  const definition = AI_TASK_DEFINITIONS.find((item) => item.key === task);
  if (!definition) throw new Error(`Unknown AI task: ${task}`);
  return {
    profileId: null,
    fallbackProfileId: null,
    temperature: definition.defaultTemperature,
    maxOutputTokens: definition.defaultMaxOutputTokens,
    prompt: {
      systemPrompt: null,
      instructionTemplate: null,
      context: recommendedContext(task),
    },
  };
}

export const emptyAiTaskPreferences: AiTaskPreferences = {
  workDesign: recommendedTaskPreference("workDesign"),
  outline: recommendedTaskPreference("outline"),
  volumePlanning: recommendedTaskPreference("volumePlanning"),
  chapterSplit: recommendedTaskPreference("chapterSplit"),
  writing: recommendedTaskPreference("writing"),
  knowledgeExtraction: recommendedTaskPreference("knowledgeExtraction"),
};

export function useAiTaskPreferences() {
  return useQuery({
    queryKey: ["ai-task-preferences"],
    queryFn: getAiTaskPreferences,
  });
}

export function resolveTaskChatProfile(
  profiles: ModelProfile[] | undefined,
  preferences: AiTaskPreferences | undefined,
  task: AiTaskKey,
) {
  const preference = resolveTaskPreference(preferences, task);
  const chatProfiles = profiles?.filter((profile) => profile.capability === "CHAT") ?? [];
  const preferredId = preference.profileId;
  if (preferredId) {
    const preferred = chatProfiles.find((profile) => profile.id === preferredId);
    if (preferred) return preferred;
  }
  return chatProfiles.find((profile) => profile.hasSecret) ?? chatProfiles[0];
}

export function resolveTaskPreference(
  preferences: AiTaskPreferences | undefined,
  task: AiTaskKey,
) {
  const fallback = recommendedTaskPreference(task);
  const preference = preferences?.[task];
  return {
    profileId: preference?.profileId ?? null,
    fallbackProfileId: preference?.fallbackProfileId ?? null,
    temperature: preference?.temperature ?? fallback.temperature,
    maxOutputTokens: preference?.maxOutputTokens ?? fallback.maxOutputTokens,
    prompt: {
      systemPrompt: preference?.prompt?.systemPrompt ?? fallback.prompt.systemPrompt,
      instructionTemplate: preference?.prompt?.instructionTemplate ?? fallback.prompt.instructionTemplate,
      context: {
        includeProjectContext: preference?.prompt?.context?.includeProjectContext ?? fallback.prompt.context.includeProjectContext,
        includeReferenceContent: preference?.prompt?.context?.includeReferenceContent ?? fallback.prompt.context.includeReferenceContent,
        includeProjectKnowledge: preference?.prompt?.context?.includeProjectKnowledge ?? fallback.prompt.context.includeProjectKnowledge,
        includeCurrentDraft: preference?.prompt?.context?.includeCurrentDraft ?? fallback.prompt.context.includeCurrentDraft,
        includeChapterPlan: preference?.prompt?.context?.includeChapterPlan ?? fallback.prompt.context.includeChapterPlan,
        inputTokenBudget: preference?.prompt?.context?.inputTokenBudget ?? fallback.prompt.context.inputTokenBudget,
      },
    },
  };
}

export function providerLabel(provider: ModelProfile["provider"]) {
  const labels: Record<ModelProfile["provider"], string> = {
    DEEP_SEEK: "DeepSeek",
    OPEN_AI: "OpenAI",
    OPEN_AI_COMPATIBLE: "兼容接口",
    SILICON_FLOW: "硅基流动",
  };
  return labels[provider];
}
