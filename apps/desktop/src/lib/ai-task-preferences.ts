import { useQuery } from "@tanstack/react-query";
import {
  getAiTaskPreferences,
  type AiTaskPreference,
  type AiTaskPreferences,
  type ModelProfile,
} from "./tauri-client";

export type AiTaskKey = keyof AiTaskPreferences;

export const AI_TASK_DEFINITIONS: Array<{
  key: AiTaskKey;
  label: string;
  description: string;
}> = [
  { key: "workDesign", label: "作品设定", description: "生成设定候选，或从文件提炼设定内容" },
  { key: "outline", label: "大纲主线", description: "根据核心设定生成和补全故事主线" },
  { key: "volumePlanning", label: "分卷规划", description: "生成分卷目标、阶段转折和卷末状态" },
  { key: "chapterSplit", label: "章节拆分", description: "把单卷规划拆成可独立执行的章节" },
  { key: "writing", label: "正文书写", description: "整章创作、续写、重写、润色和摘要" },
  { key: "knowledgeExtraction", label: "知识提炼", description: "从导入文件中提炼人物、地点和设定条目" },
];

export const emptyAiTaskPreference: AiTaskPreference = {
  profileId: null,
  temperature: null,
  maxOutputTokens: null,
};

export const emptyAiTaskPreferences: AiTaskPreferences = {
  workDesign: emptyAiTaskPreference,
  outline: emptyAiTaskPreference,
  volumePlanning: emptyAiTaskPreference,
  chapterSplit: emptyAiTaskPreference,
  writing: emptyAiTaskPreference,
  knowledgeExtraction: emptyAiTaskPreference,
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
  return preferences?.[task] ?? emptyAiTaskPreference;
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
