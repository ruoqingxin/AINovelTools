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
  { key: "discussion", label: "共创讨论", description: "自由讨论角色、物品、地点与剧情灵感", defaultTemperature: 0.45, defaultMaxOutputTokens: 4096, promptVariables: ["scopeLabel", "userMessage", "discussionHistory"] },
  { key: "discussionDesign", label: "构思整理", description: "把已选定的讨论方向整理为实体与作者设定候选", defaultTemperature: 0.45, defaultMaxOutputTokens: 4096, promptVariables: ["scopeLabel", "discussionHistory"] },
  { key: "workDesign", label: "作品设定", description: "生成设定候选，或从文件提炼设定内容", defaultTemperature: 0.45, defaultMaxOutputTokens: 4096, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext", "referenceContent"] },
  { key: "outline", label: "大纲主线", description: "根据核心设定生成和补全故事主线", defaultTemperature: 0.6, defaultMaxOutputTokens: 6144, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "volumePlanning", label: "分卷规划", description: "生成分卷目标、阶段转折和卷末状态", defaultTemperature: 0.55, defaultMaxOutputTokens: 6144, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "chapterSplit", label: "章节拆分", description: "把单卷规划拆成可独立执行的章节", defaultTemperature: 0.3, defaultMaxOutputTokens: 4096, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "chapterPlan", label: "章节规划", description: "生成章节与场景的正文执行卡", defaultTemperature: 0.35, defaultMaxOutputTokens: 4096, promptVariables: ["sectionTitle", "sectionPrompt", "userGuidance", "existingContext"] },
  { key: "consistencyReview", label: "一致性审核", description: "创作准入、正文候选审核与知识冲突检查", defaultTemperature: 0.2, defaultMaxOutputTokens: 8192, promptVariables: ["chapterTitle", "chapterPlan", "userInstruction", "currentDraft", "projectKnowledge"] },
  { key: "writing", label: "正文书写", description: "整章创作、续写、重写、润色和摘要", defaultTemperature: 0.9, defaultMaxOutputTokens: 8192, promptVariables: ["chapterTitle", "chapterPlan", "userInstruction", "selection", "currentDraft", "projectKnowledge"] },
  { key: "knowledgeExtraction", label: "知识提炼", description: "从导入文件中提炼人物、地点和设定条目", defaultTemperature: 0.1, defaultMaxOutputTokens: 4096, promptVariables: ["entityType", "entityName", "briefSummary", "applicabilityScope", "userGuidance", "sourceText"] },
];

function recommendedContext(task: AiTaskKey): AiTaskContextPreference {
  if (task === "discussion" || task === "discussionDesign") return {
    includeProjectContext: false,
    includeReferenceContent: false,
    includeProjectKnowledge: false,
    includeCurrentDraft: false,
    includeChapterPlan: false,
    inputTokenBudget: 24_576,
  };
  return {
    includeProjectContext: task !== "writing" && task !== "knowledgeExtraction",
    includeReferenceContent: task === "workDesign" || task === "knowledgeExtraction",
    includeProjectKnowledge: task !== "knowledgeExtraction",
    includeCurrentDraft: task === "writing" || task === "consistencyReview",
    includeChapterPlan: task === "writing" || task === "consistencyReview",
    inputTokenBudget: task === "writing" ? 49_152 : task === "workDesign" || task === "chapterSplit" || task === "chapterPlan" ? 24_576 : 32_768,
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
  discussion: recommendedTaskPreference("discussion"),
  discussionDesign: recommendedTaskPreference("discussionDesign"),
  workDesign: recommendedTaskPreference("workDesign"),
  outline: recommendedTaskPreference("outline"),
  volumePlanning: recommendedTaskPreference("volumePlanning"),
  chapterSplit: recommendedTaskPreference("chapterSplit"),
  chapterPlan: recommendedTaskPreference("chapterPlan"),
  consistencyReview: recommendedTaskPreference("consistencyReview"),
  writing: recommendedTaskPreference("writing"),
  knowledgeExtraction: recommendedTaskPreference("knowledgeExtraction"),
};

export type AiTaskSettingsScope = "GLOBAL" | "PROJECT";

export function aiTaskSettingsHref(task?: AiTaskKey, scope: AiTaskSettingsScope = "GLOBAL") {
  const params = new URLSearchParams();
  if (task) params.set("task", task);
  if (scope === "PROJECT") params.set("scope", scope);
  return `/settings#ai-task-models${params.size ? `?${params}` : ""}`;
}

export function aiTaskSettingsFromHash(hash = window.location.hash) {
  const [section, query = ""] = hash.split("?");
  if (section !== "#ai-task-models") return null;
  const params = new URLSearchParams(query);
  const task = AI_TASK_DEFINITIONS.find(({ key }) => key === params.get("task"))?.key;
  return { task: task ?? "workDesign", scope: params.get("scope") === "PROJECT" ? "PROJECT" as const : "GLOBAL" as const };
}

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
  const preferredId = preference.profileId;
  if (preferredId) {
    const preferred = profiles?.find((profile) => profile.capability === "CHAT" && profile.id === preferredId);
    if (preferred) return preferred;
  }
  return profiles?.find((profile) => profile.capability === "CHAT" && profile.hasSecret)
    ?? profiles?.find((profile) => profile.capability === "CHAT");
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

export function describeTaskPreferenceDifferences(
  preference: AiTaskPreference,
  task: AiTaskKey,
) {
  const defaults = recommendedTaskPreference(task);
  const differences: string[] = [];
  if (preference.temperature !== defaults.temperature) {
    differences.push(`温度 ${preference.temperature ?? "默认"}（推荐 ${defaults.temperature}）`);
  }
  if (preference.maxOutputTokens !== defaults.maxOutputTokens) {
    differences.push(`最大输出 ${preference.maxOutputTokens ?? "默认"}（推荐 ${defaults.maxOutputTokens}）`);
  }
  if (preference.prompt.context.inputTokenBudget !== defaults.prompt.context.inputTokenBudget) {
    differences.push(`输入预算 ${preference.prompt.context.inputTokenBudget ?? "默认"}（推荐 ${defaults.prompt.context.inputTokenBudget}）`);
  }
  const contextLabels: Array<[keyof AiTaskContextPreference, string]> = [
    ["includeProjectContext", "正式设定"],
    ["includeReferenceContent", "参考文件"],
    ["includeProjectKnowledge", "项目知识"],
    ["includeCurrentDraft", "当前草稿"],
    ["includeChapterPlan", "章节规划"],
  ];
  for (const [key, label] of contextLabels) {
    if (preference.prompt.context[key] !== defaults.prompt.context[key]) {
      differences.push(`${preference.prompt.context[key] ? "开启" : "关闭"}${label}（推荐${defaults.prompt.context[key] ? "开启" : "关闭"}）`);
    }
  }
  if (preference.prompt.systemPrompt?.trim()) differences.push("自定义系统提示词");
  if (preference.prompt.instructionTemplate?.trim()) differences.push("自定义任务模板");
  return differences;
}
